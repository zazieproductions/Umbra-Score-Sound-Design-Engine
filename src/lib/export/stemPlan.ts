/* ==================================================================== *
 *  STEM PLAN — pure, deterministic delivery planning
 *
 *  Owns the export-side stem taxonomy (creative post buses + engineering
 *  source buses) and turns a Project + scope + tail policy into a set of
 *  render passes. NO Web Audio here: the plan is plain data, fully unit
 *  testable in Node, and consumed by two executors:
 *
 *    stemRender.ts        — production: Web Audio graph, the SAME DSP
 *                           primitives as the monitor / renderScore.
 *    referenceKernel.ts   — test/tooling: deterministic algebra mirror
 *                           used to prove timing + partition invariants.
 *
 *  Stem architecture (see ADR-0005):
 *    • every audible source lands in exactly ONE creative stem and ONE
 *      source stem — partitions never overlap internally;
 *    • reverb sends render per-pass from that pass's own material
 *      (deterministic IR seeds, identical at 'render' quality), so no
 *      reverb energy is duplicated and none is lost;
 *    • the nonlinear sub-chain output is owned by SUB_LFE (gated by
 *      master.subOut);
 *    • stems bypass the shared nonlinear master-bus stages (glue / tape /
 *      exciter / limiter) so Σ stems reconstructs the pre-master mix
 *      exactly; the MASTER file applies them plus BS.1770 conform.
 * ==================================================================== */

import { BASS_KINDS, HIT_KINDS } from '../dsp';
import {
  DEFAULT_TAIL,
  deliverySpan,
  secToSample,
  tailSeconds,
  type FrameSpan,
  type RenderClock,
  type TailPolicy,
} from './clock';
import { clipEnd } from '../clips';
import type { AudioClip, LayerKind, Project, Scene } from '../types';
import type { SoundRole } from '../library/types';

/* --------------------------------------------------- creative buses ---- */

/** Professional post-production delivery buses (export-side taxonomy). */
export type CreativeBus = 'MX' | 'AMB' | 'FOLEY' | 'SFX' | 'DESIGN' | 'IMPACTS' | 'SUB_LFE';

/** Engineering / provenance buses — a different *axis*, not a substitute. */
export type SourceBus = 'PROCEDURAL' | 'GENERATED' | 'LIBRARY' | 'USER';

export const CREATIVE_BUSES: CreativeBus[] = ['MX', 'AMB', 'FOLEY', 'SFX', 'DESIGN', 'IMPACTS', 'SUB_LFE'];
export const SOURCE_BUSES: SourceBus[] = ['PROCEDURAL', 'GENERATED', 'LIBRARY', 'USER'];

export const CREATIVE_BUS_META: Record<CreativeBus, { label: string; blurb: string; color: string }> = {
  MX: { label: 'MX — Music', blurb: 'Score / music cues and musical beds', color: '#7fb6e0' },
  AMB: { label: 'AMB — Ambience', blurb: 'Room tones, atmospheres, wind, weather, environmental beds', color: '#4b8f9a' },
  FOLEY: { label: 'FOLEY', blurb: 'Footsteps, cloth, body movement, practical doors, object handling', color: '#b9a37e' },
  SFX: { label: 'SFX', blurb: 'Mechanical, electrical, vehicles, water, general effects', color: '#c0a3e6' },
  DESIGN: { label: 'DESIGN', blurb: 'Drones, textures, processed sound design, abstract/generative material', color: '#a86bd6' },
  IMPACTS: { label: 'IMPACTS', blurb: 'Impacts, braams, stingers, hits, transitions, transient rumbles', color: '#ff6a3d' },
  SUB_LFE: { label: 'SUB_LFE', blurb: 'Dedicated low-frequency bus: sub chain + design rumbles', color: '#5847d6' },
};

export const SOURCE_BUS_META: Record<SourceBus, { label: string; blurb: string }> = {
  PROCEDURAL: { label: 'PROCEDURAL', blurb: 'Umbra procedural engine voices + procedural clips' },
  GENERATED: { label: 'GENERATED', blurb: 'Model-generated audio (ACE-Step, Stable Audio, MMAudio)' },
  LIBRARY: { label: 'LIBRARY', blurb: 'Retrieved library audio (Freesound / assisted)' },
  USER: { label: 'USER', blurb: 'User-imported audio' },
};

/* ------------------------------------------------- classification ---- */

/** LayerKind → creative bus. Explicit, small, documented, testable. */
export const LAYER_KIND_STEM: Record<LayerKind, CreativeBus> = {
  drone: 'DESIGN',
  sub: 'SUB_LFE',
  ambience: 'AMB',
  texture: 'DESIGN',
  strings: 'MX',
  choir: 'MX',
  foley: 'FOLEY',
  pulse: 'MX',
  tick: 'SFX',
  riser: 'IMPACTS',
  downlifter: 'IMPACTS',
  whoosh: 'IMPACTS',
  braam: 'IMPACTS',
  brass: 'IMPACTS',
  percussion: 'IMPACTS',
  stinger: 'IMPACTS',
  impact: 'IMPACTS',
};

/**
 * SoundRole (the retrieval taxonomy — consumed here, never modified) →
 * creative bus. Unknown material falls through to SFX; it never disappears.
 */
export const ROLE_STEM: Record<SoundRole, CreativeBus> = {
  ROOM_TONE: 'AMB',
  AMBIENCE: 'AMB',
  WIND: 'AMB',
  WEATHER: 'AMB',
  ANIMAL: 'AMB',
  FOOTSTEP: 'FOLEY',
  CLOTHING: 'FOLEY',
  BODY: 'FOLEY',
  BREATH: 'FOLEY',
  DOOR: 'FOLEY',
  CREAK: 'FOLEY',
  KNOCK: 'FOLEY',
  RATTLE: 'FOLEY',
  SCRAPE: 'FOLEY',
  WOOD: 'FOLEY',
  MECHANICAL: 'SFX',
  ELECTRICAL: 'SFX',
  VEHICLE: 'SFX',
  WATER: 'SFX',
  GLASS: 'SFX',
  METAL: 'SFX',
  IMPACT: 'IMPACTS',
  TRANSITION: 'IMPACTS',
  RUMBLE: 'IMPACTS',
  DRONE: 'DESIGN',
  TEXTURE: 'DESIGN',
  MISC_FOLEY: 'FOLEY',
};

/**
 * Generic keyword hints (English). Applied only when a clip carries no
 * semantic role — a safety net for hand-placed material, deliberately short
 * so it can never turn into a secret classifier. First match wins.
 */
const KEYWORD_STEMS: [RegExp, CreativeBus][] = [
  [/\b(foot ?steps?|heel|toe|cloth|fabric|body ?mov|handling)\b/, 'FOLEY'],
  [/\b(door|creak|hinge|latch|drawer|knob)\b/, 'FOLEY'],
  [/\b(room ?tone|atmo(sphere)?|ambience|environment|field recording|rain|storm|thunder|wind|bird|insect)\b/, 'AMB'],
  [/\b(impact|braam|boom|stinger|hit|whoosh|riser|down ?lifter|trailer hit|transition)\b/, 'IMPACTS'],
  [/\b(drone|texture|bed|pad|swell|sub ?bass|low end|designed)\b/, 'DESIGN'],
  [/\b(engine|motor|machine|mechanical|electric|generator|vehicle|car|water|drip|splash|glass|metal)\b/, 'SFX'],
];

/** A sustained rumble reads as design; a transient rumble reads as impact. */
function rumbleIsSustained(text: string): boolean {
  return /\b(bed|drone|tone|hum|low end|sub)\b/.test(text);
}

export const STEM_OVERRIDE_KEY = 'umbraStem';

function isCreativeBus(v: unknown): v is CreativeBus {
  return typeof v === 'string' && (CREATIVE_BUSES as string[]).some((b) => b === v.toUpperCase());
}

/**
 * classifyForStem(clip) → the single creative stem bus a clip belongs to.
 *
 * Precedence (documented, fixed):
 *   1. explicit override  — metadata[STEM_OVERRIDE_KEY] ('DESIGN', …)
 *   2. semantic role      — clip.role from the retrieval planner
 *   3. name/tag keywords  — generic English hints
 *   4. provider default   — ace-step → MX, stable-audio/mmaudio → DESIGN,
 *                           procedural clip with a known kind → that kind's bus
 *   5. fallback           — SFX (never drop material, never guess AMB)
 */
export function classifyForStem(clip: AudioClip): CreativeBus {
  const override = clip.metadata?.[STEM_OVERRIDE_KEY];
  if (isCreativeBus(override)) return override.toUpperCase() as CreativeBus;

  if (clip.role && ROLE_STEM[clip.role]) {
    if (clip.role === 'RUMBLE' && rumbleIsSustained(clipText(clip))) return 'DESIGN';
    return ROLE_STEM[clip.role];
  }

  const text = clipText(clip);
  for (const [re, bus] of KEYWORD_STEMS) if (re.test(text)) return bus;

  switch (clip.provider) {
    case 'ace-step':
      return 'MX';
    case 'stable-audio':
    case 'mmaudio':
      return 'DESIGN';
    case 'umbra-procedural': {
      const kind = (clip.metadata?.generationSettings as { kind?: LayerKind } | undefined)?.kind;
      if (kind && LAYER_KIND_STEM[kind]) return LAYER_KIND_STEM[kind];
      return 'SFX';
    }
    default:
      return 'SFX';
  }
}

function clipText(clip: AudioClip): string {
  const parts = [clip.name];
  if (clip.asset?.title) parts.push(clip.asset.title);
  if (clip.asset?.tags?.length) parts.push(clip.asset.tags.join(' '));
  if (typeof clip.metadata?.prompt === 'string') parts.push(clip.metadata.prompt);
  return parts.join(' ').toLowerCase();
}

/** provider → engineering source bus (provenance axis). */
export function classifySource(clip: AudioClip): SourceBus {
  switch (clip.provider) {
    case 'umbra-procedural':
      return 'PROCEDURAL';
    case 'ace-step':
    case 'stable-audio':
    case 'mmaudio':
      return 'GENERATED';
    case 'library':
      return 'LIBRARY';
    case 'user':
      return 'USER';
    default:
      return 'LIBRARY';
  }
}

/** True when a layer's channel contributes to the nonlinear sub-chain. */
export function layerFeedsSub(kind: LayerKind): boolean {
  return kind === 'sub' || BASS_KINDS.includes(kind);
}
export function layerIsSubOwner(kind: LayerKind): boolean {
  return kind === 'sub';
}
/** music-style material rides the ducked bus (mirrors scheduleClip + buildChannel). */
export function layerIsMusic(kind: LayerKind): boolean {
  return !HIT_KINDS.includes(kind) && !layerIsSubOwner(kind);
}
export function clipIsMusic(clip: AudioClip): boolean {
  return clip.provider === 'ace-step';
}

/* ------------------------------------------------------------ ducks ---- */

export interface DuckEvent {
  at: number; // seconds on the render clock, pass-local origin
  depth: number;
  attack: number;
  release: number;
}

/**
 * The authoritative scene-seam duck list. render.ts schedules exactly these;
 * the planner records them per pass; the reference kernel applies the same
 * automation — one source of truth for the pump, so a stem's ducking matches
 * the mix's ducking sample for sample.
 */
export function sceneDuckEvents(scenes: Pick<Scene, 'start' | 'end'>[], total: number): DuckEvent[] {
  const out: DuckEvent[] = [];
  for (const scene of scenes) {
    const start = Math.max(0, scene.start);
    const end = Math.min(total, scene.end);
    if (end - start < 0.05) continue;
    if (start > 0.05) out.push({ at: start, depth: 0.16, attack: 0.01, release: 0.6 });
  }
  return out;
}

/* -------------------------------------------------- solo / audibility -- */

export type SoloPolicy = 'ignore' | 'honor';

/**
 * Delivery audibility policy (documented invariant):
 *   • muted  — ALWAYS honored. A muted clip never appears in any stem.
 *   • solo   — by default IGNORED for delivery: a leftover solo button in
 *     the monitor must not silently strip material from stems. `honor`
 *     opts into the transient monitor behaviour on request.
 */
export function normalizeSoloScenes(scenes: Scene[], soloPolicy: SoloPolicy): Scene[] {
  if (soloPolicy === 'honor') return scenes;
  return scenes.map((s) => ({ ...s, layers: s.layers.map((l) => (l.solo ? { ...l, solo: false } : l)) }));
}
export function normalizeSoloClips(clips: AudioClip[], soloPolicy: SoloPolicy): AudioClip[] {
  if (soloPolicy === 'honor') return clips;
  return clips.map((c) => (c.solo ? { ...c, solo: false } : c));
}

/** Delivery audibility of a clip after solo-policy normalisation has run. */
export function clipIsAudible(c: AudioClip, soloPolicy: SoloPolicy, clips: AudioClip[]): boolean {
  if (c.muted) return false;
  if (soloPolicy === 'honor' && clips.some((x) => x.solo) && !c.solo) return false;
  return true;
}

/* ------------------------------------------------------------ scopes --- */

export type DeliveryScope = { kind: 'full' } | { kind: 'range'; start: number; end: number } | { kind: 'scene'; sceneId: string };

export interface PictureAuthority {
  /** Authoritative picture end in project seconds for this scope. */
  pictureEnd: number;
  /** Where the number came from — surfaced in the manifest, never guessed. */
  source: 'project' | 'range' | 'scene' | 'last-event-fallback';
  note?: string;
}

/**
 * §8 — video duration as delivery authority.
 * The expected span comes from project metadata (an imported video's
 * duration lives in Project.duration), NOT from whichever audio layer
 * happens to end last. Only when the project carries no usable duration do
 * we fall back to the furthest timeline event, and the manifest says so.
 */
export function resolvePictureEnd(project: Project, scope: DeliveryScope): PictureAuthority {
  if (scope.kind === 'range') {
    const start = Math.max(0, Math.min(scope.start, scope.end));
    const end = Math.max(start, scope.end);
    return { pictureEnd: end - start, source: 'range', note: `selected range ${start.toFixed(3)}–${end.toFixed(3)} s` };
  }
  if (scope.kind === 'scene') {
    const scene = project.scenes.find((s) => s.id === scope.sceneId);
    if (scene) return { pictureEnd: scene.end - scene.start, source: 'scene', note: scene.title || scene.id };
    return { pictureEnd: Math.max(0, project.duration), source: 'project', note: 'scene not found — full project used' };
  }
  if (project.duration > 0) {
    return {
      pictureEnd: project.duration,
      source: 'project',
      note: project.videoUrl ? 'imported video duration (project metadata)' : 'project timeline duration',
    };
  }
  const last = Math.max(0, ...project.scenes.map((s) => s.end), ...(project.clips ?? []).map((c) => clipEnd(c)));
  return { pictureEnd: last, source: 'last-event-fallback', note: 'project has no resolved duration — derived from furthest event' };
}

/** Window (project seconds) for a scope — the origin of every stem file. */
export function scopeWindow(project: Project, scope: DeliveryScope): { start: number; end: number } {
  if (scope.kind === 'range') {
    const start = Math.max(0, Math.min(scope.start, scope.end));
    return { start, end: Math.max(start, scope.end) };
  }
  if (scope.kind === 'scene') {
    const scene = project.scenes.find((s) => s.id === scope.sceneId);
    if (scene) return { start: scene.start, end: scene.end };
  }
  return { start: 0, end: project.duration };
}

/**
 * Remap scenes into a window, origin-shifted — mirrors exactly what
 * renderScore() does for a single-scene bounce, so scene-relative
 * synchronization is preserved for range and scene scopes too.
 */
export function remapScenes(scenes: Scene[], windowStart: number, windowEnd: number): Scene[] {
  return scenes
    .filter((s) => s.end > windowStart && s.start < windowEnd)
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - windowStart),
      end: Math.min(windowEnd - windowStart, s.end - windowStart),
      hits: s.hits.map((h) => h - windowStart).filter((h) => h >= 0),
    }));
}

/* ------------------------------------------------------------- passes -- */

export type PassMode = 'master' | 'creative' | 'source' | 'reference' | 'clip-processed' | 'clip-sync';
export type PackageFolder = 'Mix' | 'Post_Stems' | 'Source_Stems' | 'Individual_Clips' | 'Debug' | 'Root';

/** One clip's exact placement inside one pass — all values in samples. */
export interface PlannedClipPlacement {
  clipId: string;
  /** Absolute project sample of the clip's timeline start (the sync anchor). */
  startSampleAbs: number;
  /** Absolute project sample where the clip's visible content ends. */
  endSampleAbs: number;
  /** Sample within this stem file where content begins (>= 0). */
  atSample: number;
  /** Sample into the decoded source buffer where reading begins (head trim applied). */
  offsetSample: number;
  /** Source frames consumed by this pass (0 → skipped). */
  frameCount: number;
  headTrimSamples: number;
  tailTrimSamples: number;
  /** Mirrors scheduleClip()'s fade clamping, expressed in whole samples. */
  fadeInSamples: number;
  fadeOutSamples: number;
  gain: number;
  pan: number;
  isMusic: boolean;
  creativeBus: CreativeBus;
  sourceBus: SourceBus;
}

export interface PassLayerRef {
  sceneId: string;
  layerId: string;
  kind: LayerKind;
  /** fader feeds the summed buses (false = output only through the sub-chain) */
  dry: boolean;
  /** channel reverb sends active (false = send gains forced to 0) */
  verb: boolean;
  /** the layer's FULL fader output feeds the sub-chain (SUB-kind layers) */
  subFull: boolean;
}

export interface StemPassPlan {
  id: string;
  label: string;
  mode: PassMode;
  /** creative bus id, source bus id, or 'CLIP' for individual exports */
  bus: string;
  folder: PackageFolder;
  fileName: string;
  /** Frames in the output file. Consolidated passes share plan.span.frameCount. */
  frameCount: number;
  subOut: boolean;
  masterFx: boolean;
  /** BS.1770 conform + true-peak limiting — applied to the MASTER file only. */
  loudnessConform: boolean;
  clips: PlannedClipPlacement[];
  layers: PassLayerRef[];
  duck: DuckEvent[];
  /** audible clips that had to be skipped — reported, never silent */
  skippedClipIds: { clipId: string; reason: 'too-short' }[];
}

interface LayerEntry {
  sceneId: string;
  layerId: string;
  kind: LayerKind;
  bus: CreativeBus;
  audible: boolean;
  feedsSub: boolean;
  subOwner: boolean;
}

export interface DeliveryPlan {
  projectName: string;
  clock: RenderClock;
  scope: DeliveryScope;
  /** Project-seconds origin of the delivery window (0 for full film). */
  windowStart: number;
  /** Picture length inside the window (seconds, excludes tail). */
  pictureEnd: number;
  picture: PictureAuthority;
  tail: TailPolicy;
  tailSeconds: number;
  /** Shared span — EVERY consolidated stem file has exactly these frames. */
  span: FrameSpan;
  fps: number;
  soloPolicy: SoloPolicy;
  soloActiveClips: number;
  soloActiveLayers: number;
  /** Scenes remapped to the window origin, solo policy applied. */
  scenes: Scene[];
  /** All clips intersecting the window (solo-normalized), muted included. */
  clips: AudioClip[];
  /** Clips actually rendered (audible after the delivery policy). */
  audibleClips: AudioClip[];
  mutedClipIds: string[];
  passes: StemPassPlan[];
}

/** Minimum content length kept in a pass — mirrors scheduleClips' 0.02 s floor. */
export const MIN_CONTENT_SECONDS = 0.02;

export interface PlanOpts {
  clock: RenderClock;
  scope: DeliveryScope;
  tail?: TailPolicy;
  /** which creative buses to emit (empty = none). SUB_LFE included only if present. */
  creative?: CreativeBus[];
  /** which source-mode buses to emit (empty = off). */
  sources?: SourceBus[];
  includeMaster?: boolean;
  /** debug: pre-master reference file for reconstruction conformance in a DAW */
  includeMixReference?: boolean;
  soloPolicy?: SoloPolicy;
  /** per-clip individual exports */
  individualClips?: 'none' | 'processed' | 'sync' | 'both';
  /** file-name resolver injected to keep this module free of naming/UI deps */
  fileName: (folder: PackageFolder, key: string, ext: string) => string;
}

/**
 * Build the full delivery plan. Pure function — same project in, same
 * pass list out, sample for sample.
 */
export function planDelivery(project: Project, opts: PlanOpts): DeliveryPlan {
  const clock = opts.clock;
  const tail = opts.tail ?? DEFAULT_TAIL;
  const soloPolicy: SoloPolicy = opts.soloPolicy ?? 'ignore';
  const { start: windowStart } = scopeWindow(project, opts.scope);
  // §8: the picture END is authoritative delivery metadata — always resolved
  // through resolvePictureEnd (project/video duration first, never "whatever
  // layer ended last" unless there is no duration at all, and then labelled).
  const picture = resolvePictureEnd(project, opts.scope);
  const pictureEnd = Math.max(0, picture.pictureEnd);
  const windowEnd = windowStart + pictureEnd;
  const span = deliverySpan(windowStart, windowEnd, tail, clock);
  const fps = project.fps && project.fps > 0 ? project.fps : 24;

  const scenes = normalizeSoloScenes(remapScenes(project.scenes, windowStart, windowStart + pictureEnd), soloPolicy);
  const soloActiveLayers = project.scenes.reduce((a, s) => a + s.layers.filter((l) => l.solo).length, 0);
  const allClips = normalizeSoloClips(project.clips ?? [], soloPolicy);
  const soloActiveClips = (project.clips ?? []).filter((c) => c.solo).length;

  const windowStartAbs = span.startSample;
  const deliveryEndAbs = span.endSample;
  const minFrames = Math.floor(MIN_CONTENT_SECONDS * clock.sampleRate);

  const inScope = allClips.filter((c) => {
    const relStart = secToSample(c.start - windowStart, clock);
    const relEnd = secToSample(clipEnd(c) - windowStart, clock);
    return relEnd > 0 && relStart < span.frameCount;
  });
  const anySolo = soloPolicy === 'honor' && allClips.some((c) => c.solo);
  const audible = inScope.filter((c) => !c.muted && !(anySolo && !c.solo));
  const mutedClipIds = inScope.filter((c) => c.muted).map((c) => c.id);

  /* ---- clip placements (windowed) — computed once, shared by all passes -- */
  const placements = new Map<string, PlannedClipPlacement>();
  const skipped = new Map<string, 'too-short'>();
  for (const c of audible) {
    const startAbs = secToSample(c.start, clock);
    const wanted = Math.max(0, secToSample(c.duration, clock));
    const relStart = startAbs - windowStartAbs;
    const headTrim = Math.max(0, -relStart);
    const tailTrim = Math.max(0, startAbs + wanted - deliveryEndAbs);
    const frameCount = wanted - headTrim - tailTrim;
    if (frameCount <= minFrames) {
      skipped.set(c.id, 'too-short');
      continue;
    }
    const fadeIn = Math.max(0.002, Math.min(c.fadeIn, (frameCount / clock.sampleRate) * 0.5));
    const fadeOut = Math.max(0.002, Math.min(c.fadeOut, (frameCount / clock.sampleRate) * 0.5));
    placements.set(c.id, {
      clipId: c.id,
      startSampleAbs: startAbs,
      endSampleAbs: startAbs + wanted,
      atSample: Math.max(0, relStart),
      offsetSample: secToSample(c.offset, clock) + headTrim,
      frameCount,
      headTrimSamples: headTrim,
      tailTrimSamples: tailTrim,
      fadeInSamples: Math.max(1, secToSample(fadeIn, clock)),
      fadeOutSamples: Math.max(1, secToSample(fadeOut, clock)),
      gain: Math.max(0, c.gain),
      pan: Math.max(-1, Math.min(1, c.pan)),
      isMusic: clipIsMusic(c),
      creativeBus: classifyForStem(c),
      sourceBus: classifySource(c),
    });
  }

  /* ---- layer bookkeeping -------------------------------------------------- */
  const layerEntries: LayerEntry[] = [];
  for (const scene of scenes) {
    const sceneSolo = scene.layers.some((l) => l.solo);
    for (const l of scene.layers) {
      const effectiveMuted = l.muted || (soloPolicy === 'honor' && sceneSolo && !l.solo);
      layerEntries.push({
        sceneId: scene.id,
        layerId: l.id,
        kind: l.kind,
        bus: LAYER_KIND_STEM[l.kind] ?? 'SFX',
        audible: !effectiveMuted,
        feedsSub: layerFeedsSub(l.kind),
        subOwner: layerIsSubOwner(l.kind),
      });
    }
  }
  const subMembers = layerEntries.filter((e) => e.audible && (e.feedsSub || e.subOwner || e.bus === 'SUB_LFE'));

  /** every audible layer, with SUB-owner material routed dry-free through the sub chain */
  const mixLikeLayers = (): PassLayerRef[] => [
    ...layerEntries.filter((e) => e.audible && !e.subOwner).map((e) => layerRef(e, true, true, false)),
    ...layerEntries.filter((e) => e.audible && e.subOwner).map((e) => layerRef(e, false, true, true)),
  ];
  const layerRef = (e: LayerEntry, dry: boolean, verb: boolean, subFull: boolean): PassLayerRef => ({
    sceneId: e.sceneId,
    layerId: e.layerId,
    kind: e.kind,
    dry,
    verb,
    subFull,
  });

  const clipsFor = (pick: (p: PlannedClipPlacement) => boolean): PlannedClipPlacement[] => {
    const out: PlannedClipPlacement[] = [];
    for (const c of audible) {
      const p = placements.get(c.id);
      if (p && pick(p)) out.push(p);
    }
    return out;
  };

  const duck = sceneDuckEvents(scenes, pictureEnd);
  const passes: StemPassPlan[] = [];
  const skippedList = [...skipped.keys()].map((clipId) => ({ clipId, reason: 'too-short' as const }));

  /* ---- MASTER + pre-master reference -------------------------------------- */
  if (opts.includeMaster !== false) {
    passes.push({
      id: 'MASTER',
      label: 'Master mix',
      mode: 'master',
      bus: 'MASTER',
      folder: 'Mix',
      fileName: opts.fileName('Mix', 'MASTER', 'wav'),
      frameCount: span.frameCount,
      subOut: true,
      masterFx: true,
      loudnessConform: true,
      clips: clipsFor(() => true),
      layers: mixLikeLayers(),
      duck,
      skippedClipIds: skippedList,
    });
  }
  if (opts.includeMixReference) {
    passes.push({
      id: 'REF',
      label: 'Pre-master mix reference',
      mode: 'reference',
      bus: 'MIX_REF',
      folder: 'Debug',
      fileName: opts.fileName('Debug', 'MIX_REF', 'wav'),
      frameCount: span.frameCount,
      subOut: true,
      masterFx: false,
      loudnessConform: false,
      clips: clipsFor(() => true),
      layers: mixLikeLayers(),
      duck,
      skippedClipIds: [],
    });
  }

  /* ---- creative post stems -------------------------------------------------- */
  for (const bus of opts.creative ?? []) {
    const isSub = bus === 'SUB_LFE';
    passes.push({
      id: `POST.${bus}`,
      label: CREATIVE_BUS_META[bus].label,
      mode: 'creative',
      bus,
      folder: 'Post_Stems',
      fileName: opts.fileName('Post_Stems', bus, 'wav'),
      frameCount: span.frameCount,
      subOut: isSub,
      masterFx: false,
      loudnessConform: false,
      clips: clipsFor((p) => p.creativeBus === bus),
      layers: isSub
        ? subMembers.map((e) => layerRef(e, e.subOwner, e.bus === 'SUB_LFE', e.subOwner))
        : layerEntries.filter((e) => e.audible && e.bus === bus && !e.subOwner).map((e) => layerRef(e, true, true, false)),
      duck,
      skippedClipIds: [],
    });
  }

  /* ---- source-mode stems ----------------------------------------------------- */
  for (const bus of opts.sources ?? []) {
    const proc = bus === 'PROCEDURAL';
    passes.push({
      id: `SRC.${bus}`,
      label: SOURCE_BUS_META[bus].label,
      mode: 'source',
      bus,
      folder: 'Source_Stems',
      fileName: opts.fileName('Source_Stems', bus, 'wav'),
      frameCount: span.frameCount,
      subOut: proc,
      masterFx: false,
      loudnessConform: false,
      clips: clipsFor((p) => p.sourceBus === bus),
      layers: proc ? mixLikeLayers() : [],
      duck,
      skippedClipIds: [],
    });
  }

  /* ---- individual clips ------------------------------------------------------- */
  const indiv = opts.individualClips ?? 'none';
  if (indiv !== 'none') {
    for (const c of audible) {
      const base = placements.get(c.id);
      if (indiv === 'sync' || indiv === 'both') {
        if (base) {
          passes.push({
            id: `CLIP.${c.id}.SYNC`,
            label: `${c.name} — sync-padded`,
            mode: 'clip-sync',
            bus: 'CLIP',
            folder: 'Individual_Clips',
            fileName: opts.fileName('Individual_Clips', `SYNC_${c.id}`, 'wav'),
            frameCount: span.frameCount,
            subOut: false,
            masterFx: false,
            loudnessConform: false,
            clips: [base],
            layers: [],
            // sync-padded files sit on the PROJECT grid, so they carry the
            // same scene-seam duck automation the mix applies — a replacement
            // dropped over the original stem then behaves identically
            duck,
            skippedClipIds: [],
          });
        }
      }
      if (indiv === 'processed' || indiv === 'both') {
        // processed export starts at the clip's own local zero and spans the
        // clip's full visible length (no window clamping — the file IS the clip)
        const frames = Math.max(1, secToSample(c.duration, clock));
        const fadeIn = Math.max(0.002, Math.min(c.fadeIn, (frames / clock.sampleRate) * 0.5));
        const fadeOut = Math.max(0.002, Math.min(c.fadeOut, (frames / clock.sampleRate) * 0.5));
        passes.push({
          id: `CLIP.${c.id}.PROC`,
          label: `${c.name} — processed`,
          mode: 'clip-processed',
          bus: 'CLIP',
          folder: 'Individual_Clips',
          fileName: opts.fileName('Individual_Clips', `PROC_${c.id}`, 'wav'),
          frameCount: frames,
          subOut: false,
          masterFx: false,
          loudnessConform: false,
          clips: [
            {
              clipId: c.id,
              startSampleAbs: placements.get(c.id)?.startSampleAbs ?? secToSample(c.start, clock),
              endSampleAbs: placements.get(c.id)?.endSampleAbs ?? secToSample(clipEnd(c), clock),
              atSample: 0,
              offsetSample: secToSample(c.offset, clock),
              frameCount: frames,
              headTrimSamples: 0,
              tailTrimSamples: 0,
              fadeInSamples: Math.max(1, secToSample(fadeIn, clock)),
              fadeOutSamples: Math.max(1, secToSample(fadeOut, clock)),
              gain: Math.max(0, c.gain),
              pan: Math.max(-1, Math.min(1, c.pan)),
              isMusic: clipIsMusic(c),
              creativeBus: classifyForStem(c),
              sourceBus: classifySource(c),
            },
          ],
          layers: [],
          duck: [],
          skippedClipIds: [],
        });
      }
    }
  }

  return {
    projectName: project.name,
    clock,
    scope: opts.scope,
    windowStart,
    pictureEnd,
    picture,
    tail,
    tailSeconds: tailSeconds(tail),
    span,
    fps,
    soloPolicy,
    soloActiveClips,
    soloActiveLayers,
    scenes,
    clips: inScope,
    audibleClips: audible,
    mutedClipIds,
    passes,
  };
}
