import asyncio
import tempfile
import unittest
from pathlib import Path

from codex_adapter.client import (
    CodexProtocolError,
    CodexRuntime,
    _server_request_result,
)
from codex_adapter.config import RuntimeSettings
from codex_adapter.config_store import NullConfigStore


def settings(directory: str, **overrides):
    root = Path(directory)
    values = {
        "model_name": "gpt-5.2-codex",
        "model_endpoint": "",
        "model_api_key": "",
        "model_provider": "digibuddy",
        "approval_policy": "never",
        "sandbox": "workspace-write",
        "network_access": True,
        "workspace": root / "workspace",
        "codex_home": root / "codex",
        "instructions_path": root / "AGENTS.md",
        "payload_root": root / "payload",
        "skills_source": root / "skills",
    }
    values.update(overrides)
    return RuntimeSettings(**values)


class ServerRequestTests(unittest.TestCase):
    def test_each_interactive_request_gets_a_schema_compatible_decline(self):
        self.assertEqual(
            _server_request_result("item/commandExecution/requestApproval"),
            {"decision": "decline"},
        )
        self.assertEqual(
            _server_request_result("mcpServer/elicitation/request"),
            {"action": "decline", "content": None},
        )
        self.assertEqual(
            _server_request_result("item/tool/requestUserInput"),
            {"answers": {}},
        )
        self.assertEqual(
            _server_request_result("item/permissions/requestApproval"),
            {"permissions": {}, "scope": "turn"},
        )
        self.assertIsNone(_server_request_result("unknown/request"))


class ProtocolTimeoutTests(unittest.TestCase):
    def test_request_timeout_restarts_the_stalled_process(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory, protocol_timeout_seconds=0.01)
                runtime = CodexRuntime(current, NullConfigStore())
                restarted = False

                async def send(_message):
                    return None

                async def read_forever():
                    await asyncio.Event().wait()

                async def restart():
                    nonlocal restarted
                    restarted = True

                runtime._send = send
                runtime._read_message = read_forever
                runtime._restart = restart

                with self.assertRaisesRegex(CodexProtocolError, "initialize timed out"):
                    await runtime._request("initialize", {})
                self.assertTrue(restarted)

        asyncio.run(exercise())

    def test_cancellation_interrupts_an_idle_turn(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                runtime = CodexRuntime(settings(directory), NullConfigStore())
                cancellation = asyncio.Event()
                cancellation.set()
                restarted = False

                async def restart():
                    nonlocal restarted
                    restarted = True

                runtime._restart = restart
                self.assertIsNone(await runtime._next_turn_message(cancellation))
                self.assertTrue(restarted)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
