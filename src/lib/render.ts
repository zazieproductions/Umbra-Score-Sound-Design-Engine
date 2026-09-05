import { buildMaster, type MasterParams } from './dsp';
import { buildVoice } from './voices';
import { mulberry32 } from './prng';
import { KIND_META, type Layer, type Project, type Scene } from './types';

/** Static fader target for a layer — mirrors applyStrip() in voices.ts. */
function faderTarget(l: Layer, tension: number): number {
  return l.gain * KIND_META[l.kind].trim * (0.72 + tension * 0.5);
}

/* ==================================================================== *
 *  OFFLINE RENDERER
 *  Renders the real mix through an OfflineAudioContext, then encodes a
 *  24-bit / 48 kHz stereo WAV. This is the actual deliverable — the same
 *  DSP graph as the live monitor, rendered faster than realtime.
 * ==================================================================== */

export interface RenderResult {
  blob: Blob;
  url: string;
  peakDb: number;
  lufs: number;
  seconds: number;
  bytes: number;
}

export interface RenderOpts {
  sampleRate?: number;
  bitDepth?: 16 | 24;
  /** limit render length (seconds) */
  maxSeconds?: number;
  onProgress?: (p: number) => void;
}

/** Schedule every scene's layers into an offline graph. */
function schedule(ctx: OfflineAudioContext, master: ReturnType<typeof buildMaster>, scenes: Scene[], total: number) {
  const XF = 0.9; // crossfade at scene boundaries

  for (const scene of scenes) {
    const start = Math.max(0, scene.start);
    const end = Math.min(total, scene.end);
    if (end - start < 0.05) continue;
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
      g.setValueAtTime(0.0004, inAt);
      g.exponentialRampToValueAtTime(target, inAt + XF);

      // intra-scene swell toward the tension peak, then release
      const mid = start + (end - start) * 0.68;
      if (mid > inAt + XF + 0.05 && mid < outAt - XF - 0.05) {
        g.exponentialRampToValueAtTime(target * (1 + scene.tension * 0.5), mid);
        g.exponentialRampToValueAtTime(target * 0.85, outAt - XF * 0.5);
      }
      g.exponentialRampToValueAtTime(0.0004, outAt);

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

      // hard-sync stingers/impacts to detected hit points
      if ((layer.kind === 'stinger' || layer.kind === 'impact' || layer.kind === 'braam') && voice.fire) {
        for (const h of scene.hits) {
          if (h >= start && h < end) voice.fire(h, 0.95, layer);
        }
      }
    }
  }
}

function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24): { blob: Blob; peakDb: number; lufs: number } {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
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
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * bytesPer, true);
  view.setUint16(32, numCh * bytesPer, true);
  view.setUint16(34, bitDepth, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  let peak = 0;
  let sqSum = 0;
  let off = 44;
  const max24 = 8388607;

  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sqSum += s * s;
      if (bitDepth === 24) {
        const v = Math.round(s * max24);
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      } else {
        view.setInt16(off, Math.round(s * 32767), true);
        off += 2;
      }
    }
  }

  const rms = Math.sqrt(sqSum / Math.max(1, len * numCh));
  const lufs = rms > 1e-7 ? 20 * Math.log10(rms) - 0.7 : -70;
  const peakDb = peak > 1e-7 ? 20 * Math.log10(peak) : -70;
  return { blob: new Blob([ab], { type: 'audio/wav' }), peakDb, lufs };
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

  opts.onProgress?.(8);
  const buffer = await ctx.startRendering();
  opts.onProgress?.(78);

  const { blob, peakDb, lufs } = encodeWav(buffer, bitDepth);
  opts.onProgress?.(98);

  return {
    blob,
    url: URL.createObjectURL(blob),
    peakDb,
    lufs,
    seconds: buffer.duration,
    bytes: blob.size,
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
  const solo: Scene = { ...scene, start: 0, end: span, layers: [{ ...layer, muted: false, solo: false }], hits: scene.hits.map((h) => h - scene.start).filter((h) => h >= 0 && h < span) };
  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const total = span + 2;
  const ctx = new OfflineCtor(2, Math.ceil(total * sampleRate), sampleRate);
  const master = buildMaster(ctx, { ...masterParams, volume: Math.min(1, masterParams.volume) }, 'render');
  schedule(ctx, master, [solo], span);
  const buffer = await ctx.startRendering();
  const { blob, peakDb, lufs } = encodeWav(buffer, 24);
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
