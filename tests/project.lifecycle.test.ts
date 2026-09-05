/* ==================================================================== *
 *  UMBRA · PROJECT LIFECYCLE + DRAFT PERSISTENCE
 *
 *  Behavioural guarantees behind the local draft feature and the cache
 *  ownership contract:
 *
 *    L1  Save → reload → hydrate: blob URLs never survive serialisation,
 *        library/user clips are rebuilt from the IndexedDB sound cache,
 *        missing cache audio is reported BY NAME, and the newest draft
 *        supersedes older ones (exactly one live draft).
 *    L2  Deterministic planning/regeneration is what makes procedural
 *        clips re-renderable from their stored seed — stable by seed,
 *        different by intent.
 *    L3  "Clear unused cache" can never delete audio the open project
 *        references (ownership list OR explicit cacheKey).
 * ==================================================================== */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Project } from '../src/lib/types';
import type { CacheRecord, SavedProjectDraft } from '../src/lib/library/cache';
import { projectStore, provenanceStore, soundCache } from '../src/lib/library/cache';
import {
  discardLatestSavedProject,
  hydrateClips,
  loadLatestSnapshot,
  persistProject,
  serializeProject,
} from '../src/lib/persistence';
import { addLayer, analyzeProject, regenerateLayer } from '../src/lib/generate';
import { DEFAULT_MASTER, type MasterParams } from '../src/lib/dsp';
import type { LibraryAsset } from '../src/lib/library/types';

/* ------------------------------------------------------------ fixtures -- */

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

function asset(over: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    provider: 'freesound',
    providerLabel: 'Freesound',
    soundId: '9201',
    title: 'old_wooden_door_creak_open',
    creator: 'umbra-fixture',
    sourceUrl: 'https://freesound.org/sounds/9201/',
    license: 'CC0',
    licenseClass: 'CC0',
    attributionRequired: false,
    creditLine: 'door by umbra-fixture (CC0)',
    retrievedAt: 1,
    quality: 'preview',
    duration: 2,
    sampleRate: 44100,
    channels: 1,
    tags: ['door'],
    ...over,
  };
}

function clip(over: Partial<AudioClip> & { id: string }): AudioClip {
  return {
    id: over.id,
    name: 'door slam',
    audioId: `local-${over.id}`,
    url: 'blob:umbra-dead-url',
    provider: 'library',
    start: 10,
    duration: 2,
    offset: 0,
    sourceDuration: 2,
    gain: 1,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    solo: false,
    sampleRate: 44100,
    channels: 1,
    metadata: { provider: 'library' },
    createdAt: 1,
    version: 1,
    cacheKey: `ck-${over.id}`,
    role: 'DOOR',
    intentId: 'intent-1',
    match: 0.91,
    ...over,
  };
}

function project(id: string, clips: AudioClip[]): Project {
  return {
    id,
    name: `Cut ${id}`,
    source: 'local test',
    duration: 120,
    fps: 24,
    resolution: '1920 × 1080',
    videoUrl: 'blob:umbra-video-url',
    scenes: [],
    clips,
    spotting: [],
    createdAt: 1,
  };
}

function master(): MasterParams {
  return { ...DEFAULT_MASTER, volume: 0.85, ceiling: -1, glue: 0.4 };
}

/* ==================================================================== *
 *  L1 — draft save → reload → hydrate
 * ==================================================================== */

describe('L1 · draft lifecycle round trip', () => {
  beforeEach(async () => {
    const all = await projectStore.list();
    await Promise.all(all.map((d) => projectStore.remove(d.id)));
  });

  it('serializeProject never persists blob: video or clip URLs', () => {
    const p = project('p-blob', [
      clip({ id: 'a', url: 'blob:dead-1' }),
      clip({ id: 'b', url: '/api/audio/live' }),
      clip({ id: 'c', url: '' }),
    ]);
    const clean = serializeProject(p);
    expect(clean.videoUrl).toBeNull();
    expect(clean.clips.find((c) => c.id === 'a')!.url).toBe('');
    // live proxy URLs and already-empty URLs are untouched
    expect(clean.clips.find((c) => c.id === 'b')!.url).toBe('/api/audio/live');
    expect(clean.clips.find((c) => c.id === 'c')!.url).toBe('');
  });

  it('persist → loadLatestSnapshot restores the project and master, URL-free', async () => {
    const p = project('p-rt', [clip({ id: 'a' })]);
    await persistProject(p, master());
    const snap = await loadLatestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.project.id).toBe('p-rt');
    expect(snap!.project.name).toBe('Cut p-rt');
    expect(snap!.master).toEqual(master());
    expect(snap!.savedAt).toBeGreaterThan(0);
    // nothing blob: survived
    expect(snap!.project.videoUrl).toBeNull();
    for (const c of snap!.project.clips) expect(c.url).not.toMatch(/^blob:/);
  });

  it('a new save supersedes older drafts — exactly one live draft exists', async () => {
    await persistProject(project('p-old', []), master());
    await persistProject(project('p-new', []), master());
    const all = await projectStore.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('p-new');
  });

  it('latest() returns the newest draft by savedAt', async () => {
    const mk = (id: string, savedAt: number): SavedProjectDraft => ({
      id,
      name: id,
      duration: 60,
      savedAt,
      hadLocalVideo: false,
      serialized: { id },
      master: {},
    });
    await projectStore.save(mk('older', 1_000));
    await projectStore.save(mk('newer', 2_000));
    const latest = await projectStore.latest();
    expect(latest?.id).toBe('newer');
  });

  it('discardLatestSavedProject removes the newest draft and reports whether one existed', async () => {
    await projectStore.save({
      id: 'p-discard',
      name: 'discard me',
      duration: 60,
      savedAt: 500,
      hadLocalVideo: false,
      serialized: { id: 'p-discard' },
      master: {},
    });
    await expect(discardLatestSavedProject()).resolves.toBe(true);
    await expect(discardLatestSavedProject()).resolves.toBe(false);
    await expect(projectStore.latest()).resolves.toBeUndefined();
  });
});

describe('L1 · hydration rebuilds playable clips from the cache', () => {
  it('library clip with cache audio is rebuilt to a fresh blob URL from the cache', async () => {
    const c = clip({ id: 'lib', cacheKey: 'ck-hydrate-ok' });
    await soundCache.put({
      cacheKey: 'ck-hydrate-ok',
      blob: wavBlob(),
      asset: asset(),
      addedAt: 1,
      projects: ['p-owner'],
    } satisfies CacheRecord);

    const { project: out, warnings } = await hydrateClips(project('p-hydrate', [c]));
    expect(warnings).toEqual([]);
    const rebuilt = out.clips[0];
    expect(rebuilt.url).toMatch(/^blob:/);
    expect(rebuilt.audioId).toBe('ck-hydrate-ok');
    expect(rebuilt.provider).toBe('library');
    // the project now owns the blob — clear-unused must keep it
    const rec = await soundCache.get('ck-hydrate-ok');
    expect(rec?.projects).toContain('p-hydrate');
  });

  it('missing cache audio restores the clip silent and reports it BY NAME', async () => {
    const c = clip({ id: 'gone', name: 'explosion finale', cacheKey: 'ck-does-not-exist' });
    const { project: out, warnings } = await hydrateClips(project('p-miss', [c]));
    expect(out.clips[0].url).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('explosion finale');
    expect(warnings[0]).toContain('no longer available');
  });

  it('deterministic procedural clip without a re-render environment is reported by name, with seed inputs preserved for the browser re-render', async () => {
    const proc = clip({
      id: 'proc',
      provider: 'umbra-procedural',
      name: 'sub pressure cue',
      cacheKey: undefined,
      audioId: 'local:424242',
      metadata: {
        provider: 'umbra-procedural',
        model: 'umbra-voices-17',
        prompt: 'deep sub drone, 40 hz',
        seed: 424242,
        key: 'A',
        mode: null,
        bpm: null,
        generationSettings: { kind: 'sub', space: 'room', tension: 0.62, rootHz: 55 },
      },
    });
    const serialized = serializeProject(project('p-proc', [proc]));
    const saved = serialized.clips[0];
    // every input the deterministic re-render needs survives the draft
    expect(saved.metadata.prompt).toBe('deep sub drone, 40 hz');
    expect(saved.metadata.seed).toBe(424242);
    expect(saved.metadata.generationSettings).toMatchObject({ kind: 'sub' });

    const { project: out, warnings } = await hydrateClips(serialized);
    expect(out.clips[0].url).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sub pressure cue');
    expect(warnings[0]).toContain('cannot be re-rendered');
  });
});

/* ==================================================================== *
 *  L2 — deterministic planning + regeneration (re-render stability)
 * ==================================================================== */

describe('L2 · deterministic procedural planning and regeneration', () => {
  it('analyzeProject produces the identical plan for identical inputs', () => {
    const a = analyzeProject('same_reel.mov', 148, null, 'test');
    const b = analyzeProject('same_reel.mov', 148, null, 'test');
    expect({ ...a, createdAt: 0 }).toEqual({ ...b, createdAt: 0 });
    expect(a.scenes).toHaveLength(b.scenes.length);
  });

  it('addLayer is fully determined by its seed', () => {
    const a = addLayer('drone', 'hall', 0.6, 55, 12345);
    const b = addLayer('drone', 'hall', 0.6, 55, 12345);
    const c = addLayer('drone', 'hall', 0.6, 55, 54321);
    expect(a).toEqual(b);
    // a different seed is a different synthesis intent — the whole layer moves
    expect(a.id === c.id && a.seed === c.seed && a.tone === c.tone).toBe(false);
  });

  it('regenerateLayer is a pure function of the layer', () => {
    const layer = addLayer('strings', 'cathedral', 0.8, 110, 999);
    const once = regenerateLayer(layer);
    const twice = regenerateLayer(layer);
    expect(once).toEqual(twice);
    expect(once.version).toBe(layer.version + 1);
    expect(once.seed).not.toBe(layer.seed);
  });
});

/* ==================================================================== *
 *  L3 — clear-unused cache can never orphan a referenced clip
 * ==================================================================== */

describe('L3 · cache ownership vs clear-unused', () => {
  it('keeps records the open project owns or references by key; removes the rest', async () => {
    await provenanceStore.clear();
    const owned = {
      cacheKey: 'ck-owned',
      blob: wavBlob(),
      asset: asset({ soundId: '1' }),
      addedAt: 1,
      projects: ['p-open'],
    } satisfies CacheRecord;
    const explicit = {
      cacheKey: 'ck-explicit',
      blob: wavBlob(),
      asset: asset({ soundId: '2' }),
      addedAt: 1,
      projects: [], // pre-ownership record — survives only via keepKeys
    } satisfies CacheRecord;
    const stray = {
      cacheKey: 'ck-stray',
      blob: wavBlob(),
      asset: asset({ soundId: '3' }),
      addedAt: 1,
      projects: ['p-closed'],
    } satisfies CacheRecord;
    await soundCache.put(owned);
    await soundCache.put(explicit);
    await soundCache.put(stray);

    const removed = await soundCache.clearUnused(['p-open'], ['ck-explicit']);

    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(soundCache.get('ck-owned')).resolves.toBeDefined();
    await expect(soundCache.get('ck-explicit')).resolves.toBeDefined();
    await expect(soundCache.get('ck-stray')).resolves.toBeUndefined();
  });
});
