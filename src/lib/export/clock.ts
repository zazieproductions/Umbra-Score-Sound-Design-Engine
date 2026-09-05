/* ==================================================================== *
 *  DELIVERY RENDER CLOCK — the single authoritative time↔sample mapping
 *
 *  Every timestamp in the export subsystem — clip positions, scene edges,
 *  tail policy, stem length, cue-sheet samples, BWF time references — is
 *  converted through THIS module and nowhere else. Independent rounding
 *  per call site is how stems drift apart from the master; one clock
 *  makes that structurally impossible.
 *
 *  Rule: sampleIndex = round(timestampSeconds * sampleRate), computed
 *  from absolute project time. Never accumulated, never delta-chained —
 *  so no cumulative float drift across a 2-hour program.
 * ==================================================================== */

/** Sample rates supported for professional delivery. */
export const DELIVERY_SAMPLE_RATES = [44100, 48000, 96000] as const;
export type DeliverySampleRate = (typeof DELIVERY_SAMPLE_RATES)[number];

/** Bit depths we can write with honest quantisation. */
export const DELIVERY_BIT_DEPTHS = [16, 24] as const;
export type DeliveryBitDepth = (typeof DELIVERY_BIT_DEPTHS)[number];

export interface RenderClock {
  readonly sampleRate: number;
}

/** The default professional delivery clock. */
export const DEFAULT_CLOCK: RenderClock = { sampleRate: 48000 };

/**
 * Seconds → sample index. The ONE conversion used by all of delivery.
 * Math.round (not floor/ceil): symmetric, stable for values like 18.4
 * where the float product lands on x.5±ε.
 */
export function secToSample(seconds: number, clock: RenderClock = DEFAULT_CLOCK): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * clock.sampleRate);
}

/** Samples → exact seconds (division, never accumulation). */
export function sampleToSec(sample: number, clock: RenderClock = DEFAULT_CLOCK): number {
  return sample / clock.sampleRate;
}

/**
 * A half-open frame range [startSample, startSample + frameCount).
 * All consolidated stems share the same span so they lay down on top of
 * each other at 00:00 in any DAW.
 */
export interface FrameSpan {
  readonly startSample: number;
  readonly frameCount: number;
  readonly endSample: number; // exclusive
  readonly startSeconds: number;
  readonly lengthSeconds: number;
}

export function spanFromSamples(startSample: number, frameCount: number, clock: RenderClock = DEFAULT_CLOCK): FrameSpan {
  const s = Math.max(0, Math.round(startSample));
  const f = Math.max(0, Math.round(frameCount));
  return {
    startSample: s,
    frameCount: f,
    endSample: s + f,
    startSeconds: sampleToSec(s, clock),
    lengthSeconds: sampleToSec(f, clock),
  };
}

/* ------------------------------------------------------------ tail ----- */

/**
 * Tail policy — how far past picture end a stem is rendered.
 *
 *  'exact'       — hard cut at picture end (unusual, broadcast conform).
 *  'picture_plus'— picture end + N seconds. Default 2 s: captures reverb
 *                  tails, impact rings and duck releases without leaving
 *                  a cliff. This is the same idea as the legacy +2.5 s
 *                  in renderScore, but explicit, configurable, and —
 *                  critically — identical for every stem.
 *  'custom'      — arbitrary N seconds (>= 0).
 */
export type TailPolicy =
  | { kind: 'exact' }
  | { kind: 'picture_plus'; seconds: number }
  | { kind: 'custom'; seconds: number };

export const DEFAULT_TAIL: TailPolicy = { kind: 'picture_plus', seconds: 2 };

export const TAIL_PRESETS: { id: string; label: string; tail: TailPolicy }[] = [
  { id: 'exact', label: 'Exact picture length', tail: { kind: 'exact' } },
  { id: 'tail2', label: 'Picture + 2 s tail', tail: { kind: 'picture_plus', seconds: 2 } },
  { id: 'tail5', label: 'Picture + 5 s tail', tail: { kind: 'picture_plus', seconds: 5 } },
];

export function tailSeconds(tail: TailPolicy): number {
  switch (tail.kind) {
    case 'exact':
      return 0;
    default:
      return Math.max(0, tail.seconds);
  }
}

/** Tail expressed in whole samples at the delivery rate. */
export function tailSamples(tail: TailPolicy, clock: RenderClock = DEFAULT_CLOCK): number {
  return secToSample(tailSeconds(tail), clock);
}

/**
 * The consolidated delivery span for a scope.
 *
 * pictureEndSeconds is the authoritative end (video/project duration —
 * see delivery.ts resolvePictureEnd). Returns the FrameSpan that EVERY
 * stem must share, exactly.
 */
export function deliverySpan(
  windowStartSeconds: number,
  pictureEndSeconds: number,
  tail: TailPolicy,
  clock: RenderClock = DEFAULT_CLOCK,
): FrameSpan {
  const startSample = Math.max(0, secToSample(windowStartSeconds, clock));
  const endSample = Math.max(startSample, secToSample(pictureEndSeconds, clock)) + tailSamples(tail, clock);
  return spanFromSamples(startSample, endSample - startSample, clock);
}

/* --------------------------------------------------------- timecode ---- */

/**
 * Timecode HH:MM:SS.mmm (+ optional frame field at the project fps).
 * Frames are derived from the SAMPLE index via the clock — not from the
 * float seconds — so cue-sheet TC and file position cannot disagree.
 */
export function timecode(seconds: number, opts: { fps?: number; frames?: boolean; clock?: RenderClock } = {}): string {
  const clock = opts.clock ?? DEFAULT_CLOCK;
  const total = secToSample(Math.max(0, seconds), clock);
  const sec = total / clock.sampleRate; // exact enough for wall-clock fields
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000 + 1e-6);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  let out = `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  if (opts.frames && opts.fps) {
    const frameDur = 1 / opts.fps;
    const f = Math.floor(((sec % 1) + frameDur / 1000) / frameDur) % opts.fps;
    out += `:${pad(f)}`;
  }
  return out;
}

/** File-name-safe timecode, e.g. 00-01-18-420 (hh-mm-ss-ms). */
export function timecodeFileSafe(seconds: number, clock: RenderClock = DEFAULT_CLOCK): string {
  const total = secToSample(Math.max(0, seconds), clock);
  const sec = total / clock.sampleRate;
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000 + 1e-6);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}-${pad(m)}-${pad(s)}-${pad(ms, 3)}`;
}
