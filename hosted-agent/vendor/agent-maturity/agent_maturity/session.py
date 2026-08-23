"""Durable engagement state.

A 30-60 question customer interview without atomic persistence is not
supported, so every answer is written through a temporary sibling and an
atomic replace. `progress.cursor` is the resume point; nothing else is.
"""

from __future__ import annotations

import datetime
import json
import os
import tempfile

ANSWERS_SCHEMA = "agent-maturity-answers/2"
ANSWERS_SCHEMAS = {"agent-maturity-answers/1", ANSWERS_SCHEMA}
ANSWERS_FILENAME = "answers.json"


class SessionError(Exception):
    pass


def now_iso() -> str:
    return datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()


def read_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json_atomic(path: str, payload) -> str:
    """Durably replace `path` with `payload`, creating parent directories."""
    return _atomic(path, lambda fh: _dump_json(fh, payload))


def write_text_atomic(path: str, text: str) -> str:
    """Durably replace `path` with `text`, creating parent directories."""
    return _atomic(path, lambda fh: fh.write(text))


def _dump_json(fh, payload):
    json.dump(payload, fh, ensure_ascii=False, indent=2)
    fh.write("\n")


def _atomic(path: str, write) -> str:
    path = os.path.abspath(path)
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    handle, temporary = tempfile.mkstemp(
        dir=parent, prefix=".{0}.".format(os.path.basename(path)), suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as fh:
            write(fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return path


def answers_path(session_dir: str) -> str:
    """Where the answers for this engagement live.

    Delegates to `resolve_answers` so that the path a caller *checks* is always
    the path a writer *uses*; when those two disagreed, passing an answers file
    as `session_dir` silently overwrote a live engagement with a blank one.
    """
    return resolve_answers(session_dir)


def resolve_answers(path_or_dir: str) -> str:
    """Accept either a session directory or a direct path to an answers file.

    The directory usually does not exist yet on the first call, so existence
    cannot be the whole test - guessing "file" there would write the answers
    into a file named after the intended directory.
    """
    absolute = os.path.abspath(path_or_dir)
    if os.path.isdir(absolute):
        return os.path.join(absolute, ANSWERS_FILENAME)
    if os.path.isfile(absolute) or absolute.lower().endswith(".json"):
        return absolute
    return os.path.join(absolute, ANSWERS_FILENAME)


def new_answers_doc(engagement: dict) -> dict:
    return {
        "schema": ANSWERS_SCHEMA,
        "engagement": dict(engagement),
        "progress": {"status": "in_progress", "cursor": None, "updated_at": now_iso()},
        "answers": {},
    }


def load_answers(path_or_dir: str) -> dict:
    path = resolve_answers(path_or_dir)
    if not os.path.isfile(path):
        raise SessionError(
            "no answers file at {0}; call maturity_start_session first".format(path)
        )
    doc = read_json(path)
    schema = doc.get("schema")
    if schema not in ANSWERS_SCHEMAS:
        raise SessionError(
            "unsupported answers schema {0!r}; expected one of {1}".format(
                schema, sorted(ANSWERS_SCHEMAS)
            )
        )
    doc.setdefault("answers", {})
    doc.setdefault("progress", {"status": "in_progress", "cursor": None})
    return doc


def save_answers(path_or_dir: str, doc: dict, cursor=None, status=None) -> str:
    progress = doc.setdefault("progress", {})
    if status is not None:
        progress["status"] = status
    progress["cursor"] = cursor
    progress["updated_at"] = now_iso()
    return write_json_atomic(resolve_answers(path_or_dir), doc)
