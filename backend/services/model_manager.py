"""Local model discovery.

The Models view must never show invented statistics. This module only reports
what is genuinely on disk or genuinely importable:

* is the Python package importable?
* is a checkpoint directory actually present, and how big is it?
* which device would actually be used?

Checkpoint layout follows ACE-Step's own ``model_downloader`` conventions:
a ``checkpoints/`` root containing one directory per component.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional


def checkpoints_root() -> Path:
    """Where Umbra looks for local weights.

    Honours ``UMBRA_CHECKPOINTS`` first, then ACE-Step's ``ACESTEP_CHECKPOINT_DIR``,
    then a repo-local ``checkpoints/`` folder (git-ignored).
    """
    for env in ("UMBRA_CHECKPOINTS", "ACESTEP_CHECKPOINT_DIR"):
        v = os.environ.get(env)
        if v:
            return Path(v).expanduser()
    return Path.cwd() / "checkpoints"


def package_version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except Exception:
        return None


def package_installed(name: str) -> bool:
    """True only when the module can genuinely be located."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False


def dir_size(path: Path, *, limit_files: int = 20000) -> Optional[int]:
    """Real on-disk size of a checkpoint directory."""
    if not path.exists():
        return None
    total = 0
    seen = 0
    for p in path.rglob("*"):
        if seen > limit_files:
            break
        try:
            if p.is_file():
                total += p.stat().st_size
                seen += 1
        except OSError:
            continue
    return total


# ACE-Step's own component list (acestep/model_downloader.py MAIN_MODEL_COMPONENTS)
ACE_STEP_MAIN_COMPONENTS = [
    "acestep-v15-turbo",
    "vae",
    "Qwen3-Embedding-0.6B",
    "acestep-5Hz-lm-1.7B",
]

# ACE-Step's SUBMODEL_REGISTRY, as of ACE-Step 1.5.
ACE_STEP_SUBMODELS: Dict[str, str] = {
    "acestep-5Hz-lm-0.6B": "ACE-Step/acestep-5Hz-lm-0.6B",
    "acestep-5Hz-lm-4B": "ACE-Step/acestep-5Hz-lm-4B",
    "acestep-v15-turbo-shift3": "ACE-Step/acestep-v15-turbo-shift3",
    "acestep-v15-sft": "ACE-Step/acestep-v15-sft",
    "acestep-v15-base": "ACE-Step/acestep-v15-base",
    "acestep-v15-turbo-shift1": "ACE-Step/acestep-v15-turbo-shift1",
    "acestep-v15-turbo-continuous": "ACE-Step/acestep-v15-turbo-continuous",
    "acestep-v15-xl-base": "ACE-Step/acestep-v15-xl-base",
    "acestep-v15-xl-sft": "ACE-Step/acestep-v15-xl-sft",
    "acestep-v15-xl-turbo": "ACE-Step/acestep-v15-xl-turbo",
}

ACE_STEP_MAIN_REPO = "ACE-Step/Ace-Step1.5"


@dataclass
class CheckpointInfo:
    name: str
    present: bool
    path: Optional[str] = None
    size_bytes: Optional[int] = None
    repo: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "present": self.present,
            "path": self.path,
            "sizeBytes": self.size_bytes,
            "repo": self.repo,
        }


@dataclass
class PackageInfo:
    name: str
    installed: bool
    version: Optional[str] = None
    purpose: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "installed": self.installed,
            "version": self.version,
            "purpose": self.purpose,
        }


@dataclass
class ModelReport:
    checkpoints: List[CheckpointInfo] = field(default_factory=list)
    packages: List[PackageInfo] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "checkpointsRoot": str(checkpoints_root()),
            "checkpoints": [c.to_json() for c in self.checkpoints],
            "packages": [p.to_json() for p in self.packages],
        }


def ace_step_checkpoints() -> List[CheckpointInfo]:
    root = checkpoints_root()
    out: List[CheckpointInfo] = []
    for name in ACE_STEP_MAIN_COMPONENTS:
        p = root / name
        out.append(
            CheckpointInfo(
                name=name,
                present=p.is_dir() and any(p.iterdir()) if p.exists() else False,
                path=str(p) if p.exists() else None,
                size_bytes=dir_size(p),
                repo=ACE_STEP_MAIN_REPO,
            )
        )
    for name, repo in ACE_STEP_SUBMODELS.items():
        p = root / name
        if not p.exists():
            continue  # only list optional submodels that are genuinely installed
        out.append(
            CheckpointInfo(
                name=name,
                present=any(p.iterdir()),
                path=str(p),
                size_bytes=dir_size(p),
                repo=repo,
            )
        )
    return out


def ace_step_installed_dit_models() -> List[str]:
    """DiT checkpoints actually present on disk."""
    root = checkpoints_root()
    if not root.exists():
        return []
    names = []
    known = set(ACE_STEP_SUBMODELS) | {"acestep-v15-turbo"}
    for p in sorted(root.iterdir()):
        if p.is_dir() and p.name in known and any(p.iterdir()):
            names.append(p.name)
    return names


def ace_step_core_ready() -> bool:
    """True only when every component ACE-Step needs to load is present."""
    root = checkpoints_root()
    for name in ACE_STEP_MAIN_COMPONENTS:
        p = root / name
        if not (p.is_dir() and any(p.iterdir())):
            return False
    return True


@lru_cache(maxsize=1)
def _tracked_packages() -> List[tuple]:
    return [
        ("torch", "Trained-model inference runtime"),
        ("torchaudio", "Audio I/O and resampling for trained models"),
        ("transformers", "Qwen3 text encoder used by ACE-Step"),
        ("diffusers", "Diffusion pipeline interfaces"),
        ("accelerate", "Device placement / offload"),
        ("soundfile", "Decoding and WAV writing"),
        ("scipy", "Resampling and analysis"),
        ("numpy", "Array maths"),
        ("acestep", "ACE-Step 1.5 inference package"),
        ("peft", "LoRA / personalization (optional)"),
        ("scenedetect", "PySceneDetect cut detection (optional)"),
    ]


def package_report() -> List[PackageInfo]:
    out: List[PackageInfo] = []
    for name, purpose in _tracked_packages():
        installed = package_installed(name)
        out.append(
            PackageInfo(
                name=name,
                installed=installed,
                version=package_version(name) if installed else None,
                purpose=purpose,
            )
        )
    return out


def model_report() -> ModelReport:
    return ModelReport(checkpoints=ace_step_checkpoints(), packages=package_report())
