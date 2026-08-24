#!/usr/bin/env python3
"""Run the container/session probe as two concurrent production turns.

`scripts/probe_runtime_isolation.py` is what a single turn executes. This drives
two conversations against the deployed agent at the same time and compares what
each one saw, which is the part that cannot be answered from inside one turn.

A positive cross-read is conclusive: the conversations share a container. A
negative one describes one scheduling outcome and not a guarantee, which is why
workspace containment shipped unconditionally rather than waiting on this.

    python3 scripts/probe_production_isolation.py
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
import subprocess
import sys
import urllib.request

ENDPOINT = os.environ.get("FOUNDRY_AGENT_ENDPOINT", "")
# Must name a deployment the agent actually has. A model the provider does not
# serve fails as an opaque server_error, which reads like a broken agent.
MODEL = os.environ.get("CODEX_MODEL_NAME", "gpt-5.6-luna")

PROMPT = """Run exactly this and report its raw output, nothing else:

cat /proc/sys/kernel/random/boot_id; echo "---"; hostname; echo "---"; \
echo "{marker}" > "$(pwd)/probe-{tag}.txt"; echo "---"; ls -1 "$(pwd)"; \
echo "--- parent env readable ---"; \
(cat /proc/1/environ >/dev/null 2>&1 && echo YES || echo NO)
"""


def token() -> str:
    result = subprocess.run(
        ["az", "account", "get-access-token", "--resource",
         "https://ai.azure.com", "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, timeout=90,
    )
    value = result.stdout.strip()
    if not value:
        raise SystemExit(f"could not obtain a token: {result.stderr.strip()[:200]}")
    return value


def turn(bearer: str, tag: str) -> dict[str, object]:
    body: dict[str, object] = {
        "model": MODEL,
        "input": PROMPT.format(tag=tag, marker=f"conversation-{tag}"),
        "stream": False,
        "store": True,
    }
    # The endpoint is already agent-scoped, and the service rejects the
    # deprecated `agent` property on this route, so the reference is implicit.

    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = json.load(response)

    text = "".join(
        part.get("text", "")
        for item in payload.get("output", [])
        if item.get("type") == "message"
        for part in item.get("content", [])
        if part.get("type") == "output_text"
    )
    return {"tag": tag, "response_id": payload.get("id", ""), "text": text}


def field(text: str, pattern: str) -> str:
    found = re.search(pattern, text)
    return found.group(0) if found else ""


def main() -> int:
    if not ENDPOINT:
        raise SystemExit("set FOUNDRY_AGENT_ENDPOINT")
    bearer = token()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda tag: turn(bearer, tag), ["a", "b"]))

    for result in results:
        print(f"=== conversation {result['tag']} ({result['response_id']}) ===")
        print(result["text"][:1400])
        print()

    a, b = (str(result["text"]) for result in results)
    boot_a = field(a, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    boot_b = field(b, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    print("=== verdict ===")
    print(f"  boot id A: {boot_a or '(not reported)'}")
    print(f"  boot id B: {boot_b or '(not reported)'}")
    print(f"  same boot id: {bool(boot_a) and boot_a == boot_b}")
    print(f"  A saw B's probe file: {'probe-b.txt' in a}")
    print(f"  B saw A's probe file: {'probe-a.txt' in b}")
    print(f"  parent environ readable: A={field(a, r'(?<=--- parent env readable ---\\n)(YES|NO)') or '?'} "
          f"B={field(b, r'(?<=--- parent env readable ---\\n)(YES|NO)') or '?'}")

    shared = ("probe-b.txt" in a) or ("probe-a.txt" in b)
    if shared:
        print("\n  CONCLUSIVE: the conversations shared a workspace.")
    else:
        print("\n  Not shared in this run. One scheduling outcome, not a guarantee.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
