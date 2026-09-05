import { mulberry32, hashString } from './prng';
import type { Layer, LayerKind, Project, Scene, SpaceId } from './types';
import { KIND_META } from './types';

const FRAMES = ['/frames/f1.jpg', '/frames/f2.jpg', '/frames/f3.jpg', '/frames/f4.jpg', '/frames/f5.jpg', '/frames/f6.jpg'];

interface BankEntry {
  title: string;
  tags: string[];
  summary: string;
  kinds: LayerKind[];
  space: SpaceId;
  tension: number;
}

const SCENE_BANK: BankEntry[] = [
  {
    title: 'Corridor / Cold Open',
    tags: ['interior', 'low-light', 'static camera'],
    summary:
      'Long empty hallway, fluorescent flicker at 0.4 Hz. No subject motion — hold the room with a detuned minor bed, sub pressure and close ambience. Dynamic floor kept low so the first cut lands.',
    kinds: ['drone', 'sub', 'ambience', 'texture'],
    space: 'hall',
    tension: 0.26,
  },
  {
    title: 'The Door Gives Way',
    tags: ['contact', 'foreground motion', 'cut-in'],
    summary:
      'Hand enters frame, wood splinters. Contact-heavy: three-part foley transients, one whoosh on the swing, soft stinger on the latch break.',
    kinds: ['foley', 'whoosh', 'drone', 'stinger', 'sub'],
    space: 'room',
    tension: 0.44,
  },
  {
    title: 'Treeline / Pursuit',
    tags: ['exterior', 'handheld', 'fog'],
    summary:
      'Handheld pursuit through fog. Motion energy peaks at 62%. Cardiac driver locked to gait, string cluster tremolo rising, ambience widened to 140° with Haas decorrelation.',
    kinds: ['pulse', 'strings', 'ambience', 'foley', 'riser'],
    space: 'cathedral',
    tension: 0.68,
  },
  {
    title: 'Glass / The Reveal',
    tags: ['close-up', 'reveal', 'high tension'],
    summary:
      'Face resolves through frosted glass on frame 41. Full braam + impact stack with sub drop; reverse pre-bloom seeded 1.2 s ahead of the cut for the theatrical swell.',
    kinds: ['braam', 'impact', 'stinger', 'sub', 'texture', 'strings'],
    space: 'cathedral',
    tension: 0.94,
  },
  {
    title: 'Attic / Slow Push',
    tags: ['interior', 'dolly', 'dust'],
    summary:
      'Slow push toward the shelf. Dust particulate detected — granular whisper texture over a narrow-band room tone, sparse foley creaks on the floorboards.',
    kinds: ['texture', 'ambience', 'foley', 'drone'],
    space: 'room',
    tension: 0.4,
  },
  {
    title: 'Mirror / Aftermath',
    tags: ['reflection', 'low motion', 'resolve'],
    summary:
      'Tension releases. Drop the pulse, retain sub pressure and a decaying cathedral drone tail bleeding into the outro cut. Loudness target drops 6 LU for contrast.',
    kinds: ['drone', 'sub', 'ambience', 'strings'],
    space: 'cathedral',
    tension: 0.34,
  },
];

const MODELS = ['DREADNET-v4', 'DREADNET-v4-XL', 'PHANTOM-fx-3', 'VISCERA-2.1', 'SUBSONICA-v3', 'CHORALIS-1'];

function mkLayer(kind: LayerKind, rnd: () => number, space: SpaceId, tension: number): Layer {
  const meta = KIND_META[kind];
  const wide = kind === 'sub' || kind === 'pulse' || kind === 'impact' ? 0.05 : 0.35 + rnd() * 0.6;
  return {
    id: `L${Math.floor(rnd() * 1e9).toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`,
    name: meta.label,
    kind,
    model: MODELS[Math.floor(rnd() * MODELS.length)],
    gain: 0.62 + rnd() * 0.36,
    pan: kind === 'sub' || kind === 'pulse' ? 0 : (rnd() * 2 - 1) * 0.62,
    reverb: kind === 'sub' ? 0.06 : 0.3 + rnd() * 0.55,
    space: kind === 'sub' ? 'room' : space,
    width: wide,
    tone: 0.26 + rnd() * 0.52,
    intensity: Math.min(0.95, 0.22 + tension * 0.5 + rnd() * 0.3),
    attack: rnd() * 0.6,
    muted: false,
    solo: false,
    seed: Math.floor(rnd() * 999999),
    version: 1,
  };
}

export function analyzeProject(name: string, duration: number, videoUrl: string | null, sourceLabel: string): Project {
  const rnd = mulberry32(hashString(name + duration.toFixed(2)));
  const count = Math.max(4, Math.min(6, Math.round(duration / 26)));
  const scenes: Scene[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const remain = count - i;
    const span = Math.max(6, ((duration - cursor) / remain) * (0.75 + rnd() * 0.5));
    const start = cursor;
    const end = i === count - 1 ? duration : Math.min(duration, start + span);
    cursor = end;
    const bank = SCENE_BANK[i % SCENE_BANK.length];
    // dramatic arc: bank tension blended with position in the cut
    const arc = 0.2 + Math.pow(i / Math.max(1, count - 1), 1.35) * 0.75;
    const tension = Math.min(0.98, Math.max(0.15, bank.tension * 0.55 + arc * 0.5 + (rnd() - 0.5) * 0.1));
    const hitCount = Math.round(1 + tension * 4);
    const hits = Array.from({ length: hitCount }, () => start + (0.15 + rnd() * 0.8) * (end - start));
    scenes.push({
      id: `S${i}-${Math.floor(rnd() * 1e6).toString(36)}`,
      index: i + 1,
      start,
      end,
      title: bank.title,
      frame: FRAMES[i % FRAMES.length],
      tags: bank.tags,
      tension,
      motion: Math.min(0.97, 0.12 + rnd() * 0.5 + tension * 0.4),
      summary: bank.summary,
      status: 'queued',
      hits: hits.sort((a, b) => a - b),
      layers: bank.kinds.map((k) => mkLayer(k, rnd, bank.space, tension)),
    });
  }
  return {
    id: `P-${Math.floor(rnd() * 1e9).toString(36).toUpperCase()}`,
    name,
    source: sourceLabel,
    duration,
    fps: 24,
    resolution: '3840 × 2160',
    videoUrl,
    scenes,
    createdAt: Date.now(),
  };
}

export function regenerateLayer(l: Layer): Layer {
  const rnd = mulberry32((l.seed * 7919 + 13) >>> 0);
  const clamp = (v: number, lo = 0.04, hi = 1) => Math.min(hi, Math.max(lo, v));
  return {
    ...l,
    seed: Math.floor(rnd() * 999999),
    version: l.version + 1,
    tone: clamp(l.tone + (rnd() - 0.5) * 0.55),
    intensity: clamp(l.intensity + (rnd() - 0.5) * 0.5),
    reverb: clamp(l.reverb + (rnd() - 0.5) * 0.4, 0),
    width: clamp(l.width + (rnd() - 0.5) * 0.4, 0),
    attack: clamp(l.attack + (rnd() - 0.5) * 0.4, 0),
    model: MODELS[Math.floor(rnd() * MODELS.length)],
  };
}

export function addLayer(kind: LayerKind, space: SpaceId = 'hall', tension = 0.6): Layer {
  return mkLayer(kind, mulberry32(Math.floor(Math.random() * 1e9)), space, tension);
}

/** Deterministic waveform envelope for timeline drawing. */
export function waveform(seed: number, samples: number, intensity: number, kind: LayerKind): number[] {
  const rnd = mulberry32(seed >>> 0);
  const out: number[] = [];
  const event = KIND_META[kind].event;
  if (event) {
    // sparse transient bursts with decays
    const env = new Array(samples).fill(0);
    const n = Math.max(2, Math.round(3 + intensity * 14));
    for (let k = 0; k < n; k++) {
      const pos = Math.floor(rnd() * samples);
      const decay = 6 + rnd() * 30;
      const amp = 0.55 + rnd() * 0.45;
      for (let i = pos; i < samples; i++) {
        const v = amp * Math.exp(-(i - pos) / decay);
        if (v < 0.008) break;
        env[i] = Math.max(env[i], v);
      }
    }
    for (let i = 0; i < samples; i++) out.push(Math.min(1, env[i] * (0.75 + rnd() * 0.45)));
    return out;
  }
  let v = 0.4;
  for (let i = 0; i < samples; i++) {
    v = v * 0.78 + rnd() * 0.22;
    const shape = Math.sin((i / samples) * Math.PI) * 0.5 + 0.5;
    const swell = 0.6 + 0.4 * Math.sin((i / samples) * Math.PI * 1.6);
    out.push(Math.min(1, v * shape * swell * (0.6 + intensity * 0.75)));
  }
  return out;
}

export const DEMO_ASSETS: { name: string; kind: LayerKind; len: number; size: number; tag: string }[] = [
  { name: 'breath_close_whisper_A.wav', kind: 'texture', len: 8.4, size: 1_480_000, tag: 'library' },
  { name: 'sub_pressure_drop_28hz.wav', kind: 'sub', len: 12.0, size: 2_120_000, tag: 'library' },
  { name: 'braam_brass_cluster_Dmin.wav', kind: 'braam', len: 4.6, size: 810_000, tag: 'library' },
  { name: 'attic_dust_air_loop.wav', kind: 'ambience', len: 30.0, size: 5_290_000, tag: 'library' },
  { name: 'gait_gravel_wet_x12.wav', kind: 'foley', len: 14.6, size: 2_580_000, tag: 'library' },
  { name: 'heartbeat_driver_84bpm.wav', kind: 'pulse', len: 20.0, size: 3_530_000, tag: 'library' },
  { name: 'string_cluster_ponticello.wav', kind: 'strings', len: 18.2, size: 3_210_000, tag: 'library' },
  { name: 'impact_boom_cinema_01.wav', kind: 'impact', len: 5.0, size: 880_000, tag: 'library' },
  { name: 'riser_noise_shepard_4s.wav', kind: 'riser', len: 4.0, size: 706_000, tag: 'library' },
];
