import importlib.util
import json
import unittest
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
