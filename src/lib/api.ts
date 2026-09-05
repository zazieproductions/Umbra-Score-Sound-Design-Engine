/**
 * Umbra Score API Client
 * 
 * TypeScript client for the Python ML backend.
 */

const API_BASE = 'http://localhost:8000';

export interface ProviderInfo {
  name: string;
  display_name: string;
  description: string;
  capabilities: string[];
  device: 'cuda' | 'mps' | 'cpu';
  status: 'ready' | 'not_installed' | 'model_missing' | 'unavailable' | 'error';
  model_name?: string;
}

export interface GenerationRequest {
  provider: 'procedural' | 'stable_audio' | 'mmaudio' | 'clap_search';
  prompt?: string;
  negative_prompt?: string;
  duration: number;
  seed?: number;
  num_variants: number;
  scene_id?: string;
  timeline_start?: number;
  source_video?: string;
  source_range_start?: number;
  source_range_end?: number;
  sample_rate: number;
  normalize: boolean;
}

export interface GeneratedAudio {
  id: string;
  filepath: string;
  duration: number;
  sample_rate: number;
  channels: number;
  provider: string;
  model?: string;
  prompt?: string;
  negative_prompt?: string;
  seed?: number;
  variant_index?: number;
  metadata: Record<string, unknown>;
  waveform_peaks?: number[];
  embedding?: number[];
  error?: string;
  status: string;
}

export interface SemanticSearchRequest {
  query: string;
  limit: number;
  include_generated: boolean;
  include_imported: boolean;
  provider?: string;
}

export interface SemanticSearchResult {
  audio_id: string;
  filepath: string;
  similarity: number;
  prompt?: string;
  provider: string;
  duration: number;
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResult[];
  total: number;
  search_time_ms: number;
}

export interface DetectedScene {
  index: number;
  start_frame: number;
  end_frame: number;
  start_time: number;
  end_time: number;
  duration: number;
  cut_type: string;
  confidence: number;
  thumbnail_path?: string;
}

export interface SceneDetectionResponse {
  video_path: string;
  total_frames: number;
  fps: number;
  duration: number;
  scenes: DetectedScene[];
  total_scenes: number;
  processing_time_seconds: number;
}

export interface DeviceInfo {
  device: 'cuda' | 'mps' | 'cpu';
  device_name: string;
  torch_available: boolean;
  cuda_available: boolean;
  mps_available: boolean;
  gpu_name?: string;
  gpu_memory_total?: number;
}

export interface Job {
  id: string;
  type: string;
  state: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export interface ApiHealth {
  status: string;
  version: string;
  providers: number;
}

class UmbraApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || `API error: ${response.status}`);
    }

    return response.json();
  }

  // Health & Status
  async health(): Promise<ApiHealth> {
    return this.request<ApiHealth>('/health');
  }

  async listProviders(): Promise<{ providers: ProviderInfo[]; available: ProviderInfo[] }> {
    return this.request('/api/providers');
  }

  async getProvider(name: string): Promise<ProviderInfo> {
    return this.request(`/api/providers/${name}`);
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request('/api/system/device');
  }

  // Generation
  async generate(request: GenerationRequest): Promise<GeneratedAudio[]> {
    return this.request('/api/generate', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getAudio(id: string): Promise<GeneratedAudio> {
    return this.request(`/api/audio/${id}`);
  }

  async downloadAudio(id: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/api/audio/${id}/download`);
    if (!response.ok) {
      throw new Error('Download failed');
    }
    return response.blob();
  }

  async getWaveform(id: string, peaks: number = 200): Promise<{ audio_id: string; peaks: number[] }> {
    return this.request(`/api/audio/${id}/waveform?peaks=${peaks}`);
  }

  async deleteAudio(id: string): Promise<void> {
    await this.request(`/api/audio/${id}`, { method: 'DELETE' });
  }

  // Semantic Search
  async search(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
    return this.request('/api/search', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async indexAudio(
    audioId: string,
    filepath: string,
    prompt?: string,
    duration?: number
  ): Promise<{ indexed: boolean; audio_id: string }> {
    const params = new URLSearchParams({
      audio_id: audioId,
      filepath,
    });
    if (prompt) params.append('prompt', prompt);
    if (duration !== undefined) params.append('duration', String(duration));

    return this.request(`/api/index?${params}`, { method: 'POST' });
  }

  // Scene Detection
  async detectScenes(
    videoPath: string,
    threshold: number = 30,
    minSceneLen: number = 0.5,
    detector: string = 'content'
  ): Promise<SceneDetectionResponse> {
    return this.request('/api/scenes/detect', {
      method: 'POST',
      body: JSON.stringify({
        video_path: videoPath,
        threshold,
        min_scene_len: minSceneLen,
        detector,
        show_progress: true,
      }),
    });
  }

  // Jobs
  async listJobs(state?: string): Promise<{ jobs: Job[] }> {
    const endpoint = state ? `/api/jobs?state=${state}` : '/api/jobs';
    return this.request(endpoint);
  }

  async getJob(id: string): Promise<Job> {
    return this.request(`/api/jobs/${id}`);
  }

  async cancelJob(id: string): Promise<void> {
    await this.request(`/api/jobs/${id}/cancel`, { method: 'POST' });
  }

  // Storage
  async getStorageStats(): Promise<{
    audio_files: number;
    metadata_files: number;
    audio_size_bytes: number;
    total_size_bytes: number;
  }> {
    return this.request('/api/storage/stats');
  }

  async cleanupStorage(): Promise<{ removed: number }> {
    return this.request('/api/storage/cleanup', { method: 'POST' });
  }
}

// Singleton instance
export const api = new UmbraApiClient();

// Backend connection check
export async function checkBackendConnection(): Promise<boolean> {
  try {
    await api.health();
    return true;
  } catch {
    return false;
  }
}
