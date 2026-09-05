# Setup

## Frontend only (complete workstation, no models)

```bash
npm install
npm run dev
```

Open the printed URL. Procedural synthesis, timeline, mixing, export, and the
library cache all work. The Models view shows trained providers as
"not installed" with setup hints — that is the honest state, not an error.

## Hybrid mode (with the inference backend)

Requires Python **3.11 or 3.12** (ACE-Step pins `>=3.11,<3.13`).

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py     # 127.0.0.1:8000; Vite proxies /api here
```

`backend/requirements.txt` intentionally installs only the *service*
(FastAPI, audio decoding, hub client). Heavy model stacks are split:

```bash
.venv/bin/pip install -r backend/requirements-ace-step.txt
.venv/bin/pip install -r backend/requirements-extras.txt   # Stable Audio, CLAP, PySceneDetect
```

## Model weights (never committed)

```bash
python scripts/setup_models.py --list          # what's installed, what devices exist
python scripts/setup_models.py --core          # ACE-Step + CLAP
python scripts/setup_models.py --ace-step
python scripts/setup_models.py --stable-audio  # gated: needs HF_TOKEN + licence acceptance
python scripts/setup_models.py --xclip         # X-CLIP semantic video analysis (~1.58 GB)
```

Weights land in `checkpoints/` (git-ignored). `ffmpeg` is an optional
external binary (not a pip package) enabling video metadata/thumbnails.

## Configuration

Only one variable, only when the backend is not on the default port/host:

```bash
cp .env.example .env   # then edit VITE_UMBRA_BACKEND if needed
```

Freesound tokens are entered in-app (Library → Settings) and stored in local
IndexedDB — never in files, never committed. `python
scripts/verify_environment.py [--json]` reports real packages, devices, and
checkpoints, then tells you the next useful command.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Models view all "not installed" | Backend not running, or deps/weights missing — run `verify_environment.py` |
| Backend 404 on `/api/*` from UI | Use the Vite dev server URL, not `:8000` directly; browser must use relative `/api` |
| Python version errors | `python3 --version` must be 3.11/3.12 |
| Video features unavailable | `ffmpeg`/`ffprobe` on PATH? (`/api/analysis/toolchain`) |
| Freesound search inert | Token set in Library → Settings? License policy excluding the result class? |
