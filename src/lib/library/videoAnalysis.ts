/* ==================================================================== *
 *  UMBRA · AUTONOMOUS CONTEXTUAL VIDEO ANALYSIS
 *
 *  Analyzes the ACTUAL video pixels (browser-side, no model, no upload):
 *  frame-difference motion energy, motion area, luma, and drift vs. a
 *  rolling reference. From those measurable features it derives sound
 *  event candidates: transients (contacts), sustained segments,
 *  rhythmic cadences (e.g. footsteps), and cuts.
 *
 *  Honesty rules (pinned by tests):
 *    - only pixel-derived features can raise confidence;
 *    - scene text/tags can refine WHAT (material, environment) but never
 *      invent a timestamp;
 *    - anything ambiguous stays <= 0.6 confidence → SUGGEST only;
 *    - frame budget is bounded: no uncontrolled work per video.
 * ==================================================================== */

import type {
  SoundDistance,
  SoundEventAnalysis,
  SoundEventCandidate,
  SoundEventKind,
  SoundRole,
} from './types';

/* ------------------------------------------------------- constants ---- */

export const ANALYSIS_GRID_W = 24;
export const ANALYSIS_GRID_H = 14;
const BLOCK_W = 4;
const BLOCK_H = 2;
const DEFAULT_MAX_FRAMES = 480;
const DEFAULT_MAX_FPS = 8;
const MOTION_SCALE = 32; // ~0..255 block diffs → 0..1-ish
/** minimum fraction of changed blocks before the localized metric applies */
const AREA_FLOOR = 0.02;
const TRANSIENT_RATIO = 2.8;
const TRANSIENT_MIN = 0.12;
const SUSTAIN_MIN = 0.18;
const SUSTAIN_MIN_SECONDS = 1.2;
const CADENCE_MIN_SECONDS = 2.0;
const CADENCE_MIN_PEAKS = 3;
const CADENCE_MIN_GAP = 0.25;
const CADENCE_MAX_GAP = 1.4;
/** a transient gesture longer than this is a sustained/cadence run instead */
const TRANSIENT_MAX_SECONDS = 1.5;

/* ------------------------------------------------------- pixel grids -- */

export interface PixelGrid {
  w: number;
  h: number;
  /** luminance 0..255 per cell, row-major */
  luma: Uint8Array;
}

/** Downsample raw RGBA image data to a small luminance grid. */
export function downscalePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gw = ANALYSIS_GRID_W,
  gh = ANALYSIS_GRID_H,
): PixelGrid {
  const out = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const sy0 = Math.floor((y * height) / gh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / gh));
    for (let x = 0; x < gw; x++) {
      const sx0 = Math.floor((x * width) / gw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / gw));
      let sum = 0;
      let n = 0;
      for (let py = sy0; py < sy1; py += 2) {
        for (let px = sx0; px < sx1; px += 2) {
          const i = (py * width + px) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      out[y * gw + x] = n ? sum / n : 0;
    }
  }
  return { w: gw, h: gh, luma: out };
}

export interface FrameFeatures {
  t: number;
  meanLuma: number;
  lumaVariance: number;
  /** mean |block diff| vs previous frame (0..255) */
  motion: number;
  /** fraction of blocks with |diff| > 12 (foreground activity) */
  motionArea: number;
  /** mean |diff| vs rolling reference (cuts / environment change) */
  drift: number;
}

function blockDiffs(a: PixelGrid, b: PixelGrid): { mean: number; area: number } {
  const bw = Math.max(1, BLOCK_W);
  const bh = Math.max(1, BLOCK_H);
  const cols = Math.floor(a.w / bw);
  const rows = Math.floor(a.h / bh);
  let sum = 0;
  let area = 0;
  let n = 0;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let d = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = (by * bh + y) * a.w + (bx * bw + x);
          d += Math.abs(a.luma[i] - b.luma[i]);
        }
      }
      const avg = d / (bw * bh);
      sum += avg;
      if (avg > 12) area++;
      n++;
    }
  }
  return { mean: n ? sum / n : 0, area: n ? area / n : 0 };
}

/** Compute one frame's features against the previous + rolling reference. */
export function frameFeatures(grid: PixelGrid, prev: PixelGrid | null, ref: PixelGrid | null, t: number): FrameFeatures {
  let sum = 0;
  let sumSq = 0;
  const n = grid.luma.length;
  for (let i = 0; i < n; i++) {
    sum += grid.luma[i];
    sumSq += grid.luma[i] * grid.luma[i];
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const m = prev ? blockDiffs(grid, prev) : { mean: 0, area: 0 };
  const drift = ref ? blockDiffs(grid, ref).mean : 0;
  return { t, meanLuma: mean, lumaVariance: variance, motion: m.mean, motionArea: m.area, drift };
}

/* ------------------------------------------------- signal detection --- */

export interface DetectionOptions {
  fps?: number;
  minTransientSeconds?: number;
  minSustainSeconds?: number;
  maxFrames?: number;
}

export interface MotionSignal {
  kind: 'transient' | 'sustained' | 'cadence' | 'cut';
  start: number;
  end: number;
  /** normalized peak intensity 0..1 */
  peak: number;
  /** pixel-evidence confidence 0..1 (intensity + regularity) */
  confidence: number;
  evidence: string[];
  /** rhythmic peaks inside a cadence segment */
  onsets?: number[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function smooth(values: number[], radius = 1): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length, i + radius + 1);
    let sum = 0;
    let n = 0;
    for (let j = lo; j < hi; j++) {
      sum += values[j];
      n++;
    }
    return n ? sum / n : 0;
  });
}

export function detectMotionSignals(features: FrameFeatures[], opts: DetectionOptions = {}): MotionSignal[] {
  const fps = opts.fps ?? DEFAULT_MAX_FPS;
  const frameMs = 1000 / fps;
  const signals: MotionSignal[] = [];
  if (features.length < 3) return signals;

  // Two complementary metrics: the mean block diff (whole frame) and the
  // mean diff over *changed* blocks only. A small subject (a figure walking
  // in a wide shot) moves just a few blocks a lot; the mean metric dilutes
  // that to almost nothing, so we keep the localized signal too.
  const mean = features.map((f) => Math.min(1.5, f.motion / MOTION_SCALE));
  const localized = features.map((f) => (f.motionArea >= AREA_FLOOR ? Math.min(1.5, (f.motion / f.motionArea) / MOTION_SCALE) : 0));
  const m = mean.map((v, i) => Math.max(v, localized[i] * 0.85));
  const baseline = smooth(m, 3).map((_, i) => Math.max(0.04, median(m.slice(Math.max(0, i - 6), i + 7))));
  const rel = m.map((v, i) => v / baseline[i]);
  const sm = smooth(m, 1);

  /* ----------------------------------------------------- transients -- */
  // Motion-burst runs: a physical gesture (door swing, impact, step) is a
  // contiguous run above a small floor. Reporting the RUN START gives an
  // accurate onset and merges sub-peaks of one gesture (door + frame) into
  // a single event instead of two late peaks.
  const burstFloor = TRANSIENT_MIN * 0.3;
  const bursts: { start: number; end: number; peak: number; peakAt: number }[] = [];
  let burstRun: number[] = [];
  const closeBurstRun = () => {
    if (!burstRun.length) return;
    const peak = Math.max(...burstRun.map((j) => m[j]));
    const relay = burstRun.some((j) => rel[j] >= TRANSIENT_RATIO);
    if (burstRun.length === 1) {
      // isolated single-frame flash: needs a strong absolute + relative peak
      const i = burstRun[0];
      if (m[i] >= TRANSIENT_MIN && rel[i] >= TRANSIENT_RATIO) {
        bursts.push({ start: features[i].t, end: features[i].t + Math.max(frameMs / 1000, opts.minTransientSeconds ?? 0.08), peak: m[i], peakAt: i });
      }
    } else if (peak >= TRANSIENT_MIN && relay) {
      const start = features[burstRun[0]].t;
      const end = features[burstRun[burstRun.length - 1]].t;
      // a long sustained drift is not a transient
      if (end - start <= TRANSIENT_MAX_SECONDS) {
        bursts.push({ start, end: end + frameMs / 1000, peak, peakAt: burstRun[0] });
      }
    }
    burstRun = [];
  };
  for (let i = 0; i < m.length; i++) {
    if (m[i] >= burstFloor) burstRun.push(i);
    else closeBurstRun();
  }
  closeBurstRun();
  for (const b of bursts) {
    const isCadencePeak = signals.some((s) => s.kind === 'cadence' && s.onsets?.some((o) => Math.abs(o - b.start) < frameMs * 2));
    if (isCadencePeak) continue;
    signals.push({
      kind: 'transient',
      start: b.start,
      end: b.end,
      peak: Math.min(1, b.peak),
      confidence: Math.min(0.88, 0.4 + Math.min(1, b.peak) * 0.55),
      evidence: [
        `motion burst ${(b.peak * 100).toFixed(0)}% of peak scale at ${b.start.toFixed(2)}s` +
          (b.end - b.start > frameMs * 1.5 ? ` over ${(b.end - b.start).toFixed(2)}s` : ''),
      ],
    });
  }

  /* ------------------------------------------------- sustained run -- */
  const sustained: { start: number; end: number; peak: number; idx: number[] }[] = [];
  let run: number[] = [];
  // absolute-level gate: a periodic rhythm raises the median baseline, so a
  // relative gate would (wrongly) suppress sustained segments — transient
  // detection uses the relative gate (sparse bursts don't pollute the median)
  for (let i = 0; i < sm.length; i++) {
    if (sm[i] >= SUSTAIN_MIN && sm[i] >= baseline[i] * 0.4) {
      run.push(i);
    } else {
      if (run.length >= SUSTAIN_MIN_SECONDS * fps) {
        sustained.push({ start: features[run[0]].t, end: features[run[run.length - 1]].t, peak: Math.max(...run.map((j) => m[j])), idx: run });
      }
      run = [];
    }
  }
  if (run.length >= SUSTAIN_MIN_SECONDS * fps) {
    sustained.push({ start: features[run[0]].t, end: features[run[run.length - 1]].t, peak: Math.max(...run.map((j) => m[j])), idx: run });
  }

  /* ---------------------------------------------------- cadence ------ */
  for (const seg of sustained) {
    if (seg.end - seg.start < CADENCE_MIN_SECONDS || seg.peak < 0.22) {
      signals.push({
        kind: 'sustained',
        start: seg.start,
        end: seg.end,
        peak: Math.min(1, seg.peak),
        confidence: Math.min(0.7, 0.35 + seg.peak * 0.4),
        evidence: [`continuous motion ${(seg.peak * 100).toFixed(0)}% for ${(seg.end - seg.start).toFixed(1)}s`],
      });
      continue;
    }
    // local maxima inside the sustained segment
    const peaks: number[] = [];
    const idxs = seg.idx;
    for (let k = 1; k < idxs.length - 1; k++) {
      const i = idxs[k];
      if (m[i] >= m[i - 1] && m[i] > m[i + 1] && m[i] >= 0.28) peaks.push(i);
    }
    const kept: number[] = [];
    for (const i of peaks) {
      const last = kept[kept.length - 1];
      if (last !== undefined && features[i].t - features[last].t < CADENCE_MIN_GAP) {
        if (m[i] > m[last]) kept[kept.length - 1] = i;
      } else kept.push(i);
    }
    const gaps = kept.slice(1).map((i, k) => features[i].t - features[kept[k]].t);
    const gapMedian = median(gaps);
    const regular =
      gaps.filter((g) => g >= CADENCE_MIN_GAP && g <= CADENCE_MAX_GAP).length === gaps.length &&
      kept.length >= CADENCE_MIN_PEAKS;
    if (regular) {
      const spread = gaps.length ? (Math.max(...gaps) - Math.min(...gaps)) / Math.max(0.01, gapMedian) : 1;
      const regularity = Math.max(0, Math.min(1, 1 - spread));
      signals.push({
        kind: 'cadence',
        start: seg.start,
        end: seg.end,
        peak: Math.min(1, seg.peak),
        confidence: Math.min(0.92, 0.55 + seg.peak * 0.25 + regularity * 0.18),
        evidence: [`gait-like cadence: ${kept.length} contacts, median gap ${gapMedian.toFixed(2)}s (spread ${spread.toFixed(2)})`],
        onsets: kept.map((i) => features[i].t),
      });
    } else {
      signals.push({
        kind: 'sustained',
        start: seg.start,
        end: seg.end,
        peak: Math.min(1, seg.peak),
        confidence: Math.min(0.6, 0.3 + seg.peak * 0.4),
        evidence: [`continuous motion ${(seg.peak * 100).toFixed(0)}% for ${(seg.end - seg.start).toFixed(1)}s (no stable rhythm)`],
      });
    }
  }

  /* ----------------------------------------------------- cuts ------- */
  for (let i = 2; i < features.length - 2; i++) {
    if (features[i].drift > 90 && features[i].drift >= features[i - 1].drift && features[i].drift > features[i + 1].drift) {
      signals.push({
        kind: 'cut',
        start: features[i].t,
        end: features[i].t + frameMs / 1000,
        peak: 0.5,
        confidence: 0.5,
        evidence: [`shot change: frame drift ${features[i].drift.toFixed(0)}/255 at ${features[i].t.toFixed(2)}s`],
      });
    }
  }

  return signals.sort((a, b) => a.start - b.start);
}

/* ---------------------------------------- signals → sound candidates -- */

export interface EventEnvironment {
  sceneId: string;
  sceneStart: number;
  sceneEnd: number;
  title: string;
  tags: string[];
  summary: string;
}

export interface CandidateOptions {
  /** hard cap on candidates per analysis (condensation) */
  maxEvents?: number;
  /** make every event suggest-only regardless of confidence (safety) */
  suggestOnly?: boolean;
}

const ROLE_KEYWORDS: Record<SoundRole, string[]> = {
  ROOM_TONE: ['room', 'interior', 'inside', 'basement', 'cellar', 'attic'],
  AMBIENCE: ['ambience', 'atmosphere', 'background', 'hall'],
  FOOTSTEP: ['footstep', 'footsteps', 'step', 'walking', 'walk', 'gait', 'boot', 'stairs', 'staircase'],
  CLOTHING: ['cloth', 'clothing', 'fabric', 'jacket', 'coat'],
  DOOR: ['door', 'doorway', 'hinge', 'latch', 'gate'],
  WOOD: ['wood', 'wooden', 'plank', 'floorboard'],
  METAL: ['metal', 'metallic', 'iron', 'steel', 'chain'],
  GLASS: ['glass', 'window', 'pane'],
  BODY: ['body', 'flesh', 'person', 'character', 'hand'],
  BREATH: ['breath', 'breathing', 'pant'],
  MECHANICAL: ['machine', 'mechanical', 'engine', 'ventil', 'motor', 'industrial', 'compressor', 'fan', 'appliance'],
  ELECTRICAL: ['electrical', 'electric', 'power', 'hum', 'buzz'],
  WIND: ['wind', 'breeze', 'gust'],
  WEATHER: ['rain', 'storm', 'weather', 'thunder'],
  WATER: ['water', 'drip', 'pipe', 'drain', 'leak', 'liquid'],
  CREAK: ['creak', 'groan', 'squeak'],
  SCRAPE: ['scrape', 'drag', 'scuff'],
  IMPACT: ['impact', 'hit', 'thud', 'collision', 'crash', 'slam'],
  KNOCK: ['knock', 'rap'],
  RATTLE: ['rattle', 'shake', 'clatter'],
  RUMBLE: ['rumble', 'sub', 'low'],
  DRONE: ['drone', 'sustained', 'hum'],
  TEXTURE: ['texture', 'granular', 'airy'],
  TRANSITION: ['transition', 'whoosh', 'cut'],
  ANIMAL: ['animal', 'creature', 'rat', 'bird'],
  VEHICLE: ['vehicle', 'car', 'traffic', 'train', 'plane'],
  MISC_FOLEY: ['foley', 'object', 'prop'],
};

function envText(env: EventEnvironment): string {
  return `${env.title} ${env.tags.join(' ')} ${env.summary}`.toLowerCase();
}

function hasEnv(env: EventEnvironment, words: string[]): boolean {
  const hay = envText(env);
  return words.some((w) => hay.includes(w));
}

function detectMaterial(env: EventEnvironment): string | undefined {
  const mats: [string, string[]][] = [
    ['metal', ['metal', 'iron', 'steel', 'chain', 'rust', 'rusted', 'rusty']],
    ['wood', ['wood', 'wooden', 'plank', 'floorboard']],
    ['glass', ['glass', 'window']],
    ['concrete', ['concrete', 'cement', 'stone']],
    ['cloth', ['cloth', 'clothing', 'fabric']],
  ];
  for (const [name, words] of mats) if (hasEnv(env, words)) return name;
  return undefined;
}

function detectEnvironment(env: EventEnvironment): string | undefined {
  const envs: [string, string[]][] = [
    ['basement', ['basement', 'cellar', 'underground']],
    ['concrete room', ['concrete room']],
    ['industrial', ['industrial']],
    ['staircase', ['stair', 'stairs', 'staircase']],
    ['forest', ['forest', 'trees', 'woodland']],
    ['street', ['street', 'road', 'traffic']],
    ['room', ['room', 'interior', 'inside', 'hall']],
  ];
  for (const [name, words] of envs) if (hasEnv(env, words)) return name;
  return undefined;
}

function detectDistance(area: number, evidence: string[]): SoundDistance {
  const d: SoundDistance = area > 0.34 ? 'close' : area > 0.14 ? 'medium' : 'far';
  evidence.push(`motion occupied ${(area * 100).toFixed(0)}% of frame → ${d}`);
  return d;
}

const ACTION_BY_KIND: Record<SoundEventKind, string[]> = {
  footstep: ['single footstep', 'boot step', 'walk step'],
  door: ['door hinge creak', 'door open', 'metal door'],
  impact: ['impact thud', 'collision impact', 'hard hit'],
  cloth: ['cloth movement', 'fabric rustle'],
  mechanical: ['machine hum', 'mechanical hum', 'industrial machine'],
  water: ['water drip', 'pipe drip', 'liquid pour'],
  wind: ['wind gust', 'wind howl'],
  vehicle: ['vehicle pass', 'car engine'],
  ambience: ['room ambience', 'interior ambience'],
  'room-tone': ['empty room tone', 'interior room tone'],
  body: ['body movement', 'person movement'],
  breath: ['breath close', 'breathing'],
  'object-movement': ['object movement', 'object handling'],
  other: ['sound effect', 'motion foley'],
};

const ROLE_BY_KIND: Record<SoundEventKind, SoundRole> = {
  footstep: 'FOOTSTEP',
  door: 'DOOR',
  impact: 'IMPACT',
  cloth: 'CLOTHING',
  mechanical: 'MECHANICAL',
  water: 'WATER',
  wind: 'WIND',
  vehicle: 'VEHICLE',
  ambience: 'AMBIENCE',
  'room-tone': 'ROOM_TONE',
  body: 'BODY',
  breath: 'BREATH',
  'object-movement': 'MISC_FOLEY',
  other: 'MISC_FOLEY',
};

function kindForSignal(sig: MotionSignal, env: EventEnvironment): { kind: SoundEventKind; semantic: number; note: string } {
  const hay = envText(env);
  if (sig.kind === 'cut') return { kind: 'other', semantic: 0.3, note: 'shot change; sound role unknown from pixels alone' };
  if (sig.kind === 'cadence') {
    if (hasEnv(env, ROLE_KEYWORDS.FOOTSTEP)) return { kind: 'footstep', semantic: 0.85, note: 'regular contact rhythm + scene naming walking/footsteps' };
    if (hasEnv(env, ROLE_KEYWORDS.DOOR)) return { kind: 'door', semantic: 0.7, note: 'rhythmic contacts near a door' };
    if (hasEnv(env, ROLE_KEYWORDS.ANIMAL)) return { kind: 'other', semantic: 0.5, note: 'rhythm consistent with movement, source ambiguous' };
    return { kind: 'body', semantic: 0.55, note: 'gait-like rhythm but scene does not name the source' };
  }
  if (sig.kind === 'sustained') {
    if (hasEnv(env, ROLE_KEYWORDS.MECHANICAL)) return { kind: 'mechanical', semantic: 0.8, note: 'continuous motion + scene names machinery' };
    if (hasEnv(env, ROLE_KEYWORDS.WATER)) return { kind: 'water', semantic: 0.7, note: 'continuous motion + scene names water' };
    if (hasEnv(env, ROLE_KEYWORDS.WIND)) return { kind: 'wind', semantic: 0.7, note: 'continuous motion + scene names wind' };
    if (hasEnv(env, ROLE_KEYWORDS.VEHICLE)) return { kind: 'vehicle', semantic: 0.7, note: 'continuous motion + scene names vehicle' };
    if (hasEnv(env, ROLE_KEYWORDS.ROOM_TONE)) return { kind: 'ambience', semantic: 0.45, note: 'continuous low-energy motion in an interior' };
    return { kind: 'object-movement', semantic: 0.4, note: 'continuous motion, source not named' };
  }
  // transient
  if (hasEnv(env, ROLE_KEYWORDS.DOOR)) return { kind: 'door', semantic: 0.7, note: 'isolated contact near a named door' };
  if (hasEnv(env, ROLE_KEYWORDS.IMPACT)) return { kind: 'impact', semantic: 0.75, note: 'isolated contact near named impact' };
  if (hasEnv(env, ROLE_KEYWORDS.FOOTSTEP)) return { kind: 'footstep', semantic: 0.7, note: 'isolated contact while scene names walking' };
  if (hasEnv(env, ROLE_KEYWORDS.GLASS)) return { kind: 'impact', semantic: 0.55, note: 'transient near glass' };
  void hay;
  return { kind: 'object-movement', semantic: 0.38, note: 'isolated motion burst, source not named' };
}

function buildQuery(ev: {
  kind: SoundEventKind;
  material?: string;
  environment?: string;
  distance?: SoundDistance;
  action?: string;
}): { query: string; alts: string[] } {
  const actions = ACTION_BY_KIND[ev.kind];
  const action = ev.action ?? actions[0];
  const parts: string[] = [];
  if (ev.distance === 'far') parts.push('distant');
  if (ev.material && ev.material !== 'cloth') parts.push(ev.material);
  parts.push(action);
  if (ev.environment && ev.kind !== 'room-tone') parts.push(ev.environment);
  const query = [...new Set(parts)].slice(0, 6).join(' ');
  // alternates: drop material / drop environment / add distance
  const withoutMaterial = [...new Set([...(ev.distance === 'far' ? ['distant'] : []), action, ...(ev.environment ? [ev.environment] : [])])].join(' ');
  const withoutEnv = [...new Set([...(ev.distance === 'far' ? ['distant'] : []), ...(ev.material ? [ev.material] : []), action])].join(' ');
  const alts = [...new Set([withoutMaterial, withoutEnv].filter((s) => s && s !== query))].slice(0, 3);
  return { query, alts };
}

/** Turn motion signals + scene context into the clean event representation. */
export function signalsToCandidates(
  signals: MotionSignal[],
  env: EventEnvironment,
  opts: CandidateOptions = {},
): SoundEventCandidate[] {
  const maxEvents = opts.maxEvents ?? 16;
  const candidates: SoundEventCandidate[] = [];

  // environment-driven bed: interior/room-tone anchored at first real activity
  const interior = hasEnv(env, ROLE_KEYWORDS.ROOM_TONE);
  const mechanical = hasEnv(env, ROLE_KEYWORDS.MECHANICAL);
  if ((interior || mechanical) && signals.length > 0) {
    const anchor = signals[0].start;
    const kind: SoundEventKind = interior ? 'room-tone' : 'ambience';
    const material = detectMaterial(env);
    const environment = detectEnvironment(env);
    const distance: SoundDistance = 'medium';
    const sem = interior ? 0.5 : 0.55;
    const confidence = Math.min(0.62, 0.1 + sem * 0.7);
    const { query, alts } = buildQuery({
      kind,
      material: material === 'cloth' ? undefined : material,
      environment,
      distance,
    });
    candidates.push({
      id: `ev-bed-${env.sceneId}-${anchor.toFixed(2)}`,
      sceneId: env.sceneId,
      timestamp: anchor,
      placementTimestamp: anchor,
      event: kind,
      environment,
      material,
      action: ACTION_BY_KIND[kind][0],
      distance,
      perspective: 'onscreen',
      confidence: round2(confidence),
      evidence: [`environment metadata: ${env.title} (${env.tags.join(', ')})`, `first activity at ${anchor.toFixed(2)}s anchors the bed`],
      suggestedRole: ROLE_BY_KIND[kind],
      query,
      altQueries: alts,
      ambiguous: true,
    });
  }

  for (const sig of signals) {
    const { kind, semantic, note } = kindForSignal(sig, env);
    const distance = detectDistance(sig.kind === 'cadence' ? 0.3 : Math.min(0.6, sig.peak * 0.4), sig.evidence);
    const material = detectMaterial(env);
    const environment = detectEnvironment(env);
    const { query, alts } = buildQuery({ kind, material, environment, distance });
    const base = { kind, material, environment, distance, note, ambiguous: semantic <= 0.55 };
    const cap = base.ambiguous ? 0.75 : 0.92;
    if (sig.kind === 'cadence' && sig.onsets) {
      for (const onset of sig.onsets) {
        const confidence = Math.min(cap, sig.confidence * 0.75 + semantic * 0.25);
        candidates.push(
          mkCandidate(sig, env, onset, onset, base, confidence, [...sig.evidence, note], query, alts, opts),
        );
      }
    } else {
      const confidence = Math.min(cap, sig.confidence * 0.6 + semantic * 0.4);
      candidates.push(mkCandidate(sig, env, sig.start, sig.start, base, confidence, [...sig.evidence, note], query, alts, opts));
    }
  }

  const deduped: SoundEventCandidate[] = [];
  for (const c of candidates.sort((a, b) => a.timestamp - b.timestamp)) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.timestamp - c.timestamp) < 0.18 && last.event === c.event) {
      // keep the higher-confidence observation, merge evidence
      if (c.confidence > last.confidence) {
        c.evidence = [...new Set([...last.evidence, ...c.evidence])];
        deduped[deduped.length - 1] = c;
      } else {
        last.evidence = [...new Set([...last.evidence, ...c.evidence])];
      }
      continue;
    }
    deduped.push(c);
  }
  return deduped.slice(0, maxEvents);
}

function mkCandidate(
  sig: MotionSignal,
  env: EventEnvironment,
  detected: number,
  placed: number,
  base: { kind: SoundEventKind; material?: string; environment?: string; distance: SoundDistance; ambiguous?: boolean },
  confidence: number,
  evidence: string[],
  query: string,
  alts: string[],
  opts: CandidateOptions,
): SoundEventCandidate {
  return {
    id: `ev-${env.sceneId}-${base.kind}-${detected.toFixed(2)}`,
    sceneId: env.sceneId,
    timestamp: round3(detected),
    placementTimestamp: round3(placed),
    duration: sig.kind === 'sustained' || sig.kind === 'cadence' ? round3(sig.end - sig.start) : sig.kind === 'transient' ? round3(Math.max(0.08, sig.end - sig.start)) : undefined,
    event: base.kind,
    material: base.material,
    action: ACTION_BY_KIND[base.kind][0],
    environment: base.environment,
    distance: base.distance,
    perspective: hasEnv(env, ['offscreen', 'background', 'distant']) ? 'offscreen' : 'onscreen',
    confidence: opts.suggestOnly ? Math.min(confidence, 0.45) : round2(confidence),
    evidence,
    suggestedRole: ROLE_BY_KIND[base.kind],
    query,
    altQueries: alts,
    ambiguous: base.ambiguous,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* --------------------------------------------- browser pixel capture -- */

export interface AnalyzeVideoOptions extends DetectionOptions {
  onProgress?: (frames: number) => void;
  signal?: AbortSignal;
  /** hard cap on derived candidates */
  maxEvents?: number;
}

export interface VideoPixelSource {
  duration: number;
  seek(t: number): Promise<void>;
  grab(): { data: Uint8ClampedArray; width: number; height: number };
}

/**
 * Frame a source into a time series of features and return candidates.
 * Pure w.r.t. the source: `videoPixelSource` is injectable so tests can
 * feed deterministic frames without a DOM.
 */
export async function analyzePixelSource(
  source: VideoPixelSource,
  env: EventEnvironment,
  opts: AnalyzeVideoOptions = {},
): Promise<SoundEventAnalysis> {
  const duration = Math.max(0.1, source.duration);
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const fps = Math.max(1, Math.min(DEFAULT_MAX_FPS, Math.round((opts.fps ?? maxFrames / duration) * 10) / 10 || 1));
  const interval = 1 / fps;
  const count = Math.min(maxFrames, Math.max(2, Math.floor(duration / interval) + 1));
  const features: FrameFeatures[] = [];
  let prev: PixelGrid | null = null;
  let ref: PixelGrid | null = null;
  const partial = duration > count * interval;
  const offset = env.sceneStart;

  for (let i = 0; i < count; i++) {
    if (opts.signal?.aborted) break;
    const rel = Math.min(duration - 0.001, i * interval);
    const abs = Math.min(1e9, offset + rel);
    await source.seek(abs);
    const frame = source.grab();
    const grid = downscalePixels(frame.data, frame.width, frame.height);
    if (i % 24 === 0) ref = grid;
    features.push(frameFeatures(grid, prev, ref, abs));
    prev = grid;
    opts.onProgress?.(i + 1);
  }

  if (features.length < 3) {
    return {
      available: true,
      method: 'browser-pixel',
      frameCount: features.length,
      fps,
      duration,
      partial,
      events: [],
      message: 'Not enough frames to measure motion — no sound events claimed.',
      analyzedAt: Date.now(),
    };
  }
  const signals = detectMotionSignals(features, { fps });
  const events = signalsToCandidates(signals, env, { maxEvents: opts.maxEvents });
  return {
    available: true,
    method: 'browser-pixel',
    frameCount: features.length,
    fps,
    duration,
    partial,
    events,
    message: events.length ? `${events.length} candidate(s) from ${features.length} frames` : 'No motion-derived sound candidates; negative space preserved.',
    analyzedAt: Date.now(),
  };
}

/* ---------------------------------------------------- DOM video tap -- */

/**
 * Analyze a real video URL (object URL or same-origin) by stepping its
 * frames through a canvas. Returns an honest report; failures degrade to
 * `available:false` with a message — never fabricated events.
 */
export async function analyzeVideoUrl(
  url: string,
  env: EventEnvironment,
  opts: AnalyzeVideoOptions = {},
): Promise<SoundEventAnalysis> {
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const to = window.setTimeout(() => reject(new Error('video metadata timeout')), 15000);
      video.onloadedmetadata = () => {
        window.clearTimeout(to);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(to);
        reject(new Error('video decode unavailable for analysis'));
      };
    });
    const duration = video.duration || 0;
    if (!(duration > 0)) {
      return {
        available: false,
        method: 'none',
        frameCount: 0,
        fps: 0,
        duration: 0,
        partial: false,
        events: [],
        message: 'Video metadata unavailable — cannot analyze.',
        analyzedAt: Date.now(),
      };
    }
    const canvas = document.createElement('canvas');
    canvas.width = ANALYSIS_GRID_W * 8;
    canvas.height = ANALYSIS_GRID_H * 8;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return {
        available: false,
        method: 'none',
        frameCount: 0,
        fps: 0,
        duration,
        partial: false,
        events: [],
        message: 'Canvas 2D is unavailable in this browser — cannot analyze video pixels.',
        analyzedAt: Date.now(),
      };
    }
    const source: VideoPixelSource = {
      duration,
      async seek(t: number) {
        await new Promise<void>((resolve, reject) => {
          const to = window.setTimeout(() => reject(new Error(`seek timeout at ${t.toFixed(2)}s`)), 6000);
          const onSeek = () => {
            window.clearTimeout(to);
            video.removeEventListener('seeked', onSeek);
            resolve();
          };
          video.addEventListener('seeked', onSeek);
          video.currentTime = t;
        });
      },
      grab() {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return { data: img.data, width: canvas.width, height: canvas.height };
      },
    };
    const result = await analyzePixelSource(source, env, opts);
    // release the video element
    video.removeAttribute('src');
    video.load();
    return result;
  } catch (e) {
    return {
      available: false,
      method: 'none',
      frameCount: 0,
      fps: 0,
      duration: 0,
      partial: false,
      events: [],
      message: `Video analysis unavailable: ${(e as Error).message}`,
      analyzedAt: Date.now(),
    };
  }
}

/** Deduplicate/condense events for a whole project before retrieval. */
export function condenseEvents(events: SoundEventCandidate[], maxEvents = 40): SoundEventCandidate[] {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const out: SoundEventCandidate[] = [];
  for (const ev of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.timestamp - ev.timestamp) < 0.3 && last.suggestedRole === ev.suggestedRole) continue;
    out.push(ev);
  }
  return out.slice(0, maxEvents);
}
