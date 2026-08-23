from __future__ import annotations

import argparse
import copy
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request


REQUIRED_QUESTION_PROMPT = (
    "Which of these best describes how AI agents are actually talked about by your leadership today?"
)
LOCAL_QUESTION_CHECK = (
    "import json; from pathlib import Path; "
    "question = json.loads(Path('/app/hosted-agent/skills/agent-maturity-assess/references/question-bank.json').read_text())"
    "['pillars'][0]['dimensions'][0]['qa']['prompt']['en']; print(question)"
)


class ReleaseError(RuntimeError):
    """Release orchestration failed."""


@dataclass(frozen=True, slots=True)
class ReleaseConfig:
    release_root: Path = Path(".azure/releases")
    account_name: str = "haxuaifoundryaiservice"
    project_name: str = "haxuaifoundryaiservice-agent"
    agent_name: str = "haeronclaw-codex"
    acr_name: str = "haxureg"
    hosted_image_repository: str = "digibuddy-skills"
    webui_image_repository: str = "haeronclaw-webui"
    webapp_name: str = "haeronclaw-haxu"
    webapp_resource_group: str = "rg-brand-intel"
    response_protocol: str = "responses"
    response_protocol_version: str = "2.0.0"
    source_kind: str = "hosted"
    source_status: str = "active"
    api_version: str = "v1"
    ai_resource: str = "https://ai.azure.com"
    default_model_name: str = "gpt-5.2-codex"
    local_agent_image: str = "digibuddy-skills:verify"
    local_agent_port: int = 18088
    local_agent_container_prefix: str = "release-hosted-agent"
    local_agent_readiness_path: str = "/readiness"
    webui_ready_path: str = "/"
    required_question_cursor: str = "A1.qa"
    required_question_prompt: str = REQUIRED_QUESTION_PROMPT

    @property
    def foundry_base_url(self) -> str:
        return (
            f"https://{self.account_name}.services.ai.azure.com/api/projects/"
            f"{self.project_name}"
        )

    def versions_url(self) -> str:
        return (
            f"{self.foundry_base_url}/agents/{self.agent_name}/versions"
            f"?api-version={self.api_version}"
        )

    def version_url(self, version_id: str) -> str:
        return (
            f"{self.foundry_base_url}/agents/{self.agent_name}/versions/{version_id}"
            f"?api-version={self.api_version}"
        )

    def responses_url(self) -> str:
        return (
            f"{self.foundry_base_url}/agents/{self.agent_name}/endpoint/"
            f"protocols/openai/responses?api-version={self.api_version}"
        )

    def hosted_image(self, tag: str) -> str:
        return f"{self.acr_name}.azurecr.io/{self.hosted_image_repository}:{tag}"

    def webui_image(self, tag: str) -> str:
        return f"{self.acr_name}.azurecr.io/{self.webui_image_repository}:{tag}"


CommandRunner = Callable[..., Any]
HttpClient = Callable[..., Any]


@dataclass(frozen=True, slots=True)
class ReleaseOptions:
    fast: bool = False
    build_only: bool = False
    skip_webui: bool = False
    reuse_tag: str | None = None
    activation_timeout_seconds: int = 600
    activation_poll_seconds: int = 10
    webui_timeout_seconds: int = 300


class ReleaseRunner:
    def __init__(
        self,
        *,
        config: ReleaseConfig | None = None,
        root: Path | str | None = None,
        command_runner: CommandRunner | None = None,
        http_client: HttpClient | None = None,
        clock: Callable[[], datetime] | None = None,
        sleep: Callable[[float], None] | None = None,
        fast: bool = False,
        build_only: bool = False,
        skip_webui: bool = False,
        reuse_tag: str | None = None,
        activation_timeout_seconds: int = 600,
        activation_poll_seconds: int = 10,
        webui_timeout_seconds: int = 300,
    ) -> None:
        self.config = config or ReleaseConfig()
        self.root = Path(root) if root is not None else Path.cwd()
        self.command_runner = command_runner or _run_subprocess
        self.http_client = http_client or _http_request
        self.clock = clock or _utc_now
        self.sleep = sleep or _sleep_seconds
        self.options = ReleaseOptions(
            fast=fast,
            build_only=build_only,
            skip_webui=skip_webui,
            reuse_tag=reuse_tag,
            activation_timeout_seconds=activation_timeout_seconds,
            activation_poll_seconds=activation_poll_seconds,
            webui_timeout_seconds=webui_timeout_seconds,
        )
        self._local_container_name: str | None = None
        self._image_tag: str | None = None

    def run(self) -> dict[str, object]:
        image_tag = self.options.reuse_tag or make_image_tag(
            self._git_head_sha(), self.clock()
        )
        self._image_tag = image_tag
        hosted_image = self.config.hosted_image(image_tag)
        webui_image = self.config.webui_image(image_tag)
        result: dict[str, object] = {
            "status": "released",
            "image_tag": image_tag,
        }
        try:
            self._ensure_clean_worktree()
            self._run_release_gates()
            if not self.options.fast:
                self._validate_local_agent_image()

            if self.options.reuse_tag:
                hosted_digest = self._acr_image_digest(
                    self.config.hosted_image_repository, image_tag
                )
            else:
                hosted_digest = self._build_acr_image(
                    repository=self.config.hosted_image_repository,
                    dockerfile="hosted-agent/Dockerfile",
                    working_directory=".",
                    tag=image_tag,
                )
            result["image_digest"] = hosted_digest

            webui_digest: str | None = None
            if not self.options.skip_webui:
                if self.options.reuse_tag:
                    webui_digest = self._acr_image_digest(
                        self.config.webui_image_repository, image_tag
                    )
                else:
                    webui_digest = self._build_acr_image(
                        repository=self.config.webui_image_repository,
                        dockerfile="Dockerfile",
                        working_directory="webui",
                        tag=image_tag,
                    )
                result["webui_image_digest"] = webui_digest

            if self.options.build_only:
                result["status"] = "build_only"
                return result

            token = self._azure_access_token()
            source_version = self._load_source_version(token)
            created_new_version = _version_image(source_version) != hosted_image
            if created_new_version:
                version_id = self._create_agent_version(
                    token, source_version, hosted_image
                )
            else:
                version_id = _version_identity(source_version)
                if not version_id:
                    raise ReleaseError(
                        "Existing active Agent image has no version identifier."
                    )
            try:
                if created_new_version:
                    self._wait_for_version_active(token, version_id)
                response_payload = self._verify_agent_endpoint(token, source_version)
            except Exception as exc:
                rollback_detail = (
                    self._delete_failed_version(token, version_id)
                    if created_new_version
                    else ""
                )
                message = str(exc)
                if rollback_detail:
                    message = f"{message} {rollback_detail}".strip()
                raise ReleaseError(message) from exc

            response_id = _string_value(response_payload.get("id"))
            result["version_id"] = version_id
            result["response_id"] = response_id

            webapp_host: str | None = None
            if not self.options.skip_webui:
                webapp_host = self._deploy_webui(webui_image, version_id)
                result["webapp_host"] = webapp_host

            receipt = release_receipt(
                config=self.config,
                image_tag=image_tag,
                image_digest=hosted_digest,
                version_id=version_id,
                response_id=response_id,
                released_at=self.clock(),
                source_version=source_version,
            )
            if webui_digest:
                receipt["webui_image_digest"] = webui_digest
            if webapp_host:
                receipt["webapp_host"] = webapp_host
            receipt_path = self._write_receipt(image_tag, receipt)
            result["receipt_path"] = str(receipt_path)
            return result
        finally:
            self._cleanup_local_container()

    def _ensure_clean_worktree(self) -> None:
        output = self._run_checked(["git", "status", "--porcelain"])
        if output.strip():
            raise ReleaseError("Release requires a clean committed worktree.")

    def _git_head_sha(self) -> str:
        sha = self._run_checked(["git", "rev-parse", "HEAD"]).strip()
        if len(sha) < 7:
            raise ReleaseError("Unable to determine a valid git commit SHA.")
        return sha

    def _run_release_gates(self) -> None:
        self._run_checked(["scripts/sync-agent-skills.sh", "--check"])
        self._run_checked(
            ["python", "-m", "unittest", "tests/test_release_hosted_agent.py"]
        )
        self._run_checked(
            ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
            cwd=self.root / "hosted-agent",
        )
        self._run_checked(["python", "hosted-agent/tests/probe_maturity_mcp.py"])
        self._run_checked(["npm", "test"], cwd=self.root / "webui")
        self._run_checked(["npm", "run", "lint"], cwd=self.root / "webui")
        self._run_checked(["npm", "run", "build"], cwd=self.root / "webui")

    def _validate_local_agent_image(self) -> None:
        self._run_checked(
            [
                "docker",
                "build",
                "-f",
                "hosted-agent/Dockerfile",
                "-t",
                self.config.local_agent_image,
                ".",
            ]
        )
        image_tag = self._image_tag or make_image_tag(self._git_head_sha(), self.clock())
        container_name = f"{self.config.local_agent_container_prefix}-{image_tag.lower()}"
        self._local_container_name = container_name
        self._run_checked(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                container_name,
                "-p",
                f"{self.config.local_agent_port}:8088",
                self.config.local_agent_image,
            ]
        )
        self._wait_for_http_ready(
            f"http://127.0.0.1:{self.config.local_agent_port}{self.config.local_agent_readiness_path}",
            timeout_seconds=self.options.activation_timeout_seconds,
            failure_message="Timed out waiting for the local Hosted Agent container readiness endpoint.",
        )
        node_version = self._run_checked(["docker", "exec", container_name, "node", "--version"]).strip()
        if not node_version.startswith("v22."):
            raise ReleaseError(f"Expected Node.js 22 in the local image, got {node_version or 'unknown'!r}.")
        prompt = self._run_checked(
            ["docker", "exec", container_name, "python", "-c", LOCAL_QUESTION_CHECK]
        ).strip()
        if self.config.required_question_prompt not in prompt:
            raise ReleaseError("Local Hosted Agent image is missing the required bundled maturity assets.")

    def _build_acr_image(
        self, *, repository: str, dockerfile: str, working_directory: str, tag: str
    ) -> str:
        self._run_checked(
            [
                "az",
                "acr",
                "build",
                "--registry",
                self.config.acr_name,
                "--image",
                f"{repository}:{tag}",
                "-f",
                dockerfile,
                ".",
            ],
            cwd=self.root / working_directory,
        )
        return self._acr_image_digest(repository, tag)

    def _acr_image_digest(self, repository: str, tag: str) -> str:
        metadata = self._command_json(
            [
                "az",
                "acr",
                "manifest",
                "show-metadata",
                "--registry",
                self.config.acr_name,
                "--name",
                f"{repository}:{tag}",
                "-o",
                "json",
            ]
        )
        digest = _string_value(metadata.get("digest"))
        if not digest:
            raise ReleaseError(f"ACR metadata for {repository}:{tag} did not contain a digest.")
        return digest

    def _azure_access_token(self) -> str:
        payload = self._command_json(
            [
                "az",
                "account",
                "get-access-token",
                "--resource",
                self.config.ai_resource,
                "-o",
                "json",
            ]
        )
        token = _string_value(payload.get("accessToken"))
        if not token:
            raise ReleaseError("Azure CLI did not return an access token for Foundry.")
        return token

    def _load_source_version(self, token: str) -> Mapping[str, Any]:
        payload = self._json_request("GET", self.config.versions_url(), token=token)
        versions = (
            payload.get("data", payload.get("value"))
            if isinstance(payload, Mapping)
            else payload
        )
        if not isinstance(versions, Sequence) or isinstance(versions, (str, bytes, bytearray)):
            raise ReleaseError("Foundry versions response did not contain a version list.")
        try:
            return select_source_version(versions)
        except ValueError as exc:
            raise ReleaseError(str(exc)) from exc

    def _create_agent_version(
        self,
        token: str,
        source_version: Mapping[str, Any],
        hosted_image: str,
    ) -> str:
        body = _clone_version_payload(source_version, hosted_image)
        created = self._json_request("POST", self.config.versions_url(), token=token, payload=body, expected_statuses=(200, 201))
        version_id = _version_identity(created)
        if not version_id:
            raise ReleaseError("Foundry did not return the new Hosted Agent version identifier.")
        return version_id

    def _wait_for_version_active(self, token: str, version_id: str) -> None:
        url = self.config.version_url(version_id)
        remaining = self.options.activation_timeout_seconds
        while True:
            payload = self._json_request("GET", url, token=token)
            status = _string_value(payload.get("status")).lower()
            if status == "active":
                return
            if status == "failed":
                raise ReleaseError(f"Agent version {version_id} provisioning failed.")
            if remaining <= self.options.activation_poll_seconds:
                break
            self.sleep(float(self.options.activation_poll_seconds))
            remaining -= self.options.activation_poll_seconds
        raise ReleaseError(f"Timed out waiting for Agent version {version_id} to become active.")

    def _verify_agent_endpoint(self, token: str, source_version: Mapping[str, Any]) -> Mapping[str, Any]:
        model_name = _environment_value(source_version, "CODEX_MODEL_NAME") or self.config.default_model_name
        prompt = (
            "Use the maturity_get_question tool with question_id A1 and lang en. "
            f"Reply with exactly '{self.config.required_question_cursor}: {self.config.required_question_prompt}'."
        )
        payload = self._json_request(
            "POST",
            self.config.responses_url(),
            token=token,
            payload={
                "model": model_name,
                "store": False,
                "stream": False,
                "input": prompt,
            },
        )
        output_text = extract_output_text(payload)
        if (
            self.config.required_question_cursor not in output_text
            or self.config.required_question_prompt not in output_text
        ):
            raise ReleaseError(
                f"Agent verification did not return the required {self.config.required_question_cursor} question."
            )
        return payload

    def _deploy_webui(self, new_image: str, agent_version: str) -> str:
        details = self._command_json(
            [
                "az",
                "webapp",
                "show",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "-o",
                "json",
            ]
        )
        host = _string_value(details.get("defaultHostName"))
        if not host:
            raise ReleaseError("Azure Web App response did not contain defaultHostName.")
        container_config = self._command_json(
            [
                "az",
                "webapp",
                "config",
                "container",
                "show",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "-o",
                "json",
            ]
        )
        previous_image = _extract_webapp_container_image(container_config)
        app_settings = self._command_json(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "list",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "-o",
                "json",
            ]
        )
        had_previous_version, previous_version = _app_setting(
            app_settings, "FOUNDRY_AGENT_VERSION"
        )
        try:
            self._set_webui_agent_version(agent_version)
            self._set_webui_image(new_image)
            self._restart_webapp()
            self._wait_for_http_ready(
                f"https://{host}{self.config.webui_ready_path}",
                timeout_seconds=self.options.webui_timeout_seconds,
                failure_message="Timed out waiting for the Web UI to become ready.",
            )
            self._verify_webui_agent(host)
        except Exception as exc:
            rollback_errors: list[str] = []
            restored_state = False
            if previous_image:
                try:
                    self._set_webui_image(previous_image)
                    restored_state = True
                except Exception as rollback_exc:
                    rollback_errors.append(f"image restore failed: {rollback_exc}")
            else:
                rollback_errors.append("previous Web UI image is unavailable")
            try:
                if had_previous_version:
                    self._set_webui_agent_version(previous_version)
                else:
                    self._delete_webui_agent_version()
                restored_state = True
            except Exception as rollback_exc:
                rollback_errors.append(f"Agent version restore failed: {rollback_exc}")
            if restored_state:
                try:
                    self._restart_webapp()
                except Exception as rollback_exc:
                    rollback_errors.append(f"Web App restart failed: {rollback_exc}")
            if previous_image and not rollback_errors:
                try:
                    self._wait_for_http_ready(
                        f"https://{host}{self.config.webui_ready_path}",
                        timeout_seconds=self.options.webui_timeout_seconds,
                        failure_message="Timed out waiting for the rolled back Web UI to recover.",
                    )
                except Exception as rollback_exc:
                    raise ReleaseError(
                        f"Web UI validation failed and rollback to {previous_image} also failed: {rollback_exc}"
                    ) from exc
                raise ReleaseError(
                    f"Web UI validation failed; rolled back to {previous_image}"
                ) from exc
            if rollback_errors:
                raise ReleaseError(
                    f"Web UI validation failed and rollback was incomplete: {'; '.join(rollback_errors)}"
                ) from exc
            raise
        return host

    def _set_webui_agent_version(self, version: str) -> None:
        self._run_checked(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "set",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "--settings",
                f"FOUNDRY_AGENT_VERSION={version}",
            ]
        )

    def _delete_webui_agent_version(self) -> None:
        self._run_checked(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "delete",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "--setting-names",
                "FOUNDRY_AGENT_VERSION",
            ]
        )

    def _set_webui_image(self, image: str) -> None:
        self._run_checked(
            [
                "az",
                "webapp",
                "config",
                "container",
                "set",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
                "--container-image-name",
                image,
            ]
        )

    def _restart_webapp(self) -> None:
        self._run_checked(
            [
                "az",
                "webapp",
                "restart",
                "--resource-group",
                self.config.webapp_resource_group,
                "--name",
                self.config.webapp_name,
            ]
        )

    def _verify_webui_agent(self, host: str) -> None:
        smoke_id = self._image_tag or "release"
        response = self.http_client(
            "POST",
            f"https://{host}/api/agent",
            headers={
                "Accept": "text/event-stream",
                "Content-Type": "application/json",
            },
            data=json.dumps(
                {
                    "threadId": f"release-{smoke_id}",
                    "runId": f"release-{smoke_id}",
                    "messages": [
                        {
                            "id": f"release-{smoke_id}",
                            "role": "user",
                            "content": "Reply with a brief confirmation that DigiBuddy is ready.",
                        }
                    ],
                    "state": {},
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                }
            ).encode("utf-8"),
            timeout=self.options.webui_timeout_seconds,
        )
        status = int(getattr(response, "status", 0) or 0)
        if not 200 <= status < 300:
            raise ReleaseError(
                f"Web UI Agent smoke test failed with HTTP {status}."
            )
        events = _sse_json_events(getattr(response, "body", b""))
        error_event = next(
            (event for event in events if event.get("type") == "RUN_ERROR"), None
        )
        if error_event is not None:
            message = _string_value(error_event.get("message")) or "unknown error"
            raise ReleaseError(f"Web UI Agent smoke test failed: {message}")
        finished = any(event.get("type") == "RUN_FINISHED" for event in events)
        output = "".join(
            _string_value(event.get("delta"))
            for event in events
            if event.get("type") == "TEXT_MESSAGE_CONTENT"
        )
        if not finished or not output:
            raise ReleaseError(
                "Web UI Agent smoke test returned no completed assistant response."
            )

    def _wait_for_http_ready(self, url: str, *, timeout_seconds: int, failure_message: str) -> None:
        remaining = timeout_seconds
        poll_seconds = max(1, min(self.options.activation_poll_seconds, timeout_seconds or 1))
        last_error: ReleaseError | None = None
        while True:
            try:
                response = self.http_client(
                    "GET",
                    url,
                    headers={"Accept": "application/json, text/plain, */*"},
                    timeout=timeout_seconds,
                )
            except ReleaseError as exc:
                last_error = exc
            else:
                status = int(getattr(response, "status", 0) or 0)
                if 200 <= status < 300:
                    return
                last_error = None
            if remaining <= poll_seconds:
                break
            self.sleep(float(poll_seconds))
            remaining -= poll_seconds
        if last_error is not None:
            raise ReleaseError(f"{failure_message} Last error: {last_error}") from last_error
        raise ReleaseError(failure_message)

    def _delete_failed_version(self, token: str, version_id: str) -> str:
        try:
            self._json_request("DELETE", self.config.version_url(version_id), token=token, expected_statuses=(200, 202, 204))
        except Exception as exc:
            return f"Cleanup could not delete the new Agent version {version_id}: {exc}"
        return ""

    def _write_receipt(self, image_tag: str, receipt: Mapping[str, Any]) -> Path:
        release_root = self.config.release_root
        if not release_root.is_absolute():
            release_root = self.root / release_root
        release_root.mkdir(parents=True, exist_ok=True)
        receipt_path = release_root / f"{image_tag}.json"
        receipt_path.write_text(json.dumps(dict(receipt), indent=2, sort_keys=True) + "\n")
        return receipt_path

    def _command_json(self, args: Sequence[str], *, cwd: Path | None = None) -> Any:
        output = self._run_checked(list(args), cwd=cwd)
        try:
            payload = json.loads(output)
        except json.JSONDecodeError as exc:
            raise ReleaseError(f"Command did not return valid JSON: {' '.join(args)}") from exc
        return payload

    def _json_request(
        self,
        method: str,
        url: str,
        *,
        token: str,
        payload: Mapping[str, Any] | None = None,
        expected_statuses: Sequence[int] = (200,),
    ) -> Mapping[str, Any]:
        data = None
        headers = {
            "Accept": "application/json",
            "Foundry-Features": "HostedAgents=V1Preview",
            "Authorization": f"Bearer {token}",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        response = self.http_client(method, url, headers=headers, data=data, timeout=self.options.activation_timeout_seconds)
        status = int(getattr(response, "status", 0) or 0)
        if status not in expected_statuses:
            text = _decode_body(getattr(response, "body", b""))
            raise ReleaseError(f"Foundry request {method} {url} failed with HTTP {status}: {text[:200]}")
        body = _decode_body(getattr(response, "body", b""))
        if not body:
            return {}
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ReleaseError(f"Foundry request {method} {url} returned non-JSON content.") from exc
        if not isinstance(parsed, Mapping):
            raise ReleaseError(f"Foundry request {method} {url} returned non-object JSON.")
        return parsed

    def _run_checked(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        input_text: str | None = None,
    ) -> str:
        completed = self.command_runner(args, cwd=cwd, env=dict(env or {}), input_text=input_text)
        returncode = int(getattr(completed, "returncode", 1))
        if returncode != 0:
            stderr = _string_value(getattr(completed, "stderr", ""))
            stdout = _string_value(getattr(completed, "stdout", ""))
            detail = stderr or stdout or f"exit code {returncode}"
            raise ReleaseError(f"Command failed ({' '.join(args)}): {detail}")
        stdout = getattr(completed, "stdout", "")
        return stdout if isinstance(stdout, str) else _decode_body(stdout)

    def _cleanup_local_container(self) -> None:
        if not self._local_container_name:
            return
        try:
            self._run_checked(["docker", "rm", "-f", self._local_container_name])
        except Exception:
            pass
        finally:
            self._local_container_name = None


def make_image_tag(sha: str, now: datetime) -> str:
    short_sha = sha.strip()[:7]
    timestamp = _ensure_utc(now).strftime("%Y%m%dT%H%M%SZ")
    return f"{short_sha}-{timestamp}"


def select_source_version(versions: Sequence[Mapping[str, Any]] | Sequence[Any]) -> Mapping[str, Any]:
    candidates: list[tuple[datetime, Mapping[str, Any]]] = []
    for version in versions:
        record = _as_mapping(version)
        if record is None:
            continue
        if not _is_valid_source_version(record):
            continue
        candidates.append((_version_timestamp(record), record))

    if not candidates:
        raise ValueError("No valid active hosted version with a Responses protocol entry was found.")

    return max(candidates, key=lambda item: item[0])[1]


def extract_output_text(payload: Any) -> str:
    if not payload or not isinstance(payload, Mapping):
        return ""

    response_text = payload.get("output_text")
    if isinstance(response_text, str):
        return response_text

    output = payload.get("output")
    if not isinstance(output, Sequence) or isinstance(output, (str, bytes, bytearray)):
        return ""

    parts: list[str] = []
    for item in output:
        if not isinstance(item, Mapping):
            continue
        content = item.get("content")
        if not isinstance(content, Sequence) or isinstance(content, (str, bytes, bytearray)):
            continue
        for entry in content:
            if isinstance(entry, Mapping):
                text = entry.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(entry, str):
                parts.append(entry)
    return "".join(parts)


def release_receipt(
    *,
    config: ReleaseConfig | None = None,
    image_tag: str,
    image_digest: str,
    version_id: str,
    response_id: str,
    released_at: datetime,
    source_version: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "image_tag": image_tag,
        "image_digest": image_digest,
        "version_id": version_id,
        "response_id": response_id,
        "released_at": _ensure_utc(released_at).isoformat().replace("+00:00", "Z"),
    }
    if source_version is not None:
        source_id = _version_identity(source_version)
        if source_id:
            receipt["source_version_id"] = source_id
    return receipt


def build_parser() -> argparse.ArgumentParser:
    defaults = ReleaseConfig()
    parser = argparse.ArgumentParser(description="Release the Hosted Agent and optional Web UI.")
    parser.add_argument("--fast", action="store_true", help="Skip local Docker validation but keep release gates.")
    parser.add_argument("--build-only", action="store_true", help="Build immutable ACR images and stop before Foundry or Web App rollout.")
    parser.add_argument("--skip-webui", action="store_true", help="Release only the Hosted Agent; skip the Web UI image and Web App rollout.")
    parser.add_argument("--reuse-tag", help="Reuse both existing ACR images from a prior interrupted release instead of rebuilding.")
    parser.add_argument("--release-root", default=str(defaults.release_root), help="Directory for non-secret release receipts.")
    parser.add_argument("--account-name", default=defaults.account_name)
    parser.add_argument("--project-name", default=defaults.project_name)
    parser.add_argument("--agent-name", default=defaults.agent_name)
    parser.add_argument("--acr-name", default=defaults.acr_name)
    parser.add_argument("--hosted-image-repository", default=defaults.hosted_image_repository)
    parser.add_argument("--webui-image-repository", default=defaults.webui_image_repository)
    parser.add_argument("--webapp-name", default=defaults.webapp_name)
    parser.add_argument("--webapp-resource-group", default=defaults.webapp_resource_group)
    parser.add_argument("--activation-timeout-seconds", type=int, default=600)
    parser.add_argument("--activation-poll-seconds", type=int, default=10)
    parser.add_argument("--webui-timeout-seconds", type=int, default=300)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = ReleaseConfig(
        release_root=Path(args.release_root),
        account_name=args.account_name,
        project_name=args.project_name,
        agent_name=args.agent_name,
        acr_name=args.acr_name,
        hosted_image_repository=args.hosted_image_repository,
        webui_image_repository=args.webui_image_repository,
        webapp_name=args.webapp_name,
        webapp_resource_group=args.webapp_resource_group,
    )
    runner = ReleaseRunner(
        config=config,
        fast=args.fast,
        build_only=args.build_only,
        skip_webui=args.skip_webui,
        reuse_tag=args.reuse_tag,
        activation_timeout_seconds=args.activation_timeout_seconds,
        activation_poll_seconds=args.activation_poll_seconds,
        webui_timeout_seconds=args.webui_timeout_seconds,
    )
    result = runner.run()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sleep_seconds(seconds: float) -> None:
    import time

    time.sleep(seconds)


def _run_subprocess(
    args: Sequence[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=str(cwd) if cwd is not None else None,
        env=None if not env else dict(env),
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def _http_request(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    data: bytes | None = None,
    timeout: int | float | None = None,
) -> Any:
    request = urllib_request.Request(url=url, data=data, headers=dict(headers or {}), method=method)
    try:
        with urllib_request.urlopen(request, timeout=timeout) as response:
            return _SimpleHttpResponse(
                status=int(getattr(response, "status", response.getcode())),
                body=response.read(),
                headers=dict(response.headers.items()),
            )
    except urllib_error.HTTPError as exc:
        return _SimpleHttpResponse(
            status=exc.code,
            body=exc.read(),
            headers=dict(exc.headers.items()),
        )
    except urllib_error.URLError as exc:
        raise ReleaseError(f"HTTP request failed for {url}: {exc.reason}") from exc


@dataclass(frozen=True, slots=True)
class _SimpleHttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str]


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    return None


def _string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _version_timestamp(version: Mapping[str, Any]) -> datetime:
    for key in ("created_at", "createdAt", "updated_at", "updatedAt"):
        raw = version.get(key)
        if isinstance(raw, datetime):
            return _ensure_utc(raw)
        if isinstance(raw, (int, float)):
            return datetime.fromtimestamp(raw, tz=timezone.utc)
        if isinstance(raw, str):
            parsed = _parse_datetime(raw)
            if parsed is not None:
                return parsed
    return datetime.min.replace(tzinfo=timezone.utc)


def _parse_datetime(value: str) -> datetime | None:
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _ensure_utc(parsed)


def _definition(version: Mapping[str, Any]) -> Mapping[str, Any]:
    nested = _as_mapping(version.get("definition"))
    return nested if nested is not None else version


def _is_valid_source_version(version: Mapping[str, Any]) -> bool:
    definition = _definition(version)
    if _string_value(definition.get("kind")) != "hosted":
        return False
    if _string_value(version.get("status")) != "active":
        return False

    container = _as_mapping(definition.get("container_configuration") or version.get("container_configuration"))
    if not container:
        return False
    if not _string_value(container.get("image")):
        return False

    protocols = definition.get("protocol_versions") or definition.get("protocols") or version.get("protocol_versions") or version.get("protocols")
    if not isinstance(protocols, Sequence) or isinstance(protocols, (str, bytes, bytearray)):
        return False
    for protocol in protocols:
        if not isinstance(protocol, Mapping):
            continue
        if _string_value(protocol.get("protocol")) == "responses":
            return True
    return False


def _version_identity(version: Mapping[str, Any]) -> str:
    for key in ("version", "id", "name"):
        value = _string_value(version.get(key))
        if value:
            return value
    return ""


def _clone_version_payload(source_version: Mapping[str, Any], hosted_image: str) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for key in ("description", "metadata", "blueprint_reference"):
        if key in source_version:
            body[key] = copy.deepcopy(source_version[key])
    definition = copy.deepcopy(dict(_definition(source_version)))
    container = _as_mapping(definition.get("container_configuration"))
    if container is None:
        raise ReleaseError("Source version is missing definition.container_configuration.")
    definition["container_configuration"] = dict(container)
    definition["container_configuration"]["image"] = hosted_image
    body["definition"] = definition
    return body


def _environment_value(version: Mapping[str, Any], name: str) -> str:
    definition = _definition(version)
    for key in ("environment_variables", "environmentVariables"):
        entries = definition.get(key)
        if isinstance(entries, Mapping):
            value = entries.get(name)
            if isinstance(value, str):
                return _string_value(value)
        if isinstance(entries, Sequence) and not isinstance(entries, (str, bytes, bytearray)):
            for entry in entries:
                if not isinstance(entry, Mapping):
                    continue
                if _string_value(entry.get("name")) == name:
                    return _string_value(entry.get("value"))
    environment = _as_mapping(definition.get("environment"))
    if environment and isinstance(environment.get(name), str):
        return _string_value(environment.get(name))
    return ""


def _version_image(version: Mapping[str, Any]) -> str:
    container = _as_mapping(_definition(version).get("container_configuration"))
    return _string_value(container.get("image")) if container else ""


def _extract_webapp_container_image(payload: Any) -> str:
    if isinstance(payload, Sequence) and not isinstance(
        payload, (str, bytes, bytearray)
    ):
        for entry in payload:
            if (
                isinstance(entry, Mapping)
                and entry.get("name") == "DOCKER_CUSTOM_IMAGE_NAME"
            ):
                return _extract_webapp_container_image(entry.get("value"))
        return ""
    if isinstance(payload, str):
        linux_fx = payload
    elif isinstance(payload, Mapping):
        linux_fx = _string_value(payload.get("DOCKER_CUSTOM_IMAGE_NAME"))
        if not linux_fx:
            site_config = _as_mapping(payload.get("siteConfig")) or {}
            linux_fx = _string_value(site_config.get("linuxFxVersion"))
    else:
        return ""
    prefix = "DOCKER|"
    if linux_fx.startswith(prefix):
        return linux_fx[len(prefix) :]
    return ""


def _app_setting(payload: Any, name: str) -> tuple[bool, str]:
    if isinstance(payload, Mapping):
        if name in payload:
            return True, _string_value(payload.get(name))
        return False, ""
    if isinstance(payload, Sequence) and not isinstance(
        payload, (str, bytes, bytearray)
    ):
        for entry in payload:
            if not isinstance(entry, Mapping):
                continue
            if _string_value(entry.get("name")) == name:
                return True, _string_value(entry.get("value"))
    return False, ""


def _sse_json_events(body: Any) -> list[Mapping[str, Any]]:
    text = _decode_body(body)
    events: list[Mapping[str, Any]] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(
            line[5:].lstrip()
            for line in block.splitlines()
            if line.startswith("data:")
        )
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(event, Mapping):
            events.append(event)
    return events


def _decode_body(body: Any) -> str:
    if isinstance(body, bytes):
        return body.decode("utf-8", errors="replace")
    if isinstance(body, str):
        return body
    return ""
