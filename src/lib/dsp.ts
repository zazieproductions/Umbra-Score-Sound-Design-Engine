import { mulberry32 } from './prng';
import type { LayerKind } from './types';

/* ==================================================================== *
 *  UMBRA DSP CORE
 *  Shared primitives for the realtime engine and the offline renderer.
 *  Signal flow (per project):
 *
 *   voices ─┬─► channel strip (HP · bell · air shelf · pan · Haas width)
 *           │        └─► sends ─► room / stage / cathedral convolvers ─┐
 *           │                                                          │
 *   music layers ─► musicSum ─► duck (hit sidechain) ──────────────────┤
 *   hit layers   ─► hitSum ────────────────────────────────────────────┤
 *   sub layers   ─► sub bus ─► LP + octave + resonance + drive ────────┤
 *                                                                     ▼
 *   dynamics (tension macro) ─► glue comp ─► tape drive ─► tilt EQ
 *        ─► mid/side widener ─► (+ parallel exciter) ─► brickwall ─► out
 * ==================================================================== */

export interface MasterParams {
  volume: number;   // 0 .. 1.2
  drive: number;    // 0 .. 1   tape saturation
  width: number;    // 0 .. 1.8 mid/side width
  glue: number;     // 0 .. 1   bus compression
  ceiling: number;  // -6 .. 0  dBTP limiter ceiling
  subBoost: number; // 0 .. 1
  ducking: number;  // 0 .. 1   impact sidechain depth
  roomMix: number;  // 0 .. 1
  hallMix: number;  // 0 .. 1
  cathMix: number;  // 0 .. 1
  air: number;      // 0 .. 1   high shelf + exciter
}

export const DEFAULT_MASTER: MasterParams = {
  volume: 0.95,
  drive: 0.34,
  width: 1.3,
  glue: 0.5,
  ceiling: -1,
  subBoost: 0.55,
  ducking: 0.55,
  roomMix: 0.28,
  hallMix: 0.34,
  cathMix: 0.18,
  air: 0.38,
};

export function f32(n: number): Float32Array<ArrayBuffer> {
  return new Float32Array(new ArrayBuffer(n * 4));
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Asymmetric tanh transfer curve — tape-ish saturation with even harmonics. */
export function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = f32(n);
  const k = 1 + drive * 18;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const bias = 0.06 * drive;
    c[i] = (Math.tanh(k * (x + bias)) - Math.tanh(k * bias)) / Math.tanh(k);
  }
  return c;
}

/**
 * Full-wave rectifier — generates an octave-up harmonic for sub
 * reinforcement on small speakers.
 *
 * Maps silence to silence: the curve is a true |x| rectifier, so an idle
 * sub bus contributes no DC step. (The old |x|*2 - 1 mapping folded an idle
 * 0 V input up to -1 V full-scale DC, which thumped through the following
 * 95 Hz highpass as a subsonic pop at the start of every render.) The small
 * DC a *signal*'s |x| still carries is removed by that highpass downstream.
 * The octave-up fundamental is 6 dB lower than the offset variant (its
 * Fourier series is half of |x|*2-1's), so the octave gain downstream is
 * doubled to keep the reinforcement level.
 */
export function rectifyCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = f32(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.abs(x);
  }
  return c;
}

/* ------------------------------------------------- band-limited voices --- */

/**
 * How many harmonics fit under Nyquist for a fundamental at `freq`.
 * A naive oscillator with more partials than this would fold them back
 * into the audible band as inharmonic aliasing; the helper below caps
 * them so sustained pitched material stays clean.
 */
export function bandlimitedPartials(freq: number, sampleRate: number, maxPartials: number): number {
  if (!(freq > 0)) return 1;
  return Math.max(1, Math.min(maxPartials, Math.floor(sampleRate / 2 / freq) - 1));
}

/**
 * Build a PeriodicWave whose Fourier series matches an ideal sawtooth /
 * square / triangle, truncated at Nyquist. PeriodicWave normalisation
 * keeps the peak near unity, so these drop in where a raw oscillator was.
 */
export function makeBandlimitedWave(
  ctx: BaseAudioContext,
  type: 'sawtooth' | 'square' | 'triangle',
  freq: number,
  maxPartials = 96,
): PeriodicWave {
  const n = bandlimitedPartials(freq, ctx.sampleRate, maxPartials);
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    let a = 0;
    if (type === 'sawtooth') {
      a = 2 / (Math.PI * k);
    } else if (type === 'square') {
      a = k % 2 === 1 ? 4 / (Math.PI * k) : 0;
    } else {
      a = k % 2 === 1 ? (8 / (Math.PI * Math.PI * k * k)) * (k % 4 === 1 ? 1 : -1) : 0;
    }
    imag[k] = a;
  }
  return ctx.createPeriodicWave(real, imag);
}

export interface BandlimitedVoice {
  osc: OscillatorNode;
  /** Retune (with optional glide); rebuilds the wave only when the target moved >1%. */
  tune(target: number, when: number, glide: number): void;
}

export function bandlimitedOsc(
  ctx: BaseAudioContext,
  type: 'sawtooth' | 'square' | 'triangle',
  freq: number,
  maxPartials = 96,
): BandlimitedVoice {
  const osc = ctx.createOscillator();
  let builtFreq = freq;
  osc.setPeriodicWave(makeBandlimitedWave(ctx, type, freq, maxPartials));
  osc.frequency.value = freq;
  const tune = (target: number, when: number, glide: number) => {
    if (Math.abs(target - builtFreq) / builtFreq > 0.01) {
      builtFreq = target;
      try {
        osc.setPeriodicWave(makeBandlimitedWave(ctx, type, target, maxPartials));
      } catch {
        /* some engines reject re-setting a wave mid-flight; keep the old one */
      }
    }
    if (glide > 0) osc.frequency.setTargetAtTime(target, when, glide);
    else osc.frequency.setValueAtTime(target, when);
  };
  return { osc, tune };
}

/** Seeded pink-ish noise, stereo, decorrelated channels. */
export function makeNoise(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(seed + c * 7919);
    const d = buf.getChannelData(c);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      // 3-stage pinking filter
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
  }
  return buf;
}

export interface IROpts {
  seconds: number;
  decay: number;
  predelay: number;
  damp: number; // 0 dark .. 1 bright
  seed: number;
  reverse?: boolean;
  spread?: number;
}

/**
 * Procedural impulse response: early-reflection cluster + progressively
 * damped diffuse tail, decorrelated per channel. Sounds like a real space
 * rather than a noise burst.
 */
export function makeIR(ctx: BaseAudioContext, o: IROpts): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(sr * o.seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const spread = o.spread ?? 1;

  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(o.seed + c * 104729);
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = rnd() * 2 - 1;
      // time-varying one-pole lowpass: tail darkens as it decays
      const coef = Math.min(0.97, 0.18 + (1 - o.damp) * 0.55 + t / o.seconds * 0.42);
      lp = lp * coef + w * (1 - coef);
      const env = Math.exp(-t * o.decay) * (1 - t / o.seconds);
      d[i] = lp * env * 1.9;
    }
    // early reflections
    const taps = 14;
    for (let k = 0; k < taps; k++) {
      const pos = Math.floor((o.predelay + (0.004 + rnd() * 0.055) * spread * (1 + k * 0.35)) * sr);
      if (pos < len) d[pos] += (rnd() * 2 - 1) * (0.62 / (1 + k * 0.55));
    }
    if (o.reverse) {
      d.reverse();
      for (let i = 0; i < len; i++) d[i] *= Math.pow(i / len, 1.6);
    }
    // normalise
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak * 1.25;
  }
  return buf;
}

export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1,
  gain = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

export function gainNode(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** Kinds routed to the transient (un-ducked) bus so their punch survives. */
export const HIT_KINDS: LayerKind[] = ['impact', 'stinger', 'braam', 'percussion', 'brass'];
/** Kinds that feed the dedicated low-frequency bus. */
export const SUB_KINDS: LayerKind[] = ['sub'];
/** Kinds whose low end also taps the sub bus for extra LFE weight. */
export const BASS_KINDS: LayerKind[] = ['impact', 'braam', 'percussion', 'pulse', 'stinger'];

/* ------------------------------------------------------------- master --- */

export interface MasterChain {
  ctx: BaseAudioContext;
  sum: GainNode;
  musicSum: GainNode;
  hitSum: GainNode;
  duckGain: GainNode;
  subBus: GainNode;
  dynamics: GainNode;
  sendRoom: GainNode;
  sendHall: GainNode;
  sendCath: GainNode;
  reverseVerb: ConvolverNode;
  noise: AudioBuffer;
  spec: AnalyserNode;
  loud: AnalyserNode;
  out: GainNode;
  params: MasterParams;
  setParams(p: Partial<MasterParams>, when: number, glide: number): void;
  /** dip the music bed under a hit — theatrical "pump" */
  duck(when: number, depth: number, attack?: number, release?: number): void;
}

export function buildMaster(ctx: BaseAudioContext, params: MasterParams, quality: 'live' | 'render' = 'live'): MasterChain {
  const p: MasterParams = { ...params };
  const noise = makeNoise(ctx, 5, 20240);

  const sum = gainNode(ctx, 1);
  const musicSum = gainNode(ctx, 1);
  const duckGain = gainNode(ctx, 1);
  const hitSum = gainNode(ctx, 1);
  const dynamics = gainNode(ctx, 1);
  musicSum.connect(duckGain);
  duckGain.connect(sum);
  hitSum.connect(sum);

  /*
   * Working headroom. A full procedural stack (drone + sub + ambience + …
   * through the sub bus and three reverbs) can sum close to full scale on its
   * own; padding the mix down before the dynamics stage keeps the glue/tape/
   * limiter stages out of the flat-top region and leaves real room for the
   * loudness stage. This is gain *staging*, not a limiter: it scales every
   * layer equally, so relative balance and dynamics are untouched.
   */
  const headroom = gainNode(ctx, dbToGain(-6));

  /* --- sub bus: lowpass + rectified octave + resonance + drive --------- */
  const subBus = gainNode(ctx, 1);
  const subLP = biquad(ctx, 'lowpass', 118, 0.9);
  const subHP = biquad(ctx, 'highpass', 24, 0.7);
  const subDrive = ctx.createWaveShaper();
  subDrive.curve = driveCurve(0.35);
  subDrive.oversample = '4x';
  const subGain = gainNode(ctx, 1);
  const subRes = biquad(ctx, 'peaking', 46, 0.9, 2.5); // resonant weight (tamed by setParams)
  subBus.connect(subLP);
  subLP.connect(subHP);
  subHP.connect(subDrive);
  subDrive.connect(subGain);
  subGain.connect(subRes);
  subRes.connect(sum);

  // psychoacoustic octave-up so the weight survives small speakers
  const octBP = biquad(ctx, 'bandpass', 78, 1.1);
  const oct = ctx.createWaveShaper();
  oct.curve = rectifyCurve();
  const octHP = biquad(ctx, 'highpass', 95, 0.8);
  const octGain = gainNode(ctx, 0.4); // doubles the offset-free rectifier (see rectifyCurve)
  subBus.connect(octBP);
  octBP.connect(oct);
  oct.connect(octHP);
  octHP.connect(octGain);
  octGain.connect(sum);

  /* --- reverb buses ----------------------------------------------------- */
  const mk = (o: IROpts, hp: number) => {
    const send = gainNode(ctx, 1);
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = makeIR(ctx, o);
    const cut = biquad(ctx, 'highpass', hp, 0.7);
    const tame = biquad(ctx, 'lowshelf', 260, 0.7, -3);
    const ret = gainNode(ctx, 0.3);
    send.connect(conv);
    conv.connect(cut);
    cut.connect(tame);
    tame.connect(ret);
    ret.connect(sum);
    return { send, ret };
  };

  const room = mk({ seconds: 0.85, decay: 5.4, predelay: 0.006, damp: 0.62, seed: 11, spread: 0.5 }, 190);
  const hall = mk({ seconds: quality === 'live' ? 3.1 : 3.6, decay: 2.3, predelay: 0.021, damp: 0.5, seed: 29, spread: 1 }, 170);
  const cath = mk({ seconds: quality === 'live' ? 4.4 : 6.2, decay: 1.05, predelay: 0.048, damp: 0.32, seed: 47, spread: 1.7 }, 140);

  // reverse-bloom convolver used by impacts / risers for pre-swell tails
  const reverseVerb = ctx.createConvolver();
  reverseVerb.normalize = true;
  reverseVerb.buffer = makeIR(ctx, { seconds: 1.6, decay: 1.6, predelay: 0, damp: 0.45, seed: 71, reverse: true });
  const revRet = gainNode(ctx, 0.55);
  reverseVerb.connect(revRet);
  revRet.connect(sum);

  /* --- master bus processing ------------------------------------------- */
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 14;
  glue.ratio.value = 2.4;
  glue.attack.value = 0.018;
  glue.release.value = 0.24;

  const satIn = gainNode(ctx, 1);
  const shaper = ctx.createWaveShaper();
  shaper.curve = driveCurve(p.drive);
  shaper.oversample = '4x';
  const satWet = gainNode(ctx, p.drive * 0.6);
  const satDry = gainNode(ctx, 1 - p.drive * 0.35);
  const satMix = gainNode(ctx, 1);
  satIn.connect(shaper);
  shaper.connect(satWet);
  satWet.connect(satMix);
  satIn.connect(satDry);
  satDry.connect(satMix);

  const lowShelf = biquad(ctx, 'lowshelf', 90, 0.7, 1.6);
  const mudCut = biquad(ctx, 'peaking', 320, 1.1, -1.8);
  const airShelf = biquad(ctx, 'highshelf', 8200, 0.7, p.air * 5);

  /* --- mid/side widener ------------------------------------------------- */
  const split = ctx.createChannelSplitter(2);
  const mid = gainNode(ctx, 1);
  const side = gainNode(ctx, 1);
  const lToMid = gainNode(ctx, 0.5);
  const rToMid = gainNode(ctx, 0.5);
  const lToSide = gainNode(ctx, 0.5);
  const rToSide = gainNode(ctx, -0.5);
  split.connect(lToMid, 0);
  split.connect(rToMid, 1);
  split.connect(lToSide, 0);
  split.connect(rToSide, 1);
  lToMid.connect(mid);
  rToMid.connect(mid);
  lToSide.connect(side);
  rToSide.connect(side);
  const sideW = gainNode(ctx, p.width);
  side.connect(sideW);
  const outL = gainNode(ctx, 1);
  const outR = gainNode(ctx, 1);
  const sideNeg = gainNode(ctx, -1);
  mid.connect(outL);
  mid.connect(outR);
  sideW.connect(outL);
  sideW.connect(sideNeg);
  sideNeg.connect(outR);
  const merge = ctx.createChannelMerger(2);
  outL.connect(merge, 0, 0);
  outR.connect(merge, 0, 1);

  /* --- parallel exciter: adds sheen to the mid channel ------------------ */
  const exciteIn = gainNode(ctx, 1);
  const exciteHP = biquad(ctx, 'highpass', 6500, 0.7);
  const exciteShaper = ctx.createWaveShaper();
  exciteShaper.curve = driveCurve(0.22);
  exciteShaper.oversample = '4x';
  const exciteGain = gainNode(ctx, 0);
  satMix.connect(exciteIn);
  exciteIn.connect(exciteHP);
  exciteHP.connect(exciteShaper);
  exciteShaper.connect(exciteGain);
  exciteGain.connect(mid);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = p.ceiling - 0.4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.0012;
  limiter.release.value = 0.055;

  // Final DC / subsonic hygiene: a 12 Hz highpass removes any residual DC
  // or inaudible low-end pile-up before the brickwall. Inaudible to the
  // score, but it keeps the limiter and downstream codecs honest.
  const dcBlock = biquad(ctx, 'highpass', 12, 0.707);

  const out = gainNode(ctx, p.volume);
  const spec = ctx.createAnalyser();
  spec.fftSize = 512;
  spec.smoothingTimeConstant = 0.72;
  const loud = ctx.createAnalyser();
  loud.fftSize = 2048;

  sum.connect(headroom);
  headroom.connect(dynamics);
  dynamics.connect(glue);
  glue.connect(satIn);
  satMix.connect(lowShelf);
  lowShelf.connect(mudCut);
  mudCut.connect(airShelf);
  airShelf.connect(split);
  merge.connect(dcBlock);
  dcBlock.connect(limiter);
  limiter.connect(out);
  out.connect(spec);
  out.connect(loud);
  out.connect(ctx.destination);

  let duckLevel = 1;
  let curveDrive = p.drive;

  const setParams = (patch: Partial<MasterParams>, when: number, glide: number) => {
    Object.assign(p, patch);
    const set = (param: AudioParam, v: number) => {
      if (glide > 0) param.setTargetAtTime(v, when, glide);
      else param.setValueAtTime(v, when);
    };
    set(out.gain, p.volume);
    set(satWet.gain, p.drive * 0.62);
    set(satDry.gain, 1 - p.drive * 0.32);
    if (patch.drive !== undefined && patch.drive !== curveDrive) {
      curveDrive = p.drive;
      shaper.curve = driveCurve(p.drive);
    }
    set(sideW.gain, p.width);
    set(glue.threshold, -12 - p.glue * 14);
    set(glue.ratio, 1.3 + p.glue * 2.6);
    set(limiter.threshold, p.ceiling - 0.4);
    set(subGain.gain, 0.5 + p.subBoost * 0.95);
    set(subRes.gain, p.subBoost * 3);
    set(octGain.gain, p.subBoost * 0.6);
    set(room.ret.gain, p.roomMix * 0.95);
    set(hall.ret.gain, p.hallMix * 0.95);
    set(cath.ret.gain, p.cathMix * 0.9);
    set(airShelf.gain, -1 + p.air * 6.5);
    set(exciteGain.gain, p.air * 0.22);
  };
  setParams(p, ctx.currentTime, 0);

  const duck = (when: number, depth: number, attack = 0.008, release = 0.3) => {
    const g = duckGain.gain;
    const t = Math.max(0, when);
    const d = Math.min(0.95, Math.max(0, depth));
    g.cancelScheduledValues(t);
    g.setValueAtTime(duckLevel, t);
    const floor = Math.max(0.05, 1 - d);
    g.exponentialRampToValueAtTime(floor, t + attack);
    g.exponentialRampToValueAtTime(1, t + attack + release);
    duckLevel = 1;
  };

  return {
    ctx,
    sum,
    musicSum,
    hitSum,
    duckGain,
    subBus,
    dynamics,
    sendRoom: room.send,
    sendHall: hall.send,
    sendCath: cath.send,
    reverseVerb,
    noise,
    spec,
    loud,
    out,
    params: p,
    setParams,
    duck,
  };
}

/* ------------------------------------------------------------ channel --- */

export interface Channel {
  m: MasterChain;
  input: GainNode;
  hp: BiquadFilterNode;
  bell: BiquadFilterNode;
  airEq: BiquadFilterNode;
  pan: StereoPannerNode;
  wideGain: GainNode;
  widePan: StereoPannerNode;
  fader: GainNode;
  meter: AnalyserNode;
  meterBuf: Float32Array<ArrayBuffer>;
  sendRoom: GainNode;
  sendHall: GainNode;
  sendCath: GainNode;
  subFeed: GainNode;
  dispose(): void;
}

export function buildChannel(m: MasterChain, kind: LayerKind, seed = 0): Channel {
  const ctx = m.ctx;
  const input = gainNode(ctx, 1);
  const hp = biquad(ctx, 'highpass', 24, 0.7);
  const bell = biquad(ctx, 'peaking', 1200, 1, 0);
  const airEq = biquad(ctx, 'highshelf', 6500, 0.7, 0);
  const pan = ctx.createStereoPanner();
  const fader = gainNode(ctx, 0);
  const meter = ctx.createAnalyser();
  meter.fftSize = 256;

  // Haas decorrelation path for immersive width on sustained material.
  // Seeded so the monitor and the bounce build the identical delay offset.
  const haasRnd = mulberry32(seed >>> 0);
  const wideDelay = ctx.createDelay(0.05);
  wideDelay.delayTime.value = 0.009 + haasRnd() * 0.012;
  const wideGain = gainNode(ctx, 0);
  const widePan = ctx.createStereoPanner();
  const wideTilt = biquad(ctx, 'highpass', 220, 0.7);

  input.connect(hp);
  hp.connect(bell);
  bell.connect(airEq);
  airEq.connect(pan);
  pan.connect(fader);

  airEq.connect(wideDelay);
  wideDelay.connect(wideTilt);
  wideTilt.connect(wideGain);
  wideGain.connect(widePan);
  widePan.connect(fader);

  const sendRoom = gainNode(ctx, 0);
  const sendHall = gainNode(ctx, 0);
  const sendCath = gainNode(ctx, 0);
  const subFeed = gainNode(ctx, 0);

  fader.connect(meter);
  if (SUB_KINDS.includes(kind)) {
    fader.connect(m.subBus);
  } else if (HIT_KINDS.includes(kind)) {
    fader.connect(m.hitSum);
  } else {
    fader.connect(m.musicSum);
  }
  fader.connect(sendRoom);
  fader.connect(sendHall);
  fader.connect(sendCath);
  fader.connect(subFeed);
  sendRoom.connect(m.sendRoom);
  sendHall.connect(m.sendHall);
  sendCath.connect(m.sendCath);
  subFeed.connect(m.subBus);

  return {
    m,
    input,
    hp,
    bell,
    airEq,
    pan,
    wideGain,
    widePan,
    fader,
    meter,
    meterBuf: f32(256),
    sendRoom,
    sendHall,
    sendCath,
    subFeed,
    dispose() {
      [input, hp, bell, airEq, pan, fader, sendRoom, sendHall, sendCath, subFeed, wideGain, widePan, wideDelay, wideTilt, meter].forEach(
        (n) => {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        },
      );
    },
  };
}
