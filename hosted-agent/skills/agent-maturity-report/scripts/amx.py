from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "_lib"))

from agent_maturity.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
