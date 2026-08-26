"""Bridge Codex's stdio MCP transport to an Entra-protected HTTP server."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

URL_ENV = "MCP_HTTP_PROXY_URL"
SCOPE_ENV = "MCP_HTTP_PROXY_SCOPE"
TIMEOUT_ENV = "MCP_HTTP_PROXY_TIMEOUT_SECONDS"


class McpHttpProxy:
    def __init__(
        self,
        url: str,
        scope: str,
        *,
        credential: Any | None = None,
        opener: Any | None = None,
        timeout_seconds: float = 60,
    ):
        if not url.startswith("https://"):
            raise ValueError(f"{URL_ENV} must use HTTPS")
        self._url = url
        self._scope = scope
        self._credential = credential
        self._opener = opener or urllib.request.build_opener()
        self._timeout = max(float(timeout_seconds), 1)
        self._session_id = ""
        self._protocol_version = ""

    def _resolved_credential(self):
        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        return self._credential

    def _request(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self._scope:
            headers["Authorization"] = (
                f"Bearer {self._resolved_credential().get_token(self._scope).token}"
            )
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if self._protocol_version:
            headers["MCP-Protocol-Version"] = self._protocol_version
        request = urllib.request.Request(
            self._url,
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            response = self._opener.open(request, timeout=self._timeout)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error
        try:
            self._session_id = response.headers.get("Mcp-Session-Id", self._session_id)
            body = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
        finally:
            response.close()

        if not body.strip():
            return []
        if "text/event-stream" in content_type:
            events = []
            for block in body.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(
                    line[5:].lstrip()
                    for line in block.splitlines()
                    if line.startswith("data:")
                )
                if data and data != "[DONE]":
                    value = json.loads(data)
                    if isinstance(value, dict):
                        events.append(value)
            return events
        value = json.loads(body)
        return [value] if isinstance(value, dict) else []

    def exchange(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        responses = self._request(message)
        if message.get("method") == "initialize":
            for response in responses:
                result = response.get("result")
                if isinstance(result, dict):
                    version = result.get("protocolVersion")
                    if isinstance(version, str):
                        self._protocol_version = version
        return responses


def _error_response(message: dict[str, Any], error: Exception) -> dict[str, Any] | None:
    request_id = message.get("id")
    if request_id is None:
        return None
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": f"MCP HTTP proxy failed: {error}"},
    }


def main() -> int:
    proxy = McpHttpProxy(
        os.environ.get(URL_ENV, "").strip(),
        os.environ.get(SCOPE_ENV, "").strip(),
        timeout_seconds=float(os.environ.get(TIMEOUT_ENV, "60")),
    )
    for line in sys.stdin:
        message: dict[str, Any] = {}
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("MCP message must be a JSON object")
            message = value
            responses = proxy.exchange(message)
        except Exception as error:  # noqa: BLE001 - return JSON-RPC errors to Codex
            response = _error_response(message, error)
            responses = [response] if response else []
        for response in responses:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
