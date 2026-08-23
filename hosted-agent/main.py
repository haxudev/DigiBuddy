from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from azure.ai.agentserver.responses import (
    CreateResponse,
    ResponseContext,
    ResponseEventStream,
    ResponsesAgentServerHost,
    ResponsesServerOptions,
)

from codex_adapter import (
    CodexRuntime,
    attachment_prompt,
    collect_attachments,
    load_settings,
    store_attachments,
)
from codex_adapter.events import completion_delta, tool_arguments

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("digibuddy.hosted_agent")

settings = load_settings()
runtime = CodexRuntime(settings)
app = ResponsesAgentServerHost(
    options=ResponsesServerOptions(
        default_fetch_history_count=20,
        sse_keep_alive_interval_seconds=15,
    )
)


def _request_value(request: CreateResponse, name: str) -> Any:
    if hasattr(request, name):
        return getattr(request, name)
    if isinstance(request, dict):
        return request.get(name)
    return None


def _requested_profile(request: CreateResponse) -> str | None:
    """Agent profiles are selected with ``metadata.profile`` on the request.

    The ``agent`` field is reserved for the deployed Foundry agent reference, so
    it cannot double as the profile selector.
    """
    metadata = _request_value(request, "metadata")
    if not isinstance(metadata, dict):
        return None
    profile = metadata.get("profile")
    return profile.strip() if isinstance(profile, str) and profile.strip() else None


def _requested_reasoning_effort(request: CreateResponse) -> str | None:
    """Read the thinking strength the console asked for, if any."""
    reasoning = _request_value(request, "reasoning")
    effort: Any = None
    if isinstance(reasoning, dict):
        effort = reasoning.get("effort")
    elif reasoning is not None:
        effort = getattr(reasoning, "effort", None)
    return effort.strip() if isinstance(effort, str) and effort.strip() else None


async def _prepare_prompt(context: ResponseContext) -> str:
    """Combine the user's text with any files attached to the turn.

    Attachments are written into the Codex workspace so the sandboxed agent can
    open them with ordinary file tools, and the prompt records where they are.
    """
    prompt = (await context.get_input_text() or "").strip()
    paths = []
    try:
        items = await context.get_input_items()
        paths = store_attachments(
            collect_attachments(list(items)), settings.workspace / "uploads"
        )
    except Exception:  # noqa: BLE001 - a bad upload must not fail the turn
        logger.warning("Could not store request attachments", exc_info=True)
    prompt = attachment_prompt(prompt, paths)
    if not prompt:
        raise ValueError("A non-empty text input is required")
    return prompt


@app.response_handler
async def handle_response(
    request: CreateResponse,
    context: ResponseContext,
    cancellation_signal: asyncio.Event,
):
    prompt = await _prepare_prompt(context)

    stream = ResponseEventStream(response_id=context.response_id, request=request)
    yield stream.emit_created()
    yield stream.emit_in_progress()

    previous_response_id = _request_value(request, "previous_response_id")
    requested_model = _request_value(request, "model")
    if not isinstance(requested_model, str) or not requested_model.strip():
        requested_model = None

    # Reasoning and tool activity travel as their own output items so the
    # console can show them live and collapsed instead of splicing them into
    # the answer. Items are created lazily to keep the output indices in the
    # order they actually stream.
    reasoning: Any = None
    reasoning_part: Any = None
    reasoning_text = ""
    tools: dict[str, tuple[Any, str]] = {}
    text: Any = None
    output = ""

    def open_reasoning():
        nonlocal reasoning, reasoning_part, reasoning_text
        reasoning = stream.add_output_item_reasoning_item()
        reasoning_text = ""
        yield reasoning.emit_added()
        reasoning_part = reasoning.add_summary_part()
        yield reasoning_part.emit_added()

    def close_reasoning():
        nonlocal reasoning, reasoning_part
        if reasoning_part is None:
            return
        yield reasoning_part.emit_text_done(reasoning_text)
        yield reasoning_part.emit_done()
        yield reasoning.emit_done()
        reasoning = None
        reasoning_part = None

    async for event in runtime.stream_turn(
        prompt,
        previous_response_id=(
            previous_response_id if isinstance(previous_response_id, str) else None
        ),
        response_id=context.response_id,
        cancellation_signal=cancellation_signal,
        model=requested_model,
        profile=_requested_profile(request),
        reasoning_effort=_requested_reasoning_effort(request),
    ):
        logger.info(
            "codex_event %s",
            json.dumps({"type": event.type, **event.data}, ensure_ascii=False),
        )

        if event.type == "assistant.reasoning.delta":
            if reasoning_part is None:
                for item in open_reasoning():
                    yield item
            reasoning_text += event.data["delta"]
            yield reasoning_part.emit_text_delta(event.data["delta"])

        elif event.type == "assistant.reasoning.completed":
            # Only used when the engine never streamed reasoning deltas.
            if reasoning_part is not None:
                continue
            for item in open_reasoning():
                yield item
            reasoning_text = event.data["text"]
            yield reasoning_part.emit_text_delta(reasoning_text)

        elif event.type == "tool.started":
            for item in close_reasoning():
                yield item
            item_id = str(event.data.get("item_id") or "")
            if item_id in tools:
                continue
            call = stream.add_output_item_function_call(
                str(event.data.get("tool") or "tool"), item_id or "call"
            )
            tools[item_id] = (call, str(event.data.get("summary") or ""))
            yield call.emit_added()

        elif event.type == "tool.completed":
            pending = tools.pop(str(event.data.get("item_id") or ""), None)
            if pending is None:
                continue
            call, started_summary = pending
            arguments = tool_arguments(event.data, started_summary)
            yield call.emit_arguments_delta(arguments)
            yield call.emit_arguments_done(arguments)
            yield call.emit_done()

        elif event.type == "assistant.message.delta":
            for item in close_reasoning():
                yield item
            if text is None:
                message = stream.add_output_item_message()
                yield message.emit_added()
                text = message.add_text_content()
                yield text.emit_added()
            output += event.data["delta"]
            yield text.emit_delta(event.data["delta"])

        elif event.type == "assistant.message.completed":
            delta = completion_delta(output, event.data["text"])
            if not delta:
                continue
            if text is None:
                message = stream.add_output_item_message()
                yield message.emit_added()
                text = message.add_text_content()
                yield text.emit_added()
            output += delta
            yield text.emit_delta(delta)

    for item in close_reasoning():
        yield item
    for call, summary in tools.values():
        arguments = tool_arguments({}, summary)
        yield call.emit_arguments_delta(arguments)
        yield call.emit_arguments_done(arguments)
        yield call.emit_done()

    if text is None:
        message = stream.add_output_item_message()
        yield message.emit_added()
        text = message.add_text_content()
        yield text.emit_added()
    yield text.emit_text_done(output)
    yield text.emit_done()
    yield message.emit_done()
    yield stream.emit_completed()


if __name__ == "__main__":
    app.run()
