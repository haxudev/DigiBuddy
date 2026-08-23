"""Read-only access to the question bank, with language resolution.

The bank is data: an industry variant or a new language is an edit to
`question-bank.json` and no code change. Everything here therefore reads the
bank defensively and never assumes more structure than the validator enforces.
"""

from __future__ import annotations

import json

from .paths import bank_path

BANK_SCHEMA = "agent-maturity-bank/2"
LEVELS = (100, 200, 300, 400, 500)
LANGUAGES = ("en", "zh")
DEFAULT_LANGUAGE = "en"

# A card option's label has to be readable at a glance; the rest of the anchor
# becomes its description. Anything longer than this is a badly-split anchor
# and needs an authored `short` override, which the bank validator reports.
SHORT_LABEL_MAX = 80

_CACHE = {}


class BankError(Exception):
    pass


def load_bank(path=None, use_cache=True) -> dict:
    resolved = path or bank_path()
    if use_cache and resolved in _CACHE:
        return _CACHE[resolved]
    with open(resolved, encoding="utf-8") as fh:
        bank = json.load(fh)
    if bank.get("schema") != BANK_SCHEMA:
        raise BankError(
            "unsupported bank schema {0!r}; expected {1!r}".format(
                bank.get("schema"), BANK_SCHEMA
            )
        )
    if use_cache:
        _CACHE[resolved] = bank
    return bank


def t(node, lang=DEFAULT_LANGUAGE, default="") -> str:
    """Resolve an {"en": ..., "zh": ...} node, falling back to English."""
    if node is None:
        return default
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return default
    for key in (lang, DEFAULT_LANGUAGE):
        value = node.get(key)
        if isinstance(value, str) and value:
            return value
    for value in node.values():
        if isinstance(value, str) and value:
            return value
    return default


def normalize_language(lang) -> str:
    if isinstance(lang, str):
        lowered = lang.strip().lower()
        if lowered in LANGUAGES:
            return lowered
        base = lowered.split("-")[0].split("_")[0]
        if base in LANGUAGES:
            return base
    return DEFAULT_LANGUAGE


def t_strict(node, lang) -> str:
    """Resolve a localized node in `lang` only, with no English fallback.

    `t` falls back to English so a half-translated bank still runs. That is
    wrong for an override: a `short` label authored only in English would then
    be handed to a Chinese card as an untranslated string, when the correct
    behaviour is to derive the Chinese label from the Chinese anchor instead.
    """
    if isinstance(node, dict):
        value = node.get(lang)
        if isinstance(value, str) and value:
            return value
    return ""


def tier_config(bank: dict, tier: str) -> dict:
    tiers = bank.get("tiers", {})
    if tier not in tiers:
        raise BankError(
            "unknown tier {0!r}; the bank defines {1}".format(tier, sorted(tiers))
        )
    return tiers[tier]


def tier_ids(bank: dict):
    return list(bank.get("tiers", {}).keys())


def pillars(bank: dict):
    return list(bank.get("pillars", []))


def pillar_ids(bank: dict):
    return [p["id"] for p in pillars(bank)]


def find_pillar(bank: dict, pillar_id: str) -> dict:
    for pillar in pillars(bank):
        if pillar["id"] == pillar_id:
            return pillar
    raise BankError("unknown pillar {0!r}".format(pillar_id))


def walk(bank: dict):
    """Yield (pillar, dimension) in bank order: A1, A2, A3, B1, ... E3."""
    for pillar in pillars(bank):
        for dimension in pillar.get("dimensions", []):
            yield pillar, dimension


def dimension_ids(bank: dict):
    return [dimension["id"] for _, dimension in walk(bank)]


def find_dimension(bank: dict, dimension_id: str):
    for pillar, dimension in walk(bank):
        if dimension["id"] == dimension_id:
            return pillar, dimension
    raise BankError("unknown sub-dimension {0!r}".format(dimension_id))


def rai_dimension_ids(bank: dict):
    return [d["id"] for _, d in walk(bank) if d.get("rai_bearing")]


def anchors(dimension: dict):
    return list(dimension.get("qa", {}).get("anchors", []))


# ------------------------------------------------------------ card projection
#
# A selection card wants a short label with the detail beside it, not a
# paragraph crammed into the label. The anchors are already written as a
# headline sentence followed by its elaboration, so the split is derived rather
# than authored: a hand-written second copy of 75 anchors in two languages is 75
# more places for the card and the score to drift apart. `short` exists only as
# an override for the few anchors whose first sentence does not stand alone.

_HARD_STOPS = "。！？"
_SOFT_STOPS = ".!?"


def split_sentence(text: str):
    """Split `text` into (first sentence, remainder), both stripped."""
    text = (text or "").strip()
    if not text:
        return "", ""
    for index, char in enumerate(text):
        if char in _HARD_STOPS:
            return text[: index + 1].strip(), text[index + 1 :].strip()
        if char in _SOFT_STOPS:
            following = text[index + 1 : index + 2]
            if following == "" or following.isspace():
                return text[: index + 1].strip(), text[index + 1 :].strip()
    return text, ""


def anchor_label(anchor: dict, lang=DEFAULT_LANGUAGE):
    """The (label, description) pair a card renders for one anchor.

    An authored `short` wins; otherwise the first sentence is the label and the
    rest is the description. When the anchor is a single sentence the
    description is empty, which is correct - a description that restates the
    label is worse than none.
    """
    full = t(anchor.get("text"), lang)
    override = t_strict(anchor.get("short"), lang)
    if override:
        remainder = full[len(override) :].strip() if full.startswith(override) else full
        return override, remainder
    label, remainder = split_sentence(full)
    return label, remainder


def fail_exemplar(dimension: dict, lang=DEFAULT_LANGUAGE) -> str:
    """The canonical non-answer for this sub-dimension's disconfirming probe.

    Every `pass_test` names the answer that fails, in quotes - "'We review it
    regularly' is a fail". Lifting it out gives the agent a seed for the options
    it generates without handing it the pass criterion, which stays in
    `judge_rule` and never reaches the customer.

    Raises rather than returning a placeholder: a bank edit that drops the quote
    should fail loudly, not quietly produce a probe with nothing to anchor on.
    """
    qc = dimension.get("qc") or {}
    override = t_strict(qc.get("fail_exemplar"), lang)
    if override:
        return override
    quoted = extract_quoted(t(qc.get("pass_test"), lang))
    if quoted:
        return quoted
    raise BankError(
        "{0} has no fail_exemplar and its pass_test names no quoted example; "
        "add qc.fail_exemplar to the bank".format(dimension.get("id", "?"))
    )


_QUOTE_PAIRS = (("「", "」"), ("“", "”"), ("'", "'"), ('"', '"'))


def extract_quoted(text: str) -> str:
    """The first quoted span in `text`, whatever quote marks it uses."""
    if not isinstance(text, str):
        return ""
    for opener, closer in _QUOTE_PAIRS:
        start = text.find(opener)
        if start < 0:
            continue
        end = text.find(closer, start + len(opener))
        if end > start:
            span = text[start + len(opener) : end].strip()
            if span:
                return span
    return ""


def dimension_header(dimension: dict, lang=DEFAULT_LANGUAGE) -> str:
    """The short label a card puts on every ask for this sub-dimension.

    Falls back to the id, which is meaningless to the customer but always fits;
    the bank validator flags a missing header so it does not stay that way.
    """
    header = t_strict(dimension.get("header"), lang) or t(dimension.get("header"), lang)
    return header or dimension.get("id", "")


def level_name(bank: dict, level, lang=DEFAULT_LANGUAGE) -> str:
    names = bank.get("model", {}).get("level_names", {})
    return t(names.get(str(level)), lang, default=str(level))


def model_meta(bank: dict) -> dict:
    return bank.get("model", {})
