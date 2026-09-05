/* ==================================================================== *
 *  CLIP ENGINE
 *  Real decoded audio on the Umbra timeline.
 *
 *  Generated audio is NOT played by a separate preview widget. It is
 *  decoded into AudioBuffers and scheduled into exactly the same graph as
 *  the procedural voices — same master chain, same ducking, same limiter,
 *  same offline bounce. A clip therefore moves, trims, fades, mutes, solos
 *  and exports like any other timeline object, and whatever you hear in
 *  the monitor is what lands in the exported master.
 * ==================================================================== */

import { biquad, gainNode, type MasterChain } from './dsp';
import type { AudioClip, ClipProvider } from './types';

/* ------------------------------------------------------------ decode cache */

const bufferCache = new Map<string, AudioBuffer>();
const pending = new Map<string, Promise<AudioBuffer>>();
const rawCache = new Map<string, ArrayBuffer>();

/** Fetch + decode a clip's audio, caching both the bytes and the buffer. */
export async function loadClipBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const key = `${url}@${ctx.sampleRate}`;
  const hit = bufferCache.get(key);
  if (hit) return hit;

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    let bytes = rawCache.get(url);
    if (!bytes) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`could not fetch clip audio (${res.status})`);
      bytes = await res.arrayBuffer();
      rawCache.set(url, bytes);
    }
    // decodeAudioData detaches the buffer, so always hand it a copy
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    bufferCache.set(key, buf);
    return buf;
  })();

  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

/** Warm the cache for a set of clips — used before an offline render. */
export async function preloadClips(ctx: BaseAudioContext, clips: AudioClip[]): Promise<void> {
  await Promise.all(
    clips.map((c) =>
      loadClipBuffer(ctx, c.url).catch(() => {
        /* a missing clip must not abort the whole render */
      }),
    ),
  );
}

export function clearClipCache(url?: string) {
  if (url) {
    rawCache.delete(url);
    for (const key of [...bufferCache.keys()]) if (key.startsWith(`${url}@`)) bufferCache.delete(key);
  } else {
    bufferCache.clear();
    rawCache.clear();
  }
}

/* ------------------------------------------------------------- clip strip */

export interface ClipVoice {
  source: AudioBufferSourceNode;
  fader: GainNode;
  stop(when: number): void;
  dispose(): void;
}

/**
 * Build a clip's channel strip and schedule it.
 *
 * Musical clips (ACE-Step) join `musicSum`, so hit ducking pumps them along
 * with the procedural bed — a generated cue sits *inside* the mix rather than
 * floating on top of it. Sound-design clips join the un-ducked bus so their
 * transients survive.
 */
export function scheduleClip(
  master: MasterChain,
  clip: AudioClip,
  buffer: AudioBuffer,
  opts: { at: number; offset: number; duration: number; masterTime?: boolean } ,
): ClipVoice {
  const ctx = master.ctx;
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const hp = biquad(ctx, 'highpass', 18, 0.7);
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, clip.pan));
  const fader = gainNode(ctx, 0);

  source.connect(hp);
  hp.connect(panner);
  panner.connect(fader);

  // Musical material rides the ducked music bus; designed sound does not.
  const musical = clip.provider === 'ace-step';
  fader.connect(musical ? master.musicSum : master.hitSum);

  const level = clip.muted ? 0 : Math.max(0, clip.gain);
  const at = Math.max(0, opts.at);
  const dur = Math.max(0.01, opts.duration);
  const fadeIn = Math.max(0.002, Math.min(clip.fadeIn, dur * 0.5));
  const fadeOut = Math.max(0.002, Math.min(clip.fadeOut, dur * 0.5));

  const g = fader.gain;
  g.cancelScheduledValues(at);
  g.setValueAtTime(0, at);
  g.linearRampToValueAtTime(level, at + fadeIn);
  g.setValueAtTime(level, at + dur - fadeOut);
  g.linearRampToValueAtTime(0, at + dur);

  source.start(at, Math.max(0, opts.offset), dur);

  return {
    source,
    fader,
    stop(when: number) {
      try {
        fader.gain.cancelScheduledValues(when);
        fader.gain.setTargetAtTime(0, when, 0.04);
        source.stop(when + 0.2);
      } catch {
        /* already stopped */
      }
    },
    dispose() {
      [source, hp, panner, fader].forEach((n) => {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      });
    },
  };
}

/* ------------------------------------------------------------- clip edits */

let clipSeq = 0;

function clipId(): string {
  return `C${Date.now().toString(36)}${(clipSeq++).toString(36)}`;
}

export interface ClipInit {
  audioId: string;
  url: string;
  provider: ClipProvider;
  name: string;
  start: number;
  duration: number;
  sampleRate: number;
  channels: number;
  metadata?: AudioClip['metadata'];
}

/** Turn a finished generation into a timeline clip. */
export function makeClip(init: ClipInit): AudioClip {
  return {
    id: clipId(),
    name: init.name,
    audioId: init.audioId,
    url: init.url,
    provider: init.provider,
    start: Math.max(0, init.start),
    duration: init.duration,
    offset: 0,
    sourceDuration: init.duration,
    gain: 0.9,
    pan: 0,
    fadeIn: Math.min(0.08, init.duration * 0.05),
    fadeOut: Math.min(0.25, init.duration * 0.12),
    muted: false,
    solo: false,
    sampleRate: init.sampleRate,
    channels: init.channels,
    metadata: init.metadata ?? { provider: init.provider },
    createdAt: Date.now(),
    version: 1,
  };
}

export function clipEnd(c: AudioClip): number {
  return c.start + c.duration;
}

/** Move a clip, clamped to the project. */
export function moveClip(c: AudioClip, to: number, projectDuration: number): AudioClip {
  const start = Math.max(0, Math.min(to, Math.max(0, projectDuration - 0.05)));
  return { ...c, start };
}

/**
 * Trim from either edge.
 *
 * Trimming the head advances the read offset into the source buffer so the
 * audio underneath stays sample-aligned — the clip reveals later material
 * rather than resampling.
 */
export function trimClip(c: AudioClip, edge: 'start' | 'end', delta: number): AudioClip {
  const MIN = 0.05;
  if (edge === 'start') {
    const maxIn = c.sourceDuration - c.offset - MIN;
    const d = Math.max(-c.offset, Math.min(delta, Math.min(maxIn, c.duration - MIN)));
    return {
      ...c,
      start: c.start + d,
      offset: c.offset + d,
      duration: c.duration - d,
    };
  }
  const available = c.sourceDuration - c.offset;
  const duration = Math.max(MIN, Math.min(c.duration + delta, available));
  return { ...c, duration };
}

/** Split at an absolute timeline position, producing two independent clips. */
export function splitClip(c: AudioClip, at: number): [AudioClip, AudioClip] | null {
  const local = at - c.start;
  if (local <= 0.05 || local >= c.duration - 0.05) return null;
  const left: AudioClip = {
    ...c,
    id: clipId(),
    duration: local,
    fadeOut: Math.min(c.fadeOut, local * 0.3),
    name: `${c.name} A`,
  };
  const right: AudioClip = {
    ...c,
    id: clipId(),
    start: c.start + local,
    offset: c.offset + local,
    duration: c.duration - local,
    fadeIn: Math.min(c.fadeIn, (c.duration - local) * 0.3),
    name: `${c.name} B`,
  };
  return [left, right];
}

/** Clips audible right now, honouring solo across the whole clip pool. */
export function activeClips(clips: AudioClip[], time: number): AudioClip[] {
  const anySolo = clips.some((c) => c.solo);
  return clips.filter(
    (c) => !(c.muted || (anySolo && !c.solo)) && time >= c.start && time < clipEnd(c),
  );
}

export function clipsInRange(clips: AudioClip[], from: number, to: number): AudioClip[] {
  return clips.filter((c) => clipEnd(c) > from && c.start < to);
}

/** Where a continuation of this clip should be placed. */
export function continuationStart(c: AudioClip): number {
  return clipEnd(c);
}

/* --------------------------------------------------------- clip waveform */

const peakCache = new Map<string, number[]>();

/** Downsample a decoded buffer into peaks for timeline drawing. */
export function clipPeaks(buffer: AudioBuffer, bins: number, cacheKey?: string): number[] {
  const key = cacheKey ? `${cacheKey}:${bins}` : null;
  if (key) {
    const hit = peakCache.get(key);
    if (hit) return hit;
  }
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bins));
  const out: number[] = [];
  for (let i = 0; i < bins; i++) {
    let peak = 0;
    const from = i * step;
    const to = Math.min(data.length, from + step);
    for (let j = from; j < to; j += 2) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out.push(Math.min(1, peak));
  }
  if (key) peakCache.set(key, out);
  return out;
}

/**
 * Decode a clip (through the shared cache) and return its real peaks.
 * Never synthesises a placeholder shape — undecodable clips return null so the
 * UI can say so honestly.
 */
export async function clipWaveform(
  ctx: BaseAudioContext,
  clip: AudioClip,
  bins: number,
): Promise<number[] | null> {
  const key = `${clip.url}#${clip.offset.toFixed(3)}+${clip.duration.toFixed(3)}:${bins}`;
  const hit = peakCache.get(key);
  if (hit) return hit;
  let buffer: AudioBuffer;
  try {
    buffer = await loadClipBuffer(ctx, clip.url);
  } catch {
    return null;
  }
  const sr = buffer.sampleRate;
  const from = Math.max(0, Math.floor(clip.offset * sr));
  const to = Math.min(buffer.length, Math.ceil((clip.offset + clip.duration) * sr));
  const data = buffer.getChannelData(0);
  const span = Math.max(1, to - from);
  const step = Math.max(1, Math.floor(span / bins));
  const out: number[] = [];
  for (let i = 0; i < bins; i++) {
    let peak = 0;
    const a = from + i * step;
    const b = Math.min(to, a + step);
    for (let j = a; j < b; j += 2) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out.push(Math.min(1, peak));
  }
  peakCache.set(key, out);
  return out;
}
