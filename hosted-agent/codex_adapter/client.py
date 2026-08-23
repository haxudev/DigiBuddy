from __future__ import annotations

import asyncio
import json
import logging
from asyncio.subprocess import Process
from collections.abc import AsyncIterator
from typing import Any

from .config import RuntimeSettings, load_instructions, prepare_codex_environment
from .events import RuntimeEvent, translate_notification
from .session_map import ResponseThreadMap

logger = logging.getLogger(__name__)


class CodexProtocolError(RuntimeError):
    pass


class CodexRuntime:
    def __init__(self, settings: RuntimeSettings):
        self._settings = settings
        self._process: Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._request_id = 0
        self._lock = asyncio.Lock()
        self._loaded_threads: set[str] = set()
        self._pending_notifications: list[dict[str, Any]] = []
        self._thread_map = ResponseThreadMap(
            settings.codex_home / "digibuddy-response-threads.json"
        )

    async def stream_turn(
        self,
        prompt: str,
        *,
        previous_response_id: str | None,
        response_id: str,
        cancellation_signal: asyncio.Event,
        model: str | None = None,
    ) -> AsyncIterator[RuntimeEvent]:
        async with self._lock:
            await self._ensure_started()
            thread_id = self._thread_map.lookup(previous_response_id)
            if thread_id:
                await self._resume_thread(thread_id, model)
            else:
                thread_id = await self._start_thread(model)
            self._thread_map.bind(response_id, thread_id)

            result = await self._request(
                "turn/start",
                {
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": prompt}],
                },
            )
            turn = result.get("turn") if isinstance(result, dict) else None
            turn_id = turn.get("id") if isinstance(turn, dict) else None

            while self._pending_notifications:
                notification = self._pending_notifications.pop(0)
                for event in translate_notification(notification):
                    yield event

            while True:
                if cancellation_signal.is_set():
                    await self._restart()
                    return
                message = await self._read_message()
                if "method" in message and "id" in message:
                    await self._decline_server_request(message)
                    continue
                if "method" not in message:
                    continue
                for event in translate_notification(message):
                    yield event
                if message.get("method") == "turn/completed":
                    params = message.get("params")
                    completed = params.get("turn") if isinstance(params, dict) else None
                    completed_id = completed.get("id") if isinstance(completed, dict) else None
                    if not turn_id or not completed_id or completed_id == turn_id:
                        if isinstance(completed, dict) and completed.get("status") == "failed":
                            error = completed.get("error") or "Codex turn failed"
                            raise CodexProtocolError(str(error))
                        return

    async def _ensure_started(self) -> None:
        if self._process and self._process.returncode is None:
            return
        environment = prepare_codex_environment(self._settings)
        self._process = await asyncio.create_subprocess_exec(
            "codex",
            "app-server",
            "--listen",
            "stdio://",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            cwd=self._settings.workspace,
        )
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        await self._request(
            "initialize",
            {
                "clientInfo": {
                    "name": "digibuddy_foundry",
                    "title": "DigiBuddy Foundry Hosted Agent",
                    "version": "1.0.0",
                }
            },
        )
        await self._send({"method": "initialized", "params": {}})

    async def _start_thread(self, model: str | None) -> str:
        params: dict[str, Any] = {
            "model": model or self._settings.model_name,
            "cwd": str(self._settings.workspace),
            "approvalPolicy": self._settings.approval_policy,
            "sandbox": self._settings.sandbox,
            "baseInstructions": load_instructions(self._settings),
        }
        if self._settings.model_endpoint:
            params["modelProvider"] = self._settings.model_provider
        result = await self._request("thread/start", params)
        thread = result.get("thread") if isinstance(result, dict) else None
        thread_id = thread.get("id") if isinstance(thread, dict) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise CodexProtocolError("Codex thread/start returned no thread id")
        self._loaded_threads.add(thread_id)
        return thread_id

    async def _resume_thread(self, thread_id: str, model: str | None) -> None:
        if thread_id in self._loaded_threads:
            return
        params: dict[str, Any] = {
            "threadId": thread_id,
            "model": model or self._settings.model_name,
            "cwd": str(self._settings.workspace),
            "approvalPolicy": self._settings.approval_policy,
            "sandbox": self._settings.sandbox,
            "baseInstructions": load_instructions(self._settings),
        }
        if self._settings.model_endpoint:
            params["modelProvider"] = self._settings.model_provider
        await self._request("thread/resume", params)
        self._loaded_threads.add(thread_id)

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        self._request_id += 1
        request_id = self._request_id
        await self._send({"method": method, "id": request_id, "params": params})
        while True:
            message = await self._read_message()
            if message.get("id") == request_id and "method" not in message:
                if "error" in message:
                    raise CodexProtocolError(
                        f"{method} failed: {json.dumps(message['error'], ensure_ascii=False)}"
                    )
                return message.get("result")
            if "method" in message and "id" in message:
                await self._decline_server_request(message)
            elif "method" in message:
                self._pending_notifications.append(message)

    async def _send(self, message: dict[str, Any]) -> None:
        if not self._process or not self._process.stdin:
            raise CodexProtocolError("Codex app-server is not running")
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        self._process.stdin.write(payload.encode("utf-8"))
        await self._process.stdin.drain()

    async def _read_message(self) -> dict[str, Any]:
        if not self._process or not self._process.stdout:
            raise CodexProtocolError("Codex app-server is not running")
        line = await self._process.stdout.readline()
        if not line:
            return_code = await self._process.wait()
            raise CodexProtocolError(
                f"Codex app-server exited unexpectedly with code {return_code}"
            )
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CodexProtocolError("Codex app-server emitted invalid JSON") from exc
        if not isinstance(message, dict):
            raise CodexProtocolError("Codex app-server emitted a non-object message")
        return message

    async def _decline_server_request(self, message: dict[str, Any]) -> None:
        await self._send({"id": message["id"], "result": {"decision": "decline"}})

    async def _drain_stderr(self) -> None:
        if not self._process or not self._process.stderr:
            return
        while line := await self._process.stderr.readline():
            logger.info("codex: %s", line.decode("utf-8", errors="replace").rstrip())

    async def _restart(self) -> None:
        if self._process and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        if self._stderr_task:
            self._stderr_task.cancel()
        self._process = None
        self._stderr_task = None
        self._loaded_threads.clear()
        self._pending_notifications.clear()
