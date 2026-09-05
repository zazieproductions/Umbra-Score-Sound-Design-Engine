"""Tests for the UMBRA local ML backend.

These deliberately exercise the parts that are easy to fake and therefore
important to pin down:

* the real-result contract (nothing registers without decoding)
* capability honesty (turbo checkpoints must not claim continuation)
* the ACE-Step payload mapping
* horror-first negative direction
* intent routing for every example in the product spec
"""

from __future__ import annotations

import math
import struct
import time
import wave
from pathlib import Path

import pytest

from backend.analysis.scenes import plan_scene
from backend.analysis.spotting import build_prompt
from backend.providers.ace_step import AceStepProvider, _is_base_family, clamp_bpm, clamp_duration
from backend.providers.base import Capability, GenerationRequest, ProviderError, TaskType
from backend.providers.registry import route_intent
from backend.services.audio_store import AudioDecodeError, AudioStore, probe_audio


# --------------------------------------------------------------------- helpers


def write_sine(path: Path, seconds: float = 1.0, sr: int = 48000, channels: int = 2) -> Path:
    frames = int(seconds * sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        data = bytearray()
        for i in range(frames):
            v = int(0.3 * 32767 * math.sin(2 * math.pi * 110 * i / sr))
            for _ in range(channels):
                data += struct.pack("<h", v)
        w.writeframes(bytes(data))
    return path


# ---------------------------------------------------------- real audio contract


def test_probe_audio_reads_real_values(tmp_path):
    p = write_sine(tmp_path / "a.wav", seconds=1.5, sr=48000, channels=2)
    sr, ch, frames = probe_audio(p)
    assert sr == 48000
    assert ch == 2
    assert frames == 72000


def test_probe_audio_rejects_non_audio(tmp_path):
    bad = tmp_path / "not-audio.wav"
    bad.write_bytes(b"this is not audio at all")
    with pytest.raises(AudioDecodeError):
        probe_audio(bad)


def test_probe_audio_rejects_empty(tmp_path):
    empty = tmp_path / "empty.wav"
    empty.write_bytes(b"")
    with pytest.raises(AudioDecodeError):
        probe_audio(empty)


def test_store_measures_duration_rather_than_trusting_caller(tmp_path):
    store = AudioStore(tmp_path / "store")
    src = write_sine(tmp_path / "b.wav", seconds=2.0)
    rec = store.register(src, provider="test", metadata={"duration": 999.0})
    # the *measured* duration wins over anything a provider claimed
    assert rec.duration == pytest.approx(2.0, abs=0.01)
    assert rec.frames == 96000
    assert rec.sample_rate == 48000
    assert rec.bytes > 0
    assert store.get(rec.id) is not None
    assert store.path_for(rec.id).exists()


def test_store_refuses_to_register_fake_audio(tmp_path):
    store = AudioStore(tmp_path / "store")
    bad = tmp_path / "fake.wav"
    bad.write_bytes(b"\x00" * 64)
    with pytest.raises(AudioDecodeError):
        store.register(bad, provider="test")
    assert store.list() == []


def test_store_roundtrips_index(tmp_path):
    root = tmp_path / "store"
    s1 = AudioStore(root)
    rec = s1.register(write_sine(tmp_path / "c.wav"), provider="test")
    s2 = AudioStore(root)
    assert s2.get(rec.id) is not None
    assert s2.get(rec.id).duration == pytest.approx(rec.duration)


def test_store_delete_removes_file(tmp_path):
    store = AudioStore(tmp_path / "store")
    rec = store.register(write_sine(tmp_path / "d.wav"), provider="test")
    path = Path(rec.path)
    assert path.exists()
    assert store.delete(rec.id) is True
    assert not path.exists()
    assert store.get(rec.id) is None


# ------------------------------------------------------------ ACE-Step mapping


def test_base_family_detection_matches_upstream_task_split():
    # acestep/constants.py: turbo models expose a smaller task set
    assert _is_base_family("acestep-v15-base") is True
    assert _is_base_family("acestep-v15-sft") is True
    assert _is_base_family("acestep-v15-xl-base") is True
    assert _is_base_family("acestep-v15-turbo") is False
    assert _is_base_family("acestep-v15-turbo-shift3") is False
    assert _is_base_family(None) is False


def test_capabilities_never_overclaim_on_turbo():
    p = AceStepProvider()
    caps = p._capabilities("acestep-v15-turbo", ready=True)
    assert Capability.MUSIC_GENERATION in caps
    assert Capability.REPAINT in caps
    assert Capability.KEY_CONDITIONING in caps
    # turbo has no `complete`/`lego` task -> no continuation or accompaniment
    assert Capability.CONTINUATION not in caps
    assert Capability.ACCOMPANIMENT not in caps


def test_capabilities_unlock_on_base_checkpoint():
    p = AceStepProvider()
    caps = p._capabilities("acestep-v15-base", ready=True)
    assert Capability.CONTINUATION in caps
    assert Capability.ACCOMPANIMENT in caps


def test_capabilities_empty_when_not_ready():
    p = AceStepProvider()
    assert p._capabilities("acestep-v15-base", ready=False) == []


def test_payload_maps_key_bpm_and_time_signature():
    p = AceStepProvider()
    req = GenerationRequest(
        provider="ace-step",
        prompt="sparse low-register dissonant score",
        duration=12,
        key="D",
        mode="minor",
        bpm=44,
        time_signature="4",
        seed=1234,
    )
    payload = p.build_payload(req, "acestep-v15-turbo")
    assert payload["key_scale"] == "D minor"
    assert payload["bpm"] == 44
    assert payload["time_signature"] == "4"
    assert payload["audio_duration"] == 12
    assert payload["seed"] == 1234
    assert payload["use_random_seed"] is False
    assert payload["task_type"] == "text2music"
    assert payload["audio_format"] == "wav"
    assert payload["lyrics"] == ""  # scoring is instrumental by default


def test_payload_clamps_to_upstream_bounds():
    assert clamp_duration(2) == 10.0       # DURATION_MIN
    assert clamp_duration(9999) == 600.0   # DURATION_MAX
    assert clamp_bpm(1) == 30              # BPM_MIN
    assert clamp_bpm(999) == 300           # BPM_MAX
    assert clamp_bpm(None) is None


def test_negative_direction_uses_lm_cfg_path():
    p = AceStepProvider()
    req = GenerationRequest(
        provider="ace-step", prompt="low bed", negative_prompt="drums, heroic resolution"
    )
    payload = p.build_payload(req, "acestep-v15-turbo")
    assert payload["lm_negative_prompt"] == "drums, heroic resolution"
    assert payload["lm_cfg_scale"] > 1


def test_continuation_refused_on_turbo_with_clear_reason():
    p = AceStepProvider()
    req = GenerationRequest(provider="ace-step", prompt="x", task=TaskType.CONTINUE)
    with pytest.raises(ProviderError) as exc:
        p.build_payload(req, "acestep-v15-turbo")
    assert exc.value.http_status == 409
    assert "base or sft" in str(exc.value)


def test_continuation_maps_to_complete_on_base():
    p = AceStepProvider()
    req = GenerationRequest(provider="ace-step", prompt="x", task=TaskType.CONTINUE)
    assert p.build_payload(req, "acestep-v15-base")["task_type"] == "complete"


def test_reference_audio_switches_to_cover():
    p = AceStepProvider()
    req = GenerationRequest(provider="ace-step", prompt="x", reference_audio_id="abc")
    payload = p.build_payload(req, "acestep-v15-turbo")
    assert payload["task_type"] == "cover"
    assert 0 < payload["audio_cover_strength"] <= 1


def test_repaint_uses_explicit_chunk_mask():
    p = AceStepProvider()
    req = GenerationRequest(
        provider="ace-step", prompt="x", task=TaskType.REPAINT,
        repaint_start=4.0, repaint_end=8.0,
    )
    payload = p.build_payload(req, "acestep-v15-turbo")
    assert payload["task_type"] == "repaint"
    assert payload["repainting_start"] == 4.0
    assert payload["repainting_end"] == 8.0
    assert payload["chunk_mask_mode"] == "explicit"


def test_advanced_params_are_allow_listed():
    p = AceStepProvider()
    req = GenerationRequest(
        provider="ace-step", prompt="x",
        advanced={"inferenceSteps": 16, "rm -rf": "nope", "guidance_scale": 5.0},
    )
    payload = p.build_payload(req, "acestep-v15-turbo")
    assert payload["inference_steps"] == 16
    assert payload["guidance_scale"] == 5.0
    assert "rm -rf" not in payload


def test_request_parses_camelcase_from_frontend():
    req = GenerationRequest.from_json({
        "provider": "ace-step",
        "prompt": "sparse low-register dissonant score, no drums",
        "negativePrompt": "heroic",
        "duration": 12,
        "bpm": 44,
        "key": "D",
        "mode": "minor",
        "timeSignature": "4",
        "seed": 7,
        "timelineStart": 48.0,
        "task": "continue",
    })
    assert req.task is TaskType.CONTINUE
    assert req.bpm == 44
    assert req.time_signature == "4"
    assert req.timeline_start == 48.0
    assert req.key_scale() == "D minor"


# ------------------------------------------------------------- horror prompting


def test_prompt_always_carries_anti_song_negatives():
    plan = build_prompt("slow dissonant low-register horror texture")
    neg = plan.negative_prompt.lower()
    assert "pop song structure" in neg
    assert "heroic trailer harmony" in neg
    assert "triumphant resolution" in neg


def test_prompt_honours_explicit_exclusions():
    plan = build_prompt("sparse low bed, no drums, no vocals")
    neg = plan.negative_prompt.lower()
    assert "drums" in neg
    assert "vocals" in neg


def test_prompt_keeps_composer_words_first():
    intent = "barely tonal sustained score"
    plan = build_prompt(intent)
    assert plan.prompt.startswith(intent)


def test_prompt_expands_horror_shorthand():
    plan = build_prompt("spectral, corroded, prepared piano")
    assert "inharmonic" in plan.prompt or "spectral smear" in plan.prompt
    assert plan.notes


def test_prompt_marks_instrumental_and_underscore():
    plan = build_prompt("low cluster")
    assert "instrumental" in plan.prompt
    assert "underscore" in plan.prompt or "cinematic cue" in plan.prompt


# -------------------------------------------------------------------- planner


def test_planner_is_deterministic():
    a = plan_scene(start=48.0, end=63.0, tension=0.82, scene_id="s6", index=6)
    b = plan_scene(start=48.0, end=63.0, tension=0.82, scene_id="s6", index=6)
    assert a.to_json() == b.to_json()


def test_planner_keeps_horror_tempo_range():
    for tension in (0.0, 0.25, 0.5, 0.75, 1.0):
        plan = plan_scene(start=0, end=15, tension=tension, index=3)
        assert 32 <= plan.bpm <= 84


def test_planner_withholds_musical_tension():
    plan = plan_scene(start=0, end=15, tension=0.9, index=1)
    # scene tension high, but the *score* holds back
    assert plan.tension < 0.7
    assert plan.dread > 0.6


def test_planner_structure_starts_quiet_and_ends_on_the_cut():
    plan = plan_scene(start=48.0, end=63.0, tension=0.4, index=6)
    assert plan.structure[0].at == pytest.approx(48.0)
    assert plan.structure[-1].action == "cut to silence"
    assert plan.structure[-1].at == pytest.approx(63.0)
    ats = [e.at for e in plan.structure]
    assert ats == sorted(ats)


def test_planner_text_is_readable_spotting_note():
    text = plan_scene(start=48.0, end=63.0, tension=0.8, index=6, label="Scene 6").as_text()
    assert "key:" in text
    assert "tempo:" in text
    assert "dread:" in text
    assert "structure:" in text


# --------------------------------------------------------------------- routing


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Score this scene with a dissonant low string bed", "ace-step"),
        ("Add a precisely timed 40 Hz sub swell", "umbra-procedural"),
        ("Generate rusted ventilation machinery", "stable-audio"),
        ("Create footsteps synced to this video selection", "mmaudio"),
        ("Find something in my library that sounds like distant metal scraping", "clap"),
        ("slow dissonant string texture in D minor, no percussion", "ace-step"),
        ("restrained 48 BPM low-register horror score with long silences", "ace-step"),
        ("reverse stinger before the cut", "umbra-procedural"),
        ("distant ventilation hum from the corridor", "stable-audio"),
    ],
)
def test_router_matches_spec_examples(text, expected):
    assert route_intent(text, has_video_selection="video" in text).provider == expected


def test_router_explains_itself():
    d = route_intent("Generate rusted ventilation machinery")
    assert d.reason
    assert d.matched
    assert 0 < d.confidence <= 1


def test_router_admits_when_it_has_no_signal():
    d = route_intent("something")
    assert d.confidence == 0.0
    assert "manually" in d.reason


def test_router_flags_unavailable_provider():
    d = route_intent("Generate rusted ventilation machinery", available=["umbra-procedural"])
    assert d.provider == "stable-audio"
    assert "not installed" in d.reason


# ------------------------------------------------------------- HTTP contract
#
# These exercise the real FastAPI app end to end. No model downloads, no
# network: every provider except the procedural one is legitimately absent in
# CI, which is exactly the state we want to pin down.


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from backend.app import app

    with TestClient(app) as c:
        yield c



def test_plan_scene_accepts_duration_or_end(client):
    """The frontend sends start/end; ad-hoc callers send a duration."""
    a = client.post("/api/plan/scene", json={"start": 4.0, "end": 28.0, "tension": 0.7})
    b = client.post("/api/plan/scene", json={"start": 4.0, "duration": 24.0, "tension": 0.7})
    assert a.status_code == 200 and b.status_code == 200
    pa, pb = a.json()["plan"], b.json()["plan"]
    assert pa["duration"] == pytest.approx(24.0)
    assert pb["duration"] == pytest.approx(24.0)
    assert pa["end"] == pytest.approx(pb["end"])


def test_procedural_provider_is_browser_side_only(client):
    """
    Umbra Procedural must never be rendered by Python — the browser owns it.
    The backend should say so clearly rather than returning silence.
    """
    r = client.post(
        "/api/generate",
        json={"provider": "umbra-procedural", "prompt": "low sub swell", "duration": 4},
    )
    assert r.status_code == 200
    job_id = r.json()["job"]["jobId"]

    for _ in range(50):
        job = client.get(f"/api/jobs/{job_id}").json()["job"]
        if job["state"] in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(0.05)

    assert job["state"] == "failed"
    assert "browser" in (job["error"] or "").lower()


def test_procedural_provider_still_reports_ready(client):
    """It is unavailable *in Python*, but it is a first-class provider."""
    providers = {p["id"]: p for p in client.get("/api/providers").json()["providers"]}
    proc = providers["umbra-procedural"]
    assert proc["ready"] is True
    assert proc["installed"] is True
    assert proc["device"] == "browser"


def test_no_fabricated_hardware_in_runtime_report(client):
    """Every device reported must be one the machine actually has."""
    rt = client.get("/api/health").json()["runtime"]
    ids = {d["id"] for d in rt["devices"]}
    assert "cpu" in ids
    assert rt["preferredDevice"] in ids
    for d in rt["devices"]:
        # no invented VRAM figures for devices that are not present
        if not d["available"]:
            assert d["totalMemoryBytes"] is None


def test_unavailable_providers_declare_no_capabilities(client):
    """A capability must never be advertised by a provider that is not installed."""
    for p in client.get("/api/providers").json()["providers"]:
        if not p["installed"]:
            assert p["capabilities"] == []
            assert p["installHint"], f"{p['id']} should tell the user how to install it"


# ------------------------------------------- preserved analysis (video/waveform)


def test_video_toolchain_reports_honestly():
    """ffmpeg is an external binary — never claim it when it is absent."""
    from backend.analysis.video import ffmpeg_available, toolchain_status

    status = toolchain_status()
    assert status["ffmpeg"]["available"] == ffmpeg_available()
    if not status["ffmpeg"]["available"]:
        assert status["ffmpeg"]["path"] is None
        assert status["note"]


def test_probe_video_degrades_without_ffprobe_or_file(tmp_path):
    """A missing tool or file yields available=False, not an exception."""
    from backend.analysis.video import probe_video

    info = probe_video(tmp_path / "nope.mov")
    assert info.available is False
    assert info.message
    assert info.duration == 0.0


def test_extract_range_rejects_empty_span(tmp_path):
    from backend.analysis.video import extract_range

    result = extract_range(tmp_path / "in.mov", tmp_path / "out.mov", 5.0, 5.0)
    assert result.ok is False
    assert result.message


def test_generate_peaks_returns_real_shape(tmp_path):
    """Peaks must come from the decoded file, not a synthesised curve."""
    from backend.analysis.waveform import generate_peaks

    p = write_sine(tmp_path / "peaks.wav", seconds=1.0, sr=48000, channels=1)
    result = generate_peaks(p, bins=64)

    assert result.available is True
    assert len(result.peaks) <= 64
    assert result.sample_rate == 48000
    assert result.duration == pytest.approx(1.0, abs=0.02)
    # a 0.3 amplitude sine normalises to a peak of 1.0
    assert max(result.peaks) == pytest.approx(1.0, abs=0.01)


def test_analyze_features_measures_real_levels(tmp_path):
    from backend.analysis.waveform import analyze_features

    p = write_sine(tmp_path / "level.wav", seconds=1.0, sr=48000, channels=1)
    f = analyze_features(p)

    assert f.available is True
    assert f.peak == pytest.approx(0.3, abs=0.01)
    # RMS of a sine is amplitude / sqrt(2)
    assert f.rms == pytest.approx(0.3 / math.sqrt(2), abs=0.01)
    assert f.crest_factor == pytest.approx(math.sqrt(2), abs=0.05)
    assert -12 < f.peak_db < -9


def test_silence_detection_distinguishes_unknown_from_silent(tmp_path):
    """None means 'could not measure' — never conflate that with silence."""
    from backend.analysis.waveform import is_effectively_silent

    assert is_effectively_silent(tmp_path / "missing.wav") is None

    loud = write_sine(tmp_path / "loud.wav", seconds=0.5, sr=48000, channels=1)
    assert is_effectively_silent(loud) is False


def test_waveform_handles_undecodable_file(tmp_path):
    from backend.analysis.waveform import analyze_features, generate_peaks

    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"this is not audio at all")

    assert generate_peaks(junk).available is False
    assert analyze_features(junk).available is False


def test_audio_feature_endpoints_reject_unknown_id(client):
    assert client.get("/api/audio/does-not-exist/peaks").status_code == 404
    assert client.get("/api/audio/does-not-exist/features").status_code == 404


def test_toolchain_endpoint(client):
    r = client.get("/api/analysis/toolchain")
    assert r.status_code == 200
    assert "ffmpeg" in r.json()


def test_single_provider_api_no_duplicate_abstraction():
    """
    There must be exactly ONE provider base class and ONE registry.
    PR #5's parallel schemas/AudioProvider layer was intentionally removed.
    """
    import backend

    root = Path(backend.__file__).parent
    assert not (root / "schemas").exists(), "backend/schemas must not return"
    assert not (root / "services" / "jobs.py").exists(), "duplicate job manager must not return"
    assert not (root / "providers" / "procedural_bridge.py").exists()
    assert not (root / "providers" / "pyscenedetect.py").exists()

    from backend.providers.base import AudioProvider

    assert AudioProvider is not None
