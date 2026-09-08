"""MMAudio plumbing only: no torch import, weights, downloads or real inference.

The optional ffmpeg test decodes a real tiny MP4, but inference stays mocked.
Passing this suite MUST NOT be reported as model runtime verification.
"""

import asyncio
import hashlib
import json
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from backend.analysis.video import ExtractResult, VideoInfo, extract_range, probe_video, toolchain_status
from backend.providers import mmaudio as adapter
from backend.providers.base import Capability, GenerationRequest, ProviderError, TaskType
from backend.providers.mmaudio import MMAudioProvider
from backend.providers.mmaudio_runtime import select_device
from backend.providers.registry import ProviderRegistry, route_intent
from backend.services import mmaudio_models as models, model_manager
from backend.services.audio_store import AudioStore
from backend.services.device import DeviceInfo
from scripts import setup_models


@pytest.fixture
def provider(tmp_path, monkeypatch):
    monkeypatch.setenv("UMBRA_CHECKPOINTS", str(tmp_path / "checkpoints"))
    monkeypatch.setattr(adapter, "preferred_device", lambda: DeviceInfo("cpu", "CPU", True))
    return MMAudioProvider(AudioStore(tmp_path / "audio"))


@pytest.fixture
def gen_request(provider, tmp_path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"mock video; not used for real decoding")
    return GenerationRequest(provider="mmaudio", video_path=str(video), video_start=18.417,
                             video_end=20.75, prompt="metal door closes", seed=0,
                             commercial_safe=False, allow_noncommercial=True)


@pytest.fixture
def tiny_assets(monkeypatch):
    """Replace expected asset sizes/hashes, not storage logic, with one-byte fixtures."""
    digest = hashlib.sha256(b"x").hexdigest()
    monkeypatch.setattr(models, "WEIGHTS", {name: (1, digest) for name in models.WEIGHTS})
    monkeypatch.setattr(models, "AUXILIARIES", {
        repo: {**aux, "files": {name: (1, digest) for name in aux["files"]}}
        for repo, aux in models.AUXILIARIES.items()
    })


def write_assets(root):
    for path in models.required_files(root):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    for repo, aux in models.AUXILIARIES.items():
        ref = models.cache_repo(root, repo) / "refs/main"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(aux["revision"])


@pytest.fixture
def ready(provider, tiny_assets, monkeypatch):
    write_assets(models.model_root())
    monkeypatch.setattr(model_manager, "package_installed", lambda _: True)
    monkeypatch.setattr(adapter, "toolchain_status", lambda: {
        "ffmpeg": {"available": True}, "ffprobe": {"available": True},
    })
    return provider


def test_registration_reuses_existing_registry(provider):
    registry = ProviderRegistry()
    assert isinstance(registry.get("mmaudio"), MMAudioProvider)
    assert [p.id for p in registry.all()].count("mmaudio") == 1
    assert {p.id for p in registry.all()} == {"mmaudio", "ace-step", "stable-audio", "clap", "umbra-procedural"}


def test_readme_or_wrong_checkpoint_does_not_make_provider_ready(provider, monkeypatch):
    local = models.model_root()
    local.mkdir(parents=True)
    (local / "README.md").write_text("not weights")
    (local / "mmaudio_large_44k.pth").write_bytes(b"not the small model")
    monkeypatch.setattr(model_manager, "package_installed", lambda _: True)
    status = provider.status()
    assert status.installed and not status.ready and not status.capabilities
    assert status.model is None
    assert status.to_json()["commercialSafe"] is False
    assert status.to_json()["weightsLicense"] == "CC BY-NC 4.0"
    assert "--mmaudio" in status.install_hint


def test_complete_install_declares_caps_but_not_verification(ready):
    status = ready.status()
    assert status.ready
    assert status.model == "mmaudio_small_44k.pth"
    assert status.experimental and status.commercial_safe is False
    assert Capability.VIDEO_CONDITIONED in status.capabilities
    assert Capability.DURATION_CONTROL in status.capabilities
    assert Capability.CONTINUATION not in status.capabilities
    assert Capability.MUSIC_GENERATION not in status.capabilities
    assert "runtimeVerified" not in status.to_json()
    models.verify_files(models.model_root())
    # Same size, wrong hash: detected before model loading.
    (models.model_root() / models.CHECKPOINT).write_bytes(b"z")
    with pytest.raises(ValueError, match="checksum mismatch"):
        models.verify_files(models.model_root())


def test_auxiliary_cache_ref_is_required_even_when_weights_exist(ready):
    repo = next(iter(models.AUXILIARIES))
    (models.cache_repo(models.model_root(), repo) / "refs/main").unlink()
    assert not ready.status().ready


def test_setup_downloads_only_small_inference_assets(provider, tiny_assets, monkeypatch, tmp_path, capsys):
    calls = []

    def snapshot(**kwargs):
        calls.append(kwargs)
        if kwargs["repo_id"] == models.REPO:
            root = Path(kwargs["local_dir"])
            for name in models.WEIGHTS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x")
        else:
            root = Path(kwargs["cache_dir"]).parent
            aux = models.AUXILIARIES[kwargs["repo_id"]]
            for name in aux["files"]:
                path = models.cache_repo(root, kwargs["repo_id"]) / "snapshots" / aux["revision"] / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x")

    monkeypatch.setattr(setup_models, "_require_hf", lambda: snapshot)
    custom = tmp_path / "custom models"
    monkeypatch.setattr(sys, "argv", ["setup_models.py", "--mmaudio", "--dir", str(custom)])
    assert setup_models.main() == 0
    local = models.model_root(custom)
    assert not models.missing_files(local)
    assert calls[0]["revision"] == models.REVISION
    assert set(calls[0]["allow_patterns"]) == {*models.WEIGHTS, "README.md"}
    for call in calls:
        assert call["revision"] != "main"
        assert all("large" not in name and "optimizer" not in name and "*" not in name
                   for name in call["allow_patterns"])
    assert len(calls) == 3
    assert str(custom) in capsys.readouterr().out
    report = model_manager.model_report(custom)
    assert report.to_json()["checkpointsRoot"] == str(custom)
    assert report.checkpoints[-1].present


@pytest.mark.parametrize("flag", ["--all", "--core"])
def test_default_setups_never_opt_into_mmaudio(flag, provider, monkeypatch):
    monkeypatch.setattr(setup_models, "install_ace_step", lambda *a, **kw: 0)
    monkeypatch.setattr(setup_models, "install_simple", lambda *a: 0)
    forbidden = Mock(side_effect=AssertionError("MMAudio must be explicitly selected"))
    monkeypatch.setattr(setup_models, "install_mmaudio", forbidden)
    monkeypatch.setattr(setup_models, "show_list", lambda _: None)
    monkeypatch.setattr(sys, "argv", ["setup_models.py", flag])
    assert setup_models.main() == 0
    forbidden.assert_not_called()


def test_checkpoint_root_respects_env_and_is_not_cwd_relative(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("UMBRA_CHECKPOINTS", "~/external-models")
    assert models.model_root() == tmp_path / "external-models/mmaudio"
    monkeypatch.delenv("UMBRA_CHECKPOINTS")
    monkeypatch.delenv("ACESTEP_CHECKPOINT_DIR", raising=False)
    monkeypatch.chdir(tmp_path)
    assert model_manager.checkpoints_root() == Path(model_manager.__file__).resolve().parents[2] / "checkpoints"


def test_all_mmaudio_storage_is_gitignored_even_with_dir_override():
    paths = ["checkpoints/mmaudio/weights/mmaudio_small_44k.pth",
             "models/mmaudio/hf-cache/file.bin", "custom/mmaudio/hf-cache/file.bin"]
    for path in paths:
        assert subprocess.run(["git", "check-ignore", "-q", path]).returncode == 0


@pytest.mark.parametrize("snake", [False, True])
def test_request_normalization_uses_exact_video_range(provider, gen_request, snake):
    payload = {"provider": "mmaudio", "prompt": "", "duration": 999, "seed": "0",
               "videoPath": gen_request.video_path, "videoStart": "18.417", "videoEnd": "20.75",
               "timelineStart": 99, "commercialSafe": False, "allowNoncommercial": True,
               "advanced": {"inference_steps": "30", "guidance_scale": "4.5"}}
    if snake:
        for a, b in [("videoPath", "video_path"), ("videoStart", "video_start"), ("videoEnd", "video_end"),
                     ("commercialSafe", "commercial_safe"), ("allowNoncommercial", "allow_noncommercial")]:
            payload[b] = payload.pop(a)
    normalized = provider.validate_request(GenerationRequest.from_json(payload))
    assert normalized.video_start == normalized.timeline_start == 18.417
    assert normalized.video_end == 20.75
    assert normalized.duration == pytest.approx(2.333)
    assert normalized.prompt == "" and normalized.seed == 0
    assert normalized.advanced == {"inferenceSteps": 30, "guidanceScale": 4.5}


def test_start_plus_duration_normalizes_to_end(provider, gen_request):
    normalized = provider.validate_request(replace(gen_request, video_end=None, duration=2))
    assert normalized.video_end == pytest.approx(20.417)


@pytest.mark.parametrize("patch", [
    {"video_start": -1}, {"video_start": float("nan")}, {"video_end": float("inf")},
    {"video_end": 18.4}, {"video_end": 28}, {"video_end": 19},
    {"seed": -1}, {"seed": 2**32}, {"seed": True}, {"seed": 0.5},
    {"task": TaskType.REPAINT}, {"advanced": {"inferenceSteps": 1.5}},
    {"advanced": {"guidanceScale": float("nan")}}, {"advanced": {"model": "large_44k"}},
    {"video_path": None}, {"video_path": "blob:browser-path-is-not-a-local-file"},
])
def test_invalid_requests_fail_before_inference(provider, gen_request, patch):
    with pytest.raises(ProviderError) as error:
        provider.validate_request(replace(gen_request, **patch))
    assert error.value.http_status == 400


@pytest.mark.parametrize("safe, consent", [(True, True), (False, False), (True, False), ("false", True), (False, "true")])
def test_license_gate_cannot_be_bypassed(provider, gen_request, safe, consent):
    with pytest.raises(ProviderError) as error:
        asyncio.run(provider.generate(replace(gen_request, commercial_safe=safe, allow_noncommercial=consent)))
    assert error.value.http_status == 403
    assert provider.store.list() == []


@pytest.mark.parametrize("field, value", [("videoStart", "bad"), ("videoEnd", "nan"), ("videoStart", True),
                                         ("commercialSafe", "false"), ("allowNoncommercial", 1), ("seed", "oops"),
                                         ("seed", 1.5), ("seed", True), ("duration", "oops"), ("advanced", "bad")])
def test_json_rejects_invalid_numbers_and_truthy_license_flags(field, value):
    with pytest.raises(ProviderError) as error:
        GenerationRequest.from_json({"provider": "mmaudio", field: value})
    assert error.value.http_status == 400


def test_router_reports_blocked_match_instead_of_silent_fallback():
    text = "Create footsteps synced to this video selection"
    blocked = route_intent(text, has_video_selection=True, available=["mmaudio"])
    assert blocked.provider == "mmaudio" and blocked.blocked
    assert "blocked" in blocked.reason and "CC BY-NC" in blocked.reason
    consented = route_intent(text, has_video_selection=True, commercial_safe=False, allow_noncommercial=True)
    assert consented.provider == "mmaudio" and not consented.blocked


def test_missing_models_fail_with_setup_hint(provider, gen_request):
    with pytest.raises(ProviderError) as error:
        asyncio.run(provider.generate(gen_request))
    assert error.value.http_status == 503
    assert "--mmaudio" in error.value.hint
    assert provider.store.list() == []


@pytest.fixture
def mocked_inference(ready, monkeypatch):
    monkeypatch.setattr(adapter, "probe_video", lambda _: VideoInfo(available=True, duration=40, video_codec="h264"))

    def cut(source, target, start, end, *, with_audio):
        assert start == 18.417 and end == 20.75 and with_audio is False
        target.write_bytes(b"selected video only")
        return ExtractResult(ok=True, start=start, end=end, duration=end - start)

    async def infer(selection, output, gen_request):
        assert selection.read_bytes() == b"selected video only"
        # A real decodable file, but emphatically NOT real model inference.
        samples = np.sin(np.arange(round(2.25 * 44100)) * 0.02) * 0.1
        sf.write(output, samples, 44100, subtype="PCM_24")
        return {"device": "cpu", "codeVersion": "mock", "commercialSafe": True}

    monkeypatch.setattr(adapter, "extract_range", cut)
    monkeypatch.setattr(ready, "_infer", AsyncMock(side_effect=infer))
    return ready


def test_video_range_result_measured_timing_and_provenance(mocked_inference, gen_request):
    result = asyncio.run(mocked_inference.generate(gen_request))
    assert result.provider == "mmaudio" and result.duration == 2.25 and result.sample_rate == 44100
    m = result.metadata
    assert m["sourceVideoStart"] == m["timelineStart"] == 18.417
    assert m["sourceVideoEnd"] == 20.75 and m["generatedDuration"] == 2.25
    assert m["prompt"] == gen_request.prompt and m["seed"] == 0
    assert m["model"] == "mmaudio_small_44k.pth" and m["modelVersion"] == "small_44k"
    assert m["modelRevision"] == models.REVISION and m["codeVersion"] == "mock"
    assert m["licenseClass"] == "CC_BY_NC" and m["codeLicense"] == "MIT"
    assert m["commercialSafe"] is False  # cannot be overwritten by inference metadata
    assert m["sourceUrl"] and m["creditLine"] and len(m["auxiliaryModels"]) == 2
    restored = AudioStore(mocked_inference.store.root).get(result.audio_id)
    assert restored.metadata == m
    assert not list(mocked_inference.store.root.glob("mmaudio-*"))  # scratch cleaned


def test_random_seed_is_resolved_and_retained(mocked_inference, gen_request):
    result = asyncio.run(mocked_inference.generate(replace(gen_request, seed=None)))
    assert isinstance(result.metadata["seed"], int)
    assert 0 <= result.metadata["seed"] < 2**32
    assert mocked_inference._infer.call_args.args[2].seed == result.metadata["seed"]


@pytest.mark.parametrize("failure", ["inference", "invalid-wav", "beyond-end"])
def test_failures_never_register_filler(mocked_inference, gen_request, monkeypatch, failure):
    async def bad(selection, output, req):
        if failure == "inference":
            raise RuntimeError("out of memory")
        output.write_bytes(b"not WAV")
        return {}
    if failure == "beyond-end":
        monkeypatch.setattr(adapter, "probe_video", lambda _: VideoInfo(available=True, duration=19, video_codec="h264"))
    else:
        monkeypatch.setattr(mocked_inference, "_infer", bad)
    with pytest.raises(ProviderError):
        asyncio.run(mocked_inference.generate(gen_request))
    assert mocked_inference.store.list() == []


def test_existing_api_jobs_and_audio_manifest(mocked_inference, gen_request, monkeypatch):
    from backend.app import app

    with TestClient(app) as client:
        monkeypatch.setattr(app.state.registry, "_providers", {"mmaudio": mocked_inference})
        monkeypatch.setattr(app.state, "store", mocked_inference.store)
        # Denied before queueing, even if the provider is installed.
        denied = client.post("/api/generate", json={"provider": "mmaudio", "allowNoncommercial": True})
        assert denied.status_code == 403 and not app.state.jobs.list()
        payload = {"provider": "mmaudio", "videoPath": gen_request.video_path, "videoStart": 18.417,
                   "videoEnd": 20.75, "timelineStart": 99, "commercialSafe": False, "allowNoncommercial": True}
        submitted = client.post("/api/generate", json=payload)
        assert submitted.status_code == 200
        job = submitted.json()["job"]
        assert job["timelineStart"] == 18.417
        for _ in range(100):
            job = client.get(f"/api/jobs/{job['jobId']}").json()["job"]
            if job["state"] in {"succeeded", "failed"}:
                break
            time.sleep(0.01)
        assert job["state"] == "succeeded" and job["result"]["duration"] == 2.25
        url = job["result"]["url"]
        assert client.get(url).content.startswith(b"RIFF")
        manifest = client.get(url + "?metadata=1")
        assert "attachment" in manifest.headers["content-disposition"]
        assert manifest.json()["metadata"]["license"] == "CC BY-NC 4.0"
        assert manifest.json()["metadata"]["sourceVideoStart"] == 18.417


@pytest.mark.parametrize("detected, mps_works, expected", [("cuda", False, "cuda"), ("mps", True, "mps"),
                                                         ("mps", False, "cpu"), ("cpu", False, "cpu")])
def test_device_selection_uses_existing_detection(monkeypatch, detected, mps_works, expected):
    from backend.providers import mmaudio_runtime as runtime

    torch = Mock()
    if not mps_works:
        torch.Generator.side_effect = RuntimeError("unsupported native generator")
    monkeypatch.setattr(runtime, "preferred_device", lambda: DeviceInfo(detected, detected, True))
    device, note = select_device(torch)
    assert device == expected
    if detected == "mps" and not mps_works:
        assert "CPU float32" in note


def test_inference_child_has_private_offline_cache(ready, gen_request, tmp_path, monkeypatch):
    output = tmp_path / "out.wav"
    output.with_suffix(".json").write_text('{"device":"cpu"}')
    process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"", None)))
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    result = asyncio.run(ready._infer(Path(gen_request.video_path), output, gen_request))
    args, kwargs = spawn.call_args
    assert args[:3] == (sys.executable, "-m", "backend.providers.mmaudio_runtime")
    assert kwargs["env"]["HF_HUB_OFFLINE"] == "1"
    assert kwargs["env"]["HF_HUB_CACHE"] == str(models.model_root() / "hf-cache")
    assert "--variant" not in args and result["device"] == "cpu"


def test_real_tiny_mp4_range_and_upload_without_model(tmp_path, monkeypatch):
    if not all(toolchain_status()[p]["available"] for p in ("ffmpeg", "ffprobe")):
        pytest.skip("ffmpeg/ffprobe unavailable; no model inference involved")
    from backend.app import app

    video = tmp_path / "tiny.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
                    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True, timeout=30)
    selected = tmp_path / "cut.mp4"
    assert extract_range(video, selected, 0.4, 2.4, with_audio=False).ok
    info = probe_video(selected)
    assert info.duration == pytest.approx(2, abs=0.05) and not info.has_audio
    with TestClient(app) as client:
        monkeypatch.setattr(app.state, "store", AudioStore(tmp_path / "runtime/audio"))
        response = client.post("/api/analysis/video/upload", files={"file": ("tiny.mp4", video.read_bytes(), "video/mp4")})
        assert response.status_code == 200
        uploaded = Path(response.json()["video"]["path"])
        assert uploaded.parent == tmp_path / "runtime/video"
        assert uploaded.read_bytes() == video.read_bytes()
        bad = client.post("/api/analysis/video/upload", files={"file": ("fake.mp4", b"bad", "video/mp4")})
        assert bad.status_code == 400
        assert list(uploaded.parent.iterdir()) == [uploaded]


def test_setup_download_failure_does_not_claim_success(provider, monkeypatch, capsys):
    download = Mock(side_effect=OSError("offline"))
    monkeypatch.setattr(setup_models, "_require_hf", lambda: download)
    assert setup_models.install_mmaudio(model_manager.checkpoints_root()) == 1
    assert "FAILED" in capsys.readouterr().err
    assert models.missing_files(models.model_root())


def test_inference_timeout_kills_child_without_registering_audio(ready, gen_request, tmp_path, monkeypatch):
    async def hang():
        await asyncio.sleep(60)

    process = SimpleNamespace(returncode=None, communicate=hang, kill=Mock(), wait=AsyncMock())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    monkeypatch.setattr(adapter, "RUNTIME_TIMEOUT", 0.01)
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(ready._infer(Path(gen_request.video_path), tmp_path / "out.wav", gen_request))
    process.kill.assert_called_once()
    process.wait.assert_awaited_once()
    assert ready.store.list() == []
