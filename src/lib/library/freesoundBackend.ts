/* ==================================================================== *
 *  UMBRA · FREESOUND → BACKEND CLIENT
 *
 *  The browser NEVER talks to freesound.org and NEVER holds an API key.
 *  Every authenticated request goes to the local FastAPI backend, which
 *  owns the credential (FREESOUND_API_KEY in a git-ignored .env):
 *
 *      browser ──► /api/integrations/freesound/* ──► Umbra backend
 *                                                      │
 *                                        Authorization: Token <key>
 *                                                      ▼
 *                                              freesound.org/apiv2
 *
 *  This module is transport only. Mapping (license class, credit line,
 *  provenance), ranking, the license gate and clip construction stay in
 *  the retrieval subsystem — the pipeline is unchanged, only the wire is.
 * ==================================================================== */

/** Vite proxies `/api` to the Python backend; the browser stays same-origin. */
export const FREESOUND_API = '/api/integrations/freesound';

/* ------------------------------------------------------- wire types ---- */

/** A sound object exactly as the Freesound APIv2 returns it (passthrough). */
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

/** `GET /api/integrations/freesound/status` — configuration, never the key. */
export interface FreesoundStatus {
  provider: 'freesound';
  /** A key is present in the backend environment. */
  configured: boolean;
  /** true = key accepted · false = key rejected · null = unknown/not probed. */
  connected: boolean | null;
  /** Where the backend read the key from — never the key itself. */
  keySource: string | null;
  oauth: { configured: boolean; quality: 'preview' | 'original' };
  apiBase: string;
  probed: boolean;
  reason: string | null;
  hint: string | null;
  checkedAt: number | null;
  elapsedMs: number | null;
  capabilities: {
    search: boolean;
    metadata: boolean;
    preview: boolean;
    similar: boolean;
    audioFeatures: boolean;
    originalDownload: boolean;
  };
}

export interface FreesoundSearchRequest {
  query: string;
  page?: number;
  pageSize?: number;
  filters?: string[];
  sort?: string;
  fields?: string;
}

export interface FreesoundSearchResponse {
  provider: 'freesound';
  query: string;
  count: number;
  page: number;
  pageSize: number;
  next: string | null;
  previous: string | null;
  sounds: FsSound[];
}

/* ----------------------------------------------------------- errors ---- */

/** Stable error codes the backend returns (backend/integrations/freesound.py). */
export type FreesoundErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'timeout'
  | 'upstream_unreachable'
  | 'upstream_error'
  | 'oauth_required'
  | 'bad_request';

export class FreesoundBackendError extends Error {
  readonly code: FreesoundErrorCode | 'backend_offline' | 'unknown';
  readonly hint: string | null;
  readonly status: number;

  constructor(message: string, code: FreesoundBackendError['code'], status: number, hint: string | null = null) {
    super(message);
    this.name = 'FreesoundBackendError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }

  /** Message plus hint — what the UI should surface, verbatim. */
  detail(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }
}

const BACKEND_OFFLINE_HINT =
  'Start the backend (`python scripts/run_backend.py`) — Freesound runs through it, ' +
  'never from the browser. See docs/development/FREESOUND.md.';

/* ------------------------------------------------------------ http ----- */

async function readError(res: Response): Promise<FreesoundBackendError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: FreesoundBackendError['code'] = 'unknown';
  let hint: string | null = null;
  try {
    const body = (await res.json()) as { error?: string; detail?: string; code?: string; hint?: string };
    message = body.error ?? body.detail ?? message;
    if (body.code) code = body.code as FreesoundBackendError['code'];
    hint = body.hint ?? null;
  } catch {
    /* non-JSON error body — keep the status line */
  }
  return new FreesoundBackendError(message, code, res.status, hint);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${FREESOUND_API}${path}`, init);
  } catch {
    // Backend down, offline, or blocked: say so instead of faking results.
    throw new FreesoundBackendError(
      'The UMBRA backend is not running, so Freesound is unreachable.',
      'backend_offline',
      0,
      BACKEND_OFFLINE_HINT,
    );
  }
  if (!res.ok) throw await readError(res);
  return res;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path, { headers: { Accept: 'application/json' } });
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/* ---------------------------------------------------------- surface ---- */

/**
 * Connection status. `probe` controls whether the backend calls Freesound:
 * `'auto'` uses a 60 s server-side cache, `'always'` forces a live check,
 * `'never'` reports configuration only.
 */
export async function fetchFreesoundStatus(probe: 'never' | 'auto' | 'always' = 'auto'): Promise<FreesoundStatus> {
  return getJson<FreesoundStatus>(`/status?probe=${encodeURIComponent(probe)}`);
}

/** Authenticated search. Returns raw Freesound sounds — no mapping, no ranking. */
export async function freesoundSearch(req: FreesoundSearchRequest): Promise<FreesoundSearchResponse> {
  return postJson<FreesoundSearchResponse>('/search', {
    query: req.query,
    page: req.page ?? 1,
    pageSize: req.pageSize ?? 30,
    filters: req.filters ?? [],
    sort: req.sort ?? 'score',
    ...(req.fields ? { fields: req.fields } : {}),
  });
}

/** Metadata for one sound (creator, license, source url, previews). */
export async function freesoundSound(soundId: string | number): Promise<FsSound> {
  const res = await getJson<{ sound: FsSound }>(`/sounds/${encodeURIComponent(String(soundId))}`);
  return res.sound;
}

/** Similar sounds through Freesound's laion_clap similarity space. */
export async function freesoundSimilar(
  soundId: string | number,
  page = 1,
  pageSize = 20,
): Promise<{ count: number; page: number; pageSize: number; sounds: FsSound[] }> {
  return getJson(`/sounds/${encodeURIComponent(String(soundId))}/similar?page=${page}&page_size=${pageSize}`);
}

/** Audio feature descriptors Freesound extracted from the file. */
export async function freesoundAnalysis(
  soundId: string | number,
  descriptors?: string,
): Promise<Record<string, number | string | number[]>> {
  const q = descriptors ? `?descriptors=${encodeURIComponent(descriptors)}` : '';
  const res = await getJson<{ features: Record<string, number | string | number[]> }>(
    `/sounds/${encodeURIComponent(String(soundId))}/analysis${q}`,
  );
  return res.features ?? {};
}

/** Preview audio proxied by the backend (the key never reaches the browser). */
export function freesoundPreviewUrl(soundId: string | number, quality = 'preview-hq-mp3'): string {
  return `${FREESOUND_API}/sounds/${encodeURIComponent(String(soundId))}/preview?quality=${encodeURIComponent(quality)}`;
}

/** Original-quality download (backend needs FREESOUND_OAUTH_TOKEN). */
export function freesoundDownloadUrl(soundId: string | number): string {
  return `${FREESOUND_API}/sounds/${encodeURIComponent(String(soundId))}/download`;
}
