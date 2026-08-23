import json
import tempfile
import unittest
from pathlib import Path

from codex_adapter.config import (
    RuntimeSettings,
    apply_model_overrides,
    build_catalogue,
    load_instructions,
    load_mcp_servers,
    load_profiles,
    prepare_codex_environment,
    render_codex_config,
    validate_settings,
)
from codex_adapter.config_store import FileConfigStore
from codex_adapter.profiles import AgentProfile


def settings(**overrides):
    values = {
        "model_name": "gpt-5.2-codex",
        "model_endpoint": "https://example.openai.azure.com/openai/v1",
        "model_api_key": "not-a-real-key",
        "model_provider": "digibuddy",
        "approval_policy": "never",
        "sandbox": "workspace-write",
        "workspace": Path("/workspace"),
        "codex_home": Path("/tmp/codex"),
        "instructions_path": Path("/tmp/AGENTS.md"),
        "payload_root": Path("/opt/digibuddy"),
    }
    values.update(overrides)
    return RuntimeSettings(**values)


def payload(directory, *, skills=(), tools=(), servers=None, profiles=None):
    """Build a miniature agent payload on disk and point settings at it."""
    base = Path(directory)
    root = base / "payload"
    (root / "skills").mkdir(parents=True)
    (root / "tools").mkdir(parents=True)
    (root / "AGENTS.md").write_text("payload persona", encoding="utf-8")
    for name in skills:
        skill = root / "skills" / name
        skill.mkdir()
        (skill / "SKILL.md").write_text(f"# {name}", encoding="utf-8")
    for name in tools:
        (root / "tools" / f"{name}.py").write_text("", encoding="utf-8")
    if servers is not None:
        (root / "mcp.json").write_text(
            json.dumps({"servers": servers}), encoding="utf-8"
        )
    if profiles is not None:
        (root / "profiles.json").write_text(
            json.dumps({"profiles": profiles}), encoding="utf-8"
        )
    instructions = base / "AGENTS.md"
    instructions.write_text("runtime guardrails", encoding="utf-8")
    return settings(
        payload_root=root,
        instructions_path=instructions,
        workspace=base / "workspace",
        codex_home=base / "codex",
    )


class RuntimeSettingsTests(unittest.TestCase):
    def test_config_references_secret_environment_variable(self):
        rendered = render_codex_config(settings(model_api_key="super-secret"))

        self.assertIn('env_key = "DIGIBUDDY_MODEL_API_KEY"', rendered)
        self.assertNotIn("super-secret", rendered)
        self.assertIn('wire_api = "responses"', rendered)

    def test_remote_endpoint_requires_https(self):
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            validate_settings(settings(model_endpoint="http://example.com/v1"))

    def test_endpoint_requires_key(self):
        with self.assertRaisesRegex(RuntimeError, "CODEX_MODEL_API_KEY"):
            validate_settings(settings(model_api_key=""))


class ModelOverrideTests(unittest.TestCase):
    def test_blank_fields_keep_the_deployed_values(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            store.write("models.json", {"model": "gpt-5.2", "api_key": "  "})

            overridden = apply_model_overrides(settings(), store)

            self.assertEqual(overridden.model_name, "gpt-5.2")
            self.assertEqual(overridden.model_api_key, "not-a-real-key")

    def test_invalid_overlay_falls_back_to_the_image(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            store.write("models.json", {"endpoint": "http://plaintext.example.com"})

            deployed = settings()
            self.assertEqual(apply_model_overrides(deployed, store), deployed)


class McpCatalogueTests(unittest.TestCase):
    def test_disabled_and_plaintext_servers_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory,
                servers={
                    "good": {"url": "https://example.com/mcp"},
                    "off": {"url": "https://example.com/mcp", "enabled": False},
                    "plain": {"url": "http://example.com/mcp"},
                },
            )

            self.assertEqual(list(load_mcp_servers(configured)), ["good"])

    def test_profile_restricts_the_catalogue(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory,
                servers={
                    "learn": {"url": "https://example.com/learn"},
                    "pricing": {"url": "https://example.com/pricing"},
                },
            )
            profile = AgentProfile(name="p", mcp_servers=("learn",))

            self.assertEqual(
                list(load_mcp_servers(configured, None, profile)), ["learn"]
            )

    def test_overlay_replaces_the_packaged_catalogue(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory, servers={"packaged": {"url": "https://example.com/a"}}
            )
            store = FileConfigStore(Path(directory) / "config")
            store.write(
                "mcp.json", {"servers": {"admin": {"url": "https://example.com/b"}}}
            )

            self.assertEqual(list(load_mcp_servers(configured, store)), ["admin"])


class InstructionsTests(unittest.TestCase):
    def test_only_allowed_skills_are_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory, skills=["pptx", "docx"])
            profile = AgentProfile(name="p", persona="Be brief.", skills=("pptx",))

            rendered = load_instructions(configured, profile)

            self.assertIn("runtime guardrails", rendered)
            self.assertIn("payload persona", rendered)
            self.assertIn("Be brief.", rendered)
            self.assertIn("- pptx", rendered)
            self.assertNotIn("- docx", rendered)


class ProfileEnvironmentTests(unittest.TestCase):
    def test_restricted_profile_gets_a_filtered_view(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory, skills=["pptx", "docx"], tools=["azure_blob", "m365_cli"]
            )
            profile = AgentProfile(
                name="marketing", skills=("pptx",), tools=("azure_blob",)
            )

            environment = prepare_codex_environment(configured, None, profile)

            skills_root = Path(environment["DIGIBUDDY_SKILLS_ROOT"])
            tools_root = Path(environment["DIGIBUDDY_TOOLS_ROOT"])
            self.assertEqual(environment["DIGIBUDDY_PROFILE"], "marketing")
            self.assertEqual([p.name for p in skills_root.iterdir()], ["pptx"])
            self.assertEqual([p.name for p in tools_root.iterdir()], ["azure_blob.py"])
            self.assertTrue(environment["PYTHONPATH"].startswith(str(tools_root)))

    def test_unrestricted_profile_points_at_the_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory, skills=["pptx"], tools=["azure_blob"])

            environment = prepare_codex_environment(configured)

            self.assertEqual(
                environment["DIGIBUDDY_SKILLS_ROOT"],
                str(configured.payload_root / "skills"),
            )
            self.assertEqual(
                environment["DIGIBUDDY_TOOLS_ROOT"],
                str(configured.payload_root / "tools"),
            )


class CatalogueTests(unittest.TestCase):
    def test_catalogue_reports_what_the_image_ships(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory,
                skills=["docx", "pptx"],
                tools=["azure_blob", "_private"],
                servers={"learn": {"url": "https://example.com/learn"}},
            )

            catalogue = build_catalogue(configured)

            self.assertEqual(catalogue.skills, ("docx", "pptx"))
            self.assertEqual(catalogue.tools, ("azure_blob",))
            self.assertEqual(catalogue.mcp_servers, ("learn",))


class ProfileSourceTests(unittest.TestCase):
    def test_overlay_profiles_win_over_the_packaged_ones(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory, profiles=[{"name": "packaged"}])

            self.assertEqual(list(load_profiles(configured)), ["packaged"])

            store = FileConfigStore(Path(directory) / "config")
            store.write("profiles.json", {"profiles": [{"name": "admin"}]})

            self.assertEqual(list(load_profiles(configured, store)), ["admin"])


if __name__ == "__main__":
    unittest.main()
