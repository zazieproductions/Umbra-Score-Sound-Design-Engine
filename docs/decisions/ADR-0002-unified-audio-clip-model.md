# ADR-0002: One canonical AudioClip for every sound source

- **Status:** Accepted
- **Date:** 2026-09

## Context

Parallel development produced two clip architectures: generative `AudioClip`
and library `SoundClip`, with separate players, editors, and code paths. Every
new operation had to be built twice, and mixed timelines were second-class.

## Decision

- `AudioClip` (`src/lib/types.ts`) is the single timeline object. Every
  provider — procedural, ACE-Step, Stable Audio, MMAudio, Freesound, user
  library — lands as one.
- Retrieval provenance (`asset`, `cacheKey`, `transform`, `intentId`, `match`)
  is an optional extension, not a fork.
- `SoundClip` (`src/lib/library/types.ts`) remains only as a legacy boundary
  shape with conversion helpers. New code uses `AudioClip`.

## Consequences

- Move/trim/split/fade/gain/pan/mute/solo/replace/export work identically for
  all sources. One inspector, one scheduler, one bounce path.
- Conversion code at the retrieval boundary must be maintained.

## What this prevents

- A second "AI result" player beside the timeline.
- Parallel competing clip architectures (the exact failure this ADR reverses).
- Features that work for generated clips but not retrieved ones, or vice versa.
