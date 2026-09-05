/* ==================================================================== *
 *  UMBRA · USER LIBRARY PROVIDER
 *
 *  The composer's own imported files. This provider has the HIGHEST
 *  privilege in the routing: a strong user-library match beats an
 *  external download. Works fully offline.
 * ==================================================================== */

import { userLibrary, sha256Hex, shortId, type UserFile } from './cache';
import type { LibraryAsset, LicensePolicy, ProviderCapabilities, ProviderStatus, RetrievalIntent, RetrievalSearchResult } from './types';
import type { PreviewFetch, SearchOptions, SoundLibraryProvider } from './provider';
import { mapFreesoundLicense } from './freesound';
import { licenseAllowed } from './types';

export class UserLibraryProvider implements SoundLibraryProvider {
  readonly id = 'user-library' as const;
  readonly label = 'User Library';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    metadataSearch: true,
    preview: true,
    download: 'local',
    licenseMetadata: true,
    attribution: true,
    similarity: false,
    audioFeatures: false,
    assistedSearch: false,
    manualImport: true,
    offline: true,
  };

  status(): ProviderStatus {
    return {
      provider: this.id,
      label: this.label,
      online: true,
      ready: true,
      reason: 'Local files — works offline, always available.',
      capabilities: this.capabilities,
    };
  }

  sourcePageUrl(asset: LibraryAsset): string {
    return asset.sourceUrl || `umbra://user-library/${asset.soundId}`;
  }

  async search(intent: RetrievalIntent, opts: SearchOptions = {}): Promise<RetrievalSearchResult> {
    const started = performance.now();
    const files = await userLibrary.list();
    const q = intent.query.toLowerCase();
    const qTokens = q.split(/\s+/).filter((t) => t.length > 1);
    const hits = files
      .map((f) => {
        const hay = `${f.name} ${f.tags.join(' ')} ${f.role} ${f.note}`.toLowerCase();
        let score = 0;
        for (const t of qTokens) if (hay.includes(t)) score += 1;
        // a file tagged against the SAME role is a strong, honest match even
        // when the free-text query uses synonyms ("machinery" vs "mechanical")
        if (f.role === intent.role) score += 4;
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 24);
    const pol = opts.policy ?? fallbackPolicy();
    const assets = hits.map(({ f }) => userFileToAsset(f));
    const candidates = assets.map((asset) => ({
      asset,
      match: 0,
      signals: [{ label: 'user library', value: 'local', weight: 1 }],
      licenseOk: licenseAllowed(pol, asset.licenseClass),
      licenseReason: licenseAllowed(pol, asset.licenseClass) ? null : 'License not allowed by current policy.',
    }));
    return {
      intent,
      count: candidates.length,
      page: 1,
      candidates,
      clap: 'metadata',
      elapsedMs: Math.round(performance.now() - started),
      error: null,
    };
  }

  async fetchPreview(asset: LibraryAsset): Promise<PreviewFetch> {
    const files = await userLibrary.list();
    const f = files.find((x) => x.id === asset.soundId);
    if (!f) throw new Error(`User library file ${asset.soundId} no longer exists.`);
    return { blob: f.blob, mime: f.blob.type || 'audio/wav', bytes: f.blob.size };
  }

  /**
   * Import a local audio file into the user library with metadata.
   * Caller supplies role/tags/license via the import dialog — UMBRA never
   * guesses a license from the filename.
   */
  async importFile(file: File, meta: { role: string; tags: string[]; license: string; licenseClass: string; creator: string; sourceUrl: string; note: string }): Promise<UserFile> {
    const buf = await file.arrayBuffer();
    const md5 = await sha256Hex(buf);
    const duration = await probeDuration(file);
    const rec: UserFile = {
      id: shortId('u'),
      name: file.name,
      role: meta.role,
      tags: meta.tags,
      license: meta.license,
      licenseClass: meta.licenseClass,
      creator: meta.creator,
      sourceUrl: meta.sourceUrl,
      note: meta.note,
      addedAt: Date.now(),
      blob: file,
      duration,
      md5,
    };
    return userLibrary.add(rec);
  }

  /** Remove a file from the library (project clips keep their own cached copy). */
  remove(id: string): Promise<void> {
    return userLibrary.remove(id);
  }
}

/* --------------------------------------------------------- helpers -- */

function userFileToAsset(f: UserFile): LibraryAsset {
  const lic = mapFreesoundLicense(f.licenseClass);
  return {
    provider: 'user-library',
    providerLabel: 'User Library',
    soundId: f.id,
    title: f.name,
    creator: f.creator || 'You',
    sourceUrl: f.sourceUrl,
    license: f.license || 'User-owned (self-declared)',
    licenseClass: f.licenseClass === 'CC0' || f.licenseClass === 'CC_BY' || f.licenseClass === 'CC_BY_NC' || f.licenseClass === 'OTHER' ? (f.licenseClass as LibraryAsset['licenseClass']) : 'UNKNOWN',
    attributionRequired: lic.attributionRequired,
    creditLine: `"${f.name}" from user library${f.creator ? ` by ${f.creator}` : ''} — ${f.license || 'user metadata'}`,
    retrievedAt: f.addedAt,
    quality: 'original',
    duration: f.duration,
    sampleRate: f.sampleRate,
    channels: f.channels,
    tags: f.tags,
    md5: f.md5,
    cacheKey: `usr-${f.id}`,
  };
}

function probeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.src = url;
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
  });
}

function fallbackPolicy(): LicensePolicy {
  return { mode: 'personal', accepted: ['CC0', 'CC_BY', 'CC_BY_NC'] };
}
