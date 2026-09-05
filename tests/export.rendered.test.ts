/* ==================================================================== *
 *  RENDERED STEM DELIVERY — end-to-end through the REAL Web Audio engine
 *
 *  The kernel tests prove the algebra; these prove the browser executor
 *  (stemRender.renderPassWebAudio) honours the same contract on genuine
 *  DSP: identical file lengths, and Σ creative = Σ source = mix reference
 *  within render-noise tolerance — through real convolvers, ducking and
 *  the sub bus, not the comb proxies.
 *
 *  Gated like rendered.quality.test.ts: with `node-web-audio-api` absent
 *  or unloadable (no ALSA), this suite SKIPS — it never fakes a pass.
 * ==================================================================== */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

let webAudio: { OfflineAudioContext: typeof OfflineAudioContext } | null = null;
try {
  webAudio = require('node-web-audio-api');
} catch {
  webAudio = null;
}
const HAS_WEB_AUDIO = !!webAudio;
if (webAudio) {
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = webAudio.OfflineAudioContext;
}

const { DEFAULT_MASTER } = await import('../src/lib/dsp');
const { CREATIVE_BUSES, SOURCE_BUSES, planDelivery } = await import('../src/lib/export');
const { renderPassWebAudio } = await import('../src/lib/export/stemRender');
const { mkLayer, mkProject, mkScene, planOptions } = await import('./export.fixtures');

function makePlan() {
  const scenes = [
    mkScene(0, 10, [mkLayer('drone', { id: 'd1' }), mkLayer('impact', { id: 'i1', reverb: 0.8 })], { id: 'sc1', hits: [2, 5.5, 8], tension: 0.9 }),
    mkScene(10, 20, [mkLayer('sub', { id: 's1' }), mkLayer('pulse', { id: 'p1' })], { id: 'sc2', hits: [14], tension: 0.4 }),
  ];
  const project = mkProject([], scenes, { duration: 20 });
  return planDelivery(project, {
    clock: { sampleRate: 48000 },
    scope: { kind: 'full' },
    creative: [...CREATIVE_BUSES],
    sources: [...SOURCE_BUSES],
    includeMaster: true,
    includeMixReference: true,
    ...planOptions(),
  });
}

describe.skipIf(!HAS_WEB_AUDIO)('rendered stem delivery (real engine)', () => {
  it('every pass renders to exactly the shared frameCount — no NaN, no drift', async () => {
    const plan = makePlan();
    for (const pass of plan.passes) {
      const r = await renderPassWebAudio(plan, pass, DEFAULT_MASTER);
      expect(r.L.length).toBe(plan.span.frameCount);
      expect(r.R.length).toBe(plan.span.frameCount);
      expect(r.L.every((v) => Number.isFinite(v))).toBe(true);
      expect(r.clipsFailed).toEqual([]);
    }
  }, 180_000);

  it('Σ creative stems = Σ source stems = mix reference through the real graph', async () => {
    const plan = makePlan();
    const render = (id: string) => {
      const pass = plan.passes.find((p) => p.id === id);
      if (!pass) throw new Error(`missing pass ${id}`);
      return renderPassWebAudio(plan, pass, DEFAULT_MASTER);
    };
    const ref = await render('REF');
    const sumC = CREATIVE_BUSES.map((b) => render(`POST.${b}`));
    const sumS = SOURCE_BUSES.map((b) => render(`SRC.${b}`));
    const [cCh, sCh] = await Promise.all([Promise.all(sumC), Promise.all(sumS)]);

    const sum = (rs: { L: Float32Array; R: Float32Array }[]) => {
      const L = new Float64Array(ref.L.length);
      const R = new Float64Array(ref.R.length);
      for (const r of rs) for (let i = 0; i < L.length; i++) { L[i] += r.L[i]; R[i] += r.R[i]; }
      return { L, R };
    };
    // Real convolvers + node-internal float reduction: tolerance is looser
    // than the kernel's 1e-6 (documented in DELIVERY.md §8) but tiny.
    const tol = 1e-4;
    for (const s of [sum(cCh), sum(sCh)]) {
      let max = 0;
      for (let i = 0; i < ref.L.length; i++) max = Math.max(max, Math.abs(s.L[i] - ref.L[i]), Math.abs(s.R[i] - ref.R[i]));
      expect(max).toBeLessThan(tol);
    }
    // the mix must have actual content for the null to mean anything
    let e = 0;
    for (let i = 0; i < ref.L.length; i += 97) e += Math.abs(ref.L[i]);
    expect(e).toBeGreaterThan(1);
  }, 300_000);
});
