# Delivery — stems, sync, and the post-production export

This subsystem answers one question: **can an editor drag our stems onto a
DAW timeline at 00:00 and rebuild the session exactly?** Everything else in
`src/lib/export/` exists to serve that contract. It does not replace the
single-bounce export (`render.ts`); it generalises it into a full delivery
package (ADR-0005).

```
plan.ts data ──► stemPlan.ts (WHERE + WHEN) ──► stemRender.ts (render each pass)
                     │                              │  reuses clips.ts scheduleClip,
                     ▼                              │  dsp.ts buildMaster, render.ts schedule
                referenceKernel.ts ◄────────────────┘  (same algebra, test-visible)
                     │
                     ▼
      wavio.ts (WAV/BWF) ──► package.ts (ZIP) ──► manifest.ts (documentation)
```

## 1 · One clock, one span

`clock.ts` is the only place seconds become samples:
`sample = round(seconds · sampleRate)`. No module may re-derive positions.

- Every file in a package shares ONE delivery span:
  `{ startSample, frameCount }`. `startSample` is the absolute project sample
  that becomes byte-0 of every file; `frameCount` is identical across all of
  them — master, every creative stem, every source stem, every sync-padded
  clip. Same length, same sample rate, same bit depth, stereo, PCM.
- The span is `[0 … pictureEnd + tail]` for `full` scope; `range`/`scene`
  scopes shift the origin, and placements stay project-absolute in the
  manifest while stems carry stem-relative `atSample`.
- Picture length comes from `project.duration` (the label on the locked
  picture), never "end of the last layer." With no duration the planner falls
  back to the last event and records `durationAuthority:
  "last-event-fallback"` in the manifest — visibly, not silently.
- Awkward frame rates are the test cases (`tests/export.clock.test.ts`):
  18.4, 18.417, 61.033, 127.999 s round exactly once; repeated conversions
  never accumulate drift.

## 2 · Tail policy (explicit, never silent)

`TailPolicy`: `exact` (hard picture end), `picture_plus` (**default +2 s** —
tails/reverb/duck recovery), `+5 s` (`TAIL_PRESETS`), or a custom number.
Changing the policy changes the length of EVERY file in the package — it can
never vary stem lengths clip-to-clip. Content that crosses the end of the
window is trimmed at the boundary (its start sample never moves).

## 3 · Stem taxonomy (export-side, independent of retrieval)

Two axes. A clip appears in **exactly one bus per axis** — never dropped,
never double-counted within an axis.

- **Creative** (`classifyForStem`): `MX · AMB · FOLEY · SFX · DESIGN ·
  IMPACTS` (+ optional `SUB_LFE`). Resolution order:
  `metadata.umbraStem` override → `role` (RUMBLE maps to DESIGN only when
  sustained) → ordered keyword chain → provider default
  (ace-step→MX, stable/mmaudio→DESIGN, procedural→by voice kind) → `SFX`.
- **Source** (`classifySource`): `PROCEDURAL · GENERATED · LIBRARY · USER` —
  provenance-shaped, so post can pull "everything Freesound" without a
  parallel metadata store.

Unknown clips land in SFX; there is no trash bin, because a dropped clip is a
worse outcome than a mislabelled one. This taxonomy lives ONLY here — the
retrieval planner's taxonomy is deliberately untouched.

## 4 · Why the stems sum to the mix (the reconstruction invariant)

`Σ creative stems = Σ source stems = pre-master mix`. The mix reference pass
(`REF`) renders the identical session WITHOUT master FX/conform, and every
pass (REF included) shares these decisions:

- **Reverb sends are resolved per pass.** Each pass gets its own convolver
  state fed only by the sources routed into it (in the browser, the pass's own
  `buildMaster` returns with its own IR). No shared FX-return stem exists to
  double-count, and wet tails stay with their origin. The trade-off — each
  pass renders its IR — is accepted and recorded in ADR-0005.
- **Ducking automation is data, not state.** `sceneDuckEvents` (shared with
  `render.ts` so monitor and export cannot drift) is recomputed per pass over
  the same event list. Sidechain ducks fired *by procedural voices* at event
  time ride along identically: every pass schedules every voice, muting
  foreign ones as sample-zero ghosts, so the duck envelope is the same global
  in master, reference and every stem, and Σ nulls exactly. A music stem
  ducks against the full hit list exactly like the mix does.
- **The sub bus is single-owner.** `SUB_LFE` (when enabled) and `PROCEDURAL`
  take custody of sub-bus material (`subOut=false` on other consolidated
  passes); the owner feeds `subFull + verb` exactly as the master graph does.
- **Fades/trims/gains/pans are per-clip data** produced once by the planner
  (fade math mirrors `clips.ts`: 2 ms safety floor, fades clamped to half the
  clip, `≤ 0.02 s` clips skipped as `tooShort`), consumed identically by
  every pass.

**Tolerance contract:** the kernel tests assert
`max |Σ stems − REF| < 1e-6` per sample — pure float32 rounding-order noise.
This is a property of the ALGEBRA (see §8). A DAW that bit-exactly sums our
files will land in the same order; a DAW that applies gain staging or plugin
latency compensation on import is outside our contract (the manual checklist
below says how to verify it properly).

## 5 · Loudness and headroom

- Only `MASTER` is conformed: BS.1770 → **-16 LUFS** integral, then
  lookahead true-peak limiting → **-1 dBTP** (unchanged `render.ts`
  behaviour, now covered by `tests/export.loudness.test.ts`).
- **Stems are never loudness-normalised.** They carry measured
  `peakDb`/`lufs` in the manifest flagged `informationalOnly: true` —
  documentation, never applied processing. A stem is a faithful slice of the
  pre-master mix, which is exactly why the sum works.
- No mastering surprises on stems: `masterFx` (drive/glue/tilt/exciter) and
  the conform run on the master pass only; consolidated stems render through
  clip routing + per-pass reverb/duck/sub, preserving session headroom.

## 6 · Individual clip modes

`RAW SOURCE` (original asset bytes re-wrapped, never re-encoded — RIFF
probed, not guessed), `PROCESSED` (clip-local, starts at sample 0),
`SYNC-PADDED` (full span, silence from 00:00, content at the exact delivery
sample). Sync-padded files are grid-compatible with the stems by
construction; the kernel test proves a sync-padded render equals its own
master when the clip is the whole session.

## 7 · Formats, honestly

- Delivery rates 44.1/48/96 kHz; 16/24-bit PCM (default **48 kHz / 24-bit**).
- Decode happens ONCE at the delivery rate (`clips.ts` cache seeded by the
  preflight probe) — no double resampling anywhere in the pipeline; every
  file in the package has identical SR/bit depth.
- `container: 'bwav'` writes a real `bext` chunk (EBU Tech 3285): JUNK pad to
  byte 64, 7-bit-ASCII-sanitised fields, timeReferenceSample = delivery
  origin (64-bit), 180-char coding-history records with CRC32 —
  round-trip-tested, including > 2^32 sample counts. Loudness metadata in
  `bext` is written as "not measured" rather than faked. `container: 'wav'`
  ships plain WAV and the manifest records the container per file.

## 8 · Reference kernel vs browser (what the tests actually prove)

`referenceKernel.ts` is a pure-TS transcription of the same algebra
(pan/gain/fade → shared per-pass duck automation → per-voice verb sends →
music/hit bus → sub bus → master FX bypassed for REF), used ONLY by tests to
inspect sample positions and summation. `stemRender.ts` executes the same
plan in `OfflineAudioContext` through the real graph (`buildMaster`,
`scheduleClip`, shared `schedule()` — pinned by import-scan tests so neither
side may fork the DSP). Equivalence between the two is by construction; if
you change one, change the other in the same PR, and `npm test` will fail
loudly if the structural boundary moves.

## 9 · Package layout (ZIP, via fflate; audio STORED, docs deflated)

```
UMBRA_<project>_<timestamp>/
  Mix/            UMBRA_<p>_MASTER.wav (+ optional MUX reference)
  Post_Stems/     UMBRA_<p>_MX.wav … (creative axis, one file per bus)
  Source_Stems/   UMBRA_<p>_GENERATED.wav … (source axis)
  Documentation/  delivery_manifest.json · sound_credits.txt/.json ·
                  cue_sheet.csv · README.txt · export_log.txt
  Individual_Clips/ (only when requested)
```

Raw source files are NOT duplicated into the package unless
`includeRawSourceFiles` is checked (the RAW individual export stays opt-in).

## 10 · Preflight (validate before you write)

`runPreflight(plan, env)` runs before any file is produced: clock sanity,
rate/bit-depth support, duration authority, per-clip decode probe
(`missing`/`undecodable` = **error**, blocks the export unless the user
explicitly forces it), partition integrity (every clip exactly one bus per
axis), stem-length uniformity, mute/solo state (solo default `ignore`:
delivery = what the session would play, mutes always honoured; `honor`
mode mirrors monitoring and says so), license warnings (never silently
export unlicensed audio — flag, require acknowledgement, never auto-drop).
`formatPreflight` renders the checklist; the UI shows it before the button
unlocks.

## 11 · Manual acceptance — DAW round trip (human gate, not CI)

CI proves the algebra; this proves the *product*. Not executed in this
environment (no DAW available here), so it ships as the acceptance runbook.
Target ≈30 minutes in any of Reaper / Logic / Pro Tools / Pyramix.

1. Export a package from a session that contains: a clip at an awkward time
   (18.417 s), sparse hits with silence, a procedural sub owner, a library
   bed with reverb, a muted clip, and content past picture end (+2 s tail).
2. Import `Mix/…MASTER.wav` at 00:00 → waveform/zoom to sample grid.
3. Import every `Post_Stems/*` file at 00:00 too. **Zoom to sample level:**
   first transient of each stem event must sit on the same sample as the
   master. Nudge tool must read 0.000 samples offset.
4. Solo-mute through each stem: sum-of-stems null test against the master
   with the master's gain at unity — set a trim so stems sum to −90 dBFS or
   lower residual, or accept ≤1e-6 (kernel contract) numerically via the
   files themselves (Reaper: item processing → "Normalize off", sum track).
5. Replace `Post_Stems` with `Source_Stems` → the null must still close
   (cross-axis partition).
6. Check stem properties: 48 kHz / 24-bit / identical frame counts / stereo
   on every file; DAW prompts for no SRC or bit conversion on import.
7. Tail: picture ends at LCB; a sound crossing out must still be audible in
   the +2 s region of every stem and in the master (same content, same place).
8. BWF: import with `container: 'bwav'` — a DAW (e.g. Pyramix/Soundminer)
   must show bext origin = 0 and project fields; iXML-free honesty.
9. Open `Documentation/delivery_manifest.json`: clip anchors listed in samples
   must equal the DAW cursor positions from step 3; `cue_sheet.csv` rows must
   match the actual timeline events at 00:00-relative timecode.
10. Credits: `sound_credits.txt` lists every delivered retrieved asset, with
    licence + creator, and nothing that wasn't delivered.
Sign off in the release notes; record the DAW + version used
(`docs/development/TESTING.md` §Tier 3 (delivery) is the pointer).

## 12 · Non-goals

No MIDI/CME/MTC transport embedding, no OMF/AAF/conform round-trip, no stem
compression, no per-stem loudness targets, no Dolby/IMF packaging. If one of
those becomes real, it gets its own ADR before its own module.
