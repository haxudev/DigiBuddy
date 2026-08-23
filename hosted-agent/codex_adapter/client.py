from __future__ import annotations

import asyncio
import json
import logging
from asyncio.subprocess import Process
from collections.abc import AsyncIterator
from typing import Any

from .config import (
    RuntimeSettings,
    apply_model_overrides,
    build_catalogue,
    effective_model,
    load_instructions,
    load_profiles,
    prepare_codex_environment,
)
from .config_store import CATALOGUE_DOCUMENT, ConfigStore, build_config_store
from .events import RuntimeEvent, translate_notification
from .profiles import AgentProfile, profile_fingerprint, resolve_profile
from .session_map import ResponseThreadMap

logger = logging.getLogger(__name__)


class CodexProtocolError(RuntimeError):
    pass


class CodexRuntime:
    def __init__(self, settings: RuntimeSettings, store: ConfigStore | None = None):
        self._base_settings = settings
        self._settings = settings
        self._store = store if store is not None else build_config_store()
        self._process: Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._request_id = 0
        self._lock = asyncio.Lock()
        self._loaded_threads: set[str] = set()
        self._pending_notifications: list[dict[str, Any]] = []
        self._active_fingerprint: str | None = None
        self._thread_map = ResponseThreadMap(
            settings.codex_home / "digibuddy-response-threads.json"
        )
        self._publish_catalogue()

    def _publish_catalogue(self) -> None:
        """Tell the admin console exactly what this image ships."""
        try:
            self._store.write(
                CATALOGUE_DOCUMENT,
                build_catalogue(self._base_settings, self._store).as_document(),
            )
        except Exception:  # noqa: BLE001 - publishing must never block startup
            logger.warning("Could not publish the capability catalogue", exc_info=True)

    def available_profiles(self) -> dict[str, AgentProfile]:
        return load_profiles(self._base_settings, self._store)

    def _resolve(self, requested: str | None) -> AgentProfile:
        return resolve_profile(self.available_profiles(), requested)

    async def stream_turn(
        self,
        prompt: str,
        *,
        previous_response_id: str | None,
        response_id: str,
        cancellation_signal: asyncio.Event,
        model: str | None = None,
        profile: str | None = None,
    ) -> AsyncIterator[RuntimeEvent]:
        async with self._lock:
            binding = self._thread_map.lookup(previous_response_id)
            # A resumed conversation keeps the profile it was started with.
            active = self._resolve(binding.profile if binding else profile)
            await self._ensure_started(active)

            thread_id = binding.thread_id if binding else None
            if thread_id:
                await self._resume_thread(thread_id, model, active)
            else:
                thread_id = await self._start_thread(model, active)
            self._thread_map.bind(response_id, thread_id, active.name)

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

    async def _ensure_started(self, profile: AgentProfile) -> None:
        # Configuration is re-read at the turn boundary so administrator edits
        # take effect without redeploying, and the engine is restarted whenever
        # the rendered Codex configuration would differ.
        settings = apply_model_overrides(self._base_settings, self._store)
        fingerprint = "|".join(
            [
                settings.model_name,
                settings.model_endpoint,
                settings.model_provider,
                settings.reasoning_effort,
                profile_fingerprint(profile),
            ]
        )
        running = self._process is not None and self._process.returncode is None
        if running and fingerprint == self._active_fingerprint:
            return
        if running:
            logger.info("Codex configuration changed; restarting the engine")
            await self._restart()

        self._settings = settings
        environment = prepare_codex_environment(settings, self._store, profile)
        self._active_fingerprint = fingerprint
        self._process = await asyncio.create_subprocess_exec(
            "codex",
            "app-server",
            "--listen",
            "stdio://",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            cwd=settings.workspace,
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

    def _thread_params(self, model: str | None, profile: AgentProfile) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": model or effective_model(self._settings, profile),
            "cwd": str(self._settings.workspace),
            "approvalPolicy": self._settings.approval_policy,
            "sandbox": self._settings.sandbox,
            "baseInstructions": load_instructions(self._settings, profile),
        }
        if self._settings.model_endpoint:
            params["modelProvider"] = self._settings.model_provider
        return params

    async def _start_thread(self, model: str | None, profile: AgentProfile) -> str:
        params = self._thread_params(model, profile)
        result = await self._request("thread/start", params)
        thread = result.get("thread") if isinstance(result, dict) else None
        thread_id = thread.get("id") if isinstance(thread, dict) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise CodexProtocolError("Codex thread/start returned no thread id")
        self._loaded_threads.add(thread_id)
        return thread_id

    async def _resume_thread(
        self, thread_id: str, model: str | None, profile: AgentProfile
    ) -> None:
        if thread_id in self._loaded_threads:
            return
        params = self._thread_params(model, profile)
        params["threadId"] = thread_id
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
        self._active_fingerprint = None
        self._loaded_threads.clear()
        self._pending_notifications.clear()
