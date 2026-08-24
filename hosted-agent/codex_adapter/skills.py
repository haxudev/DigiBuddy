"""Centrally deployed skills.

Skills come from two places. The image bakes in an immutable set (``skills/``),
and administrators deploy further ones at runtime through the admin console.
A deployed skill is a zip bundle in the shared config store, addressed by its
content hash and described by the ``skills.json`` registry.

This module owns the runtime half of that plane: parsing the registry, fetching
a bundle, and extracting it. The bundle is attacker-controlled input as far as
the runtime is concerned -- the console validates uploads, but the store is the
trust boundary that matters -- so extraction verifies the digest first and then
refuses anything that is not a plain file under the skill's own directory.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

#: Ceilings on what a single bundle may expand to, so one upload cannot fill the
#: session sandbox' disk. Mirrored by the console's upload validation.
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
MAX_ENTRIES = 2000


@dataclass(frozen=True)
class DeployedSkill:
    name: str
    version: str
    description: str
    bundle: str
    sha256: str
    enabled: bool = True

    def fingerprint(self) -> str:
        return f"{self.name}@{self.version}:{self.sha256}:{int(self.enabled)}"


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_registry(document: Any) -> tuple[DeployedSkill, ...]:
    """Parse ``skills.json``.

    Malformed entries are skipped rather than failing the runtime, so one bad
    edit cannot take every deployed skill offline.
    """
    entries = document.get("skills") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        return ()

    skills: dict[str, DeployedSkill] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name"))
        digest = _text(entry.get("sha256")).lower()
        bundle = _text(entry.get("bundle"))
        if not SKILL_NAME.fullmatch(name) or not _SHA256.fullmatch(digest):
            continue
        if bundle != f"bundles/{name}/{digest}.zip":
            continue
        skills[name] = DeployedSkill(
            name=name,
            version=_text(entry.get("version")) or "0",
            description=_text(entry.get("description")),
            bundle=bundle,
            sha256=digest,
            enabled=entry.get("enabled") is not False,
        )
    return tuple(skills[name] for name in sorted(skills))


def registry_fingerprint(skills: tuple[DeployedSkill, ...]) -> str:
    """Identity of the deployed skill set, so a change replaces the process."""
    return hashlib.sha256(
        "\0".join(skill.fingerprint() for skill in skills).encode("utf-8")
    ).hexdigest()


def _safe_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """Members that may be written, with the leading skill directory stripped.

    Rejects the archive outright on anything that could escape the destination
    or exhaust the disk; a partially installed skill is worse than none.
    """
    members = archive.infolist()
    if len(members) > MAX_ENTRIES:
        raise ValueError(f"bundle has more than {MAX_ENTRIES} entries")

    total = 0
    safe: list[zipfile.ZipInfo] = []
    for member in members:
        name = member.filename
        if name.endswith("/"):
            continue
        if member.create_system == 3 and (member.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError(f"bundle contains a symlink: {name}")
        if name.startswith("/") or "\\" in name:
            raise ValueError(f"bundle contains an unsafe path: {name}")
        parts = name.split("/")
        if any(part in ("", "..", ".") for part in parts):
            raise ValueError(f"bundle contains an unsafe path: {name}")
        total += member.file_size
        if total > MAX_EXTRACTED_BYTES:
            raise ValueError("bundle expands beyond the size limit")
        safe.append(member)

    if not safe:
        raise ValueError("bundle is empty")
    return safe


def _strip_prefix(members: list[zipfile.ZipInfo], name: str) -> str:
    """Bundles may be rooted at ``<name>/`` or at the skill files themselves."""
    if all(Path(member.filename).parts[0] == name for member in members):
        return f"{name}/"
    return ""


def _file_mode(member: zipfile.ZipInfo) -> int:
    """Permissions to give an extracted file.

    Skills ship helper scripts, and a script that loses its executable bit fails
    at the moment the agent runs it rather than at install time. So the owner's
    execute bit is carried across -- and nothing else is: the rest of the mode is
    normalised, because the archive is untrusted and must not be able to publish
    a setuid or world-writable file.
    """
    if member.create_system == 3 and (member.external_attr >> 16) & 0o100:
        return 0o755
    return 0o644


def extract_bundle(payload: bytes, skill: DeployedSkill, destination: Path) -> None:
    """Verify and unpack ``payload`` into ``destination/<skill name>``.

    Raises ``ValueError`` when the bundle does not match the registry or is not
    a well-formed, self-contained skill.
    """
    if len(payload) > MAX_BUNDLE_BYTES:
        raise ValueError("bundle is larger than the size limit")
    digest = hashlib.sha256(payload).hexdigest()
    if digest != skill.sha256:
        raise ValueError(
            f"bundle digest {digest} does not match the registry entry {skill.sha256}"
        )

    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise ValueError("bundle is not a readable zip archive") from exc

    with archive:
        members = _safe_members(archive)
        prefix = _strip_prefix(members, skill.name)
        relative = {
            member.filename[len(prefix) :]: member
            for member in members
            if member.filename.startswith(prefix)
        }
        if "SKILL.md" not in relative:
            raise ValueError(f"bundle for {skill.name} has no SKILL.md")

        target = destination / skill.name
        if target.exists():
            shutil.rmtree(target)
        # Stage first so a failure mid-extraction never publishes half a skill.
        staging = destination / f".{skill.name}.staging"
        if staging.exists():
            shutil.rmtree(staging)
        try:
            for name, member in relative.items():
                path = staging / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, path.open("wb") as sink:
                    shutil.copyfileobj(source, sink, length=64 * 1024)
                path.chmod(_file_mode(member))
            staging.rename(target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def install_deployed_skills(
    store: Any,
    skills: tuple[DeployedSkill, ...],
    destination: Path,
    *,
    allows: Any = None,
    reserved: frozenset[str] = frozenset(),
) -> int:
    """Materialise every enabled registry skill the profile is allowed to see.

    Returns the number installed. One unusable bundle is logged and skipped so a
    single bad upload cannot take the agent offline.
    """
    installed = 0
    for skill in skills:
        if not skill.enabled or (allows is not None and not allows(skill.name)):
            continue
        if skill.name in reserved:
            # A packaged skill of the same name is authoritative: the image is
            # reviewed, the upload is not.
            logger.warning(
                "Deployed skill %s shadows a packaged skill; keeping the packaged one",
                skill.name,
            )
            continue
        try:
            payload = store.read_bundle(skill.bundle)
            if payload is None:
                raise ValueError("bundle is missing from the store")
            extract_bundle(payload, skill, destination)
        except Exception:  # noqa: BLE001 - skip the skill, keep the agent up
            logger.warning("Could not install deployed skill %s", skill.name, exc_info=True)
            continue
        installed += 1

    if installed:
        logger.info("Installed %d deployed skills into %s", installed, destination)
    return installed


def load_registry(store: Any) -> tuple[DeployedSkill, ...]:
    from .config_store import SKILLS_DOCUMENT

    try:
        return parse_registry(store.read(SKILLS_DOCUMENT) if store else None)
    except Exception:  # noqa: BLE001
        logger.warning("Could not read the skill registry", exc_info=True)
        return ()


__all__ = [
    "MAX_BUNDLE_BYTES",
    "MAX_ENTRIES",
    "MAX_EXTRACTED_BYTES",
    "DeployedSkill",
    "extract_bundle",
    "install_deployed_skills",
    "load_registry",
    "parse_registry",
    "registry_fingerprint",
]
