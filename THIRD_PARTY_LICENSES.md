# Third-party licences

Umbra·Score integrates a small number of open-source projects. This file covers **software**
(libraries, packages, source code). Model *weights* are covered separately in
[`THIRD_PARTY_MODELS.md`](./THIRD_PARTY_MODELS.md) — a permissive code licence very often
does **not** extend to the checkpoints.

Every entry below was verified against the upstream `LICENSE` file at the time of
implementation (September 2026), not from memory. Where an SPDX identifier is given, it is the
identifier GitHub resolves from the repository's own licence file.

Nothing in this list is vendored into the repository. Python packages are installed from PyPI
or from source by the user; JavaScript packages come from npm via `package.json`.

---

## Generative audio models & toolkits

| Project | Used for | Licence | Source |
| --- | --- | --- | --- |
| **ACE-Step 1.5** | Primary trained musical-scoring provider (text→music, continuation, repaint, cover/reference) | **MIT** — "Copyright (c) 2026 ACEStep" | <https://github.com/ace-step/ACE-Step-1.5> |
| **stable-audio-tools** | Reference implementation used to load Stable Audio Open for SFX/environmental generation | **MIT** | <https://github.com/Stability-AI/stable-audio-tools> |
| **MMAudio** | Video-conditioned foley generation | **MIT** | <https://github.com/hkchengrex/MMAudio> |
| **FoleyCrafter** | Alternative video-conditioned foley generation | **Apache-2.0** | <https://github.com/open-mmlab/FoleyCrafter> |
| **CLAP (LAION)** | Contrastive language–audio embeddings for library search | **CC0-1.0** (code) | <https://github.com/LAION-AI/CLAP> |
| **PySceneDetect** | Shot-boundary detection for spotting | **BSD-3-Clause** | <https://github.com/Breakthrough/PySceneDetect> |

### ACE-Step responsible-use notice

ACE-Step's own README asks users to verify the originality of generated works, disclose AI
involvement, and obtain permissions when adapting protected styles or materials. Umbra passes
that expectation on to you: generated cues are your responsibility, and Umbra never uploads or
references external copyrighted material on your behalf.

---

## Python runtime dependencies

Installed by `backend/requirements*.txt`. Only the packages Umbra actually calls are listed;
transitive dependencies carry their own licences.

| Package | Used for | Licence |
| --- | --- | --- |
| **PyTorch** (`torch`, `torchaudio`) | Model execution, device detection (CUDA / MPS / CPU) | BSD-3-Clause style (see PyTorch `LICENSE`, "From PyTorch: Copyright (c) 2016- Facebook, Inc …") |
| **Transformers** | Text encoders used inside ACE-Step | Apache-2.0 |
| **Diffusers** | Official diffusion pipeline interfaces | Apache-2.0 |
| **Accelerate** | Device placement / offload | Apache-2.0 |
| **huggingface_hub** | Checkpoint download in `scripts/setup_models.py` | Apache-2.0 |
| **FastAPI** | Local inference HTTP service | MIT |
| **Uvicorn** | ASGI server for that service | BSD-3-Clause |
| **python-multipart** | Reference-audio uploads | Apache-2.0 |
| **SoundFile** (`soundfile`) | WAV/FLAC I/O (libsndfile bindings) | BSD-3-Clause |
| **NumPy** | Audio buffers and analysis | BSD-3-Clause ("Copyright (c) 2005-2025, NumPy Developers") |
| **SciPy** | Resampling and signal helpers | BSD-3-Clause |
| **httpx** | Talking to a separately-running ACE-Step API server | BSD-3-Clause |
| **pytest** | Backend test suite | MIT |

Optional, only if you enable personalization (see `docs/PERSONALIZATION.md`):

| Package | Used for | Licence |
| --- | --- | --- |
| **PEFT** | LoRA adapters | Apache-2.0 |
| **LyCORIS** | LoHa / LoKr adapter variants | Apache-2.0 |

---

## Frontend dependencies

Declared in `package.json`, installed from npm.

| Package | Used for | Licence |
| --- | --- | --- |
| **React**, **React DOM** | UI | MIT |
| **Vite**, **@vitejs/plugin-react** | Dev server, build, `/api` proxy | MIT |
| **TypeScript** | Types | Apache-2.0 |
| **Tailwind CSS**, **@tailwindcss/vite** | Styling | MIT |
| **lucide-react** | Icons | ISC |
| **framer-motion** | Animation | MIT |
| **react-router-dom** | Routing | MIT |
| **ESLint** and plugins | Linting | MIT |

---

## What Umbra itself contributes

The procedural synthesis engine (`src/lib/voices.ts`), the master/DSP chain
(`src/lib/dsp.ts`), the offline renderer and WAV encoder (`src/lib/render.ts`), the clip engine
(`src/lib/clips.ts`), the horror prompt layer and music planner (`backend/providers/prompting.py`,
`backend/analysis/`), and the provider router are original work in this repository and carry the
repository's own licence. No ACE-Step model internals were reimplemented — Umbra calls the
official package.

## Attribution

Several of these licences require attribution when you distribute a product built on them.
MIT and BSD-3-Clause both require the copyright notice and permission text to travel with any
redistribution; Apache-2.0 additionally requires you to state significant changes. CC0-1.0
(LAION-CLAP's code) waives attribution, though crediting the authors remains good practice.

If you ship a build of Umbra, reproduce the upstream `LICENSE` files for the components you
actually bundle. Umbra downloads models and installs Python packages rather than vendoring
them, so a source checkout of this repository does not itself redistribute the components
listed above — but a packaged distribution might.

## Reporting a licensing problem

If you believe something here is misattributed or missing, open an issue. Licence terms change;
re-verify against upstream before relying on this table for a commercial release.
