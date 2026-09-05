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
```

Weights land in `checkpoints/` (git-ignored). `ffmpeg` is an optional
external binary (not a pip package) enabling video metadata/thumbnails.

## Configuration

```bash
cp .env.example .env
```

`.env` holds local, git-ignored settings — most importantly the Freesound API
key, which the **backend** uses (the browser never sees it):

```dotenv
FREESOUND_API_KEY=your-freesound-client-secret   # freesound.org/apiv2/apply
VITE_UMBRA_BACKEND=http://127.0.0.1:8000         # only if the backend is elsewhere
```

> Never commit `.env` or any real credential, and never put a secret in a
> `VITE_` variable — those are inlined into the browser bundle.

Full walkthrough (create the key, start both servers, verify the connection,
honest failure modes): [`FREESOUND.md`](FREESOUND.md).

`python scripts/verify_environment.py [--json]` reports real packages, devices,
and checkpoints, then tells you the next useful command.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Models view all "not installed" | Backend not running, or deps/weights missing — run `verify_environment.py` |
| Backend 404 on `/api/*` from UI | Use the Vite dev server URL, not `:8000` directly; browser must use relative `/api` |
| Python version errors | `python3 --version` must be 3.11/3.12 |
| Video features unavailable | `ffmpeg`/`ffprobe` on PATH? (`/api/analysis/toolchain`) |
| Freesound search inert | Backend running? `GET /api/integrations/freesound/status` — key configured/connected? License policy excluding the result class? See [`FREESOUND.md`](FREESOUND.md) |
