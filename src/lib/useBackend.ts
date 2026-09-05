/**
 * Backend Integration Hook
 * 
 * React hook for connecting to the Python ML backend.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api, checkBackendConnection, type ProviderInfo, type DeviceInfo, type SemanticSearchResult } from './api';

export interface BackendState {
  connected: boolean;
  providers: ProviderInfo[];
  availableProviders: ProviderInfo[];
  device: DeviceInfo | null;
  loading: boolean;
  error: string | null;
}

export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const pollIntervalRef = useRef<number | null>(null);
  const refreshRequestedRef = useRef(false);

  const refresh = useCallback(async () => {
    // Prevent concurrent refreshes
    if (refreshRequestedRef.current) return;
    refreshRequestedRef.current = true;
    
    try {
      const isConnected = await checkBackendConnection();
      
      if (isConnected) {
        const [providersData, deviceInfo] = await Promise.all([
          api.listProviders(),
          api.getDeviceInfo(),
        ]);

        setConnected(true);
        setProviders(providersData.providers);
        setAvailableProviders(providersData.available);
        setDevice(deviceInfo);
        setLoading(false);
        setError(null);
      } else {
        setConnected(false);
        setProviders([]);
        setAvailableProviders([]);
        setDevice(null);
        setLoading(false);
        setError('Backend not connected. Run the Python backend to enable ML features.');
      }
    } catch (err) {
      setConnected(false);
      setProviders([]);
      setAvailableProviders([]);
      setDevice(null);
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to connect to backend');
    } finally {
      refreshRequestedRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Defer initial check to avoid the sync setState issue
    const timerId = requestAnimationFrame(() => {
      refresh();
    });

    // Set up polling after initial check
    pollIntervalRef.current = window.setInterval(refresh, 30000);
    
    return () => {
      cancelAnimationFrame(timerId);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [refresh]);

  return {
    connected,
    providers,
    availableProviders,
    device,
    loading,
    error,
    refresh,
    isProviderReady: useCallback((name: string) =>
      availableProviders.some(p => p.name === name),
    [availableProviders]),
    getProvider: useCallback((name: string) =>
      providers.find(p => p.name === name),
    [providers]),
  };
}

export interface GenerationState {
  generating: boolean;
  results: GenerationResult[];
  error: string | null;
}

export interface GenerationResult {
  id: string;
  provider: string;
  status: 'pending' | 'complete' | 'failed';
  error?: string;
}

export function useGeneration() {
  const [state, setState] = useState<GenerationState>({
    generating: false,
    results: [],
    error: null,
  });

  const generate = useCallback(async (
    provider: string,
    params: {
      prompt?: string;
      negativePrompt?: string;
      duration: number;
      seed?: number;
      numVariants?: number;
      sourceVideo?: string;
      sourceRangeStart?: number;
      sourceRangeEnd?: number;
    }
  ) => {
    setState({
      generating: true,
      results: [],
      error: null,
    });

    try {
      const results = await api.generate({
        provider: provider as 'procedural' | 'stable_audio' | 'mmaudio' | 'clap_search',
        prompt: params.prompt,
        negative_prompt: params.negativePrompt,
        duration: params.duration,
        seed: params.seed,
        num_variants: params.numVariants ?? 1,
        source_video: params.sourceVideo,
        source_range_start: params.sourceRangeStart,
        source_range_end: params.sourceRangeEnd,
        sample_rate: 48000,
        normalize: true,
      });

      setState({
        generating: false,
        results: results.map(r => ({
          id: r.id,
          provider: r.provider,
          status: r.error ? 'failed' : 'complete',
          error: r.error,
        })),
        error: null,
      });

      return results;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Generation failed';
      setState({
        generating: false,
        results: [],
        error: errorMsg,
      });
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setState({
      generating: false,
      results: [],
      error: null,
    });
  }, []);

  return {
    ...state,
    generate,
    reset,
  };
}

export function useSemanticSearch() {
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (query: string, limit: number = 10) => {
    setSearching(true);
    setError(null);

    try {
      const response = await api.search({
        query,
        limit,
        include_generated: true,
        include_imported: true,
      });

      setResults(response.results);
      setSearching(false);
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setSearching(false);
      throw err;
    }
  }, []);

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return {
    searching,
    results,
    error,
    search,
    clear,
  };
}

interface DetectedScene {
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

export function useSceneDetection() {
  const [detecting, setDetecting] = useState(false);
  const [scenes, setScenes] = useState<DetectedScene[]>([]);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async (
    videoPath: string,
    options?: {
      threshold?: number;
      minSceneLen?: number;
      detector?: 'content' | 'threshold';
    }
  ) => {
    setDetecting(true);
    setError(null);

    try {
      const response = await api.detectScenes(
        videoPath,
        options?.threshold,
        options?.minSceneLen,
        options?.detector
      );

      setScenes(response.scenes);
      setDetecting(false);
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection failed');
      setDetecting(false);
      throw err;
    }
  }, []);

  const clear = useCallback(() => {
    setScenes([]);
    setError(null);
  }, []);

  return {
    detecting,
    scenes,
    error,
    detect,
    clear,
  };
}
