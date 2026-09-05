import { buildMaster, type MasterParams } from './dsp';
import { buildVoice } from './voices';
import { mulberry32 } from './prng';
import { clipEnd, loadClipBuffer, scheduleClip } from './clips';
import { KIND_META, type AudioClip, type Layer, type Project, type Scene } from './types';

/** Static fader target for a layer — mirrors applyStrip() in voices.ts. */
function faderTarget(l: Layer, tension: number): number {
  return l.gain * KIND_META[l.kind].trim * (0.5 + tension * 0.75);
}

/* ==================================================================== *
 *  OFFLINE RENDERER
 *  Renders the real mix through an OfflineAudioContext, then runs a
 *  post chain — BS.1770 loudness normalisation → lookahead true-peak
 *  limiting → 24-bit WAV. This is the actual deliverable, rendered
 *  faster than realtime.
 * ==================================================================== */

export interface RenderResult {
  blob: Blob;
  url: string;
  peakDb: number;
  lufs: number;
  seconds: number;
  bytes: number;
  /** generated clips included in this bounce */
  clipsPlaced?: number;
  /** clips whose audio could not be decoded — reported, never hidden */
  clipsFailed?: string[];
}

export interface RenderOpts {
  sampleRate?: number;
  bitDepth?: 16 | 24;
  /** limit render length (seconds) */
  maxSeconds?: number;
  onProgress?: (p: number) => void;
}

const TARGET_LUFS = -16;
const CURVE_N = 256;

function fadeInCurve(target: number): Float32Array {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) c[i] = target * Math.sin((Math.PI / 2) * (i / (CURVE_N - 1)));
  return c;
}

function fadeOutCurve(from: number): Float32Array {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) c[i] = from * Math.cos((Math.PI / 2) * (i / (CURVE_N - 1)));
  return c;
}

/** Schedule every scene's layers into an offline graph. */
function schedule(ctx: OfflineAudioContext, master: ReturnType<typeof buildMaster>, scenes: Scene[], total: number) {
  const XF = 1.1; // crossfade at scene boundaries

  for (const scene of scenes) {
    const start = Math.max(0, scene.start);
    const end = Math.min(total, scene.end);
    if (end - start < 0.05) continue;

    // polished seam: duck the music bed a touch as each new scene enters
    if (start > 0.05) master.duck(start, 0.16, 0.01, 0.6);

    const anySolo = scene.layers.some((l) => l.solo);

    for (const raw of scene.layers) {
      const layer: Layer = { ...raw, muted: raw.muted || (anySolo && !raw.solo) };
      if (layer.muted) continue;

      const voice = buildVoice(master, layer);
      const inAt = Math.max(0, start - XF * 0.5);
      const outAt = Math.min(total, end + XF * 0.5);

      // set every strip parameter (pan / sends / eq / width) statically
      voice.update(layer, scene.tension, 0, 0);

      // dynamics: tension shapes the fader, giving real dramatic range
      const target = Math.max(0.0005, faderTarget(layer, scene.tension));
      const g = voice.ch.fader.gain;
      g.cancelScheduledValues(0);
      g.setValueAtTime(0, inAt);
      g.setValueCurveAtTime(fadeInCurve(target), inAt, XF);

      // intra-scene swell toward the tension peak, then release
      const mid = start + (end - start) * 0.68;
      if (mid > inAt + XF + 0.05 && mid < outAt - XF - 0.05) {
        g.linearRampToValueAtTime(target * (1 + scene.tension * 0.5), mid);
      }
      g.linearRampToValueAtTime(target * 0.8, outAt - XF);
      g.setValueCurveAtTime(fadeOutCurve(target * 0.8), outAt - XF, XF);

      voice.start(inAt);
      voice.stop(outAt + 0.5);

      // event scheduling across the scene span
      if (voice.fire && voice.interval) {
        const rnd = mulberry32(layer.seed || 7);
        let t = start + rnd() * 0.6;
        let guard = 0;
        while (t < end && guard++ < 900) {
          const prog = (t - start) / Math.max(0.001, end - start);
          const force = 0.4 + scene.tension * 0.42 + prog * 0.2;
          voice.fire(t, Math.min(1, force), layer);
          t += voice.interval(layer, scene.tension);
        }
      }

      // hard-sync transient stacks to detected hit points
      const syncKinds = ['stinger', 'impact', 'braam', 'brass', 'percussion'];
      if (syncKinds.includes(layer.kind) && voice.fire) {
        for (const h of scene.hits) {
          if (h >= start && h < end) voice.fire(h, 0.95, layer);
        }
      }
    }
  }
}

/**
 * Schedule generated clips into the offline graph.
 *
 * This is what makes the acceptance test true: the exported master contains
 * the *exact* audio the composer heard, because the bounce decodes the same
 * files and runs them through the same master chain as the monitor. Nothing
 * is re-generated at export time and nothing is approximated.
 *
 * Returns the clips that were actually placed, so the caller can report
 * honestly if one failed to decode.
 */
async function scheduleClips(
  ctx: OfflineAudioContext,
  master: ReturnType<typeof buildMaster>,
  clips: AudioClip[],
  windowStart: number,
  windowEnd: number,
): Promise<{ placed: AudioClip[]; failed: AudioClip[] }> {
  const anySolo = clips.some((c) => c.solo);
  const audible = clips.filter((c) => {
    if (c.muted || (anySolo && !c.solo)) return false;
    return clipEnd(c) > windowStart && c.start < windowEnd;
  });

  const placed: AudioClip[] = [];
  const failed: AudioClip[] = [];

  // Decode in parallel — this dominates render time for clip-heavy projects.
  const decoded = await Promise.all(
    audible.map(async (clip) => {
      try {
        return { clip, buffer: await loadClipBuffer(ctx, clip.url) };
      } catch {
        return { clip, buffer: null as AudioBuffer | null };
      }
    }),
  );

  for (const { clip, buffer } of decoded) {
    if (!buffer) {
      failed.push(clip);
      continue;
    }
    // clamp the clip into the render window without shifting its content
    const headTrim = Math.max(0, windowStart - clip.start);
    const tailTrim = Math.max(0, clipEnd(clip) - windowEnd);
    const duration = clip.duration - headTrim - tailTrim;
    if (duration <= 0.02) continue;

    scheduleClip(master, clip, buffer, {
      at: clip.start + headTrim - windowStart,
      offset: clip.offset + headTrim,
      duration,
    });
    placed.push(clip);
  }

  return { placed, failed };
}

/* -------------------------------------------------- post processing --- */

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function highShelfCoeffs(f0: number, fs: number, dbGain: number): BiquadCoeffs {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = (sinw / 2) * Math.sqrt(2); // S = 1
  const sqA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
  const b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha);
  const a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosw);
  const a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highPassCoeffs(f0: number, fs: number, Q: number): BiquadCoeffs {
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

/**
 * ITU-R BS.1770-style integrated loudness: K-weighting (high shelf +4 dB @
 * 1.68 kHz, high-pass 38 Hz), 400 ms blocks, absolute then relative gating.
 */
function measureLufs(chans: Float32Array[], fs: number): number {
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
      // high shelf
      const y = H.b0 * s + H.b1 * hx1 + H.b2 * hx2 - H.a1 * hy1 - H.a2 * hy2;
      hx2 = hx1;
      hx1 = s;
      hy2 = hy1;
      hy1 = y;
      // high pass
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

  // absolute gate at -70 LUFS
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
  // relative gate: -10 LU below gated mean
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

/** Lookahead true-peak limiter (sliding-window max, instant attack, smooth release). */
function lookaheadLimit(data: Float32Array, fs: number, ceilingDb: number): Float32Array {
  const n = data.length;
  const out = new Float32Array(n);
  const ceiling = Math.pow(10, ceilingDb / 20);
  const look = Math.max(1, Math.floor(fs * 0.005));
  const rel = 1 - Math.exp(-1 / (fs * 0.08));
  const peak = new Float32Array(n);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  // backward scan → look-ahead window max
  for (let i = n - 1; i >= 0; i--) {
    const v = Math.abs(data[i]);
    while (qh < qt && Math.abs(data[q[qt - 1]]) <= v) qt--;
    q[qt++] = i;
    const lim = i + look;
    while (qh < qt && q[qh] > lim) qh++;
    peak[i] = Math.abs(data[q[qh]]);
  }
  let gain = 1;
  for (let i = 0; i < n; i++) {
    const target = peak[i] > 1e-9 ? ceiling / peak[i] : 1;
    if (target < gain) gain = target;
    else if (gain < 1) gain = Math.min(1, gain + (1 - gain) * rel);
    out[i] = data[i] * gain;
  }
  return out;
}

/** Post-render master: loudness-normalise, true-peak limit, measure. */
function finalizeMaster(buffer: AudioBuffer, ceilingDb: number, targetLufs: number | null) {
  const fs = buffer.sampleRate;
  const numCh = Math.min(2, buffer.numberOfChannels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  const rawLufs = measureLufs(chans, fs);
  let lufs = rawLufs;
  if (targetLufs !== null) {
    const makeup = Math.min(9, Math.max(-4, targetLufs - rawLufs));
    const mg = Math.pow(10, makeup / 20);
    for (let c = 0; c < numCh; c++) {
      const d = chans[c];
      for (let i = 0; i < d.length; i++) d[i] *= mg;
    }
  }

  for (let c = 0; c < numCh; c++) {
    const limited = lookaheadLimit(chans[c], fs, ceilingDb - 0.15);
    chans[c] = limited;
  }

  lufs = measureLufs(chans, fs);
  let peak = 0;
  for (let c = 0; c < numCh; c++) {
    const d = chans[c];
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const peakDb = peak > 1e-7 ? 20 * Math.log10(peak) : -70;
  return { chans, lufs, peakDb };
}

export function encodeWav(chans: Float32Array[], sampleRate: number, bitDepth: 16 | 24): Blob {
  const numCh = chans.length;
  const len = chans[0].length;
  const bytesPer = bitDepth / 8;
  const dataSize = len * numCh * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPer, true);
  view.setUint16(32, numCh * bytesPer, true);
  view.setUint16(34, bitDepth, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  const rnd = mulberry32(0x5eed);
  let off = 44;
  const max24 = 8388607;

  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      if (bitDepth === 24) {
        const v = Math.round(s * max24);
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      } else {
        // TPDF dither on 16-bit
        const dither = (rnd() + rnd() - 1) / 32768;
        const v = Math.max(-32768, Math.min(32767, Math.round((s + dither) * 32767)));
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Render the whole project score (or a single scene) to a WAV file. */
export async function renderScore(
  project: Project,
  masterParams: MasterParams,
  opts: RenderOpts = {},
  onlyScene?: Scene,
): Promise<RenderResult> {
  const sampleRate = opts.sampleRate ?? 48000;
  const bitDepth = opts.bitDepth ?? 24;
  const offset = onlyScene ? onlyScene.start : 0;
  const scenes = onlyScene
    ? [
        {
          ...onlyScene,
          start: 0,
          end: onlyScene.end - offset,
          hits: onlyScene.hits.map((h) => h - offset).filter((h) => h >= 0),
        },
      ]
    : project.scenes;
  const span = onlyScene ? onlyScene.end - onlyScene.start : project.duration;
  const total = Math.min(opts.maxSeconds ?? 600, span) + 2.5; // tail

  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  const ctx = new OfflineCtor(2, Math.ceil(total * sampleRate), sampleRate);
  const master = buildMaster(ctx, masterParams, 'render');
  schedule(ctx, master, scenes, total - 2.5);

  // Generated clips ride the same master chain as the procedural voices.
  const windowStart = offset;
  const windowEnd = offset + span;
  const clipResult = await scheduleClips(ctx, master, project.clips ?? [], windowStart, windowEnd);

  opts.onProgress?.(8);
  const buffer = await ctx.startRendering();
  opts.onProgress?.(70);

  const { chans, lufs, peakDb } = finalizeMaster(buffer, masterParams.ceiling, TARGET_LUFS);
  opts.onProgress?.(92);

  const blob = encodeWav(chans, sampleRate, bitDepth);
  opts.onProgress?.(98);

  return {
    blob,
    url: URL.createObjectURL(blob),
    peakDb,
    lufs,
    seconds: buffer.duration,
    bytes: blob.size,
    clipsPlaced: clipResult.placed.length,
    clipsFailed: clipResult.failed.map((c) => c.name),
  };
}

/**
 * Render a single generated clip in isolation.
 *
 * Same chain, same limiter — so a clip stem and the same clip inside the full
 * master are consistent with each other.
 */
export async function renderClipStem(
  clip: AudioClip,
  masterParams: MasterParams,
  sampleRate = 48000,
): Promise<RenderResult> {
  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  const total = clip.duration + 1.5;
  const ctx = new OfflineCtor(2, Math.ceil(total * sampleRate), sampleRate);
  const master = buildMaster(ctx, masterParams, 'render');

  const solo: AudioClip = { ...clip, start: 0, muted: false, solo: false };
  const result = await scheduleClips(ctx, master, [solo], 0, total);
  if (result.placed.length === 0) {
    throw new Error(`could not decode audio for "${clip.name}"`);
  }

  const buffer = await ctx.startRendering();
  const { chans, lufs, peakDb } = finalizeMaster(buffer, masterParams.ceiling, null);
  const blob = encodeWav(chans, sampleRate, 24);
  return {
    blob,
    url: URL.createObjectURL(blob),
    peakDb,
    lufs,
    seconds: buffer.duration,
    bytes: blob.size,
    clipsPlaced: 1,
    clipsFailed: [],
  };
}

/** Render a single layer in isolation — used for stem delivery. */
export async function renderStem(
  scene: Scene,
  layer: Layer,
  masterParams: MasterParams,
  sampleRate = 48000,
): Promise<RenderResult> {
  const span = Math.min(60, scene.end - scene.start);
  const solo: Scene = {
    ...scene,
    start: 0,
    end: span,
    layers: [{ ...layer, muted: false, solo: false }],
    hits: scene.hits.map((h) => h - scene.start).filter((h) => h >= 0 && h < span),
  };
  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const total = span + 2;
  const ctx = new OfflineCtor(2, Math.ceil(total * sampleRate), sampleRate);
  const master = buildMaster(ctx, { ...masterParams, volume: Math.min(1, masterParams.volume) }, 'render');
  schedule(ctx, master, [solo], span);
  const buffer = await ctx.startRendering();
  const { chans, lufs, peakDb } = finalizeMaster(buffer, masterParams.ceiling, null);
  const blob = encodeWav(chans, sampleRate, 24);
  return { blob, url: URL.createObjectURL(blob), peakDb, lufs, seconds: buffer.duration, bytes: blob.size };
}

export function download(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
