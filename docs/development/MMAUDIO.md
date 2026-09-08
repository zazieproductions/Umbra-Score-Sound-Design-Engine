# MMAudio — EXPERIMENTAL · NONCOMMERCIAL

MMAudio generates sound conditioned on video frames and an optional text
sound description. It can suggest picture-synchronized Foley/ambience; it
is not guaranteed to identify every action or produce accurate Foley. Listen
against picture and edit the result like any other clip.

This adapter calls the **official** [hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio)
package, targeting commit `974010a026c731054592d8f777218bd9d85a6c24`.
Only **`small_44k` / `mmaudio_small_44k.pth`** is supported in this first pass.
There is no large-model default or automatic upgrade.

## Licensing — read before installing

- MMAudio **code is MIT**; its [released checkpoints](https://huggingface.co/hkchengrex/MMAudio/blob/main/README.md)
  are **[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)**,
  for **noncommercial use only**. MIT does not make the checkpoints commercial-safe.
- The generator picker, Models view, and clip inspector label it
  **EXPERIMENTAL · NONCOMMERCIAL**, even when offline.
- Umbra reuses **Library Licensing** policy: `strict` / portable blocks
  MMAudio; `personal` or a custom policy accepting `CC_BY_NC` permits an
  explicit noncommercial opt-in. Permission in the policy alone is **not**
  consent: check the acknowledgment in the Score panel too.
- The API defaults to `commercialSafe: true` and
  `allowNoncommercial: false`. Both must be explicitly changed to run MMAudio.
  Validation happens before queueing and again inside the provider.
- The intent router may explain that MMAudio matches a request, but returns
  `blocked: true` when licensing forbids it. It neither generates nor
  silently substitutes another engine. MMAudio is never the UI's automatic
  fallback provider.

The required Apple CLIP and NVIDIA BigVGAN assets retain their own terms
(`apple-amlr` and MIT respectively); this does not relax MMAudio's restriction.

## Install (optional; Python 3.11/3.12)

Activate the same environment used by the existing Umbra backend. Install
`ffmpeg` **and** `ffprobe` using your OS package manager. First install mutually
compatible **torch, torchvision and torchaudio** builds for your hardware
following [PyTorch's instructions](https://pytorch.org/get-started/locally/)
(upstream requires torch ≥2.5.1). Then:

```bash
pip install -r backend/requirements.txt -r backend/requirements-mmaudio.txt
python scripts/setup_models.py --mmaudio
python scripts/setup_models.py --list
python scripts/run_backend.py
```

`--mmaudio` downloads weights, not Python packages, consistent with the other
model setup commands. It prints the noncommercial restriction. Neither
`--core` nor `--all` includes MMAudio: explicitly request it.

### Storage

The small flow checkpoint is **~0.63 GB / 601 MiB**. It is **not** the entire
runtime: VAE (~1.22 GB), Synchformer (~0.95 GB), Apple CLIP (~3.95 GB), and the
44.1 kHz BigVGAN generator (~0.49 GB) bring required weights to **~7.24 GB
(~6.74 GiB)**. Allow additional space for Python/PyTorch and temporary downloads.
No local RAM/VRAM minimum has been benchmarked by this integration.

```
checkpoints/mmaudio/                 # gitignored, never commit
  weights/mmaudio_small_44k.pth
  ext_weights/v1-44.pth
  ext_weights/synchformer_state_dict.pth
  hf-cache/                         # pinned CLIP + BigVGAN inference files only
```

Default root is the repository's `checkpoints/`, independent of shell cwd.
Use `UMBRA_CHECKPOINTS=/absolute/storage/checkpoints` for both setup and the
backend, or `--dir /absolute/storage/checkpoints` for setup **and the same
`UMBRA_CHECKPOINTS` when starting the backend**. The existing
`ACESTEP_CHECKPOINT_DIR` fallback is also honored. A `mmaudio/` directory is
ignored even under a custom in-repo `--dir`; `.pth`/`.pt` are ignored too.
Never commit pretrained weights, auxiliary `.bin` caches, or user media.

Setup uses exact allowlists and pinned official HF revisions: **no large,
medium, 16 kHz, optimizer, training checkpoint, or duplicate CLIP weights**.
Sizes and SHA-256 hashes are checked at setup and before inference. An
arbitrary nonempty folder/README/Git LFS pointer does not count as installed.

## Use on the existing timeline

1. Import a local video into the normal Umbra project.
2. Enable a noncommercial-compatible policy in **Library Licensing**.
3. Shift-drag the existing timeline ruler to mark **1–8 seconds**.
4. In **Score**, explicitly select **MMAudio**, acknowledge noncommercial use,
   optionally enter a sound description, and Generate. An empty description
   means video-only conditioning; the music prompt builder is bypassed.
5. The source video is copied **once, on demand**, to this same local backend
   (upload limit 2 GiB; no cloud service). `extract_range(..., with_audio=False)`
   hands the model only the selected range, not the whole reel or its audio.
6. The generated **44.1 kHz PCM WAV** goes through the existing AudioStore,
   job polling, browser decode, `AudioClip`, playback and master/export graph.
   Its initial clip start equals the **source video in-point**, not the
   playhead or the end of the generation job. There is no second timeline.

Longer, reversed, non-finite, too-short or out-of-video selections are refused,
not silently clamped. This is an intentional initial 1–8 s adapter limit,
not a claim about every duration upstream supports. Model latent padding is
trimmed, never stretched or padded with filler. Video preprocessing can
shorten the result by up to one CLIP sampling interval (125 ms); generated
length is measured from WAV frames and preserved separately from the request.

Clips remain movable, trimmable, splittable, fadeable and exportable. MMAudio
has no repaint/continuation here; select the video range in Score for a new
take. Local video copies are in `.umbra/video/` beside the audio store and can
be removed manually when no longer needed. Existing audio clips still play
if their source video is removed; new video generations then fail honestly.

### API (same `/api/generate`, `/api/jobs`, `/api/audio`)

```json
{
  "provider": "mmaudio",
  "videoPath": "/absolute/local/film.mp4",
  "videoStart": 18.417,
  "videoEnd": 20.75,
  "prompt": "metal door closes",
  "seed": 42,
  "commercialSafe": false,
  "allowNoncommercial": true
}
```

Alternatively use `videoStart` + `duration`. CamelCase and snake_case video
fields are accepted. Explicit `videoEnd` is the duration authority;
`timelineStart` is normalized to `videoStart`. File paths refer to the
**backend machine**, never a browser `blob:` URL. Browser upload uses
`POST /api/analysis/video/upload`. Like existing local-path analysis routes,
these endpoints are for a trusted local workstation, not a public file service.

## Runtime and failure behavior

- Reuses `services/device.py`: **CUDA first**, bfloat16 when supported,
  otherwise float32. No `torch.compile` or CUDA-only BigVGAN extension.
- **MPS** is attempted only when detected and a native float32 random-generator
  probe works; otherwise an explicit device note records CPU fallback.
  No implicit unsupported-MPS-operation fallback is enabled. Later model
  operation errors fail the job, rather than pretending MPS was supported.
- **CPU float32** is a best-effort fallback, potentially slow/memory-heavy.
  Failed imports, missing files, failed kernels, OOM/child death, invalid WAVs
  and the 14-minute inference timeout are visible failures, not fake audio.
- A short-lived child belongs to **MMAudioProvider within the existing job
  queue**. It releases torch memory after each request and isolates upstream
  cache/environment behavior. It is not a new service, queue, or generation
  system. All imports are optional/lazy. No weights download during inference:
  the child has a private HF cache and offline mode, and never calls upstream's
  `download_if_needed()` or large-default demo CLI.

## Provenance and export

Clip metadata retains provider, source path/in/out, actual generated duration,
prompt/negative prompt, resolved seed (including randomly chosen seeds),
checkpoint filename/variant/revision/SHA-256, installed code version/revision
(when discoverable), auxiliary model revisions/licenses, device/dtype, credit
line, and MIT-code vs CC-BY-NC-checkpoint provenance. Edits do not rewrite
source timing. Project save/load retains it.

`delivery_manifest.json` and cue sheets expose the checkpoint restriction;
noncommercial deliveries **always include documentation**, even with a
master-only/no-docs preset. Strict/portable delivery blocks these clips;
“force export” cannot override the license gate. Single bounces and Source
downloads include a `.provenance.json` sidecar. Keep sidecars/manifests with
shared WAVs (allow multiple downloads if your browser asks). The library's
retrieved-asset ledger is not misused to invent a recording/asset for MMAudio.

For generated clips, the `license` fields describe the **checkpoint-use
restriction/provenance**, not a blanket legal assertion about copyright in
every generated waveform. Prompts and local source paths travel in the
manifest; review them before sharing.

## Manual real-runtime verification (not CI)

Make a tiny local MP4, or use your own short film excerpt:

```bash
ffmpeg -f lavfi -i "testsrc2=size=96x64:rate=25" -t 3 -c:v libx264 -pix_fmt yuv420p fixtures/runtime/mmaudio_tiny.mp4
```

With the existing backend running, the **one verification command** is:

```bash
python scripts/verify_mmaudio.py --video fixtures/runtime/mmaudio_tiny.mp4 --start 0.4 --duration 2 --seed 42 --allow-noncommercial
```

Add `--prompt "a short mechanical rattle"` to test text+video. The script
submits the existing API job, fetches and decodes its WAV, checks timing,
model/license/seed provenance and non-silence, and only then prints
`RUNTIME VERIFIED`. Evidence + WAV go to gitignored `.umbra/verification/`.
This command does **not** insert a clip into an open browser session.
For full product verification, also generate through Score, listen against
picture, move/trim the clip, and inspect an exported manifest and audible WAV.

### What was actually verified here (2026-09-05)

- **Model inference: NOT runtime-verified.** No MMAudio/PyTorch runtime or
  pretrained weights installed/downloaded. CUDA and MPS were not exercised.
- Unit/contract tests: registry, exact model/setup paths and allowlists,
  normalization, license gating, range timing, real-WAV store/job/manifest
  plumbing with **mocked inference**, edits/persistence/export provenance.
- Real ffmpeg tiny-MP4 range extraction and upload/rejection were tested with
  a temporary local ffmpeg/ffprobe toolchain. That is **not** model inference.
- Live Vite → backend checks passed: provider discovery, local tiny-MP4 upload,
  commercial-safe request → HTTP 403, consented request with missing model →
  HTTP 503 and no queued/fabricated generation. The manual verifier was run
  and exited 1 with that missing-install error; it made **no runtime claim**.
- Frontend typecheck/lint/tests and production build pass. Tests must never
  upgrade this status; only real video-to-audio evidence may do that.

Run lightweight tests with `python -m pytest backend/tests/test_mmaudio.py -q`
and `npm test -- tests/mmaudio.test.ts`. ffmpeg-only tests skip when missing;
CI never downloads weights or runs model inference.

### Pre-PR recheck (2026-09-07)

Rebased on main `285b012`, retaining the newer transport fixes and server-side
Freesound integration. Typecheck/lint/build pass; frontend 165 passed / 6
skipped; backend 154 passed / 2 skipped with ffmpeg (153 / 3 without).
The live API checks and the expected missing-install verifier failure were
repeated. **Model inference remains NOT runtime-verified.**

Actual browser captures: [Models card](images/mmaudio-provider.png) and
[Score picker](images/mmaudio-score.png). These show the real **not installed**
state, noncommercial labels and unavailable generator; no ready status or
successful model generation was simulated for the screenshots.

## Upgrade / remove

Provider logic lives in `providers/mmaudio.py` + its private
`mmaudio_runtime.py`; the small pinned asset contract is
`services/mmaudio_models.py`. Audit upstream APIs/licenses before changing
those pins and the optional requirements file, then rerun the manual test.
Remove `checkpoints/mmaudio/` and uninstall the optional package to disable
new MMAudio generation. Existing canonical WAV clips remain editable; their
noncommercial provenance must remain intact even after removing the model.
