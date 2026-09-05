/* ==================================================================== *
 *  STEM PLAN — taxonomy (§3), source axis (§4), scopes/tails (§8),
 *  partition integrity (§6 algebra), audibility policy (§17 D/E/F)
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  CREATIVE_BUSES,
  LAYER_KIND_STEM,
  MIN_CONTENT_SECONDS,
  ROLE_STEM,
  SOURCE_BUSES,
  classifyForStem,
  classifySource,
  layerFeedsSub,
  planDelivery,
  remapScenes,
  resolvePictureEnd,
  type CreativeBus,
  type PlanOpts,
} from '../src/lib/export';
import { secToSample } from '../src/lib/export/clock';
import { clipIsAudible, normalizeSoloClips } from '../src/lib/export/stemPlan';
import type { AudioClip, Project } from '../src/lib/types';
import { mkClip, mkLayer, mkProject, mkScene, planOptions, SR } from './export.fixtures';

const clock = { sampleRate: SR };

function plan(project: Project, over: Partial<PlanOpts> = {}) {
  return planDelivery(project, {
    clock,
    scope: { kind: 'full' },
    creative: [...CREATIVE_BUSES],
    sources: [...SOURCE_BUSES],
    includeMaster: true,
    ...planOptions(),
    ...over,
  });
}

/* ------------------------------------------------------- classification -- */

describe('classifyForStem — post taxonomy from existing clip data', () => {
  it('maps every retrieval role explicitly and to a real bus', () => {
    for (const role of Object.keys(ROLE_STEM)) {
      const clip = mkClip({ role: role as never, name: 'untitled thing' });
      expect(CREATIVE_BUSES).toContain(classifyForStem(clip));
    }
    expect(classifyForStem(mkClip({ role: 'DOOR' as never }))).toBe('FOLEY');
    expect(classifyForStem(mkClip({ role: 'ROOM_TONE' as never }))).toBe('AMB');
    expect(classifyForStem(mkClip({ role: 'FOOTSTEP' as never }))).toBe('FOLEY');
    expect(classifyForStem(mkClip({ role: 'MECHANICAL' as never }))).toBe('SFX');
    expect(classifyForStem(mkClip({ role: 'IMPACT' as never }))).toBe('IMPACTS');
    expect(classifyForStem(mkClip({ role: 'DRONE' as never }))).toBe('DESIGN');
    expect(classifyForStem(mkClip({ role: 'TRANSITION' as never }))).toBe('IMPACTS');
    expect(classifyForStem(mkClip({ role: 'WIND' as never }))).toBe('AMB');
    expect(classifyForStem(mkClip({ role: 'VEHICLE' as never }))).toBe('SFX');
  });

  it('sustained rumbles read as DESIGN, transient rumbles as IMPACTS', () => {
    expect(classifyForStem(mkClip({ role: 'RUMBLE' as never, name: 'low room tone bed rumble hum' }))).toBe('DESIGN');
    expect(classifyForStem(mkClip({ role: 'RUMBLE' as never, name: 'building collapse rumble' }))).toBe('IMPACTS');
  });

  it('role wins over contradictory keywords; keywords win over provider', () => {
    expect(classifyForStem(mkClip({ role: 'WATER' as never, name: 'engine impact whoosh' }))).toBe('SFX');
    expect(classifyForStem(mkClip({ provider: 'user', name: 'footsteps on gravel pass-by' }))).toBe('FOLEY');
    expect(classifyForStem(mkClip({ provider: 'user', name: 'old metal door creak' }))).toBe('FOLEY');
  });

  it('provider defaults: ace-step → MX, generated → DESIGN, procedural kind → kind map', () => {
    expect(classifyForStem(mkClip({ provider: 'ace-step', name: 'quiet nothing' }))).toBe('MX');
    expect(classifyForStem(mkClip({ provider: 'stable-audio', name: 'quiet nothing' }))).toBe('DESIGN');
    expect(classifyForStem(mkClip({ provider: 'mmaudio', name: 'quiet nothing' }))).toBe('DESIGN');
    expect(
      classifyForStem(
        mkClip({ provider: 'umbra-procedural', name: 'quiet nothing', metadata: { provider: 'umbra-procedural', generationSettings: { kind: 'braam' } } }),
      ),
    ).toBe('IMPACTS');
  });

  it('unknown material falls back to SFX — never disappears', () => {
    const weird = mkClip({ provider: 'library', name: 'zzz 42 unknown material', role: undefined });
    expect(classifyForStem(weird)).toBe('SFX');
    const orphan = mkClip({ provider: 'library', role: 'NOT_A_ROLE' as never, name: '' });
    expect(classifyForStem(orphan)).toBe('SFX');
  });

  it('explicit metadata override beats everything', () => {
    const clip = mkClip({
      role: 'IMPACT' as never,
      name: 'engine impact',
      metadata: { provider: 'library', umbraStem: 'FOLEY' },
    });
    expect(classifyForStem(clip)).toBe('FOLEY');
    const bogus = mkClip({ role: 'IMPACT' as never, metadata: { provider: 'library', umbraStem: 'NONSENSE' } });
    expect(classifyForStem(bogus)).toBe('IMPACTS'); // invalid override ignored, chain continues
  });

  it('source axis follows provider exactly', () => {
    expect(classifySource(mkClip({ provider: 'umbra-procedural' }))).toBe('PROCEDURAL');
    expect(classifySource(mkClip({ provider: 'ace-step' }))).toBe('GENERATED');
    expect(classifySource(mkClip({ provider: 'stable-audio' }))).toBe('GENERATED');
    expect(classifySource(mkClip({ provider: 'mmaudio' }))).toBe('GENERATED');
    expect(classifySource(mkClip({ provider: 'library' }))).toBe('LIBRARY');
    expect(classifySource(mkClip({ provider: 'user' }))).toBe('USER');
  });

  it('every layer kind has an explicit bus and sub-ownership rules', () => {
    for (const kind of Object.keys(LAYER_KIND_STEM) as (keyof typeof LAYER_KIND_STEM)[]) {
      expect(CREATIVE_BUSES).toContain(LAYER_KIND_STEM[kind]);
    }
    expect(LAYER_KIND_STEM.drone).toBe('DESIGN');
    expect(LAYER_KIND_STEM.ambience).toBe('AMB');
    expect(LAYER_KIND_STEM.sub).toBe('SUB_LFE');
    expect(LAYER_KIND_STEM.impact).toBe('IMPACTS');
    expect(LAYER_KIND_STEM.strings).toBe('MX');
    expect(layerFeedsSub('sub')).toBe(true);
    expect(layerFeedsSub('impact')).toBe(true);
    expect(layerFeedsSub('strings')).toBe(false);
  });
});

/* ------------------------------------------------------------- scopes --- */

describe('picture authority + span (§8)', () => {
  it('derives the span from project duration, not the last-ending layer', () => {
    const clips = [mkClip({ start: 2, duration: 1 })];
    const scenes = [mkScene(0, 6, [mkLayer('drone')])];
    const p = mkProject(clips, scenes, { duration: 227.52 });
    const a = resolvePictureEnd(p, { kind: 'full' });
    expect(a.pictureEnd).toBe(227.52);
    expect(a.source).toBe('project');
  });

  it('falls back (labelled!) when the project has no duration', () => {
    const clips = [mkClip({ start: 2, duration: 3 })]; // ends at 5
    const p = mkProject(clips, [], { duration: 0, videoUrl: null });
    const a = resolvePictureEnd(p, { kind: 'full' });
    expect(a.source).toBe('last-event-fallback');
    expect(a.pictureEnd).toBe(5);
    const pl = plan(p);
    expect(pl.span.frameCount).toBe(secToSample(7, clock)); // fallback + default 2 s tail
  });

  it('all consolidated stems share one exact frame count; PROC clip files differ', () => {
    const clips = [
      mkClip({ start: 5.2, duration: 1, role: 'MECHANICAL' as never }),
      mkClip({ start: 40, duration: 0.5, role: 'FOOTSTEP' as never }),
    ];
    const scenes = [mkScene(0, 60, [mkLayer('drone'), mkLayer('sub')])];
    const p = mkProject(clips, scenes, { duration: 60 });
    const pl = plan(p, { individualClips: 'both', includeMixReference: true });
    const consolidated = pl.passes.filter((x) => x.mode !== 'clip-processed');
    const lens = new Set(consolidated.map((x) => x.frameCount));
    expect(lens.size).toBe(1);
    expect([...lens][0]).toBe(secToSample(62, clock)); // 60 picture + 2 tail
    const proc = pl.passes.find((x) => x.mode === 'clip-processed')!;
    expect(proc.frameCount).toBe(secToSample(1, clock));
  });

  it('scene scope shifts the origin but preserves project-absolute anchors', () => {
    const scene = mkScene(10, 20, [], { id: 'scB' });
    const clips = [mkClip({ start: 12.5, duration: 1 })];
    const p = mkProject(clips, [scene], { duration: 30 });
    const pl = plan(p, { scope: { kind: 'scene', sceneId: 'scB' } });
    expect(pl.windowStart).toBe(10);
    expect(pl.pictureEnd).toBe(10);
    expect(pl.span.startSample).toBe(secToSample(10, clock));
    // delivery = windowStart + picture + tail (absolute), origin = windowStart
    expect(pl.span.startSample + pl.span.frameCount).toBe(secToSample(22, clock));
    const p0 = pl.passes.find((x) => x.mode === 'creative' && x.clips.length > 0)!.clips[0];
    expect(p0.atSample).toBe(secToSample(2.5, clock)); // 12.5 − 10
    expect(p0.startSampleAbs).toBe(secToSample(12.5, clock));
  });
});

/* ------------------------------------------------- audibility policy ---- */

describe('mute + solo delivery policy (§17 D/E)', () => {
  const c1 = mkClip({ id: 'm1', start: 1, duration: 1, muted: true });
  const c2 = mkClip({ id: 'm2', start: 3, duration: 1 });
  const c3 = mkClip({ id: 'm3', start: 5, duration: 1, solo: true });
  const project = mkProject([c1, c2, c3], [], { duration: 10 });

  it('muted clips never appear in any stem', () => {
    const pl = plan(project);
    for (const pass of pl.passes) {
      expect(pass.clips.map((c) => c.clipId)).not.toContain('m1');
    }
    expect(pl.mutedClipIds).toEqual(['m1']);
  });

  it('ignores solo by default: non-soloed material still ships', () => {
    const pl = plan(project);
    const ids = pl.passes.filter((p) => p.mode === 'creative').flatMap((p) => p.clips.map((c) => c.clipId));
    expect(ids).toContain('m2');
    expect(ids).toContain('m3');
    expect(pl.soloActiveClips).toBe(1);
  });

  it('honor mode omits non-soloed material — and says so', () => {
    const pl = plan(project, { soloPolicy: 'honor' });
    const creative = pl.passes.filter((p) => p.mode === 'creative');
    const anyIds = creative.flatMap((p) => p.clips.map((c) => c.clipId));
    expect(anyIds).toEqual(['m3']);
    expect(pl.soloPolicy).toBe('honor');
  });

  it('clipIsAudible mirrors the documented policy', () => {
    const clips = [c1, c2, c3];
    expect(clipIsAudible(c2, 'ignore', clips)).toBe(true);
    expect(clipIsAudible(c1, 'honor', clips)).toBe(false);
    expect(normalizeSoloClips(clips, 'ignore').every((c: AudioClip) => !c.solo)).toBe(true);
    expect(normalizeSoloClips(clips, 'honor')[2].solo).toBe(true);
  });
});

/* ---------------------------------------------------- windowing edges --- */

describe('placement + window behaviour', () => {
  it('a clip crossing a scene boundary stays one continuous placement (§17 H)', () => {
    const scenes = [mkScene(0, 10, []), mkScene(10, 20, [])];
    const clip = mkClip({ id: 'x', start: 9.4, duration: 1.6 }); // crosses 10
    const pl = plan(mkProject([clip], scenes, { duration: 20 }));
    const pass = pl.passes.find((p) => p.mode === 'creative' && p.clips.length)!;
    const placements = pass.clips.filter((c) => c.clipId === 'x');
    expect(placements.length).toBe(1); // never split by scene edges
    expect(placements[0].frameCount).toBe(secToSample(11.0, clock) - secToSample(9.4, clock));
    expect(placements[0].headTrimSamples).toBe(0);
  });

  it('clips starting before the window are head-trimmed without moving content', () => {
    const scene = mkScene(5, 15, [], { id: 's' });
    const clip = mkClip({ start: 3, duration: 5 }); // ends at 8 → 2 s inside a 5..15 scene
    const pl = plan(mkProject([clip], [scene], { duration: 15 }), { scope: { kind: 'scene', sceneId: 's' } });
    const p0 = pl.passes.find((p) => p.mode === 'creative' && p.clips.length > 0)!.clips[0];
    expect(p0.atSample).toBe(0);
    expect(p0.headTrimSamples).toBe(secToSample(2, clock));
    expect(p0.offsetSample).toBe(secToSample(2, clock)); // reads from 2 s into the source
    expect(p0.frameCount).toBe(secToSample(3, clock));
  });

  it('content at the picture edge obeys the tail policy', () => {
    const clip = mkClip({ start: 59.5, duration: 1.2 }); // ends 60.7 — past a 60 s picture
    const p = mkProject([clip], [], { duration: 60 });
    const withTail = plan(p, { tail: { kind: 'picture_plus', seconds: 2 } });
    const exact = plan(p, { tail: { kind: 'exact' } });
    const tw = withTail.passes.find((x) => x.mode === 'creative' && x.clips.length > 0)!.clips[0];
    const ex = exact.passes.find((x) => x.mode === 'creative' && x.clips.length > 0)!.clips[0];
    expect(tw.tailTrimSamples).toBe(0);
    expect(tw.frameCount).toBe(secToSample(1.2, clock));
    expect(ex.tailTrimSamples).toBe(secToSample(0.7, clock));
    expect(ex.frameCount).toBe(secToSample(0.5, clock));
  });

  it('sub-floor clips are skipped loudly, not silently', () => {
    const clip = mkClip({ id: 'tiny', start: 10, duration: MIN_CONTENT_SECONDS / 2 });
    const pl = plan(mkProject([clip], [], { duration: 60 }));
    const master = pl.passes.find((p) => p.mode === 'master')!;
    expect(master.clips.find((c) => c.clipId === 'tiny')).toBeUndefined();
    expect(master.skippedClipIds).toEqual([{ clipId: 'tiny', reason: 'too-short' }]);
  });

  it('remapScenes shifts hits with the window', () => {
    const s = mkScene(0, 10, [], { hits: [3.2, 8.7] });
    const r = remapScenes([s], 2, 10);
    expect(r[0].start).toBe(0);
    expect(r[0].hits.length).toBe(2);
    r[0].hits.forEach((t: number, i: number) => expect(t).toBeCloseTo([1.2, 6.7][i], 9));
  });
});

/* --------------------------------------------------- partition algebra -- */

describe('stem partition integrity (§6)', () => {
  const clips = [
    mkClip({ id: 'a', start: 1, duration: 1, role: 'ROOM_TONE' as never, provider: 'library' }),
    mkClip({ id: 'b', start: 2, duration: 1, role: 'IMPACT' as never, provider: 'user' }),
    mkClip({ id: 'c', start: 3, duration: 1, provider: 'ace-step' }),
    mkClip({ id: 'd', start: 4, duration: 1, provider: 'umbra-procedural' }),
  ];
  const project = mkProject(clips, [mkScene(0, 10, [mkLayer('drone'), mkLayer('impact'), mkLayer('sub')])], { duration: 10 });

  it('every audible clip appears in exactly one creative stem and one source stem', () => {
    const pl = plan(project);
    for (const axis of ['creative', 'source'] as const) {
      const seen = new Map<string, number>();
      for (const pass of pl.passes.filter((p) => p.mode === axis))
        for (const c of pass.clips) seen.set(c.clipId, (seen.get(c.clipId) ?? 0) + 1);
      for (const c of clips) expect(seen.get(c.id)).toBe(1);
    }
  });

  it('creative axis covers all buses in fixed order; source axis the four provenance modes', () => {
    const pl = plan(project);
    expect(pl.passes.filter((p) => p.mode === 'creative').map((p) => p.bus)).toEqual([...CREATIVE_BUSES]);
    expect(pl.passes.filter((p) => p.mode === 'source').map((p) => p.bus)).toEqual([...SOURCE_BUSES]);
  });

  it('sub-chain ownership: only SUB_LFE (creative) and PROCEDURAL (source) own it', () => {
    const pl = plan(project);
    for (const pass of pl.passes) {
      const expectOwn = pass.bus === 'SUB_LFE' || pass.bus === 'PROCEDURAL' || pass.mode === 'master' || pass.mode === 'reference';
      expect(pass.subOut).toBe(expectOwn);
    }
    const subPass = pl.passes.find((p) => p.bus === 'SUB_LFE')!;
    const kinds = new Set(subPass.layers.map((l) => l.kind));
    expect(kinds.has('sub')).toBe(true); // owner (full fader → sub chain)
    expect(kinds.has('impact')).toBe(true); // BASS-kind feed
    expect(kinds.has('drone')).toBe(false);
    const impactRef = subPass.layers.find((l) => l.kind === 'impact')!;
    expect(impactRef.dry).toBe(false); // its dry lives in IMPACTS
    expect(impactRef.verb).toBe(false); // its reverb lives in IMPACTS — never both
    expect(impactRef.subFull).toBe(false); // only the sub-feed, not the fader
    const subRef = subPass.layers.find((l) => l.kind === 'sub')!;
    expect(subRef.subFull).toBe(true);
    expect(subRef.verb).toBe(true); // its own space lives ONLY here
  });

  it('nonlinear master processing belongs to MASTER alone', () => {
    const pl = plan(project, { includeMixReference: true });
    for (const pass of pl.passes) {
      if (pass.mode === 'master') {
        expect(pass.masterFx).toBe(true);
        expect(pass.loudnessConform).toBe(true);
      } else {
        expect(pass.masterFx).toBe(false);
        expect(pass.loudnessConform).toBe(false);
      }
    }
  });

  it('a procedural clip lands in PROCEDURAL, not in a generated bucket (§17 J)', () => {
    const pl = plan(project);
    const ids = (bus: string) => pl.passes.find((p) => p.bus === bus && p.mode === 'source')!.clips.map((c) => c.clipId);
    expect(ids('PROCEDURAL')).toEqual(['d']);
    expect(ids('GENERATED')).toEqual(['c']);
    expect(ids('LIBRARY')).toEqual(['a']);
    expect(ids('USER')).toEqual(['b']);
  });

  it('classification never leaves a bus unassigned', () => {
    const all: CreativeBus[] = [];
    for (const provider of ['library', 'user', 'ace-step', 'stable-audio', 'mmaudio', 'umbra-procedural'] as const) {
      all.push(classifyForStem(mkClip({ provider, name: '' })));
    }
    expect(all.every((b) => CREATIVE_BUSES.includes(b))).toBe(true);
    expect(SOURCE_BUSES.length).toBe(4);
  });
});
