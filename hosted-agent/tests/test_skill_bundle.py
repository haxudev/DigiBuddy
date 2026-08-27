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
    "superclarity",
}
# Superclarity folded its six workflow skills back into one; the retired names
# must stay out of the image so a stale copy can never shadow the new entry.
RETIRED_SKILLS = {
    "clarifying-intent",
    "distilling-lessons",
    "drafting-plans",
    "running-plans",
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
        self.assertFalse(installed & RETIRED_SKILLS)
        for name in RETIRED_SKILLS:
            self.assertFalse((SKILLS / name).exists(), name)
        self.assertTrue(
            (SKILLS / "agent-maturity-assess" / "references" / "question-bank.json")
            .is_file()
        )

    def test_superclarity_ships_its_cli_and_every_module_it_imports(self):
        scripts = SKILLS / "superclarity" / "scripts"
        entrypoint = scripts / "superclarity.mjs"

        self.assertTrue(entrypoint.is_file())
        source = entrypoint.read_text(encoding="utf-8")
        # A relative import that did not survive the sync would only surface at
        # runtime inside the sandbox, so resolve the whole graph up front.
        seen = {entrypoint}
        pending = [entrypoint]
        while pending:
            module = pending.pop()
            for target in re.findall(
                r"""^\s*(?:import|export)[^'"]*from\s+['"](\./[^'"]+)['"]""",
                module.read_text(encoding="utf-8"),
                re.MULTILINE,
            ):
                resolved = (module.parent / target).resolve()
                self.assertTrue(resolved.is_file(), f"{module.name} -> {target}")
                if resolved not in seen:
                    seen.add(resolved)
                    pending.append(resolved)

        self.assertGreater(len(seen), 1)
        # Codex runs the CLI with `node`; CRLF or a BOM from the upstream
        # checkout would break the shebang line inside the Linux image.
        self.assertFalse(source.startswith("\ufeff"))
        self.assertNotIn("\r\n", source)

    def test_provenance_records_both_sources(self):
        provenance = (VENDOR / "PROVENANCE.txt").read_text(encoding="utf-8")

        self.assertIn("haxudev/superclarity@", provenance)
        self.assertIn("haxudev/agent-maturity-assessment@", provenance)

    def test_superclarity_is_reached_only_when_a_turn_asks_for_it(self):
        """No standing directive, and a `/` command rather than a hidden skill.

        Superclarity used to be the default route for anything multi-step,
        which meant an ordinary question paid for a task ledger nobody asked
        for. Both halves of that have to hold together: the instructions must
        stop demanding it, and the availability must make it something a user
        can actually choose.
        """
        instructions = " ".join(
            (HOSTED_AGENT / "AGENTS.md").read_text(encoding="utf-8").split()
        )
        availability = json.loads(
            (ROOT / "src" / "skill-availability.json").read_text(encoding="utf-8")
        )

        self.assertNotIn("load the `superclarity` skill first", instructions)
        self.assertIn("/superclarity", instructions)
        self.assertEqual(availability["skills"]["superclarity"], "command")

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

    def test_foundry_iq_is_the_default_knowledge_base(self):
        config = json.loads((ROOT / "src" / "mcp.json").read_text(encoding="utf-8"))
        server = config["servers"]["foundry-iq"]
        environment = server["env"]

        # Entra-protected, so it has to go through the token-minting stdio
        # bridge rather than a bare HTTPS entry with a static bearer token.
        self.assertEqual(server["args"], ["-m", "mcp_http_proxy"])
        self.assertNotIn("enabled", server)
        self.assertTrue(
            environment["MCP_HTTP_PROXY_URL"].startswith("https://"),
            environment["MCP_HTTP_PROXY_URL"],
        )
        self.assertIn("/knowledgebases/", environment["MCP_HTTP_PROXY_URL"])
        self.assertIn("/mcp?", environment["MCP_HTTP_PROXY_URL"])
        self.assertEqual(
            environment["MCP_HTTP_PROXY_SCOPE"], "https://search.azure.com/.default"
        )

    def test_microsoft_learn_uses_the_transport_that_works(self):
        """Codex's remote client registered none of Learn's tools in Foundry."""
        config = json.loads((ROOT / "src" / "mcp.json").read_text(encoding="utf-8"))
        server = config["servers"]["microsoft-learn"]

        self.assertEqual(server["args"], ["-m", "mcp_http_proxy"])
        self.assertEqual(
            server["env"]["MCP_HTTP_PROXY_URL"],
            "https://learn.microsoft.com/api/mcp",
        )
        # Learn's endpoint is public; a scope would mint a token nobody wants.
        self.assertNotIn("MCP_HTTP_PROXY_SCOPE", server["env"])

    def test_every_profile_can_reach_the_default_knowledge_base(self):
        profiles = json.loads(
            (ROOT / "src" / "profiles.json").read_text(encoding="utf-8")
        )["profiles"]

        for profile in profiles:
            allowed = profile.get("mcp_servers")
            # `None` means unrestricted, which already includes foundry-iq.
            if allowed is None:
                continue
            self.assertIn("foundry-iq", allowed, profile["name"])

    def test_persona_routes_internal_questions_to_the_knowledge_base(self):
        persona = " ".join((ROOT / "src" / "AGENTS.md").read_text(encoding="utf-8").split())

        self.assertIn("knowledge_base_retrieve", persona)
        self.assertIn("This is the default knowledge base", persona)


if __name__ == "__main__":
    unittest.main()
