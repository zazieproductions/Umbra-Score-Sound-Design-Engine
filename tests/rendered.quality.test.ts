/* ==================================================================== *
 *  UMBRA · RENDERED AUDIO QUALITY TESTS
 *
 *  These run the REAL procedural engine (voices.ts + dsp.ts + render.ts)
 *  through a genuine Web Audio implementation and measure the actual
 *  rendered PCM — not mocks, not code inspection. They are the "listening
 *  tests" the quality brief calls for, rendered headlessly.
 *
 *  Dependency: node-web-audio-api (a native Web Audio implementation for
 *  Node). When it cannot load — no ALSA on the machine, no prebuilt
 *  binary, etc. — the suite SKIPS itself rather than faking a pass, per
 *  the repo's "runtime verified means real inference" honesty rule.
 *  Locally:  npm i -D node-web-audio-api   (already in devDependencies)
 *
 *  Note on determinism: the Umbra graph is deterministic (all voices render
 *  byte-identically in isolation), but the native addon parallelises float
 *  reduction across large graphs, so whole-project renders may differ at the
 *  LSB level between runs. The determinism test therefore asserts *structural*
 *  determinism (events/levels identical within a tight tolerance), which is
 *  the property the engine guarantees.
 * ==================================================================== */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

let webAudio: {
  OfflineAudioContext: typeof OfflineAudioContext;
  AudioContext: typeof AudioContext;
} | null = null;
try {
  webAudio = require('node-web-audio-api');
} catch {
  webAudio = null;
}

const HAS_WEB_AUDIO = !!webAudio;
if (webAudio) {
  // The lib only reads `window.OfflineAudioContext` at render time.
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = webAudio.OfflineAudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = webAudio.AudioContext;
}

import { DEFAULT_MASTER } from '../src/lib/dsp';
import { addLayer, analyzeProject } from '../src/lib/generate';
import { renderScore, renderStem } from '../src/lib/render';
import { KIND_ORDER, type Layer, type Scene } from '../src/lib/types';

function denseScene(): Scene {
  const layers: Layer[] = KIND_ORDER.map((kind) => addLayer(kind, 'cathedral', 1, 40));
  for (const l of layers) {
    l.gain = 1.3;
    l.intensity = 1;
    l.reverb = 0.9;
  }
  return {
    id: 'stress',
    index: 0,
    start: 0,
    end: 8,
    title: 'dense stress',
    frame: '',
    tags: ['stress'],
    tension: 1,
    motion: 1,
    summary: 'every voice stacked at full intensity',
    status: 'ready',
    hits: [1, 2.5, 4, 5.5, 7],
    layers,
  };
}

describe.skipIf(!HAS_WEB_AUDIO)('rendered audio quality', () => {
  it(
    'a dense 17-voice stack at full intensity stays clean (no clip / DC / NaN / subsonic blowup)',
    async () => {
      const proj = analyzeProject('stress', 8, null, 'stress');
      const scene = denseScene();
      const res = await renderScore(proj, DEFAULT_MASTER, { maxSeconds: 10 }, scene);
      const q = res.quality!;
      expect(q.nonFinite).toBe(false);
      expect(q.clippedSamples).toBe(0);
      expect(q.truePeakDb).toBeLessThanOrEqual(0); // no intersample clip
      expect(q.dcDb).toBeLessThan(-40); // no DC / subsonic pile-up
      expect(q.subsonicDb).toBeLessThan(-6); // fail threshold in quality.ts
      expect(q.verdict).not.toBe('fail');
    },
    120_000,
  );

  it('a full project conforms to the -16 LUFS target with headroom to spare', async () => {
    const proj = analyzeProject('conform', 24, null, 'conform');
    const res = await renderScore(proj, DEFAULT_MASTER, { maxSeconds: 30 });
    expect(res.quality!.lufs).toBeGreaterThan(-17.5);
    expect(res.quality!.lufs).toBeLessThan(-14.5);
    expect(res.quality!.peakDb).toBeLessThan(-1); // under the -1 dBTP ceiling
  }, 120_000);

  it('near-silent material is preserved, not pumped to broadcast level', async () => {
    const proj = analyzeProject('silence', 8, null, 'silence');
    const scene = proj.scenes[0];
    const muted: Scene = { ...scene, layers: scene.layers.map((l) => ({ ...l, muted: true })) };
    const res = await renderScore(proj, DEFAULT_MASTER, { maxSeconds: 10 }, muted);
    // The loudness conform must not lift intentional negative space: a fully
    // muted stack stays at silence level rather than being made up to -16 LUFS.
    expect(res.quality!.lufs).toBeLessThan(-45);
    expect(res.quality!.silence.isSilent).toBe(true);
    expect(res.quality!.verdict).toBe('pass');
  }, 120_000);

  it('a single event voice renders structurally deterministically', async () => {
    const proj = analyzeProject('det', 8, null, 'det');
    const scene = proj.scenes[0];
    const layer = scene.layers[0]; // a bed voice from the cold open
    const a = await renderStem(scene, layer, DEFAULT_MASTER);
    const b = await renderStem(scene, layer, DEFAULT_MASTER);
    const ba = new Uint8Array(await a.blob.arrayBuffer());
    const bb = new Uint8Array(await b.blob.arrayBuffer());
    expect(ba.length).toBe(bb.length);
    // Tolerate only LSB-level float-reduction jitter from the native engine;
    // the pre-fix Math.random() voices differed by full-scale 16-bit flips.
    let maxByteDiff = 0;
    for (let i = 0; i < ba.length; i++) {
      const d = Math.abs(ba[i] - bb[i]);
      if (d > maxByteDiff) maxByteDiff = d;
    }
    expect(maxByteDiff).toBeLessThan(8);
  }, 120_000);
});
