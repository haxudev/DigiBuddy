"""The tool surface, independent of any protocol.

Every capability the skills need is a plain Python function with a JSON Schema
attached. `mcp/tools.py` adapts this registry onto MCP, `cli.py` adapts it onto
argv, and an OpenAI/LangGraph/ADK host can adapt it onto its own function
calling with no further work.

Two rules hold throughout:

* **Nothing here writes to stdout.** The MCP stdio transport reserves stdout
  for protocol frames, so a stray `print` would corrupt a live session.
* **Handlers raise `ToolError` for anything the caller could fix.** The
  adapters turn that into the host's error shape and leave the session usable.
"""

from __future__ import annotations

import dataclasses
import json
import os
from typing import Any, Callable, Dict, List, Optional

from . import bank as bank_mod
from . import interview, paths, session
from .askspec import OPTIONS_AGENT, AnswerError, AskSpec, HostCaps

# The two host classes the binding table in references/choice-cards.md actually
# splits into. Both plans are emitted for every ask so the agent can pick by
# reading its own tool schema, which is the only authority on what it can
# render, without the server having to remember anything about the host.
UNCAPPED = HostCaps()
CAPPED = HostCaps(max_options=4, header_limit=12)
from .radar import radar_svg
from .report import build as build_html
from .scoring import CAP_REASONS, ScoringError, build_assessment
from .validation import Bad as ValidationError
from .validation import validate as validate_assessment


class ToolError(Exception):
    """A failure the caller can act on: bad arguments, missing state, bad file."""


# The tightest header limit in references/choice-cards.md. A header longer than
# this is silently shortened by the host, which is how a card label turns into
# a truncated word in front of a customer.
CARD_HEADER_MAX = 12


@dataclasses.dataclass(frozen=True)
class ToolDef:
    name: str
    title: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[..., Dict[str, Any]]
    requires: Optional[str] = None
    read_only: bool = False


class ToolContext:
    """Host capabilities a tool may use when the host actually has them.

    `elicit` receives an `AskSpec` and returns `(action, value)` where action is
    one of accept / decline / cancel. It is `None` on hosts that cannot ask the
    user directly, which is why the stepwise tools exist.
    """

    def __init__(self, elicit=None):
        self._elicit = elicit

    @property
    def can_elicit(self) -> bool:
        return self._elicit is not None

    def elicit(self, ask: AskSpec):
        if self._elicit is None:
            raise ToolError(
                "this host cannot ask the user directly; drive the interview with "
                "maturity_next_question and maturity_record_answer instead"
            )
        return self._elicit(ask)


# ---------------------------------------------------------------- helpers


def _bank(path=None):
    try:
        return bank_mod.load_bank(path)
    except (OSError, ValueError, bank_mod.BankError, paths.ReferenceNotFound) as exc:
        raise ToolError(str(exc))


def _load(session_dir):
    if not session_dir:
        raise ToolError("session_dir is required")
    try:
        return session.load_answers(session_dir)
    except session.SessionError as exc:
        raise ToolError(str(exc))
    except (OSError, ValueError) as exc:
        raise ToolError("could not read the answers file: {0}".format(exc))


def _read_json(path, label):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise ToolError("could not read {0} at {1}: {2}".format(label, path, exc))
    except ValueError as exc:
        raise ToolError("{0} at {1} is not valid JSON: {2}".format(label, path, exc))


def _assessment_path(session_dir=None, assessment=None):
    if assessment:
        return os.path.abspath(assessment)
    if session_dir:
        return os.path.join(os.path.abspath(session_dir), "assessment.json")
    raise ToolError("pass either assessment or session_dir")


def _ask_payload(bank, doc, ask):
    if ask is None:
        return None
    payload = ask.to_dict()
    payload["text_fallback"] = ask.to_text_prompt()
    payload["card"] = ask.render_plan(UNCAPPED)
    payload["card_capped"] = ask.render_plan(CAPPED)
    return payload


def _advance(bank, doc, session_dir, extra=None):
    """Persist, then describe the next step. Persistence happens first so a
    crash between writing and answering loses nothing."""
    ask = interview.next_ask(bank, doc)
    complete = interview.is_complete(bank, doc)
    session.save_answers(
        session_dir,
        doc,
        cursor=ask.id if ask else None,
        status="complete" if complete else "in_progress",
    )
    out = {
        "session_dir": os.path.abspath(session_dir),
        "next_question": _ask_payload(bank, doc, ask),
        "complete": complete,
        "pending_judgements": interview.pending_judgements(bank, doc),
    }
    if complete:
        out["hint"] = "All sub-dimensions are recorded. Call maturity_score next."
    if extra:
        out.update(extra)
    return out


# ---------------------------------------------------------------- handlers


def start_session(
    session_dir,
    organization=None,
    sector=None,
    tier=None,
    language=None,
    participant_roles=None,
    focus_pillars=None,
    overwrite=False,
):
    bank = _bank()
    path = session.answers_path(session_dir)
    if os.path.exists(path) and not overwrite:
        doc = _load(session_dir)
        return _advance(
            bank,
            doc,
            session_dir,
            {
                "resumed": True,
                "resume_sentence": interview.resume_sentence(bank, doc),
                "answers_path": path,
            },
        )

    doc = session.new_answers_doc({})
    supplied = [
        ("framing.language", language),
        ("framing.organization", organization),
        ("framing.sector", sector),
        ("framing.roles", participant_roles),
        ("framing.focus", focus_pillars),
        ("framing.tier", tier),
    ]
    prefilled = []
    skipped = []
    for ask_id, value in supplied:
        if value in (None, "", []):
            continue
        # Only accept a pre-filled answer at the point the interview would ask
        # for it, so the sequence stays the single source of order. A gap
        # earlier in the sequence therefore blocks everything after it.
        if interview.next_ask_id(bank, doc) != ask_id:
            skipped.append(ask_id)
            continue
        try:
            ask = interview.build_ask(bank, doc, ask_id)
            interview.record(
                bank,
                doc,
                ask_id,
                value,
                answer_source="free_text" if ask.option_source == OPTIONS_AGENT else None,
            )
        except (AnswerError, interview.InterviewError) as exc:
            raise ToolError(str(exc))
        prefilled.append(ask_id)

    extra = {
        "resumed": False,
        "prefilled": prefilled,
        "answers_path": path,
    }
    if skipped:
        extra["not_prefilled"] = skipped
        extra["note"] = (
            "These framing values were supplied but an earlier question was still "
            "unanswered, so they will be asked in sequence: " + ", ".join(skipped)
        )
    return _advance(bank, doc, session_dir, extra)


def next_question(session_dir):
    bank = _bank()
    doc = _load(session_dir)
    ask = interview.next_ask(bank, doc)
    return {
        "session_dir": os.path.abspath(session_dir),
        "next_question": _ask_payload(bank, doc, ask),
        "complete": interview.is_complete(bank, doc),
        "resume_sentence": interview.resume_sentence(bank, doc),
        "pending_judgements": interview.pending_judgements(bank, doc),
    }


def record_answer(
    session_dir, ask_id, value=None, quote=None, inferred=None, answer_source=None
):
    if not ask_id:
        raise ToolError("ask_id is required; get it from maturity_next_question")
    bank = _bank()
    doc = _load(session_dir)
    expected = interview.next_ask_id(bank, doc)
    if expected is not None and ask_id != expected and ask_id not in interview.asked_ids(doc):
        raise ToolError(
            "the interview is at {0}, not {1}; answer questions in the order they "
            "are issued so the sequence stays reproducible".format(expected, ask_id)
        )
    try:
        written = interview.record(
            bank,
            doc,
            ask_id,
            value,
            quote=quote,
            inferred=inferred,
            answer_source=answer_source,
        )
    except AnswerError as exc:
        raise ToolError(str(exc))
    except interview.InterviewError as exc:
        raise ToolError(str(exc))
    return _advance(bank, doc, session_dir, {"recorded": written})


def judge_probe(session_dir, dimension_id, passed, rationale=None):
    bank = _bank()
    doc = _load(session_dir)
    try:
        entry = interview.judge_probe(doc, dimension_id, passed, rationale, bank=bank)
    except interview.InterviewError as exc:
        raise ToolError(str(exc))
    except bank_mod.BankError as exc:
        raise ToolError(str(exc))
    return _advance(
        bank,
        doc,
        session_dir,
        {"dimension": dimension_id, "qc_passed": entry.get("qc_passed")},
    )


def session_status(session_dir):
    bank = _bank()
    doc = _load(session_dir)
    state = interview.status(bank, doc)
    state["session_dir"] = os.path.abspath(session_dir)
    state["answers_path"] = session.answers_path(session_dir)
    state["resume_sentence"] = interview.resume_sentence(bank, doc)
    return state


def run_interview(session_dir, max_questions=0, context=None):
    """Drive the interview directly through the host's own ask UI.

    Only offered where the host declared it can ask the user. Every accepted
    answer is persisted before the next question is issued, so a decline, a
    cancel or a dropped connection all leave a session that resumes.
    """
    if context is None or not context.can_elicit:
        raise ToolError(
            "this host cannot ask the user directly; use maturity_next_question "
            "and maturity_record_answer"
        )
    bank = _bank()
    doc = _load(session_dir)
    asked = 0
    limit = int(max_questions or 0)
    stopped = "complete"

    while True:
        ask = interview.next_ask(bank, doc)
        if ask is None:
            stopped = "complete"
            break
        if limit and asked >= limit:
            stopped = "limit_reached"
            break
        action, value = context.elicit(ask)
        if action != "accept":
            stopped = action
            break
        try:
            # An elicitation returns whatever the host's own control produced,
            # so the source is derived from the value rather than declared. An
            # agent-generated card cannot reach this path: `run_interview` uses
            # the host's control, and the options on it are the AskSpec's own.
            if ask.option_source == OPTIONS_AGENT:
                normalized = ask.validate(value)
                source = "option" if ask.is_option(normalized) else "free_text"
            else:
                source = None
            interview.record(
                bank,
                doc,
                ask.id,
                value,
                answer_source=source,
            )
        except AnswerError as exc:
            # The host returned something its own schema should have prevented.
            # That is a host bug, not a bad answer from the customer, so stop
            # with the session intact rather than guess at what was meant.
            session.save_answers(session_dir, doc, cursor=ask.id)
            raise ToolError(
                "the host returned an answer for {0} that does not fit the "
                "question it was asked: {1}".format(ask.id, exc)
            )
        asked += 1
        session.save_answers(session_dir, doc, cursor=None)

    result = _advance(bank, doc, session_dir, {"asked": asked, "stopped": stopped})
    if result["pending_judgements"]:
        result["hint"] = (
            "Judge each pending disconfirming probe with maturity_judge_probe "
            "against the pass_test it carries, then call maturity_score."
        )
    return result


def score_session(session_dir=None, answers=None, out=None, bank_path=None):
    bank = _bank(bank_path)
    if answers:
        answers_file = os.path.abspath(answers)
        doc = _read_json(answers_file, "answers")
        base = os.path.dirname(answers_file)
    else:
        if not session_dir:
            raise ToolError("pass either session_dir or answers")
        doc = _load(session_dir)
        base = os.path.abspath(session_dir)

    missing = [
        dim
        for dim in bank_mod.dimension_ids(bank)
        if (doc.get("answers", {}).get(dim) or {}).get("anchor") is None
    ]
    if missing:
        raise ToolError(
            "cannot score yet: {0} sub-dimension(s) have no anchor ({1}). "
            "Finish the interview first.".format(len(missing), ", ".join(missing))
        )
    pending = interview.pending_judgements(bank, doc)

    try:
        assessment = build_assessment(bank, doc)
    except ScoringError as exc:
        raise ToolError("scoring failed: {0}".format(exc))
    except (KeyError, ValueError, TypeError) as exc:
        raise ToolError("scoring failed: {0}".format(exc))

    try:
        validate_assessment(assessment)
    except ValidationError as exc:
        raise ToolError("the scored assessment failed validation: {0}".format(exc))

    target = os.path.abspath(out) if out else os.path.join(base, "assessment.json")
    session.write_json_atomic(target, assessment)

    return {
        "assessment_path": target,
        "validated": True,
        "overall": assessment["overall"],
        "rai": {
            "staged": assessment["rai"]["staged"],
            "mean": assessment["rai"]["mean"],
            "lagging_pillars": assessment["rai"]["lagging_pillars"],
        },
        "pillars": [
            {
                "id": p["id"],
                "staged": p["staged"],
                "mean": p["mean"],
                "spread": p["spread"],
            }
            for p in assessment["pillars"]
        ],
        "capped": [
            {"id": c["id"], "claimed": c.get("claimed"), "scored": c.get("level")}
            for c in assessment["findings"]["capped"]
        ],
        "pending_judgements": pending,
        "note": (
            "The five-pillar profile is the official model output. The floor, the "
            "mean and the RAI overlay are this project's diagnostic method, not a "
            "Microsoft scoring algorithm."
        ),
    }


def validate_file(path):
    doc = _read_json(os.path.abspath(path), "assessment")
    try:
        validate_assessment(doc)
    except ValidationError as exc:
        return {"path": os.path.abspath(path), "valid": False, "error": str(exc)}
    return {
        "path": os.path.abspath(path),
        "valid": True,
        "pillars": len(doc.get("pillars", [])),
        "dimensions": sum(len(p["dimensions"]) for p in doc.get("pillars", [])),
    }


def render_report(
    assessment=None, session_dir=None, out_dir=None, lang=None, formats=None
):
    source = _assessment_path(session_dir, assessment)
    doc = _read_json(source, "assessment")
    try:
        validate_assessment(doc)
    except ValidationError as exc:
        raise ToolError(
            "refusing to render an invalid assessment: {0}".format(exc)
        )
    language = bank_mod.normalize_language(
        lang or doc.get("engagement", {}).get("language")
    )
    wanted = [f.lower() for f in (formats or ["html", "svg"])]
    unknown = [f for f in wanted if f not in ("html", "svg", "png")]
    if unknown:
        raise ToolError(
            "unknown format(s) {0}; choose from html, svg, png".format(
                ", ".join(unknown)
            )
        )
    if "png" in wanted and "svg" not in wanted:
        wanted.append("svg")

    target_dir = os.path.abspath(out_dir or os.path.dirname(source))
    os.makedirs(target_dir, exist_ok=True)
    stem = "agent-maturity"
    written = {}
    warnings = []

    svg_path = os.path.join(target_dir, stem + ".radar.svg")
    if "svg" in wanted:
        svg = radar_svg(doc, lang=language, standalone=True)
        _write_text(svg_path, svg + "\n")
        written["svg"] = svg_path

    if "html" in wanted:
        html_path = os.path.join(target_dir, stem + ".html")
        _write_text(html_path, build_html(doc, lang=language))
        written["html"] = html_path

    if "png" in wanted:
        from .raster import rasterize

        png_path = os.path.join(target_dir, stem + ".radar.png")
        try:
            rasterize(svg_path, png_path)
            written["png"] = png_path
        except Exception as exc:
            warnings.append(
                "PNG skipped: {0}. The HTML and SVG do not need a browser.".format(exc)
            )

    return {
        "language": language,
        "files": written,
        "warnings": warnings,
        "note": (
            "The HTML is self-contained: no network access, no storage, so it is "
            "safe to hand to a customer or open from OneDrive or SharePoint."
        ),
    }


def _write_text(path, text):
    """Same durability guarantee as the JSON writer: a half-written report
    should never be handed to a customer."""
    session.write_text_atomic(path, text)


def explain_score(assessment=None, session_dir=None, dimension=None, lang=None):
    source = _assessment_path(session_dir, assessment)
    doc = _read_json(source, "assessment")
    language = bank_mod.normalize_language(
        lang or doc.get("engagement", {}).get("language")
    )
    rows = []
    for pillar in doc.get("pillars", []):
        for dim in pillar.get("dimensions", []):
            if dimension and dim["id"] != dimension:
                continue
            claimed = dim.get("claimed")
            level = dim.get("level")
            codes = dim.get("cap_codes") or []
            # The scorer already localized the reason at the moment it applied
            # the cap, so re-deriving it here could only drift from the report.
            reason = bank_mod.t(dim.get("cap_reason"), language) if codes else ""
            rows.append(
                {
                    "dimension": dim["id"],
                    "pillar": pillar["id"],
                    "claimed": claimed,
                    "scored": level,
                    "capped": bool(codes),
                    "cap_codes": codes,
                    "sentence": _cap_sentence(dim, reason, language),
                    "confidence": dim.get("confidence"),
                    "evidence": dim.get("evidence"),
                    "quote": dim.get("quote"),
                }
            )
    if dimension and not rows:
        raise ToolError("no sub-dimension {0!r} in {1}".format(dimension, source))
    return {"assessment_path": source, "language": language, "explanations": rows}


def _cap_sentence(dim, reason, lang):
    claimed = dim.get("claimed")
    level = dim.get("level")
    if not reason:
        if lang == "zh":
            return "{0}：选中 {1}，计为 {1}，未触发任何上限。".format(dim["id"], level)
        return "{0}: claimed {1}, scored {1}, no cap applied.".format(dim["id"], level)
    if lang == "zh":
        return "{0}：自述 {1}，计为 {2}，因为{3}。".format(
            dim["id"], claimed, level, reason
        )
    return "{0}: claimed {1}, scored {2}, because {3}.".format(
        dim["id"], claimed, level, reason
    )


def get_question(question_id, lang=None, session_dir=None):
    bank = _bank()
    doc = None
    if session_dir and os.path.exists(session.answers_path(session_dir)):
        doc = _load(session_dir)
    if doc is None:
        doc = session.new_answers_doc(
            {"language": bank_mod.normalize_language(lang or "en")}
        )
    elif lang:
        doc = dict(doc)
        doc["engagement"] = dict(doc.get("engagement", {}))
        doc["engagement"]["language"] = bank_mod.normalize_language(lang)

    identifier = question_id.strip()
    if "." not in identifier:
        identifier = identifier.upper() + ".qa"
    try:
        ask = interview.build_ask(bank, doc, identifier)
    except (interview.InterviewError, bank_mod.BankError) as exc:
        raise ToolError(str(exc))
    payload = ask.to_dict()
    payload["text_fallback"] = ask.to_text_prompt()
    payload["json_schema"] = ask.to_json_schema()
    payload["card"] = ask.render_plan(UNCAPPED)
    payload["card_capped"] = ask.render_plan(CAPPED)
    return payload


def validate_bank(bank_path=None):
    bank = _bank(bank_path)
    problems = []
    pillars = bank_mod.pillars(bank)
    if len(pillars) != 5:
        problems.append("expected 5 pillars, found {0}".format(len(pillars)))
    rai_per_pillar = {}
    for pillar in pillars:
        dims = pillar.get("dimensions", [])
        if len(dims) != 3:
            problems.append(
                "pillar {0} has {1} sub-dimensions, expected 3".format(
                    pillar["id"], len(dims)
                )
            )
        if not pillar.get("qb_batched", {}).get("prompt"):
            problems.append("pillar {0} has no batched evidence prompt".format(pillar["id"]))
        rai_per_pillar[pillar["id"]] = [d["id"] for d in dims if d.get("rai_bearing")]
        for dim in dims:
            problems.extend(_check_dimension(pillar, dim))
    for pillar_id, bearers in rai_per_pillar.items():
        if len(bearers) != 1:
            problems.append(
                "pillar {0} must designate exactly one RAI-bearing sub-dimension, "
                "found {1}".format(pillar_id, len(bearers))
            )
    return {
        "bank_path": bank_path or paths.bank_path(),
        "valid": not problems,
        "problems": problems,
        "pillars": len(pillars),
        "dimensions": len(bank_mod.dimension_ids(bank)),
        "rai_bearing": bank_mod.rai_dimension_ids(bank),
        "tiers": bank_mod.tier_ids(bank),
    }


def _check_dimension(pillar, dim):
    problems = []
    dim_id = dim.get("id", "?")
    anchors = dim.get("qa", {}).get("anchors", [])
    levels = [a.get("level") for a in anchors]
    if levels != list(bank_mod.LEVELS):
        problems.append(
            "{0} anchors must map one-to-one onto 100-500 in order, found {1}".format(
                dim_id, levels
            )
        )
    for node_name in ("qa", "qb", "qc"):
        if not dim.get(node_name):
            problems.append("{0} is missing {1}".format(dim_id, node_name))
    fires_at = dim.get("qc", {}).get("fires_at")
    if fires_at != [400, 500]:
        problems.append("{0} qc.fires_at must be [400, 500], found {1}".format(dim_id, fires_at))
    if not dim.get("qc", {}).get("pass_test"):
        problems.append("{0} qc has no pass_test to judge against".format(dim_id))
    # A citation, not customer-facing text, so it is deliberately not bilingual.
    if not isinstance(dim.get("source_heading"), str) or not dim["source_heading"]:
        problems.append("{0} has no source_heading tracing it to Microsoft Learn".format(dim_id))
    problems.extend(_check_card_fields(dim))
    for path, node in _i18n_nodes(dim):
        if not isinstance(node, dict):
            problems.append("{0}.{1} is not a localized node".format(dim_id, path))
            continue
        for language in bank_mod.LANGUAGES:
            if not node.get(language):
                problems.append("{0}.{1} is missing the {2} string".format(dim_id, path, language))
    return problems


def _check_card_fields(dim):
    """The invariants the selection card depends on.

    `short` is deliberately not required and deliberately not checked for both
    languages: it is a per-language override for anchors whose first sentence
    does not stand alone, and the languages that split cleanly must be left to
    derive rather than made to carry a second copy of the anchor.
    """
    problems = []
    dim_id = dim.get("id", "?")
    for language in bank_mod.LANGUAGES:
        header = bank_mod.t_strict(dim.get("header"), language)
        if not header:
            problems.append(
                "{0} has no {1} header for the card label".format(dim_id, language)
            )
        elif len(header) > CARD_HEADER_MAX:
            problems.append(
                "{0} {1} header is {2} characters; the tightest host allows "
                "{3}".format(dim_id, language, len(header), CARD_HEADER_MAX)
            )
        for anchor in dim.get("qa", {}).get("anchors", []):
            label, _ = bank_mod.anchor_label(anchor, language)
            if not label:
                problems.append(
                    "{0} level {1} has no {2} card label".format(
                        dim_id, anchor.get("level"), language
                    )
                )
            elif len(label) > bank_mod.SHORT_LABEL_MAX:
                problems.append(
                    "{0} level {1} {2} card label is {3} characters; add a "
                    "qa.anchors[].short.{2} override to keep it under {4}".format(
                        dim_id,
                        anchor.get("level"),
                        language,
                        len(label),
                        bank_mod.SHORT_LABEL_MAX,
                    )
                )
        try:
            bank_mod.fail_exemplar(dim, language)
        except bank_mod.BankError as exc:
            problems.append(str(exc))
    return problems


def _i18n_nodes(dim):
    yield "name", dim.get("name", {})
    for key in ("qa", "qb", "qc", "probe2"):
        node = dim.get(key) or {}
        if node.get("prompt"):
            yield "{0}.prompt".format(key), node["prompt"]
    for index, anchor in enumerate(dim.get("qa", {}).get("anchors", [])):
        yield "qa.anchors[{0}]".format(index), anchor.get("text", {})
    if dim.get("qc", {}).get("pass_test"):
        yield "qc.pass_test", dim["qc"]["pass_test"]


# ---------------------------------------------------------------- registry

_SESSION_DIR = {
    "type": "string",
    "description": "Absolute path to the customer-private engagement directory holding answers.json.",
}
_LANG = {
    "type": "string",
    "enum": ["en", "zh"],
    "description": "Output language; defaults to the engagement language.",
}

TOOLS: List[ToolDef] = [
    ToolDef(
        name="maturity_start_session",
        title="Start or resume an assessment",
        description=(
            "Create (or resume) an engagement in session_dir and return the first "
            "question to ask. Call this before any other maturity tool. Framing "
            "answers you already know can be passed in to skip those questions; "
            "everything else is asked. Never point session_dir at the repository's "
            "fixtures directory - real customer statements belong in a private "
            "directory."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "organization": {"type": "string", "description": "Customer name."},
                "sector": {"type": "string", "description": "Sector or industry."},
                "tier": {
                    "type": "string",
                    "enum": ["pulse", "standard", "deep"],
                    "description": "Depth. pulse is a screening tier capped at 300; standard is the default.",
                },
                "language": _LANG,
                "participant_roles": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(interview.PARTICIPANT_ROLES)},
                    "description": "Role ids of everyone in the room.",
                },
                "focus_pillars": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["A", "B", "C", "D", "E"]},
                    "description": "Pillars to emphasise in the debrief. All five are still assessed.",
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "Discard an existing session in this directory. Defaults to false, which resumes.",
                },
            },
            "required": ["session_dir"],
            "additionalProperties": False,
        },
        handler=start_session,
    ),
    ToolDef(
        name="maturity_next_question",
        title="Get the next interview question",
        description=(
            "Return the next question as a runtime-neutral ask: kind (single, "
            "multi or text), prompt, options, a ready-made selection card in "
            "`card` (and `card_capped` for hosts that cap a card at four "
            "options), and a text_fallback for chat-only hosts. Render it with "
            "your own card tool, matched by shape rather than by name. Ask it in "
            "the customer's language, one question per turn, and never read out "
            "the level numbers behind the options, `facilitator_note`, or "
            "`meta.judge_rule`. When `option_source` is `agent` you write the "
            "options yourself, following `meta.option_rule`."
        ),
        input_schema={
            "type": "object",
            "properties": {"session_dir": _SESSION_DIR},
            "required": ["session_dir"],
            "additionalProperties": False,
        },
        handler=next_question,
        read_only=True,
    ),
    ToolDef(
        name="maturity_record_answer",
        title="Record one answer",
        description=(
            "Persist the customer's answer to the question that maturity_next_question "
            "issued, then return the next one. Pass the option id (or the option's "
            "label, which is what a card tool hands back) for single and multi "
            "asks, and the customer's words for text asks. On an ask whose "
            "option_source is `agent`, also pass answer_source, because that is "
            "the only way to tell a clicked option from a typed answer - and on a "
            "disconfirming probe a clicked option is recorded as a fail whatever "
            "it says. Record a verbatim quote where you have one, and set inferred "
            "when the customer did not actually know - a gap in knowledge is "
            "itself a finding."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "ask_id": {
                    "type": "string",
                    "description": "The id from maturity_next_question, for example A1.qa.",
                },
                "value": {
                    "description": (
                        "Option id or label (single), a list of them (multi), or "
                        "the customer's own words."
                    ),
                    "anyOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                },
                "answer_source": {
                    "type": "string",
                    "enum": ["option", "free_text"],
                    "description": (
                        "How the answer arrived. Required when the ask's "
                        "option_source is `agent`; derived otherwise. A picked "
                        "option can never pass a disconfirming probe."
                    ),
                },
                "quote": {
                    "type": "string",
                    "description": "What the customer actually said, verbatim, not your paraphrase.",
                },
                "inferred": {
                    "type": "boolean",
                    "description": "True when the customer did not know and this was inferred. Never round upward.",
                },
            },
            "required": ["session_dir", "ask_id"],
            "additionalProperties": False,
        },
        handler=record_answer,
    ),
    ToolDef(
        name="maturity_judge_probe",
        title="Judge a disconfirming probe",
        description=(
            "Record whether a Q-C answer passed. Judge against the written "
            "judge_rule the question carried, not against how confident the person "
            "sounded. A pass cannot be recorded without preserving the customer's "
            "answer."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "dimension_id": {
                    "type": "string",
                    "description": "Sub-dimension id, for example A1.",
                },
                "passed": {"type": "boolean"},
                "rationale": {
                    "type": "string",
                    "description": "Why it passed or failed, against the pass_test.",
                },
            },
            "required": ["session_dir", "dimension_id", "passed"],
            "additionalProperties": False,
        },
        handler=judge_probe,
    ),
    ToolDef(
        name="maturity_session_status",
        title="Session progress",
        description=(
            "Report progress, the resume point, per-pillar completion and any "
            "disconfirming probes still awaiting judgement."
        ),
        input_schema={
            "type": "object",
            "properties": {"session_dir": _SESSION_DIR},
            "required": ["session_dir"],
            "additionalProperties": False,
        },
        handler=session_status,
        read_only=True,
    ),
    ToolDef(
        name="maturity_run_interview",
        title="Run the interview directly",
        description=(
            "Ask the customer the remaining questions through this host's own "
            "input UI, persisting each answer before the next question. Available "
            "only on hosts that support elicitation. Use max_questions to run one "
            "pillar at a time. Declining or cancelling leaves a session that "
            "resumes cleanly."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "max_questions": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Stop after this many questions. 0 runs to the end.",
                },
            },
            "required": ["session_dir"],
            "additionalProperties": False,
        },
        handler=run_interview,
        requires="elicitation",
    ),
    ToolDef(
        name="maturity_score",
        title="Score the interview",
        description=(
            "Apply the evidence gate and write assessment.json, validating it "
            "before returning. The gate only ever lowers a score: a claim of 300+ "
            "with no named artifact is capped at 200, and 400+ additionally "
            "requires a passed disconfirming probe or is capped at 300."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "answers": {"type": "string", "description": "Path to an answers file, instead of session_dir."},
                "out": {"type": "string", "description": "Where to write assessment.json."},
                "bank_path": {"type": "string", "description": "Alternate question bank."},
            },
            "additionalProperties": False,
        },
        handler=score_session,
    ),
    ToolDef(
        name="maturity_validate",
        title="Validate an assessment file",
        description=(
            "Recompute every floor and mean from the sub-dimension levels and "
            "refuse an assessment where the evidence gate raised a score, so a "
            "hand-edited file cannot reach a customer."
        ),
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        handler=validate_file,
        read_only=True,
    ),
    ToolDef(
        name="maturity_render_report",
        title="Render the report",
        description=(
            "Produce the self-contained interactive HTML report with the maturity "
            "radar chart, the standalone SVG, and optionally a PNG. The HTML makes "
            "no network calls and uses no storage, so it opens offline and from a "
            "shared link. PNG needs a Chromium-family browser; if none is found "
            "the other formats are still written and a warning is returned."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "assessment": {"type": "string", "description": "Path to assessment.json, instead of session_dir."},
                "out_dir": {"type": "string", "description": "Output directory. Defaults to the assessment's directory."},
                "lang": _LANG,
                "formats": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["html", "svg", "png"]},
                    "description": "Defaults to html and svg.",
                },
            },
            "additionalProperties": False,
        },
        handler=render_report,
    ),
    ToolDef(
        name="maturity_explain_score",
        title="Explain a score",
        description=(
            "Return 'claimed X, scored Y, because Z' for one sub-dimension or all "
            "of them. Use this when a customer challenges a capped level: a "
            "customer who can see the rule can argue with it, and one who sees only "
            "a number stops trusting the whole report."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "session_dir": _SESSION_DIR,
                "assessment": {"type": "string"},
                "dimension": {"type": "string", "description": "Sub-dimension id, for example A1. Omit for all."},
                "lang": _LANG,
            },
            "additionalProperties": False,
        },
        handler=explain_score,
        read_only=True,
    ),
    ToolDef(
        name="maturity_get_question",
        title="Look up one question",
        description=(
            "Return a single question from the bank with its options, text "
            "fallback and JSON Schema, without touching a session. Useful for "
            "reviewing wording, translating, or wiring the bank into another host."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "question_id": {
                    "type": "string",
                    "description": "A1, A1.qa, A1.qb, A1.qc, A1.probe2 or A.qb_batched. A bare id means the anchored choice.",
                },
                "lang": _LANG,
                "session_dir": _SESSION_DIR,
            },
            "required": ["question_id"],
            "additionalProperties": False,
        },
        handler=get_question,
        read_only=True,
    ),
    ToolDef(
        name="maturity_validate_bank",
        title="Validate the question bank",
        description=(
            "Check the invariants the design depends on: five pillars, three "
            "sub-dimensions each, five anchors mapping one-to-one onto 100-500, a "
            "pass_test on every disconfirming probe, fires_at of [400, 500], every "
            "string in both en and zh, and exactly one RAI-bearing sub-dimension "
            "per pillar. Run this after editing the bank."
        ),
        input_schema={
            "type": "object",
            "properties": {"bank_path": {"type": "string"}},
            "additionalProperties": False,
        },
        handler=validate_bank,
        read_only=True,
    ),
]


def registry() -> Dict[str, ToolDef]:
    return {tool.name: tool for tool in TOOLS}


def available(capabilities=()) -> List[ToolDef]:
    """Tools this host can actually honour."""
    granted = set(capabilities or ())
    return [t for t in TOOLS if t.requires is None or t.requires in granted]


def call(name: str, arguments=None, context=None) -> Dict[str, Any]:
    tool = registry().get(name)
    if tool is None:
        raise ToolError("unknown tool {0!r}".format(name))
    kwargs = dict(arguments or {})
    allowed = set(tool.input_schema.get("properties", {}))
    unexpected = [key for key in kwargs if key not in allowed]
    if unexpected:
        raise ToolError(
            "{0} does not accept {1}; expected {2}".format(
                name, ", ".join(sorted(unexpected)), ", ".join(sorted(allowed))
            )
        )
    for required in tool.input_schema.get("required", []):
        if kwargs.get(required) in (None, ""):
            raise ToolError("{0} requires {1}".format(name, required))
    if tool.requires == "elicitation":
        kwargs["context"] = context
    return tool.handler(**kwargs)
