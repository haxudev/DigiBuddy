import asyncio
import tempfile
import unittest
from pathlib import Path

from codex_adapter.client import (
    CodexProtocolError,
    CodexRuntime,
    _server_request_result,
)
from codex_adapter.artifacts import ARTIFACT_EVENT
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

    def test_completed_turn_publishes_new_deliverables(self):
        class ArtifactStore(NullConfigStore):
            def __init__(self):
                self.payloads = []

            def write_artifact(
                self, artifact_id, filename, payload, content_type
            ):
                self.payloads.append((artifact_id, filename, payload, content_type))
                return True

        async def exercise():
            with tempfile.TemporaryDirectory() as directory:
                current = settings(directory)
                current.workspace.mkdir()
                store = ArtifactStore()
                runtime = CodexRuntime(current, store)

                async def ensure_started(_profile, _reasoning_effort=""):
                    return None

                async def start_thread(_model, _profile):
                    return "thread-1"

                async def request(method, _params):
                    self.assertEqual(method, "turn/start")
                    (current.workspace / "report.md").write_text(
                        "# Report", encoding="utf-8"
                    )
                    return {"turn": {"id": "turn-1"}}

                async def next_message(_cancellation):
                    return {
                        "method": "turn/completed",
                        "params": {
                            "turn": {"id": "turn-1", "status": "completed"}
                        },
                    }

                runtime._ensure_started = ensure_started
                runtime._start_thread = start_thread
                runtime._request = request
                runtime._next_turn_message = next_message

                events = [
                    event
                    async for event in runtime.stream_turn(
                        "build it",
                        previous_response_id=None,
                        response_id="response-1",
                        cancellation_signal=asyncio.Event(),
                    )
                ]

                artifact_event = next(
                    event for event in events if event.type == ARTIFACT_EVENT
                )
                self.assertEqual(
                    artifact_event.data["artifacts"][0]["name"], "report.md"
                )
                self.assertEqual(store.payloads[0][2], b"# Report")

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
