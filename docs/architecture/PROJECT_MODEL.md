# Project model (canonical domain types)

One timeline, one clip architecture. This page names the authoritative type
for each concept and where it lives. **Do not define competing versions** —
import these.

## Frontend canonical types — `src/lib/types.ts`

| Type | Role |
| --- | --- |
| `AudioClip` | **The** timeline object. Placement (`start`, `duration`, `offset`, `sourceDuration`), mix (`gain`, `pan`, `fadeIn/Out`, `muted`, `solo`), measured file facts (`audioId`, `url`, `sampleRate`, `channels`), generation history (`metadata`, `version`), plus optional retrieval extensions (`asset`, `cacheKey`, `transform`, `intentId`, `match`, `role`). |
| `ClipMetadata` | Provider, model, prompt/negative prompt, seed, key/mode/BPM/time-signature, task, conditioning package. Open index signature for provenance passthrough — not an excuse for untyped blobs. |
| `ClipProvider` | `'umbra-procedural' \| 'ace-step' \| 'stable-audio' \| 'mmaudio' \| 'library' \| 'user'`. Labels/colors in `CLIP_PROVIDER_META`. |
| `Project` | Reel metadata, `scenes`, unified `clips`, user `spotting` events. |
| `Scene` | Time span + tension/motion/tags/hits + procedural `layers`. |
| `Layer` / `LayerKind` | One procedural voice slot (17 kinds in `KIND_META`). |

## Retrieval domain — `src/lib/library/types.ts`

`SoundRole` taxonomy, `RetrievalIntent`, `RankedCandidate`,
`LibraryAsset` (full provenance: provider, soundId, license class,
attribution, credit line, cache key), `TransformSpec`, `ProvenanceEntry`,
`SpottingEvent`, license policy, settings, credentials (local-only, never
committed).

> **Two clip types — read carefully.** `SoundClip` (library) is the
> *legacy* placed-sound shape, kept for backwards compatibility.
> `AudioClip` (top-level) is canonical: conversion happens at the boundary
> via `soundClipToAudioClip`, and `useStudio` stores only `AudioClip`.
> New code uses `AudioClip`. Do not extend `SoundClip` with new features.

## Backend canonical types — `backend/providers/base.py`

`Capability`, `ProviderRole`, `TaskType`, `GenerationRequest`,
`GenerationResult`, `ProviderStatus`, `ProviderError`. The frontend mirrors
the wire shape in `src/lib/providers.ts` — if the two drift, the backend
wins and the mirror gets updated.

## Lifecycle summary

```
SpottingEvent / scene ──► RetrievalIntent ──► RankedCandidate ──► LibraryAsset
        │                                                        │ (cached blob)
        ▼                                                        ▼
ScorePlan / prompt ──► GenerationRequest ──► GenerationResult ──► AudioClip ──► timeline
(audio file)                (backend)            (real file)        (unified)
```

Provenance (`ProvenanceEntry` ledger → `sound_credits.txt/.json`) is written
at placement time and survives every edit, including Find-Alternative
replacement (location/edits kept, source swapped).
