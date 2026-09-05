"""MMAudio provider — video-conditioned Foley.

Given a video selection, MMAudio produces audio synchronised to what is on
screen: footsteps, cloth movement, impacts on contact frames. This is the
provider Umbra routes *physical, picture-locked* sound to.

Attribution note: MMAudio is Umbra's own independent open-source choice for
video-conditioned Foley. It is not a claim about any other product's internals.

This adapter is scaffolded and reports itself as not installed until the
weights and package are genuinely present — it never fabricates a result.
"""

from __future__ import annotations

import logging
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
from backend.services import model_manager
from backend.services.audio_store import AudioStore, get_audio_store
from backend.services.device import preferred_device

log = logging.getLogger("umbra.mmaudio")

CHECKPOINT_DIR_NAME = "mmaudio"


class MMAudioProvider(AudioProvider):
    id = "mmaudio"
    label = "MMAudio"
    blurb = "Video → synchronized audio"
    role = ProviderRole.VIDEO_FOLEY
    install_hint = "python scripts/setup_models.py --mmaudio"

    def __init__(self, store: Optional[AudioStore] = None):
        self.store = store or get_audio_store()

    def _local_path(self):
        p = model_manager.checkpoints_root() / CHECKPOINT_DIR_NAME
        return p if p.is_dir() and any(p.iterdir()) else None

    def status(self) -> ProviderStatus:
        local = self._local_path()
        pkg = model_manager.package_installed("mmaudio")
        ready = bool(local and pkg and model_manager.package_installed("torch"))
        device = preferred_device()

        notes: List[str] = []
        if not pkg:
            notes.append("mmaudio package not installed")
        if not local:
            notes.append("Weights not downloaded")
        if ready:
            notes.append("Needs a video selection — generates picture-locked Foley")

        return ProviderStatus(
            id=self.id,
            label=self.label,
            blurb=self.blurb,
            role=self.role,
            installed=bool(local and pkg),
            ready=ready,
            capabilities=(
                [Capability.VIDEO_CONDITIONED, Capability.SFX_GENERATION, Capability.SEED_CONTROL]
                if ready
                else []
            ),
            device=device.id if ready else None,
            device_detail=device.detail if ready else None,
            model="mmaudio" if local else None,
            size_bytes=model_manager.dir_size(local) if local else None,
            notes=notes,
            install_hint=self.install_hint,
        )

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        if not self.status().ready:
            raise ProviderError(
                "MMAudio is not installed. Video-conditioned Foley is unavailable.",
                http_status=503,
                hint=self.install_hint,
            )
        raise ProviderError(
            "MMAudio inference is not wired up in this build yet — install the model and "
            "the adapter will drive it. Umbra will not return placeholder audio.",
            http_status=501,
        )
