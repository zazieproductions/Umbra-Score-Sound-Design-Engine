/* ==================================================================== *
 *  UMBRA PROVIDERS — frontend client for the local ML backend
 *
 *  Umbra is a hybrid workstation. Some providers run in this browser
 *  (Umbra Procedural / Web Audio), others run as trained models in the
 *  local Python service. This module is the single boundary between the
 *  two, and it deliberately never invents state: if the backend is not
 *  running, providers report "offline" rather than pretending.
 *
 *  All requests are relative URLs proxied by Vite to the backend, so the
 *  browser only ever talks to its own origin.
 * ==================================================================== */

export type ProviderId = 'umbra-procedural' | 'ace-step' | 'stable-audio' | 'mmaudio' | 'clap';

export type ProviderRole = 'procedural' | 'musical_score' | 'sound_design' | 'video_foley' | 'semantic';

export type Capability =
  | 'MUSIC_GENERATION'
  | 'SFX_GENERATION'
  | 'VIDEO_CONDITIONED'
  | 'REFERENCE_AUDIO'
  | 'CONTINUATION'
  | 'ACCOMPANIMENT'
  | 'REPAINT'
  | 'KEY_CONDITIONING'
  | 'BPM_CONDITIONING'
  | 'TIME_SIGNATURE_CONDITIONING'
  | 'NEGATIVE_DIRECTION'
  | 'SEED_CONTROL'
  | 'DURATION_CONTROL'
  | 'SEMANTIC_SEARCH'
  | 'EMBEDDINGS'
  | 'LORA';

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  blurb: string;
  role: ProviderRole;
  installed: boolean;
  ready: boolean;
  capabilities: Capability[];
  device: string | null;
  deviceDetail: string | null;
  model: string | null;
  availableModels: string[];
  version: string | null;
  sizeBytes: number | null;
  notes: string[];
  installHint: string | null;
  error: string | null;
  experimental?: boolean;
  commercialSafe?: boolean | null;
  weightsLicense?: string | null;
}

export interface DeviceInfo {
  id: string;
  label: string;
  available: boolean;
  detail: string | null;
  totalMemoryBytes: number | null;
  notes: string[];
}

export interface RuntimeSummary {
  platform: { system: string; machine: string; python: string; appleSilicon: boolean };
  torch: string | null;
  devices: DeviceInfo[];
  preferredDevice: string;
  preferredDeviceLabel: string;
}

export interface CheckpointInfo {
  name: string;
  present: boolean;
  path: string | null;
  sizeBytes: number | null;
  repo: string | null;
}

export interface PackageInfo {
  name: string;
  installed: boolean;
  version: string | null;
  purpose: string;
}

export interface ModelsReport {
  runtime: RuntimeSummary;
  providers: ProviderStatus[];
  checkpointsRoot: string;
  checkpoints: CheckpointInfo[];
  packages: PackageInfo[];
}

export interface GenerationJob {
  jobId: string;
  provider: ProviderId;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  elapsed: number;
  result: GenerationResultPayload | null;
  error: string | null;
  hint: string | null;
  label: string | null;
  sceneId: string | null;
  timelineStart: number;
}

export interface GenerationResultPayload {
  audioId: string;
  url: string;
  duration: number;
  sampleRate: number;
  channels: number;
  frames: number;
  bytes: number;
  provider: string;
  metadata: Record<string, unknown>;
}

export type UmbraTask = 'generate' | 'continue' | 'repaint' | 'reference' | 'accompany';

export interface GenerateRequest {
  provider: ProviderId;
  prompt: string;
  negativePrompt?: string;
  task?: UmbraTask;
  duration: number;
  seed?: number | null;
  key?: string | null;
  mode?: string | null;
  bpm?: number | null;
  timeSignature?: string | null;
  instrumental?: boolean;
  referenceAudioId?: string | null;
  sourceAudioId?: string | null;
  repaintStart?: number | null;
  repaintEnd?: number | null;
  referenceStrength?: number;
  videoPath?: string | null;
  videoStart?: number;
  videoEnd?: number;
  commercialSafe?: boolean;
  allowNoncommercial?: boolean;
  timelineStart?: number;
  sceneId?: string | null;
  label?: string | null;
  advanced?: Record<string, unknown>;
}

export interface PromptPlan {
  prompt: string;
  negativePrompt: string;
  key: string | null;
  mode: string | null;
  bpm: number | null;
  timeSignature: string | null;
  duration: number;
  instrumental: boolean;
  notes: string[];
}

export interface PlanEvent {
  at: number;
  action: string;
}

export interface ScorePlan {
  sceneId: string | null;
  label: string;
  start: number;
  end: number;
  duration: number;
  key: string;
  mode: string;
  keyScale: string;
  bpm: number;
  density: string;
  dread: number;
  tension: number;
  structure: PlanEvent[];
  intent: string;
  negativeDirection: string[];
}

export interface RouteDecision {
  provider: ProviderId;
  confidence: number;
  reason: string;
  alternatives: ProviderId[];
  matched: string[];
  blocked: boolean;
}

export interface StoredAudio {
  audioId: string;
  filename: string;
  duration: number;
  sampleRate: number;
  channels: number;
  frames: number;
  bytes: number;
  provider: string;
  createdAt: number;
  kind: string;
  metadata: Record<string, unknown>;
  url: string;
  score?: number;
}

/* ------------------------------------------------------------------ client */

export const MMAUDIO_NOTICE = 'EXPERIMENTAL · NONCOMMERCIAL';

/** Fail closed even for callers outside the scoring panel. The server checks again. */
export function generationLicenseError(req: Pick<GenerateRequest, 'provider' | 'commercialSafe' | 'allowNoncommercial'>): string | null {
  if (req.provider !== 'mmaudio') return null;
  if (req.commercialSafe !== false) return 'MMAudio is blocked in commercial-safe workflows (CC BY-NC 4.0 checkpoints).';
  if (req.allowNoncommercial !== true) return 'Explicit noncommercial consent is required for MMAudio.';
  return null;
}

export class BackendOfflineError extends Error {
  constructor() {
    super('The UMBRA local ML backend is not running.');
    this.name = 'BackendOfflineError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new BackendOfflineError();
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body.error || body.detail || detail;
      if (body.hint) detail += ` — ${body.hint}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const backend = {
  async health() {
    return request<{ status: string; version: string; runtime: RuntimeSummary }>('/api/health');
  },

  async providers(): Promise<ProviderStatus[]> {
    const r = await request<{ providers: ProviderStatus[] }>('/api/providers');
    return r.providers;
  },

  async models(): Promise<ModelsReport> {
    return request<ModelsReport>('/api/models');
  },

  async generate(req: GenerateRequest): Promise<GenerationJob> {
    const error = generationLicenseError(req);
    if (error) throw new Error(error);
    const r = await request<{ job: GenerationJob }>('/api/generate', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    return r.job;
  },

  async job(id: string): Promise<GenerationJob> {
    const r = await request<{ job: GenerationJob }>(`/api/jobs/${id}`);
    return r.job;
  },

  async jobs(): Promise<GenerationJob[]> {
    const r = await request<{ jobs: GenerationJob[] }>('/api/jobs');
    return r.jobs;
  },

  async cancelJob(id: string): Promise<void> {
    await request(`/api/jobs/${id}/cancel`, { method: 'POST' });
  },

  async buildPrompt(payload: {
    intent: string;
    key?: string | null;
    mode?: string | null;
    bpm?: number | null;
    timeSignature?: string | null;
    duration?: number;
    density?: string | null;
    dread?: number | null;
    tension?: number | null;
    extraNegatives?: string[];
  }): Promise<PromptPlan> {
    const r = await request<{ plan: PromptPlan }>('/api/prompt/build', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return r.plan;
  },

  async presets(): Promise<{ id: string; label: string; prompt: string }[]> {
    const r = await request<{ presets: { id: string; label: string; prompt: string }[] }>(
      '/api/prompt/presets',
    );
    return r.presets;
  },

  async planScene(payload: {
    start: number;
    end: number;
    tension: number;
    motion?: number;
    sceneId?: string;
    label?: string;
    index?: number;
    intent?: string;
  }): Promise<{ plan: ScorePlan; text: string }> {
    return request<{ plan: ScorePlan; text: string }>('/api/plan/scene', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async route(text: string, hasVideoSelection = false, commercialSafe = true, allowNoncommercial = false): Promise<RouteDecision> {
    const r = await request<{ route: RouteDecision }>('/api/route', {
      method: 'POST',
      body: JSON.stringify({ text, hasVideoSelection, commercialSafe, allowNoncommercial }),
    });
    return r.route;
  },

  async search(query: string, limit = 12) {
    return request<{ available: boolean; results: StoredAudio[]; message?: string }>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  },

  /** Direct URL to a stored audio file — proxied through the Vite dev server. */
  audioUrl(audioId: string): string {
    return `/api/audio/${encodeURIComponent(audioId)}`;
  },

  /** Save the exact generated file to disk, untouched by the master chain. */
  downloadAudio(audioId: string, filename: string, withProvenance = false) {
    const base = `/api/audio/${encodeURIComponent(audioId)}`;
    const files = [{ url: `${base}?download=1`, name: filename }];
    if (withProvenance) files.push({ url: `${base}?metadata=1`, name: `${filename}.provenance.json` });
    for (const file of files) {
      const a = document.createElement('a');
      a.href = file.url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  },

  async listAudio(kind?: string): Promise<StoredAudio[]> {
    const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    const r = await request<{ audio: StoredAudio[] }>(`/api/audio${q}`);
    return r.audio;
  },

  async uploadAudio(file: File, kind = 'reference'): Promise<StoredAudio> {
    const form = new FormData();
    form.append('file', file);
    let res: Response;
    try {
      res = await fetch(`/api/audio/upload?kind=${encodeURIComponent(kind)}`, {
        method: 'POST',
        body: form,
      });
    } catch {
      throw new BackendOfflineError();
    }
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const body = await res.json();
    return body.audio as StoredAudio;
  },

  /** Upload a browser-selected video to this same local backend, only on explicit generation. */
  async uploadVideo(blob: Blob, name: string): Promise<{ path: string; duration: number }> {
    const form = new FormData();
    form.append('file', blob, name);
    const res = await fetch('/api/analysis/video/upload', { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `video upload failed: ${res.status}`);
    }
    return (await res.json()).video;
  },

  /** Poll a job to completion. Resolves with the finished job either way. */
  async waitForJob(
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number; onTick?: (j: GenerationJob) => void } = {},
  ): Promise<GenerationJob> {
    const interval = opts.intervalMs ?? 1000;
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60 * 1000);
    for (;;) {
      const job = await this.job(id);
      opts.onTick?.(job);
      if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
      if (Date.now() > deadline) throw new Error('generation timed out');
      await new Promise((r) => setTimeout(r, interval));
    }
  },
};

/* --------------------------------------------------------------- metadata */

export const CAPABILITY_LABEL: Record<Capability, string> = {
  MUSIC_GENERATION: 'Music generation',
  SFX_GENERATION: 'Sound design',
  VIDEO_CONDITIONED: 'Video conditioned',
  REFERENCE_AUDIO: 'Reference audio',
  CONTINUATION: 'Continuation',
  ACCOMPANIMENT: 'Accompaniment',
  REPAINT: 'Repaint',
  KEY_CONDITIONING: 'Key',
  BPM_CONDITIONING: 'BPM',
  TIME_SIGNATURE_CONDITIONING: 'Time signature',
  NEGATIVE_DIRECTION: 'Negative direction',
  SEED_CONTROL: 'Seed',
  DURATION_CONTROL: 'Duration',
  SEMANTIC_SEARCH: 'Semantic search',
  EMBEDDINGS: 'Embeddings',
  LORA: 'LoRA',
};

/** Offline description used before the backend answers (never claims readiness). */
export const PROVIDER_FALLBACK: Record<ProviderId, Pick<ProviderStatus, 'label' | 'blurb' | 'role' | 'experimental' | 'commercialSafe' | 'weightsLicense'>> = {
  'umbra-procedural': {
    label: 'Umbra Procedural',
    blurb: 'Instant deterministic synthesis',
    role: 'procedural',
  },
  'ace-step': { label: 'ACE-Step', blurb: 'AI scoring / music generation', role: 'musical_score' },
  'stable-audio': { label: 'Stable Audio Open', blurb: 'Text → sound design', role: 'sound_design' },
  mmaudio: { label: 'MMAudio', blurb: 'Video → synchronized audio', role: 'video_foley', experimental: true, commercialSafe: false, weightsLicense: 'CC BY-NC 4.0' },
  clap: { label: 'Library Match', blurb: 'Semantic sound search', role: 'semantic' },
};

export const MUSICAL_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const TIME_SIGNATURES = [
  { value: '2', label: '2/4' },
  { value: '3', label: '3/4' },
  { value: '4', label: '4/4' },
  { value: '6', label: '6/8' },
];
