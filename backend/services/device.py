"""Real device detection.

Umbra never invents GPU or cloud statistics. Everything reported here comes
from an actual runtime probe; when we cannot determine something we return
``None`` and the UI shows nothing rather than a plausible-looking number.
"""

from __future__ import annotations

import functools
import os
import platform
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class DeviceInfo:
    """A real, probed compute device."""

    id: str                      # "cuda" | "mps" | "mlx" | "cpu" | "xpu"
    label: str
    available: bool
    detail: Optional[str] = None
    total_memory_bytes: Optional[int] = None
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "available": self.available,
            "detail": self.detail,
            "totalMemoryBytes": self.total_memory_bytes,
            "notes": self.notes,
        }


def _torch():
    try:
        import torch  # type: ignore

        return torch
    except Exception:
        return None


def _probe_cuda(torch) -> Optional[DeviceInfo]:
    try:
        if not torch.cuda.is_available():
            return None
        idx = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(idx)
        return DeviceInfo(
            id="cuda",
            label="CUDA",
            available=True,
            detail=props.name,
            total_memory_bytes=int(props.total_memory),
            notes=[f"torch {torch.__version__}", f"{torch.cuda.device_count()} device(s)"],
        )
    except Exception:
        return None


def _probe_mps(torch) -> Optional[DeviceInfo]:
    """Apple Silicon Metal Performance Shaders, probed the same way ACE-Step does."""
    try:
        backends = getattr(torch.backends, "mps", None)
        if backends is None or not backends.is_available():
            return None
        total: Optional[int] = None
        mps_mod = getattr(torch, "mps", None)
        if mps_mod is not None and hasattr(mps_mod, "recommended_max_memory"):
            try:
                total = int(mps_mod.recommended_max_memory())
            except Exception:
                total = None
        return DeviceInfo(
            id="mps",
            label="Apple MPS",
            available=True,
            detail=platform.processor() or "Apple Silicon",
            total_memory_bytes=total,
            notes=[f"torch {torch.__version__}"],
        )
    except Exception:
        return None


def _probe_xpu(torch) -> Optional[DeviceInfo]:
    try:
        xpu = getattr(torch, "xpu", None)
        if xpu is None or not xpu.is_available():
            return None
        return DeviceInfo(id="xpu", label="Intel XPU", available=True, detail="torch.xpu")
    except Exception:
        return None


def _probe_mlx() -> Optional[DeviceInfo]:
    """MLX is Apple-Silicon-only.

    ACE-Step ships ``mlx``/``mlx-lm`` as darwin+arm64 extras and accepts
    ``mlx`` as an LM backend (``VALID_LM_BACKENDS`` in ``acestep/gpu_config.py``).
    We surface it only when the package genuinely imports.
    """
    if platform.system() != "Darwin":
        return None
    try:
        import mlx.core as mx  # type: ignore

        version = getattr(mx, "__version__", None)
        notes = ["ACE-Step accepts mlx as an LM backend on Apple Silicon"]
        return DeviceInfo(
            id="mlx",
            label="Apple MLX",
            available=True,
            detail=f"mlx {version}" if version else "mlx",
            notes=notes,
        )
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def probe_devices() -> List[DeviceInfo]:
    """Probe every device backend once per process."""
    devices: List[DeviceInfo] = []
    torch = _torch()
    if torch is not None:
        for probe in (_probe_cuda, _probe_mps, _probe_xpu):
            info = probe(torch)
            if info is not None:
                devices.append(info)
    mlx = _probe_mlx()
    if mlx is not None:
        devices.append(mlx)

    cpu_notes: List[str] = []
    cores = os.cpu_count()
    if cores:
        cpu_notes.append(f"{cores} logical cores")
    if torch is None:
        cpu_notes.append("PyTorch not installed — trained-model providers unavailable")
    devices.append(
        DeviceInfo(
            id="cpu",
            label="CPU",
            available=True,
            detail=platform.machine(),
            notes=cpu_notes,
        )
    )
    return devices


def preferred_device() -> DeviceInfo:
    """The device Umbra would actually use, in ACE-Step's own preference order."""
    order = ["cuda", "mps", "xpu", "cpu"]
    by_id = {d.id: d for d in probe_devices()}
    for key in order:
        d = by_id.get(key)
        if d is not None and d.available:
            return d
    return by_id["cpu"]


def torch_version() -> Optional[str]:
    torch = _torch()
    return getattr(torch, "__version__", None) if torch is not None else None


def runtime_summary() -> Dict[str, Any]:
    """A fully-real snapshot of the local runtime for the Models view."""
    devices = probe_devices()
    pref = preferred_device()
    return {
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "appleSilicon": platform.system() == "Darwin" and platform.machine() == "arm64",
        },
        "torch": torch_version(),
        "devices": [d.to_json() for d in devices],
        "preferredDevice": pref.id,
        "preferredDeviceLabel": pref.label,
    }
