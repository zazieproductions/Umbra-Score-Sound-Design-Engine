# UMBRA·SCORE

**A horror composer's integrated generative and retrieval sound-design workstation.**

Not "AI Studio in a browser". Umbra combines procedural synthesis, pretrained generative
models, **curated library retrieval**, video understanding and — above all — human editing,
on one timeline that renders to a real 24-bit / 48 kHz master.

> "Score it like a Hollywood mix. Frame by frame."

---

## The idea

Two things are true at once, and most tools pick only one:

- **A trained model is the wrong instrument for a timed 40 Hz sub swell.** You want that
  frame-accurate, deterministic and instantly re-renderable. That is synthesis.
- **Synthesis is the wrong instrument for a slow, unstable bowed cluster with real orchestral
  behaviour.** You want a model that has heard thousands of hours of strings.
- **Generation is the wrong instrument for a specific door handle rattle at 00:18.4.** You want
  retrieval: find, audition, and place a real recording with provenance and license intact.

So Umbra is **multi-provider and multi-source**. Every source — whether synthesized, generated,
or retrieved — produces the same kind of object — an editable clip on the same timeline,
through the same master chain, into the same exported WAV.

| Provider / Source | Role | Runs |
| --- | --- | --- |
| **Umbra Procedural** | 17 synthesis classes: sub pressure, drones, clusters, risers, stingers, impacts, foley. Deterministic, frame-accurate, instant | In the browser (Web Audio) |
| **ACE-Step 1.5** | Musical scoring: tonal beds, orchestral/synthetic texture, continuation, repaint, reference-conditioned generation | Local Python service |
| **Stable Audio Open** | Physical and environmental sound: ventilation, water, wind, debris | Local Python service |
| **MMAudio** | Foley synchronised to picture (video → audio) | Local Python service |
| **CLAP** | "Find something like this in my library" — semantic search over *your* audio (embeddings, not generation) | Local Python service |
| **Library Retrieval** | Freesound.org, your indexed user library, Pixabay-assisted term expansion — ranked, gated by license, provenance-attributed, CLAP-reranked when available | Browser (RetrievalService) + IndexedDB cache + optional CLAP rerank via Python |

**Umbra Procedural is first class and always available.** The trained providers simply report
themselves as unavailable — honestly, with the command needed to install them — until their
weights and dependencies genuinely exist. Library retrieval is mocked in tests and works offline
against IndexedDB when the Freesound token is not set.

### What ACE-Step is *not* used for

It scores. It does not author foley, footsteps, door sounds or room tone, and it never generates
a whole soundtrack unattended. That is a deliberate boundary, not a limitation of the install.
Retrieval owns foley; generation owns music beds.

---

## Architecture

```
┌─ Browser (React 19 · Vite 7 · TypeScript · Web Audio) ──────────────────┐
│  UI · timeline · clip lanes · scoring panel · library view ·            │
│  clip inspector · model manager · mixing · ducking · metering ·          │
│  offline render · WAV export · retrieval planner · IndexedDB cache       │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │  /api  (proxied by Vite in dev — no CORS / no localhost in UI)
┌──────────────────────────▼──────────────────────────────────────────────┐
│  Local Python service (FastAPI · Uvicorn, single worker)                │
│  model loading · inference (ACE-Step / Stable Audio / MMAudio) ·        │
│  CLAP embeddings · scene analysis (PySceneDetect) · waveform features · │
│  job queue · audio store (real file probing, not trust-caller duration) │
└─────────────────────────────────────────────────────────────────────────┘
```

The split is strict:

- **No heavyweight Python inference logic in TypeScript.** ACE-Step is PyTorch; it does not
  belong in a browser.
- **No latent tensors leak into the frontend.** The VAE and latent space are an internal detail
  of the provider. The frontend receives audio files and metadata, nothing else.
- **No fabricated hardware.** No `gpu 87%`, no `eu-north-1b`, no invented A100 shards. `GET /api/health`
  returns the *real* `torch` / `cuda` / `mps` / `cpu` state the Python process sees. The UI renders
  only what the backend actually reports.
- **No native plugin layer.** No VST3, no JUCE, no C++, no GGUF. Browser + local ML backend is the whole target.

### Backend layout

```
backend/
  app.py                    FastAPI application — all /api routes, unified schemas
  providers/
    base.py                 Provider protocol, GenerationRequest, capability enum, ProviderStatus
    registry.py             discovery, honest status, routing (route_intent with real signals)
    ace_step.py             ACE-Step 1.5 — honest NOT INSTALLED / MODEL AVAILABLE / RUNTIME VERIFIED
    stable_audio.py         Stable Audio Open — validates repo/pipeline/sr/resample/device/MPS/CUDA/seed
    mmaudio.py              video-conditioned foley — real inference or UNAVAILABLE, not stub
    clap.py                 CLAP embeddings — honest embedder, never pretends to generate
    umbra_procedural.py     browser procedural (always installed/ready)
  analysis/
    scenes.py               PySceneDetect when installed, otherwise available=false (no fake cuts)
    spotting.py             horror-first prompt/planner construction
    embeddings.py           CLAP index for library search
    video.py                ffprobe metadata, thumbnails, range extraction
    waveform.py             peak extraction, RMS/peak/crest on real decoded bytes
  services/
    audio_store.py          content-addressed store — re-measures duration, rejects non-audio
    model_manager.py        checkpoint discovery, package probing
    generation_jobs.py      async job queue with cancellation
    device.py               real device detection (CUDA / MPS / CPU) — never faked
  tests/                    57 backend tests + 19 library retrieval tests — no model downloads
  scripts/
    run_backend.py          single-worker launch
    setup_models.py         fetch official checkpoints only
    verify_environment.py   real packages / devices / checkpoints → next command
```

### Frontend layout

```
src/lib/
  types.ts              AudioClip + ClipMetadata (unified — generative + library share one type)
  dsp.ts                master bus, channel strips, convolvers, ducking
  voices.ts             per-layer synthesis graphs (17 classes — umbra-voices-17)
  generate.ts           scene/key planning — no fake model names
  clips.ts              clip engine: decode cache, scheduling, move/trim/split
  render.ts             offline renderer — scheduleClips via same master chain as monitor
  audio.ts              realtime monitoring engine — ScoreEngine with clipBuffers / prepareClip / syncClips
  providers.ts          typed backend client (/api/*)
  useGeneration.ts      provider status polling, job tracking, generation → AudioClip
  useStudio.ts          state, transport, clip editing, export orchestration + library wiring
  library/              SoundRetrievalPlanner, ranking, CLAP rerank, Freesound/Pixabay/user-library,
                        IndexedDB soundCache + provenance, license gating, credits export
src/components/
  Viewer · ScenesView · Timeline · ClipLane · RightPanel (Mix/Score/Export) ·
  ScoringPanel · ClipInspector (unified move/trim/fade/gain/pan/replace/provenance) ·
  LibraryView · SoundLibrarySettings · ModelsView · Meter
```

---

## Running it

### Frontend only (procedural + library cache, no models)

```bash
npm install
npm run dev
```

Everything except the trained providers works. This is a complete workstation on its own.
The Models view will show ACE-Step / Stable Audio / MMAudio / CLAP as "not installed" with setup hints.

### With the inference backend

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py          # http://127.0.0.1:8000 — Vite proxies /api here
```

Or directly:

```bash
python -m uvicorn backend.app:app --port 8000
```

Vite proxies `/api` to that service, so the browser never talks to Python directly and the app
works unchanged behind a remote preview (`*.e2b.app`).

### Installing models

No weights are committed to this repository. Fetch them from their official sources:

```bash
python scripts/setup_models.py --list          # what's installed, what devices exist
python scripts/setup_models.py --core          # ACE-Step + CLAP
python scripts/setup_models.py --ace-step      # ACE-Step 1.5 only
python scripts/setup_models.py --stable-audio  # gated: needs HF_TOKEN + licence acceptance
```

ACE-Step's runtime dependencies (torch, transformers, diffusers…) are separate on purpose:

```bash
.venv/bin/pip install -r backend/requirements-ace-step.txt
.venv/bin/pip install -r backend/requirements-extras.txt   # Stable Audio, CLAP, PySceneDetect
```

Requires Python **3.11 or 3.12** (ACE-Step pins `>=3.11,<3.13`). Device selection is real:
CUDA, Apple MPS/MLX, or CPU, detected via PyTorch. Umbra never displays hardware it cannot see.

`ffmpeg` is optional but recommended — it is an external binary, not a Python package, and it
enables video metadata, thumbnails and handing a video-conditioned provider just the span you
selected. Without it those features report themselves unavailable rather than guessing.

### Scripts

```bash
npm run dev      # dev server with HMR and the /api proxy
npm run build    # tsc -b && vite build
npm run lint     # eslint
npm test         # 19 library retrieval tests (mocked Freesound, fake-indexedDB) — vitest
.venv/bin/python -m pytest backend/tests -q     # 57 backend tests — no downloads
python scripts/verify_environment.py            # what's installed, what hardware exists
python scripts/verify_environment.py --json     # machine-readable
```

`verify_environment.py` is the fastest way to find out why a provider is showing as
unavailable.

---

## Scoring workflow (generative)

1. **Load a reel.** Umbra analyses it into scenes — tension, motion, sync hits — and assigns each a musical key.
2. **Mark a range** on the timeline (shift-drag the ruler), or just position the playhead.
3. **Choose a generator** in the Score panel (ScoringPanel). Only genuinely available providers are selectable.
4. **Write direction, not parameters:** *"sparse low-register dissonant score, slow spectral movement, no drums, no heroic resolution."*
5. **Set the musical frame:** key, mode, BPM, time signature, duration, seed. Or let the planner fill them.
6. **Generate.** The clip lands on the timeline at your range as a real `AudioClip` — move/trim/split/fade/gain/pan/mute/solo like any other.
7. **Continue or Repaint:** select a musical clip → Continue (next cue) or mark a sub-range → Repaint selection (only that span changes).
8. **Export.** The bounced master contains exactly that audio, through the same master chain.

Expert controls — inference steps, guidance scale, reference strength — live behind **Advanced**.

### Horror-first prompting & the music planner

Umbra rewrites composer shorthand into model conditioning and always applies a negative direction. Ask for *"slow unstable bowed texture"* and the backend expands it, adds phrasing hints appropriate to the tempo, and suppresses pop song structure, heroic trailer harmony, triumphant resolution, EDM drops and radio-clean mixes. The Score panel shows you the exact prompt and negative prompt before you commit.

Structured musical intent is **Umbra's** creative layer, not the model's. Before generation it produces a plan — key, tempo, density, dread and tension values, and a timestamped structure:

```
0.0s   near silence
3.2s   introduce low strings
7.8s   spectral instability
12.0s  remove bass
15.5s  unresolved swell
19.0s  cut to silence
```

The model realises that plan. It does not invent it. The planner is deterministic: same scene always plans the same.

---

## Library retrieval workflow (non-generative)

1. **Configure Freesound** in Library / Settings (token stored in local IndexedDB via `credsStore`, never committed). Set the license policy — only results whose `LicenseClass` you accepted are shown.
2. **Search** from the Library view (`RetrievalService.search`) or **Auto Sound Design** (`lib.autoDesign`) which builds intents from the scene graph + any `SpottingEvent`s (e.g. DOOR OPEN @ 00:18.4). Pixabay term expansion and user-library index are included automatically.
3. **Candidates are ranked** by `ranking.ts` and optionally **CLAP-reranked** when the CLAP provider is installed; otherwise text ranking is honest about it.
4. **Audition** a candidate (preview blob decoded via Web Audio), then **Use** it — it is cached in `soundCache` (IndexedDB), provenance recorded in `provenanceStore`, and placed on the timeline as an `AudioClip` (`provider: 'library'` or `'user'`, with `cacheKey`, `asset`, `transform`, `license`, `match`, `familyId`).
5. **Edit like any clip:** move/trim/split/fade/gain/pan/mute/solo. Use **Find alternative** to rerun the same intent and swap source while keeping fades/processing.
6. **Credits:** `exportCredits` → `sound_credits.txt` / `sound_credits.json` from provenance, auditable for festival delivery. `clearUnusedCache` removes orphaned blobs but keeps anything on `project.clips`.

Freesound: CC BY-NC and friends are supported with attribution text assembled from the API response; the backend never synthesises a fake license.

---

## The audio chain

Clips and procedural voices share one signal path:

```
voices ─┬─► channel strip (HP · bell · air · pan · Haas width)
        │      └─► sends → room / scoring stage / cathedral convolvers
        │
ACE-Step clips ──► musicSum ──► duck (hit sidechain) ─┐
SFX / foley clips ──► hitSum ─────────────────────────┤
music layers ────────► musicSum ──────────────────────┤
hit layers ──────────► hitSum ────────────────────────┤
sub layers ──────────► sub bus (LP · octave · 46 Hz res)
                                                      ▼
tension macro → glue comp → tape drive → tilt EQ → M/S widen
     → parallel exciter → brickwall → true-peak lookahead limiter
```

Musical clips route to `musicSum`, so hits duck them and they sit *inside* the mix. Foley and SFX clips route to `hitSum`, preserving their transients. **This is the same graph in the realtime monitor and in the offline bounce**, which is what makes the exported master match what you heard.

Every render then runs a post master:

1. **ITU-R BS.1770 loudness** (K-weighting, 400 ms blocks, absolute + relative gating) → conformed to **-16 LUFS**.
2. **Lookahead true-peak limiting** (5 ms window, instant attack) → **-1 dBTP** ceiling.
3. 24-bit PCM encode (TPDF-dithered).

Theatrical moves that survive from the original engine: hit ducking, sub-harmonic LFE with rectified octave reinforcement and a resonant 46 Hz shelf, procedural stereo impulse responses with decorrelated tails, a reverse-bloom convolver, and a tension macro riding the whole mix with equal-power scene crossfades.

### The 17 procedural layer classes

| Family | Layers |
| --- | --- |
| Beds | Drone Bed · Sub Pressure · Ambience · Whisper Texture |
| Orchestra | String Section · Choir Pad · Braam · Brass Stab |
| Rhythm / Tension | Heart Pulse · Tension Tick · Taiko / Percussion |
| Transitions | Riser · Downlifter · Whoosh Pass |
| Detail | Foley · Stinger · Impact |

Pitched layers resolve to a shared scene key (umbra-voices-17), so strings, choir, brass and braams occupy the same harmonic space as generated cues.

---

## Model manager

The **Models** view replaces the old Cloud view. It reports only what is actually true on your machine:

- install state per provider — `NOT INSTALLED` / `INSTALLED` / `MODEL AVAILABLE` / `LOADED` / `RUNTIME VERIFIED` / `FAILED`, never guessed
- resolved checkpoint and size on disk
- detected devices with the preferred one marked, PyTorch version, checkpoint directory
- capabilities listed only when the *installed* version genuinely declares support — Umbra will not advertise repaint or continuation because a different build of ACE-Step has it
- setup command for the next useful step

There are no cloud regions, no GPU utilisation gauges, no credit counters, and no invented hardware anywhere in the interface. If a provider is unavailable the UI explains why and what to install, with verified paths.

---

## Privacy

- Reference audio you supply stays on your machine.
- Personalization material lives in `training/user_audio/` and is git-ignored.
- No datasets ship with Umbra. No scraping. No telemetry. No uploads.
- Freesound / Pixabay tokens are stored in local IndexedDB (`credsStore`), never committed.

---

## Documentation

- [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) — software licences, verified upstream
- [`THIRD_PARTY_MODELS.md`](./THIRD_PARTY_MODELS.md) — model weight licences and gating
- [`docs/PERSONALIZATION.md`](./docs/PERSONALIZATION.md) — LoRA/adapter architecture and the data rules for training on your own cues

---

## Status

| Area | Status |
| --- | --- |
| Procedural engine (17 voices, umbra-voices-17) | ✅ preserved — browser Web Audio, always available |
| Library retrieval (Freesound + user library + Pixabay, ranking, CLAP rerank, license/provenance, credits) | ✅ — 19/19 Freesound mocked tests |
| Python backend registry / device / audio store / jobs — honest states | ✅ — 57 tests, no downloads |
| ACE-Step 1.5 as music provider (prompt→plan→payload, continuation/repaint/key/bpm gating) | ✅ plumbed — `RUNTIME VERIFIED` only on a machine with weights + torch + ffmpeg |
| Stable Audio validation (repo/pipeline/sr/resample/device/MPS/CUDA/seed/duration allowlisting) | ✅ provider validates; gated behind install |
| MMAudio (video-conditioned foley) | ✅ provider exists, returns real inference or `UNAVAILABLE` — no stub file |
| CLAP embeddings | ✅ honest embedder; never pretends to generate audio |
| PySceneDetect (real cut detection, fps from video, no 0.85 fake confidence) | ✅ when installed, else `available:false` |
| Timeline ClipLane + unified AudioClip (move/trim/split/fade/gain/pan/mute/solo/provenance) | ✅ |
| ModelsView (replaces fabricated CloudView) | ✅ |
| Master bus + offline render (BS.1770 / true-peak / 24-bit, clips baked in) | ✅ — `clipsPlaced` / `clipsFailed` reported, never hidden |
| End-to-end acceptance (prompt D minor 44 BPM 12s → real file → timeline → play sync → move/trim → master contains it) | ⬜ requires hardware with ACE-Step weights — not faked on CI |

**ACE-Step integration is not claimed as complete until the hardware acceptance above passes.** Package installing, backend starting, a provider appearing or a request returning JSON prove nothing.

---

## Development

```bash
npm install
npm run dev        # HMR + /api proxy
npm run build      # tsc -b && vite build
npm run lint       # eslint
npm test           # vitest — library retrieval
python -m pytest backend/tests -q  # 57 — backend honesty + real-audio contract
```

This repository is on `arena/01a06fb2-umbra-score-sound-design-engin`. Do not reset or force-push
`main`; keep the checkpoint tag `umbra-pre-reconcile-*`.

## Contributing

Experimental project. Contributions should maintain:

1. Procedural engine as a first-class citizen (browser Web Audio is not a fallback).
2. Real audio output — no simulated/fake audio or fabricated hardware/metrics.
3. Honest capability reporting — providers only advertise what the installed version supports.
4. Library provenance — every retrieved sound keeps provider, soundId, license, credit line and can export `sound_credits`.
5. License compliance — see THIRD_PARTY_*.
