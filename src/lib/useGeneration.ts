/* ==================================================================== *
 *  GENERATION STATE
 *  Backend connection, provider status and the generation → clip flow.
 *
 *  Kept separate from useStudio so the procedural engine remains
 *  completely independent of the ML backend: Umbra works with the backend
 *  offline, it just shows the trained providers as unavailable.
 * ==================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  backend,
  BackendOfflineError,
  PROVIDER_FALLBACK,
  type GenerateRequest,
  type GenerationJob,
  type ProviderId,
  type ProviderStatus,
  type RuntimeSummary,
} from './providers';
import { engine } from './audio';
import { makeClip } from './clips';
import { renderProceduralClip } from './proceduralClip';
import type { AudioClip, ClipProvider } from './types';

export type BackendState = 'checking' | 'online' | 'offline' | 'error';

function toClipProvider(id: ProviderId): ClipProvider {
  if (id === 'ace-step' || id === 'stable-audio' || id === 'mmaudio' || id === 'umbra-procedural') return id;
  return 'library';
}

/** Providers rendered by the backend (Umbra Procedural stays in-browser). */
const REMOTE_PROVIDERS: ProviderId[] = ['ace-step', 'stable-audio', 'mmaudio', 'clap'];

export interface GenerationOptions {
  /** called with the finished clip so the caller can place it on the timeline */
  onClip: (clip: AudioClip) => void;
  log: (text: string, level?: 'info' | 'ok' | 'warn' | 'gpu') => void;
}

export function useGeneration({ onClip, log }: GenerationOptions) {
  const [backendState, setBackendState] = useState<BackendState>('checking');
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSummary | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  /** providers that produced a real audio result this session (RUNTIME VERIFIED) */
  const [verified, setVerified] = useState<ProviderId[]>([]);
  const pollers = useRef<Set<string>>(new Set());
  const mounted = useRef(true);

  const markVerified = useCallback((id: ProviderId) => {
    setVerified((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* ------------------------------------------------------ backend probing */

  const refresh = useCallback(async () => {
    try {
      const [list, health] = await Promise.all([backend.providers(), backend.health()]);
      if (!mounted.current) return;
      setProviders(list);
      setRuntime(health.runtime);
      setBackendError(null);
      setBackendState('online');
    } catch (e) {
      if (!mounted.current) return;
      // Offline = nothing is listening. Anything else = the service answered
      // with an error, which is a different, visible state — never collapsed.
      const offline = e instanceof BackendOfflineError;
      setBackendState(offline ? 'offline' : 'error');
      setBackendError(offline ? null : (e as Error).message);
      setProviders([]);
      setRuntime(null);
    }
  }, []);

  useEffect(() => {
    // Deferred so the first poll never sets state during the mount commit.
    const first = window.setTimeout(() => void refresh(), 0);
    const id = window.setInterval(() => void refresh(), 20000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [refresh]);

  /** Provider status including the always-available in-browser engine. */
  const allProviders = useMemo<ProviderStatus[]>(() => {
    if (providers.length) return providers;
    // Backend offline: procedural is still genuinely ready, the rest are not.
    return (['umbra-procedural', ...REMOTE_PROVIDERS] as ProviderId[]).map((id) => ({
      id,
      ...PROVIDER_FALLBACK[id],
      installed: id === 'umbra-procedural',
      ready: id === 'umbra-procedural',
      capabilities: id === 'umbra-procedural' ? ['SFX_GENERATION', 'MUSIC_GENERATION'] : [],
      device: id === 'umbra-procedural' ? 'browser' : null,
      deviceDetail: id === 'umbra-procedural' ? 'Web Audio API' : null,
      model: id === 'umbra-procedural' ? 'umbra-voices-17' : null,
      availableModels: [],
      version: null,
      sizeBytes: null,
      notes:
        id === 'umbra-procedural'
          ? ['Runs entirely in the browser']
          : ['Local ML backend is not running'],
      installHint: id === 'umbra-procedural' ? null : 'python scripts/run_backend.py',
      error: null,
    })) as ProviderStatus[];
  }, [providers]);

  const providerById = useCallback(
    (id: ProviderId) => allProviders.find((p) => p.id === id),
    [allProviders],
  );

  const capable = useCallback(
    (id: ProviderId, capability: string) => !!providerById(id)?.capabilities.includes(capability as never),
    [providerById],
  );

  /* ----------------------------------------------------------- generation */

  const trackJob = useCallback(
    async (job: GenerationJob, placement: { start: number; name: string }) => {
      if (pollers.current.has(job.jobId)) return;
      pollers.current.add(job.jobId);
      setJobs((prev) => [job, ...prev.filter((j) => j.jobId !== job.jobId)].slice(0, 40));

      try {
        const finished = await backend.waitForJob(job.jobId, {
          onTick: (j) => {
            if (!mounted.current) return;
            setJobs((prev) => prev.map((x) => (x.jobId === j.jobId ? j : x)));
          },
        });
        if (!mounted.current) return;
        setJobs((prev) => prev.map((x) => (x.jobId === finished.jobId ? finished : x)));

        if (finished.state !== 'succeeded' || !finished.result) {
          log(`${finished.provider}: ${finished.error ?? 'generation failed'}`, 'warn');
          if (finished.hint) log(`hint: ${finished.hint}`, 'info');
          return;
        }

        const r = finished.result;
        const clip = makeClip({
          audioId: r.audioId,
          url: r.url,
          provider: toClipProvider(finished.provider),
          name: placement.name,
          start: placement.start,
          duration: r.duration,
          sampleRate: r.sampleRate,
          channels: r.channels,
          metadata: {
            ...(r.metadata as AudioClip['metadata']),
            provider: toClipProvider(finished.provider),
          },
        });

        // Decode before it reaches the timeline so playback is instant and any
        // decode failure surfaces here rather than as silence during playback.
        try {
          await engine.prepareClip(clip);
        } catch (e) {
          log(`clip decode failed: ${(e as Error).message}`, 'warn');
          return;
        }

        onClip(clip);
        markVerified(finished.provider);
        log(
          `${finished.provider}: ${r.duration.toFixed(2)}s @ ${r.sampleRate} Hz · ` +
            `${(r.bytes / 1024).toFixed(0)} KB → timeline @ ${placement.start.toFixed(2)}s`,
          'ok',
        );
      } catch (e) {
        log(`generation error: ${(e as Error).message}`, 'warn');
      } finally {
        pollers.current.delete(job.jobId);
        if (mounted.current) setBusy(pollers.current.size > 0);
      }
    },
    [log, onClip, markVerified],
  );

  const generate = useCallback(
    async (req: GenerateRequest, placement?: { start?: number; name?: string }) => {
      const provider = providerById(req.provider);
      if (provider && !provider.ready) {
        log(`${provider.label} is not ready — ${provider.notes[0] ?? 'not installed'}`, 'warn');
        return null;
      }
      /*
       * Umbra Procedural is rendered by the browser's own Web Audio engine,
       * never by the Python service. It therefore works with the backend
       * completely offline.
       */
      if (req.provider === 'umbra-procedural') {
        setBusy(true);
        try {
          const { clip, seconds } = await renderProceduralClip({
            prompt: req.prompt,
            duration: req.duration,
            seed: req.seed ?? null,
            key: req.key ?? null,
            mode: req.mode ?? null,
            bpm: req.bpm ?? null,
            start: placement?.start ?? req.timelineStart ?? 0,
            name: placement?.name ?? req.label ?? 'Procedural cue',
            sceneId: req.sceneId ?? null,
          });
          await engine.prepareClip(clip);
          onClip(clip);
          markVerified('umbra-procedural');
          log(`umbra-procedural: rendered ${seconds.toFixed(2)}s in the browser`, 'ok');
        } catch (e) {
          log(`procedural render failed: ${(e as Error).message}`, 'warn');
        } finally {
          setBusy(false);
        }
        return null;
      }

      setBusy(true);
      try {
        const job = await backend.generate(req);
        log(`${req.provider}: queued ${req.duration}s · ${req.prompt.slice(0, 60)}`, 'gpu');
        void trackJob(job, {
          start: placement?.start ?? req.timelineStart ?? 0,
          name: placement?.name ?? req.label ?? 'Generated cue',
        });
        return job;
      } catch (e) {
        setBusy(false);
        const msg = e instanceof BackendOfflineError
          ? 'Local ML backend is not running — start it with `python scripts/run_backend.py`'
          : (e as Error).message;
        log(msg, 'warn');
        return null;
      }
    },
    [log, providerById, trackJob, onClip, markVerified],
  );

  const cancelJob = useCallback(
    async (jobId: string) => {
      try {
        await backend.cancelJob(jobId);
        log(`job ${jobId} cancelled`, 'info');
        setJobs((prev) => prev.map((j) => (j.jobId === jobId ? { ...j, state: 'cancelled' } : j)));
      } catch (e) {
        log(`could not cancel: ${(e as Error).message}`, 'warn');
      }
    },
    [log],
  );

  const activeJobs = useMemo(
    () => jobs.filter((j) => j.state === 'queued' || j.state === 'running'),
    [jobs],
  );

  return {
    backendState,
    backendError,
    providers: allProviders,
    providerById,
    capable,
    runtime,
    jobs,
    activeJobs,
    busy,
    verified,
    isVerified: (id: ProviderId) => verified.includes(id),
    generate,
    cancelJob,
    refresh,
  };
}

export type Generation = ReturnType<typeof useGeneration>;
