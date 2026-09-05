"""ACE-Step 1.5 provider — Umbra's trained SCORING engine.

ACE-Step 1.5 (https://github.com/ace-step/ACE-Step-1.5, MIT) is an open
generative music foundation model co-developed by ACE Studio and StepFun. In
Umbra it handles *musical material only*: tonal beds, dissonant string
textures, ritual percussion, spectral smears. Foley, room tone and physical
environmental sound are explicitly routed elsewhere (see ``registry.py``).

Two integration modes, chosen automatically:

``server``
    Talk to an already-running ``acestep.api_server`` over HTTP. This is the
    default and the recommended path: ACE-Step's own FastAPI service owns model
    loading, its queue and its VRAM, and Umbra stays a client. Endpoints used
    are the documented ones — ``POST /release_task``, ``POST /query_result``,
    ``GET /v1/models``, ``GET /v1/audio``, ``GET /health``.

``inprocess``
    Import ``acestep`` directly and call its pipeline in this process. Used
    when ACE-Step is pip-installed into the same environment.

Capabilities are derived from the checkpoint that is actually loaded. ACE-Step
restricts task types by model family (``acestep/constants.py``):

    TASK_TYPES_TURBO = ["text2music", "repaint", "cover", "cover-nofsq"]
    TASK_TYPES_BASE  = TURBO + ["extract", "lego", "complete"]

So ``CONTINUATION``/``ACCOMPANIMENT`` (which map to ``complete``/``lego``) are
advertised **only** when a base-family checkpoint is active. We never claim a
capability the installed version does not have.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
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
    TaskType,
)
from backend.services import model_manager
from backend.services.audio_store import AudioStore, get_audio_store
from backend.services.device import preferred_device

log = logging.getLogger("umbra.ace_step")

DEFAULT_BASE_URL = os.environ.get("UMBRA_ACE_STEP_URL", "http://127.0.0.1:8001")

# ACE-Step metadata bounds (acestep/constants.py).
BPM_MIN, BPM_MAX = 30, 300
DURATION_MIN, DURATION_MAX = 10.0, 600.0
VALID_TIME_SIGNATURES = {"2", "3", "4", "6"}

# Model families that expose the full base task set.
_BASE_FAMILY_MARKERS = ("base", "sft")
_TURBO_TASKS = {"text2music", "repaint", "cover", "cover-nofsq"}
_BASE_TASKS = _TURBO_TASKS | {"extract", "lego", "complete"}


def _is_base_family(model_name: Optional[str]) -> bool:
    """Turbo checkpoints expose fewer tasks than base/sft checkpoints."""
    if not model_name:
        return False
    name = model_name.lower()
    if "turbo" in name:
        return False
    return any(marker in name for marker in _BASE_FAMILY_MARKERS)


def clamp_duration(seconds: float) -> float:
    return max(DURATION_MIN, min(DURATION_MAX, float(seconds)))


def clamp_bpm(bpm: Optional[int]) -> Optional[int]:
    if bpm is None:
        return None
    return max(BPM_MIN, min(BPM_MAX, int(bpm)))


class AceStepProvider(AudioProvider):
    id = "ace-step"
    label = "ACE-Step"
    blurb = "AI scoring / music generation"
    role = ProviderRole.MUSICAL_SCORE
    install_hint = "python scripts/setup_models.py --ace-step"

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        store: Optional[AudioStore] = None,
        timeout: float = 900.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.store = store or get_audio_store()
        self.timeout = timeout
        self._server_cache: Optional[Tuple[float, Dict[str, Any]]] = None
        self._cache_ttl = 5.0

    # ------------------------------------------------------------- probing --
    def _package_installed(self) -> bool:
        return model_manager.package_installed("acestep")

    def _probe_server(self) -> Dict[str, Any]:
        """Ask a running ACE-Step API server what it actually has loaded."""
        now = time.time()
        if self._server_cache and now - self._server_cache[0] < self._cache_ttl:
            return self._server_cache[1]

        result: Dict[str, Any] = {"online": False, "models": [], "default_model": None, "error": None}
        try:
            import httpx  # type: ignore
        except Exception:
            result["error"] = "httpx not installed — cannot reach the ACE-Step API server"
            self._server_cache = (now, result)
            return result

        try:
            with httpx.Client(timeout=3.0) as client:
                health = client.get(f"{self.base_url}/health")
                if health.status_code != 200:
                    raise RuntimeError(f"health returned {health.status_code}")
                result["online"] = True
                try:
                    models = client.get(f"{self.base_url}/v1/models")
                    if models.status_code == 200:
                        payload = models.json().get("data") or {}
                        result["models"] = [
                            m.get("name") for m in payload.get("models", []) if m.get("name")
                        ]
                        result["default_model"] = payload.get("default_model")
                except Exception as exc:  # server up but model list unavailable
                    result["error"] = f"model list unavailable: {exc}"
        except Exception as exc:
            result["error"] = str(exc)

        self._server_cache = (now, result)
        return result

    def _active_model(self) -> Tuple[Optional[str], List[str], str]:
        """Return ``(active_model, available_models, mode)`` from real state."""
        server = self._probe_server()
        if server["online"]:
            models = server["models"] or []
            active = server["default_model"] or (models[0] if models else None)
            return active, models, "server"
        local = model_manager.ace_step_installed_dit_models()
        if local and self._package_installed():
            override = os.environ.get("ACESTEP_CONFIG_PATH")
            active = override if override in local else local[0]
            return active, local, "inprocess"
        return None, local, "unavailable"

    def _capabilities(self, active_model: Optional[str], ready: bool) -> List[Capability]:
        """Only advertise what the active checkpoint genuinely supports."""
        if not ready:
            return []
        caps = [
            Capability.MUSIC_GENERATION,
            Capability.DURATION_CONTROL,
            Capability.SEED_CONTROL,
            Capability.KEY_CONDITIONING,
            Capability.BPM_CONDITIONING,
            Capability.TIME_SIGNATURE_CONDITIONING,
            # `cover` with a reference + low cover strength is ACE-Step's
            # documented style-transfer path; available on turbo and base.
            Capability.REFERENCE_AUDIO,
            Capability.REPAINT,
        ]
        tasks = _BASE_TASKS if _is_base_family(active_model) else _TURBO_TASKS
        if "complete" in tasks:
            caps.append(Capability.CONTINUATION)
        if "lego" in tasks:
            caps.append(Capability.ACCOMPANIMENT)
        if model_manager.package_installed("peft"):
            caps.append(Capability.LORA)
        return caps

    def status(self) -> ProviderStatus:
        active, models, mode = self._active_model()
        server = self._probe_server()
        installed = self._package_installed() or server["online"]
        ready = mode in ("server", "inprocess")

        device = preferred_device()
        notes: List[str] = []
        if mode == "server":
            notes.append(f"Connected to ACE-Step API server at {self.base_url}")
        elif mode == "inprocess":
            notes.append("acestep package importable — in-process inference")
            notes.append("Starting the ACE-Step API server is recommended for queueing and model reuse")
        else:
            if not installed:
                notes.append("ACE-Step is not installed in this environment")
            elif server.get("error"):
                notes.append(f"No ACE-Step API server reachable at {self.base_url}")

        if ready and not _is_base_family(active):
            notes.append(
                "Turbo checkpoint active — continuation/accompaniment need a base or sft checkpoint"
            )

        size = None
        if ready:
            root = model_manager.checkpoints_root()
            if active:
                size = model_manager.dir_size(root / active)

        return ProviderStatus(
            id=self.id,
            label=self.label,
            blurb=self.blurb,
            role=self.role,
            installed=installed,
            ready=ready,
            capabilities=self._capabilities(active, ready),
            device=device.id if ready else None,
            device_detail=device.detail if ready else None,
            model=active,
            available_models=models,
            version=model_manager.package_version("acestep"),
            size_bytes=size,
            notes=notes,
            install_hint=self.install_hint,
            error=None if ready else (server.get("error") or None),
        )

    # -------------------------------------------------------- request build --
    def _resolve_task(self, request: GenerationRequest, active_model: Optional[str]) -> str:
        """Map an Umbra task to an ACE-Step ``task_type``, honestly."""
        tasks = _BASE_TASKS if _is_base_family(active_model) else _TURBO_TASKS

        if request.task is TaskType.GENERATE:
            # A reference clip turns plain generation into style transfer.
            if request.reference_audio_id:
                return "cover"
            return "text2music"
        if request.task is TaskType.REFERENCE:
            return "cover"
        if request.task is TaskType.REPAINT:
            return "repaint"
        if request.task is TaskType.CONTINUE:
            if "complete" not in tasks:
                raise ProviderError(
                    "Continuation needs an ACE-Step base or sft checkpoint — the active "
                    f"checkpoint ({active_model or 'unknown'}) only supports "
                    f"{sorted(tasks)}.",
                    http_status=409,
                    hint="python scripts/setup_models.py --ace-step-base",
                )
            return "complete"
        if request.task is TaskType.ACCOMPANY:
            if "lego" not in tasks:
                raise ProviderError(
                    "Accompaniment needs an ACE-Step base or sft checkpoint — the active "
                    f"checkpoint ({active_model or 'unknown'}) only supports "
                    f"{sorted(tasks)}.",
                    http_status=409,
                    hint="python scripts/setup_models.py --ace-step-base",
                )
            return "lego"
        return "text2music"

    def build_payload(
        self, request: GenerationRequest, active_model: Optional[str]
    ) -> Dict[str, Any]:
        """Translate an Umbra request into ACE-Step's ``/release_task`` schema.

        Kept pure and side-effect free so it is directly unit-testable.
        """
        task_type = self._resolve_task(request, active_model)
        duration = clamp_duration(request.duration)

        payload: Dict[str, Any] = {
            "prompt": request.prompt,
            "task_type": task_type,
            "audio_duration": duration,
            "audio_format": "wav",
            "batch_size": 1,
            # Umbra scores film. Lyrics are opt-in; the default is instrumental.
            "lyrics": "" if request.instrumental else request.lyrics,
        }

        if request.seed is not None:
            payload["use_random_seed"] = False
            payload["seed"] = int(request.seed)
        else:
            payload["use_random_seed"] = True

        key_scale = request.key_scale()
        if key_scale:
            payload["key_scale"] = key_scale
        bpm = clamp_bpm(request.bpm)
        if bpm is not None:
            payload["bpm"] = bpm
        if request.time_signature and str(request.time_signature) in VALID_TIME_SIGNATURES:
            payload["time_signature"] = str(request.time_signature)

        # Negative direction: ACE-Step exposes a negative prompt through the
        # 5Hz LM's CFG path (lm_negative_prompt). It only has an effect when
        # the LM runs, so we also enable thinking when one is supplied.
        if request.negative_prompt:
            payload["lm_negative_prompt"] = request.negative_prompt
            payload["lm_cfg_scale"] = float(request.advanced.get("lmCfgScale", 2.5))

        # Repaint window
        if task_type == "repaint":
            payload["repainting_start"] = float(request.repaint_start or 0.0)
            if request.repaint_end is not None:
                payload["repainting_end"] = float(request.repaint_end)
            payload["chunk_mask_mode"] = "explicit"
            payload["repaint_mode"] = request.advanced.get("repaintMode", "balanced")
            payload["repaint_strength"] = float(request.advanced.get("repaintStrength", 0.5))

        # Style transfer strength — lower values preserve the reference's world.
        if task_type in ("cover", "cover-nofsq"):
            payload["audio_cover_strength"] = float(
                request.advanced.get("coverStrength", max(0.05, min(1.0, request.reference_strength)))
            )

        # Expert overrides, allow-listed so the UI cannot smuggle nonsense in.
        allowed = {
            "inference_steps", "guidance_scale", "shift", "infer_method",
            "timesteps", "use_adg", "cfg_interval_start", "cfg_interval_end",
            "thinking", "use_format", "lm_temperature", "lm_top_p",
            "lm_repetition_penalty", "use_cot_caption", "model",
        }
        camel = {
            "inferenceSteps": "inference_steps",
            "guidanceScale": "guidance_scale",
            "inferMethod": "infer_method",
            "useAdg": "use_adg",
            "lmTemperature": "lm_temperature",
            "lmTopP": "lm_top_p",
            "useCotCaption": "use_cot_caption",
        }
        for key, value in request.advanced.items():
            target = camel.get(key, key)
            if target in allowed and value is not None:
                payload[target] = value

        if active_model and "model" not in payload:
            payload["model"] = active_model
        return payload

    # ----------------------------------------------------------- generation --
    async def generate(self, request: GenerationRequest) -> GenerationResult:
        active, _models, mode = self._active_model()
        if mode == "unavailable":
            raise ProviderError(
                "ACE-Step is not available. Install it and either start its API server "
                f"(expected at {self.base_url}) or install the acestep package locally.",
                http_status=503,
                hint=self.install_hint,
            )
        if not request.prompt.strip() and request.task is TaskType.GENERATE:
            raise ProviderError("ACE-Step needs a prompt describing the cue.", http_status=400)

        payload = self.build_payload(request, active)

        # Attach local audio paths for reference / repaint / continuation.
        if request.reference_audio_id:
            p = self.store.path_for(request.reference_audio_id)
            if p is None:
                raise ProviderError(
                    f"reference audio {request.reference_audio_id} not found in the local store",
                    http_status=400,
                )
            payload["reference_audio_path"] = str(p)
        if request.source_audio_id:
            p = self.store.path_for(request.source_audio_id)
            if p is None:
                raise ProviderError(
                    f"source audio {request.source_audio_id} not found in the local store",
                    http_status=400,
                )
            payload["src_audio_path"] = str(p)

        if payload["task_type"] in ("repaint", "cover", "cover-nofsq") and not payload.get("src_audio_path"):
            if payload.get("reference_audio_path") and payload["task_type"] != "repaint":
                payload["src_audio_path"] = payload["reference_audio_path"]
            elif payload["task_type"] == "repaint":
                raise ProviderError(
                    "Repaint needs a source clip — select an existing ACE-Step cue first.",
                    http_status=400,
                )

        started = time.time()
        if mode == "server":
            audio_bytes, suffix, info = await self._generate_via_server(payload)
        else:
            audio_bytes, suffix, info = await self._generate_in_process(payload)

        metadata = {
            "provider": self.id,
            "model": info.get("model") or active,
            "prompt": request.prompt,
            "negativePrompt": request.negative_prompt or None,
            "task": request.task.value,
            "aceTaskType": payload["task_type"],
            "seed": info.get("seed", request.seed),
            "bpm": payload.get("bpm"),
            "key": request.key,
            "mode": request.mode,
            "keyScale": payload.get("key_scale"),
            "timeSignature": payload.get("time_signature"),
            "requestedDuration": payload.get("audio_duration"),
            "referenceAudioId": request.reference_audio_id,
            "sourceAudioId": request.source_audio_id,
            "sceneId": request.scene_id,
            "timelineStart": request.timeline_start,
            "generationSettings": {k: v for k, v in payload.items() if not k.endswith("_path")},
            "inferenceSeconds": round(time.time() - started, 3),
            "integrationMode": mode,
        }

        record = self.store.register_bytes(
            audio_bytes,
            provider=self.id,
            suffix=suffix,
            metadata=metadata,
            filename=(request.label or "ace-step-cue").replace(" ", "_") + suffix,
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

    async def _generate_via_server(self, payload: Dict[str, Any]) -> Tuple[bytes, str, Dict[str, Any]]:
        """Drive ACE-Step's documented async task API."""
        import httpx  # type: ignore

        headers = {}
        api_key = os.environ.get("ACESTEP_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        async with httpx.AsyncClient(timeout=self.timeout, headers=headers) as client:
            resp = await client.post(f"{self.base_url}/release_task", json=payload)
            if resp.status_code != 200:
                raise ProviderError(
                    f"ACE-Step rejected the task ({resp.status_code}): {resp.text[:400]}",
                    http_status=502,
                )
            body = resp.json()
            data = body.get("data") or {}
            task_id = data.get("task_id")
            if not task_id:
                raise ProviderError(f"ACE-Step returned no task_id: {body}", http_status=502)

            deadline = time.time() + self.timeout
            result_obj: Optional[Dict[str, Any]] = None
            while time.time() < deadline:
                await asyncio.sleep(1.0)
                q = await client.post(
                    f"{self.base_url}/query_result", json={"task_id_list": [task_id]}
                )
                if q.status_code != 200:
                    continue
                entries = (q.json().get("data") or [])
                if not entries:
                    continue
                entry = entries[0]
                status = entry.get("status")
                if status == 1:
                    raw = entry.get("result")
                    parsed = json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(parsed, list) and parsed:
                        result_obj = parsed[0]
                    elif isinstance(parsed, dict):
                        result_obj = parsed
                    break
                if status == 2:
                    raise ProviderError(
                        f"ACE-Step generation failed: {entry.get('error') or 'no detail returned'}",
                        http_status=502,
                    )
            if result_obj is None:
                raise ProviderError("ACE-Step generation timed out", http_status=504)

            file_ref = result_obj.get("file")
            if not file_ref:
                raise ProviderError("ACE-Step result contained no audio file", http_status=502)

            url = file_ref if file_ref.startswith("http") else f"{self.base_url}{file_ref}"
            audio = await client.get(url)
            if audio.status_code != 200 or not audio.content:
                raise ProviderError(
                    f"could not download ACE-Step audio ({audio.status_code})", http_status=502
                )

            suffix = Path(url.split("?")[0]).suffix or ".wav"
            if "path=" in url:
                suffix = Path(url.split("path=")[-1]).suffix or suffix
            info = {
                "model": result_obj.get("dit_model"),
                "lmModel": result_obj.get("lm_model"),
                "seed": result_obj.get("seed_value"),
                "generationInfo": result_obj.get("generation_info"),
                "metas": result_obj.get("metas"),
            }
            return audio.content, suffix, info

    async def _generate_in_process(self, payload: Dict[str, Any]) -> Tuple[bytes, str, Dict[str, Any]]:
        """Call the acestep package directly when it is importable here.

        Runs in a worker thread so the event loop keeps serving the UI while a
        diffusion pass occupies the GPU.
        """

        def _run() -> Tuple[bytes, str, Dict[str, Any]]:
            try:
                from acestep.inference import generate_music  # type: ignore
            except Exception as exc:  # pragma: no cover - depends on install
                raise ProviderError(
                    f"acestep package present but its inference API could not be imported: {exc}",
                    http_status=503,
                    hint=self.install_hint,
                ) from exc

            outputs = generate_music(**payload)
            paths: List[str] = []
            if isinstance(outputs, (list, tuple)):
                for item in outputs:
                    if isinstance(item, str) and Path(item).exists():
                        paths.append(item)
                    elif isinstance(item, dict) and item.get("file"):
                        paths.append(item["file"])
            elif isinstance(outputs, str):
                paths.append(outputs)
            elif isinstance(outputs, dict) and outputs.get("file"):
                paths.append(outputs["file"])

            if not paths:
                raise ProviderError(
                    "ACE-Step in-process inference returned no audio file", http_status=502
                )
            p = Path(paths[0])
            return p.read_bytes(), p.suffix or ".wav", {"model": payload.get("model")}

        return await asyncio.to_thread(_run)
