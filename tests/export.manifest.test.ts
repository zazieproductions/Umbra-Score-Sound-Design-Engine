/* ==================================================================== *
 *  MANIFEST + CUE SHEET (§9, §11) — machine-readable sync documentation
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  CUE_SHEET_COLUMNS,
  buildCueRows,
  buildCueSheetCsv,
  buildDeliveryManifest,
  projectProvenance,
  soundCreditsJson,
  CREATIVE_BUSES,
  SOURCE_BUSES,
  planDelivery,
  secToSample,
} from '../src/lib/export';
import { mkClip, mkProject, planOptions, SR } from './export.fixtures';

const clock = { sampleRate: SR };

function makePlan() {
  const clips = [
    mkClip({
      id: 'door',
      name: 'Old Metal Door Creak, vol 2',
      start: 18.4,
      duration: 2.55,
      offset: 0.35,
      role: 'DOOR' as never,
      provider: 'library',
      asset: {
        provider: 'freesound',
        providerLabel: 'Freesound',
        soundId: '381927',
        title: 'Old Metal Door Creak',
        creator: 'CreatorName',
        sourceUrl: 'https://freesound.org/s/381927/',
        license: 'Creative Commons 0',
        licenseClass: 'CC0',
        attributionRequired: false,
        creditLine: 'x',
        retrievedAt: 0,
        quality: 'original',
        duration: 9,
        tags: ['door', 'creak'],
        cacheKey: 'fs-381927',
      },
      match: 0.89,
      intentId: 'int-1',
    }),
    mkClip({ id: 'score', start: 0, duration: 18, provider: 'ace-step' }),
  ];
  const project = mkProject(clips, [], { duration: 227.52, name: 'Long Dark Night.mp4' });
  const plan = planDelivery(project, {
    clock,
    scope: { kind: 'full' },
    creative: [...CREATIVE_BUSES],
    sources: [...SOURCE_BUSES],
    includeMaster: true,
    ...planOptions(),
  });
  return { plan, project, clips };
}

describe('delivery manifest (§9)', () => {
  it('carries the documented top-level contract fields', () => {
    const { plan } = makePlan();
    const fileNames = new Map(plan.passes.map((p) => [p.id, p.fileName]));
    const m = buildDeliveryManifest(plan, { bitDepth: 24, container: 'bwav', channels: 2 }, new Map(), fileNames, {
      exportedAt: '2026-09-05T00:00:00.000Z',
      toolVersion: 'test',
    }) as Record<string, unknown>;

    expect(m.project).toBe('Long Dark Night.mp4');
    expect(m.sampleRate).toBe(48000);
    expect(m.bitDepth).toBe(24);
    expect(m.projectStart).toBe(0);
    expect(m.videoDuration).toBe(227.52);
    expect(m.tailSeconds).toBe(2);
    expect(m.durationAuthority).toBe('project');
    expect(m.stems).toBeInstanceOf(Array);
    expect(m.clips).toBeInstanceOf(Array);
    expect((m.stems as unknown[]).length).toBe(plan.passes.length);
    expect(m.deliveryDurationSeconds).toBe(plan.span.frameCount / SR);
  });

  it('each stem entry documents exact frames, origin and per-stem file identity', () => {
    const { plan } = makePlan();
    const stats = new Map([['POST.FOLEY', { peakDb: -3.2, lufs: -22.5, clipsPlaced: 1, clipsFailed: [] }]]);
    const names = new Map(plan.passes.map((p) => [p.id, p.fileName]));
    const m = buildDeliveryManifest(plan, { bitDepth: 24, container: 'wav', channels: 2 }, stats, names, {
      exportedAt: 'x',
      toolVersion: 'test',
    });
    const sfx = m.stems.find((s) => s.id === 'POST.FOLEY')!;
    expect(sfx.frameCount).toBe(plan.span.frameCount);
    expect(sfx.startSample).toBe(0);
    expect(sfx.projectOriginSample).toBe(plan.span.startSample);
    expect(sfx.clipIds).toEqual(['door']);
    expect(sfx.loudnessConform).toBe(false);
    expect(sfx.masterFx).toBe(false);
    const master = m.stems.find((s) => s.id === 'MASTER')!;
    expect(master.loudnessConform).toBe(true);
    expect(sfx.measured?.informationalOnly).toBe(true);
    expect(sfx.measured?.peakDb).toBe(-3.2);
  });

  it('every clip entry resolves to the SAME sample anchors the passes use', () => {
    const { plan } = makePlan();
    const m = buildDeliveryManifest(plan, { bitDepth: 24, container: 'wav', channels: 2 }, new Map(), new Map(), {
      exportedAt: 'x',
      toolVersion: 'test',
    });
    const entry = m.clips.find((c) => c.clipId === 'door')!;
    expect(entry.startSample).toBe(secToSample(18.4, clock));
    expect(entry.endSample).toBe(secToSample(18.4 + 2.55, clock));
    expect(entry.sourceOffsetSample).toBe(secToSample(0.35, clock));
    expect(entry.stem).toBe('FOLEY');
    expect(entry.sourceStem).toBe('LIBRARY');
    expect(entry.sourceId).toBe('381927');
    expect(entry.license).toBe('Creative Commons 0');
    expect(entry.creator).toBe('CreatorName');
  });
});

describe('cue sheet (§11)', () => {
  it('emits the documented columns and places the door creak at 00:00:18.400', () => {
    const { plan } = makePlan();
    const rows = buildCueRows(plan);
    expect(rows.length).toBe(2);
    const door = rows.find((r) => r.clip.includes('Door'))!;
    expect(door.start.startsWith('00:00:18.400')).toBe(true);
    expect(door.end.startsWith('00:00:20.950')).toBe(true);
    expect(door.role).toBe('DOOR');
    expect(door.stem).toBe('FOLEY');
    expect(door.source).toBe('LIB');
    expect(door.provider).toBe('Freesound');
    expect(door.sourceId).toBe('381927');
    expect(door.license).toBe('Creative Commons 0');
    expect(door.creator).toBe('CreatorName');
    expect(door.notes).toContain('auto-placed');
    expect(door.notes).toContain('0.89');
    // sorted by time
    expect(rows[0].clip).toContain('score'); // the music cue starts at 0
  });

  it('escapes CSV metacharacters in clip names', () => {
    const { plan } = makePlan();
    const csv = buildCueSheetCsv(buildCueRows(plan));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(CUE_SHEET_COLUMNS.join(','));
    const doorLine = lines.find((l) => l.includes('Door'))!;
    expect(doorLine).toContain('"Old Metal Door Creak, vol 2"'); // quoted, embedded comma
  });
});

describe('credits are derived, not duplicated (§16)', () => {
  it('provenance filter keys off delivered clips only', () => {
    const { plan, clips } = makePlan();
    const entries = [
      { id: 'p1', clipId: 'door', sceneId: 's', usedAt: 1, role: 'DOOR' as never, asset: clips[0].asset! },
      { id: 'p2', clipId: 'gone', sceneId: 's', usedAt: 2, role: 'DOOR' as never, asset: clips[0].asset! },
    ];
    const scoped = projectProvenance(entries, plan.clips);
    expect(scoped.map((e) => e.clipId)).toEqual(['door']);
    const json = JSON.parse(soundCreditsJson('proj', 10, scoped));
    expect(json.count).toBe(1);
    expect(json.entries[0].licenseClass).toBe('CC0');
  });
});
