import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from codex_adapter.skills import (
    DeployedSkill,
    extract_bundle,
    install_deployed_skills,
    parse_registry,
    registry_fingerprint,
)


def bundle(entries: dict[str, str], *, root: str = "demo") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in entries.items():
            archive.writestr(f"{root}/{name}" if root else name, body)
    return buffer.getvalue()


def entry(payload: bytes, name: str = "demo", enabled: bool = True) -> DeployedSkill:
    digest = hashlib.sha256(payload).hexdigest()
    return DeployedSkill(
        name=name,
        version="1",
        description="",
        bundle=f"bundles/{name}/{digest}.zip",
        sha256=digest,
        enabled=enabled,
    )


class FakeStore:
    def __init__(self, document, bundles):
        self._document = document
        self._bundles = bundles

    def read(self, name):
        return self._document

    def write(self, name, document):
        self._document = document

    def read_bundle(self, path):
        return self._bundles.get(path)


class RegistryTests(unittest.TestCase):
    def test_entry_is_rejected_when_the_bundle_path_is_not_content_addressed(self):
        payload = bundle({"SKILL.md": "# demo"})
        good = entry(payload)
        document = {
            "skills": [
                {**good.__dict__, "bundle": "bundles/demo/../../secrets.zip"},
            ]
        }
        self.assertEqual(parse_registry(document), ())

    def test_malformed_entries_do_not_discard_the_good_ones(self):
        good = entry(bundle({"SKILL.md": "# demo"}))
        document = {"skills": ["nonsense", {"name": "NoUpper"}, good.__dict__]}
        self.assertEqual([skill.name for skill in parse_registry(document)], ["demo"])

    def test_fingerprint_changes_when_a_skill_is_disabled(self):
        skill = entry(bundle({"SKILL.md": "# demo"}))
        self.assertNotEqual(
            registry_fingerprint((skill,)),
            registry_fingerprint((DeployedSkill(**{**skill.__dict__, "enabled": False}),)),
        )


class ExtractionTests(unittest.TestCase):
    def test_digest_mismatch_is_refused(self):
        payload = bundle({"SKILL.md": "# demo"})
        skill = entry(payload)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                extract_bundle(b"tampered" + payload, skill, Path(directory))

    def test_traversal_entries_are_refused(self):
        payload = bundle({"SKILL.md": "# demo", "../../escape.sh": "boom"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                extract_bundle(payload, entry(payload), Path(directory))

    def test_bundle_without_skill_manifest_is_refused(self):
        payload = bundle({"README.md": "nothing here"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                extract_bundle(payload, entry(payload), Path(directory))

    def test_a_flat_bundle_installs_under_the_registered_name(self):
        payload = bundle({"SKILL.md": "# demo", "scripts/run.py": "print(1)"}, root="")
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            extract_bundle(payload, entry(payload), destination)
            self.assertTrue((destination / "demo" / "SKILL.md").is_file())
            self.assertTrue((destination / "demo" / "scripts" / "run.py").is_file())

    def test_a_failed_install_leaves_no_partial_skill(self):
        payload = bundle({"SKILL.md": "# demo", "..\\escape": "boom"})
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            with self.assertRaises(ValueError):
                extract_bundle(payload, entry(payload), destination)
            self.assertEqual(list(destination.iterdir()), [])

    def test_an_executable_script_stays_executable(self):
        # A skill's helper script that loses its execute bit fails when the agent
        # runs it, long after the install that caused it.
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("demo/SKILL.md", "# demo")
            script = zipfile.ZipInfo("demo/scripts/run.sh")
            script.create_system = 3
            script.external_attr = 0o100755 << 16
            archive.writestr(script, "#!/bin/sh\n")
            notes = zipfile.ZipInfo("demo/references/notes.md")
            notes.create_system = 3
            # A crafted archive must not be able to publish a world-writable file.
            notes.external_attr = 0o102666 << 16
            archive.writestr(notes, "notes")
        payload = buffer.getvalue()

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            extract_bundle(payload, entry(payload), destination)
            skill = destination / "demo"
            self.assertEqual((skill / "scripts" / "run.sh").stat().st_mode & 0o777, 0o755)
            self.assertEqual(
                (skill / "references" / "notes.md").stat().st_mode & 0o777, 0o644
            )


class InstallTests(unittest.TestCase):
    def test_packaged_skills_are_not_shadowed_by_uploads(self):
        payload = bundle({"SKILL.md": "# replaced"})
        skill = entry(payload)
        store = FakeStore(None, {skill.bundle: payload})
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            installed = install_deployed_skills(
                store, (skill,), destination, reserved=frozenset({"demo"})
            )
            self.assertEqual(installed, 0)
            self.assertEqual(list(destination.iterdir()), [])

    def test_a_broken_bundle_does_not_stop_the_healthy_ones(self):
        healthy = bundle({"SKILL.md": "# fine"}, root="fine")
        good = entry(healthy, name="fine")
        broken = entry(bundle({"SKILL.md": "# broken"}, root="broken"), name="broken")
        store = FakeStore(None, {good.bundle: healthy})
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            self.assertEqual(
                install_deployed_skills(store, (broken, good), destination), 1
            )
            self.assertTrue((destination / "fine" / "SKILL.md").is_file())

    def test_a_profile_only_receives_the_skills_it_assembles(self):
        payload = bundle({"SKILL.md": "# demo"})
        skill = entry(payload)
        store = FakeStore(None, {skill.bundle: payload})
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            installed = install_deployed_skills(
                store, (skill,), destination, allows=lambda name: name != "demo"
            )
            self.assertEqual(installed, 0)


if __name__ == "__main__":
    unittest.main()
