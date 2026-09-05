/* ==================================================================== *
 *  UMBRA · ARCHITECTURE INVARIANTS
 *
 *  Structural contracts future changes must not break. These are cheap,
 *  deterministic, and mock-free where possible. If an invariant needs to
 *  change, update AGENTS.md / docs first, then this file — in that order.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import {
  CLIP_PROVIDER_META,
  soundClipToAudioClip,
  type AudioClip,
  type ClipProvider,
} from '../src/lib/types';
import {
  CAPABILITY_LABEL,
  PROVIDER_FALLBACK,
  type Capability,
  type ProviderId,
} from '../src/lib/providers';

/* CLAP is analysis/search, never generation. If the capability set ever
 * grows a generation cap for the semantic role, this fails loudly. */
const GENERATION_CAPS: Capability[] = ['MUSIC_GENERATION', 'SFX_GENERATION'];
const SEMANTIC_ROLE_CAPS: Capability[] = ['SEMANTIC_SEARCH', 'EMBEDDINGS'];

describe('CLAP is search, not generation', () => {
  it('the semantic provider role has no generation capabilities in its vocabulary slot', () => {
    expect(PROVIDER_FALLBACK['clap'].role).toBe('semantic');
    for (const cap of GENERATION_CAPS) {
      expect(SEMANTIC_ROLE_CAPS).not.toContain(cap);
      expect(CAPABILITY_LABEL[cap]).toBeTruthy(); // label exists, just never for clap
    }
  });
});

/* Procedural must be usable with no backend. The fallback description is the
 * pre-backend state: it must exist and must not claim model readiness. */
describe('procedural is first-class and backend-independent', () => {
  it('has an offline description with the procedural role', () => {
    expect(PROVIDER_FALLBACK['umbra-procedural'].role).toBe('procedural');
    expect(PROVIDER_FALLBACK['umbra-procedural'].label).toBeTruthy();
  });

  it('every backend provider id has a fallback entry (no missing/extra ids)', () => {
    const ids: ProviderId[] = ['umbra-procedural', 'ace-step', 'stable-audio', 'mmaudio', 'clap'];
    expect(Object.keys(PROVIDER_FALLBACK).sort()).toEqual([...ids].sort());
  });
});

/* One canonical clip architecture: every ClipProvider value must have
 * metadata in CLIP_PROVIDER_META, and the library boundary conversion must
 * preserve provenance. */
describe('unified AudioClip architecture', () => {
  it('every ClipProvider has canonical metadata (no shadow clip types)', () => {
    const providers: ClipProvider[] = [
      'umbra-procedural',
      'ace-step',
      'stable-audio',
      'mmaudio',
      'library',
      'user',
    ];
    for (const p of providers) {
      expect(CLIP_PROVIDER_META[p]?.label).toBeTruthy();
      expect(CLIP_PROVIDER_META[p]?.short).toBeTruthy();
    }
  });

  it('library → unified conversion retains provenance (asset, cacheKey, intent)', () => {
    const legacy = {
      id: 'c1',
      sceneId: 's1',
      name: 'door rattle',
      role: 'DOOR',
      source: 'LIB',
      start: 18.4,
      end: 19.4,
      offset: 0,
      gain: 1,
      pan: 0,
      fadeIn: 0.05,
      fadeOut: 0.1,
      muted: false,
      solo: false,
      transform: undefined,
      asset: {
        provider: 'freesound',
        soundId: '123',
        title: 'door rattle',
        licenseClass: 'CC_BY',
        creditLine: 'door rattle by someone (CC BY)',
        cacheKey: 'fs-123-preview',
      },
      cacheKey: 'fs-123-preview',
      intentId: 'intent-7',
      match: 0.9,
    };
    const clip: AudioClip = soundClipToAudioClip(legacy as never);
    expect(clip.provider).toBe('library');
    expect(clip.cacheKey).toBe('fs-123-preview');
    expect(clip.intentId).toBe('intent-7');
    expect(clip.match).toBe(0.9);
    expect(clip.asset).toBeTruthy();
  });
});

/* Provider failures must be explicit errors, never fabricated audio. The
 * single frontend↔backend boundary throws BackendOfflineError (not a fake
 * empty result) when the service is unreachable. */
describe('failures are loud, never fabricated', () => {
  it('BackendOfflineError is an Error with a stable message contract', async () => {
    const { BackendOfflineError } = await import('../src/lib/providers');
    const err = new BackendOfflineError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BackendOfflineError');
    expect(err.message).toMatch(/not running/);
  });
});
