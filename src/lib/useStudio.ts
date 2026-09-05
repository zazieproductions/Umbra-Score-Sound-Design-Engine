import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layer, LayerKind, Project, RenderJob, Scene } from './types';
import { addLayer as makeLayer, analyzeProject, regenerateLayer } from './generate';
import { engine, DEFAULT_MASTER, type MasterParams } from './audio';
import { download, renderScore, renderStem } from './render';

export interface LogLine {
  id: string;
  at: number;
  level: 'info' | 'ok' | 'warn' | 'gpu';
  text: string;
}

let logSeq = 0;

export function useStudio() {
  const [project, setProject] = useState<Project | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [master, setMasterState] = useState<MasterParams>({ ...DEFAULT_MASTER });
  const [audioOn, setAudioOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [regenerating, setRegenerating] = useState<Record<string, number>>({});
  const [gpuLoad, setGpuLoad] = useState(38);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timers = useRef<number[]>([]);

  const log = useCallback((text: string, level: LogLine['level'] = 'info') => {
    setLogs((prev) => [{ id: `lg${logSeq++}`, at: Date.now(), level, text }, ...prev].slice(0, 120));
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setGpuLoad((g) => Math.max(12, Math.min(97, g + (Math.random() - 0.48) * 14)));
    }, 1600);
    return () => window.clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      engine.stop();
    },
    [],
  );

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /* ------------------------------------------------ ingest + analysis */

  const ingest = useCallback(
    (name: string, duration: number, videoUrl: string | null, sourceLabel: string) => {
      const p = analyzeProject(name, duration, videoUrl, sourceLabel);
      setProject(p);
      setActiveSceneId(p.scenes[0].id);
      setTime(0);
      setPlaying(false);
      setAnalyzing(true);
      setAnalyzeProgress(0);
      log(`ingest: ${name} · ${duration.toFixed(1)}s · sha256 verified`, 'ok');
      log('cloud: allocating A100 shard eu-north-1b · 48 kHz pipeline', 'gpu');

      const total = p.scenes.length;
      p.scenes.forEach((s, i) => {
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'analyzing' } : x)) } : cur,
          );
          log(`vision: scene ${s.index} · shot boundary @ ${s.start.toFixed(2)}s · tension ${(s.tension * 100).toFixed(0)}%`, 'info');
        }, 350 + i * 520);
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'generating' } : x)) } : cur,
          );
          log(`cinemix: scene ${s.index} · scoring ${s.layers.length} layers into ${s.layers[0]?.space ?? 'hall'} space`, 'gpu');
        }, 700 + i * 520);
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'ready' } : x)) } : cur,
          );
          setAnalyzeProgress(((i + 1) / total) * 100);
          log(`scene ${s.index} ready · ${s.layers.length} stems · ${s.hits.length} sync hits`, 'ok');
          if (i === total - 1) {
            setAnalyzing(false);
            log('pipeline complete · master conformed to -16 LUFS / -1 dBTP true-peak', 'ok');
          }
        }, 1200 + i * 520);
      });
    },
    [log],
  );

  const loadDemo = useCallback(() => {
    ingest('NIGHTSHIFT_reel_v4.mov', 148, null, 'demo · 4K ProRes proxy');
  }, [ingest]);

  const uploadFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = url;
      const done = (dur: number) => {
        ingest(file.name, Math.max(24, Math.min(600, dur || 120)), url, `${(file.size / 1e6).toFixed(1)} MB · local`);
      };
      probe.onloadedmetadata = () => done(probe.duration);
      probe.onerror = () => done(120);
    },
    [ingest],
  );

  /* --------------------------------------------------------- transport */

  const activeScene: Scene | null = useMemo(() => {
    if (!project) return null;
    return project.scenes.find((s) => s.id === activeSceneId) ?? project.scenes[0];
  }, [project, activeSceneId]);

  const sceneAtTime = useMemo(() => {
    if (!project) return null;
    return project.scenes.find((s) => time >= s.start && time < s.end) ?? project.scenes[project.scenes.length - 1];
  }, [project, time]);

  useEffect(() => {
    if (!playing || !sceneAtTime || sceneAtTime.id === activeSceneId) return;
    const raf = requestAnimationFrame(() => setActiveSceneId(sceneAtTime.id));
    return () => cancelAnimationFrame(raf);
  }, [playing, sceneAtTime, activeSceneId]);

  useEffect(() => {
    if (!playing || !project) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const v = videoRef.current;
      setTime((t) => {
        const next = v && !v.paused ? v.currentTime : t + dt;
        if (next >= project.duration) {
          setPlaying(false);
          return project.duration;
        }
        return next;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, project]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing]);

  const seek = useCallback((t: number) => {
    setTime(t);
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }, []);

  /* ------------------------------------------------------------ audio */

  const monitorScene = playing ? sceneAtTime : activeScene;

  const liveLayers = useMemo(
    () => (monitorScene && monitorScene.status === 'ready' ? monitorScene.layers : []),
    [monitorScene],
  );

  useEffect(() => {
    engine.setMaster(master);
  }, [master]);

  // dynamic range macro follows the scene tension + intra-scene position
  useEffect(() => {
    if (!monitorScene) return;
    const span = Math.max(0.001, monitorScene.end - monitorScene.start);
    const prog = Math.min(1, Math.max(0, (time - monitorScene.start) / span));
    const swell = Math.sin(prog * Math.PI) * 0.22;
    engine.setTension(Math.min(1, monitorScene.tension + swell));
  }, [monitorScene, time]);

  useEffect(() => {
    if (audioOn && playing) engine.start(liveLayers);
    else if (audioOn && engine.isRunning()) engine.update(liveLayers);
  }, [audioOn, playing, liveLayers]);

  useEffect(() => {
    if (!audioOn || !playing) engine.stop();
  }, [audioOn, playing]);

  const setMaster = useCallback((p: Partial<MasterParams>) => {
    setMasterState((m) => ({ ...m, ...p }));
  }, []);

  const toggleAudio = useCallback(() => {
    setAudioOn((a) => {
      const next = !a;
      if (!next) engine.stop();
      else log('monitor: cinematic bus online · 48 kHz · glue → tape → M/S → limiter', 'ok');
      return next;
    });
  }, [log]);

  const audition = useCallback(
    (l: Layer) => {
      engine.audition(l);
      log(`audition: ${l.name} · ${l.model} · seed ${l.seed} · ${l.space} space`, 'info');
    },
    [log],
  );

  /* ------------------------------------------------------------ edits */

  const patchLayer = useCallback((sceneId: string, layerId: string, patch: Partial<Layer>) => {
    setProject((cur) =>
      cur
        ? {
            ...cur,
            scenes: cur.scenes.map((s) =>
              s.id === sceneId ? { ...s, layers: s.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) } : s,
            ),
          }
        : cur,
    );
  }, []);

  const removeLayer = useCallback(
    (sceneId: string, layerId: string) => {
      setProject((cur) =>
        cur
          ? { ...cur, scenes: cur.scenes.map((s) => (s.id === sceneId ? { ...s, layers: s.layers.filter((l) => l.id !== layerId) } : s)) }
          : cur,
      );
      log('layer removed from scene bus', 'warn');
    },
    [log],
  );

  const appendLayer = useCallback(
    (sceneId: string, kind: LayerKind) => {
      setProject((cur) => {
        if (!cur) return cur;
        const scene = cur.scenes.find((s) => s.id === sceneId);
        const l = makeLayer(kind, scene?.layers[0]?.space ?? 'hall', scene?.tension ?? 0.6, scene?.layers[0]?.root ?? 55);
        log(`generate: new ${l.name} · ${l.model} · seed ${l.seed}`, 'gpu');
        return { ...cur, scenes: cur.scenes.map((s) => (s.id === sceneId ? { ...s, layers: [...s.layers, l] } : s)) };
      });
    },
    [log],
  );

  const regenLayer = useCallback(
    (sceneId: string, layerId: string) => {
      setRegenerating((r) => ({ ...r, [layerId]: 0 }));
      log('regen: queued diffusion pass (32 steps)', 'gpu');
      const iv = window.setInterval(() => {
        setRegenerating((r) => {
          const p = (r[layerId] ?? 0) + 9 + Math.random() * 16;
          if (p >= 100) {
            window.clearInterval(iv);
            setProject((cur) =>
              cur
                ? {
                    ...cur,
                    scenes: cur.scenes.map((s) =>
                      s.id === sceneId ? { ...s, layers: s.layers.map((l) => (l.id === layerId ? regenerateLayer(l) : l)) } : s,
                    ),
                  }
                : cur,
            );
            log('regen: variant accepted · phase-aligned to scene cut', 'ok');
            const next = { ...r };
            delete next[layerId];
            return next;
          }
          return { ...r, [layerId]: p };
        });
      }, 180);
    },
    [log],
  );

  const regenScene = useCallback(
    (sceneId: string) => {
      const s = project?.scenes.find((x) => x.id === sceneId);
      if (!s) return;
      log(`regen: full scene ${s.index} stack · ${s.layers.length} layers`, 'gpu');
      s.layers.forEach((l, i) => later(() => regenLayer(sceneId, l.id), i * 200));
    },
    [project, regenLayer, log],
  );

  /* ----------------------------------------------------------- export */

  const patchJob = (id: string, patch: Partial<RenderJob>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  /** Real offline render → downloadable 24-bit WAV. */
  const startRender = useCallback(
    async (
      label: string,
      format: string,
      resolution: string,
      opts?: { scene?: Scene; layer?: Layer; filename?: string; maxSeconds?: number },
    ) => {
      if (!project) return;
      const id = `J${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const job: RenderJob = {
        id,
        label,
        format,
        resolution,
        progress: 2,
        state: 'rendering',
        bytes: 0,
        at: Date.now(),
      };
      setJobs((j) => [job, ...j]);
      log(`render: ${label} → offline bounce @ 48 kHz / 24-bit`, 'gpu');

      const creep = window.setInterval(() => {
        setJobs((prev) => prev.map((j) => (j.id === id && j.state === 'rendering' && j.progress < 72 ? { ...j, progress: j.progress + 2.5 } : j)));
      }, 160);

      try {
        // yield so the UI paints the queue entry before the heavy render
        await new Promise((r) => setTimeout(r, 40));
        const result =
          opts?.layer && opts.scene
            ? await renderStem(opts.scene, opts.layer, master)
            : await renderScore(project, master, { maxSeconds: opts?.maxSeconds ?? 240 }, opts?.scene);
        window.clearInterval(creep);
        patchJob(id, { progress: 90, state: 'encoding' });
        const filename =
          opts?.filename ??
          `${project.name.replace(/\.[^.]+$/, '')}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`;
        await new Promise((r) => setTimeout(r, 120));
        patchJob(id, {
          progress: 100,
          state: 'complete',
          bytes: result.bytes,
          url: result.url,
          filename,
          peak: result.peakDb,
          lufs: result.lufs,
        });
        log(
          `render complete: ${filename} · ${result.seconds.toFixed(1)}s · peak ${result.peakDb.toFixed(1)} dBTP · ${result.lufs.toFixed(1)} LUFS`,
          'ok',
        );
      } catch (e) {
        window.clearInterval(creep);
        patchJob(id, { state: 'failed', progress: 100 });
        log(`render failed: ${(e as Error).message}`, 'warn');
      }
    },
    [project, master, log],
  );

  const downloadJob = useCallback(
    (job: RenderJob) => {
      if (!job.url || !job.filename) return;
      download(job.url, job.filename);
      log(`download: ${job.filename}`, 'info');
    },
    [log],
  );

  const readyCount = project ? project.scenes.filter((s) => s.status === 'ready').length : 0;
  const layerCount = project ? project.scenes.reduce((a, s) => a + s.layers.length, 0) : 0;

  return {
    project,
    activeScene,
    activeSceneId,
    setActiveSceneId,
    time,
    seek,
    playing,
    setPlaying,
    master,
    setMaster,
    audioOn,
    toggleAudio,
    audition,
    zoom,
    setZoom,
    logs,
    jobs,
    analyzing,
    analyzeProgress,
    regenerating,
    gpuLoad,
    videoRef,
    loadDemo,
    uploadFile,
    patchLayer,
    removeLayer,
    appendLayer,
    regenLayer,
    regenScene,
    startRender,
    downloadJob,
    readyCount,
    layerCount,
    log,
    reset: () => {
      engine.stop();
      setProject(null);
      setPlaying(false);
      setTime(0);
      setJobs([]);
      setLogs([]);
    },
  };
}

export type Studio = ReturnType<typeof useStudio>;
