# X-CLIP semantic video analysis

An **optional local semantic video-analysis layer** that answers a different
question from Umbra's pixel motion detector.

| | |
| --- | --- |
| What it does | Given a *meaningful* video window (a pixel-detected event), returns which of a bounded Umbra sound-design vocabulary the window **most likely** represents — e.g. footsteps, door opening, object impact, machinery. |
| Model ID | `microsoft/xclip-base-patch32` |
| Code / weights licence | **MIT** (the Hugging Face model card reports `license: mit`; re-check before commercial use) |
| Approx. download | ~1.58 GB (8 frames per window at 224×224) |
| Runs | Locally in the Python backend via Hugging Face Transformers |
| Requirement | `torch` + `transformers` + `Pillow` + `ffmpeg` binary |

## Why it exists

Umbra's existing pixel detector is honest but answers only **WHEN**:
a transient burst at 18.4 s, a gait-like cadence, a sustained motion segment.
X-CLIP adds the complementary **WHAT**: the same bounded window is embedded
and compared against a small list of Umbra sound-design labels, producing a
ranked set of candidates with similarity / confidence.

The two are combined, never replaced:

```
pixel analysis  ->  WHEN something happens (existing detector)
X-CLIP          ->  WHAT the window probably represents (this layer)
```

## Install

```bash
# dependencies (imports are genuinely probed by the backend)
.venv/bin/pip install -r backend/requirements-ace-step.txt   # torch + transformers etc
.venv/bin/pip install -r backend/requirements-extras.txt      # Pillow + others

# weights (never committed; fetched into git-ignored checkpoints/)
.venv/bin/python scripts/setup_models.py --xclip
```

`ffmpeg` must be on `PATH` for frame sampling.

## Where things live

| Path | Purpose |
| --- | --- |
| `checkpoints/xclip-base-patch32/` | Model weights, git-ignored |
| `models/cache/xclip/` | JSON analysis result cache, git-ignored |
| `models/cache/xclip-frames/` | Sampled window JPEGs (scratch), git-ignored |

Both `checkpoints/` and `models/` are excluded from Git. Override the
checkpoint directory with `--dir` or `UMBRA_CHECKPOINTS`.

## How to verify it (real inference)

```bash
.venv/bin/python scripts/verify_xclip.py /path/to/small.mp4 --at 2.5 --seconds 1.5
```

The script returns exit 0 and prints `RUNTIME VERIFIED` only after real
X-CLIP inference processed frames and produced candidates. Weights on disk
alone never sets that; the backend status (`/api/analysis/xclip/status`,
Models view) similarly only reports `runtimeVerified` after a real inference.

## API

- `GET /api/analysis/xclip/status` — honest model/status metadata.
- `POST /api/analysis/xclip` with `{ path, events, windowSeconds, topK, frames }`
  — attaches `semantic` / `semanticQuery` to each existing event object.
- `POST /api/analysis/events` accepts `includeSemantics: true` to run pixel
  analysis and X-CLIP enrichment in one call (X-CLIP is still opt-in).

## Integration

The resulting semantic candidates feed Umbra's existing retrieval pipeline
(the same `SoundEventCandidate` → `RetrievalIntent` → license gate/ranking →
CLAP rerank → `AudioClip` path). X-CLIP is advisory: it can refine the query
and role, but the user and the pixel timeline remain authoritative.

## Limitations

- **Probabilistic, not guaranteed.** X-CLIP is a zero-shot contrastive video
  classifier. It produces a *likely interpretation* of the window, not a
  reliable object/action detector. A "door opening" candidate means the
  window resembles that label to the model — it is not proof a door was
  opened.
- **Bounded vocabulary.** Umbra only interprets windows against the labels in
  `backend/analysis/xclip.py`. It is intentionally small and centralized; a
  real unseen event falls back to `MISC_FOLEY` / `other` rather than a made-up
  category.
- **Only meaningful windows.** X-CLIP never analyses every frame or arbitrary
  spans. It runs on event windows produced by the existing pixel detector.
- **Local and optional.** No weights are committed. Without torch /
  transformers / weights / ffmpeg, the layer reports `available: false` with
  the install hint and never fabricates labels.
- **No guarantee of download licence.** MIT is reported from the model card;
  always re-check third-party model terms before commercial use.
