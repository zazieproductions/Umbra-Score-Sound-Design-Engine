/* ==================================================================== *
 *  RENDER CLOCK — §7 sync integrity
 *
 *  One authoritative seconds↔sample conversion for the whole delivery
 *  stack. These pin the awkward cases and prove there is no cumulative
 *  float drift by construction (absolute conversion, never accumulation).
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAIL,
  TAIL_PRESETS,
  deliverySpan,
  sampleToSec,
  secToSample,
  tailSamples,
  timecode,
  timecodeFileSafe,
} from '../src/lib/export/clock';

const SR = 48000;
const clock = { sampleRate: SR };

describe('delivery render clock', () => {
  it('converts awkward timestamps exactly to the documented sample grid', () => {
    expect(secToSample(18.4, clock)).toBe(883200);
    expect(secToSample(18.417, clock)).toBe(Math.round(18.417 * 48000));
    expect(secToSample(61.033, clock)).toBe(Math.round(61.033 * 48000));
    // 127.999 → one sample short of 128 s, deterministic
    expect(secToSample(127.999, clock)).toBe(Math.round(127.999 * 48000));
    expect(secToSample(127.999, clock)).toBe(6143952);
  });

  it('round-trips sample→second→sample for every supported rate', () => {
    for (const sr of [44100, 48000, 96000]) {
      const c = { sampleRate: sr };
      for (const t of [0, 0.001, 5.2, 18.4, 18.417, 60, 61.033, 127.999, 227.52, 3599.989]) {
        const n = secToSample(t, c);
        expect(secToSample(sampleToSec(n, c), c)).toBe(n);
      }
    }
  });

  it('computes every timeline position from absolute time — zero cumulative drift', () => {
    // 2000 successive 0.1 s events: accumulation would drift; absolute
    // conversion cannot. This is the anti-drift architectural guarantee.
    let acc = 0;
    for (let i = 1; i <= 2000; i++) {
      acc += 0.1;
      expect(secToSample(acc, clock)).toBe(secToSample(i * 0.1, clock));
    }
  });

  it('tail policy is deterministic and rate-exact', () => {
    expect(tailSamples(DEFAULT_TAIL, clock)).toBe(96000); // +2 s @ 48 k
    expect(tailSamples({ kind: 'exact' }, clock)).toBe(0);
    expect(tailSamples({ kind: 'picture_plus', seconds: 5 }, clock)).toBe(240000);
    expect(TAIL_PRESETS.map((t) => t.id)).toEqual(['exact', 'tail2', 'tail5']);
  });

  it('delivery span is picture length + tail in whole frames', () => {
    const span = deliverySpan(0, 242, DEFAULT_TAIL, clock);
    expect(span.frameCount).toBe(242 * 48000 + 96000);
    expect(span.endSample).toBe(span.startSample + span.frameCount);
    // a range scope shifts the origin, keeps grid alignment
    const r = deliverySpan(10.5, 40.0, { kind: 'picture_plus', seconds: 2 }, clock);
    expect(r.startSample).toBe(secToSample(10.5, clock));
    expect(r.frameCount).toBe(secToSample(42.0, clock) - r.startSample);
  });

  it('timecode is derived from the sample grid, with frames at project fps', () => {
    expect(timecode(18.4, { clock })).toBe('00:00:18.400');
    expect(timecode(18.4, { frames: true, fps: 24, clock })).toBe('00:00:18.400:09');
    expect(timecode(0, { clock })).toBe('00:00:00.000');
    expect(timecode(227.52, { clock })).toBe('00:03:47.520');
    expect(timecodeFileSafe(78.42, clock)).toBe('00-01-18-420');
    expect(timecode(-4, { clock })).toBe('00:00:00.000');
  });
});
