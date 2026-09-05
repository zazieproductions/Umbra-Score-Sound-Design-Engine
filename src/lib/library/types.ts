/* ==================================================================== *
 *  UMBRA · SOUND LIBRARY RETRIEVAL — domain model
 *
 *  Provider-agnostic types: every online/offline sound source speaks
 *  this shared vocabulary so no provider logic leaks into the app.
 * ==================================================================== */

/* ------------------------------------------------------------ roles -- */

/** Retrieval roles — the taxonomy the planner uses to build queries. */
export type SoundRole =
  | 'ROOM_TONE'
  | 'AMBIENCE'
  | 'FOOTSTEP'
  | 'CLOTHING'
  | 'DOOR'
  | 'WOOD'
  | 'METAL'
  | 'GLASS'
  | 'BODY'
  | 'BREATH'
  | 'MECHANICAL'
  | 'ELECTRICAL'
  | 'WIND'
  | 'WEATHER'
  | 'WATER'
  | 'CREAK'
  | 'SCRAPE'
  | 'IMPACT'
  | 'KNOCK'
  | 'RATTLE'
  | 'RUMBLE'
  | 'DRONE'
  | 'TEXTURE'
  | 'TRANSITION'
  | 'ANIMAL'
  | 'VEHICLE'
  | 'MISC_FOLEY';

export const ROLE_LABELS: Record<SoundRole, string> = {
  ROOM_TONE: 'Room tone',
  AMBIENCE: 'Ambience',
  FOOTSTEP: 'Footstep',
  CLOTHING: 'Clothing',
  DOOR: 'Door',
  WOOD: 'Wood',
  METAL: 'Metal',
  GLASS: 'Glass',
  BODY: 'Body',
  BREATH: 'Breath',
  MECHANICAL: 'Mechanical',
  ELECTRICAL: 'Electrical',
  WIND: 'Wind',
  WEATHER: 'Weather',
  WATER: 'Water',
  CREAK: 'Creak',
  SCRAPE: 'Scrape',
  IMPACT: 'Impact',
  KNOCK: 'Knock',
  RATTLE: 'Rattle',
  RUMBLE: 'Rumble',
  DRONE: 'Drone',
  TEXTURE: 'Texture',
  TRANSITION: 'Transition',
  ANIMAL: 'Animal',
  VEHICLE: 'Vehicle',
  MISC_FOLEY: 'Foley',
};

/** Roles that describe continuous beds rather than one-shot events. */
export const BED_ROLES: SoundRole[] = ['ROOM_TONE', 'AMBIENCE', 'DRONE', 'TEXTURE', 'WIND', 'RUMBLE'];

export function isBedRole(role: SoundRole): boolean {
  return BED_ROLES.includes(role);
}

/* ---------------------------------------------------------- licenses -- */

export type LicenseClass = 'CC0' | 'CC_BY' | 'CC_BY_NC' | 'OTHER' | 'UNKNOWN';

export const LICENSE_CLASS_LABELS: Record<LicenseClass, string> = {
  CC0: 'CC0',
  CC_BY: 'CC BY',
  CC_BY_NC: 'CC BY-NC',
  OTHER: 'Other',
  UNKNOWN: 'Unknown',
};

/** Built-in license policy presets for the licensing settings. */
export type LicenseMode = 'strict' | 'personal' | 'custom';

export interface LicensePolicy {
  mode: LicenseMode;
  /** explicit accept list used when mode === 'custom' */
  accepted: LicenseClass[];
}

/** Default classes allowed per built-in mode (CC0 + BY in strict; + NC for personal). */
export const MODE_ACCEPTED: Record<Exclude<LicenseMode, 'custom'>, LicenseClass[]> = {
  strict: ['CC0', 'CC_BY'],
  personal: ['CC0', 'CC_BY', 'CC_BY_NC'],
};

export function licenseAllowed(policy: LicensePolicy, cls: LicenseClass): boolean {
  if (cls === 'UNKNOWN') return false; // never guess from filenames / absence of metadata
  if (cls === 'OTHER') return policy.mode === 'custom' && policy.accepted.includes('OTHER');
  const base = policy.mode === 'custom' ? policy.accepted : MODE_ACCEPTED[policy.mode];
  return base.includes(cls);
}

export interface AttributionInfo {
  provider: string;
  providerLabel: string;
  soundId: string;
  title: string;
  creator: string;
  sourceUrl: string;
  license: string;        // raw provider license string — never inferred
  licenseClass: LicenseClass;
  attributionRequired: boolean;
  creditLine: string;
}

/* ------------------------------------------------------- providers ---- */

export type ProviderId = 'freesound' | 'user-library' | 'pixabay-assisted';

export interface ProviderCapabilities {
  search: boolean;            // programmatic in-app search
  metadataSearch: boolean;    // structured metadata queries
  preview: boolean;           // listen without leaving Umbra
  download: 'full' | 'oauth' | 'local' | 'none';
  licenseMetadata: boolean;
  attribution: boolean;
  similarity: boolean;
  audioFeatures: boolean;
  assistedSearch: boolean;    // hands the user off to the provider's own search
  manualImport: boolean;
  offline: boolean;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  online: boolean;
  ready: boolean;
  reason: string | null;
  capabilities: ProviderCapabilities;
}

/* --------------------------------------------------------- assets ---- */

export type AssetQuality = 'preview' | 'original';
export type ClipSource = 'LIB' | 'USR' | 'GEN' | 'VID' | 'PROC' | 'PIX';

/** A retrieved/imported sound, with all provenance attached. */
export interface LibraryAsset {
  provider: ProviderId;
  providerLabel: string;
  soundId: string;
  title: string;
  creator: string;
  sourceUrl: string;
  license: string;
  licenseClass: LicenseClass;
  attributionRequired: boolean;
  creditLine: string;
  retrievedAt: number;
  quality: AssetQuality;
  duration: number;
  sampleRate?: number;
  channels?: number;
  type?: string;
  fileSize?: number;
  tags: string[];
  description?: string;
  /** preview media URLs as returned by the provider (hq/lq mp3+ogg) */
  previewUrls?: Record<string, string>;
  md5?: string;
  numDownloads?: number;
  avgRating?: number;
  created?: string;
  genAiPreference?: string;
  images?: { waveform?: string; spectrum?: string };
  features?: Record<string, number | string | number[]>;
  /** provider relevance score (0..1 when known) */
  score?: number;
  /** cache key of the audio blob in the local asset cache */
  cacheKey: string;
}

/* ---------------------------------------------------- retrieval ------ */

export interface RetrievalIntent {
  id: string;
  sceneId: string;
  role: SoundRole;
  /** the GOOD query — audible phenomenon, not a mood sentence */
  query: string;
  altQueries: string[];
  /** anchor time in project seconds; null = bed across the scene */
  time: number | null;
  offset: number;
  durationFit: 'short' | 'medium' | 'long';
  minDuration?: number;
  maxDuration?: number;
  priority: number;
  /** negative space is a valid decision */
  allowSilence: boolean;
  reason: string;
  /** optional nondestructive processing / hybrid construction */
  transform?: TransformSpec;
  addProceduralSub?: boolean;
  isSilenceChoice?: boolean;
}

/** Nondestructive source + transform. The original asset is always kept. */
export interface TransformSpec {
  playbackRate: number;
  pitch: number;          // semitones
  reverse: boolean;
  lowpassHz: number | null;
  highpassHz: number | null;
  reverb: number;         // 0..1 send
  gainDb: number;
  loop: boolean;
  crossfadeLoop: boolean;
  slowModulate: number;   // 0..1 slow amplitude breathing
}

export const NO_TRANSFORM: TransformSpec = {
  playbackRate: 1,
  pitch: 0,
  reverse: false,
  lowpassHz: null,
  highpassHz: null,
  reverb: 0,
  gainDb: 0,
  loop: false,
  crossfadeLoop: false,
  slowModulate: 0,
};

/** The classic real-sound → horror drone recipe. */
export const HORROR_DRONE_TRANSFORM: TransformSpec = {
  playbackRate: 0.4,
  pitch: -12,
  reverse: false,
  lowpassHz: 1800,
  highpassHz: 24,
  reverb: 0.74,
  gainDb: -14,
  loop: true,
  crossfadeLoop: true,
  slowModulate: 0.35,
};

export interface RankedCandidate {
  asset: LibraryAsset;
  match: number;         // 0..1, informational — never "objective truth"
  signals: { label: string; value: string; weight: number }[];
  licenseOk: boolean;
  licenseReason: string | null;
}

export interface RetrievalSearchResult {
  intent: RetrievalIntent;
  count: number;
  page: number;
  candidates: RankedCandidate[];
  clap: 'none' | 'metadata' | 'freesound-laion-clap';
  elapsedMs: number;
  error: string | null;
}

/* ---------------------------------------------------------- clips ---- */

/** A placed, editable, sample-based sound clip on the timeline. */
export interface SoundClip {
  id: string;
  sceneId: string;
  name: string;
  role: SoundRole;
  source: ClipSource;
  start: number;          // project seconds
  end: number;            // project seconds
  offset: number;         // source offset
  gain: number;           // 0..1.3
  pan: number;            // -1..1
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
  solo: boolean;
  transform: TransformSpec;
  asset: LibraryAsset;
  cacheKey: string;
  intentId: string;
  /** informational retrieval match, shown as MATCH */
  match: number;
  familyId?: string;
  variantIndex?: number;
}

/* ----------------------------------------------------- provenance ---- */

export interface ProvenanceEntry {
  id: string;
  clipId: string;
  sceneId: string;
  usedAt: number;
  role: SoundRole;
  asset: LibraryAsset;
}

/* ---------------------------------------------------- settings ------- */

export type AutoMode = 'off' | 'suggest' | 'auto-safe' | 'auto-full';
export type SoundDensity = 'minimal' | 'restrained' | 'normal' | 'dense';

export interface LibrarySettings {
  licensePolicy: LicensePolicy;
  density: SoundDensity;
  autoMode: AutoMode;
  autoSafeThreshold: number;
  autoFullThreshold: number;
  usePreviewFirst: boolean;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  licensePolicy: { mode: 'personal', accepted: ['CC0', 'CC_BY', 'CC_BY_NC'] },
  density: 'normal',
  autoMode: 'suggest',
  autoSafeThreshold: 0.82,
  autoFullThreshold: 0.6,
  usePreviewFirst: true,
};

/* -------------------------------------------------- credentials ------ */

/** Never written to Git. Local-only (localStorage), shown masked in UI. */
export interface FreesoundCredentials {
  apiToken: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;      // epoch ms
  user: string | null;
}

export const EMPTY_FREESOUND_CREDS: FreesoundCredentials = {
  apiToken: '',
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  user: null,
};

export interface SpottingEvent {
  id: string;
  sceneId: string;
  label: string;
  role: SoundRole;
  time: number;
  createdAt: number;
}

/** Context handed to the retrieval planner for one scene. */
export interface SceneSoundContext {
  sceneId: string;
  start: number;
  end: number;
  title: string;
  tags: string[];
  summary: string;
  tension: number; // 0..1
  motion: number;  // 0..1
  hits: number[];
  spotting: SpottingEvent[];
}

/* --------------------------------------------------- search state ---- */

export interface RetrievalState {
  busy: boolean;
  intent: RetrievalIntent | null;
  result: RetrievalSearchResult | null;
  error: string | null;
  lastAuto: { mode: AutoMode; placed: number; suggested: number; skipped: number; at: number } | null;
}
