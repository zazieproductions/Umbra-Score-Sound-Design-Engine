/* ==================================================================== *
 *  UMBRA · CLIP TRANSFORM ROUTING
 *
 *  Transform controls (rate, pitch, reverse, LP/HP, loop, slow modulation,
 *  reverb send, gain trim) must genuinely reach the shared audio graph.
 *  `scheduleClip` — used by BOTH the live monitor (audio.ts) and the
 *  offline bounce (render.ts) — applies clip.transform, so these helpers
 *  describe when the transform graph is engaged and how timeline offsets
 *  convert to buffer offsets at the clip's playback rate.
 *
 *  The Web Audio graph itself cannot run under Node; these tests lock the
 *  pure routing decisions, and the graph application is exercised by the
 *  shared scheduleClip call path in both engines.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import { clipBufferOffset, clipTransformRate, isTransformActive } from '../src/lib/clips';
import { HORROR_DRONE_TRANSFORM, NO_TRANSFORM } from '../src/lib/library/types';
import type { AudioClip, ClipProvider } from '../src/lib/types';

function clip(over: Partial<AudioClip> & { id: string }): AudioClip {
  return {
    id: over.id,
    name: 'transform target',
    audioId: `local-${over.id}`,
    url: 'blob:umbra',
    provider: 'library' as ClipProvider,
    start: 0,
    duration: 4,
    offset: 0.5,
    sourceDuration: 6,
    gain: 1,
    pan: 0,
    fadeIn: 0.1,
    fadeOut: 0.2,
    muted: false,
    solo: false,
    sampleRate: 44100,
    channels: 1,
    metadata: { provider: 'library' },
    createdAt: 1,
    version: 1,
    ...over,
  };
}

describe('isTransformActive', () => {
  it('treats no transform and the neutral spec as inactive', () => {
    expect(isTransformActive(undefined)).toBe(false);
    expect(isTransformActive(NO_TRANSFORM)).toBe(false);
  });

  it('is active when any audible field deviates from neutral', () => {
    expect(isTransformActive({ ...NO_TRANSFORM, playbackRate: 0.4 })).toBe(true);
    expect(isTransformActive({ ...NO_TRANSFORM, pitch: -12 })).toBe(true);
    expect(isTransformActive({ ...NO_TRANSFORM, reverse: true })).toBe(true);
    expect(isTransformActive({ ...NO_TRANSFORM, lowpassHz: 1200 })).toBe(true);
    expect(isTransformActive({ ...NO_TRANSFORM, slowModulate: 0.5 })).toBe(true);
    expect(isTransformActive(HORROR_DRONE_TRANSFORM)).toBe(true);
  });
});

describe('rate-aware offset conversion', () => {
  it('returns unit rate for clips with no transform', () => {
    const c = clip({ id: 'c' });
    expect(clipTransformRate(c)).toBe(1);
    expect(clipBufferOffset(2, c)).toBe(2);
  });

  it('scales buffer offsets by the playback rate for transformed clips', () => {
    const c = clip({ id: 'c', transform: { ...NO_TRANSFORM, playbackRate: 0.5 } });
    expect(clipTransformRate(c)).toBe(0.5);
    // 2 s of timeline consumes 1 s of buffer at 0.5×
    expect(clipBufferOffset(2, c)).toBe(1);
  });
});
