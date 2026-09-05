/* ==================================================================== *
 *  UMBRA · FREESOUND BACKEND INTEGRATION (mocked)
 *
 *  The Freesound API key is a server-side secret. These tests pin down the
 *  consequences of that decision in the browser:
 *
 *    · every authenticated request goes to /api/integrations/freesound/*
 *    · no request ever carries a credential or hits freesound.org
 *    · nothing is written to localStorage / IndexedDB
 *    · configuration and connection state are reported honestly, and a
 *      failure never becomes an invented result
 *
 *  All HTTP is mocked at the fetch layer. No credential, real or fake, is
 *  needed anywhere in this file.
 * ==================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchMock } from './setup';

import { FreesoundProvider, freesoundToAsset, type FsSound } from '../src/lib/library/freesound';
import {
  FreesoundBackendError,
  FREESOUND_API,
  fetchFreesoundStatus,
  freesoundPreviewUrl,
  type FreesoundStatus,
} from '../src/lib/library/freesoundBackend';
import { purgeLegacyFreesoundCredentials } from '../src/lib/library/cache';
import type { RetrievalIntent } from '../src/lib/library/types';

/* ---------------------------------------------------------- fixtures -- */

const BASE_STATUS: FreesoundStatus = {
  provider: 'freesound',
  configured: true,
  connected: true,
  keySource: 'environment:FREESOUND_API_KEY',
  keyHint: 'sha256:0f1e2d3c4b5a',
  oauth: { configured: false, quality: 'preview' },
  apiBase: 'https://freesound.org/apiv2',
  probed: true,
  reason: null,
  hint: null,
  checkedAt: 1700000000,
  elapsedMs: 12,
  capabilities: {
    search: true,
    metadata: true,
    preview: true,
    similar: true,
    audioFeatures: true,
    originalDownload: false,
  },
};

function sound(over: Partial<FsSound> & { id: number }): FsSound {
  return {
    id: over.id,
    url: `https://freesound.org/sounds/${over.id}/`,
    name: `sound_${over.id}`,
    tags: ['door'],
    description: 'fixture',
    username: 'umbra-fixture',
    license: 'Attribution',
    type: 'wav',
    channels: 1,
    filesize: 88200,
    duration: 1.4,
    samplerate: 44100,
    created: '2021-01-01T00:00:00Z',
    previews: { 'preview-hq-mp3': `https://freesound.org/data/previews/${over.id}_hq.mp3` },
    score: 88,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const intent: RetrievalIntent = {
  id: 'i1',
  sceneId: 'sc1',
  role: 'DOOR',
  query: 'wooden door creak',
  altQueries: [],
  time: 18.4,
  offset: 0,
  durationFit: 'short',
  priority: 1,
  allowSilence: true,
  reason: 'fixture',
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  setFetchMock(null);
});

/* ------------------------------------------------------------- status -- */

describe('GET /api/integrations/freesound/status', () => {
  it('reports configured + connected without ever exposing the key', async () => {
    const calls: string[] = [];
    setFetchMock((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json(BASE_STATUS);
    }) as never);

    const status = await fetchFreesoundStatus('always');

    expect(status.configured).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.keySource).toBe('environment:FREESOUND_API_KEY');
    // the fingerprint is not the key, and the key is nowhere in the payload
    expect(status.keyHint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(status)).not.toMatch(/api[_-]?key"\s*:\s*"/i);
    expect(calls[0]).toBe(`${FREESOUND_API}/status?probe=always`);
  });

  it('a rejected key is reported as not-connected, never as ready', async () => {
    setFetchMock((async () =>
      json({
        ...BASE_STATUS,
        connected: false,
        reason: 'Freesound rejected the configured API key (401).',
        hint: 'Check FREESOUND_API_KEY in .env.',
      })) as never);

    const provider = new FreesoundProvider();
    const status = await provider.status({ force: true });

    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/rejected/);
  });

  it('a missing key is reported as not-configured with actionable guidance', async () => {
    setFetchMock((async () =>
      json({
        ...BASE_STATUS,
        configured: false,
        connected: null,
        keySource: null,
        keyHint: null,
        probed: false,
        reason: 'No Freesound API key configured on the backend (FREESOUND_API_KEY is unset).',
        hint: 'Copy .env.example to .env and set FREESOUND_API_KEY.',
      })) as never);

    const status = await new FreesoundProvider().status({ force: true });

    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/FREESOUND_API_KEY/);
    expect(status.online).toBe(true); // the backend answered; only the key is missing
  });

  it('backend offline is reported honestly instead of faking availability', async () => {
    setFetchMock((async () => {
      throw new Error('Failed to fetch');
    }) as never);

    const status = await new FreesoundProvider().status({ force: true });

    expect(status.online).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/backend is not running/i);

    // and the surfaced error carries the remediation hint
    await expect(fetchFreesoundStatus()).rejects.toBeInstanceOf(FreesoundBackendError);
    const err = await fetchFreesoundStatus().catch((e: FreesoundBackendError) => e);
    expect(err.code).toBe('backend_offline');
    expect(err.hint).toMatch(/run_backend/);
  });
});

/* ------------------------------------------------------------- search -- */

describe('search routes through the backend and preserves provenance', () => {
  it('posts to the backend seam, maps the sound, and stores no credential', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    setFetchMock((async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(input);
      calls.push([raw, init]);
      if (raw.includes('/status')) return json(BASE_STATUS);
      if (raw.includes('/search')) {
        return json({
          provider: 'freesound',
          query: 'wooden door creak door hinge',
          count: 1,
          page: 1,
          pageSize: 30,
          next: null,
          previous: null,
          sounds: [sound({ id: 4242, name: 'old_door_creak', license: 'Attribution NonCommercial' })],
        });
      }
      throw new Error(`unmapped ${raw}`);
    }) as never);

    const provider = new FreesoundProvider();
    const res = await provider.search(intent);

    expect(res.error).toBeNull();
    const asset = res.candidates[0].asset;
    expect(asset.provider).toBe('freesound');
    expect(asset.soundId).toBe('4242');
    expect(asset.creator).toBe('umbra-fixture');
    expect(asset.license).toBe('Attribution NonCommercial');
    expect(asset.licenseClass).toBe('CC_BY_NC');
    expect(asset.attributionRequired).toBe(true);
    expect(asset.sourceUrl).toContain('/sounds/4242/');
    expect(asset.quality).toBe('preview');
    expect(asset.creditLine).toContain('umbra-fixture');

    // every request stayed on the app origin and none carried a credential
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls) {
      expect(url.startsWith('/api/integrations/freesound')).toBe(true);
      expect(url).not.toMatch(/freesound\.org/);
      expect(url).not.toMatch(/token=/i);
      expect(String(init?.body ?? '')).not.toMatch(/token|api[_-]?key/i);
    }

    // nothing secret is persisted in the browser
    const stored = Object.keys(localStorage).concat(JSON.stringify(localStorage));
    expect(stored.join(' ')).not.toMatch(/api[_-]?key|token/i);
  });

  it('surfaces a not-configured backend verbatim instead of inventing results', async () => {
    setFetchMock((async (input: RequestInfo | URL) => {
      const raw = String(input);
      if (raw.includes('/status')) {
        return json({
          ...BASE_STATUS,
          configured: false,
          connected: null,
          keyHint: null,
          probed: false,
          reason: 'No Freesound API key configured on the backend (FREESOUND_API_KEY is unset).',
        });
      }
      return json({ error: 'No Freesound API key configured on the backend.', code: 'not_configured' }, 503);
    }) as never);

    const res = await new FreesoundProvider().search(intent);

    expect(res.candidates).toHaveLength(0);
    expect(res.error).toMatch(/FREESOUND_API_KEY|API key configured/i);
  });
});

/* ------------------------------------------------------------ preview -- */

describe('preview + original quality', () => {
  it('auditions previews through the backend proxy', async () => {
    const calls: string[] = [];
    setFetchMock((async (input: RequestInfo | URL) => {
      const raw = String(input);
      calls.push(raw);
      if (raw.includes('/status')) return json(BASE_STATUS);
      if (raw.includes('/preview')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      }
      throw new Error(`unmapped ${raw}`);
    }) as never);

    const provider = new FreesoundProvider();
    const asset = freesoundToAsset(sound({ id: 777 }), 'preview', 'fs-777-preview');
    const fetched = await provider.fetchPreview(asset);

    expect(fetched.bytes).toBe(4);
    expect(fetched.mime).toBe('audio/mpeg');
    expect(calls.some((c) => c === freesoundPreviewUrl('777'))).toBe(true);
    // every call stays on the app's own origin — no direct freesound.org request
    expect(calls.every((c) => new URL(c, 'http://umbra.test').origin === 'http://umbra.test')).toBe(true);
  });

  it('download errors name the real cause (OAuth2) and never fall back silently', async () => {
    setFetchMock((async () =>
      json(
        {
          error: 'Original-quality download needs a Freesound OAuth2 access token in FREESOUND_OAUTH_TOKEN.',
          code: 'oauth_required',
        },
        501,
      )) as never);

    const provider = new FreesoundProvider();
    const asset = freesoundToAsset(sound({ id: 778 }), 'preview', 'fs-778-preview');
    await expect(provider.fetchOriginal(asset)).rejects.toThrow(/OAuth2/);
  });
});

/* ------------------------------------------------- legacy credential --- */

describe('legacy browser credentials are purged', () => {
  it('deletes any Freesound credential an older build left in localStorage', () => {
    localStorage.setItem('umbra.library.freesound.creds.v1', JSON.stringify({ apiToken: 'stale-value-from-an-old-build' }));
    expect(purgeLegacyFreesoundCredentials()).toEqual(['umbra.library.freesound.creds.v1']);
    expect(localStorage.getItem('umbra.library.freesound.creds.v1')).toBeNull();
  });

  it('is a no-op when nothing is stored', () => {
    expect(purgeLegacyFreesoundCredentials()).toEqual([]);
  });
});

/* ------------------------------------------------------ error mapping -- */

describe('backend error codes reach the UI intact', () => {
  it('maps 503 not_configured onto a typed error with its hint', async () => {
    setFetchMock((async () =>
      json({ error: 'No key.', code: 'not_configured', hint: 'Set FREESOUND_API_KEY in .env.' }, 503)) as never);

    const err = await fetchFreesoundStatus().catch((e: FreesoundBackendError) => e);
    expect(err).toBeInstanceOf(FreesoundBackendError);
    expect(err.code).toBe('not_configured');
    expect(err.status).toBe(503);
    expect(err.detail()).toContain('FREESOUND_API_KEY');
  });

  it('never lets a search resolve to synthetic candidates', async () => {
    // a transport-level failure can only mean the backend is unreachable —
    // the provider says so, and returns zero candidates rather than filler
    const spy = vi.fn(async () => {
      throw new Error('boom');
    });
    setFetchMock(spy as never);
    const res = await new FreesoundProvider().search(intent);
    expect(res.candidates).toEqual([]);
    expect(res.error).toMatch(/backend is not running/i);
  });
});
