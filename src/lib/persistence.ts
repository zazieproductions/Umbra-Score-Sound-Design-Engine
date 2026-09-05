/* ==================================================================== *
 *  PROJECT SAVE / LOAD + CACHE DURABILITY
 *
 *  Umbra persists *project drafts*, not rendered audio. The durable record
 *  is the Project object (clips, provenance, transforms, edits) plus master
 *  settings; audio blobs live in the IndexedDB sound cache and are keyed to
 *  the project so "clear unused cache" can never delete a clip that a
 *  project still references.
 *
 *  What survives a reload:
 *    - every timeline AudioClip: position, trim/offset, fades, gain/pan,
 *      mute/solo, name, metadata, version, library provenance (asset +
 *      license + transform) and cacheKey.
 *    - scene/layer edits and spotting events.
 *    - master-chain settings and the local library settings/credentials.
 *
 *  What cannot survive and is therefore reported honestly:
 *    - a local video blob (browser sandbox: no file handle persists).
 *      The project reopens with picture offline; audio is intact.
 *    - blob: URLs, which die with the page. Library/user clips are rebuilt
 *      from the cache; deterministic umbra-procedural clips are re-rendered
 *      offline from their stored seed/settings; anything that cannot be
 *      rebuilt is reported by name instead of silently playing silence.
 * ==================================================================== */

import type { AudioClip, Project } from './types';
import type { MasterParams } from './dsp';
import { projectStore, soundCache } from './library/cache';
import { renderProceduralClip } from './proceduralClip';

export interface ProjectSnapshot {
  project: Project;
  master: MasterParams;
  savedAt: number;
  hadLocalVideo: boolean;
}

export interface HydrateResult {
  project: Project;
  warnings: string[];
}

const BLOB = 'blob:';

/** Strip everything page-lifetime from a project before it is written. */
export function serializeProject(p: Project): Project {
  return {
    ...p,
    // a blob video cannot be restored after a reload — do not persist a dead URL
    videoUrl: p.videoUrl && p.videoUrl.startsWith(BLOB) ? null : p.videoUrl,
    clips: p.clips.map((c) => ({
      ...c,
      url: c.url && c.url.startsWith(BLOB) ? '' : c.url,
    })),
  };
}

export async function persistProject(
  project: Project,
  master: MasterParams,
): Promise<void> {
  const hadLocalVideo = !!project.videoUrl?.startsWith(BLOB);
  const draft = {
    id: project.id,
    name: project.name,
    duration: project.duration,
    savedAt: Date.now(),
    hadLocalVideo,
    serialized: serializeProject(project) as unknown,
    master: master as unknown,
  };
  await projectStore.save(draft);
  // Keep exactly one live draft: saving a new project supersedes older ones
  // so "Resume" always opens the most recent work.
  const all = await projectStore.list();
  for (const other of all) {
    if (other.id !== project.id) await projectStore.remove(other.id);
  }
  // The project itself now references these blobs: never let cache
  // eviction remove them while the draft exists.
  const keys = new Set(project.clips.map((c) => c.cacheKey).filter((k): k is string => !!k));
  await Promise.all([...keys].map((k) => soundCache.touchProjects(k, project.id)));
}

export async function loadLatestSnapshot(): Promise<ProjectSnapshot | null> {
  const draft = await projectStore.latest();
  if (!draft) return null;
  return {
    project: draft.serialized as Project,
    master: draft.master as MasterParams,
    savedAt: draft.savedAt,
    hadLocalVideo: draft.hadLocalVideo,
  };
}

export async function discardSavedProject(projectId: string): Promise<void> {
  await projectStore.remove(projectId);
}

/**
 * Remove the newest live draft. Single-live-draft policy means “latest” is
 * the only draft that can exist, so this is the safe unconditional discard.
 * Returns true when a draft was actually removed.
 */
export async function discardLatestSavedProject(): Promise<boolean> {
  const draft = await projectStore.latest();
  if (!draft) return false;
  await projectStore.remove(draft.id);
  return true;
}

/**
 * Rebuild playable audio for clips whose URL died with the previous page.
 *
 *  - library/user clips with a cacheKey → fresh object URL from the cache.
 *  - umbra-procedural clips (deterministic) → re-rendered offline from the
 *    stored seed/settings. The same seed always renders the same audio.
 *  - everything else (backend /api urls) is untouched.
 *
 * Returns warnings for anything that could not be rebuilt so the caller can
 * surface the failure by name instead of playing silence.
 */
export async function hydrateClips(project: Project): Promise<HydrateResult> {
  const warnings: string[] = [];
  const clips: AudioClip[] = [];
  for (const clip of project.clips) {
    const hydrated = await hydrateClip(clip, project.id);
    if (hydrated.note) warnings.push(`${hydrated.note} — "${clip.name}"`);
    clips.push(hydrated.clip);
  }
  return { project: { ...project, clips }, warnings };
}

async function hydrateClip(clip: AudioClip, projectId: string): Promise<{ clip: AudioClip; note?: string }> {
  // Live URL already (backend proxy, data:, http): nothing to do.
  if (clip.url && !clip.url.startsWith(BLOB)) return { clip };

  // Library / user clip: rebuild from the IndexedDB blob cache.
  if ((clip.provider === 'library' || clip.provider === 'user') && clip.cacheKey) {
    const rec = await soundCache.get(clip.cacheKey).catch(() => undefined);
    if (rec) {
      const url = URL.createObjectURL(rec.blob);
      await soundCache.touchProjects(clip.cacheKey, projectId).catch(() => undefined);
      return {
        clip: {
          ...clip,
          url,
          audioId: clip.cacheKey,
          sampleRate: rec.asset?.sampleRate ?? clip.sampleRate,
          channels: rec.asset?.channels ?? clip.channels,
        },
        note: rec.asset?.duration ? undefined : 'rebuilt from cache (provider duration used)',
      };
    }
    return {
      clip: { ...clip, url: '' },
      note: 'cached audio no longer available — clip restored silent; re-import the source sound to hear it',
    };
  }

  // Deterministic browser-synthesised clip: re-render the stored request.
  if (clip.provider === 'umbra-procedural') {
    const m = clip.metadata ?? {};
    const settings = (m.generationSettings ?? {}) as Record<string, unknown>;
    if (
      typeof window !== 'undefined' &&
      (window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext) &&
      settings.kind &&
      clip.audioId.startsWith('local:')
    ) {
      try {
        const rendered = await renderProceduralClip({
          prompt: (m.prompt as string) || '',
          duration: typeof settings.duration === 'number' ? settings.duration : Math.max(1, clip.sourceDuration - 1.5),
          seed: m.seed != null ? Number(m.seed) : null,
          key: (m.key as string | null) ?? null,
          mode: (m.mode as string | null) ?? null,
          bpm: (m.bpm as number | null) ?? null,
          start: 0,
          name: clip.name,
          sceneId: null,
        });
        // keep the saved edit, only swap in the freshly rendered source
        const restored: AudioClip = {
          ...clip,
          url: rendered.clip.url,
          audioId: rendered.clip.audioId,
          sourceDuration: rendered.clip.sourceDuration,
          sampleRate: rendered.clip.sampleRate,
          channels: rendered.clip.channels,
        };
        return { clip: restored };
      } catch (e) {
        return { clip: { ...clip, url: '' }, note: `procedural clip could not be re-rendered (${(e as Error).message})` };
      }
    }
    if (clip.audioId.startsWith('local:')) {
      return {
        clip: { ...clip, url: '' },
        note: 'procedural clip cannot be re-rendered in this environment — restored silent; re-generate it',
      };
    }
  }

  // Unknown dead URL: restore the edit, keep it visibly broken.
  return { clip: { ...clip, url: '' }, note: 'clip audio URL was lost with the previous page and cannot be rebuilt' };
}
