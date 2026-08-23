import json
import tempfile
import tomllib
import unittest
from pathlib import Path

from codex_adapter.config import (
    RuntimeSettings,
    apply_model_overrides,
    build_catalogue,
    install_global_skills,
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
        "network_access": True,
        "workspace": Path("/workspace"),
        "codex_home": Path("/tmp/codex"),
        "instructions_path": Path("/tmp/AGENTS.md"),
        "payload_root": Path("/opt/digibuddy"),
        "skills_source": Path("/tmp/global-skills"),
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
        skills_source=Path(__file__).resolve().parents[1] / "skills",
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

    def test_requested_reasoning_effort_overrides_the_profile(self):
        profile = AgentProfile(name="deep", reasoning_effort="high")

        rendered = render_codex_config(settings(), None, profile, "low")

        self.assertIn('model_reasoning_effort = "low"', rendered)

    def test_unknown_reasoning_effort_keeps_the_configured_one(self):
        rendered = render_codex_config(settings(reasoning_effort="medium"), None, None, "turbo")

        self.assertIn('model_reasoning_effort = "medium"', rendered)

    def test_endpoint_requires_key(self):
        with self.assertRaisesRegex(RuntimeError, "CODEX_MODEL_API_KEY"):
            validate_settings(settings(model_api_key=""))

    def test_workspace_write_sandbox_grants_network_access(self):
        parsed = tomllib.loads(render_codex_config(settings()))

        self.assertTrue(parsed["sandbox_workspace_write"]["network_access"])
        self.assertEqual(parsed["model_provider"], "digibuddy")
        self.assertEqual(
            parsed["model_providers"]["digibuddy"]["wire_api"], "responses"
        )

    def test_network_access_can_be_disabled(self):
        parsed = tomllib.loads(render_codex_config(settings(network_access=False)))

        self.assertFalse(parsed["sandbox_workspace_write"]["network_access"])

    def test_non_workspace_write_sandbox_omits_network_table(self):
        parsed = tomllib.loads(render_codex_config(settings(sandbox="read-only")))

        self.assertNotIn("sandbox_workspace_write", parsed)


class GlobalSkillInstallTests(unittest.TestCase):
    def test_skills_are_published_under_codex_home(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "pack"
            for index in range(11):
                skill = source / f"skill-{index}"
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("x", encoding="utf-8")
            (source / "notes").mkdir()
            (source / "notes" / "README.md").write_text("x", encoding="utf-8")
            codex_home = Path(root) / "codex"
            codex_home.mkdir()
            current = settings(skills_source=source, codex_home=codex_home)

            self.assertEqual(install_global_skills(current), 11)
            self.assertEqual(install_global_skills(current), 11)
            self.assertTrue(
                (codex_home / "skills" / "skill-0" / "SKILL.md").is_file()
            )
            self.assertFalse((codex_home / "skills" / "notes").exists())

    def test_missing_skill_pack_is_reported(self):
        with tempfile.TemporaryDirectory() as root:
            codex_home = Path(root) / "codex"
            codex_home.mkdir()
            current = settings(
                skills_source=Path(root) / "absent", codex_home=codex_home
            )

            with self.assertRaisesRegex(RuntimeError, "missing"):
                install_global_skills(current)


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
    def test_local_agent_maturity_server_keeps_its_fixed_package_path(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory,
                servers={
                    "agent-maturity": {
                        "command": "python",
                        "args": ["-m", "agent_maturity.mcp"],
                        "env": {
                            "PYTHONPATH": (
                                "/app/hosted-agent/vendor/agent-maturity"
                            )
                        },
                    }
                },
            )

            server = load_mcp_servers(configured)["agent-maturity"]
            self.assertEqual(server["command"], "python")
            self.assertEqual(server["args"], ["-m", "agent_maturity.mcp"])
            self.assertEqual(
                server["env"]["PYTHONPATH"],
                "/app/hosted-agent/vendor/agent-maturity",
            )

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

            self.assertTrue({"docx", "pptx", "superclarity"} <= set(catalogue.skills))
            self.assertEqual(catalogue.tools, ("azure_blob",))
            self.assertEqual(catalogue.mcp_servers, ("learn",))

    def test_catalogue_includes_packaged_global_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory, skills=["docx"])
            global_skills = Path(directory) / "global-skills"
            skill = global_skills / "superclarity"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("# superclarity", encoding="utf-8")
            configured = settings(
                **{
                    **configured.__dict__,
                    "skills_source": global_skills,
                }
            )

            self.assertEqual(
                build_catalogue(configured).skills,
                ("docx", "superclarity"),
            )


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
