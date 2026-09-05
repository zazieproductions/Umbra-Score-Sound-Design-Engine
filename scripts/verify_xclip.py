#!/usr/bin/env python3
"""Manual Tier-3 runtime verification for X-CLIP semantic video analysis.

This is the check that earns `RUNTIME VERIFIED` for the X-CLIP analysis
layer. It requires real weights, torch/transformers/Pillow and an ffmpeg
binary; unlike CI it actually runs inference on a real small video and only
prints `RUNTIME VERIFIED` after frames were processed successfully.

Usage::

    python scripts/verify_xclip.py /path/to/small.mp4 [--at 2.5] [--seconds 1.5]

Exit code 0 only when a real X-CLIP inference completed. Otherwise it prints
what is missing (weights, dependency, ffmpeg, file) and exits non-zero.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.analysis.xclip import get_xclip_analyzer  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser(description="Real X-CLIP inference verification")
    parser.add_argument("video", help="path to a real small MP4/quicktime file")
    parser.add_argument("--at", type=float, default=0.0, help="event timestamp (seconds)")
    parser.add_argument("--seconds", type=float, default=1.5, help="window length")
    parser.add_argument("--top", type=int, default=5, help="top candidates to print")
    parser.add_argument("--json", action="store_true", help="print full JSON")
    args = parser.parse_args()

    analyzer = get_xclip_analyzer()
    status = analyzer.status()
    print(f"X-CLIP status: {json.dumps(status, indent=2)}")

    if not status["installed"]:
        print("\nWeights are not installed. Run:\n  python scripts/setup_models.py --xclip")
        return 1
    if not status["ready"]:
        print("\nDependencies missing. Install backend/requirements-extras.txt and torch.")
        return 1

    path = Path(args.video)
    if not path.exists():
        print(f"\nvideo not found: {path}")
        return 1

    event = {
        "id": "verify-xclip",
        "sceneId": "verify",
        "timestamp": args.at,
        "duration": args.seconds,
        "event": "other",
    }
    result = await analyzer.enrich_events(path, [event], window_seconds=args.seconds, top_k=args.top)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"\npayload: {event}")
        print(message := result["message"])
        for ev in result["events"]:
            sem = ev.get("semantic") or {}
            print(f"  event {ev.get('id')}: available={sem.get('available')}")
            for c in sem.get("candidates", []):
                print(
                    f"    {c['confidence']:.3f}  {c['label']:<32} "
                    f"role={c['role']} audioSet={c.get('audioSet')}"
                )

    ok = result.get("available") and any(
        (ev.get("semantic") or {}).get("candidates")
        for ev in result["events"]
    )
    if ok:
        print("\nRUNTIME VERIFIED — real X-CLIP inference processed video frames.")
        return 0
    print("\nNot runtime verified: X-CLIP did not produce semantic candidates.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
