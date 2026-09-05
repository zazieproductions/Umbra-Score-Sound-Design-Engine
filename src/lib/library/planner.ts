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

import type { RetrievalIntent, SoundDensity, SoundRole, SpottingEvent, SceneSoundContext } from './types';
import { HORROR_DRONE_TRANSFORM } from './types';

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
  return mkIntent(ctx, ev.role, base.q, base.alts, ev.time, 0, base.fit, 1, false, `spotting event: ${ev.label}`);
}

/* --------------------------------------------------------- helpers -- */

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
