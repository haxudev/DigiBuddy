"""Run the maturity MCP server on stdio.

    python -m agent_maturity.mcp
"""

from __future__ import annotations

import sys

from .protocol import run_stdio
from .tools import build_session


def main(argv=None) -> int:
    run_stdio(build_session())
    return 0


if __name__ == "__main__":
    sys.exit(main())
