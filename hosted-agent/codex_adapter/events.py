from __future__ import annotations

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
        delta = _first_text(params.get("delta"), params.get("text"))
        if delta:
            return [RuntimeEvent("assistant.reasoning.delta", {"delta": delta})]
        return []

    if method == "turn/started":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        return [RuntimeEvent("task.started", {"turn_id": turn.get("id")})]

    if method in {"item/started", "item/completed"}:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
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
        event_type = "task.failed" if status == "failed" else "task.completed"
        return [RuntimeEvent(event_type, {"status": status, "turn_id": turn.get("id")})]

    return []
