# Audio pipeline

How sound travels from an idea to an exported master. Three stages, one
invariant: **every audible source becomes an `AudioClip`, and the monitor and
the bounce render the same graph.**

## 1. Sourcing — three doors, one object

| Source | Path | Lands as |
| --- | --- | --- |
| **Procedural** (17 voice classes) | `voices.ts` graph → played live, or bounced via `proceduralClip.ts` to a real WAV | `AudioClip` with `provider: 'umbra-procedural'` |
| **Generated** (ACE-Step / Stable Audio / MMAudio) | Composer direction → `spotting.py` prompt plan → `POST /api/generate` → job queue → inference → `audio_store` decodes + measures → frontend polls → clip placed at the requested timeline position | `AudioClip` with `provider: 'ace-step' \| 'stable-audio' \| 'mmaudio'`, conditioning preserved in `metadata` |
| **Retrieved** (Freesound / user library / Pixabay-assisted) | `SpottingEvent` or search → `planner.ts` builds `RetrievalIntent` → `service.ts` searches sources → `ranking.ts` (+ CLAP rerank when installed) → license gate → audition → `Use` caches blob in IndexedDB, records provenance, converts to unified clip | `AudioClip` with `provider: 'library' \| 'user'`, plus `asset`, `cacheKey`, `transform`, `license` via asset, `match`, `intentId` |

Retrieval detail (planner → rank → license → audition → place → credits) is a
large subsystem of its own; the acceptance scenarios are pinned in
`tests/library.acceptance.test.ts` and narrated in
`tests/ACCEPTANCE-REPORT.md`.

## 2. Timeline — editing

Clips are ordinary editable objects: move, trim, split, fade, gain, pan, mute,
solo, lock, replace, regenerate, download. Geometry helpers live in
`src/lib/clips.ts` (`moveClip`, `trimClip`, `splitClip`, `clipEnd`); state
ops in `useStudio.ts`. Library clips additionally support nondestructive
`TransformSpec` (rate, pitch, filters, reverb send, looping) — the original
asset is always kept.

Placed separately, never flattened: auto sound design returns N clips, not a
mixed-down bed (pinned by acceptance test T2).

## 3. Mix and export — one graph, two contexts

```
voices ─┬─► channel strip (HP · bell · air · pan · Haas width)
        │      └─► sends → room / stage / cathedral convolvers
        │
music clips ──► musicSum ──► duck (hit sidechain) ─┐
sfx clips   ──► hitSum ────────────────────────────┤
music layers ─► musicSum ──────────────────────────┤
hit layers ───► hitSum ────────────────────────────┤
sub layers ───► sub bus (LP · octave · 46 Hz res) ─┤
                                                   ▼
tension macro → glue → tape → tilt → M/S widen → exciter → brickwall → limiter
```

- **Monitor:** `audio.ts` `ScoreEngine` builds this in a realtime
  `AudioContext` — clip buffers via `clips.ts scheduleClip`, voices via
  `voices.ts buildVoice`, master via `dsp.ts buildMaster`.
- **Export:** `render.ts` rebuilds the same graph in an
  `OfflineAudioContext` (`scheduleClip` reused verbatim), then a post master:
  1. ITU-R BS.1770 loudness conform → **-16 LUFS**,
  2. lookahead true-peak limiting → **-1 dBTP**,
  3. TPDF-dithered 24-bit PCM WAV (+ stems on request).

Because both paths share `dsp.ts` primitives and `scheduleClip`, the exported
master matches what was heard. The bounce reports `clipsPlaced` /
`clipsFailed` — failures are surfaced, never silently dropped.

## Invariants (also pinned in `tests/architecture.invariants.test.ts`)

- Monitor and bounce share DSP code; a node existing in only one path is a bug.
- No clip on the timeline without either a backend `audioId` (real file) or a
  library `cacheKey` (real blob). Failures fail loudly.
- Retrieval clips retain `asset` + `cacheKey` + `intentId` through conversion.
- Credits (`sound_credits.txt/.json`) are derivable from timeline state alone.
