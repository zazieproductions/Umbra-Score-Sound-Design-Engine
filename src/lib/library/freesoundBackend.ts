/* ==================================================================== *
 *  UMBRA · FREESOUND INTEGRATION CLIENT  (browser → Umbra backend)
 *
 *  The browser NEVER holds Freesound secrets. It only ever learns whether
 *  the integration is configured and usable. Every secret-bearing action —
 *  storing the API key, exchanging the OAuth2 code, refreshing tokens,
 *  downloading originals — happens inside the local Python backend, which
 *  keeps credentials encrypted at rest with a server-only key.
 *
 *  Wire contract (backend/app.py):
 *    GET    /api/integrations/freesound/status
 *    POST   /api/integrations/freesound/configure       (one-time secret POST)
 *    DELETE /api/integrations/freesound/configure
 *    POST   /api/integrations/freesound/verify
 *    POST   /api/integrations/freesound/oauth/start
 *    POST   /api/integrations/freesound/oauth/exchange
 *    POST   /api/integrations/freesound/oauth/refresh
 *
 *  None of these responses ever contain apiKey, clientSecret, accessToken,
 *  refreshToken, or the encryption key. That is pinned by tests.
 * ==================================================================== */

import { request } from '../providers';

/** Everything the browser is allowed to know about the integration. */
export interface FreesoundIntegrationStatus {
  provider: 'freesound';
  /** any credential (API key / OAuth app / tokens) is stored server-side */
  configured: boolean;
  /** API key present → search + preview workflow possible */
  searchAvailable: boolean;
  /** access token present and not expired → original-quality downloads */
  oauthAvailable: boolean;
  /** client id + secret present → Reconnect (OAuth) is possible */
  oauthConfigured: boolean;
  /** access token exists but has expired (Refresh / Reconnect offered) */
  tokenExpired: boolean;
  /** a refresh token + app credentials exist → token can be refreshed */
  refreshable: boolean;
  /** epoch ms, null when unknown */
  expiresAt: number | null;
  /** epoch ms of the last real, successful connection test */
  lastVerifiedAt: number | null;
  /** outcome of the last connection test */
  verification: 'verified' | 'failed' | null;
  /** Freesound username when OAuth verified */
  user: string | null;
  redirectUri: string | null;
  /** actionable, secret-free failure text */
  error: string | null;
  storage: 'encrypted-db' | 'env' | 'none';
  encryptionKeyConfigured: boolean;
}

export const EMPTY_FREESOUND_STATUS: FreesoundIntegrationStatus = {
  provider: 'freesound',
  configured: false,
  searchAvailable: false,
  oauthAvailable: false,
  oauthConfigured: false,
  tokenExpired: false,
  refreshable: false,
  expiresAt: null,
  lastVerifiedAt: null,
  verification: null,
  user: null,
  redirectUri: null,
  error: null,
  storage: 'none',
  encryptionKeyConfigured: false,
};

/** Keys a status payload may legally contain — pinned by security tests. */
export const FREESOUND_STATUS_SAFE_KEYS = [
  'provider',
  'configured',
  'searchAvailable',
  'oauthAvailable',
  'oauthConfigured',
  'tokenExpired',
  'refreshable',
  'expiresAt',
  'lastVerifiedAt',
  'verification',
  'user',
  'redirectUri',
  'error',
  'storage',
  'encryptionKeyConfigured',
] as const;

/** What the retrieval pipeline's FreesoundProvider needs at runtime. */
export interface FreesoundRuntime {
  status: FreesoundIntegrationStatus;
  backendOnline: boolean;
}

export const OFFLINE_FREESOUND_RUNTIME: FreesoundRuntime = {
  status: EMPTY_FREESOUND_STATUS,
  backendOnline: false,
};

/* ------------------------------------------------------------- calls --- */

export async function fetchFreesoundStatus(): Promise<FreesoundIntegrationStatus> {
  return request<FreesoundIntegrationStatus>('/api/integrations/freesound/status');
}

export interface FreesoundConfigurePayload {
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/**
 * Submit credentials to the backend. The values exist in browser memory only
 * between typing and this one POST — callers must clear their inputs the
 * moment this resolves (or rejects), and never write them to any store.
 */
export async function configureFreesound(
  payload: FreesoundConfigurePayload,
): Promise<{ saved: boolean; status: FreesoundIntegrationStatus }> {
  return request('/api/integrations/freesound/configure', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function disconnectFreesound(): Promise<{
  deleted: boolean;
  status: FreesoundIntegrationStatus;
}> {
  return request('/api/integrations/freesound/configure', { method: 'DELETE' });
}

export interface FreesoundVerification {
  verified: boolean;
  searchVerified: boolean;
  oauthVerified: boolean;
  user: string | null;
  error: string | null;
  checks: string[];
  checkedAt: number;
}

/** Test Connection — a real authenticated request to freesound.org. */
export async function verifyFreesound(): Promise<{
  verification: FreesoundVerification;
  status: FreesoundIntegrationStatus;
}> {
  return request('/api/integrations/freesound/verify', { method: 'POST' });
}

export async function startFreesoundOAuth(redirectUri?: string): Promise<{
  authorizeUrl: string;
  expiresInSeconds: number;
}> {
  return request('/api/integrations/freesound/oauth/start', {
    method: 'POST',
    body: JSON.stringify(redirectUri ? { redirectUri } : {}),
  });
}

/** Completes the OAuth2 loop after freesound.org redirects back with code+state. */
export async function exchangeFreesoundOAuth(
  code: string,
  state: string,
): Promise<{ status: FreesoundIntegrationStatus }> {
  return request('/api/integrations/freesound/oauth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code, state }),
  });
}

export async function refreshFreesoundOAuth(): Promise<{
  status: FreesoundIntegrationStatus;
}> {
  return request('/api/integrations/freesound/oauth/refresh', { method: 'POST' });
}

/* ------------------------------------------------------------- ladder -- */

export type FreesoundLadderLabel =
  | 'BACKEND OFFLINE'
  | 'NOT CONFIGURED'
  | 'CONFIGURED'
  | 'SEARCH READY'
  | 'OAUTH READY'
  | 'TOKEN EXPIRED'
  | 'ERROR';

/**
 * The honest runtime status ladder for the integration. Verified is earned
 * by a real Freesound response — never by a key merely existing.
 */
export function freesoundLadder(
  runtime: FreesoundRuntime,
): { label: FreesoundLadderLabel; detail: string } {
  const s = runtime.status;
  if (!runtime.backendOnline) {
    return {
      label: 'BACKEND OFFLINE',
      detail:
        'Freesound credentials are managed by the Umbra backend. Start it (scripts/run_backend.py) and reload to configure or use the integration.',
    };
  }
  if (s.verification === 'failed' && s.error) {
    return { label: 'ERROR', detail: s.error };
  }
  if (!s.configured) {
    return {
      label: 'NOT CONFIGURED',
      detail: s.error
        ? s.error
        : 'No Freesound credentials are stored on the backend. Configure the integration to enable search.',
    };
  }
  if (s.tokenExpired) {
    return {
      label: 'TOKEN EXPIRED',
      detail: s.refreshable
        ? 'The OAuth2 access token expired. Refresh it or reconnect to restore original-quality downloads.'
        : 'The OAuth2 access token expired. Reconnect to restore original-quality downloads.',
    };
  }
  if (s.verification === 'verified') {
    if (s.oauthAvailable) {
      return {
        label: 'OAUTH READY',
        detail: `Verified against freesound.org${s.user ? ` as ${s.user}` : ''}. Search and original-quality downloads are live.`,
      };
    }
    if (s.searchAvailable) {
      return {
        label: 'SEARCH READY',
        detail: 'Verified against freesound.org. Search and preview workflow is live.',
      };
    }
  }
  return {
    label: 'CONFIGURED',
    detail: 'Credentials are stored on the backend but not verified yet — run Test Connection.',
  };
}
