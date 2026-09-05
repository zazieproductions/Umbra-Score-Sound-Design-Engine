# UMBRA·SCORE

**Cinematic Score & Sound Design Engine** — a fully client-side synthesizer that turns a video cut into a layered, Hollywood-grade film score. No samples, no cloud: every stem is synthesized and mixed in-browser through the Web Audio API, then bounced to a real 24-bit / 48 kHz WAV.

> "Score it like a Hollywood mix. Frame by frame."

## What it generates

UMBRA analyzes a reel into scenes (tension, motion, sync hits), assigns each scene a musical key, then scores it with **17 layer classes**:

| Family | Layers |
| --- | --- |
| Beds | Drone Bed · Sub Pressure · Ambience · Whisper Texture |
| Orchestra | String Section · Choir Pad · Braam · Brass Stab |
| Rhythm / Tension | Heart Pulse · Tension Tick · Taiko / Percussion |
| Transitions | Riser · Downlifter · Whoosh Pass |
| Detail | Foley · Stinger · Impact |

Pitched layers resolve to a shared scene key, so strings, choir, brass and braams sit in the same harmonic space — the whole cut plays like one composed score, not a wall of unrelated drones.

## The audio chain

```
voices ─┬─► channel strip (HP · bell · air · pan · Haas width)
        │      └─► sends → room / scoring stage / cathedral convolvers
        │
music layers → musicSum → duck (hit sidechain) ─┐
hit layers   → hitSum ──────────────────────────┤
sub layers   → sub bus (LP · octave · 46 Hz res)┤
                                               ▼
tension macro → glue comp → tape drive → tilt EQ → M/S widen
     → parallel exciter → brickwall → true-peak lookahead limiter
```

Every render then runs a **post master**:

1. **ITU-R BS.1770 loudness measurement** (K-weighting, 400 ms blocks, absolute + relative gating) → conformed to **-16 LUFS**.
2. **Lookahead true-peak limiting** (5 ms sliding-window max, instant attack, smooth release) → **-1 dBTP** ceiling.
3. 24-bit PCM encode (TPDF-dithered at 16-bit).

Key mixing moves for the theatrical feel:

- **Hit ducking** — impacts, stingers, braams, brass and taiko sidechain the music bed, so every hit lands with real pump.
- **Sub-harmonic LFE** — layered fundamental + fifth + sub-octave, rectified octave reinforcement, and a resonant 46 Hz shelf so the weight survives small speakers.
- **Immersive space** — procedural stereo impulse responses with early reflections and decorrelated tails, Haas width, drifting ambience pans, and a reverse-bloom convolver for pre-swell tails.
- **Dramatic dynamic range** — a tension macro rides the whole mix, scenes swell toward their tension peak, and equal-power crossfades with a sub "brake" polish every seam.

## Running it

```bash
npm install
npm run dev      # local dev server with HMR
npm run build    # typecheck + production bundle
npm run lint     # eslint
```

Load the demo reel or drop a video (MP4 / MOV / ProRes / WebM, up to 4K). Use the **Mix** panel to ride the master bus, solo/mute/audition layers, and bounce stems; **Export** renders the full score to WAV in-browser.

## Project layout

```
src/lib/
  types.ts       layer kinds, scenes, project model, metadata
  dsp.ts         master bus, channel strips, reverbs, ducking
  voices.ts      per-layer synthesis graphs (17 classes)
  generate.ts    scene/key planning and layer generation
  render.ts      offline render + loudness/true-peak post master
  audio.ts       realtime monitoring engine
  useStudio.ts   React state + transport + export orchestration
src/components/  UI (viewer, timeline, mixer, exports, assets…)
```
