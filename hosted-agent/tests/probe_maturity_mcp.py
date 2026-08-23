from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = ROOT / "hosted-agent" / "vendor" / "agent-maturity"
REFERENCES = ROOT / "hosted-agent" / "skills" / "agent-maturity-assess" / "references"


def probe(capabilities: dict[str, object]) -> set[str]:
    requests = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": capabilities,
                "clientInfo": {"name": "deployment-probe", "version": "1"},
            },
        },
        {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "maturity_get_question",
                "arguments": {"question_id": "A1", "lang": "en"},
            },
        },
    ]
    environment = os.environ.copy()
    environment["AGENT_MATURITY_REFERENCES"] = str(REFERENCES)
    environment["PYTHONPATH"] = str(PACKAGE_ROOT)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, "-B", "-m", "agent_maturity.mcp"],
        input="\n".join(json.dumps(request) for request in requests) + "\n",
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"MCP server exited {completed.returncode}: {completed.stderr.strip()}"
        )
    responses = []
    for line in completed.stdout.splitlines():
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"MCP emitted non-JSON stdout: {line!r}") from exc
    listed = next((response for response in responses if response.get("id") == 2), None)
    if not listed or "result" not in listed:
        raise RuntimeError(f"MCP tools/list response is missing: {responses!r}")
    names = {
        tool["name"]
        for tool in listed["result"].get("tools", [])
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    }
    if len(names) != len(listed["result"].get("tools", [])):
        raise RuntimeError("MCP tools/list contains duplicate or unnamed tools")
    if not all(name.startswith("maturity_") for name in names):
        raise RuntimeError(f"MCP exposed unexpected tools: {sorted(names)!r}")
    called = next((response for response in responses if response.get("id") == 3), None)
    if not called or "result" not in called or called["result"].get("isError"):
        raise RuntimeError(f"MCP tools/call failed: {called!r}")
    return names


def main() -> int:
    normal = probe({})
    elicitation = probe({"elicitation": {}})
    if len(normal) != 11:
        raise RuntimeError(f"expected 11 tools without elicitation, got {len(normal)}")
    if len(elicitation) != 12:
        raise RuntimeError(
            f"expected 12 tools with elicitation, got {len(elicitation)}"
        )
    if elicitation - normal != {"maturity_run_interview"}:
        raise RuntimeError(
            "elicitation should add only maturity_run_interview: "
            f"{sorted(elicitation - normal)!r}"
        )
    print("agent-maturity MCP probe passed: 11 tools, 12 with elicitation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
