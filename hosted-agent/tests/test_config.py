import tempfile
import unittest
from pathlib import Path

from codex_adapter.config import RuntimeSettings, render_codex_config, validate_settings


def settings(**overrides):
    values = {
        "model_name": "gpt-5.2-codex",
        "model_endpoint": "https://example.openai.azure.com/openai/v1",
        "model_api_key": "not-a-real-key",
        "model_provider": "haeronclaw",
        "approval_policy": "never",
        "sandbox": "workspace-write",
        "workspace": Path("/workspace"),
        "codex_home": Path("/tmp/codex"),
        "instructions_path": Path("/tmp/AGENTS.md"),
    }
    values.update(overrides)
    return RuntimeSettings(**values)


class RuntimeSettingsTests(unittest.TestCase):
    def test_config_references_secret_environment_variable(self):
        rendered = render_codex_config(settings(model_api_key="super-secret"))

        self.assertIn('env_key = "HAERONCLAW_MODEL_API_KEY"', rendered)
        self.assertNotIn("super-secret", rendered)
        self.assertIn('wire_api = "responses"', rendered)

    def test_remote_endpoint_requires_https(self):
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            validate_settings(settings(model_endpoint="http://example.com/v1"))

    def test_endpoint_requires_key(self):
        with self.assertRaisesRegex(RuntimeError, "CODEX_MODEL_API_KEY"):
            validate_settings(settings(model_api_key=""))


if __name__ == "__main__":
    unittest.main()
