import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioClip, Layer, LayerKind, Project, RenderJob, Scene } from './types';
import { soundClipToAudioClip } from './types';
import { addLayer as makeLayer, analyzeProject, regenerateLayer } from './generate';
import { engine, DEFAULT_MASTER, type MasterParams } from './audio';
import { download, renderClipStem, renderScore, renderStem } from './render';
import { clipEnd, moveClip, splitClip, trimClip } from './clips';
import { useGeneration } from './useGeneration';
import type { GenerateRequest } from './providers';
// Library imports — preserve PR7 retrieval completely
import { RetrievalService } from './library/service';
import { soundCache, provenanceStore, credsStore, settingsStore, shortId } from './library/cache';
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
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** in/out points on the project timeline used to target generation */
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
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
    void provenanceStore.list().then(() => setLibraryLoaded(true));
    try { setFavorites(JSON.parse(localStorage.getItem('umbra.library.favorites') ?? '[]').length); } catch { setFavorites(0); }
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
      log(`ingest: ${name} · ${duration.toFixed(1)}s`, 'ok');

      const total = p.scenes.length;
      p.scenes.forEach((s, i) => {
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'analyzing' } : x)) } : cur,
          );
          log(`analysis: scene ${s.index} · shot boundary @ ${s.start.toFixed(2)}s · tension ${(s.tension * 100).toFixed(0)}%`, 'info');
        }, 350 + i * 520);
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'generating' } : x)) } : cur,
          );
          log(`scoring: scene ${s.index} · scoring ${s.layers.length} layers into ${s.layers[0]?.space ?? 'hall'} space`, 'gpu');
        }, 700 + i * 520);
        later(() => {
          setProject((cur) =>
            cur ? { ...cur, scenes: cur.scenes.map((x) => (x.id === s.id ? { ...x, status: 'ready' } : x)) } : cur,
          );
          setAnalyzeProgress(((i + 1) / total) * 100);
          log(`scene ${s.index} ready · ${s.layers.length} stems · ${s.hits.length} sync hits`, 'ok');
          if (i === total - 1) {
            setAnalyzing(false);
            log('pipeline complete', 'ok');
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

  // keep engine clips in sync with transport (both generative and library)
  useEffect(() => {
    if (!playing || !project || !audioOn) return;
    let raf = 0;
    const loop = () => {
      engine.tickClips(project.clips ?? [], time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, project, audioOn, time]);

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

  // Convert a library SoundClip (from service) into unified AudioClip and create blob URL
  const libraryClipToUnified = useCallback(async (sc: SoundClip): Promise<AudioClip> => {
    const ac = soundClipToAudioClip(sc);
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
    const ac = await libraryClipToUnified(sc);
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
    const { blob, cacheKey } = await lib.ensurePreview(candidate.asset);
    await soundCache.touchProjects(cacheKey, project.id);
    const ac = await libraryClipToUnified({ ...sc, cacheKey, asset: candidate.asset });
    // keep position/gain/pan etc from target
    const merged: AudioClip = { ...target, asset: ac.asset, cacheKey: ac.cacheKey, url: ac.url, name: ac.name, match: ac.match, audioId: ac.audioId, sampleRate: ac.sampleRate, channels: ac.channels, sourceDuration: ac.sourceDuration };
    setProject((cur) => cur ? { ...cur, clips: cur.clips.map((c) => c.id === clipId ? merged : c) } : cur);
    log(`replace: ${target.name} → ${merged.name}`, 'ok');
  }, [project, lib, libraryClipToUnified, log]);

  const findAlternatives = useCallback(async (clipId: string) => {
    const clip = project?.clips.find((c) => c.id === clipId);
    if (!clip || !clip.asset) { log('no asset for alternative search', 'warn'); return null; }
    const sc = clip as unknown as SoundClip;
    const intent = lib.alternativeIntent(sc);
    const res = await runSearch(intent);
    setRetrieval((r) => ({ ...r, intent, result: res }));
    return res;
  }, [project, lib, runSearch, log]);

  const runAutoDesign = useCallback(async (sceneId: string, mode: AutoMode) => {
    if (!project) return { placed: [], suggestions: [], skipped: 0 };
    const scene = project.scenes.find((s) => s.id === sceneId);
    if (!scene) return { placed: [], suggestions: [], skipped: 0 };
    const ctx = { sceneId: scene.id, start: scene.start, end: scene.end, title: scene.title, tags: scene.tags, summary: scene.summary, tension: scene.tension, motion: scene.motion, hits: scene.hits, spotting: project.spotting.filter((e) => e.sceneId === sceneId) };
    setRetrieval((r) => ({ ...r, busy: true }));
    const result = await lib.autoDesign(ctx, project.id, mode, (msg) => log(msg, 'info'));
    const unified: AudioClip[] = [];
    for (const sc of result.placed) {
      const ac = await libraryClipToUnified(sc);
      unified.push(ac);
      addClip(ac);
    }
    setRetrieval({ busy: false, intent: null, result: null, error: null, lastAuto: { mode, placed: unified.length, suggested: result.suggestions.length, skipped: result.skipped, at: Date.now() } });
    log(`auto sound design: ${mode} · placed ${unified.length} · suggested ${result.suggestions.length} · skipped ${result.skipped}`, 'ok');
    return { placed: unified, suggestions: result.suggestions, skipped: result.skipped };
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
    const removed = await soundCache.clearUnused([project.id]);
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
      setRegenerating((r) => ({ ...r, [layerId]: 0 }));
      log('regen: queued synthesis variant', 'gpu');
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
            log('regen: variant accepted', 'ok');
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
        patchJob(id, {
          progress: 100,
          state: 'complete',
          bytes: result.bytes,
          url: result.url,
          filename,
          peak: result.peakDb,
          lufs: result.lufs,
        });
        const clipNote = result.clipsPlaced ? ` · ${result.clipsPlaced} clip(s) baked in` : '';
        log(
          `render complete: ${filename} · ${result.seconds.toFixed(1)}s · peak ${result.peakDb.toFixed(1)} dBTP · ${result.lufs.toFixed(1)} LUFS${clipNote}`,
          'ok',
        );
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
    regenerating,
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
    // sound library — preserved from PR7
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
    auditionClip,
    favorites,
    toggleFavorite,
    isFavorite,
    importUserAudio,
    clearUnusedCache,
    exportCredits,
    libraryLoaded,
    clipCount,
    providerStatuses: () => lib.providers().map((p) => p.status()),
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
