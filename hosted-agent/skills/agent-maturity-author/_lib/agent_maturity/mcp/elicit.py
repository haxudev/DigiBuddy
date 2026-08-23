"""Project an `AskSpec` onto an MCP `elicitation/create` request.

Form-mode `requestedSchema` is restricted to a flat object of primitives, so
the three ask kinds map like this:

    text   -> {"type": "string"}
    single -> {"type": "string", "oneOf": [{"const", "title"}]}     2025-11-25
              {"type": "string", "enum": [...], "enumNames": [...]} 2025-06-18
    multi  -> {"type": "array", "items": {"anyOf": [...]}}          2025-11-25
              one boolean property per option                       2025-06-18

The 2025-06-18 revision has no array form at all, which is why a multi-select
degrades to a set of booleans there rather than to a free-text field: booleans
are still a real control the client can render and validate.
"""

from __future__ import annotations

from typing import Any, Dict

from ..askspec import MULTI, SINGLE, TEXT, AskSpec

ANSWER_KEY = "answer"
FREE_TEXT_KEY = "answer_text"
MODERN = "2025-11-25"


def supports_arrays(protocol_version: str) -> bool:
    return protocol_version == MODERN


def message_for(ask: AskSpec) -> str:
    """What the client renders to whoever is answering.

    The customer sees this, so it carries the question and nothing else -
    `facilitator_note` discusses scoring, and `meta.judge_rule` states what
    would pass the disconfirming probe.
    """
    message = ask.prompt
    if ask.free_text_label and ask.allow_free_text:
        message += "\n\n" + ask.free_text_label
    elif ask.placeholder:
        message += "\n\nFormat: " + ask.placeholder
    return message


def requested_schema(ask: AskSpec, protocol_version: str = MODERN) -> Dict[str, Any]:
    if ask.kind == TEXT:
        return _wrap(_text_field(ask), required=ask.required)
    if ask.kind == SINGLE:
        return _wrap(_single_field(ask, protocol_version), required=ask.required)
    if ask.allow_free_text:
        return _multi_with_text(ask, protocol_version)
    if supports_arrays(protocol_version):
        return _wrap(_multi_field(ask), required=ask.min_items > 0)
    return _boolean_matrix(ask)


def _wrap(field: Dict[str, Any], required: bool) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {ANSWER_KEY: field},
        "required": [ANSWER_KEY] if required else [],
    }


def _text_field(ask: AskSpec) -> Dict[str, Any]:
    field: Dict[str, Any] = {"type": "string", "title": _title(ask)}
    if ask.free_text_label:
        field["description"] = ask.free_text_label
    elif ask.placeholder:
        field["description"] = ask.placeholder
    return field


def _option_entry(option) -> Dict[str, Any]:
    entry: Dict[str, Any] = {"const": option.id, "title": option.label}
    if option.description:
        entry["description"] = option.description
    return entry


def _single_field(ask: AskSpec, protocol_version: str) -> Dict[str, Any]:
    if ask.allow_free_text:
        # An enum would reject the customer's own words, and on these asks that
        # is the only answer carrying a specific fact. The options survive as
        # examples so the client can still suggest them.
        field: Dict[str, Any] = {"type": "string", "title": _title(ask)}
        if ask.free_text_label:
            field["description"] = ask.free_text_label
        field["examples"] = [option.label for option in ask.options]
        return field
    field = {"type": "string", "title": _title(ask)}
    if supports_arrays(protocol_version):
        field["oneOf"] = [_option_entry(option) for option in ask.options]
    else:
        field["enum"] = ask.option_ids
        field["enumNames"] = [_option_text(option) for option in ask.options]
    return field


def _multi_field(ask: AskSpec) -> Dict[str, Any]:
    field: Dict[str, Any] = {
        "type": "array",
        "title": _title(ask),
        "items": {"anyOf": [_option_entry(option) for option in ask.options]},
    }
    if ask.min_items:
        field["minItems"] = ask.min_items
    field["maxItems"] = ask.max_items or len(ask.options)
    return field


def _option_text(option) -> str:
    if option.description:
        return "{0} - {1}".format(option.label, option.description)
    return option.label


def _multi_with_text(ask: AskSpec, protocol_version: str) -> Dict[str, Any]:
    if supports_arrays(protocol_version):
        properties = {
            ANSWER_KEY: _multi_field(ask),
            FREE_TEXT_KEY: {
                "type": "string",
                "title": ask.free_text_label or _title(ask),
            },
        }
    else:
        properties = _boolean_matrix(ask)["properties"]
        properties[FREE_TEXT_KEY] = {
            "type": "string",
            "title": ask.free_text_label or _title(ask),
        }
    schema = {"type": "object", "properties": properties, "required": []}
    if ask.min_items > 0:
        # JSON Schema cannot express "a non-empty array or a non-empty string"
        # with `required` alone. Keep the fields flat for MCP form mode and put
        # the either/or constraint at the object level.
        schema["anyOf"] = [
            {
                "required": [ANSWER_KEY],
                "properties": {ANSWER_KEY: {"minItems": ask.min_items}},
            },
            {
                "required": [FREE_TEXT_KEY],
                "properties": {FREE_TEXT_KEY: {"minLength": 1}},
            },
        ]
    return schema


def _boolean_matrix(ask: AskSpec) -> Dict[str, Any]:
    properties = {
        option.id: {"type": "boolean", "title": option.label, "default": False}
        for option in ask.options
    }
    return {"type": "object", "properties": properties, "required": []}


def _title(ask: AskSpec) -> str:
    # The prompt already carries the question; the title is the control's label,
    # so it stays short enough to survive a cramped form.
    return ask.id


def extract(ask: AskSpec, content, protocol_version: str = MODERN):
    """Pull the answer out of an accepted elicitation result."""
    if not isinstance(content, dict):
        return [] if ask.kind == MULTI else ""
    if ask.kind == MULTI and not supports_arrays(protocol_version):
        values = [
            option.id for option in ask.options if bool(content.get(option.id))
        ]
        text = content.get(FREE_TEXT_KEY)
        if ask.allow_free_text and isinstance(text, str) and text.strip():
            values.append(text.strip())
        return values
    if ask.kind == MULTI and ask.allow_free_text:
        values = content.get(ANSWER_KEY) or []
        if not isinstance(values, list):
            values = []
        text = content.get(FREE_TEXT_KEY)
        if isinstance(text, str) and text.strip():
            values.append(text.strip())
        return values
    value = content.get(ANSWER_KEY)
    if value is None:
        return [] if ask.kind == MULTI else ""
    return value


def elicit_ask(session, ask: AskSpec):
    """Ask one question through the client. Returns (action, value)."""
    version = getattr(session, "protocol_version", MODERN) or MODERN
    result = session.elicit(
        message=message_for(ask),
        requested_schema=requested_schema(ask, version),
    )
    action = result.get("action")
    if action != "accept":
        return (action or "cancel"), None
    return "accept", extract(ask, result.get("content"), version)
