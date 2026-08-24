"""Credentials bound to one agent profile.

A profile is meant to be a business agent, and the code has said for a while
that filtering capabilities is curation rather than a boundary: the real
question is which credentials the agent is handed. Until now there were none to
hand out. Everything lived in the container environment, so every profile's
Codex process inherited every profile's secrets, and a shell was enough to read
them.

The model here is deliberately small:

* **Slots, not free-form variables.** A profile binds a value to a named
  capability slot; the slot decides which environment variable the child sees.
  A binding therefore cannot invent ``PATH`` or ``PYTHONPATH``.
* **Values live apart from the profile.** ``profiles.json`` is projected to
  every chat user through ``/api/profiles``. Secrets live in their own document
  that no read API returns.
* **Absence means absence.** A profile with no binding for a slot gets nothing,
  rather than falling through to a container-wide default -- inheriting is the
  behaviour this exists to remove.

What this buys, and what it does not: a Codex process is only ever handed its
own profile's values, because switching profile already replaces the process.
It is not a defence against a determined prompt injection, which can still ask
the container's ambient managed identity for a token. That boundary needs
separate deployments.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_SLOT = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
_MAX_VALUE_BYTES = 8 * 1024

#: Every slot a profile may bind, and the variable it becomes in the child.
#:
#: Closed on purpose. An open mapping would let a binding shadow `PATH`,
#: `PYTHONPATH` or the model key, which turns a credential store into a code
#: execution channel.
SLOT_VARIABLES: dict[str, str] = {
    "graph_client_id": "DIGIBUDDY_GRAPH_CLIENT_ID",
    "graph_client_secret": "DIGIBUDDY_GRAPH_CLIENT_SECRET",
    "graph_tenant_id": "DIGIBUDDY_GRAPH_TENANT_ID",
    "blob_service_uri": "DIGIBUDDY_BLOB_SERVICE_URI",
    "blob_container": "DIGIBUDDY_BLOB_CONTAINER",
    "mcp_bearer_token": "DIGIBUDDY_MCP_BEARER_TOKEN",
}


@dataclass(frozen=True)
class Credential:
    profile: str
    slot: str
    value: str

    @property
    def variable(self) -> str:
        return SLOT_VARIABLES[self.slot]


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_credentials(document: Any) -> dict[tuple[str, str], Credential]:
    """Parse ``credentials.json`` into a ``(profile, slot) -> credential`` map.

    A malformed entry is dropped rather than failing the runtime, matching how
    every other document behaves. Dropping is also the safe direction here: the
    result is a missing credential, not a shared one.
    """
    entries = document.get("credentials") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        return {}

    credentials: dict[tuple[str, str], Credential] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        profile = _text(entry.get("profile"))
        slot = _text(entry.get("slot")).lower()
        value = entry.get("value")
        if not profile or not _SLOT.fullmatch(slot) or slot not in SLOT_VARIABLES:
            continue
        if not isinstance(value, str) or not value:
            continue
        if "\0" in value or len(value.encode("utf-8")) > _MAX_VALUE_BYTES:
            logger.warning(
                "Credential %s/%s is not a usable environment value; ignoring",
                profile,
                slot,
            )
            continue
        credentials[(profile, slot)] = Credential(
            profile=profile, slot=slot, value=value
        )
    return credentials


def credentials_for(
    credentials: dict[tuple[str, str], Credential], profile: str
) -> dict[str, str]:
    """The environment this profile's Codex process should receive."""
    return {
        credential.variable: credential.value
        for (owner, _slot), credential in credentials.items()
        if owner == profile
    }


def credential_fingerprint(values: dict[str, str], key: bytes) -> str:
    """Identify the resolved values without recording them.

    Fingerprinting the reference alone would miss a rotation that keeps the same
    slot, so the process would keep running with a revoked secret. Fingerprinting
    the plaintext directly would put a secret-derived digest into a document that
    is compared and logged, so the digest is keyed with a per-process value and
    never leaves this process.
    """
    digest = hashlib.blake2b(key=key, digest_size=32)
    for variable in sorted(values):
        digest.update(variable.encode("utf-8"))
        digest.update(b"\0")
        digest.update(values[variable].encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


__all__ = [
    "SLOT_VARIABLES",
    "Credential",
    "credential_fingerprint",
    "credentials_for",
    "parse_credentials",
]
