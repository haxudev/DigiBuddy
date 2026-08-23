"""`AskSpec` - one runtime-neutral description of a question.

This is the portability seam. The interview emits `AskSpec` objects and knows
nothing about the host; each adapter projects the same object onto whatever the
host actually offers:

    agent runtime -> its own selection card              (render_plan)
    MCP           -> elicitation/create requestedSchema  (mcp/elicit.py)
    LangGraph     -> interrupt(payload)                  (adapters/langgraph.py)
    chat-only host -> a lettered list and a typed reply  (to_text_prompt)
    any SDK       -> plain JSON Schema                   (to_json_schema)

Nothing in this module mentions maturity assessment, so an unrelated
interview-style skill can reuse it as-is. In particular the escape wording, the
band labels and the free-text prompts all arrive as data on the `AskSpec`;
nothing user-facing is spelled in here, because a literal written into this
module would be an English string stranded inside a translated card.

Two invariants the rest of the package depends on:

* **Rendering never changes what gets recorded.** A five-option question asked
  as one card and the same question asked as a band card plus a refine card
  both resolve to the same option id. `render_plan` may reshape the cards; it
  may not reshape the answer.
* **A card either offers a labelled free-text slot or forbids free text.**
  `Card.free_text is None` means the host must switch its own free-text entry
  off - it is not "unspecified".
"""

from __future__ import annotations

import dataclasses
from typing import Any, Dict, List, Optional

SINGLE = "single"
MULTI = "multi"
TEXT = "text"
KINDS = (SINGLE, MULTI, TEXT)

# Who supplies the options the customer sees.
OPTIONS_FIXED = "fixed"  # they are on this AskSpec
OPTIONS_AGENT = "agent"  # the agent generates them at render time
OPTION_SOURCES = (OPTIONS_FIXED, OPTIONS_AGENT)

_LETTERS = "abcdefghijklmnopqrstuvwxyz"

# Synthetic id for the option that stands in for a collapsed group.
GROUP_PREFIX = "@"


class AnswerError(ValueError):
    """The supplied answer does not fit the AskSpec it claims to answer."""


@dataclasses.dataclass(frozen=True)
class Option:
    id: str
    label: str
    description: Optional[str] = None
    group: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out = {"id": self.id, "label": self.label}
        if self.description:
            out["description"] = self.description
        if self.group:
            out["group"] = self.group
        return out


@dataclasses.dataclass(frozen=True)
class Group:
    """A band of options that may be collapsed behind one option.

    A group without a `label` is not collapsible: there is no wording to put on
    the option that would stand in for it, and inventing one here would invent
    it in English.
    """

    id: str
    option_ids: List[str]
    label: Optional[str] = None
    description: Optional[str] = None

    @property
    def collapsible(self) -> bool:
        return bool(self.label) and len(self.option_ids) > 1

    def to_dict(self) -> Dict[str, Any]:
        out = {"id": self.id, "option_ids": list(self.option_ids)}
        if self.label:
            out["label"] = self.label
        if self.description:
            out["description"] = self.description
        return out


@dataclasses.dataclass(frozen=True)
class HostCaps:
    """What the host's own card tool can actually do.

    Read this off the tool's schema at runtime. `max_options=None` means the
    schema states no limit, which is not the same as a limit of zero.
    """

    max_options: Optional[int] = None
    header_limit: Optional[int] = None
    free_text: bool = True
    multi_select: bool = True

    @classmethod
    def uncapped(cls) -> "HostCaps":
        return cls()


@dataclasses.dataclass(frozen=True)
class AskSpec:
    id: str
    kind: str
    prompt: str
    options: List[Option] = dataclasses.field(default_factory=list)
    facilitator_note: Optional[str] = None
    placeholder: Optional[str] = None
    min_items: int = 0
    max_items: Optional[int] = None
    required: bool = True
    meta: Dict[str, Any] = dataclasses.field(default_factory=dict)
    # -- card projection --------------------------------------------------
    header: Optional[str] = None
    allow_free_text: bool = False
    free_text_label: Optional[str] = None
    free_text_option_label: Optional[str] = None
    option_source: str = OPTIONS_FIXED
    groups: List[Group] = dataclasses.field(default_factory=list)

    def __post_init__(self):
        if self.kind not in KINDS:
            raise ValueError("unknown ask kind {0!r}".format(self.kind))
        if self.option_source not in OPTION_SOURCES:
            raise ValueError(
                "unknown option source {0!r} on ask {1!r}".format(
                    self.option_source, self.id
                )
            )
        if self.kind in (SINGLE, MULTI) and not self.options:
            raise ValueError("{0} ask {1!r} needs options".format(self.kind, self.id))
        if self.kind == TEXT:
            if self.options:
                raise ValueError("text ask {0!r} cannot carry options".format(self.id))
            # A text ask *is* a free-text answer; making callers say so twice is
            # bookkeeping that would eventually disagree with itself.
            object.__setattr__(self, "allow_free_text", True)
        seen = set()
        for option in self.options:
            if option.id in seen:
                raise ValueError(
                    "duplicate option id {0!r} in ask {1!r}".format(option.id, self.id)
                )
            if option.id.startswith(GROUP_PREFIX):
                raise ValueError(
                    "option id {0!r} in ask {1!r} is reserved for collapsed "
                    "groups".format(option.id, self.id)
                )
            seen.add(option.id)
        # Card tools hand back the label, not the id, so two options sharing a
        # label are two answers the host cannot tell apart.
        labels = {}
        for option in self.options:
            key = _norm(option.label)
            if key in labels:
                raise ValueError(
                    "options {0!r} and {1!r} in ask {2!r} share the label {3!r}; a "
                    "host that answers by label could not tell them apart".format(
                        labels[key], option.id, self.id, option.label
                    )
                )
            labels[key] = option.id
        known = set(seen)
        for group in self.groups:
            for option_id in group.option_ids:
                if option_id not in known:
                    raise ValueError(
                        "group {0!r} in ask {1!r} names unknown option {2!r}".format(
                            group.id, self.id, option_id
                        )
                    )

    @property
    def option_ids(self) -> List[str]:
        return [option.id for option in self.options]

    def option(self, option_id: str) -> Option:
        for option in self.options:
            if option.id == option_id:
                return option
        raise AnswerError(
            "{0!r} is not an option for {1}; choose one of {2}".format(
                option_id, self.id, ", ".join(self.option_ids)
            )
        )

    def is_option(self, value) -> bool:
        """Did this answer arrive as one of the AskSpec's own options?"""
        return isinstance(value, str) and value in set(self.option_ids)

    # -- validation ------------------------------------------------------

    def validate(self, value, answer_source=None):
        """Normalize a host's raw answer, or raise AnswerError.

        Hosts vary in what they hand back, so a single-select may arrive as a
        one-element list and a multi-select as a comma-separated string. Both
        are accepted; anything ambiguous is rejected rather than guessed at.

        When `allow_free_text` is set, a single-select answer that matches no
        option is returned as the customer's own words rather than rejected.
        Callers separate the two with `is_option`.
        """
        if answer_source == "free_text" and self.kind == SINGLE:
            if not self.allow_free_text:
                raise AnswerError("{0} does not accept free text".format(self.id))
            if isinstance(value, (list, tuple)):
                if len(value) != 1:
                    raise AnswerError(
                        "{0} received {1} free-text values".format(self.id, len(value))
                    )
                value = value[0]
            if self.option_source == OPTIONS_FIXED and isinstance(value, str):
                try:
                    self._resolve_exact(value.strip())
                except AnswerError:
                    pass
                else:
                    raise AnswerError(
                        "{0!r} is a fixed option for {1}, not free text".format(
                            value, self.id
                        )
                    )
            return self._validate_text(value)
        if self.kind == TEXT:
            return self._validate_text(value)
        if self.kind == SINGLE:
            return self._validate_single(
                value,
                exact_only=(
                    answer_source == "option" and self.option_source == OPTIONS_AGENT
                ),
            )
        return self._validate_multi(value)

    def _validate_text(self, value):
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise AnswerError(
                "{0} expects text, got {1}".format(self.id, type(value).__name__)
            )
        value = value.strip()
        if self.required and not value:
            raise AnswerError("{0} requires a non-empty answer".format(self.id))
        return value

    def _validate_single(self, value, exact_only=False):
        if value is None and not self.required and self.allow_free_text:
            value = ""
        if isinstance(value, (list, tuple)):
            if len(value) != 1:
                raise AnswerError(
                    "{0} is single-select but received {1} values".format(
                        self.id, len(value)
                    )
                )
            value = value[0]
        if not isinstance(value, str):
            raise AnswerError(
                "{0} expects one option id, got {1}".format(
                    self.id, type(value).__name__
                )
            )
        token = value.strip()
        try:
            return self._resolve_exact(token) if exact_only else self._resolve(token)
        except AnswerError:
            if self.allow_free_text:
                if self.required and not token:
                    raise AnswerError(
                        "{0} requires an answer".format(self.id)
                    )
                return token
            raise

    def _validate_multi(self, value):
        if value is None:
            value = []
        if isinstance(value, str):
            value = self._split_multi_string(value)
        if not isinstance(value, (list, tuple)):
            raise AnswerError(
                "{0} expects a list of option ids, got {1}".format(
                    self.id, type(value).__name__
                )
            )
        chosen = []
        extra = []
        for raw in value:
            if not isinstance(raw, str):
                raise AnswerError(
                    "{0} expects option ids as strings".format(self.id)
                )
            token = raw.strip()
            if not token:
                continue
            try:
                resolved = self._resolve(token)
            except AnswerError:
                if not self.allow_free_text:
                    raise
                if token not in extra:
                    extra.append(token)
                continue
            if resolved not in chosen:
                chosen.append(resolved)
        if len(chosen) < self.min_items and not extra:
            raise AnswerError(
                "{0} needs at least {1} selection(s)".format(self.id, self.min_items)
            )
        if self.max_items is not None and len(chosen) + len(extra) > self.max_items:
            raise AnswerError(
                "{0} accepts at most {1} selection(s)".format(self.id, self.max_items)
            )
        return chosen + extra

    def _split_multi_string(self, value: str):
        """Turn one string into the list a multi-select expects.

        A chat host answers "a, c" and means two options; a customer typing into
        a free-text slot answers "A1: the register, reviewed monthly" and means
        one sentence. The separator is the same character, so splitting on it
        unconditionally silently truncates the sentence at its first comma.

        The rule is therefore: preserve the whole string when none of its comma
        fragments is an option. When some are options, keep those selections and
        keep all remaining prose as one free-text value. Never fragment prose
        into separate answers just because it contains punctuation.
        """
        separator = "," if self.allow_free_text else None
        if separator is None:
            parts = [part.strip() for part in value.replace(";", ",").split(",")]
        else:
            parts = [part.strip() for part in value.split(separator)]
        parts = [part for part in parts if part]
        if not parts:
            return []
        if not self.allow_free_text:
            return parts
        resolved = []
        unmatched = []
        for part in parts:
            try:
                option_id = self._resolve(part)
            except AnswerError:
                unmatched.append(part)
            else:
                resolved.append(option_id)
        if not resolved:
            return [value.strip()]
        if unmatched:
            resolved.append(", ".join(unmatched))
        return resolved

    def _resolve(self, token: str) -> str:
        """Map an option id, a label, a display letter, or a 1-based index onto an id.

        The label comes first because that is what a card tool actually hands
        back: `AskUserQuestion` and `question` both answer with the display
        string, not with anything the caller chose as an id.
        """
        try:
            return self._resolve_exact(token)
        except AnswerError:
            pass
        lowered = token.strip().lower()
        if len(lowered) == 1 and lowered in _LETTERS:
            index = _LETTERS.index(lowered)
            if index < len(self.options):
                return self.options[index].id
        if token.strip().isdigit():
            index = int(token.strip()) - 1
            if 0 <= index < len(self.options):
                return self.options[index].id
        raise AnswerError(
            "{0!r} is not an option for {1}; choose one of {2}".format(
                token, self.id, ", ".join(self.option_ids)
            )
        )

    def _resolve_exact(self, token: str) -> str:
        """Resolve only ids and labels, never chat fallback aliases."""
        normalized = _norm(token)
        for option in self.options:
            if option.id == token:
                return option.id
        for option in self.options:
            if _norm(option.label) == normalized:
                return option.id
        lowered = token.strip().lower()
        for option in self.options:
            if option.id.lower() == lowered:
                return option.id
        raise AnswerError(
            "{0!r} is not an option for {1}; choose one of {2}".format(
                token, self.id, ", ".join(self.option_ids)
            )
        )

    # -- projections -----------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "id": self.id,
            "kind": self.kind,
            "prompt": self.prompt,
            "required": self.required,
        }
        if self.header:
            out["header"] = self.header
        if self.options:
            out["options"] = [option.to_dict() for option in self.options]
        if self.groups:
            out["groups"] = [group.to_dict() for group in self.groups]
        if self.facilitator_note:
            # For the interviewer, never for the customer: these notes discuss
            # scoring, and one of them names the levels the probe fires at.
            out["facilitator_note"] = self.facilitator_note
        if self.placeholder:
            out["placeholder"] = self.placeholder
        if self.kind == MULTI:
            out["min_items"] = self.min_items
            if self.max_items is not None:
                out["max_items"] = self.max_items
        out["allow_free_text"] = self.allow_free_text
        if self.free_text_label:
            out["free_text_label"] = self.free_text_label
        if self.free_text_option_label:
            out["free_text_option_label"] = self.free_text_option_label
        out["option_source"] = self.option_source
        if self.meta:
            out["meta"] = dict(self.meta)
        return out

    def to_json_schema(self) -> Dict[str, Any]:
        """A plain JSON Schema for hosts that only speak function calling."""
        if self.kind == TEXT:
            field = {"type": "string", "description": self.prompt}
        elif self.kind == SINGLE:
            field = {"type": "string", "description": self.prompt}
            if self.allow_free_text:
                # An enum here would reject the customer's own words, which on
                # these asks is the only answer that can carry a specific fact.
                field["examples"] = self.option_ids
            else:
                field["enum"] = self.option_ids
        else:
            item = {"type": "string"}
            if self.allow_free_text:
                item["examples"] = self.option_ids
            else:
                item["enum"] = self.option_ids
            field = {
                "type": "array",
                "description": self.prompt,
                "items": item,
                "minItems": self.min_items,
            }
            if self.max_items is not None:
                field["maxItems"] = self.max_items
        return {
            "type": "object",
            "properties": {"answer": field},
            "required": ["answer"] if self.required else [],
            "additionalProperties": False,
        }

    def to_text_prompt(self) -> str:
        """The chat fallback documented in runtime-adapters.md.

        Customer-facing only: `facilitator_note` is deliberately excluded.
        """
        lines = [self.prompt]
        if self.options:
            lines.append("")
            for letter, option in zip(_LETTERS, self.options):
                lines.append("{0}) {1}".format(letter, option.label))
                if option.description:
                    lines.append("   {0}".format(option.description))
            lines.append("")
            if self.kind == SINGLE:
                lines.append("Reply with one letter.")
            else:
                lines.append("Reply with comma-separated letters.")
            if self.allow_free_text and self.free_text_label:
                lines.append(self.free_text_label)
        elif self.free_text_label:
            lines.append("")
            lines.append(self.free_text_label)
        elif self.placeholder:
            lines.append("")
            lines.append("Format: {0}".format(self.placeholder))
        return "\n".join(lines)

    # -- the card projection ---------------------------------------------

    def _card(self, options, caps: HostCaps, step: str, warnings) -> Dict[str, Any]:
        header = self.header or self.id
        if caps.header_limit and len(header) > caps.header_limit:
            # Shorten the label, never the question.
            header = header[: caps.header_limit].rstrip()
            warnings.append("header-shortened")
        free_text = self.free_text_label if self.allow_free_text else None
        if free_text and not caps.free_text:
            free_text = None
        card = {
            "ask_id": self.id,
            "step": step,
            "header": header,
            "question": self.prompt,
            "options": [
                {
                    "id": option.id,
                    "label": option.label,
                    "description": option.description or "",
                }
                for option in options
            ],
            "select_many": self.kind == MULTI,
            "free_text": free_text,
            "option_source": self.option_source,
        }
        return card

    def render_plan(self, caps: Optional[HostCaps] = None) -> Dict[str, Any]:
        """How this ask should reach the customer on a host with `caps`.

        Returns `mode` of `cards` or `plain-text`, the cards to render in order,
        and the text fallback. A second card is shown only when the first card's
        answer equals its `follow_up_id`.

        Reshaping the cards never reshapes the answer: whichever path is taken,
        the value handed back to `record` is one of this AskSpec's option ids or
        the customer's own text.
        """
        caps = caps or HostCaps.uncapped()
        warnings: List[str] = []
        text_fallback = self.to_text_prompt()

        def plain(reason):
            return {
                "mode": "plain-text",
                "reason": reason,
                "warnings": warnings,
                "cards": [],
                "text_fallback": text_fallback,
            }

        if self.kind == TEXT:
            if self.option_source == OPTIONS_AGENT:
                # The agent builds the card; there is nothing here to lay out
                # for it beyond the question and the rule in `meta`.
                if not caps.free_text:
                    return plain("no-free-text-for-open-answer")
                card = self._card([], caps, "direct", warnings)
                card["options"] = []
                return {
                    "mode": "cards",
                    "reason": "agent-generated-options",
                    "warnings": warnings,
                    "cards": [card],
                    "text_fallback": text_fallback,
                }
            return plain("open-answer")

        if self.kind == MULTI and not caps.multi_select:
            # Silently dropping to single-select discards choices the customer
            # made, and they never see it happen.
            return plain("no-multi-select")

        options = list(self.options)
        if self.allow_free_text and not caps.free_text:
            return plain("no-free-text")

        budget = caps.max_options

        if budget is not None and len(options) > budget:
            plan = _collapse(options, self.groups, budget)
            if plan is None:
                return plain("too-many-options")
            first, group, rest = plan
            warnings.append("group-collapsed")
            band = self._card(first, caps, "band", warnings)
            refine = self._card(rest, caps, "refine", warnings)
            refine["free_text"] = None
            band["follow_up_id"] = GROUP_PREFIX + group.id
            band["follow_up_label"] = group.label
            return {
                "mode": "cards",
                "reason": "collapsed-to-fit",
                "warnings": warnings,
                "cards": [band, refine],
                "text_fallback": text_fallback,
            }

        card = self._card(options, caps, "direct", warnings)
        return {
            "mode": "cards",
            "reason": "fits",
            "warnings": warnings,
            "cards": [card],
            "text_fallback": text_fallback,
        }


def _collapse(options, groups, budget):
    """Fold one collapsible group behind a single option so the card fits.

    Returns `(first_card_options, group, refine_options)` or None when no single
    collapse gets under `budget`. Only one group is ever collapsed: chaining
    refine cards would turn one question into a menu tree, which is a sign the
    question is under-analysed rather than a rendering problem.
    """
    if budget is None or budget < 2:
        return None
    by_id = {option.id: option for option in options}
    for group in sorted(groups, key=lambda g: -len(g.option_ids)):
        if not group.collapsible:
            continue
        members = [by_id[oid] for oid in group.option_ids if oid in by_id]
        if len(members) < 2:
            continue
        remaining = [o for o in options if o.id not in set(group.option_ids)]
        stand_in = Option(
            id=GROUP_PREFIX + group.id,
            label=group.label,
            description=group.description,
        )
        first = remaining + [stand_in]
        if len(first) <= budget and len(members) <= budget:
            return first, group, members
    return None


def _norm(text) -> str:
    if not isinstance(text, str):
        return ""
    return " ".join(text.split()).strip().lower()


def letter_options(labels, prefix="", descriptions=None, groups=None) -> List[Option]:
    """Build positional options whose ids carry no information about ordering
    semantics beyond the order the customer already sees."""
    descriptions = descriptions or []
    groups = groups or []
    out = []
    for index, label in enumerate(labels):
        out.append(
            Option(
                id="{0}{1}".format(prefix, _LETTERS[index]),
                label=label,
                description=descriptions[index] if index < len(descriptions) else None,
                group=groups[index] if index < len(groups) else None,
            )
        )
    return out
