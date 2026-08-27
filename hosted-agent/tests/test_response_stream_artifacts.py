import asyncio
import json
import re
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock

from codex_adapter.artifacts import ARTIFACT_EVENT
from codex_adapter.events import RuntimeEvent


def _install_responses_sdk_stub():
    added = []

    def put(name, module):
        if name not in sys.modules:
            sys.modules[name] = module
            added.append(name)
        return sys.modules[name]

    azure = put("azure", ModuleType("azure"))
    ai = put("azure.ai", ModuleType("azure.ai"))
    agentserver = put("azure.ai.agentserver", ModuleType("azure.ai.agentserver"))
    responses = put(
        "azure.ai.agentserver.responses",
        ModuleType("azure.ai.agentserver.responses"),
    )
    activity = put(
        "azure.ai.agentserver.activity",
        ModuleType("azure.ai.agentserver.activity"),
    )

    class ResponsesServerOptions:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class ResponsesAgentServerHost:
        def __init__(self, **_kwargs):
            self.handler = None

        def response_handler(self, func):
            self.handler = func
            return func

        def run(self):
            return None

    class FakeAgentApplication:
        def __init__(self):
            self.handlers = {}
            self.error_handler = None

        def activity(self, activity_type):
            def register(func):
                self.handlers[activity_type] = func
                return func

            return register

        def error(self, func):
            self.error_handler = func
            return func

    class ActivityAgentServerHost:
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.agent_app = FakeAgentApplication()

    class ResponseEventStream:
        def __init__(self, **_kwargs):
            pass

    responses.CreateResponse = dict
    responses.ResponseContext = object
    responses.ResponseEventStream = ResponseEventStream
    responses.ResponsesAgentServerHost = ResponsesAgentServerHost
    responses.ResponsesServerOptions = ResponsesServerOptions
    activity.ActivityAgentServerHost = ActivityAgentServerHost
    azure.ai = ai
    ai.agentserver = agentserver
    agentserver.responses = responses
    agentserver.activity = activity
    return added


_ADDED_AZURE_STUBS = _install_responses_sdk_stub()
import main  # noqa: E402

for _name in reversed(_ADDED_AZURE_STUBS):
    sys.modules.pop(_name, None)


ARTIFACT_MARKER = "digibuddy-artifacts:"
OLD_FAILURE_WARNING = "Some generated files could not be saved"
READY_FALLBACK = "Your files are ready in the delivery area."


class FakeContext:
    response_id = "response-stream-test"

    async def get_input_text(self):
        return "make a report"

    async def get_input_items(self):
        return []


class FakeRuntime:
    def conversation_workspace(self, _previous_response_id, _response_id):
        return Path(".work/response-stream-test")


class FakeActivityContext:
    def __init__(self, text="ping", activity_id="activity-1"):
        self.activity = SimpleNamespace(
            id=activity_id,
            text=text,
            channel_id="msteams",
            conversation=SimpleNamespace(id="conversation-1"),
        )
        self.sent = []

    async def send_activity(self, value):
        self.sent.append(value)


class FakeStreamingResponse:
    def __init__(self):
        self.updates = []
        self.chunks = []
        self.ended = False

    def queue_informative_update(self, value):
        self.updates.append(value)

    def queue_text_chunk(self, value):
        self.chunks.append(value)

    async def end_stream(self):
        self.ended = True


class FailingStreamingResponse(FakeStreamingResponse):
    def __init__(self):
        super().__init__()
        self.reset_called = False

    async def end_stream(self):
        raise RuntimeError("Bot Connector unavailable")

    def reset(self):
        self.reset_called = True


class CancelledStreamingResponse(FakeStreamingResponse):
    def __init__(self):
        super().__init__()
        self._cancelled = False
        self.reset_called = False

    async def end_stream(self):
        self.ended = True
        self._cancelled = True

    async def reset(self):
        self.reset_called = True
        self._cancelled = False


class RecordingResponseEventStream:
    def __init__(self, *, response_id, request):
        self.response_id = response_id
        self.request = request
        self._items = []

    def emit_created(self):
        return {"type": "response.created", "response_id": self.response_id}

    def emit_in_progress(self):
        return {"type": "response.in_progress", "response_id": self.response_id}

    def emit_completed(self):
        return {"type": "response.completed", "response_id": self.response_id}

    def add_output_item_message(self):
        item = RecordingMessageItem(len(self._items))
        self._items.append(item)
        return item

    def add_output_item_reasoning_item(self):
        raise AssertionError("reasoning is outside this test's scope")

    def add_output_item_function_call(self, _tool, _item_id):
        raise AssertionError("tool calls are outside this test's scope")


class RecordingMessageItem:
    def __init__(self, output_index):
        self.output_index = output_index
        self.item_id = f"message-{output_index}"
        self._parts = []

    def emit_added(self):
        return {
            "type": "response.output_item.added",
            "output_index": self.output_index,
            "item": {"id": self.item_id, "type": "message"},
        }

    def add_text_content(self):
        part = RecordingTextContent(self, len(self._parts))
        self._parts.append(part)
        return part

    def emit_done(self):
        return {
            "type": "response.output_item.done",
            "output_index": self.output_index,
            "item": {"id": self.item_id, "type": "message"},
        }


class RecordingTextContent:
    def __init__(self, message, content_index):
        self.message = message
        self.content_index = content_index

    def _base(self, event_type):
        return {
            "type": event_type,
            "item_id": self.message.item_id,
            "output_index": self.message.output_index,
            "content_index": self.content_index,
        }

    def emit_added(self):
        event = self._base("response.content_part.added")
        event["part"] = {"type": "output_text", "text": ""}
        return event

    def emit_delta(self, delta):
        event = self._base("response.output_text.delta")
        event["delta"] = delta
        return event

    def emit_text_done(self, text):
        event = self._base("response.output_text.done")
        event["text"] = text
        return event

    def emit_done(self):
        event = self._base("response.content_part.done")
        event["part"] = {"type": "output_text"}
        return event


class HandleResponseArtifactStreamTests(unittest.TestCase):
    artifact = {
        "id": "a" * 32,
        "name": "report.md",
        "mimeType": "text/markdown",
        "size": 8,
    }

    async def _collect(self, scripted_events):
        async def scripted_turn_events(*_args, **_kwargs):
            for event in scripted_events:
                yield event

        with (
            mock.patch.object(main, "runtime", FakeRuntime()),
            mock.patch.object(main, "_turn_events", scripted_turn_events),
            mock.patch.object(main, "ResponseEventStream", RecordingResponseEventStream),
        ):
            return [
                event
                async for event in main.handle_response(
                    {"model": "gpt-test", "metadata": {}},
                    FakeContext(),
                    asyncio.Event(),
                )
            ]

    def _run(self, scripted_events):
        return asyncio.run(self._collect(scripted_events))

    def _assistant_text(self, stream_events):
        text_done = [
            event["text"]
            for event in stream_events
            if event["type"] == "response.output_text.done"
        ]
        self.assertEqual(len(text_done), 1)
        deltas = [
            event["delta"]
            for event in stream_events
            if event["type"] == "response.output_text.delta"
        ]
        self.assertEqual("".join(deltas), text_done[0])
        return text_done[0]

    def _text_deltas(self, stream_events):
        return [
            event["delta"]
            for event in stream_events
            if event["type"] == "response.output_text.delta"
        ]

    def _artifact_payload(self, assistant_text):
        match = re.search(
            r"<!-- digibuddy-artifacts:(?P<payload>.*?) -->", assistant_text
        )
        self.assertIsNotNone(match)
        return json.loads(match.group("payload"))

    def _visible_text(self, assistant_text):
        return assistant_text.split("\n\n<!-- digibuddy-artifacts:", 1)[0]

    def _assert_no_artifact_manifest(self, assistant_text):
        self.assertNotIn(ARTIFACT_MARKER, assistant_text)

    def _assert_stream_is_structurally_valid(self, stream_events):
        self.assertEqual(stream_events[0]["type"], "response.created")
        self.assertEqual(stream_events[1]["type"], "response.in_progress")
        self.assertEqual(stream_events[-1]["type"], "response.completed")

        opened_items = set()
        open_text_parts = set()
        text_done = set()
        parts_done = set()

        for event in stream_events:
            event_type = event["type"]
            if event_type == "response.output_item.added":
                self.assertEqual(event["item"]["type"], "message")
                opened_items.add(event["item"]["id"])
            elif event_type == "response.content_part.added":
                self.assertEqual(event["part"]["type"], "output_text")
                self.assertIn(event["item_id"], opened_items)
                open_text_parts.add((event["item_id"], event["content_index"]))
            elif event_type == "response.output_text.delta":
                key = (event["item_id"], event["content_index"])
                self.assertIn(key, open_text_parts)
                self.assertNotIn(key, text_done)
            elif event_type == "response.output_text.done":
                key = (event["item_id"], event["content_index"])
                self.assertIn(key, open_text_parts)
                text_done.add(key)
            elif event_type == "response.content_part.done":
                key = (event["item_id"], event["content_index"])
                self.assertIn(key, text_done)
                parts_done.add(key)
            elif event_type == "response.output_item.done":
                self.assertIn(event["item"]["id"], opened_items)
                self.assertTrue(parts_done)

    def test_artifacts_with_model_text_preserve_text_and_manifest_shape(self):
        model_text = "Here is the finished report."

        stream_events = self._run(
            [
                RuntimeEvent("assistant.message.delta", {"delta": model_text}),
                RuntimeEvent("assistant.message.completed", {"text": model_text}),
                RuntimeEvent(
                    ARTIFACT_EVENT,
                    {"artifacts": [self.artifact], "failed": 0},
                ),
            ]
        )

        self._assert_stream_is_structurally_valid(stream_events)
        assistant_text = self._assistant_text(stream_events)
        self.assertEqual(self._visible_text(assistant_text), model_text)
        self.assertNotIn(READY_FALLBACK, assistant_text)
        payload = self._artifact_payload(assistant_text)
        self.assertEqual(payload["artifacts"], [self.artifact])
        self.assertNotIn("failed", payload)

    def test_artifacts_without_model_text_emit_ready_fallback_then_manifest(self):
        stream_events = self._run(
            [
                RuntimeEvent(
                    ARTIFACT_EVENT,
                    {"artifacts": [self.artifact], "failed": 0},
                )
            ]
        )

        self._assert_stream_is_structurally_valid(stream_events)
        assistant_text = self._assistant_text(stream_events)
        self.assertEqual(self._visible_text(assistant_text), READY_FALLBACK)
        deltas = self._text_deltas(stream_events)
        self.assertEqual(deltas[0], READY_FALLBACK)
        self.assertIn(ARTIFACT_MARKER, deltas[1])
        payload = self._artifact_payload(assistant_text)
        self.assertEqual(payload["artifacts"], [self.artifact])
        self.assertNotIn("failed", payload)

    def test_failures_only_with_model_text_keep_warning_out_of_band(self):
        model_text = "I updated the workspace."

        stream_events = self._run(
            [
                RuntimeEvent("assistant.message.delta", {"delta": model_text}),
                RuntimeEvent("assistant.message.completed", {"text": model_text}),
                RuntimeEvent(ARTIFACT_EVENT, {"artifacts": [], "failed": 2}),
            ]
        )

        self._assert_stream_is_structurally_valid(stream_events)
        assistant_text = self._assistant_text(stream_events)
        self.assertEqual(self._visible_text(assistant_text), model_text)
        self.assertNotIn(OLD_FAILURE_WARNING, json.dumps(stream_events))
        self.assertNotIn(OLD_FAILURE_WARNING, assistant_text)
        payload = self._artifact_payload(assistant_text)
        self.assertEqual(payload, {"version": 1, "artifacts": [], "failed": 2})

    def test_failures_only_without_model_text_open_message_before_manifest(self):
        try:
            stream_events = self._run(
                [RuntimeEvent(ARTIFACT_EVENT, {"artifacts": [], "failed": 3})]
            )
        except RuntimeError as error:
            self.fail(f"failure-only artifact manifest raised {error!r}")

        self._assert_stream_is_structurally_valid(stream_events)
        assistant_text = self._assistant_text(stream_events)
        self.assertEqual(self._visible_text(assistant_text), "")
        payload = self._artifact_payload(assistant_text)
        self.assertEqual(payload, {"version": 1, "artifacts": [], "failed": 3})

        first_delta = next(
            index
            for index, event in enumerate(stream_events)
            if event["type"] == "response.output_text.delta"
        )
        first_message_added = next(
            index
            for index, event in enumerate(stream_events)
            if event["type"] == "response.output_item.added"
        )
        first_text_added = next(
            index
            for index, event in enumerate(stream_events)
            if event["type"] == "response.content_part.added"
        )
        self.assertLess(first_message_added, first_delta)
        self.assertLess(first_text_added, first_delta)

    def test_no_artifacts_or_failures_emit_no_artifact_manifest(self):
        model_text = "Nothing to deliver."

        stream_events = self._run(
            [
                RuntimeEvent("assistant.message.delta", {"delta": model_text}),
                RuntimeEvent("assistant.message.completed", {"text": model_text}),
            ]
        )

        self._assert_stream_is_structurally_valid(stream_events)
        assistant_text = self._assistant_text(stream_events)
        self.assertEqual(assistant_text, model_text)
        self._assert_no_artifact_manifest(assistant_text)


if __name__ == "__main__":
    unittest.main()


class FailedTurnStreamTests(HandleResponseArtifactStreamTests):
    """An explicable failure is an answer, not an internal server error."""

    def test_a_failed_turn_tells_the_user_what_the_runtime_reported(self):
        events = self._run(
            [
                RuntimeEvent(
                    "task.failed",
                    {"status": "failed", "message": "context window exceeded"},
                )
            ]
        )

        text = self._assistant_text(events)
        self.assertIn("context window exceeded", text)

    def test_a_retried_error_is_not_treated_as_the_outcome(self):
        events = self._run(
            [
                RuntimeEvent(
                    "turn.error", {"message": "rate limited", "will_retry": True}
                ),
                RuntimeEvent("assistant.message.delta", {"delta": "here you go"}),
            ]
        )

        self.assertIn("here you go", self._assistant_text(events))

    def test_a_failure_after_real_output_does_not_replace_the_answer(self):
        events = self._run(
            [
                RuntimeEvent("assistant.message.delta", {"delta": "partial answer"}),
                RuntimeEvent("task.failed", {"status": "failed", "message": "boom"}),
            ]
        )

        text = self._assistant_text(events)
        self.assertIn("partial answer", text)
        self.assertNotIn("could not complete", text)

    def test_an_unexplained_empty_turn_is_still_an_error(self):
        # Nothing to tell the user, and silence would look like a valid answer.
        with self.assertRaises(RuntimeError):
            self._run([RuntimeEvent("task.completed", {"status": "completed"})])


class TeamsActivityBridgeTests(unittest.TestCase):
    def test_one_host_registers_responses_and_teams_handlers(self):
        self.assertIs(main.app.handler, main.handle_response)
        self.assertIs(
            main.teams_app.handlers["message"],
            main.handle_activity_message,
        )
        self.assertIs(
            main.teams_app.error_handler,
            main.handle_activity_error,
        )

    def test_other_mentions_are_preserved_after_sdk_bot_cleanup(self):
        activity = FakeActivityContext(
            " <at>Alice</at> summarize this "
        ).activity

        self.assertEqual(
            main._activity_prompt(activity),
            "<at>Alice</at> summarize this",
        )

    def test_conversation_keys_are_stable_and_opaque(self):
        first = FakeActivityContext().activity
        same = FakeActivityContext("another message").activity
        other = FakeActivityContext().activity
        other.conversation.id = "conversation-2"

        self.assertEqual(
            main._activity_conversation_key(first),
            main._activity_conversation_key(same),
        )
        self.assertNotEqual(
            main._activity_conversation_key(first),
            main._activity_conversation_key(other),
        )
        self.assertNotIn(
            "conversation-1",
            main._activity_conversation_key(first),
        )

    def test_activity_replies_join_streamed_and_completed_text(self):
        async def scripted_turn_events(*_args, **_kwargs):
            yield RuntimeEvent("assistant.message.delta", {"delta": "hello"})
            yield RuntimeEvent(
                "assistant.message.completed",
                {"text": "hello from Teams"},
            )

        async def collect():
            with mock.patch.object(
                main,
                "_turn_events",
                scripted_turn_events,
            ):
                return await main._activity_reply("ping", "teams-key")

        self.assertEqual(asyncio.run(collect()), "hello from Teams")

    def test_a_teams_message_sends_the_codex_reply(self):
        context = FakeActivityContext()

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="pong"),
            ) as reply:
                await main.handle_activity_message(context, {})
                return reply

        reply = asyncio.run(run())
        self.assertEqual(context.sent, ["pong"])
        reply.assert_awaited_once_with(
            "ping",
            main._activity_conversation_key(context.activity),
        )

    def test_a_bare_mention_gets_a_useful_greeting(self):
        # The M365 SDK removes the recipient mention before this handler runs.
        context = FakeActivityContext("", activity_id="activity-2")

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="How can I help?"),
            ) as reply:
                await main.handle_activity_message(context, {})
                return reply

        reply = asyncio.run(run())
        self.assertEqual(context.sent, ["How can I help?"])
        self.assertIn("Greet the user", reply.await_args.args[0])

    def test_an_artifact_only_turn_is_still_a_successful_reply(self):
        async def scripted_turn_events(*_args, **_kwargs):
            yield RuntimeEvent(
                ARTIFACT_EVENT,
                {"artifacts": [{"id": "artifact"}], "failed": 0},
            )

        async def collect():
            with mock.patch.object(
                main,
                "_turn_events",
                scripted_turn_events,
            ):
                return await main._activity_reply("make it", "teams-key")

        self.assertIn("generated files", asyncio.run(collect()))

    def test_streaming_keeps_the_turn_alive_and_finishes_it(self):
        context = FakeActivityContext(activity_id="activity-stream")
        context.streaming_response = FakeStreamingResponse()

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="pong"),
            ):
                await main.handle_activity_message(context, {})

        asyncio.run(run())
        self.assertTrue(context.streaming_response.updates)
        self.assertEqual(context.streaming_response.chunks, ["pong"])
        self.assertTrue(context.streaming_response.ended)
        self.assertEqual(context.sent, [])

    def test_a_silently_cancelled_stream_falls_back_to_an_ordinary_reply(self):
        context = FakeActivityContext(activity_id="activity-cancelled-stream")
        context.streaming_response = CancelledStreamingResponse()

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="pong"),
            ):
                await main.handle_activity_message(context, {})

        asyncio.run(run())
        self.assertTrue(context.streaming_response.reset_called)
        self.assertEqual(context.sent, ["pong"])

    def test_a_completed_activity_retry_does_not_send_twice(self):
        first = FakeActivityContext(activity_id="activity-retry")
        retry = FakeActivityContext(activity_id="activity-retry")

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="pong"),
            ) as reply:
                await main.handle_activity_message(first, {})
                await main.handle_activity_message(retry, {})
                return reply

        reply = asyncio.run(run())
        self.assertEqual(first.sent, ["pong"])
        self.assertEqual(retry.sent, [])
        self.assertEqual(reply.await_count, 1)

    def test_a_delivery_retry_reuses_completed_work(self):
        first = FakeActivityContext(activity_id="activity-delivery-retry")
        first.streaming_response = FailingStreamingResponse()
        first.send_activity = mock.AsyncMock(
            side_effect=RuntimeError("Bot Connector unavailable")
        )
        retry = FakeActivityContext(activity_id="activity-delivery-retry")

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="expensive result"),
            ) as reply:
                with self.assertRaisesRegex(
                    main.ActivityDeliveryError,
                    "rejected",
                ):
                    await main.handle_activity_message(first, {})
                await main.handle_activity_message(retry, {})
                return reply

        reply = asyncio.run(run())
        self.assertTrue(first.streaming_response.reset_called)
        self.assertEqual(retry.sent, ["expensive result"])
        self.assertEqual(reply.await_count, 1)

    def test_same_activity_id_in_two_conversations_is_not_a_duplicate(self):
        first = FakeActivityContext(activity_id="shared-activity-id")
        second = FakeActivityContext(activity_id="shared-activity-id")
        second.activity.conversation.id = "another-conversation"

        async def run():
            with mock.patch.object(
                main,
                "_activity_reply",
                mock.AsyncMock(return_value="pong"),
            ) as reply:
                await main.handle_activity_message(first, {})
                await main.handle_activity_message(second, {})
                return reply

        reply = asyncio.run(run())
        self.assertEqual(first.sent, ["pong"])
        self.assertEqual(second.sent, ["pong"])
        self.assertEqual(reply.await_count, 2)

    def test_delivery_errors_are_rethrown_for_connector_retry(self):
        context = FakeActivityContext(activity_id="activity-hard-failure")
        error = main.ActivityDeliveryError("delivery failed")

        with self.assertRaises(main.ActivityDeliveryError):
            asyncio.run(main.handle_activity_error(context, error))
        self.assertEqual(context.sent, [])
