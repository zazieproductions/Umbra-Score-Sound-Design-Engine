# UMBRA·SCORE

**A horror composer's integrated generative and retrieval sound-design workstation.**

Not "AI studio in a browser". Umbra combines procedural synthesis, pretrained
generative models, **curated library retrieval**, video understanding and —
above all — human editing, on one timeline that renders to a real 24-bit /
48 kHz master.

> "Score it like a Hollywood mix. Frame by frame."

Two things are true at once, and most tools pick only one:

- **A trained model is the wrong instrument for a timed 40 Hz sub swell.**
  You want that frame-accurate, deterministic, instantly re-renderable. That
  is synthesis.
- **Synthesis is the wrong instrument for a slow, unstable bowed cluster.**
  You want a model that has heard thousands of hours of strings.
- **Generation is the wrong instrument for a door-handle rattle at 00:18.4.**
  You want retrieval: find, audition, and place a real recording with
  provenance and license intact.

So Umbra is **multi-provider and multi-source**. Every source — synthesized,
generated, or retrieved — becomes the same object: an editable clip on the
same timeline, through the same master chain, into the same exported WAV.

## Architecture

```
VIDEO + USER DIRECTION ──► SCENE / SPOTTING ──► PROVIDER ROUTING ──┬──► PROCEDURAL (browser Web Audio)
                                                                    ├──► TRAINED MODELS (local Python)
                                                                    └──► LIBRARY (Freesound / user, licensed)
                                              ──► AUDIOCLIP ──► TIMELINE ──► MIX ──► EXPORT (-16 LUFS, 24-bit WAV)
```

- **Browser** (`src/`): UI, timeline, transport, clip editing, Web Audio
  playback, procedural synthesis, mixing, DSP, metering, offline render.
- **Python backend** (`backend/`): model loading, inference, CLAP embeddings,
  scene detection, audio file store, generation jobs, video preprocessing.
- The browser talks to its own origin only — Vite proxies `/api` to the
  backend. Heavy ML never enters the browser; latents never leave Python.

Full map: [`docs/architecture/OVERVIEW.md`](docs/architecture/OVERVIEW.md) ·
boundaries: [`docs/architecture/`](docs/architecture/) · decisions:
[`docs/decisions/`](docs/decisions/).

## Quick start

Frontend only — a complete workstation (procedural + library cache, no models):

```bash
npm install
npm run dev
```

Hybrid mode — with the local inference backend (Python 3.11/3.12):

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py
```

Models (weights are never committed; fetched from official sources):

```bash
python scripts/setup_models.py --list
python scripts/setup_models.py --core
python scripts/setup_models.py --xclip   # optional semantic video analysis (~1.58 GB)
```

Setup details, troubleshooting: [`docs/development/SETUP.md`](docs/development/SETUP.md).

## Providers

| Provider | Role | Runs |
| --- | --- | --- |
| **Umbra Procedural** | 17 synthesis classes — subs, drones, risers, stingers, impacts. Deterministic, instant | Browser (always available) |
| **ACE-Step 1.5** | Musical score: tonal beds, texture, continuation, repaint | Local Python |
| **Stable Audio Open** | Physical/environmental sound | Local Python |
| **MMAudio** | Foley synchronised to picture | Local Python |
| **CLAP** | Semantic search over *your* library (embeddings, not generation) | Local Python |
| **X-CLIP** | Semantic *video* interpretation: WHAT a pixel-detected event likely represents (advisory to retrieval) | Local Python (optional) |
| **Library retrieval** | Freesound + user library, ranked, license-gated, provenance-kept | Browser + IndexedDB |

Routing boundaries, capability honesty, and the status ladder
(`NOT INSTALLED` → … → `RUNTIME VERIFIED`):
[`docs/architecture/PROVIDERS.md`](docs/architecture/PROVIDERS.md).

## Implementation / runtime status

| Area | Status |
| --- | --- |
| Procedural engine, timeline, unified clips, mix + offline render | ✅ working |
| Library retrieval (ranking, license/provenance, credits) | ✅ 25/25 frontend tests (mocked HTTP) |
| Backend registry, audio store, jobs, analysis + X-CLIP layer | ✅ 91 backend tests, no downloads |
| ACE-Step / Stable Audio / MMAudio / CLAP inference | ✅ plumbed — `RUNTIME VERIFIED` only on a machine with weights + deps (not yet in this environment) |
| X-CLIP semantic video analysis | ✅ plumbed + mock-tested — NOT runtime-verified here (no torch/weights/ffmpeg); see [`docs/development/XCLIP.md`](docs/development/XCLIP.md) |

Live status briefing: [`docs/ai/CURRENT_STATE.md`](docs/ai/CURRENT_STATE.md).
What mocked tests do and do not prove: [`docs/development/TESTING.md`](docs/development/TESTING.md).

## Repository map

```
/ ── README · AGENTS.md · CONTRIBUTING.md · THIRD_PARTY_*.md
├── src/          browser app (engines in lib/, views in components/)
├── backend/      local ML service (app · providers · analysis · services)
├── tests/        frontend tests (retrieval acceptance + architecture invariants)
├── scripts/      run_backend · setup_models · verify_environment
├── docs/         architecture · development · decisions · ai · personalization
└── .github/      CI + PR/issue templates
```

## Testing

```bash
npm run verify                        # typecheck + lint + unit tests
npm run build                         # production build
python -m pytest backend/tests -q     # backend, no model downloads
```

## For AI agents

**Read [`AGENTS.md`](AGENTS.md) first** — the binding operational contract
(identity, invariants, parallel-work protocol, done-means). Then
[`docs/ai/CURRENT_STATE.md`](docs/ai/CURRENT_STATE.md).

## License / model caveat

Software licences: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
Model weight licences + gating:
[`THIRD_PARTY_MODELS.md`](THIRD_PARTY_MODELS.md) — a permissive code licence
does not extend to checkpoints; re-check terms before commercial use.
Reference/training audio stays on your machine and is never committed.
