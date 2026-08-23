from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

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


def load_mcp_servers(settings: RuntimeSettings) -> dict[str, dict[str, Any]]:
    """Read the payload `mcp.json` catalogue of remote and local MCP servers."""
    path = settings.payload_root / "mcp.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RuntimeError(f"{path} is not readable JSON") from exc

    servers = data.get("servers") if isinstance(data, dict) else None
    if not isinstance(servers, dict):
        return {}

    resolved: dict[str, dict[str, Any]] = {}
    for name, server in servers.items():
        if not isinstance(name, str) or not isinstance(server, dict):
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


def _render_toml_value(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(json.dumps(item) for item in value) + "]"
    if isinstance(value, dict):
        pairs = ", ".join(f"{key} = {json.dumps(val)}" for key, val in value.items())
        return "{" + pairs + "}"
    return json.dumps(value)


def render_codex_config(settings: RuntimeSettings) -> str:
    lines = [
        f"model = {json.dumps(settings.model_name)}",
        'model_reasoning_effort = "high"',
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

    servers = load_mcp_servers(settings)
    if any("url" in server for server in servers.values()):
        lines.insert(2, "experimental_use_rmcp_client = true")
    for name, server in servers.items():
        lines.extend(["", f"[mcp_servers.{name}]"])
        lines.extend(
            f"{key} = {_render_toml_value(value)}" for key, value in server.items()
        )

    return "\n".join(lines) + "\n"


def load_instructions(settings: RuntimeSettings) -> str:
    """Runtime guardrails plus the payload persona, tool and skill catalogue."""
    sections = [settings.instructions_path.read_text(encoding="utf-8")]
    payload_instructions = settings.payload_root / "AGENTS.md"
    if payload_instructions.is_file():
        sections.append(payload_instructions.read_text(encoding="utf-8"))
    return "\n\n".join(section.strip() for section in sections) + "\n"


def prepare_codex_environment(settings: RuntimeSettings) -> dict[str, str]:
    settings.workspace.mkdir(parents=True, exist_ok=True)
    settings.codex_home.mkdir(parents=True, exist_ok=True)
    config_path = settings.codex_home / "config.toml"
    config_path.write_text(render_codex_config(settings), encoding="utf-8")
    config_path.chmod(0o600)

    environment = os.environ.copy()
    environment["CODEX_HOME"] = str(settings.codex_home)
    environment["DIGIBUDDY_PAYLOAD_ROOT"] = str(settings.payload_root)
    environment["DIGIBUDDY_SKILLS_ROOT"] = str(settings.payload_root / "skills")
    environment["DIGIBUDDY_TOOLS_ROOT"] = str(settings.payload_root / "tools")
    if settings.model_api_key:
        environment[MODEL_API_KEY_ENV] = settings.model_api_key
        if not settings.model_endpoint:
            environment["OPENAI_API_KEY"] = settings.model_api_key
    return environment
