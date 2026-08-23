"""The console entry point.

Every subcommand is a thin wrapper over `toolkit`, so the CLI and the MCP
server cannot drift apart: fixing a tool fixes both. `agent-maturity tools`
prints the whole surface as JSON, which is how you wire the pack into a host
that is not covered by a bundled adapter.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__, toolkit
from .adapters.terminal import elicitor
from .toolkit import ToolContext, ToolError


def _emit(payload, as_json=True):
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(str(payload) + "\n")


def _kv(args, *names):
    out = {}
    for name in names:
        value = getattr(args, name, None)
        if value not in (None, "", []):
            out[name] = value
    return out


def _run(name, arguments, context=None):
    try:
        return toolkit.call(name, arguments, context=context)
    except ToolError as exc:
        sys.stderr.write("error: {0}\n".format(exc))
        raise SystemExit(1)


def cmd_start(args):
    payload = _run(
        "maturity_start_session",
        _kv(
            args,
            "session_dir",
            "organization",
            "sector",
            "tier",
            "language",
            "participant_roles",
            "focus_pillars",
            "overwrite",
        ),
    )
    _emit(payload)
    return 0


def cmd_ask(args):
    payload = _run("maturity_next_question", {"session_dir": args.session_dir})
    question = payload.get("next_question")
    if args.text:
        if question is None:
            _emit(payload.get("resume_sentence", "Nothing further to ask."), False)
        else:
            _emit(question["text_fallback"], False)
        return 0
    _emit(payload)
    return 0


def cmd_answer(args):
    value = args.value
    payload = _run(
        "maturity_record_answer",
        _kv_with(
            {"session_dir": args.session_dir, "ask_id": args.ask_id, "value": value},
            quote=args.quote,
            inferred=args.inferred,
            answer_source=args.answer_source,
        ),
    )
    _emit(payload)
    return 0


def _kv_with(base, **extra):
    # `is None` rather than a membership test: False is a meaningful value for
    # `inferred` and must reach the tool, while absence must not.
    for key, value in extra.items():
        if value is None or value == "" or value == []:
            continue
        base[key] = value
    return base


def cmd_judge(args):
    _emit(
        _run(
            "maturity_judge_probe",
            _kv_with(
                {
                    "session_dir": args.session_dir,
                    "dimension_id": args.dimension,
                    "passed": args.passed,
                },
                rationale=args.rationale,
            ),
        )
    )
    return 0


def cmd_status(args):
    _emit(_run("maturity_session_status", {"session_dir": args.session_dir}))
    return 0


def cmd_interview(args):
    """Run the interview in this terminal.

    The terminal is just another host: it supplies the same accept/decline/
    cancel callback the MCP elicitation path supplies, over the same AskSpec.
    """
    context = ToolContext(elicit=elicitor())
    arguments = {"session_dir": args.session_dir}
    if args.max_questions:
        arguments["max_questions"] = args.max_questions
    payload = _run("maturity_run_interview", arguments, context=context)
    sys.stderr.write(
        "\n{0} question(s) answered, stopped: {1}\n".format(
            payload.get("asked"), payload.get("stopped")
        )
    )
    if payload.get("pending_judgements"):
        sys.stderr.write(
            "awaiting judgement: {0}\n".format(
                ", ".join(payload["pending_judgements"])
            )
        )
    _emit(payload)
    return 0


def cmd_score(args):
    _emit(
        _run(
            "maturity_score",
            _kv(args, "session_dir", "answers", "out", "bank_path"),
        )
    )
    return 0


def cmd_validate(args):
    payload = _run("maturity_validate", {"path": args.path})
    _emit(payload)
    return 0 if payload.get("valid") else 1


def cmd_render(args):
    payload = _run(
        "maturity_render_report",
        _kv(args, "session_dir", "assessment", "out_dir", "lang", "formats"),
    )
    _emit(payload)
    return 0


def cmd_explain(args):
    _emit(
        _run(
            "maturity_explain_score",
            _kv(args, "session_dir", "assessment", "dimension", "lang"),
        )
    )
    return 0


def cmd_question(args):
    _emit(_run("maturity_get_question", _kv(args, "question_id", "lang")))
    return 0


def cmd_check_bank(args):
    payload = _run("maturity_validate_bank", _kv(args, "bank_path"))
    _emit(payload)
    return 0 if payload.get("valid") else 1


def cmd_tools(args):
    """Print the tool surface, for wiring into a host with no bundled adapter."""
    _emit(
        {
            "version": __version__,
            "tools": [
                {
                    "name": tool.name,
                    "title": tool.title,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                    "readOnly": tool.read_only,
                    "requires": tool.requires,
                }
                for tool in toolkit.TOOLS
            ],
        }
    )
    return 0


def cmd_mcp(args):
    from .mcp.__main__ import main as mcp_main

    return mcp_main()


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agent-maturity",
        description=(
            "Agentic AI adoption maturity assessment: interview, score, report."
        ),
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    def session_arg(p, required=True):
        p.add_argument(
            "--session-dir",
            required=required,
            help="Customer-private engagement directory. Never use fixtures/.",
        )

    p = sub.add_parser("start", help="create or resume an engagement")
    session_arg(p)
    p.add_argument("--organization")
    p.add_argument("--sector")
    p.add_argument("--tier", choices=["pulse", "standard", "deep"])
    p.add_argument("--language", choices=["en", "zh"])
    p.add_argument("--participant-roles", nargs="*", dest="participant_roles")
    p.add_argument("--focus-pillars", nargs="*", dest="focus_pillars")
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("ask", help="show the next question")
    session_arg(p)
    p.add_argument("--text", action="store_true", help="print the chat fallback only")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("answer", help="record one answer")
    session_arg(p)
    p.add_argument("--ask-id", required=True, dest="ask_id")
    p.add_argument("--value")
    p.add_argument("--multi", action="store_true", help="split --value on commas")
    p.add_argument("--quote", help="what the customer actually said, verbatim")
    p.add_argument(
        "--answer-source",
        dest="answer_source",
        choices=["option", "free_text"],
        help=(
            "how the answer arrived; required on an ask whose option_source is "
            "'agent', because a picked option can never pass a probe"
        ),
    )
    # Tri-state: absent must mean "leave it alone", not "clear it". A plain
    # store_true sent inferred=false on every command, so the flag recorded on
    # the anchor was erased by the next answer for that dimension and the
    # report promoted the sub-dimension from inferred to evidenced.
    flag = p.add_mutually_exclusive_group()
    flag.add_argument(
        "--inferred",
        dest="inferred",
        action="store_const",
        const=True,
        default=None,
        help="the customer did not know; never round upward",
    )
    flag.add_argument(
        "--not-inferred",
        dest="inferred",
        action="store_const",
        const=False,
        help="clear a previously recorded inferred flag",
    )
    p.set_defaults(func=cmd_answer)

    p = sub.add_parser("judge", help="judge a disconfirming probe")
    session_arg(p)
    p.add_argument("--dimension", required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--passed", dest="passed", action="store_true")
    group.add_argument("--failed", dest="passed", action="store_false")
    p.add_argument("--rationale")
    p.set_defaults(func=cmd_judge)

    p = sub.add_parser("status", help="progress and resume point")
    session_arg(p)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("interview", help="run the interview in this terminal")
    session_arg(p)
    p.add_argument("--max-questions", type=int, default=0, dest="max_questions")
    p.set_defaults(func=cmd_interview)

    p = sub.add_parser("score", help="apply the evidence gate and write assessment.json")
    session_arg(p, required=False)
    p.add_argument("--answers")
    p.add_argument("--out")
    p.add_argument("--bank", dest="bank_path")
    p.set_defaults(func=cmd_score)

    p = sub.add_parser("validate", help="validate an assessment file")
    p.add_argument("path")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("render", help="write the HTML report, SVG and PNG")
    session_arg(p, required=False)
    p.add_argument("--assessment")
    p.add_argument("--out-dir", dest="out_dir")
    p.add_argument("--lang", choices=["en", "zh"])
    p.add_argument("--formats", nargs="*", choices=["html", "svg", "png"])
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("explain", help="claimed X, scored Y, because Z")
    session_arg(p, required=False)
    p.add_argument("--assessment")
    p.add_argument("--dimension")
    p.add_argument("--lang", choices=["en", "zh"])
    p.set_defaults(func=cmd_explain)

    p = sub.add_parser("question", help="look up one question from the bank")
    p.add_argument("question_id")
    p.add_argument("--lang", choices=["en", "zh"])
    p.set_defaults(func=cmd_question)

    p = sub.add_parser("check-bank", help="validate the question bank invariants")
    p.add_argument("--bank", dest="bank_path")
    p.set_defaults(func=cmd_check_bank)

    p = sub.add_parser("tools", help="print the tool surface as JSON")
    p.set_defaults(func=cmd_tools)

    p = sub.add_parser("mcp", help="run the MCP server on stdio")
    p.set_defaults(func=cmd_mcp)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
