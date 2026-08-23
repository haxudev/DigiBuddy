"""Expose the toolkit over MCP.

The tool bodies live in `agent_maturity.toolkit` and know nothing about MCP;
this module only adapts them. Two behaviours are specific to the protocol:

* `maturity_run_interview` is advertised only when the client declared the
  elicitation capability, so a host never sees a tool it cannot honour.
* A tool failure is reported as `isError` on a successful JSON-RPC response,
  not as a JSON-RPC error, so the model can read the message and correct
  itself instead of the session dying.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from .. import paths
from ..askspec import AskSpec
from ..toolkit import ToolContext, ToolError, available, call, registry
from .elicit import elicit_ask
from .jsonrpc import INVALID_PARAMS, RpcError
from .protocol import ElicitationUnsupported, Session

RESOURCES = [
    (
        "maturity://references/pillars.md",
        "pillars.md",
        "Pillars, sub-dimensions and level descriptors",
        "The five capability pillars, their three sub-dimensions each, every level "
        "descriptor, and the Microsoft Learn source URL and retrieval date behind each.",
        "text/markdown",
    ),
    (
        "maturity://references/scoring-rubric.md",
        "scoring-rubric.md",
        "Scoring rubric",
        "The evidence gate, the staged-floor rule, the confidence tags and the "
        "assessment schema. Read before explaining or changing a score.",
        "text/markdown",
    ),
    (
        "maturity://references/report-template.md",
        "report-template.md",
        "Debrief narrative",
        "How to present the result: open with the binding constraint rather than the "
        "average, how to answer 'why did you cap us', and the written-summary skeleton.",
        "text/markdown",
    ),
    (
        "maturity://references/runtime-adapters.md",
        "runtime-adapters.md",
        "Runtime adapter contract",
        "The portable ask, persistence and path contract this server implements.",
        "text/markdown",
    ),
    (
        "maturity://references/question-bank.json",
        "question-bank.json",
        "Question bank",
        "The interview itself: 15 sub-dimensions, 75 anchors, evidence and "
        "disconfirming probes, bilingual English and Chinese.",
        "application/json",
    ),
]

INSTRUCTIONS = (
    "Run the Microsoft Agentic AI adoption maturity model as a consulting "
    "interview, then produce a self-contained interactive HTML report with a "
    "maturity radar chart.\n\n"
    "Start with maturity_start_session, then loop maturity_next_question and "
    "maturity_record_answer until complete, judging every disconfirming probe "
    "with maturity_judge_probe. Then maturity_score and maturity_render_report.\n\n"
    "Guardrails: never accept a self-assigned number, never lead the witness, "
    "ask one question per turn in the customer's language, record verbatim "
    "quotes, never name another customer's results, and never read out the "
    "level numbers behind the answer options."
)


def _tool_descriptor(tool) -> Dict[str, Any]:
    return {
        "name": tool.name,
        "title": tool.title,
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": {
            "title": tool.title,
            "readOnlyHint": tool.read_only,
            "destructiveHint": False,
            "openWorldHint": False,
        },
    }


def _text_result(payload, is_error=False) -> Dict[str, Any]:
    if isinstance(payload, str):
        text = payload
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def build_session() -> Session:
    session = Session()

    def granted():
        return ("elicitation",) if session.supports_elicitation_form else ()

    def list_tools(params):
        return {"tools": [_tool_descriptor(t) for t in available(granted())]}

    def call_tool(params):
        if not isinstance(params, dict):
            raise RpcError(INVALID_PARAMS, "tools/call params must be an object")
        name = params.get("name")
        if not isinstance(name, str):
            raise RpcError(INVALID_PARAMS, "tools/call requires a tool name")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise RpcError(INVALID_PARAMS, "tools/call arguments must be an object")

        known = registry()
        if name not in known:
            return _text_result("unknown tool {0!r}".format(name), is_error=True)
        if known[name].requires == "elicitation" and not session.supports_elicitation_form:
            return _text_result(
                "{0} needs a host that can ask the user directly. This client did "
                "not declare the elicitation capability, so drive the interview "
                "with maturity_next_question and maturity_record_answer "
                "instead.".format(name),
                is_error=True,
            )

        context = ToolContext(elicit=lambda ask: _elicit(session, ask))
        try:
            return _text_result(call(name, arguments, context=context))
        except ToolError as exc:
            return _text_result(str(exc), is_error=True)
        except ElicitationUnsupported as exc:
            return _text_result(str(exc), is_error=True)
        except RpcError:
            raise
        except SystemExit as exc:
            # Nothing in the package should raise this, but SystemExit would
            # otherwise pass through every guard below and end the engagement.
            return _text_result(
                "{0} attempted to exit the process: {1}".format(name, exc),
                is_error=True,
            )
        except Exception as exc:  # a bug here must not end the engagement
            if session.connection is not None:
                session.connection.log_traceback()
            return _text_result(
                "{0} failed unexpectedly: {1}: {2}".format(
                    name, type(exc).__name__, exc
                ),
                is_error=True,
            )

    def list_resources(params):
        return {
            "resources": [
                {
                    "uri": uri,
                    "name": name,
                    "title": title,
                    "description": description,
                    "mimeType": mime,
                }
                for uri, name, title, description, mime in RESOURCES
            ]
        }

    def read_resource(params):
        if not isinstance(params, dict):
            raise RpcError(INVALID_PARAMS, "resources/read params must be an object")
        uri = params.get("uri")
        for candidate, name, _title, _description, mime in RESOURCES:
            if candidate == uri:
                try:
                    with open(paths.reference_path(name), encoding="utf-8") as fh:
                        text = fh.read()
                except (OSError, paths.ReferenceNotFound) as exc:
                    raise RpcError(
                        INVALID_PARAMS, "could not read {0}: {1}".format(uri, exc)
                    )
                return {
                    "contents": [{"uri": uri, "mimeType": mime, "text": text}]
                }
        raise RpcError(INVALID_PARAMS, "unknown resource {0!r}".format(uri))

    session.register("tools/list", list_tools)
    session.register("tools/call", call_tool)
    session.register("resources/list", list_resources)
    session.register("resources/read", read_resource)
    session.declare_capability("tools", {"listChanged": True})
    session.declare_capability("resources", {"listChanged": False, "subscribe": False})
    session.instructions = INSTRUCTIONS
    return session


def _elicit(session: Session, ask: AskSpec):
    try:
        return elicit_ask(session, ask)
    except ElicitationUnsupported:
        raise ToolError(
            "this host cannot ask the user directly; use maturity_next_question "
            "and maturity_record_answer"
        )
