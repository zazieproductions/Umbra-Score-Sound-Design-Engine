/* ==================================================================== *
 *  UMBRA · RETRIEVAL SERVICE
 *
 *  Orchestrates the full chain for one intent:
 *    provider search → license gate → rank → (CLAP rerank) → cache → clip
 *
 *  Providers are searched in privilege order:
 *    1. User Library (highest privilege, offline, personal)
 *    2. Freesound (if configured / online)
 *    3. Pixabay assisted (no programmatic search — surfaced separately)
 *
 *  Failures are surfaced, never faked, and never silently substituted
 *  with generative audio labeled as library material.
 * ==================================================================== */

import { FreesoundProvider } from './freesound';
import { UserLibraryProvider } from './userLibrary';
import { PixabayAssistedProvider } from './pixabay';
import { soundCache, provenanceStore, settingsStore, shortId } from './cache';
import { rankCandidates, applyClapRerank, getClapReranker } from './ranking';
import { planScene } from './planner';
import type { SceneSoundContext } from './types';
import type {
  FreesoundCredentials,
  LibraryAsset,
  LibrarySettings,
  ProvenanceEntry,
  RankedCandidate,
  RetrievalIntent,
  RetrievalSearchResult,
  SoundClip,
} from './types';
import { DEFAULT_LIBRARY_SETTINGS, NO_TRANSFORM, isBedRole } from './types';
import type { SoundLibraryProvider } from './provider';

export class RetrievalService {
  readonly freesound: FreesoundProvider;
  readonly userLibrary: UserLibraryProvider;
  readonly pixabay: PixabayAssistedProvider;
  settings: LibrarySettings;

  constructor(
    private getCreds: () => FreesoundCredentials,
    settings?: Partial<LibrarySettings>,
  ) {
    this.freesound = new FreesoundProvider(getCreds);
    this.userLibrary = new UserLibraryProvider();
    this.pixabay = new PixabayAssistedProvider();
    this.settings = { ...DEFAULT_LIBRARY_SETTINGS, ...(settings ?? {}) };
    // persist settings locally (no secrets involved here)
    settingsStore.save(this.settings);
  }

  providers(): SoundLibraryProvider[] {
    return [this.userLibrary, this.freesound, this.pixabay];
  }

  /* ----------------------------------------------------- planning ---- */

  planForScene(ctx: SceneSoundContext): RetrievalIntent[] {
    return planScene(ctx, { density: this.settings.density });
  }

  /* ------------------------------------------------------ searching -- */

  /**
   * Search user library + Freesound for one intent, return ranked results.
   * User library results are rank-boosted by privilege but policy still gates.
   */
  async search(intent: RetrievalIntent, page = 1): Promise<RetrievalSearchResult> {
    const policy = this.settings.licensePolicy;
    const raw: { provider: SoundLibraryProvider; result: RetrievalSearchResult }[] = [];
    const unavailable: string[] = [];

    // user library first — highest privilege, offline
    try {
      const r = await this.userLibrary.search(intent, { policy });
      if (r.error === null) raw.push({ provider: this.userLibrary, result: r });
      else unavailable.push(`user library: ${r.error}`);
    } catch (e) {
      unavailable.push(`user library: ${(e as Error).message}`);
      raw.push({
        provider: this.userLibrary,
        result: { intent, count: 0, page, candidates: [], clap: 'metadata', elapsedMs: 0, error: (e as Error).message },
      });
    }

    // freesound — only if token ready; otherwise say so honestly
    const fsStatus = this.freesound.status();
    if (fsStatus.ready) {
      try {
        const r = await this.freesound.search(intent, { page });
        raw.push({ provider: this.freesound, result: r });
      } catch (e) {
        unavailable.push(`freesound: ${(e as Error).message}`);
        raw.push({
          provider: this.freesound,
          result: { intent, count: 0, page, candidates: [], clap: 'metadata', elapsedMs: 0, error: (e as Error).message },
        });
      }
    } else {
      unavailable.push(`freesound: ${fsStatus.reason ?? 'not ready'}`);
    }

    if (!raw.length && unavailable.length) {
      return {
        intent,
        count: 0,
        page,
        candidates: [],
        clap: 'metadata',
        elapsedMs: 0,
        error: unavailable.join(' · '),
      };
    }
    if (!raw.length) {
      return {
        intent,
        count: 0,
        page,
        candidates: [],
        clap: 'metadata',
        elapsedMs: 0,
        error: 'No online provider available (offline mode). User library unchanged.',
      };
    }

    // ---- license gate + combined ranking
    const all = raw.flatMap((r) => r.result.candidates);
    const ranked = rankCandidates({
      intent,
      assets: all.map((c) => c.asset),
      policy,
    });
    // user-library privilege: a treated real library asset beats external only
    // when its raw score is within a small margin — never by fiat
    const results = ranked.map((c) => {
      const lic = c.licenseOk;
      return {
        ...c,
        match: Math.min(1, c.match + (c.asset.provider === 'user-library' ? 0.06 : 0)),
        signals: [
          ...c.signals,
          { label: 'source privilege', value: c.asset.provider === 'user-library' ? 'user library first' : 'external', weight: 0.06 },
        ],
        licenseOk: lic,
      };
    });

    // ---- CLAP rerank (advisory; only if a reranker is registered)
    const clapReranker = getClapReranker();
    const merged = clapReranker
      ? (
          await applyClapRerank(
            intent,
            results,
            policy,
            async (asset) => (await this.ensurePreview(asset)).blob,
            decodeToMono,
          )
        ).candidates
      : results;

    // apply license gate honestly: disallowed candidates stay visible but are
    // clearly flagged — the user may still inspect them (never auto-place).
    // Unavailable providers are reported truthfully alongside any results.
    const providerErrors = raw.map((r) => r.result.error).filter(Boolean);
    const allNotes = [...providerErrors, ...unavailable];
    return {
      intent,
      count: raw.reduce((a, r) => a + r.result.count, 0),
      page,
      candidates: merged,
      clap: clapReranker ? 'metadata' : 'metadata', // refined to 'freesound-laion-clap' when similar() ran
      elapsedMs: Math.round(raw.reduce((a, r) => a + r.result.elapsedMs, 0)),
      error: allNotes.length ? allNotes.join(' · ') : null,
    };
  }

  /** Freesound-only similar search via laion_clap similarity space. */
  async similar(asset: LibraryAsset): Promise<RetrievalSearchResult> {
    const r = await this.freesound.similar(asset);
    const ranked = rankCandidates({ intent: r.intent, assets: r.candidates.map((c) => c.asset), policy: this.settings.licensePolicy });
    return { ...r, candidates: ranked };
  }

  /* ------------------------------------------------------ audio ------ */

  /** Ensure the preview blob exists in the local cache, return its record. */
  async ensurePreview(asset: LibraryAsset): Promise<{ blob: Blob; cacheKey: string }> {
    const cached = await soundCache.get(asset.cacheKey);
    if (cached) return { blob: cached.blob, cacheKey: asset.cacheKey };
    const provider = this.providerFor(asset.provider);
    const pf = await provider.fetchPreview(asset);
    const record = {
      cacheKey: asset.cacheKey,
      blob: pf.blob,
      asset,
      addedAt: Date.now(),
      projects: [],
    };
    await soundCache.put(record);
    return { blob: pf.blob, cacheKey: asset.cacheKey };
  }

  /** Original-quality when OAuth2 is configured; otherwise honest error. */
  async fetchOriginal(asset: LibraryAsset): Promise<{ blob: Blob; cacheKey: string }> {
    if (!this.freesound.capabilities.download || asset.provider !== 'freesound') {
      throw new Error('Original download is only available for Freesound via OAuth2.');
    }
    // keep provenance honest: cache key reflects quality
    const originalKey = `fs-${asset.soundId}-original`;
    const cached = await soundCache.get(originalKey);
    if (cached) return { blob: cached.blob, cacheKey: originalKey };
    const pf = await this.freesound.fetchOriginal({ ...asset, cacheKey: originalKey });
    await soundCache.put({ cacheKey: originalKey, blob: pf.blob, asset: { ...asset, quality: 'original', cacheKey: originalKey }, addedAt: Date.now(), projects: [] });
    return { blob: pf.blob, cacheKey: originalKey };
  }

  providerFor(id: LibraryAsset['provider']): SoundLibraryProvider {
    if (id === 'freesound') return this.freesound;
    if (id === 'user-library') return this.userLibrary;
    return this.pixabay;
  }

  /* -------------------------------------------------- clip factory --- */

  /**
   * Place a retrieved asset as a split, editable SoundClip at a timeline
   * position. Returns the clip after caching + provenance write.
   */
  async placeClip(opts: {
    sceneId: string;
    intent: RetrievalIntent;
    candidate: RankedCandidate;
    start: number;
    transform?: SoundClip['transform'];
    gain?: number;
    pan?: number;
    projectId?: string;
    familyId?: string;
    variantIndex?: number;
  }): Promise<SoundClip> {
    const { asset } = opts.candidate;
    // cache audio (preview first; original only when explicitly requested)
    const { blob, cacheKey } = await this.ensurePreview(asset);
    void blob;
    // decode duration precisely from the blob for honest clip length
    let dur = asset.duration || 0;
    try {
      const d = await decodeDuration(cacheKey);
      if (d > 0) dur = d;
    } catch {
      /* keep provider metadata */
    }

    const bed = isBedRole(opts.intent.role);
    const clampDur = bed
      ? Math.min(dur, 90)
      : Math.min(dur, Math.max(0.5, opts.intent.maxDuration ?? 6));
    const transform = opts.transform ?? opts.intent.transform ?? NO_TRANSFORM;
    const clip: SoundClip = {
      id: `C${Math.random().toString(36).slice(2, 10)}`,
      sceneId: opts.sceneId,
      name: asset.title.replace(/\.(wav|mp3|ogg|flac|aif|aiff|m4a)$/i, ''),
      role: opts.intent.role,
      source: asset.provider === 'user-library' ? 'USR' : asset.provider === 'freesound' ? 'LIB' : 'PIX',
      start: opts.start,
      end: opts.start + clampDur,
      offset: 0,
      gain: opts.gain ?? 0.9,
      pan: opts.pan ?? 0,
      fadeIn: bed ? 0.4 : 0.01,
      fadeOut: bed ? 0.4 : 0.02,
      muted: false,
      solo: false,
      transform,
      asset,
      cacheKey,
      intentId: opts.intent.id,
      match: Math.round(opts.candidate.match * 100) / 100,
      familyId: opts.familyId,
      variantIndex: opts.variantIndex,
    };
    if (opts.projectId) await soundCache.touchProjects(cacheKey, opts.projectId);
    return clip;
  }

  /* ------------------------------------------------ provenance ------- */

  async recordProvenance(clip: SoundClip, projectId: string): Promise<ProvenanceEntry> {
    const entry: ProvenanceEntry = {
      id: shortId('prov'),
      clipId: clip.id,
      sceneId: clip.sceneId,
      usedAt: clip.start,
      role: clip.role,
      asset: clip.asset,
    };
    await provenanceStore.add(entry);
    await soundCache.touchProjects(clip.cacheKey, projectId);
    return entry;
  }

  /* -------------------------------------------- auto sound design ---- */

  /**
   * Run planner → search → gate → (suggest) | (auto place).
   *  - SUGGEST: return top candidates per intent, place nothing.
   *  - AUTO SAFE: place only match ≥ autoSafeThreshold AND license-ok.
   *  - AUTO FULL: place match ≥ autoFullThreshold, everything editable.
   *  AUTO FULL never flattens; clips remain separate + undoable.
   */
  async autoDesign(
    ctx: SceneSoundContext,
    projectId: string,
    mode: LibrarySettings['autoMode'],
    onProgress?: (msg: string) => void,
  ): Promise<{ placed: SoundClip[]; suggestions: { intent: RetrievalIntent; candidates: RankedCandidate[] }[]; skipped: number }> {
    const placed: SoundClip[] = [];
    const suggestions: { intent: RetrievalIntent; candidates: RankedCandidate[] }[] = [];
    let skipped = 0;
    const intents = this.planForScene(ctx);
    const threshold = mode === 'auto-safe' ? this.settings.autoSafeThreshold : this.settings.autoFullThreshold;

    for (const intent of intents) {
      if (intent.isSilenceChoice) {
        onProgress?.(`negative space: keeping ${ctx.title} quiet`);
        continue;
      }
      onProgress?.(`search: ${intent.query}`);
      const res = await this.search(intent);
      if (res.error && !res.candidates.length) {
        onProgress?.(`provider unavailable: ${res.error}`);
        skipped++;
        continue;
      }
      const ok = res.candidates.filter((c) => c.licenseOk);
      if (!ok.length) {
        onProgress?.(`no license-safe candidate for "${intent.query}" — skipping`);
        skipped++;
        continue;
      }
      const suggestionsList = ok.slice(0, 6);
      suggestions.push({ intent, candidates: suggestionsList });

      if (mode === 'off') continue;
      if (mode === 'suggest') continue; // nothing placed

      const best = ok[0];
      if (!best || best.match < threshold) {
        if (best && best.match < threshold) skipped++;
        continue;
      }
      const start = intent.time !== null ? intent.time + intent.offset : ctx.start + 0.5;
      const clip = await this.placeClip({
        sceneId: ctx.sceneId,
        intent,
        candidate: best,
        start,
        projectId,
        transform: intent.transform,
      });
      await this.recordProvenance(clip, projectId);
      placed.push(clip);
      onProgress?.(`placed ${clip.name} @ ${clip.start.toFixed(2)}s (match ${Math.round(clip.match * 100)}%)`);
    }
    return { placed, suggestions, skipped };
  }

  /* ---------------------------------------------- footstep family ---- */

  /** Sequence several variants as one family (avoids robotic repeats). */
  familyOf(clips: SoundClip[], startTime: number, stepSec: number): SoundClip[] {
    return clips.map((c, i) => ({
      ...c,
      start: startTime + i * stepSec,
      end: startTime + i * stepSec + (c.end - c.start),
      gain: Math.max(0.35, Math.min(1.3, c.gain * (0.88 + Math.random() * 0.24))),
      pan: Math.max(-0.6, Math.min(0.6, (Math.random() - 0.5) * 0.5)),
      transform: { ...c.transform, playbackRate: c.transform.playbackRate * (0.94 + Math.random() * 0.12) },
      familyId: `fam${Date.now().toString(36)}`,
      variantIndex: i,
    }));
  }

  /* -------------------------------------- replacement / finding ------ */

  /**
   * Build the retrieval intent for FIND ALTERNATIVE on a placed clip.
   * Keeps the original semantic intent (role, time, duration fit) so the
   * replacement search recalls what the clip is FOR — not just its name.
   */
  alternativeIntent(clip: SoundClip, idPrefix = 'alt'): RetrievalIntent {
    return {
      id: `${idPrefix}-${clip.id}`,
      sceneId: clip.sceneId,
      role: clip.role,
      query: clip.asset.tags.length ? clip.asset.tags.slice(0, 4).join(' ') : clip.name,
      altQueries: [clip.name, clip.asset.title],
      time: clip.start,
      offset: 0,
      durationFit: clip.role === 'ROOM_TONE' || clip.role === 'DRONE' ? ('long' as const) : ('short' as const),
      priority: 0.9,
      allowSilence: false,
      reason: `find alternative for ${clip.name} (maintains original intent)`,
    };
  }

  /**
   * ONE-CLICK REPLACE: keep every timeline/production edit (position,
   * gain, pan, fades, offest, transform, mute/solo), swap ONLY the
   * source audio + its provenance (asset, cacheKey, match, name).
   */
  applyReplacement(clip: SoundClip, next: SoundClip): SoundClip {
    return {
      ...clip,
      asset: next.asset,
      cacheKey: next.cacheKey,
      name: next.name,
      match: next.match,
      end: clip.start + Math.min(clip.end - clip.start, next.asset.duration || clip.end - clip.start),
      intentId: next.intentId,
    };
  }
}

/* ------------------------------------------------------- helpers ---- */

async function decodeToMono(blob: Blob): Promise<Float32Array | null> {
  try {
    const ab = await blob.arrayBuffer();
    const Ctor: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new Ctor();
    const buf = await ac.decodeAudioData(ab);
    const ch = buf.getChannelData(0);
    await ac.close();
    return ch;
  } catch {
    return null;
  }
}

const durationCache = new Map<string, number>();
async function decodeDuration(cacheKey: string): Promise<number> {
  if (durationCache.has(cacheKey)) return durationCache.get(cacheKey) ?? 0;
  const rec = await soundCache.get(cacheKey);
  if (!rec) return 0;
  const ab = await rec.blob.arrayBuffer();
  const Ctor: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new Ctor();
  const buf = await ac.decodeAudioData(ab);
  await ac.close();
  durationCache.set(cacheKey, buf.duration);
  return buf.duration;
}

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const Ctor: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new Ctor();
  try {
    const ab = await blob.arrayBuffer();
    return await ac.decodeAudioData(ab);
  } finally {
    await ac.close().catch(() => undefined);
  }
}
