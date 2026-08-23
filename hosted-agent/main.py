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

from codex_adapter import CodexRuntime, load_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("haeronclaw.hosted_agent")

settings = load_settings()
runtime = CodexRuntime(settings)
app = ResponsesAgentServerHost(
    options=ResponsesServerOptions(default_fetch_history_count=20)
)


def _request_value(request: CreateResponse, name: str) -> Any:
    if hasattr(request, name):
        return getattr(request, name)
    if isinstance(request, dict):
        return request.get(name)
    return None


@app.response_handler
async def handle_response(
    request: CreateResponse,
    context: ResponseContext,
    cancellation_signal: asyncio.Event,
):
    prompt = (await context.get_input_text() or "").strip()
    if not prompt:
        raise ValueError("A non-empty text input is required")

    stream = ResponseEventStream(response_id=context.response_id, request=request)
    yield stream.emit_created()
    yield stream.emit_in_progress()

    message = stream.add_output_item_message()
    yield message.emit_added()
    text = message.add_text_content()
    yield text.emit_added()
    output = ""

    previous_response_id = _request_value(request, "previous_response_id")
    requested_model = _request_value(request, "model")
    if not isinstance(requested_model, str) or not requested_model.strip():
        requested_model = None

    async for event in runtime.stream_turn(
        prompt,
        previous_response_id=(
            previous_response_id if isinstance(previous_response_id, str) else None
        ),
        response_id=context.response_id,
        cancellation_signal=cancellation_signal,
        model=requested_model,
    ):
        logger.info(
            "codex_event %s",
            json.dumps({"type": event.type, **event.data}, ensure_ascii=False),
        )
        if event.type == "assistant.message.delta":
            delta = event.data["delta"]
            output += delta
            yield text.emit_delta(delta)

    yield text.emit_text_done(output)
    yield text.emit_done()
    yield message.emit_done()
    yield stream.emit_completed()


if __name__ == "__main__":
    app.run()
