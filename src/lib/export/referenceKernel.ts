/* ==================================================================== *
 *  REFERENCE KERNEL — deterministic algebra mirror for delivery tests
 *
 *  ⚠ This is NOT a second audio engine. It renders no product sound and
 *  nothing in the app plays it. Its single job: execute the *routing
 *  algebra* of a StemPassPlan (sample placement, fader envelope, pan law,
 *  duck automation, per-pass send/sub gating) in pure TypeScript so the
 *  load-bearing invariants — sync anchors, stem partitioning, exact
 *  reconstruction of the pre-master mix, tail policy, silence between
 *  events — can be proven in Node without a browser.
 *
 *  The production path (stemRender.ts) runs the SAME plan through the real
 *  Web Audio graph (buildMaster / schedule / scheduleClip). Where the two
 *  differ is only in DSP quality (convolution vs a comb proxy, full biquads
 *  vs simplified ones); the TIMING and PARTITION arithmetic is shared data
 *  from stemPlan.ts, which is exactly what the invariants are about.
 * ==================================================================== */

import type { DuckEvent, StemPassPlan } from './stemPlan';

/** Minimal structural stand-in for AudioBuffer — the real one satisfies it. */
export interface KernelBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface KernelSource {
  key: string;
  buffer: KernelBufferLike;
  /** pass-local placement — semantics identical to PlannedClipPlacement */
  atSample: number;
  offsetSample: number;
  frameCount: number;
  gain: number;
  pan: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  isMusic: boolean;
  /** per-space send gains (room/hall/cathedral), 0 = dry */
  verbSends?: { room?: number; hall?: number; cath?: number };
  /** fraction of the source's dry signal tapped into the sub chain */
  subFeed?: number;
  /** full fader output goes through the sub chain instead of the dry bus */
  subFull?: boolean;
  /** per-pass gating — mirrors the flags on PassLayerRef / pass membership */
  dry?: boolean; // default true
  verb?: boolean; // default true
  sub?: boolean; // default true (gated by pass subOut too)
}

export interface KernelMasterConfig {
  volume: number;
  width: number;
  roomMix: number;
  hallMix: number;
  cathMix: number;
  subBoost: number;
}

/** Sensible neutral config: unit gains, the DEFAULT_MASTER mixes for sends. */
export const DEFAULT_KERNEL_MASTER: KernelMasterConfig = {
  volume: 1,
  width: 1,
  roomMix: 0.28,
  hallMix: 0.34,
  cathMix: 0.18,
  subBoost: 0.66,
};

export interface KernelPassSpec {
  frameCount: number;
  sampleRate: number;
  sources: KernelSource[];
  duck: DuckEvent[];
  subOut: boolean;
  master: KernelMasterConfig;
}

/** Equal-power pan law, matching StereoPannerNode's documented formula. */
function panGains(pan: number): { l: number; r: number } {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return { l: Math.cos(angle), r: Math.sin(angle) };
}

/**
 * Fade + hold envelope identical in structure to scheduleClip()'s
 * automation: 0 → linRamp(g, at+fadeIn) → hold → linRamp(0, at+dur).
 */
function faderEnvelope(out: Float32Array, at: number, frames: number, fadeIn: number, fadeOut: number, level: number): void {
  const fi = Math.max(1, Math.min(fadeIn, Math.floor(frames / 2)));
  const fo = Math.max(1, Math.min(fadeOut, Math.floor(frames / 2)));
  for (let i = 0; i < frames; i++) {
    let g = level;
    if (i < fi) g = (level * i) / fi;
    else if (i >= frames - fo) g = (level * (frames - 1 - i)) / Math.max(1, fo - 1);
    out[at + i] = g;
  }
}

/** Music-bus duck automation — Web Audio exponentialRamp semantics, sampled. */
function duckEnvelope(frameCount: number, sr: number, duck: DuckEvent[]): Float32Array {
  const env = new Float32Array(frameCount).fill(1);
  for (const d of duck) {
    const t0 = Math.round(d.at * sr);
    if (t0 >= frameCount) continue;
    const atk = Math.max(1, Math.round(d.attack * sr));
    const rel = Math.max(1, Math.round(d.release * sr));
    const floor = Math.max(0.05, 1 - Math.min(0.95, Math.max(0, d.depth)));
    for (let n = t0; n < frameCount; n++) env[n] = 1; // cancelScheduledValues + setValueAtTime(1, t0)
    for (let k = 0; k < atk && t0 + k < frameCount; k++) {
      env[t0 + k] = Math.pow(floor, k / atk);
    }
    const r0 = t0 + atk;
    const rEnd = r0 + rel;
    for (let n = r0; n < rEnd && n < frameCount; n++) {
      const x = (n - r0) / rel;
      env[n] = Math.pow(floor, 1 - x);
    }
    for (let n = rEnd; n < frameCount; n++) env[n] = 1;
  }
  return env;
}

/* ---------------------------------------------- deterministic FX proxies --
 * Linear, time-invariant stand-ins for the convolvers / sub chain. Their
 * exact frequency behaviour is irrelevant to the invariants — what matters
 * is they're SHARED per pass (one instance fed by the pass's own sources),
 * exactly like the master-chain topology.
 */

/** Single-pole feedback comb: y[n] = x[n-d] + a*y[n-d], then one-pole LP. */
function combVerb(input: Float32Array, out: Float32Array, delay: number, feedback: number, lpCoef: number): void {
  let lp = 0;
  for (let n = 0; n < input.length; n++) {
    const d = n - delay;
    const x = d >= 0 ? input[d] : 0;
    const yPrev = d >= 0 ? out[d] : 0;
    const v = x + yPrev * feedback;
    lp = lp * lpCoef + v * (1 - lpCoef);
    out[n] = lp;
  }
}

/** Low rumble proxy for the sub chain: LP → HP → soft saturation. */
function subChain(input: Float32Array, sr: number): Float32Array {
  const out = new Float32Array(input.length);
  const lpC = 1 - Math.exp((-2 * Math.PI * 118) / sr);
  const hpC = Math.exp((-2 * Math.PI * 22) / sr);
  let lp = 0;
  let hpPrev = 0;
  for (let n = 0; n < input.length; n++) {
    const x = input[n];
    lp = lp * (1 - lpC) + x * lpC;
    const hp = lp - hpPrev * hpC;
    hpPrev = lp;
    out[n] = Math.tanh(hp * 1.35) * 0.94;
  }
  return out;
}

/** One-pole helper used by the linear master stages. */
function shelf(input: Float32Array, out: Float32Array, coef: number, amount: number, low: boolean): void {
  let lp = 0;
  for (let n = 0; n < input.length; n++) {
    const x = input[n];
    lp = lp * (1 - coef) + x * coef;
    out[n] = low ? x + lp * amount : x + (x - lp) * amount;
  }
}

export interface KernelRender {
  L: Float32Array;
  R: Float32Array;
  placed: string[];
}

/**
 * Render one pass. Every pass — the mix reference and each stem — goes
 * through this single function with its own source subset, so summation
 * behaviour is structural, not wishful.
 */
export function renderKernelPass(spec: KernelPassSpec): KernelRender {
  const { frameCount, sampleRate: sr } = spec;
  const L = new Float32Array(frameCount);
  const R = new Float32Array(frameCount);
  const musicL = new Float32Array(frameCount);
  const musicR = new Float32Array(frameCount);
  const hitL = new Float32Array(frameCount);
  const hitR = new Float32Array(frameCount);
  const verbRoom = new Float32Array(frameCount);
  const verbHall = new Float32Array(frameCount);
  const verbCath = new Float32Array(frameCount);
  const subIn = new Float32Array(frameCount);
  const env = spec.duck.length ? duckEnvelope(frameCount, sr, spec.duck) : null;
  const placed: string[] = [];

  for (const src of spec.sources) {
    const dry = src.dry !== false;
    const verb = src.verb !== false;
    const sub = src.sub !== false;
    const buf = src.buffer;
    const nCh = buf.numberOfChannels;
    const srcData: Float32Array[] = [];
    for (let c = 0; c < 2; c++) srcData.push(buf.getChannelData(Math.min(c, nCh - 1)));
    const maxFrames = Math.max(0, Math.min(src.frameCount, buf.length - src.offsetSample));
    if (maxFrames <= 0) continue;
    const at = Math.max(0, src.atSample);
    const frames = Math.min(maxFrames, frameCount - at);
    if (frames <= 0) continue;
    placed.push(src.key);

    // dry signal through the fader envelope (mono sums if the source is mono)
    const mono = nCh === 1;
    const gains = panGains(src.pan);
    const fader = new Float32Array(frames);
    faderEnvelope(fader, 0, frames, src.fadeInSamples, src.fadeOutSamples, src.gain);
    const dL = new Float32Array(frames);
    const dR = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const s = srcData[0][src.offsetSample + i] + (mono ? 0 : srcData[1][src.offsetSample + i]);
      const g = fader[i] * (mono ? 0.5 : 1);
      dL[i] = s * g * gains.l;
      dR[i] = s * g * gains.r;
    }

    const isFull = src.subFull === true;
    const subFeed = src.subFeed ?? 0;
    const emitDry = dry && !isFull;
    for (let i = 0; i < frames; i++) {
      const n = at + i;
      if (emitDry) {
        if (src.isMusic) {
          musicL[n] += dL[i];
          musicR[n] += dR[i];
        } else {
          hitL[n] += dL[i];
          hitR[n] += dR[i];
        }
      }
      if (verb) {
        const s = src.verbSends ?? {};
        if (s.room) {
          verbRoom[n] += dL[i] * s.room;
        }
        if (s.hall) {
          verbHall[n] += dL[i] * s.hall;
        }
        if (s.cath) {
          verbCath[n] += dL[i] * s.cath;
        }
      }
      if (sub && (isFull || subFeed > 0)) {
        const tap = isFull ? dL[i] : dL[i] * subFeed;
        subIn[n] += tap;
      }
    }
  }

  // shared bus processing — one instance per pass, like the master chain
  const ducked = env ?? null;
  for (let n = 0; n < frameCount; n++) {
    const m = ducked ? ducked[n] : 1;
    L[n] = hitL[n] + musicL[n] * m;
    R[n] = hitR[n] + musicR[n] * m;
  }

  // reverb returns (mono proxy spread across the field like the IR's decorrelated channels)
  const roomRet = new Float32Array(frameCount);
  const hallRet = new Float32Array(frameCount);
  const cathRet = new Float32Array(frameCount);
  // proxy decay/lengths mirror the IR intent (room tight, cathedral huge) —
  // linear and shared per pass, which is all the algebra needs
  combVerb(verbRoom, roomRet, Math.round(sr * 0.006), 0.9, 0.42);
  combVerb(verbHall, hallRet, Math.round(sr * 0.021), 0.965, 0.3);
  combVerb(verbCath, cathRet, Math.round(sr * 0.048), 0.988, 0.18);
  for (let n = 0; n < frameCount; n++) {
    const wet = roomRet[n] * spec.master.roomMix * 0.95 + hallRet[n] * spec.master.hallMix * 0.95 + cathRet[n] * spec.master.cathMix * 0.9;
    L[n] += wet * 0.7071;
    R[n] += wet * 0.7071;
  }

  // sub chain (shared, nonlinear) — included when the pass owns it
  if (spec.subOut) {
    const sub = subChain(subIn, sr);
    const subGain = 0.55 + spec.master.subBoost * 1.15;
    for (let n = 0; n < frameCount; n++) {
      const v = sub[n] * subGain;
      L[n] += v * 0.5;
      R[n] += v * 0.5;
    }
  }

  // linear master stages: tilt shelf + M/S width + volume (stems keep these)
  const lOut = new Float32Array(frameCount);
  const rOut = new Float32Array(frameCount);
  shelf(L, lOut, 0.02, 0.2, true); // gentle 90 Hz shelf, +1.6 dB-ish
  shelf(R, rOut, 0.02, 0.2, true);
  const w = spec.master.width;
  for (let n = 0; n < frameCount; n++) {
    const mid = (lOut[n] + rOut[n]) * 0.5;
    const side = (lOut[n] - rOut[n]) * 0.5 * w;
    L[n] = (mid + side) * spec.master.volume;
    R[n] = (mid - side) * spec.master.volume;
  }
  return { L, R, placed };
}

/**
 * Build kernel sources straight from a planned pass plus a source-audio
 * resolver — so tests exercise the EXACT pass data the Web Audio executor
 * will consume. `layers` maps `sceneId/layerId` to a proxy buffer the test
 * supplies (voices are not reproducible in pure TS; their placement flags are).
 */
export function kernelSourcesForPass(
  pass: StemPassPlan,
  clipBuffers: Map<string, KernelBufferLike>,
  layerBuffers?: Map<string, { buffer: KernelBufferLike; verb?: { room?: number; hall?: number; cath?: number }; subFeed?: number }>,
): KernelSource[] {
  const sources: KernelSource[] = [];
  for (const p of pass.clips) {
    const buffer = clipBuffers.get(p.clipId);
    if (!buffer) continue;
    sources.push({
      key: `clip:${p.clipId}`,
      buffer,
      atSample: p.atSample,
      offsetSample: p.offsetSample,
      frameCount: p.frameCount,
      gain: p.gain,
      pan: p.pan,
      fadeInSamples: p.fadeInSamples,
      fadeOutSamples: p.fadeOutSamples,
      isMusic: p.isMusic,
      // offline clips schedule through scheduleClip which wires no sends
      verbSends: undefined,
      subFeed: 0,
      dry: true,
      verb: false,
      sub: false,
    });
  }
  if (layerBuffers) {
    for (const lr of pass.layers) {
      const proxy = layerBuffers.get(`${lr.sceneId}/${lr.layerId}`);
      if (!proxy) continue;
      sources.push({
        key: `layer:${lr.sceneId}/${lr.layerId}`,
        buffer: proxy.buffer,
        atSample: 0,
        offsetSample: 0,
        frameCount: proxy.buffer.length,
        gain: 1,
        pan: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        isMusic: !lr.subFull,
        verbSends: proxy.verb,
        subFeed: proxy.subFeed ?? 0,
        subFull: lr.subFull,
        dry: lr.dry,
        verb: lr.verb,
        sub: true,
      });
    }
  }
  return sources;
}
