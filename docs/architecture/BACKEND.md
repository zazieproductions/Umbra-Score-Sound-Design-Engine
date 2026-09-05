# Backend (local Python ML service)

FastAPI · single-worker Uvicorn · Python 3.11/3.12. Owns everything the
browser must not do: trained-model inference, model loading, device probing,
CLAP embeddings, scene detection, audio file storage, generation jobs, video
preprocessing. Run with `python scripts/run_backend.py` (or
`python -m uvicorn backend.app:app --port 8000`).

## Module ownership (`backend/`)

| Path | Owns | Does not own |
| --- | --- | --- |
| `app.py` | All `/api` routes, request/response schemas, lifespan (registry + store + job manager). Thin routing layer — no inference logic here. | Model internals |
| `providers/base.py` | **Canonical backend domain types**: `Capability`, `ProviderRole`, `TaskType`, `GenerationRequest`, `GenerationResult`, `ProviderStatus`, `ProviderError`. The contract every provider implements. | Any specific model |
| `providers/registry.py` | Provider discovery, honest status aggregation, and `route_intent` — a transparent keyword/geometry scorer that explains *why* a request routes somewhere. | Inference |
| `providers/ace_step.py` | ACE-Step 1.5 musical scoring (server or local mode, task allow-listing per checkpoint family). | Foley, SFX, search |
| `providers/stable_audio.py` | Stable Audio Open: physical/environmental sound. Validates repo, pipeline, sample rate, device, seed, duration. | Music |
| `providers/mmaudio.py` | MMAudio: video-conditioned Foley. Real inference or `UNAVAILABLE` — never a stub result. | Anything non-video |
| `providers/clap.py` | CLAP embeddings + semantic search. Advertises `SEMANTIC_SEARCH`/`EMBEDDINGS` **only** — generation capabilities are forbidden (pinned by tests). | Audio generation |
| `providers/umbra_procedural.py` | Descriptor only: tells the registry/Models view that procedural rendering happens in the browser. The Python service never renders it. | Rendering |
| `analysis/scenes.py` | Real cut detection (PySceneDetect when installed, else `available:false`) + deterministic horror-scoring planner. | Inference |
| `analysis/spotting.py` | Horror-first prompt translation + negative direction. Deterministic and inspectable — the composer sees the exact conditioning. | Model calls |
| `analysis/video.py` | ffprobe metadata, thumbnails, range extraction. Missing ffmpeg degrades to honest "not installed". | Analysis semantics |
| `analysis/waveform.py` | Peaks + measured RMS/peak/crest for files the browser hasn't decoded. Never invents numbers. | Playback |
| `analysis/embeddings.py` | Facade over the CLAP provider for search routes. Latent tensors stop here — never reach the frontend. | Generation |
| `services/audio_store.py` | Content-addressed audio store. **Enforces the real-result contract**: nothing registers without being decoded first, so duration/rate/channels are measured, never claimed. | Inference |
| `services/device.py` | Real device detection (CUDA/MPS/CPU via actual probes). Returns `None` when unknown — the UI shows nothing rather than a plausible number. | Anything else |
| `services/generation_jobs.py` | Async job queue with cancellation. `succeeded` is reachable only with decoded audio on disk. | Routing |
| `services/model_manager.py` | Checkpoint discovery (size on disk), package probing, Models-view report. Only reports what exists. | Downloads (see `scripts/setup_models.py`) |
| `tests/` | 57 tests: real-audio contract, capability honesty, payload mapping, routing. No model downloads. | — |

## API map (`app.py`)

| Area | Routes |
| --- | --- |
| Health / models | `GET /api/health`, `GET /api/providers`, `GET /api/models` |
| Planning | `POST /api/plan/scene`, `POST /api/plan/project`, `POST /api/prompt/build`, `GET /api/prompt/presets`, `POST /api/route` |
| Generation | `POST /api/generate` → `GET /api/jobs[/{id}]` → `POST /api/jobs/{id}/cancel` |
| Audio | `GET /api/audio[/{id}]`, `DELETE /api/audio/{id}`, `POST /api/audio/upload`, `GET /api/audio/{id}/peaks`, `GET /api/audio/{id}/features` |
| Search / analysis | `POST /api/search` (CLAP, local files only), `POST /api/analysis/cuts`, `POST /api/analysis/video`, `GET /api/analysis/toolchain` |

## Rules for changing the backend

1. New model? New file in `providers/` implementing `AudioProvider`, registered
   in `registry.py` — see `../development/ADDING_A_PROVIDER.md`.
2. Capabilities are re-derived at runtime from the *installed* version, never
   hard-coded wish lists. Unavailable providers declare **no** capabilities.
3. Every generation result goes through `audio_store` decoding. No path may
   return success without a real file.
4. New route? Thin handler in `app.py` delegating to a provider/analysis/
   service module. No inference logic in route functions.
5. Device/hardware facts come from `services/device.py` probes only.
