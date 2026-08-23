from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


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


def load_settings() -> RuntimeSettings:
    root = Path(__file__).resolve().parent.parent
    settings = RuntimeSettings(
        model_name=os.environ.get("CODEX_MODEL_NAME", "gpt-5.2-codex").strip(),
        model_endpoint=os.environ.get("CODEX_MODEL_ENDPOINT", "").strip().rstrip("/"),
        model_api_key=os.environ.get("CODEX_MODEL_API_KEY", "").strip(),
        model_provider=os.environ.get("CODEX_MODEL_PROVIDER", "haeronclaw").strip(),
        approval_policy=os.environ.get("CODEX_APPROVAL_POLICY", "never").strip(),
        sandbox=os.environ.get("CODEX_SANDBOX", "workspace-write").strip(),
        workspace=Path(os.environ.get("CODEX_WORKSPACE", "/workspace")).resolve(),
        codex_home=Path(
            os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
        ).resolve(),
        instructions_path=Path(
            os.environ.get("CODEX_INSTRUCTIONS_PATH", str(root / "AGENTS.md"))
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
                'name = "HaeronClaw configured provider"',
                f"base_url = {json.dumps(settings.model_endpoint)}",
                'env_key = "HAERONCLAW_MODEL_API_KEY"',
                'wire_api = "responses"',
            ]
        )
    return "\n".join(lines) + "\n"


def prepare_codex_environment(settings: RuntimeSettings) -> dict[str, str]:
    settings.workspace.mkdir(parents=True, exist_ok=True)
    settings.codex_home.mkdir(parents=True, exist_ok=True)
    config_path = settings.codex_home / "config.toml"
    config_path.write_text(render_codex_config(settings), encoding="utf-8")
    config_path.chmod(0o600)

    environment = os.environ.copy()
    environment["CODEX_HOME"] = str(settings.codex_home)
    if settings.model_api_key:
        environment["HAERONCLAW_MODEL_API_KEY"] = settings.model_api_key
        if not settings.model_endpoint:
            environment["OPENAI_API_KEY"] = settings.model_api_key
    return environment
