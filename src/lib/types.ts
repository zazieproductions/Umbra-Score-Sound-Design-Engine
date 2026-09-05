export type LayerKind =
  | 'drone'
  | 'sub'
  | 'ambience'
  | 'texture'
  | 'strings'
  | 'foley'
  | 'pulse'
  | 'riser'
  | 'whoosh'
  | 'braam'
  | 'stinger'
  | 'impact';

export type SpaceId = 'room' | 'hall' | 'cathedral';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  model: string;
  gain: number;      // 0 .. 1.3   fader
  pan: number;       // -1 .. 1
  reverb: number;    // 0 .. 1     send amount
  space: SpaceId;    // which convolution space
  width: number;     // 0 .. 1     Haas decorrelation
  tone: number;      // 0 .. 1     spectral centre
  intensity: number; // 0 .. 1     drive / density / rate
  attack: number;    // 0 .. 1     transient softness
  muted: boolean;
  solo: boolean;
  seed: number;
  version: number;
}

export type SceneStatus = 'queued' | 'analyzing' | 'generating' | 'ready';

export interface Scene {
  id: string;
  index: number;
  start: number;
  end: number;
  title: string;
  frame: string;
  tags: string[];
  tension: number;
  motion: number;
  summary: string;
  status: SceneStatus;
  hits: number[];
  layers: Layer[];
}

export interface Project {
  id: string;
  name: string;
  source: string;
  duration: number;
  fps: number;
  resolution: string;
  videoUrl: string | null;
  scenes: Scene[];
  createdAt: number;
}

export interface RenderJob {
  id: string;
  label: string;
  format: string;
  resolution: string;
  progress: number;
  state: 'rendering' | 'encoding' | 'complete' | 'failed';
  bytes: number;
  at: number;
  url?: string;
  filename?: string;
  peak?: number;
  lufs?: number;
}

export interface KindMeta {
  label: string;
  color: string;
  short: string;
  blurb: string;
  /** static mix trim so the default stack sits balanced */
  trim: number;
  event: boolean;
}

export const KIND_META: Record<LayerKind, KindMeta> = {
  drone: {
    label: 'Drone Bed',
    color: '#7d6bff',
    short: 'DRN',
    blurb: 'Five-voice detuned minor cluster, breathing filter, orchestral weight.',
    trim: 0.3,
    event: false,
  },
  sub: {
    label: 'Sub Pressure',
    color: '#5847d6',
    short: 'SUB',
    blurb: 'Infrasonic bed with rectified octave reinforcement — theatrical LFE.',
    trim: 0.62,
    event: false,
  },
  ambience: {
    label: 'Ambience',
    color: '#4b8f9a',
    short: 'AMB',
    blurb: 'Pink-noise room tone through a resonant three-band bank, wide stereo.',
    trim: 0.22,
    event: false,
  },
  texture: {
    label: 'Whisper Texture',
    color: '#a86bd6',
    short: 'TEX',
    blurb: 'Formant-filtered breath layer, drifting vowel bank, close-mic intimacy.',
    trim: 0.24,
    event: false,
  },
  strings: {
    label: 'String Cluster',
    color: '#c0a3e6',
    short: 'STR',
    blurb: 'Sul-ponticello ensemble, dissonant cluster, fast tremolo bowing.',
    trim: 0.24,
    event: false,
  },
  foley: {
    label: 'Foley',
    color: '#b9a37e',
    short: 'FOL',
    blurb: 'Three-part transients — click, body, tail — with per-hit randomisation.',
    trim: 0.44,
    event: true,
  },
  pulse: {
    label: 'Heart Pulse',
    color: '#c01033',
    short: 'PLS',
    blurb: 'Two-beat cardiac driver with sub thump and chest resonance.',
    trim: 0.5,
    event: true,
  },
  riser: {
    label: 'Riser',
    color: '#e0663f',
    short: 'RIS',
    blurb: 'Accelerating noise + pitch swell that resolves on the cut.',
    trim: 0.34,
    event: true,
  },
  whoosh: {
    label: 'Whoosh Pass',
    color: '#6fb3c0',
    short: 'WSH',
    blurb: 'Doppler noise sweep travelling across the stereo field.',
    trim: 0.32,
    event: true,
  },
  braam: {
    label: 'Braam',
    color: '#d8a24a',
    short: 'BRM',
    blurb: 'Stacked brass cluster with rasp drive and reverse pre-bloom.',
    trim: 0.4,
    event: true,
  },
  stinger: {
    label: 'Stinger',
    color: '#ff3b5c',
    short: 'STG',
    blurb: 'Metallic FM crack, sub drop and reverse swell aligned to the cut.',
    trim: 0.5,
    event: true,
  },
  impact: {
    label: 'Impact',
    color: '#ff6a3d',
    short: 'IMP',
    blurb: 'Cinema boom — sub sweep, distorted mid thwack, cathedral tail.',
    trim: 0.58,
    event: true,
  },
};

export const KIND_ORDER: LayerKind[] = [
  'drone',
  'sub',
  'ambience',
  'texture',
  'strings',
  'foley',
  'pulse',
  'riser',
  'whoosh',
  'braam',
  'stinger',
  'impact',
];

export const SPACES: { id: SpaceId; label: string; note: string }[] = [
  { id: 'room', label: 'Room', note: '0.85 s · tight early reflections' },
  { id: 'hall', label: 'Scoring stage', note: '2.6 s · orchestral hall' },
  { id: 'cathedral', label: 'Cathedral', note: '5.6 s · long diffuse tail' },
];
