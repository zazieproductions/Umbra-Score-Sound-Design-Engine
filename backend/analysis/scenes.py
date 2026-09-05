"""Scene analysis and the Umbra scoring planner.

Two things live here:

1. **Cut detection.** When PySceneDetect is installed we run *real* content
   detection on the composer's video file. When it is not, we say so — we do
   not emit fabricated cut times dressed up as analysis.

2. **The scoring planner.** ACE-Step's architecture uses a language-model
   planning stage ahead of the diffusion transformer. Umbra takes conceptual
   inspiration from that idea but keeps the creative layer its own: a
   deterministic horror-scoring planner that produces *structured musical
   intent* — key, tempo, density, dread/tension curves and a timed event
   structure — before any audio is generated.

   The planner is not ACE-Step and does not need to be. It produces the
   musical instruction; ACE-Step renders it.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.services import model_manager

# Keys that sit well for low-register horror scoring.
DARK_KEYS = ["D", "C", "A", "G", "F", "E", "B"]
MODES = ["minor"]


def _stable_rand(seed_text: str) -> float:
    """Deterministic 0..1 from a string — same scene always plans the same."""
    h = hashlib.sha256(seed_text.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") / float(1 << 64)


@dataclass
class PlanEvent:
    """One timed instruction inside a cue."""

    at: float
    action: str

    def to_json(self) -> Dict[str, Any]:
        return {"at": round(self.at, 2), "action": self.action}


@dataclass
class ScorePlan:
    """Structured musical intent for one span of film."""

    scene_id: Optional[str]
    label: str
    start: float
    end: float
    key: str
    mode: str
    bpm: int
    density: str
    dread: float
    tension: float
    structure: List[PlanEvent] = field(default_factory=list)
    intent: str = ""
    negative_direction: List[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_json(self) -> Dict[str, Any]:
        d = asdict(self)
        d["structure"] = [e.to_json() for e in self.structure]
        d["duration"] = round(self.duration, 2)
        d["keyScale"] = f"{self.key} {self.mode}"
        return d

    def as_text(self) -> str:
        """The human-readable spotting note a composer would actually write."""
        lines = [
            self.label.upper(),
            f"{_tc(self.start)}–{_tc(self.end)}",
            "",
            f"key:\n{self.key} {self.mode}",
            "",
            f"tempo:\n{self.bpm} BPM",
            "",
            f"density:\n{self.density}",
            "",
            f"dread:\n{self.dread:.2f}",
            "",
            f"tension:\n{self.tension:.2f}",
            "",
            "structure:",
        ]
        for ev in self.structure:
            lines.append(f"{_tc(ev.at)} {ev.action}")
        return "\n".join(lines)


def _tc(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds - m * 60
    return f"{m:02d}:{s:04.1f}"


def plan_scene(
    *,
    start: float,
    end: float,
    tension: float,
    motion: float = 0.4,
    scene_id: Optional[str] = None,
    label: str = "Scene",
    index: int = 1,
    intent: str = "",
) -> ScorePlan:
    """Build structured musical intent for one scene.

    Deterministic: identical inputs always plan identically, so a composer can
    re-run a plan and get the same cue back.
    """
    span = max(0.5, end - start)
    seed_text = f"{scene_id or label}:{start:.2f}:{end:.2f}:{tension:.3f}"
    r = _stable_rand(seed_text)

    # Dread is slow, ambient and rises with tension but never collapses to 0.
    dread = min(0.98, 0.34 + tension * 0.55 + (r - 0.5) * 0.12)
    # Tension in the *musical* sense is intentionally lower than scene tension:
    # a horror score withholds. High-motion scenes get a bit more.
    musical_tension = max(0.05, min(0.95, tension * 0.45 + motion * 0.2 + (r - 0.5) * 0.08))

    # Slow tempi. Horror scoring lives between roughly 36 and 76 BPM.
    bpm = int(round(38 + tension * 34 + (r - 0.5) * 6))
    bpm = max(32, min(84, bpm))

    key = DARK_KEYS[(index + int(r * 7)) % len(DARK_KEYS)]
    mode = MODES[0]

    if tension < 0.3:
        density = "empty" if span > 8 else "low"
    elif tension < 0.55:
        density = "low"
    elif tension < 0.8:
        density = "medium"
    else:
        density = "high"

    structure = _build_structure(start, end, tension, density)

    negatives = ["pop song structure", "heroic trailer harmony", "triumphant resolution"]
    if density in ("empty", "low"):
        negatives.append("drums")

    return ScorePlan(
        scene_id=scene_id,
        label=label,
        start=start,
        end=end,
        key=key,
        mode=mode,
        bpm=bpm,
        density=density,
        dread=round(dread, 2),
        tension=round(musical_tension, 2),
        structure=structure,
        intent=intent,
        negative_direction=negatives,
    )


def _build_structure(start: float, end: float, tension: float, density: str) -> List[PlanEvent]:
    """A timed shape for the cue — entrances, instability, removal, the cut."""
    span = end - start
    ev: List[PlanEvent] = []

    if span < 3:
        ev.append(PlanEvent(start, "single sustained gesture"))
        ev.append(PlanEvent(end, "cut to silence"))
        return ev

    # Horror cues start with nothing.
    hold = span * (0.34 if density in ("empty", "low") else 0.18)
    ev.append(PlanEvent(start, "near silence" if density in ("empty", "low") else "low bed enters"))

    entry = start + hold
    ev.append(PlanEvent(entry, "introduce low strings"))

    if span > 8:
        ev.append(PlanEvent(start + span * 0.58, "spectral instability"))
    if span > 10 and tension > 0.45:
        ev.append(PlanEvent(start + span * 0.74, "remove bass"))

    swell_at = start + span * 0.88
    ev.append(PlanEvent(swell_at, "unresolved swell"))
    ev.append(PlanEvent(end, "cut to silence"))

    return [e for e in ev if start <= e.at <= end]


def plan_project(scenes: List[Dict[str, Any]]) -> List[ScorePlan]:
    """Plan a whole reel, keeping a coherent key relationship across scenes."""
    plans: List[ScorePlan] = []
    for i, s in enumerate(scenes):
        plans.append(
            plan_scene(
                start=float(s.get("start", 0.0)),
                end=float(s.get("end", 0.0)),
                tension=float(s.get("tension", 0.5)),
                motion=float(s.get("motion", 0.4)),
                scene_id=s.get("id"),
                label=s.get("title") or f"Scene {i + 1}",
                index=i + 1,
                intent=s.get("summary", ""),
            )
        )
    return plans


# --------------------------------------------------------------- cut detection


@dataclass
class CutDetectionResult:
    available: bool
    cuts: List[float] = field(default_factory=list)
    scenes: List[Tuple[float, float]] = field(default_factory=list)
    detector: Optional[str] = None
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "cuts": [round(c, 3) for c in self.cuts],
            "scenes": [{"start": round(a, 3), "end": round(b, 3)} for a, b in self.scenes],
            "detector": self.detector,
            "message": self.message,
        }


def detect_cuts(video_path: Path, threshold: float = 27.0, min_scene_seconds: float = 1.5) -> CutDetectionResult:
    """Real shot-boundary detection via PySceneDetect.

    If PySceneDetect is not installed we return ``available=False`` with an
    explanation. Umbra does not invent cut points.
    """
    if not model_manager.package_installed("scenedetect"):
        return CutDetectionResult(
            available=False,
            message="PySceneDetect is not installed — install it for real cut detection.",
        )
    if not video_path.exists():
        return CutDetectionResult(available=False, message=f"video not found: {video_path}")

    try:
        from scenedetect import ContentDetector, SceneManager, open_video  # type: ignore

        video = open_video(str(video_path))
        manager = SceneManager()
        fps = video.frame_rate or 24.0
        manager.add_detector(
            ContentDetector(threshold=threshold, min_scene_len=int(min_scene_seconds * fps))
        )
        manager.detect_scenes(video, show_progress=False)
        scene_list = manager.get_scene_list()
    except Exception as exc:
        return CutDetectionResult(available=False, message=f"PySceneDetect failed: {exc}")

    spans = [(s.get_seconds(), e.get_seconds()) for s, e in scene_list]
    cuts = [s for s, _ in spans[1:]]
    return CutDetectionResult(
        available=True,
        cuts=cuts,
        scenes=spans,
        detector="PySceneDetect ContentDetector",
        message=f"{len(spans)} shots detected",
    )
