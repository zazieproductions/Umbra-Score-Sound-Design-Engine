# ADR-0005: Stem delivery re-runs the live graph — no second mixer, no per-stem mastering

- **Status:** Accepted
- **Date:** 2026-09

## Context

Post-production delivery requires consolidated stems that sum back to the
approved mix exactly, land at identical sample positions as the master, and
survive a DAW import at 00:00 without resampling or drift. The tempting
shortcuts are (a) a second, simpler "stem renderer" with its own gain maths,
(b) bouncing FX returns as shared auxiliary stems, (c) loudness-normalising
each stem so they "all hit -16". Each of these breaks a promise: (a) drifts
from what the user monitored, (b) makes reverb double-counted or lost in the
Σ-stems null test, (c) makes reconstruction impossible by construction.

## Decision

- **One clock, one span.** `src/lib/export/clock.ts` owns
  `sample = round(seconds · sampleRate)` and the delivery span; every file
  (master, creative stems, source stems, sync-padded clips) shares the exact
  same frame count, rate and depth. Picture length (`project.duration`) is
  the authority, extended by an explicit tail policy — never the last event.
- **Stems render the SAME primitives as monitor and single bounce.**
  `stemRender.ts` schedules voices through `clips.ts scheduleClip`,
  `render.ts schedule()` and `dsp.ts buildMaster` in an `OfflineAudioContext`.
  A pure-TS `referenceKernel.ts` mirrors this algebra for tests. If the
  graph changes, all three change together; import-boundary tests pin it.
- **Reverb is per-pass, not a shared FX-return stem.** Each stem pass owns
  its convolver returns fed only by its routed sources, so Σ stems equals the
  mix. Cost: each pass renders its own IR tail — accepted: passes are
  sequential, memory-bound work is the buffer, and correctness of the
  reconstruction invariant outranks a few seconds of bounce time.
- **Ducking is derived from the same scene data in every pass** (shared
  `sceneDuckEvents`), so the music stem's duck matches the master's exactly.
- **Two-classification partition:** creative buses (MX/AMB/FOLEY/SFX/DESIGN/
  IMPACTS/SUB_LFE) and source buses (PROCEDURAL/GENERATED/LIBRARY/USER);
  every clip in exactly one bus per axis, unknown → SFX (never dropped).
  The retrieval taxonomy is NOT changed to serve export.
- **Loudness conformance (-16 LUFS / -1 dBTP) is a master-only operation.**
  Stems export measured peak/LUFS as documentation (`informationalOnly`) and
  nothing else. Σ stems = pre-master mix within a 1e-6 float-noise tolerance
  (contract in `docs/architecture/DELIVERY.md`).
- **Export-side metadata honesty:** BWF `bext` is written only as a real,
  spec-shaped chunk (sanitised ASCII, CRC'd coding history, "not measured"
  where unmeasured) or not at all; ZIP via **fflate** with audio STORED
  (WAVs don't compress) rather than a hand-rolled writer; raw sources are
  opt-in so the package never silently duplicates audio.

## Consequences

- New subsystem `src/lib/export/` + `tests/export.*` (72 tests); `render.ts`
  and `dsp.ts` gained reusable seams (`scheduleClipsInto`, `finalizeMaster`,
  `measureLufs`, selectable master-chain wiring) rather than a fork.
- Bouncing N stems costs N graph renders — explicitly fine: the alternative
  (one pass + tap extraction) would fork the DSP into node-tap plumbing the
  monitor can't share.
- Solo is a transient monitor state: delivery ignores solo by default
  (`soloPolicy: 'ignore'`, mutes always honoured), `honor` is opt-in and
  flagged into the manifest + README.
- Any future DAW-format work (AAF, CME, MTC) must pass through this plan
  layer, not new ad-hoc renderers.

## What this prevents

- "Stems don't add back up to the mix" — the classic post-house rejection.
- Sample drift between stem files from scattered `· sampleRate` conversions.
- A second audio engine drifting from the monitor the user approved on.
- Loudness-processed stems that can never be recombined.
- Accidental double-billed reverb or silently dropped unmapped clips.
