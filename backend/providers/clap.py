"""CLAP provider — semantic audio embeddings and library search.

CLAP embeds audio and text into a shared space, which lets a composer ask
"find something in my library that sounds like distant metal scraping" and
get real matches from their own files rather than filename substring hits.

CLAP does not generate audio; it advertises SEMANTIC_SEARCH / EMBEDDINGS only.
"""

from __future__ import annotations

import asyncio
import logging
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.providers.base import (
    AudioProvider,
    Capability,
    GenerationRequest,
    GenerationResult,
    ProviderError,
    ProviderRole,
    ProviderStatus,
)
from backend.services import model_manager
from backend.services.audio_store import AudioStore, get_audio_store
from backend.services.device import preferred_device

log = logging.getLogger("umbra.clap")

DEFAULT_MODEL = "laion/clap-htsat-unfused"
CHECKPOINT_DIR_NAME = "clap-htsat-unfused"


class ClapProvider(AudioProvider):
    id = "clap"
    label = "Library Match"
    blurb = "Semantic sound search"
    role = ProviderRole.SEMANTIC
    install_hint = "python scripts/setup_models.py --clap"

    def __init__(self, store: Optional[AudioStore] = None):
        self.store = store or get_audio_store()
        self._model = None
        self._processor = None
        self._lock = asyncio.Lock()
        self._audio_cache: Dict[str, List[float]] = {}

    def _local_path(self):
        p = model_manager.checkpoints_root() / CHECKPOINT_DIR_NAME
        return p if p.is_dir() and any(p.iterdir()) else None

    def _deps_ok(self) -> bool:
        return all(
            model_manager.package_installed(m) for m in ("torch", "transformers", "soundfile")
        )

    def status(self) -> ProviderStatus:
        local = self._local_path()
        ready = bool(local and self._deps_ok())
        device = preferred_device()
        notes: List[str] = []
        if not self._deps_ok():
            notes.append("Requires torch + transformers + soundfile")
        if not local:
            notes.append("Weights not downloaded")
        if ready:
            notes.append("Searches your own local library — nothing is uploaded")

        return ProviderStatus(
            id=self.id,
            label=self.label,
            blurb=self.blurb,
            role=self.role,
            installed=bool(local),
            ready=ready,
            capabilities=[Capability.SEMANTIC_SEARCH, Capability.EMBEDDINGS] if ready else [],
            device=device.id if ready else None,
            device_detail=device.detail if ready else None,
            model=DEFAULT_MODEL if local else None,
            size_bytes=model_manager.dir_size(local) if local else None,
            notes=notes,
            install_hint=self.install_hint,
        )

    async def _ensure_model(self):
        if self._model is not None:
            return
        async with self._lock:
            if self._model is not None:
                return
            local = self._local_path()
            if local is None:
                raise ProviderError(
                    "CLAP weights are not installed.", http_status=503, hint=self.install_hint
                )

            def _load():
                from transformers import ClapModel, ClapProcessor  # type: ignore

                model = ClapModel.from_pretrained(str(local)).eval()
                processor = ClapProcessor.from_pretrained(str(local))
                return model, processor

            self._model, self._processor = await asyncio.to_thread(_load)

    async def embed_text(self, text: str) -> List[float]:
        await self._ensure_model()

        def _run() -> List[float]:
            import torch  # type: ignore

            inputs = self._processor(text=[text], return_tensors="pt", padding=True)
            with torch.no_grad():
                feats = self._model.get_text_features(**inputs)
            v = feats[0]
            v = v / v.norm(p=2)
            return v.tolist()

        return await asyncio.to_thread(_run)

    async def embed_audio(self, path: Path) -> List[float]:
        await self._ensure_model()
        key = str(path)
        if key in self._audio_cache:
            return self._audio_cache[key]

        def _run() -> List[float]:
            import numpy as np  # type: ignore
            import soundfile as sf  # type: ignore
            import torch  # type: ignore

            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            mono = data.mean(axis=1)
            target_sr = 48000
            if sr != target_sr:  # CLAP expects 48 kHz
                idx = np.linspace(0, len(mono) - 1, int(len(mono) * target_sr / sr))
                mono = np.interp(idx, np.arange(len(mono)), mono).astype("float32")
            # cap at 30 s to bound memory
            mono = mono[: target_sr * 30]
            inputs = self._processor(audios=mono, sampling_rate=target_sr, return_tensors="pt")
            with torch.no_grad():
                feats = self._model.get_audio_features(**inputs)
            v = feats[0]
            v = v / v.norm(p=2)
            return v.tolist()

        vec = await asyncio.to_thread(_run)
        self._audio_cache[key] = vec
        return vec

    async def search(self, query: str, limit: int = 12) -> List[Dict[str, Any]]:
        """Rank every local audio record against a text query."""
        qv = await self.embed_text(query)
        scored: List[Tuple[float, Any]] = []
        for rec in self.store.list():
            p = Path(rec.path)
            if not p.exists():
                continue
            try:
                av = await self.embed_audio(p)
            except Exception as exc:
                log.warning("CLAP could not embed %s: %s", p.name, exc)
                continue
            score = sum(a * b for a, b in zip(qv, av))
            if math.isnan(score):
                continue
            scored.append((score, rec))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [{**rec.to_json(), "score": round(score, 4)} for score, rec in scored[:limit]]

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        raise ProviderError(
            "CLAP is a search and embedding provider — it does not generate audio. "
            "Use it through /api/search.",
            http_status=400,
        )
