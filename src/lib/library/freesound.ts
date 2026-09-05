/* ==================================================================== *
 *  UMBRA · FREESOUND PROVIDER
 *
 *  Official APIv2 only. No scraping, no mirroring. The API key lives in
 *  the backend process (FREESOUND_API_KEY); this provider is an HTTP
 *  client for `/api/integrations/freesound/*` and nothing else:
 *
 *    search        POST /api/integrations/freesound/search
 *    sound         GET  /api/integrations/freesound/sounds/<id>
 *    analysis      GET  /api/integrations/freesound/sounds/<id>/analysis
 *    similar       GET  /api/integrations/freesound/sounds/<id>/similar
 *    preview       GET  /api/integrations/freesound/sounds/<id>/preview
 *    download      GET  /api/integrations/freesound/sounds/<id>/download
 *                  (OAuth2 bearer, server-side, original quality only)
 *
 *  What did NOT change: the retrieval pipeline. Freesound sound objects
 *  arrive untouched and are still mapped by `freesoundToAsset()` into a
 *  LibraryAsset — creator, source url, license string, license class,
 *  sound id, preview URLs and quality — then licensed-gated and ranked by
 *  `service.ts`. No credential is stored in the browser (no localStorage,
 *  no IndexedDB, nothing in the bundle).
 *
 *  Licensing: the API returns `license` as one of
 *    "Creative Commons 0" | "Attribution" | "Attribution NonCommercial"
 *  We map those strings to classes; we never guess a license from a file
 *  name or from the tags.
 * ==================================================================== */

import type {
  LibraryAsset,
  LicenseClass,
  ProviderCapabilities,
  ProviderStatus,
  RetrievalIntent,
  RetrievalSearchResult,
} from './types';
import type { PreviewFetch, SearchOptions, SoundLibraryProvider } from './provider';
import {
  FreesoundBackendError,
  fetchFreesoundStatus,
  freesoundAnalysis,
  freesoundDownloadUrl,
  freesoundPreviewUrl,
  freesoundSearch,
  freesoundSimilar,
  type FreesoundStatus,
  type FsSound,
} from './freesoundBackend';

export type { FsSound } from './freesoundBackend';

/** How long a successful/failed status answer is reused before re-asking. */
const STATUS_CACHE_MS = 20_000;

export function mapFreesoundLicense(raw: string): { cls: LicenseClass; attributionRequired: boolean } {
  switch (raw?.trim().toLowerCase()) {
    case 'creative commons 0':
      return { cls: 'CC0', attributionRequired: false };
    case 'attribution':
      return { cls: 'CC_BY', attributionRequired: true };
    case 'attribution noncommercial':
      return { cls: 'CC_BY_NC', attributionRequired: true };
    default:
      return { cls: 'UNKNOWN', attributionRequired: true };
  }
}

export function freesoundToAsset(s: FsSound, quality: 'preview' | 'original', cacheKey: string): LibraryAsset {
  const lic = mapFreesoundLicense(s.license);
  const url = s.url.startsWith('http') ? s.url : `https://freesound.org${s.url}`;
  const creator = s.username || 'unknown';
  const creditLine = `"${s.name || `Freesound sound ${s.id}`}" by ${creator} (Freesound) — ${s.license} — ${url}`;
  const preview = (s.previews ?? {}) as Record<string, string>;
  const previews = Object.fromEntries(
    Object.entries(preview).map(([k, v]) => [k, v.startsWith('http') ? v : `https://freesound.org${v}`]),
  );
  const images = s.images
    ? {
        waveform: (s.images.waveform_l ?? s.images.waveform_m ?? '').replace(/^(\/|(https?:\/\/[^/]+))/g, (m) =>
          m.startsWith('h') ? m : 'https://freesound.org' + m,
        ),
        spectrum: (s.images.spectral_l ?? s.images.spectral_m ?? '').replace(/^(\/|(https?:\/\/[^/]+))/g, (m) =>
          m.startsWith('h') ? m : 'https://freesound.org' + m,
        ),
      }
    : undefined;
  return {
    provider: 'freesound',
    providerLabel: 'Freesound',
    soundId: String(s.id),
    title: s.name || `Freesound sound ${s.id}`,
    creator,
    sourceUrl: url,
    license: s.license || 'Unknown',
    licenseClass: lic.cls,
    attributionRequired: lic.attributionRequired,
    creditLine,
    retrievedAt: Date.now(),
    quality,
    duration: s.duration ?? 0,
    sampleRate: s.samplerate,
    channels: s.channels,
    type: s.type,
    fileSize: s.filesize,
    tags: s.tags ?? [],
    description: s.description,
    previewUrls: previews,
    md5: s.md5,
    numDownloads: s.num_downloads,
    avgRating: s.avg_rating,
    created: s.created,
    genAiPreference: s.gen_ai_preference,
    images,
    score: s.score,
    // provider stores soundId alone; cache key = `fs-<id>-<quality>`
    cacheKey,
  };
}

/** The backend client surface the provider uses (injectable in tests). */
export interface FreesoundBackendLike {
  status(probe?: 'never' | 'auto' | 'always'): Promise<FreesoundStatus>;
  search(req: {
    query: string;
    page?: number;
    pageSize?: number;
    filters?: string[];
    sort?: string;
    fields?: string;
  }): Promise<{ count: number; page: number; pageSize: number; sounds: FsSound[] }>;
  similar(
    soundId: string | number,
    page?: number,
    pageSize?: number,
  ): Promise<{ count: number; page: number; pageSize: number; sounds: FsSound[] }>;
  analysis(soundId: string | number, descriptors?: string): Promise<Record<string, number | string | number[]>>;
}

const defaultBackend: FreesoundBackendLike = {
  status: (probe) => fetchFreesoundStatus(probe ?? 'auto'),
  search: freesoundSearch,
  similar: freesoundSimilar,
  analysis: freesoundAnalysis,
};

export class FreesoundProvider implements SoundLibraryProvider {
  readonly id = 'freesound' as const;
  readonly label = 'Freesound';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    metadataSearch: true,
    preview: true,
    // original-quality download needs an OAuth2 bearer on the server
    download: 'oauth',
    licenseMetadata: true,
    attribution: true,
    similarity: true,
    audioFeatures: true,
    assistedSearch: false,
    manualImport: false,
    offline: false,
  };

  private cachedStatus: { at: number; status: ProviderStatus } | null = null;
  private lastRemote: FreesoundStatus | null = null;

  constructor(private backend: FreesoundBackendLike = defaultBackend) {}

  /* --------------------------------------------------------- status --- */

  /**
   * Ask the backend whether Freesound is configured and reachable.
   * The browser learns "configured / connected" — never the key.
   */
  async status(opts: { force?: boolean } = {}): Promise<ProviderStatus> {
    if (!opts.force && this.cachedStatus && Date.now() - this.cachedStatus.at < STATUS_CACHE_MS) {
      return this.cachedStatus.status;
    }
    let status: ProviderStatus;
    try {
      const remote = await this.backend.status('auto');
      this.lastRemote = remote;
      status = providerStatusFromRemote(remote, this.capabilities);
    } catch (e) {
      status = providerStatusFromError(e, this.capabilities);
    }
    this.cachedStatus = { at: Date.now(), status };
    return status;
  }

  /** Force a live re-check (the "re-test connection" button in Settings). */
  async refreshStatus(): Promise<ProviderStatus> {
    this.cachedStatus = null;
    try {
      const remote = await this.backend.status('always');
      this.lastRemote = remote;
      const status = providerStatusFromRemote(remote, this.capabilities);
      this.cachedStatus = { at: Date.now(), status };
      return status;
    } catch (e) {
      const status = providerStatusFromError(e, this.capabilities);
      this.cachedStatus = { at: Date.now(), status };
      return status;
    }
  }

  /** Raw backend status (quality level, key fingerprint) for the settings UI. */
  remoteStatus(): FreesoundStatus | null {
    return this.lastRemote;
  }

  sourcePageUrl(asset: LibraryAsset): string {
    return asset.sourceUrl || `https://freesound.org/sounds/${asset.soundId}/`;
  }

  /* --------------------------------------------------------- search --- */

  async search(intent: RetrievalIntent, opts: SearchOptions = {}): Promise<RetrievalSearchResult> {
    const started = performance.now();
    const page = opts.page ?? 1;
    const query = intent.query.trim() ? intent.query.trim() : allForRole(intent.role);
    const filters: string[] = [];
    if (intent.minDuration !== undefined || intent.maxDuration !== undefined) {
      const lo = intent.minDuration ?? 0;
      const hi = intent.maxDuration ?? 600;
      filters.push(`duration:[${lo} TO ${hi}]`);
    }
    // primed search: expand with role-specific terms so queries read like real
    // foley requests instead of mood sentences
    const q = expandQuery(query, intent.role);
    try {
      const data = await this.backend.search({ query: q, filters, page, pageSize: 30, sort: 'score' });
      const assets = (data.sounds ?? []).map((s) => freesoundToAsset(s, 'preview', `fs-${s.id}-preview`));
      return buildResult(intent, assets, data.count ?? 0, page, 'metadata', started);
    } catch (e) {
      return buildResult(intent, [], 0, page, 'metadata', started, messageFor(e));
    }
  }

  async metadataSearch(intent: RetrievalIntent, extraFilters: string[], page = 1): Promise<RetrievalSearchResult> {
    const started = performance.now();
    const filters = [...extraFilters];
    if (intent.minDuration !== undefined || intent.maxDuration !== undefined) {
      const lo = intent.minDuration ?? 0;
      const hi = intent.maxDuration ?? 600;
      filters.push(`duration:[${lo} TO ${hi}]`);
    }
    try {
      const data = await this.backend.search({
        query: expandQuery(intent.query, intent.role),
        filters,
        page,
        pageSize: 30,
        sort: 'score',
      });
      const assets = (data.sounds ?? []).map((s) => freesoundToAsset(s, 'preview', `fs-${s.id}-preview`));
      return buildResult(intent, assets, data.count ?? 0, page, 'metadata', started);
    } catch (e) {
      return buildResult(intent, [], 0, page, 'metadata', started, messageFor(e));
    }
  }

  /* -------------------------------------------------- similar / AI ---- */

  async similar(asset: LibraryAsset, page = 1): Promise<RetrievalSearchResult> {
    const started = performance.now();
    try {
      const data = await this.backend.similar(asset.soundId, page, 20);
      const assets = (data.sounds ?? []).map((s) => freesoundToAsset(s, 'preview', `fs-${s.id}-preview`));
      // similar() has no text intent; synthesize one so the UI still shows a
      // query source, and use the real provider similarity scores
      const intent: RetrievalIntent = {
        ...assetIntentForSimilar(asset),
        query: `similar to "${asset.title}"`,
      };
      return buildResult(intent, assets, data.count ?? assets.length, page, 'freesound-laion-clap', started);
    } catch (e) {
      const intent = assetIntentForSimilar(asset);
      return buildResult(intent, [], 0, page, 'freesound-laion-clap', started, messageFor(e));
    }
  }

  async audioFeatures(asset: LibraryAsset): Promise<Record<string, number | string | number[]>> {
    if (!asset.soundId) return {};
    try {
      return await this.backend.analysis(asset.soundId);
    } catch {
      return {};
    }
  }

  /* --------------------------------------------------------- audio ---- */

  /** Preview audio, proxied by the backend (no credential in the browser). */
  async fetchPreview(asset: LibraryAsset): Promise<PreviewFetch> {
    const url = freesoundPreviewUrl(asset.soundId, preferredQuality(asset));
    return this.fetchBlob(url);
  }

  /**
   * Original-quality file. Freesound requires OAuth2 for it; the backend
   * holds the bearer token. Without one this fails loudly — it never
   * returns a preview dressed up as an original.
   */
  async fetchOriginal(asset: LibraryAsset): Promise<PreviewFetch> {
    const res = await fetch(freesoundDownloadUrl(asset.soundId));
    if (!res.ok) {
      let message = `Freesound original download failed (${res.status}).`;
      try {
        const body = (await res.json()) as { error?: string; hint?: string; code?: string };
        if (body.error) message = body.hint ? `${body.error} ${body.hint}` : body.error;
      } catch {
        /* non-JSON body */
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    return { blob, mime: blob.type || 'audio/wav', bytes: blob.size };
  }

  private async fetchBlob(url: string): Promise<PreviewFetch> {
    const res = await fetch(url);
    if (!res.ok) {
      let message = `Freesound preview download failed (${res.status}).`;
      try {
        const body = (await res.json()) as { error?: string; hint?: string };
        if (body.error) message = body.hint ? `${body.error} ${body.hint}` : body.error;
      } catch {
        /* non-JSON body */
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    return { blob, mime: blob.type || 'audio/mpeg', bytes: blob.size };
  }
}

/* ------------------------------------------------------ status map ---- */

function providerStatusFromRemote(remote: FreesoundStatus, capabilities: ProviderCapabilities): ProviderStatus {
  if (remote.configured && remote.connected) {
    return {
      provider: 'freesound',
      label: 'Freesound',
      online: true,
      ready: true,
      reason: remote.oauth.quality === 'original'
        ? 'Connected through the Umbra backend — search, preview and original-quality download.'
        : 'Connected through the Umbra backend — search + preview (original quality needs an OAuth token on the server).',
      capabilities,
    };
  }
  if (remote.configured && remote.connected === false) {
    return {
      provider: 'freesound',
      label: 'Freesound',
      online: true,
      ready: false,
      reason: remote.reason ?? 'The backend reported an invalid Freesound API key.',
      capabilities,
    };
  }
  if (remote.configured) {
    return {
      provider: 'freesound',
      label: 'Freesound',
      online: true,
      ready: false,
      reason: remote.reason ?? 'Freesound connection state unknown — the backend could not reach it.',
      capabilities,
    };
  }
  return {
    provider: 'freesound',
    label: 'Freesound',
    online: true,
    ready: false,
    reason:
      remote.reason ??
      'No Freesound API key on the backend. Add FREESOUND_API_KEY to .env and restart the backend.',
    capabilities,
  };
}

function providerStatusFromError(e: unknown, capabilities: ProviderCapabilities): ProviderStatus {
  const message = messageFor(e);
  const offline = e instanceof FreesoundBackendError && e.code === 'backend_offline';
  return {
    provider: 'freesound',
    label: 'Freesound',
    online: !offline,
    ready: false,
    reason: offline
      ? 'The UMBRA backend is not running — Freesound retrieval goes through it. Start it with `python scripts/run_backend.py`.'
      : message,
    capabilities,
  };
}

function messageFor(e: unknown): string {
  if (e instanceof FreesoundBackendError) return e.detail();
  if (e instanceof Error) return e.message;
  return String(e);
}

/* --------------------------------------------------------- helpers ---- */

function preferredQuality(asset: LibraryAsset): string {
  const have = asset.previewUrls ?? {};
  return (
    (have['preview-hq-mp3'] && 'preview-hq-mp3') ||
    (have['preview-hq-ogg'] && 'preview-hq-ogg') ||
    (have['preview-lq-mp3'] && 'preview-lq-mp3') ||
    (have['preview-lq-ogg'] && 'preview-lq-ogg') ||
    'preview-hq-mp3'
  );
}

function expandQuery(query: string, role: RetrievalIntent['role']): string {
  const roleTerms: Partial<Record<RetrievalIntent['role'], string[]>> = {
    ROOM_TONE: ['room-tone', 'ambience', 'interior', 'empty'],
    AMBIENCE: ['ambience', 'atmosphere', 'background'],
    FOOTSTEP: ['footstep', 'footsteps', 'walking', 'steps'],
    CLOTHING: ['cloth', 'fabric', 'clothing', 'movement'],
    DOOR: ['door', 'hinge', 'doorway'],
    WOOD: ['wood', 'wooden', 'plank', 'floorboard'],
    METAL: ['metal', 'metallic'],
    GLASS: ['glass', 'glassware'],
    BODY: ['body', 'flesh', 'organic'],
    BREATH: ['breath', 'breathing'],
    MECHANICAL: ['mechanical', 'machine', 'engine'],
    ELECTRICAL: ['electrical', 'hum', 'electric'],
    WIND: ['wind', 'breeze', 'gust'],
    WEATHER: ['rain', 'storm', 'weather'],
    WATER: ['water', 'drip', 'liquid'],
    CREAK: ['creak', 'creaking', 'groan'],
    SCRAPE: ['scrape', 'scraping', 'drag'],
    IMPACT: ['impact', 'thud', 'hit'],
    KNOCK: ['knock', 'knocking', 'rap'],
    RATTLE: ['rattle', 'rattling', 'shake'],
    RUMBLE: ['rumble', 'low', 'sub'],
    DRONE: ['drone', 'hum', 'low', 'sustained'],
    TEXTURE: ['texture', 'granular', 'foley'],
    TRANSITION: ['whoosh', 'transition', 'sweep'],
    ANIMAL: ['animal', 'creature'],
    VEHICLE: ['vehicle', 'car', 'traffic'],
    MISC_FOLEY: ['foley', 'sound-effect', 'fx'],
  };
  const extra = roleTerms[role] ?? [];
  const tokens: string[] = [];
  for (const t of query.split(/\s+/)) if (t) tokens.push(t);
  for (const r of extra) if (!tokens.includes(r)) tokens.push(r);
  // keep the query focused: max 6 terms so Freesound relevance stays sharp
  return tokens.slice(0, 6).join(' ');
}

function allForRole(role: RetrievalIntent['role']): string {
  const map: Partial<Record<RetrievalIntent['role'], string>> = {
    ROOM_TONE: 'room tone ambience interior',
    AMBIENCE: 'ambience atmosphere',
    FOOTSTEP: 'footsteps',
    CLOTHING: 'clothing fabric movement',
    DOOR: 'door hinge',
    WOOD: 'wood creak',
    METAL: 'metal',
    GLASS: 'glass',
    BODY: 'body foley',
    BREATH: 'breathing',
    MECHANICAL: 'mechanical machine',
    ELECTRICAL: 'electrical hum',
    WIND: 'wind',
    WEATHER: 'rain weather',
    WATER: 'water',
    CREAK: 'creak',
    SCRAPE: 'scrape',
    IMPACT: 'impact',
    KNOCK: 'knock',
    RATTLE: 'rattle',
    RUMBLE: 'rumble',
    DRONE: 'drone hum',
    TEXTURE: 'texture foley',
    TRANSITION: 'whoosh transition',
    ANIMAL: 'animal creature',
    VEHICLE: 'vehicle traffic',
    MISC_FOLEY: 'foley sound effect',
  };
  return map[role] ?? 'sound effect';
}

function assetIntentForSimilar(asset: LibraryAsset): RetrievalIntent {
  return {
    id: `sim-${asset.soundId}`,
    sceneId: '',
    role: 'MISC_FOLEY',
    query: `similar to "${asset.title}"`,
    altQueries: [],
    time: null,
    offset: 0,
    durationFit: asset.duration > 5 ? 'long' : asset.duration > 1.5 ? 'medium' : 'short',
    priority: 0.5,
    allowSilence: false,
    reason: `User requested alternatives to ${asset.creditLine}`,
  };
}

function buildResult(
  intent: RetrievalIntent,
  assets: LibraryAsset[],
  count: number,
  page: number,
  clap: RetrievalSearchResult['clap'],
  started: number,
  error: string | null = null,
): RetrievalSearchResult {
  return {
    intent,
    count,
    page,
    // raw provider candidates — the retrieval service applies license
    // gating + full ranking afterwards; provider relevance is preserved
    candidates: assets.map((asset) => ({
      asset,
      match: Math.min(1, (asset.score ?? 0) / 100),
      signals: [{ label: 'provider relevance', value: (asset.score ?? 0).toFixed(2), weight: 0.12 }],
      licenseOk: true,
      licenseReason: null,
    })),
    clap,
    elapsedMs: Math.round(performance.now() - started),
    error,
  };
}
