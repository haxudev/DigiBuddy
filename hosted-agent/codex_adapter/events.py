from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeEvent:
    type: str
    data: dict[str, Any]


TOOL_ITEM_TYPES = {
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
}

_TOOL_LABELS = {
    "commandExecution": "Ran a command",
    "fileChange": "Edited files",
    "mcpToolCall": "Called an MCP tool",
    "dynamicToolCall": "Called a tool",
    "webSearch": "Searched the web",
}

# Codex has spelled the reasoning stream differently across app-server
# releases, so every shipped variant is accepted; unknown ones yield no event.
_REASONING_DELTA_METHODS = {
    "item/reasoning/delta",
    "item/reasoning/summaryDelta",
    "item/agentReasoning/delta",
    "item/agentReasoningDelta",
}


def _first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def tool_summary(item: dict[str, Any]) -> str:
    """Describe a tool item in the single line the console shows collapsed."""
    item_type = str(item.get("type") or "")
    fallback = _TOOL_LABELS.get(item_type, item_type or "Tool")
    if item_type == "commandExecution":
        command = item.get("command")
        if isinstance(command, list):
            command = " ".join(str(part) for part in command)
        return _first_text(command) or fallback
    if item_type == "fileChange":
        changes = item.get("changes")
        paths = (
            [
                str(change.get("path"))
                for change in changes
                if isinstance(change, dict) and change.get("path")
            ]
            if isinstance(changes, list)
            else []
        )
        return ", ".join(paths) if paths else fallback
    if item_type in {"mcpToolCall", "dynamicToolCall"}:
        server = _first_text(item.get("server"))
        tool = _first_text(item.get("tool"), item.get("name"))
        if server and tool:
            return f"{server}.{tool}"
        return tool or fallback
    if item_type == "webSearch":
        return _first_text(item.get("query")) or fallback
    return fallback


def tool_arguments(data: dict[str, Any], fallback: str = "") -> str:
    """Build one valid function-call argument document from final tool metadata."""
    summary = _first_text(data.get("summary"), fallback)
    return json.dumps({"summary": summary}, ensure_ascii=False)


def completion_delta(streamed: str, completed: str) -> str:
    """Return the authoritative suffix when completion contains the streamed prefix."""
    if completed.startswith(streamed):
        return completed[len(streamed) :]
    return completed if not streamed else ""


def turn_error_message(error: Any) -> str:
    """Read why Codex gave up, in the words it used.

    A failed turn used to reach the caller as a bare internal server error:
    Codex says what went wrong -- a rate limit, a context overflow, a sandbox
    refusal -- and the adapter discarded all of it. `additionalDetails` is
    excluded because it can carry whatever a tool printed.
    """
    if not isinstance(error, dict):
        return ""
    message = _first_text(error.get("message"))
    info = error.get("codexErrorInfo")
    code = ""
    if isinstance(info, dict):
        code = _first_text(info.get("type"), info.get("code"))
    elif isinstance(info, str):
        code = _first_text(info)
    if message and code and code.lower() not in message.lower():
        return f"{message} ({code})"
    return message or code


def translate_notification(message: dict[str, Any]) -> list[RuntimeEvent]:
    method = str(message.get("method") or "")
    params = message.get("params")
    if not isinstance(params, dict):
        params = {}

    if method == "item/agentMessage/delta":
        delta = params.get("delta")
        if isinstance(delta, str) and delta:
            return [RuntimeEvent("assistant.message.delta", {"delta": delta})]
        return []

    if method in _REASONING_DELTA_METHODS:
        delta = params.get("delta")
        if not isinstance(delta, str):
            delta = params.get("text")
        if isinstance(delta, str) and delta:
            return [RuntimeEvent("assistant.reasoning.delta", {"delta": delta})]
        return []

    if method == "turn/started":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        return [RuntimeEvent("task.started", {"turn_id": turn.get("id")})]

    if method in {"item/started", "item/completed"}:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        if item_type == "agentMessage":
            if method != "item/completed":
                return []
            text = item.get("text")
            return (
                [RuntimeEvent("assistant.message.completed", {"text": text})]
                if isinstance(text, str) and text
                else []
            )
        if item_type == "reasoning":
            # The completed item repeats the whole summary, so it is reported
            # separately and only used when no delta stream arrived.
            if method != "item/completed":
                return []
            text = _first_text(item.get("text"), item.get("summary"))
            return (
                [RuntimeEvent("assistant.reasoning.completed", {"text": text})]
                if text
                else []
            )
        if item_type in TOOL_ITEM_TYPES:
            event_type = (
                "tool.started" if method == "item/started" else "tool.completed"
            )
            return [
                RuntimeEvent(
                    event_type,
                    {
                        "item_id": item.get("id"),
                        "tool": item_type,
                        "status": item.get("status"),
                        "summary": tool_summary(item),
                    },
                )
            ]

    if method == "turn/completed":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        status = str(turn.get("status") or "completed")
        if status != "failed":
            return [
                RuntimeEvent(
                    "task.completed", {"status": status, "turn_id": turn.get("id")}
                )
            ]
        return [
            RuntimeEvent(
                "task.failed",
                {
                    "status": status,
                    "turn_id": turn.get("id"),
                    "message": turn_error_message(turn.get("error")),
                },
            )
        ]

    if method == "error":
        # Codex reports the reason here and repeats the failure on
        # `turn/completed`. A retried error is not the end of the turn, so it
        # is recorded rather than treated as the outcome.
        return [
            RuntimeEvent(
                "turn.error",
                {
                    "message": turn_error_message(params.get("error")),
                    "will_retry": bool(params.get("willRetry")),
                },
            )
        ]

    if method == "mcpServer/startupStatus/updated":
        return [
            RuntimeEvent(
                "mcp.startup",
                {
                    "server": _first_text(params.get("name")),
                    "status": _first_text(params.get("status")) or "unknown",
                    "message": _first_text(params.get("error")),
                    "reason": _first_text(params.get("failureReason")),
                },
            )
        ]

    return []
