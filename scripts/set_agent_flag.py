#!/usr/bin/env python3
"""Turn a Hosted Agent feature flag on or off.

Flags live in the agent version's environment, and a version is immutable, so
changing one means creating a new version from the current definition. That is
what a release already does; this does the same thing without rebuilding an
image, so a flag can be flipped and rolled back independently of the code.

    python3 scripts/set_agent_flag.py --list
    python3 scripts/set_agent_flag.py DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS=true
    python3 scripts/set_agent_flag.py DIGIBUDDY_ENABLE_CAPABILITY_PACKS=false

Rolling back is setting it to false, or activating the previous version. Both
leave the image alone.
"""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJECT = (
    "https://haxuaifoundryaiservice.services.ai.azure.com"
    "/api/projects/haxuaifoundryaiservice-agent"
)
AGENT = "haeronclaw-codex"
API = "api-version=v1"

#: Only these may be set here. An open list would turn a flag tool into a way to
#: rewrite the model endpoint or inject a credential.
SETTABLE = frozenset(
    {
        "DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS",
        "DIGIBUDDY_ENABLE_CAPABILITY_PACKS",
    }
)


def token() -> str:
    result = subprocess.run(
        ["az", "account", "get-access-token", "--resource",
         "https://ai.azure.com", "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, timeout=120,
    )
    value = result.stdout.strip()
    if not value:
        raise SystemExit(f"could not obtain a token: {result.stderr.strip()[:200]}")
    return value


def call(method: str, path: str, bearer: str, payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{PROJECT}{path}{'&' if '?' in path else '?'}{API}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read()
        return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed with {error.code}: {error.read().decode()[:400]}")


def latest(bearer: str) -> dict:
    agent = call("GET", f"/agents/{AGENT}", bearer)
    version = (agent.get("versions") or {}).get("latest")
    if not version:
        raise SystemExit("the agent has no latest version")
    return version


def environment_of(version: dict) -> dict[str, str]:
    definition = version.get("definition") or {}
    return dict(definition.get("environment_variables") or {})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assignment", nargs="?", help="NAME=true or NAME=false")
    parser.add_argument("--list", action="store_true", help="show the current flags")
    arguments = parser.parse_args()

    bearer = token()
    version = latest(bearer)
    current = environment_of(version)

    if arguments.list or not arguments.assignment:
        print(f"agent version {version.get('version')}")
        for name in sorted(SETTABLE):
            print(f"  {name} = {current.get(name, '(unset)')}")
        return 0

    name, _, raw = arguments.assignment.partition("=")
    name = name.strip().upper()
    value = raw.strip().lower()
    if name not in SETTABLE:
        raise SystemExit(f"{name} is not a settable flag. Allowed: {', '.join(sorted(SETTABLE))}")
    if value not in {"true", "false"}:
        raise SystemExit("value must be true or false")

    if current.get(name, "") == value:
        print(f"{name} is already {value} on version {version.get('version')}")
        return 0

    definition = copy.deepcopy(version.get("definition") or {})
    environment = dict(definition.get("environment_variables") or {})
    environment[name] = value
    definition["environment_variables"] = environment

    body = {"definition": definition}
    for key in ("description", "metadata"):
        if key in version:
            body[key] = copy.deepcopy(version[key])

    created = call("POST", f"/agents/{AGENT}/versions", bearer, body)
    new_version = created.get("version") or created.get("id")
    print(f"created version {new_version} with {name}={value}")

    # A version that is not active yet serves nothing, so wait rather than
    # reporting success on a version the platform has not accepted.
    for _ in range(60):
        time.sleep(5)
        check = latest(bearer)
        if str(check.get("version")) == str(new_version):
            print(f"version {new_version} is now the latest")
            return 0
    print(f"version {new_version} created but is not yet latest; check the portal", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
