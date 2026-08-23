"""LangGraph adapter.

LangGraph's `interrupt()` plus a checkpointer is the closest fit in any
ecosystem to what this interview needs: the graph stops mid-node, the state is
durable, and a resume carries the human's answer back as the return value of the
call that stopped.

`langgraph` is imported lazily, inside the functions that need it, so importing
this module never breaks the zero-dependency guarantee the rest of the package
makes. Install the extra to use it:

    pip install "agent-maturity-assessment[langgraph]"

The graph is deliberately thin. Question order, validation, persistence and
scoring stay in `interview` and `toolkit`, so the LangGraph path and the MCP
path can never disagree about what the interview is.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .. import bank as bank_mod
from .. import interview, session
from ..askspec import AskSpec

STATE_KEYS = ("session_dir", "asked", "stopped", "complete")


def ask_payload(ask: AskSpec) -> Dict[str, Any]:
    """What to hand to `interrupt()`.

    A LangGraph client renders this itself, so it gets the structured form plus
    the lettered fallback rather than a schema it would have to interpret.
    """
    payload = ask.to_dict()
    payload["text_fallback"] = ask.to_text_prompt()
    payload["json_schema"] = ask.to_json_schema()
    return payload


def normalize_resume(ask: AskSpec, resumed: Any):
    """Accept either a bare answer or `{"answer": ...}` from the resume call."""
    if isinstance(resumed, dict) and "answer" in resumed:
        return resumed["answer"]
    return resumed


def step(state: Dict[str, Any], interrupt_fn) -> Dict[str, Any]:
    """One question: ask, persist, report. Pure apart from `interrupt_fn`.

    Kept separate from the graph so it can be tested with a fake interrupt and
    no LangGraph installed.
    """
    session_dir = state["session_dir"]
    bank = bank_mod.load_bank()
    doc = session.load_answers(session_dir)

    ask = interview.next_ask(bank, doc)
    if ask is None:
        return {
            "session_dir": session_dir,
            "asked": state.get("asked", 0),
            "stopped": "complete",
            "complete": True,
        }

    answer = normalize_resume(ask, interrupt_fn(ask_payload(ask)))
    interview.record(bank, doc, ask.id, answer)
    session.save_answers(session_dir, doc, cursor=None)

    complete = interview.is_complete(bank, doc)
    return {
        "session_dir": session_dir,
        "asked": state.get("asked", 0) + 1,
        "stopped": "complete" if complete else None,
        "complete": complete,
    }


def should_continue(state: Dict[str, Any]) -> str:
    return "end" if state.get("complete") else "ask"


def build_graph(checkpointer=None):
    """A graph that loops one question per node until the interview completes.

    Pass a checkpointer - LangGraph cannot resume an interrupt without one, and
    an interview with no durable state is not supported.
    """
    from langgraph.graph import END, START, StateGraph
    from langgraph.types import interrupt

    def ask_node(state):
        return step(state, interrupt)

    graph = StateGraph(dict)
    graph.add_node("ask", ask_node)
    graph.add_edge(START, "ask")
    graph.add_conditional_edges("ask", should_continue, {"ask": "ask", "end": END})

    if checkpointer is None:
        from langgraph.checkpoint.memory import MemorySaver

        checkpointer = MemorySaver()
    return graph.compile(checkpointer=checkpointer)


def start(session_dir: str, **framing) -> Dict[str, Any]:
    """Create the engagement and return the initial graph state."""
    from ..toolkit import call

    call("maturity_start_session", dict(framing, session_dir=session_dir))
    return {"session_dir": session_dir, "asked": 0, "stopped": None, "complete": False}
