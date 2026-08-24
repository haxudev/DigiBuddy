import os
import subprocess
import sys
import unittest

from codex_adapter.hardening import harden_process


class HardeningTests(unittest.TestCase):
    """The adapter holds the model key and every resolved profile credential."""

    def test_a_same_uid_child_can_no_longer_read_the_parent_environment(self):
        # Run in a subprocess: the flag is irreversible for the process that
        # sets it, and this one has tests left to run.
        script = """
import subprocess, sys, os
sys.path.insert(0, %r)
from codex_adapter.hardening import harden_process

probe = [sys.executable, "-c", "open('/proc/%%d/environ','rb').read()" %% os.getpid()]
before = subprocess.run(probe, capture_output=True).returncode == 0
applied = harden_process()
after = subprocess.run(probe, capture_output=True).returncode == 0
print(f"{before}:{applied}:{after}")
""" % os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        before, applied, after = result.stdout.strip().split(":")

        self.assertEqual(before, "True", "the parent environment should start readable")
        self.assertEqual(applied, "True", "hardening should report success")
        self.assertEqual(after, "False", "the child must no longer read it")

    def test_hardening_reports_rather_than_raises_when_it_cannot_apply(self):
        # Never a hard failure: the agent is still useful without the tier, and
        # crashing on start-up would be a worse outcome than a warning.
        self.assertIn(harden_process(), (True, False))


class SecretSinkTests(unittest.TestCase):
    """A credential that reaches a log outlives the process it was scoped to."""

    def test_codex_stderr_is_counted_not_transcribed(self):
        import asyncio
        import logging
        import tempfile
        from pathlib import Path

        from codex_adapter.client import CodexRuntime
        from codex_adapter.config import RuntimeSettings
        from codex_adapter.config_store import NullConfigStore

        class Stream:
            def __init__(self, lines):
                self._lines = list(lines)

            async def readline(self):
                return self._lines.pop(0) if self._lines else b""

        class Process:
            stderr = Stream([b"Bearer sk-super-secret-value\n"])

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                runtime = CodexRuntime(
                    RuntimeSettings(
                        model_name="m",
                        model_endpoint="",
                        model_api_key="",
                        model_provider="digibuddy",
                        approval_policy="never",
                        sandbox="workspace-write",
                        network_access=True,
                        workspace=root / "workspace",
                        codex_home=root / "codex",
                        instructions_path=root / "AGENTS.md",
                        payload_root=root / "payload",
                        skills_source=root / "skills",
                    ),
                    NullConfigStore(),
                )
                runtime._process = Process()
                with self.assertLogs("codex_adapter.client", level=logging.INFO) as logs:
                    await runtime._drain_stderr()
                return "\n".join(logs.output)

        recorded = asyncio.run(exercise())
        self.assertNotIn("sk-super-secret-value", recorded)
        self.assertIn("bytes", recorded)


if __name__ == "__main__":
    unittest.main()
