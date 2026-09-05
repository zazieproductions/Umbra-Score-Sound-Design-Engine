/* ==================================================================== *
 *  UMBRA · X-CLIP SEMANTIC BRIDGE TESTS
 *
 *  Pure frontend contracts. No model, no backend, no video decode: these
 *  pin how semantic results are normalized, attached to event objects and
 *  fed into the existing retrieval planner.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import { planSoundEvents } from '../src/lib/library/planner';
import type { SceneSoundContext, SoundEventCandidate, SoundEventKind, SoundRole, SemanticVideoResult } from '../src/lib/library/types';
import {
  attachSemanticResults,
  normalizeSemanticResult,
  semanticQuery,
  semanticRole,
  topSemanticCandidate,
} from '../src/lib/library/xclip';

function scene(over: Partial<SceneSoundContext> = {}): SceneSoundContext {
  return {
    sceneId: 'sc-test',
    start: 0,
    end: 60,
    title: 'Test scene',
    tags: [],
    summary: '',
    tension: 0.4,
    motion: 0.3,
    hits: [],
    spotting: [],
    ...over,
  };
}

function event(over: Partial<SoundEventCandidate> = {}): SoundEventCandidate {
  return {
    id: 'ev-x',
    sceneId: 'sc-test',
    timestamp: 12,
    event: 'body',
    confidence: 0.5,
    evidence: ['pixel cadence, source unnamed'],
    suggestedRole: 'BODY',
    query: 'body movement',
    altQueries: [],
    ...over,
  };
}

function semantic(over: Partial<SemanticVideoResult> = {}): SemanticVideoResult {
  return {
    available: true,
    eventId: 'ev-x',
    method: 'xclip',
    message: null,
    modelId: 'microsoft/xclip-base-patch32',
    device: 'cpu',
    candidates: [
      {
        label: 'a door opening',
        labelId: 'door_opening',
        role: 'DOOR',
        eventKind: 'door',
        audioSet: 'Door',
        query: 'door opening creak hinge',
        similarity: 0.9,
        confidence: 0.7,
      },
      {
        label: 'a door closing',
        labelId: 'door_closing',
        role: 'DOOR',
        eventKind: 'door',
        audioSet: 'Door',
        query: 'door closing creak latch',
        similarity: 0.5,
        confidence: 0.2,
      },
    ],
    ...over,
  };
}

describe('X-CLIP semantic normalization', () => {
  it('keeps known roles and clamps confidence/similarity', () => {
    const r = normalizeSemanticResult(
      {
        available: true,
        method: 'xclip',
        message: 'ok',
        candidates: [
          { label: 'fire burning', labelId: 'fire', role: 'MISC_FOLEY', eventKind: 'other', audioSet: 'Fire', query: 'fire crackling', similarity: 1.4, confidence: -0.1 },
          { label: 'made-up', labelId: null, role: 'NOT_A_ROLE', eventKind: 'nonsense', audioSet: null, query: 'made-up', similarity: 0.4, confidence: 0.9 },
        ],
      },
      'ev-1',
    );
    expect(r.candidates[0].role).toBe('MISC_FOLEY');
    expect(r.candidates[0].similarity).toBe(1);
    expect(r.candidates[0].confidence).toBe(0);
    expect(r.candidates[1].role).toBe('MISC_FOLEY');
    expect(r.candidates[1].eventKind).toBe('other');
  });

  it('marks unavailable results honestly', () => {
    const r = normalizeSemanticResult(
      { available: false, method: 'none', message: 'weights missing', candidates: [] },
      'ev-2',
    );
    expect(r.available).toBe(false);
    expect(topSemanticCandidate(r)).toBeNull();
    expect(semanticQuery(r)).toBeNull();
  });
});

describe('event attachment', () => {
  it('attaches by eventId and preserves pixel fields', () => {
    const events: SoundEventCandidate[] = [
      event({ id: 'ev-a', event: 'footstep', suggestedRole: 'FOOTSTEP' }),
      event({ id: 'ev-b', event: 'door', suggestedRole: 'DOOR' }),
    ];
    const sem: SemanticVideoResult = semantic({ eventId: 'ev-b' });
    const out = attachSemanticResults(events, [sem]);
    expect(out[0].semantic).toBeNull();
    expect(out[0].event).toBe('footstep');
    expect(out[1].semantic?.candidates[0].label).toBe('a door opening');
    expect(out[1].semanticQuery).toBe('door opening creak hinge');
    expect(out[1].event).toBe('door');
  });
});

describe('retrieval integration', () => {
  it('uses semantic query/role when confidence is strong', () => {
    const ev = event({
      id: 'ev-door',
      event: 'body',
      suggestedRole: 'BODY',
      confidence: 0.5,
      query: 'body movement',
      semantic: semantic({ eventId: 'ev-door' }),
    });
    const intents = planSoundEvents(scene(), [ev], { eventConfidenceThreshold: 0.1 });
    expect(intents.length).toBe(1);
    const intent = intents[0];
    expect(intent.role).toBe('DOOR');
    expect(intent.query).toBe('door opening creak hinge');
    expect(intent.semanticLabels).toEqual(['a door opening']);
    expect(intent.audioSetEvent).toBe('Door');
    expect(intent.semanticConfidence).toBeCloseTo(0.7);
    expect(intent.eventKind).toBe('door');
  });

  it('keeps pixel role when semantics are weak or absent', () => {
    // absent semantics
    const noSem = event({ id: 'ev-body', event: 'body', suggestedRole: 'BODY', query: 'body movement' });
    const ints = planSoundEvents(scene(), [noSem], { eventConfidenceThreshold: 0.1 });
    expect(ints[0].role).toBe('BODY');
    expect(ints[0].query).toBe('body movement');

    // low-confidence semantic — advisory only, must not override the pixel role
    const weak = semantic({
      eventId: 'ev-weak',
      candidates: [
        {
          label: 'human movement',
          labelId: 'general_human_movement',
          role: 'BODY' as SoundRole,
          eventKind: 'body' as SoundEventKind,
          audioSet: 'Human sounds',
          query: 'human movement body',
          similarity: 0.5,
          confidence: 0.1,
        },
      ],
    });
    const ev = event({ id: 'ev-weak', event: 'door', suggestedRole: 'DOOR', query: 'door hinge', semantic: weak });
    const weakIntents = planSoundEvents(scene(), [ev], { eventConfidenceThreshold: 0.1 });
    expect(weakIntents[0].role).toBe('DOOR');
    expect(weakIntents[0].query).toBe('door hinge');
  });

  it('exposes semantic provenance in the intent', () => {
    const ev = event({ id: 'ev-mach', event: 'mechanical', suggestedRole: 'MECHANICAL', semantic: semantic({ eventId: 'ev-mach' }) });
    // matches no semantic path below (MECHANICAL intent), then semantic role DOOR
    const intents = planSoundEvents(scene(), [ev], { eventConfidenceThreshold: 0.1 });
    expect(intents[0].semanticLabels).toHaveLength(1);
    expect(intents[0].audioSetEvent).toBe('Door');
  });
});

describe('role suggestion helper', () => {
  it('returns the top role above the safety threshold', () => {
    expect(semanticRole(semantic())).toBe('DOOR');
  });
  it('returns null below the safety threshold', () => {
    const weak = semantic();
    weak.candidates[0].confidence = 0.1;
    expect(semanticRole(weak)).toBeNull();
  });
  it('returns null when unavailable', () => {
    expect(semanticRole(normalizeSemanticResult({ available: false, method: 'none', message: 'x', candidates: [] }, 'e'))).toBeNull();
  });
});
