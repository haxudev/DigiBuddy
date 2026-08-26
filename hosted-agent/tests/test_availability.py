import json
import tempfile
import unittest
from pathlib import Path

from codex_adapter.availability import (
    BUILTIN,
    COMMAND,
    DEFAULT_AVAILABILITY,
    HIDDEN,
    OFF,
    availability_fingerprint,
    availability_of,
    is_off,
    load_availability,
    parse_availability,
)

REPOSITORY = Path(__file__).resolve().parents[2]


class ParseAvailabilityTest(unittest.TestCase):
    def test_reads_the_skills_map(self):
        parsed = parse_availability(
            {"skills": {"pptx": "builtin", "acr-analysis": "command"}}
        )
        self.assertEqual(parsed, {"pptx": BUILTIN, "acr-analysis": COMMAND})

    def test_normalises_case_and_whitespace(self):
        parsed = parse_availability({"skills": {" PPTX ": " BuiltIn "}})
        self.assertEqual(parsed, {"pptx": BUILTIN})

    def test_an_unknown_value_falls_back_to_the_default(self):
        # Dropping the entry can only ever restore a skill, never hide one, so
        # a typo degrades to the old behaviour instead of removing a capability.
        parsed = parse_availability({"skills": {"pptx": "invisible"}})
        self.assertEqual(parsed, {})
        self.assertEqual(availability_of(parsed, "pptx"), DEFAULT_AVAILABILITY)

    def test_a_malformed_document_says_nothing(self):
        for document in (None, [], {}, {"skills": []}, {"skills": {1: "builtin"}}):
            self.assertEqual(parse_availability(document), {})

    def test_an_unnamed_skill_is_the_default(self):
        self.assertEqual(availability_of({}, "whatever"), COMMAND)
        self.assertFalse(is_off({}, "whatever"))


class LoadAvailabilityTest(unittest.TestCase):
    def test_reads_the_payload_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skill-availability.json").write_text(
                json.dumps({"skills": {"pptx": "builtin", "mcp-builder": "off"}}),
                encoding="utf-8",
            )
            loaded = load_availability(root)
        self.assertEqual(loaded, {"pptx": BUILTIN, "mcp-builder": OFF})
        self.assertTrue(is_off(loaded, "mcp-builder"))

    def test_a_missing_document_leaves_every_skill_at_the_default(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(load_availability(Path(directory)), {})

    def test_unreadable_json_does_not_take_the_catalogue_down(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skill-availability.json").write_text("{not json", encoding="utf-8")
            self.assertEqual(load_availability(root), {})


class FingerprintTest(unittest.TestCase):
    def test_the_same_map_fingerprints_the_same(self):
        left = availability_fingerprint({"a": BUILTIN, "b": HIDDEN})
        right = availability_fingerprint({"b": HIDDEN, "a": BUILTIN})
        self.assertEqual(left, right)

    def test_moving_a_skill_to_hidden_changes_the_fingerprint(self):
        # Hiding a skill leaves the rendered instructions identical, so without
        # this the console would keep offering a command the runtime no longer
        # means to publish.
        before = availability_fingerprint({"a": COMMAND})
        after = availability_fingerprint({"a": HIDDEN})
        self.assertNotEqual(before, after)


class RepositoryDeclarationTest(unittest.TestCase):
    """The declaration and `.dockerignore` are two files that must agree.

    An `off` skill whose bytes still ship is deployed after all, and the runtime
    filter would be the only thing standing between it and the agent. Both
    surfaces are silent at runtime, so the disagreement is caught here.
    """

    def setUp(self):
        self.declared = json.loads(
            (REPOSITORY / "src" / "skill-availability.json").read_text(encoding="utf-8")
        )["skills"]
        self.ignored = {
            line.strip().rstrip("/")
            for line in (REPOSITORY / ".dockerignore")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip() and not line.strip().startswith("#")
        }

    def test_every_declared_value_is_one_the_runtime_understands(self):
        for name, value in self.declared.items():
            self.assertIn(value, {BUILTIN, COMMAND, HIDDEN, OFF}, name)

    def test_every_off_skill_is_excluded_from_the_image(self):
        for name, value in sorted(self.declared.items()):
            if value != OFF:
                continue
            self.assertIn(f"src/skills/{name}", self.ignored, name)

    def test_nothing_still_deployed_is_excluded_from_the_image(self):
        for line in sorted(self.ignored):
            if not line.startswith("src/skills/"):
                continue
            name = line[len("src/skills/") :]
            self.assertEqual(self.declared.get(name), OFF, name)

    def test_every_declared_skill_exists(self):
        present = {
            path.parent.name
            for root in ("src/skills", "hosted-agent/skills")
            for path in (REPOSITORY / root).glob("*/SKILL.md")
        }
        for name in sorted(self.declared):
            self.assertIn(name, present, name)


if __name__ == "__main__":
    unittest.main()
