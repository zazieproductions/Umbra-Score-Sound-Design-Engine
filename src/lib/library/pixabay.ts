/* ==================================================================== *
 *  UMBRA · PIXABAY ASSISTED PROVIDER
 *
 *  The public Pixabay API does not currently expose a sound-effects
 *  search endpoint, so this provider NEVER pretends to search or
 *  download. It hands the user off to Pixabay's own site for the
 *  sourced phrase and makes importing the downloaded file trivial.
 *  If a legitimate official audio API appears later, an adapter can
 *  implement full search without touching this code path.
 * ==================================================================== */

import type { LibraryAsset, ProviderCapabilities, ProviderStatus, RetrievalIntent, RetrievalSearchResult } from './types';
import type { PreviewFetch, SearchOptions, SoundLibraryProvider } from './provider';

const PIXABAY_SOUND_EFFECTS = 'https://pixabay.com/sound-effects/';

export class PixabayAssistedProvider implements SoundLibraryProvider {
  readonly id = 'pixabay-assisted' as const;
  readonly label = 'Pixabay (assisted)';
  readonly capabilities: ProviderCapabilities = {
    search: false,          // truthful: no programmatic search through Umbra
    metadataSearch: false,
    preview: false,
    download: 'none',
    licenseMetadata: false, // license checked on their site / in their terms
    attribution: true,
    similarity: false,
    audioFeatures: false,
    assistedSearch: true,
    manualImport: true,
    offline: false,
  };

  async status(): Promise<ProviderStatus> {
    return {
      provider: this.id,
      label: this.label,
      online: true,
      ready: true,
      reason: 'Assisted search only: opens Pixabay sound-effects search; you choose and import the file.',
      capabilities: this.capabilities,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sourcePageUrl(_asset: LibraryAsset): string {
    return PIXABAY_SOUND_EFFECTS;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_intent: RetrievalIntent, _opts?: SearchOptions): Promise<RetrievalSearchResult> {
    throw new Error('Pixabay assisted provider cannot search programmatically.');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchPreview(_asset: LibraryAsset): Promise<PreviewFetch> {
    throw new Error('Pixabay assisted provider cannot fetch audio.');
  }

  /** URL to open for the user's own search on Pixabay (no scraping). */
  assistedSearchUrl(phrase: string): string {
    const u = new URL(PIXABAY_SOUND_EFFECTS);
    u.searchParams.set('search', phrase);
    return u.toString();
  }

  /** Attribution guideline displayed to the user (per Pixabay license). */
  attributionNote(): string {
    return 'Pixabay Content License: free for commercial and noncommercial use, no attribution required, but redistribution of unmodified copies is not allowed. Confirm the license on the asset page.';
  }
}
