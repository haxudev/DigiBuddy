"""Agent profiles.

A profile is data, not an image: one runtime image serves every business agent.
A profile selects a subset of the packaged capabilities (skills, tools, remote
MCP servers) and optionally overrides the model settings and persona.

Filtering is a *visibility* mechanism that keeps the prompt focused. It is not a
security boundary -- Codex has a full shell. Real isolation must come from the
credentials each profile is granted.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

DEFAULT_PROFILE_NAME = "digibuddy"
_PROFILE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

REASONING_EFFORTS = frozenset({"minimal", "low", "medium", "high"})

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
    display_name="DigiBuddy",
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


def parse_profiles(document: Any) -> dict[str, AgentProfile]:
    """Parse a ``profiles.json`` document into a name -> profile mapping.

    Malformed entries are skipped rather than failing the whole runtime, so one
    bad edit in the admin console cannot take the agent offline.
    """
    profiles: dict[str, AgentProfile] = {}
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
    if name:
        if name in profiles:
            return profiles[name]
        raise UnknownProfileError(name)
    if DEFAULT_PROFILE_NAME in profiles:
        return profiles[DEFAULT_PROFILE_NAME]
    return DEFAULT_PROFILE


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
class Catalogue:
    """What the running image actually ships, published for the admin console."""

    skills: tuple[str, ...] = field(default=())
    tools: tuple[str, ...] = field(default=())
    mcp_servers: tuple[str, ...] = field(default=())

    def as_document(self) -> dict[str, Any]:
        return {
            "skills": list(self.skills),
            "tools": list(self.tools),
            "mcp_servers": list(self.mcp_servers),
        }
