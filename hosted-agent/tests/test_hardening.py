import os
import subprocess
import sys
import unittest
from pathlib import Path

from codex_adapter.hardening import harden_process


class HardeningTests(unittest.TestCase):
    """The adapter holds the model key and every resolved profile credential."""

    def test_a_same_uid_child_can_no_longer_read_the_parent_environment(self):
        # Run in a subprocess: the flag is irreversible for the process that
        # sets it, and this one has tests left to run.
        probe = """
import os, subprocess, sys
sys.path.insert(0, %r)
from codex_adapter import hardening

hardening.harden_process()
hardening._hardened_pid = -1          # what a pid change looks like
applied_again = hardening.harden_process()
check = [sys.executable, "-c", "open('/proc/%%d/environ','rb').read()" %% os.getpid()]
child_can_read = subprocess.run(check, capture_output=True).returncode == 0
print(f"{applied_again}:{child_can_read}")
""" % os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        result = subprocess.run(
            [sys.executable, "-c", probe], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        applied_again, child_can_read = result.stdout.strip().split(":")

        self.assertEqual(applied_again, "True", "a new pid must be hardened again")
        self.assertEqual(child_can_read, "False", "the child must not read it")

    def test_the_runtime_hardens_before_it_forks_codex(self):
        """The guarantee is about the process that owns the child, not startup."""
        source = Path(__file__).resolve().parent.parent / "codex_adapter" / "client.py"
        body = source.read_text(encoding="utf-8")

        harden = body.index("harden_process()")
        fork = body.index("create_subprocess_exec")
        self.assertLess(
            harden, fork, "hardening must happen before Codex is forked"
        )

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
