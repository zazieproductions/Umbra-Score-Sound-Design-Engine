/* ==================================================================== *
 *  UMBRA · AUDIO QUALITY MEASUREMENT UNIT TESTS
 *
 *  Pure, deterministic arithmetic over Float32Array PCM — no AudioContext,
 *  no mocks. These pin the measurement gates the export path uses:
 *  clipping, true peak, crest, DC, silence, subsonic, stability, verdicts.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  analyzeFloat,
  dcLinear,
  integratedLufs,
  rmsLinear,
  samplePeakLinear,
  stereoCorrelation,
  subsonicRatioDb,
  truePeakLinear,
  type QualityReport,
} from '../src/lib/quality';
import { bandlimitedPartials, driveCurve, rectifyCurve } from '../src/lib/dsp';

const SR = 48000;

function sine(freq: number, amp: number, seconds = 1, sr = SR): Float32Array {
  const out = new Float32Array(sr * seconds);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

describe('level primitives', () => {
  it('sample peak, RMS and DC of a known sine', () => {
    const ch = sine(1000, 0.5);
    expect(samplePeakLinear(ch)).toBeCloseTo(0.5, 3);
    expect(rmsLinear(ch)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(dcLinear(ch)).toBeCloseTo(0, 2);
  });

  it('reports a DC component', () => {
    const ch = new Float32Array(1000).fill(0.1);
    expect(dcLinear(ch)).toBeCloseTo(0.1, 5);
    expect(samplePeakLinear(ch)).toBeCloseTo(0.1, 5);
  });

  it('stereo correlation: identical in-phase is 1, flipped is -1', () => {
    const a = sine(500, 0.5, 0.1);
    const b = new Float32Array(a).map((v) => -v);
    expect(stereoCorrelation(a, a)).toBeCloseTo(1, 5);
    expect(stereoCorrelation(a, b)).toBeCloseTo(-1, 5);
  });
});

describe('true peak (inter-sample)', () => {
  it('a step edge overshoots its sample peak on reconstruction', () => {
    // a 0 → 1 step: the samples peak at 1.0 but the cubic reconstruction
    // rings slightly above 1.0 between samples
    const ch = new Float32Array(1000);
    for (let i = 200; i < 400; i++) ch[i] = 1.0;
    const tp = truePeakLinear(ch);
    expect(tp).toBeGreaterThan(1.0);
    expect(samplePeakLinear(ch)).toBe(1.0);
  });

  it('a smooth sine never exceeds its sample peak', () => {
    const ch = sine(1000, 1.0);
    expect(truePeakLinear(ch)).toBeLessThanOrEqual(1.0 + 1e-4);
  });
});

describe('integrated loudness (approximate BS.1770)', () => {
  it('measures a -20 dBFS sine at ~-23 LUFS (RMS is 3 dB below peak)', () => {
    const lufs = integratedLufs([sine(1000, Math.pow(10, -20 / 20), 2)], SR);
    expect(lufs).toBeGreaterThan(-24);
    expect(lufs).toBeLessThan(-22);
  });

  it('returns -70 for silence', () => {
    expect(integratedLufs([new Float32Array(SR)], SR)).toBe(-70);
  });
});

describe('subsonic ratio', () => {
  it('a 1 kHz sine has negligible subsonic energy', () => {
    expect(subsonicRatioDb(sine(1000, 0.5, 2), SR)).toBeLessThan(-50);
  });

  it('a 10 Hz sine is almost entirely subsonic', () => {
    expect(subsonicRatioDb(sine(10, 0.5, 2), SR)).toBeGreaterThan(-6);
  });
});

describe('analyzeFloat verdicts', () => {
  it('a clean, dynamic signal passes', () => {
    // three non-harmonic partials at varied levels → realistic crest, no DC
    const ch = new Float32Array(SR);
    for (let i = 0; i < ch.length; i++) {
      const t = i / SR;
      ch[i] = 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.15 * Math.sin(2 * Math.PI * 554.37 * t) + 0.1 * Math.sin(2 * Math.PI * 659.26 * t);
    }
    const r = analyzeFloat([ch], SR);
    expect(r.verdict).toBe('pass');
    expect(r.clippedSamples).toBe(0);
    expect(r.nonFinite).toBe(false);
  });

  it('hard clipping fails with the CLIPPED flag', () => {
    const ch = sine(1000, 2.0); // amplitudes exceed full scale
    const r = analyzeFloat([ch], SR);
    expect(r.clippedSamples).toBeGreaterThan(0);
    expect(r.verdict).toBe('fail');
    expect(r.flags.some((f) => f.code === 'CLIPPED')).toBe(true);
  });

  it('a DC-offset signal fails on DC', () => {
    const ch = new Float32Array(SR).fill(0.5);
    const r = analyzeFloat([ch], SR);
    expect(r.dcDb).toBeGreaterThan(-40);
    expect(r.verdict).toBe('fail');
    expect(r.flags.some((f) => f.code === 'DC_OFFSET')).toBe(true);
  });

  it('silence is flagged informational, not a failure', () => {
    const r = analyzeFloat([new Float32Array(SR)], SR);
    expect(r.silence.isSilent).toBe(true);
    expect(r.verdict).toBe('pass');
    expect(r.flags.some((f) => f.code === 'SILENT')).toBe(true);
  });

  it('non-finite samples fail loudly', () => {
    const ch = sine(1000, 0.2);
    ch[100] = NaN;
    const r = analyzeFloat([ch], SR);
    expect(r.nonFinite).toBe(true);
    expect(r.verdict).toBe('fail');
    expect(r.flags.some((f) => f.code === 'NON_FINITE')).toBe(true);
  });

  it('measures crest factor as true-peak to RMS', () => {
    const r = analyzeFloat([sine(1000, 0.2)], SR) as QualityReport;
    // sine crest ≈ 3 dB
    expect(r.crestDb).toBeGreaterThan(2);
    expect(r.crestDb).toBeLessThan(4);
  });
});

describe('band-limited oscillator maths', () => {
  it('caps partials at Nyquist', () => {
    // 220 Hz @ 48 kHz → floor(24000/220) - 1 = 108 partials
    expect(bandlimitedPartials(220, 48000, 128)).toBe(108);
  });

  it('never returns more partials than the cap', () => {
    expect(bandlimitedPartials(55, 48000, 96)).toBe(96);
  });

  it('clamps to at least one partial', () => {
    expect(bandlimitedPartials(20000, 48000, 96)).toBe(1);
  });
});

describe('transfer curves', () => {
  it('driveCurve passes through (near) zero with no DC offset at the centre', () => {
    const c = driveCurve(0.4);
    expect(c.length).toBe(4096);
    const mid = Math.floor(c.length / 2);
    // the sample grid doesn't land exactly on x=0 for an even curve length
    expect(Math.abs(c[mid])).toBeLessThan(0.01);
    // monotonic non-decreasing across the curve
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1] - 1e-7);
  });

  it('rectifyCurve full-wave rectifies and passes silence through', () => {
    const c = rectifyCurve();
    expect(c.length).toBe(1024);
    const mid = Math.floor(c.length / 2);
    expect(c[0]).toBeCloseTo(1, 5); // x=-1 → |x| = 1
    // n=1024 is even, so the grid straddles x=0 (|x| ≈ 9.8e-4 at the centre)
    expect(c[mid]).toBeLessThan(0.001);
    expect(c[c.length - 1]).toBeCloseTo(1, 5); // x=1 → 1
    // every output is non-negative — a true full-wave rectifier
    for (let i = 0; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(0);
  });
});
