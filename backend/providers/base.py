"""Provider contract shared by every Umbra audio generation backend.

Umbra is a *hybrid* workstation. Providers are deliberately heterogeneous:

* ``umbra-procedural`` runs entirely in the browser (Web Audio) and is
  therefore only *described* here — the Python service never renders it.
* ``ace-step`` runs trained music generation in a local PyTorch service.
* ``stable-audio`` / ``mmaudio`` / ``clap`` are optional local models.

Everything a provider returns must be a *real* decoded audio file on disk.
There is no placeholder path: if a model is not installed the provider says
so and generation fails loudly instead of returning synthetic filler.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class Capability(str, enum.Enum):
    """Capabilities a provider may advertise.

    A provider must only list a capability that the *installed* version
    actually supports. Capabilities are re-derived at runtime (see
    :meth:`AudioProvider.status`) rather than hard-coded, because ACE-Step's
    turbo checkpoints support a smaller task set than the base checkpoints.
    """

    MUSIC_GENERATION = "MUSIC_GENERATION"
    SFX_GENERATION = "SFX_GENERATION"
    VIDEO_CONDITIONED = "VIDEO_CONDITIONED"
    REFERENCE_AUDIO = "REFERENCE_AUDIO"
    CONTINUATION = "CONTINUATION"
    ACCOMPANIMENT = "ACCOMPANIMENT"
    REPAINT = "REPAINT"
    KEY_CONDITIONING = "KEY_CONDITIONING"
    BPM_CONDITIONING = "BPM_CONDITIONING"
    TIME_SIGNATURE_CONDITIONING = "TIME_SIGNATURE_CONDITIONING"
    NEGATIVE_DIRECTION = "NEGATIVE_DIRECTION"
    SEED_CONTROL = "SEED_CONTROL"
    DURATION_CONTROL = "DURATION_CONTROL"
    SEMANTIC_SEARCH = "SEMANTIC_SEARCH"
    EMBEDDINGS = "EMBEDDINGS"
    LORA = "LORA"


class ProviderRole(str, enum.Enum):
    """What this provider is *for*, used by the intent router."""

    PROCEDURAL = "procedural"
    MUSICAL_SCORE = "musical_score"
    SOUND_DESIGN = "sound_design"
    VIDEO_FOLEY = "video_foley"
    SEMANTIC = "semantic"


class TaskType(str, enum.Enum):
    """Umbra-level generation tasks (mapped per provider)."""

    GENERATE = "generate"
    CONTINUE = "continue"
    REPAINT = "repaint"
    REFERENCE = "reference"
    ACCOMPANY = "accompany"


@dataclass
class ProviderStatus:
    """Honest, runtime-derived description of a provider."""

    id: str
    label: str
    blurb: str
    role: ProviderRole
    installed: bool
    ready: bool
    capabilities: List[Capability] = field(default_factory=list)
    device: Optional[str] = None
    device_detail: Optional[str] = None
    model: Optional[str] = None
    available_models: List[str] = field(default_factory=list)
    version: Optional[str] = None
    size_bytes: Optional[int] = None
    notes: List[str] = field(default_factory=list)
    install_hint: Optional[str] = None
    error: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "blurb": self.blurb,
            "role": self.role.value,
            "installed": self.installed,
            "ready": self.ready,
            "capabilities": [c.value for c in self.capabilities],
            "device": self.device,
            "deviceDetail": self.device_detail,
            "model": self.model,
            "availableModels": self.available_models,
            "version": self.version,
            "sizeBytes": self.size_bytes,
            "notes": self.notes,
            "installHint": self.install_hint,
            "error": self.error,
        }


@dataclass
class GenerationRequest:
    """A single generation request routed to one provider."""

    provider: str
    prompt: str = ""
    negative_prompt: str = ""
    task: TaskType = TaskType.GENERATE
    duration: float = 12.0
    seed: Optional[int] = None

    # Musical conditioning
    key: Optional[str] = None          # "D"
    mode: Optional[str] = None         # "minor" | "major"
    bpm: Optional[int] = None
    time_signature: Optional[str] = None  # "2" | "3" | "4" | "6"
    instrumental: bool = True
    lyrics: str = ""

    # Audio conditioning (ids into the audio store, kept local)
    reference_audio_id: Optional[str] = None
    source_audio_id: Optional[str] = None
    repaint_start: Optional[float] = None
    repaint_end: Optional[float] = None
    reference_strength: float = 0.35

    # Timeline context — never sent to a model, carried into clip metadata
    timeline_start: float = 0.0
    scene_id: Optional[str] = None
    label: Optional[str] = None

    # Expert / model-specific escape hatch
    advanced: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> "GenerationRequest":
        def num(key: str, *aliases: str) -> Optional[float]:
            for k in (key, *aliases):
                v = data.get(k)
                if v is not None and v != "":
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        return None
            return None

        task_raw = str(data.get("task") or "generate").lower()
        try:
            task = TaskType(task_raw)
        except ValueError:
            task = TaskType.GENERATE

        seed = data.get("seed")
        try:
            seed_val = int(seed) if seed is not None and seed != "" else None
        except (TypeError, ValueError):
            seed_val = None

        bpm = data.get("bpm")
        try:
            bpm_val = int(bpm) if bpm is not None and bpm != "" else None
        except (TypeError, ValueError):
            bpm_val = None

        ts = data.get("timeSignature", data.get("time_signature"))

        return cls(
            provider=str(data.get("provider") or "ace-step"),
            prompt=str(data.get("prompt") or ""),
            negative_prompt=str(data.get("negativePrompt") or data.get("negative_prompt") or ""),
            task=task,
            duration=float(num("duration") or 12.0),
            seed=seed_val,
            key=(data.get("key") or None),
            mode=(data.get("mode") or None),
            bpm=bpm_val,
            time_signature=(str(ts) if ts not in (None, "") else None),
            instrumental=bool(data.get("instrumental", True)),
            lyrics=str(data.get("lyrics") or ""),
            reference_audio_id=data.get("referenceAudioId") or data.get("reference_audio_id"),
            source_audio_id=data.get("sourceAudioId") or data.get("source_audio_id"),
            repaint_start=num("repaintStart", "repaint_start"),
            repaint_end=num("repaintEnd", "repaint_end"),
            reference_strength=float(num("referenceStrength", "reference_strength") or 0.35),
            timeline_start=float(num("timelineStart", "timeline_start") or 0.0),
            scene_id=data.get("sceneId") or data.get("scene_id"),
            label=data.get("label"),
            advanced=dict(data.get("advanced") or {}),
        )

    def key_scale(self) -> Optional[str]:
        """ACE-Step ``key_scale`` string, e.g. ``"D minor"``.

        Upstream builds its valid set as ``f"{note}{accidental} {mode}"`` with
        lowercase ``major``/``minor`` (see ``acestep/constants.py``), so we emit
        exactly that shape.
        """
        if not self.key:
            return None
        mode = (self.mode or "minor").strip().lower()
        if mode not in ("major", "minor"):
            mode = "minor"
        return f"{self.key.strip()} {mode}"


@dataclass
class GenerationResult:
    """The real-result contract.

    A generation is only complete when there is an actual audio file with a
    real frame count, sample rate and duration. :mod:`backend.services.audio_store`
    verifies these by decoding the file — they are never taken on trust from a
    model wrapper.
    """

    audio_id: str
    url: str
    duration: float
    sample_rate: int
    channels: int
    frames: int
    bytes: int
    provider: str
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> Dict[str, Any]:
        return {
            "audioId": self.audio_id,
            "url": self.url,
            "duration": self.duration,
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "frames": self.frames,
            "bytes": self.bytes,
            "provider": self.provider,
            "metadata": self.metadata,
        }


class ProviderError(RuntimeError):
    """Raised when a provider cannot fulfil a request.

    ``http_status`` lets the API surface a meaningful code — 503 when a model
    simply is not installed, 400 for a bad request, 500 for a real failure.
    """

    def __init__(self, message: str, http_status: int = 500, hint: Optional[str] = None):
        super().__init__(message)
        self.http_status = http_status
        self.hint = hint


class AudioProvider:
    """Base class for every Umbra audio provider."""

    id: str = "base"
    label: str = "Provider"
    blurb: str = ""
    role: ProviderRole = ProviderRole.SOUND_DESIGN
    install_hint: Optional[str] = None

    def status(self) -> ProviderStatus:  # pragma: no cover - abstract
        raise NotImplementedError

    def supports(self, capability: Capability) -> bool:
        return capability in self.status().capabilities

    async def generate(self, request: GenerationRequest) -> GenerationResult:  # pragma: no cover - abstract
        raise NotImplementedError

    # Optional lifecycle hooks -------------------------------------------------
    async def warmup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None
