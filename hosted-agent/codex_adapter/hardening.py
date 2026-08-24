"""Keep the adapter's own process out of reach of the Codex process.

Parent and child run as the same user, and a same-uid process may read
``/proc/<pid>/environ``. That is where the model key and every resolved profile
credential live, so scoping the child's environment achieves nothing while the
parent's is readable beside it.

``PR_SET_DUMPABLE`` is the mechanism that fits. Clearing it makes the kernel
re-own this process's ``/proc`` entry to root, and a same-uid reader is refused.
Verified on Linux 6.x: a child could read the parent's environ before the call
and got ``EACCES`` after it.

It applies to this process only. ``execve`` restores the default, so the Codex
child stays ordinarily inspectable -- which is what we want, since it is the
untrusted side and nothing in it needs protecting.

This is one layer. It does not stop a prompt injection asking the container's
ambient managed identity for a token; that boundary needs separate deployments.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys

logger = logging.getLogger(__name__)

_PR_SET_DUMPABLE = 4


def harden_process() -> bool:
    """Make this process undumpable. Returns whether it took effect."""
    if not sys.platform.startswith("linux"):
        logger.info("Process hardening skipped: not Linux")
        return False
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        if libc.prctl(_PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE) failed")
    except (OSError, AttributeError) as error:
        # Worth a warning rather than a failure: the agent is still useful, but
        # an operator should know the tier was not achieved.
        logger.warning("Could not make the adapter undumpable: %s", error)
        return False

    if not _procfs_is_closed():
        logger.warning(
            "The adapter is marked undumpable but its /proc entry is still "
            "readable; treat the parent environment as exposed"
        )
        return False
    logger.info("Adapter process hardened: /proc entry is no longer self-readable")
    return True


def _procfs_is_closed() -> bool:
    """Confirm the flag did what it claims, rather than trusting the call.

    After the kernel re-owns the entry, this process is no longer its owner and
    reading it fails -- which is exactly the observation a same-uid child would
    make.
    """
    try:
        with open(f"/proc/{os.getpid()}/environ", "rb") as handle:
            handle.read(1)
    except PermissionError:
        return True
    except OSError:
        return True
    return False


__all__ = ["harden_process"]
