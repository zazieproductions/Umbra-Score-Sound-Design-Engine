/* ==================================================================== *
 *  UMBRA AUDIO QUALITY MEASUREMENT
 *
 *  Pure, deterministic, context-free analysis over rendered PCM
 *  (Float32Array channels). One source of truth for the measurable
 *  quality gates the task demands:
 *
 *    clipping · sample/true peak · crest factor · DC offset · silence ·
 *    subsonic buildup · stereo correlation · output stability.
 *
 *  Everything here is plain arithmetic — it runs identically in the
 *  browser (to meter a freshly rendered master) and in Node (to gate
 *  exports and stress-tests). No AudioContext, no mocks.
 *
 *  The same Catmull-Rom 4x oversampler is used by the export limiter
 *  (render.ts) so the reported true peak matches what the limiter saw.
 * ==================================================================== */

export type Severity = 'info' | 'warn' | 'fail';

export interface QualityFlag {
  code: string;
  severity: Severity;
  message: string;
}

export interface StabilityStats {
  /** standard deviation of gated short-term RMS levels, in dB */
  rmsStdDevDb: number;
  /** short-term RMS jumped around far more than material usually does */
  unstable: boolean;
  /** output keeps climbing into the last windows — runaway gain */
  runaway: boolean;
}

export interface SilenceStats {
  /** fraction of samples at/below -80 dBFS */
  ratio: number;
  /** peak below -60 dBFS — treated as intentional negative space */
  isSilent: boolean;
}

export interface QualityReport {
  channels: number;
  sampleRate: number;
  frames: number;
  seconds: number;
  /** highest absolute sample, dBFS */
  peakDb: number;
  /** 4x oversampled (Catmull-Rom) true peak, dBFS */
  truePeakDb: number;
  /** root-mean-square level, dBFS */
  rmsDb: number;
  /** true-peak to RMS ratio, dB — how much life the dynamics have */
  crestDb: number;
  /** DC component relative to full scale, dBFS */
  dcDb: number;
  /** absolute mean (linear) */
  dcLinear: number;
  /** energy below 20 Hz relative to full band, dB (lower = cleaner) */
  subsonicDb: number;
  /** samples at/above the clip threshold (≈ full scale) */
  clippedSamples: number;
  /** intersample peak reached full scale */
  intersampleClip: boolean;
  /** any non-finite sample (NaN / ±Inf) */
  nonFinite: boolean;
  /** integrated loudness, approximate ITU-R BS.1770 K-weighting */
  lufs: number;
  /** -1 .. 1 (1 = mono-identical, 0 = decorrelated, -1 = phase-flipped) */
  stereoCorrelation: number;
  silence: SilenceStats;
  stability: StabilityStats;
  flags: QualityFlag[];
  /** worst severity across flags ('pass' when none above info) */
  verdict: 'pass' | 'warn' | 'fail';
}

/* ------------------------------------------------------------- thresholds */

/** Samples at or above this linear magnitude are counted as clipped. */
export const CLIP_LINEAR = 0.9995;
/** DC at or above this dBFS level is flagged. */
export const DC_WARN_DB = -46;
export const DC_FAIL_DB = -38;
/** Subsonic (≤20 Hz) energy at or above this dB ratio is flagged. */
export const SUBSONIC_WARN_DB = -12;
export const SUBSONIC_FAIL_DB = -6;
/** Crest factor at or below this dB is flagged as over-squashed. */
export const CREST_WARN_DB = 6;
/** Integrated loudness below this is treated as intentional silence. */
export const SILENCE_LUFS_DB = -45;
export const SILENCE_PEAK_DB = -60;
/** Short-term RMS standard deviation at/above this is "unstable". Set well
 *  above natural horror contrast (transients legitimately swing levels) so
 *  the flag fires on genuinely erratic output, not on dynamic range. */
export const STABILITY_STDDEV_DB = 12;

const SUBSONIC_CUTOFF_HZ = 20;

/* --------------------------------------------------------------- primitives */

export function samplePeakLinear(ch: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function rmsLinear(ch: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return ch.length ? Math.sqrt(sum / ch.length) : 0;
}

export function dcLinear(ch: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += ch[i];
  return ch.length ? sum / ch.length : 0;
}

export function toDb(linear: number): number {
  return linear > 1e-7 ? 20 * Math.log10(linear) : -200;
}

/**
 * Catmull-Rom cubic interpolation at position t in [0,1) between x1 and x2,
 * flanked by x0 and x3. Used to reconstruct inter-sample peaks.
 */
function catmullRom(x0: number, x1: number, x2: number, x3: number, t: number): number {
  const a = -0.5 * x0 + 1.5 * x1 - 1.5 * x2 + 0.5 * x3;
  const b = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
  const c = -0.5 * x0 + 0.5 * x2;
  const d = x1;
  return ((a * t + b) * t + c) * t + d;
}

/**
 * 4x oversampled true-peak estimate. Linear interpolation cannot reveal
 * intersample peaks (its extrema are the samples themselves), so we
 * reconstruct with Catmull-Rom and take the largest absolute value at
 * quarter-sample steps. This is a conservative estimate, not a full
 * ITU-R BS.1770 meter — documented, not claimed otherwise.
 */
export function truePeakLinear(ch: Float32Array, oversample = 4): number {
  const n = ch.length;
  if (n === 0) return 0;
  if (n === 1) return Math.abs(ch[0]);
  let peak = 0;
  const at = (i: number) => (i < 0 ? ch[0] : i >= n ? ch[n - 1] : ch[i]);
  for (let i = 0; i < n - 1; i++) {
    const x0 = at(i - 1);
    const x1 = ch[i];
    const x2 = ch[i + 1];
    const x3 = at(i + 2);
    for (let s = 0; s < oversample; s++) {
      const t = s / oversample;
      const v = Math.abs(catmullRom(x0, x1, x2, x3, t));
      if (v > peak) peak = v;
    }
  }
  return peak;
}

export function countNonFinite(ch: Float32Array): number {
  let c = 0;
  for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) c++;
  return c;
}

export function stereoCorrelation(l: Float32Array, r: Float32Array): number {
  const n = Math.min(l.length, r.length);
  if (n === 0) return 1;
  let ml = 0;
  let mr = 0;
  for (let i = 0; i < n; i++) {
    ml += l[i];
    mr += r[i];
  }
  ml /= n;
  mr /= n;
  let num = 0;
  let dl = 0;
  let dr = 0;
  for (let i = 0; i < n; i++) {
    const a = l[i] - ml;
    const b = r[i] - mr;
    num += a * b;
    dl += a * a;
    dr += b * b;
  }
  const den = Math.sqrt(dl * dr);
  return den > 1e-12 ? num / den : 1;
}

/* ------------------------------------------------------------- biquad maths */

interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function highShelfCoeffs(f0: number, fs: number, dbGain: number): Coeffs {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = (sinw / 2) * Math.sqrt(2);
  const sqA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
  const b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha);
  const a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosw);
  const a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function highPassCoeffs(f0: number, fs: number, Q: number): Coeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function lowPassCoeffs(f0: number, fs: number, Q: number): Coeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/* --------------------------------------------------------------- loudness */

/**
 * Approximate ITU-R BS.1770 integrated loudness: K-weighting (high shelf
 * +4 dB @ 1.68 kHz, high-pass 38 Hz), 400 ms blocks, absolute then
 * relative gating. Returns LUFS.
 */
export function integratedLufs(chans: Float32Array[], fs: number): number {
  const n = chans[0].length;
  const block = Math.max(1, Math.round(fs * 0.4));
  const numBlocks = Math.max(1, Math.floor(n / block));
  const powers = new Float64Array(numBlocks);
  const H = highShelfCoeffs(1681.97, fs, 4);
  const L = highPassCoeffs(38.13, fs, 0.7071);

  for (let c = 0; c < chans.length; c++) {
    const x = chans[c];
    let hx1 = 0;
    let hx2 = 0;
    let hy1 = 0;
    let hy2 = 0;
    let lx1 = 0;
    let lx2 = 0;
    let ly1 = 0;
    let ly2 = 0;
    let blockSum = 0;
    let bi = 0;
    for (let i = 0; i < n; i++) {
      const s = x[i];
      const y = H.b0 * s + H.b1 * hx1 + H.b2 * hx2 - H.a1 * hy1 - H.a2 * hy2;
      hx2 = hx1;
      hx1 = s;
      hy2 = hy1;
      hy1 = y;
      const yb = L.b0 * y + L.b1 * lx1 + L.b2 * lx2 - L.a1 * ly1 - L.a2 * ly2;
      lx2 = lx1;
      lx1 = y;
      ly2 = ly1;
      ly1 = yb;
      blockSum += yb * yb;
      if ((i + 1) % block === 0) {
        powers[bi] += blockSum;
        blockSum = 0;
        bi++;
      }
    }
  }

  const absThresh = Math.pow(10, -70 / 10);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < numBlocks; i++) {
    const ms = powers[i] / block;
    if (ms >= absThresh) {
      sum += ms;
      cnt++;
    }
  }
  if (cnt === 0) return -70;
  const mean = sum / cnt;
  const relThresh = mean * Math.pow(10, -10 / 10);
  let sum2 = 0;
  let cnt2 = 0;
  for (let i = 0; i < numBlocks; i++) {
    const ms = powers[i] / block;
    if (ms >= absThresh && ms >= relThresh) {
      sum2 += ms;
      cnt2++;
    }
  }
  const final = cnt2 > 0 ? sum2 / cnt2 : mean;
  return -0.691 + 10 * Math.log10(Math.max(1e-12, final));
}

/* --------------------------------------------------------------- subsonic */

/**
 * Energy at/below SUBSONIC_CUTOFF_HZ relative to the full band, in dB.
 * A second-order lowpass accumulates the low band; the ratio is
 * 10*log10(lowEnergy / totalEnergy).
 */
export function subsonicRatioDb(ch: Float32Array, fs: number, cutoff = SUBSONIC_CUTOFF_HZ): number {
  const n = ch.length;
  if (n === 0) return -200;
  const lp = lowPassCoeffs(cutoff, fs, 0.7071);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let low = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const s = ch[i];
    const y = lp.b0 * s + lp.b1 * x1 + lp.b2 * x2 - lp.a1 * y1 - lp.a2 * y2;
    x2 = x1;
    x1 = s;
    y2 = y1;
    y1 = y;
    low += y * y;
    total += s * s;
  }
  if (total <= 1e-20) return -200;
  return 10 * Math.log10(low / total);
}

/* --------------------------------------------------------------- stability */

export function measureStability(ch: Float32Array, fs: number): StabilityStats {
  const win = Math.max(64, Math.round(fs * 0.5));
  const wins = Math.floor(ch.length / win);
  const rmsDb: number[] = [];
  for (let w = 0; w < wins; w++) {
    let sum = 0;
    const from = w * win;
    const to = from + win;
    for (let i = from; i < to; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / win);
    rmsDb.push(rms > 1e-7 ? 20 * Math.log10(rms) : -200);
  }
  if (rmsDb.length < 4) {
    return { rmsStdDevDb: 0, unstable: false, runaway: false };
  }
  // gate out near-silent windows so silence does not read as instability
  const gated = rmsDb.filter((v) => v > -50);
  // every window below the gate: this is silence (intentional negative space),
  // not erratic output — report it stable rather than flagging the meter's
  // own noise floor
  if (gated.length === 0) {
    return { rmsStdDevDb: 0, unstable: false, runaway: false };
  }
  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  const variance = gated.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gated.length;
  const stdDev = Math.sqrt(variance);

  // runaway: the tail keeps climbing well past the body
  const tail = rmsDb.slice(-3);
  const tailMax = Math.max(...tail);
  const body = rmsDb.slice(0, Math.max(1, rmsDb.length - 3));
  const bodyMed = [...body].sort((a, b) => a - b)[Math.floor(body.length / 2)];
  const runaway = tailMax > -20 && tailMax > bodyMed + 12;

  return {
    rmsStdDevDb: stdDev,
    unstable: stdDev >= STABILITY_STDDEV_DB,
    runaway,
  };
}

/* ------------------------------------------------------------------ analyse */

/**
 * Full measurement of a rendered master (1 or 2 channels). Returns a
 * structured report with a verdict; the same function the export path
 * uses, so a green export and a green report are the same fact.
 */
export function analyzeFloat(chans: Float32Array[], sampleRate: number): QualityReport {
  const frames = chans[0]?.length ?? 0;
  const seconds = frames / sampleRate;
  const flags: QualityFlag[] = [];

  let nonFinite = 0;
  let peak = 0;
  let truePeak = 0;
  let rms = 0;
  let dcAbs = 0;
  let subsonic = -200;
  let clipped = 0;

  for (const ch of chans) {
    nonFinite += countNonFinite(ch);
    const pk = samplePeakLinear(ch);
    if (pk > peak) peak = pk;
    const tp = truePeakLinear(ch);
    if (tp > truePeak) truePeak = tp;
    const r = rmsLinear(ch);
    if (r > rms) rms = r;
    const d = Math.abs(dcLinear(ch));
    if (d > dcAbs) dcAbs = d;
    const sub = subsonicRatioDb(ch, sampleRate);
    if (sub > subsonic) subsonic = sub;
    for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) >= CLIP_LINEAR) clipped++;
  }

  const peakDb = toDb(peak);
  const truePeakDb = toDb(truePeak);
  const rmsDb = toDb(rms);
  const crestDb = truePeakDb - rmsDb;
  const dcDb = toDb(dcAbs);
  const lufs = frames ? integratedLufs(chans, sampleRate) : -70;

  const silenceRatio = countBelow(chans, 1e-4) / Math.max(1, frames);
  const isSilent = peakDb < SILENCE_PEAK_DB;

  const correlation =
    chans.length >= 2 ? stereoCorrelation(chans[0], chans[1]) : 1;
  const stability = measureStability(chans[0], sampleRate);

  const intersampleClip = truePeak >= 1.0;

  if (nonFinite > 0) {
    flags.push({ code: 'NON_FINITE', severity: 'fail', message: `${nonFinite} non-finite sample(s) — output is broken` });
  }
  if (clipped > 0) {
    flags.push({ code: 'CLIPPED', severity: 'fail', message: `${clipped} sample(s) at full scale — hard clipping` });
  }
  if (intersampleClip) {
    flags.push({ code: 'INTERSAMPLE_CLIP', severity: 'fail', message: 'true peak reached 0 dBFS — intersample clipping on reconstruction' });
  }
  if (dcDb >= DC_FAIL_DB) {
    flags.push({ code: 'DC_OFFSET', severity: 'fail', message: `DC offset at ${dcDb.toFixed(1)} dBFS — audible thump / wasted headroom` });
  } else if (dcDb >= DC_WARN_DB) {
    flags.push({ code: 'DC_OFFSET', severity: 'warn', message: `DC offset at ${dcDb.toFixed(1)} dBFS` });
  }
  if (subsonic >= SUBSONIC_FAIL_DB) {
    flags.push({ code: 'SUBSONIC', severity: 'fail', message: `subsonic energy ${subsonic.toFixed(1)} dB below full band — low-end runaway` });
  } else if (subsonic >= SUBSONIC_WARN_DB) {
    flags.push({ code: 'SUBSONIC', severity: 'warn', message: `subsonic energy ${subsonic.toFixed(1)} dB below full band — check sub control` });
  }
  if (crestDb <= CREST_WARN_DB && !isSilent) {
    flags.push({ code: 'LOW_CREST', severity: 'warn', message: `crest factor ${crestDb.toFixed(1)} dB — dynamics heavily compressed` });
  }
  if (stability.unstable) {
    flags.push({ code: 'UNSTABLE', severity: 'warn', message: `short-term level varies ${stability.rmsStdDevDb.toFixed(1)} dB (σ) — check layer balance` });
  }
  if (stability.runaway) {
    flags.push({ code: 'RUNAWAY', severity: 'fail', message: 'output keeps rising into the tail — runaway gain' });
  }
  if (isSilent) {
    flags.push({ code: 'SILENT', severity: 'info', message: 'near-silent render — silence is a valid design decision' });
  }

  const verdict: QualityReport['verdict'] = flags.some((f) => f.severity === 'fail')
    ? 'fail'
    : flags.some((f) => f.severity === 'warn')
      ? 'warn'
      : 'pass';

  return {
    channels: chans.length,
    sampleRate,
    frames,
    seconds,
    peakDb,
    truePeakDb,
    rmsDb,
    crestDb,
    dcDb,
    dcLinear: dcAbs,
    subsonicDb: subsonic,
    clippedSamples: clipped,
    intersampleClip,
    nonFinite: nonFinite > 0,
    lufs,
    stereoCorrelation: correlation,
    silence: { ratio: silenceRatio, isSilent },
    stability,
    flags,
    verdict,
  };
}

function countBelow(chans: Float32Array[], threshold: number): number {
  let c = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) <= threshold) c++;
  return c;
}

/** Human-readable one-line summary for logs and QA output. */
export function formatReport(r: QualityReport): string {
  return (
    `peak ${r.peakDb.toFixed(2)} dBFS · true ${r.truePeakDb.toFixed(2)} dBTP · ` +
    `crest ${r.crestDb.toFixed(1)} dB · DC ${r.dcDb.toFixed(1)} dB · ` +
    `sub ${r.subsonicDb.toFixed(1)} dB · ${r.lufs.toFixed(1)} LUFS · ` +
    `verdict ${r.verdict.toUpperCase()}` +
    (r.flags.length ? ` [${r.flags.map((f) => f.code).join(', ')}]` : '')
  );
}
