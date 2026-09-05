/* ==================================================================== *
 *  UMBRA · RETRIEVAL SERVICE
 *
 *  Orchestrates the full chain for one intent:
 *    video events / scene → plan → provider search → license gate
 *    → rank → (CLAP rerank) → cache → family variants → AudioClip
 *
 *  Providers are searched in privilege order:
 *    1. User Library (highest privilege, offline, personal)
 *    2. Freesound (if configured / online)
 *    3. Pixabay assisted (no programmatic search — surfaced separately)
 *
 *  Failures are surfaced, never faked, and never silently substituted
 *  with generative audio labeled as library material. Negative space
 *  is a valid decision, and every auto decision is reported with its
 *  reason (AutoPlacementReport).
 * ==================================================================== */

import { FreesoundProvider } from './freesound';
import { UserLibraryProvider } from './userLibrary';
import { PixabayAssistedProvider } from './pixabay';
import { soundCache, provenanceStore, settingsStore, shortId } from './cache';
import { rankCandidates, applyClapRerank, getClapReranker } from './ranking';
import { planScene, planSoundEvents, type PlanEventsOptions } from './planner';
import type { SceneSoundContext, SoundEventCandidate } from './types';
import type {
  AutoPlacementReport,
  LibraryAsset,
  LibrarySettings,
  ProvenanceEntry,
  RankedCandidate,
  RetrievalIntent,
  RetrievalSearchResult,
  SoundClip,
  SoundDistance,
  SoundEventKind,
  TransformSpec,
} from './types';
import { DEFAULT_LIBRARY_SETTINGS, NO_TRANSFORM, isBedRole } from './types';
import type { SoundLibraryProvider } from './provider';

export interface AutoDesignOptions {
  /** video-analysis candidates that DRIVE the run (events first) */
  events?: SoundEventCandidate[];
  /** override planner options (confidence threshold, tolerance, caps) */
  plan?: PlanEventsOptions;
}

export interface AutoPlacementDetail {
  clipId: string;
  role: SoundClip['role'];
  eventTimestamp?: number;
  placementTimestamp?: number;
  eventConfidence?: number;
  searchQuery?: string;
  /** evidence strings from the video-analysis stage (kept on the clip) */
  eventEvidence?: string[];
  /** retrieval intent kept for FIND ALTERNATIVE reuse */
  eventKind?: SoundEventKind;
  eventMaterial?: string;
  eventAction?: string;
  eventEnvironment?: string;
  eventDistance?: SoundDistance;
  eventPerspective?: string;
  autoPlaced: boolean;
}

export interface AutoDesignResult {
  placed: SoundClip[];
  suggestions: { intent: RetrievalIntent; candidates: RankedCandidate[] }[];
  skipped: number;
  /** per-intent truthful status — placed / suggested / skipped / silence / failed */
  reports: AutoPlacementReport[];
  /** placement metadata for canonical AudioClip conversion */
  details: AutoPlacementDetail[];
}

export class RetrievalService {
  readonly freesound: FreesoundProvider;
  readonly userLibrary: UserLibraryProvider;
  readonly pixabay: PixabayAssistedProvider;
  settings: LibrarySettings;

  /**
   * Freesound needs no credentials here: the API key lives in the backend
   * process (FREESOUND_API_KEY), and the provider talks to
   * `/api/integrations/freesound/*`. Nothing secret is stored in the browser.
   */
  constructor(settings?: Partial<LibrarySettings>) {
    this.freesound = new FreesoundProvider();
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

  planFromVideo(ctx: SceneSoundContext, events: SoundEventCandidate[], opts?: PlanEventsOptions): RetrievalIntent[] {
    return planSoundEvents(ctx, events, {
      density: this.settings.density,
      timingToleranceMs: this.settings.timingToleranceMs,
      eventConfidenceThreshold: this.settings.eventConfidenceThreshold,
      ...opts,
    });
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

    // freesound — only if the backend reports it configured; otherwise say so honestly
    const fsStatus = await this.freesound.status();
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
    let clapUsed = false;
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
    if (clapReranker) {
      // cheap boolean: applyClapRerank returns used:true only when scores landed
      clapUsed = results.some((c) => merged.some((m) => m.asset.soundId === c.asset.soundId && m.signals.some((s) => s.label === 'clap')));
    }

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
      clap: clapUsed ? 'freesound-laion-clap' : 'metadata',
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

  /** Original quality when the backend has an OAuth2 token; otherwise honest error. */
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

  /* ------------------------------------------- transform estimation -- */

  /**
   * Conservative initial processing from scene context — a starting point
   * only. Never destructive: transform lives on the clip, source is kept.
   * Explicit planner transforms (e.g. the dread recipe) always win.
   */
  estimateTransform(intent: RetrievalIntent): TransformSpec {
    if (intent.transform) return intent.transform;
    if (intent.distance === 'far') {
      // far-away machinery / ambience: lower gain, HF attenuation, more reverb
      return { ...NO_TRANSFORM, gainDb: -6, lowpassHz: 5200, reverb: 0.28 };
    }
    if (intent.perspective === 'offscreen') {
      return { ...NO_TRANSFORM, lowpassHz: 6500, gainDb: -5 };
    }
    if (isBedRole(intent.role)) {
      // room tone / ambience: loop + crossfade, long fades handled at placement
      return { ...NO_TRANSFORM, loop: true, crossfadeLoop: true };
    }
    if (intent.role === 'IMPACT' || intent.role === 'DOOR' || intent.role === 'KNOCK' || intent.role === 'METAL') {
      // close impact: maintain transient, minimal reverb
      return { ...NO_TRANSFORM, reverb: 0 };
    }
    return NO_TRANSFORM;
  }

  /* -------------------------------------------------- clip factory --- */

  /**
   * Place a retrieved asset as a split, editable clip at a timeline
   * position. Returns a legacy SoundClip; `useStudio` converts it to the
   * canonical AudioClip at the boundary.
   */
  async placeClip(opts: {
    sceneId: string;
    intent: RetrievalIntent;
    candidate: RankedCandidate;
    start: number;
    transform?: TransformSpec;
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
    // estimation is applied by the autonomous path (autoDesign); manual
    // placement keeps intent transforms or a clean default
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
   * Run events → plan → search → gate → rank → (suggest) | (auto place).
   *
   *   SUGGEST    returns candidates per intent, places nothing.
   *   AUTO SAFE  places only when event confidence ≥ eventConfidenceThreshold
   *              AND best match ≥ autoSafeThreshold AND license-ok AND a
   *              provider succeeded.
   *   AUTO FULL  same, with lower match threshold; still never bypasses
   *              license policy and never fills negative space.
   *
   * Returns a truthful report per intent — including WHY it was skipped.
   */
  async autoDesign(
    ctx: SceneSoundContext,
    projectId: string,
    mode: LibrarySettings['autoMode'],
    onProgress?: (msg: string) => void,
    opts: AutoDesignOptions = {},
  ): Promise<AutoDesignResult> {
    const placed: SoundClip[] = [];
    const suggestions: { intent: RetrievalIntent; candidates: RankedCandidate[] }[] = [];
    const reports: AutoPlacementReport[] = [];
    const details: AutoPlacementDetail[] = [];
    const budget = { used: 0, cap: Math.max(1, this.settings.maxSearchesPerRun) };

    const events = (opts.events ?? []).filter((e) => e.sceneId === ctx.sceneId || !e.sceneId);
    const hasVideoEvents = events.length > 0;
    const intents = hasVideoEvents
      ? this.planFromVideo(ctx, events, opts.plan)
      : this.planForScene(ctx);

    const silence = intents.filter((i) => i.isSilenceChoice);
    const actionable = intents.filter((i) => !i.isSilenceChoice);

    for (const i of silence) {
      reports.push({ intentId: i.id, role: i.role, query: i.query || '(silence)', status: 'silence', reason: i.reason });
    }
    if (hasVideoEvents && !actionable.length) {
      onProgress?.(`negative space: no sound-producing event in ${ctx.title} — keeping it quiet`);
    }

    // bounded, prioritized search order (event condensation, never per-frame)
    const prioritized = [...actionable].sort(
      (a, b) =>
        (b.priority * (b.eventConfidence ?? 0.8)) - (a.priority * (a.eventConfidence ?? 0.8)) ||
        (a.detectedTimestamp ?? a.time ?? 0) - (b.detectedTimestamp ?? b.time ?? 0),
    );
    const searched = prioritized.slice(0, budget.cap);
    for (const overflow of prioritized.slice(budget.cap)) {
      reports.push({
        intentId: overflow.id,
        role: overflow.role,
        eventTimestamp: overflow.detectedTimestamp ?? overflow.time ?? undefined,
        placementTimestamp: overflow.placementTimestamp,
        query: overflow.query,
        status: 'skipped',
        reason: `search budget (${budget.cap} per run) exceeded — event retained but not queried`,
      });
      onProgress?.(`budget: skipped ${overflow.query}`);
    }

    for (const intent of searched) {
      const at = intent.placementTimestamp ?? intent.detectedTimestamp ?? (intent.time !== null ? intent.time + intent.offset : ctx.start + 0.5);
      const baseReport = {
        intentId: intent.id,
        role: intent.role,
        eventTimestamp: intent.detectedTimestamp ?? intent.time ?? undefined,
        placementTimestamp: intent.placementTimestamp ?? at,
        query: intent.query,
      };

      // low-confidence / ambiguous events stay suggestions in AUTO modes —
      // never placed. AUTO FULL may lower the floor but never invents a
      // sound with no evidence.
      const conf = intent.eventConfidence ?? 1;
      const confFloor = mode === 'auto-safe' ? this.settings.eventConfidenceThreshold : this.settings.eventConfidenceThreshold * 0.5;
      if (mode !== 'off' && mode !== 'suggest' && (intent.suggestOnly || conf < confFloor)) {
        const why = intent.suggestOnly
          ? 'source is not named by the scene (ambiguous motion) — suggestion only'
          : `event confidence ${conf.toFixed(2)} < ${confFloor.toFixed(2)}`;
        reports.push({ ...baseReport, status: 'skipped', reason: `${why} (${intent.reason})` });
        onProgress?.(`not auto-placed: ${intent.query} — ${why}`);
        continue;
      }

      onProgress?.(`search: ${intent.query}`);
      const res = await this.searchWithAlternates(intent, budget);
      if (res.error && !res.candidates.length) {
        reports.push({ ...baseReport, status: 'failed', reason: `provider unavailable: ${res.error}` });
        onProgress?.(`provider unavailable: ${res.error}`);
        continue;
      }
      if (!res.candidates.length) {
        reports.push({ ...baseReport, status: 'skipped', reason: `no candidates returned for "${intent.query}"` });
        continue;
      }

      // honest transparency: disallowed candidates stay visible + flagged
      suggestions.push({ intent, candidates: res.candidates.slice(0, 8) });
      const ok = res.candidates.filter((c) => c.licenseOk);
      if (!ok.length) {
        reports.push({
          ...baseReport,
          status: 'skipped',
          reason: `no license-safe candidate (policy ${this.settings.licensePolicy.mode}) — ${res.candidates[0]?.licenseReason ?? 'license gate rejected all'}`,
        });
        onProgress?.(`license gate: no safe candidate for "${intent.query}"`);
        continue;
      }

      if (mode === 'off' || mode === 'suggest') {
        reports.push({ ...baseReport, status: 'suggested', reason: `${mode} mode — placed nothing`, match: ok[0].match });
        continue;
      }

      const best = ok[0];
      const matchFloor = mode === 'auto-safe' ? this.settings.candidateMatchThreshold : this.settings.autoFullThreshold;
      if (best.match < matchFloor) {
        reports.push({ ...baseReport, status: 'skipped', reason: `best candidate match ${best.match.toFixed(2)} < ${matchFloor.toFixed(2)} (${best.asset.title})`, match: best.match, asset: best.asset });
        onProgress?.(`weak candidate: ${intent.query} best ${(best.match * 100).toFixed(0)}%`);
        continue;
      }

      const steps = intent.familySteps?.length ? intent.familySteps : [at];
      const family = steps.length > 1;
      // conservative automatic transform estimation is part of the autonomous
      // video path; text-driven planning keeps its explicit recipes only
      const transform = hasVideoEvents ? intent.transform ?? this.estimateTransform(intent) : intent.transform;
      if (family) {
        // ONE search → small variant family rotated across onsets
        const variants = ok.filter((c, i, arr) => arr.findIndex((x) => x.asset.soundId === c.asset.soundId) === i).slice(0, 4);
        const familyId = `fam-${intent.id}`;
        for (let i = 0; i < steps.length; i++) {
          const variant = variants[i % variants.length];
          const clip = await this.placeClip({
            sceneId: ctx.sceneId,
            intent,
            candidate: variant,
            start: round3(steps[i]),
            projectId,
            transform,
            familyId,
            variantIndex: i,
            gain: variantGain(i),
            pan: variantPan(i),
          });
          await this.recordProvenance(clip, projectId);
          placed.push(clip);
          details.push({
            clipId: clip.id,
            role: clip.role,
            eventTimestamp: steps[i],
            placementTimestamp: round3(steps[i]),
            eventConfidence: intent.eventConfidence,
            searchQuery: intent.query,
            eventEvidence: intent.eventEvidence,
            eventKind: intent.eventKind,
            eventMaterial: intent.material,
            eventAction: intent.action,
            eventEnvironment: intent.environment,
            eventDistance: intent.distance,
            eventPerspective: intent.perspective,
            autoPlaced: true,
          });
          onProgress?.(`placed ${clip.name} @ ${clip.start.toFixed(2)}s (variant ${i + 1}/${steps.length})`);
        }
        reports.push({ ...baseReport, status: 'placed', reason: `${steps.length}-step family, ${variants.length} variant(s) rotated`, match: best.match, asset: best.asset, familySize: steps.length });
        continue;
      }

      const clip = await this.placeClip({
        sceneId: ctx.sceneId,
        intent,
        candidate: best,
        start: at,
        projectId,
        transform,
      });
      await this.recordProvenance(clip, projectId);
      placed.push(clip);
      details.push({
        clipId: clip.id,
        role: clip.role,
        eventTimestamp: intent.detectedTimestamp ?? intent.time ?? undefined,
        placementTimestamp: at,
        eventConfidence: intent.eventConfidence,
        searchQuery: intent.query,
        eventEvidence: intent.eventEvidence,
        eventKind: intent.eventKind,
        eventMaterial: intent.material,
        eventAction: intent.action,
        eventEnvironment: intent.environment,
        eventDistance: intent.distance,
        eventPerspective: intent.perspective,
        autoPlaced: true,
      });
      reports.push({ ...baseReport, status: 'placed', reason: `${best.asset.title} matched ${(best.match * 100).toFixed(0)}%`, match: best.match, asset: best.asset });
      onProgress?.(`placed ${clip.name} @ ${clip.start.toFixed(2)}s (match ${Math.round(clip.match * 100)}%)`);
    }

    return { placed, suggestions, skipped: reports.filter((r) => r.status === 'skipped' || r.status === 'failed').length, reports, details };
  }

  /** Search primary query; retry an alternate if the first yields no license-safe results. */
  private async searchWithAlternates(intent: RetrievalIntent, budget: { used: number; cap: number }): Promise<RetrievalSearchResult> {
    const first = await this.search(intent);
    const hasSafe = first.candidates.some((c) => c.licenseOk);
    if (hasSafe || !first.candidates.length || budget.used >= budget.cap) {
      budget.used++;
      return first;
    }
    const alt = intent.altQueries?.[0];
    if (!alt) {
      budget.used++;
      return first;
    }
    budget.used += 2;
    const altIntent = { ...intent, id: `${intent.id}-alt`, query: alt, reason: `${intent.reason} · alternate query "${alt}"` };
    const second = await this.search(altIntent);
    return { ...second, intent, count: second.count || first.count, error: second.error ?? first.error };
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
   * When the clip carries autonomous-analysis provenance, it is restored
   * so alternative searches stay contextual.
   */
  alternativeIntent(
    clip: SoundClip,
    idPrefix = 'alt',
    provenance?: { query?: string; detectedTimestamp?: number; placementTimestamp?: number; eventConfidence?: number; material?: string; environment?: string; eventKind?: RetrievalIntent['eventKind']; distance?: RetrievalIntent['distance'] },
  ): RetrievalIntent {
    const base = this.settings.density;
    void base;
    const role = clip.role;
    const isBed = isBedRole(role);
    const intent: RetrievalIntent = {
      id: `${idPrefix}-${clip.id}`,
      sceneId: clip.sceneId,
      role,
      query: provenance?.query ?? (clip.asset.tags.length ? clip.asset.tags.slice(0, 4).join(' ') : clip.name),
      altQueries: [clip.name, clip.asset.title],
      time: clip.start,
      offset: 0,
      durationFit: isBed ? 'long' : role === 'MECHANICAL' || role === 'VEHICLE' ? 'medium' : 'short',
      priority: 0.9,
      allowSilence: false,
      reason: `find alternative for ${clip.name} (maintains original intent)`,
      origin: 'alternative',
      detectedTimestamp: provenance?.detectedTimestamp ?? clip.start,
      placementTimestamp: provenance?.placementTimestamp ?? clip.start,
      timingToleranceMs: this.settings.timingToleranceMs,
      eventConfidence: provenance?.eventConfidence,
      material: provenance?.material,
      environment: provenance?.environment,
      eventKind: provenance?.eventKind,
      distance: provenance?.distance,
    };
    return intent;
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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** deterministic variant variation (no Math.random → testable families) */
function variantGain(i: number): number {
  const jitter = ((i * 37) % 13) / 100; // 0.00 .. 0.12
  return Math.max(0.6, Math.min(1.1, 0.9 - jitter * 0.4 + (i % 2 === 0 ? 0.04 : -0.03)));
}

function variantPan(i: number): number {
  return Math.max(-0.5, Math.min(0.5, ((i * 53) % 41) / 100 - 0.2));
}

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
