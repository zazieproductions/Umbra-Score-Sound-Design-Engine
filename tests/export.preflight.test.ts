/* ==================================================================== *
 *  PREFLIGHT (§14) + PACKAGING (§10)
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  CREATIVE_BUSES,
  SOURCE_BUSES,
  buildZip,
  formatPreflight,
  planDelivery,
  runPreflight,
  type PreflightEnv,
} from '../src/lib/export';
import { mkClip, mkProject, planOptions, SR } from './export.fixtures';

const clock = { sampleRate: SR };

function makePlan(clips: ReturnType<typeof mkClip>[]) {
  const project = mkProject(clips, [], { duration: 60 });
  return planDelivery(project, {
    clock,
    scope: { kind: 'full' },
    creative: [...CREATIVE_BUSES],
    sources: [...SOURCE_BUSES],
    includeMaster: true,
    ...planOptions(),
  });
}

function envWith(results: Record<string, 'ok' | 'undecodable' | 'missing'>): PreflightEnv {
  return {
    probeClip: async (clipId) => results[clipId] ?? 'ok',
  };
}

describe('preflight — validate before you write', () => {
  it('a healthy session passes with informative ✓ lines', async () => {
    const clips = [mkClip({ id: 'a', start: 4, duration: 2 })];
    const plan = makePlan(clips);
    const report = await runPreflight(plan, envWith({}), { bitDepth: 24 });
    expect(report.ok).toBe(true);
    const codes = report.checks.map((c) => c.code);
    expect(codes).toContain('sr');
    expect(codes).toContain('bitdepth');
    expect(codes).toContain('duration');
    expect(codes).toContain('clips-decoded');
    expect(codes).toContain('partition');
    expect(codes).toContain('length');
    expect(report.counts.decoded).toBe(1);
    const lines = formatPreflight(report);
    expect(lines.some((l) => l.startsWith('✓'))).toBe(true);
  });

  it('F · one missing asset blocks delivery with a clear error (§17 F)', async () => {
    const clips = [mkClip({ id: 'good', start: 1, duration: 2 }), mkClip({ id: 'bad', start: 5, duration: 2 })];
    const plan = makePlan(clips);
    const report = await runPreflight(plan, envWith({ bad: 'undecodable' }));
    expect(report.ok).toBe(false);
    const err = report.checks.find((c) => c.code === 'clips-undecodable');
    expect(err?.level).toBe('error');
    expect(err?.message).toContain('could not be decoded');
    expect(err?.refs).toContain('clip-bad');
  });

  it('a clip referencing no real audio at all fails the architecture invariant check', async () => {
    const orphan = mkClip({ id: 'orphan', start: 1, duration: 2, url: '', cacheKey: undefined, audioId: '' });
    const plan = makePlan([orphan]);
    const report = await runPreflight(plan, envWith({}));
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.code)).toContain('no-audio-reference');
  });

  it('unsupported sample rate is an error; unknown licenses are warnings', async () => {
    const asset = {
      provider: 'freesound' as const,
      providerLabel: 'Freesound',
      soundId: '9',
      title: 'x',
      creator: 'y',
      sourceUrl: '',
      license: '',
      licenseClass: 'UNKNOWN' as const,
      attributionRequired: true,
      creditLine: '',
      retrievedAt: 0,
      quality: 'original' as const,
      duration: 3,
      tags: [],
      cacheKey: 'k',
    };
    const plan = makePlan([mkClip({ id: 'lic', start: 2, duration: 2, asset })]);
    const report = await runPreflight(plan, envWith({}), { bitDepth: 24 });
    expect(report.ok).toBe(true); // unknown license alone must not block, but must warn
    const lic = report.checks.find((c) => c.code === 'provenance');
    expect(lic?.level).toBe('warn');
    expect(lic?.message).toContain('unknown license');

    const badRate = makePlan([mkClip({ id: 'a', start: 1, duration: 2 })]);
    const broken = await runPreflight({ ...badRate, clock: { sampleRate: 88200 } }, envWith({}), { bitDepth: 24 });
    expect(broken.ok).toBe(false);
    expect(broken.checks.map((c) => c.code)).toContain('sr-unsupported');

    const broken2 = await runPreflight(badRate, envWith({}), { bitDepth: 8 as never });
    expect(broken2.checks.map((c) => c.code)).toContain('bitdepth-unsupported');
  });

  it('muted + solo state are reported explicitly (§14 philosophy)', async () => {
    const clips = [
      mkClip({ id: 'mute', start: 1, duration: 1, muted: true }),
      mkClip({ id: 'solo', start: 2, duration: 1, solo: true }),
      mkClip({ id: 'other', start: 3, duration: 1 }),
    ];
    const plan = makePlan(clips);
    const report = await runPreflight(plan, envWith({}));
    expect(report.checks.map((c) => c.code)).toContain('muted');
    const solo = report.checks.find((c) => c.code === 'solo-state');
    expect(solo?.level).toBe('info');
    expect(solo?.message).toContain('ignores solo by policy');
    // default policy ships 'other' anyway — partition still clean
    expect(report.ok).toBe(true);

    const honor = await runPreflight(planDelivery(mkProject(clips, [], { duration: 60 }), {
      clock,
      scope: { kind: 'full' },
      creative: [...CREATIVE_BUSES],
      soloPolicy: 'honor',
      ...planOptions(),
    }), envWith({}));
    expect(honor.checks.find((c) => c.code === 'solo-state')?.level).toBe('warn');
  });

  it('detects stem-length disagreement — it cannot happen, so we still assert it', async () => {
    const plan = makePlan([mkClip({ id: 'a', start: 1, duration: 1 })]);
    const broken = { ...plan, passes: plan.passes.map((p, i) => (i === 1 ? { ...p, frameCount: p.frameCount + 48 } : p)) };
    const report = await runPreflight(broken, envWith({}));
    expect(report.checks.map((c) => c.code)).toContain('length-mismatch');
    expect(report.ok).toBe(false);
  });
});

describe('ZIP packaging (§10)', () => {
  it('round-trips every entry byte-for-byte (stored audio, deflated docs)', async () => {
    const audio = new Uint8Array(5000).map((_, i) => (i * 37) & 0xff);
    const docs = new TextEncoder().encode('{"project": "x"}');
    const zipped = await buildZip([
      { path: 'Mix/UMBRA_X_MASTER.wav', data: audio },
      { path: 'Documentation/delivery_manifest.json', data: docs },
      { path: 'Post_Stems/UMBRA_X_SFX.wav', data: audio },
    ]);
    const out = unzipSync(zipped, { filter: () => true });
    expect(Object.keys(out).sort()).toEqual(['Documentation/delivery_manifest.json', 'Mix/UMBRA_X_MASTER.wav', 'Post_Stems/UMBRA_X_SFX.wav']);
    expect(out['Mix/UMBRA_X_MASTER.wav'].length).toBe(5000);
    expect(out['Mix/UMBRA_X_MASTER.wav'].every((b, i) => b === audio[i])).toBe(true);
    expect(new TextDecoder().decode(out['Documentation/delivery_manifest.json'])).toBe('{"project": "x"}');
  });

  it('refuses duplicate paths instead of silently overwriting', async () => {
    await expect(
      buildZip([
        { path: 'a.wav', data: new Uint8Array([1]) },
        { path: 'a.wav', data: new Uint8Array([2]) },
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  it('handles the empty-data edge without corrupting the archive', async () => {
    const zipped = await buildZip([{ path: 'Documentation/empty.txt', data: new Uint8Array(0) }]);
    const out = unzipSync(zipped);
    expect(out['Documentation/empty.txt'].length).toBe(0);
  });

  it('SOURCE stems are only present when requested (§10 no accidental duplicates)', () => {
    const plan = makePlan([mkClip({ id: 'a', start: 1, duration: 1 })]);
    const withSources = plan.passes.filter((p) => p.mode === 'source');
    expect(withSources.length).toBe(SOURCE_BUSES.length);
    const without = planDelivery(
      mkProject([mkClip({ id: 'a', start: 1, duration: 1 })], [], { duration: 60 }),
      { clock, scope: { kind: 'full' }, creative: [...CREATIVE_BUSES], sources: [], ...planOptions() },
    );
    expect(without.passes.filter((p) => p.mode === 'source').length).toBe(0);
    // individual clip files land in their own folder, never duplicated into stems
    const individual = without.passes.find((p) => p.mode === 'clip-sync');
    expect(individual).toBeUndefined();
  });
});
