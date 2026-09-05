"""X-CLIP semantic video-analysis layer.

Umbra already knows *when* something happens: the pixel-derived motion
detector (``backend/analysis/events.py``) turns an ffmpeg frame grid into
transient / sustained / cadence events. X-CLIP answers a different, equally
honest question:

    given this bounded video window, which Umbra sound-design labels is it
    *most likely* to represent?

That is a probabilistic semantic interpretation, not guaranteed object or
action recognition. The model is ``microsoft/xclip-base-patch32``, run locally
through Hugging Face Transformers. It is optional: when the weights / deps are
absent the layer reports a truthful ``available: False`` plus an install hint
and never fabricates a label.

Design rules (mirroring Umbra's invariants):

* Only meaningful event windows are analysed — never every frame.
* Inference is batched per request when multiple windows exist.
* Results are cached in git-ignored ``models/cache/xclip``.
* Device, model id and runtime-verified state are real, not implausible.
* The vocabulary is centralised and easy to extend.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from backend.services import model_manager
from backend.services.device import preferred_device

log = logging.getLogger("umbra.xclip")

XCLIP_MODEL_ID = "microsoft/xclip-base-patch32"
XCLIP_DIR_NAME = "xclip-base-patch32"
XCLIP_LICENSE = "MIT (model card reports license: mit; re-check before commercial use)"

DEFAULT_FRAMES = 8
MAX_FRAMES = 16
DEFAULT_WINDOW_SECONDS = 1.5
MAX_WINDOW_SECONDS = 4.0
PAD_BEFORE = 0.2
DEFAULT_TOP_K = 5
FFMPEG_TIMEOUT = 120

# ----------------------------------------------------------------------- vocab


@dataclass(frozen=True)
class SemanticLabel:
    """One row in Umbra's bounded X-CLIP sound-design vocabulary.

    ``role`` / ``event_kind`` are Umbra's own retrieval vocabulary (the
    same shape ``backend/analysis/events.py`` and the frontend planner use).
    ``audio_set`` is an AudioSet-style label used for transparent expansion /
    mapping when an AudioSet ontology is present; Umbra does not create a
    second taxonomy.
    """

    id: str
    text: str
    role: str
    event_kind: str
    query: str
    audio_set: Optional[str] = None
    aliases: Tuple[str, ...] = ()

    def to_json(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "role": self.role,
            "eventKind": self.event_kind,
            "query": self.query,
            "audioSet": self.audio_set,
            "aliases": list(self.aliases),
        }


VOCABULARY: List[SemanticLabel] = [
    SemanticLabel("footsteps_walking", "footsteps walking", "FOOTSTEP", "footstep",
                  "footsteps walking on floor", "Walk, footsteps"),
    SemanticLabel("running", "person running", "FOOTSTEP", "footstep",
                  "running footsteps", "Run"),
    SemanticLabel("door_opening", "a door opening", "DOOR", "door",
                  "door opening creak hinge", "Door"),
    SemanticLabel("door_closing", "a door closing", "DOOR", "door",
                  "door closing creak latch", "Door"),
    SemanticLabel("object_falling", "an object falling", "IMPACT", "impact",
                  "object falling impact", "Impact"),
    SemanticLabel("object_impact", "an object impact", "IMPACT", "impact",
                  "object impact thud collision", "Impact"),
    SemanticLabel("object_placed_down", "an object being placed down", "MISC_FOLEY", "object-movement",
                  "object placed down soft contact", "Object"),
    SemanticLabel("fabric_clothing_movement", "fabric or clothing movement", "CLOTHING", "cloth",
                  "fabric clothing movement rustle", "Fabric"),
    SemanticLabel("person_sitting", "a person sitting", "BODY", "body",
                  "person sitting movement", "Sitting"),
    SemanticLabel("person_standing", "a person standing", "BODY", "body",
                  "person standing movement", "Standing"),
    SemanticLabel("hand_contacting_surface", "a hand contacting a surface", "BODY", "body",
                  "hand contacting surface", "Hands"),
    SemanticLabel("vehicle_movement", "a vehicle moving", "VEHICLE", "vehicle",
                  "vehicle movement engine", "Vehicle"),
    SemanticLabel("machinery_operating", "machinery operating", "MECHANICAL", "mechanical",
                  "machinery operating hum", "Machine"),
    SemanticLabel("water_movement", "water movement", "WATER", "water",
                  "water movement splash", "Water"),
    SemanticLabel("fire", "fire burning", "MISC_FOLEY", "other",
                  "fire crackling", "Fire"),
    SemanticLabel("physical_struggle", "physical struggle", "BODY", "body",
                  "physical struggle movement", "Fighting"),
    SemanticLabel("general_human_movement", "general human movement", "BODY", "body",
                  "human movement body", "Human sounds"),
]

VOCABULARY_BY_TEXT: Dict[str, SemanticLabel] = {v.text.lower(): v for v in VOCABULARY}
VOCABULARY_BY_ID: Dict[str, SemanticLabel] = {v.id: v for v in VOCABULARY}


def vocabulary_texts() -> List[str]:
    """The bounded set of text prompts X-CLIP is compared against."""
    return [v.text for v in VOCABULARY]


def label_texts() -> Tuple[str, ...]:
    return tuple(vocabulary_texts())


# --------------------------------------------------------------------- dataclasses


@dataclass
class SemanticCandidate:
    label: str
    label_id: Optional[str]
    role: str
    event_kind: str
    query: str
    audio_set: Optional[str]
    similarity: float
    confidence: float

    def to_json(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "labelId": self.label_id,
            "role": self.role,
            "eventKind": self.event_kind,
            "query": self.query,
            "audioSet": self.audio_set,
            "similarity": round(float(self.similarity), 4),
            "confidence": round(float(self.confidence), 4),
        }


@dataclass
class SemanticResult:
    available: bool
    event_id: str
    method: str
    message: Optional[str]
    model_id: Optional[str] = XCLIP_MODEL_ID
    device: Optional[str] = None
    candidates: List[SemanticCandidate] = field(default_factory=list)
    runtime_ms: Optional[int] = None
    cache_hit: bool = False
    install_hint: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "eventId": self.event_id,
            "method": self.method,
            "message": self.message,
            "modelId": self.model_id if self.available else None,
            "device": self.device if self.available else None,
            "candidates": [c.to_json() for c in self.candidates],
            "runtimeMs": self.runtime_ms,
            "cacheHit": self.cache_hit,
            "installHint": self.install_hint,
        }


@dataclass
class SampledWindow:
    available: bool
    event_id: str
    start: float
    end: float
    frame_paths: List[str] = field(default_factory=list)
    at: List[float] = field(default_factory=list)
    message: Optional[str] = None


@dataclass
class AnalysisStats:
    window_count: int = 0
    cache_hits: int = 0
    inference_count: int = 0
    analyzed_in_ms: int = 0
    model: str = XCLIP_MODEL_ID
    device: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "windowCount": self.window_count,
            "cacheHits": self.cache_hits,
            "inferenceCount": self.inference_count,
            "analyzedInMs": self.analyzed_in_ms,
            "model": self.model,
            "device": self.device,
        }


# ------------------------------------------------------------- pure helpers


def event_window(
    start: float,
    duration: Optional[float] = None,
    *,
    window_seconds: float = DEFAULT_WINDOW_SECONDS,
    pad_before: float = PAD_BEFORE,
    max_window_seconds: float = MAX_WINDOW_SECONDS,
) -> Tuple[float, float]:
    """A bounded, centred window around one detected event.

    A transient can be shorter than a millisecond while still being
    meaningful, so the window is never smaller than ``pad_before`` + a
    visible sample span (default 1.5 s). The window is clamped to prevent
    unbounded model work.
    """
    start = max(0.0, float(start))
    duration = float(duration or 0.0)
    span = min(max_window_seconds, max(0.5, float(window_seconds), duration + 0.5))
    lo = max(0.0, start - pad_before)
    hi = lo + span
    return round(lo, 3), round(hi, 3)


def uniform_timestamps(start: float, end: float, count: int) -> List[float]:
    """Evenly spaced timestamps for a window."""
    count = max(1, int(count))
    if end <= start:
        return [round(start, 3)]
    step = (end - start) / count
    return [round(start + i * step, 3) for i in range(count)]


def clamp_similarity(value: float, floor: float = 0.0, ceiling: float = 1.0) -> float:
    if value != value:  # NaN
        return floor
    if value < floor:
        return floor
    if value > ceiling:
        return ceiling
    return float(value)


def normalized_confidence(scores: Sequence[float]) -> List[float]:
    """A bounded-vocabulary softmax.

    ``scores`` are raw cosine similarities. The vocabulary is intentionally
    small, so the softmax reports how confidently X-CLIP picked *among the
    Umbra labels* — never an absolute probability of the real-world event.
    """
    if not scores:
        return []
    peak = max(scores)
    temper = 0.1
    exps = [float(math.exp((s - peak) / temper)) for s in scores]
    total = sum(exps) or 1.0
    return [e / total for e in exps]


def normalize_semantic_results(
    raw: Sequence[Sequence[Tuple[str, float]]],
    *,
    event_ids: Sequence[str],
    top_k: int = DEFAULT_TOP_K,
) -> List[SemanticResult]:
    """Map raw ``(label, cosine)`` pairs to Umbra-safe semantic candidates.

    Unknown labels stay honest: they are kept with their raw text, mapped to
    ``MISC_FOLEY`` / ``other`` so retrieval still has a query, and marked by
    a ``None`` label id.
    """
    out: List[SemanticResult] = []
    for idx, video_scores in enumerate(raw):
        event_id = event_ids[idx] if idx < len(event_ids) else f"event-{idx + 1}"
        scores = list(video_scores[:top_k])
        confs = normalized_confidence([s for _, s in scores])
        candidates: List[SemanticCandidate] = []
        for (text, sim), conf in zip(scores, confs, strict=True):
            spec = VOCABULARY_BY_TEXT.get(str(text).strip().lower())
            candidates.append(
                SemanticCandidate(
                    label=str(text),
                    label_id=spec.id if spec else None,
                    role=spec.role if spec else "MISC_FOLEY",
                    event_kind=spec.event_kind if spec else "other",
                    query=spec.query if spec else str(text),
                    audio_set=spec.audio_set if spec else None,
                    similarity=clamp_similarity(sim),
                    confidence=float(conf),
                )
            )
        out.append(
            SemanticResult(
                available=True,
                event_id=event_id,
                method="xclip",
                message=f"{len(candidates)} candidate(s) from the bounded Umbra vocabulary",
                candidates=candidates,
            )
        )
    return out


def semantic_query(result: SemanticResult) -> Optional[str]:
    """The first/best retrieval query an X-CLIP result suggests."""
    if not result.available or not result.candidates:
        return None
    return result.candidates[0].query or result.candidates[0].label


def attach_semantics(events: Iterable[Dict[str, Any]], results: Sequence[SemanticResult]) -> List[Dict[str, Any]]:
    """Attach semantic results to the existing event representation.

    Events are shallow-copied; existing pixel fields are never removed. An
    missing result leaves the event untouched.
    """
    by_id = {r.event_id: r for r in results}
    enriched: List[Dict[str, Any]] = []
    for ev in events:
        item = dict(ev)
        result = by_id.get(str(ev.get("id", "")))
        if result is not None:
            item["semantic"] = result.to_json()
            item["semanticQuery"] = semantic_query(result)
        enriched.append(item)
    return enriched


class SemanticCache:
    """Small on-disk JSON cache for X-CLIP window results.

    Stored under ``models/cache/xclip`` (git-ignored) so a re-run of the same
    analysis does not pay inference twice. This is analysis provenance, not a
    durability contract — a cleared cache simply reruns real inference.
    """

    def __init__(self, root: Optional[Path] = None):
        self.root = Path(root or (Path.cwd() / "models" / "cache" / "xclip"))
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def key_for(self, video_path: Path, start: float, end: float, frames: int) -> str:
        size = video_path.stat().st_size if video_path.exists() else 0
        raw = f"{XCLIP_MODEL_ID}|{video_path}|{start:.3f}|{end:.3f}|{frames}|{size}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    def _path_for(self, key: str) -> Path:
        return self.root / f"{key}.json"

    def has(self, key: str) -> bool:
        return self._path_for(key).exists()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        p = self._path_for(key)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            return None

    def put(self, key: str, payload: Dict[str, Any]) -> None:
        p = self._path_for(key)
        with self._lock:
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload))
            tmp.replace(p)


# --------------------------------------------------------------- analyzer


class XCLIPAnalyzer:
    """Load, run, cache and honestly report local X-CLIP inference."""

    id = "xclip"
    label = "Semantic video analysis"
    install_hint = "python scripts/setup_models.py --xclip"

    def __init__(self, cache_root: Optional[Path] = None):
        self.cache = SemanticCache(cache_root)
        self._model: Any = None
        self._processor: Any = None
        self._lock = asyncio.Lock()
        self._runtime_verified = False
        self._device = preferred_device()

    # ------------------------------------------------------------ deps --
    def _local_path(self) -> Optional[Path]:
        p = model_manager.checkpoints_root() / XCLIP_DIR_NAME
        return p if p.is_dir() and any(p.iterdir()) else None

    def _deps_ok(self) -> bool:
        return all(
            model_manager.package_installed(m)
            for m in ("torch", "transformers", "PIL")
        )

    def status(self) -> Dict[str, Any]:
        local = self._local_path()
        deps = self._deps_ok()
        ready = bool(local and deps)
        device = preferred_device()
        notes: List[str] = []
        if not deps:
            notes.append("Requires torch + transformers + Pillow")
        if not local:
            notes.append("Weights not downloaded")
        if ready:
            notes.append("Analyses only meaningful event windows; results are cached")
        if self._runtime_verified:
            notes.append("A real X-CLIP inference processed video frames this session")
        return {
            "id": self.id,
            "label": self.label,
            "model": XCLIP_MODEL_ID if local else None,
            "license": XCLIP_LICENSE,
            "installed": bool(local),
            "ready": ready,
            "runtimeVerified": self._runtime_verified,
            "device": device.id if ready else None,
            "deviceDetail": device.detail if ready else None,
            "sizeBytes": model_manager.dir_size(local) if local else None,
            "notes": notes,
            "installHint": self.install_hint,
            "error": None,
        }

    def status_json(self) -> Dict[str, Any]:
        return self.status()

    # ----------------------------------------------------------- load --
    async def _ensure_model(self) -> None:
        if self._model is not None and self._processor is not None:
            return
        async with self._lock:
            if self._model is not None and self._processor is not None:
                return
            local = self._local_path()
            if local is None:
                raise RuntimeError(
                    "X-CLIP weights are not installed. Run python scripts/setup_models.py --xclip"
                )
            if not self._deps_ok():
                raise RuntimeError(
                    "X-CLIP requires torch, transformers and Pillow — "
                    "install backend/requirements-extras.txt first."
                )

            def _load():
                import torch  # type: ignore
                from transformers import XCLIPModel, XCLIPProcessor  # type: ignore
                from backend.services.device import preferred_device as _pd

                device = _pd()
                torch_device = "cuda" if device.id == "cuda" else "mps" if device.id == "mps" else "xpu" if device.id == "xpu" else "cpu"
                model = XCLIPModel.from_pretrained(str(local)).eval().to(torch_device)
                processor = XCLIPProcessor.from_pretrained(str(local))
                return model, processor, torch_device

            self._model, self._processor, self._model_device = await asyncio.to_thread(_load)
            self._device = preferred_device()

    # ------------------------------------------------------------ ffmpeg --
    def _frame_dir(self) -> Path:
        return Path.cwd() / "models" / "cache" / "xclip-frames"

    def _sample_one_window(
        self,
        video_path: Path,
        event_id: str,
        start: float,
        end: float,
        frames: int,
        *,
        width: int = 224,
        height: int = 224,
    ) -> SampledWindow:
        if not shutil.which("ffmpeg"):
            return SampledWindow(False, event_id, start, end,
                                message="ffmpeg not found — X-CLIP frame sampling needs it.")
        if not video_path.exists():
            return SampledWindow(False, event_id, start, end,
                                message=f"video not found: {video_path}")
        out_dir = self._frame_dir() / hashlib.sha256(str(video_path).encode()).hexdigest()[:8] / f"{event_id}-{start:.3f}"
        out_dir.mkdir(parents=True, exist_ok=True)
        span = float(end) - float(start)
        interval = max(0.05, span / max(1, frames))
        fps = 1.0 / interval
        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{float(start):.3f}",
            "-i", str(video_path),
            "-t", f"{max(0.05, span):.3f}",
            "-vf", f"fps={fps:.4f},scale={width}:{height}",
            "-frames:v", str(frames),
            "-q:v", "2",
        ]
        output = out_dir / "window_%03d.jpg"
        cmd.append(str(output))
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            err = (exc.stderr or b"").decode("utf-8", "replace")[-300:] if isinstance(exc, subprocess.CalledProcessError) else str(exc)
            return SampledWindow(False, event_id, start, end, message=f"ffmpeg failed: {err}")
        paths = sorted(out_dir.glob("window_*.jpg"))
        times = uniform_timestamps(start, end, len(paths))
        if not paths:
            return SampledWindow(False, event_id, start, end, message="no frames extracted")
        return SampledWindow(True, event_id, start, end, [str(p) for p in paths], times)

    # --------------------------------------------------------- inference --
    def _infer(self, window_frame_paths: Sequence[Sequence[str]], texts: Sequence[str]) -> List[List[Tuple[str, float]]]:
        """Run one batched X-CLIP inference over N video windows.

        Returns one row per window: ``[(label_text, cosine), ...]`` for every
        vocabulary text. Kept separate from the async orchestration so tests
        can mock it without a model.
        """
        import torch  # type: ignore
        from PIL import Image  # type: ignore

        videos = [[Image.open(p).convert("RGB") for p in window] for window in window_frame_paths]
        processor = self._processor
        model = self._model
        device = self._model_device
        inputs = processor(text=list(texts), videos=videos, return_tensors="pt", padding=True)
        inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
        with torch.no_grad():
            vfeat = model.get_video_features(**inputs)
            tfeat = model.get_text_features(**inputs)
        vfeat = vfeat / vfeat.norm(dim=-1, keepdim=True)
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)
        sims = tfeat @ vfeat.T  # shape [n_texts, n_videos]
        rows: List[List[Tuple[str, float]]] = []
        for col in range(sims.shape[1]):
            row = []
            for i, text in enumerate(texts):
                row.append((text, float(sims[i, col].item())))
            row.sort(key=lambda x: x[1], reverse=True)
            rows.append(row)
        return rows

    # -------------------------------------------------- public workflow --
    async def enrich_events(
        self,
        path: Path,
        events: Sequence[Dict[str, Any]],
        *,
        window_seconds: float = DEFAULT_WINDOW_SECONDS,
        top_k: int = DEFAULT_TOP_K,
        frames: int = DEFAULT_FRAMES,
    ) -> Dict[str, Any]:
        """Attach X-CLIP semantic results to each meaningful event window."""
        path = Path(path)
        events = list(events or [])
        frames = max(1, min(int(frames), MAX_FRAMES))
        status = self.status()
        t0 = time.time()

        if not status["ready"]:
            missing = "X-CLIP is not installed — weights and torch/transformers are required."
            return {
                "available": False,
                "modelId": XCLIP_MODEL_ID,
                "device": None,
                "events": [
                    {**ev, "semantic": SemanticResult(False, str(ev.get("id", "")), "none",
                                                     missing, install_hint=self.install_hint).to_json()}
                    for ev in events
                ],
                "message": missing,
                "installHint": self.install_hint,
                "stats": AnalysisStats().to_json(),
            }
        if not path.exists():
            return {
                "available": False,
                "modelId": XCLIP_MODEL_ID,
                "device": status.get("device"),
                "events": events,
                "message": f"video not found: {path}",
                "installHint": None,
                "stats": AnalysisStats().to_json(),
            }

        try:
            await self._ensure_model()
        except Exception as exc:  # a load failure must be surfaced, never faked
            return {
                "available": False,
                "modelId": XCLIP_MODEL_ID,
                "device": status.get("device"),
                "events": events,
                "message": f"X-CLIP failed to load: {exc}",
                "installHint": self.install_hint,
                "stats": AnalysisStats().to_json(),
            }

        stats = AnalysisStats(device=status.get("device"), model=XCLIP_MODEL_ID)
        enriched_by_id: Dict[str, Dict[str, Any]] = {}
        windows: List[SampledWindow] = []

        for ev in events:
            event_id = str(ev.get("id") or f"event-{len(enriched_by_id) + 1}")
            start, end = event_window(
                float(ev.get("timestamp", 0.0)),
                float(ev.get("duration")) if ev.get("duration") is not None else None,
                window_seconds=window_seconds,
            )
            key = self.cache.key_for(path, start, end, frames)
            cached = self.cache.get(key)
            if cached is not None:
                cached = dict(cached)
                cached["cacheHit"] = True
                cached["candidates"] = cached.get("candidates", [])
                result = SemanticResult(
                    available=bool(cached.get("available")),
                    event_id=event_id,
                    method=str(cached.get("method", "xclip")),
                    message=cached.get("message"),
                    model_id=cached.get("modelId", XCLIP_MODEL_ID),
                    device=cached.get("device"),
                    candidates=[
                        SemanticCandidate(
                            label=str(c["label"]),
                            label_id=c.get("labelId"),
                            role=str(c.get("role", "MISC_FOLEY")),
                            event_kind=str(c.get("eventKind", "other")),
                            query=str(c.get("query", c["label"])),
                            audio_set=c.get("audioSet"),
                            similarity=float(c.get("similarity", 0.0)),
                            confidence=float(c.get("confidence", 0.0)),
                        )
                        for c in cached.get("candidates", [])
                    ],
                    runtime_ms=cached.get("runtimeMs"),
                    cache_hit=True,
                )
                enriched_by_id[event_id] = result.to_json()
                stats.cache_hits += 1
                stats.window_count += 1
            else:
                window = self._sample_one_window(path, event_id, start, end, frames)
                windows.append(window)

        # Batch any uncached windows in ONE model call (when frames exist)
        runnable = [w for w in windows if w.available]
        failed = [w for w in windows if not w.available]
        if runnable:
            raw = await asyncio.to_thread(self._infer, [w.frame_paths for w in runnable], vocabulary_texts())
            results = normalize_semantic_results(raw, event_ids=[w.event_id for w in runnable], top_k=top_k)
            for w, result in zip(runnable, results, strict=True):
                result.device = self._device.id if self._device else None
                result.model_id = XCLIP_MODEL_ID
                result.runtime_ms = int((time.time() - t0) * 1000)
                enriched_by_id[w.event_id] = result.to_json()
                payload = result.to_json()
                payload["cacheHit"] = False
                key = self.cache.key_for(path, w.start, w.end, frames)
                self.cache.put(key, payload)
                stats.window_count += 1
            stats.inference_count += 1
            self._runtime_verified = True
        for w in failed:
            enriched_by_id[w.event_id] = SemanticResult(
                False, w.event_id, "none", w.message or "X-CLIP could not sample this window",
                install_hint=None,
            ).to_json()
            stats.window_count += 1

        # Build the enriched event list (preserve one entry per input event)
        semantic_results: List[SemanticResult] = []
        for idx, ev in enumerate(events):
            event_id = str(ev.get("id") or f"event-{idx + 1}")
            data = enriched_by_id.get(event_id, {
                "available": False,
                "method": "none",
                "message": "no semantic result produced for this window",
                "candidates": [],
                "cacheHit": False,
            })
            semantic_results.append(
                SemanticResult(
                    available=bool(data.get("available")),
                    event_id=event_id,
                    method=str(data.get("method", "none")),
                    message=data.get("message"),
                    model_id=data.get("modelId"),
                    device=data.get("device"),
                    candidates=[
                        SemanticCandidate(
                            label=str(c["label"]),
                            label_id=c.get("labelId"),
                            role=str(c.get("role", "MISC_FOLEY")),
                            event_kind=str(c.get("eventKind", "other")),
                            query=str(c.get("query", c["label"])),
                            audio_set=c.get("audioSet"),
                            similarity=float(c.get("similarity", 0.0)),
                            confidence=float(c.get("confidence", 0.0)),
                        )
                        for c in data.get("candidates", [])
                    ],
                    runtime_ms=data.get("runtimeMs"),
                    cache_hit=bool(data.get("cacheHit")),
                )
            )
        enriched = attach_semantics(events, semantic_results)

        stats.analyzed_in_ms = int((time.time() - t0) * 1000)
        any_semantic = any(
            bool(r.available and r.candidates)
            for r in semantic_results
        )
        message = (
            f"{stats.window_count} window(s) analysed; {stats.cache_hits} cache hit(s), "
            f"{stats.inference_count} batched inference run(s)"
        )
        if not any_semantic:
            message = "No semantic candidates produced — check ffmpeg / video decoding. " + message
        return {
            "available": any_semantic,
            "modelId": XCLIP_MODEL_ID,
            "device": status.get("device"),
            "events": enriched,
            "message": message,
            "installHint": self.install_hint if not status["ready"] else None,
            "stats": stats.to_json(),
        }


_xclip_analyzer: Optional[XCLIPAnalyzer] = None


def get_xclip_analyzer() -> XCLIPAnalyzer:
    global _xclip_analyzer
    if _xclip_analyzer is None:
        _xclip_analyzer = XCLIPAnalyzer()
    return _xclip_analyzer
