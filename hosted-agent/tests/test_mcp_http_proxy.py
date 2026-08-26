import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace


MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "src" / "tools" / "mcp_http_proxy.py"
)
SPEC = importlib.util.spec_from_file_location("mcp_http_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
mcp_http_proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mcp_http_proxy)


class FakeCredential:
    def __init__(self):
        self.scopes = []

    def get_token(self, scope):
        self.scopes.append(scope)
        return SimpleNamespace(token="token")


class FakeResponse:
    def __init__(self, body, headers):
        self._body = body
        self.headers = headers

    def read(self):
        return self._body

    def close(self):
        pass


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return self.responses.pop(0)


class McpHttpProxyTests(unittest.TestCase):
    def test_initialize_tracks_session_and_protocol_for_later_calls(self):
        credential = FakeCredential()
        opener = FakeOpener(
            [
                FakeResponse(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": {"protocolVersion": "2025-03-26"},
                        }
                    ).encode(),
                    {
                        "Content-Type": "application/json",
                        "Mcp-Session-Id": "session-1",
                    },
                ),
                FakeResponse(
                    b'{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
                    {"Content-Type": "application/json"},
                ),
            ]
        )
        proxy = mcp_http_proxy.McpHttpProxy(
            "https://mcp.example/mcp",
            "api://mcp/.default",
            credential=credential,
            opener=opener,
        )

        proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        response = proxy.exchange({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})

        self.assertEqual(response[0]["result"], {"tools": []})
        second = opener.requests[1][0]
        self.assertEqual(second.get_header("Mcp-session-id"), "session-1")
        self.assertEqual(second.get_header("Mcp-protocol-version"), "2025-03-26")
        self.assertEqual(credential.scopes, ["api://mcp/.default"] * 2)

    def test_streamable_http_sse_is_translated_to_stdio_messages(self):
        opener = FakeOpener(
            [
                FakeResponse(
                    (
                        'event: message\n'
                        'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'
                    ).encode(),
                    {"Content-Type": "text/event-stream"},
                )
            ]
        )
        proxy = mcp_http_proxy.McpHttpProxy(
            "https://mcp.example/mcp",
            "api://mcp/.default",
            credential=FakeCredential(),
            opener=opener,
        )

        response = proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

        self.assertEqual(response[0]["result"], {"tools": []})


if __name__ == "__main__":
    unittest.main()


class AnonymousEndpointTests(unittest.TestCase):
    """A public MCP server has no audience to mint a token for."""

    def _proxy(self, opener, credential):
        return mcp_http_proxy.McpHttpProxy(
            "https://learn.microsoft.com/api/mcp",
            "",
            credential=credential,
            opener=opener,
        )

    def test_an_empty_scope_sends_no_authorization_header(self):
        opener = FakeOpener(
            [
                FakeResponse(
                    b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
                    {"Content-Type": "application/json"},
                )
            ]
        )
        credential = FakeCredential()

        self._proxy(opener, credential).exchange(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )

        request = opener.requests[0][0]
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(credential.scopes, [])

    def test_plaintext_is_still_refused(self):
        with self.assertRaises(ValueError):
            mcp_http_proxy.McpHttpProxy("http://learn.microsoft.com/api/mcp", "")


class OversizedResultTests(unittest.TestCase):
    """The runtime fails the whole turn on a tool result it cannot carry.

    A broad retrieval against a real corpus returns hundreds of kilobytes, and
    the caller then gets `server_error` instead of an answer. Truncated
    grounding beats no answer.
    """

    def _call(self, content, **overrides):
        opener = FakeOpener(
            [
                FakeResponse(
                    json.dumps(
                        {"jsonrpc": "2.0", "id": 1, "result": {"content": content}}
                    ).encode(),
                    {"Content-Type": "application/json"},
                )
            ]
        )
        proxy = mcp_http_proxy.McpHttpProxy(
            "https://mcp.example/mcp",
            "api://mcp/.default",
            credential=FakeCredential(),
            opener=opener,
            **overrides,
        )
        response = proxy.exchange(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call"}
        )
        return response[0]["result"]["content"]

    def test_a_result_within_budget_is_untouched(self):
        content = [{"type": "text", "text": "x" * 100}]

        self.assertEqual(self._call(content, max_text_chars=100), content)

    def test_an_oversized_result_is_cut_and_says_so(self):
        blocks = self._call(
            [
                {"type": "text", "text": "a" * 60},
                {"type": "text", "text": "b" * 40},
            ],
            max_text_chars=50,
        )

        self.assertEqual(blocks[0]["text"], "a" * 50)
        # The second block is dropped rather than emptied, and both its
        # characters and the first block's overflow are accounted for.
        self.assertIn("truncated 50 characters", blocks[-1]["text"])
        self.assertEqual(len(blocks), 2)

    def test_non_text_blocks_survive_the_cut(self):
        blocks = self._call(
            [
                {"type": "text", "text": "a" * 60},
                {"type": "resource", "resource": {"uri": "x://y"}},
            ],
            max_text_chars=10,
        )

        self.assertIn({"type": "resource", "resource": {"uri": "x://y"}}, blocks)

    def test_a_disabled_budget_carries_everything(self):
        content = [{"type": "text", "text": "a" * 5000}]

        self.assertEqual(self._call(content, max_text_chars=0), content)

    def test_other_methods_are_never_rewritten(self):
        opener = FakeOpener(
            [
                FakeResponse(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": {
                                "content": [{"type": "text", "text": "a" * 500}]
                            },
                        }
                    ).encode(),
                    {"Content-Type": "application/json"},
                )
            ]
        )
        proxy = mcp_http_proxy.McpHttpProxy(
            "https://mcp.example/mcp",
            "api://mcp/.default",
            credential=FakeCredential(),
            opener=opener,
            max_text_chars=10,
        )

        response = proxy.exchange(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )

        self.assertEqual(len(response[0]["result"]["content"][0]["text"]), 500)


class FlakyOpener:
    """Fails the first `failures` attempts, then answers."""

    def __init__(self, failures, response):
        self._failures = list(failures)
        self._response = response
        self.attempts = 0

    def open(self, request, timeout):
        self.attempts += 1
        if self._failures:
            raise self._failures.pop(0)
        return self._response


def http_error(code, body=b"upstream is busy"):
    return urllib.error.HTTPError(
        "https://mcp.example/mcp", code, "boom", {}, io.BytesIO(body)
    )


class TransientFailureTests(unittest.TestCase):
    """Codex starts an MCP server once and drops it for good if it fails.

    A single timeout while the container is warming up therefore costs the
    knowledge base for the rest of the session, which reads to the user as the
    agent ignoring it.
    """

    def _proxy(self, opener, **overrides):
        slept: list[float] = []
        proxy = mcp_http_proxy.McpHttpProxy(
            "https://mcp.example/mcp",
            "api://mcp/.default",
            credential=FakeCredential(),
            opener=opener,
            sleep=slept.append,
            **overrides,
        )
        return proxy, slept

    def _ok(self):
        return FakeResponse(
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}).encode(),
            {"Content-Type": "application/json"},
        )

    def test_a_handshake_survives_a_server_that_is_still_warming_up(self):
        opener = FlakyOpener([http_error(503)], self._ok())
        proxy, slept = self._proxy(opener)

        response = proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

        self.assertEqual(response[0]["result"], {})
        self.assertEqual(opener.attempts, 2)
        self.assertEqual(len(slept), 1)

    def test_a_network_fault_is_retried_too(self):
        opener = FlakyOpener([urllib.error.URLError("connection reset")], self._ok())
        proxy, _ = self._proxy(opener)

        proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

        self.assertEqual(opener.attempts, 2)

    def test_a_rejected_request_is_not_retried(self):
        # It would fail the same way every time, and the caller waits for it.
        opener = FlakyOpener([http_error(400, b"bad arguments")] * 3, self._ok())
        proxy, slept = self._proxy(opener)

        with self.assertRaises(RuntimeError) as caught:
            proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "tools/call"})

        self.assertIn("400", str(caught.exception))
        self.assertEqual(opener.attempts, 1)
        self.assertEqual(slept, [])

    def test_retrying_gives_up_and_reports_the_last_failure(self):
        opener = FlakyOpener([http_error(503)] * 5, self._ok())
        proxy, slept = self._proxy(opener)

        with self.assertRaises(RuntimeError) as caught:
            proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

        self.assertIn("503", str(caught.exception))
        self.assertEqual(opener.attempts, mcp_http_proxy.RETRY_ATTEMPTS)
        self.assertEqual(len(slept), mcp_http_proxy.RETRY_ATTEMPTS - 1)

    def test_the_wait_grows_between_attempts(self):
        opener = FlakyOpener([http_error(503)] * 5, self._ok())
        proxy, slept = self._proxy(opener)

        with self.assertRaises(RuntimeError):
            proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

        self.assertEqual(slept, sorted(slept))
        self.assertGreater(slept[-1], slept[0])

    def test_a_healthy_server_is_called_once(self):
        opener = FlakyOpener([], self._ok())
        proxy, slept = self._proxy(opener)

        proxy.exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize"})

        self.assertEqual(opener.attempts, 1)
        self.assertEqual(slept, [])
