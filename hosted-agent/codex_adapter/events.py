from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeEvent:
    type: str
    data: dict[str, Any]


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

    if method == "turn/started":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        return [RuntimeEvent("task.started", {"turn_id": turn.get("id")})]

    if method in {"item/started", "item/completed"}:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        event_type = "tool.started" if method == "item/started" else "tool.completed"
        if item_type in {
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
        }:
            return [
                RuntimeEvent(
                    event_type,
                    {
                        "item_id": item.get("id"),
                        "tool": item_type,
                        "status": item.get("status"),
                    },
                )
            ]

    if method == "turn/completed":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        status = str(turn.get("status") or "completed")
        event_type = "task.failed" if status == "failed" else "task.completed"
        return [RuntimeEvent(event_type, {"status": status, "turn_id": turn.get("id")})]

    return []
