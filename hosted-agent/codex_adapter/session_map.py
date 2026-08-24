from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ThreadBinding:
    thread_id: str
    profile: str = ""
    #: Which conversation directory this thread owns. Empty in maps written
    #: before workspaces were separated; those conversations keep the shared
    #: root so a resumed session still finds its own files.
    workspace_id: str = ""


class ResponseThreadMap:
    def __init__(self, path: Path):
        self._path = path

    def lookup(self, response_id: str | None) -> ThreadBinding | None:
        if not response_id:
            return None
        return self._read().get(response_id)

    def bind(
        self,
        response_id: str,
        thread_id: str,
        profile: str = "",
        workspace_id: str = "",
    ) -> None:
        mappings = self._read()
        mappings[response_id] = ThreadBinding(
            thread_id=thread_id, profile=profile, workspace_id=workspace_id
        )
        serialised = {
            key: {
                "thread": value.thread_id,
                "profile": value.profile,
                "workspace": value.workspace_id,
            }
            for key, value in mappings.items()
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(
            dir=self._path.parent, prefix=".response-threads-", suffix=".json"
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(serialised, stream, separators=(",", ":"), sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self._path)
        finally:
            if os.path.exists(temporary_path):
                os.unlink(temporary_path)

    def _read(self) -> dict[str, ThreadBinding]:
        if not self._path.exists():
            return {}
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Could not read response thread map %s: %s", self._path, exc)
            return {}
        if not isinstance(value, dict):
            logger.warning("Ignoring invalid response thread map %s", self._path)
            return {}

        bindings: dict[str, ThreadBinding] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                continue
            # Maps written before profiles existed stored a bare thread id.
            if isinstance(item, str):
                bindings[key] = ThreadBinding(thread_id=item)
            elif isinstance(item, dict) and isinstance(item.get("thread"), str):
                profile = item.get("profile")
                workspace = item.get("workspace")
                bindings[key] = ThreadBinding(
                    thread_id=item["thread"],
                    profile=profile if isinstance(profile, str) else "",
                    workspace_id=workspace if isinstance(workspace, str) else "",
                )
        return bindings
