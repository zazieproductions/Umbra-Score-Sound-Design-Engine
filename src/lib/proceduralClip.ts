/* ==================================================================== *
 *  UMBRA PROCEDURAL → CLIP
 *
 *  Umbra Procedural is a first-class provider, but unlike the trained
 *  models it does NOT run in Python — it is the browser's own Web Audio
 *  synthesis engine. When the composer asks it for a clip, we bounce the
 *  existing voice graph offline and hand back a real WAV, so a procedural
 *  clip is byte-for-byte as concrete as an ACE-Step one and lives on the
 *  same timeline with the same edit operations.
 * ==================================================================== */

import { buildVoice } from './voices';
import { buildMaster, DEFAULT_MASTER } from './dsp';
import { encodeWav } from './render';
import { makeClip } from './clips';
import { KIND_ORDER, type AudioClip, type Layer, type LayerKind, type SpaceId } from './types';
import { addLayer } from './generate';

/** Keyword → synthesis class. Mirrors the backend router's vocabulary. */
const KIND_HINTS: [RegExp, LayerKind][] = [
  [/\bsub|40\s*hz|infra|rumble\b/i, 'sub'],
  [/\bdrone|bed|sustain|tonal\b/i, 'drone'],
  [/\bcluster|dissonan|bowed|string/i, 'strings'],
  [/\bbraam|blare|horn\b/i, 'braam'],
  [/\bstinger|sting\b/i, 'stinger'],
  [/\bimpact|hit|slam|boom\b/i, 'impact'],
  [/\briser|swell|build|crescendo\b/i, 'riser'],
  [/\breverse|backwards|suck\b/i, 'downlifter'],
  [/\bwhisper|voice|choir|vocal\b/i, 'choir'],
  [/\bpulse|heartbeat|throb|ostinato\b/i, 'pulse'],
  [/\bmetal|scrape|screech|friction\b/i, 'foley'],
  [/\bnoise|wind|hiss|air|room tone\b/i, 'ambience'],
  [/\bwhoosh|pass-?by|transition\b/i, 'whoosh'],
  [/\bbrass|horn section\b/i, 'brass'],
  [/\btick|clock|metronome\b/i, 'tick'],
  [/\bpercussion|taiko|drum\b/i, 'percussion'],
  [/\btexture|grain|spectral\b/i, 'texture'],
];

function pickKind(prompt: string): LayerKind {
  for (const [re, kind] of KIND_HINTS) if (re.test(prompt)) return kind;
  return 'drone';
}

const SPACE_HINTS: [RegExp, SpaceId][] = [
  [/\bcathedral|church|vast|huge\b/i, 'cathedral'],
  [/\bhall|stage|orchestral\b/i, 'hall'],
  [/\broom|close|intimate|dry\b/i, 'room'],
];

function pickSpace(prompt: string): SpaceId {
  for (const [re, s] of SPACE_HINTS) if (re.test(prompt)) return s;
  return 'hall';
}

/** Musical key → root frequency, so procedural clips agree with scored ones. */
const SEMITONE: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

function rootHz(key: string | null | undefined): number {
  const st = SEMITONE[key ?? 'D'] ?? 2;
  // A1 = 55 Hz reference, keep everything in the low register
  return 55 * Math.pow(2, (st - 9) / 12) * 2;
}

export interface ProceduralRequest {
  prompt: string;
  duration: number;
  seed?: number | null;
  key?: string | null;
  mode?: string | null;
  bpm?: number | null;
  intensity?: number;
  start: number;
  name?: string;
  sceneId?: string | null;
}

export interface ProceduralClipResult {
  clip: AudioClip;
  blob: Blob;
  seconds: number;
}

/**
 * Render a procedural cue offline and return it as a timeline clip.
 *
 * Deliberately bounced *dry* (no master chain): the clip is mixed through the
 * live master bus like every other clip, so applying it twice would double the
 * processing.
 */
export async function renderProceduralClip(
  req: ProceduralRequest,
  sampleRate = 48000,
): Promise<ProceduralClipResult> {
  const duration = Math.max(0.5, Math.min(120, req.duration));
  const seed = req.seed ?? Math.floor(Math.random() * 999999);
  const kind = pickKind(req.prompt);
  const space = pickSpace(req.prompt);
  const tension = Math.min(1, Math.max(0.15, req.intensity ?? 0.62));

  // The whole layer (not just the seed field) is derived from `seed` so a
  // re-render of the stored request reproduces the same voice parameters —
  // determinism is what makes hydration from a draft trustworthy.
  const base: Layer = addLayer(kind, space, tension, rootHz(req.key), seed);
  const layer: Layer = { ...base, seed, muted: false, solo: false, gain: 0 };

  const OfflineCtor: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  // a little tail so releases and reverb are not clipped off
  const tail = 1.5;
  const ctx = new OfflineCtor(2, Math.ceil((duration + tail) * sampleRate), sampleRate);

  /*
   * The voice needs a master chain to hang off, but we bounce the clip
   * *flat*: no glue comp, no tape drive, no limiter, no reverb sends. The
   * clip is then mixed through the real master bus like every other clip,
   * so the processing is applied exactly once.
   */
  const flat = {
    ...DEFAULT_MASTER,
    volume: 1,
    glue: 0,
    drive: 0,
    tilt: 0,
    width: 1, // keep the voice's own stereo image; do not mono-collapse
    exciter: 0,
    air: 0,
    roomMix: 0.06,
    hallMix: 0.1,
    cathMix: 0.04,
    ceiling: 0,
  };
  const master = buildMaster(ctx, flat, 'render');
  master.out.connect(ctx.destination);

  const voice = buildVoice(master, layer);
  voice.update(layer, tension, 0, 0);

  const g = voice.ch.fader.gain;
  g.setValueAtTime(0.0001, 0);
  g.exponentialRampToValueAtTime(0.85, Math.min(0.4, duration * 0.15));
  g.setValueAtTime(0.85, Math.max(0.5, duration - 0.35));
  g.exponentialRampToValueAtTime(0.0001, duration);

  voice.start(0);

  // one-shot classes need explicit triggers to make any sound at all
  if (voice.fire) {
    const every = voice.interval ? Math.max(0.35, voice.interval(layer, tension, 0.05)) : duration;
    for (let t = 0.05; t < duration - 0.05; t += voice.interval ? Math.max(0.35, voice.interval(layer, tension, t)) : every) {
      voice.fire(t, 0.55 + tension * 0.4, layer);
    }
  }

  voice.stop(duration + tail * 0.8);

  const buffer = await ctx.startRendering();

  // Peak-normalise to a sane headroom; the master chain does the rest.
  const chans: Float32Array[] = [];
  let peak = 1e-6;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  const norm = Math.min(4, 0.89 / peak);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * norm;
    chans.push(dst);
  }

  const blob = encodeWav(chans, sampleRate, 24);
  const url = URL.createObjectURL(blob);
  const seconds = buffer.duration;

  const clip = makeClip({
    audioId: `local:${seed}`,
    url,
    provider: 'umbra-procedural',
    name: req.name ?? `${kind} · ${duration.toFixed(1)}s`,
    start: req.start,
    duration: seconds,
    sampleRate,
    channels: buffer.numberOfChannels,
    metadata: {
      provider: 'umbra-procedural',
      model: 'umbra-voices-17',
      prompt: req.prompt,
      seed,
      key: req.key ?? null,
      mode: req.mode ?? null,
      bpm: req.bpm ?? null,
      duration: seconds,
      task: 'text2audio',
      generationSettings: { kind, space, tension, rootHz: rootHz(req.key) },
    },
  });

  return { clip, blob, seconds };
}

export const PROCEDURAL_KINDS = KIND_ORDER;
