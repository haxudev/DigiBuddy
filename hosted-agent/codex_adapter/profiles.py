"""Agent profiles.

A profile is data, not an image: one runtime image serves every business agent.
A profile selects a subset of the packaged capabilities (skills, tools, remote
MCP servers) and optionally overrides the model settings and persona.

Filtering is a *visibility* mechanism that keeps the prompt focused. It is not a
security boundary -- Codex has a full shell. Real isolation must come from the
credentials each profile is granted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

DEFAULT_PROFILE_NAME = "digibuddy"

REASONING_EFFORTS = frozenset({"minimal", "low", "medium", "high"})


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
    """``None`` (absent) keeps everything; a list restricts to those entries."""
    if not isinstance(value, list):
        return None
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
        if not name:
            continue
        effort = _text(entry.get("reasoning_effort")).lower()
        profiles[name] = AgentProfile(
            name=name,
            display_name=_text(entry.get("display_name")) or name,
            description=_text(entry.get("description")),
            persona=_text(entry.get("persona")),
            skills=_names(entry.get("skills")),
            tools=_names(entry.get("tools")),
            mcp_servers=_names(entry.get("mcp_servers")),
            model_name=_text(entry.get("model")),
            reasoning_effort=effort if effort in REASONING_EFFORTS else "",
        )
    return profiles


def resolve_profile(
    profiles: dict[str, AgentProfile], requested: str | None
) -> AgentProfile:
    """Pick the requested profile, else the configured default, else everything."""
    name = (requested or "").strip()
    if name and name in profiles:
        return profiles[name]
    if DEFAULT_PROFILE_NAME in profiles:
        return profiles[DEFAULT_PROFILE_NAME]
    return DEFAULT_PROFILE


def profile_fingerprint(profile: AgentProfile) -> str:
    """Identity of everything that affects the generated Codex configuration."""
    return "|".join(
        [
            profile.name,
            profile.model_name,
            profile.reasoning_effort,
            ",".join(sorted(profile.mcp_servers)) if profile.mcp_servers else "*",
        ]
    )


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
