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
import re
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

CONFIG_URI_ENV = "DIGIBUDDY_CONFIG_URI"
CONFIG_DIR_ENV = "DIGIBUDDY_CONFIG_DIR"
CONFIG_TTL_ENV = "DIGIBUDDY_CONFIG_TTL_SECONDS"

#: The document shapes this build understands. A document written to a newer
#: schema is refused rather than reinterpreted, because the fields this build
#: would ignore are exactly the ones a newer console added to restrict something.
SCHEMA_VERSION = 1
SCHEMA_FIELD = "schema_version"

MODELS_DOCUMENT = "models.json"
MCP_DOCUMENT = "mcp.json"
PROFILES_DOCUMENT = "profiles.json"
CATALOGUE_DOCUMENT = "catalogue.json"
SKILLS_DOCUMENT = "skills.json"
CREDENTIALS_DOCUMENT = "credentials.json"

DOCUMENTS = (
    MODELS_DOCUMENT,
    MCP_DOCUMENT,
    PROFILES_DOCUMENT,
    CATALOGUE_DOCUMENT,
    SKILLS_DOCUMENT,
    CREDENTIALS_DOCUMENT,
)


def readable_schema(document: Any) -> bool:
    """Whether this build may interpret ``document``.

    An absent version is the legacy unversioned shape and is still readable, so
    an existing deployment keeps working across the upgrade.
    """
    if not isinstance(document, dict):
        return False
    version = document.get(SCHEMA_FIELD)
    if version is None:
        return True
    return isinstance(version, int) and not isinstance(version, bool) and version <= SCHEMA_VERSION

#: Administrator-uploaded skill bundles live beside the documents in the same
#: container, under a reserved prefix and addressed by their content hash.
BUNDLE_PREFIX = "bundles/"
_BUNDLE_PATH = re.compile(r"^bundles/[a-z0-9]+(?:-[a-z0-9]+)*/[0-9a-f]{64}\.zip$")
ARTIFACT_PREFIX = "artifacts/"
_ARTIFACT_ID = re.compile(r"^[0-9a-f]{32}$")


class ConfigStore(Protocol):
    """Read/write access to the runtime configuration documents."""

    def read(self, name: str) -> dict[str, Any] | None: ...

    def read_raw(self, name: str) -> dict[str, Any] | None: ...

    def write(self, name: str, document: dict[str, Any]) -> None: ...

    def read_bundle(self, path: str) -> bytes | None: ...

    def write_artifact(
        self, artifact_id: str, filename: str, payload: bytes, content_type: str
    ) -> bool: ...


class NullConfigStore:
    """Used when no overlay is configured; always falls back to the payload."""

    def read(self, name: str) -> dict[str, Any] | None:
        return None

    def read_raw(self, name: str) -> dict[str, Any] | None:
        return None

    def write(self, name: str, document: dict[str, Any]) -> None:
        return None

    def read_bundle(self, path: str) -> bytes | None:
        return None

    def write_artifact(
        self, artifact_id: str, filename: str, payload: bytes, content_type: str
    ) -> bool:
        return False


class FileConfigStore:
    """Overlay documents stored in a directory."""

    def __init__(self, root: Path):
        self._root = root

    def read(self, name: str) -> dict[str, Any] | None:
        document = self.read_raw(name)
        if document is None:
            return None
        if not readable_schema(document):
            logger.warning(
                "config overlay %s declares an unsupported %s; ignoring",
                name,
                SCHEMA_FIELD,
            )
            return None
        return document

    def read_raw(self, name: str) -> dict[str, Any] | None:
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

    def read_bundle(self, path: str) -> bytes | None:
        bundle = self._root / _safe_bundle_path(path)
        try:
            return bundle.read_bytes()
        except OSError:
            return None

    def write_artifact(
        self, artifact_id: str, filename: str, payload: bytes, content_type: str
    ) -> bool:
        del content_type
        target = self._root / artifact_path(artifact_id, filename)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            dir=target.parent, prefix=".artifact-"
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return True


class BlobConfigStore:
    """Overlay documents stored as blobs, authenticated with Entra ID."""

    def __init__(self, container_url: str):
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import ContainerClient

        self._container = ContainerClient.from_container_url(
            container_url, credential=DefaultAzureCredential()
        )

    def read(self, name: str) -> dict[str, Any] | None:
        document = self.read_raw(name)
        if document is None:
            return None
        if not readable_schema(document):
            logger.warning(
                "config overlay blob %s declares an unsupported %s; ignoring",
                name,
                SCHEMA_FIELD,
            )
            return None
        return document

    def read_raw(self, name: str) -> dict[str, Any] | None:
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

    def read_bundle(self, path: str) -> bytes | None:
        from azure.core.exceptions import AzureError

        try:
            return self._container.download_blob(_safe_bundle_path(path)).readall()
        except AzureError:
            return None

    def write_artifact(
        self, artifact_id: str, filename: str, payload: bytes, content_type: str
    ) -> bool:
        from azure.storage.blob import ContentSettings

        self._container.upload_blob(
            artifact_path(artifact_id, filename),
            payload,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )
        return True


class CachingConfigStore:
    """Time-bounded cache so every turn does not hit the network.

    It also holds the last document this build could read. A document the
    backend later replaces with an unsupported schema reads as absent, and
    "absent" means "fall back to the packaged payload" -- which for a profiles
    document would quietly drop every administrator restriction. Serving the
    last good value instead keeps the restriction in force until an operator
    fixes the document or upgrades the runtime.
    """

    def __init__(self, inner: ConfigStore, ttl_seconds: float):
        self._inner = inner
        self._ttl = max(ttl_seconds, 0.0)
        self._cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
        self._last_good: dict[str, dict[str, Any]] = {}

    def read(self, name: str) -> dict[str, Any] | None:
        now = time.monotonic()
        cached = self._cache.get(name)
        if cached and now - cached[0] < self._ttl:
            return cached[1]

        raw = self._inner.read_raw(name)
        if raw is None:
            # Genuinely absent, so the packaged payload is the right answer and
            # there is nothing to protect.
            document = None
            self._last_good.pop(name, None)
        elif readable_schema(raw):
            document = raw
            self._last_good[name] = raw
        else:
            logger.warning(
                "config overlay %s declares an unsupported %s; keeping the last "
                "readable version",
                name,
                SCHEMA_FIELD,
            )
            document = self._last_good.get(name)

        self._cache[name] = (now, document)
        return document

    def read_raw(self, name: str) -> dict[str, Any] | None:
        return self._inner.read_raw(name)

    def write(self, name: str, document: dict[str, Any]) -> None:
        self._inner.write(name, document)
        self._cache.pop(name, None)

    def read_bundle(self, path: str) -> bytes | None:
        # Bundles are content-addressed and cached on disk by the installer, so
        # keeping megabytes of archive in memory would buy nothing.
        return self._inner.read_bundle(path)

    def write_artifact(
        self, artifact_id: str, filename: str, payload: bytes, content_type: str
    ) -> bool:
        return self._inner.write_artifact(
            artifact_id, filename, payload, content_type
        )


def _safe_document_name(name: str) -> str:
    """Reject traversal and nested paths; documents live in a flat namespace."""
    if name not in DOCUMENTS:
        raise ValueError(f"Unknown configuration document: {name}")
    return name


def _safe_bundle_path(path: str) -> str:
    """Only content-addressed bundle paths may be fetched from the store."""
    if not _BUNDLE_PATH.fullmatch(path):
        raise ValueError(f"Not a skill bundle path: {path}")
    return path


def safe_artifact_filename(name: str) -> str:
    """Return one portable path segment without losing non-ASCII names."""
    leaf = str(name or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(
        character
        for character in leaf
        if 32 <= ord(character) != 127 and character not in '<>:"/\\|?*'
    ).strip(" .")
    return cleaned[:180] or "deliverable"


def artifact_path(artifact_id: str, filename: str) -> str:
    """Pin artifact access to an unguessable id below the reserved prefix."""
    if not _ARTIFACT_ID.fullmatch(artifact_id):
        raise ValueError("Invalid artifact id")
    safe_name = safe_artifact_filename(filename)
    if safe_name != filename:
        raise ValueError("Invalid artifact filename")
    return f"{ARTIFACT_PREFIX}{artifact_id}/{safe_name}"


def new_artifact_id() -> str:
    return secrets.token_hex(16)


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
