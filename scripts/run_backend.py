#!/usr/bin/env python3
"""Start UMBRA's local ML backend.

    python scripts/run_backend.py                # 127.0.0.1:8000
    python scripts/run_backend.py --port 8080
    python scripts/run_backend.py --reload

The Vite dev server proxies ``/api`` to this process, so the browser never
needs to know where it lives.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the UMBRA local ML backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    try:
        import uvicorn
    except ImportError:
        print(
            "uvicorn is not installed. Run:\n"
            "  python -m venv .venv && . .venv/bin/activate\n"
            "  pip install -r backend/requirements.txt",
            file=sys.stderr,
        )
        return 1

    # Single worker: the in-process job queue and loaded models are per-process.
    uvicorn.run(
        "backend.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        workers=1,
        log_level=args.log_level,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
