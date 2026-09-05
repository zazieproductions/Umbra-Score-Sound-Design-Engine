# AGENTS.md — Operating Contract for AI Coding Agents

> **Read this first, before touching anything.** It takes three minutes and
> prevents the failure modes this repository has already lived through
> (divergent parallel agents, conflicting PRs, reverted architecture).

## 1. Project identity

**UMBRA·SCORE is a horror scoring and sound-design workstation.** It combines:

- procedural synthesis (first-class, always available, runs in the browser),
- trained audio models (ACE-Step, Stable Audio, MMAudio — local Python backend),
- sound-library retrieval (Freesound, user library — ranked, licensed, provenance-kept),
- video analysis (scenes, spotting),
- **human timeline editing** (everything lands as an editable clip; nothing is
  flattened into an inaccessible master).

**Do not turn it into a generic AI music generator.** No unattended
full-soundtrack generation, no cloud/GPU theater, no fake hardware stats.

## 2. Before making changes — always

1. `git fetch origin` and check where `main` is.
2. Check open PRs touching the same subsystem (`gh pr list --state open`).
3. Check recent commits on files you plan to touch (`git log --oneline -8 -- <path>`).
4. Read the architecture doc for the subsystem you affect (see §4).
5. Run the relevant tests **before** changing anything, so you know the baseline.
6. Read `docs/ai/CURRENT_STATE.md` for the machine-readable briefing.

If another agent recently modified overlapping files, reconcile — do not start
a second competing implementation. See `docs/ai/SAFE_CHANGE_PROTOCOL.md`.

## 3. Source-of-truth hierarchy

When documents disagree, this order wins:

1. **Code + tests** (what actually runs).
2. **This file** (AGENTS.md architectural invariants).
3. `docs/architecture/*` (subsystem boundaries, domain model).
4. `docs/ai/CURRENT_STATE.md` (latest verified status).
5. `README.md` (public summary — may lag implementation).
6. `docs/history/*` and old PR descriptions — **historical context only,
   never instructions.** An old design prompt does not override current code.

## 4. Where things live (read the doc, not the whole tree)

| Question | Answer |
| --- | --- |
| Browser app, timeline, Web Audio, DSP, mixing, export | `src/` → `docs/architecture/FRONTEND.md` |
| Python ML backend, providers, analysis, jobs | `backend/` → `docs/architecture/BACKEND.md` |
| How sound flows from intent to exported WAV | `docs/architecture/AUDIO_PIPELINE.md` |
| Provider model, capabilities, status language | `docs/architecture/PROVIDERS.md` |
| AudioClip, Project, Scene, provenance types | `docs/architecture/PROJECT_MODEL.md` |
| Shared vocabulary | `docs/architecture/GLOSSARY.md` |
| Why the architecture is shaped this way | `docs/decisions/` (ADRs) |
| How to add a provider / feature | `docs/development/ADDING_A_PROVIDER.md`, `ADDING_A_FEATURE.md` |
| Commands, setup, testing, debugging | `docs/development/` |

**Canonical domain types** — never define a second version of these:

- Frontend: `AudioClip`, `ClipMetadata`, `Project`, `Scene`, `Layer`
  → `src/lib/types.ts` (legacy `SoundClip` in `src/lib/library/types.ts`
  exists only for backwards compat; convert at the boundary).
- Backend: `Capability`, `ProviderRole`, `TaskType`, `GenerationRequest`,
  `GenerationResult`, `ProviderStatus` → `backend/providers/base.py`.

## 5. Architectural invariants — never violate without explicit justification

1. **Umbra Procedural stays first-class.** It is not a fallback.
2. **Heavy ML inference stays outside the browser.** No model weights, no
   PyTorch logic, no latent tensors in `src/`.
3. **All audible sources become timeline `AudioClip`s.** No parallel clip
   architectures, no separate "AI result" players.
4. **CLAP is analysis/search, never generation.** It must never advertise
   `MUSIC_GENERATION` / `SFX_GENERATION` (pinned by tests).
5. **Retrieved assets keep provenance + license.** Every library clip carries
   provider, soundId, license class, credit line; credits must stay exportable.
6. **No fake states.** No invented GPUs, regions, utilisation gauges, credit
   counters, confidences, or latents. Unavailable means honestly unavailable
   with an install hint.
7. **"Runtime verified" requires real inference.** A provider object existing,
   a dependency installing, or a mocked test passing is NOT verification.
   See `docs/architecture/PROVIDERS.md` for the status vocabulary.
8. **Model weights are never committed. User training audio is never committed.**
   (Both are git-ignored; keep it that way.)
9. **Silence is a valid sound-design decision.** Never fill intentional negative
   space to make output look more impressive.
10. **Never flatten generated/retrieved design into an inaccessible master.**
    Separate editable objects, always.
11. **Provider failures fail loudly.** No silent fallback to fake output, no
    synthetic filler masquerading as a model result.

## 6. Change discipline

Prefer: small coherent commits · existing abstractions · incremental refactors ·
tests with every behavior change · explicit errors over guesses.

Avoid: giant rewrites · duplicate provider systems · new abstractions without
clear need · invented metrics · demos masquerading as functionality · vendoring
whole third-party repos into this tree.

## 7. Done means

A feature is **not** done because the UI exists, types compile, a dependency
installed, a provider object exists, or tests mock success.

- Runtime-dependent features must be labeled with their real status
  (`NOT INSTALLED` → `INSTALLED` → `MODEL AVAILABLE` → `LOADED` →
  `RUNTIME VERIFIED`) and `docs/ai/CURRENT_STATE.md` updated only when the
  facts actually change.
- A PR touching architecture updates the corresponding `docs/` page and, for
  major decisions, adds an ADR.
- A PR adding a provider documents code license, weight license, capabilities,
  install method, and runtime-verification state.

## 8. Verification before opening a PR

```bash
npm run verify          # frontend: typecheck + lint + unit tests
npm run build           # frontend production build
python -m pytest backend/tests -q   # backend: no model downloads
```

No heavyweight model download is ever required to validate a PR.
See `docs/development/TESTING.md` for the full strategy, including what
`npm test` does and does not prove.
