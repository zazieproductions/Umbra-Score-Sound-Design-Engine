#!/usr/bin/env python3
"""Download model weights for UMBRA's local ML backend.

Weights are never committed to this repository. This script pulls them from
their official distribution channels into a git-ignored ``checkpoints/``
directory, using each project's own conventions.

Usage::

    python scripts/setup_models.py --core          # ACE-Step main components
    python scripts/setup_models.py --ace-step      # same as --core
    python scripts/setup_models.py --ace-step-base # + base checkpoint (continuation)
    python scripts/setup_models.py --stable-audio  # Stable Audio Open 1.0
    python scripts/setup_models.py --clap          # CLAP semantic search
    python scripts/setup_models.py --xclip         # X-CLIP semantic video analysis
    python scripts/setup_models.py --list          # show what is already local

Licences differ per model and some are gated. See THIRD_PARTY_MODELS.md — you
are responsible for accepting each licence before downloading.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from backend.services import model_manager  # noqa: E402

# ACE-Step 1.5 main repo + the components its own downloader expects.
ACE_STEP_MAIN_REPO = "ACE-Step/Ace-Step1.5"
ACE_STEP_COMPONENTS = model_manager.ACE_STEP_MAIN_COMPONENTS

OPTIONAL_REPOS = {
    "ace-step-base": ("ACE-Step/acestep-v15-base", "acestep-v15-base"),
    "ace-step-lm-small": ("ACE-Step/acestep-5Hz-lm-0.6B", "acestep-5Hz-lm-0.6B"),
    "stable-audio": ("stabilityai/stable-audio-open-1.0", "stable-audio-open-1.0"),
    "clap": ("laion/clap-htsat-unfused", "clap-htsat-unfused"),
    "xclip": ("microsoft/xclip-base-patch32", "xclip-base-patch32"),
}

LICENCE_NOTES = {
    "ace-step": (
        "ACE-Step 1.5 code is MIT. Model weights carry their own terms — check the "
        "model card at https://huggingface.co/ACE-Step/Ace-Step1.5 before use."
    ),
    "stable-audio": (
        "Stable Audio Open 1.0 is released under the Stability AI Community License "
        "and is a GATED repository: accept the licence on Hugging Face and log in "
        "with `huggingface-cli login` first. Commercial use above Stability's "
        "revenue threshold requires an enterprise licence."
    ),
    "clap": "CLAP (laion/clap-htsat-unfused) — check the model card for its licence terms.",
    "xclip": (
        "X-CLIP (microsoft/xclip-base-patch32) — MIT licence per the model card. "
        "Weights live in git-ignored checkpoints/xclip-base-patch32; analysis results "
        "are cached in git-ignored models/cache/xclip."
    ),
}


def _require_hf():
    try:
        from huggingface_hub import snapshot_download  # type: ignore

        return snapshot_download
    except ImportError:
        print(
            "ERROR: huggingface_hub is not installed.\n"
            "       pip install -r backend/requirements.txt",
            file=sys.stderr,
        )
        raise SystemExit(1)


def download(repo_id: str, target: Path, allow_patterns=None) -> bool:
    snapshot_download = _require_hf()
    target.mkdir(parents=True, exist_ok=True)
    print(f"  → {repo_id}\n    into {target}")
    try:
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(target),
            allow_patterns=allow_patterns,
            token=os.environ.get("HF_TOKEN"),
        )
    except Exception as exc:
        print(f"    FAILED: {exc}", file=sys.stderr)
        if "gated" in str(exc).lower() or "401" in str(exc) or "403" in str(exc):
            print(
                "    This repo is gated. Accept the licence on its Hugging Face page,\n"
                "    then run `huggingface-cli login` (or set HF_TOKEN).",
                file=sys.stderr,
            )
        return False
    print("    done")
    return True


def install_ace_step(root: Path, include_base: bool = False) -> int:
    print(f"\nACE-Step 1.5\n{LICENCE_NOTES['ace-step']}\n")
    failures = 0
    # ACE-Step's downloader pulls each component subfolder from the main repo.
    for component in ACE_STEP_COMPONENTS:
        target = root / component
        if target.exists() and any(target.iterdir()):
            print(f"  ✓ {component} already present")
            continue
        if not download(ACE_STEP_MAIN_REPO, target, allow_patterns=[f"{component}/*"]):
            failures += 1
    if include_base:
        repo, name = OPTIONAL_REPOS["ace-step-base"]
        target = root / name
        if target.exists() and any(target.iterdir()):
            print(f"  ✓ {name} already present")
        elif not download(repo, target):
            failures += 1
    return failures


def install_simple(key: str, root: Path) -> int:
    repo, name = OPTIONAL_REPOS[key]
    note = LICENCE_NOTES.get(key)
    print(f"\n{name}")
    if note:
        print(note)
    print()
    target = root / name
    if target.exists() and any(target.iterdir()):
        print(f"  ✓ {name} already present")
        return 0
    return 0 if download(repo, target) else 1


def show_list(root: Path) -> None:
    report = model_manager.model_report()
    print(f"\ncheckpoints root: {root}\n")
    print("CHECKPOINTS")
    if not report.checkpoints:
        print("  (none)")
    for c in report.checkpoints:
        mark = "✓" if c.present else "·"
        size = f"{c.size_bytes / 1e9:.2f} GB" if c.size_bytes else "—"
        print(f"  {mark} {c.name:32} {size:>10}   {c.repo or ''}")
    print("\nPACKAGES")
    for p in report.packages:
        mark = "✓" if p.installed else "·"
        print(f"  {mark} {p.name:16} {p.version or '—':>12}   {p.purpose}")

    from backend.services.device import runtime_summary

    rt = runtime_summary()
    print(f"\nDEVICES (preferred: {rt['preferredDeviceLabel']})")
    for d in rt["devices"]:
        mark = "✓" if d["available"] else "·"
        print(f"  {mark} {d['label']:14} {d['detail'] or ''}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Download UMBRA model weights")
    parser.add_argument("--core", action="store_true", help="ACE-Step main components")
    parser.add_argument("--ace-step", action="store_true", help="ACE-Step main components")
    parser.add_argument(
        "--ace-step-base", action="store_true",
        help="ACE-Step base checkpoint (needed for continuation / accompaniment)",
    )
    parser.add_argument("--stable-audio", action="store_true", help="Stable Audio Open 1.0 (gated)")
    parser.add_argument("--clap", action="store_true", help="CLAP semantic search")
    parser.add_argument("--xclip", action="store_true", help="X-CLIP semantic video analysis")
    parser.add_argument("--all", action="store_true", help="everything above")
    parser.add_argument("--list", action="store_true", help="show local state and exit")
    parser.add_argument("--dir", type=str, default=None, help="override checkpoints directory")
    args = parser.parse_args()

    root = Path(args.dir).expanduser() if args.dir else model_manager.checkpoints_root()

    if args.list or not any(
        [args.core, args.ace_step, args.ace_step_base, args.stable_audio, args.clap, args.xclip, args.all]
    ):
        show_list(root)
        if not args.list:
            parser.print_help()
        return 0

    root.mkdir(parents=True, exist_ok=True)
    failures = 0

    if args.all or args.core or args.ace_step or args.ace_step_base:
        failures += install_ace_step(root, include_base=args.all or args.ace_step_base)
    if args.all or args.stable_audio:
        failures += install_simple("stable-audio", root)
    if args.all or args.clap:
        failures += install_simple("clap", root)
    if args.all or args.xclip:
        failures += install_simple("xclip", root)

    print()
    show_list(root)
    if failures:
        print(f"{failures} download(s) failed.", file=sys.stderr)
        return 1
    print("All requested models are present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
