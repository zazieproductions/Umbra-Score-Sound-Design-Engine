/* MMAudio boundary/licensing/export tests. Mocked inference/rendering ≠ runtime verification. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScoringPanel from '../src/components/ScoringPanel';
import ModelsView from '../src/components/ModelsView';
import { backend, generationLicenseError, PROVIDER_FALLBACK, type GenerationJob, type ProviderStatus } from '../src/lib/providers';
import { clipFromGeneration, moveClip, splitClip, trimClip } from '../src/lib/clips';
import { hasNoncommercialModel } from '../src/lib/types';
import { licenseAllowed } from '../src/lib/library/types';
import { serializeProject } from '../src/lib/persistence';
import { DEFAULT_MASTER } from '../src/lib/dsp';
import { buildCueRows, buildDeliveryManifest, planDelivery, runPreflight } from '../src/lib/export';
import { runPostExport } from '../src/lib/export/delivery';
import { renderPassWebAudio } from '../src/lib/export/stemRender';
import type { StemPassPlan } from '../src/lib/export/stemPlan';
import { statusView } from '../src/lib/status';
import { mkProject, planOptions, SR } from './export.fixtures';
import { setFetchMock } from './setup';

vi.mock('../src/lib/export/stemRender', () => ({
  renderPassWebAudio: vi.fn(async (_plan: unknown, pass: StemPassPlan) => ({
    L: new Float32Array(pass.frameCount), R: new Float32Array(pass.frameCount),
    peakDb: -12, lufs: -24, clipsPlaced: pass.clips.length, clipsFailed: [],
  })),
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function jobFixture(): GenerationJob {
  return {
    jobId: 'mma-test', provider: 'mmaudio', state: 'succeeded', stage: 'complete',
    createdAt: 0, startedAt: 0, finishedAt: 1, elapsed: 1, error: null, hint: null,
    label: 'Door', sceneId: 'scene-1', timelineStart: 18.417,
    result: {
      audioId: 'real-decoded-id', url: '/api/audio/real-decoded-id', duration: 2.25,
      sampleRate: 44100, channels: 1, frames: 99225, bytes: 297720, provider: 'mmaudio',
      metadata: {
        provider: 'mmaudio', prompt: '', negativePrompt: '', seed: 0,
        model: 'mmaudio_small_44k.pth', modelVersion: 'small_44k', modelRevision: 'pinned-weight-revision',
        codeLicense: 'MIT', codeVersion: '1.0.0', codeRevision: 'installed-revision',
        videoPath: '/local/.umbra/video/film.mp4', sourceVideoStart: 18.417, sourceVideoEnd: 20.75,
        generatedDuration: 2.25, requestedDuration: 2.333, timelineStart: 18.417,
        commercialSafe: false, experimental: true, license: 'CC BY-NC 4.0', licenseClass: 'CC_BY_NC',
        licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
        creditLine: 'MMAudio — Ho Kei Cheng et al.; CC BY-NC 4.0 checkpoints.',
        sourceUrl: 'https://huggingface.co/hkchengrex/MMAudio',
      },
    },
  };
}

function clipFixture() { return clipFromGeneration(jobFixture(), { start: 99, name: 'Door Foley' }); }
function planFixture() {
  return planDelivery(mkProject([clipFixture()], [], { duration: 24 }), {
    clock: { sampleRate: SR }, scope: { kind: 'full' }, creative: ['FOLEY'], sources: ['GENERATED'],
    includeMaster: true, ...planOptions(),
  });
}

function statusFixture(): ProviderStatus {
  return {
    id: 'mmaudio', ...PROVIDER_FALLBACK.mmaudio, installed: true, ready: true,
    capabilities: ['VIDEO_CONDITIONED', 'SFX_GENERATION'], device: 'cpu', deviceDetail: null,
    model: 'mmaudio_small_44k.pth', availableModels: ['small_44k'], version: '1.0.0',
    sizeBytes: null, notes: [], installHint: 'python scripts/setup_models.py --mmaudio', error: null,
  };
}

describe('canonical video generation → AudioClip', () => {
  it('uses the backend-normalized video in-point, not a stale playhead, and measured duration', () => {
    const clip = clipFixture();
    expect(clip.start).toBe(18.417);
    expect(clip.duration).toBe(2.25);
    expect(clip.sourceDuration).toBe(2.25);
    expect(clip.offset).toBe(0);
    expect(clip.provider).toBe('mmaudio');
    expect(clip.audioId).toBe('real-decoded-id');
    expect(clip.metadata).toEqual(jobFixture().result!.metadata);
  });

  it('preserves source timing and model/license provenance through edits and persistence', () => {
    const original = clipFixture();
    const moved = moveClip(original, 12, 24);
    const trimmed = trimClip(moved, 'start', 0.25);
    const split = splitClip(trimmed, 13)!;
    expect(split).toHaveLength(2);
    for (const clip of split) expect(clip.metadata).toEqual(original.metadata);
    const saved = serializeProject(mkProject(split));
    expect(saved.clips[0].metadata.sourceVideoStart).toBe(18.417);
    expect(saved.clips[0].metadata.license).toBe('CC BY-NC 4.0');
    expect(saved.clips[0].metadata.modelVersion).toBe('small_44k');
  });

  it('refuses absent/failed results instead of fabricating clips', () => {
    expect(() => clipFromGeneration({ ...jobFixture(), state: 'failed', result: null }, { start: 0, name: 'bad' })).toThrow();
  });
});

describe('noncommercial gating', () => {
  it('is blocked by default, in strict mode, and without explicit consent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
    setFetchMock(fetch);
    for (const flags of [{}, { allowNoncommercial: true }, { commercialSafe: true, allowNoncommercial: true }, { commercialSafe: false }]) {
      await expect(backend.generate({ provider: 'mmaudio', prompt: '', duration: 2, ...flags })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    const strict = { mode: 'strict' as const, accepted: ['CC_BY_NC' as const] };
    expect(generationLicenseError({ provider: 'mmaudio', commercialSafe: !licenseAllowed(strict, 'CC_BY_NC'), allowNoncommercial: true })).toContain('blocked');
    expect(generationLicenseError({ provider: 'ace-step' })).toBeNull();
  });

  it('posts video-only or text+video requests to the existing endpoint with explicit consent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ job: jobFixture() })));
    setFetchMock(fetch);
    const req = { provider: 'mmaudio' as const, prompt: '', duration: 2.333, videoPath: '/local/video.mp4',
      videoStart: 18.417, videoEnd: 20.75, commercialSafe: false, allowNoncommercial: true, seed: 0 };
    await backend.generate(req);
    expect(fetch.mock.calls[0][0]).toBe('/api/generate');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(req);
  });

  it('keeps video uploads on the same origin', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ video: { path: '/local/upload.mp4', duration: 3 } })));
    setFetchMock(fetch);
    const video = await backend.uploadVideo(new Blob(['test MP4 fixture']), 'tiny.mp4');
    expect(video.path).toBe('/local/upload.mp4');
    expect(fetch.mock.calls[0][0]).toBe('/api/analysis/video/upload');
    expect(fetch.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
  });

  it('never classifies MMAudio as commercial-safe or runtime-verified just because installed', () => {
    expect(PROVIDER_FALLBACK.mmaudio.commercialSafe).toBe(false);
    expect(PROVIDER_FALLBACK.mmaudio.experimental).toBe(true);
    expect(statusView(statusFixture()).trust).not.toBe('runtime-verified');
    expect(hasNoncommercialModel({ ...clipFixture(), metadata: { provider: 'mmaudio' } })).toBe(true);
  });

  it('labels MMAudio visibly and disables its picker in strict/portable workflows', () => {
    const mma = statusFixture();
    const proc: ProviderStatus = { ...mma, id: 'umbra-procedural', ...PROVIDER_FALLBACK['umbra-procedural'] };
    const providers = [proc, mma];
    const studio = {
      project: mkProject([]), activeScene: null, range: { start: 0, end: 2 }, time: 0,
      libSettings: { licensePolicy: { mode: 'strict', accepted: [] } },
      generation: { providers, providerById: (id: string) => providers.find((p) => p.id === id),
        backendState: 'offline', backendError: null, jobs: [], busy: false, isVerified: () => false },
    };
    const picker = renderToStaticMarkup(createElement(ScoringPanel, { studio: studio as never }));
    expect(picker).toContain('EXPERIMENTAL · NONCOMMERCIAL');
    expect(picker.match(/<button[^>]*title="Blocked by strict\/portable licensing policy"[^>]*>/)?.[0]).toContain('disabled');
    const cards = renderToStaticMarkup(createElement(ModelsView, { studio: studio as never }));
    expect(cards).toContain('EXPERIMENTAL · NONCOMMERCIAL');
    expect(cards).toContain('CC BY-NC 4.0');
    expect(cards).not.toContain('runtime verified');
  });
});

describe('export provenance is mandatory, not a second library asset', () => {
  it('retains the checkpoint, license, prompt, seed and source range in manifests/cues', () => {
    const plan = planFixture();
    const manifest = buildDeliveryManifest(plan, { bitDepth: 24, channels: 2, container: 'wav' }, new Map(), new Map(), {
      exportedAt: 'test', toolVersion: 'test',
    });
    const entry = manifest.clips[0];
    expect(entry.startSample).toBe(Math.round(18.417 * SR));
    expect(entry.license).toBe('CC BY-NC 4.0');
    expect(entry.licenseClass).toBe('CC_BY_NC');
    expect(entry.commercialSafe).toBe(false);
    expect(entry.metadata).toEqual(jobFixture().result!.metadata);
    expect(buildCueRows(plan)[0].license).toBe('CC BY-NC 4.0');
    expect(buildCueRows(plan)[0].notes).toContain('NONCOMMERCIAL');
  });

  it('blocks commercial-safe delivery, including force; allows explicit noncommercial mode with a warning', async () => {
    const plan = planFixture();
    const env = { probeClip: async () => 'ok' as const };
    expect((await runPreflight(plan, env)).ok).toBe(false);
    const allowed = await runPreflight(plan, env, { commercialSafe: false });
    expect(allowed.ok).toBe(true);
    expect(allowed.checks.find((c) => c.code === 'noncommercial-model')?.level).toBe('warn');
    await expect(runPostExport(mkProject([clipFixture()]), DEFAULT_MASTER, { preset: 'MASTER_MIX', force: true }, {
      probeClip: async () => 'ok',
    })).rejects.toThrow('NONCOMMERCIAL');
    expect(renderPassWebAudio).not.toHaveBeenCalled();
  });

  it('ships the manifest even for master-only/no-docs noncommercial exports (render is mocked)', async () => {
    const result = await runPostExport(mkProject([clipFixture()]), DEFAULT_MASTER, {
      preset: 'MASTER_MIX', commercialSafe: false, docs: false, zip: false,
    }, { probeClip: async () => 'ok' });
    const file = result.files.find((f) => f.name === 'delivery_manifest.json');
    expect(file).toBeDefined();
    const doc = JSON.parse(new TextDecoder().decode(file!.bytes));
    expect(doc.clips[0].metadata.model).toBe('mmaudio_small_44k.pth');
    expect(doc.clips[0].commercialSafe).toBe(false);
    for (const f of result.files) if (f.url) URL.revokeObjectURL(f.url);
  });

  it('source download requests the WAV and its backend provenance sidecar', () => {
    const clicked: string[] = [];
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      const a = { href: '', download: '', click: () => clicked.push(a.href), remove: () => undefined };
      return a as unknown as HTMLAnchorElement;
    });
    backend.downloadAudio('id', 'MMAudio.wav', true);
    expect(clicked).toEqual(['/api/audio/id?download=1', '/api/audio/id?metadata=1']);
  });
});
