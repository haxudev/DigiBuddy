from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


class ResponseThreadMap:
    def __init__(self, path: Path):
        self._path = path

    def lookup(self, response_id: str | None) -> str | None:
        if not response_id:
            return None
        return self._read().get(response_id)

    def bind(self, response_id: str, thread_id: str) -> None:
        mappings = self._read()
        mappings[response_id] = thread_id
        self._path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(
            dir=self._path.parent, prefix=".response-threads-", suffix=".json"
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(mappings, stream, separators=(",", ":"), sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self._path)
        finally:
            if os.path.exists(temporary_path):
                os.unlink(temporary_path)

    def _read(self) -> dict[str, str]:
        if not self._path.exists():
            return {}
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(value, dict):
            return {}
        return {
            key: item
            for key, item in value.items()
            if isinstance(key, str) and isinstance(item, str)
        }
