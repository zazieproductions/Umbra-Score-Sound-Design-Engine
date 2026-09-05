/* ==================================================================== *
 *  EXPORT PREFLIGHT — never silently export a broken session.
 *
 *  Runs before any file is written. It builds on the renderer's existing
 *  clipsPlaced / clipsFailed philosophy and extends it to the whole
 *  delivery contract: decode authority, blob presence, licensing,
 *  duration authority, stem-partition integrity (every audible clip in
 *  exactly one creative bus and one source bus) and uniform stem length.
 *
 *  `probe` is injected so the check logic is unit-testable in Node with a
 *  fake resolver; the browser implementation decodes through the shared
 *  clip cache (delivery.ts).
 * ==================================================================== */

import { DELIVERY_BIT_DEPTHS, DELIVERY_SAMPLE_RATES } from './clock';
import { CREATIVE_BUSES, SOURCE_BUSES, type DeliveryPlan } from './stemPlan';

export type PreflightLevel = 'ok' | 'info' | 'warn' | 'error';

export interface PreflightCheck {
  level: PreflightLevel;
  /** stable machine code — UI/tests must not match on prose */
  code: string;
  message: string;
  refs?: string[];
}

export type ClipProbeResult = 'ok' | 'undecodable' | 'missing';

export interface PreflightEnv {
  /** attempt to fetch+decode the clip's audio; 'missing' = no reference at all */
  probeClip(clipId: string): Promise<ClipProbeResult>;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  counts: {
    clipsInWindow: number;
    clipsAudible: number;
    decoded: number;
    undecodable: number;
    missing: number;
    muted: number;
    skippedTooShort: number;
    unknownLicense: number;
    externalAssets: number;
    soloActive: number;
    stemsPlanned: number;
  };
}

/** format is validated by the caller (delivery.ts) — the report checks the plan's contract. */
export interface PreflightFormat {
  bitDepth?: 16 | 24;
}

export async function runPreflight(plan: DeliveryPlan, env: PreflightEnv, format: PreflightFormat = {}): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (level: PreflightLevel, code: string, message: string, refs?: string[]) =>
    checks.push({ level, code, message, refs });

  /* clock + format support */
  if (!DELIVERY_SAMPLE_RATES.some((r) => r === plan.clock.sampleRate)) {
    add('error', 'sr-unsupported', `${plan.clock.sampleRate} Hz is not a supported delivery rate (44.1/48/96 kHz)`);
  } else {
    add('ok', 'sr', `${plan.clock.sampleRate / 1000} kHz`);
  }
  if (format.bitDepth !== undefined) {
    if (DELIVERY_BIT_DEPTHS.some((b) => b === format.bitDepth)) add('ok', 'bitdepth', `${format.bitDepth}-bit PCM`);
    else add('error', 'bitdepth-unsupported', `${format.bitDepth}-bit is not a supported delivery depth (16/24-bit PCM)`);
  }

  /* duration authority */
  if (plan.picture.source === 'last-event-fallback') {
    add('warn', 'duration-fallback', `video/project duration unavailable — delivery span derived from furthest timeline event (${plan.pictureEnd.toFixed(3)} s)`);
  } else if (plan.pictureEnd <= 0) {
    add('error', 'duration-zero', 'project duration resolves to 0 — nothing to deliver');
  } else {
    add('ok', 'duration', `project duration resolved (${plan.picture.source}): ${plan.pictureEnd.toFixed(3)} s + ${plan.tailSeconds.toFixed(3)} s tail`);
  }

  /* empty timeline */
  if (plan.audibleClips.length === 0 && plan.scenes.every((s) => s.layers.every((l) => l.muted || !l))) {
    add('warn', 'empty', 'no audible clips or layers in the delivery window — package will be silence');
  }

  /* decode probe — the big one */
  const probeResults = await Promise.all(
    plan.audibleClips.map(async (c) => ({ id: c.id, name: c.name, result: await env.probeClip(c.id) })),
  );
  const undecodable = probeResults.filter((r) => r.result === 'undecodable');
  const missing = probeResults.filter((r) => r.result === 'missing');
  const okCount = probeResults.filter((r) => r.result === 'ok').length;

  // structural: a timeline clip must reference real audio
  for (const c of plan.audibleClips) {
    if (!c.url && !c.cacheKey && !c.audioId) {
      add('error', 'no-audio-reference', `clip "${c.name}" references no real audio (no url / cacheKey / audioId)`, [c.id]);
    }
  }
  if (missing.length) add('error', 'clips-missing', `${missing.length} timeline clip(s) reference missing audio and would be omitted from every stem`, missing.map((m) => m.name));
  if (undecodable.length) add('error', 'clips-undecodable', `${undecodable.length} timeline clip(s) could not be decoded — export blocked until they are restored or removed`, undecodable.map((m) => m.name));
  if (probeResults.length === 0) add('info', 'no-clips', 'no clips to decode (procedural layers only)');
  else if (!undecodable.length && !missing.length) add('ok', 'clips-decoded', `${okCount}/${probeResults.length} timeline clips decoded`);

  /* muted / skipped — reported, never silent */
  if (plan.mutedClipIds.length) add('info', 'muted', `${plan.mutedClipIds.length} muted clip(s) excluded from delivery by policy`, plan.mutedClipIds);
  for (const pass of plan.passes) {
    for (const sk of pass.skippedClipIds) add('warn', 'clip-too-short', `clip ${sk.clipId} is shorter than the render floor inside this window — excluded from ${pass.label}`, [sk.clipId]);
  }

  /* solo state */
  const soloCount = plan.soloActiveClips + plan.soloActiveLayers;
  if (soloCount > 0) {
    add(
      plan.soloPolicy === 'honor' ? 'warn' : 'info',
      'solo-state',
      plan.soloPolicy === 'honor'
        ? `${soloCount} object(s) in solo — delivery is honoring solo state and WILL omit material. Normal for monitoring, unusual for delivery.`
        : `${soloCount} object(s) carry solo state — delivery ignores solo by policy; everything unmuted ships (honor-solo export is opt-in)`,
    );
  }

  /* licensing */
  let unknown = 0;
  let external = 0;
  const unknownIds: string[] = [];
  for (const c of plan.audibleClips) {
    if (c.asset) {
      external++;
      if (c.asset.licenseClass === 'UNKNOWN' || !c.asset.license) {
        unknown++;
        unknownIds.push(c.name);
      }
    }
  }
  if (external > 0) add(unknown ? 'warn' : 'ok', 'provenance', unknown ? `provenance for ${external - unknown}/${external} external assets — ${unknown} with unknown license metadata` : `provenance available for ${external} external assets`, unknown ? unknownIds : undefined);

  /* stem partition integrity — the architectural invariant, checked live */
  const creativePasses = plan.passes.filter((p) => p.mode === 'creative');
  const sourcePasses = plan.passes.filter((p) => p.mode === 'source');
  const mixPass = plan.passes.find((p) => p.mode === 'reference' || p.mode === 'master');
  if (creativePasses.length > 0) {
    const perClip = new Map<string, number>();
    for (const pass of creativePasses) for (const cp of pass.clips) perClip.set(cp.clipId, (perClip.get(cp.clipId) ?? 0) + 1);
    const dup = [...perClip.entries()].filter(([, n]) => n !== 1);
    if (dup.length) add('error', 'partition-dup', `${dup.length} clip(s) appear in more than one creative stem — stems would double-count`, dup.map(([id]) => id));
    const missingFromStems = plan.audibleClips.filter((c) => !perClip.has(c.id));
    const unaccounted = missingFromStems.filter((c) => !plan.passes.some((p) => p.mode === 'creative' && p.skippedClipIds.some((s) => s.clipId === c.id)));
    if (unaccounted.length) add('error', 'partition-loss', `${unaccounted.length} audible clip(s) missing from the creative stem set`, unaccounted.map((c) => c.name));
    if (!dup.length && !unaccounted.length) add('ok', 'partition', `every audible clip is assigned to exactly one of ${creativePasses.length} creative stems (${CREATIVE_BUSES.join(', ')})`);
  }
  if (sourcePasses.length > 0) {
    const seen = new Set<string>();
    const dupS: string[] = [];
    for (const pass of sourcePasses)
      for (const cp of pass.clips) {
        if (seen.has(cp.clipId)) dupS.push(cp.clipId);
        seen.add(cp.clipId);
      }
    if (dupS.length) add('error', 'source-partition-dup', 'clip assigned to two source stems', [...new Set(dupS)]);
    else add('ok', 'source-partition', `source stems cover ${seen.size} clip(s) across ${SOURCE_BUSES.join('/')}`);
  }

  /* uniform stem length — never silently vary */
  const consolidated = plan.passes.filter((p) => p.mode !== 'clip-processed');
  const lens = new Set(consolidated.map((p) => p.frameCount));
  if (lens.size > 1) add('error', 'length-mismatch', `consolidated stems disagree on length: ${[...lens].join(' / ')} frames`);
  else if (consolidated.length) add('ok', 'length', `${consolidated.length} consolidated files × ${[...lens][0]} frames (${([...lens][0] / plan.clock.sampleRate).toFixed(3)} s) — mutually sample-aligned by construction`);

  if (mixPass) add('info', 'recon', 'reconstruction contract: Σ creative stems = Σ source stems = pre-master mix (master-bus glue/tape/limiter and BS.1770 conform apply to MASTER only — see docs/architecture/DELIVERY.md)');

  const errors = checks.filter((c) => c.level === 'error');
  return {
    ok: errors.length === 0,
    checks,
    counts: {
      clipsInWindow: plan.clips.length,
      clipsAudible: plan.audibleClips.length,
      decoded: okCount,
      undecodable: undecodable.length,
      missing: missing.length,
      muted: plan.mutedClipIds.length,
      skippedTooShort: plan.passes.reduce((a, p) => a + p.skippedClipIds.length, 0),
      unknownLicense: unknown,
      externalAssets: external,
      soloActive: soloCount,
      stemsPlanned: plan.passes.length,
    },
  };
}

/** Glyph formatting for the export console / logs. */
export function formatPreflight(r: PreflightReport): string[] {
  const glyph: Record<PreflightLevel, string> = { ok: '✓', info: '·', warn: '⚠', error: '✕' };
  return r.checks.map((c) => `${glyph[c.level]} ${c.message}${c.refs?.length ? ` [${c.refs.slice(0, 6).join(', ')}${c.refs.length > 6 ? '…' : ''}]` : ''}`);
}
