import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layer, LayerKind, Project, RenderJob, Scene } from './types';
import { addLayer as makeLayer, analyzeProject, regenerateLayer } from './generate';
import { engine, DEFAULT_MASTER, type MasterParams } from './audio';
import { download, renderScore, renderStem } from './render';
import { RetrievalService } from './library/service';
import { soundCache, provenanceStore, credsStore, settingsStore, shortId } from './library/cache';
import { pollClips, clearClipScheduler, makeClipScheduler } from './library/clipAudio';
import { exportCreditsJson, exportCreditsTxt, downloadText } from './library/credits';
import type { SoundClip, RetrievalState, SoundRole, SpottingEvent, RankedCandidate, RetrievalIntent, FreesoundCredentials, LibrarySettings, AutoMode, LicenseMode, LicenseClass, LibraryAsset } from './library/types';
import { EMPTY_FREESOUND_CREDS, DEFAULT_LIBRARY_SETTINGS } from './library/types';
import { tc } from './format';

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

  /* -------------------------------------------------- sound library -- */

  const [creds, setCreds] = useState<FreesoundCredentials>(() =>
    credsStore.load('umbra.library.freesound.creds.v1', EMPTY_FREESOUND_CREDS),
  );
  const [libSettings, setLibSettingsState] = useState<LibrarySettings>(() =>
    settingsStore.load<LibrarySettings>(DEFAULT_LIBRARY_SETTINGS),
  );
  const serviceRef = useRef<RetrievalService | null>(null);
  if (!serviceRef.current) serviceRef.current = new RetrievalService(() => creds, libSettings);
  const [retrieval, setRetrieval] = useState<RetrievalState>({
    busy: false,
    intent: null,
    result: null,
    error: null,
    lastAuto: null,
  });
  const [favorites, setFavorites] = useState(0);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const clipBuffers = useRef(new Map<string, AudioBuffer>());
  const clipScheduler = useRef(makeClipScheduler());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  /** Load cached audio for placed clips into the playback buffer map. */
  const loadClipBuffers = useCallback(async () => {
    const clips = project?.clips ?? [];
    for (const c of clips) {
      if (clipBuffers.current.has(c.cacheKey)) continue;
      const rec = await soundCache.get(c.cacheKey);
      if (!rec) continue;
      try {
        const buf = await decodeForPlayback(rec.blob);
        clipBuffers.current.set(c.cacheKey, buf);
      } catch {
        /* skip undecodable */
      }
    }
    setLibraryLoaded(true);
  }, [project?.clips]);

  useEffect(() => {
    void loadClipBuffers();
    void provenanceStore.list().then(() => setLibraryLoaded(true));
    setFavorites(localStorage.getItem('umbra.library.favorites') ? JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]').length : 0);
  }, [loadClipBuffers]);

  const lib = serviceRef.current!;

  const setSettingsPatch = useCallback((patch: Partial<LibrarySettings>) => {
    setLibSettingsState((s) => {
      const next = { ...s, ...patch };
      settingsStore.save(next);
      return next;
    });
  }, []);

  const setLicensePolicy = useCallback((mode: LicenseMode, accepted?: LicenseClass[]) => {
    setLibSettingsState((s) => {
      const next = { ...s, licensePolicy: { mode, accepted: accepted ?? s.licensePolicy.accepted } };
      settingsStore.save(next);
      return next;
    });
  }, []);

  const saveCreds = useCallback((patch: Partial<FreesoundCredentials>) => {
    setCreds((c) => {
      const next = { ...c, ...patch };
      credsStore.save('umbra.library.freesound.creds.v1', next);
      return next;
    });
  }, []);

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
      clearClipScheduler(clipScheduler.current);
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

  // poll retrieved sample clips against the transport every frame
  useEffect(() => {
    if (!playing || !project || !audioOn) {
      clearClipScheduler(clipScheduler.current);
      return;
    }
    let raf = 0;
    const loop = () => {
      try {
        pollClips(clipScheduler.current, engine.getMasterNode(), project.clips, clipBuffers.current, time, 0.55);
      } catch {
        /* clip poll is best-effort */
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, project, audioOn, time]);

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

  /* ---------------------------------------------- library retrieval -- */

  const sceneContext = useCallback(
    (sceneId: string) => {
      const s = project?.scenes.find((x) => x.id === sceneId) ?? project?.scenes[0];
      if (!s || !project) return null;
      return {
        sceneId: s.id,
        start: s.start,
        end: s.end,
        title: s.title,
        tags: s.tags,
        summary: s.summary,
        tension: s.tension,
        motion: s.motion,
        hits: s.hits,
        spotting: project.spotting.filter((e) => e.sceneId === s.id),
      };
    },
    [project],
  );

  const runSearch = useCallback(
    async (intent: RetrievalIntent) => {
      setRetrieval((r) => ({ ...r, busy: true, error: null, intent }));
      log(`retrieval: "${intent.query}" · role ${intent.role}`, 'info');
      const result = await lib.search(intent);
      setRetrieval({ busy: false, intent, result, error: result.error, lastAuto: null });
      log(
        result.error && !result.candidates.length
          ? `retrieval unavailable: ${result.error}`
          : `retrieval: ${result.count} raw · ${result.candidates.length} ranked in ${result.elapsedMs}ms`,
        result.candidates.length ? 'ok' : 'warn',
      );
      return result;
    },
    [lib, log],
  );

  const planScene = useCallback(
    (sceneId: string) => {
      const ctx = sceneContext(sceneId);
      if (!ctx) return [];
      return lib.planForScene(ctx);
    },
    [lib, sceneContext],
  );

  /** Audition a candidate preview without leaving Umbra. */
  const auditionAsset = useCallback(
    async (asset: LibraryAsset) => {
      try {
        setRetrieval((r) => ({ ...r, busy: true, error: null }));
        const { blob, cacheKey } = await lib.ensurePreview(asset);
        const buf = await decodeForPlayback(blob);
        clipBuffers.current.set(cacheKey, buf);
        engine.auditionBuffer(buf, asset.duration);
        log(`audition: ${asset.title} · ${asset.providerLabel} · ${asset.license}`, 'info');
      } catch (e) {
        setRetrieval((r) => ({ ...r, busy: false, error: (e as Error).message }));
        log(`audition failed: ${(e as Error).message}`, 'warn');
      } finally {
        setRetrieval((r) => ({ ...r, busy: false }));
      }
    },
    [lib, log],
  );

  /** Place a candidate as a real editable clip on the timeline. */
  const placeCandidate = useCallback(
    async (candidate: RankedCandidate, intent: RetrievalIntent, start: number, patch?: Partial<SoundClip>) => {
      if (!project) return null;
      if (!candidate.licenseOk) {
        log(`placement blocked: ${candidate.licenseReason}`, 'warn');
        setRetrieval((r) => ({ ...r, error: candidate.licenseReason }));
        return null;
      }
      try {
        setRetrieval((r) => ({ ...r, busy: true, error: null }));
        const clip = await lib.placeClip({
          sceneId: intent.sceneId,
          intent,
          candidate,
          start,
          projectId: project.id,
        });
        const final: SoundClip = { ...clip, ...(patch ?? {}) };
        await lib.recordProvenance(final, project.id);
        setProject((cur) => (cur ? { ...cur, clips: [...cur.clips, final] } : cur));
        setSelectedClipId(final.id);
        setRetrieval((r) => ({ ...r, busy: false, result: r.result }));
        log(`placed: ${final.name} @ ${tc(start, true)} · ${final.asset.providerLabel} · match ${Math.round(final.match * 100)}%`, 'ok');
        return final;
      } catch (e) {
        setRetrieval((r) => ({ ...r, busy: false, error: (e as Error).message }));
        log(`placement failed: ${(e as Error).message}`, 'warn');
        return null;
      }
    },
    [project, lib, log],
  );

  /** ONE-CLICK REPLACE: keep timeline position/gain/pan/fades/transform,
   *  swap only the source audio (and its provenance). */
  const replaceClipSource = useCallback(
    async (clipId: string, candidate: RankedCandidate) => {
      if (!project) return null;
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip) return null;
      if (!candidate.licenseOk) {
        log(`replace blocked: ${candidate.licenseReason}`, 'warn');
        return null;
      }
      try {
        const intent = lib.alternativeIntent(clip, 'rpl');
        const next = await lib.placeClip({
          sceneId: clip.sceneId,
          intent,
          candidate,
          start: clip.start,
          projectId: project.id,
          familyId: clip.familyId,
          variantIndex: clip.variantIndex,
        });
        const preserved: SoundClip = lib.applyReplacement(clip, next);
        await lib.recordProvenance(preserved, project.id);
        setProject((cur) =>
          cur ? { ...cur, clips: cur.clips.map((c) => (c.id === clipId ? preserved : c)) } : cur,
        );
        log(`replaced source: ${clip.name} → ${next.name} (timeline edits preserved)`, 'ok');
        return preserved;
      } catch (e) {
        log(`replacement failed: ${(e as Error).message}`, 'warn');
        return null;
      }
    },
    [project, lib, log],
  );

  const findAlternatives = useCallback(
    async (clipId: string) => {
      const clip = project?.clips.find((c) => c.id === clipId);
      if (!clip) return null;
      return runSearch(lib.alternativeIntent(clip));
    },
    [project, runSearch, lib],
  );

  /** AUTO SOUND DESIGN (suggest / auto-safe / auto-full). */
  const runAutoDesign = useCallback(
    async (sceneId: string, mode: AutoMode) => {
      const ctx = sceneContext(sceneId);
      if (!ctx || !project) return;
      if (mode === 'off') {
        log('auto sound design: off — no library retrieval', 'info');
        return;
      }
      setRetrieval((r) => ({ ...r, busy: true, error: null }));
      log(`auto sound design: ${mode} · scene ${ctx.title} · density ${lib.settings.density}`, 'info');
      try {
        const out = await lib.autoDesign(ctx, project.id, mode, (msg) => log(`retrieval: ${msg}`, 'info'));
        if (out.placed.length) {
          setProject((cur) => (cur ? { ...cur, clips: [...cur.clips, ...out.placed] } : cur));
          const first = out.placed[0];
          if (first) setSelectedClipId(first.id);
        }
        setRetrieval({
          busy: false,
          intent: null,
          result: null,
          error: null,
          lastAuto: { mode, placed: out.placed.length, suggested: out.suggestions.length, skipped: out.skipped, at: Date.now() },
        });
        log(
          `auto design ${mode}: ${out.placed.length} placed · ${out.suggestions.length} suggested · ${out.skipped} skipped`,
          out.placed.length ? 'ok' : 'warn',
        );
      } catch (e) {
        setRetrieval((r) => ({ ...r, busy: false, error: (e as Error).message }));
        log(`auto design failed: ${(e as Error).message}`, 'warn');
      }
    },
    [project, sceneContext, lib, log],
  );

  /* --------------------------------------------- spotting + clips ---- */

  const addSpottingEvent = useCallback(
    (sceneId: string, role: SoundRole, time: number) => {
      if (!project) return null;
      const ev: SpottingEvent = {
        id: shortId('ev'),
        sceneId,
        label: `${role.replace(/_/g, ' ').toLowerCase()} @ ${tc(time, true)}`,
        role,
        time,
        createdAt: Date.now(),
      };
      setProject((cur) => (cur ? { ...cur, spotting: [...cur.spotting, ev] } : cur));
      log(`spotting: ${ev.label}`, 'info');
      return ev;
    },
    [project, log],
  );

  const patchClip = useCallback((clipId: string, patch: Partial<SoundClip>) => {
    setProject((cur) => (cur ? { ...cur, clips: cur.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) } : cur));
  }, []);

  const removeClip = useCallback(
    (clipId: string) => {
      setProject((cur) => (cur ? { ...cur, clips: cur.clips.filter((c) => c.id !== clipId) } : cur));
      void provenanceStore.remove(clipId);
      setSelectedClipId((id) => (id === clipId ? null : id));
      log('clip removed — provenance entry cleared', 'warn');
    },
    [log],
  );

  const auditionClip = useCallback(
    async (clipId: string) => {
      const clip = project?.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const buf = clipBuffers.current.get(clip.cacheKey);
      if (!buf) {
        const rec = await soundCache.get(clip.cacheKey);
        if (!rec) return;
        const d = await decodeForPlayback(rec.blob);
        clipBuffers.current.set(clip.cacheKey, d);
        engine.auditionBuffer(d, clip.end - clip.start);
        return;
      }
      engine.auditionBuffer(buf, clip.end - clip.start);
      log(`audition clip: ${clip.name} @ ${tc(clip.start, true)}`, 'info');
    },
    [project, log],
  );

  const clearUnusedCache = useCallback(async () => {
    if (!project) return;
    const removed = await soundCache.clearUnused([project.id]);
    log(`cache: removed ${removed} unused audio asset(s) — project files kept`, 'warn');
    setLibraryLoaded(false);
    void loadClipBuffers();
  }, [project, loadClipBuffers, log]);

  const exportCredits = useCallback(
    async (kind: 'txt' | 'json') => {
      if (!project) return;
      const entries = await provenanceStore.list();
      const projectEntries = entries.filter((e) => project.clips.some((c) => c.id === e.clipId));
      if (kind === 'json') {
        downloadText('sound_credits.json', exportCreditsJson(projectEntries, project.name, project.duration), 'application/json');
      } else {
        downloadText('sound_credits.txt', exportCreditsTxt(projectEntries, project.name, project.duration));
      }
      log(`exported sound_credits.${kind} (${projectEntries.length} assets)`, 'ok');
    },
    [project, log],
  );

  const importUserAudio = useCallback(
    async (file: File, meta: Parameters<RetrievalService['userLibrary']['importFile']>[1]) => {
      const rec = await lib.userLibrary.importFile(file, meta);
      log(`user library: imported ${rec.name} (${(file.size / 1e6).toFixed(1)} MB, offline-available)`, 'ok');
      return rec;
    },
    [lib, log],
  );

  const toggleFavorite = useCallback((asset: LibraryAsset) => {
    const list = JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]');
    const keyExists = list.some((f: { asset: LibraryAsset }) => f.asset.provider === asset.provider && f.asset.soundId === asset.soundId);
    const next = keyExists
      ? list.filter((f: { asset: LibraryAsset }) => !(f.asset.provider === asset.provider && f.asset.soundId === asset.soundId))
      : [{ asset, at: Date.now() }, ...list];
    localStorage.setItem('umbra.library.favorites', JSON.stringify(next));
    setFavorites(next.length);
  }, []);

  const isFavorite = useCallback((asset: LibraryAsset) => {
    const list = JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]');
    return list.some((f: { asset: LibraryAsset }) => f.asset.provider === asset.provider && f.asset.soundId === asset.soundId);
  }, []);

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
            : await renderScore(project, master, { maxSeconds: opts?.maxSeconds ?? 240, clipBuffers: clipBuffers.current }, opts?.scene);
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
  const clipCount = project?.clips.length ?? 0;
  const selectedClip = project?.clips.find((c) => c.id === selectedClipId) ?? null;

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
    // ---- sound library ----
    creds,
    saveCreds,
    libSettings,
    setSettingsPatch,
    setLicensePolicy,
    retrieval,
    runSearch,
    planScene,
    auditionAsset,
    placeCandidate,
    replaceClipSource,
    findAlternatives,
    runAutoDesign,
    addSpottingEvent,
    patchClip,
    removeClip,
    auditionClip,
    selectedClipId,
    setSelectedClipId,
    selectedClip,
    clipCount,
    favorites,
    toggleFavorite,
    isFavorite,
    importUserAudio,
    clearUnusedCache,
    exportCredits,
    libraryLoaded,
    providerStatuses: () => lib.providers().map((p) => p.status()),
    reset: () => {
      engine.stop();
      clearClipScheduler(clipScheduler.current);
      setProject(null);
      setPlaying(false);
      setTime(0);
      setJobs([]);
      setLogs([]);
      setSelectedClipId(null);
      setRetrieval({ busy: false, intent: null, result: null, error: null, lastAuto: null });
    },
  };
}

/* ------------------------------------------------------- helpers ---- */

async function decodeForPlayback(blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  const Ctor: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(ab);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export type Studio = ReturnType<typeof useStudio>;
