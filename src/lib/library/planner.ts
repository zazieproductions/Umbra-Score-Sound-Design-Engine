/* ==================================================================== *
 *  UMBRA · SOUND RETRIEVAL PLANNER
 *
 *  Converts film/spotting information into GOOD SEARCH QUERIES.
 *  Queries describe actual audible phenomena — never whole scene
 *  descriptions ("dark scary person walking through creepy room").
 *
 *  NEGATIVE SPACE: "no sound" is a valid, explicit decision. Dense
 *  scenes get more intents; minimal scenes get deliberately few.
 * ==================================================================== */

import type { RetrievalIntent, SoundDensity, SoundRole, SoundEventCandidate, SpottingEvent, SceneSoundContext } from './types';
import { HORROR_DRONE_TRANSFORM, isBedRole } from './types';
import { semanticEventKind, semanticQuery, semanticRole, topSemanticCandidate } from './xclip';

let intentSeq = 0;
const nid = () => `int${Date.now().toString(36)}${(intentSeq++).toString(36)}`;

/* --------------------------------------------------- role detection -- */

const ROLE_QUERIES: Record<SoundRole, { q: string; alts: string[]; fit: RetrievalIntent['durationFit'] }> = {
  ROOM_TONE: { q: 'large empty room tone', alts: ['old house interior room tone', 'quiet room ambience'], fit: 'long' },
  AMBIENCE: { q: 'large empty room tone', alts: ['empty hall ambience', 'old building atmosphere'], fit: 'long' },
  FOOTSTEP: { q: 'soft footsteps wood floor', alts: ['footsteps on wooden floor', 'slow walking wood steps'], fit: 'short' },
  CLOTHING: { q: 'quiet clothing movement', alts: ['fabric rustle clothing', 'jacket movement cloth'], fit: 'short' },
  DOOR: { q: 'old wood door hinge slow', alts: ['wooden door creak open', 'old door latch handle'], fit: 'short' },
  WOOD: { q: 'old floorboard creak', alts: ['wooden plank creak', 'wood structure groan'], fit: 'short' },
  METAL: { q: 'metal contact scrape', alts: ['metal rattle clank', 'metallic impact'], fit: 'short' },
  GLASS: { q: 'glass clink tap', alts: ['glass break thin', 'window rattle'], fit: 'short' },
  BODY: { q: 'body movement organic', alts: ['hands body contact', 'flesh impact'], fit: 'short' },
  BREATH: { q: 'slow breath close', alts: ['breathing quiet', 'exhale inhale'], fit: 'short' },
  MECHANICAL: { q: 'distant machinery hum', alts: ['industrial ventilation', 'machine room noise'], fit: 'long' },
  ELECTRICAL: { q: 'electrical hum transformer', alts: ['power supply buzz', 'electric cable hum'], fit: 'long' },
  WIND: { q: 'wind howl distant', alts: ['wind gust exterior', 'breeze trees'], fit: 'long' },
  WEATHER: { q: 'rain on roof distant', alts: ['storm rain outside', 'rain window'], fit: 'long' },
  WATER: { q: 'water drip pipe', alts: ['water tank resonance', 'liquid pour'], fit: 'short' },
  CREAK: { q: 'old wooden creak', alts: ['stairs creak wood', 'floorboard groan'], fit: 'short' },
  SCRAPE: { q: 'wood scrape floor', alts: ['something dragging wood', 'scrape concrete'], fit: 'short' },
  IMPACT: { q: 'heavy thud impact', alts: ['dull impact wood', 'body thud'], fit: 'short' },
  KNOCK: { q: 'knock on wood door', alts: ['old door knock', 'raps wood'], fit: 'short' },
  RATTLE: { q: 'door rattle shake', alts: ['chain rattle', 'metal jingle'], fit: 'short' },
  RUMBLE: { q: 'low rumble distant', alts: ['sub rumble underground', 'deep drone rumble'], fit: 'medium' },
  DRONE: { q: 'low dark drone', alts: ['sustained low hum', 'dark room resonance'], fit: 'long' },
  TEXTURE: { q: 'granular texture sound', alts: ['dust air texture', 'material movement'], fit: 'medium' },
  TRANSITION: { q: 'whoosh transition', alts: ['air sweep swoosh', 'room tone change'], fit: 'short' },
  ANIMAL: { q: 'animal movement creature', alts: ['rat scurry', 'insect buzz'], fit: 'short' },
  VEHICLE: { q: 'distant car pass', alts: ['traffic exterior', 'car engine idle'], fit: 'medium' },
  MISC_FOLEY: { q: 'foley sound effect', alts: ['object handling', 'props foley'], fit: 'short' },
};

const TAG_RULES: { test: RegExp; role: SoundRole }[] = [
  { test: /(interior|room|hall|house|building|basement|attic|cellar)/i, role: 'ROOM_TONE' },
  { test: /(wood|floor|stair|staircase|plank|board)/i, role: 'FOOTSTEP' },
  { test: /(door|doorway|latch|hinge)/i, role: 'DOOR' },
  { test: /(cloth|clothing|fabric|jacket|coat)/i, role: 'CLOTHING' },
  { test: /(machine|mechanical|appliance|ventil|compressor|furnace|fan)/i, role: 'MECHANICAL' },
  { test: /(electri|power|hum|buzz)/i, role: 'ELECTRICAL' },
  { test: /(wind|breeze|gust)/i, role: 'WIND' },
  { test: /(rain|storm|weather|thunder)/i, role: 'WEATHER' },
  { test: /(water|drip|pipe|drain|leak)/i, role: 'WATER' },
  { test: /(metal|chain|iron|steel)/i, role: 'METAL' },
  { test: /(glass|window|pane)/i, role: 'GLASS' },
  { test: /(breath|breathing|pant)/i, role: 'BREATH' },
  { test: /(whisper|texture|granular|airy)/i, role: 'TEXTURE' },
  { test: /(exterior|outside|street|traffic)/i, role: 'VEHICLE' },
  { test: /(animal|creature|rat|insect|bird)/i, role: 'ANIMAL' },
];

export interface PlanOptions {
  density: SoundDensity;
  /** how many candidate events the scene's motion should produce */
  motionEvents?: boolean;
}

/* ------------------------------------------------------ density ------ */

const DENSITY_EVENTS: Record<SoundDensity, number> = {
  minimal: 1,
  restrained: 2,
  normal: 4,
  dense: 7,
};

const DENSITY_BEDS: Record<SoundDensity, number> = {
  minimal: 1,
  restrained: 1,
  normal: 2,
  dense: 3,
};

/* ---------------------------------------------------------- plan ---- */

/**
 * Build retrieval intents for a scene.
 *
 * Reading order:
 *   1. beds first (room tone / ambience / drone per density)
 *   2. role-based events derived from tags + motion
 *   3. spotting events (user-marked, e.g. DOOR OPEN @ 00:18.4)
 *   4. hits become event intents only when motion justifies them
 *   5. silence — explicitly recorded, never just "nothing happened"
 */
export function planScene(ctx: SceneSoundContext, opts: PlanOptions): RetrievalIntent[] {
  const intents: RetrievalIntent[] = [];
  const bedCount = DENSITY_BEDS[opts.density];
  const evCount = DENSITY_EVENTS[opts.density];
  const span = Math.max(0.001, ctx.end - ctx.start);
  const lowDread = ctx.tension < 0.3 && ctx.motion < 0.25;

  // ---- beds
  const beds: SoundRole[] = [];
  if (hasAny(ctx, /(interior|room|hall|house|building|basement|attic|cellar)/i)) beds.push('ROOM_TONE');
  if (hasAny(ctx, /(machine|mechanical|appliance|ventil|compressor|furnace|fan|electri|power|hum|buzz)/i)) beds.push('MECHANICAL');
  if (hasAny(ctx, /(wind|rain|storm|weather|exterior)/i)) beds.push('WEATHER');
  // every dread-heavy scene gets at least one drone consideration
  if (ctx.tension > 0.55) beds.push('DRONE');
  // dedupe & cap
  const uniqBeds = [...new Set(beds)];
  const chosenBeds = uniqBeds.slice(0, bedCount);
  for (const role of chosenBeds) {
    const base = ROLE_QUERIES[role];
    const dronelike = role === 'DRONE' || role === 'MECHANICAL' || role === 'ELECTRICAL' || role === 'RUMBLE';
    intents.push(
      mkIntent(ctx, role, base.q, base.alts, null, 0, base.fit, 0.85, dronelike, `scene ${ctx.title}: ${roleLabel(role)} bed for dread/atmosphere`),
    );
  }
  if (chosenBeds.length === 0 && !lowDread) {
    // fallback bed for scenes with no clear environment tags
    intents.push(mkIntent(ctx, 'DRONE', 'low dark drone', ['sustained low hum'], null, 0, 'long', 0.7, true, 'tension bed'));
  }

  // ---- role events from tags
  const seen = new Set<string>();
  for (const rule of TAG_RULES) {
    if (!hasAny(ctx, rule.test) || seen.has(rule.role)) continue;
    seen.add(rule.role);
    if (intents.some((i) => i.role === rule.role)) continue;
    const base = ROLE_QUERIES[rule.role];
    const anchor = isBed(rule.role) ? null : ctx.start + span * 0.35;
    intents.push(mkIntent(ctx, rule.role, base.q, base.alts, anchor, 0, base.fit, 0.75, false, `tagged: ${rule.role.toLowerCase()} in ${ctx.title}`));
    if (intents.length >= bedCount + evCount) break;
  }

  // ---- spotting events (strongest signal — user told us the moment)
  for (const ev of ctx.spotting) {
    if (intents.some((i) => i.role === ev.role && i.time === ev.time)) continue;
    const base = ROLE_QUERIES[ev.role];
    intents.push(mkIntent(ctx, ev.role, base.q, base.alts, ev.time, 0, base.fit, 1, false, `spotting event: ${ev.label} @ ${ev.time.toFixed(2)}s`));
  }

  // ---- hits under motion high enough to carry real action
  if (opts.motionEvents !== false && ctx.motion > 0.45) {
    for (const h of ctx.hits.slice(0, evCount)) {
      const role: SoundRole = hasAny(ctx, /(door|latch|hinge)/i) ? 'DOOR' : hasAny(ctx, /(impact|hit|contact)/i) ? 'IMPACT' : 'FOOTSTEP';
      if (intents.some((i) => i.role === role && i.time === h)) continue;
      const base = ROLE_QUERIES[role];
      intents.push(mkIntent(ctx, role, base.q, base.alts, h, 0, base.fit, 0.72, false, `motion hit @ ${h.toFixed(2)} (${ctx.title})`));
    }
  }

  // ---- negative space: explicit silence decision, not an omission
  if (lowDread && opts.density !== 'dense') {
    intents.push(
      mkIntent(ctx, 'MISC_FOLEY', '', [], null, 0, 'medium', 0.2, false, `${ctx.title}: deliberate negative space — keep quiet`),
    );
    // silence intents are flagged so engines never search them
    const last = intents[intents.length - 1];
    last.isSilenceChoice = true;
    last.allowSilence = true;
  }

  return intents
    .filter((i) => !i.isSilenceChoice)
    .concat(intents.filter((i) => i.isSilenceChoice))
    .sort((a, b) => b.priority - a.priority);
}

/** Manually trigger retrieval for one event (e.g. user added DOOR OPEN @ 00:18.4). */
export function planEvent(ctx: SceneSoundContext, ev: SpottingEvent): RetrievalIntent {
  const base = ROLE_QUERIES[ev.role];
  return mkIntent(ctx, ev.role, base.q, base.alts, ev.time, 0, base.fit, 1, false, `spotting event: ${ev.label}`, {
    origin: 'spotting',
    detectedTimestamp: ev.time,
    placementTimestamp: ev.time,
    timingToleranceMs: 120,
    eventConfidence: 1,
    eventEvidence: [`user-marked: ${ev.label}`],
  });
}

/* ------------------------------------------------- video-event plans -- */

export interface PlanEventsOptions {
  density?: SoundDensity;
  timingToleranceMs?: number;
  eventConfidenceThreshold?: number;
  /** hard bound on intents per scene run (event condensation) */
  maxIntents?: number;
}

/**
 * Convert video-analysis `SoundEventCandidate`s into retrieval intents.
 *
 * Rules:
 *   - event candidates drive the timestamps (never re-snap to scene starts);
 *   - repeated role events (e.g. 5 footsteps) collapse into ONE intent with
 *     `familySteps` → one search, rotated variants at each onset;
 *   - candidates below the configurable event-confidence threshold are
 *     `suggestOnly` — visible, never auto-placed;
 *   - no candidates → silence is preserved (no fabricated intent).
 */
export function planSoundEvents(
  ctx: SceneSoundContext,
  events: SoundEventCandidate[],
  opts: PlanEventsOptions = {},
): RetrievalIntent[] {
  // density keeps intents conservative: video events decide what exists,
  // density caps how many of them survive condensation (see maxIntents)
  const tolerance = opts.timingToleranceMs ?? 120;
  const confidenceThreshold = opts.eventConfidenceThreshold ?? 0.8;
  const maxIntents = opts.maxIntents ?? 14;
  const inScene = events.filter((e) => e.sceneId === ctx.sceneId || !e.sceneId);

  if (!inScene.length) {
    // explicit negative space — a valid decision, never a search
    return [
      mkIntent(ctx, 'MISC_FOLEY', '', [], null, 0, 'medium', 0.1, false, `${ctx.title}: no detected sound-producing activity — keep negative space`, {
        isSilenceChoice: true,
        origin: 'video-analysis',
      }),
    ];
  }

  const intents: RetrievalIntent[] = [];
  const used = new Set<string>();

  // 1) beds first (room tone / ambience) — anchored at the actual activity
  const beds = new Set<SoundRole>();
  for (const ev of inScene) {
    const role = effectiveRole(ev);
    if (isBedRole(role) && !beds.has(role)) beds.add(role);
  }
  if (!beds.size && inScene.length && (hasAny(ctx, /interior|room|basement|hall|building/i))) beds.add('ROOM_TONE');
  for (const role of beds) {
    const ev = inScene.find((e) => effectiveRole(e) === role);
    if (!ev) continue;
    const base = ROLE_QUERIES[role];
    const query = semanticQuery(ev.semantic) ?? (ev.query || base.q);
    const int = mkIntent(ctx, role, query, ev.altQueries.length ? ev.altQueries : base.alts, ev.timestamp, 0, base.fit, 0.55 + ev.confidence * 0.4, false, `video bed: ${ev.evidence.join(' · ')}`, {
      origin: 'video-analysis',
      eventKind: semanticEventKind(ev.semantic) ?? ev.event,
      detectedTimestamp: ev.timestamp,
      placementTimestamp: ev.placementTimestamp ?? ev.timestamp,
      timingToleranceMs: tolerance,
      eventConfidence: ev.confidence,
      eventEvidence: ev.evidence,
      material: ev.material,
      action: ev.action,
      environment: ev.environment,
      distance: ev.distance,
      perspective: ev.perspective,
      suggestOnly: ev.ambiguous === true || ev.confidence < confidenceThreshold,
      ...semanticExtras(ev),
    });
    intents.push(int);
    used.add(ev.id);
  }

  // 2) footstep families — one search per group
  const steps = inScene.filter((e) => effectiveRole(e) === 'FOOTSTEP' && !used.has(e.id));
  const stepGroups: SoundEventCandidate[][] = [];
  for (const ev of steps) {
    const g = stepGroups[stepGroups.length - 1];
    if (g && ev.timestamp - g[g.length - 1].timestamp <= 6) g.push(ev);
    else stepGroups.push([ev]);
  }
  for (const group of stepGroups) {
    const first = group[0];
    const base = ROLE_QUERIES.FOOTSTEP;
    const confidence = Math.max(...group.map((e) => e.confidence));
    const allOnsets = group.map((e) => e.timestamp).sort((a, b) => a - b);
    const query = semanticQuery(first.semantic) ?? (first.query || base.q);
    const int = mkIntent(
      ctx,
      'FOOTSTEP',
      query,
      first.altQueries.length ? first.altQueries : base.alts,
      allOnsets[0],
      0,
      'short',
      0.55 + confidence * 0.4,
      false,
      `video: ${group.length} contact(s) on the walk — one family, one search`,
      {
        origin: 'video-analysis',
        eventKind: semanticEventKind(first.semantic) ?? first.event,
        detectedTimestamp: allOnsets[0],
        placementTimestamp: allOnsets[0],
        timingToleranceMs: tolerance,
        eventConfidence: confidence,
        eventEvidence: group.flatMap((e) => e.evidence),
        material: first.material,
        action: first.action,
        environment: first.environment,
        distance: first.distance,
        perspective: first.perspective,
        familySteps: allOnsets,
        suggestOnly: group.some((e) => e.ambiguous) || confidence < confidenceThreshold,
        ...semanticExtras(first),
      },
    );
    intents.push(int);
    group.forEach((e) => used.add(e.id));
  }

  // 3) remaining events — dedupe by role+tolerance, keep the strongest
  const remaining = inScene.filter((e) => !used.has(e.id));
  for (const ev of remaining) {
    const role = effectiveRole(ev);
    const base = ROLE_QUERIES[role] ?? ROLE_QUERIES.MISC_FOLEY;
    const fit = isBedRole(role) ? 'long' : role === 'MECHANICAL' || role === 'VEHICLE' || role === 'WATER' || role === 'WIND' ? 'medium' : 'short';
    const dup = intents.find((i) => i.role === role && Math.abs((i.detectedTimestamp ?? i.time ?? 0) - ev.timestamp) < (3 * tolerance) / 1000);
    if (dup) {
      if ((ev.confidence ?? 0) > (dup.eventConfidence ?? 0)) {
        dup.query = semanticQuery(ev.semantic) ?? (ev.query || dup.query);
        dup.altQueries = ev.altQueries.length ? ev.altQueries : dup.altQueries;
        dup.eventConfidence = ev.confidence;
        dup.eventKind = semanticEventKind(ev.semantic) ?? dup.eventKind ?? ev.event;
        dup.suggestOnly = ev.ambiguous === true || ev.confidence < confidenceThreshold;
        Object.assign(dup, semanticExtras(ev));
      }
      continue;
    }
    const query = semanticQuery(ev.semantic) ?? (ev.query || base.q);
    const int = mkIntent(ctx, role, query, ev.altQueries.length ? ev.altQueries : base.alts, ev.timestamp, 0, fit, 0.5 + ev.confidence * 0.5, false, `video: ${ev.evidence.join(' · ')}`, {
      origin: 'video-analysis',
      eventKind: semanticEventKind(ev.semantic) ?? ev.event,
      detectedTimestamp: ev.timestamp,
      placementTimestamp: ev.placementTimestamp ?? ev.timestamp,
      timingToleranceMs: tolerance,
      eventConfidence: ev.confidence,
      eventEvidence: ev.evidence,
      material: ev.material,
      action: ev.action,
      environment: ev.environment,
      distance: ev.distance,
      perspective: ev.perspective,
      suggestOnly: ev.ambiguous === true || ev.confidence < confidenceThreshold,
      ...semanticExtras(ev),
    });
    intents.push(int);
    used.add(ev.id);
  }

  // user spotting events always win over inferred ones at the same moment
  for (const ev of ctx.spotting) {
    const clash = intents.find((i) => i.role === ev.role && Math.abs((i.detectedTimestamp ?? i.time ?? 0) - ev.time) < (3 * tolerance) / 1000);
    if (clash) {
      clash.priority = 1;
      clash.eventConfidence = 1;
      clash.suggestOnly = false;
      clash.origin = 'spotting';
      clash.reason = `spotting event ${ev.label} overrides inference @ ${ev.time.toFixed(2)}s`;
      continue;
    }
    const base = ROLE_QUERIES[ev.role];
    intents.push(
      mkIntent(ctx, ev.role, base.q, base.alts, ev.time, 0, base.fit, 1, false, `spotting event: ${ev.label} @ ${ev.time.toFixed(2)}s`, {
        origin: 'spotting',
        eventKind: roleToEventKind(ev.role),
        detectedTimestamp: ev.time,
        placementTimestamp: ev.time,
        timingToleranceMs: tolerance,
        eventConfidence: 1,
        eventEvidence: [`user-marked: ${ev.label}`],
      }),
    );
  }

  return intents
    .sort((a, b) => b.priority - a.priority || (a.detectedTimestamp ?? a.time ?? 0) - (b.detectedTimestamp ?? b.time ?? 0))
    .slice(0, maxIntents);
}

/* --------------------------------------------- X-CLIP semantic helpers -- */

/** X-CLIP advisory role override; falls back to the pixel-derived role. */
function effectiveRole(ev: SoundEventCandidate): SoundRole {
  return semanticRole(ev.semantic) ?? ev.suggestedRole;
}

/** Carry X-CLIP provenance into a retrieval intent (advisory only). */
function semanticExtras(ev: SoundEventCandidate): Pick<RetrievalIntent, 'semanticLabels' | 'audioSetEvent' | 'semanticConfidence'> {
  const top = topSemanticCandidate(ev.semantic);
  if (!top) return { semanticLabels: undefined, audioSetEvent: undefined, semanticConfidence: undefined };
  return {
    semanticLabels: top.label ? [top.label] : undefined,
    audioSetEvent: top.audioSet ?? undefined,
    semanticConfidence: top.confidence,
  };
}

/* --------------------------------------------------------- helpers -- */

function roleToEventKind(role: SoundRole): SoundEventCandidate['event'] {
  const map: Partial<Record<SoundRole, SoundEventCandidate['event']>> = {
    ROOM_TONE: 'room-tone',
    AMBIENCE: 'ambience',
    FOOTSTEP: 'footstep',
    CLOTHING: 'cloth',
    DOOR: 'door',
    METAL: 'impact',
    GLASS: 'impact',
    BODY: 'body',
    BREATH: 'breath',
    MECHANICAL: 'mechanical',
    ELECTRICAL: 'mechanical',
    WIND: 'wind',
    WEATHER: 'wind',
    WATER: 'water',
    IMPACT: 'impact',
    SCRAPE: 'impact',
    RATTLE: 'impact',
    RUMBLE: 'mechanical',
    DRONE: 'ambience',
    TEXTURE: 'cloth',
    TRANSITION: 'other',
    ANIMAL: 'body',
    VEHICLE: 'vehicle',
    MISC_FOLEY: 'object-movement',
  };
  return map[role] ?? 'other';
}

function mkIntent(
  ctx: SceneSoundContext,
  role: SoundRole,
  q: string,
  alts: string[],
  time: number | null,
  offset: number,
  fit: RetrievalIntent['durationFit'],
  priority: number,
  transformForDrone: boolean,
  reason: string,
  extras: Partial<RetrievalIntent> = {},
): RetrievalIntent {
  const min = fit === 'short' ? 0.1 : fit === 'medium' ? 0.5 : 8;
  const max = fit === 'short' ? 4 : fit === 'medium' ? 12 : 120;
  return {
    id: nid(),
    sceneId: ctx.sceneId,
    role,
    query: q,
    altQueries: alts,
    time,
    offset,
    durationFit: fit,
    minDuration: min,
    maxDuration: max,
    priority,
    allowSilence: true,
    reason,
    transform: transformForDrone ? HORROR_DRONE_TRANSFORM : undefined,
    ...extras,
  };
}

function hasAny(ctx: SceneSoundContext, re: RegExp): boolean {
  const hay = [...ctx.tags, ctx.title, ctx.summary].join(' ');
  return re.test(hay);
}

export function isBed(role: SoundRole): boolean {
  return ['ROOM_TONE', 'AMBIENCE', 'DRONE', 'TEXTURE', 'WIND', 'RUMBLE', 'WEATHER', 'MECHANICAL', 'ELECTRICAL'].includes(role);
}

function roleLabel(role: SoundRole): string {
  return role.replace(/_/g, ' ').toLowerCase();
}
