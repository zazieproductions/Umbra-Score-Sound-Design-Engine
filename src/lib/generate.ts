import { mulberry32, hashString } from './prng';
import type { Layer, LayerKind, Project, Scene, SpaceId } from './types';
import { KIND_META } from './types';

const FRAMES = ['/frames/f1.jpg', '/frames/f2.jpg', '/frames/f3.jpg', '/frames/f4.jpg', '/frames/f5.jpg', '/frames/f6.jpg'];

/** Cinematic key centres (Hz). All pitched layers in a scene resolve to these. */
const ROOTS = [49, 55, 61.74, 65.41, 73.42]; // G1 · A1 · B1 · C2 · D2
const REGISTERS = [1, 1, 2, 1, 2, 1]; // octave register per scene index — keeps tonality, varies weight

interface BankEntry {
  title: string;
  tags: string[];
  summary: string;
  kinds: LayerKind[];
  space: SpaceId;
  tension: number;
}

/**
 * Cinematic scene archetypes. The arc rises from a sparse cold open through
 * pursuit to a full-brass reveal, then resolves — scored like a theatrical
 * three-act structure, not a flat drone wall.
 */
const SCENE_BANK: BankEntry[] = [
  {
    title: 'Cold Open / The Quiet',
    tags: ['interior', 'low-light', 'static camera'],
    summary:
      'Hold the room. Sparse detuned minor bed, sub pressure, close ambience and a faint choir thread; a slow clock tick keeps the floor alive. Dynamic floor kept low so the first cut lands.',
    kinds: ['drone', 'sub', 'ambience', 'texture', 'choir', 'tick'],
    space: 'hall',
    tension: 0.24,
  },
  {
    title: 'The Incursion',
    tags: ['contact', 'foreground motion', 'cut-in'],
    summary:
      'The door gives. Contact-heavy: three-part foley transients, a whoosh on the swing, marcato brass stabs and a stinger on the latch break over the drone bed.',
    kinds: ['foley', 'whoosh', 'brass', 'drone', 'stinger', 'sub'],
    space: 'room',
    tension: 0.44,
  },
  {
    title: 'Pursuit / Treeline',
    tags: ['exterior', 'handheld', 'fog'],
    summary:
      'Handheld chase through fog. Cardiac driver locked to gait, string tremolo rising, taiko hits on the turn, an accelerating tick and a riser pushing into the next cut.',
    kinds: ['pulse', 'strings', 'percussion', 'ambience', 'tick', 'riser', 'whoosh'],
    space: 'cathedral',
    tension: 0.68,
  },
  {
    title: 'The Reveal',
    tags: ['close-up', 'reveal', 'high tension'],
    summary:
      'The full stack lands. Braam + impact + brass + taiko with sub drop; reverse pre-bloom seeded 1.2 s ahead of the cut for the theatrical swell, choir thickening the ceiling.',
    kinds: ['braam', 'impact', 'brass', 'percussion', 'stinger', 'sub', 'choir', 'texture', 'strings'],
    space: 'cathedral',
    tension: 0.95,
  },
  {
    title: 'Counterattack / The Turn',
    tags: ['exterior', 'dolly', 'kinetic'],
    summary:
      'The hero turns the fight. Strings and choir lock to a driving pulse, brass and taiko answer each cut, risers and whooshes carry every transition at full dynamic swing.',
    kinds: ['strings', 'choir', 'pulse', 'brass', 'percussion', 'riser', 'whoosh', 'drone'],
    space: 'hall',
    tension: 0.82,
  },
  {
    title: 'Aftermath / Resolve',
    tags: ['reflection', 'low motion', 'resolve'],
    summary:
      'Tension releases. Drop the pulse and brass, retain sub pressure and a decaying cathedral drone tail, choir settles, and a downlifter bleeds into the outro cut. Loudness target dips for contrast.',
    kinds: ['drone', 'sub', 'ambience', 'choir', 'strings', 'downlifter'],
    space: 'cathedral',
    tension: 0.3,
  },
];

/*
 * Procedural layers are synthesised by Umbra's own Web Audio voices — there is
 * no trained model behind them. The label names the real synthesis class so the
 * UI never implies a model that does not exist.
 */
const PROCEDURAL_ENGINE = 'umbra-voices-17';

function mkLayer(kind: LayerKind, rnd: () => number, space: SpaceId, tension: number, root: number): Layer {
  const meta = KIND_META[kind];
  const bassy = kind === 'sub' || kind === 'pulse' || kind === 'impact' || kind === 'percussion';
  const wide = bassy ? 0.05 + rnd() * 0.12 : 0.4 + rnd() * 0.55;
  return {
    id: `L${Math.floor(rnd() * 1e9).toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`,
    name: meta.label,
    kind,
    model: PROCEDURAL_ENGINE,
    gain: 0.66 + rnd() * 0.32,
    pan: bassy ? 0 : (rnd() * 2 - 1) * 0.72,
    reverb: kind === 'sub' ? 0.08 : 0.38 + rnd() * 0.5,
    space: kind === 'sub' ? 'room' : space,
    width: wide,
    tone: 0.28 + rnd() * 0.5,
    intensity: Math.min(0.96, 0.24 + tension * 0.45 + rnd() * 0.3),
    attack: 0.15 + rnd() * 0.5,
    root,
    muted: false,
    solo: false,
    seed: Math.floor(rnd() * 999999),
    version: 1,
  };
}

export function analyzeProject(name: string, duration: number, videoUrl: string | null, sourceLabel: string): Project {
  const rnd = mulberry32(hashString(name + duration.toFixed(2)));
  // richer stacks: 5–9 scenes depending on reel length
  const count = Math.max(5, Math.min(9, Math.round(duration / 22)));
  const projectRoot = ROOTS[Math.floor(rnd() * ROOTS.length)];
  const scenes: Scene[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const remain = count - i;
    const span = Math.max(6, ((duration - cursor) / remain) * (0.75 + rnd() * 0.5));
    const start = cursor;
    const end = i === count - 1 ? duration : Math.min(duration, start + span);
    cursor = end;
    const bank = SCENE_BANK[i % SCENE_BANK.length];
    // three-act arc: bank archetype blended with position in the cut
    const arc = 0.18 + Math.pow(i / Math.max(1, count - 1), 1.3) * 0.78;
    const tension = Math.min(0.98, Math.max(0.12, bank.tension * 0.55 + arc * 0.5 + (rnd() - 0.5) * 0.08));
    const root = Math.min(146.83, projectRoot * REGISTERS[i % REGISTERS.length]);
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
      layers: bank.kinds.map((k) => mkLayer(k, rnd, bank.space, tension, root)),
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
    clips: [],
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
    model: PROCEDURAL_ENGINE,
  };
}

export function addLayer(kind: LayerKind, space: SpaceId = 'hall', tension = 0.6, root = 55): Layer {
  return mkLayer(kind, mulberry32(Math.floor(Math.random() * 1e9)), space, tension, root);
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
  { name: 'taiko_war_drum_D.wav', kind: 'percussion', len: 6.4, size: 1_140_000, tag: 'library' },
  { name: 'choir_pad_Amin_sustain.wav', kind: 'choir', len: 22.0, size: 3_880_000, tag: 'library' },
  { name: 'clock_tick_tension_loop.wav', kind: 'tick', len: 16.0, size: 1_260_000, tag: 'library' },
];
