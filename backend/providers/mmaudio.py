"""Optional official MMAudio small_44k adapter. No downloads during generation.

The existing job queue owns this provider. Its short-lived inference child
isolates upstream HF caches / torch memory; it is not another backend or queue.
Every successful result goes through the canonical AudioStore decode contract.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import secrets
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

from backend.analysis.video import extract_range, probe_video, toolchain_status
from backend.providers.base import (
    AudioProvider, Capability, GenerationRequest, GenerationResult,
    ProviderError, ProviderRole, ProviderStatus, TaskType,
)
from backend.services import model_manager, mmaudio_models as models
from backend.services.audio_store import AudioStore, get_audio_store, probe_audio
from backend.services.device import preferred_device

MIN_DURATION = 1.0
MAX_DURATION = 8.0
RUNTIME_TIMEOUT = 14 * 60  # shorter than the existing client's 15-minute job timeout


def license_error(commercial_safe: bool, allow_noncommercial: bool) -> str | None:
    if commercial_safe is not False:
        return "MMAudio is blocked in commercial-safe workflows: its checkpoints are CC BY-NC 4.0."
    if allow_noncommercial is not True:
        return "MMAudio requires explicit noncommercial consent (allowNoncommercial: true)."
    return None


class MMAudioProvider(AudioProvider):
    id = "mmaudio"
    label = "MMAudio"
    blurb = "Video → synchronized audio · EXPERIMENTAL · NONCOMMERCIAL"
    role = ProviderRole.VIDEO_FOLEY
    install_hint = models.INSTALL_HINT

    def __init__(self, store: AudioStore | None = None):
        self.store = store or get_audio_store()
        self._lock = asyncio.Lock()
        self._error: str | None = None

    def status(self) -> ProviderStatus:
        local = models.model_root()
        missing = models.missing_files(local)
        deps = [p for p in ("mmaudio", "torch", "torchvision", "torchaudio", "open_clip", "av", "soundfile")
                if not model_manager.package_installed(p)]
        tools = toolchain_status()
        video_tools = all(tools[p]["available"] for p in ("ffmpeg", "ffprobe"))
        ready = not missing and not deps and video_tools
        device = preferred_device()
        notes = [f"{models.NOTICE} — checkpoints {models.LICENSE}; not commercial-safe."]
        if deps:
            notes.append("Missing packages: " + ", ".join(deps))
        if missing:
            notes.append("Missing/incomplete model files: " + ", ".join(missing))
        if not video_tools:
            notes.append("Install ffmpeg (including ffprobe) for video range extraction.")
        notes.append("Select 1–8 seconds of video. Installation is NOT runtime verification.")
        notes.append("CUDA preferred; MPS requires a working native generator at runtime; CPU float32 may be very slow or exhaust RAM.")
        return ProviderStatus(
            id=self.id, label=self.label, blurb=self.blurb, role=self.role,
            installed=model_manager.package_installed("mmaudio"), ready=ready,
            capabilities=[Capability.VIDEO_CONDITIONED, Capability.SFX_GENERATION,
                          Capability.SEED_CONTROL, Capability.DURATION_CONTROL,
                          Capability.NEGATIVE_DIRECTION] if ready else [],
            device=device.id if ready else None, device_detail=device.detail if ready else None,
            model=Path(models.CHECKPOINT).name if not missing else None,
            available_models=[models.MODEL] if not missing else [],
            version=model_manager.package_version("mmaudio"),
            size_bytes=model_manager.mmaudio_checkpoints()[0].size_bytes,
            notes=notes, install_hint=self.install_hint, error=self._error,
            experimental=True, commercial_safe=False, weights_license=models.LICENSE,
        )

    def validate_request(self, request: GenerationRequest) -> GenerationRequest:
        error = license_error(request.commercial_safe, request.allow_noncommercial)
        if error:
            raise ProviderError(error, http_status=403, hint="Choose a different provider, or explicitly opt in for noncommercial use.")
        if request.task != TaskType.GENERATE:
            raise ProviderError("MMAudio supports video-to-audio generation only, not repaint/continuation.", http_status=400)
        if not isinstance(request.video_path, (str, Path)) or not str(request.video_path).strip():
            raise ProviderError("MMAudio needs videoPath: a local video on the backend (upload it first).", http_status=400)

        def number(value, name):
            try:
                n = float(value)
                if isinstance(value, bool) or not math.isfinite(n):
                    raise ValueError
                return n
            except (TypeError, ValueError):
                raise ProviderError(f"{name} must be a finite number", http_status=400)

        start = number(request.video_start if request.video_start is not None else 0, "videoStart")
        end = number(request.video_end, "videoEnd") if request.video_end is not None else start + number(request.duration, "duration")
        if start < 0 or not MIN_DURATION <= end - start <= MAX_DURATION:
            raise ProviderError("Select a video range of 1–8 seconds with a nonnegative start; Umbra will not silently clamp it.", http_status=400)
        if request.seed is not None and (isinstance(request.seed, bool) or not isinstance(request.seed, int) or not 0 <= request.seed < 2**32):
            raise ProviderError("MMAudio seed must be an integer from 0 to 4294967295", http_status=400)
        advanced = request.advanced
        if advanced.get("model", models.MODEL) != models.MODEL:
            raise ProviderError("This adapter supports only MMAudio small_44k.", http_status=400)
        steps = number(advanced.get("inferenceSteps", advanced.get("inference_steps", 25)), "inferenceSteps")
        guidance = number(advanced.get("guidanceScale", advanced.get("guidance_scale", 4.5)), "guidanceScale")
        if not steps.is_integer() or not 1 <= steps <= 100 or not 0 <= guidance <= 20:
            raise ProviderError("MMAudio requires 1–100 integer steps and guidanceScale between 0 and 20.", http_status=400)
        path = Path(request.video_path).expanduser().resolve()
        if not path.is_file():
            raise ProviderError("MMAudio source video is missing. Re-upload it or supply a local videoPath.", http_status=400)
        return replace(request, video_path=str(path), video_start=start, video_end=end,
                       duration=end - start, timeline_start=start,
                       advanced={"inferenceSteps": int(steps), "guidanceScale": guidance})

    async def _infer(self, selection: Path, output: Path, request: GenerationRequest) -> dict:
        """Private process boundary; heavy inference is mocked here in CI."""
        local = models.model_root()
        config = output.with_suffix(".request.json")
        config.write_text(json.dumps({
            "video": str(selection), "output": str(output), "models": str(local),
            "prompt": request.prompt, "negativePrompt": request.negative_prompt,
            "duration": request.duration, "seed": request.seed, **request.advanced,
        }))
        env = {**os.environ, "HF_HOME": str(local / "hf-home"),
               "HF_HUB_CACHE": str(local / "hf-cache"), "HUGGINGFACE_HUB_CACHE": str(local / "hf-cache"),
               "TORCH_HOME": str(local / "torch-cache"), "HF_HUB_OFFLINE": "1",
               "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
               "PYTORCH_ENABLE_MPS_FALLBACK": "0"}
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.providers.mmaudio_runtime", str(config),
            cwd=str(Path(__file__).resolve().parents[2]), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=RUNTIME_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            detail = stdout.decode("utf-8", "replace")[-3000:]
            raise ProviderError(f"MMAudio inference failed (exit {process.returncode}; a killed process may indicate insufficient RAM/VRAM): {detail}",
                                hint="Check the local torch/ffmpeg install and memory; try a shorter selection on supported hardware.")
        return json.loads(output.with_suffix(".json").read_text())

    async def generate(self, request: GenerationRequest) -> GenerationResult:
        request = self.validate_request(request)
        status = self.status()
        if not status.ready:
            raise ProviderError("MMAudio is unavailable. " + " ".join(status.notes), http_status=503, hint=self.install_hint)
        async with self._lock:
            try:
                info = await asyncio.to_thread(probe_video, Path(request.video_path))
                if not info.available or not info.video_codec or not math.isfinite(info.duration) or request.video_end > info.duration + 1e-6:
                    raise ProviderError(info.message or "Selected range extends beyond the source video or it has no video stream.", http_status=400)
                request = replace(request, seed=request.seed if request.seed is not None else secrets.randbelow(2**32))
                with tempfile.TemporaryDirectory(prefix="mmaudio-", dir=self.store.root) as tmp:
                    selection, output = Path(tmp) / "selection.mp4", Path(tmp) / "generated.wav"
                    cut = await asyncio.to_thread(extract_range, Path(request.video_path), selection,
                                                  request.video_start, request.video_end, with_audio=False)
                    if not cut.ok:
                        raise ProviderError(cut.message or "Video range extraction failed.")
                    runtime = await self._infer(selection, output, request)
                    sr, channels, frames = probe_audio(output)
                    if sr != 44100 or channels not in (1, 2) or not max(MIN_DURATION, request.duration - 0.125) <= frames / sr <= request.duration + 1 / sr:
                        raise ProviderError("MMAudio returned an invalid sample rate, channel count or duration.")
                    metadata = {
                        **runtime, **models.provenance(),
                        "prompt": request.prompt, "negativePrompt": request.negative_prompt,
                        "seed": request.seed, "task": request.task.value,
                        "videoPath": request.video_path,
                        "sourceVideoStart": request.video_start, "sourceVideoEnd": request.video_end,
                        "requestedDuration": request.duration, "generatedDuration": frames / sr,
                        "timelineStart": request.video_start, "sceneId": request.scene_id,
                        "generationSettings": request.advanced,
                    }
                    record = self.store.register(output, provider=self.id, metadata=metadata, move=True)
                self._error = None
                return GenerationResult(
                    audio_id=record.id, url=f"/api/audio/{record.id}", duration=record.duration,
                    sample_rate=record.sample_rate, channels=record.channels, frames=record.frames,
                    bytes=record.bytes, provider=self.id, metadata=record.metadata,
                )
            except asyncio.TimeoutError:
                self._error = "MMAudio timed out on this machine; no audio was registered."
                raise ProviderError(self._error, hint="Try a shorter video range or a machine with more memory / CUDA.")
            except Exception as exc:
                self._error = str(exc)
                if isinstance(exc, ProviderError):
                    raise
                raise ProviderError(f"MMAudio failed: {exc}", hint=self.install_hint) from exc
