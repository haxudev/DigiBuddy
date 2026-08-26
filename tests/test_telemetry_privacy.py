"""Telemetry must carry the runtime's diagnostics, not the conversation.

The agent server captures prompts and completions by default. Production now
exports its logs and traces to Application Insights, so leaving that default in
place would record what every user asked and what the knowledge base answered.
The switch that prevents it is one line in `azure.yaml` and nothing else fails
if it disappears, which is exactly why it is asserted here.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

AZURE_YAML = Path(__file__).resolve().parent.parent / "azure.yaml"

CAPTURE_DISABLED = re.compile(
    r"^\s*OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT:\s*\"false\"\s*$",
    re.MULTILINE,
)


class TelemetryPrivacyTests(unittest.TestCase):
    def test_prompts_and_completions_are_not_exported(self):
        self.assertRegex(AZURE_YAML.read_text(encoding="utf-8"), CAPTURE_DISABLED)

    def test_the_reserved_connection_string_is_not_set_by_hand(self):
        # Foundry rejects the deployment outright; it injects the value from
        # the project's Application Insights connection instead.
        self.assertNotIn(
            "APPLICATIONINSIGHTS_CONNECTION_STRING:",
            AZURE_YAML.read_text(encoding="utf-8"),
        )
