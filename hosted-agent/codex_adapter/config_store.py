"""Runtime configuration overlay.

The Hosted Agent image bakes in a default payload (``src/``). Administrators can
override the model settings, remote MCP catalogue and agent profiles at runtime
without rebuilding the image by pointing the runtime at a shared document store.

Three backends are supported:

``DIGIBUDDY_CONFIG_URI``
    An Azure Blob container URL. Documents are blobs inside the container and
    are read with the agent's own Entra ID identity -- no account key.

``DIGIBUDDY_CONFIG_API``
    The console runtime API URL, for example
    ``https://<console-host>/api/runtime``. The hosted agent authenticates with
    ``DIGIBUDDY_CONFIG_API_SECRET`` when set, otherwise with its managed
    identity, and asks the console to read and write the shared store from
    inside the virtual network.

``DIGIBUDDY_CONFIG_DIR``
    A directory. Useful for local development and for mounted file shares.

All backends are optional. When none is configured the packaged defaults are
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
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import quote, urlparse

logger = logging.getLogger(__name__)


class _NoRedirects(urllib_request.HTTPRedirectHandler):
    """Refuse redirects, because urllib would carry the token to the new host.

    Unlike some clients, urllib forwards ``Authorization`` across a cross-host
    redirect: only the content headers are dropped. The console is a fixed,
    configured endpoint, so a redirect is never legitimate here, and following
    one would hand a managed-identity token to whoever answered.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

CONFIG_URI_ENV = "DIGIBUDDY_CONFIG_URI"
CONFIG_DIR_ENV = "DIGIBUDDY_CONFIG_DIR"
CONFIG_API_ENV = "DIGIBUDDY_CONFIG_API"
CONFIG_API_SCOPE_ENV = "DIGIBUDDY_CONFIG_API_SCOPE"
CONFIG_API_SECRET_ENV = "DIGIBUDDY_CONFIG_API_SECRET"
CONFIG_TTL_ENV = "DIGIBUDDY_CONFIG_TTL_SECONDS"

BLOB_ARTIFACT_UPLOAD_ATTEMPTS = 3
BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS = 0.5
#: A cold agent container reaches a console that may itself be scaling from
#: zero, and every read that gives up falls back to the packaged defaults --
#: silently running the session without whatever an administrator configured.
#: Waiting is cheap here because reads are cached for the whole turn.
HTTP_CONFIG_TIMEOUT_SECONDS = 15.0
HTTP_CONFIG_ATTEMPTS = 3
HTTP_CONFIG_BACKOFF_SECONDS = 0.5
HTTP_TOKEN_REFRESH_SKEW_SECONDS = 60.0
RUNTIME_SECRET_HEADER = "X-DigiBuddy-Runtime-Secret"

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
SKILL_POLICY_DOCUMENT = "skill-policy.json"
CREDENTIALS_DOCUMENT = "credentials.json"

DOCUMENTS = (
    MODELS_DOCUMENT,
    MCP_DOCUMENT,
    PROFILES_DOCUMENT,
    CATALOGUE_DOCUMENT,
    SKILLS_DOCUMENT,
    SKILL_POLICY_DOCUMENT,
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
#: A capability name is one path segment. Skills are kebab-case and tools are Python identifiers, so both separators have to be accepted here -- a tool named `release_notes` was silently unstorable, which made the whole tool-pack path dead.
_BUNDLE_PATH = re.compile(r"^bundles/[a-z0-9]+(?:[-_][a-z0-9]+)*/[0-9a-f]{64}\.zip$")
ARTIFACT_PREFIX = "artifacts/"
_ARTIFACT_ID = re.compile(r"^[0-9a-f]{32}$")
_URL = re.compile(r"https?://[^\s'\"<>)]+")
_SENSITIVE_PARAMETER = re.compile(
    r"\b(sig|se|sp|spr|sv|sr|skoid|sktid|skt|ske|sks|skv|credential|"
    r"authorization|access_token|token)=([^&\s'\"]+)",
    re.IGNORECASE,
)
_SENSITIVE_BEARER = re.compile(r"\bBearer\s+[^,\s'\"]+", re.IGNORECASE)


class ConfigStore(Protocol):
    """Read/write access to the runtime configuration documents."""

    def read(self, name: str) -> dict[str, Any] | None: ...

    def read_raw(self, name: str) -> dict[str, Any] | None: ...

    def write(self, name: str, document: dict[str, Any]) -> None: ...

    def read_bundle(self, path: str) -> bytes | None: ...

    def write_artifact(
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
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
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
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
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
    ) -> bool:
        del content_type
        target = self._root / artifact_path(artifact_id, filename, owner)
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
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
    ) -> bool:
        from azure.core.exceptions import AzureError
        from azure.storage.blob import ContentSettings

        path = artifact_path(artifact_id, filename, owner)
        settings = ContentSettings(content_type=content_type)
        attempts = max(int(BLOB_ARTIFACT_UPLOAD_ATTEMPTS), 1)
        backoff = max(float(BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS), 0.0)
        for attempt in range(1, attempts + 1):
            try:
                self._container.upload_blob(
                    path,
                    payload,
                    overwrite=True,
                    content_settings=settings,
                )
                return True
            except AzureError as error:
                logger.warning(
                    "Artifact blob upload failed (attempt %s/%s): %s: %s",
                    attempt,
                    attempts,
                    type(error).__name__,
                    _safe_log_message(error),
                )
                if attempt == attempts:
                    return False
                if backoff:
                    time.sleep(backoff)
                backoff *= 2
        return False


class HttpConfigStore:
    """Overlay documents reached through the console runtime API."""

    def __init__(
        self,
        api_url: str,
        scope: str,
        *,
        secret: str | None = None,
        credential: Any | None = None,
        opener: Any | None = None,
        timeout_seconds: float = HTTP_CONFIG_TIMEOUT_SECONDS,
        sleep: Any | None = None,
    ):
        if urlparse(api_url).scheme != "https":
            raise RuntimeError(f"{CONFIG_API_ENV} must use HTTPS")
        configured_secret = (secret or "").strip()
        if not configured_secret and not scope.strip():
            raise RuntimeError(f"{CONFIG_API_SCOPE_ENV} must be set")
        self._api_url = api_url.rstrip("/")
        self._scope = scope.strip()
        self._secret = configured_secret
        self._credential = credential
        self._opener = opener or urllib_request.build_opener(_NoRedirects)
        self._timeout = max(float(timeout_seconds), 0.1)
        self._sleep = sleep or time.sleep
        self._token = ""
        self._token_expires_on = 0.0

    def read(self, name: str) -> dict[str, Any] | None:
        document = self.read_raw(name)
        if document is None:
            return None
        if not readable_schema(document):
            logger.warning(
                "config overlay document %s declares an unsupported %s; ignoring",
                name,
                SCHEMA_FIELD,
            )
            return None
        return document

    def read_raw(self, name: str) -> dict[str, Any] | None:
        document_name = _safe_document_name(name)
        try:
            payload = self._request("GET", "documents", document_name)
        except urllib_error.HTTPError as error:
            if error.code == 404:
                return None
            logger.warning(
                "Config API read failed for %s: %s: %s",
                document_name,
                type(error).__name__,
                _safe_log_message(error),
            )
            return None
        except Exception as error:  # noqa: BLE001 - config overlays must degrade
            logger.warning(
                "Config API read failed for %s: %s: %s",
                document_name,
                type(error).__name__,
                _safe_log_message(error),
            )
            return None
        try:
            document = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            logger.warning("config overlay document %s is not readable JSON", name)
            return None
        return document if isinstance(document, dict) else None

    def write(self, name: str, document: dict[str, Any]) -> None:
        document_name = _safe_document_name(name)
        payload = json.dumps(document, ensure_ascii=False, sort_keys=True).encode(
            "utf-8"
        )
        self._request(
            "PUT",
            "documents",
            document_name,
            body=payload,
            content_type="application/json; charset=utf-8",
        )

    def read_bundle(self, path: str) -> bytes | None:
        bundle_path = _safe_bundle_path(path)
        _, name, filename = bundle_path.split("/", 2)
        try:
            return self._request("GET", "bundles", name, filename)
        except urllib_error.HTTPError as error:
            if error.code == 404:
                return None
            logger.warning(
                "Config API bundle read failed for %s: %s: %s",
                bundle_path,
                type(error).__name__,
                _safe_log_message(error),
            )
            return None
        except Exception as error:  # noqa: BLE001 - config overlays must degrade
            logger.warning(
                "Config API bundle read failed for %s: %s: %s",
                bundle_path,
                type(error).__name__,
                _safe_log_message(error),
            )
            return None

    def write_artifact(
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
    ) -> bool:
        path = artifact_path(artifact_id, filename, owner)
        parts = path.split("/", 3)
        if len(parts) != 4:
            # The console addresses artifacts by owner, so the flat layout that
            # predates sign-in has nowhere to go here. Say so: otherwise a turn
            # writes a deliverable, the upload refuses, and the only trace is a
            # count of files that failed for no stated reason.
            logger.warning(
                "Config API cannot store an artifact without an owner; "
                "the console addresses artifacts by owner (%s)",
                filename,
            )
            return False
        _, owner_segment, artifact_segment, name_segment = parts
        try:
            self._request(
                "PUT",
                "artifacts",
                owner_segment,
                artifact_segment,
                name_segment,
                body=payload,
                content_type=content_type or "application/octet-stream",
            )
            return True
        except Exception as error:  # noqa: BLE001 - delivery reports failures out of band
            logger.warning(
                "Config API artifact upload failed: %s: %s",
                type(error).__name__,
                _safe_log_message(error),
            )
            return False

    def _resolved_credential(self) -> Any:
        """Build the credential on first use.

        Deferred rather than constructed up front so the store can be created
        anywhere the Azure SDK is absent -- including the test suite -- and so
        a turn never pays for a credential it does not end up needing.
        """
        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        return self._credential

    def _bearer_token(self) -> str:
        if self._secret:
            return self._secret
        now = time.time()
        if (
            self._token
            and now < self._token_expires_on - HTTP_TOKEN_REFRESH_SKEW_SECONDS
        ):
            return self._token
        token = self._resolved_credential().get_token(self._scope)
        self._token = str(token.token)
        self._token_expires_on = float(token.expires_on)
        return self._token

    def _request(
        self,
        method: str,
        *segments: str,
        body: bytes | None = None,
        content_type: str = "",
    ) -> bytes:
        url = "/".join(
            [self._api_url, *(quote(segment, safe="") for segment in segments)]
        )
        headers = {"Accept": "application/octet-stream, application/json"}
        if self._secret:
            # Container Apps Easy Auth consumes Authorization before Next.js
            # sees the request, even when anonymous requests are allowed.
            headers[RUNTIME_SECRET_HEADER] = self._secret
        else:
            headers["Authorization"] = f"Bearer {self._bearer_token()}"
        if body is not None:
            headers["Content-Length"] = str(len(body))
            headers["Content-Type"] = content_type or "application/octet-stream"
        request = urllib_request.Request(
            url,
            data=body,
            headers=headers,
            method=method,
        )
        return self._open(request)

    def _open(self, request: Any) -> bytes:
        """Read the document, retrying a console that is not answering yet.

        A failed read is not an error the caller can act on: it falls back to
        the packaged defaults, so an administrator's configuration silently
        does not apply for the whole session. One slow cold start should not
        cost that.
        """
        for attempt in range(1, HTTP_CONFIG_ATTEMPTS + 1):
            try:
                response = self._opener.open(request, timeout=self._timeout)
            except urllib_error.HTTPError:
                raise
            except OSError:
                if attempt == HTTP_CONFIG_ATTEMPTS:
                    raise
                self._sleep(HTTP_CONFIG_BACKOFF_SECONDS * (2 ** (attempt - 1)))
                continue
            try:
                return response.read()
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    close()
        raise RuntimeError("unreachable")


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
        self,
        artifact_id: str,
        filename: str,
        payload: bytes,
        content_type: str,
        owner: str = "",
    ) -> bool:
        return self._inner.write_artifact(
            artifact_id, filename, payload, content_type, owner
        )


def _safe_document_name(name: str) -> str:
    """Reject traversal and nested paths; documents live in a flat namespace."""
    if name not in DOCUMENTS:
        raise ValueError(f"Unknown configuration document: {name}")
    return name


def _safe_log_message(error: BaseException) -> str:
    """Return an exception message without URL query strings or token values."""

    def strip_url_query(match: re.Match[str]) -> str:
        parsed = urlparse(match.group(0))
        return parsed._replace(query="", fragment="").geturl()

    text = _URL.sub(strip_url_query, str(error))
    text = _SENSITIVE_BEARER.sub("Bearer <redacted>", text)
    return _SENSITIVE_PARAMETER.sub(lambda match: f"{match.group(1)}=<redacted>", text)


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


def artifact_path(artifact_id: str, filename: str, owner: str = "") -> str:
    """Pin artifact access to an unguessable id below the reserved prefix.

    Partitioned by owner when the console tells us who asked, so a signed-in
    account can only address its own files. The owner is an opaque hash, so a
    blob path never carries an identity. An empty owner keeps the flat layout
    that predates sign-in.
    """
    if not _ARTIFACT_ID.fullmatch(artifact_id):
        raise ValueError("Invalid artifact id")
    safe_name = safe_artifact_filename(filename)
    if safe_name != filename:
        raise ValueError("Invalid artifact filename")
    if owner and not _ARTIFACT_ID.fullmatch(owner):
        raise ValueError("Invalid artifact owner")
    prefix = f"{ARTIFACT_PREFIX}{owner}/" if owner else ARTIFACT_PREFIX
    return f"{prefix}{artifact_id}/{safe_name}"


def new_artifact_id() -> str:
    return secrets.token_hex(16)


def build_config_store(
    environment: dict[str, str] | None = None,
) -> ConfigStore:
    """Build the runtime configuration overlay.

    Precedence is local directory first, then the console HTTPS runtime API,
    then the legacy direct Blob container. Keeping ``DIGIBUDDY_CONFIG_DIR`` at
    the top lets local development override deployed settings, while hosted
    agents prefer the console proxy over direct storage because production
    storage is reachable only from the Web UI's virtual network.
    """
    env = environment if environment is not None else dict(os.environ)
    ttl = _ttl_seconds(env.get(CONFIG_TTL_ENV))

    directory = (env.get(CONFIG_DIR_ENV) or "").strip()
    if directory:
        return CachingConfigStore(FileConfigStore(Path(directory).resolve()), ttl)

    api_url = (env.get(CONFIG_API_ENV) or "").strip()
    if api_url:
        try:
            return CachingConfigStore(
                HttpConfigStore(
                    api_url,
                    env.get(CONFIG_API_SCOPE_ENV) or "",
                    secret=env.get(CONFIG_API_SECRET_ENV) or "",
                ),
                ttl,
            )
        except Exception:  # noqa: BLE001 - never block startup on the overlay
            logger.exception("Falling back to packaged config; %s unusable", CONFIG_API_ENV)
            return NullConfigStore()

    container_url = (env.get(CONFIG_URI_ENV) or "").strip()
    if container_url:
        if urlparse(container_url).scheme != "https":
            raise RuntimeError(f"{CONFIG_URI_ENV} must use HTTPS")
        try:
            return CachingConfigStore(BlobConfigStore(container_url), ttl)
        except Exception:  # noqa: BLE001 - never block startup on the overlay
            logger.exception("Falling back to packaged config; %s unusable", CONFIG_URI_ENV)
            return NullConfigStore()

    return NullConfigStore()


def _ttl_seconds(raw: str | None) -> float:
    try:
        return max(float(raw), 0.0) if raw else 30.0
    except ValueError:
        return 30.0
