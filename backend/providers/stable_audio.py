"""Stable Audio Open provider — text to sound design.

Handles *physical and environmental* sound: rusted ventilation machinery,
room tone, metal scrape, water, distant traffic. It is deliberately NOT used
for musical score (that is ACE-Step) and not for precise synthetic elements
(that is Umbra Procedural).

Note on attribution: Stable Audio Open is Umbra's own independent choice of an
open text-to-audio model. It is not a claim about any other product's
internals.

Inference goes through Hugging Face Diffusers' ``StableAudioPipeline`` rather
than a hand-rolled diffusion loop.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
from typing import Any, Dict, List, Optional

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

log = logging.getLogger("umbra.stable_audio")

DEFAULT_MODEL = os.environ.get("UMBRA_STABLE_AUDIO_MODEL", "stabilityai/stable-audio-open-1.0")
CHECKPOINT_DIR_NAME = "stable-audio-open-1.0"

# Stable Audio Open 1.0 generates up to 47 s at 44.1 kHz stereo.
MAX_DURATION = 47.0


class StableAudioProvider(AudioProvider):
    id = "stable-audio"
    label = "Stable Audio Open"
    blurb = "Text → sound design"
    role = ProviderRole.SOUND_DESIGN
    install_hint = "python scripts/setup_models.py --stable-audio"

    def __init__(self, store: Optional[AudioStore] = None):
        self.store = store or get_audio_store()
        self._pipe = None
        self._lock = asyncio.Lock()

    def _local_path(self):
        p = model_manager.checkpoints_root() / CHECKPOINT_DIR_NAME
        return p if p.is_dir() and any(p.iterdir()) else None

    def _deps_ok(self) -> bool:
        return all(model_manager.package_installed(m) for m in ("torch", "diffusers", "soundfile"))

    def status(self) -> ProviderStatus:
        local = self._local_path()
        deps = self._deps_ok()
        ready = bool(local and deps)
        device = preferred_device()

        notes: List[str] = []
        if not deps:
            notes.append("Requires torch + diffusers + soundfile")
        if not local:
            notes.append("Weights not downloaded (gated model — accept the licence on Hugging Face)")
        if ready:
            notes.append("Handles environmental and physical sound, not musical score")
            notes.append(f"Maximum generation length {MAX_DURATION:.0f}s")

        return ProviderStatus(
            id=self.id,
            label=self.label,
            blurb=self.blurb,
            role=self.role,
            installed=bool(local),
            ready=ready,
            capabilities=(
                [
                    Capability.SFX_GENERATION,
                    Capability.DURATION_CONTROL,
                    Capability.SEED_CONTROL,
                    Capability.NEGATIVE_DIRECTION,
                ]
                if ready
                else []
            ),
            device=device.id if ready else None,
            device_detail=device.detail if ready else None,
            model=DEFAULT_MODEL if local else None,
            available_models=[DEFAULT_MODEL] if local else [],
            version=model_manager.package_version("diffusers"),
            size_bytes=model_manager.dir_size(local) if local else None,
            notes=notes,
            install_hint=self.install_hint,
        )

    async def _ensure_pipe(self):
        if self._pipe is not None:
            return self._pipe
        async with self._lock:
            if self._pipe is not None:
                return self._pipe
            local = self._local_path()
            if local is None:
                raise ProviderError(
                    "Stable Audio Open weights are not installed.",
                    http_status=503,
                    hint=self.install_hint,
                )

            def _load():
                import torch  # type: ignore
                from diffusers import StableAudioPipeline  # type: ignore

                device = preferred_device().id
                dtype = torch.float16 if device == "cuda" else torch.float32
                pipe = StableAudioPipeline.from_pretrained(str(local), torch_dtype=dtype)
                return pipe.to("cuda" if device == "cuda" else "mps" if device == "mps" else "cpu")

            self._pipe = await asyncio.to_thread(_load)
            return self._pipe

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        if not request.prompt.strip():
            raise ProviderError("Stable Audio needs a prompt describing the sound.", http_status=400)
        pipe = await self._ensure_pipe()
        duration = max(1.0, min(MAX_DURATION, float(request.duration)))
        seed = request.seed
        steps = int(request.advanced.get("inferenceSteps", request.advanced.get("inference_steps", 100)))

        def _run() -> bytes:
            import numpy as np  # type: ignore
            import soundfile as sf  # type: ignore
            import torch  # type: ignore

            generator = None
            if seed is not None:
                generator = torch.Generator(device="cpu").manual_seed(int(seed))
            out = pipe(
                prompt=request.prompt,
                negative_prompt=request.negative_prompt or None,
                num_inference_steps=steps,
                audio_end_in_s=duration,
                num_waveforms_per_prompt=1,
                generator=generator,
            )
            audio = out.audios[0].to(torch.float32).cpu().numpy().T  # (frames, channels)
            audio = np.clip(audio, -1.0, 1.0)
            buf = io.BytesIO()
            sf.write(buf, audio, int(pipe.vae.sampling_rate), format="WAV", subtype="PCM_24")
            return buf.getvalue()

        data = await asyncio.to_thread(_run)
        metadata: Dict[str, Any] = {
            "provider": self.id,
            "model": DEFAULT_MODEL,
            "prompt": request.prompt,
            "negativePrompt": request.negative_prompt or None,
            "seed": seed,
            "requestedDuration": duration,
            "inferenceSteps": steps,
            "sceneId": request.scene_id,
            "timelineStart": request.timeline_start,
        }
        record = self.store.register_bytes(
            data,
            provider=self.id,
            suffix=".wav",
            metadata=metadata,
            filename=(request.label or "stable-audio-sfx").replace(" ", "_") + ".wav",
        )
        return GenerationResult(
            audio_id=record.id,
            url=f"/api/audio/{record.id}",
            duration=record.duration,
            sample_rate=record.sample_rate,
            channels=record.channels,
            frames=record.frames,
            bytes=record.bytes,
            provider=self.id,
            metadata=record.metadata,
        )
