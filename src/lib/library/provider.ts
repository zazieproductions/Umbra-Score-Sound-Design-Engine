/* ==================================================================== *
 *  UMBRA · SOUND LIBRARY PROVIDER ARCHITECTURE
 *
 *  One interface for every sound source. Providers report capabilities
 *  truthfully; UMBRA never assumes what a provider can do.
 * ==================================================================== */

import type { LibraryAsset, LicensePolicy, ProviderCapabilities, ProviderId, ProviderStatus, RetrievalIntent, RetrievalSearchResult } from './types';

export interface PreviewFetch {
  blob: Blob;
  mime: string;
  bytes: number;
}

/** Optional search parameters (positional page/policy mixing caused signature conflicts). */
export interface SearchOptions {
  /** Page number for paginated providers (default 1). */
  page?: number;
  /** License policy gate applied by the service; local providers may filter earlier. */
  policy?: LicensePolicy;
}

/** Everything a provider must implement. Optional pieces are capability-gated. */
export interface SoundLibraryProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Current status. Async because a remote provider must be *asked* —
   * Freesound readiness lives on the backend, not in the browser.
   */
  status(opts?: { force?: boolean }): Promise<ProviderStatus>;

  /** Search by a planner intent. Returns raw candidates (service ranks them). */
  search(intent: RetrievalIntent, opts?: SearchOptions): Promise<RetrievalSearchResult>;

  /** Fetch the auditionable audio for a candidate (preview MP3/OGG at Level 1). */
  fetchPreview(asset: LibraryAsset): Promise<PreviewFetch>;

  /** Fetch the original-quality file (OAuth2 for Freesound). */
  fetchOriginal?(asset: LibraryAsset): Promise<PreviewFetch>;

  /** Metadata search — re-query with specific metadata fields/filters. */
  metadataSearch?(intent: RetrievalIntent, filters: string[], page?: number): Promise<RetrievalSearchResult>;

  /** Find acoustically/semantically similar sounds (Freesound laion_clap space). */
  similar?(asset: LibraryAsset, page?: number): Promise<RetrievalSearchResult>;

  /** Audio feature descriptors when the provider exposes them. */
  audioFeatures?(asset: LibraryAsset): Promise<Record<string, number | string | number[]>>;

  /** Provider-specific deep link for attribution (never bypasses licensing). */
  sourcePageUrl(asset: LibraryAsset): string;
}
