/* ==================================================================== *
 *  UMBRA · ACCEPTANCE TESTS — Contextual Sound Retrieval + Layering
 *
 *  Three critical user-accepted scenarios:
 *
 *    T1  DOOR OPEN @ 00:18.4  → automated Freesound search → in-app
 *        audition (preview) → real clip at 00:18.4, editable, movable,
 *        trimmable, fade/gain/pan, replaceable, license attached.
 *
 *    T2  "dark industrial basement" → AUTO SOUND DESIGN → SUGGEST
 *        returns room tone / pipe resonance / footstep foley / distant
 *        machine as THREE SEPARATE CLIPS (never flattened).
 *
 *    T3  Real mechanical recording → Umbra processing → dark drone,
 *        with provenance, source AND transform retained & editable.
 *
 *  Every Freesound HTTP response is a controlled fixture (the live API
 *  is unreachable from this environment). Mocks are asserted, never
 *  trusted blindly.
 * ==================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchMock } from './setup';

import { RetrievalService } from '../src/lib/library/service';
import { planScene, planEvent } from '../src/lib/library/planner';
import { freesoundToAsset, mapFreesoundLicense, type FsSound } from '../src/lib/library/freesound';
import { rankCandidates, applyClapRerank, registerClapReranker } from '../src/lib/library/ranking';
import { provenanceStore, userLibrary } from '../src/lib/library/cache';
import { exportCreditsTxt, exportCreditsJson, ledgerFromClips } from '../src/lib/library/credits';
import { EMPTY_FREESOUND_STATUS, type FreesoundIntegrationStatus, type FreesoundRuntime } from '../src/lib/library/freesoundBackend';
import {
  HORROR_DRONE_TRANSFORM,
  NO_TRANSFORM,
  type LicensePolicy,
  type LibraryAsset,
  type RetrievalIntent,
  type SceneSoundContext,
  type SoundClip,
  type SpottingEvent,
} from '../src/lib/library/types';

/* ------------------------------------------------------------ fixtures -- */

/**
 * The API key the (mocked) BACKEND holds. The browser must never see or
 * send it — every assertion below treats it as a leak canary.
 */
const TOKEN = 'umbra-test-token-0000';

/** Safe, secret-free integration runtime — what the browser actually knows. */
function runtime(over: Partial<FreesoundIntegrationStatus> = {}): FreesoundRuntime {
  return {
    backendOnline: true,
    status: {
      ...EMPTY_FREESOUND_STATUS,
      configured: true,
      searchAvailable: true,
      verification: 'verified',
      ...over,
    },
  };
}

/** Minimal WAV header + 0.5s of silence so blob sizes are honest. */
function wavBlob(seconds = 0.5): Blob {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const data = new Uint8Array(44 + n * 2);
  const dv = new DataView(data.buffer);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, n * 2, true);
  return new Blob([data], { type: 'audio/wav' });
}

/** A Freesound API sound fixture (matches SEARCH_FIELDS). */
function fsSound(over: Partial<FsSound> & { id: number }): FsSound {
  return {
    id: over.id,
    url: `https://freesound.org/sounds/${over.id}/`,
    name: `sound_${over.id}`,
    tags: [],
    description: '',
    username: 'umbra-fixture',
    license: 'Attribution',
    type: 'wav',
    channels: 1,
    filesize: 88200,
    duration: 2.0,
    samplerate: 44100,
    created: '2021-01-01T00:00:00Z',
    num_downloads: 100,
    avg_rating: 4.0,
    previews: {
      'preview-hq-mp3': `https://freesound.org/data/previews/${over.id}_hq.mp3`,
      'preview-hq-ogg': `https://freesound.org/data/previews/${over.id}_hq.ogg`,
      'preview-lq-mp3': `https://freesound.org/data/previews/${over.id}_lq.mp3`,
      'preview-lq-ogg': `https://freesound.org/data/previews/${over.id}_lq.ogg`,
    },
    images: {
      waveform_m: `/data/images/${over.id}_waveform_m.png`,
      spectral_m: `/data/images/${over.id}_spectral_m.png`,
    },
    score: 80,
    gen_ai_preference: 'not_specified',
    md5: `md5-${over.id}`,
    category: 'sound',
    subcategory: 'foley',
    ...over,
  };
}

/**
 * Mock the Umbra backend's Freesound proxy (browser → /api/library/freesound)
 * plus the public preview CDN, routing searches to canned fixtures.
 *
 * The mock enforces the security contract on every call: the browser request
 * must carry NO credential — no token/api key in the URL, no Authorization
 * header. The key the backend uses (TOKEN) is treated as a leak canary.
 */
function mockFreesoundSearch(routes: { q: RegExp; results: FsSound[] }[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? new URL(input, 'http://umbra.test')
        : input instanceof URL
          ? input
          : new URL(input.url, 'http://umbra.test');
    // SECURITY: no credential may appear in a browser request URL
    for (const k of ['token', 'apiKey', 'api_key', 'client_secret', 'access_token', 'refresh_token']) {
      if (url.searchParams.has(k)) throw new Error(`secret leaked into the browser request URL: ${k}`);
    }
    if (String(url).includes(TOKEN)) throw new Error('backend API key leaked into the browser request');
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith('/api/') && headers.has('Authorization')) {
      throw new Error('credential leaked into the browser→backend request');
    }
    // the backend proxy: search
    if (url.origin === 'http://umbra.test' && url.pathname === '/api/library/freesound/search') {
      const q = url.searchParams.get('query') ?? '';
      const route = routes.find((r) => r.q.test(q));
      const results = route?.results ?? [];
      return new Response(JSON.stringify({ count: results.length, next: null, previous: null, results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // the backend proxy: original-quality download (the backend holds the OAuth token)
    if (url.origin === 'http://umbra.test' && /\/api\/library\/freesound\/sounds\/\d+\/download$/.test(url.pathname)) {
      return new Response(wavBlob(2), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    // preview downloads (public CDN, no credential involved) — a tiny real
    // WAV so blob sizes are truthful
    if (url.origin === 'https://freesound.org' && url.pathname.includes('/data/previews/')) {
      return new Response(wavBlob(0.5), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error(`unmapped url ${url.origin}${url.pathname}`);
  });
  setFetchMock(fn as never);
  return fn;
}

function scene(over: Partial<SceneSoundContext> = {}): SceneSoundContext {
  return {
    sceneId: 'sc-test',
    start: 0,
    end: 60,
    title: 'Test scene',
    tags: [],
    summary: '',
    tension: 0.4,
    motion: 0.3,
    hits: [],
    spotting: [],
    ...over,
  };
}

function spotted(over: Partial<SpottingEvent> = {}): SpottingEvent {
  return {
    id: 'ev-1',
    sceneId: 'sc-test',
    label: 'door open @ 00:18.4',
    role: 'DOOR',
    time: 18.4,
    createdAt: 0,
    ...over,
  };
}

/* --------------------------------------------------------------- setup -- */

beforeEach(async () => {
  await provenanceStore.clear();
  const all = await userLibrary.list();
  await Promise.all(all.map((f) => userLibrary.remove(f.id)));
});

afterEach(() => {
  registerClapReranker(null);
});

/* ==================================================================== *
 *  T1 — DOOR OPEN @ 00:18.4
 * ==================================================================== */
describe('T1 · DOOR OPEN @ 00:18.4 → search → audition → placed editable clip', () => {
  it('planner turns the spotting event into a DOOR intent anchored at 18.4s', () => {
    const ctx = scene({ spotting: [spotted()] });
    const intents = planScene(ctx, { density: 'normal' });
    const door = intents.find((i) => i.role === 'DOOR' && i.time === 18.4);
    expect(door).toBeDefined();
    expect(door!.query).toMatch(/door|hinge/i);
    expect(door!.durationFit).toBe('short');
    expect(door!.allowSilence).toBe(true);
    // user-marked moment has the highest priority
    expect(door!.priority).toBeGreaterThanOrEqual(0.9);
  });

  it('searches Freesound through the backend proxy — no credential in the browser request', async () => {
    const fetchFn = mockFreesoundSearch([
      {
        q: /door/i,
        results: [
          fsSound({
            id: 9201,
            name: 'old_wooden_door_creak_open',
            tags: ['door', 'wood', 'hinge', 'open'],
            description: 'old wooden door opening slowly',
            license: 'Attribution',
            duration: 1.8,
            score: 92,
          }),
        ],
      },
    ]);

    const svc = new RetrievalService(() => runtime(), { autoMode: 'suggest' });
    const ctx = scene({ spotting: [spotted()] });
    const intents = planScene(ctx, { density: 'normal' });
    const door = intents.find((i) => i.role === 'DOOR')!;
    const res = await svc.search(door);

    expect(res.error).toBeNull();
    expect(res.candidates.length).toBeGreaterThan(0);

    // the browser called the UMBRA backend, never freesound.org, and the
    // request carried no credential whatsoever (the mock would have thrown)
    const calledUrl = new URL(fetchFn.mock.calls[0][0] as string, 'http://umbra.test');
    expect(calledUrl.pathname).toBe('/api/library/freesound/search');
    expect(calledUrl.searchParams.get('token')).toBeNull();
    expect(calledUrl.searchParams.get('query')).toMatch(/door/i);
    expect(calledUrl.searchParams.get('fields')).toContain('previews');
    expect(calledUrl.searchParams.get('fields')).toContain('license');
    expect(calledUrl.searchParams.get('filter')).toMatch(/duration/);

    const c = res.candidates[0];
    expect(c.asset.provider).toBe('freesound');
    expect(c.asset.soundId).toBe('9201');
    expect(c.asset.creator).toBe('umbra-fixture');
    expect(c.asset.license).toBe('Attribution');
    expect(c.asset.licenseClass).toBe('CC_BY');
    expect(c.asset.attributionRequired).toBe(true);
    expect(c.asset.sourceUrl).toContain('/sounds/9201/');
    expect(c.asset.creditLine).toContain('umbra-fixture');
    expect(c.asset.previewUrls?.['preview-hq-mp3']).toContain('/data/previews/9201_hq.mp3');
    expect(c.licenseOk).toBe(true);
  });

  it('auditions the preview: fetches the hq-mp3 once, caches by sound id', async () => {
    const fetchFn = mockFreesoundSearch([
      { q: /door/i, results: [fsSound({ id: 9202, name: 'door_creak_02', tags: ['door'], duration: 1.5, score: 10 })] },
    ]);
    const svc = new RetrievalService(() => runtime());
    const intent = planEvent(scene(), spotted({ id: 'ev-d', role: 'DOOR', time: 18.4 }));
    const res = await svc.search(intent);
    const asset = res.candidates[0].asset;

    const first = await svc.ensurePreview(asset);
    expect(first.cacheKey).toBe('fs-9202-preview');
    expect(first.blob.size).toBeGreaterThan(44);

    // second call must be served from the cache — no second network fetch
    const previewFetches = fetchFn.mock.calls.filter(([i]) => String(i).includes('/data/previews/')).length;
    expect(previewFetches).toBe(1);
    const second = await svc.ensurePreview(asset);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(fetchFn.mock.calls.filter(([i]) => String(i).includes('/data/previews/')).length).toBe(1);
  });

  it('places a REAL editable clip at 00:18.4 with license + provenance attached', async () => {
    mockFreesoundSearch([
      {
        q: /door/i,
        results: [
          fsSound({
            id: 9203,
            name: 'wood_door_open_slow',
            tags: ['door', 'hinge', 'wood', 'open'],
            description: 'wooden door opening',
            license: 'Attribution',
            duration: 1.8,
            score: 88,
            username: 'field_recorder_anne',
          }),
        ],
      },
    ]);
    const svc = new RetrievalService(() => runtime());
    const ctx = scene({ spotting: [spotted({ id: 'ev-t1' })] });
    const intent = planEvent(ctx, spotted({ id: 'ev-t1' }));

    const res = await svc.search(intent);
    const candidate = res.candidates[0];
    const clip = await svc.placeClip({ sceneId: 'sc-test', intent, candidate, start: 18.4, projectId: 'prj-t1' });
    await svc.recordProvenance(clip, 'prj-t1');

    // timeline placement is exact
    expect(clip.start).toBeCloseTo(18.4, 5);
    expect(clip.end).toBeGreaterThan(clip.start);

    // it is a real, separate, editable clip — not a flattened mix
    expect(clip.id).toMatch(/^C/);
    expect(clip.role).toBe('DOOR');
    expect(clip.source).toBe('LIB');
    expect(clip.cacheKey).toBe('fs-9203-preview');
    expect(clip.asset.license).toBe('Attribution');
    expect(clip.asset.creator).toBe('field_recorder_anne');
    expect(clip.asset.retrievedAt).toBeGreaterThan(0);

    // editable surface: move, trim, fade, gain, pan
    const editable: SoundClip = {
      ...clip,
      start: 19.1, // moved
      end: 19.1 + 1.2, // trimmed
      offset: 0.1,
      gain: 0.62,
      pan: -0.3,
      fadeIn: 0.08,
      fadeOut: 0.22,
      transform: { ...clip.transform, lowpassHz: 4000 },
    };
    expect(editable.start).toBe(19.1);
    expect(editable.end - editable.start).toBeCloseTo(1.2, 5);
    expect(editable.gain).toBe(0.62);
    expect(editable.pan).toBe(-0.3);
    expect(editable.transform.lowpassHz).toBe(4000);

    // provenance ledger carries the full attribution chain
    const ledger = await provenanceStore.list();
    const entry = ledger.find((e) => e.clipId === clip.id);
    expect(entry).toBeDefined();
    expect(entry!.asset.creator).toBe('field_recorder_anne');
    expect(entry!.asset.license).toBe('Attribution');
    expect(entry!.asset.sourceUrl).toContain('/sounds/9203/');
    expect(entry!.usedAt).toBeCloseTo(18.4, 5);

    // credits export includes it (txt + json)
    const txt = exportCreditsTxt(ledger, 'T1 demo', 60);
    expect(txt).toContain('wood_door_open_slow');
    expect(txt).toContain('field_recorder_anne');
    expect(txt).toContain('Attribution');
    const json = JSON.parse(exportCreditsJson(ledger, 'T1 demo', 60)) as ReturnType<typeof ledgerFromClips>;
    expect(json.entries[0].creditLine).toContain('field_recorder_anne');
    expect(json.entries[0].quality).toBe('preview');
  });

  it('FIND ALTERNATIVE keeps timeline edits and swaps only the source audio', async () => {
    mockFreesoundSearch([
      {
        q: /door/i,
        results: [
          fsSound({ id: 9204, name: 'door_creak_v1', tags: ['door'], duration: 1.8, score: 70 }),
          fsSound({ id: 9205, name: 'door_creak_v2', tags: ['door'], duration: 1.6, score: 95 }),
        ],
      },
    ]);
    const svc = new RetrievalService(() => runtime());
    const intent = planEvent(scene(), spotted());
    const res = await svc.search(intent);
    const clip = await svc.placeClip({ sceneId: 'sc-test', intent, candidate: res.candidates[0], start: 18.4, projectId: 'prj' });
    const produced: SoundClip = { ...clip, start: 18.4, end: 18.4 + 1.4, offset: 0.2, gain: 0.5, pan: 0.25, fadeIn: 0.05, fadeOut: 0.15, transform: { ...clip.transform, reverse: true } };

    // user clicks FIND ALTERNATIVE on the produced clip
    const altIntent = svc.alternativeIntent(produced, 'alt');
    expect(altIntent.sceneId).toBe(produced.sceneId);
    expect(altIntent.role).toBe('DOOR');
    expect(altIntent.time).toBe(18.4);
    const altRes = await svc.search(altIntent);
    // the user picks a DIFFERENT candidate from the alternative list
    const alt = altRes.candidates.find((c) => c.asset.soundId !== produced.asset.soundId) ?? altRes.candidates[0];
    expect(alt.asset.soundId).not.toBe(produced.asset.soundId);

    const next = await svc.placeClip({ sceneId: produced.sceneId, intent: altIntent, candidate: alt, start: produced.start, projectId: 'prj' });
    const replaced = svc.applyReplacement(produced, next);

    // location, gain, pan, fades, transform preserved — only source swapped
    expect(replaced.start).toBe(produced.start);
    expect(replaced.gain).toBe(produced.gain);
    expect(replaced.pan).toBe(produced.pan);
    expect(replaced.fadeIn).toBe(produced.fadeIn);
    expect(replaced.fadeOut).toBe(produced.fadeOut);
    expect(replaced.transform).toEqual(produced.transform);
    expect(replaced.offset).toBe(produced.offset);
    expect(replaced.asset.soundId).not.toBe(produced.asset.soundId);
    expect(replaced.cacheKey).not.toBe(produced.cacheKey);
    expect(replaced.intentId).toBe(altIntent.id);
  });
});

/* ==================================================================== *
 *  T2 — dark industrial basement → AUTO SOUND DESIGN → SUGGEST
 * ==================================================================== */
describe('T2 · dark industrial basement → AUTO SUGGEST → separate clips', () => {
  const basement = (): SceneSoundContext =>
    scene({
      title: 'Dark industrial basement',
      tags: ['basement', 'industrial', 'pipes', 'machine', 'concrete', 'echo'],
      summary: 'underground machine room, dripping pipes, concrete floor, distant machinery',
      tension: 0.85,
      motion: 0.35,
      spotting: [spotted({ id: 'ev-step', role: 'FOOTSTEP', time: 8.0, label: 'footsteps on concrete @ 00:08.0' })],
    });

  it('planner produces room tone / pipe (water) / footstep / machine intents — all distinct roles', () => {
    const intents = planScene(basement(), { density: 'normal' });
    const roles = new Set(intents.map((i) => i.role));
    expect(roles.has('ROOM_TONE')).toBe(true); // basement/interior bed
    expect(roles.has('MECHANICAL')).toBe(true); // machine bed (dread)
    expect(roles.has('WATER')).toBe(true); // pipe / drip resonance
    expect(roles.has('FOOTSTEP')).toBe(true); // user spotting event
    // never one giant "whole scene" query — each intent is an audible phenomenon
    for (const i of intents) {
      expect(i.query.trim().length).toBeGreaterThan(0);
      expect(i.query).not.toMatch(/dark.*.*basement/i);
    }
  });

  it('AUTO SOUND DESIGN (SUGGEST) returns three+ separate candidate sets and places nothing', async () => {
    const fetchFn = mockFreesoundSearch([
      { q: /room tone|ambience|interior|empty/i, results: [fsSound({ id: 6301, name: 'old_basement_room_tone', tags: ['room-tone', 'interior', 'basement'], description: 'large empty room tone', duration: 30, score: 85 })] },
      { q: /pipe|drip|water/i, results: [fsSound({ id: 6302, name: 'water_drip_pipe_resonance', tags: ['water', 'drip', 'pipe'], description: 'water dripping in metal pipe', duration: 3.0, score: 82 })] },
      { q: /footstep|walk|step/i, results: [fsSound({ id: 6303, name: 'footsteps_concrete_basement', tags: ['footstep', 'concrete', 'basement'], description: 'slow footsteps on concrete', duration: 0.9, score: 78 })] },
      { q: /machine|mechanical|engine/i, results: [fsSound({ id: 6304, name: 'distant_machine_hum', tags: ['machine', 'industrial', 'hum'], description: 'distant machine room hum', duration: 26, score: 88 })] },
      { q: /drone/i, results: [fsSound({ id: 6305, name: 'low_dark_drone', tags: ['drone', 'low'], description: 'sustained low drone', duration: 40, score: 90 })] },
    ]);

    const svc = new RetrievalService(() => runtime(), { autoMode: 'suggest', density: 'normal' });
    const out = await svc.autoDesign(basement(), 'prj-t2', 'suggest');

    // SUGGEST: nothing is placed — this is the honest default
    expect(out.placed).toHaveLength(0);

    // but each intent has its own candidate set (three+ separate selections)
    expect(out.suggestions.length).toBeGreaterThanOrEqual(3);
    const roles = out.suggestions.map((s) => s.intent.role);
    expect(roles).toContain('ROOM_TONE');
    expect(roles).toContain('WATER');
    expect(roles).toContain('FOOTSTEP');
    expect(roles).toContain('MECHANICAL');

    // every suggestion carries real candidates, never empty window dressing
    for (const s of out.suggestions) {
      expect(s.candidates.length).toBeGreaterThan(0);
      expect(s.candidates[0].asset.license).toBeTruthy();
      expect(s.candidates[0].asset.creator).toBe('umbra-fixture');
    }

    // each search actually hit the API (not one chained mega-query)
    const searchCalls = fetchFn.mock.calls.filter(([i]) => String(i).includes('/api/library/freesound/search'));
    expect(searchCalls.length).toBe(out.suggestions.length);
  });

  it('AUTO FULL places several separate clips — one per role, never a flattened file', async () => {
    const fetchFn = mockFreesoundSearch([
      { q: /room tone|ambience|interior|empty/i, results: [fsSound({ id: 6311, name: 'basement_room_tone_loop', tags: ['room-tone'], description: 'basement room tone', duration: 34, score: 96 })] },
      { q: /pipe|drip|water/i, results: [fsSound({ id: 6312, name: 'pipe_drip', tags: ['water', 'drip'], description: 'pipe resonance drip', duration: 3.2, score: 97 })] },
      { q: /footstep|walk|step/i, results: [fsSound({ id: 6313, name: 'soft_footsteps_wood_floor', tags: ['footsteps', 'wood', 'floor', 'basement'], description: 'slow footsteps on wooden floor', duration: 0.7, score: 98 })] },
      { q: /machine|mechanical|engine/i, results: [fsSound({ id: 6314, name: 'distant_machinery_hum', tags: ['machinery', 'hum', 'machine'], description: 'distant machinery hum', duration: 20, score: 94 })] },
      { q: /drone/i, results: [fsSound({ id: 6315, name: 'dark_drone', tags: ['drone'], description: 'dark drone', duration: 45, score: 95 })] },
    ]);

    const svc = new RetrievalService(() => runtime(), { autoMode: 'auto-full', density: 'normal', autoFullThreshold: 0.6 });
    // user library has priority but is empty; use a fixture-only run
    const out = await svc.autoDesign(basement(), 'prj-t2b', 'auto-full');

    expect(out.placed.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(out.placed.map((c) => c.id));
    expect(ids.size).toBe(out.placed.length); // every clip is its own object

    // separate clips, distinct assets/roles — nothing flattened into one file
    const roles = new Set(out.placed.map((c) => c.role));
    expect(roles.has('ROOM_TONE')).toBe(true);
    expect(roles.has('WATER')).toBe(true);
    expect(roles.has('FOOTSTEP')).toBe(true);
    expect(roles.has('MECHANICAL')).toBe(true);

    // each placed clip has provenance + position
    const ledger = await provenanceStore.list();
    expect(ledger.length).toBe(out.placed.length);
    for (const clip of out.placed) {
      expect(clip.start).toBeGreaterThanOrEqual(0);
      expect(clip.end).toBeGreaterThan(clip.start);
      expect(clip.asset.license).toBeTruthy();
      expect(ledger.some((e) => e.clipId === clip.id)).toBe(true);
    }

    // spot-check: the footstep spotting event landed at 8.0s
    const step = out.placed.find((c) => c.role === 'FOOTSTEP');
    expect(step!.start).toBeCloseTo(8.0, 5);

    // machine/drone beds carried the horror transform, others stayed clean
    const machine = out.placed.find((c) => c.role === 'MECHANICAL');
    expect(machine!.transform).toEqual(HORROR_DRONE_TRANSFORM);
    const tone = out.placed.find((c) => c.role === 'ROOM_TONE');
    expect(tone!.transform).toEqual(NO_TRANSFORM);

    // and the whole thing ran through real API calls
    expect(fetchFn.mock.calls.filter(([i]) => String(i).includes('/api/library/freesound/search')).length).toBeGreaterThanOrEqual(3);
  });
});

/* ==================================================================== *
 *  T3 — real mechanical recording → Umbra processing → dark drone
 * ==================================================================== */
describe('T3 · mechanical recording → Umbra drone transform + provenance', () => {
  it('user library import keeps full metadata (never infers license from filename)', async () => {
    const svc = new RetrievalService(() => runtime());
    const file = new File([wavBlob(3.0)], 'factory_floor_01.wav', { type: 'audio/wav' });
    const rec = await svc.userLibrary.importFile(file, {
      role: 'MECHANICAL',
      tags: ['mechanical', 'factory', 'machine'],
      license: 'CC0',
      licenseClass: 'CC0',
      creator: 'Jane Composer',
      sourceUrl: 'https://example.com/my-factory-floor-recording',
      note: 'self-recorded',
    });
    expect(rec.name).toBe('factory_floor_01.wav');
    expect(rec.licenseClass).toBe('CC0');
    expect(rec.creator).toBe('Jane Composer');
  });

  it('searches the USER LIBRARY first and ranks it above external sources', async () => {
    // external provider returns a decent machine sound…
    mockFreesoundSearch([
      { q: /machine|mechanical|engine/i, results: [fsSound({ id: 7701, name: 'generic_machine_buzz', tags: ['machine'], description: 'machine buzz', duration: 12, score: 90 })] },
    ]);
    const svc = new RetrievalService(() => runtime());
    const file = new File([wavBlob(12)], 'my_distant_machinery_hum.wav', { type: 'audio/wav' });
    await svc.userLibrary.importFile(file, {
      role: 'MECHANICAL',
      tags: ['distant', 'machinery', 'hum', 'mechanical', 'machine'],
      license: 'CC0',
      licenseClass: 'CC0',
      creator: 'Me',
      sourceUrl: 'umbra://user/my-recording',
      note: 'my own field recording',
    });

    const ctx = scene({ title: 'Machine room', tags: ['machine', 'mechanical'], tension: 0.9 });
    const intents = planScene(ctx, { density: 'normal' });
    const mech = intents.find((i) => i.role === 'MECHANICAL')!;
    const res = await svc.search(mech);

    const top = res.candidates[0];
    expect(top.asset.provider).toBe('user-library');
    expect(top.asset.creator).toBe('Me');
    expect(top.asset.licenseClass).toBe('CC0');
    expect(top.asset.sourceUrl).toBe('umbra://user/my-recording');
    // privilege is a nudge, not a fiat — and the user file must still be licensed correctly
    expect(top.licenseOk).toBe(true);
  });

  it('places the mechanical recording with the horror-drone transform + provenance, source and transform retained', async () => {
    mockFreesoundSearch([
      { q: /machine|mechanical|engine/i, results: [fsSound({ id: 7702, name: 'other_machine', tags: ['machine'], duration: 10, score: 5 })] },
    ]);
    const svc = new RetrievalService(() => runtime());
    const file = new File([wavBlob(12)], 'mech_room_capture_distant_machinery_hum.wav', { type: 'audio/wav' });
    await svc.userLibrary.importFile(file, {
      role: 'MECHANICAL',
      tags: ['distant', 'machinery', 'hum', 'mechanical', 'machine', 'industrial'],
      license: 'CC0',
      licenseClass: 'CC0',
      creator: 'Field Crew',
      sourceUrl: 'https://example.com/mech-room-capture',
      note: 'recorded on location',
    });

    const ctx = scene({ title: 'Engine room', tags: ['machine', 'mechanical'], tension: 0.92, motion: 0.2 });
    const intents = planScene(ctx, { density: 'normal' });
    const mech = intents.find((i) => i.role === 'MECHANICAL')!;
    // planner marks mechanical/dread beds as drone-transform candidates
    expect(mech.transform).toEqual(HORROR_DRONE_TRANSFORM);

    const res = await svc.search(mech);
    const clip = await svc.placeClip({
      sceneId: ctx.sceneId,
      intent: mech,
      candidate: res.candidates[0],
      start: 2.0,
      projectId: 'prj-t3',
      transform: mech.transform,
    });
    await svc.recordProvenance(clip, 'prj-t3');

    // the transform IS the processing: pitch -12, 250% stretch, filters, reverb, loop, modulate
    expect(clip.transform).toEqual(HORROR_DRONE_TRANSFORM);
    expect(clip.transform.pitch).toBe(-12);
    expect(clip.transform.playbackRate).toBeCloseTo(0.4, 5); // = 250% duration
    expect(clip.transform.lowpassHz).toBe(1800);
    expect(clip.transform.reverb).toBeGreaterThan(0.5);
    expect(clip.transform.loop).toBe(true);
    expect(clip.transform.slowModulate).toBeGreaterThan(0);

    // source is a USER library file — source indicator USR, not LIB, not GEN
    expect(clip.source).toBe('USR');
    expect(clip.asset.provider).toBe('user-library');
    expect(clip.asset.creator).toBe('Field Crew');
    expect(clip.asset.licenseClass).toBe('CC0');
    expect(clip.asset.retrievedAt).toBeGreaterThan(0);
    expect(clip.asset.quality).toBe('original'); // user files are originals

    // provenance survives (creator, source, retrieval date, license)
    const entry = (await provenanceStore.list()).find((e) => e.clipId === clip.id)!;
    expect(entry.asset.creator).toBe('Field Crew');
    expect(entry.asset.sourceUrl).toBe('https://example.com/mech-room-capture');
    expect(entry.asset.license).toBe('CC0');
    expect(entry.role).toBe('MECHANICAL');

    // user can still EDIT the transform afterwards — source stays as-is
    const edited: SoundClip = {
      ...clip,
      transform: { ...clip.transform, pitch: -6, reverb: 0.4, lowpassHz: 1200 },
    };
    expect(edited.transform.pitch).toBe(-6);
    expect(edited.transform.reverb).toBe(0.4);
    expect(edited.asset.creator).toBe('Field Crew'); // provenance untouched
    expect(edited.asset.licenseClass).toBe('CC0');
  });
});

/* ==================================================================== *
 *  Policy + honesty — required by the license-aware workflow
 * ==================================================================== */
describe('license policy is a hard gate, never inferred from a filename', () => {
  it('mapFreesoundLicense reads the actual API metadata', () => {
    expect(mapFreesoundLicense('Creative Commons 0')).toEqual({ cls: 'CC0', attributionRequired: false });
    expect(mapFreesoundLicense('Attribution')).toEqual({ cls: 'CC_BY', attributionRequired: true });
    expect(mapFreesoundLicense('Attribution NonCommercial')).toEqual({ cls: 'CC_BY_NC', attributionRequired: true });
    expect(mapFreesoundLicense('totally-made-up')).toEqual({ cls: 'UNKNOWN', attributionRequired: true });
  });

  it('STRICT policy rejects CC BY-NC; PERSONAL NONCOMMERCIAL accepts it', async () => {
    mockFreesoundSearch([
      {
        q: /drone/i,
        results: [
          fsSound({ id: 8801, name: 'nc_drone', tags: ['drone'], license: 'Attribution NonCommercial', duration: 20, score: 99 }),
        ],
      },
    ]);
    const strict = new RetrievalService(() => runtime(), { licensePolicy: { mode: 'strict', accepted: ['CC0', 'CC_BY'] } });
    const personal = new RetrievalService(() => runtime(), { licensePolicy: { mode: 'personal', accepted: ['CC0', 'CC_BY', 'CC_BY_NC'] } });

    const intent: RetrievalIntent = { id: 'i', sceneId: 's', role: 'DRONE', query: 'drone', altQueries: [], time: null, offset: 0, durationFit: 'long', priority: 1, allowSilence: true, reason: 'test' };
    const strictRes = await strict.search(intent);
    const personalRes = await personal.search(intent);

    const strictCandidate = strictRes.candidates[0];
    const personalCandidate = personalRes.candidates[0];
    expect(strictCandidate.licenseOk).toBe(false);
    expect(strictCandidate.licenseReason).toMatch(/not allowed/);
    // honest transparency: the candidate is visible but flagged — never placed
    expect(strictCandidate.asset.license).toBe('Attribution NonCommercial');
    expect(personalCandidate.licenseOk).toBe(true);
  });

  it('UNKNOWN license is never auto-placed even by AUTO SAFE', async () => {
    mockFreesoundSearch([
      { q: /door/i, results: [fsSound({ id: 8802, name: 'weird_door', tags: ['door'], license: 'Special Use', duration: 1.0, score: 100 })] },
    ]);
    const svc = new RetrievalService(() => runtime(), { autoMode: 'auto-safe', licensePolicy: { mode: 'custom', accepted: ['CC0', 'CC_BY'] } });
    const ctx = scene({ spotting: [spotted({ id: 'ev-x', role: 'DOOR', time: 3 })] });
    const out = await svc.autoDesign(ctx, 'prj', 'auto-safe');
    expect(out.placed).toHaveLength(0);
    expect(out.skipped).toBeGreaterThan(0);
  });

  it('provider failure is surfaced honestly — no fake results, no silent substitution', async () => {
    setFetchMock((async () => {
      throw new Error('network unreachable');
    }) as never);
    const svc = new RetrievalService(() => runtime());
    const intent = planEvent(scene(), spotted());
    const res = await svc.search(intent);
    expect(res.candidates).toHaveLength(0);
    expect(res.error).toMatch(/network unreachable|Freesound/);
  });

  it('not configured on the backend → provider reports not-ready and the search returns an honest error', async () => {
    const svc = new RetrievalService(() => runtime({ configured: false, searchAvailable: false, verification: null }));
    expect(svc.freesound.status().ready).toBe(false);
    expect(svc.freesound.status().reason).toMatch(/not configured|backend/i);
    const res = await svc.search(planEvent(scene(), spotted()));
    expect(res.candidates).toHaveLength(0);
    expect(res.error).toBeTruthy();
  });

  it('backend offline → provider reports honestly instead of pretending', async () => {
    const svc = new RetrievalService(() => ({ status: EMPTY_FREESOUND_STATUS, backendOnline: false }));
    const st = svc.freesound.status();
    expect(st.ready).toBe(false);
    expect(st.online).toBe(false);
    expect(st.reason).toMatch(/backend/i);
  });

  it('preview and original quality are never conflated; original needs OAuth', async () => {
    const svc = new RetrievalService(() => runtime());
    const asset = freesoundToAsset(fsSound({ id: 9901, name: 'q_check', tags: [] }), 'preview', 'fs-9901-preview');
    expect(asset.quality).toBe('preview');

    const original = await svc.fetchOriginal(asset).catch((e: Error) => e);
    expect(original).toBeInstanceOf(Error);
    expect((original as Error).message).toMatch(/OAuth/i);

    // with OAuth connected the original download goes through the backend —
    // the browser sends no Authorization header; the backend holds the token
    const bearerFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sounds/9901/download')) return new Response(wavBlob(2), { status: 200, headers: { 'content-type': 'audio/wav' } });
      throw new Error(`unexpected ${url}`);
    });
    setFetchMock(bearerFn as never);
    const svc2 = new RetrievalService(() =>
      runtime({ oauthAvailable: true, oauthConfigured: true, expiresAt: Date.now() + 3600_000 }),
    );
    const orig = await svc2.fetchOriginal(asset);
    expect(orig.cacheKey).toBe('fs-9901-original');
    expect(String(bearerFn.mock.calls[0][0])).toContain('/api/library/freesound/sounds/9901/download');
    const firstInit = bearerFn.mock.calls[0][1] as RequestInit | undefined;
    expect(new Headers(firstInit?.headers).has('Authorization')).toBe(false);
  });
});

/* ==================================================================== *
 *  CLAP reranking — advisory signal, never the sole voice
 * ==================================================================== */
describe('CLAP rerank is advisory on top of ranking, never authoritative', () => {
  it('blends CLAP with text/duration/license signals and keeps MATCH informational', async () => {
    const intent: RetrievalIntent = { id: 'ci', sceneId: 's', role: 'DOOR', query: 'wooden door open', altQueries: [], time: 0, offset: 0, durationFit: 'short', priority: 1, allowSilence: true, reason: 't' };
    const policy: LicensePolicy = { mode: 'strict', accepted: ['CC0', 'CC_BY'] };
    const mk = (id: number, name: string, score: number, duration: number): LibraryAsset => ({
      provider: 'freesound',
      providerLabel: 'Freesound',
      soundId: String(id),
      title: name,
      creator: 'u',
      sourceUrl: `https://freesound.org/sounds/${id}/`,
      license: 'Attribution',
      licenseClass: 'CC_BY',
      attributionRequired: true,
      creditLine: `"${name}" by u — Attribution`,
      retrievedAt: 0,
      quality: 'preview',
      duration,
      type: 'wav',
      sampleRate: 44100,
      channels: 2,
      tags: ['door', 'wood'],
      cacheKey: `fs-${id}-preview`,
      score,
    });
    const a = mk(1, 'wooden door creak', 10, 1.5);
    const b = mk(2, 'dog barking', 90, 1.4); // good provider score, wrong semantics

    registerClapReranker({
      id: 'test-clap',
      label: 'test',
      score: async (query) => (query.includes('door') ? (a.title.includes('door') ? 0.95 : 0.05) : 0),
    });
    const ranked = rankCandidates({ intent, assets: [a, b], policy });
    const fetched: string[] = [];
    const { candidates } = await applyClapRerank(intent, ranked, policy, async (asset) => {
      fetched.push(asset.soundId);
      return new Blob([new Uint8Array(1024)]);
    }, async () => new Float32Array(2048));

    expect(fetched.length).toBe(2);
    // CLAP helped, but it is one of several signals: candidate a (door) still wins
    expect(candidates[0].asset.soundId).toBe('1');
    // signals are transparent
    const clapSignal = candidates[0].signals.find((s) => s.label === 'clap');
    expect(clapSignal).toBeDefined();
    expect(candidates[0].match).toBeGreaterThan(0);
    expect(candidates[0].match).toBeLessThanOrEqual(1);
  });

  it('CLAP failure never breaks retrieval', async () => {
    const intent: RetrievalIntent = { id: 'cf', sceneId: 's', role: 'DRONE', query: 'low drone', altQueries: [], time: null, offset: 0, durationFit: 'long', priority: 1, allowSilence: true, reason: 't' };
    const asset: LibraryAsset = { ...({} as LibraryAsset), provider: 'freesound', providerLabel: 'Freesound', soundId: '5', title: 'drone', creator: 'u', sourceUrl: 'https://freesound.org/sounds/5/', license: 'Creative Commons 0', licenseClass: 'CC0', attributionRequired: false, creditLine: '"drone" by u', retrievedAt: 0, quality: 'preview', duration: 20, tags: ['drone'], cacheKey: 'fs-5-preview' };
    registerClapReranker({ id: 'bad', label: 'bad', score: async () => { throw new Error('clap crashed'); } });
    const ranked = rankCandidates({ intent, assets: [asset], policy: { mode: 'strict', accepted: ['CC0', 'CC_BY'] } });
    const out = await applyClapRerank(intent, ranked, { mode: 'strict', accepted: ['CC0', 'CC_BY'] }, async () => new Blob(), async () => new Float32Array(0));
    expect(out.candidates).toHaveLength(1);
    expect(out.used).toBe(false);
  });
});
