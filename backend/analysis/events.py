"""Deterministic video motion-event analysis.

Mirrors the browser pixel analyzer (``src/lib/library/videoAnalysis.ts``)
for videos that live on the backend filesystem. Real analysis via ffmpeg
raw-gray frame extraction — no model, no inference, no invented certainty.

Honesty rules (pinned by tests):
  - a missing ffmpeg degrades to ``available=False`` with an install hint;
  - only pixel-derived features can raise confidence;
  - scene text refines WHAT (material/environment/role) but never invents
    a timestamp;
  - ambiguous signals stay <= 0.6 confidence (suggestion-only upstream);
  - the frame budget is bounded: no uncontrolled query per video.
"""

from __future__ import annotations

import math
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

GRID_W = 24
GRID_H = 14
BLOCK_W = 4
BLOCK_H = 2
MOTION_SCALE = 32.0
AREA_FLOOR = 0.02
TRANSIENT_RATIO = 2.8
TRANSIENT_MIN = 0.12
SUSTAIN_MIN = 0.18
SUSTAIN_MIN_SECONDS = 1.2
CADENCE_MIN_SECONDS = 2.0
CADENCE_MIN_PEAKS = 3
CADENCE_MIN_GAP = 0.25
CADENCE_MAX_GAP = 1.4
TRANSIENT_MAX_SECONDS = 1.5

# Semantic mapping (same vocabulary as the browser analyzer)
ROLE_KEYWORDS: Dict[str, List[str]] = {
    "ROOM_TONE": ["room", "interior", "inside", "basement", "cellar", "attic"],
    "AMBIENCE": ["ambience", "atmosphere", "background", "hall"],
    "FOOTSTEP": ["footstep", "footsteps", "step", "walking", "walk", "gait", "boot", "stairs", "staircase"],
    "CLOTHING": ["cloth", "clothing", "fabric", "jacket", "coat"],
    "DOOR": ["door", "doorway", "hinge", "latch", "gate"],
    "WOOD": ["wood", "wooden", "plank", "floorboard"],
    "METAL": ["metal", "metallic", "iron", "steel", "chain"],
    "GLASS": ["glass", "window", "pane"],
    "BODY": ["body", "flesh", "person", "character", "hand"],
    "BREATH": ["breath", "breathing", "pant"],
    "MECHANICAL": ["machine", "mechanical", "engine", "ventil", "motor", "industrial", "compressor", "fan", "appliance"],
    "ELECTRICAL": ["electrical", "electric", "power", "hum", "buzz"],
    "WIND": ["wind", "breeze", "gust"],
    "WEATHER": ["rain", "storm", "weather", "thunder"],
    "WATER": ["water", "drip", "pipe", "drain", "leak", "liquid"],
    "IMPACT": ["impact", "hit", "thud", "collision", "crash", "slam"],
    "ANIMAL": ["animal", "creature", "rat", "bird"],
    "VEHICLE": ["vehicle", "car", "traffic", "train", "plane"],
    "MISC_FOLEY": ["foley", "object", "prop"],
}

ROLE_BY_KIND = {
    "footstep": "FOOTSTEP",
    "door": "DOOR",
    "impact": "IMPACT",
    "cloth": "CLOTHING",
    "mechanical": "MECHANICAL",
    "water": "WATER",
    "wind": "WIND",
    "vehicle": "VEHICLE",
    "ambience": "AMBIENCE",
    "room-tone": "ROOM_TONE",
    "body": "BODY",
    "breath": "BREATH",
    "object-movement": "MISC_FOLEY",
    "other": "MISC_FOLEY",
}

ACTION_BY_KIND = {
    "footstep": "single footstep",
    "door": "door hinge creak",
    "impact": "impact thud",
    "cloth": "cloth movement",
    "mechanical": "machine hum",
    "water": "water drip",
    "wind": "wind gust",
    "vehicle": "vehicle pass",
    "ambience": "room ambience",
    "room-tone": "empty room tone",
    "body": "body movement",
    "breath": "breath close",
    "object-movement": "object movement",
    "other": "sound effect",
}


@dataclass
class FrameFeatures:
    t: float
    mean_luma: float
    luma_variance: float
    motion: float
    motion_area: float
    drift: float


def _median(values: List[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[len(s) // 2]


def _smooth(values: List[float], radius: int = 1) -> List[float]:
    out: List[float] = []
    for i in range(len(values)):
        lo = max(0, i - radius)
        hi = min(len(values), i + radius + 1)
        window = values[lo:hi]
        out.append(sum(window) / len(window))
    return out


# ------------------------------------------------------------ pixels ---


def downscale_gray(data: bytes, width: int, height: int, gw: int = GRID_W, gh: int = GRID_H) -> bytes:
    """Average raw gray bytes into a small gw×gh grid (row-major)."""
    out = bytearray(gw * gh)
    if not data or width <= 0 or height <= 0:
        return bytes(out)
    for y in range(gh):
        sy0 = y * height // gh
        sy1 = max(sy0 + 1, ((y + 1) * height) // gh)
        for x in range(gw):
            sx0 = x * width // gw
            sx1 = max(sx0 + 1, ((x + 1) * width) // gw)
            total = 0
            n = 0
            for py in range(sy0, sy1, 2):
                row = py * width
                for px in range(sx0, sx1, 2):
                    idx = row + px
                    if idx < len(data):
                        total += data[idx]
                        n += 1
            out[y * gw + x] = round(total / n) if n else 0
    return bytes(out)


def _block_diffs(a: bytes, b: bytes, width: int = GRID_W, height: int = GRID_H) -> Tuple[float, float]:
    cols = width // BLOCK_W
    rows = height // BLOCK_H
    total = 0.0
    area = 0
    n = 0
    for by in range(rows):
        for bx in range(cols):
            d = 0.0
            for y in range(BLOCK_H):
                base = (by * BLOCK_H + y) * width + bx * BLOCK_W
                for x in range(BLOCK_W):
                    d += abs(a[base + x] - b[base + x])
            avg = d / (BLOCK_W * BLOCK_H)
            total += avg
            if avg > 12:
                area += 1
            n += 1
    return (total / n if n else 0.0), (area / n if n else 0.0)


def frame_features(grid: bytes, prev: Optional[bytes], ref: Optional[bytes], t: float) -> FrameFeatures:
    values = list(grid)
    n = len(values)
    mean = sum(values) / n if n else 0.0
    variance = (sum(v * v for v in values) / n - mean * mean) if n else 0.0
    motion, area = _block_diffs(grid, prev) if prev is not None else (0.0, 0.0)
    drift, _ = _block_diffs(grid, ref) if ref is not None else (0.0, 0.0)
    return FrameFeatures(t=t, mean_luma=mean, luma_variance=max(0.0, variance), motion=motion, motion_area=area, drift=drift)


# ---------------------------------------------------------- signals ---


def detect_motion_signals(features: List[FrameFeatures], fps: float = 8.0, min_transient_seconds: float = 0.08) -> List[Dict[str, Any]]:
    """Same thresholds/semantics as the browser analyzer."""
    signals: List[Dict[str, Any]] = []
    if len(features) < 3:
        return signals
    frame_ms = 1000.0 / max(1.0, fps)
    # Two complementary metrics: the mean block diff (whole frame) and the
    # mean diff over *changed* blocks only. A small subject (a figure walking
    # in a wide shot) moves just a few blocks a lot; the mean metric dilutes
    # that to almost nothing, so we keep the localized signal too.
    mean = [min(1.5, f.motion / MOTION_SCALE) for f in features]
    localized = [
        min(1.5, (f.motion / max(0.0, f.motion_area)) / MOTION_SCALE) if f.motion_area >= AREA_FLOOR else 0.0
        for f in features
    ]
    m = [max(mean[i], localized[i] * 0.85) for i in range(len(mean))]
    baseline: List[float] = []
    for i in range(len(m)):
        lo = max(0, i - 6)
        hi = i + 7
        baseline.append(max(0.04, _median(m[lo:hi])))
    rel = [m[i] / baseline[i] for i in range(len(m))]
    sm = _smooth(m, 1)

    # transients — motion-burst RUNS: a physical gesture (door swing, impact,
    # step) is a contiguous run above a small floor. Reporting the RUN START
    # gives an accurate onset and merges sub-peaks of one gesture into a
    # single event instead of two late peaks.
    burst_floor = TRANSIENT_MIN * 0.3
    bursts: List[Dict[str, float]] = []
    burst_run: List[int] = []

    def close_burst_run() -> None:
        if not burst_run:
            return
        peak = max(m[j] for j in burst_run)
        relay = any(rel[j] >= TRANSIENT_RATIO for j in burst_run)
        if len(burst_run) == 1:
            i = burst_run[0]
            if m[i] >= TRANSIENT_MIN and rel[i] >= TRANSIENT_RATIO:
                bursts.append(
                    {
                        "start": features[i].t,
                        "end": features[i].t + max(frame_ms / 1000.0, min_transient_seconds),
                        "peak": float(m[i]),
                        "peakAt": float(i),
                    }
                )
        elif peak >= TRANSIENT_MIN and relay:
            start = features[burst_run[0]].t
            end = features[burst_run[-1]].t
            if end - start <= TRANSIENT_MAX_SECONDS:
                bursts.append(
                    {"start": start, "end": end + frame_ms / 1000.0, "peak": float(peak), "peakAt": float(burst_run[0])}
                )
        burst_run.clear()

    for i in range(len(m)):
        if m[i] >= burst_floor:
            burst_run.append(i)
        else:
            close_burst_run()
    close_burst_run()

    cadence_onsets: List[float] = []
    for b in bursts:
        span = b["end"] - b["start"]
        extra = f" over {span:.2f}s" if span > frame_ms / 1000.0 * 1.5 else ""
        signals.append(
            {
                "kind": "transient",
                "start": b["start"],
                "end": b["end"],
                "peak": min(1.0, b["peak"]),
                "confidence": min(0.88, 0.4 + min(1.0, b["peak"]) * 0.55),
                "evidence": [f"motion burst {b['peak'] * 100:.0f}% of peak scale at {b['start']:.2f}s{extra}"],
            }
        )

    # sustained runs (absolute-level gate: a periodic rhythm raises the
    # median baseline, so a relative gate would wrongly suppress these;
    # transient detection below uses the relative gate instead)
    sustained: List[Dict[str, Any]] = []
    run: List[int] = []
    for i in range(len(sm)):
        if sm[i] >= SUSTAIN_MIN and sm[i] >= baseline[i] * 0.4:
            run.append(i)
        else:
            if len(run) >= SUSTAIN_MIN_SECONDS * fps:
                sustained.append({"idx": run[:]})
            run = []
    if len(run) >= SUSTAIN_MIN_SECONDS * fps:
        sustained.append({"idx": run[:]})

    for seg in sustained:
        idxs = seg["idx"]
        start = features[idxs[0]].t
        end = features[idxs[-1]].t
        peak = max(m[j] for j in idxs)
        if end - start < CADENCE_MIN_SECONDS or peak < 0.22:
            signals.append(
                {
                    "kind": "sustained",
                    "start": start,
                    "end": end,
                    "peak": min(1.0, peak),
                    "confidence": min(0.7, 0.35 + peak * 0.4),
                    "evidence": [f"continuous motion {peak * 100:.0f}% for {end - start:.1f}s"],
                }
            )
            continue
        peaks: List[int] = []
        for k in range(1, len(idxs) - 1):
            i = idxs[k]
            if m[i] >= m[i - 1] and m[i] > m[i + 1] and m[i] >= 0.28:
                peaks.append(i)
        kept: List[int] = []
        for i in peaks:
            if kept and features[i].t - features[kept[-1]].t < CADENCE_MIN_GAP:
                if m[i] > m[kept[-1]]:
                    kept[-1] = i
            else:
                kept.append(i)
        gaps = [features[kept[k + 1]].t - features[kept[k]].t for k in range(len(kept) - 1)]
        gap_median = _median(gaps) if gaps else 0.0
        regular = (
            len(kept) >= CADENCE_MIN_PEAKS
            and bool(gaps)
            and all(CADENCE_MIN_GAP <= g <= CADENCE_MAX_GAP for g in gaps)
        )
        if regular:
            spread = (max(gaps) - min(gaps)) / max(0.01, gap_median) if gaps else 1.0
            regularity = max(0.0, min(1.0, 1 - spread))
            onsets = [features[i].t for i in kept]
            cadence_onsets.extend(onsets)
            signals.append(
                {
                    "kind": "cadence",
                    "start": start,
                    "end": end,
                    "peak": min(1.0, peak),
                    "confidence": min(0.92, 0.55 + peak * 0.25 + regularity * 0.18),
                    "evidence": [f"gait-like cadence: {len(kept)} contacts, median gap {gap_median:.2f}s (spread {spread:.2f})"],
                    "onsets": onsets,
                }
            )
        else:
            signals.append(
                {
                    "kind": "sustained",
                    "start": start,
                    "end": end,
                    "peak": min(1.0, peak),
                    "confidence": min(0.6, 0.3 + peak * 0.4),
                    "evidence": [f"continuous motion {peak * 100:.0f}% for {end - start:.1f}s (no stable rhythm)"],
                }
            )

    # cuts (drift vs rolling reference)
    for i in range(2, len(features) - 2):
        if features[i].drift > 90 and features[i].drift >= features[i - 1].drift and features[i].drift > features[i + 1].drift:
            signals.append(
                {
                    "kind": "cut",
                    "start": features[i].t,
                    "end": features[i].t + frame_ms / 1000.0,
                    "peak": 0.5,
                    "confidence": 0.5,
                    "evidence": [f"shot change: frame drift {features[i].drift:.0f}/255 at {features[i].t:.2f}s"],
                }
            )

    signals.sort(key=lambda s: s["start"])
    return signals


# ------------------------------------------------ signals → events ---


def _env_text(title: str, tags: List[str], summary: str) -> str:
    return " ".join([title, " ".join(tags), summary]).lower()


def _has_env(hay: str, words: List[str]) -> bool:
    return any(w in hay for w in words)


def _detect_material(hay: str) -> Optional[str]:
    mats: List[Tuple[str, List[str]]] = [
        ("metal", ["metal", "iron", "steel", "chain", "rust"]),
        ("wood", ["wood", "wooden", "plank", "floorboard"]),
        ("glass", ["glass", "window"]),
        ("concrete", ["concrete", "cement", "stone"]),
        ("cloth", ["cloth", "clothing", "fabric"]),
    ]
    for name, words in mats:
        if _has_env(hay, words):
            return name
    return None


def _detect_environment(hay: str) -> Optional[str]:
    envs: List[Tuple[str, List[str]]] = [
        ("basement", ["basement", "cellar", "underground"]),
        ("concrete room", ["concrete room"]),
        ("industrial", ["industrial"]),
        ("staircase", ["stair", "stairs", "staircase"]),
        ("forest", ["forest", "trees", "woodland"]),
        ("street", ["street", "road", "traffic"]),
        ("room", ["room", "interior", "inside", "hall"]),
    ]
    for name, words in envs:
        if _has_env(hay, words):
            return name
    return None


def _kind_for_signal(sig: Dict[str, Any], hay: str) -> Tuple[str, float, str]:
    kind = sig.get("kind")
    if kind == "cut":
        return "other", 0.3, "shot change; sound role unknown from pixels alone"
    if kind == "cadence":
        if _has_env(hay, ROLE_KEYWORDS["FOOTSTEP"]):
            return "footstep", 0.85, "regular contact rhythm + scene naming walking/footsteps"
        if _has_env(hay, ROLE_KEYWORDS["DOOR"]):
            return "door", 0.7, "rhythmic contacts near a door"
        if _has_env(hay, ROLE_KEYWORDS["ANIMAL"]):
            return "other", 0.5, "rhythm consistent with movement, source ambiguous"
        return "body", 0.55, "gait-like rhythm but scene does not name the source"
    if kind == "sustained":
        if _has_env(hay, ROLE_KEYWORDS["MECHANICAL"]):
            return "mechanical", 0.8, "continuous motion + scene names machinery"
        if _has_env(hay, ROLE_KEYWORDS["WATER"]):
            return "water", 0.7, "continuous motion + scene names water"
        if _has_env(hay, ROLE_KEYWORDS["WIND"]):
            return "wind", 0.7, "continuous motion + scene names wind"
        if _has_env(hay, ROLE_KEYWORDS["VEHICLE"]):
            return "vehicle", 0.7, "continuous motion + scene names vehicle"
        if _has_env(hay, ROLE_KEYWORDS["ROOM_TONE"]):
            return "ambience", 0.45, "continuous low-energy motion in an interior"
        return "object-movement", 0.4, "continuous motion, source not named"
    if _has_env(hay, ROLE_KEYWORDS["DOOR"]):
        return "door", 0.7, "isolated contact near a named door"
    if _has_env(hay, ROLE_KEYWORDS["IMPACT"]):
        return "impact", 0.75, "isolated contact near named impact"
    if _has_env(hay, ROLE_KEYWORDS["FOOTSTEP"]):
        return "footstep", 0.7, "isolated contact while scene names walking"
    return "object-movement", 0.38, "isolated motion burst, source not named"


def _build_query(kind: str, material: Optional[str], environment: Optional[str], distance: str) -> Tuple[str, List[str]]:
    action = ACTION_BY_KIND.get(kind, "sound effect")
    parts: List[str] = []
    if distance == "far":
        parts.append("distant")
    if material and material != "cloth":
        parts.append(material)
    parts.append(action)
    if environment and kind != "room-tone":
        parts.append(environment)
    query = " ".join(dict.fromkeys(parts))[:200]
    without_material = " ".join(
        dict.fromkeys((["distant"] if distance == "far" else []) + [action] + ([environment] if environment else []))
    )
    without_env = " ".join(
        dict.fromkeys((["distant"] if distance == "far" else []) + ([material] if material else []) + [action])
    )
    alts = [a for a in [without_material, without_env] if a and a != query][:3]
    return query, alts


def signals_to_candidates(
    signals: List[Dict[str, Any]],
    scene_id: str,
    scene_start: float,
    title: str = "",
    tags: Optional[List[str]] = None,
    summary: str = "",
    max_events: int = 16,
) -> List[Dict[str, Any]]:
    """Map motion signals to SoundEventCandidate dicts (JSON-safe)."""
    tags = tags or []
    hay = _env_text(title, tags, summary)
    candidates: List[Dict[str, Any]] = []
    interior = _has_env(hay, ROLE_KEYWORDS["ROOM_TONE"])
    mechanical_env = _has_env(hay, ROLE_KEYWORDS["MECHANICAL"])
    material = _detect_material(hay)
    environment = _detect_environment(hay)

    if (interior or mechanical_env) and signals:
        anchor = signals[0]["start"]
        kind = "room-tone" if interior else "ambience"
        query, alts = _build_query(kind, None if material == "cloth" else material, environment, "medium")
        candidates.append(
            {
                "id": f"ev-bed-{scene_id}-{anchor:.2f}",
                "sceneId": scene_id,
                "timestamp": round(anchor, 3),
                "placementTimestamp": round(anchor, 3),
                "event": kind,
                "environment": environment,
                "material": material,
                "action": ACTION_BY_KIND[kind],
                "distance": "medium",
                "perspective": "onscreen",
                "confidence": round(min(0.62, 0.1 + 0.5 * 0.7), 2),
                "evidence": [f"environment metadata: {title} ({', '.join(tags)})", f"first activity at {anchor:.2f}s anchors the bed"],
                "suggestedRole": ROLE_BY_KIND[kind],
                "query": query,
                "altQueries": alts,
                "ambiguous": True,
            }
        )

    for sig in signals:
        kind, semantic, note = _kind_for_signal(sig, hay)
        peak = float(sig.get("peak", 0.0))
        area = min(0.6, peak * 0.4)
        distance = "close" if area > 0.34 else "medium" if area > 0.14 else "far"
        evidence = list(sig.get("evidence", []))
        evidence.append(f"motion occupied {area * 100:.0f}% of frame → {distance}")
        evidence.append(note)
        query, alts = _build_query(kind, material, environment, distance)
        ambiguous = semantic <= 0.55
        conf = round(min(0.75 if ambiguous else 0.85, float(sig.get("confidence", 0.3)) * 0.6 + semantic * 0.4), 2)
        if sig.get("kind") == "cadence" and sig.get("onsets"):
            for onset in sig["onsets"]:
                candidates.append(
                    _mk_candidate(f"{scene_id}", kind, material, environment, distance, onset, onset, conf, evidence, query, alts, sig, ambiguous)
                )
        else:
            start = float(sig["start"])
            candidates.append(
                _mk_candidate(f"{scene_id}", kind, material, environment, distance, start, start, conf, evidence, query, alts, sig, ambiguous)
            )

    candidates.sort(key=lambda c: c["timestamp"])
    deduped: List[Dict[str, Any]] = []
    for c in candidates:
        if deduped and abs(deduped[-1]["timestamp"] - c["timestamp"]) < 0.18 and deduped[-1]["event"] == c["event"]:
            if c["confidence"] > deduped[-1]["confidence"]:
                deduped[-1] = c
            continue
        deduped.append(c)
    return deduped[:max_events]


def _mk_candidate(scene_id, kind, material, environment, distance, detected, placed, confidence, evidence, query, alts, sig, ambiguous: bool = False) -> Dict[str, Any]:
    return {
        "id": f"ev-{scene_id}-{kind}-{detected:.2f}",
        "sceneId": scene_id,
        "timestamp": round(detected, 3),
        "placementTimestamp": round(placed, 3),
        "duration": round(max(0.08, float(sig.get("end", sig.get("start", detected))) - detected), 3),
        "event": kind,
        "material": material,
        "action": ACTION_BY_KIND.get(kind, "sound effect"),
        "environment": environment,
        "distance": distance,
        "perspective": "onscreen",
        "confidence": confidence,
        "evidence": evidence,
        "suggestedRole": ROLE_BY_KIND[kind],
        "query": query,
        "altQueries": alts,
        "ambiguous": ambiguous,
    }


# --------------------------------------------------- ffmpeg pipeline ---

FFMPEG_TIMEOUT = 180


def analyze_gray_frames(frame_bytes: Iterable[bytes], fps: float, scene_start: float = 0.0) -> List[FrameFeatures]:
    """Compute features from an iterable of raw gray frames (24×14)."""
    features: List[FrameFeatures] = []
    prev: Optional[bytes] = None
    ref: Optional[bytes] = None
    for i, frame in enumerate(frame_bytes):
        if len(frame) < GRID_W * GRID_H:
            break
        if i % 24 == 0:
            ref = frame
        t = scene_start + i / max(1.0, fps)
        features.append(frame_features(frame, prev, ref, t))
        prev = frame
    return features


def analyze_video_events(
    path: Path,
    *,
    fps: float = 6.0,
    max_frames: int = 480,
    scene_id: str = "",
    scene_start: float = 0.0,
    title: str = "",
    tags: Optional[List[str]] = None,
    summary: str = "",
) -> Dict[str, Any]:
    """Real ffmpeg-based analysis; honest `available:false` when it cannot run."""
    if shutil.which("ffmpeg") is None:
        return {
            "available": False,
            "method": "none",
            "frameCount": 0,
            "fps": fps,
            "duration": 0.0,
            "partial": False,
            "events": [],
            "message": "ffmpeg not found — install it for real video motion analysis.",
        }
    if not path.exists():
        return {
            "available": False,
            "method": "none",
            "frameCount": 0,
            "fps": fps,
            "duration": 0.0,
            "partial": False,
            "events": [],
            "message": f"video not found: {path}",
        }

    cmd = [
        "ffmpeg",
        "-v", "error",
        "-ss", f"{max(0.0, scene_start):.3f}",
        "-i", str(path),
        "-vf", f"fps={fps},scale={GRID_W}:{GRID_H},format=gray",
        "-frames:v", str(max_frames),
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "pipe:1",
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert proc.stdout is not None
        frame_size = GRID_W * GRID_H
        frames: List[bytes] = []
        for _ in range(max_frames):
            chunk = proc.stdout.read(frame_size)
            if len(chunk) < frame_size:
                break
            frames.append(chunk)
        proc.stdout.close()
        stderr = (proc.stderr or b"").read().decode("utf-8", "replace")[:400]
        proc.wait(timeout=FFMPEG_TIMEOUT)
    except (subprocess.TimeoutExpired, AssertionError) as exc:
        return {
            "available": False,
            "method": "none",
            "frameCount": 0,
            "fps": fps,
            "duration": 0.0,
            "partial": False,
            "events": [],
            "message": f"ffmpeg analysis failed: {exc}",
        }

    features = analyze_gray_frames(frames, fps, scene_start)
    if len(features) < 3:
        return {
            "available": True,
            "method": "backend-ffmpeg",
            "frameCount": len(features),
            "fps": fps,
            "duration": 0.0,
            "partial": True,
            "events": [],
            "message": f"Not enough frames to measure motion ({len(features)}).",
        }
    signals = detect_motion_signals(features, fps)
    events = signals_to_candidates(signals, scene_id, scene_start, title, tags or [], summary)
    return {
        "available": True,
        "method": "backend-ffmpeg",
        "frameCount": len(features),
        "fps": fps,
        "duration": len(features) / max(1.0, fps),
        "partial": len(features) >= max_frames,
        "events": events,
        "message": f"{len(events)} candidate(s) from {len(features)} frames" + (f" ({stderr})" if stderr else ""),
    }
