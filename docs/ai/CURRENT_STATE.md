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
(decode-before-register), job queue, model discovery. All routes in `app.py`.

## Providers

| Provider | Implementation | Runtime status |
| --- | --- | --- |
| umbra-procedural | 17 Web Audio voices, offline bounce to WAV | RUNTIME VERIFIED (browser-side); per-stem/per-scene renders deterministic; full-mix may vary at 1-LSB level (native engine float reduction) |
| ace-step | Adapter + prompt plan + job flow plumbed | NOT runtime-verified here — needs weights + torch + ffmpeg on target hardware |
| stable-audio | Validation adapter | NOT runtime-verified here |
| mmaudio | Adapter, real-or-UNAVAILABLE | NOT runtime-verified here |
| clap | Embeddings/search adapter | NOT runtime-verified here |
| library (Freesound/user/Pixabay) | Retrieval subsystem; Freesound auth proxied through the backend | Verified at plumbing level: mocked acceptance + security tests both sides of the wire; live freesound.org verification is the documented manual gate (FREESOUND_LIVE_ACCEPTANCE.md) |

## Runtime status

No Tier 3 (hardware + weights) acceptance has passed in this environment.
The end-to-end hardware gate (D-minor/44 BPM/12 s → file → timeline → master)
remains open by design — CI never downloads weights.

## Test counts

- Frontend: 148 (`npm test`) — 20 retrieval acceptance + 6 Freesound
  frontend-security (no secrets in requests/persistence, safe status shape,
  OAuth body) + 6 architecture
  invariants + 20 quality-measurement units + 6 rendered gates exercising the
  real engine through headless Web Audio (4 audio-QA + 2 stem-delivery
  equivalence: shared frameCount + Σ-stems-null on genuine convolvers;
  `node-web-audio-api`, skip-not-fail when the addon cannot load) +
  72 export-delivery (clock 6, stemPlan 27, kernel A/B/C/G 8, WAV/BWF 10,
  manifest 6, preflight+ZIP 10, loudness/boundaries 5).
- Backend: 101 (`pytest backend/tests -q`), no downloads — includes 27
  backend-managed-Freesound security tests (all Freesound HTTP mocked)
- `tsc -b` clean · `eslint` clean · `vite build` clean

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
- Freesound search needs the local backend running (it holds the
  credentials); procedural + user-library retrieval still work without it.
  Live freesound.org verification has not been executed in this environment
  (no egress route) — see docs/development/FREESOUND_LIVE_ACCEPTANCE.md.
- Legacy `SoundClip` still present at the retrieval boundary (compat shims in
  `src/lib/types.ts`); new code must use `AudioClip`.
- Browser cache (IndexedDB) durability is best-effort; timeline clips are the
  durable record via `clearUnusedCache` protection.

## Open technical debt

See `docs/TECH_DEBT.md` for the register (IDs, risk, safe next steps).

## Recent architectural decisions

- ADRs 0001–0006: hybrid split, unified clip, procedural first-class,
  retrieval provenance, backend-managed Freesound credentials (see
  `docs/decisions/`).
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

- **Date:** 2026-09-05 · **base commit:** `0d78a15` · **branch:**
  `arena/01a072fd-umbra-score-sound-design-engin`
- Frontend: `npm run verify` green (typecheck + eslint + 45 pass / 4 skip) ·
  `npm run build` green · rendered QA 49/49 with the headless engine + ALSA stub
- Backend: `pytest backend/tests` 66 passed, no downloads
- Runtime provider verification: none in this environment (see table above)
