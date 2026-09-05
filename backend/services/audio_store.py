"""Local audio store.

Everything a provider produces lands here as a real file on local disk. The
store is the single place that enforces Umbra's *real result contract*:

    generation request -> inference -> decoded audio -> real WAV -> AudioClip

Nothing is registered without being decoded first, so ``duration``,
``sampleRate``, ``channels`` and ``frames`` are always measured values rather
than whatever a model wrapper claimed.

User-supplied reference audio also lives here and never leaves the machine.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class AudioRecord:
    """A verified audio file held by the store."""

    id: str
    path: str
    filename: str
    duration: float
    sample_rate: int
    channels: int
    frames: int
    bytes: int
    provider: str
    created_at: float
    kind: str = "generated"  # "generated" | "reference" | "upload"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> Dict[str, Any]:
        d = asdict(self)
        d.pop("path", None)
        return {
            "audioId": d["id"],
            "filename": d["filename"],
            "duration": d["duration"],
            "sampleRate": d["sample_rate"],
            "channels": d["channels"],
            "frames": d["frames"],
            "bytes": d["bytes"],
            "provider": d["provider"],
            "createdAt": d["created_at"],
            "kind": d["kind"],
            "metadata": d["metadata"],
            "url": f"/api/audio/{d['id']}",
        }


class AudioDecodeError(RuntimeError):
    """Raised when a file cannot be decoded — i.e. it is not real audio."""


def _probe_with_soundfile(path: Path):
    try:
        import soundfile as sf  # type: ignore
    except Exception:
        return None
    try:
        info = sf.info(str(path))
    except Exception:
        return None
    return int(info.samplerate), int(info.channels), int(info.frames)


def _probe_wav(path: Path):
    """Stdlib fallback so the store works before soundfile is installed."""
    try:
        with wave.open(str(path), "rb") as w:
            return w.getframerate(), w.getnchannels(), w.getnframes()
    except Exception:
        return None


def probe_audio(path: Path):
    """Decode-probe a file. Returns ``(sample_rate, channels, frames)``.

    Raises :class:`AudioDecodeError` when the file is not decodable audio —
    this is what makes a "generation succeeded" claim verifiable.
    """
    if not path.exists():
        raise AudioDecodeError(f"audio file does not exist: {path}")
    if path.stat().st_size == 0:
        raise AudioDecodeError(f"audio file is empty: {path}")

    probed = _probe_with_soundfile(path) or _probe_wav(path)
    if probed is None:
        raise AudioDecodeError(
            f"could not decode audio at {path.name} — install 'soundfile' for "
            "non-WAV formats, or have the provider emit WAV"
        )
    sample_rate, channels, frames = probed
    if sample_rate <= 0 or frames <= 0 or channels <= 0:
        raise AudioDecodeError(
            f"decoded audio is degenerate: sr={sample_rate} ch={channels} frames={frames}"
        )
    return sample_rate, channels, frames


class AudioStore:
    """Filesystem-backed store with a small JSON index."""

    def __init__(self, root: Optional[Path] = None):
        self.root = Path(root or os.environ.get("UMBRA_AUDIO_DIR") or (Path.cwd() / ".umbra" / "audio"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.json"
        self._lock = threading.Lock()
        self._records: Dict[str, AudioRecord] = {}
        self._load()

    # ------------------------------------------------------------------ io --
    def _load(self) -> None:
        if not self.index_path.exists():
            return
        try:
            raw = json.loads(self.index_path.read_text())
        except Exception:
            return
        for item in raw.get("records", []):
            try:
                rec = AudioRecord(**item)
            except TypeError:
                continue
            if Path(rec.path).exists():
                self._records[rec.id] = rec

    def _save(self) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        payload = {"records": [asdict(r) for r in self._records.values()]}
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(self.index_path)

    # ------------------------------------------------------------- register --
    def register(
        self,
        source: Path,
        *,
        provider: str,
        kind: str = "generated",
        metadata: Optional[Dict[str, Any]] = None,
        move: bool = False,
        filename: Optional[str] = None,
    ) -> AudioRecord:
        """Verify and adopt an audio file produced by a provider.

        The file is decoded *before* it is registered. If it will not decode,
        nothing is stored and the caller gets an exception — a provider can
        never report success for audio that does not exist.
        """
        source = Path(source)
        sample_rate, channels, frames = probe_audio(source)

        audio_id = uuid.uuid4().hex[:16]
        suffix = source.suffix or ".wav"
        target_name = f"{audio_id}{suffix}"
        target = self.root / target_name

        if move:
            shutil.move(str(source), str(target))
        else:
            shutil.copy2(str(source), str(target))

        rec = AudioRecord(
            id=audio_id,
            path=str(target),
            filename=filename or f"umbra_{provider}_{audio_id}{suffix}",
            duration=round(frames / float(sample_rate), 6),
            sample_rate=sample_rate,
            channels=channels,
            frames=frames,
            bytes=target.stat().st_size,
            provider=provider,
            created_at=time.time(),
            kind=kind,
            metadata=dict(metadata or {}),
        )
        with self._lock:
            self._records[audio_id] = rec
            self._save()
        return rec

    def register_bytes(
        self,
        data: bytes,
        *,
        provider: str,
        suffix: str = ".wav",
        kind: str = "generated",
        metadata: Optional[Dict[str, Any]] = None,
        filename: Optional[str] = None,
    ) -> AudioRecord:
        staging = self.root / f".staging-{uuid.uuid4().hex}{suffix}"
        staging.write_bytes(data)
        try:
            return self.register(
                staging, provider=provider, kind=kind, metadata=metadata, move=True, filename=filename
            )
        finally:
            if staging.exists():
                staging.unlink()

    # ----------------------------------------------------------------- read --
    def get(self, audio_id: str) -> Optional[AudioRecord]:
        return self._records.get(audio_id)

    def path_for(self, audio_id: str) -> Optional[Path]:
        rec = self.get(audio_id)
        if rec is None:
            return None
        p = Path(rec.path)
        return p if p.exists() else None

    def list(self, kind: Optional[str] = None) -> List[AudioRecord]:
        out = [r for r in self._records.values() if kind is None or r.kind == kind]
        return sorted(out, key=lambda r: r.created_at, reverse=True)

    def delete(self, audio_id: str) -> bool:
        with self._lock:
            rec = self._records.pop(audio_id, None)
            if rec is None:
                return False
            try:
                Path(rec.path).unlink(missing_ok=True)
            except Exception:
                pass
            self._save()
            return True

    def stats(self) -> Dict[str, Any]:
        recs = list(self._records.values())
        return {
            "count": len(recs),
            "bytes": sum(r.bytes for r in recs),
            "seconds": round(sum(r.duration for r in recs), 2),
            "root": str(self.root),
        }


_store: Optional[AudioStore] = None


def get_audio_store() -> AudioStore:
    global _store
    if _store is None:
        _store = AudioStore()
    return _store
