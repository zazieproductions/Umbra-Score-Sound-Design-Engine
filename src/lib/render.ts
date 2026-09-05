import { buildMaster, type MasterParams } from './dsp';
import { buildVoice, type Voice } from './voices';
import { mulberry32 } from './prng';
import { clipBufferOffset, clipEnd, loadClipBuffer, scheduleClip } from './clips';
import { KIND_META, type AudioClip, type Layer, type Project, type Scene } from './types';
import { sceneDuckEvents } from './export/stemPlan';
import { analyzeFloat, integratedLufs, truePeakLinear, type QualityReport } from './quality';

/**
 * Optional selection applied while scheduling procedural layers.
 * Used by the stem renderer to restrict a render pass to one bus without
 * forking the scheduling code — monitor, master bounce and every stem share
 * this single implementation.
 */
export interface ScheduleSelection {
  /** false = the layer is not scheduled in this pass (duck automation still applies) */
  includeLayer?: (scene: Scene, layer: Layer) => boolean;
  /** called after a voice's strip is configured — lets a pass rewire/gate its outputs */
  afterVoice?: (scene: Scene, layer: Layer, voice: Voice) => void;
}

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
  /** measured quality report of the final master (clipping, DC, subsonic…) */
  quality?: QualityReport;
}

export interface RenderOpts {
  sampleRate?: number;
  bitDepth?: 16 | 24;
  /** limit render length (seconds) */
  maxSeconds?: number;
  onProgress?: (p: number) => void;
}

/** Delivery target for the MASTER file only. Stems are never conformed. */
export const TARGET_LUFS = -16;
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

/**
 * Schedule every scene's layers into an offline graph.
 *
 * Exported for stem delivery: the master bounce and every stem pass run this
 * exact scheduling code, differing only in `sel` — the shared-graph
 * invariant extends unchanged to delivery (ADR-0005).
 */
export function schedule(
  ctx: OfflineAudioContext,
  master: ReturnType<typeof buildMaster>,
  scenes: Scene[],
  total: number,
  sel?: ScheduleSelection,
) {
  const XF = 1.1; // crossfade at scene boundaries

  // polished seam: duck the music bed a touch as each new scene enters.
  // sceneDuckEvents() is the single authoritative list — the stem plan feeds
  // the same events to its passes, so master and every stem pump identically
  // and Σ stems stays an exact reconstruction.
  for (const d of sceneDuckEvents(scenes, total)) master.duck(d.at, d.depth, d.attack, d.release);

  for (const scene of scenes) {
    const start = Math.max(0, scene.start);
    const end = Math.min(total, scene.end);
    if (end - start < 0.05) continue;

    // Tension macro — mirror the live monitor (audio.ts setTension). Without
    // this the offline bounce leaves the dynamics gain at unity and exports
    // run hot, most of all on quiet (low-tension) scenes.
    master.dynamics.gain.setValueAtTime(0.34 + scene.tension * 0.92, start);

    const anySolo = scene.layers.some((l) => l.solo);

    for (const raw of scene.layers) {
      const layer: Layer = { ...raw, muted: raw.muted || (anySolo && !raw.solo) };
      if (layer.muted) continue;
      if (sel?.includeLayer && !sel.includeLayer(scene, layer)) continue;

      const voice = buildVoice(master, layer);
      const inAt = Math.max(0, start - XF * 0.5);
      const outAt = Math.min(total, end + XF * 0.5);

      // set every strip parameter (pan / sends / eq / width) statically
      voice.update(layer, scene.tension, 0, 0);
      sel?.afterVoice?.(scene, layer, voice);

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
          t += voice.interval(layer, scene.tension, t);
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
 * honestly if one failed to decode. Exported so stem passes reuse the exact
 * placement maths (window clamping, buffer-rate offsets, ≤0.02 s skip).
 */
export async function scheduleClipsInto(
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
      // timeline trim expressed in buffer seconds at the clip's playback rate
      offset: clipBufferOffset(clip.offset + headTrim, clip),
      duration,
    });
    placed.push(clip);
  }

  return { placed, failed };
}

/* -------------------------------------------------- post processing --- */

/**
 * Lookahead true-peak limiter.
 *
 * The window max is computed over a 4x Catmull-Rom reconstruction (shared
 * with quality.ts) rather than over raw samples, so inter-sample peaks are
 * attenuated too — the exported master genuinely stays under the ceiling
 * on reconstruction, not just at the sample points.
 */
function lookaheadLimit(data: Float32Array, fs: number, ceilingDb: number): Float32Array {
  const n = data.length;
  const out = new Float32Array(n);
  const ceiling = Math.pow(10, ceilingDb / 20);
  const look = Math.max(1, Math.floor(fs * 0.005));
  const rel = 1 - Math.exp(-1 / (fs * 0.08));

  // 4x oversampled (Catmull-Rom) reconstruction for inter-sample peaks.
  const ov = 4;
  const up = new Float32Array((n - 1) * ov);
  const at = (i: number) => (i < 0 ? data[0] : i >= n ? data[n - 1] : data[i]);
  for (let i = 0; i < n - 1; i++) {
    const x0 = at(i - 1);
    const x1 = data[i];
    const x2 = data[i + 1];
    const x3 = at(i + 2);
    const a = -0.5 * x0 + 1.5 * x1 - 1.5 * x2 + 0.5 * x3;
    const b = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
    const c = -0.5 * x0 + 0.5 * x2;
    const d = x1;
    for (let s = 0; s < ov; s++) {
      const t = s / ov;
      up[i * ov + s] = ((a * t + b) * t + c) * t + d;
    }
  }

  const m = up.length;
  const peak = new Float32Array(m);
  const q = new Int32Array(m);
  let qh = 0;
  let qt = 0;
  const win = look * ov;
  for (let i = m - 1; i >= 0; i--) {
    const v = Math.abs(up[i]);
    while (qh < qt && Math.abs(up[q[qt - 1]]) <= v) qt--;
    q[qt++] = i;
    const lim = i + win;
    while (qh < qt && q[qh] > lim) qh++;
    peak[i] = Math.abs(up[q[qh]]);
  }

  let gain = 1;
  for (let i = 0; i < n; i++) {
    const p = i < n - 1 ? peak[i * ov] : Math.abs(data[i]);
    const target = p > 1e-9 ? ceiling / p : 1;
    if (target < gain) gain = target;
    else if (gain < 1) gain = Math.min(1, gain + (1 - gain) * rel);
    out[i] = data[i] * gain;
  }
  return out;
}

/**
 * Post-render master: loudness-conform, true-peak limit, measure.
 *
 * Near-silent output is left alone: conforming a quiet psychological cue
 * to -16 LUFS would lift the noise floor and destroy the intentional
 * negative space, so below SILENCE_LUFS_DB we skip the makeup gain.
 */
/** Exported for stem delivery: the MASTER pass conforms; stems never do. */
export function finalizeMaster(buffer: AudioBuffer, ceilingDb: number, targetLufs: number | null) {
  const fs = buffer.sampleRate;
  const numCh = Math.min(2, buffer.numberOfChannels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  const rawLufs = integratedLufs(chans, fs);
  let lufs = rawLufs;
  if (targetLufs !== null && rawLufs > -45) {
    // Asymmetric conform: loud material is reduced freely to the target,
    // but quiet material is only ever lifted a little (+6 dB cap) — so a
    // near-silent cue is not pumped up to broadcast level and the film's
    // quiet-to-loud arc survives.
    const makeup = Math.min(6, targetLufs - rawLufs);
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

  lufs = integratedLufs(chans, fs);
  let peak = 0;
  let truePeak = 0;
  for (let c = 0; c < numCh; c++) {
    const d = chans[c];
    const p = truePeakLinear(d);
    if (p > truePeak) truePeak = p;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  const peakDb = peak > 1e-7 ? 20 * Math.log10(peak) : -70;
  const truePeakDb = truePeak > 1e-7 ? 20 * Math.log10(truePeak) : -70;
  return { chans, lufs, peakDb, truePeakDb };
}

/**
 * BS.1770 integrated loudness (K-weighted, gated) — the quality.ts meter,
 * re-exported so stem delivery can *report* LUFS on every file without
 * *normalising* anything. Stems must never be independently mastered.
 */
export function measureLufs(chans: Float32Array[], fs: number): number {
  return integratedLufs(chans, fs);
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
        // TPDF dither at the 24-bit LSB so truncation never quantises to a
        // correlated (audible) error — matches the "TPDF-dithered 24-bit" promise.
        const dither = (rnd() + rnd() - 1) / max24;
        const v = Math.max(-max24, Math.min(max24, Math.round((s + dither) * max24)));
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
  const clipResult = await scheduleClipsInto(ctx, master, project.clips ?? [], windowStart, windowEnd);

  opts.onProgress?.(8);
  const buffer = await ctx.startRendering();
  opts.onProgress?.(70);

  const { chans, lufs, peakDb } = finalizeMaster(buffer, masterParams.ceiling, TARGET_LUFS);
  opts.onProgress?.(92);

  const quality = analyzeFloat(chans, sampleRate);

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
    quality,
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
  const result = await scheduleClipsInto(ctx, master, [solo], 0, total);
  if (result.placed.length === 0) {
    throw new Error(`could not decode audio for "${clip.name}"`);
  }

  const buffer = await ctx.startRendering();
  const { chans, lufs, peakDb } = finalizeMaster(buffer, masterParams.ceiling, null);
  const quality = analyzeFloat(chans, sampleRate);
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
    quality,
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
  const quality = analyzeFloat(chans, sampleRate);
  const blob = encodeWav(chans, sampleRate, 24);
  return { blob, url: URL.createObjectURL(blob), peakDb, lufs, seconds: buffer.duration, bytes: blob.size, quality };
}

export function download(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
