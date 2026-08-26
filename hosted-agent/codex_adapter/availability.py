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
import sys
from collections.abc import Sequence
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


def check_image(payload_root: Path, packaged_skills: Path) -> list[str]:
    """Reasons the built image and the declaration disagree.

    ``skill-availability.json`` decides what the runtime deploys and
    ``.dockerignore`` decides what reaches the image. They are two files, so
    they can disagree: a skill declared ``off`` whose bytes still shipped is
    deployed after all, and one declared ``builtin`` that was excluded is
    advertised but missing. Both are silent at runtime, so the build asks this
    question instead.
    """
    declared = parse_availability(
        json.loads((payload_root / AVAILABILITY_DOCUMENT).read_text(encoding="utf-8"))
    )
    present = {
        path.parent.name
        for root in (payload_root / "skills", packaged_skills)
        for path in root.glob("*/SKILL.md")
    }
    problems = []
    for name, value in sorted(declared.items()):
        if value == OFF:
            if name in present:
                problems.append(f"{name} is declared off but shipped; exclude it in .dockerignore")
        elif name not in present:
            problems.append(f"{name} is declared {value} but is not in the image")
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    """Build-time entry point: ``python -m codex_adapter.availability``.

    A script rather than an inline heredoc because ACR's remote builder scans
    the Dockerfile with a parser that does not understand ``RUN <<EOF`` and
    fails the build before running anything.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    payload_root = Path(args[0]) if args else Path("/opt/digibuddy")
    packaged = Path(args[1]) if len(args) > 1 else Path("/app/hosted-agent/skills")
    problems = check_image(payload_root, packaged)
    if problems:
        print("skill availability does not match the image: " + "; ".join(problems), file=sys.stderr)
        return 1
    return 0


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
    "check_image",
    "is_off",
    "load_availability",
    "main",
    "parse_availability",
]


if __name__ == "__main__":
    raise SystemExit(main())
