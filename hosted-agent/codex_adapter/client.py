from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from asyncio.subprocess import Process
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .artifacts import (
    ARTIFACT_EVENT,
    artifact_event_data,
    changed_artifacts,
    snapshot_workspace,
)
from .config import (
    RuntimeSettings,
    apply_model_overrides,
    build_catalogue,
    effective_model,
    load_instructions,
    load_profiles,
    prepare_codex_environment,
    runtime_fingerprint,
)
from .config_store import CATALOGUE_DOCUMENT, ConfigStore, build_config_store
from .events import RuntimeEvent, translate_notification
from .hardening import harden_process
from .profiles import AgentProfile, resolve_profile
from .session_map import ResponseThreadMap

logger = logging.getLogger(__name__)

#: Emitted once per turn so the console never has to guess which agent ran.
#: The binding lives on the server, so only the server can answer it: a blank
#: request may resolve through a deployment default, and a resumed conversation
#: keeps a profile the browser may no longer remember.
PROFILE_EVENT = "assistant.profile"

#: Conversations live side by side under this directory rather than sharing the
#: workspace root. It keeps artifact detection honest -- a diff of the whole
#: root reports another conversation's file as this one's deliverable -- and
#: stops accidental cross-reads. It is containment, not isolation: two Codex
#: processes run as the same user and can still read each other's directories.
CONVERSATIONS_DIRECTORY = "conversations"


def _workspace_id(response_id: str) -> str:
    """A stable, opaque directory name for a conversation.

    Derived rather than random because the workspace has to exist before the
    turn starts -- attachments are stored before the runtime resolves anything
    -- and both callers must independently arrive at the same directory.
    """
    return hashlib.sha256(response_id.encode("utf-8")).hexdigest()[:32]


class CodexProtocolError(RuntimeError):
    pass


def _server_request_result(method: str) -> dict[str, Any] | None:
    if method in {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "applyPatchApproval",
        "execCommandApproval",
    }:
        return {"decision": "decline"}
    if method == "item/tool/requestUserInput":
        return {"answers": {}}
    if method == "mcpServer/elicitation/request":
        return {"action": "decline", "content": None}
    if method == "item/permissions/requestApproval":
        return {"permissions": {}, "scope": "turn"}
    if method == "item/tool/call":
        return {"contentItems": [], "success": False}
    return None


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
        self._published_catalogue: str | None = None
        self._thread_map = ResponseThreadMap(
            settings.codex_home / "digibuddy-response-threads.json"
        )
        self._publish_catalogue()

    def _publish_catalogue(self) -> None:
        """Tell the admin console exactly what this image ships.

        Republished whenever the catalogue would differ, because a capability
        deployed after start-up is otherwise invisible to the console until the
        container happens to restart, and the console would keep offering a
        capability the runtime has already rejected.
        """
        try:
            catalogue = build_catalogue(self._base_settings, self._store).as_document()
        except Exception:  # noqa: BLE001 - publishing must never block a turn
            logger.warning("Could not build the capability catalogue", exc_info=True)
            return
        fingerprint = hashlib.sha256(
            json.dumps(catalogue, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if fingerprint == self._published_catalogue:
            return
        try:
            self._store.write(CATALOGUE_DOCUMENT, catalogue)
        except Exception:  # noqa: BLE001 - publishing must never block startup
            logger.warning("Could not publish the capability catalogue", exc_info=True)
            return
        self._published_catalogue = fingerprint

    def available_profiles(self) -> dict[str, AgentProfile]:
        return load_profiles(self._base_settings, self._store)

    def _resolve(self, requested: str | None) -> AgentProfile:
        return resolve_profile(self.available_profiles(), requested)

    def conversation_workspace(
        self, previous_response_id: str | None, response_id: str
    ) -> Path:
        """Where this conversation's files live.

        Resuming returns the directory the conversation already owns. A
        conversation bound before workspaces were separated has none, and keeps
        the shared root so the files it already wrote stay where it left them.
        """
        root = self._base_settings.workspace
        binding = self._thread_map.lookup(previous_response_id)
        if binding is not None:
            if not binding.workspace_id:
                return root
            return root / CONVERSATIONS_DIRECTORY / binding.workspace_id
        return root / CONVERSATIONS_DIRECTORY / _workspace_id(response_id)

    async def stream_turn(
        self,
        prompt: str,
        *,
        previous_response_id: str | None,
        response_id: str,
        cancellation_signal: asyncio.Event,
        model: str | None = None,
        profile: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[RuntimeEvent]:
        async with self._lock:
            binding = self._thread_map.lookup(previous_response_id)
            # A resumed conversation keeps the profile it was started with, and
            # a request that disagrees is reported rather than dropped: the
            # console used to show one agent while another one ran.
            requested = (profile or "").strip()
            bound = binding.profile if binding else ""
            active = self._resolve(bound or requested or None)
            status = "bound"
            if bound and requested and requested != bound:
                status = "contradicted"
                logger.warning(
                    "Turn requested profile %r but the conversation is bound to %r; "
                    "keeping the binding",
                    requested,
                    bound,
                )
            yield RuntimeEvent(
                PROFILE_EVENT,
                {
                    "profile": active.name,
                    "display_name": active.display_name or active.name,
                    "requested": requested,
                    "status": status,
                },
            )

            await self._ensure_started(active, reasoning_effort or "")

            workspace = self.conversation_workspace(previous_response_id, response_id)
            workspace.mkdir(parents=True, exist_ok=True)
            workspace_id = (
                "" if workspace == self._base_settings.workspace else workspace.name
            )

            thread_id = binding.thread_id if binding else None
            if thread_id:
                await self._resume_thread(thread_id, model, active, workspace)
            else:
                thread_id = await self._start_thread(model, active, workspace)
            self._thread_map.bind(response_id, thread_id, active.name, workspace_id)
            workspace_before = snapshot_workspace(workspace)

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
                message = await self._next_turn_message(cancellation_signal)
                if message is None:
                    return
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
                        break

            paths = changed_artifacts(workspace, workspace_before)
            if paths:
                data = await asyncio.to_thread(artifact_event_data, paths, self._store)
                yield RuntimeEvent(ARTIFACT_EVENT, data)

    async def _ensure_started(
        self, profile: AgentProfile, reasoning_effort: str = ""
    ) -> None:
        # Configuration is re-read at the turn boundary so administrator edits
        # take effect without redeploying, and the engine is restarted whenever
        # the rendered Codex configuration would differ.
        settings = apply_model_overrides(self._base_settings, self._store)
        fingerprint = runtime_fingerprint(
            settings, self._store, profile, reasoning_effort
        )
        # The catalogue is a function of the same inputs, so this is where a
        # capability deployed since start-up becomes visible to the console.
        self._publish_catalogue()
        running = self._process is not None and self._process.returncode is None
        if running and fingerprint == self._active_fingerprint:
            return
        if running:
            logger.info("Codex configuration changed; restarting the engine")
            await self._restart()
        elif self._process is not None:
            logger.warning("Codex process exited; starting a replacement")
            await self._restart()

        self._settings = settings
        environment = prepare_codex_environment(
            settings, self._store, profile, reasoning_effort
        )
        # Immediately before forking, in the process that will be the child's
        # parent. Hardening at import time is not enough: the server framework
        # replaces the process afterwards, and execve resets the flag, so the
        # child could read the parent environment holding the model key and
        # every resolved profile credential.
        harden_process()
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
        try:
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
        except Exception:
            await self._restart()
            raise
        self._active_fingerprint = fingerprint

    def _thread_params(
        self, model: str | None, profile: AgentProfile, workspace: Path
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": model or effective_model(self._settings, profile),
            "cwd": str(workspace),
            "approvalPolicy": self._settings.approval_policy,
            "sandbox": self._settings.sandbox,
            "baseInstructions": load_instructions(self._settings, profile),
        }
        if self._settings.model_endpoint:
            params["modelProvider"] = self._settings.model_provider
        return params

    async def _start_thread(
        self, model: str | None, profile: AgentProfile, workspace: Path
    ) -> str:
        params = self._thread_params(model, profile, workspace)
        result = await self._request("thread/start", params)
        thread = result.get("thread") if isinstance(result, dict) else None
        thread_id = thread.get("id") if isinstance(thread, dict) else None
        if not isinstance(thread_id, str) or not thread_id:
            raise CodexProtocolError("Codex thread/start returned no thread id")
        self._loaded_threads.add(thread_id)
        return thread_id

    async def _resume_thread(
        self,
        thread_id: str,
        model: str | None,
        profile: AgentProfile,
        workspace: Path,
    ) -> None:
        if thread_id in self._loaded_threads:
            return
        params = self._thread_params(model, profile, workspace)
        params["threadId"] = thread_id
        await self._request("thread/resume", params)
        self._loaded_threads.add(thread_id)

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        self._request_id += 1
        request_id = self._request_id
        await self._send({"method": method, "id": request_id, "params": params})
        while True:
            try:
                message = await asyncio.wait_for(
                    self._read_message(),
                    timeout=self._settings.protocol_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                timeout = self._settings.protocol_timeout_seconds
                await self._restart()
                raise CodexProtocolError(
                    f"{method} timed out after {timeout:g} seconds without a response"
                ) from exc
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

    async def _next_turn_message(
        self, cancellation_signal: asyncio.Event
    ) -> dict[str, Any] | None:
        if cancellation_signal.is_set():
            await self._restart()
            return None

        read_task = asyncio.create_task(self._read_message())
        cancellation_task = asyncio.create_task(cancellation_signal.wait())
        done, _ = await asyncio.wait(
            {read_task, cancellation_task},
            timeout=self._settings.turn_idle_timeout_seconds,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancellation_task in done and cancellation_signal.is_set():
            read_task.cancel()
            await asyncio.gather(read_task, return_exceptions=True)
            await self._restart()
            return None
        if read_task in done:
            cancellation_task.cancel()
            await asyncio.gather(cancellation_task, return_exceptions=True)
            return await read_task

        read_task.cancel()
        cancellation_task.cancel()
        await asyncio.gather(read_task, cancellation_task, return_exceptions=True)
        timeout = self._settings.turn_idle_timeout_seconds
        await self._restart()
        raise CodexProtocolError(
            f"Codex turn produced no events for {timeout:g} seconds"
        )

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
        method = str(message.get("method") or "")
        result = _server_request_result(method)
        if result is not None:
            await self._send({"id": message["id"], "result": result})
            return
        await self._send(
            {
                "id": message["id"],
                "error": {
                    "code": -32601,
                    "message": f"Unsupported Codex server request: {method or 'unknown'}",
                },
            }
        )

    async def _drain_stderr(self) -> None:
        """Record that Codex wrote to stderr, not what it wrote.

        Codex relays whatever a tool or MCP server printed, and a tool that
        prints a token would otherwise persist it in centralised logs, outliving
        the profile whose credential it was. The length is enough to correlate
        with a failure; the bytes are not ours to keep.
        """
        if not self._process or not self._process.stderr:
            return
        while line := await self._process.stderr.readline():
            logger.info("codex stderr: %d bytes", len(line))

    async def _restart(self) -> None:
        if self._process and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        stderr_task = self._stderr_task
        if stderr_task:
            stderr_task.cancel()
        self._process = None
        self._stderr_task = None
        self._active_fingerprint = None
        self._loaded_threads.clear()
        self._pending_notifications.clear()
        if stderr_task:
            await asyncio.gather(stderr_task, return_exceptions=True)
