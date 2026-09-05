"""Deterministic tests for the video motion-event analyzer.

No ffmpeg, no models: synthetic gray grids exercise the pure signal
processing. Each assertion is about what the pixels actually show —
nothing is fabricated.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.analysis.events import (
    GRID_H,
    GRID_W,
    analyze_gray_frames,
    analyze_video_events,
    detect_motion_signals,
    signals_to_candidates,
)


def frame_empty(base: int = 30) -> bytes:
    return bytes([base]) * (GRID_W * GRID_H)


def frame_band(shift: int, width: int = 6, bright: int = 200, base: int = 30) -> bytes:
    g = bytearray([base]) * (GRID_W * GRID_H)
    for y in range(GRID_H):
        for x in range(shift, min(GRID_W, shift + width)):
            g[y * GRID_W + x] = bright
    return bytes(g)


def frames_static(n: int) -> list[bytes]:
    return [frame_empty() for _ in range(n)]


def frames_transient(fps: int = 8) -> list[bytes]:
    """4s of quiet, one 2-frame burst, then quiet."""
    frames: list[bytes] = []
    for i in range(int(4.0 * fps)):
        if i in (16, 17):  # burst centred near 2.0s
            frames.append(frame_band(0))
        else:
            frames.append(frame_empty())
    return frames


def frames_cadence(fps: int = 8, seconds: float = 3.2) -> list[bytes]:
    """Periodic contacts every 4 frames (0.5 s) inside sustained motion."""
    frames: list[bytes] = []
    n = int(seconds * fps)
    for i in range(n):
        phase = i % 4
        if phase < 2:
            frames.append(frame_band(0 if phase == 0 else 6))
        else:
            frames.append(frame_empty())
    return frames


def test_static_video_produces_no_events():
    features = analyze_gray_frames(frames_static(48), fps=8)
    signals = detect_motion_signals(features, fps=8)
    assert signals == []


def test_transient_burst_is_detected_at_its_onset():
    features = analyze_gray_frames(frames_transient(), fps=8)
    signals = detect_motion_signals(features, fps=8)
    transients = [s for s in signals if s["kind"] == "transient"]
    assert len(transients) >= 1, signals
    # onset within +/-1 frame (125 ms) of the synthetic burst at 2.0s
    burst = transients[0]["start"]
    assert abs(burst - 2.0) <= 0.2, burst


def test_cadence_yields_regular_step_onsets():
    features = analyze_gray_frames(frames_cadence(), fps=8)
    signals = detect_motion_signals(features, fps=8)
    cadence = [s for s in signals if s["kind"] == "cadence"]
    assert len(cadence) == 1, signals
    onsets = cadence[0]["onsets"]
    assert onsets is not None and len(onsets) >= 5, onsets
    gaps = [b - a for a, b in zip(onsets, onsets[1:])]
    assert all(0.3 <= g <= 0.8 for g in gaps), gaps


def test_negative_space_is_preserved():
    features = analyze_gray_frames(frames_static(120), fps=8)
    signals = detect_motion_signals(features, fps=8)
    candidates = signals_to_candidates(signals, "sc-1", 0.0, title="still basement", tags=["basement", "quiet"])
    assert candidates == []


def test_candidates_map_to_audible_queries_not_cinematic_prose():
    features = analyze_gray_frames(frames_cadence(), fps=8)
    signals = detect_motion_signals(features, fps=8)
    candidates = signals_to_candidates(
        signals,
        "sc-walk",
        0.0,
        title="Concrete basement walk",
        tags=["basement", "concrete", "footsteps", "walking", "rusty", "metal"],
        summary="character walks across concrete, metal stairs",
    )
    footstep = [c for c in candidates if c["event"] == "footstep"]
    assert len(footstep) >= 1
    for c in footstep:
        assert c["query"] and not any(word in c["query"] for word in ["scary", "creepy", "nightmare", "dark"])
        assert "footstep" in c["query"] or "step" in c["query"]
        assert c["suggestedRole"] == "FOOTSTEP"
        assert c["confidence"] <= 0.92
        assert c["evidence"], "evidence must explain why the event exists"


def test_ambiguous_activity_stays_suggest_only():
    # generic motion, scene text says nothing about the source
    features = analyze_gray_frames(frames_cadence(), fps=8)
    signals = detect_motion_signals(features, fps=8)
    candidates = signals_to_candidates(signals, "sc-2", 5.0, title="Interior", tags=["room"], summary="")
    # without walking/door context the role stays ambiguous: generic
    # body/foley suggestions only, and never at AUTO-SAFE confidence (>=0.8)
    for c in candidates:
        assert c["confidence"] <= 0.8, c
        if c["event"] != "room-tone":
            assert c["suggestedRole"] in ("BODY", "MISC_FOLEY"), c


def test_backend_analysis_is_honest_when_unavailable(tmp_path: Path):
    missing = tmp_path / "nope.mov"
    result = analyze_video_events(missing, fps=8, max_frames=32)
    assert result["available"] is False
    if result["method"] == "none":
        assert "ffmpeg" in result["message"] or "not found" in result["message"]


def test_api_events_route_is_honest():
    """POST /api/analysis/events validates input and never fabricates."""
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        missing = c.post("/api/analysis/events", json={})
        assert missing.status_code == 400

        no_file = c.post("/api/analysis/events", json={"path": "/definitely/not/here.mov"})
        assert no_file.status_code == 200
        body = no_file.json()
        assert body["available"] is False
        assert body["events"] == []
        assert body["message"]


# ---------------------------------------------------------------------- #
#  Runtime fixtures (REAL H.264 MP4 files decoded via ffmpeg).  Only run  #
#  when ffmpeg is actually installed; otherwise skip, never fake.        #
# ---------------------------------------------------------------------- #

import shutil as _shutil
from pathlib import Path as _Path

_FIXTURES = _Path(__file__).resolve().parents[2] / "fixtures" / "runtime"


def _need_ffmpeg():
    if _shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed — runtime fixture test skipped")


def test_runtime_door_fixture_observed_onsets():
    _need_ffmpeg()
    if not (_FIXTURES / "door_open_18_4.mp4").exists():
        pytest.skip("runtime fixture not present")
    r = analyze_video_events(
        _FIXTURES / "door_open_18_4.mp4",
        fps=8,
        max_frames=280,
        scene_id="s1",
        scene_start=0.0,
        title="Old metal door opens in a basement room",
        tags=["basement", "metal", "door", "doorway", "interior"],
        summary="A heavy metal door is swung open",
    )
    assert r["available"] is True
    assert r["method"] == "backend-ffmpeg"
    doors = [e for e in r["events"] if e["event"] == "door"]
    assert len(doors) == 1, f"expected exactly 1 DOOR event, got {len(doors)}"
    assert abs(doors[0]["timestamp"] - 18.4) <= 0.15, f"door onset {doors[0]['timestamp']} not within 150 ms of 18.4"


def test_runtime_footstep_fixture_five_onsets():
    _need_ffmpeg()
    if not (_FIXTURES / "five_footsteps.mp4").exists():
        pytest.skip("runtime fixture not present")
    r = analyze_video_events(
        _FIXTURES / "five_footsteps.mp4",
        fps=12,
        max_frames=280,
        scene_id="s2",
        scene_start=0.0,
        title="Concrete basement corridor walk",
        tags=["basement", "concrete", "footsteps", "walking"],
        summary="Someone walks across the corridor",
    )
    assert r["available"] is True
    steps = [e for e in r["events"] if e["event"] == "footstep"]
    assert len(steps) == 5, f"expected 5 footstep events, got {len(steps)}: {[e['timestamp'] for e in steps]}"
    truth = [0.8, 1.6, 2.4, 3.2, 4.0]
    for e, t in zip(steps, truth, strict=True):
        assert abs(e["timestamp"] - t) <= 0.15, f"onset {e['timestamp']} not within 150 ms of {t}"
