# Current state (agent briefing)

Factual, short, read at the start of every task. Update `LAST VERIFIED` only
when the facts change. Never claim runtime verification from mocked tests.

## Current architecture

Hybrid: React 19 + Web Audio browser app (`src/`) with realtime monitor,
procedural engine (17 voices), and offline bounce sharing one DSP core
(`dsp.ts`); local FastAPI backend (`backend/`) for inference, embeddings,
analysis, jobs, and the audio file store. Single crossing point:
`src/lib/providers.ts` ↔ `/api`. One canonical clip: `AudioClip`
(`src/lib/types.ts`); legacy `SoundClip` converts at the retrieval boundary.

## Frontend

Timeline (lanes, inspector, scoring panel, library, models, export views),
unified clip editing, master chain + BS.1770/true-peak/24-bit export,
retrieval subsystem (planner, ranking, Freesound/Pixabay/user-library,
IndexedDB cache, provenance, credits), stem-delivery subsystem
(`src/lib/export/`: one clock/span, creative+source stem axes, per-pass
reverb/duck algebra, preflight, manifest/cue-sheet/credits, BWF, fflate ZIP —
see `docs/architecture/DELIVERY.md`, ADR-0005). Works fully without the
backend.

## Backend

Registry + router (5 providers), ACE-Step / Stable Audio / MMAudio / CLAP
adapters, scene+spotting planner, video/waveform analysis, audio store
(decode-before-register), job queue, model discovery. Routes in `app.py` plus the external-API
integration router (`backend/integrations/`); Freesound credentials stay server-side.

## Providers

| Provider | Implementation | Runtime status |
| --- | --- | --- |
| umbra-procedural | 17 Web Audio voices, offline bounce to WAV | RUNTIME VERIFIED (browser-side); per-stem/per-scene renders deterministic; full-mix may vary at 1-LSB level (native engine float reduction) |
| ace-step | Adapter + prompt plan + job flow plumbed | NOT runtime-verified here — needs weights + torch + ffmpeg on target hardware |
| stable-audio | Validation adapter | NOT runtime-verified here |
| mmaudio | Official small_44k adapter + selected-range → existing jobs/AudioClip; explicit noncommercial gate and export provenance | **NOT runtime-verified here** — no weights/torch; heavy inference mocked |
| clap | Embeddings/search adapter | NOT runtime-verified here |
| library (Freesound/user/Pixabay) | Retrieval subsystem | Verified at plumbing level: 19/19 mocked acceptance tests. Freesound HTTP now runs through the backend (`backend/integrations/`), key server-side — 21 backend + 12 frontend mocked tests; **live freesound.org call NOT runtime-verified here** (outbound TLS blocked in this environment) |

## Runtime status

No Tier 3 (hardware + weights) acceptance has passed in this environment.
The end-to-end hardware gate (D-minor/44 BPM/12 s → file → timeline → master)
remains open by design — CI never downloads weights.

## Test counts

- Frontend: 165 passed / 6 environment-dependent rendered tests skipped
  (`npm run verify`); includes 12 MMAudio boundary/UI/licensing/export tests.
- Backend: 154 passed / 2 local-fixture tests skipped, no model downloads.
  Includes 59 MMAudio contract cases and real ffmpeg tiny-MP4 extraction/upload
  with a temporary toolchain; inference itself is mocked. Also includes the
  upstream Freesound integration (21 backend / 12 frontend mocked tests).
- `tsc -b` clean · `eslint` clean · `vite build` clean (bundle-size warning).

## Audio quality gates

`src/lib/quality.ts` is the single source of truth for measurable export QA:
sample/true peak, RMS, crest factor, DC offset, subsonic (≤20 Hz) ratio,
clipping, intersample clipping, non-finite samples, integrated LUFS, stereo
correlation, silence and output stability, with a `pass|warn|fail` verdict.
`render.ts` measures every bounce and `useStudio.ts` surfaces the verdict in
the render queue and log. The DSP core fixes landed this pass: a
silence-through full-wave rectifier (was injecting a full-scale DC step that
thumped through the sub-bus highpass at render start) and band-limited
oscillators across all pitched/transient voices (no fold-back aliasing).

## Known limitations

- Stem-delivery algebra is kernel-tested, but the end-to-end DAW round-trip
  acceptance (§11 of `DELIVERY.md`) is a MANUAL gate — no DAW exists in CI or
  this sandbox; a human must tick it per release. Browser execution of
  `stemRender`/`delivery` (OfflineAudioContext) is likewise untested here —
  the node test env stubs no OfflineAudioContext by design.

- Backend optional extras (torch, diffusers, CLAP, PySceneDetect) not installed
  in lightweight envs — providers honestly report unavailable.
- `ffmpeg` external binary required for video metadata/thumbnails.
- Live Freesound calls need `FREESOUND_API_KEY` in a git-ignored `.env`, read by
  the backend only (never the browser). Verified against a local Freesound
  stand-in — the production host is unreachable from this sandbox.
- Legacy `SoundClip` still present at the retrieval boundary (compat shims in
  `src/lib/types.ts`); new code must use `AudioClip`.
- Browser cache (IndexedDB) durability is best-effort; timeline clips are the
  durable record via `clearUnusedCache` protection.

## MMAudio optional integration

`python scripts/setup_models.py --mmaudio` installs only small_44k + required
auxiliaries (~7.24 GB), not large/training models; excluded from `--core`/`--all`.
All weights/caches stay gitignored. Code MIT, checkpoints **CC BY-NC 4.0**;
UI **EXPERIMENTAL · NONCOMMERCIAL**. Uses existing licensing policy and requires
explicit consent; strict/portable workflows block generation/export. Real
source timing, prompt, model/version, seed and licensing persist in AudioClip
metadata and mandatory export manifests/sidecars. No second timeline/backend.
[Runbook and manual verification command](../development/MMAUDIO.md).

## Open technical debt

See `docs/TECH_DEBT.md` for the register (IDs, risk, safe next steps).

## Recent architectural decisions

- ADRs 0001–0004: hybrid split, unified clip, procedural first-class,
  retrieval provenance (see `docs/decisions/`).
- Historical design prompt moved to `docs/history/` — not a spec.
- `npm run verify` (typecheck + lint + tests) is the pre-PR gate.

## Files most likely to conflict

`src/lib/useStudio.ts` (state coordinator), `src/lib/types.ts` (domain types),
`src/components/Timeline.tsx` + `ClipLane.tsx`, `backend/app.py` (routes),
`backend/providers/registry.py`, `README.md` / `docs/**` (parallel doc edits).

## Next safe areas of work

From `docs/TECH_DEBT.md` / `docs/ROADMAP.md` (NOW): SoundClip boundary
retirement, retrieval ranking eval harness, Models-view status-ladder
alignment, export loudness conformance tests, docs drift checks.

## Last verified

- **Date:** 2026-09-05 · **base commit:** `2cb7055` · **branch:**
  `arena/01a073b4-umbra-score-sound-design-engin` (rebased on fetched main).
- Frontend: `npm run verify` green (165 pass / 6 skip) · `npm run build` green.
- Backend: `pytest backend/tests -q` 154 passed / 2 skipped with ffmpeg toolchain;
  without ffmpeg: 153 passed / 3 skipped. No weights downloaded.
- Live Vite proxy/API: discovery, real tiny-MP4 upload, licensing HTTP 403,
  missing-model HTTP 503 verified; manual verifier fails honestly (exit 1).
- Runtime provider verification: **none** in this environment. In particular,
  MMAudio model loading, CUDA/MPS/CPU inference and listening sync remain unverified.
