"""Lightweight tests for the X-CLIP semantic video-analysis layer.

No model weights, no torch, no ffmpeg is required here. Real inference is
mocked (``_infer`` / ``_sample_one_window``) so the orchestration, cache,
normalization and event-attachment contracts are pinned without a download.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from backend.analysis.xclip import (
    DEFAULT_TOP_K,
    VOCABULARY,
    VOCABULARY_BY_ID,
    XCLIP_MODEL_ID,
    SemanticCache,
    SemanticLabel,
    SemanticResult,
    XCLIPAnalyzer,
    SampledWindow,
    attach_semantics,
    event_window,
    normalize_semantic_results,
    semantic_query,
    uniform_timestamps,
    vocabulary_texts,
)


# ------------------------------------------------------------- vocabulary


def test_vocabulary_contains_requested_labels():
    texts = vocabulary_texts()
    for expected in (
        "footsteps walking",
        "person running",
        "a door opening",
        "a door closing",
        "an object falling",
        "an object impact",
        "an object being placed down",
        "fabric or clothing movement",
        "a person sitting",
        "a person standing",
        "a hand contacting a surface",
        "a vehicle moving",
        "machinery operating",
        "water movement",
        "fire burning",
        "physical struggle",
        "general human movement",
    ):
        assert expected in texts, expected


def test_vocabulary_is_centralized_and_uniquely_keyed():
    ids = [v.id for v in VOCABULARY]
    assert len(ids) == len(set(ids)), f"duplicate ids: {[i for i in ids if ids.count(i) > 1]}"
    assert len(VOCABULARY_BY_ID) == len(VOCABULARY)
    valid_roles = {
        "ROOM_TONE", "AMBIENCE", "FOOTSTEP", "CLOTHING", "DOOR", "WOOD", "METAL",
        "GLASS", "BODY", "BREATH", "MECHANICAL", "ELECTRICAL", "WIND", "WEATHER",
        "WATER", "CREAK", "SCRAPE", "IMPACT", "KNOCK", "RATTLE", "RUMBLE", "DRONE",
        "TEXTURE", "TRANSITION", "ANIMAL", "VEHICLE", "MISC_FOLEY",
    }
    valid_events = {
        "footstep", "door", "impact", "cloth", "mechanical", "water", "wind",
        "vehicle", "ambience", "room-tone", "body", "breath", "object-movement",
        "other",
    }
    for label in VOCABULARY:
        assert label.role in valid_roles, label
        assert label.event_kind in valid_events, label
        assert label.query, label


# ---------------------------------------------------------- pure helpers


def test_event_window_is_bounded_and_centred():
    start, end = event_window(18.4, 0.8)
    assert start == pytest.approx(18.2)
    assert end - start > 0.5
    # never unbounded even with a huge requested window
    start2, end2 = event_window(50.0, 60.0, window_seconds=120)
    assert end2 - start2 <= 4.0


def test_uniform_timestamps_are_even():
    t = uniform_timestamps(2.0, 6.0, 4)
    assert t == [2.0, 3.0, 4.0, 5.0]
    assert uniform_timestamps(2.0, 2.0, 3) == [2.0]


def test_frame_sampling_is_honest_without_ffmpeg(tmp_path):
    analyzer = XCLIPAnalyzer(cache_root=tmp_path / "cache")
    window = analyzer._sample_one_window(tmp_path / "nope.mp4", "e1", 0.0, 1.0, 8)
    if not window.available:
        assert window.message
        assert window.frame_paths == []


# -------------------------------------------------------- normalization


def test_normalize_results_maps_to_umbra_roles():
    raw = [
        [
            ("footsteps walking", 0.9),
            ("a door opening", 0.5),
            ("fire burning", 0.2),
        ]
    ]
    results = normalize_semantic_results(raw, event_ids=["ev-1"], top_k=3)
    assert results[0].available is True
    cands = results[0].candidates
    assert cands[0].label == "footsteps walking"
    assert cands[0].role == "FOOTSTEP"
    assert cands[0].audio_set == "Walk, footsteps"
    assert cands[1].role == "DOOR"
    assert cands[2].role == "MISC_FOLEY"
    assert sum(c.confidence for c in cands) == pytest.approx(1.0, abs=0.001)
    assert cands[0].similarity > cands[1].similarity


def test_normalize_results_unknown_label_is_honest():
    raw = [[("something totally unseen", 0.9)]]
    results = normalize_semantic_results(raw, event_ids=["ev-x"], top_k=1)
    c = results[0].candidates[0]
    assert c.label == "something totally unseen"
    assert c.label_id is None
    assert c.role == "MISC_FOLEY"
    assert c.event_kind == "other"
    assert c.query == "something totally unseen"


def test_semantic_query_uses_top_candidate():
    raw = [[("a door opening", 0.7), ("a door closing", 0.3)]]
    result = normalize_semantic_results(raw, event_ids=["ev-d"], top_k=2)[0]
    assert semantic_query(result) == "door opening creak hinge"


# -------------------------------------------------------- event attach


def test_attach_semantics_attaches_to_existing_event():
    events = [
        {"id": "ev-1", "event": "footstep", "confidence": 0.8, "evidence": ["x"]},
        {"id": "ev-2", "event": "door", "confidence": 0.7, "evidence": ["y"]},
    ]
    result = normalize_semantic_results(
        [[("a door opening", 0.9), ("a door closing", 0.1)]],
        event_ids=["ev-2"],
        top_k=2,
    )
    enriched = attach_semantics(events, result)
    assert enriched[0]["event"] == "footstep"  # untouched
    assert enriched[0].get("semantic") is None
    assert enriched[1]["event"] == "door"
    assert enriched[1]["semantic"]["candidates"][0]["label"] == "a door opening"


# ------------------------------------------------------------- cache


def test_cache_roundtrips_and_misses(tmp_path):
    cache = SemanticCache(tmp_path / "cache")
    key = cache.key_for(tmp_path / "v.mp4", 1.0, 2.5, 8)
    assert cache.has(key) is False
    assert cache.get(key) is None
    cache.put(key, {"available": True, "candidates": []})
    assert cache.has(key) is True
    assert cache.get(key)["available"] is True
    # stable key independent of cache object
    cache2 = SemanticCache(tmp_path / "cache")
    assert cache2.key_for(tmp_path / "v.mp4", 1.0, 2.5, 8) == key


def test_cache_key_changes_with_window(tmp_path):
    cache = SemanticCache(tmp_path / "cache")
    v = tmp_path / "v.mp4"
    v.write_bytes(b"x")
    assert cache.key_for(v, 1.0, 2.0, 8) != cache.key_for(v, 3.0, 4.0, 8)


# ------------------------------------------------------- analyzer mock


def _make_runnable_analyzer(tmp_path) -> XCLIPAnalyzer:
    analyzer = XCLIPAnalyzer(cache_root=tmp_path / "cache")
    local = tmp_path / "weights"
    local.mkdir()
    (local / "config.json").write_text("{}")
    analyzer._local_path = lambda: local
    analyzer._deps_ok = lambda: True
    analyzer._model = object()
    analyzer._processor = object()
    analyzer._model_device = "cpu"
    return analyzer


def test_missing_model_is_honest(tmp_path):
    analyzer = XCLIPAnalyzer(cache_root=tmp_path / "cache")
    analyzer._local_path = lambda: None
    analyzer._deps_ok = lambda: False

    async def run():
        return await analyzer.enrich_events(
            tmp_path / "v.mp4",
            [{"id": "ev-1", "timestamp": 1.0}],
        )

    result = asyncio.run(run())
    assert result["available"] is False
    assert result["installHint"] == "python scripts/setup_models.py --xclip"
    assert result["events"][0]["semantic"]["available"] is False
    assert "X-CLIP" in result["message"]


def test_mock_inference_attaches_and_caches(tmp_path):
    analyzer = _make_runnable_analyzer(tmp_path)
    video = tmp_path / "v.mp4"
    video.write_bytes(b"fake")

    samples = [SampledWindow(True, "ev-1", 0.8, 2.3, ["a.jpg", "b.jpg"], [0.8, 1.55])]
    analyzer._sample_one_window = lambda *a, **k: samples[0]

    calls = {"infer": 0, "sample": 0}

    def fake_infer(_frames, _texts):
        calls["infer"] += 1
        return [
            [
                ("fire burning", 0.8),
                ("water movement", 0.2),
            ]
        ]

    analyzer._infer = fake_infer
    original_sample = analyzer._sample_one_window

    def counting_sample(*args, **kwargs):
        calls["sample"] += 1
        return original_sample(*args, **kwargs)

    analyzer._sample_one_window = counting_sample

    async def run():
        return await analyzer.enrich_events(video, [{"id": "ev-1", "timestamp": 1.0}], top_k=2)

    first = asyncio.run(run())
    assert first["available"] is True
    ev = first["events"][0]
    cands = ev["semantic"]["candidates"]
    assert cands[0]["label"] == "fire burning"
    assert ev["semanticQuery"] == "fire crackling"
    assert calls["infer"] == 1
    assert calls["sample"] == 1
    assert analyzer.status()["runtimeVerified"] is True

    # second run must read cache and not touch inference/frames again
    async def run2():
        return await analyzer.enrich_events(video, [{"id": "ev-1", "timestamp": 1.0}], top_k=2)

    calls["sample"] = 0
    calls["infer"] = 0
    # force an error if sampling or inference is attempted
    analyzer._sample_one_window = lambda *a, **k: (_ for _ in ()).throw(AssertionError("sample called"))
    analyzer._infer = lambda *a, **k: (_ for _ in ()).throw(AssertionError("infer called"))
    second = asyncio.run(run2())
    assert second["stats"]["cacheHits"] == 1
    assert second["stats"]["inferenceCount"] == 0
    assert second["events"][0]["semantic"]["cacheHit"] is True


# -------------------------------------------------------------- HTTP


def test_api_xclip_requires_path():
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        assert c.post("/api/analysis/xclip", json={}).status_code == 400
        r = c.post("/api/analysis/xclip", json={"path": "/none.mp4", "events": [{"id": "e1", "timestamp": 1.0}]})
        assert r.status_code == 200
        body = r.json()
        if body["available"] is False:
            assert body["message"]
            assert "installHint" in body


def test_api_events_include_semantics_is_opt_in_and_honest():
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        r = c.post(
            "/api/analysis/events",
            json={
                "path": "/definitely/not/here.mov",
                "includeSemantics": True,
                "windowSeconds": 1.0,
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert "semantic" in body
        assert body["semantic"]["installHint"]  # missing-model path is honest


def test_api_xclip_status_shape():
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        body = c.get("/api/analysis/xclip/status").json()["xclip"]
        assert body["id"] == "xclip"
        assert body["model"] in (None, "microsoft/xclip-base-patch32")
        assert body["runtimeVerified"] is False  # weights alone must never imply it


# ---------------------------------------------------------- integrations


def test_semantic_result_json_is_safe():
    result = normalize_semantic_results(
        [[("a door opening", 0.6), ("a door closing", 0.1)]],
        event_ids=["e"],
        top_k=2,
    )[0]
    result.device = "cpu"
    data = json.dumps(result.to_json())
    assert "label" in data
    assert "confidence" in data
    assert "audioSet" in data
