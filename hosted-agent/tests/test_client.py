import asyncio
import tempfile
import unittest
from pathlib import Path

from codex_adapter.client import (
    PROFILE_EVENT,
    CodexProtocolError,
    CodexRuntime,
    _server_request_result,
)
from codex_adapter.artifacts import ARTIFACT_EVENT
from codex_adapter.config import RuntimeSettings
from codex_adapter.config_store import NullConfigStore
from codex_adapter.profiles import UnknownProfileError


def settings(directory: str, **overrides):
    root = Path(directory)
    values = {
        "model_name": "gpt-5.2-codex",
        "model_endpoint": "",
        "model_api_key": "",
        "model_provider": "digibuddy",
        "approval_policy": "never",
        "sandbox": "workspace-write",
        "network_access": True,
        "workspace": root / "workspace",
        "codex_home": root / "codex",
        "instructions_path": root / "AGENTS.md",
        "payload_root": root / "payload",
        "skills_source": root / "skills",
    }
    values.update(overrides)
    return RuntimeSettings(**values)


class ServerRequestTests(unittest.TestCase):
    def test_each_interactive_request_gets_a_schema_compatible_decline(self):
        self.assertEqual(
            _server_request_result("item/commandExecution/requestApproval"),
            {"decision": "decline"},
        )
        self.assertEqual(
            _server_request_result("mcpServer/elicitation/request"),
            {"action": "decline", "content": None},
        )
        self.assertEqual(
            _server_request_result("item/tool/requestUserInput"),
            {"answers": {}},
        )
        self.assertEqual(
            _server_request_result("item/permissions/requestApproval"),
            {"permissions": {}, "scope": "turn"},
        )
        self.assertIsNone(_server_request_result("unknown/request"))


class ProtocolTimeoutTests(unittest.TestCase):
    def test_request_timeout_restarts_the_stalled_process(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory, protocol_timeout_seconds=0.01)
                runtime = CodexRuntime(current, NullConfigStore())
                restarted = False

                async def send(_message):
                    return None

                async def read_forever():
                    await asyncio.Event().wait()

                async def restart():
                    nonlocal restarted
                    restarted = True

                runtime._send = send
                runtime._read_message = read_forever
                runtime._restart = restart

                with self.assertRaisesRegex(CodexProtocolError, "initialize timed out"):
                    await runtime._request("initialize", {})
                self.assertTrue(restarted)

        asyncio.run(exercise())

    def test_completed_turn_publishes_new_deliverables(self):
        class ArtifactStore(NullConfigStore):
            def __init__(self):
                self.payloads = []

            def write_artifact(
                self, artifact_id, filename, payload, content_type, owner=""
            ):
                self.payloads.append((artifact_id, filename, payload, content_type))
                return True

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory)
                current.workspace.mkdir()
                store = ArtifactStore()
                runtime = CodexRuntime(current, store)

                async def ensure_started(_profile, _reasoning_effort=""):
                    return None

                async def start_thread(_model, _profile, _workspace=None):
                    return "thread-1"

                conversation = runtime.conversation_workspace(None, "response-1")

                async def request(method, _params):
                    self.assertEqual(method, "turn/start")
                    conversation.mkdir(parents=True, exist_ok=True)
                    (conversation / "report.md").write_text(
                        "# Report", encoding="utf-8"
                    )
                    return {"turn": {"id": "turn-1"}}

                async def next_message(_cancellation):
                    return {
                        "method": "turn/completed",
                        "params": {
                            "turn": {"id": "turn-1", "status": "completed"}
                        },
                    }

                runtime._ensure_started = ensure_started
                runtime._start_thread = start_thread
                runtime._request = request
                runtime._next_turn_message = next_message

                events = [
                    event
                    async for event in runtime.stream_turn(
                        "build it",
                        previous_response_id=None,
                        response_id="response-1",
                        cancellation_signal=asyncio.Event(),
                    )
                ]

                artifact_event = next(
                    event for event in events if event.type == ARTIFACT_EVENT
                )
                self.assertEqual(
                    artifact_event.data["artifacts"][0]["name"], "report.md"
                )
                self.assertEqual(store.payloads[0][2], b"# Report")

        asyncio.run(exercise())

    def test_cancellation_interrupts_an_idle_turn(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = CodexRuntime(settings(directory), NullConfigStore())
                cancellation = asyncio.Event()
                cancellation.set()
                restarted = False

                async def restart():
                    nonlocal restarted
                    restarted = True

                runtime._restart = restart
                self.assertIsNone(await runtime._next_turn_message(cancellation))
                self.assertTrue(restarted)

        asyncio.run(exercise())


class ProfileBindingTests(unittest.TestCase):
    """The server owns the binding, so the server has to report it."""

    def _runtime(self, directory, profiles):
        class ProfileStore(NullConfigStore):
            def read(self, name):
                if name == "profiles.json":
                    return {"profiles": profiles}
                return None

        current = settings(directory)
        current.workspace.mkdir(parents=True, exist_ok=True)
        runtime = CodexRuntime(current, ProfileStore())

        async def ensure_started(_profile, _reasoning_effort=""):
            return None

        async def start_thread(_model, _profile, _workspace=None):
            return "thread-1"

        async def resume_thread(_thread_id, _model, _profile, _workspace=None):
            return None

        async def request(_method, _params):
            return {"turn": {"id": "turn-1"}}

        async def next_message(_cancellation):
            return {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-1", "status": "completed"}},
            }

        runtime._ensure_started = ensure_started
        runtime._start_thread = start_thread
        runtime._resume_thread = resume_thread
        runtime._request = request
        runtime._next_turn_message = next_message
        return runtime

    async def _run(self, runtime, *, profile=None, previous=None, response_id="r1"):
        return [
            event
            async for event in runtime.stream_turn(
                "do it",
                previous_response_id=previous,
                response_id=response_id,
                cancellation_signal=asyncio.Event(),
                profile=profile,
            )
        ]

    def test_a_turn_reports_the_profile_it_actually_used(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(
                    directory,
                    [{"name": "digibuddy"}, {"name": "marketing", "display_name": "Marketing"}],
                )

                events = await self._run(runtime, profile="marketing")

                reported = next(e for e in events if e.type == PROFILE_EVENT)
                self.assertEqual(reported.data["profile"], "marketing")
                self.assertEqual(reported.data["display_name"], "Marketing")
                self.assertEqual(reported.data["status"], "bound")

        asyncio.run(exercise())

    def test_a_blank_request_reports_the_default_it_resolved_to(self):
        """Blank does not mean "no profile"; the console must be told which one."""

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(directory, [{"name": "digibuddy"}])

                events = await self._run(runtime, profile=None)

                reported = next(e for e in events if e.type == PROFILE_EVENT)
                self.assertEqual(reported.data["profile"], "digibuddy")

        asyncio.run(exercise())

    def test_a_bound_conversation_keeps_its_profile_and_says_so(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(
                    directory, [{"name": "digibuddy"}, {"name": "marketing"}]
                )
                await self._run(runtime, profile="marketing", response_id="r1")

                events = await self._run(
                    runtime, profile="digibuddy", previous="r1", response_id="r2"
                )

                reported = next(e for e in events if e.type == PROFILE_EVENT)
                self.assertEqual(reported.data["profile"], "marketing")
                self.assertEqual(reported.data["status"], "contradicted")
                self.assertEqual(reported.data["requested"], "digibuddy")

        asyncio.run(exercise())

    def test_an_unknown_profile_fails_instead_of_running_as_the_default(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(directory, [{"name": "digibuddy"}])

                with self.assertRaises(UnknownProfileError):
                    await self._run(runtime, profile="deleted-agent")

        asyncio.run(exercise())

    def test_a_bound_profile_that_was_deleted_fails_closed(self):
        """The dangerous case: a restricted agent resuming as the default."""

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = self._runtime(
                    directory, [{"name": "digibuddy"}, {"name": "marketing"}]
                )
                await self._run(runtime, profile="marketing", response_id="r1")

                runtime._store.read = lambda name: (
                    {"profiles": [{"name": "digibuddy"}]}
                    if name == "profiles.json"
                    else None
                )

                with self.assertRaises(UnknownProfileError):
                    await self._run(runtime, previous="r1", response_id="r2")

        asyncio.run(exercise())


class WorkspaceContainmentTests(unittest.TestCase):
    """One conversation's files must not be attributed to another."""

    def _runtime(self, directory):
        current = settings(directory)
        current.workspace.mkdir(parents=True, exist_ok=True)
        return CodexRuntime(current, NullConfigStore())

    def test_two_conversations_resolve_to_different_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)

            first = runtime.conversation_workspace(None, "response-a")
            second = runtime.conversation_workspace(None, "response-b")

            self.assertNotEqual(first, second)
            self.assertEqual(first, runtime.conversation_workspace(None, "response-a"))

    def test_a_resumed_conversation_returns_to_its_own_root(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            first = runtime.conversation_workspace(None, "response-a")
            runtime._thread_map.bind("response-a", "thread-1", "digibuddy", first.name)

            resumed = runtime.conversation_workspace("response-a", "response-b")

            self.assertEqual(resumed, first)

    def test_a_conversation_bound_before_containment_keeps_the_shared_root(self):
        """An in-flight conversation must not lose the files it already wrote."""
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            runtime._thread_map.bind("legacy", "thread-1", "digibuddy")

            self.assertEqual(
                runtime.conversation_workspace("legacy", "response-b"),
                runtime._base_settings.workspace,
            )

    def test_a_root_is_confined_below_the_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self._runtime(directory)
            root = runtime._base_settings.workspace.resolve()

            resolved = runtime.conversation_workspace(None, "../../etc/passwd").resolve()

            self.assertTrue(resolved.is_relative_to(root))

    def test_artifacts_never_cross_conversations(self):
        class ArtifactStore(NullConfigStore):
            def __init__(self):
                self.names = []

            def write_artifact(self, artifact_id, filename, payload, content_type, owner=""):
                self.names.append(filename)
                return True

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory)
                current.workspace.mkdir(parents=True, exist_ok=True)
                store = ArtifactStore()
                runtime = CodexRuntime(current, store)

                other = runtime.conversation_workspace(None, "response-other")
                other.mkdir(parents=True, exist_ok=True)
                (other / "not-mine.md").write_text("# theirs", encoding="utf-8")

                mine = runtime.conversation_workspace(None, "response-mine")

                async def ensure_started(_profile, _reasoning_effort=""):
                    return None

                async def start_thread(_model, _profile, _workspace=None):
                    return "thread-1"

                async def request(_method, _params):
                    mine.mkdir(parents=True, exist_ok=True)
                    (mine / "mine.md").write_text("# mine", encoding="utf-8")
                    return {"turn": {"id": "turn-1"}}

                async def next_message(_cancellation):
                    return {
                        "method": "turn/completed",
                        "params": {"turn": {"id": "turn-1", "status": "completed"}},
                    }

                runtime._ensure_started = ensure_started
                runtime._start_thread = start_thread
                runtime._request = request
                runtime._next_turn_message = next_message

                events = [
                    event
                    async for event in runtime.stream_turn(
                        "build it",
                        previous_response_id=None,
                        response_id="response-mine",
                        cancellation_signal=asyncio.Event(),
                    )
                ]

                artifact_event = next(
                    event for event in events if event.type == ARTIFACT_EVENT
                )
                delivered = [item["name"] for item in artifact_event.data["artifacts"]]
                self.assertEqual(delivered, ["mine.md"])
                self.assertNotIn("not-mine.md", store.names)

        asyncio.run(exercise())


class ArtifactOwnershipTests(unittest.TestCase):
    def test_a_turn_publishes_into_the_caller_s_namespace(self):
        class OwnerStore(NullConfigStore):
            def __init__(self):
                self.owners = []

            def write_artifact(
                self, artifact_id, filename, payload, content_type, owner=""
            ):
                self.owners.append(owner)
                return True

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory)
                current.workspace.mkdir(parents=True, exist_ok=True)
                store = OwnerStore()
                runtime = CodexRuntime(current, store)
                conversation = runtime.conversation_workspace(None, "response-1")

                async def ensure_started(_profile, _reasoning_effort=""):
                    return None

                async def start_thread(_model, _profile, _workspace=None):
                    return "thread-1"

                async def request(_method, _params):
                    conversation.mkdir(parents=True, exist_ok=True)
                    (conversation / "report.md").write_text("# r", encoding="utf-8")
                    return {"turn": {"id": "turn-1"}}

                async def next_message(_cancellation):
                    return {
                        "method": "turn/completed",
                        "params": {"turn": {"id": "turn-1", "status": "completed"}},
                    }

                runtime._ensure_started = ensure_started
                runtime._start_thread = start_thread
                runtime._request = request
                runtime._next_turn_message = next_message

                async for _ in runtime.stream_turn(
                    "build it",
                    previous_response_id=None,
                    response_id="response-1",
                    cancellation_signal=asyncio.Event(),
                    owner="f" * 32,
                ):
                    pass
                return store.owners

        self.assertEqual(asyncio.run(exercise()), ["f" * 32])


if __name__ == "__main__":
    unittest.main()
