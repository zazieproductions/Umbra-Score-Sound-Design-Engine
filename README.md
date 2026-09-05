# UMBRA·SCORE

**A horror composer's integrated generative sound-design workstation.**

Not "ACE Studio in a browser". Umbra combines procedural synthesis, pretrained generative
models, video understanding and — above all — human editing, on one timeline that renders to a
real 24-bit / 48 kHz master.

> "Score it like a Hollywood mix. Frame by frame."

---

## The idea

Two things are true at once, and most tools pick only one:

- **A trained model is the wrong instrument for a timed 40 Hz sub swell.** You want that
  frame-accurate, deterministic and instantly re-renderable. That is synthesis.
- **Synthesis is the wrong instrument for a slow, unstable bowed cluster with real orchestral
  behaviour.** You want a model that has heard thousands of hours of strings.

So Umbra is **multi-provider**. Every provider produces the same kind of object — an editable
clip on the same timeline, through the same master chain, into the same exported WAV.

| Provider | Role | Runs |
| --- | --- | --- |
| **Umbra Procedural** | 17 synthesis classes: sub pressure, drones, clusters, risers, stingers, impacts, foley. Deterministic, frame-accurate, instant | In the browser (Web Audio) |
| **ACE-Step 1.5** | Musical scoring: tonal beds, orchestral/synthetic texture, continuation, repaint, reference-conditioned generation | Local Python service |
| **Stable Audio Open** | Physical and environmental sound: ventilation, water, wind, debris | Local Python service |
| **MMAudio / FoleyCrafter** | Foley synchronised to picture | Local Python service |
| **CLAP** | "Find something like this in my library" — semantic search over *your* audio | Local Python service |

**Umbra Procedural is first class and always available.** With the Python service switched off,
the app still works completely: analysis, synthesis, mixing, metering, offline render, export.
The trained providers simply report themselves as unavailable — honestly, with the command
needed to install them.

### What ACE-Step is *not* used for

It scores. It does not author foley, footsteps, door sounds or room tone, and it never generates
a whole soundtrack unattended. That is a deliberate boundary, not a limitation of the install.

---

## Architecture

```
┌─ Browser (React 19 · Vite 7 · TypeScript · Web Audio) ──────────────┐
│  UI · timeline · clip editing · transport · realtime synthesis      │
│  mixing · ducking · metering · offline render · WAV export          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  /api  (proxied by Vite in dev)
┌──────────────────────────▼──────────────────────────────────────────┐
│  Local Python service (FastAPI · Uvicorn, single worker)            │
│  model loading · inference · embeddings · scene analysis            │
│  job queue · audio store                                            │
└─────────────────────────────────────────────────────────────────────┘
```

The split is strict:

- **No heavyweight Python inference logic in TypeScript.** ACE-Step is PyTorch; it does not
  belong in a browser.
- **No latent tensors leak into the frontend.** The VAE and latent space are an internal detail
  of the provider. The frontend receives audio files and metadata, nothing else.
- **No native plugin layer.** No VST3, no JUCE, no C++, no GGUF. This is a browser app with a
  local ML backend, and that is the whole target.

### Backend layout

```
backend/
  app.py                    FastAPI application, all /api routes
  providers/
    base.py                 Provider protocol, capability enum, results
    registry.py             discovery, status reporting, routing
    ace_step.py             ACE-Step 1.5 (in-process or via its API server)
    stable_audio.py         Stable Audio Open
    mmaudio.py              video-conditioned foley
    clap.py                 text↔audio embeddings and search
    prompting.py            horror-first prompt construction
  analysis/
    scenes.py               shot detection (PySceneDetect) + music planner
    spotting.py             horror-first prompt construction
    embeddings.py           embedding index for library search
    video.py                ffprobe metadata, thumbnails, range extraction
    waveform.py             peak extraction, RMS/peak/crest measurement
  services/
    audio_store.py          content-addressed local audio store
    model_manager.py        checkpoint discovery, package probing
    generation_jobs.py      async job queue with cancellation
    device.py               real device detection (CUDA / MPS / CPU)
  tests/                    42 tests, no model downloads required
```

### Frontend layout

```
src/lib/
  types.ts          layer kinds, scenes, project, AudioClip + ClipMetadata
  dsp.ts            master bus, channel strips, convolvers, ducking
  voices.ts         per-layer synthesis graphs (17 classes)
  generate.ts       scene/key planning and procedural layer generation
  clips.ts          clip engine: decode cache, scheduling, move/trim/split
  proceduralClip.ts offline bounce of a procedural cue into a clip
  render.ts         offline render + BS.1770 / true-peak post master
  audio.ts          realtime monitoring engine
  providers.ts      typed backend client
  useGeneration.ts  provider status, job tracking, generation → clip
  useStudio.ts      state, transport, clip editing, export orchestration
src/components/     viewer · timeline · clip lanes · scoring panel ·
                    clip inspector · model manager · mixer · exports
```

---

## Running it

### Frontend only (procedural engine, no models)

```bash
npm install
npm run dev
```

Everything except the trained providers works. This is a complete workstation on its own.

### With the inference backend

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py          # http://127.0.0.1:8000
```

Vite proxies `/api` to that service, so the browser never talks to Python directly and the app
works unchanged behind a remote preview.

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
.venv/bin/python -m pytest backend/tests -q     # 57 tests

python scripts/verify_environment.py            # what's installed, what hardware exists
python scripts/verify_environment.py --json     # same, machine-readable
```

`verify_environment.py` is the fastest way to find out why a provider is showing as
unavailable. It reports real packages, real devices and real checkpoints, then prints the next
useful command.

---

## Scoring workflow

1. **Load a reel.** Umbra analyses it into scenes — tension, motion, sync hits — and assigns
   each a musical key.
2. **Mark a range** on the timeline (shift-drag the ruler), or just position the playhead.
3. **Choose a generator** in the Score panel. Only genuinely available providers are selectable.
4. **Write direction, not parameters:** *"sparse low-register dissonant score, slow spectral
   movement, no drums, no heroic resolution."*
5. **Set the musical frame:** key, mode, BPM, time signature, duration, seed.
6. **Generate.** The clip lands on the timeline at your range.
7. **Edit it like anything else:** move, trim, split, fade, gain, pan, mute, solo, delete.
8. **Export.** The bounced master contains exactly that audio.

Expert controls — inference steps, guidance scale, reference strength — live behind
**Advanced**. They are not in your way while you are writing.

### Horror-first prompting

Umbra rewrites composer shorthand into model conditioning and always applies a negative
direction. Ask for *"slow unstable bowed texture"* and the backend expands it, adds phrasing
hints appropriate to the tempo, and suppresses pop song structure, heroic trailer harmony,
triumphant resolution, EDM drops and radio-clean mixes. The Score panel shows you the exact
prompt and negative prompt before you commit.

### The music planner

Structured musical intent is **Umbra's** creative layer, not the model's. Before generation it
produces a plan — key, tempo, density, dread and tension values, and a timestamped structure:

```
0.0s   near silence
3.2s   introduce low strings
7.8s   spectral instability
12.0s  remove bass
15.5s  unresolved swell
19.0s  cut to silence
```

The model realises that plan. It does not invent it.

### Continuation

Select a musical clip → **Continue** → choose a length → generate. The continuation is placed
immediately after its source and inherits key, tempo, prompt and character, so the two read as
one cue rather than two takes.

### Repaint

Mark a range inside a generated clip → **Repaint selection**. Only that span is regenerated;
the material before and after is preserved.

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

Musical clips route to `musicSum`, so hits duck them and they sit *inside* the mix. Foley and
SFX clips route to `hitSum`, preserving their transients. **This is the same graph in the
realtime monitor and in the offline bounce**, which is what makes the exported master match what
you heard.

Every render then runs a post master:

1. **ITU-R BS.1770 loudness measurement** (K-weighting, 400 ms blocks, absolute + relative
   gating) → conformed to **-16 LUFS**.
2. **Lookahead true-peak limiting** (5 ms sliding-window max, instant attack, smooth release) →
   **-1 dBTP** ceiling.
3. 24-bit PCM encode (TPDF-dithered).

Theatrical moves that survive from the original engine: hit ducking, sub-harmonic LFE with
rectified octave reinforcement and a resonant 46 Hz shelf, procedural stereo impulse responses
with decorrelated tails, a reverse-bloom convolver, and a tension macro riding the whole mix
with equal-power scene crossfades.

### The 17 procedural layer classes

| Family | Layers |
| --- | --- |
| Beds | Drone Bed · Sub Pressure · Ambience · Whisper Texture |
| Orchestra | String Section · Choir Pad · Braam · Brass Stab |
| Rhythm / Tension | Heart Pulse · Tension Tick · Taiko / Percussion |
| Transitions | Riser · Downlifter · Whoosh Pass |
| Detail | Foley · Stinger · Impact |

Pitched layers resolve to a shared scene key, so strings, choir, brass and braams occupy the
same harmonic space as generated cues.

---

## Model manager

The **Models** view reports only what is actually true on your machine: install state per
provider, the resolved checkpoint and its size on disk, detected devices with the preferred one
marked, PyTorch version, and the checkpoint directory. Capabilities are listed only when the
*installed* version genuinely declares support for them — Umbra will not advertise repaint or
continuation because a different build of ACE-Step has it.

There are no cloud regions, no GPU utilisation gauges, no credit counters, and no invented
hardware anywhere in the interface.

---

## Privacy

- Reference audio you supply stays on your machine.
- Personalization material lives in `training/user_audio/` and is git-ignored.
- No datasets ship with Umbra. No scraping. No telemetry. No uploads.

---

## Documentation

- [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) — software licences, verified upstream
- [`THIRD_PARTY_MODELS.md`](./THIRD_PARTY_MODELS.md) — model weight licences and gating
- [`docs/PERSONALIZATION.md`](./docs/PERSONALIZATION.md) — LoRA/adapter architecture and the
  data rules for training on your own cues

---

## Status

| Phase | |
| --- | --- |
| P1 · Procedural engine preserved, Python backend created and verified | ✅ |
| P2 · Real ACE-Step inference | ⬜ needs a machine that can run it |
| P3 · Generated audio on the Umbra timeline | ✅ |
| P4 · Key / BPM / duration / seed conditioning | ✅ plumbed, pending P2 verification |
| P5 · Continuation and reference conditioning | ✅ plumbed, pending P2 verification |
| P6 · Repaint | ✅ plumbed, pending P2 verification |
| P7 · LoRA personalization | ⬜ design documented only |

**ACE-Step integration is not claimed as complete.** The package installing, the backend
starting, a provider appearing or a request returning JSON prove nothing. The only definition of
done is the full acceptance test: enter a horror prompt in D minor at 44 BPM for 12 seconds,
press Generate, get real inference producing a real audio file, see that exact audio on the
timeline, play it in sync with the film, move it, trim it, export it — and find it in the
exported master. That requires hardware capable of running the model.
