from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


@dataclass(frozen=True, slots=True)
class ReleaseConfig:
    release_root: Path = Path(".azure/releases")
    agent_name: str = "digibuddy-codex"
    agent_version: str = "1"
    response_protocol: str = "responses"
    response_protocol_version: str = "2.0.0"
    source_kind: str = "hosted"
    source_status: str = "active"


def make_image_tag(sha: str, now: datetime) -> str:
    short_sha = sha.strip()[:7]
    timestamp = _ensure_utc(now).strftime("%Y%m%dT%H%M%SZ")
    return f"{short_sha}-{timestamp}"


def select_source_version(versions: Sequence[Mapping[str, Any]] | Sequence[Any]) -> Mapping[str, Any]:
    candidates: list[tuple[datetime, Mapping[str, Any]]] = []
    for version in versions:
        record = _as_mapping(version)
        if record is None:
            continue
        if not _is_valid_source_version(record):
            continue
        candidates.append((_version_timestamp(record), record))

    if not candidates:
        raise ValueError("No valid active hosted version with a Responses protocol entry was found.")

    return max(candidates, key=lambda item: item[0])[1]


def extract_output_text(payload: Any) -> str:
    if not payload or not isinstance(payload, Mapping):
        return ""

    response_text = payload.get("output_text")
    if isinstance(response_text, str):
        return response_text

    output = payload.get("output")
    if not isinstance(output, Sequence) or isinstance(output, (str, bytes, bytearray)):
        return ""

    parts: list[str] = []
    for item in output:
        if not isinstance(item, Mapping):
            continue
        content = item.get("content")
        if not isinstance(content, Sequence) or isinstance(content, (str, bytes, bytearray)):
            continue
        for entry in content:
            if isinstance(entry, Mapping):
                text = entry.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(entry, str):
                parts.append(entry)
    return "".join(parts)


def release_receipt(
    *,
    config: ReleaseConfig | None = None,
    image_tag: str,
    image_digest: str,
    version_id: str,
    response_id: str,
    released_at: datetime,
    source_version: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "image_tag": image_tag,
        "image_digest": image_digest,
        "version_id": version_id,
        "response_id": response_id,
        "released_at": _ensure_utc(released_at).isoformat().replace("+00:00", "Z"),
    }
    if source_version is not None:
        source_id = _version_identity(source_version)
        if source_id:
            receipt["source_version_id"] = source_id
    return receipt


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    return None


def _string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _version_timestamp(version: Mapping[str, Any]) -> datetime:
    for key in ("created_at", "createdAt", "updated_at", "updatedAt"):
        raw = version.get(key)
        if isinstance(raw, datetime):
            return _ensure_utc(raw)
        if isinstance(raw, str):
            parsed = _parse_datetime(raw)
            if parsed is not None:
                return parsed
    return datetime.min.replace(tzinfo=timezone.utc)


def _parse_datetime(value: str) -> datetime | None:
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _ensure_utc(parsed)


def _is_valid_source_version(version: Mapping[str, Any]) -> bool:
    if _string_value(version.get("kind")) != "hosted":
        return False
    if _string_value(version.get("status")) != "active":
        return False

    container = _as_mapping(version.get("container_configuration"))
    if not container:
        return False
    if not _string_value(container.get("image")):
        return False

    protocols = version.get("protocols")
    if not isinstance(protocols, Sequence) or isinstance(protocols, (str, bytes, bytearray)):
        return False
    for protocol in protocols:
        if not isinstance(protocol, Mapping):
            continue
        if _string_value(protocol.get("protocol")) == "responses":
            return True
    return False


def _version_identity(version: Mapping[str, Any]) -> str:
    for key in ("id", "version", "name"):
        value = _string_value(version.get(key))
        if value:
            return value
    return ""
