/* ==================================================================== *
 *  MASTER LOUDNESS CONFORMANCE (closes DEBT-004) + delivery boundary rules
 *
 *  render.ts's BS.1770 conform + true-peak limiter now has a synthetic
 *  signal test. Also pins the boundary THIS subsystem added: the conform
 *  applies to MASTER only; stems carry measurement, not processing.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { finalizeMaster, measureLufs, TARGET_LUFS } from '../src/lib/render';

const SR = 48000;

function sineBuffer(amp: number, seconds: number, freq = 1000) {
  const length = Math.round(seconds * SR);
  const chans = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    chans[0][i] = v;
    chans[1][i] = v;
  }
  // structural AudioBuffer stand-in (finalizeMaster only reads these members)
  return {
    sampleRate: SR,
    numberOfChannels: 2,
    length,
    duration: length / SR,
    getChannelData: (c: number) => chans[c],
  } as unknown as AudioBuffer;
}

describe('BS.1770 loudness conform (master deliverable only)', () => {
  it('obeys the physics a loudness meter must: +6 dB input = +6 LU readout', () => {
    const a = measureLufs((() => { const b = sineBuffer(0.1, 5); return [b.getChannelData(0), b.getChannelData(1)]; })(), SR);
    const b2 = measureLufs((() => { const b = sineBuffer(0.2, 5); return [b.getChannelData(0), b.getChannelData(1)]; })(), SR);
    expect(Math.abs(b2 - (a + 6.0206) - 0)).toBeLessThan(0.02); // linearity in level
    // and a steady sine integrates without block-boundary wobble
    const mono = sineBuffer(0.1, 5.333); // non-integer number of gate blocks
    const c = measureLufs([mono.getChannelData(0), mono.getChannelData(1)], SR);
    expect(Math.abs(c - a)).toBeLessThan(0.02);
  });

  it('conforms to -16 LUFS and stays under the true-peak ceiling', () => {
    const buf = sineBuffer(0.1, 5); // raw ≈ -23 LUFS → makeup inside the clamp window
    const { chans, lufs, peakDb } = finalizeMaster(buf, -1, TARGET_LUFS);
    expect(Math.abs(lufs - TARGET_LUFS)).toBeLessThan(0.25);
    expect(peakDb).toBeLessThanOrEqual(-1 + 0.05);
    // headroom preserved: a quiet signal is NOT slammed to full scale
    expect(peakDb).toBeLessThan(-6);
    expect(chans[0].length).toBe(Math.round(5 * SR));
  });

  it('is deterministic — same input, byte-identical result', () => {
    const a = finalizeMaster(sineBuffer(0.25, 3), -1, TARGET_LUFS);
    const b = finalizeMaster(sineBuffer(0.25, 3), -1, TARGET_LUFS);
    expect(a.lufs).toBe(b.lufs);
    expect(a.peakDb).toBe(b.peakDb);
    expect(a.chans[0].every((v, i) => v === b.chans[0][i])).toBe(true);
  });

  it('null-input path reports -70 instead of NaN', () => {
    const buf = sineBuffer(0, 2);
    const l = measureLufs([buf.getChannelData(0), buf.getChannelData(1)], SR);
    expect(l).toBe(-70);
  });
});

/* --------------------------------------------------------- boundaries -- */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('no parallel audio engine — stems run the shared graph', () => {
  const stemRender = read('../src/lib/export/stemRender.ts');

  it('stem execution imports the SAME primitives the monitor and renderScore use', () => {
    expect(stemRender).toMatch(/from '\.\.\/dsp'/); // buildMaster
    expect(stemRender).toMatch(/from '\.\.\/clips'/); // scheduleClip + decode cache
    expect(stemRender).toMatch(/from '\.\.\/render'/); // shared schedule() + finalize/measure
    expect(stemRender).toMatch(/buildMaster\(ctx, masterParams, 'render'/);
    expect(stemRender).toMatch(/schedule\(\s*ctx,\s*master,\s*plan\.scenes/);
    expect(stemRender).toMatch(/scheduleClip\(master, clip, buffer/);
  });

  it('only the master pass may conform loudness', () => {
    // exactly one conform site, and it is guarded by the pass flag
    expect(stemRender.match(/finalizeMaster\(/g)?.length).toBe(1);
    expect(stemRender).toMatch(
      /if \(pass\.loudnessConform\) \{[\s\S]*?finalizeMaster\(buffer, masterParams\.ceiling, TARGET_LUFS\)/,
    );
    // every other pass measures without touching the samples
    expect(stemRender).toMatch(/\} else \{[\s\S]*?measure, never process[\s\S]*?measureLufs\(chans, sr\)/);
  });

  it('the planner never exports a stem with loudnessConform outside MASTER', async () => {
    const { planDelivery, CREATIVE_BUSES, SOURCE_BUSES } = await import('../src/lib/export');
    const { mkClip, mkProject, planOptions, SR: sr } = await import('./export.fixtures');
    const project = mkProject([mkClip({ id: 'a', start: 1, duration: 1 })], [], { duration: 10 });
    const plan = planDelivery(project, {
      clock: { sampleRate: sr },
      scope: { kind: 'full' },
      creative: [...CREATIVE_BUSES],
      sources: [...SOURCE_BUSES],
      ...planOptions(),
    });
    for (const pass of plan.passes) {
      expect(pass.loudnessConform).toBe(pass.mode === 'master');
      expect(pass.masterFx).toBe(pass.mode === 'master');
    }
  });
});
