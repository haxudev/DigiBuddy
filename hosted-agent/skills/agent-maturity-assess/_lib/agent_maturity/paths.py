"""Locate the bundled reference data regardless of how the package was installed.

The reference documents are the agent-readable half of the skill, so their
canonical home in the repository is `skills/agent-maturity-assess/references/`.
The wheel re-homes that directory as `agent_maturity/data/`, so both layouts
have to resolve.
"""

from __future__ import annotations

import os

_HERE = os.path.dirname(os.path.abspath(__file__))
# Two levels up is the repository root in a checkout, and the installed skill's
# own directory when the package has been vendored into `<skill>/_lib/`.
_ABOVE = os.path.dirname(os.path.dirname(_HERE))

REFERENCE_FILES = (
    "question-bank.json",
    "pillars.md",
    "scoring-rubric.md",
    "report-template.md",
    "runtime-adapters.md",
)

_CANDIDATES = (
    # Installed wheel: force-included as package data.
    os.path.join(_HERE, "data"),
    # Vendored into a skill by tools/install.py: `<skill>/_lib/agent_maturity`
    # sits beside `<skill>/references`.
    os.path.join(_ABOVE, "references"),
    # Source checkout.
    os.path.join(_ABOVE, "skills", "agent-maturity-assess", "references"),
)


class ReferenceNotFound(Exception):
    pass


def reference_dir() -> str:
    """Absolute path of the directory holding the bank and the reference docs."""
    override = os.environ.get("AGENT_MATURITY_REFERENCES")
    candidates = ((override,) if override else ()) + _CANDIDATES
    for candidate in candidates:
        if os.path.isfile(os.path.join(candidate, "question-bank.json")):
            return os.path.abspath(candidate)
    raise ReferenceNotFound(
        "could not locate question-bank.json; looked in "
        + ", ".join(repr(c) for c in candidates)
        + ". Set AGENT_MATURITY_REFERENCES to the directory that contains it."
    )


def reference_path(name: str) -> str:
    if name not in REFERENCE_FILES:
        raise ReferenceNotFound(f"unknown reference document {name!r}")
    return os.path.join(reference_dir(), name)


def bank_path() -> str:
    """Absolute path of the question bank, honouring AGENT_MATURITY_BANK."""
    override = os.environ.get("AGENT_MATURITY_BANK")
    if override:
        return os.path.abspath(override)
    return reference_path("question-bank.json")


def skills_dir() -> str:
    """Absolute path of the repository's `skills/` directory, when running from a checkout."""
    return os.path.join(_ABOVE, "skills")


def repo_root() -> str:
    return _ABOVE
