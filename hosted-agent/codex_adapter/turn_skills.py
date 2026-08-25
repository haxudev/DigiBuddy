"""The skills a single turn asked for.

A slash command in the console names a skill; this decides what that means by
the time Codex sees it.

Skill selection is deliberately *not* configuration. The set of MCP servers, the
model, the profile -- those live in the rendered ``config.toml`` and changing one
replaces the Codex process, container-wide, for every conversation at once. A
skill is different in kind: it is markdown the model reads on demand, so it can
be chosen per turn, and the only channel that is genuinely per turn is the turn's
own prompt. Hence a directive prefixed to the message rather than an instruction
block or a config key.

The names arrive in request metadata, so they are caller-controlled. They are
matched against a name pattern, resolved against the roots that actually hold
skills, and confirmed to stay inside them.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

#: The same shape the registry and the console accept, so a skill that can be
#: deployed can also be asked for.
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*$")

#: One turn loads a handful of skills at most. A command bundles two or three;
#: anything beyond this is a caller filling the prompt rather than choosing.
MAX_TURN_SKILLS = 8


def requested_skills(metadata: Any) -> tuple[str, ...]:
    """Read ``metadata.skills``, keeping only plausible names.

    Order is preserved and duplicates are dropped, because the directive lists
    the skills in the order the command declared them and a repeat would just
    say the same thing twice.
    """
    if not isinstance(metadata, dict):
        return ()
    raw = metadata.get("skills")
    if isinstance(raw, str):
        raw = [part for part in raw.split(",")]
    if not isinstance(raw, list):
        return ()

    names: list[str] = []
    for entry in raw:
        if not isinstance(entry, str):
            continue
        name = entry.strip().lower()
        if not SKILL_NAME.fullmatch(name) or name in names:
            continue
        names.append(name)
        if len(names) >= MAX_TURN_SKILLS:
            break
    return tuple(names)


#: Where a skill may live, and the variable the agent knows that root by.
#: Codex's own global root comes first: it holds the image's global skills and
#: everything an administrator deployed, which is what a command normally names.
_ROOTS = (
    ("codex_home_skills", "$CODEX_HOME/skills"),
    ("payload_skills", "$DIGIBUDDY_SKILLS_ROOT"),
)


def locate_skill(
    name: str, *, codex_home_skills: Path, payload_skills: Path
) -> str | None:
    """The path to a skill's ``SKILL.md``, written the way the agent reads paths.

    Returns ``None`` when the skill is not installed -- which is the normal way
    a profile's restrictions show up here, since ``install_global_skills`` only
    publishes what the profile allows.
    """
    roots = {"codex_home_skills": codex_home_skills, "payload_skills": payload_skills}
    for key, display in _ROOTS:
        root = roots[key]
        try:
            resolved_root = root.resolve()
            candidate = (root / name / "SKILL.md").resolve()
        except OSError:
            continue
        # The name already matched a strict pattern, so this cannot currently
        # escape. It is checked anyway because the pattern and the filesystem
        # are two different guarantees, and only one of them is enforced here.
        if not candidate.is_relative_to(resolved_root):
            continue
        if candidate.is_file():
            return f"{display}/{name}/SKILL.md"
    return None


def resolve_turn_skills(
    names: Iterable[str],
    *,
    codex_home_skills: Path,
    payload_skills: Path,
    allows: Callable[[str], bool],
) -> tuple[tuple[str, str], ...]:
    """Pair each requested skill with its path, dropping the unreachable ones.

    The console filters the menu by profile already, but that is a convenience
    for the reader. This is the boundary: metadata arrives from the caller, so
    the profile is enforced here regardless of what the menu showed.

    ``allows`` is required rather than defaulting to allow-all. It is the whole
    access check, and a caller that forgot to pass it would silently grant every
    skill in the image to every conversation.
    """
    resolved: list[tuple[str, str]] = []
    for name in names:
        if not allows(name):
            logger.info("Turn asked for skill %r the profile does not allow", name)
            continue
        path = locate_skill(
            name, codex_home_skills=codex_home_skills, payload_skills=payload_skills
        )
        if path is None:
            logger.info("Turn asked for skill %r which is not installed", name)
            continue
        resolved.append((name, path))
    return tuple(resolved)


def skill_directive(skills: tuple[tuple[str, str], ...], command: str = "") -> str:
    """The sentence that loads the skills, or empty when there is nothing to load.

    The command name is re-checked here rather than trusted from the caller.
    This builds text that goes into the model's prompt, and ``stream_turn`` is a
    public entry point, so the shape is asserted at the point of interpolation
    instead of relying on a check in whichever module happened to call it.
    """
    if not skills:
        return ""
    if command and not SKILL_NAME.fullmatch(command):
        command = ""
    invoked = f"The user invoked /{command}" if command else "The user asked for"
    if len(skills) == 1:
        name, path = skills[0]
        subject = (
            f"{invoked}, which loads the `{name}` skill."
            if command
            else f"{invoked} the `{name}` skill."
        )
        return (
            f"{subject} Read `{path}` now and follow it for this turn, before "
            f"doing anything else."
        )

    listing = "\n".join(f"- `{name}` — read `{path}`" for name, path in skills)
    subject = (
        f"{invoked}, which loads these skills:"
        if command
        else f"{invoked} these skills:"
    )
    return (
        f"{subject}\n{listing}\n"
        f"Read them now and follow them for this turn, before doing anything "
        f"else. Where they overlap, the first one listed governs."
    )


def apply_skill_directive(prompt: str, directive: str) -> str:
    """Put the directive ahead of the user's message.

    Ahead, not behind: it decides how the message should be read, and a reader
    who has already interpreted the request has less use for it. The user's own
    words are left exactly as written so the message the agent answers is still
    the message that was sent.
    """
    if not directive:
        return prompt
    return f"{directive}\n\n{prompt}" if prompt else directive


__all__ = [
    "MAX_TURN_SKILLS",
    "SKILL_NAME",
    "apply_skill_directive",
    "locate_skill",
    "requested_skills",
    "resolve_turn_skills",
    "skill_directive",
]
