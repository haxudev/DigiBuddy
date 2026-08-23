"""Runtime configuration overlay.

The Hosted Agent image bakes in a default payload (``src/``). Administrators can
override the model settings, remote MCP catalogue and agent profiles at runtime
without rebuilding the image by pointing the runtime at a shared document store.

Two backends are supported:

``DIGIBUDDY_CONFIG_URI``
    An Azure Blob container URL. Documents are blobs inside the container and
    are read with the agent's own Entra ID identity -- no account key.

``DIGIBUDDY_CONFIG_DIR``
    A directory. Useful for local development and for mounted file shares.

Both backends are optional. When neither is configured the packaged defaults are
used unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

CONFIG_URI_ENV = "DIGIBUDDY_CONFIG_URI"
CONFIG_DIR_ENV = "DIGIBUDDY_CONFIG_DIR"
CONFIG_TTL_ENV = "DIGIBUDDY_CONFIG_TTL_SECONDS"

MODELS_DOCUMENT = "models.json"
MCP_DOCUMENT = "mcp.json"
PROFILES_DOCUMENT = "profiles.json"
CATALOGUE_DOCUMENT = "catalogue.json"

DOCUMENTS = (MODELS_DOCUMENT, MCP_DOCUMENT, PROFILES_DOCUMENT, CATALOGUE_DOCUMENT)


class ConfigStore(Protocol):
    """Read/write access to the runtime configuration documents."""

    def read(self, name: str) -> dict[str, Any] | None: ...

    def write(self, name: str, document: dict[str, Any]) -> None: ...


class NullConfigStore:
    """Used when no overlay is configured; always falls back to the payload."""

    def read(self, name: str) -> dict[str, Any] | None:
        return None

    def write(self, name: str, document: dict[str, Any]) -> None:
        return None


class FileConfigStore:
    """Overlay documents stored in a directory."""

    def __init__(self, root: Path):
        self._root = root

    def read(self, name: str) -> dict[str, Any] | None:
        path = self._root / _safe_document_name(name)
        if not path.is_file():
            return None
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("config overlay %s is not readable JSON; ignoring", path)
            return None
        return document if isinstance(document, dict) else None

    def write(self, name: str, document: dict[str, Any]) -> None:
        path = self._root / _safe_document_name(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".config-")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(document, stream, ensure_ascii=False, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class BlobConfigStore:
    """Overlay documents stored as blobs, authenticated with Entra ID."""

    def __init__(self, container_url: str):
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import ContainerClient

        self._container = ContainerClient.from_container_url(
            container_url, credential=DefaultAzureCredential()
        )

    def read(self, name: str) -> dict[str, Any] | None:
        from azure.core.exceptions import AzureError

        try:
            payload = self._container.download_blob(
                _safe_document_name(name)
            ).readall()
        except AzureError:
            return None
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.warning("config overlay blob %s is not readable JSON", name)
            return None
        return document if isinstance(document, dict) else None

    def write(self, name: str, document: dict[str, Any]) -> None:
        payload = json.dumps(document, ensure_ascii=False, sort_keys=True)
        self._container.upload_blob(
            _safe_document_name(name), payload.encode("utf-8"), overwrite=True
        )


class CachingConfigStore:
    """Time-bounded cache so every turn does not hit the network."""

    def __init__(self, inner: ConfigStore, ttl_seconds: float):
        self._inner = inner
        self._ttl = max(ttl_seconds, 0.0)
        self._cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

    def read(self, name: str) -> dict[str, Any] | None:
        now = time.monotonic()
        cached = self._cache.get(name)
        if cached and now - cached[0] < self._ttl:
            return cached[1]
        document = self._inner.read(name)
        self._cache[name] = (now, document)
        return document

    def write(self, name: str, document: dict[str, Any]) -> None:
        self._inner.write(name, document)
        self._cache.pop(name, None)


def _safe_document_name(name: str) -> str:
    """Reject traversal and nested paths; documents live in a flat namespace."""
    if name not in DOCUMENTS:
        raise ValueError(f"Unknown configuration document: {name}")
    return name


def build_config_store(
    environment: dict[str, str] | None = None,
) -> ConfigStore:
    env = environment if environment is not None else dict(os.environ)
    ttl = _ttl_seconds(env.get(CONFIG_TTL_ENV))

    container_url = (env.get(CONFIG_URI_ENV) or "").strip()
    if container_url:
        if urlparse(container_url).scheme != "https":
            raise RuntimeError(f"{CONFIG_URI_ENV} must use HTTPS")
        try:
            return CachingConfigStore(BlobConfigStore(container_url), ttl)
        except Exception:  # noqa: BLE001 - never block startup on the overlay
            logger.exception("Falling back to packaged config; %s unusable", CONFIG_URI_ENV)
            return NullConfigStore()

    directory = (env.get(CONFIG_DIR_ENV) or "").strip()
    if directory:
        return CachingConfigStore(FileConfigStore(Path(directory).resolve()), ttl)

    return NullConfigStore()


def _ttl_seconds(raw: str | None) -> float:
    try:
        return max(float(raw), 0.0) if raw else 30.0
    except ValueError:
        return 30.0
