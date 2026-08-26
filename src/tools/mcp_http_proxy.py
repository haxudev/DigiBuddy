"""Bridge Codex's stdio MCP transport to an Entra-protected HTTP server."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

URL_ENV = "MCP_HTTP_PROXY_URL"
SCOPE_ENV = "MCP_HTTP_PROXY_SCOPE"
TIMEOUT_ENV = "MCP_HTTP_PROXY_TIMEOUT_SECONDS"
MAX_TEXT_ENV = "MCP_HTTP_PROXY_MAX_TEXT_CHARS"

#: A retrieval server answers with as much grounding as it found, and a broad
#: query against a real corpus can return hundreds of kilobytes in one result.
#: The hosted runtime fails the whole turn on a tool result that large -- the
#: caller gets `server_error` and no answer at all -- so an oversized result is
#: cut down to something the model can still read. Roughly 15k tokens of
#: grounding, which is far more than a turn needs and far less than it breaks
#: on.
DEFAULT_MAX_TEXT_CHARS = 60_000

#: Codex starts an MCP server once per session and drops it for good if the
#: handshake fails, so a transient fault is worth a second and third try.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 0.5
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class McpHttpProxy:
    def __init__(
        self,
        url: str,
        scope: str,
        *,
        credential: Any | None = None,
        opener: Any | None = None,
        timeout_seconds: float = 60,
        max_text_chars: int = DEFAULT_MAX_TEXT_CHARS,
        sleep: Any | None = None,
    ):
        if not url.startswith("https://"):
            raise ValueError(f"{URL_ENV} must use HTTPS")
        self._url = url
        self._scope = scope
        self._credential = credential
        self._opener = opener or urllib.request.build_opener()
        self._timeout = max(float(timeout_seconds), 1)
        self._max_text_chars = max(int(max_text_chars), 0)
        self._sleep = sleep or time.sleep
        self._session_id = ""
        self._protocol_version = ""

    def _resolved_credential(self):
        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        return self._credential

    def _open(self, request: Any) -> Any:
        """Send the request, retrying the failures that are worth retrying.

        Codex starts an MCP server once. A single timeout or 503 while the
        container is still warming up makes the handshake fail, Codex drops the
        server, and its tools are missing for the rest of the session -- which
        reads to the user as the agent ignoring its knowledge base. Retrying a
        transient failure here is far cheaper than losing the server.

        Retrying a POST is only safe because every catalogued server answers
        read-only queries; a server with side effects would need an idempotency
        key before it could be admitted.
        """
        last: Exception | None = None
        for attempt in range(RETRY_ATTEMPTS):
            try:
                return self._opener.open(request, timeout=self._timeout)
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:500]
                failure = RuntimeError(f"HTTP {error.code}: {detail}")
                # A refused or malformed request fails the same way every time;
                # only overload and server faults are worth another attempt.
                if error.code not in RETRYABLE_STATUS:
                    raise failure from error
                last = failure
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last = RuntimeError(f"{type(error).__name__}: {error}")
            if attempt + 1 < RETRY_ATTEMPTS:
                self._sleep(RETRY_BACKOFF_SECONDS * (2**attempt))
        raise last or RuntimeError("MCP request failed without a reason")

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
        response = self._open(request)
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

    def _clamp(self, response: dict[str, Any]) -> None:
        """Cut an oversized tool result down to a readable budget.

        Only `text` blocks are touched, and only past the budget, so a result
        that already fits is returned byte for byte. The marker tells the model
        the passage list was cut rather than exhausted, which is the difference
        between "no more matches" and "ask a narrower question".
        """
        if not self._max_text_chars:
            return
        result = response.get("result")
        if not isinstance(result, dict):
            return
        content = result.get("content")
        if not isinstance(content, list):
            return
        remaining = self._max_text_chars
        dropped = 0
        kept: list[Any] = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text":
                kept.append(block)
                continue
            text = block.get("text")
            if not isinstance(text, str):
                kept.append(block)
                continue
            if remaining <= 0:
                dropped += len(text)
                continue
            if len(text) > remaining:
                dropped += len(text) - remaining
                block["text"] = text[:remaining]
            remaining -= min(len(text), remaining)
            kept.append(block)
        if not dropped:
            return
        kept.append(
            {
                "type": "text",
                "text": (
                    f"[mcp_http_proxy truncated {dropped} characters: the "
                    "result exceeded what one turn can carry. Ask a narrower "
                    "question to see the rest.]"
                ),
            }
        )
        result["content"] = kept

    def exchange(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        responses = self._request(message)
        if message.get("method") == "initialize":
            for response in responses:
                result = response.get("result")
                if isinstance(result, dict):
                    version = result.get("protocolVersion")
                    if isinstance(version, str):
                        self._protocol_version = version
        elif message.get("method") == "tools/call":
            for response in responses:
                self._clamp(response)
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
        max_text_chars=int(
            os.environ.get(MAX_TEXT_ENV, "") or DEFAULT_MAX_TEXT_CHARS
        ),
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
