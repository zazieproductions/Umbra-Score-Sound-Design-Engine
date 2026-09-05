# Providers

A **provider** is one engine that can put sound on the timeline. Providers are
deliberately heterogeneous — synthesis, trained models, and libraries sit side
by side — and the registry treats them uniformly while being honest about
where each one runs.

## The six providers

| Provider | Role | Runs | Code |
| --- | --- | --- | --- |
| `umbra-procedural` | Precise synthetic elements: subs, drones, risers, stingers, impacts (17 classes) | Browser Web Audio — always available | `src/lib/voices.ts`, `backend/providers/umbra_procedural.py` (descriptor only) |
| `ace-step` | Musical score: tonal beds, orchestral/synthetic texture, continuation, repaint | Local Python (PyTorch) | `backend/providers/ace_step.py` |
| `stable-audio` | Physical/environmental sound: machinery, room tone, water, wind, debris | Local Python (Diffusers) | `backend/providers/stable_audio.py` |
| `mmaudio` | Video-conditioned Foley synchronised to picture | Local Python | `backend/providers/mmaudio.py` |
| `clap` | Semantic search over your own library (embeddings, **not generation**) | Local Python | `backend/providers/clap.py` |
| Library retrieval (`library` / `user` clip providers) | Freesound, user library, Pixabay-assisted discovery — ranked, license-gated, provenance-kept | Browser ranking + IndexedDB cache; Freesound HTTP goes through the local backend because its API key is server-side (+ CLAP rerank when installed) | `src/lib/library/`, `backend/integrations/` |

Routing between them: `backend/providers/registry.py` (`route_intent`) and
the `/api/route` endpoint — a transparent scorer that returns its reasoning.

## Routing boundaries (what each provider is NOT for)

- ACE-Step scores. It does not author Foley, footsteps, door sounds, or room
  tone, and never generates a whole soundtrack unattended.
- Stable Audio handles recorded-world texture, not musical score.
- MMAudio handles picture-locked Foley, nothing else.
- CLAP finds sounds; it never synthesises them.
- Retrieval owns Foley; generation owns music beds.

## Capability model

Backend source of truth: `Capability` in `backend/providers/base.py`.
Frontend mirror: `Capability` in `src/lib/providers.ts` (keep the two in sync
when adding values).

Capabilities are **re-derived at runtime from the installed version** — e.g. a
turbo ACE-Step checkpoint must not claim `CONTINUATION`. Unavailable providers
declare no capabilities at all.

## Status vocabulary — the only allowed language

Backend probes report booleans (`installed`, `ready`) + capabilities + device.
The UI (Models view) renders them on this ladder:

| Status | Meaning | Requirement to claim it |
| --- | --- | --- |
| `NOT INSTALLED` | Package/weights absent | Default; always allowed |
| `INSTALLED` | Package importable, weights missing | Real import probe passes |
| `MODEL AVAILABLE` | Weights present on disk | Real checkpoint scan finds them |
| `LOADED` | Model in memory, ready to infer | Real load completed |
| `RUNTIME VERIFIED` | **Actual inference succeeded on this machine** | A real generation produced a real decoded file |
| `UNAVAILABLE` | Cannot run here (with reason + install hint) | Probe determined why |
| `FAILED` | Attempted and errored (with error text) | Real failure captured |

**Rules:**

- Do not invent new status words. If none fits, use `UNAVAILABLE`/`FAILED`
  with a clear reason string.
- A provider is not `RUNTIME VERIFIED` because its object exists, its
  dependency installed, the backend started, or a mocked test passed. Only
  real inference counts. Current per-provider verification state lives in
  `docs/ai/CURRENT_STATE.md` (`RUNTIME STATUS`).
- The frontend `PROVIDER_FALLBACK` descriptions (`src/lib/providers.ts`) must
  never claim readiness — they render before the backend answers.
- No fake hardware, regions, utilisation, or credit counters anywhere in this
  flow. Device facts come from `backend/services/device.py` probes only.

## Generation flow

```
composer direction → prompt plan (spotting.py, shown before commit)
  → POST /api/generate → job queued → inference → audio_store decodes/measures
  → poll GET /api/jobs/{id} → succeeded ONLY with real file
  → frontend places AudioClip at timeline_start (useGeneration.ts)
```

Reference audio the composer supplies stays on the machine
(`POST /api/audio/upload`, `training/user_audio/` — git-ignored).
