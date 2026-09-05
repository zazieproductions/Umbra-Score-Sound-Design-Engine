/* ==================================================================== *
 *  UMBRA · TEST SETUP
 *
 *  The retrieval service touches browser APIs (IndexedDB, localStorage,
 *  fetch, crypto, URL.createObjectURL, AudioContext). This shim provides
 *  the minimum needed so acceptance tests run in Node without a DOM.
 *
 *  No fake results: live Freesound calls are mocked at the fetch layer
 *  with explicit fixtures, and every mock response is asserted-on.
 * ==================================================================== */

import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';

/* ------------------------------------------------------- localStorage -- */

class LocalStorageShim implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
}

if (!('localStorage' in globalThis)) {
  (globalThis as { localStorage: Storage }).localStorage = new LocalStorageShim();
}

/* --------------------------------------------------- fetch + crypto ---- */

// Node 22 provides fetch, Blob, and webcrypto on globalThis already.
// We install a per-test mock via setFetchMock() in the tests themselves.
let fetchMock: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;

export function setFetchMock(fn: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null): void {
  fetchMock = fn;
}

// bind fetch at module scope so tests can swap it without touching global
const realFetch = globalThis.fetch;
const boundFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (fetchMock) return fetchMock(input, init);
  return realFetch(input, init);
};
vi.stubGlobal('fetch', boundFetch);

afterEach(() => {
  fetchMock = null;
});

/* --------------------------------------------------- AudioContext ------ */

// decodeDuration/decodeToMono construct AudioContext; in Node it does not
// exist. The service guards these with try/catch, but we still provide a
// stub so paths that need a duration fall back to provider metadata
// rather than throwing synchronously.
if (!('AudioContext' in globalThis)) {
  class AudioContextStub {
    currentTime = 0;
    sampleRate = 48000;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async decodeAudioData(_ab: ArrayBuffer): Promise<unknown> {
      throw new Error('AudioContext stub: decoding not available in tests');
    }
    createBuffer(): never {
      throw new Error('AudioContext stub: buffer creation not available in tests');
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  (globalThis as { AudioContext?: typeof AudioContextStub }).AudioContext = AudioContextStub as never;
}

/* ------------------------------------------------- object URL + DOM --- */

if (!('createObjectURL' in URL)) {
  URL.createObjectURL = () => `blob:umbra-test-${Math.random().toString(36).slice(2)}`;
}
if (!('revokeObjectURL' in URL)) {
  URL.revokeObjectURL = () => undefined;
}

// credits.ts downloadText() uses document; export paths are tested through
// the pure generators. userLibrary.importFile() probes duration via an
// <audio> element, so the stub fires onloadedmetadata with a fixed duration.
const FIXED_PROBE_SECONDS = 3.0;
if (!('document' in globalThis)) {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'audio') {
        const el: Record<string, unknown> & { onloadedmetadata?: () => void } = {
          preload: '',
          src: '',
          duration: FIXED_PROBE_SECONDS,
        };
        queueMicrotask(() => el.onloadedmetadata?.());
        return el;
      }
      return { click: () => undefined, remove: () => undefined };
    },
    body: { appendChild: () => undefined },
  };
}

/* -------------------------------------------------------- set globals -- */

export const testHelpers = { setFetchMock };
