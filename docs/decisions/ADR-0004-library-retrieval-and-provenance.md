# ADR-0004: Library retrieval with license/provenance preservation

- **Status:** Accepted
- **Date:** 2026-09

## Context

Generation is the wrong instrument for a specific real-world sound (a door
handle rattle at 00:18.4). Retrieval — find, audition, place a real recording
— is a core workflow, but scraped or unattributed audio is a legal and ethical
liability, especially for festival delivery.

## Decision

- Retrieval (Freesound, user library, Pixabay-assisted discovery) is a
  first-class sound source with planner → rank → license-gate → audition →
  place flow.
- Every retrieved clip retains provider, soundId, license class, attribution,
  and credit line from placement through every edit to credits export
  (`sound_credits.txt/.json`).
- License policy gates results (`strict` / `personal` / `custom`);
  `UNKNOWN` licenses are rejected, never guessed.
- Auto sound design returns N separate editable clips, never a flattened bed.
- Silence (`allowSilence`) is a valid planner decision.

## Consequences

- Retrieval code carries provenance plumbing everywhere (asset, cacheKey,
  intentId) — see `PROJECT_MODEL.md`.
- Some searches legitimately return nothing under a strict policy; the UI
  must say why.

## What this prevents

- Unattributed/432 unlicensed audio reaching an export.
- "Auto design" producing one inaccessible mixed master.
- Confidence-flavored ranking theater (`match` is informational, 0..1).
