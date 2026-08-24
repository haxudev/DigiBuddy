import json
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from codex_adapter.config import (
    PACKAGED_SKILL_MANIFEST,
    RuntimeSettings,
    apply_model_overrides,
    build_catalogue,
    capability_packs_enabled,
    install_global_skills,
    load_instructions,
    load_mcp_servers,
    load_profiles,
    prepare_codex_environment,
    profile_credentials_enabled,
    render_codex_config,
    runtime_fingerprint,
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

    def test_provider_names_with_dots_are_rendered_as_literal_table_keys(self):
        parsed = tomllib.loads(
            render_codex_config(settings(model_provider="azure.openai"))
        )

        self.assertIn("azure.openai", parsed["model_providers"])


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

    def test_a_source_that_stops_publishing_a_skill_is_reported(self):
        # The image's skills are synced from upstream repositories. A source that
        # quietly drops a skill would otherwise shrink what the agent can do with
        # no signal at all, so the generated manifest is cross-checked.
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "pack"
            for name in ("alpha", "beta"):
                skill = source / name
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("x", encoding="utf-8")
            codex_home = Path(root) / "codex"
            codex_home.mkdir()
            current = settings(skills_source=source, codex_home=codex_home)

            manifest = source / PACKAGED_SKILL_MANIFEST
            manifest.write_text("# generated\nalpha\nbeta\n", encoding="utf-8")
            self.assertEqual(install_global_skills(current), 2)

            manifest.write_text("# generated\nalpha\nbeta\ngamma\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "gamma"):
                install_global_skills(current)

    def test_restricted_profile_removes_disallowed_global_skills(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "pack"
            for index in range(11):
                skill = source / f"skill-{index}"
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("x", encoding="utf-8")
            codex_home = Path(root) / "codex"
            current = settings(skills_source=source, codex_home=codex_home)

            self.assertEqual(install_global_skills(current), 11)
            restricted = AgentProfile(name="restricted", skills=("skill-0",))
            self.assertEqual(install_global_skills(current, restricted), 1)
            self.assertEqual(
                [entry.name for entry in (codex_home / "skills").iterdir()],
                ["skill-0"],
            )


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
                    "placeholder": {
                        "url": "https://<your-service>.azurewebsites.net/mcp"
                    },
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


class RuntimeFingerprintTests(unittest.TestCase):
    def test_secret_profile_and_mcp_changes_restart_the_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(
                directory,
                servers={"learn": {"url": "https://example.com/learn"}},
            )
            profile = AgentProfile(name="profile", persona="First")
            original = runtime_fingerprint(configured, None, profile)

            rotated = settings(
                **{
                    **configured.__dict__,
                    "model_api_key": "rotated-key",
                }
            )
            self.assertNotEqual(
                original, runtime_fingerprint(rotated, None, profile)
            )
            self.assertNotEqual(
                original,
                runtime_fingerprint(
                    configured,
                    None,
                    AgentProfile(name="profile", persona="Second"),
                ),
            )

            store = FileConfigStore(Path(directory) / "config")
            store.write(
                "mcp.json",
                {"servers": {"learn": {"url": "https://example.com/other"}}},
            )
            self.assertNotEqual(
                original, runtime_fingerprint(configured, store, profile)
            )


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


class KillSwitchTests(unittest.TestCase):
    """Both new planes ship off, so the console and the runtime can roll apart."""

    def test_both_features_default_to_off(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(profile_credentials_enabled())
            self.assertFalse(capability_packs_enabled())

    def test_each_switch_is_read_independently(self):
        with mock.patch.dict(
            os.environ,
            {"DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS": "true"},
            clear=True,
        ):
            self.assertTrue(profile_credentials_enabled())
            self.assertFalse(capability_packs_enabled())

        with mock.patch.dict(
            os.environ, {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "1"}, clear=True
        ):
            self.assertFalse(profile_credentials_enabled())
            self.assertTrue(capability_packs_enabled())

    def test_an_unparsable_switch_stays_off(self):
        with mock.patch.dict(
            os.environ,
            {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "perhaps"},
            clear=True,
        ):
            self.assertFalse(capability_packs_enabled())


if __name__ == "__main__":
    unittest.main()


class ChildEnvironmentTests(unittest.TestCase):
    """What the Codex process inherits is a security decision, not a default.

    The child is untrusted: it has a shell, network egress and a model that can
    be talked into using them. So its environment is built from an explicit
    list plus the active profile's own bindings, never copied wholesale.
    """

    def _prepared(self, directory, *, profile=None, extra_env=None, credentials=None):
        configured = payload(directory)
        store = FileConfigStore(Path(directory) / "config")
        if credentials is not None:
            store.write("credentials.json", credentials)
        environment = {
            "PATH": "/usr/bin",
            "HOME": "/home/agent",
            "DIGIBUDDY_CONFIG_URI": "https://example.blob.core.windows.net/config",
            "DIGIBUDDY_GRAPH_CLIENT_SECRET": "container-wide-graph-secret",
            "UNRELATED_BUILD_TOKEN": "should-not-travel",
            **(extra_env or {}),
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            with mock.patch.dict(
                os.environ, {"DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS": "true"}
            ):
                return prepare_codex_environment(configured, store, profile)

    def test_the_runtime_essentials_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            child = self._prepared(directory)

            self.assertEqual(child["PATH"], "/usr/bin")
            self.assertEqual(child["HOME"], "/home/agent")
            self.assertIn("DIGIBUDDY_SKILLS_ROOT", child)
            self.assertIn("DIGIBUDDY_TOOLS_ROOT", child)
            self.assertIn("PYTHONPATH", child)

    def test_an_unrelated_variable_does_not_travel(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertNotIn("UNRELATED_BUILD_TOKEN", self._prepared(directory))

    def test_the_config_store_uri_is_withheld(self):
        """It is the address of every profile's secrets."""
        with tempfile.TemporaryDirectory() as directory:
            self.assertNotIn("DIGIBUDDY_CONFIG_URI", self._prepared(directory))

    def test_a_credential_reaches_only_the_profile_it_is_bound_to(self):
        credentials = {
            "credentials": [
                {"profile": "alpha", "slot": "graph_client_secret", "value": "alpha-secret"},
                {"profile": "beta", "slot": "graph_client_secret", "value": "beta-secret"},
            ]
        }
        alpha = AgentProfile(name="alpha")
        beta = AgentProfile(name="beta")

        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            for_alpha = self._prepared(one, profile=alpha, credentials=credentials)
            for_beta = self._prepared(two, profile=beta, credentials=credentials)

        self.assertEqual(for_alpha["DIGIBUDDY_GRAPH_CLIENT_SECRET"], "alpha-secret")
        self.assertEqual(for_beta["DIGIBUDDY_GRAPH_CLIENT_SECRET"], "beta-secret")

    def test_a_profile_without_a_binding_gets_no_credential_at_all(self):
        """Inheriting the container-wide value would defeat the whole point."""
        credentials = {
            "credentials": [
                {"profile": "alpha", "slot": "graph_client_secret", "value": "alpha-secret"}
            ]
        }

        with tempfile.TemporaryDirectory() as directory:
            child = self._prepared(
                directory, profile=AgentProfile(name="beta"), credentials=credentials
            )

        self.assertNotIn("DIGIBUDDY_GRAPH_CLIENT_SECRET", child)

    def test_a_credential_cannot_overwrite_a_runtime_variable(self):
        credentials = {
            "credentials": [
                {"profile": "alpha", "slot": "PATH", "value": "/attacker/bin"},
                {"profile": "alpha", "slot": "PYTHONPATH", "value": "/attacker/lib"},
            ]
        }

        with tempfile.TemporaryDirectory() as directory:
            child = self._prepared(
                directory, profile=AgentProfile(name="alpha"), credentials=credentials
            )

        self.assertEqual(child["PATH"], "/usr/bin")
        self.assertNotIn("/attacker/lib", child["PYTHONPATH"])

    def test_credentials_stay_out_until_the_switch_is_on(self):
        credentials = {
            "credentials": [
                {"profile": "alpha", "slot": "graph_client_secret", "value": "alpha-secret"}
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = FileConfigStore(Path(directory) / "config")
            store.write("credentials.json", credentials)
            with mock.patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True):
                child = prepare_codex_environment(
                    configured, store, AgentProfile(name="alpha")
                )

        self.assertNotIn("DIGIBUDDY_GRAPH_CLIENT_SECRET", child)


class PackActivationTests(unittest.TestCase):
    """Uploaded code runs only when consent names the bytes now in the store."""

    def _store(self, directory, entries):
        store = FileConfigStore(Path(directory) / "config")
        store.write("skills.json", {"skills": entries})
        return store

    def _tool_entry(self, digest, **overrides):
        base = {
            "name": "reporter",
            "kind": "tool",
            "sha256": digest,
            "bundle": f"bundles/reporter/{digest}.zip",
            "enabled": True,
            "approved_sha256": digest,
            "declaration": {"module": "reporter.cli", "call": "main"},
        }
        base.update(overrides)
        return base

    def _mcp_entry(self, digest, **overrides):
        base = {
            "name": "pack-mcp",
            "kind": "mcp_server",
            "sha256": digest,
            "bundle": f"bundles/pack-mcp/{digest}.zip",
            "enabled": True,
            "approved_sha256": digest,
            "declaration": {
                "runtime": "python",
                "entrypoint": "server.py",
                "env": {"PACK_MODE": "safe"},
            },
        }
        base.update(overrides)
        return base

    def test_an_approved_mcp_server_is_rendered_from_its_installed_files(self):
        digest = "c" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(directory, [self._mcp_entry(digest)])
            with mock.patch.dict(
                os.environ, {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"}
            ):
                rendered = render_codex_config(configured, store)

            block = tomllib.loads(rendered)["mcp_servers"]["pack-mcp"]
            self.assertEqual(block["command"], "python")
            self.assertTrue(block["args"][0].endswith("pack-mcp/server.py"))
            self.assertEqual(block["env"]["PACK_MODE"], "safe")

    def test_an_unapproved_mcp_server_renders_nothing(self):
        digest = "c" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(
                directory, [self._mcp_entry(digest, approved_sha256="")]
            )
            with mock.patch.dict(
                os.environ, {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"}
            ):
                rendered = render_codex_config(configured, store)

            self.assertNotIn("pack-mcp", rendered)

    def test_a_profile_that_does_not_allow_it_never_receives_it(self):
        digest = "c" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(directory, [self._mcp_entry(digest)])
            with mock.patch.dict(
                os.environ, {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"}
            ):
                rendered = render_codex_config(
                    configured, store, AgentProfile(name="a", mcp_servers=())
                )

            self.assertNotIn("pack-mcp", rendered)

    def test_pack_capabilities_stay_out_until_the_switch_is_on(self):
        digest = "c" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(directory, [self._mcp_entry(digest)])
            with mock.patch.dict(os.environ, {}, clear=True):
                rendered = render_codex_config(configured, store)

            self.assertNotIn("pack-mcp", rendered)

    def test_an_approved_tool_never_joins_the_global_module_path(self):
        """A pack directory on PYTHONPATH would run its own sitecustomize."""
        digest = "d" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(directory, [self._tool_entry(digest)])
            with mock.patch.dict(
                os.environ,
                {"PATH": "/usr/bin", "DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"},
                clear=True,
            ):
                child = prepare_codex_environment(configured, store)

            self.assertNotIn("packs", child["PYTHONPATH"])

    def test_the_catalogue_reports_only_what_is_actually_active(self):
        digest = "e" * 64
        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = self._store(
                directory,
                [
                    self._tool_entry(digest),
                    self._mcp_entry(digest, approved_sha256=""),
                ],
            )
            with mock.patch.dict(
                os.environ, {"DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"}
            ):
                catalogue = build_catalogue(configured, store)

            self.assertIn("reporter", catalogue.tools)
            self.assertNotIn("pack-mcp", catalogue.mcp_servers)

    def test_an_approved_tool_is_published_behind_a_launcher(self):
        import zipfile, io, hashlib

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("reporter/reporter/__init__.py", "")
            archive.writestr("reporter/reporter/cli.py", "def main():\n    return 0\n")
        artifact = buffer.getvalue()
        digest = hashlib.sha256(artifact).hexdigest()

        class PackStore(FileConfigStore):
            def read_bundle(self, path):
                return artifact

        with tempfile.TemporaryDirectory() as directory:
            configured = payload(directory)
            store = PackStore(Path(directory) / "config")
            store.write("skills.json", {"skills": [self._tool_entry(digest)]})

            with mock.patch.dict(
                os.environ,
                {"PATH": "/usr/bin", "DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true"},
                clear=True,
            ):
                child = prepare_codex_environment(configured, store)

            launcher = Path(child["DIGIBUDDY_TOOLS_ROOT"]) / "reporter.py"
            self.assertTrue(launcher.is_file())
            body = launcher.read_text(encoding="utf-8")
            self.assertIn("from reporter.cli import main", body)
            # The artifact reaches sys.path inside the launcher, never through
            # the interpreter's own module path.
            self.assertIn("sys.path.insert", body)
            self.assertNotIn("packs", child["PYTHONPATH"])
