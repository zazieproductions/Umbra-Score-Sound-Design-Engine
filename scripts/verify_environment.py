#!/usr/bin/env python3
"""Verify the local Umbra environment.

Reports what is genuinely installed and what hardware genuinely exists, then
tells you the next useful command. Everything here reads the real machine —
this script never claims a device or a package that is not present.

    python scripts/verify_environment.py
    python scripts/verify_environment.py --json
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import device, model_manager  # noqa: E402

OK = "\u2713"
MISSING = "\u25cb"
WARN = "\u26a0"

CORE_PACKAGES = [
    ("fastapi", "FastAPI", True),
    ("uvicorn", "Uvicorn", True),
    ("soundfile", "SoundFile", True),
    ("numpy", "NumPy", True),
    ("multipart", "python-multipart", True),
    # Only needed by scripts/setup_models.py, not to serve the app.
    ("huggingface_hub", "huggingface-hub", False),
    ("pytest", "pytest", False),
]

MODEL_PACKAGES = [
    ("torch", "PyTorch"),
    ("torchaudio", "Torchaudio"),
    ("transformers", "Transformers"),
    ("diffusers", "Diffusers"),
    ("accelerate", "Accelerate"),
    ("acestep", "ACE-Step"),
    ("stable_audio_tools", "stable-audio-tools"),
    ("laion_clap", "LAION-CLAP"),
    ("scenedetect", "PySceneDetect"),
    ("cv2", "OpenCV"),
]


def _section(title: str) -> None:
    print()
    print("=" * 62)
    print(title)
    print("=" * 62)


def collect() -> dict:
    """Gather the whole environment picture as plain data."""
    py = sys.version_info
    runtime = device.runtime_summary()
    report = model_manager.model_report().to_json()

    core = [
        {
            "module": mod,
            "label": label,
            "required": required,
            "version": model_manager.package_version(mod),
            "installed": model_manager.package_installed(mod),
        }
        for mod, label, required in CORE_PACKAGES
    ]
    models = [
        {
            "module": mod,
            "label": label,
            "version": model_manager.package_version(mod),
            "installed": model_manager.package_installed(mod),
        }
        for mod, label in MODEL_PACKAGES
    ]

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    ffmpeg_version = None
    if ffmpeg:
        try:
            out = subprocess.run(
                [ffmpeg, "-version"], capture_output=True, text=True, timeout=10
            )
            ffmpeg_version = out.stdout.splitlines()[0] if out.stdout else None
        except Exception:
            ffmpeg_version = None

    return {
        "python": {
            "version": f"{py.major}.{py.minor}.{py.micro}",
            "supported": (3, 11) <= (py.major, py.minor) < (3, 13),
            "executable": sys.executable,
        },
        "runtime": runtime,
        "corePackages": core,
        "modelPackages": models,
        "tools": {
            "ffmpeg": {"path": ffmpeg, "version": ffmpeg_version},
            "ffprobe": {"path": ffprobe},
        },
        "checkpointsRoot": report["checkpointsRoot"],
        "checkpoints": report["checkpoints"],
    }


def render(data: dict) -> int:
    _section("UMBRA\u00b7SCORE \u2014 environment verification")

    py = data["python"]
    mark = OK if py["supported"] else WARN
    print(f"  {mark} Python {py['version']}")
    if not py["supported"]:
        print("      ACE-Step requires Python >=3.11,<3.13")
    print(f"      {py['executable']}")

    _section("Service packages")
    missing_core = []
    for p in data["corePackages"]:
        if p["installed"]:
            print(f"  {OK} {p['label']} {p['version'] or ''}".rstrip())
        elif p["required"]:
            print(f"  {WARN} {p['label']} NOT INSTALLED")
            missing_core.append(p["label"])
        else:
            note = " (needed for scripts/setup_models.py)" if p["module"] == "huggingface_hub" else " (optional)"
            print(f"  {MISSING} {p['label']} not installed{note}")

    _section("Model packages (optional \u2014 each unlocks a provider)")
    for p in data["modelPackages"]:
        if p["installed"]:
            print(f"  {OK} {p['label']} {p['version'] or ''}".rstrip())
        else:
            print(f"  {MISSING} {p['label']} not installed")

    _section("Detected hardware")
    rt = data["runtime"]
    plat = rt["platform"]
    print(f"  Platform: {plat['system']} {plat['machine']}"
          + (" (Apple Silicon)" if plat["appleSilicon"] else ""))
    print(f"  PyTorch:  {rt['torch'] or 'not installed'}")
    print()
    for d in rt["devices"]:
        star = "\u2190 preferred" if d["id"] == rt["preferredDevice"] else ""
        mark = OK if d["available"] else MISSING
        mem = f" \u00b7 {d['totalMemoryBytes'] / 1e9:.1f} GB" if d.get("totalMemoryBytes") else ""
        print(f"  {mark} {d['label']}{mem} {star}".rstrip())
        for note in d.get("notes", []):
            print(f"      {note}")

    _section("External tools")
    ff = data["tools"]["ffmpeg"]
    if ff["path"]:
        print(f"  {OK} {ff['version'] or 'ffmpeg'}")
    else:
        print(f"  {MISSING} ffmpeg not found (optional: video metadata, thumbnails, range extraction)")
    print(f"  {OK if data['tools']['ffprobe']['path'] else MISSING} ffprobe")

    _section("Checkpoints")
    print(f"  Root: {data['checkpointsRoot']}")
    present = [c for c in data["checkpoints"] if c["present"]]
    if not present:
        print("  (none installed)")
    for c in present:
        size = f" \u00b7 {c['sizeBytes'] / 1e9:.2f} GB" if c.get("sizeBytes") else ""
        print(f"  {OK} {c['name']}{size}")

    _section("Next steps")
    if missing_core:
        print("  Install the service dependencies:")
        print("    pip install -r backend/requirements.txt")
    elif not any(p["installed"] for p in data["modelPackages"] if p["module"] == "torch"):
        print("  The service will run, and Umbra Procedural works fully in the browser.")
        print("  To enable trained providers:")
        print("    pip install -r backend/requirements-ace-step.txt")
        print("    python scripts/setup_models.py --ace-step")
    elif not present:
        print("  Packages are installed but no checkpoints are present:")
        print("    python scripts/setup_models.py --core")
    else:
        print("  Environment looks ready. Start the backend:")
        print("    python scripts/run_backend.py")

    if rt["preferredDevice"] == "cpu" and rt["torch"]:
        print()
        print(f"  {WARN} CPU-only: generation will be very slow. A CUDA GPU or Apple Silicon")
        print("      machine is strongly recommended for real inference.")

    print()
    return 1 if missing_core else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify the local Umbra environment.")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()

    data = collect()
    if args.json:
        print(json.dumps(data, indent=2))
        return 0
    return render(data)


if __name__ == "__main__":
    sys.exit(main())
