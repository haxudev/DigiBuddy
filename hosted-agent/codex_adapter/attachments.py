from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

_DATA_URL = re.compile(r"^data:([^;,]*)(;[^,]*)?,(.*)$", re.DOTALL)
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class Attachment:
    """A file the user attached to the turn, already decoded."""

    filename: str
    data: bytes


def safe_filename(name: str, fallback: str = "attachment") -> str:
    """Reduce a user supplied name to a leaf that cannot escape the folder."""
    leaf = Path(str(name or "")).name
    cleaned = _UNSAFE.sub("_", leaf).strip("._")
    return cleaned[:120] or fallback


def _decode(value: str) -> bytes | None:
    match = _DATA_URL.match(value.strip())
    payload = match.group(3) if match else value.strip()
    if match and ";base64" not in (match.group(2) or ""):
        return payload.encode("utf-8")
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None


def _part_attachment(part: dict[str, Any], index: int) -> Attachment | None:
    part_type = str(part.get("type") or "")
    if part_type == "input_file":
        source = part.get("file_data") or part.get("file_url")
        default = f"attachment-{index}"
    elif part_type == "input_image":
        source = part.get("image_url") or part.get("file_data")
        default = f"image-{index}.png"
    else:
        return None
    if not isinstance(source, str) or not source.strip():
        return None

    data = _decode(source)
    # A remote URL carries no bytes: the agent can fetch it from the prompt
    # text instead, so it is not turned into a workspace file.
    if data is None or not data or len(data) > MAX_ATTACHMENT_BYTES:
        return None
    return Attachment(safe_filename(part.get("filename") or "", default), data)


def collect_attachments(items: list[Any]) -> list[Attachment]:
    """Pull decoded attachments out of Responses API input items."""
    attachments: list[Attachment] = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            attachment = _part_attachment(part, len(attachments) + 1)
            if attachment:
                attachments.append(attachment)
    return attachments


def store_attachments(
    attachments: list[Attachment], directory: Path
) -> list[Path]:
    """Write attachments into ``directory`` without overwriting each other."""
    if not attachments:
        return []
    directory.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    used: set[str] = set()
    for attachment in attachments:
        name = attachment.filename
        stem, dot, suffix = name.partition(".")
        counter = 1
        while name in used or (directory / name).exists():
            name = f"{stem}-{counter}{dot}{suffix}"
            counter += 1
        used.add(name)
        path = directory / name
        path.write_bytes(attachment.data)
        paths.append(path)
    return paths


def attachment_prompt(prompt: str, paths: list[Path]) -> str:
    """Tell the agent where the uploaded files landed in its workspace."""
    if not paths:
        return prompt
    listing = "\n".join(f"- {path}" for path in paths)
    note = f"The user attached these files to this message:\n{listing}"
    return f"{prompt}\n\n{note}" if prompt else note


__all__ = [
    "MAX_ATTACHMENT_BYTES",
    "Attachment",
    "attachment_prompt",
    "collect_attachments",
    "safe_filename",
    "store_attachments",
]
