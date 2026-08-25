"""Agent profiles.

A profile is data, not an image: one runtime image serves every business agent.
A profile selects a subset of the packaged capabilities (skills, tools, remote
MCP servers), optionally overrides the model settings and persona, and binds the
credentials its agent is allowed to use.

Two different things are going on, and they are worth keeping apart.

Capability filtering is *visibility*. It keeps the prompt focused and stops the
model reaching for something this agent has no business using. It is not a
sandbox: Codex has a full shell, and a determined turn can look around.

Credential binding is the part with teeth. A profile's values are handed only to
that profile's Codex process, and switching profile already replaces the
process, so one agent's secrets are never present in another's environment. That
holds against the ordinary failure -- an agent using a credential it should not
have -- but not against a prompt injection reaching the container's ambient
managed identity. See `credentials.py` and the security notes in
`docs/architecture.md` for where the line actually falls.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

DEFAULT_PROFILE_NAME = "digibuddy"
_PROFILE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})

#: Sentinel for "the key was not present at all", which is the only thing that
#: may widen a profile to the whole catalogue.
_ABSENT = object()


class UnknownProfileError(LookupError):
    """A caller named a profile that this configuration does not define.

    Resolving it to the default would hand a conversation the capabilities of a
    different agent, so an explicit name that cannot be found is an error.
    """

    def __init__(self, name: str):
        super().__init__(f"Unknown agent profile: {name}")
        self.name = name


class MalformedProfileError(ValueError):
    """A profile entry could not be read the way it was written."""


class ProfileMap(dict[str, "AgentProfile"]):
    """Parsed profiles plus whether a profiles document actually existed.

    An empty mapping is ambiguous otherwise. It may mean "nothing has ever been
    configured", where the built-in unrestricted default is intentional, or
    "an administrator supplied an empty/all-invalid document", where falling
    back to that default would turn a bad edit into a capability escalation.
    """

    def __init__(self, *, configured: bool = False):
        super().__init__()
        self.configured = configured


@dataclass(frozen=True)
class AgentProfile:
    name: str
    display_name: str = ""
    description: str = ""
    persona: str = ""
    #: ``None`` means "every packaged capability"; a list means "only these".
    skills: tuple[str, ...] | None = None
    tools: tuple[str, ...] | None = None
    mcp_servers: tuple[str, ...] | None = None
    model_name: str = ""
    reasoning_effort: str = ""

    def allows_skill(self, name: str) -> bool:
        return self.skills is None or name in self.skills

    def allows_tool(self, name: str) -> bool:
        return self.tools is None or name in self.tools

    def allows_mcp_server(self, name: str) -> bool:
        return self.mcp_servers is None or name in self.mcp_servers


#: Unrestricted profile used when nothing else is configured or requested.
DEFAULT_PROFILE = AgentProfile(
    name=DEFAULT_PROFILE_NAME,
    display_name="GTMBuddy",
    description="Full Microsoft domain expert with every packaged capability.",
)


def _names(value: Any) -> tuple[str, ...] | None:
    """``None`` (absent) keeps everything; a list restricts to those entries.

    Anything else is malformed. It deliberately does *not* degrade to "keep
    everything": a selection that cannot be read is far more likely to be a bad
    edit than an intent to grant the full catalogue.
    """
    if value is _ABSENT or value is None:
        return None
    if not isinstance(value, list):
        raise MalformedProfileError(
            f"a capability selection must be a list, got {type(value).__name__}"
        )
    return tuple(
        stripped
        for item in value
        if isinstance(item, str) and (stripped := item.strip())
    )


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_profiles(document: Any) -> ProfileMap:
    """Parse a ``profiles.json`` document into a name -> profile mapping.

    Malformed entries are skipped rather than failing the whole runtime, so one
    bad edit in the admin console cannot take the agent offline.
    """
    profiles = ProfileMap(configured=isinstance(document, dict))
    entries = document.get("profiles") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        return profiles

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name"))
        if not _PROFILE_NAME.fullmatch(name):
            continue
        effort = _text(entry.get("reasoning_effort")).lower()
        try:
            skills = _names(entry.get("skills", _ABSENT))
            tools = _names(entry.get("tools", _ABSENT))
            mcp_servers = _names(entry.get("mcp_servers", _ABSENT))
        except MalformedProfileError:
            # Dropping the profile makes it unresolvable, which fails closed.
            # Keeping it with an unreadable selection would fail open.
            continue
        profiles[name] = AgentProfile(
            name=name,
            display_name=_text(entry.get("display_name")) or name,
            description=_text(entry.get("description")),
            persona=_text(entry.get("persona")),
            skills=skills,
            tools=tools,
            mcp_servers=mcp_servers,
            model_name=_text(entry.get("model")),
            reasoning_effort=effort if effort in REASONING_EFFORTS else "",
        )
    return profiles


def resolve_profile(
    profiles: dict[str, AgentProfile], requested: str | None
) -> AgentProfile:
    """Pick the requested profile, or the default when none was requested.

    An explicitly named profile that is not configured raises rather than
    falling back: a renamed or deleted restricted agent must not silently
    resume as the unrestricted default.
    """
    name = (requested or "").strip()
    configured = (
        profiles.configured if isinstance(profiles, ProfileMap) else bool(profiles)
    )
    if name:
        if name in profiles:
            return profiles[name]
        # The built-in default exists only before an administrator has curated
        # any profiles. Once a profiles document names even one agent, omission
        # is policy: treating the familiar default name as a secret escape hatch
        # would turn a typo, deletion or malformed restricted profile into the
        # unrestricted capability set.
        if name == DEFAULT_PROFILE_NAME and not configured:
            return DEFAULT_PROFILE
        raise UnknownProfileError(name)
    if DEFAULT_PROFILE_NAME in profiles:
        return profiles[DEFAULT_PROFILE_NAME]
    if not configured:
        return DEFAULT_PROFILE
    raise UnknownProfileError(DEFAULT_PROFILE_NAME)


def profile_fingerprint(profile: AgentProfile) -> str:
    """Identity of everything a profile contributes to a Codex process."""
    document = {
        "name": profile.name,
        "display_name": profile.display_name,
        "description": profile.description,
        "persona": profile.persona,
        "skills": profile.skills,
        "tools": profile.tools,
        "mcp_servers": profile.mcp_servers,
        "model_name": profile.model_name,
        "reasoning_effort": profile.reasoning_effort,
    }
    return hashlib.sha256(
        json.dumps(document, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


@dataclass(frozen=True)
class SkillEntry:
    """A skill as the console needs to present it, not merely name it.

    The Web UI and the hosted agent are separate containers sharing only the
    config store, so the console cannot open a ``SKILL.md`` to find out what a
    skill is for. Whatever the slash menu shows has to travel in the catalogue.
    """

    name: str
    description: str = ""
    #: ``packaged`` for skills baked into the image, ``deployed`` for ones an
    #: administrator uploaded. The console says which is which, because a
    #: packaged skill cannot be withdrawn from the admin surface.
    source: str = "packaged"
    enabled: bool = True

    def as_document(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class Catalogue:
    """What the running image actually ships, published for the admin console."""

    skills: tuple[str, ...] = field(default=())
    tools: tuple[str, ...] = field(default=())
    mcp_servers: tuple[str, ...] = field(default=())
    #: The full skill inventory, with the description and switch state each one
    #: carries.
    #: A separate key rather than a richer ``skills``: the console and the
    #: profile documents already read ``skills`` as a list of names, and the two
    #: containers roll out independently, so the addition has to be one an older
    #: reader can ignore.
    skill_entries: tuple[SkillEntry, ...] = field(default=())

    def as_document(self) -> dict[str, Any]:
        return {
            "skills": list(self.skills),
            "tools": list(self.tools),
            "mcp_servers": list(self.mcp_servers),
            "skill_entries": [entry.as_document() for entry in self.skill_entries],
        }
