"""Reading the frontmatter block at the top of a ``SKILL.md``.

The console needs a sentence about each skill to put next to it in the slash
menu, and it cannot read the image's files -- the Web UI and the hosted agent
are separate containers that share only the config store. So the runtime reads
the frontmatter here and publishes it in the catalogue.

This is the twin of ``parseFrontmatter`` in ``webui/src/lib/skill-bundle.ts``.
Both are deliberately not YAML parsers: a skill's frontmatter is a handful of
scalar keys, and the two that matter are the ones every runtime agrees on. The
two implementations have to stay in step, because a description that parses in
one plane and not the other would put a blank entry in the menu.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: ``SKILL.md`` is prose. Anything larger is not frontmatter worth scanning for,
#: and reading it in full would make one bad file expensive.
MAX_SKILL_MD_BYTES = 1024 * 1024

_OPENING = re.compile(r"^---\r?\n")
_CLOSING = re.compile(r"\r?\n---[ \t]*(?:\r?\n|$)")
_KEY = re.compile(r"^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$")
_CONTINUATION = re.compile(r"^\s+\S")
_QUOTED = re.compile(r'^["\']|["\']$')


@dataclass(frozen=True)
class Frontmatter:
    name: str = ""
    description: str = ""


def parse_frontmatter(markdown: str) -> Frontmatter:
    """Read ``name`` and ``description`` out of a YAML frontmatter block.

    Anything unreadable is absent rather than an error: a skill without
    frontmatter is still a perfectly good skill, and refusing to catalogue it
    would hide a working capability over a cosmetic detail.
    """
    text = markdown.lstrip("\ufeff")
    if not _OPENING.match(text):
        return Frontmatter()
    closing = _CLOSING.search(text)
    if closing is None:
        return Frontmatter()

    block = text[text.index("\n") + 1 : closing.start()]
    values: dict[str, str] = {}
    key = ""
    for line in block.splitlines():
        # Fold YAML block scalars and plain continuation lines into the open key.
        if key and _CONTINUATION.match(line):
            values[key] = f"{values[key]} {line.strip()}".strip()
            continue
        match = _KEY.match(line)
        if match is None:
            key = ""
            continue
        key = match.group(1).lower()
        value = _QUOTED.sub("", match.group(2).strip())
        values[key] = "" if value in ("|", ">") else value

    return Frontmatter(
        name=values.get("name", "").strip(),
        description=" ".join(values.get("description", "").split()),
    )


def read_skill_frontmatter(skill_md: Path) -> Frontmatter:
    """Read a ``SKILL.md`` from disk, tolerating anything unreadable.

    A skill directory that cannot be read is still installed and still works;
    only its description is missing. Failing here would take the whole catalogue
    down for one unreadable file.
    """
    try:
        if skill_md.stat().st_size > MAX_SKILL_MD_BYTES:
            return Frontmatter()
        return parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return Frontmatter()


__all__ = [
    "MAX_SKILL_MD_BYTES",
    "Frontmatter",
    "parse_frontmatter",
    "read_skill_frontmatter",
]
