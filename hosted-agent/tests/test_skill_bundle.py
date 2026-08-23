import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HOSTED_AGENT = ROOT / "hosted-agent"
SKILLS = HOSTED_AGENT / "skills"
VENDOR = HOSTED_AGENT / "vendor"
EXPECTED_SKILLS = {
    "agent-maturity-assess",
    "agent-maturity-author",
    "agent-maturity-deploy",
    "agent-maturity-report",
    "clarifying-intent",
    "distilling-lessons",
    "drafting-plans",
    "running-plans",
    "superclarity",
    "surveying-capabilities",
    "verifying-outcomes",
}


class SkillBundleTests(unittest.TestCase):
    def test_sources_are_locked_to_commits(self):
        rows = {}
        for line in (HOSTED_AGENT / "skill-sources.lock").read_text(
            encoding="utf-8"
        ).splitlines():
            if not line or line.startswith("#"):
                continue
            name, repository, commit = line.split()
            rows[name] = (repository, commit)

        self.assertEqual(set(rows), {"superclarity", "agent-maturity"})
        self.assertEqual(rows["superclarity"][0], "haxudev/superclarity")
        self.assertEqual(
            rows["agent-maturity"][0], "haxudev/agent-maturity-assessment"
        )
        for _, commit in rows.values():
            self.assertRegex(commit, re.compile(r"^[0-9a-f]{40}$"))

    def test_all_skills_and_support_assets_are_bundled(self):
        installed = {
            path.name for path in SKILLS.iterdir() if (path / "SKILL.md").is_file()
        }

        self.assertEqual(installed, EXPECTED_SKILLS)
        self.assertTrue(
            (
                SKILLS
                / "distilling-lessons"
                / "scripts"
                / "profile-transaction-cli.mjs"
            ).is_file()
        )
        self.assertTrue(
            (
                SKILLS
                / "agent-maturity-assess"
                / "references"
                / "question-bank.json"
            ).is_file()
        )

    def test_provenance_records_both_sources(self):
        provenance = (VENDOR / "PROVENANCE.txt").read_text(encoding="utf-8")

        self.assertIn("haxudev/superclarity@", provenance)
        self.assertIn("haxudev/agent-maturity-assessment@", provenance)

    def test_superclarity_is_the_default_workflow_entry(self):
        instructions = (HOSTED_AGENT / "AGENTS.md").read_text(encoding="utf-8")

        self.assertIn(
            "load the `superclarity` skill first",
            " ".join(instructions.split()),
        )

    def test_agent_maturity_package_is_self_contained(self):
        package_root = VENDOR / "agent-maturity"
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(package_root)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        completed = subprocess.run(
            [
                sys.executable,
                "-B",
                "-I",
                "-c",
                (
                    "import sys; "
                    f"sys.path.insert(0, {str(package_root)!r}); "
                    "import agent_maturity.mcp"
                ),
            ],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_agent_maturity_mcp_can_locate_its_bundled_references(self):
        config = json.loads((ROOT / "src" / "mcp.json").read_text(encoding="utf-8"))
        environment = config["servers"]["agent-maturity"]["env"]

        self.assertEqual(
            environment["AGENT_MATURITY_REFERENCES"],
            "/app/hosted-agent/skills/agent-maturity-assess/references",
        )


if __name__ == "__main__":
    unittest.main()
