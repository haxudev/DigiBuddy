#!/usr/bin/env python3
"""Measure what a Codex turn can actually reach inside the Hosted Agent container.

The design assumes three things that nothing in the code enforces: that a
container serves one conversation, that the Codex process cannot read the
adapter's environment, and that scoping credentials to a profile means
something while the container's managed identity is ambient.

This script is what a Codex turn runs to answer those questions. It only reads;
it changes nothing. Paste its output into `docs/architecture.md` together with
the date.

    python3 scripts/probe_runtime_isolation.py [--write-probe NAME]

Run it in two concurrent conversations. Give the first one `--write-probe a` so
the second can look for the file.

Deliberately *not* used as evidence:

  * ``echo $$`` reports the shell the command ran in, not the container.
  * Artifact cross-delivery cannot fail. The second conversation snapshots the
    workspace at its own turn start, by which time the first conversation's
    finished file is already part of its baseline, so it can never be reported
    as changed.

A positive cross-read is conclusive. A negative one describes one scheduling
outcome, not a guarantee, which is why workspace containment is unconditional.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

WORKSPACE = Path(os.environ.get("CODEX_WORKSPACE", "/workspace"))
IMDS = "http://169.254.169.254/metadata/identity/oauth2/token"
PR_SET_DUMPABLE = 4


def container_identity() -> dict[str, object]:
    """Identity that survives a shell, unlike a PID."""
    boot_id = Path("/proc/sys/kernel/random/boot_id")
    cgroup = Path("/proc/self/cgroup")
    return {
        "hostname": socket.gethostname(),
        "boot_id": boot_id.read_text(encoding="utf-8").strip()
        if boot_id.is_file()
        else "unavailable",
        "cgroup": cgroup.read_text(encoding="utf-8").strip().splitlines()[-1:]
        if cgroup.is_file()
        else ["unavailable"],
        "adapter_pid_1_cmdline": _read("/proc/1/cmdline").replace("\0", " ").strip(),
    }


def workspace_neighbours(probe: str | None) -> dict[str, object]:
    """Whether this conversation can see another one's files."""
    if probe:
        (WORKSPACE / f"probe-{probe}.txt").write_text(probe, encoding="utf-8")
    try:
        entries = sorted(item.name for item in WORKSPACE.iterdir())
    except OSError as error:
        entries = [f"unreadable: {error}"]
    return {
        "workspace": str(WORKSPACE),
        "entries": entries,
        "foreign_probes": [
            name
            for name in entries
            if name.startswith("probe-") and name != f"probe-{probe}.txt"
        ],
    }


def parent_environment_exposure() -> dict[str, object]:
    """Can this process read the adapter's environment through procfs?

    Same-uid parent and child means yes, unless the parent made itself
    undumpable. Only the variable *names* are reported; values are the thing
    being protected.
    """
    result: dict[str, object] = {"same_uid_as_pid_1": None, "readable": None}
    try:
        result["same_uid_as_pid_1"] = os.stat("/proc/1").st_uid == os.getuid()
    except OSError as error:
        result["same_uid_as_pid_1"] = f"unavailable: {error}"
    try:
        raw = Path("/proc/1/environ").read_bytes()
        names = sorted(
            entry.split("=", 1)[0]
            for entry in raw.decode("utf-8", "replace").split("\0")
            if "=" in entry
        )
        result["readable"] = True
        result["variable_names"] = names
    except OSError as error:
        result["readable"] = False
        result["error"] = str(error)
    return result


def undumpable_self_test() -> dict[str, object]:
    """Confirm the T2 mechanism works here before relying on it.

    Verified on Linux 6.x: after ``prctl(PR_SET_DUMPABLE, 0)`` the process's
    /proc entry becomes root-owned and a same-uid child is refused.
    """
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
    except OSError as error:
        return {"supported": False, "error": str(error)}
    probe = [
        sys.executable,
        "-c",
        f"open('/proc/{os.getpid()}/environ','rb').read()",
    ]
    before = subprocess.run(probe, capture_output=True).returncode == 0
    rc = libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    after = subprocess.run(probe, capture_output=True).returncode == 0
    libc.prctl(PR_SET_DUMPABLE, 1, 0, 0, 0)
    return {
        "supported": rc == 0,
        "child_read_before": before,
        "child_read_after": after,
        "closes_procfs": bool(before and not after),
    }


def ambient_identity() -> dict[str, object]:
    """What a managed identity is still reachable for, from this process.

    Removing DIGIBUDDY_CONFIG_URI from the child does not revoke the identity,
    so this is the measurement that decides whether T3 is a restriction or an
    accepted residual risk.
    """
    findings: dict[str, object] = {
        "identity_endpoint_env": bool(os.environ.get("IDENTITY_ENDPOINT")),
        "msi_endpoint_env": bool(os.environ.get("MSI_ENDPOINT")),
        "config_uri_visible": bool(os.environ.get("DIGIBUDDY_CONFIG_URI")),
    }

    request = urllib.request.Request(
        f"{IMDS}?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F",
        headers={"Metadata": "true"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            findings["imds_token"] = "acquired" if response.status == 200 else response.status
    except urllib.error.URLError as error:
        findings["imds_token"] = f"refused: {error.reason}"
    except Exception as error:  # noqa: BLE001 - a probe must not raise
        findings["imds_token"] = f"refused: {error}"

    try:
        from azure.identity import DefaultAzureCredential

        DefaultAzureCredential().get_token("https://storage.azure.com/.default")
        findings["sdk_token"] = "acquired"
    except Exception as error:  # noqa: BLE001
        findings["sdk_token"] = f"refused: {type(error).__name__}"

    return findings


def blob_tool_still_works() -> str:
    """The counter-constraint: azure_blob deliberately uses that identity.

    A restriction that silently breaks deliverable upload is not a win.
    """
    if not os.environ.get("DIGIBUDDY_BLOB_SERVICE_URI"):
        return "not configured in this deployment"
    probe = Path(os.environ.get("TMPDIR", "/tmp")) / "digibuddy-identity-probe.txt"
    probe.write_text("probe", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "azure_blob", "upload", str(probe)],
        capture_output=True,
        text=True,
    )
    probe.unlink(missing_ok=True)
    return "upload succeeded" if result.returncode == 0 else f"upload failed: {result.stderr.strip()[:200]}"


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write-probe",
        metavar="NAME",
        help="drop probe-<NAME>.txt in the workspace for another conversation to find",
    )
    arguments = parser.parse_args()

    report = {
        "container": container_identity(),
        "workspace": workspace_neighbours(arguments.write_probe),
        "parent_environment": parent_environment_exposure(),
        "undumpable": undumpable_self_test(),
        "ambient_identity": ambient_identity(),
        "blob_tool": blob_tool_still_works(),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
