/* ==================================================================== *
 *  UMBRA · X-CLIP SEMANTIC BRIDGE (frontend)
 *
 *  Umbra's pixel analyzer answers WHEN. This module carries the local
 *  backend's X-CLIP answer to WHAT a meaningful video window most likely
 *  represents, and hands it to the existing retrieval planner.
 *
 *  Honesty (pinned by tests):
 *    - semantic output is probabilistic interpretation, never guaranteed
 *      object/action recognition;
 *    - an unavailable/missing model attaches `available:false` and never
 *      fabricates labels;
 *    - existing pixel fields are preserved; semantics are advisory.
 * ==================================================================== */

import type {
  SemanticLabelCandidate,
  SemanticVideoResult,
  SoundEventCandidate,
  SoundEventKind,
  SoundRole,
} from './types';

export const XCLIP_MODEL_ID = 'microsoft/xclip-base-patch32';
/** minimum semantic confidence before it can shift the Umbra retrieval role */
export const SEMANTIC_ROLE_MIN_CONFIDENCE = 0.25;

const VALID_ROLES = new Set<SoundRole>([
  'ROOM_TONE', 'AMBIENCE', 'FOOTSTEP', 'CLOTHING', 'DOOR', 'WOOD', 'METAL', 'GLASS',
  'BODY', 'BREATH', 'MECHANICAL', 'ELECTRICAL', 'WIND', 'WEATHER', 'WATER', 'CREAK',
  'SCRAPE', 'IMPACT', 'KNOCK', 'RATTLE', 'RUMBLE', 'DRONE', 'TEXTURE', 'TRANSITION',
  'ANIMAL', 'VEHICLE', 'MISC_FOLEY',
]);

const VALID_EVENTS = new Set<SoundEventKind>([
  'footstep', 'door', 'impact', 'cloth', 'mechanical', 'water', 'wind', 'vehicle',
  'ambience', 'room-tone', 'body', 'breath', 'object-movement', 'other',
]);

function clamp(n: number, lo = 0, hi = 1): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function ensureRole(v: unknown): SoundRole {
  const s = String(v ?? '');
  return (VALID_ROLES as Set<string>).has(s) ? (s as SoundRole) : 'MISC_FOLEY';
}

function ensureEventKind(v: unknown): SoundEventKind {
  const s = String(v ?? '');
  return (VALID_EVENTS as Set<string>).has(s) ? (s as SoundEventKind) : 'other';
}

/**
 * Normalize one backend X-CLIP result. The backend already speaks the same
 * shape, but the frontend re-checks roles/events/similarity so a malformed or
 * upgraded payload can never inject an unknown role into the retrieval engine.
 */
export function normalizeSemanticResult(raw: unknown, eventId: string): SemanticVideoResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const candidatesRaw = Array.isArray(r.candidates) ? r.candidates : [];
  const candidates: SemanticLabelCandidate[] = candidatesRaw.map((c) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    return {
      label: String(cc.label ?? ''),
      labelId: cc.labelId == null ? null : String(cc.labelId),
      role: ensureRole(cc.role),
      eventKind: ensureEventKind(cc.eventKind),
      audioSet: cc.audioSet == null ? null : String(cc.audioSet),
      query: String(cc.query ?? cc.label ?? ''),
      similarity: clamp(Number(cc.similarity ?? 0)),
      confidence: clamp(Number(cc.confidence ?? 0)),
    };
  });
  return {
    available: Boolean(r.available),
    eventId,
    method: r.method === 'xclip' ? 'xclip' : 'none',
    message: r.message == null ? null : String(r.message),
    modelId: r.modelId == null ? undefined : String(r.modelId),
    device: r.device == null ? null : String(r.device),
    candidates,
    runtimeMs: r.runtimeMs == null ? null : Number(r.runtimeMs),
    cacheHit: Boolean(r.cacheHit),
    installHint: r.installHint == null ? null : String(r.installHint),
  };
}

/** Clamp/sanitize a result coming straight off an already-parsed event. */
export function validateSemanticResult(result: SemanticVideoResult): SemanticVideoResult {
  return normalizeSemanticResult(result, result.eventId);
}

export function topSemanticCandidate(result: SemanticVideoResult | null | undefined): SemanticLabelCandidate | null {
  if (!result?.available || !result.candidates.length) return null;
  return [...result.candidates].sort((a, b) => b.confidence - a.confidence || b.similarity - a.similarity)[0];
}

/** The audible sound-design query the top X-CLIP candidate suggests.

 * Advisory only: below ``SEMANTIC_ROLE_MIN_CONFIDENCE`` the model is too
 * unsure to change the retrieval query, so Umbra keeps the pixel/scene query.
 */
export function semanticQuery(result: SemanticVideoResult | null | undefined): string | null {
  const top = topSemanticCandidate(result);
  if (!top || top.confidence < SEMANTIC_ROLE_MIN_CONFIDENCE) return null;
  return top.query || top.label || null;
}

/** Umbra event kind suggested by a confident semantic result, or null. */
export function semanticEventKind(result: SemanticVideoResult | null | undefined): SoundEventKind | null {
  const top = topSemanticCandidate(result);
  if (!top || top.confidence < SEMANTIC_ROLE_MIN_CONFIDENCE) return null;
  return top.eventKind;
}

/** Umbra retrieval role suggested by a semantic result, or null. */
export function semanticRole(result: SemanticVideoResult | null | undefined): SoundRole | null {
  const top = topSemanticCandidate(result);
  if (!top || top.confidence < SEMANTIC_ROLE_MIN_CONFIDENCE) return null;
  return top.role;
}

/** Attach semantic results to events by id; returns a new array. */
export function attachSemanticResults(
  events: SoundEventCandidate[],
  results: SemanticVideoResult[],
): SoundEventCandidate[] {
  const byId = new Map<string, SemanticVideoResult>();
  for (const r of results) byId.set(r.eventId, normalizeSemanticResult(r, r.eventId));
  return events.map((ev) => {
    const semantic = byId.get(ev.id) ?? ev.semantic ?? null;
    const q = semantic ? semanticQuery(semantic) : null;
    return {
      ...ev,
      semantic,
      semanticQuery: q ?? ev.semanticQuery,
    };
  });
}

/**
 * Apply a semantic result to a backend-style plain event dict and return an
 * enriched plain dict. Used when copying backend JSON into the event object
 * before the planner.
 */
export function applySemanticToEvent<T extends Record<string, unknown>>(event: T, result: SemanticVideoResult): T & { semantic: SemanticVideoResult; semanticQuery?: string } {
  const normalized = normalizeSemanticResult(result, result.eventId);
  const q = semanticQuery(normalized);
  return {
    ...event,
    semantic: normalized,
    ...(q ? { semanticQuery: q } : {}),
  };
}
