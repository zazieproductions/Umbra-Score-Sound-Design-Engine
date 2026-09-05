# UMBRA·SCORE

**Hybrid Procedural + Generative Audio Workstation**

A cinematic score and sound design engine combining:

1. **UMBRA PROCEDURAL** — Deterministic browser-based synthesis
2. **Pretrained Generative Models** — Optional neural audio generation

> "Score it like a Hollywood mix. Frame by frame. Now with AI-powered sound generation."

---

## Architecture Overview

```
VIDEO / USER PROMPT
        ↓
UMBRA ANALYSIS + SPOTTING (PySceneDetect)
        ↓
PROVIDER ROUTER
        ↓
┌────────────────────┐
│ UMBRA PROCEDURAL   │  ← Deterministic DSP (browser)
└────────────────────┘
┌────────────────────┐
│ Stable Audio Open  │  ← Text → audio (optional)
└────────────────────┘
┌────────────────────┐
│ MMAudio            │  ← Video → audio (optional)
└────────────────────┘
┌────────────────────┐
│ CLAP               │  ← Semantic search (optional)
└────────────────────┘
        ↓
REAL AUDIO FILES / BUFFERS
        ↓
UMBRA AUDIO CLIPS
        ↓
TIMELINE
        ↓
HUMAN EDITING
        ↓
UMBRA DSP / MIX
        ↓
WAV EXPORT
```

---

## Two Audio Engines

### UMBRA PROCEDURAL (Built-in)

The original deterministic synthesis engine running entirely in the browser via Web Audio API.

**Characteristics:**
- Instant generation (no inference wait)
- Fully deterministic (same seed = same output)
- Zero model downloads
- Works offline
- GPU-agnostic

**Supported layers:**
- Drone Bed, Sub Pressure, Ambience, Whisper Texture
- String Section, Choir Pad, Braam, Brass Stab
- Heart Pulse, Tension Tick, Taiko / Percussion
- Riser, Downlifter, Whoosh Pass
- Foley, Stinger, Impact

### Pretrained Generative Models (Optional)

ML-powered audio generation requires the Python backend.

| Provider | Input | Output | Model Size |
|----------|-------|--------|------------|
| **Stable Audio Open** | Text prompt | Audio file | ~1.5 GB |
| **MMAudio** | Video + optional prompt | Synchronized audio | ~2 GB |
| **CLAP** | Text query | Similarity ranking | ~1 GB |

---

## Quick Start

### Frontend Only (Procedural Engine)

```bash
npm install
npm run dev
```

Open http://localhost:5173

### With ML Backend (Hybrid Mode)

```bash
# Terminal 1: Frontend
npm install
npm run dev

# Terminal 2: Python Backend
cd backend
pip install -r requirements.txt  # or: python scripts/setup_models.py --core
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### Installing ML Models

```bash
# Install all ML dependencies
python backend/scripts/setup_models.py --all

# Or install individually
python backend/scripts/setup_models.py --stable-audio
python backend/scripts/setup_models.py --mmaudio
python backend/scripts/setup_models.py --clap
python backend/scripts/setup_models.py --pyscenedetect
```

---

## Frontend Project Structure

```
src/
├── lib/
│   ├── types.ts        # Layer kinds, scenes, project model
│   ├── dsp.ts          # Master bus, channel strips, reverbs
│   ├── voices.ts       # Per-layer synthesis (17 classes)
│   ├── generate.ts     # Scene/key planning, layer generation
│   ├── render.ts       # Offline render + loudness/limiter
│   ├── audio.ts        # Realtime monitoring engine
│   └── useStudio.ts    # React state, transport, export
├── components/         # UI components
└── App.tsx            # Main application
```

## Backend Project Structure

```
backend/
├── app.py              # FastAPI application
├── providers/
│   ├── base.py         # Abstract provider interface
│   ├── registry.py     # Provider registration system
│   ├── procedural_bridge.py  # UMBRA procedural metadata
│   ├── stable_audio.py       # Stable Audio Open integration
│   ├── mmaudio.py            # MMAudio integration
│   ├── clap.py               # CLAP semantic search
│   └── pyscenedetect.py      # Scene detection
├── analysis/
│   ├── scenes.py       # Scene detection wrapper
│   ├── video.py        # Video analysis utilities
│   └── waveform.py     # Waveform generation
├── services/
│   ├── model_manager.py   # Model downloads, caching
│   ├── audio_store.py     # Generated audio storage
│   └── jobs.py            # Job tracking
├── schemas/
│   ├── providers.py    # Provider schemas
│   ├── generation.py   # Generation request/response
│   └── analysis.py     # Scene detection schemas
└── scripts/
    ├── setup_models.py    # Model installation
    └── verify_environment.py  # Environment check
```

---

## API Endpoints

### Health & Status
- `GET /health` — Health check
- `GET /api/providers` — List providers
- `GET /api/system/device` — GPU/CPU detection

### Audio Generation
- `POST /api/generate` — Generate audio
- `GET /api/audio/{id}` — Get audio metadata
- `GET /api/audio/{id}/download` — Download audio file
- `GET /api/audio/{id}/waveform` — Get waveform peaks

### Semantic Search
- `POST /api/search` — Search audio by text
- `POST /api/index` — Add audio to search index

### Scene Detection
- `POST /api/scenes/detect` — Detect video scenes

### Jobs
- `GET /api/jobs` — List jobs
- `GET /api/jobs/{id}` — Get job status
- `POST /api/jobs/{id}/cancel` — Cancel job

---

## Hardware Requirements

| Mode | Minimum | Recommended |
|------|---------|-------------|
| Procedural Only | Any modern browser | Chrome/Firefox/Safari |
| With ML Backend | 8GB RAM, CPU | 16GB RAM, NVIDIA GPU or Apple Silicon |

### GPU Support

The backend automatically detects available hardware:

1. **NVIDIA CUDA** — Full acceleration
2. **Apple MPS** — Metal GPU (M1/M2/M3)
3. **CPU** — Fallback (slower)

---

## License & Third-Party Models

See:
- [THIRD_PARTY_MODELS.md](THIRD_PARTY_MODELS.md) — Integrated model documentation
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) — License details
- [docs/FINE_TUNING.md](docs/FINE_TUNING.md) — Future fine-tuning guide

**Important:** This project is for personal, experimental, noncommercial use. Always verify that your use case complies with the licenses of integrated models.

---

## Development

```bash
# Frontend
npm install
npm run dev        # Development
npm run build     # Production build
npm run lint      # Linting
npm test          # Sound-library retrieval acceptance tests (mocked Freesound API)

# Backend
cd backend
pip install -r requirements.txt
python -m uvicorn app:app --reload

# Verify environment
python scripts/verify_environment.py
```

---

## What's New in v0.2

- **Hybrid Architecture** — Procedural synthesis + ML models
- **Stable Audio Open** — Text-to-audio generation
- **MMAudio** — Video-conditioned audio
- **CLAP** — Semantic audio search
- **PySceneDetect** — Real video scene detection
- **Python Backend** — FastAPI for ML inference
- **Provider System** — Pluggable audio generation providers

---

## Known Limitations

- ML models require separate installation
- GPU acceleration depends on hardware availability
- Some providers may have different capabilities than described
- Fine-tuning is not yet implemented

---

## Contributing

This is an experimental project. Contributions are welcome but should maintain:

1. The procedural engine as a first-class citizen
2. Real audio output (no simulated/fake audio)
3. Honest capability reporting
4. License compliance
