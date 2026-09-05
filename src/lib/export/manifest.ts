/* ==================================================================== *
 *  DELIVERY MANIFEST + CUE SHEET
 *
 *  Machine-readable documentation of exactly what shipped and where it
 *  belongs. Derived ONLY from the plan + the timeline state — no parallel
 *  provenance store, no second source of truth:
 *
 *    delivery_manifest.json — sample-exact session description (DAW-safe)
 *    cue_sheet.csv          — editorial cue sheet (START/END/… per §11)
 *    cue_sheet.json         — same data, machine-first consumers/agents
 *    sound_credits.txt/json — via the existing provenance ledger
 *                             (src/lib/library/credits.ts)
 *
 *  BWF status: BWF 'bext' time references are written when container ===
 *  'bwav' (real BWF v0 — see wavio.ts). Plain WAV delivery carries timing
 *  exclusively in this manifest. We never claim more than we write.
 * ==================================================================== */

import { timecode } from './clock';
import type { DeliveryPlan, StemPassPlan } from './stemPlan';
import { CREATIVE_BUSES, SOURCE_BUSES } from './stemPlan';
import type { AudioClip } from '../types';
import type { ProvenanceEntry } from '../library/types';

export interface PassStats {
  peakDb: number;
  lufs: number;
  clipsPlaced: number;
  clipsFailed: string[];
}

export interface DeliveryFormatInfo {
  bitDepth: 16 | 24;
  container: 'wav' | 'bwav';
  channels: 2;
}

function clipFields(c: AudioClip) {
  return {
    clipId: c.id,
    name: c.name,
    role: c.role ?? null,
    provider: c.provider,
    source: c.source ?? null,
    timelineStartSeconds: c.start,
    timelineEndSeconds: c.start + c.duration,
    sourceOffsetSeconds: c.offset,
    fadeSeconds: { in: c.fadeIn, out: c.fadeOut },
    gain: c.gain,
    pan: c.pan,
    muted: !!c.muted,
    sourceId: c.asset?.soundId ?? c.audioId ?? null,
    license: c.asset?.license ?? null,
    licenseClass: c.asset?.licenseClass ?? null,
    creator: c.asset?.creator ?? null,
    creditLine: c.asset?.creditLine ?? null,
    sourceUrl: c.asset?.sourceUrl ?? null,
    match: c.match ?? null,
    intentId: c.intentId ?? null,
    metadata: c.metadata ?? null,
  };
}

function stemEntry(plan: DeliveryPlan, pass: StemPassPlan, stats: PassStats | undefined, fmt: DeliveryFormatInfo, fileName: string) {
  const clipIds = pass.clips.map((p) => p.clipId);
  return {
    id: pass.id,
    label: pass.label,
    kind: pass.mode,
    bus: pass.bus,
    file: fileName,
    folder: pass.folder,
    /** every consolidated stem shares this exactly */
    startSample: 0,
    frameCount: pass.frameCount,
    durationSeconds: pass.frameCount / plan.clock.sampleRate,
    sampleRate: plan.clock.sampleRate,
    bitDepth: fmt.bitDepth,
    channels: fmt.channels,
    container: fmt.container,
    /** where in the PROJECT this stem begins (sample-exact) */
    projectOriginSample: plan.span.startSample,
    clipIds,
    layerCount: pass.layers.length,
    loudnessConform: pass.loudnessConform,
    masterFx: pass.masterFx,
    subOut: pass.subOut,
    measured: stats
      ? { peakDb: +stats.peakDb.toFixed(2), integratedLufs: +stats.lufs.toFixed(2), informationalOnly: !pass.loudnessConform }
      : null,
    failedClips: stats?.clipsFailed ?? [],
  };
}

export function buildDeliveryManifest(
  plan: DeliveryPlan,
  fmt: DeliveryFormatInfo,
  passStats: Map<string, PassStats>,
  fileNames: Map<string, string>,
  opts: { exportedAt: string; toolVersion: string; zipName?: string },
) {
  const sr = plan.clock.sampleRate;
  return {
    format: 'umbra-delivery/1',
    generatedBy: `UMBRA·SCORE ${opts.toolVersion}`,
    exportedAt: opts.exportedAt,
    project: plan.projectName,
    sampleRate: sr,
    bitDepth: fmt.bitDepth,
    channels: fmt.channels,
    container: fmt.container,
    /** project 00:00 in absolute BWF/midnight terms — 0 until the model carries source timecode */
    projectStart: plan.windowStart,
    projectStartSample: plan.span.startSample,
    /** authoritative delivery span (§8): duration + tail policy */
    videoDuration: +plan.pictureEnd.toFixed(6),
    videoDurationSamples: Math.round(plan.pictureEnd * sr),
    durationAuthority: plan.picture.source,
    durationNote: plan.picture.note ?? null,
    tailSeconds: plan.tailSeconds,
    tailPolicy: plan.tail,
    deliveryDurationSeconds: plan.span.frameCount / sr,
    deliveryFrameCount: plan.span.frameCount,
    fps: plan.fps,
    soloPolicy: plan.soloPolicy,
    timeReference:
      fmt.container === 'bwav'
        ? 'BWF bext TimeReference = samples from project 00:00 (0 for full-film stems; range/scene stems carry the window origin)'
        : 'plain PCM WAV — timing authority lives in this manifest',
    stems: plan.passes.map((p) => stemEntry(plan, p, passStats.get(p.id), fmt, fileNames.get(p.id) ?? p.fileName)),
    clips: plan.clips.map((c) => {
      const placement = plan.passes.find((p) => p.mode === 'master' || p.mode === 'reference')?.clips.find((cp) => cp.clipId === c.id);
      return {
        ...clipFields(c),
        /** sample-exact anchors from the render clock — the same numbers every stem uses */
        startSample: placement?.startSampleAbs ?? Math.round(c.start * sr),
        endSample: placement?.endSampleAbs ?? Math.round((c.start + c.duration) * sr),
        sourceOffsetSample: placement?.offsetSample ?? Math.round(c.offset * sr),
        stem: placement?.creativeBus ?? 'EXCLUDED',
        sourceStem: placement?.sourceBus ?? null,
        startTc: timecode(c.start - plan.windowStart, { clock: plan.clock }),
      };
    }),
    excluded: {
      mutedClipIds: plan.mutedClipIds,
      tooShortClipIds: plan.passes.flatMap((p) => p.skippedClipIds.map((s) => s.clipId)),
    },
    contract: {
      /** the acceptance criterion, in one line */
      import: 'Place every stem at 00:00 on one timeline; all files share length, rate, depth and origin.',
      reconstruction: `SUM(creative stems) = SUM(source stems) = pre-master mix within float tolerance. ${
        CREATIVE_BUSES.map((b) => b).join('+')
      } covered; MASTER applies glue/tape/limiter + BS.1770 conform on top.`,
      stemsNotIndependentlyMastered: true,
      subOwnership: 'SUB_LFE (creative axis) and PROCEDURAL (source axis) each own the sub-chain output; creative and source axes are alternative views — never sum the two sets together.',
    },
    zip: opts.zipName ?? null,
  };
}

/* ---------------------------------------------------------- cue sheet -- */

export const CUE_SHEET_COLUMNS = [
  'START',
  'END',
  'DURATION',
  'CLIP',
  'ROLE',
  'STEM',
  'SOURCE',
  'PROVIDER',
  'SOURCE_ID',
  'LICENSE',
  'CREATOR',
  'NOTES',
] as const;

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CueRow {
  start: string;
  end: string;
  duration: string;
  clip: string;
  role: string;
  stem: string;
  source: string;
  provider: string;
  sourceId: string;
  license: string;
  creator: string;
  notes: string;
  startSample: number;
  endSample: number;
}

/**
 * Cue rows for every audible clip, sorted by timeline position — derived
 * from the plan (timeline + existing provenance data only).
 */
export function buildCueRows(plan: DeliveryPlan): CueRow[] {
  const sr = plan.clock.sampleRate;
  const masterPass = plan.passes.find((p) => p.mode === 'master') ?? plan.passes.find((p) => p.mode === 'reference');
  const rows = plan.audibleClips
    .map((c) => {
      const p = masterPass?.clips.find((cp) => cp.clipId === c.id);
      const startRel = (p?.startSampleAbs ?? Math.round(c.start * sr)) - plan.span.startSample;
      const endRel = (p?.endSampleAbs ?? Math.round((c.start + c.duration) * sr)) - plan.span.startSample;
      const notes: string[] = [];
      if (c.intentId) notes.push('auto-placed');
      if (typeof c.match === 'number') notes.push(`confidence ${c.match.toFixed(2)}`);
      if (c.variantIndex) notes.push(`v${c.variantIndex + 1}`);
      if (c.transform && (c.transform.playbackRate !== 1 || c.transform.pitch !== 0)) {
        notes.push(`xform rate ${c.transform.playbackRate.toFixed(2)} pitch ${c.transform.pitch >= 0 ? '+' : ''}${c.transform.pitch}`);
      }
      const srcTag = c.source ?? (c.provider === 'umbra-procedural' ? 'PROC' : c.provider === 'ace-step' || c.provider === 'stable-audio' || c.provider === 'mmaudio' ? 'GEN' : c.provider === 'user' ? 'USR' : 'LIB');
      return {
        start: timecode(startRel / sr, { fps: plan.fps, frames: true, clock: plan.clock }),
        end: timecode(endRel / sr, { fps: plan.fps, frames: true, clock: plan.clock }),
        duration: timecode(Math.max(0, endRel - startRel) / sr, { fps: plan.fps, frames: true, clock: plan.clock }),
        clip: c.name,
        role: c.role ?? 'MISC_FOLEY',
        stem: p?.creativeBus ?? 'SFX',
        source: srcTag,
        provider: c.asset?.providerLabel ?? c.provider,
        sourceId: c.asset?.soundId ?? c.audioId,
        license: c.asset?.license ?? 'unknown',
        creator: c.asset?.creator ?? '—',
        notes: notes.join('; ') || (c.role ? 'placed' : 'manual'),
        startSample: startRel,
        endSample: endRel,
      } satisfies CueRow;
    })
    .sort((a, b) => a.startSample - b.startSample || a.clip.localeCompare(b.clip));
  return rows;
}

export function buildCueSheetCsv(rows: CueRow[]): string {
  const lines = [CUE_SHEET_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [r.start, r.end, r.duration, r.clip, r.role, r.stem, r.source, r.provider, r.sourceId, r.license, r.creator, r.notes]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/* ----------------------------------------------------- credits wiring -- */

/** Filter the EXISTING provenance ledger to the delivered clips. */
export function projectProvenance(entries: ProvenanceEntry[], clips: AudioClip[]): ProvenanceEntry[] {
  const ids = new Set(clips.map((c) => c.id));
  return entries.filter((e) => ids.has(e.clipId));
}

export function soundCreditsJson(manifestProject: string, duration: number, entries: ProvenanceEntry[]): string {
  // De-duplicate on provider+soundId exactly like the existing ledger export,
  // but re-serialize here so the delivery package owns its own copy.
  const unique = new Map<string, ProvenanceEntry>();
  for (const e of entries) {
    const key = `${e.asset.provider}|${e.asset.soundId}`;
    if (!unique.has(key)) unique.set(key, e);
  }
  const deduped = [...unique.values()].sort((a, b) => a.usedAt - b.usedAt);
  return JSON.stringify(
    {
      project: manifestProject,
      duration,
      count: deduped.length,
      entries: deduped.map((e) => ({
        source: e.asset.providerLabel,
        provider: e.asset.provider,
        title: e.asset.title,
        creator: e.asset.creator,
        soundId: e.asset.soundId,
        sourceUrl: e.asset.sourceUrl,
        license: e.asset.license,
        licenseClass: e.asset.licenseClass,
        attributionRequired: e.asset.attributionRequired,
        creditLine: e.asset.creditLine,
        quality: e.asset.quality,
        md5: e.asset.md5 ?? null,
      })),
    },
    null,
    2,
  );
}

export function buildReadme(plan: DeliveryPlan, fmt: DeliveryFormatInfo): string {
  const sr = plan.clock.sampleRate;
  return [
    'UMBRA·SCORE — POST DELIVERY PACKAGE',
    '===================================',
    '',
    `Project        : ${plan.projectName}`,
    `Delivery span  : 0…${plan.span.frameCount} samples (${(plan.span.frameCount / sr).toFixed(3)} s) @ ${sr} Hz / ${fmt.bitDepth}-bit PCM${fmt.container === 'bwav' ? ' / BWF (bext)' : ''}`,
    `Picture        : ${plan.pictureEnd.toFixed(3)} s — authority: ${plan.picture.source}${plan.picture.note ? ` (${plan.picture.note})` : ''}`,
    `Tail policy    : ${plan.tail.kind}${plan.tail.kind !== 'exact' ? ` + ${(plan.tail as { seconds: number }).seconds} s` : ''}`,
    `Solo policy    : ${plan.soloPolicy === 'honor' ? 'HONORED — soloed clips only!' : 'ignored (mutes still honored)'}`,
    '',
    'HOW TO USE',
    '  1. Create a session at the exact sample rate above.',
    '  2. Drag every file from Mix/ + Post_Stems/ (or Source_Stems/) to 00:00.',
    '  3. They are mutually sample-aligned: no nudging, ever.',
    '',
    'THE CONTRACT',
    '  • Post_Stems = creative buses (MX/AMB/FOLEY/SFX/DESIGN/IMPACTS/SUB_LFE).',
    '  • Source_Stems = provenance axis (PROCEDURAL/GENERATED/LIBRARY/USER).',
    '    The two sets are ALTERNATIVE views of the same mix — never sum both.',
    '  • Stems are pre-master: the shared bus glue comp, tape drive, exciter and',
    '    limiter are bypassed on stems BY DESIGN so Σ stems nulls against the',
    '    pre-master mix (float tolerance; see delivery_manifest.json).',
    '  • Reverb: each stem carries only ITS OWN send contributions (deterministic',
    '    IRs) — no duplicated wet energy, no lost tails.',
    '  • Sub: the nonlinear sub-chain output lives in SUB_LFE (and PROCEDURAL).',
    '  • MASTER is the only loudness-conformed file (-16 LUFS / -1 dBTP).',
    '    Stems intentionally preserve headroom and dynamic contrast.',
    '',
    'Files',
    '  delivery_manifest.json  sample-exact session map (positions, licenses, stems)',
    '  cue_sheet.csv           editorial cue sheet, sorted by time',
    '  sound_credits.txt/json  attribution ledger (from the project provenance store)',
    '  export_log.txt          preflight report + render stats',
    '',
    'If a file was missing or silent that you expected: check the manifest',
    '`excluded` block first — Umbra reports omissions, it does not hide them.',
  ].join('\n');
}

export const CUE_COLUMNS = CUE_SHEET_COLUMNS;
export const STEM_AXES = { creative: CREATIVE_BUSES, source: SOURCE_BUSES };
