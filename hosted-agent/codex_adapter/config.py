from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import secrets
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
from .skills import (
    install_deployed_skills,
    load_registry,
    registry_fingerprint,
)
from .profiles import (
    DEFAULT_PROFILE,
    REASONING_EFFORTS,
    AgentProfile,
    Catalogue,
    parse_profiles,
    profile_fingerprint,
)

MODEL_API_KEY_ENV = "DIGIBUDDY_MODEL_API_KEY"
logger = logging.getLogger(__name__)

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}
_NETWORK_CAPABLE_SANDBOX = "workspace-write"
_FINGERPRINT_KEY = secrets.token_bytes(32)


@dataclass(frozen=True)
class RuntimeSettings:
    model_name: str
    model_endpoint: str
    model_api_key: str
    model_provider: str
    approval_policy: str
    sandbox: str
    network_access: bool
    workspace: Path
    codex_home: Path
    instructions_path: Path
    payload_root: Path
    skills_source: Path
    reasoning_effort: str = "high"
    protocol_timeout_seconds: float = 60.0
    turn_idle_timeout_seconds: float = 300.0


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    raise RuntimeError(f"{name} must be a boolean value, got {raw!r}")


def _env_positive_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive number, got {raw!r}") from exc
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"{name} must be a positive number, got {raw!r}")
    return value


def load_settings() -> RuntimeSettings:
    root = Path(__file__).resolve().parent.parent
    settings = RuntimeSettings(
        model_name=os.environ.get("CODEX_MODEL_NAME", "gpt-5.2-codex").strip(),
        model_endpoint=os.environ.get("CODEX_MODEL_ENDPOINT", "").strip().rstrip("/"),
        model_api_key=os.environ.get("CODEX_MODEL_API_KEY", "").strip(),
        model_provider=os.environ.get("CODEX_MODEL_PROVIDER", "digibuddy").strip(),
        approval_policy=os.environ.get("CODEX_APPROVAL_POLICY", "never").strip(),
        sandbox=os.environ.get("CODEX_SANDBOX", "workspace-write").strip(),
        network_access=_env_flag("CODEX_NETWORK_ACCESS", True),
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
        skills_source=Path(
            os.environ.get("CODEX_SKILLS_SOURCE", str(root / "skills"))
        ).resolve(),
        reasoning_effort=os.environ.get("CODEX_REASONING_EFFORT", "high").strip(),
        protocol_timeout_seconds=_env_positive_seconds(
            "CODEX_PROTOCOL_TIMEOUT_SECONDS", 60.0
        ),
        turn_idle_timeout_seconds=_env_positive_seconds(
            "CODEX_TURN_IDLE_TIMEOUT_SECONDS", 300.0
        ),
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
    if settings.network_access and settings.sandbox != _NETWORK_CAPABLE_SANDBOX:
        logger.warning(
            "CODEX_NETWORK_ACCESS is enabled but CODEX_SANDBOX=%s ignores it; "
            "set CODEX_SANDBOX=%s to grant the sandbox network egress",
            settings.sandbox,
            _NETWORK_CAPABLE_SANDBOX,
        )
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
            parsed = urlparse(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or any(marker in url for marker in ("<", ">", "{", "}"))
            ):
                logger.warning("Skipping MCP server %s with an invalid HTTPS URL", name)
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
    skills = set()
    for skills_root in (settings.payload_root / "skills", settings.skills_source):
        if not skills_root.is_dir():
            continue
        skills.update(
            entry.name
            for entry in skills_root.iterdir()
            if entry.is_dir() and (entry / "SKILL.md").is_file()
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
    skills.update(
        skill.name for skill in load_registry(store) if skill.enabled
    )
    mcp_servers = sorted(load_mcp_servers(settings, store))
    return Catalogue(
        skills=tuple(sorted(skills)),
        tools=tuple(tools),
        mcp_servers=tuple(mcp_servers),
    )


def _render_toml_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(json.dumps(item) for item in value) + "]"
    if isinstance(value, dict):
        pairs = ", ".join(
            f"{json.dumps(str(key))} = {json.dumps(val)}"
            for key, val in value.items()
        )
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
        lines.append(f"model_provider = {json.dumps(settings.model_provider)}")
    if settings.sandbox == _NETWORK_CAPABLE_SANDBOX:
        lines.extend(
            [
                "",
                "[sandbox_workspace_write]",
                f"network_access = {json.dumps(settings.network_access)}",
            ]
        )
    if settings.model_endpoint:
        lines.extend(
            [
                "",
                f"[model_providers.{json.dumps(settings.model_provider)}]",
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
        lines.extend(["", f"[mcp_servers.{json.dumps(name)}]"])
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


def runtime_fingerprint(
    settings: RuntimeSettings,
    store: ConfigStore | None,
    profile: AgentProfile,
    reasoning_effort: str = "",
) -> str:
    """Fingerprint every input that requires replacing the Codex process."""
    secret_digest = hashlib.scrypt(
        settings.model_api_key.encode("utf-8"),
        salt=_FINGERPRINT_KEY,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    ).hex()
    parts = [
        render_codex_config(settings, store, profile, reasoning_effort),
        registry_fingerprint(load_registry(store)),
        load_instructions(settings, profile),
        profile_fingerprint(profile),
        secret_digest,
        settings.approval_policy,
        settings.sandbox,
        str(settings.workspace),
        str(settings.payload_root),
    ]
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


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


#: Written by ``scripts/sync-agent-skills.sh`` beside the synced skills. It
#: names every skill the image is supposed to carry, so a source that silently
#: stops publishing a skill fails the container rather than quietly shrinking
#: the agent's capabilities.
PACKAGED_SKILL_MANIFEST = ".manifest"


def _assert_packaged_manifest(source: Path, candidates: list[Path]) -> None:
    found = {candidate.name for candidate in candidates}
    if not found:
        raise RuntimeError(f"no packaged global skills found in {source}")

    manifest = source / PACKAGED_SKILL_MANIFEST
    if not manifest.is_file():
        return
    expected = {
        line.strip()
        for line in manifest.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    if expected and expected != found:
        missing = ", ".join(sorted(expected - found)) or "none"
        extra = ", ".join(sorted(found - expected)) or "none"
        raise RuntimeError(
            f"packaged global skills in {source} do not match the manifest "
            f"(missing: {missing}; unexpected: {extra})"
        )


def install_global_skills(
    settings: RuntimeSettings,
    profile: AgentProfile | None = None,
    store: ConfigStore | None = None,
) -> int:
    """Publish the profile's skills into Codex's global root.

    Both sources land in the same directory so Codex discovers them uniformly:
    the immutable build-time skills the image ships, and the ones an
    administrator deployed through the console.
    """
    source = settings.skills_source
    target = settings.codex_home / "skills"
    if not source.is_dir():
        raise RuntimeError(f"packaged global skill directory is missing: {source}")

    candidates = [
        candidate
        for candidate in sorted(source.iterdir())
        if (candidate / "SKILL.md").is_file()
    ]
    _assert_packaged_manifest(source, candidates)

    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)

    active = profile or DEFAULT_PROFILE
    installed = 0
    for candidate in candidates:
        if not active.allows_skill(candidate.name):
            continue
        destination = target / candidate.name
        shutil.copytree(candidate, destination)
        installed += 1

    logger.info("Installed %d global Codex skills into %s", installed, target)
    if store is not None:
        installed += install_deployed_skills(
            store,
            load_registry(store),
            target,
            allows=active.allows_skill,
            reserved=frozenset(
                candidate.name
                for root in (settings.payload_root / "skills", source)
                if root.is_dir()
                for candidate in root.iterdir()
                if candidate.is_dir() and (candidate / "SKILL.md").is_file()
            ),
        )
    return installed


def prepare_codex_environment(
    settings: RuntimeSettings,
    store: ConfigStore | None = None,
    profile: AgentProfile | None = None,
    reasoning_effort: str = "",
) -> dict[str, str]:
    active = profile or DEFAULT_PROFILE
    settings.workspace.mkdir(parents=True, exist_ok=True)
    settings.codex_home.mkdir(parents=True, exist_ok=True)
    install_global_skills(settings, active, store)
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
    "install_global_skills",
    "load_instructions",
    "load_mcp_servers",
    "load_profiles",
    "load_settings",
    "prepare_codex_environment",
    "render_codex_config",
    "runtime_fingerprint",
    "validate_settings",
]
