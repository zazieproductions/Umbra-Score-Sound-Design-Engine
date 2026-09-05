/* ==================================================================== *
 *  UMBRA · AUTONOMOUS VIDEO-ANALYSIS UNIT TESTS (pure, DOM-free)
 *
 *  Synthetic pixel grids drive the browser analyzer's pure functions and
 *  its injectable source interface. Nothing here touches a real video or
 *  the network — every assertion checks what the pixels actually show.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_GRID_H,
  ANALYSIS_GRID_W,
  analyzePixelSource,
  condenseEvents,
  detectMotionSignals,
  downscalePixels,
  frameFeatures,
  signalsToCandidates,
  type EventEnvironment,
  type PixelGrid,
  type VideoPixelSource,
} from '../src/lib/library/videoAnalysis';
import type { SoundEventCandidate } from '../src/lib/library/types';

/* --------------------------------------------------------- fixtures -- */

const W = ANALYSIS_GRID_W;
const H = ANALYSIS_GRID_H;

function rgbaFromGrid(luma: number[]): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = luma[i];
    data[i * 4 + 1] = luma[i];
    data[i * 4 + 2] = luma[i];
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H };
}

function grid(luma: number[]): PixelGrid {
  return downscalePixels(rgbaFromGrid(luma).data, W, H, W, H);
}

function emptyGrid(value = 30): PixelGrid {
  return grid(new Array(W * H).fill(value));
}

function bandGrid(shift: number, width = 6, bright = 200, base = 30): PixelGrid {
  const l = new Array(W * H).fill(base);
  for (let y = 0; y < H; y++) {
    for (let x = shift; x < Math.min(W, shift + width); x++) l[y * W + x] = bright;
  }
  return grid(l);
}

function framesTransient(fps = 8): PixelGrid[] {
  const out: PixelGrid[] = [];
  for (let i = 0; i < 4 * fps; i++) out.push(i === 16 || i === 17 ? bandGrid(0) : emptyGrid());
  return out;
}

function framesCadence(fps = 8, seconds = 3.2): PixelGrid[] {
  const out: PixelGrid[] = [];
  for (let i = 0; i < Math.floor(seconds * fps); i++) {
    const phase = i % 4;
    out.push(phase < 2 ? bandGrid(phase === 0 ? 0 : 6) : emptyGrid());
  }
  return out;
}

function featuresOf(frames: PixelGrid[], fps = 8, start = 0): ReturnType<typeof frameFeatures>[] {
  const fs: ReturnType<typeof frameFeatures>[] = [];
  let prev: PixelGrid | null = null;
  let ref: PixelGrid | null = null;
  frames.forEach((f, i) => {
    if (i % 24 === 0) ref = f;
    fs.push(frameFeatures(f, prev, ref, start + i / fps));
    prev = f;
  });
  return fs;
}

function sourceFrom(frames: PixelGrid[], fps = 8, startOffset = 0): VideoPixelSource {
  let t = 0;
  return {
    duration: frames.length / fps,
    async seek(abs: number) {
      t = abs;
    },
    grab() {
      const rel = Math.max(0, Math.min(frames.length / fps - 0.001, t - startOffset));
      const idx = Math.max(0, Math.min(frames.length - 1, Math.round(rel * fps)));
      const f = frames[idx];
      const data = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        data[i * 4] = f.luma[i];
        data[i * 4 + 1] = f.luma[i];
        data[i * 4 + 2] = f.luma[i];
        data[i * 4 + 3] = 255;
      }
      return { data, width: W, height: H };
    },
  };
}

const env = (over: Partial<EventEnvironment> = {}): EventEnvironment => ({
  sceneId: 'sc-test',
  sceneStart: 0,
  sceneEnd: 60,
  title: 'Test scene',
  tags: [],
  summary: '',
  ...over,
});

/* ------------------------------------------------------------ tests -- */

describe('pixel features are measured, never invented', () => {
  it('static frames produce zero motion and zero events', () => {
    const frames = Array.from({ length: 48 }, () => emptyGrid());
    const fs = featuresOf(frames);
    const signals = detectMotionSignals(fs, { fps: 8 });
    expect(signals).toEqual([]);
  });

  it('a transient burst registers at its real onset', () => {
    const fs = featuresOf(framesTransient());
    const signals = detectMotionSignals(fs, { fps: 8 });
    const t = signals.find((s) => s.kind === 'transient');
    expect(t).toBeDefined();
    expect(Math.abs(t!.start - 2.0)).toBeLessThanOrEqual(0.2);
    expect(t!.evidence.length).toBeGreaterThan(0);
  });

  it('a gait rhythm yields ordered, regular onsets', () => {
    const fs = featuresOf(framesCadence());
    const signals = detectMotionSignals(fs, { fps: 8 });
    const c = signals.find((s) => s.kind === 'cadence');
    expect(c).toBeDefined();
    expect(c!.onsets!.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < c!.onsets!.length; i++) {
      const gap = c!.onsets![i] - c!.onsets![i - 1];
      expect(gap).toBeGreaterThanOrEqual(0.3);
      expect(gap).toBeLessThanOrEqual(0.8);
    }
  });
});

describe('signal → candidate mapping stays honest', () => {
  it('names the role only when the scene names the source', () => {
    const fs = featuresOf(framesCadence());
    const signals = detectMotionSignals(fs, { fps: 8 });
    const named = signalsToCandidates(signals, env({ title: 'Concrete basement walk', tags: ['basement', 'concrete', 'footsteps', 'walking'] }));
    const steps = named.filter((e) => e.event === 'footstep');
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const e of steps) {
      expect(e.suggestedRole).toBe('FOOTSTEP');
      expect(e.query).toMatch(/footstep|step/i);
      expect(e.query).not.toMatch(/nightmare|scary|dark/i);
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThanOrEqual(0.92);
    }

    const ambiguous = signalsToCandidates(signals, env({ title: 'Interior', tags: ['room'] }));
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const e of ambiguous) {
      expect(e.confidence).toBeLessThanOrEqual(0.8);
      if (e.event !== 'room-tone') {
        expect(['BODY', 'MISC_FOLEY']).toContain(e.suggestedRole);
        expect(e.ambiguous).toBe(true);
      }
    }

    // A scene that NAMES the source never marks the candidates ambiguous.
    const named2 = signalsToCandidates(signals, env({ title: 'Basement corridor walk', tags: ['basement', 'footsteps', 'walking'] }));
    expect(named2.length).toBeGreaterThan(0);
    for (const e of named2) if (e.event === 'footstep') expect(e.ambiguous).not.toBe(true);
  });

  it('negative space produces no candidates at all', () => {
    const signals = detectMotionSignals(featuresOf(Array.from({ length: 120 }, () => emptyGrid())), { fps: 8 });
    const candidates = signalsToCandidates(signals, env({ title: 'Still room', tags: ['interior', 'quiet'] }));
    expect(candidates).toEqual([]);
  });

  it('dedupe/condense keeps one event per moment, bounded', () => {
    const mk = (id: string, timestamp: number, role: SoundEventCandidate['suggestedRole']): SoundEventCandidate => ({
      id,
      sceneId: 's',
      timestamp,
      event: 'footstep',
      confidence: 0.9,
      evidence: ['x'],
      suggestedRole: role,
      query: 'footstep concrete',
      altQueries: [],
    });
    const out = condenseEvents([mk('a', 1.0, 'FOOTSTEP'), mk('b', 1.05, 'FOOTSTEP'), mk('c', 1.4, 'FOOTSTEP'), mk('d', 2.0, 'DOOR')]);
    expect(out.map((e) => e.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('analyzePixelSource uses a bounded frame budget', () => {
  it('produces events at absolute scene time', async () => {
    const src = sourceFrom(framesCadence(), 8, 5);
    const r = await analyzePixelSource(src, env({ sceneStart: 5, title: 'Walk', tags: ['footsteps', 'walking'] }), { fps: 8, maxFrames: 64 });
    expect(r.available).toBe(true);
    expect(r.method).toBe('browser-pixel');
    const steps = r.events.filter((e) => e.event === 'footstep');
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const e of steps) expect(e.timestamp).toBeGreaterThanOrEqual(5);
  });

  it('never exceeds the frame cap', async () => {
    const src = sourceFrom(framesCadence(), 8);
    const r = await analyzePixelSource(src, env({ title: 'Walk', tags: ['walking'] }), { fps: 8, maxFrames: 12 });
    expect(r.frameCount).toBeLessThanOrEqual(12);
  });
});
