"""Audio feature measurement and peak extraction.

Adapted from the PR #5 ``AudioAnalyzer``. Umbra draws clip waveforms in the
browser from the already-decoded AudioBuffer (``src/lib/clips.ts``), so this
module exists for the *backend* cases the frontend cannot cover: measuring a
reference file the user uploaded, or reporting real levels for a generated
result without shipping the samples to the client.

Everything returns a dataclass with an ``available`` flag. Nothing here invents
numbers: if the file cannot be decoded we say so.
"""

from __future__ import annotations

import logging
import math
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("umbra.waveform")


def _load_samples(path: Path):
    """Return ``(mono_samples, sample_rate)`` or ``None``.

    Prefers soundfile (already a hard dependency of the service). Falls back to
    the stdlib ``wave`` module so plain PCM WAVs work even in a minimal install.
    """
    try:
        import soundfile as sf  # type: ignore
        import numpy as np  # type: ignore

        data, sr = sf.read(str(path), always_2d=True)
        mono = np.mean(data, axis=1).astype("float64")
        return mono, int(sr)
    except ImportError:
        pass
    except Exception as exc:
        logger.debug("soundfile could not read %s: %s", path, exc)
        return None

    try:
        with wave.open(str(path), "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except Exception:
        return None

    if width != 2:
        # stdlib fallback only handles 16-bit; soundfile covers the rest
        return None

    import array

    pcm = array.array("h")
    pcm.frombytes(frames)
    if channels > 1:
        mono = [
            sum(pcm[i : i + channels]) / (channels * 32768.0)
            for i in range(0, len(pcm) - channels + 1, channels)
        ]
    else:
        mono = [s / 32768.0 for s in pcm]
    return mono, sr


# --------------------------------------------------------------------- peaks


@dataclass
class WaveformPeaks:
    available: bool
    peaks: List[float] = field(default_factory=list)
    sample_rate: int = 0
    duration: float = 0.0
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "peaks": [round(p, 5) for p in self.peaks],
            "sampleRate": self.sample_rate,
            "duration": round(self.duration, 3),
            "message": self.message,
        }


def generate_peaks(audio_path: Path, bins: int = 200, *, normalize: bool = True) -> WaveformPeaks:
    """Downsample a file into peak values for drawing."""
    if not audio_path.exists():
        return WaveformPeaks(available=False, message=f"audio not found: {audio_path}")

    loaded = _load_samples(audio_path)
    if loaded is None:
        return WaveformPeaks(available=False, message="could not decode audio")

    data, sr = loaded
    total = len(data)
    if total == 0 or sr <= 0:
        return WaveformPeaks(available=False, message="file contains no audio")

    bins = max(1, min(bins, total))
    step = max(1, total // bins)

    peaks: List[float] = []
    for i in range(0, total, step):
        chunk = data[i : i + step]
        if len(chunk) == 0:
            break
        peaks.append(float(max(abs(float(s)) for s in chunk)))

    if normalize and peaks:
        loudest = max(peaks)
        if loudest > 0:
            peaks = [p / loudest for p in peaks]

    return WaveformPeaks(
        available=True,
        peaks=peaks,
        sample_rate=sr,
        duration=total / sr,
    )


# ------------------------------------------------------------------ features


@dataclass
class AudioFeatures:
    available: bool
    duration: float = 0.0
    sample_rate: int = 0
    rms: float = 0.0
    rms_db: float = -120.0
    peak: float = 0.0
    peak_db: float = -120.0
    crest_factor: float = 0.0
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "duration": round(self.duration, 3),
            "sampleRate": self.sample_rate,
            "rms": round(self.rms, 6),
            "rmsDb": round(self.rms_db, 2),
            "peak": round(self.peak, 6),
            "peakDb": round(self.peak_db, 2),
            "crestFactor": round(self.crest_factor, 3),
            "message": self.message,
        }


def _db(x: float) -> float:
    return 20.0 * math.log10(x + 1e-10)


def analyze_features(audio_path: Path) -> AudioFeatures:
    """Measure real levels: RMS, true sample peak and crest factor.

    Useful for sanity-checking a generated result before it reaches the
    timeline — a silent or clipped return is a real failure mode of a
    misconfigured model, and Umbra should be able to detect it.
    """
    if not audio_path.exists():
        return AudioFeatures(available=False, message=f"audio not found: {audio_path}")

    loaded = _load_samples(audio_path)
    if loaded is None:
        return AudioFeatures(available=False, message="could not decode audio")

    data, sr = loaded
    total = len(data)
    if total == 0 or sr <= 0:
        return AudioFeatures(available=False, message="file contains no audio")

    acc = 0.0
    peak = 0.0
    for s in data:
        v = float(s)
        acc += v * v
        a = abs(v)
        if a > peak:
            peak = a

    rms = math.sqrt(acc / total)

    return AudioFeatures(
        available=True,
        duration=total / sr,
        sample_rate=sr,
        rms=rms,
        rms_db=_db(rms),
        peak=peak,
        peak_db=_db(peak),
        crest_factor=peak / (rms + 1e-10),
    )


def is_effectively_silent(audio_path: Path, threshold_db: float = -60.0) -> Optional[bool]:
    """True if a file is silent enough to be a generation failure.

    Returns ``None`` when the file cannot be measured, so callers can tell
    "silent" apart from "unknown".
    """
    features = analyze_features(audio_path)
    if not features.available:
        return None
    return features.peak_db < threshold_db
