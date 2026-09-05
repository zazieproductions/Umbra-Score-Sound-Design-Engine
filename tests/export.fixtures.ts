/* ==================================================================== *
 *  Export-subsystem test fixtures
 *
 *  Small deterministic builders for Projects / AudioClips / layers and
 *  plain-object AudioBuffers for the reference kernel. No audio engine,
 *  no network — everything here is pure data.
 * ==================================================================== */

import type { AudioClip, Layer, Project, Scene } from '../src/lib/types';
import type { KernelBufferLike } from '../src/lib/export';

let seq = 0;

export function mkLayer(kind: Layer['kind'], over: Partial<Layer> = {}): Layer {
  const id = `L${++seq}`;
  return {
    id,
    name: `${kind}-${id}`,
    kind,
    model: 'test',
    gain: 0.6,
    pan: 0,
    reverb: 0.3,
    space: 'hall',
    width: 0.4,
    tone: 0.5,
    intensity: 0.6,
    attack: 0.3,
    root: 55,
    muted: false,
    solo: false,
    seed: 42,
    version: 1,
    ...over,
  };
}

export function mkScene(start: number, end: number, layers: Layer[], over: Partial<Scene> = {}): Scene {
  const id = over.id ?? `S${++seq}`;
  return {
    id,
    index: 0,
    start,
    end,
    title: `scene ${id}`,
    frame: '',
    tags: [],
    tension: 0.5,
    motion: 0.5,
    summary: '',
    status: 'ready',
    hits: [],
    layers,
    ...over,
  };
}

export function mkClip(over: Partial<AudioClip> = {}): AudioClip {
  const id = over.id ?? `C${++seq}`;
  return {
    id,
    name: `clip-${id}`,
    audioId: `audio-${id}`,
    url: `blob:/${id}.wav`,
    provider: 'library',
    start: 0,
    duration: 1,
    offset: 0,
    sourceDuration: 5,
    gain: 1,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    solo: false,
    sampleRate: 48000,
    channels: 1,
    metadata: { provider: 'library' },
    createdAt: 0,
    version: 1,
    ...over,
  };
}

export function mkProject(clips: AudioClip[], scenes: Scene[] = [], over: Partial<Project> = {}): Project {
  const duration = over.duration ?? Math.max(1, ...clips.map((c) => c.start + c.duration), ...scenes.map((s) => s.end));
  return {
    id: `P${++seq}`,
    name: over.name ?? 'Test Reel.mp4',
    source: 'test',
    duration,
    fps: 24,
    resolution: '1920x1080',
    videoUrl: over.videoUrl ?? 'blob:/video.mp4',
    scenes,
    clips,
    spotting: [],
    createdAt: 0,
    ...over,
  };
}

/* ------------------------------------------------------- kernel audio -- */

/**
 * Buffer of `frames` samples with impulses at the given indices (relative
 * to the buffer start). Impulses are easy to locate to the sample, which is
 * exactly what sync tests need.
 */
export function impulseBuffer(atSamples: number[], frames: number, amp = 1, sr = 48000, channels = 1): KernelBufferLike {
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const d = new Float32Array(frames);
    for (const i of atSamples) if (i >= 0 && i < frames) d[i] = amp;
    data.push(d);
  }
  return {
    sampleRate: sr,
    length: frames,
    numberOfChannels: channels,
    getChannelData: (c: number) => data[Math.min(c, data.length - 1)],
  };
}

/** Constant block, useful for length assertions. */
/** Deterministic PRNG noise fill — sustained excitation so reverb tails have
 *  something to ring from (impulses decay too fast to prove tail continuity). */
export function noiseBuffer(frames: number, amp = 0.2, channels = 1): KernelBufferLike {
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const d = new Float32Array(frames);
    let x = 0x9e3779b9 ^ c;
    for (let i = 0; i < frames; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      d[i] = amp * ((x / 0xffffffff) * 2 - 1);
    }
    data.push(d);
  }
  return {
    sampleRate: 48000,
    length: frames,
    numberOfChannels: channels,
    getChannelData: (c: number) => data[Math.min(c, data.length - 1)],
  };
}

export function toneBuffer(frames: number, value = 0.25, sr = 48000, channels = 1): KernelBufferLike {
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(frames).fill(value));
  return { sampleRate: sr, length: frames, numberOfChannels: channels, getChannelData: (c: number) => data[Math.min(c, data.length - 1)] };
}

/** First index in [from,to) where |x| > eps; -1 when the range is clean. */
export function firstNonZero(x: Float32Array, from = 0, to = x.length, eps = 0): number {
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) if (Math.abs(x[i]) > eps) return i;
  return -1;
}

/** Sum stems in float64 — the reference arithmetic is deliberately higher
 *  precision than the kernels', so residuals measure kernel rounding only. */
export function sumStems(stems: { L: Float32Array; R: Float32Array }[]): { L: Float64Array; R: Float64Array } {
  const n = stems[0].L.length;
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  for (const s of stems) {
    for (let i = 0; i < n; i++) {
      L[i] += s.L[i];
      R[i] += s.R[i];
    }
  }
  return { L, R };
}

export function maxAbsDiff(a: { length: number; [i: number]: number }, b: { length: number; [i: number]: number }): number {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

export function rms(a: { length: number; [i: number]: number }): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

/** Default clock used across the export tests. */
export const SR = 48000;

export function planOptions() {
  return { fileName: (_folder: string, key: string, ext: string) => `UMBRA_TEST_${key}.${ext}` };
}
