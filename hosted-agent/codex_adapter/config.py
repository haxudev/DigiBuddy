from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config_store import (
    MCP_DOCUMENT,
    MODELS_DOCUMENT,
    PROFILES_DOCUMENT,
    ConfigStore,
    NullConfigStore,
)
from .profiles import (
    DEFAULT_PROFILE,
    REASONING_EFFORTS,
    AgentProfile,
    Catalogue,
    parse_profiles,
)

MODEL_API_KEY_ENV = "DIGIBUDDY_MODEL_API_KEY"


@dataclass(frozen=True)
class RuntimeSettings:
    model_name: str
    model_endpoint: str
    model_api_key: str
    model_provider: str
    approval_policy: str
    sandbox: str
    workspace: Path
    codex_home: Path
    instructions_path: Path
    payload_root: Path
    reasoning_effort: str = "high"


def load_settings() -> RuntimeSettings:
    root = Path(__file__).resolve().parent.parent
    settings = RuntimeSettings(
        model_name=os.environ.get("CODEX_MODEL_NAME", "gpt-5.2-codex").strip(),
        model_endpoint=os.environ.get("CODEX_MODEL_ENDPOINT", "").strip().rstrip("/"),
        model_api_key=os.environ.get("CODEX_MODEL_API_KEY", "").strip(),
        model_provider=os.environ.get("CODEX_MODEL_PROVIDER", "digibuddy").strip(),
        approval_policy=os.environ.get("CODEX_APPROVAL_POLICY", "never").strip(),
        sandbox=os.environ.get("CODEX_SANDBOX", "workspace-write").strip(),
        workspace=Path(os.environ.get("CODEX_WORKSPACE", "/workspace")).resolve(),
        codex_home=Path(
            os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
        ).resolve(),
        instructions_path=Path(
            os.environ.get("CODEX_INSTRUCTIONS_PATH", str(root / "AGENTS.md"))
        ).resolve(),
        payload_root=Path(
            os.environ.get("DIGIBUDDY_PAYLOAD_ROOT", "/opt/digibuddy")
        ).resolve(),
        reasoning_effort=os.environ.get("CODEX_REASONING_EFFORT", "high").strip(),
    )
    validate_settings(settings)
    return settings


def validate_settings(settings: RuntimeSettings) -> None:
    if not settings.model_name:
        raise RuntimeError("CODEX_MODEL_NAME must not be empty")
    if not settings.model_provider:
        raise RuntimeError("CODEX_MODEL_PROVIDER must not be empty")
    if not settings.workspace.is_absolute() or not settings.codex_home.is_absolute():
        raise RuntimeError("CODEX_WORKSPACE and CODEX_HOME must be absolute paths")
    if settings.model_endpoint:
        parsed = urlparse(settings.model_endpoint)
        local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
        if parsed.scheme != "https" and not local_http:
            raise RuntimeError("CODEX_MODEL_ENDPOINT must use HTTPS")
        if not parsed.hostname:
            raise RuntimeError("CODEX_MODEL_ENDPOINT must include a host")
        if not settings.model_api_key:
            raise RuntimeError(
                "CODEX_MODEL_API_KEY is required when CODEX_MODEL_ENDPOINT is set"
            )


def apply_model_overrides(
    settings: RuntimeSettings, store: ConfigStore | None
) -> RuntimeSettings:
    """Layer the admin-managed ``models.json`` document over the environment.

    Blank fields keep the deployed value, so an administrator can change the
    model name without re-entering the key.
    """
    document = store.read(MODELS_DOCUMENT) if store else None
    if not isinstance(document, dict):
        return settings

    def text(key: str, current: str) -> str:
        value = document.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else current

    overridden = replace(
        settings,
        model_name=text("model", settings.model_name),
        model_endpoint=text("endpoint", settings.model_endpoint).rstrip("/"),
        model_api_key=text("api_key", settings.model_api_key),
        model_provider=text("provider", settings.model_provider),
        reasoning_effort=text("reasoning_effort", settings.reasoning_effort),
    )
    # A bad overlay must not take the agent offline; fall back to the image.
    try:
        validate_settings(overridden)
    except RuntimeError:
        return settings
    return overridden


def load_profiles(
    settings: RuntimeSettings, store: ConfigStore | None = None
) -> dict[str, AgentProfile]:
    """Admin-managed profiles win over the ones packaged in the payload."""
    document = store.read(PROFILES_DOCUMENT) if store else None
    if not isinstance(document, dict):
        path = settings.payload_root / "profiles.json"
        if not path.is_file():
            return {}
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return parse_profiles(document)


def _read_mcp_document(
    settings: RuntimeSettings, store: ConfigStore | None
) -> dict[str, Any]:
    document = store.read(MCP_DOCUMENT) if store else None
    if isinstance(document, dict):
        return document
    path = settings.payload_root / "mcp.json"
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RuntimeError(f"{path} is not readable JSON") from exc
    return parsed if isinstance(parsed, dict) else {}


def load_mcp_servers(
    settings: RuntimeSettings,
    store: ConfigStore | None = None,
    profile: AgentProfile | None = None,
) -> dict[str, dict[str, Any]]:
    """Resolve the MCP catalogue, restricted to what the profile assembles."""
    servers = _read_mcp_document(settings, store).get("servers")
    if not isinstance(servers, dict):
        return {}

    resolved: dict[str, dict[str, Any]] = {}
    for name, server in servers.items():
        if not isinstance(name, str) or not isinstance(server, dict):
            continue
        if profile and not profile.allows_mcp_server(name):
            continue
        if server.get("enabled") is False:
            continue
        url = str(server.get("url", "")).strip()
        command = str(server.get("command", "")).strip()
        entry: dict[str, Any]
        if url:
            # Placeholder and plaintext endpoints are skipped rather than
            # silently shipped into the Codex configuration.
            if urlparse(url).scheme != "https":
                continue
            entry = {"url": url}
            token_env = str(server.get("bearer_token_env_var", "")).strip()
            if token_env:
                entry["bearer_token_env_var"] = token_env
        elif command:
            entry = {"command": command}
            args = server.get("args")
            if isinstance(args, list):
                entry["args"] = [str(arg) for arg in args]
            env = server.get("env")
            if isinstance(env, dict):
                entry["env"] = {str(key): str(value) for key, value in env.items()}
        else:
            continue
        resolved[name] = entry
    return resolved


def build_catalogue(
    settings: RuntimeSettings, store: ConfigStore | None = None
) -> Catalogue:
    """Everything this image ships, so the admin console cannot drift from it."""
    skills_root = settings.payload_root / "skills"
    skills = (
        sorted(
            entry.name
            for entry in skills_root.iterdir()
            if entry.is_dir() and (entry / "SKILL.md").is_file()
        )
        if skills_root.is_dir()
        else []
    )
    tools_root = settings.payload_root / "tools"
    tools = (
        sorted(
            entry.stem
            for entry in tools_root.glob("*.py")
            if not entry.name.startswith("_")
        )
        if tools_root.is_dir()
        else []
    )
    servers = _read_mcp_document(settings, store).get("servers")
    mcp_servers = sorted(servers) if isinstance(servers, dict) else []
    return Catalogue(
        skills=tuple(skills), tools=tuple(tools), mcp_servers=tuple(mcp_servers)
    )


def _render_toml_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(json.dumps(item) for item in value) + "]"
    if isinstance(value, dict):
        pairs = ", ".join(f"{key} = {json.dumps(val)}" for key, val in value.items())
        return "{" + pairs + "}"
    return json.dumps(value)


def effective_model(settings: RuntimeSettings, profile: AgentProfile | None) -> str:
    return (profile.model_name if profile else "") or settings.model_name


def effective_reasoning_effort(
    settings: RuntimeSettings,
    profile: AgentProfile | None,
    override: str = "",
) -> str:
    """Resolve the thinking effort for a turn.

    An explicit per-request override wins over the profile and the deployment
    default so the console can offer a thinking-strength control; anything the
    model does not understand is ignored rather than passed through.
    """
    requested = override.strip().lower()
    if requested in REASONING_EFFORTS:
        return requested
    return (profile.reasoning_effort if profile else "") or settings.reasoning_effort


def render_codex_config(
    settings: RuntimeSettings,
    store: ConfigStore | None = None,
    profile: AgentProfile | None = None,
    reasoning_effort: str = "",
) -> str:
    lines = [
        f"model = {json.dumps(effective_model(settings, profile))}",
        "model_reasoning_effort = "
        f"{json.dumps(effective_reasoning_effort(settings, profile, reasoning_effort))}",
    ]
    if settings.model_endpoint:
        lines.extend(
            [
                f"model_provider = {json.dumps(settings.model_provider)}",
                "",
                f"[model_providers.{settings.model_provider}]",
                'name = "DigiBuddy configured provider"',
                f"base_url = {json.dumps(settings.model_endpoint)}",
                f"env_key = {json.dumps(MODEL_API_KEY_ENV)}",
                'wire_api = "responses"',
            ]
        )

    servers = load_mcp_servers(settings, store, profile)
    if any("url" in server for server in servers.values()):
        lines.insert(2, "experimental_use_rmcp_client = true")
    for name, server in servers.items():
        lines.extend(["", f"[mcp_servers.{name}]"])
        lines.extend(
            f"{key} = {_render_toml_value(value)}" for key, value in server.items()
        )

    return "\n".join(lines) + "\n"


def _skill_catalogue(settings: RuntimeSettings, profile: AgentProfile) -> str:
    root = settings.payload_root / "skills"
    if not root.is_dir():
        return ""
    names = sorted(
        entry.name
        for entry in root.iterdir()
        if entry.is_dir()
        and (entry / "SKILL.md").is_file()
        and profile.allows_skill(entry.name)
    )
    if not names:
        return ""
    listing = "\n".join(f"- {name}" for name in names)
    return (
        "## Assembled skills\n\n"
        f"Only these skills are available for this agent profile. Read "
        f"`$DIGIBUDDY_SKILLS_ROOT/<name>/SKILL.md` on demand.\n\n{listing}"
    )


def load_instructions(
    settings: RuntimeSettings, profile: AgentProfile | None = None
) -> str:
    """Runtime guardrails, payload persona, profile persona and skill catalogue."""
    active = profile or DEFAULT_PROFILE
    sections = [settings.instructions_path.read_text(encoding="utf-8")]
    payload_instructions = settings.payload_root / "AGENTS.md"
    if payload_instructions.is_file():
        sections.append(payload_instructions.read_text(encoding="utf-8"))
    if active.persona:
        sections.append(active.persona)
    catalogue = _skill_catalogue(settings, active)
    if catalogue:
        sections.append(catalogue)
    return "\n\n".join(section.strip() for section in sections if section.strip()) + "\n"


def _link_selection(
    source: Path, target: Path, allowed: tuple[str, ...] | None, pattern: str
) -> None:
    """Mirror the allowed entries of ``source`` into ``target`` as symlinks."""
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    if allowed is None:
        target.symlink_to(source, target_is_directory=True)
        return
    target.mkdir(parents=True, exist_ok=True)
    if not source.is_dir():
        return
    for entry in source.glob(pattern):
        name = entry.name if entry.is_dir() else entry.stem
        if name in allowed:
            (target / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())


def prepare_codex_environment(
    settings: RuntimeSettings,
    store: ConfigStore | None = None,
    profile: AgentProfile | None = None,
    reasoning_effort: str = "",
) -> dict[str, str]:
    active = profile or DEFAULT_PROFILE
    settings.workspace.mkdir(parents=True, exist_ok=True)
    settings.codex_home.mkdir(parents=True, exist_ok=True)
    config_path = settings.codex_home / "config.toml"
    config_path.write_text(
        render_codex_config(settings, store, active, reasoning_effort),
        encoding="utf-8",
    )
    config_path.chmod(0o600)

    skills_root = settings.payload_root / "skills"
    tools_root = settings.payload_root / "tools"
    if active.skills is not None or active.tools is not None:
        view = settings.codex_home / "profiles" / active.name
        view.mkdir(parents=True, exist_ok=True)
        _link_selection(skills_root, view / "skills", active.skills, "*")
        _link_selection(tools_root, view / "tools", active.tools, "*.py")
        skills_root = view / "skills"
        tools_root = view / "tools"

    environment = os.environ.copy()
    environment["CODEX_HOME"] = str(settings.codex_home)
    environment["DIGIBUDDY_PAYLOAD_ROOT"] = str(settings.payload_root)
    environment["DIGIBUDDY_SKILLS_ROOT"] = str(skills_root)
    environment["DIGIBUDDY_TOOLS_ROOT"] = str(tools_root)
    environment["DIGIBUDDY_PROFILE"] = active.name
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(tools_root), *filter(None, [environment.get("PYTHONPATH")])]
    )
    if settings.model_api_key:
        environment[MODEL_API_KEY_ENV] = settings.model_api_key
        if not settings.model_endpoint:
            environment["OPENAI_API_KEY"] = settings.model_api_key
    return environment


__all__ = [
    "MODEL_API_KEY_ENV",
    "NullConfigStore",
    "RuntimeSettings",
    "apply_model_overrides",
    "build_catalogue",
    "effective_model",
    "effective_reasoning_effort",
    "load_instructions",
    "load_mcp_servers",
    "load_profiles",
    "load_settings",
    "prepare_codex_environment",
    "render_codex_config",
    "validate_settings",
]
