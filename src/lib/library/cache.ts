/* ==================================================================== *
 *  UMBRA · LOCAL SOUND CACHE + USER LIBRARY (IndexedDB)
 *
 *  Caches ONLY sounds the user/session actually selected. No crawling,
 *  no bulk mirroring. Blobs are keyed by a content hash so the same
 *  Freesound sound is never fetched twice for a project.
 * ==================================================================== */

import type { LibraryAsset, ProvenanceEntry } from './types';

const DB_NAME = 'umbra-sound-library';
const DB_VERSION = 1;

export interface CacheRecord {
  cacheKey: string;
  blob: Blob;
  asset: LibraryAsset;
  addedAt: number;
  /** project ids that reference this asset (used by CLEAR UNUSED) */
  projects: string[];
}

export interface UserFile {
  id: string;
  name: string;
  role: string;
  tags: string[];
  license: string;
  licenseClass: string;
  creator: string;
  sourceUrl: string;
  note: string;
  addedAt: number;
  blob: Blob;
  duration: number;
  sampleRate?: number;
  channels?: number;
  md5: string;
}

export interface FavoriteEntry {
  asset: LibraryAsset;
  at: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'cacheKey' });
      if (!db.objectStoreNames.contains('userFiles')) db.createObjectStore('userFiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('provenance')) db.createObjectStore('provenance', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

function getAll<T>(store: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve((req.result as T[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
      }),
  );
}

/* ------------------------------------------------------------ cache -- */

export const soundCache = {
  get(cacheKey: string): Promise<CacheRecord | undefined> {
    return tx<CacheRecord | undefined>('cache', 'readonly', (s) => s.get(cacheKey) as IDBRequest<CacheRecord | undefined>);
  },
  put(record: CacheRecord): Promise<IDBValidKey> {
    return tx('cache', 'readwrite', (s) => s.put(record));
  },
  touchProjects(cacheKey: string, projectId: string): Promise<void> {
    return soundCache.get(cacheKey).then(async (rec) => {
      if (!rec) return;
      if (!rec.projects.includes(projectId)) {
        rec.projects = [...rec.projects, projectId];
        await soundCache.put(rec);
      }
    });
  },
  list(): Promise<CacheRecord[]> {
    return getAll<CacheRecord>('cache');
  },
  /** Remove assets no project references. Returns number removed. */
  clearUnused(keepProjectIds: string[]): Promise<number> {
    return soundCache.list().then((records) => {
      const dead = records.filter((r) => !r.projects.some((p) => keepProjectIds.includes(p)));
      return Promise.all(
        dead.map((r) => tx('cache', 'readwrite', (s) => s.delete(r.cacheKey))),
      ).then(() => dead.length);
    });
  },
  size(): Promise<number> {
    return soundCache.list().then((records) => records.reduce((a, r) => a + r.blob.size, 0));
  },
};

/* ---------------------------------------------------- user library -- */

export const userLibrary = {
  add(rec: UserFile): Promise<UserFile> {
    return tx('userFiles', 'readwrite', (s) => s.put(rec)).then(() => rec);
  },
  list(): Promise<UserFile[]> {
    return getAll<UserFile>('userFiles');
  },
  remove(id: string): Promise<void> {
    return tx('userFiles', 'readwrite', (s) => s.delete(id)).then(() => undefined);
  },
};

/* ---------------------------------------------------- provenance ---- */

export const provenanceStore = {
  add(entry: ProvenanceEntry): Promise<ProvenanceEntry> {
    return tx('provenance', 'readwrite', (s) => s.put(entry)).then(() => entry);
  },
  list(): Promise<ProvenanceEntry[]> {
    return getAll<ProvenanceEntry>('provenance');
  },
  remove(clipId: string): Promise<void> {
    return tx('provenance', 'readwrite', (s) => s.delete(clipId)).then(() => undefined);
  },
  clear(): Promise<void> {
    return openDb().then((db) => new Promise<void>((resolve, reject) => {
      const t = db.transaction('provenance', 'readwrite');
      t.objectStore('provenance').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('clear failed'));
    }));
  },
};

/* -------------------------------------------------- favorites ------- */

const FAV_KEY = 'umbra.library.favorites';
const CRED_KEY = 'umbra.library.freesound.creds.v1';
const SETTINGS_KEY = 'umbra.library.settings.v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / private mode — degrade silently */
  }
}

export const favoritesStore = {
  list(): FavoriteEntry[] {
    return readJson<FavoriteEntry[]>(FAV_KEY, []);
  },
  toggle(asset: LibraryAsset): FavoriteEntry[] {
    const all = favoritesStore.list().filter((f) => !(f.asset.provider === asset.provider && f.asset.soundId === asset.soundId));
    const next = all.some((f) => f.asset.soundId === asset.soundId)
      ? all.filter((f) => f.asset.soundId !== asset.soundId)
      : [{ asset, at: Date.now() }, ...all];
    writeJson(FAV_KEY, next);
    return next;
  },
  isFavorite(asset: LibraryAsset): boolean {
    return favoritesStore.list().some((f) => f.asset.provider === asset.provider && f.asset.soundId === asset.soundId);
  },
};

/* --------------------------------------------------- credentials ---- */

/** Pure localStorage persistence — never leaves the browser, never committed. */
export const credsStore = {
  load<T>(key = CRED_KEY, fallback: T): T {
    return readJson(key, fallback);
  },
  save(key: string, value: unknown): void {
    writeJson(key, value);
  },
  clear(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

export const settingsStore = {
  load<T>(fallback: T): T {
    return readJson(SETTINGS_KEY, fallback);
  },
  save<T>(value: T): void {
    writeJson(SETTINGS_KEY, value);
  },
};

/* ---------------------------------------------------------- digest -- */

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function shortId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
