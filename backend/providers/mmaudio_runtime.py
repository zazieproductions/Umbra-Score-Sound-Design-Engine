"""Private, one-shot inference child of MMAudioProvider (not a service).

Adapted from the official demo at mmaudio_models.CODE_REVISION. All model
math/preprocessing comes from that package. The parent sets provider-local
HF caches and offline mode BEFORE imports; upstream auto-download is never
called. This module is intentionally not imported by the registry / CI.
"""

from __future__ import annotations

import importlib.metadata
import json
import sys
import time
from dataclasses import replace
from pathlib import Path

from backend.services import mmaudio_models as models
from backend.services.device import preferred_device


def select_device(torch) -> tuple[str, str | None]:
    """Use Umbra's detector; MPS must support a native generator, not emulation."""
    detected = preferred_device().id
    if detected == "cuda":
        return "cuda", None
    if detected == "mps":
        try:
            rng = torch.Generator(device="mps").manual_seed(0)
            torch.randn(1, device="mps", dtype=torch.float32, generator=rng)
            torch.mps.synchronize()
            return "mps", None
        except (RuntimeError, NotImplementedError) as exc:
            return "cpu", f"MPS native random generator unavailable; using CPU float32: {exc}"
    return "cpu", "CUDA/MPS unavailable for MMAudio; using CPU float32 (may be slow)."


def run(config: dict) -> None:
    # Keep even direct invocations local-only, before importing any HF consumers.
    import os

    root = Path(config["models"]).resolve()
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HOME=str(root / "hf-home"), HF_HUB_CACHE=str(root / "hf-cache"),
                      HUGGINGFACE_HUB_CACHE=str(root / "hf-cache"), TORCH_HOME=str(root / "torch-cache"),
                      PYTORCH_ENABLE_MPS_FALLBACK="0")
    models.verify_files(root)

    import numpy as np
    import soundfile as sf
    import torch
    from mmaudio.eval_utils import all_model_cfg, generate, load_video
    from mmaudio.model.flow_matching import FlowMatching
    from mmaudio.model.networks import get_my_mmaudio
    from mmaudio.model.utils.features_utils import FeaturesUtils

    started = time.monotonic()
    device, device_note = select_device(torch)
    dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
    model = all_model_cfg[models.MODEL]  # explicit small_44k, NEVER upstream's large default
    seq = replace(model.seq_cfg)  # do not mutate upstream's global CONFIG_44K
    with torch.inference_mode():
        video = load_video(Path(config["video"]), config["duration"], load_all_frames=False)
        seq.duration = video.duration_sec
        net = get_my_mmaudio(model.model_name).eval()
        net.load_weights(torch.load(root / models.CHECKPOINT, map_location="cpu", weights_only=True))
        net = net.to(device=device, dtype=dtype)
        features = FeaturesUtils(
            tod_vae_ckpt=root / "ext_weights/v1-44.pth",
            synchformer_ckpt=root / "ext_weights/synchformer_state_dict.pth",
            enable_conditions=True, mode="44k", bigvgan_vocoder_ckpt=None, need_vae_encoder=False,
        ).to(device=device, dtype=dtype).eval()
        net.update_seq_lengths(seq.latent_seq_len, seq.clip_seq_len, seq.sync_seq_len)
        rng = torch.Generator(device=device).manual_seed(config["seed"])
        audios = generate(
            video.clip_frames.unsqueeze(0), video.sync_frames.unsqueeze(0), [config["prompt"]],
            negative_text=[config["negativePrompt"]], feature_utils=features, net=net,
            fm=FlowMatching(min_sigma=0, inference_mode="euler", num_steps=config["inferenceSteps"]),
            rng=rng, cfg_strength=config["guidanceScale"],
            # Small batches reduce encoder peak memory on local hardware.
            clip_batch_size_multiplier=4, sync_batch_size_multiplier=4,
        )
        audio = audios[0].float().cpu().numpy().T  # frames, channels (don't invent stereo)
        frames = round(seq.duration * seq.sampling_rate)
        if audio.ndim != 2 or frames <= 0 or audio.shape[0] < frames or not np.isfinite(audio).all():
            raise RuntimeError("MMAudio produced invalid/short/non-finite audio; no WAV written")
        # Trim only the model's latent-block tail. Never pad or stretch a failed output.
        output = Path(config["output"])
        sf.write(output, np.clip(audio[:frames], -1, 1), seq.sampling_rate, subtype="PCM_24")

    dist = importlib.metadata.distribution("mmaudio")
    direct_url = json.loads(dist.read_text("direct_url.json") or "{}")
    output.with_suffix(".json").write_text(json.dumps({
        "codeVersion": dist.version,
        "codeRevision": direct_url.get("vcs_info", {}).get("commit_id"),
        "adapterTargetRevision": models.CODE_REVISION,
        "device": device, "deviceNote": device_note, "dtype": str(dtype),
        "torchVersion": str(torch.__version__),
        "conditionedDuration": seq.duration, "inferenceSeconds": time.monotonic() - started,
    }))


if __name__ == "__main__":
    run(json.loads(Path(sys.argv[1]).read_text()))
