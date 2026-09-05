# ADR-0003: Procedural synthesis as a first-class provider

- **Status:** Accepted
- **Date:** 2026-09

## Context

A trained model is the wrong instrument for a timed 40 Hz sub swell (needs
frame accuracy, determinism, instant re-render), and synthesis is the wrong
instrument for an unstable bowed cluster (needs thousands of hours of heard
strings). Retrieval is the wrong instrument for both when a precise synthetic
element is wanted. Each engine has a native range.

## Decision

- Umbra Procedural (17 Web Audio voice classes) is a full provider in the
  registry, router, and Models view — always installed, always ready.
- Procedural requests bounce offline to real WAVs (`proceduralClip.ts`) so
  procedural clips are byte-for-byte as concrete as generated ones.
- Routing sends precise synthetic elements (subs, stingers, risers, timed
  pulses) to procedural *by design*, not as a fallback for missing models.

## Consequences

- The app works fully offline with zero installs.
- The procedural engine must be maintained with the same care as model
  integrations (shared `dsp.ts` graph, same master chain).

## What this prevents

- Treating synthesis as a degraded mode ("procedural until the real model loads").
- Moving synthesis into Python "for uniformity" (see ADR-0001).
- Fake procedural output: bounced WAVs are real files, measured like any other.
