"""Terminal adapter.

The same `AskSpec` the MCP server projects onto `elicitation/create` is
projected here onto a prompt and `input()`. Having two unrelated hosts consume
the identical object is what keeps the abstraction honest, and it gives the
project a way to rehearse an interview with no agent runtime at all.
"""

from __future__ import annotations

import sys

from ..askspec import MULTI, SINGLE, AnswerError, AskSpec

_QUIT = {":q", ":quit", ":stop"}
_SKIP = {":s", ":skip"}


def prompt_once(ask: AskSpec, stream=None, output=None):
    """Ask one question. Returns (action, value) like an elicitation result."""
    stream = stream or sys.stdin
    output = output or sys.stderr

    while True:
        # The person at this keyboard may be the customer, so the facilitator
        # note is deliberately not shown here either.
        output.write("\n" + ask.prompt + "\n")

        if ask.options:
            for letter, option in zip("abcdefghijklmnopqrstuvwxyz", ask.options):
                output.write("  {0}) {1}\n".format(letter, option.label))
                if option.description:
                    output.write("     {0}\n".format(option.description))
        if ask.allow_free_text and ask.free_text_label:
            output.write("  {0}\n".format(ask.free_text_label))

        if ask.kind == SINGLE:
            hint = "one letter" + (", or type your own" if ask.allow_free_text else "")
        elif ask.kind == MULTI:
            hint = "comma-separated letters, or blank for none"
        else:
            hint = "free text, or blank to skip"
        output.write("[{0}] ({1}, :q to stop) > ".format(ask.id, hint))
        output.flush()

        raw = stream.readline()
        if raw == "":
            return "cancel", None
        raw = raw.strip()
        if raw.lower() in _QUIT:
            return "cancel", None
        if raw.lower() in _SKIP:
            return "decline", None

        value = raw
        try:
            normalized = ask.validate(value)
        except AnswerError as exc:
            # A loop, not recursion: a piped stream of invalid lines used to
            # exhaust the stack and raise RecursionError out of the tool.
            output.write("  ! {0}\n".format(exc))
            continue
        return "accept", normalized


def elicitor(stream=None, output=None):
    """Build the callback `ToolContext` expects."""

    def _elicit(ask):
        return prompt_once(ask, stream=stream, output=output)

    return _elicit
