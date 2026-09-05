/* ==================================================================== *
 *  POST DELIVERY — the "EXPORT FOR POST" pipeline
 *
 *  plan → preflight → render passes → WAV/BWF encode → manifest/cues/
 *  credits → ZIP. Orchestration only: classification lives in stemPlan,
 *  rendering in stemRender (the shared Web Audio graph), packaging in
 *  package.ts. Failures abort before anything is written unless the user
 *  explicitly opts into 'force'.
 * ==================================================================== */

import type { AudioClip, Project } from '../types';
import type { MasterParams } from '../dsp';
import type { ProvenanceEntry } from '../library/types';
import { exportCreditsJson, exportCreditsTxt } from '../library/credits';
import { DEFAULT_TAIL, type DeliverySampleRate, type RenderClock, type TailPolicy } from './clock';
import {
  CREATIVE_BUSES,
  SOURCE_BUSES,
  planDelivery,
  type SoloPolicy,
  type CreativeBus,
  type DeliveryPlan,
  type DeliveryScope,
  type SourceBus,
} from './stemPlan';
import { runPreflight, type PreflightReport } from './preflight';
import { renderPassWebAudio } from './stemRender';
import { encodeWaveBytes, codingHistoryRecord, type BwfMeta } from './wavio';
import { clipFileStem, projectSlug, pathInPackage, makeFileNameResolver, type IndividualSuffixKind } from './naming';
import { buildCueRows, buildCueSheetCsv, buildDeliveryManifest, buildReadme, projectProvenance, type PassStats } from './manifest';
import { buildZip, deliveryZipName, type ZipEntry } from './package';

export type { TailPolicy } from './clock';
export type { DeliveryScope } from './stemPlan';
export { DEFAULT_TAIL, TAIL_PRESETS } from './clock';
export { CREATIVE_BUSES, SOURCE_BUSES } from './stemPlan';
export { formatPreflight } from './preflight';

/* ----------------------------------------------------------- options -- */

export type PostExportPreset =
  | 'MASTER_MIX'
  | 'POST_STEMS'
  | 'ALL_STEMS'
  | 'INDIVIDUAL_CLIPS'
  | 'SELECTED_RANGE'
  | 'FULL_PROJECT';

export interface PostExportOptions {
  preset: PostExportPreset;
  /** defaults per preset: full film unless SELECTED_RANGE */
  scope?: DeliveryScope;
  tail?: TailPolicy;
  sampleRate?: DeliverySampleRate;
  bitDepth?: 16 | 24;
  container?: 'wav' | 'bwav';
  zip?: boolean;
  docs?: boolean;
  soloPolicy?: SoloPolicy;
  includeMixReference?: boolean;
  clipExportMode?: 'processed' | 'sync' | 'both';
  /** bundle each clip's original source bytes (duplicates audio — opt-in only) */
  rawSourceFiles?: boolean;
  /** ship despite preflight errors (the user insists; manifest records it) */
  force?: boolean;
}

export const POST_PRESETS: { id: PostExportPreset; label: string; blurb: string }[] = [
  { id: 'MASTER_MIX', label: 'Master mix', blurb: 'Stereo master only — -16 LUFS / -1 dBTP conformed.' },
  { id: 'POST_STEMS', label: 'Post stems', blurb: 'Master + creative buses: MX · AMB · FOLEY · SFX · DESIGN · IMPACTS · SUB_LFE.' },
  { id: 'ALL_STEMS', label: 'All stems', blurb: 'Post stems + engineering source stems (PROCEDURAL / GENERATED / LIBRARY / USER).' },
  { id: 'INDIVIDUAL_CLIPS', label: 'Individual clips', blurb: 'Per-clip files for editors: processed, sync-padded, and optionally raw.' },
  { id: 'SELECTED_RANGE', label: 'Selected range', blurb: 'Everything in All Stems, limited to the marked range. Stems start at range in-point.' },
  { id: 'FULL_PROJECT', label: 'Full project', blurb: 'Full-length All Stems + pre-master reference + full documentation + ZIP.' },
];

export interface PresetPlan {
  master: boolean;
  creative: CreativeBus[];
  sources: SourceBus[];
  individual: 'none' | 'processed' | 'sync' | 'both';
  docs: boolean;
  zip: boolean;
  mixRef: boolean;
  scope: DeliveryScope;
}

export function resolvePreset(opts: PostExportOptions, range: { start: number; end: number } | null): PresetPlan {
  const base: PresetPlan = {
    master: true,
    creative: [],
    sources: [],
    individual: 'none',
    docs: true,
    zip: false,
    mixRef: false,
    scope: { kind: 'full' },
  };
  switch (opts.preset) {
    case 'MASTER_MIX':
      return { ...base, docs: false, zip: false };
    case 'POST_STEMS':
      return { ...base, creative: [...CREATIVE_BUSES], zip: true };
    case 'ALL_STEMS':
      return { ...base, creative: [...CREATIVE_BUSES], sources: [...SOURCE_BUSES], zip: true };
    case 'INDIVIDUAL_CLIPS':
      return { ...base, master: false, individual: opts.clipExportMode ?? 'both', zip: true };
    case 'SELECTED_RANGE':
      return {
        ...base,
        creative: [...CREATIVE_BUSES],
        sources: [...SOURCE_BUSES],
        zip: true,
        scope: opts.scope ?? (range ? { kind: 'range', start: range.start, end: range.end } : { kind: 'full' }),
      };
    case 'FULL_PROJECT':
      return { ...base, creative: [...CREATIVE_BUSES], sources: [...SOURCE_BUSES], zip: true, mixRef: true };
  }
}

/* -------------------------------------------------------------- files -- */

export interface DeliveryFile {
  path: string;
  name: string;
  kind: 'wav' | 'json' | 'csv' | 'txt' | 'zip' | 'bin';
  bytes: Uint8Array;
  size: number;
  frames?: number;
  url?: string;
}

export interface DeliveryStats {
  passStats: Map<string, PassStats>;
  clipsPlacedTotal: number;
  clipsFailed: string[];
}

export interface DeliveryResult {
  plan: DeliveryPlan;
  preflight: PreflightReport;
  manifest: Record<string, unknown>;
  files: DeliveryFile[];
  zip?: DeliveryFile;
  stats: DeliveryStats;
  forced: boolean;
}

export interface DeliveryHooks {
  onProgress?: (stage: string, pct: number) => void;
  log?: (msg: string, level?: 'info' | 'ok' | 'warn' | 'gpu') => void;
  /** injected provenance source (browser: provenanceStore.list()) */
  provenance?: () => Promise<ProvenanceEntry[]>;
  /** injected raw-bytes source for RAW clip export */
  fetchRaw?: (clip: AudioClip) => Promise<Uint8Array | null>;
  /** injected decode probe for preflight (browser default uses the shared clip cache) */
  probeClip?: (clip: AudioClip, clock: RenderClock) => Promise<'ok' | 'undecodable' | 'missing'>;
}

export class DeliveryPreflightError extends Error {
  report: PreflightReport;
  constructor(report: PreflightReport) {
    const errs = report.checks.filter((c) => c.level === 'error');
    super(`delivery preflight failed: ${errs.map((e) => e.message).join(' | ') || 'see report'}`);
    this.name = 'DeliveryPreflightError';
    this.report = report;
  }
}

/* ------------------------------------------------------------ browser env */

async function defaultProbe(clip: AudioClip, clock: RenderClock): Promise<'ok' | 'undecodable' | 'missing'> {
  if (!clip.url && !clip.cacheKey) return 'missing';
  const { loadClipBuffer } = await import('../clips');
  const OfflineCtor: typeof OfflineAudioContext =
    (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (globalThis as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtor) return 'undecodable';
  try {
    // probe at the delivery rate so decoding/resampling is verified, and the
    // warm cache is reused by every render pass afterwards (ONE resample,
    // cached under url@rate — see clips.ts)
    const ctx = new OfflineCtor(1, 1, clock.sampleRate);
    await loadClipBuffer(ctx, clip.url);
    return 'ok';
  } catch {
    return 'undecodable';
  }
}

/* ------------------------------------------------------------- pipeline */

export async function runPostExport(
  project: Project,
  masterParams: MasterParams,
  opts: PostExportOptions,
  hooks: DeliveryHooks = {},
  rangeForPreset: { start: number; end: number } | null = null,
): Promise<DeliveryResult> {
  const preset = resolvePreset(opts, rangeForPreset);
  const clock: RenderClock = { sampleRate: opts.sampleRate ?? 48000 };
  const bitDepth = opts.bitDepth ?? 24;
  const container = opts.container ?? 'bwav';
  const slug = projectSlug(project.name);
  const progress = (s: string, p: number) => hooks.onProgress?.(s, p);
  hooks.log?.(`delivery: ${opts.preset} @ ${clock.sampleRate / 1000} kHz / ${bitDepth}-bit / ${container === 'bwav' ? 'BWF' : 'WAV'}`, 'gpu');

  /* 1 — plan (pure) -------------------------------------------------------- */
  progress('plan', 2);
  // individual clip file names, ordered by timeline position
  const ordered = [...(project.clips ?? [])].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const indexById = new Map(ordered.map((c, i) => [c.id, i]));
  const individualNames = new Map<string, string>();
  for (const c of ordered) {
    const i = indexById.get(c.id)!;
    for (const mode of ['SYNC', 'PROC', 'RAW'] as IndividualSuffixKind[]) {
      individualNames.set(`${mode}_${c.id}`, clipFileStem(c, i, mode, clock));
    }
  }

  const plan = planDelivery(project, {
    clock,
    scope: opts.scope ?? preset.scope,
    tail: opts.tail ?? DEFAULT_TAIL,
    creative: preset.creative,
    sources: preset.sources,
    includeMaster: preset.master,
    includeMixReference: opts.includeMixReference ?? preset.mixRef,
    soloPolicy: (opts.soloPolicy ?? 'ignore') as SoloPolicy,
    individualClips: preset.individual,
    fileName: makeFileNameResolver(slug, individualNames),
  });

  /* 2 — preflight ---------------------------------------------------------- */
  progress('preflight', 5);
  const probe = hooks.probeClip ?? ((c: AudioClip, k: RenderClock) => defaultProbe(c, k));
  const probeById = new Map(plan.audibleClips.map((c) => [c.id, c]));
  const preflight = await runPreflight(plan, {
    probeClip: async (clipId) => {
      const c = probeById.get(clipId);
      if (!c) return 'missing';
      return probe(c, clock);
    },
  }, { bitDepth });
  if (!preflight.ok && !opts.force) throw new DeliveryPreflightError(preflight);
  if (!preflight.ok && opts.force) hooks.log?.('delivery: preflight errors present — FORCED export; failures recorded in the manifest', 'warn');

  /* 3 — render every pass through the real graph --------------------------- */
  const files: DeliveryFile[] = [];
  const passStats = new Map<string, PassStats>();
  const fileNames = new Map<string, string>();
  let placedTotal = 0;
  const failedAll: string[] = [];
  const now = new Date();
  const iso = now.toISOString();

  const passes = plan.passes;
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    progress(`render ${pass.label}`, 8 + (i / Math.max(1, passes.length)) * 72);
    const out = await renderPassWebAudio(plan, pass, masterParams);
    passStats.set(pass.id, {
      peakDb: out.peakDb,
      lufs: out.lufs,
      clipsPlaced: out.clipsPlaced,
      clipsFailed: out.clipsFailed,
    });
    placedTotal += out.clipsPlaced;
    failedAll.push(...out.clipsFailed);

    const bwf: BwfMeta | undefined =
      container === 'bwav'
        ? {
            description: `${pass.label} — ${project.name}`.slice(0, 250),
            originator: 'UMBRA·SCORE',
            originatorReference: `UMBRA-DELIVERY-1/${pass.id}`.slice(0, 32),
            originationDate: iso.slice(0, 10),
            originationTime: iso.slice(11, 19),
            // samples from the declared session origin (project 00:00) to this
            // file's start — the honest value; midnight TC is not modelled
            timeReferenceSample: plan.span.startSample,
            codingHistory: codingHistoryRecord(clock.sampleRate, bitDepth, `[${pass.id}] Σ-reconstructable pre-master stem`),
          }
        : undefined;
    const bytes = encodeWaveBytes([out.L, out.R], clock.sampleRate, { bitDepth, bwf });
    const path = pathInPackage(pass.folder, pass.fileName);
    fileNames.set(pass.id, pass.fileName);
    files.push({ path, name: pass.fileName, kind: 'wav', bytes, size: bytes.length, frames: pass.frameCount });
    hooks.log?.(`delivery: ${pass.fileName} · ${(pass.frameCount / clock.sampleRate).toFixed(3)}s · peak ${out.peakDb.toFixed(1)} dB${pass.loudnessConform ? ` · ${out.lufs.toFixed(1)} LUFS` : ''}`, 'ok');
  }

  /* 4 — raw source bytes (opt-in; duplicates audio) ------------------------- */
  if (preset.individual !== 'none' && opts.rawSourceFiles && hooks.fetchRaw) {
    progress('raw sources', 82);
    let rawFailed = 0;
    for (const c of plan.audibleClips) {
      try {
        const raw = await hooks.fetchRaw(c);
        if (raw && raw.length > 4) {
          const isWav = raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46; // 'RIFF'
          const base = individualNames.get(`RAW_${c.id}`) ?? `RAW_${c.id}`;
          const name = `${base}${isWav ? '.wav' : '.raw'}`;
          files.push({ path: pathInPackage('Individual_Clips', name), name, kind: isWav ? 'wav' : 'bin', bytes: raw, size: raw.length });
        } else rawFailed++;
      } catch {
        rawFailed++;
      }
    }
    if (rawFailed) hooks.log?.(`delivery: ${rawFailed} raw source file(s) unavailable — listed as missing, never faked`, 'warn');
  }

  /* 5 — documentation -------------------------------------------------------- */
  progress('documentation', 86);
  const manifest = buildDeliveryManifest(
    plan,
    { bitDepth, container, channels: 2 },
    passStats,
    fileNames,
    { exportedAt: iso, toolVersion: '1.0', zipName: preset.zip ? deliveryZipName(slug) : undefined },
  );
  if (opts.force && !preflight.ok) (manifest as Record<string, unknown>).forcedDespitePreflight = true;

  const textFiles: { path: string; name: string; kind: 'json' | 'csv' | 'txt'; text: string }[] = [
    { path: 'Documentation/delivery_manifest.json', name: 'delivery_manifest.json', kind: 'json', text: JSON.stringify(manifest, null, 2) },
    (() => {
      const rows = buildCueRows(plan);
      return {
        path: 'Documentation/cue_sheet.csv',
        name: 'cue_sheet.csv',
        kind: 'csv' as const,
        text: buildCueSheetCsv(rows),
      };
    })(),
    {
      path: 'Documentation/cue_sheet.json',
      name: 'cue_sheet.json',
      kind: 'json',
      text: JSON.stringify({ format: 'umbra-cue/1', columns: ['START', 'END', 'DURATION', 'CLIP', 'ROLE', 'STEM', 'SOURCE', 'PROVIDER', 'SOURCE_ID', 'LICENSE', 'CREATOR', 'NOTES'], rows: buildCueRows(plan) }, null, 2),
    },
    { path: 'Documentation/README.txt', name: 'README.txt', kind: 'txt', text: buildReadme(plan, { bitDepth, container, channels: 2 }) },
    {
      path: 'Documentation/export_log.txt',
      name: 'export_log.txt',
      kind: 'txt',
      text: [
        `UMBRA·SCORE delivery log — ${iso}`,
        `preset=${opts.preset} scope=${plan.scope.kind} sr=${clock.sampleRate} bit=${bitDepth} container=${container}`,
        `picture=${plan.pictureEnd.toFixed(3)}s (${plan.picture.source}) tail=${plan.tailSeconds.toFixed(3)}s frameCount=${plan.span.frameCount}`,
        `placed=${placedTotal} clip-render passes, failed=${failedAll.length ? failedAll.join(', ') : 'none'}`,
        '',
        '— preflight —',
        ...preflight.checks.map((c) => `[${c.level.toUpperCase()}] ${c.code}: ${c.message}`),
      ].join('\n'),
    },
  ];

  if (opts.docs !== false && preset.docs) {
    for (const t of textFiles) {
      files.push({ path: t.path, name: t.name, kind: t.kind, bytes: new TextEncoder().encode(t.text), size: 0 });
      files[files.length - 1].size = files[files.length - 1].bytes.length;
    }
    // credits from the EXISTING provenance ledger
    const entries = (await hooks.provenance?.()) ?? [];
    if (entries.length) {
      const scoped = projectProvenance(entries, plan.clips);
      const projectName = plan.projectName;
      files.push({
        path: 'Documentation/sound_credits.txt',
        name: 'sound_credits.txt',
        kind: 'txt',
        bytes: new TextEncoder().encode(exportCreditsTxt(scoped, projectName, plan.pictureEnd)),
        size: 0,
      });
      files[files.length - 1].size = files[files.length - 1].bytes.length;
      files.push({
        path: 'Documentation/sound_credits.json',
        name: 'sound_credits.json',
        kind: 'json',
        bytes: new TextEncoder().encode(exportCreditsJson(scoped, projectName, plan.pictureEnd)),
        size: 0,
      });
      files[files.length - 1].size = files[files.length - 1].bytes.length;
    }
  }

  /* 6 — zip ------------------------------------------------------------------ */
  let zipFile: DeliveryFile | undefined;
  if (opts.zip !== false && preset.zip) {
    progress('packaging', 94);
    const entries: ZipEntry[] = files.map((f) => ({ path: f.path, data: f.bytes }));
    const zipped = await buildZip(entries);
    const name = deliveryZipName(slug);
    zipFile = { path: name, name, kind: 'zip', bytes: zipped, size: zipped.length };
  }
  progress('done', 100);

  return {
    plan,
    preflight,
    manifest,
    files,
    zip: zipFile,
    stats: { passStats, clipsPlacedTotal: placedTotal, clipsFailed: [...new Set(failedAll)] },
    forced: !preflight.ok && !!opts.force,
  };
}

/* ------------------------------------------------------------ download -- */

export function fileObjectUrl(f: DeliveryFile): string {
  if (!f.url) {
    const mime = f.kind === 'wav' ? 'audio/wav' : f.kind === 'zip' ? 'application/zip' : f.kind === 'json' ? 'application/json' : f.kind === 'csv' ? 'text/csv' : 'text/plain';
    f.url = URL.createObjectURL(new Blob([f.bytes.slice().buffer as ArrayBuffer], { type: mime }));
  }
  return f.url;
}

export function downloadDeliveryFile(f: DeliveryFile): void {
  const a = document.createElement('a');
  a.href = fileObjectUrl(f);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
