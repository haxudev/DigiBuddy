"""How reachable a skill is, declared in one place for the whole image.

Every skill in the image used to be equal: catalogued, listed in the
instructions, and turned into a `/` command in the console. That made the chat
menu a directory listing. Most skills are not things a user picks -- `pptx` and
`html-report` are things the agent should reach for the moment a request needs
them -- and a few are implementation detail behind a curated command.

So a skill declares one of four availabilities:

``builtin``
    Installed, and named in the instructions with its own trigger description so
    the agent loads it on its own. Absent from the chat menu, because asking a
    user to type ``/pptx`` before they may have a deck is asking them to know
    the implementation.
``command``
    Installed and offered in the chat menu. The default, and what an uploaded
    skill always gets.
``hidden``
    Installed and reachable -- a curated command may bundle it, a standing
    instruction may name it -- but neither advertised in the instructions nor
    listed in the menu.
``off``
    Not installed at all. The skill stays in the repository; the runtime acts as
    if it were not there, and ``.dockerignore`` keeps its bytes out of the image
    so the two agree.

The declaration lives in ``src/skill-availability.json`` rather than in each
``SKILL.md``: ``hosted-agent/skills`` is a vendored snapshot that
``scripts/sync-agent-skills.sh --check`` diffs against its locked upstream, so a
frontmatter key added there would fail CI and be erased by the next sync. One
file covers both roots and needs one parser.

An entry only describes a skill; it never grants one. The profile's
``allows_skill`` and the packaged-skill policy are unchanged and still decide
what a conversation may reach.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BUILTIN = "builtin"
COMMAND = "command"
HIDDEN = "hidden"
OFF = "off"

#: What a skill gets when nothing says otherwise -- including every uploaded
#: skill, which is never named in this file. A bundle is untrusted input, so it
#: must not be able to declare itself built-in or hide itself from the menu.
DEFAULT_AVAILABILITY = COMMAND

AVAILABILITIES = frozenset({BUILTIN, COMMAND, HIDDEN, OFF})

#: The file is a short map. Anything much larger is not this document, and
#: reading it in full would make one bad file expensive.
MAX_DOCUMENT_BYTES = 256 * 1024

AVAILABILITY_DOCUMENT = "skill-availability.json"


def parse_availability(document: Any) -> dict[str, str]:
    """Read the ``skills`` map, keeping only names with a known availability.

    An unreadable entry is dropped rather than raising, so one bad edit leaves
    that skill at the default instead of taking the whole catalogue offline. The
    exception is a deliberate one: ``off`` is the only value that *removes* a
    capability, and dropping a malformed entry can only ever restore a skill,
    never hide one that should be visible.
    """
    if not isinstance(document, dict):
        return {}
    entries = document.get("skills")
    if not isinstance(entries, dict):
        return {}

    resolved: dict[str, str] = {}
    for name, value in entries.items():
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        skill = name.strip().lower()
        availability = value.strip().lower()
        if not skill or availability not in AVAILABILITIES:
            if skill:
                logger.warning(
                    "Skill %s declares an unknown availability %r; using %s",
                    skill,
                    value,
                    DEFAULT_AVAILABILITY,
                )
            continue
        resolved[skill] = availability
    return resolved


def load_availability(payload_root: Path) -> dict[str, str]:
    """Read ``skill-availability.json`` from the payload, tolerating anything."""
    path = payload_root / AVAILABILITY_DOCUMENT
    try:
        if path.stat().st_size > MAX_DOCUMENT_BYTES:
            logger.warning("%s is larger than the size limit; ignoring it", path)
            return {}
        return parse_availability(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Could not read %s", path, exc_info=True)
        return {}


def availability_of(availability: dict[str, str], name: str) -> str:
    return availability.get(name, DEFAULT_AVAILABILITY)


def is_off(availability: dict[str, str], name: str) -> bool:
    return availability.get(name) == OFF


def availability_fingerprint(availability: dict[str, str]) -> str:
    """Identity of the declaration, so an edit replaces the Codex process.

    The instructions already carry most of it, but a change that only moves a
    skill to ``hidden`` leaves them identical while still changing what the
    console offers. Fingerprinting the map directly means every value is
    covered, not just the ones that happen to be rendered.
    """
    return hashlib.sha256(
        "\0".join(
            f"{name}={availability[name]}" for name in sorted(availability)
        ).encode("utf-8")
    ).hexdigest()


__all__ = [
    "AVAILABILITIES",
    "AVAILABILITY_DOCUMENT",
    "BUILTIN",
    "COMMAND",
    "DEFAULT_AVAILABILITY",
    "HIDDEN",
    "MAX_DOCUMENT_BYTES",
    "OFF",
    "availability_fingerprint",
    "availability_of",
    "is_off",
    "load_availability",
    "parse_availability",
]
