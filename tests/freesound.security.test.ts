/* ==================================================================== *
 *  UMBRA · FREESOUND INTEGRATION — FRONTEND SECURITY TESTS
 *
 *  Pins the browser-side half of the backend-managed credential contract:
 *
 *    S1  the one-time configure POST is the only request that ever
 *        carries the secret — and it is never persisted anywhere
 *    S2  status responses contain no secret fields or secret substrings
 *    S3  browser persistence (localStorage / sessionStorage / IndexedDB)
 *        contains no credentials after a full configure→search→cache cycle
 *    S4  the legacy localStorage credential key is purged on mount
 *    S5  search / original-download requests carry no credential in the
 *        URL, query string, or headers — the backend authenticates
 *    S6  the OAuth exchange sends only { code, state } — the client
 *        secret never transits the browser
 *
 *  The backend half (encrypted storage, redaction, OAuth state single-use,
 *  refresh, disconnect) is pinned by backend/tests/test_freesound_integration.py
 *  with a mocked Freesound. Live verification against the real API is a
 *  separate, documented manual gate (docs/development/FREESOUND_LIVE_ACCEPTANCE.md).
 * ==================================================================== */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchMock } from './setup';
import 'fake-indexeddb/auto';

import {
  EMPTY_FREESOUND_STATUS,
  FREESOUND_STATUS_SAFE_KEYS,
  configureFreesound,
  disconnectFreesound,
  exchangeFreesoundOAuth,
  fetchFreesoundStatus,
  refreshFreesoundOAuth,
  startFreesoundOAuth,
  verifyFreesound,
  type FreesoundIntegrationStatus,
} from '../src/lib/library/freesoundBackend';
import { purgeLegacyFreesoundSecrets } from '../src/lib/library/cache';
import { RetrievalService } from '../src/lib/library/service';
import { planEvent } from '../src/lib/library/planner';
import { freesoundToAsset, type FsSound } from '../src/lib/library/freesound';
import type { SceneSoundContext, SpottingEvent } from '../src/lib/library/types';

/* ------------------------------------------------------------ canaries -- */

const SECRET_KEY = 'fs-live-key-CANARY-9d1f2ab3';
const SECRET_CLIENT_SECRET = 'fs-client-secret-CANARY-77ce';
const SECRET_ACCESS = 'fs-access-token-CANARY-31bb';
const SECRET_REFRESH = 'fs-refresh-token-CANARY-52aa';
const ALL_SECRETS = [SECRET_KEY, SECRET_CLIENT_SECRET, SECRET_ACCESS, SECRET_REFRESH];

const LEGACY_KEY = 'umbra.library.freesound.creds.v1';

function scene(over: Partial<SceneSoundContext> = {}): SceneSoundContext {
  return { sceneId: 'sc', start: 0, end: 60, title: 'T', tags: [], summary: '', tension: 0.4, motion: 0.3, hits: [], spotting: [], ...over };
}
function spotted(over: Partial<SpottingEvent> = {}): SpottingEvent {
  return { id: 'ev', sceneId: 'sc', label: 'door', role: 'DOOR', time: 3, createdAt: 0, ...over };
}
function fsSound(id: number): FsSound {
  return {
    id,
    url: `https://freesound.org/sounds/${id}/`,
    name: `sound_${id}`,
    tags: ['door'],
    description: '',
    username: 'sec-fixture',
    license: 'Creative Commons 0',
    type: 'wav',
    channels: 1,
    filesize: 1000,
    duration: 1.5,
    samplerate: 44100,
    created: '2021-01-01T00:00:00Z',
    previews: { 'preview-hq-mp3': `https://freesound.org/data/previews/${id}_hq.mp3` },
    score: 80,
  };
}

function okStatus(over: Partial<FreesoundIntegrationStatus> = {}): FreesoundIntegrationStatus {
  return {
    ...EMPTY_FREESOUND_STATUS,
    configured: true,
    searchAvailable: true,
    verification: 'verified',
    storage: 'encrypted-db',
    encryptionKeyConfigured: true,
    ...over,
  };
}

type Captured = { method: string; url: string; body: unknown; headers: Headers };

/** Mock the backend; capture every request for leak auditing. */
function mockBackend(handlers: (req: Captured) => Response | undefined) {
  const captured: Captured[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://umbra.test');
    const req: Captured = {
      method: init?.method ?? 'GET',
      url: `${url.origin}${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    captured.push(req);
    const routed = handlers(req);
    if (routed) return routed;
    return new Response(JSON.stringify({ error: `unmapped ${req.method} ${url.pathname}` }), { status: 404 });
  });
  setFetchMock(fn as never);
  return { fn, captured };
}

/** No secret canary may appear in the URL of any captured request. */
function expectNoSecretsInRequests(captured: Captured[], allowInBodiesOf: string[] = []) {
  for (const req of captured) {
    for (const secret of ALL_SECRETS) {
      if (req.url.includes(secret)) throw new Error(`secret leaked into URL: ${req.url}`);
      if (req.headers.get('Authorization')?.includes(secret)) throw new Error('secret leaked into Authorization header');
      const bodyStr = req.body ? JSON.stringify(req.body) : '';
      if (bodyStr.includes(secret) && !allowInBodiesOf.some((p) => req.url.includes(p))) {
        throw new Error(`secret leaked into request body of ${req.url}`);
      }
    }
  }
}

/** Full scan of browser persistence for secret canaries. */
async function expectNoSecretsInPersistence() {
  for (const store of [globalThis.localStorage, globalThis.sessionStorage].filter(Boolean) as Storage[]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      const value = store.getItem(key) ?? '';
      for (const secret of ALL_SECRETS) {
        if (value.includes(secret) || key.includes(secret)) {
          throw new Error(`secret found in browser storage '${key}'`);
        }
      }
    }
  }
  // IndexedDB — walk every store of the sound-library database. The database
  // is only opened when it already exists (never created here — creating it
  // outside the app's schema would break the app's own connections).
  const databases = await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.();
  if (databases && !databases.some((d) => d.name === 'umbra-sound-library')) return;
  const found = await new Promise<string[]>((resolve) => {
    const req = indexedDB.open('umbra-sound-library');
    const rows: string[] = [];
    const done = () => resolve(rows);
    req.onsuccess = () => {
      const db = req.result;
      const stores = Array.from(db.objectStoreNames);
      let pending = stores.length;
      const finish = () => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        done();
      };
      if (pending === 0) return finish();
      for (const name of stores) {
        try {
          const tx = db.transaction(name, 'readonly');
          const all = tx.objectStore(name).getAll();
          all.onsuccess = () => {
            rows.push(JSON.stringify(all.result ?? [], (_k, v) => (v instanceof Blob ? `[blob ${v.size}b]` : v)));
            if (--pending === 0) finish();
          };
          all.onerror = () => {
            if (--pending === 0) finish();
          };
        } catch {
          if (--pending === 0) finish();
        }
      }
    };
    req.onerror = () => done();
    req.onblocked = () => done();
    req.onupgradeneeded = () => {
      // opening without a version should never upgrade; if it somehow would,
      // abort the scan rather than mutate the app's schema
      try {
        (req.transaction as IDBTransaction | undefined)?.abort();
      } catch {
        /* nothing to abort */
      }
      done();
    };
  });
  for (const row of found) {
    for (const secret of ALL_SECRETS) {
      if (row.includes(secret)) throw new Error('secret found in IndexedDB');
    }
  }
}

/* --------------------------------------------------------------- setup -- */

beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage?.clear();
});

/* ==================================================================== */

describe('S4 · legacy browser-stored secrets are purged', () => {
  it('removes the old localStorage credential key and its secret', () => {
    globalThis.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ apiToken: SECRET_KEY, clientSecret: SECRET_CLIENT_SECRET }),
    );
    purgeLegacyFreesoundSecrets();
    expect(globalThis.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(globalThis.localStorage.length).toBe(0);
  });
});

describe('S1 · configure is a one-time POST and the secret is never persisted', () => {
  it('sends the secret exactly once, in the configure POST body, then never again', async () => {
    const { captured } = mockBackend((req) => {
      if (req.url.includes('/api/integrations/freesound/configure')) {
        if (req.method === 'POST') {
          return new Response(JSON.stringify({ saved: true, status: okStatus() }), { status: 200 });
        }
        return new Response(JSON.stringify({ deleted: true, status: EMPTY_FREESOUND_STATUS }), { status: 200 });
      }
      if (req.url.includes('/api/integrations/freesound/status')) {
        return new Response(JSON.stringify(okStatus()), { status: 200 });
      }
      if (req.url.includes('/api/integrations/freesound/verify')) {
        return new Response(
          JSON.stringify({ verification: { verified: true, searchVerified: true, oauthVerified: false, user: null, error: null, checks: [], checkedAt: 0 }, status: okStatus() }),
          { status: 200 },
        );
      }
      if (req.url.includes('/oauth/refresh') || req.url.includes('/oauth/exchange')) {
        return new Response(JSON.stringify({ status: okStatus() }), { status: 200 });
      }
      return undefined;
    });

    await configureFreesound({ apiKey: SECRET_KEY, clientId: 'cid', clientSecret: SECRET_CLIENT_SECRET });
    await fetchFreesoundStatus();
    await verifyFreesound();
    await refreshFreesoundOAuth();
    await disconnectFreesound();

    // exactly one request ever carried the secret
    const withSecret = captured.filter(
      (r) => JSON.stringify(r.body ?? '').includes(SECRET_KEY) || JSON.stringify(r.body ?? '').includes(SECRET_CLIENT_SECRET),
    );
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0].method).toBe('POST');
    expect(withSecret[0].url).toContain('/api/integrations/freesound/configure');

    // every other request is credential-free (URLs, headers, bodies)
    expectNoSecretsInRequests(captured, ['/api/integrations/freesound/configure']);
    // and nothing landed in browser persistence
    await expectNoSecretsInPersistence();
  });
});

describe('S2 · status payloads contain no secret fields', () => {
  it('accepts only the documented safe keys — a secret-bearing response fails the contract', async () => {
    // The contract: every key a status may carry is in the safe list, and no
    // secret-bearing key ever is. A hostile/buggy backend echoing secrets
    // would put `apiKey`/`accessToken` here — the safe list must reject them.
    const safe = okStatus();
    for (const key of Object.keys(safe)) {
      expect(FREESOUND_STATUS_SAFE_KEYS).toContain(key);
    }
    for (const secretKey of ['apiKey', 'clientSecret', 'accessToken', 'refreshToken', 'encryptionKey']) {
      expect(FREESOUND_STATUS_SAFE_KEYS).not.toContain(secretKey);
    }
    // the wire format we actually consume
    const { captured } = mockBackend(() => new Response(JSON.stringify(safe), { status: 200 }));
    const status = await fetchFreesoundStatus();
    expect(status.configured).toBe(true);
    expect(Object.keys(status).sort()).toEqual([...FREESOUND_STATUS_SAFE_KEYS].sort());
    expect(JSON.stringify(status)).not.toContain('CANARY');
    expectNoSecretsInRequests(captured);
  });
});

describe('S3+S5 · the retrieval pipeline authenticates through the backend only', () => {
  it('search requests hit /api/library/freesound with zero credentials, and nothing is persisted', async () => {
    const { captured } = mockBackend((req) => {
      if (req.url.includes('/api/library/freesound/search')) {
        return new Response(
          JSON.stringify({ count: 1, next: null, previous: null, results: [fsSound(4242)] }),
          { status: 200 },
        );
      }
      return undefined;
    });

    const svc = new RetrievalService(() => ({ status: okStatus(), backendOnline: true }), { autoMode: 'suggest' });
    const res = await svc.search(planEvent(scene(), spotted()));
    expect(res.error).toBeNull();
    expect(res.candidates.length).toBeGreaterThan(0);

    const search = captured.find((r) => r.url.includes('/api/library/freesound/search'))!;
    expect(search.method).toBe('GET');
    expect(search.url).not.toContain('token=');
    expect(search.headers.has('Authorization')).toBe(false);
    // canary: the backend-held key must not appear anywhere in the request
    expectNoSecretsInRequests(captured);

    // provenance + license metadata survive the backend round-trip intact
    const asset = res.candidates[0].asset;
    expect(asset.license).toBe('Creative Commons 0');
    expect(asset.licenseClass).toBe('CC0');
    expect(asset.creditLine).toContain('sec-fixture');
    expect(asset.sourceUrl).toBe('https://freesound.org/sounds/4242/');

    await expectNoSecretsInPersistence();
  });

  it('original-quality download goes through the backend with no browser-side bearer', async () => {
    const wav = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
    const { captured } = mockBackend((req) => {
      if (req.url.includes('/api/library/freesound/sounds/4242/download')) {
        return new Response(wav, { status: 200 });
      }
      return undefined;
    });
    const svc = new RetrievalService(() => ({
      status: okStatus({ oauthAvailable: true, oauthConfigured: true, expiresAt: Date.now() + 3600_000 }),
      backendOnline: true,
    }));
    const asset = freesoundToAsset(fsSound(4242), 'preview', 'fs-4242-preview');
    const orig = await svc.fetchOriginal(asset);
    expect(orig.cacheKey).toBe('fs-4242-original');
    expect(orig.blob.size).toBe(64);

    const dl = captured.find((r) => r.url.includes('/sounds/4242/download'))!;
    expect(dl.url).toContain('/api/library/freesound/sounds/4242/download');
    expect(dl.headers.has('Authorization')).toBe(false); // the backend holds the token
    expectNoSecretsInRequests(captured);
  });
});

describe('S6 · OAuth2 exchange sends only code + state', () => {
  it('the client secret never transits the browser during the OAuth loop', async () => {
    const { captured } = mockBackend((req) => {
      if (req.url.includes('/oauth/start') && req.method === 'POST') {
        return new Response(
          JSON.stringify({ authorizeUrl: 'https://freesound.org/apiv2/oauth2/authorize/?client_id=cid&response_type=code&state=st-123', expiresInSeconds: 600 }),
          { status: 200 },
        );
      }
      if (req.url.includes('/oauth/exchange') && req.method === 'POST') {
        return new Response(JSON.stringify({ status: okStatus({ oauthAvailable: true, user: 'ghost' }) }), { status: 200 });
      }
      return undefined;
    });

    const start = await startFreesoundOAuth();
    expect(start.authorizeUrl).toContain('state=st-123');
    // the authorization URL is secret-free
    expect(start.authorizeUrl).not.toContain('secret');

    const { status } = await exchangeFreesoundOAuth('one-time-code', 'st-123');
    expect(status.oauthAvailable).toBe(true);

    const exchange = captured.find((r) => r.url.includes('/oauth/exchange'))!;
    expect(exchange.body).toEqual({ code: 'one-time-code', state: 'st-123' });
    expectNoSecretsInRequests(captured);
    await expectNoSecretsInPersistence();
  });
});
