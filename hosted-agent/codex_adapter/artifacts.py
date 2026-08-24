from __future__ import annotations

import json
import logging
import mimetypes
import os
from dataclasses import asdict, dataclass
from pathlib import Path

from .config_store import ConfigStore, new_artifact_id, safe_artifact_filename

logger = logging.getLogger(__name__)

ARTIFACT_EVENT = "assistant.artifacts"
MAX_ARTIFACTS = 20
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_ARTIFACT_TOTAL_BYTES = 100 * 1024 * 1024

_DELIVERABLE_EXTENSIONS = {
    ".csv",
    ".docx",
    ".gif",
    ".htm",
    ".html",
    ".jpeg",
    ".jpg",
    ".json",
    ".md",
    ".markdown",
    ".pdf",
    ".png",
    ".pptx",
    ".svg",
    ".txt",
    ".webp",
    ".xlsx",
    ".zip",
}
_IGNORED_DIRECTORIES = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".venv",
    ".work",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "uploads",
    "venv",
}

WorkspaceSnapshot = dict[str, tuple[int, int]]


@dataclass(frozen=True)
class PublishedArtifact:
    id: str
    name: str
    mimeType: str
    size: int


def _workspace_files(workspace: Path):
    root = workspace.resolve()
    if not root.is_dir():
        return
    for directory, names, filenames in os.walk(root, followlinks=False):
        current = Path(directory)
        names[:] = [
            name
            for name in names
            if name not in _IGNORED_DIRECTORIES
            and not (current / name).is_symlink()
        ]
        for filename in filenames:
            path = current / filename
            if path.suffix.lower() not in _DELIVERABLE_EXTENSIONS:
                continue
            try:
                if path.is_symlink():
                    continue
                resolved = path.resolve(strict=True)
                resolved.relative_to(root)
                stat = resolved.stat()
            except (OSError, ValueError):
                continue
            if not resolved.is_file():
                continue
            yield resolved, resolved.relative_to(root).as_posix(), stat


def snapshot_workspace(workspace: Path) -> WorkspaceSnapshot:
    """Capture supported files before a serialized turn starts."""
    return {
        relative: (stat.st_mtime_ns, stat.st_size)
        for _, relative, stat in _workspace_files(workspace)
    }


def changed_artifacts(
    workspace: Path, before: WorkspaceSnapshot
) -> list[Path]:
    """Return bounded new or modified deliverables after a turn."""
    changed: list[tuple[Path, str, os.stat_result]] = []
    for path, relative, stat in _workspace_files(workspace):
        if before.get(relative) != (stat.st_mtime_ns, stat.st_size):
            changed.append((path, relative, stat))

    # Prefer the most recently written files when a noisy tool exceeds the cap.
    changed.sort(key=lambda item: (-item[2].st_mtime_ns, item[1]))
    selected: list[Path] = []
    total = 0
    for path, _, stat in changed:
        if stat.st_size <= 0 or stat.st_size > MAX_ARTIFACT_BYTES:
            continue
        if total + stat.st_size > MAX_ARTIFACT_TOTAL_BYTES:
            continue
        selected.append(path)
        total += stat.st_size
        if len(selected) == MAX_ARTIFACTS:
            break
    return selected


def publish_artifacts(
    paths: list[Path], store: ConfigStore
) -> tuple[list[PublishedArtifact], int]:
    """Persist validated files and return only successfully stored metadata."""
    published: list[PublishedArtifact] = []
    failures = 0
    for path in paths:
        try:
            name = safe_artifact_filename(path.name)
            payload = path.read_bytes()
            artifact_id = new_artifact_id()
            content_type = (
                mimetypes.guess_type(name)[0] or "application/octet-stream"
            )
            if not store.write_artifact(
                artifact_id, name, payload, content_type
            ):
                failures += 1
                continue
            published.append(
                PublishedArtifact(
                    id=artifact_id,
                    name=name,
                    mimeType=content_type,
                    size=len(payload),
                )
            )
        except Exception:  # noqa: BLE001 - one bad file must not fail the turn
            failures += 1
            logger.warning("Could not publish artifact %s", path, exc_info=True)
    return published, failures


def artifact_manifest(artifacts: list[dict[str, object]]) -> str:
    """Encode transport metadata in an invisible, backwards-compatible comment."""
    payload = json.dumps(
        {"version": 1, "artifacts": artifacts},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"\n\n<!-- digibuddy-artifacts:{payload} -->"


def artifact_event_data(
    paths: list[Path], store: ConfigStore
) -> dict[str, object]:
    published, failures = publish_artifacts(paths, store)
    return {
        "artifacts": [asdict(artifact) for artifact in published],
        "failed": failures,
    }


__all__ = [
    "ARTIFACT_EVENT",
    "PublishedArtifact",
    "artifact_event_data",
    "artifact_manifest",
    "changed_artifacts",
    "publish_artifacts",
    "snapshot_workspace",
]
