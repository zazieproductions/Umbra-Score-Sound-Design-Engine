#!/usr/bin/env python3
"""MANUAL, opt-in real video-to-audio test against the existing Umbra backend.

Not run in CI. Does not install/download any model. Only prints RUNTIME
VERIFIED after a successful job AND fetching/decoding its generated WAV.
Browser placement/listening/export is a separate manual check; see MMAUDIO.md.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Real MMAudio small_44k smoke test (NONCOMMERCIAL only)")
    parser.add_argument("--video", type=Path, required=True, help="tiny local MP4 on the same machine as the backend")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float, default=2.0, help="1–8 seconds; default 2")
    parser.add_argument("--prompt", default="", help="optional sound description; empty = video only")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--allow-noncommercial", action="store_true", required=True,
                        help="acknowledge CC BY-NC 4.0 checkpoint restriction")
    parser.add_argument("--url", default="http://127.0.0.1:8000", help="existing Umbra backend URL (not a new server)")
    args = parser.parse_args()
    video = args.video.expanduser().resolve()
    if not video.is_file():
        parser.error(f"video is missing: {video}")
    print("MMAudio: EXPERIMENTAL · NONCOMMERCIAL. No model downloads will be attempted.")
    try:
        with httpx.Client(base_url=args.url, timeout=60) as client:
            response = client.post("/api/generate", json={
                "provider": "mmaudio", "videoPath": str(video), "videoStart": args.start,
                "duration": args.duration, "prompt": args.prompt, "seed": args.seed,
                "commercialSafe": False, "allowNoncommercial": args.allow_noncommercial,
                "label": "MMAudio manual runtime verification",
            })
            if response.is_error:
                raise RuntimeError(response.text)
            job_id = response.json()["job"]["jobId"]
            deadline = time.monotonic() + 15 * 60
            while True:
                response = client.get(f"/api/jobs/{job_id}")
                response.raise_for_status()
                job = response.json()["job"]
                if job["state"] in {"failed", "cancelled"}:
                    raise RuntimeError(f"{job['state']}: {job['error']} — {job.get('hint')}")
                if job["state"] == "succeeded":
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("verification timed out; check the backend job before retrying")
                time.sleep(1)
            result = job["result"]
            m = result["metadata"]
            if (result["provider"] != "mmaudio" or m["model"] != "mmaudio_small_44k.pth"
                    or m["commercialSafe"] is not False or m["licenseClass"] != "CC_BY_NC"
                    or m["sourceVideoStart"] != args.start or job["timelineStart"] != args.start
                    or m["seed"] != args.seed):
                raise RuntimeError("generation lost model/license/seed/source timing provenance")
            audio = client.get(result["url"])
            audio.raise_for_status()
            target = ROOT / ".umbra" / "verification" / f"mmaudio-{job_id}.wav"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(audio.content)
            samples, sr = sf.read(target, always_2d=True)
            if (sr != 44100 or len(samples) != result["frames"] or not np.isfinite(samples).all()
                    or not np.any(np.abs(samples) > 1e-6) or abs(len(samples) / sr - args.duration) > 0.125):
                raise RuntimeError("generated WAV is invalid, non-finite or silent; verification failed")
            report = {
                "status": "RUNTIME VERIFIED", "verifiedAt": datetime.now(timezone.utc).isoformat(),
                "scope": "real backend video-to-audio + WAV decode; browser/listening/export not yet verified",
                "runtime": client.get("/api/health").json()["runtime"], "job": job,
            }
            target.with_suffix(".json").write_text(json.dumps(report, indent=2))
            print(f"RUNTIME VERIFIED: {len(samples) / sr:.3f}s @ {sr} Hz, {samples.shape[1]} channel(s)")
            print(f"WAV + provenance/evidence: {target} / {target.with_suffix('.json')}")
            print("Next: generate through Score, listen against picture, move/trim and export; keep CC BY-NC provenance.")
        return 0
    except Exception as exc:
        print(f"VERIFICATION FAILED (no runtime claim): {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
