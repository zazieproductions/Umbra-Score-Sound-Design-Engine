/* ==================================================================== *
 *  DELIVERY NAMING — one deterministic file-naming policy.
 *
 *  Everything (console downloads, ZIP paths, manifest entries, BWF
 *  references, individual clip files) takes its name from HERE, so a
 *  stem file can never disagree with the manifest that describes it.
 *
 *  Pattern:  UMBRA_<PROJECT>_<STEM>.wav
 *            e.g. UMBRA_NIGHTSHIFT_REEL_SFX.wav
 *                  UMBRA_NIGHTSHIFT_REEL_C07_door-creak@00-00-18-400_SYNC.wav
 * ==================================================================== */

import { timecodeFileSafe, type RenderClock } from './clock';
import type { AudioClip } from '../types';
import type { CreativeBus, SourceBus, PackageFolder } from './stemPlan';

/** 'Nightshift_reel v4.mov' → 'NIGHTSHIFT_REEL_V4' (stable, upper-snake). */
export function projectSlug(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const cleaned = base
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return (cleaned || 'PROJECT').slice(0, 32);
}

export function deliveryFileName(slug: string, stemSuffix: string, ext = 'wav'): string {
  return `UMBRA_${slug}_${stemSuffix}.${ext}`;
}

export function creativeSuffix(bus: CreativeBus): string {
  return bus; // MX, AMB, FOLEY, SFX, DESIGN, IMPACTS, SUB_LFE — already file-safe
}

export function sourceSuffix(bus: SourceBus): string {
  return bus; // PROCEDURAL / GENERATED / LIBRARY / USER
}

export type IndividualSuffixKind = 'SYNC' | 'PROC' | 'RAW';

/**
 * Individual clip file name: sortable index + readable name + the exact
 * timeline position it belongs to (so a single stray file still self-documents
 * its sync point), plus the export-mode tag.
 */
export function clipFileStem(clip: AudioClip, index: number, mode: IndividualSuffixKind, clock: RenderClock): string {
  const idx = `C${String(index + 1).padStart(3, '0')}`;
  const safe = sanitize(clip.name, 40);
  const tc = timecodeFileSafe(clip.start, clock);
  return `${idx}_${safe}@${tc}_${mode}`;
}

/** Filesystem-safe: keep letters/digits/dot/dash/underscore. */
export function sanitize(name: string, maxLen = 48): string {
  const s = name
    .replace(/[^a-zA-Z0-9.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (s || 'clip').slice(0, maxLen);
}

export function pathInPackage(folder: PackageFolder, fileName: string): string {
  return folder === 'Root' ? fileName : `${folder}/${fileName}`;
}

/** Resolve (folder, key) → file name for the planner's injected resolver. */
export function makeFileNameResolver(slug: string, individualNames?: Map<string, string>) {
  return (folder: PackageFolder, key: string, ext: string): string => {
    if (folder === 'Individual_Clips' && individualNames?.has(key)) {
      return `${individualNames.get(key)}.${ext}`;
    }
    if (folder === 'Mix' && key === 'MASTER') return deliveryFileName(slug, 'MASTER', ext);
    if (folder === 'Debug' && key === 'MIX_REF') return deliveryFileName(slug, 'MIX_REF', ext);
    return deliveryFileName(slug, key, ext);
  };
}
