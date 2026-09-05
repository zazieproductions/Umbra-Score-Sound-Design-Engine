// Unified types — merges PR6 AudioClip architecture with PR7 SoundClip provenance
// Preserve all PR7 library domains and PR6 generative domains in ONE canonical clip.

export type LayerKind =
  | 'drone'
  | 'sub'
  | 'ambience'
  | 'texture'
  | 'strings'
  | 'choir'
  | 'foley'
  | 'pulse'
  | 'tick'
  | 'riser'
  | 'downlifter'
  | 'whoosh'
  | 'braam'
  | 'brass'
  | 'percussion'
  | 'stinger'
  | 'impact';

export type SpaceId = 'room' | 'hall' | 'cathedral';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  model: string;
  gain: number; // 0 .. 1.3
  pan: number; // -1 .. 1
  reverb: number; // 0 .. 1
  space: SpaceId;
  width: number;
  tone: number;
  intensity: number;
  attack: number;
  root: number;
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

/* ==================================================================== *
 *  AUDIO CLIPS — ONE canonical timeline object
 *  Every provider — ACE-Step, Stable Audio, MMAudio, Umbra Procedural,
 *  Freesound, user library, Pixabay — ultimately lands on the timeline
 *  as an AudioClip. Clips are ordinary editable timeline objects: move,
 *  trim, split, fade, mute, solo, gain, pan, delete, regenerate,
 *  download, export. There is no separate "AI result" player.
 *
 *  Library provenance (asset, license, transform) is retained as optional
 *  extensions so retrieved clips keep their PR7 metadata without forking
 *  the type system.
 * ==================================================================== */

import type {
  LibraryAsset,
  SoundRole,
  ClipSource,
  TransformSpec,
} from './library/types';

export type ClipProvider =
  | 'umbra-procedural'
  | 'ace-step'
  | 'stable-audio'
  | 'mmaudio'
  | 'library'
  | 'user';

export interface ClipMetadata {
  provider: ClipProvider;
  model?: string | null;
  prompt?: string;
  negativePrompt?: string | null;
  seed?: number | string | null;
  bpm?: number | null;
  key?: string | null;
  mode?: string | null;
  keyScale?: string | null;
  timeSignature?: string | null;
  /** ACE-Step task this clip came from (text2music / complete / repaint …) */
  aceTaskType?: string;
  task?: string;
  referenceAudioId?: string | null;
  sourceAudioId?: string | null;
  /** full conditioning package actually sent to the model */
  generationSettings?: Record<string, unknown>;
  inferenceSeconds?: number;
  // allow arbitrary additional fields for provenance passthrough
  [key: string]: unknown;
}

export interface AudioClip {
  id: string;
  name: string;
  /** backend audio id — the real file behind this clip */
  audioId: string;
  /** URL the browser fetches and decodes; for cached library clips this is a blob URL or /api/audio proxy */
  url: string;
  provider: ClipProvider;

  /* placement on the project timeline (seconds) */
  start: number;
  /** visible length; may be shorter than the source after trimming */
  duration: number;
  /** trim offset into the source buffer */
  offset: number;
  /** full decoded source length — the trim ceiling */
  sourceDuration: number;

  /* mix */
  gain: number; // 0 .. 1.5
  pan: number; // -1 .. 1
  fadeIn: number; // seconds
  fadeOut: number;
  muted: boolean;
  solo: boolean;
  locked?: boolean;

  /* real measured properties of the decoded file */
  sampleRate: number;
  channels: number;

  metadata: ClipMetadata;
  createdAt: number;
  /** bumped on every regenerate so the UI can show variant history */
  version: number;

  /* --- library / retrieval extensions (optional) --- */
  /** semantic role when this clip originated from sound retrieval */
  role?: SoundRole;
  /** legacy ClipSource tag (LIB/USR/GEN/VID/PROC/PIX) — kept for backwards compat */
  source?: ClipSource;
  /** cache key of the blob in soundCache (for library clips) */
  cacheKey?: string;
  /** full library asset with provenance, license, tags */
  asset?: LibraryAsset;
  /** nondestructive transform applied to the source (PR7 horror drone recipe etc) */
  transform?: TransformSpec;
  /** intent that produced this clip */
  intentId?: string;
  /** retrieval match score 0..1 */
  match?: number;
  familyId?: string;
  variantIndex?: number;
  // legacy end time (derived as start+duration, kept for some UI compat)
  end?: number;
}

export const CLIP_PROVIDER_META: Record<ClipProvider, { label: string; color: string; short: string }> = {
  'umbra-procedural': { label: 'Umbra Procedural', color: '#ff3b5c', short: 'PROC' },
  'ace-step': { label: 'ACE-Step', color: '#7fb6e0', short: 'ACE' },
  'stable-audio': { label: 'Stable Audio', color: '#4b8f9a', short: 'SAO' },
  mmaudio: { label: 'MMAudio', color: '#b9a37e', short: 'MMA' },
  library: { label: 'Library', color: '#a86bd6', short: 'LIB' },
  user: { label: 'User audio', color: '#c0a3e6', short: 'USR' },
};

// Keep a deprecated alias so existing imports of SoundClip continue to type-check
// but code should migrate to AudioClip. The library tests import SoundClip from
// './library/types', not from here, so this is for studio usage only.
export type SoundClip = AudioClip;

export interface Project {
  id: string;
  name: string;
  source: string;
  duration: number;
  fps: number;
  resolution: string;
  videoUrl: string | null;
  scenes: Scene[];
  /** unified timeline clips: generative + retrieved + imported share one model */
  clips: AudioClip[];
  /** user-marked final-cut events (e.g. DOOR OPEN @ 00:18.4) */
  spotting: import('./library/types').SpottingEvent[];
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
  drone: { label: 'Drone Bed', color: '#7d6bff', short: 'DRN', blurb: 'Eight-voice detuned minor cluster with sub-octave anchor and airy shimmer, breathing filter.', trim: 0.2, event: false },
  sub: { label: 'Sub Pressure', color: '#5847d6', short: 'SUB', blurb: 'Layered infrasonic bed — fundamental, fifth and sub-octave with resonant 46 Hz weight for theatrical LFE.', trim: 0.5, event: false },
  ambience: { label: 'Ambience', color: '#4b8f9a', short: 'AMB', blurb: 'Three-band resonant room tone plus low rumble and air band, slowly drifting across the stereo field.', trim: 0.16, event: false },
  texture: { label: 'Whisper Texture', color: '#a86bd6', short: 'TEX', blurb: 'Formant-filtered breath layer with a drifting vowel bank and close-mic intimacy.', trim: 0.18, event: false },
  strings: { label: 'String Section', color: '#c0a3e6', short: 'STR', blurb: 'Four-section ensemble — basses, celli, violas, violins — legato swells, vibrato and spiccato stabs.', trim: 0.24, event: false },
  choir: { label: 'Choir Pad', color: '#7fb6e0', short: 'CHR', blurb: 'Airy vowel choir through a formant bank, slow attack and cathedral bloom.', trim: 0.2, event: false },
  foley: { label: 'Foley', color: '#b9a37e', short: 'FOL', blurb: 'Three-part transients — click, body, tail — with per-hit randomisation.', trim: 0.4, event: true },
  pulse: { label: 'Heart Pulse', color: '#c01033', short: 'PLS', blurb: 'Two-beat cardiac driver with sub thump and chest resonance locked to gait.', trim: 0.4, event: true },
  tick: { label: 'Tension Tick', color: '#b7b0c9', short: 'TCK', blurb: 'Accelerating clock tick that tightens with tension — the classic dread meter.', trim: 0.22, event: true },
  riser: { label: 'Riser', color: '#e0663f', short: 'RIS', blurb: 'Accelerating noise + pitch swell that resolves on the cut with a sub drop.', trim: 0.3, event: true },
  downlifter: { label: 'Downlifter', color: '#3fa9a0', short: 'DWN', blurb: 'Reverse pitch-fall and noise sweep into a sub drop that lands on the cut.', trim: 0.3, event: true },
  whoosh: { label: 'Whoosh Pass', color: '#6fb3c0', short: 'WSH', blurb: 'Doppler noise sweep travelling across the stereo field.', trim: 0.28, event: true },
  braam: { label: 'Braam', color: '#d8a24a', short: 'BRM', blurb: 'Stacked brass cluster with octave-down doubling, rasp drive and reverse pre-bloom.', trim: 0.4, event: true },
  brass: { label: 'Brass Stab', color: '#f0c060', short: 'BRS', blurb: 'Marcato horn stabs with rasp drive, pitch-dip attack and sub weight — theatrical accents.', trim: 0.34, event: true },
  percussion: { label: 'Taiko / Percussion', color: '#c9824f', short: 'PER', blurb: 'Deep taiko hits, rim transients and chest thump layered for battle weight.', trim: 0.44, event: true },
  stinger: { label: 'Stinger', color: '#ff3b5c', short: 'STG', blurb: 'Metallic FM crack, shriek band, sub drop and reverse swell aligned to the cut.', trim: 0.44, event: true },
  impact: { label: 'Impact', color: '#ff6a3d', short: 'IMP', blurb: 'Layered cinema boom — pre-thud, sub sweep, distorted mid thwack, ring and air burst, cathedral tail.', trim: 0.5, event: true },
};

export const KIND_ORDER: LayerKind[] = ['drone','sub','ambience','texture','strings','choir','foley','pulse','tick','riser','downlifter','whoosh','braam','brass','percussion','stinger','impact'];

export const SPACES: { id: SpaceId; label: string; note: string }[] = [
  { id: 'room', label: 'Room', note: '0.85 s · tight early reflections' },
  { id: 'hall', label: 'Scoring stage', note: '3.1 s · orchestral hall' },
  { id: 'cathedral', label: 'Cathedral', note: '5.6 s · long diffuse tail' },
];

// Helpers to bridge between old SoundClip (library) and new AudioClip unified
export function audioClipToSoundClipCompat(c: AudioClip): import('./library/types').SoundClip {
  // This is a best-effort conversion for legacy UI that expects SoundClip fields
  // AudioClip already contains superset, so we just cast and ensure required fields
  const lib = c as unknown as import('./library/types').SoundClip;
  if (lib.start != null && lib.end == null && c.duration != null) {
    lib.end = c.start + c.duration;
  }
  return lib;
}
export function soundClipToAudioClip(s: import('./library/types').SoundClip): AudioClip {
  // Convert a library SoundClip into the unified AudioClip shape
  const dur = s.end - s.start;
  return {
    id: s.id,
    name: s.name,
    audioId: s.cacheKey,
    url: `blob:${s.cacheKey}`, // placeholder; actual blob URL resolved via soundCache at playback
    provider: s.source === 'USR' ? 'user' : 'library',
    start: s.start,
    duration: dur,
    offset: s.offset,
    sourceDuration: s.asset?.duration ?? dur,
    gain: s.gain,
    pan: s.pan,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    muted: s.muted,
    solo: s.solo,
    sampleRate: s.asset?.sampleRate ?? 48000,
    channels: s.asset?.channels ?? 1,
    metadata: { provider: s.source === 'USR' ? 'user' : 'library', prompt: s.asset?.title ?? s.name } as ClipMetadata,
    createdAt: Date.now(),
    version: 1,
    role: s.role,
    source: s.source,
    cacheKey: s.cacheKey,
    asset: s.asset,
    transform: s.transform,
    intentId: s.intentId,
    match: s.match,
    familyId: s.familyId,
    variantIndex: s.variantIndex,
    end: s.end,
  };
}
