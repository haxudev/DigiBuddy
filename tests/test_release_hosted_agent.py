from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest

from scripts.release_hosted_agent import (
    _clone_version_payload,
    ReleaseConfig,
    ReleaseError,
    ReleaseRunner,
    build_parser,
    extract_output_text,
    make_image_tag,
    release_receipt,
    select_source_version,
)


QUESTION_PROMPT = (
    "Which of these best describes how AI agents are actually talked about by your leadership today?"
)
ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = ROOT / ".test-artifacts" / "release-hosted-agent"


class FakeCommandRunner:
    def __init__(self) -> None:
        self._responses: dict[tuple[str, ...], list[SimpleNamespace]] = {}
        self.calls: list[dict[str, object]] = []

    def add(
        self,
        args: list[str],
        *,
        stdout: str = "",
        stderr: str = "",
        returncode: int = 0,
    ) -> None:
        key = tuple(args)
        self._responses.setdefault(key, []).append(
            SimpleNamespace(
                args=tuple(args),
                returncode=returncode,
                stdout=stdout,
                stderr=stderr,
            )
        )

    def __call__(
        self,
        args: list[str],
        *,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        input_text: str | None = None,
    ) -> SimpleNamespace:
        key = tuple(args)
        self.calls.append(
            {
                "args": key,
                "cwd": str(cwd) if cwd is not None else None,
                "env": dict(env or {}),
                "input_text": input_text,
            }
        )
        queue = self._responses.get(key)
        if not queue:
            raise AssertionError(f"unexpected command: {args!r}")
        return queue.pop(0)

    def seen(self, prefix: tuple[str, ...]) -> bool:
        return any(call["args"][: len(prefix)] == prefix for call in self.calls)

    def count(self, prefix: tuple[str, ...]) -> int:
        return sum(1 for call in self.calls if call["args"][: len(prefix)] == prefix)


class FakeHttpClient:
    def __init__(self) -> None:
        self._responses: dict[tuple[str, str], list[object]] = {}
        self.calls: list[dict[str, object]] = []

    def add_json(self, method: str, url: str, payload: object, *, status: int = 200) -> None:
        self._responses.setdefault((method, url), []).append(
            SimpleNamespace(status=status, body=json.dumps(payload).encode("utf-8"), headers={})
        )

    def add_text(self, method: str, url: str, text: str, *, status: int = 200) -> None:
        self._responses.setdefault((method, url), []).append(
            SimpleNamespace(status=status, body=text.encode("utf-8"), headers={})
        )

    def add_error(self, method: str, url: str, error: Exception) -> None:
        self._responses.setdefault((method, url), []).append(error)

    def __call__(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        data: bytes | None = None,
        timeout: int | float | None = None,
    ) -> SimpleNamespace:
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers or {}),
                "data": data,
                "timeout": timeout,
            }
        )
        queue = self._responses.get((method, url))
        if not queue:
            raise AssertionError(f"unexpected HTTP request: {(method, url)!r}")
        response = queue.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def count(self, method: str, url: str) -> int:
        return sum(1 for call in self.calls if call["method"] == method and call["url"] == url)


class MakeImageTagTests(unittest.TestCase):
    def test_make_image_tag_uses_utc_time_and_short_sha(self) -> None:
        moment = datetime(2026, 8, 23, 20, 23, 33, tzinfo=timezone(timedelta(hours=8)))

        self.assertEqual(
            make_image_tag("abc1234deadbeef", moment),
            "abc1234-20260823T122333Z",
        )


class BuildParserTests(unittest.TestCase):
    def test_default_resource_arguments_are_concrete_values(self) -> None:
        args = build_parser().parse_args([])

        self.assertEqual(args.acr_name, "haxureg")
        self.assertEqual(args.agent_name, "haeronclaw-codex")
        self.assertEqual(args.release_root, ".azure/releases")


class SelectSourceVersionTests(unittest.TestCase):
    def test_select_source_version_skips_invalid_latest_and_picks_newest_valid(self) -> None:
        versions = [
            {
                "id": "older-valid",
                "created_at": "2026-08-22T10:00:00Z",
                "status": "active",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": "acr.example/digibuddy:old"},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                    "environment_variables": [{"name": "CODEX_MODEL_NAME", "value": "gpt-5.2-codex"}],
                },
            },
            {
                "id": "latest-invalid",
                "created_at": "2026-08-23T10:00:00Z",
                "status": "active",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": ""},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                },
            },
            {
                "id": "newest-valid",
                "created_at": "2026-08-23T11:00:00Z",
                "status": "active",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": "acr.example/digibuddy:new"},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                    "environment_variables": [{"name": "CODEX_MODEL_NAME", "value": "gpt-5.2-codex"}],
                },
            },
            {
                "id": "wrong-kind",
                "created_at": "2026-08-23T12:00:00Z",
                "status": "active",
                "definition": {
                    "kind": "managed",
                    "container_configuration": {"image": "acr.example/digibuddy:wrong"},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                },
            },
        ]

        selected = select_source_version(versions)

        self.assertEqual(selected["id"], "newest-valid")

    def test_select_source_version_rejects_when_no_valid_definition_exists(self) -> None:
        versions = [
            {
                "id": "bad-protocol",
                "created_at": "2026-08-23T10:00:00Z",
                "status": "active",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": "acr.example/digibuddy:bad"},
                    "protocol_versions": [{"protocol": "chat", "version": "1"}],
                },
            }
        ]

        with self.assertRaisesRegex(ValueError, "hosted"):
            select_source_version(versions)


class ExtractOutputTextTests(unittest.TestCase):
    def test_extract_output_text_concatenates_response_content(self) -> None:
        payload = {
            "output": [
                {"content": [{"text": "Hello, "}, {"text": ""}]},
                {"content": [{"text": "world"}, {"type": "input_text"}]},
            ]
        }

        self.assertEqual(extract_output_text(payload), "Hello, world")


class ReleaseReceiptTests(unittest.TestCase):
    def test_release_receipt_contains_release_metadata_without_environment_values(self) -> None:
        release_config = ReleaseConfig()
        receipt = release_receipt(
            config=release_config,
            image_tag="abc1234-20260823T122333Z",
            image_digest="sha256:beefcafe",
            version_id="version-42",
            response_id="response-99",
            released_at=datetime(2026, 8, 23, 12, 23, 33, tzinfo=timezone.utc),
        )

        self.assertEqual(receipt["image_digest"], "sha256:beefcafe")
        self.assertEqual(receipt["version_id"], "version-42")
        self.assertEqual(receipt["response_id"], "response-99")
        self.assertEqual(receipt["image_tag"], "abc1234-20260823T122333Z")
        self.assertNotIn("environment", {key.lower() for key in receipt})
        self.assertNotIn("env", {key.lower() for key in receipt})
        self.assertNotIn("environment_variables", {key.lower() for key in receipt})


class ReleaseRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)
        ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
        self.worktree = ARTIFACT_ROOT / "repo"
        self.worktree.mkdir(parents=True, exist_ok=True)
        self.commands = FakeCommandRunner()
        self.http = FakeHttpClient()
        self.sleep_calls: list[float] = []
        self.now = datetime(2026, 8, 23, 12, 45, 0, tzinfo=timezone.utc)
        self.config = ReleaseConfig(release_root=self.worktree / ".azure" / "releases")
        self.tag = "abc1234-20260823T124500Z"
        self.hosted_image = f"haxureg.azurecr.io/digibuddy-skills:{self.tag}"
        self.webui_image = f"haxureg.azurecr.io/haeronclaw-webui:{self.tag}"
        self.versions_url = (
            "https://haxuaifoundryaiservice.services.ai.azure.com/api/projects/"
            "haxuaifoundryaiservice-agent/agents/haeronclaw-codex/versions?api-version=v1"
        )
        self.version_url = (
            "https://haxuaifoundryaiservice.services.ai.azure.com/api/projects/"
            "haxuaifoundryaiservice-agent/agents/haeronclaw-codex/versions/7?api-version=v1"
        )
        self.responses_url = (
            "https://haxuaifoundryaiservice.services.ai.azure.com/api/projects/"
            "haxuaifoundryaiservice-agent/agents/haeronclaw-codex/endpoint/"
            "protocols/openai/responses?api-version=v1"
        )
        self.web_host = "haeronclaw-haxu.azurewebsites.net"
        self.web_url = f"https://{self.web_host}/"

    def tearDown(self) -> None:
        shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)

    def _runner(self, **overrides: object) -> ReleaseRunner:
        return ReleaseRunner(
            config=overrides.pop("config", self.config),
            root=overrides.pop("root", self.worktree),
            command_runner=overrides.pop("command_runner", self.commands),
            http_client=overrides.pop("http_client", self.http),
            clock=overrides.pop("clock", lambda: self.now),
            sleep=overrides.pop("sleep", self.sleep_calls.append),
            fast=overrides.pop("fast", False),
            build_only=overrides.pop("build_only", False),
            skip_webui=overrides.pop("skip_webui", False),
            activation_timeout_seconds=overrides.pop("activation_timeout_seconds", 30),
            activation_poll_seconds=overrides.pop("activation_poll_seconds", 5),
            webui_timeout_seconds=overrides.pop("webui_timeout_seconds", 15),
        )

    def _source_version(self) -> dict[str, object]:
        return {
            "id": "source-4",
            "version": "4",
            "created_at": "2026-08-23T10:00:00Z",
            "status": "active",
            "definition": {
                "kind": "hosted",
                "container_configuration": {"image": "haxureg.azurecr.io/digibuddy-skills:old"},
                "cpu": "2",
                "memory": "4Gi",
                "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                "environment_variables": {
                    "CODEX_MODEL_NAME": "gpt-5.6-luna",
                    "CODEX_MODEL_API_KEY": "super-secret",
                },
            },
        }

    def _add_common_local_commands(self, *, fast: bool = False) -> None:
        self.commands.add(["git", "status", "--porcelain"], stdout="")
        self.commands.add(["git", "rev-parse", "HEAD"], stdout="abc1234deadbeef\n")
        self.commands.add(["scripts/sync-agent-skills.sh", "--check"], stdout="ok\n")
        self.commands.add(
            ["python", "-m", "unittest", "tests/test_release_hosted_agent.py"],
            stdout="release tests ok\n",
        )
        self.commands.add(
            ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
            stdout="hosted ok\n",
        )
        self.commands.add(["python", "hosted-agent/tests/probe_maturity_mcp.py"], stdout="probe ok\n")
        self.commands.add(["npm", "test"], stdout="web tests ok\n")
        self.commands.add(["npm", "run", "lint"], stdout="web lint ok\n")
        self.commands.add(["npm", "run", "build"], stdout="web build ok\n")
        if not fast:
            self.commands.add(
                ["docker", "build", "-f", "hosted-agent/Dockerfile", "-t", "digibuddy-skills:verify", "."],
                stdout="built\n",
            )
            self.commands.add(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--name",
                    "release-hosted-agent-abc1234-20260823t124500z",
                    "-p",
                    "18088:8088",
                    "digibuddy-skills:verify",
                ],
                stdout="container-123\n",
            )
            self.commands.add(
                ["docker", "exec", "release-hosted-agent-abc1234-20260823t124500z", "node", "--version"],
                stdout="v22.14.0\n",
            )
            self.commands.add(
                [
                    "docker",
                    "exec",
                    "release-hosted-agent-abc1234-20260823t124500z",
                    "python",
                    "-c",
                    (
                        "import json; from pathlib import Path; "
                        "question = json.loads(Path('/app/hosted-agent/skills/agent-maturity-assess/references/question-bank.json').read_text())"
                        "['pillars'][0]['dimensions'][0]['qa']['prompt']['en']; print(question)"
                    ),
                ],
                stdout=f"{QUESTION_PROMPT}\n",
            )
            self.commands.add(
                ["docker", "rm", "-f", "release-hosted-agent-abc1234-20260823t124500z"],
                stdout="removed\n",
            )

    def _add_common_remote_commands(self, *, include_webui: bool = True) -> None:
        self.commands.add(
            ["az", "account", "get-access-token", "--resource", "https://ai.azure.com", "-o", "json"],
            stdout=json.dumps({"accessToken": "token-123"}),
        )
        self.commands.add(
            [
                "az",
                "acr",
                "build",
                "--registry",
                "haxureg",
                "--image",
                f"digibuddy-skills:{self.tag}",
                "-f",
                "hosted-agent/Dockerfile",
                ".",
            ],
            stdout="hosted build ok\n",
        )
        self.commands.add(
            [
                "az",
                "acr",
                "manifest",
                "show-metadata",
                "--registry",
                "haxureg",
                "--name",
                f"digibuddy-skills:{self.tag}",
                "-o",
                "json",
            ],
            stdout=json.dumps({"digest": "sha256:hosted"}),
        )
        if include_webui:
            self.commands.add(
                [
                    "az",
                    "acr",
                    "build",
                    "--registry",
                    "haxureg",
                    "--image",
                    f"haeronclaw-webui:{self.tag}",
                    "-f",
                    "Dockerfile",
                    ".",
                ],
                stdout="webui build ok\n",
            )
            self.commands.add(
                [
                    "az",
                    "acr",
                    "manifest",
                    "show-metadata",
                    "--registry",
                    "haxureg",
                    "--name",
                    f"haeronclaw-webui:{self.tag}",
                    "-o",
                    "json",
                ],
                stdout=json.dumps({"digest": "sha256:webui"}),
            )

    def _add_common_http(self) -> None:
        self.http.add_json("GET", self.versions_url, {"data": [self._source_version()]})
        self.http.add_json(
            "POST",
            self.versions_url,
            {
                "id": "new-7",
                "version": "7",
                "status": "creating",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": self.hosted_image},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                },
            },
            status=201,
        )
        self.http.add_json("GET", self.version_url, {"version": "7", "status": "creating"})
        self.http.add_json(
            "GET",
            self.version_url,
            {
                "version": "7",
                "status": "active",
                "definition": {
                    "kind": "hosted",
                    "container_configuration": {"image": self.hosted_image},
                    "protocol_versions": [{"protocol": "responses", "version": "2.0.0"}],
                },
            },
        )
        self.http.add_json(
            "POST",
            self.responses_url,
            {
                "id": "response-99",
                "output": [{"content": [{"text": f"A1.qa: {QUESTION_PROMPT}"}]}],
            },
        )

    def test_run_happy_path_writes_receipt_and_preserves_webui_flow(self) -> None:
        self._add_common_local_commands()
        self._add_common_remote_commands()
        self._add_common_http()
        self.commands.add(
            ["az", "webapp", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps({"defaultHostName": self.web_host}),
        )
        self.commands.add(
            ["az", "webapp", "config", "container", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps(
                [
                    {
                        "name": "DOCKER_CUSTOM_IMAGE_NAME",
                        "value": "DOCKER|haxureg.azurecr.io/haeronclaw-webui:old",
                    }
                ]
            ),
        )
        self.commands.add(
            ["az", "webapp", "config", "appsettings", "list", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps(
                [{"name": "FOUNDRY_AGENT_VERSION", "value": "4"}]
            ),
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--settings",
                "FOUNDRY_AGENT_VERSION=7",
            ],
            stdout="version updated\n",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "container",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--container-image-name",
                self.webui_image,
            ],
            stdout="updated\n",
        )
        self.commands.add(
            ["az", "webapp", "restart", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu"],
            stdout="restarted\n",
        )
        self.http.add_text("GET", "http://127.0.0.1:18088/readiness", "ok")
        self.http.add_error("GET", self.web_url, ReleaseError("transient network failure"))
        self.http.add_text("GET", self.web_url, "ready")
        self.http.add_text(
            "POST",
            f"https://{self.web_host}/api/agent",
            (
                'data: {"type":"RUN_STARTED"}\n\n'
                'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"ready"}\n\n'
                'data: {"type":"RUN_FINISHED"}\n\n'
            ),
        )

        result = self._runner().run()

        self.assertEqual(result["image_tag"], self.tag)
        self.assertEqual(result["image_digest"], "sha256:hosted")
        self.assertEqual(result["webui_image_digest"], "sha256:webui")
        self.assertEqual(result["version_id"], "7")
        self.assertEqual(result["response_id"], "response-99")
        self.assertEqual(result["webapp_host"], self.web_host)
        receipt_path = Path(result["receipt_path"])
        self.assertTrue(receipt_path.exists())
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(receipt["webapp_host"], self.web_host)
        self.assertNotIn("super-secret", receipt_path.read_text())
        self.assertTrue(
            self.commands.seen(("az", "webapp", "config", "container")),
            "expected a Web App image update command",
        )
        self.assertEqual(
            next(
                call["cwd"]
                for call in self.commands.calls
                if call["args"][:5]
                == ("az", "acr", "build", "--registry", "haxureg")
                and f"haeronclaw-webui:{self.tag}" in call["args"]
            ),
            str(self.worktree / "webui"),
        )
        self.assertTrue(
            self.commands.seen(("az", "webapp", "config", "container", "show")),
            "expected rollback image lookup from webapp container config",
        )
        self.assertTrue(
            self.commands.seen(("az", "webapp", "config", "appsettings", "list"))
        )
        self.assertTrue(
            self.commands.seen(("az", "webapp", "config", "appsettings", "set"))
        )
        self.assertLess(
            next(i for i, call in enumerate(self.http.calls) if call["method"] == "POST" and call["url"] == self.responses_url),
            next(i for i, call in enumerate(self.http.calls) if call["method"] == "GET" and call["url"] == self.web_url),
        )
        self.assertEqual(self.sleep_calls, [5, 5])
        request_body = json.loads(
            next(call for call in self.http.calls if call["method"] == "POST" and call["url"] == self.responses_url)["data"].decode("utf-8")
        )
        auth_header = next(
            call["headers"]["Authorization"]
            for call in self.http.calls
            if call["method"] == "POST" and call["url"] == self.responses_url
        )
        self.assertEqual(auth_header, "Bearer token-123")
        self.assertEqual(
            next(
                call["headers"]["Foundry-Features"]
                for call in self.http.calls
                if call["method"] == "POST" and call["url"] == self.responses_url
            ),
            "HostedAgents=V1Preview",
        )
        self.assertIn("A1.qa", request_body["input"])
        self.assertIn("maturity_get_question", request_body["input"])
        self.assertEqual(request_body["model"], "gpt-5.6-luna")

    def test_fast_mode_skips_local_container_validation(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands(include_webui=False)
        self._add_common_http()

        result = self._runner(fast=True, skip_webui=True).run()

        self.assertEqual(result["version_id"], "7")
        self.assertFalse(self.commands.seen(("docker", "build")))
        self.assertFalse(self.commands.seen(("docker", "run")))
        self.assertFalse(self.commands.seen(("docker", "rm")))

    def test_build_only_stops_after_digests(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands()

        result = self._runner(fast=True, build_only=True).run()

        self.assertEqual(result["status"], "build_only")
        self.assertEqual(result["image_digest"], "sha256:hosted")
        self.assertEqual(result["webui_image_digest"], "sha256:webui")
        self.assertEqual(self.http.calls, [])
        self.assertFalse(self.commands.seen(("az", "webapp", "show")))

    def test_skip_webui_avoids_webui_build_and_rollout(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands(include_webui=False)
        self._add_common_http()

        result = self._runner(fast=True, skip_webui=True).run()

        self.assertEqual(result["status"], "released")
        self.assertNotIn("webui_image_digest", result)
        self.assertFalse(self.commands.seen(("az", "acr", "build", "--registry", "haxureg", "--image", f"haeronclaw-webui:{self.tag}")))
        self.assertFalse(self.commands.seen(("az", "webapp", "show")))

    def test_webui_agent_smoke_test_surfaces_proxy_failures(self) -> None:
        self.http.add_text(
            "POST",
            f"https://{self.web_host}/api/agent",
            (
                'data: {"type":"RUN_STARTED"}\n\n'
                'data: {"type":"RUN_ERROR","message":"Agent version is not configured"}\n\n'
            ),
        )

        with self.assertRaisesRegex(ReleaseError, "Agent version is not configured"):
            self._runner(fast=True)._verify_webui_agent(self.web_host)

    def test_missing_previous_image_still_restores_version_and_restarts(self) -> None:
        self.commands.add(
            ["az", "webapp", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps({"defaultHostName": self.web_host}),
        )
        self.commands.add(
            ["az", "webapp", "config", "container", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout="[]",
        )
        self.commands.add(
            ["az", "webapp", "config", "appsettings", "list", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout="[]",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--settings",
                "FOUNDRY_AGENT_VERSION=7",
            ],
            stdout="version updated\n",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "container",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--container-image-name",
                self.webui_image,
            ],
            stdout="updated\n",
        )
        restart = [
            "az",
            "webapp",
            "restart",
            "--resource-group",
            "rg-brand-intel",
            "--name",
            "haeronclaw-haxu",
        ]
        self.commands.add(restart, stdout="restarted\n")
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "delete",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--setting-names",
                "FOUNDRY_AGENT_VERSION",
            ],
            stdout="version restored\n",
        )
        self.commands.add(restart, stdout="restarted after restore\n")
        self.http.add_text("GET", self.web_url, "not ready", status=503)

        with self.assertRaisesRegex(ReleaseError, "previous Web UI image is unavailable"):
            self._runner(
                fast=True, webui_timeout_seconds=1
            )._deploy_webui(self.webui_image, "7")

        self.assertEqual(
            self.commands.count(("az", "webapp", "restart")),
            2,
        )
        self.assertTrue(
            self.commands.seen(("az", "webapp", "config", "appsettings", "delete"))
        )

    def test_activation_wait_is_bounded(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands(include_webui=False)
        self.commands.add(
            ["az", "account", "get-access-token", "--resource", "https://ai.azure.com", "-o", "json"],
            stdout=json.dumps({"accessToken": "token-123"}),
        )
        self.http.add_json("GET", self.versions_url, {"value": [self._source_version()]})
        self.http.add_json(
            "POST",
            self.versions_url,
            {"id": "new-7", "version": "7", "status": "creating", "definition": self._source_version()["definition"]},
            status=201,
        )
        self.http.add_json("GET", self.version_url, {"version": "7", "status": "creating"})
        self.http.add_json("GET", self.version_url, {"version": "7", "status": "creating"})
        self.http.add_json("GET", self.version_url, {"version": "7", "status": "creating"})
        self.http.add_json("DELETE", self.version_url, {"status": "deleted"}, status=200)

        with self.assertRaisesRegex(ReleaseError, "Timed out waiting for Agent version 7"):
            self._runner(fast=True, skip_webui=True, activation_timeout_seconds=11, activation_poll_seconds=5).run()

        self.assertEqual(self.http.count("GET", self.version_url), 3)
        self.assertEqual(self.sleep_calls, [5, 5])
        self.assertEqual(self.http.count("DELETE", self.version_url), 1)

    def test_failed_agent_gate_deletes_only_the_new_version(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands(include_webui=False)
        self.http.add_json("GET", self.versions_url, {"value": [self._source_version()]})
        self.http.add_json(
            "POST",
            self.versions_url,
            {"id": "new-7", "version": "7", "status": "creating", "definition": self._source_version()["definition"]},
            status=201,
        )
        self.http.add_json("GET", self.version_url, {"version": "7", "status": "active", "definition": self._source_version()["definition"]})
        self.http.add_json(
            "POST",
            self.responses_url,
            {"id": "response-99", "output": [{"content": [{"text": "wrong question"}]}]},
        )
        self.http.add_json("DELETE", self.version_url, {"status": "deleted"}, status=200)

        with self.assertRaisesRegex(ReleaseError, r"A1\.qa"):
            self._runner(fast=True, skip_webui=True).run()

        delete_calls = [call for call in self.http.calls if call["method"] == "DELETE"]
        self.assertEqual([call["url"] for call in delete_calls], [self.version_url])
        self.assertNotIn("source-4", "\n".join(call["url"] for call in delete_calls))

    def test_webui_readiness_failure_rolls_back_previous_image(self) -> None:
        self._add_common_local_commands(fast=True)
        self._add_common_remote_commands()
        self._add_common_http()
        self.commands.add(
            ["az", "webapp", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps({"defaultHostName": self.web_host}),
        )
        self.commands.add(
            ["az", "webapp", "config", "container", "show", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps(
                [
                    {
                        "name": "DOCKER_CUSTOM_IMAGE_NAME",
                        "value": "DOCKER|haxureg.azurecr.io/haeronclaw-webui:old",
                    }
                ]
            ),
        )
        self.commands.add(
            ["az", "webapp", "config", "appsettings", "list", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu", "-o", "json"],
            stdout=json.dumps(
                [{"name": "FOUNDRY_AGENT_VERSION", "value": "4"}]
            ),
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--settings",
                "FOUNDRY_AGENT_VERSION=7",
            ],
            stdout="version updated\n",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "container",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--container-image-name",
                self.webui_image,
            ],
            stdout="updated\n",
        )
        self.commands.add(
            ["az", "webapp", "restart", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu"],
            stdout="restarted\n",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "container",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--container-image-name",
                "haxureg.azurecr.io/haeronclaw-webui:old",
            ],
            stdout="rolled back\n",
        )
        self.commands.add(
            [
                "az",
                "webapp",
                "config",
                "appsettings",
                "set",
                "--resource-group",
                "rg-brand-intel",
                "--name",
                "haeronclaw-haxu",
                "--settings",
                "FOUNDRY_AGENT_VERSION=4",
            ],
            stdout="version rolled back\n",
        )
        self.commands.add(
            ["az", "webapp", "restart", "--resource-group", "rg-brand-intel", "--name", "haeronclaw-haxu"],
            stdout="restarted rollback\n",
        )
        self.http.add_text("GET", self.web_url, "still failing", status=503)
        self.http.add_text("GET", self.web_url, "still failing", status=503)
        self.http.add_text("GET", self.web_url, "recovered", status=200)

        with self.assertRaisesRegex(ReleaseError, "rolled back"):
            self._runner(fast=True, webui_timeout_seconds=6).run()

        container_updates = [
            call["args"][-1]
            for call in self.commands.calls
            if call["args"][:5] == ("az", "webapp", "config", "container", "set")
        ]
        self.assertEqual(
            container_updates,
            [self.webui_image, "haxureg.azurecr.io/haeronclaw-webui:old"],
        )
        version_updates = [
            call["args"][-1]
            for call in self.commands.calls
            if call["args"][:5]
            == ("az", "webapp", "config", "appsettings", "set")
        ]
        self.assertEqual(
            version_updates,
            ["FOUNDRY_AGENT_VERSION=7", "FOUNDRY_AGENT_VERSION=4"],
        )


if __name__ == "__main__":
    unittest.main()


class RetiredEnvironmentTests(unittest.TestCase):
    """A cloned version must not carry a secret the runtime no longer reads."""

    def test_a_retired_variable_is_dropped_from_a_cloned_version(self) -> None:
        source = {
            "definition": {
                "container_configuration": {"image": "old"},
                "environment_variables": {
                    "CODEX_MODEL_NAME": "gpt-5.2-codex",
                    "DIGIBUDDY_GRAPH_CLIENT_SECRET": "retired-secret",
                },
            }
        }

        body = _clone_version_payload(source, "new-image")

        environment = body["definition"]["environment_variables"]
        self.assertEqual(environment["CODEX_MODEL_NAME"], "gpt-5.2-codex")
        self.assertNotIn("DIGIBUDDY_GRAPH_CLIENT_SECRET", environment)

    def test_the_list_form_is_scrubbed_too(self) -> None:
        source = {
            "definition": {
                "container_configuration": {"image": "old"},
                "environmentVariables": [
                    {"name": "CODEX_MODEL_NAME", "value": "gpt-5.2-codex"},
                    {"name": "DIGIBUDDY_GRAPH_CLIENT_SECRET", "value": "retired"},
                ],
            }
        }

        body = _clone_version_payload(source, "new-image")

        names = [
            entry["name"] for entry in body["definition"]["environmentVariables"]
        ]
        self.assertEqual(names, ["CODEX_MODEL_NAME"])

    def test_a_kill_switch_is_carried_forward_deliberately(self) -> None:
        # Feature flags are deployment state, not secrets: a release must not
        # silently turn a feature off by forgetting it.
        source = {
            "definition": {
                "container_configuration": {"image": "old"},
                "environment_variables": {
                    "DIGIBUDDY_ENABLE_CAPABILITY_PACKS": "true",
                    "DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS": "true",
                },
            }
        }

        environment = _clone_version_payload(source, "new")["definition"][
            "environment_variables"
        ]

        self.assertEqual(environment["DIGIBUDDY_ENABLE_CAPABILITY_PACKS"], "true")
        self.assertEqual(environment["DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS"], "true")
