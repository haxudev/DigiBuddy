"""The server runtime has to be a decision, not whatever resolved that day.

`azure-ai-agentserver-responses` only requires `core>=2.0.0`. An unrelated
rebuild therefore pulled core 2.1.0, which refuses every request in a hosted
environment unless the durable task subsystem is enabled, and production
answered `server_error` to even a trivial prompt with no change of our own.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REQUIREMENTS = Path(__file__).resolve().parent.parent / "requirements.txt"

PIN = re.compile(r"^(?P<name>[A-Za-z0-9._-]+)==(?P<version>[^\s#]+)\s*$")


def _pins() -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN.fullmatch(line)
        if match:
            pins[match.group("name").lower()] = match.group("version")
    return pins


class AgentServerPinTests(unittest.TestCase):
    def test_every_requirement_is_pinned_to_an_exact_version(self):
        declared = [
            line.strip()
            for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]

        self.assertTrue(declared)
        for requirement in declared:
            self.assertRegex(requirement, PIN, f"{requirement} is not pinned")

    def test_the_server_core_is_pinned_and_not_left_to_resolution(self):
        pins = _pins()

        self.assertIn("azure-ai-agentserver-core", pins)
        self.assertIn("azure-ai-agentserver-responses", pins)

    def test_the_core_pin_predates_mandatory_resilient_tasks(self):
        version = _pins()["azure-ai-agentserver-core"]
        major, minor = (int(part) for part in version.split(".")[:2])

        # 2.1.0 fails every hosted request without `set_resilient_tasks_enabled`.
        # Raising this pin means adopting the durable task subsystem first.
        self.assertEqual((major, minor), (2, 0), f"core {version} needs that work")


if __name__ == "__main__":
    unittest.main()
