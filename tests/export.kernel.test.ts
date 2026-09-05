/* ==================================================================== *
 *  DELIVERY KERNEL TESTS — signal-level proof of the sync + reconstruction
 *  contract (§6, §17 A/B/C/G)
 *
 *  These run the SAME pass data the Web Audio executor consumes, through
 *  the deterministic reference kernel (pure TS). They prove the ALGEBRA:
 *  sample-exact placement across master/creative/source/sync-padded files,
 *  silence preservation between sparse events, exact stem summation against
 *  the pre-master mix (incl. shared sends, duck automation and the sub bus),
 *  and tail policy at the picture end. DSP *quality* is identical to the
 *  monitor by construction — stemRender.ts builds the same graph — and that
 *  boundary is documented in docs/architecture/DELIVERY.md.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  CREATIVE_BUSES,
  DEFAULT_KERNEL_MASTER,
  SOURCE_BUSES,
  kernelSourcesForPass,
  planDelivery,
  renderKernelPass,
  secToSample,
  type KernelMasterConfig,
  type PlanOpts,
} from '../src/lib/export';
import { impulseBuffer, maxAbsDiff, mkClip, mkLayer, mkProject, mkScene, noiseBuffer, planOptions, rms, sumStems, SR, firstNonZero } from './export.fixtures';

const clock = { sampleRate: SR };

// the shipped default must be a valid config (used when callers don't pass one)
expect(DEFAULT_KERNEL_MASTER.volume).toBeGreaterThan(0);

const MASTER_CFG: KernelMasterConfig = {
  volume: 1,
  width: 1,
  roomMix: 0.3,
  hallMix: 0.35,
  cathMix: 0.2,
  subBoost: 0.5,
};

function buildPlan(clips: ReturnType<typeof mkClip>[], scenes: ReturnType<typeof mkScene>[] = [], over: Partial<PlanOpts> & { durationSeconds?: number } = {}) {
  const { durationSeconds, ...planOver } = over;
  const project = mkProject(clips, scenes, { duration: durationSeconds ?? 60 });
  return planDelivery(project, {
    clock,
    scope: { kind: 'full' },
    creative: [...CREATIVE_BUSES],
    sources: [...SOURCE_BUSES],
    includeMaster: true,
    includeMixReference: true,
    individualClips: 'both',
    ...planOptions(),
    ...planOver,
  });
}

/* ---------------------------------------------------------------- A ----- */

describe('A · timestamp retention — one sync anchor, four files', () => {
  it('a clip at 18.400 s lands at the SAME sample in master, post stem, source stem and sync-padded export', () => {
    const t = 18.4;
    const clip = mkClip({ id: 'door', start: t, duration: 2.55, role: 'DOOR' as never, name: 'Old Metal Door Creak' });
    const plan = buildPlan([clip]);

    const expected = secToSample(t, clock); // 883200
    const master = plan.passes.find((p) => p.mode === 'reference')!;
    const post = plan.passes.find((p) => p.id === 'POST.FOLEY')!;
    const src = plan.passes.find((p) => p.id === 'SRC.LIBRARY')!;
    const sync = plan.passes.find((p) => p.id === 'CLIP.door.SYNC')!;
    for (const pass of [master, post, src, sync]) {
      const pl = pass.clips.find((c) => c.clipId === 'door')!;
      expect(pl.atSample).toBe(expected);
      expect(pl.startSampleAbs).toBe(expected);
      expect(pl.offsetSample).toBe(0);
    }

    // and the rendered signal agrees: identical impulse lands on the exact
    // same output sample in all four files (150 sits clear of the 96-sample
    // safety fade-in ramp — the FIRST sample is ramped by definition)
    const buffers = new Map([['door', impulseBuffer([150], secToSample(2.55, clock), 1)]]);
    const renders = [master, post, src, sync].map((pass) =>
      renderKernelPass({
        frameCount: pass.frameCount,
        sampleRate: SR,
        sources: kernelSourcesForPass(pass, buffers),
        duck: pass.duck,
        subOut: pass.subOut,
        master: MASTER_CFG,
      }),
    );
    for (const r of renders) {
      expect(firstNonZero(r.L, 0, r.L.length)).toBe(expected + 150);
    }
    expect(renders[0].L.length).toBe(renders[1].L.length);
  });
});

/* ---------------------------------------------------------------- B ----- */

describe('B · sparse events — silence stays silence (§15 negative space)', () => {
  it('three SFX hits at 5.2 / 18.4 / 42.9 sit in one full-length stem with true zero gaps', () => {
    const clips = [5.2, 18.4, 42.9].map((s, i) =>
      mkClip({ id: `h${i}`, start: s, duration: 0.4, role: 'MECHANICAL' as never }),
    );
    const plan = buildPlan(clips);
    const sfx = plan.passes.find((p) => p.id === 'POST.SFX')!;
    expect(sfx.clips.length).toBe(3);
    const buffers = new Map(clips.map((c) => [c.id, impulseBuffer([150], secToSample(0.4, clock), 1)]));
    const r = renderKernelPass({
      frameCount: sfx.frameCount,
      sampleRate: SR,
      sources: kernelSourcesForPass(sfx, buffers),
      duck: [],
      subOut: sfx.subOut,
      master: MASTER_CFG,
    });

    // length = full delivery window, never "last sound + epsilon"
    expect(sfx.frameCount).toBe(secToSample(62, clock));
    // true zeros between events — negative space survives export
    expect(firstNonZero(r.L, secToSample(5.608333, clock), secToSample(18.4, clock))).toBe(-1);
    expect(firstNonZero(r.L, secToSample(18.808333, clock), secToSample(42.9, clock))).toBe(-1);
    expect(firstNonZero(r.L, secToSample(43.308333, clock), secToSample(62, clock))).toBe(-1);
    // the hits themselves sit at their exact positions
    for (const s of [5.2, 18.4, 42.9]) {
      const n = secToSample(s, clock);
      expect(firstNonZero(r.L, n, n + 300)).toBe(n + 150); // exactly, not approximately
      expect(Math.abs(r.L[n + 150])).toBeGreaterThan(0.01);
    }
  });
});

/* ---------------------------------------------------------------- C ----- */

describe('C · stem reconstruction — the architectural invariant', () => {
  it('Σ creative stems = Σ source stems = pre-master mix (documented float tolerance)', () => {
    const clips = [
      mkClip({ id: 'amb', start: 0.5, duration: 4, role: 'ROOM_TONE' as never, provider: 'library', gain: 0.8, pan: -0.3, fadeIn: 0.4, fadeOut: 0.5 }),
      mkClip({ id: 'foley', start: 5.0, duration: 0.5, role: 'FOOTSTEP' as never, provider: 'user', gain: 0.6, pan: 0.6 }),
      mkClip({ id: 'music', start: 2.0, duration: 7, provider: 'ace-step', gain: 0.9, fadeIn: 1, fadeOut: 1 }),
      mkClip({ id: 'hit', start: 5.5, duration: 1.2, role: 'IMPACT' as never, provider: 'mmaudio', gain: 1.2 }),
    ];
    // two scenes → a duck at the seam; one procedural sub owner + one bass feeder
    const scenes = [
      mkScene(0, 10, [mkLayer('drone', { id: 'd1' }), mkLayer('impact', { id: 'i1' })], { id: 'sc1' }),
      mkScene(10, 20, [mkLayer('sub', { id: 's1' })], { id: 'sc2' }),
    ];
    const plan = buildPlan(clips, scenes, { durationSeconds: 20 });

    const buffers = new Map(clips.map((c) => [c.id, impulseBuffer([500, 9000, Math.floor(c.duration * SR) - 500], Math.ceil(c.duration * SR), 0.8)]));
    const layerBuffers = new Map([
      ['sc1/d1', { buffer: noiseBuffer(secToSample(9, clock), 0.3), verb: { hall: 0.6 } }],
      ['sc1/i1', { buffer: impulseBuffer([20000], secToSample(9, clock), 0.5), verb: { room: 0.4 }, subFeed: 0.5 }],
      ['sc2/s1', { buffer: noiseBuffer(secToSample(9, clock), 0.6), verb: { cath: 0.8 } }],
    ]);

    const render = (passId: string) => {
      const pass = plan.passes.find((p) => p.id === passId)!;
      return renderKernelPass({
        frameCount: pass.frameCount,
        sampleRate: SR,
        sources: kernelSourcesForPass(pass, buffers, layerBuffers),
        duck: pass.duck,
        subOut: pass.subOut,
        master: MASTER_CFG,
      });
    };

    const mix = render('REF');
    const sumC = sumStems(CREATIVE_BUSES.map((b) => render(`POST.${b}`)));
    const sumS = sumStems(SOURCE_BUSES.map((b) => render(`SRC.${b}`)));

    // documented tolerance: float32 summation-order noise only.
    // See docs/architecture/DELIVERY.md §Tolerance for the numeric contract.
    const MAX_ABS = 1e-6;
    expect(maxAbsDiff(sumC.L, mix.L)).toBeLessThan(MAX_ABS);
    expect(maxAbsDiff(sumC.R, mix.R)).toBeLessThan(MAX_ABS);
    expect(maxAbsDiff(sumS.L, mix.L)).toBeLessThan(MAX_ABS);
    expect(maxAbsDiff(sumS.R, mix.R)).toBeLessThan(MAX_ABS);

    // sanity: the mix actually HAS content, or nulling is meaningless
    expect(rms(mix.L)).toBeGreaterThan(1e-5);

    // and the two axes agree with each other
    expect(maxAbsDiff(sumC.L, sumS.L)).toBeLessThan(MAX_ABS);
  }, 60_000);

  it('reverb energy is neither duplicated nor lost', () => {
    // one drone with a heavy hall send: if the wet were counted per-stem AND
    // in a shared FX stem, Σ stems would overshoot the mix
    const scenes = [mkScene(0, 10, [mkLayer('drone', { id: 'dr' })], { id: 'sc' })];
    const plan = buildPlan([], scenes, { durationSeconds: 10 });
    // NOTE: dry drone audio stops at 9.0 s; picture runs to 10 s and the file
    // to 12 s (tail). Sustained excitation keeps the shared hall ringing.
    const layerBuffers = new Map([['sc/dr', { buffer: noiseBuffer(secToSample(9, clock), 0.5), verb: { hall: 1 } }]]);
    const buffers = new Map<string, never>();
    const render = (passId: string) => {
      const pass = plan.passes.find((p) => p.id === passId)!;
      return renderKernelPass({
        frameCount: pass.frameCount,
        sampleRate: SR,
        sources: kernelSourcesForPass(pass, buffers, layerBuffers),
        duck: pass.duck,
        subOut: pass.subOut,
        master: MASTER_CFG,
      });
    };
    const mix = render('REF');
    const sum = sumStems(CREATIVE_BUSES.map((b) => render(`POST.${b}`)));
    expect(maxAbsDiff(sum.L, mix.L)).toBeLessThan(1e-6);
    // the wet tail keeps sounding after the DRY source stops (dry ends at
    // ~9.17 s; picture 10 s; file 12 s) — and is counted exactly once, in
    // the owning stem, thanks to the per-pass shared reverb above
    let late = 0;
    for (let i = secToSample(9.5, clock); i < secToSample(9.95, clock); i++) late += Math.abs(mix.L[i]);
    expect(late).toBeGreaterThan(1e-4);
    // the wet fills the post-dry region CONTINUOUSLY from the exact source end
    // (dry stops at 9.0 s; any hole would mean per-pass state divergence)
    expect(firstNonZero(mix.L, secToSample(9.1, clock), secToSample(9.15, clock))).toBe(secToSample(9.1, clock));
  });
});

/* ---------------------------------------------------------------- G ----- */

describe('G · tail policy at picture end', () => {
  it('a sound ending past picture survives under picture+2s and is cut under exact', () => {
    const clip = mkClip({ id: 'boom', start: 59.4, duration: 1.5, role: 'IMPACT' as never });
    const withTail = buildPlan([clip], [], { durationSeconds: 60, tail: { kind: 'picture_plus', seconds: 2 } });
    const exact = buildPlan([clip], [], { durationSeconds: 60, tail: { kind: 'exact' } });

    const buffers = new Map([['boom', impulseBuffer([150, 30000, 71500], secToSample(1.5, clock), 1)]]);
    const renderOne = (plan: ReturnType<typeof buildPlan>) => {
      const pass = plan.passes.find((p) => p.id === 'POST.IMPACTS')!;
      return {
        pass,
        r: renderKernelPass({
          frameCount: pass.frameCount,
          sampleRate: SR,
          sources: kernelSourcesForPass(pass, buffers),
          duck: pass.duck,
          subOut: pass.subOut,
          master: MASTER_CFG,
        }),
      };
    };
    const a = renderOne(withTail);
    const b = renderOne(exact);

    // +2 s: full 1.5 s of content is inside a 62 s file
    expect(a.pass.frameCount).toBe(secToSample(62, clock));
    expect(a.pass.clips[0].frameCount).toBe(secToSample(1.5, clock));
    const boomAt = a.pass.clips[0].atSample;
    expect(Math.abs(a.r.L[boomAt + 71500])).toBeGreaterThan(0.01); // energy past picture (60.89 s)
    // exact: file stops at picture; the part past it is gone, not shifted
    expect(b.pass.frameCount).toBe(secToSample(60, clock));
    expect(b.pass.clips[0].frameCount).toBe(secToSample(0.6, clock));
    expect(Math.abs(b.r.L[b.pass.clips[0].atSample + 150])).toBeGreaterThan(0.01); // early content survives
    expect(firstNonZero(b.r.L, secToSample(60, clock), b.r.L.length)).toBe(-1);
  });
});

/* ------------------------------------------------------------- extras --- */

describe('sync-padded individual export matches the stem grid', () => {
  it('lengths and sample positions are identical to the consolidated stems (§12)', () => {
    const clip = mkClip({ id: 'k', start: 18.417, duration: 0.9, role: 'DOOR' as never });
    const plan = buildPlan([clip]);
    const sync = plan.passes.find((p) => p.id === 'CLIP.k.SYNC')!;
    const master = plan.passes.find((p) => p.mode === 'master')!;
    expect(sync.frameCount).toBe(master.frameCount);
    expect(sync.clips[0].atSample).toBe(secToSample(18.417, clock));

    const buffers = new Map([['k', impulseBuffer([150], secToSample(0.9, clock), 1)]]);
    const rs = renderKernelPass({ frameCount: sync.frameCount, sampleRate: SR, sources: kernelSourcesForPass(sync, buffers), duck: sync.duck, subOut: false, master: MASTER_CFG });
    const rm = renderKernelPass({ frameCount: master.frameCount, sampleRate: SR, sources: kernelSourcesForPass(master, buffers), duck: master.duck, subOut: master.subOut, master: MASTER_CFG });
    // the clip here is the whole mix (no layers/scenes) → the sync export is the master
    expect(maxAbsDiff(rs.L, rm.L)).toBe(0);
  });
});
