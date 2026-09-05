"""UMBRA PROCEDURAL — first-class provider, rendered in the browser.

Umbra's original procedural engine is genuine Web Audio synthesis: 17 voice
classes, channel strips, convolution spaces, hit ducking, sub bus, glue /
tape / mid-side / true-peak master chain, BS.1770 loudness conform, and an
offline OfflineAudioContext bounce. None of that moves to Python.

This class exists so the procedural engine appears in the same registry,
Models view and router as the trained providers, with an honest description of
where it runs. Generation requests are answered with a directive telling the
frontend to synthesize locally — instant, deterministic and offline.
"""

from __future__ import annotations

from typing import List, Optional

from backend.providers.base import (
    AudioProvider,
    Capability,
    GenerationRequest,
    GenerationResult,
    ProviderError,
    ProviderRole,
    ProviderStatus,
)


class UmbraProceduralProvider(AudioProvider):
    id = "umbra-procedural"
    label = "Umbra Procedural"
    blurb = "Instant deterministic synthesis"
    role = ProviderRole.PROCEDURAL

    def status(self) -> ProviderStatus:
        return ProviderStatus(
            id=self.id,
            label=self.label,
            blurb=self.blurb,
            role=self.role,
            installed=True,
            ready=True,
            capabilities=[
                Capability.SFX_GENERATION,
                Capability.MUSIC_GENERATION,
                Capability.DURATION_CONTROL,
                Capability.SEED_CONTROL,
                Capability.KEY_CONDITIONING,
            ],
            device="browser",
            device_detail="Web Audio API",
            model="umbra-voices-17",
            version="built-in",
            notes=[
                "Runs entirely in the browser — no model, no download, no network",
                "17 synthesis classes with scene-key coherence and sync-hit alignment",
                "Deterministic: the same seed always produces the same audio",
            ],
        )

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        raise ProviderError(
            "Umbra Procedural renders in the browser through Web Audio — the Python "
            "service does not synthesize it. The frontend handles this provider locally.",
            http_status=400,
        )
