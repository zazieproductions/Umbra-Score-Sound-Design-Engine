/* ==================================================================== *
 *  PROJECT STATE (useStudio)
 *
 *  Owns:
 *    the Project object, transport, clip editing (move/trim/split/
 *    fade/gain/pan/mute/solo), export orchestration, and wiring the
 *    library retrieval service into the timeline.
 *
 *  Does not own:
 *    audio rendering (audio.ts / render.ts) · provider HTTP (useGeneration
 *    + providers.ts) · retrieval ranking/caching (lib/library/).
 *
 *  Invariant:
 *    every audible timeline object is an AudioClip (lib/types.ts).
 *    Retrieval results are converted at the boundary and never stored
 *    in their raw provider shape.
 * ==================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioClip, Layer, LayerKind, Project, RenderJob, Scene } from './types';
import { soundClipToAudioClip } from './types';
import { addLayer as makeLayer, analyzeProject, regenerateLayer } from './generate';
import { engine, DEFAULT_MASTER, type MasterParams } from './audio';
import { download, renderClipStem, renderScore, renderStem } from './render';
import { formatReport } from './quality';
import { clipEnd, moveClip, splitClip, trimClip } from './clips';
import { discardLatestSavedProject, hydrateClips, loadLatestSnapshot, persistProject } from './persistence';
import { useGeneration } from './useGeneration';
import type { GenerateRequest } from './providers';
// Library imports — preserve PR7 retrieval completely
import { RetrievalService, type AutoPlacementDetail } from './library/service';
import { soundCache, provenanceStore, purgeLegacyFreesoundCredentials, settingsStore, shortId } from './library/cache';
import { exportCreditsJson, exportCreditsTxt, downloadText } from './library/credits';
import { analyzeVideoUrl, condenseEvents, type EventEnvironment } from './library/videoAnalysis';
import type { SoundClip, RetrievalState, SoundRole, SpottingEvent, RankedCandidate, RetrievalIntent, FreesoundConnection, LibrarySettings, AutoMode, LicenseMode, LicenseClass, LibraryAsset, SoundEventCandidate, SoundEventAnalysis, AutoPlacementReport } from './library/types';
import { EMPTY_FREESOUND_CONNECTION, DEFAULT_LIBRARY_SETTINGS } from './library/types';
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
  // contextual video analysis (autonomous sound design driver) — real
  // browser-pixel work with its own honest progress state
  const [analyzingVideo, setAnalyzingVideo] = useState(false);
  const [videoAnalysisLog, setVideoAnalysisLog] = useState<string | null>(null);
  const [lastAutoReports, setLastAutoReports] = useState<AutoPlacementReport[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** in/out points on the project timeline used to target generation */
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /* ------------------------------------------------- draft persistence -- */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);

  /* -------------------------------------------------- sound library -- */
  /**
   * Freesound connection state, mirrored from the backend. There is no
   * credential here — the browser only knows whether the backend has a key
   * and whether Freesound accepted it.
   */
  const [freesoundConnection, setFreesoundConnection] = useState<FreesoundConnection>(EMPTY_FREESOUND_CONNECTION);
  const [libSettings, setLibSettingsState] = useState<LibrarySettings>(() =>
    settingsStore.load<LibrarySettings>(DEFAULT_LIBRARY_SETTINGS),
  );
  const serviceRef = useRef<RetrievalService | null>(null);
  // eslint-disable-next-line react-hooks/refs -- lazy service init: created once, never reassigned
  if (!serviceRef.current) serviceRef.current = new RetrievalService(libSettings);
  const [retrieval, setRetrieval] = useState<RetrievalState>({
    busy: false,
    intent: null,
    result: null,
    error: null,
    lastAuto: null,
  });
  const [favorites, setFavorites] = useState(0);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  // Library decoded buffers kept in engine.clipBuffers now, but we also keep a ref for preview audition
  const clipBuffersRef = useRef(new Map<string, AudioBuffer>());

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

  /**
   * Ask the backend how Freesound stands. `force` triggers a live probe of
   * the key instead of reusing the backend's 60 s cache.
   */
  const refreshFreesoundStatus = useCallback(async (force = false) => {
    const provider = lib.freesound;
    const status = force ? await provider.refreshStatus() : await provider.status({ force: true });
    const remote = provider.remoteStatus();
    setFreesoundConnection({
      configured: remote?.configured ?? false,
      connected: remote?.connected ?? null,
      keyHint: remote?.keyHint ?? null,
      quality: remote?.oauth.quality ?? 'preview',
      reason: status.reason ?? remote?.reason ?? null,
      hint: remote?.hint ?? null,
      probed: remote?.probed ?? false,
      loaded: true,
    });
    return status;
  }, [lib]);

  const log = useCallback((text: string, level: LogLine['level'] = 'info') => {
    setLogs((prev) => [{ id: `lg${logSeq++}`, at: Date.now(), level, text }, ...prev].slice(0, 120));
  }, []);

  /* Mount-only sync from IndexedDB/localStorage into local state — intentionally runs once. */
  /* eslint-disable react-hooks/set-state-in-effect -- mount-only external-store sync */
  useEffect(() => {
    void provenanceStore.list().then(() => setLibraryLoaded(true));
    try { setFavorites(JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]').length); } catch { setFavorites(0); }
    // The Freesound key moved to the backend: drop any copy an older build
    // left in this browser profile, then mirror the backend's status.
    const purged = purgeLegacyFreesoundCredentials();
    if (purged.length > 0) {
      log(
        `removed ${purged.length} legacy Freesound credential(s) from this browser — the API key now lives in the backend .env only`,
        'warn',
      );
    }
    void refreshFreesoundStatus();
    // mount-only by design: the purge and the first status mirror run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(
    () => () => {
      engine.stop();
    },
    [],
  );

  /* Restore the newest local project draft once on mount. Blob URLs died with
   * the previous page — hydration rebuilds them from the sound cache or by
   * re-rendering deterministic procedural clips, and reports what could not
   * be rebuilt by name. State updates happen inside the async continuation,
   * never synchronously in the effect body. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await loadLatestSnapshot();
        if (!snap || cancelled) return;
        const { project, warnings } = await hydrateClips(snap.project);
        if (cancelled) return;
        engine.setMaster(snap.master);
        setProject(project);
        setActiveSceneId(project.scenes[0]?.id ?? null);
        setMasterState(snap.master);
        setSavedAt(snap.savedAt);
        setHasSavedDraft(true);
        setSaveState('saved');
        log(`restored project "${project.name}" from the local draft (${new Date(snap.savedAt).toLocaleTimeString()})`, 'ok');
        warnings.forEach((w) => log(w, 'warn'));
        if (snap.hadLocalVideo && !project.videoUrl) {
          log('the source video was a local file and cannot be restored after a reload — picture offline, audio and edits intact', 'warn');
        }
      } catch (e) {
        log(`could not restore the saved project: ${(e as Error).message}`, 'warn');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [log]);

  /* Debounced draft autosave. The project object is the durable record; audio
   * blobs stay in the sound cache keyed to this project id. */
  useEffect(() => {
    if (!project) return;
    const t = window.setTimeout(() => {
      setSaveState('saving');
      persistProject(project, master)
        .then(() => {
          setSavedAt(Date.now());
          setHasSavedDraft(true);
          setSaveState('saved');
          setSaveError(null);
        })
        .catch((e: unknown) => {
          setSaveState('error');
          setSaveError((e as Error).message);
          log(`autosave failed: ${(e as Error).message}`, 'warn');
        });
    }, 900);
    return () => window.clearTimeout(t);
  }, [project, master, log]);

  /* -------------------------------------------- contextual vision ---- */

  /**
   * Drive the real video through the browser pixel analyzer, scene by
   * scene. Only pixel evidence + that scene's metadata produce events;
   * the result lands on the Project so AUTO SOUND DESIGN can consume it.
   */
  const analyzeProjectVideo = useCallback(
    async (projectRef: Project) => {
      if (projectRef.soundAnalysis && projectRef.soundAnalysis.events.length) return;
      if (!projectRef.videoUrl) {
        setVideoAnalysisLog('video analysis: no video file on this project (demo load) — using scene text only');
        return;
      }
      setAnalyzingVideo(true);
      try {
        const collected: SoundEventCandidate[] = [];
        let frameCount = 0;
        let fpsUsed = 0;
        let partial = false;
        for (const scene of projectRef.scenes) {
          const span = Math.max(1, scene.end - scene.start);
          const maxFrames = Math.max(30, Math.min(220, Math.round(span * 6)));
          const fps = Math.max(1, Math.min(8, Math.round(maxFrames / span)));
          const env: EventEnvironment = {
            sceneId: scene.id,
            sceneStart: scene.start,
            sceneEnd: scene.end,
            title: scene.title,
            tags: scene.tags,
            summary: scene.summary,
          };
          const r = await analyzeVideoUrl(projectRef.videoUrl, env, {
            fps,
            maxFrames,
            onProgress: (n) => log(`vision: scene ${scene.index} · ${n}/${maxFrames} frames`, 'info'),
          });
          if (!r.available) setVideoAnalysisLog(`video analysis: ${r.message}`);
          frameCount += r.frameCount;
          fpsUsed = Math.max(fpsUsed, r.fps);
          if (r.partial) partial = true;
          collected.push(...r.events);
        }
        const events = condenseEvents(collected, 40);
        const analysis: SoundEventAnalysis = {
          available: events.length > 0,
          method: 'browser-pixel',
          frameCount,
          fps: fpsUsed,
          duration: projectRef.duration,
          partial,
          events,
          message: events.length
            ? `${events.length} event candidate(s) from ${frameCount} frames — moments: ${events.map((e) => e.timestamp.toFixed(1)).join(', ')}`
            : `No motion-derived sound events across ${frameCount} frames — negative space preserved`,
          analyzedAt: Date.now(),
        };
        setVideoAnalysisLog(`video analysis: ${analysis.message}`);
        setProject((cur) => (cur && cur.id === projectRef.id ? { ...cur, soundEvents: events, soundAnalysis: analysis } : cur));
        log(`vision: ${analysis.message}`, events.length ? 'ok' : 'info');
      } finally {
        setAnalyzingVideo(false);
      }
    },
    [log],
  );

  const reanalyzeVideo = useCallback(async () => {
    if (!project) return;
    const cleared = { ...project, soundEvents: [] as SoundEventCandidate[], soundAnalysis: undefined as SoundEventAnalysis | undefined };
    setProject(cleared);
    setVideoAnalysisLog('video analysis: re-running…');
    await analyzeProjectVideo(cleared);
  }, [project, analyzeProjectVideo]);

  /* ------------------------------------------------ ingest + analysis */

  const ingest = useCallback(
    (name: string, duration: number, videoUrl: string | null, sourceLabel: string, resolution?: string) => {
      // Deterministic structural plan — computed synchronously so scenes are
      // ready the moment the cut lands. Real shot/event analysis runs
      // separately and is never faked here: browser pixel analysis below
      // (when the cut has a video file) and the local ML backend when
      // installed both report their own progress honestly.
      const p = analyzeProject(name, duration, videoUrl, sourceLabel, resolution);
      setProject(p);
      setActiveSceneId(p.scenes[0]?.id ?? null);
      setTime(0);
      setPlaying(false);
      setAnalyzing(false);
      setAnalyzeProgress(100);
      setSavedAt(null);
      setSaveState('idle');
      // Real browser-pixel analysis drives autonomous sound design. It runs
      // asynchronously with its own honest analyzingVideo state and never
      // blocks the deterministic structural plan above; with no video file
      // (demo template) it logs that scene text is used instead.
      void analyzeProjectVideo(p);
      const layers = p.scenes.reduce((a, s) => a + s.layers.length, 0);
      const hits = p.scenes.reduce((a, s) => a + s.hits.length, 0);
      log(`ingest: ${name} · ${duration.toFixed(1)}s · ${sourceLabel}`, 'ok');
      log(
        `structural plan: ${p.scenes.length} scene block(s) · ${layers} procedural layer(s) · ${hits} sync point(s) — deterministic local layout`,
        'info',
      );
      log(
        'layers are synthesised live by the Web Audio voices — turn the monitor on and play to hear the stack; bounces render the same graph offline',
        'info',
      );
    },
    [log, analyzeProjectVideo],
  );

  const loadDemo = useCallback(() => {
    ingest('NIGHTSHIFT_reel_v4 (demo template)', 148, null, 'demo template — no video file', '4K · demo template');
  }, [ingest]);

  const uploadFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = url;
      const done = (dur: number, resolution?: string) => {
        if (!dur) log('video metadata could not be probed — using a 120 s structural layout without picture', 'warn');
        ingest(
          file.name,
          Math.max(24, Math.min(600, dur || 120)),
          url,
          `${(file.size / 1e6).toFixed(1)} MB · local`,
          resolution,
        );
      };
      probe.onloadedmetadata = () => {
        const res = probe.videoWidth && probe.videoHeight ? `${probe.videoWidth} × ${probe.videoHeight}` : 'unmeasured';
        done(probe.duration, res);
      };
      probe.onerror = () => done(0);
    },
    [ingest, log],
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

  // Keep the monitor graph in sync with the transport. The active scene's
  // procedural layer stack and every timeline clip are driven through the
  // SAME voices + master chain the offline renderer uses, so play, meters
  // and export all describe the same mix. The rAF monitor loop reads the
  // refs below; they are refreshed in an effect (never during render) so
  // per-frame state changes cannot re-subscribe the effect.
  const activeLayersRef = useRef<Layer[]>([]);
  const clipsRef = useRef<AudioClip[]>([]);
  const timeRef = useRef(time);
  useEffect(() => {
    activeLayersRef.current = activeScene?.layers ?? [];
    clipsRef.current = project?.clips ?? [];
    timeRef.current = time;
  });
  useEffect(() => {
    if (!playing || !project || !audioOn) return;
    engine.start(activeLayersRef.current, clipsRef.current, timeRef.current);
    let raf = 0;
    const loop = () => {
      engine.update(activeLayersRef.current, clipsRef.current, timeRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, project, audioOn, activeSceneId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.currentTime = time;
      void v.play().catch(() => undefined);
    } else v.pause();
  }, [playing, time]);

  const seek = useCallback((t: number) => {
    setTime(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  }, []);

  const setMaster = useCallback((patch: Partial<MasterParams>) => {
    setMasterState((m) => ({ ...m, ...patch }));
    engine.setMaster(patch);
  }, []);

  const toggleAudio = useCallback(async () => {
    if (!audioOn) {
      engine.ensure();
      await engine.ctx!.resume();
      setAudioOn(true);
      log('monitor: Web Audio running @ 48 kHz', 'ok');
    } else {
      engine.stop();
      setAudioOn(false);
      log('monitor: stopped', 'info');
    }
  }, [audioOn, log]);

  const audition = useCallback((layer: Layer) => {
    engine.audition(layer);
    log(`audition: ${layer.name}`, 'info');
  }, [log]);

  /* ------------------------------------------------------------ clips */

  const clips = useMemo(() => project?.clips ?? [], [project?.clips]);

  /** Every provider result lands here — one shared timeline, one clip model. */
  const addClip = useCallback((clip: AudioClip) => {
    setProject((cur) => (cur ? { ...cur, clips: [...cur.clips, clip] } : cur));
    setSelectedClipId(clip.id);
    // ensure engine has buffer ready for immediate playback
    if (clip.url) {
      engine.prepareClip(clip).catch(() => log(`clip decode failed for ${clip.name}`, 'warn'));
    }
  }, [log]);

  const patchClip = useCallback((clipId: string, patch: Partial<AudioClip>) => {
    setProject((cur) =>
      cur ? { ...cur, clips: cur.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) } : cur,
    );
  }, []);

  const removeClip = useCallback(
    (clipId: string) => {
      setProject((cur) => (cur ? { ...cur, clips: cur.clips.filter((c) => c.id !== clipId) } : cur));
      setSelectedClipId((id) => (id === clipId ? null : id));
      log('clip removed from timeline', 'warn');
    },
    [log],
  );

  const dragClip = useCallback(
    (clipId: string, to: number) => {
      setProject((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          clips: cur.clips.map((c) => (c.id === clipId ? moveClip(c, to, cur.duration) : c)),
        };
      });
    },
    [],
  );

  const trim = useCallback((clipId: string, edge: 'start' | 'end', delta: number) => {
    setProject((cur) =>
      cur
        ? { ...cur, clips: cur.clips.map((c) => (c.id === clipId ? trimClip(c, edge, delta) : c)) }
        : cur,
    );
  }, []);

  const split = useCallback(
    (clipId: string, at: number) => {
      setProject((cur) => {
        if (!cur) return cur;
        const target = cur.clips.find((c) => c.id === clipId);
        if (!target) return cur;
        const parts = splitClip(target, at);
        if (!parts) {
          log('split point is outside the clip', 'warn');
          return cur;
        }
        log(`clip split at ${at.toFixed(2)}s`, 'info');
        return { ...cur, clips: cur.clips.flatMap((c) => (c.id === clipId ? parts : [c])) };
      });
    },
    [log],
  );

  const toggleClipMute = useCallback(
    (clipId: string) => {
      const c = clips.find((x) => x.id === clipId);
      if (c) patchClip(clipId, { muted: !c.muted });
    },
    [clips, patchClip],
  );

  const toggleClipSolo = useCallback(
    (clipId: string) => {
      const c = clips.find((x) => x.id === clipId);
      if (c) patchClip(clipId, { solo: !c.solo });
    },
    [clips, patchClip],
  );

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedClipId) ?? null,
    [clips, selectedClipId],
  );

  /* ------------------------------------------------ library helpers --- */

  // Convert a library SoundClip (from service) into unified AudioClip and create blob URL.
  // `place` carries autonomous-analysis provenance onto the canonical clip.
  const libraryClipToUnified = useCallback(async (sc: SoundClip, place?: Partial<AutoPlacementDetail>): Promise<AudioClip> => {
    const ac = soundClipToAudioClip(sc);
    if (place) {
      ac.eventTimestamp = place.eventTimestamp;
      ac.placementTimestamp = place.placementTimestamp;
      ac.eventConfidence = place.eventConfidence;
      ac.searchQuery = place.searchQuery;
      ac.eventEvidence = place.eventEvidence;
      ac.eventKind = place.eventKind;
      ac.eventMaterial = place.eventMaterial;
      ac.eventAction = place.eventAction;
      ac.eventEnvironment = place.eventEnvironment;
      ac.eventDistance = place.eventDistance;
      ac.eventPerspective = place.eventPerspective;
      ac.autoPlaced = place.autoPlaced;
    }
    try {
      const rec = await soundCache.get(sc.cacheKey);
      if (rec) {
        const url = URL.createObjectURL(rec.blob);
        ac.url = url;
        ac.audioId = sc.cacheKey;
        ac.sourceDuration = rec.blob.size ? (sc.asset?.duration ?? ac.sourceDuration) : ac.sourceDuration;
        // try to get real sampleRate/channels via engine prepare
        try {
          const buf = await engine.prepareClip(ac);
          ac.sampleRate = buf.sampleRate;
          ac.channels = buf.numberOfChannels;
          ac.sourceDuration = buf.duration;
          ac.duration = Math.min(ac.duration, buf.duration);
        } catch { /* keep estimates */ }
      }
    } catch { /* keep placeholder url */ }
    return ac;
  }, []);

  const loadClipBuffers = useCallback(async () => {
    const cls = project?.clips ?? [];
    for (const c of cls) {
      if (c.provider === 'library' || c.provider === 'user') {
        if (c.cacheKey && !engine.hasClipBuffer(c.cacheKey) && !engine.hasClipBuffer(c.audioId)) {
          const rec = await soundCache.get(c.cacheKey);
          if (!rec) continue;
          try {
            const buf = await decodeForPlayback(rec.blob);
            engine.prepareBuffer(c.cacheKey, buf);
            engine.prepareBuffer(c.audioId, buf);
            clipBuffersRef.current.set(c.cacheKey, buf);
          } catch { /* skip */ }
        }
      } else if (c.url && !engine.hasClipBuffer(c.audioId)) {
        try { await engine.prepareClip(c); } catch { /* skip */ }
      }
    }
    setLibraryLoaded(true);
  }, [project?.clips]);

  /* Re-sync decoded clip buffers whenever the timeline clip set changes. */
  /* eslint-disable-next-line react-hooks/set-state-in-effect -- clip-set sync, not render-derived state */
  useEffect(() => { void loadClipBuffers(); }, [loadClipBuffers]);

  const runSearch = useCallback(async (intent: RetrievalIntent, page = 1) => {
    setRetrieval((r) => ({ ...r, busy: true, intent, result: null, error: null }));
    try {
      const result = await lib.search(intent, page);
      setRetrieval({ busy: false, intent, result, error: result.error, lastAuto: null });
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      setRetrieval((r) => ({ ...r, busy: false, error: msg }));
      throw e;
    }
  }, [lib]);

  const planScene = useCallback((sceneId: string) => {
    if (!project) return [];
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return [];
    const ctx = { sceneId: scene.id, start: scene.start, end: scene.end, title: scene.title, tags: scene.tags, summary: scene.summary, tension: scene.tension, motion: scene.motion, hits: scene.hits, spotting: project.spotting.filter((e) => e.sceneId === sceneId) };
    return lib.planForScene(ctx);
  }, [project, lib]);

  /** The ACTUAL video-driven plan for a scene (events first). */
  const planVideoScene = useCallback(
    (sceneId: string) => {
      if (!project) return [];
      const scene = project.scenes.find((s) => s.id === sceneId);
      if (!scene) return [];
      const events = (project.soundEvents ?? []).filter((e) => e.sceneId === sceneId || !e.sceneId);
      if (!events.length) return [];
      const ctx = { sceneId: scene.id, start: scene.start, end: scene.end, title: scene.title, tags: scene.tags, summary: scene.summary, tension: scene.tension, motion: scene.motion, hits: scene.hits, spotting: project.spotting.filter((e) => e.sceneId === sceneId) };
      return lib.planFromVideo(ctx, events);
    },
    [project, lib],
  );

  const auditionAsset = useCallback(async (asset: LibraryAsset) => {
    const { blob } = await lib.ensurePreview(asset);
    const buf = await decodeForPlayback(blob);
    engine.auditionBuffer(buf, buf.duration);
    log(`audition: ${asset.title} (preview)`, 'info');
  }, [lib, log]);

  const placeCandidate = useCallback(async (intent: RetrievalIntent, candidate: RankedCandidate, start?: number) => {
    if (!project || !activeScene) throw new Error('no active scene');
    const s = start ?? intent.time ?? activeScene.start;
    const sc = await lib.placeClip({ sceneId: activeScene.id, intent, candidate, start: s, projectId: project.id });
    await lib.recordProvenance(sc, project.id);
    const ac = await libraryClipToUnified(sc, {
      eventTimestamp: intent.detectedTimestamp ?? intent.time ?? undefined,
      placementTimestamp: intent.placementTimestamp ?? s,
      eventConfidence: intent.eventConfidence,
      searchQuery: intent.query,
      eventEvidence: intent.eventEvidence,
      eventKind: intent.eventKind,
      eventMaterial: intent.material,
      eventAction: intent.action,
      eventEnvironment: intent.environment,
      eventDistance: intent.distance,
      eventPerspective: intent.perspective,
      autoPlaced: false,
    });
    addClip(ac);
    log(`placed: ${ac.name} @ ${tc(ac.start)} · match ${Math.round(ac.match! * 100)}%`, 'ok');
    return ac;
  }, [project, activeScene, lib, libraryClipToUnified, addClip, log]);

  const replaceClipSource = useCallback(async (clipId: string, candidate: RankedCandidate) => {
    if (!project) return;
    const target = project.clips.find((c) => c.id === clipId);
    if (!target || !target.cacheKey) { log('replace: not a library clip', 'warn'); return; }
    // create a temporary SoundClip for replacement source
    const tmpSc: SoundClip = {
      id: 'tmp', sceneId: target.id, name: candidate.asset.title, role: (target.role as SoundRole) ?? 'MISC_FOLEY', source: candidate.asset.provider === 'user-library' ? 'USR' : 'LIB',
      start: target.start, end: target.start + target.duration, offset: 0, gain: target.gain, pan: target.pan, fadeIn: target.fadeIn, fadeOut: target.fadeOut, muted: false, solo: false,
      transform: target.transform!, asset: candidate.asset, cacheKey: candidate.asset.cacheKey, intentId: target.intentId ?? '', match: candidate.match,
    };
    const sc = lib.applyReplacement(target as unknown as SoundClip, tmpSc);
    const { cacheKey } = await lib.ensurePreview(candidate.asset);
    await soundCache.touchProjects(cacheKey, project.id);
    const ac = await libraryClipToUnified({ ...sc, cacheKey, asset: candidate.asset });
    // keep position/gain/pan/etc from target; if this replacement came from a
    // FIND ALTERNATIVE run, the new search query becomes the truthful intent
    const altQuery = retrieval.intent?.query;
    const merged: AudioClip = {
      ...target,
      asset: ac.asset,
      cacheKey: ac.cacheKey,
      url: ac.url,
      name: ac.name,
      match: ac.match,
      audioId: ac.audioId,
      sampleRate: ac.sampleRate,
      channels: ac.channels,
      sourceDuration: ac.sourceDuration,
      ...(altQuery ? { searchQuery: altQuery } : {}),
    };
    setProject((cur) => cur ? { ...cur, clips: cur.clips.map((c) => c.id === clipId ? merged : c) } : cur);
    log(`replace: ${target.name} → ${merged.name}`, 'ok');
  }, [project, retrieval.intent, lib, libraryClipToUnified, log]);

  const findAlternatives = useCallback(async (clipId: string) => {
    const clip = project?.clips.find((c) => c.id === clipId);
    if (!clip || !clip.asset) { log('no asset for alternative search', 'warn'); return null; }
    const sc = clip as unknown as SoundClip;
    const intent = lib.alternativeIntent(sc, 'alt', {
      query: clip.searchQuery ?? (clip.asset.tags.length ? clip.asset.tags.slice(0, 4).join(' ') : clip.name),
      detectedTimestamp: clip.eventTimestamp ?? clip.start,
      placementTimestamp: clip.placementTimestamp ?? clip.start,
      eventConfidence: clip.eventConfidence,
      eventKind: clip.eventKind ?? ((clip.role ?? 'MISC_FOLEY').toLowerCase().replace('_', '-') as RetrievalIntent['eventKind']),
      material: clip.eventMaterial,
      environment: clip.eventEnvironment,
      distance: clip.eventDistance,
    });
    const res = await runSearch(intent);
    setRetrieval((r) => ({ ...r, intent, result: res }));
    return res;
  }, [project, lib, runSearch, log]);

  const runAutoDesign = useCallback(async (sceneId: string, mode: AutoMode) => {
    if (!project) return { placed: [], suggestions: [], skipped: 0, reports: [], details: [] };
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return { placed: [], suggestions: [], skipped: 0, reports: [], details: [] };
    const ctx = { sceneId: scene.id, start: scene.start, end: scene.end, title: scene.title, tags: scene.tags, summary: scene.summary, tension: scene.tension, motion: scene.motion, hits: scene.hits, spotting: project.spotting.filter((e) => e.sceneId === sceneId) };
    setRetrieval((r) => ({ ...r, busy: true }));
    // the pipeline is VIDEO-DRIVEN: real detected events are passed through;
    // no events (or demo project) → scene-text planner (backwards compatible)
    const result = await lib.autoDesign(ctx, project.id, mode, (msg) => log(msg, 'info'), { events: project.soundEvents ?? [] });
    setLastAutoReports(result.reports);
    const detailByClip = new Map(result.details.map((d) => [d.clipId, d]));
    const unified: AudioClip[] = [];
    for (const sc of result.placed) {
      const d = detailByClip.get(sc.id);
      const ac = await libraryClipToUnified(sc, d ?? { autoPlaced: true, searchQuery: undefined });
      unified.push(ac);
      addClip(ac);
    }
    setRetrieval({
      busy: false,
      intent: null,
      result: null,
      error: null,
      lastAuto: { mode, placed: unified.length, suggested: result.suggestions.length, skipped: result.skipped, at: Date.now() },
    });
    log(`auto sound design: ${mode} · placed ${unified.length} · suggested ${result.suggestions.length} · skipped ${result.skipped}`, 'ok');
    log(`auto sound design: video events driven by ${project.soundEvents?.length ?? 0} detected candidate(s)`, project.soundEvents?.length ? 'info' : 'warn');
    return { placed: unified, suggestions: result.suggestions, skipped: result.skipped, reports: result.reports, details: result.details };
  }, [project, lib, libraryClipToUnified, addClip, log]);

  const addSpottingEvent = useCallback((sceneId: string, role: SoundRole, time: number) => {
    const ev: SpottingEvent = { id: shortId('spot'), sceneId, label: role, role, time, createdAt: Date.now() };
    setProject((cur) => cur ? { ...cur, spotting: [...cur.spotting, ev] } : cur);
    log(`spotting: ${role} @ ${tc(time, true)}`, 'info');
  }, [log]);

  const auditionClip = useCallback(async (clipId: string) => {
    const clip = project?.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (clip.cacheKey) {
      const rec = await soundCache.get(clip.cacheKey);
      if (rec) {
        const buf = await decodeForPlayback(rec.blob);
        engine.auditionBuffer(buf, buf.duration);
        log(`audition: ${clip.name}`, 'info');
        return;
      }
    }
    if (clip.url) {
      try {
        const buf = await engine.prepareClip(clip);
        engine.auditionBuffer(buf, buf.duration);
        log(`audition: ${clip.name}`, 'info');
      } catch { log('audition failed', 'warn'); }
    }
  }, [project, log]);

  const toggleFavorite = useCallback((asset: LibraryAsset) => {
    const list = JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]');
    const exists = list.some((f: { asset: LibraryAsset }) => f.asset.provider === asset.provider && f.asset.soundId === asset.soundId);
    const next = exists ? list.filter((f: { asset: LibraryAsset }) => !(f.asset.provider === asset.provider && f.asset.soundId === asset.soundId)) : [{ asset, at: Date.now() }, ...list];
    localStorage.setItem('umbra.library.favorites', JSON.stringify(next));
    setFavorites(next.length);
  }, []);

  const isFavorite = useCallback((asset: LibraryAsset) => {
    const list = JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]');
    return list.some((f: { asset: LibraryAsset }) => f.asset.provider === asset.provider && f.asset.soundId === asset.soundId);
  }, []);

  const importUserAudio = useCallback(async (file: File, meta: Parameters<RetrievalService['userLibrary']['importFile']>[1]) => {
    const rec = await lib.userLibrary.importFile(file, meta);
    log(`user library: imported ${rec.name} (${(file.size / 1e6).toFixed(1)} MB, offline-available)`, 'ok');
    return rec;
  }, [lib, log]);

  const clearUnusedCache = useCallback(async () => {
    if (!project) return;
    // Keep every blob the open project references — both via the ownership
    // list and explicitly by cacheKey, so pre-ownership records survive too.
    const keys = project.clips.map((c) => c.cacheKey).filter((k): k is string => !!k);
    const removed = await soundCache.clearUnused([project.id], keys);
    log(`cache: removed ${removed} unused audio asset(s) — project files kept`, 'warn');
    setLibraryLoaded(false);
    void loadClipBuffers();
  }, [project, loadClipBuffers, log]);

  const exportCredits = useCallback(async (kind: 'txt' | 'json') => {
    if (!project) return;
    const entries = await provenanceStore.list();
    const projectEntries = entries.filter((e) => project.clips.some((c) => c.id === e.clipId));
    if (kind === 'json') {
      downloadText('sound_credits.json', exportCreditsJson(projectEntries, project.name, project.duration), 'application/json');
    } else {
      downloadText('sound_credits.txt', exportCreditsTxt(projectEntries, project.name, project.duration));
    }
    log(`exported sound_credits.${kind} (${projectEntries.length} assets)`, 'ok');
  }, [project, log]);

  /* ------------------------------------------------------- generation */

  const generation = useGeneration({ onClip: addClip, log });

  const generateClip = useCallback(
    async (req: Omit<GenerateRequest, 'timelineStart'> & { timelineStart?: number }) => {
      const start = req.timelineStart ?? range?.start ?? time;
      return generation.generate(
        { ...req, timelineStart: start, sceneId: req.sceneId ?? activeSceneId },
        { start, name: req.label ?? 'Generated cue' },
      );
    },
    [generation, range, time, activeSceneId],
  );

  const continueClip = useCallback(
    async (clip: AudioClip, seconds: number) => {
      const m = clip.metadata;
      return generation.generate(
        {
          provider: 'ace-step',
          task: 'continue',
          prompt: (m.prompt as string) || 'continue this cue without introducing new thematic material',
          negativePrompt: (m.negativePrompt as string) || undefined,
          duration: seconds,
          key: (m.key as string) ?? null,
          mode: (m.mode as string) ?? null,
          bpm: (m.bpm as number) ?? null,
          timeSignature: (m.timeSignature as string) ?? null,
          sourceAudioId: clip.audioId,
          timelineStart: clipEnd(clip),
          sceneId: activeSceneId,
          label: `${clip.name} (cont.)`,
        },
        { start: clipEnd(clip), name: `${clip.name} (cont.)` },
      );
    },
    [generation, activeSceneId],
  );

  const repaintClip = useCallback(
    async (clip: AudioClip, from: number, to: number, prompt?: string) => {
      const m = clip.metadata;
      const localFrom = Math.max(0, from - clip.start);
      const localTo = Math.min(clip.duration, to - clip.start);
      if (localTo - localFrom < 0.5) {
        log('select at least half a second inside the clip to repaint', 'warn');
        return null;
      }
      return generation.generate(
        {
          provider: 'ace-step',
          task: 'repaint',
          prompt: prompt || (m.prompt as string) || '',
          negativePrompt: (m.negativePrompt as string) || undefined,
          duration: clip.duration,
          key: (m.key as string) ?? null,
          mode: (m.mode as string) ?? null,
          bpm: (m.bpm as number) ?? null,
          sourceAudioId: clip.audioId,
          repaintStart: localFrom,
          repaintEnd: localTo,
          timelineStart: clip.start,
          sceneId: activeSceneId,
          label: `${clip.name} (repaint)`,
        },
        { start: clip.start, name: `${clip.name} v${clip.version + 1}` },
      );
    },
    [generation, activeSceneId, log],
  );

  const regenerateClip = useCallback(
    async (clip: AudioClip) => {
      const m = clip.metadata;
      const settings = (m.generationSettings ?? {}) as Record<string, unknown>;
      return generation.generate(
        {
          provider: (m.provider === 'library' || m.provider === 'user' ? 'ace-step' : m.provider) as never,
          prompt: (m.prompt as string) || (settings.prompt as string) || '',
          negativePrompt: (m.negativePrompt as string) || undefined,
          duration: clip.duration,
          seed: null,
          key: (m.key as string) ?? null,
          mode: (m.mode as string) ?? null,
          bpm: (m.bpm as number) ?? null,
          timeSignature: (m.timeSignature as string) ?? null,
          timelineStart: clip.start,
          sceneId: activeSceneId,
          label: `${clip.name} v${clip.version + 1}`,
        },
        { start: clip.start, name: `${clip.name} v${clip.version + 1}` },
      );
    },
    [generation, activeSceneId],
  );

  /* ------------------------------------------------ edits (layers) -- */

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
      const scene = project?.scenes.find((s) => s.id === sceneId);
      const l = scene?.layers.find((x) => x.id === layerId);
      if (!scene || !l) return;
      const next = regenerateLayer(l);
      setProject((cur) =>
        cur
          ? {
              ...cur,
              scenes: cur.scenes.map((s) =>
                s.id === sceneId ? { ...s, layers: s.layers.map((x) => (x.id === layerId ? next : x)) } : s,
              ),
            }
          : cur,
      );
      log(`regenerate: ${next.name} · v${next.version} · seed ${next.seed} — synthesis parameters updated live`, 'ok');
    },
    [project, log],
  );

  const regenScene = useCallback(
    (sceneId: string) => {
      const s = project?.scenes.find((x) => x.id === sceneId);
      if (!s) return;
      log(`regen: scene ${s.index} stack — ${s.layers.length} layer(s)`, 'info');
      s.layers.forEach((l) => regenLayer(sceneId, l.id));
    },
    [project, regenLayer, log],
  );

  /* ----------------------------------------------------------- export */

  const patchJob = (id: string, patch: Partial<RenderJob>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const startRender = useCallback(
    async (
      label: string,
      format: string,
      resolution: string,
      opts?: { scene?: Scene; layer?: Layer; clip?: AudioClip; filename?: string; maxSeconds?: number },
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
        await new Promise((r) => setTimeout(r, 40));
        const result = opts?.clip
          ? await renderClipStem(opts.clip, master)
          : opts?.layer && opts.scene
            ? await renderStem(opts.scene, opts.layer, master)
            : await renderScore(project, master, { maxSeconds: opts?.maxSeconds ?? 240 }, opts?.scene);
        window.clearInterval(creep);
        patchJob(id, { progress: 90, state: 'encoding' });
        const filename =
          opts?.filename ??
          `${project.name.replace(/\.[^.]+$/, '')}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`;
        await new Promise((r) => setTimeout(r, 120));
        const quality = result.quality
          ? { verdict: result.quality.verdict, summary: formatReport(result.quality) }
          : undefined;
        patchJob(id, {
          progress: 100,
          state: 'complete',
          bytes: result.bytes,
          url: result.url,
          filename,
          peak: result.peakDb,
          lufs: result.lufs,
          quality,
        });
        const clipNote = result.clipsPlaced ? ` · ${result.clipsPlaced} clip(s) baked in` : '';
        log(
          `render complete: ${filename} · ${result.seconds.toFixed(1)}s · peak ${result.peakDb.toFixed(1)} dBTP · ${result.lufs.toFixed(1)} LUFS${clipNote}`,
          'ok',
        );
        if (quality) {
          const level = quality.verdict === 'pass' ? 'ok' : quality.verdict === 'warn' ? 'warn' : 'warn';
          log(`quality ${quality.verdict.toUpperCase()}: ${quality.summary}`, level);
        }
        if (result.clipsFailed?.length) {
          log(`render warning: could not decode ${result.clipsFailed.join(', ')} — omitted from the master`, 'warn');
        }
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
    // clips + generation
    clips,
    selectedClip,
    selectedClipId,
    setSelectedClipId,
    addClip,
    patchClip,
    removeClip,
    dragClip,
    trimClip: trim,
    splitClip: split,
    toggleClipMute,
    toggleClipSolo,
    range,
    setRange,
    generation,
    generateClip,
    continueClip,
    repaintClip,
    regenerateClip,
    // sound library — credentials live on the backend, never in the browser
    freesoundConnection,
    refreshFreesoundStatus,
    libSettings,
    setSettingsPatch,
    setLicensePolicy,
    retrieval,
    runSearch,
    planScene,
    planVideoScene,
    lastAutoReports,
    auditionAsset,
    placeCandidate,
    replaceClipSource,
    findAlternatives,
    runAutoDesign,
    addSpottingEvent,
    auditionClip,
    favorites,
    toggleFavorite,
    isFavorite,
    importUserAudio,
    clearUnusedCache,
    exportCredits,
    libraryLoaded,
    clipCount,
    // contextual video analysis (autonomous sound design driver)
    analyzingVideo,
    videoAnalysisLog,
    soundEvents: project?.soundEvents ?? [],
    soundAnalysis: project?.soundAnalysis ?? null,
    reanalyzeVideo,
    providerStatuses: async () => Promise.all(lib.providers().map((p) => p.status())),
    // --- draft persistence -------------------------------------------------
    savedAt,
    saveState,
    saveError,
    hasSavedDraft,
    saveNow: async () => {
      if (!project) return;
      try {
        await persistProject(project, master);
        setSavedAt(Date.now());
        setHasSavedDraft(true);
        setSaveState('saved');
        setSaveError(null);
        log(`project draft saved locally (${new Date().toLocaleTimeString()})`, 'ok');
      } catch (e) {
        setSaveState('error');
        setSaveError((e as Error).message);
        log(`save failed: ${(e as Error).message}`, 'warn');
      }
    },
    /** Reopen the newest saved draft from the Uploader screen. */
    resumeSaved: async () => {
      try {
        const snap = await loadLatestSnapshot();
        if (!snap) return;
        const { project: p, warnings } = await hydrateClips(snap.project);
        engine.setMaster(snap.master);
        setProject(p);
        setActiveSceneId(p.scenes[0]?.id ?? null);
        setMasterState(snap.master);
        setTime(0);
        setPlaying(false);
        setSavedAt(snap.savedAt);
        setHasSavedDraft(true);
        setSaveState('saved');
        log(`resumed project "${p.name}" from the local draft`, 'ok');
        warnings.forEach((w) => log(w, 'warn'));
        if (snap.hadLocalVideo && !p.videoUrl) {
          log('the source video was a local file and cannot be restored after a reload — picture offline, audio and edits intact', 'warn');
        }
      } catch (e) {
        log(`could not resume the saved project: ${(e as Error).message}`, 'warn');
      }
    },
    /** Discard the saved draft (Close keeps it; this removes it permanently). */
    discardSaved: async () => {
      try {
        const removed = await discardLatestSavedProject();
        setSavedAt(null);
        setHasSavedDraft(false);
        setSaveState('idle');
        log(removed ? 'saved project draft removed from this browser' : 'no saved project draft to remove', 'warn');
      } catch (e) {
        log(`could not remove the saved draft: ${(e as Error).message}`, 'warn');
      }
    },
    reset: () => {
      engine.stop();
      setProject(null);
      setPlaying(false);
      setTime(0);
      setJobs([]);
      setLogs([]);
      setSelectedClipId(null);
      setRange(null);
      setRetrieval({ busy: false, intent: null, result: null, error: null, lastAuto: null });
      setLastAutoReports([]);
      setVideoAnalysisLog(null);
      // the saved draft survives Close — the Uploader offers Resume
    },
  };
}

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
