/* ==================================================================== *
 *  UMBRA · FREESOUND PROVIDER
 *
 *  Official APIv2 only. No scraping, no mirroring. Verified against the
 *  current documentation (2026-09):
 *
 *    search        GET /apiv2/search/            (token query/header)
 *                  replaces the deprecated /apiv2/search/text/,
 *                  which still redirects — we call the current one.
 *    sound         GET /apiv2/sounds/<id>/       (fields param)
 *    analysis      GET /apiv2/sounds/<id>/analysis/
 *    similar       GET /apiv2/sounds/<id>/similar/?similarity_space=laion_clap
 *    download      GET /apiv2/sounds/<id>/download/   OAuth2 Bearer only
 *    previews      returned in `previews` object — no OAuth2 needed
 *
 *  Licensing: the API returns `license` as one of
 *    "Creative Commons 0" | "Attribution" | "Attribution NonCommercial"
 *  We map those strings to classes; we never guess a license from a file
 *  name or from the tags.
 * ==================================================================== */

import type {
  FreesoundCredentials,
  LibraryAsset,
  LicenseClass,
  ProviderCapabilities,
  ProviderStatus,
  RetrievalIntent,
  RetrievalSearchResult,
} from './types';
import type { PreviewFetch, SearchOptions, SoundLibraryProvider } from './provider';

const API = 'https://freesound.org/apiv2';
/** Current search endpoint (post Nov-2025 deprecation of /search/text/). */
const SEARCH_PATH = '/search/';

/** Fields we request — keeps payloads small, includes everything UMBRA needs. */
const SEARCH_FIELDS = [
  'id',
  'url',
  'name',
  'tags',
  'description',
  'username',
  'license',
  'type',
  'channels',
  'filesize',
  'duration',
  'samplerate',
  'created',
  'num_downloads',
  'avg_rating',
  'previews',
  'images',
  'score',
  'gen_ai_preference',
  'md5',
  'category',
  'subcategory',
].join(',');

interface FsSearchResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: FsSound[];
}

export interface FsSound {
  id: number;
  url: string;
  name: string;
  tags: string[];
  description: string;
  username: string;
  license: string;
  type: string;
  channels: number;
  filesize: number;
  duration: number;
  samplerate: number;
  created: string;
  num_downloads?: number;
  avg_rating?: number;
  previews?: Record<string, string>;
  images?: Record<string, string>;
  score?: number;
  gen_ai_preference?: string;
  md5?: string;
  category?: string;
  subcategory?: string;
  similar_sounds?: string;
}

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
        waveform: (s.images.waveform_l ?? s.images.waveform_m ?? '').replace(/^(\/|(https?:\/\/[^/]+))/g, (m) => (m.startsWith('h') ? m : 'https://freesound.org' + m)),
        spectrum: (s.images.spectral_l ?? s.images.spectral_m ?? '').replace(/^(\/|(https?:\/\/[^/]+))/g, (m) => (m.startsWith('h') ? m : 'https://freesound.org' + m)),
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

export class FreesoundProvider implements SoundLibraryProvider {
  readonly id = 'freesound' as const;
  readonly label = 'Freesound';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    metadataSearch: true,
    preview: true,
    download: 'oauth',
    licenseMetadata: true,
    attribution: true,
    similarity: true,
    audioFeatures: true,
    assistedSearch: false,
    manualImport: false,
    offline: false,
  };

  constructor(private creds: () => FreesoundCredentials) {}

  status(): ProviderStatus {
    const c = this.creds();
    const tokenOk = c.apiToken.trim().length > 0;
    const oauthOk = c.accessToken.trim().length > 0 && c.expiresAt > Date.now();
    let reason: string | null = null;
    if (!tokenOk) reason = 'No API token configured — enter it in Settings → Sound Libraries → Freesound (token auth covers search + preview).';
    else if (!oauthOk) reason = 'Preview workflow ready. OAuth2 (original quality) not configured yet.';
    return {
      provider: this.id,
      label: this.label,
      online: true,
      ready: tokenOk,
      reason,
      capabilities: this.capabilities,
    };
  }

  sourcePageUrl(asset: LibraryAsset): string {
    return asset.sourceUrl || `https://freesound.org/sounds/${asset.soundId}/`;
  }

  /* ------------------------------------------------------------ HTTP -- */

  private async call<T>(path: string, params: Record<string, string | undefined> = {}, init?: RequestInit): Promise<T> {
    const c = this.creds();
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, v);
    }
    // token via query param (docs) — avoids Authorization header entirely
    if (c.apiToken) url.searchParams.set('token', c.apiToken);
    const res = await fetch(url.toString(), init);
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { detail?: string; error?: string };
        detail = j.detail ?? j.error ?? '';
      } catch {
        /* body not JSON */
      }
      const err = new Error(
        res.status === 401 || res.status === 403
          ? `Freesound authentication failed (${res.status})${detail ? `: ${detail}` : ''}.`
          : res.status === 429
            ? `Freesound rate limit reached (${res.status}). Wait a moment and try again.`
            : `Freesound API error ${res.status}${detail ? `: ${detail}` : ''}.`,
      );
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }

  /* --------------------------------------------------------- search -- */

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
      const data = await this.call<FsSearchResponse>(SEARCH_PATH, {
        query: q,
        fields: SEARCH_FIELDS,
        page: String(page),
        page_size: '30',
        filter: filters.length ? filters.join(' ') : undefined,
        sort: 'score',
      });
      const assets = (data.results ?? []).map((s) =>
        freesoundToAsset(s, 'preview', `fs-${s.id}-preview`),
      );
      const result = buildResult(intent, assets, data.count ?? 0, page, 'metadata', started);
      return result;
    } catch (e) {
      return buildResult(intent, [], 0, page, 'metadata', started, (e as Error).message);
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
      const data = await this.call<FsSearchResponse>(SEARCH_PATH, {
        query: expandQuery(intent.query, intent.role),
        fields: SEARCH_FIELDS,
        page: String(page),
        page_size: '30',
        filter: filters.length ? filters.join(' ') : undefined,
        sort: 'score',
      });
      const assets = (data.results ?? []).map((s) => freesoundToAsset(s, 'preview', `fs-${s.id}-preview`));
      return buildResult(intent, assets, data.count ?? 0, page, 'metadata', started);
    } catch (e) {
      return buildResult(intent, [], 0, page, 'metadata', started, (e as Error).message);
    }
  }

  /* -------------------------------------------------- similar / AI --- */

  async similar(asset: LibraryAsset, page = 1): Promise<RetrievalSearchResult> {
    const started = performance.now();
    try {
      const data = await this.call<FsSearchResponse>(`/sounds/${asset.soundId}/similar/`, {
        fields: SEARCH_FIELDS,
        page: String(page),
        page_size: '20',
        similarity_space: 'laion_clap',
      });
      const assets = (data.results ?? []).map((s) => freesoundToAsset(s, 'preview', `fs-${s.id}-preview`));
      // similar() has no text intent; synthesize one so the UI still shows a
      // query source, and use the real provider similarity scores
      const intent: RetrievalIntent = {
        ...assetIntentForSimilar(asset),
        query: `similar to "${asset.title}"`,
      };
      return buildResult(intent, assets, data.count ?? 0, page, 'freesound-laion-clap', started);
    } catch (e) {
      const intent = assetIntentForSimilar(asset);
      return buildResult(intent, [], 0, page, 'freesound-laion-clap', started, (e as Error).message);
    }
  }

  async audioFeatures(asset: LibraryAsset): Promise<Record<string, number | string | number[]>> {
    if (!asset.soundId) return {};
    try {
      const data = await this.call<Record<string, number | string | number[]>>(`/sounds/${asset.soundId}/analysis/`, {
        fields: 'mfcc,bpm,spectral_centroid,zero_crossing_rate,log_attack_time,temporal_centroid,dynamic_range,warmth,sharpness,roughness',
      });
      return data;
    } catch {
      return {};
    }
  }

  /* -------------------------------------------------------- audio ---- */

  async fetchPreview(asset: LibraryAsset): Promise<PreviewFetch> {
    const prep = asset.previewUrls ?? {};
    const url =
      prep['preview-hq-mp3'] ??
      prep['preview-hq-ogg'] ??
      prep['preview-lq-mp3'] ??
      prep['preview-lq-ogg'];
    if (!url) {
      // fetch sound instance once to get previews
      const s = await this.call<FsSound>(`/sounds/${asset.soundId}/`, { fields: 'previews,name,license' });
      const pr = s.previews ?? {};
      const u = pr['preview-hq-mp3'] ?? pr['preview-hq-ogg'] ?? pr['preview-lq-mp3'] ?? pr['preview-lq-ogg'];
      if (!u) throw new Error('Freesound returned no preview URL for this sound.');
      return this.fetchBlob(u);
    }
    return this.fetchBlob(url);
  }

  async fetchOriginal(asset: LibraryAsset): Promise<PreviewFetch> {
    const c = this.creds();
    if (!c.accessToken || c.expiresAt < Date.now()) {
      throw new Error('Original-quality download requires Freesound OAuth2 (Bearer token). Configure it or use the preview workflow.');
    }
    const res = await fetch(`${API}/sounds/${asset.soundId}/download/`, {
      headers: { Authorization: `Bearer ${c.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Freesound original download failed (${res.status}). Preview workflow is unaffected.`);
    }
    const blob = await res.blob();
    return { blob, mime: blob.type || 'audio/wav', bytes: blob.size };
  }

  private async fetchBlob(url: string): Promise<PreviewFetch> {
    // plain GET — no custom headers, so no CORS preflight (previews return
    // Access-Control-Allow-Origin: * on GET per Freesound's data servers)
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`Freesound preview download failed (${res.status}).`);
    const blob = await res.blob();
    return { blob, mime: blob.type || 'audio/mpeg', bytes: blob.size };
  }

  /* -------------------------------------------------------- OAuth ---- */

  authorizeUrl(state: string): string {
    const c = this.creds();
    const u = new URL(`${API}/oauth2/authorize/`);
    u.searchParams.set('client_id', c.clientId || '');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const c = this.creds();
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'authorization_code',
      code,
    });
    const res = await fetch(`${API}/oauth2/access_token/`, { method: 'POST', body });
    if (!res.ok) throw new Error(`Freesound OAuth2 token exchange failed (${res.status}). Check client id / secret.`);
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
  }

  async refreshAccessToken(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const c = this.creds();
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken,
    });
    const res = await fetch(`${API}/oauth2/access_token/`, { method: 'POST', body });
    if (!res.ok) throw new Error(`Freesound OAuth2 refresh failed (${res.status}). Re-authorize.`);
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
  }
}

/* ------------------------------------------------------- helpers ---- */

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
