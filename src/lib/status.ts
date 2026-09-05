/* ==================================================================== *
 *  PROVIDER STATUS SEMANTICS (single source of truth)
 *
 *  Every status word the UI shows corresponds to a precise amount of
 *  evidence. The ladder is deliberately strict:
 *
 *    unavailable      — the provider is known but cannot even be probed
 *    not-installed    — probed: dependencies/weights are absent
 *    installed        — dependencies/weights present, model NOT loaded
 *    ready            — the provider will accept a request (loaded/server up)
 *    runtime-verified — a real generation completed successfully this session
 *    failed           — the last operation errored and the UI must say so
 *
 *  “runtime-verified” is never derived from an adapter declaration or a
 *  mocked test. It is only set after a real job of that provider succeeded.
 *  Capabilities are *declared* by the installed version until a generation
 *  actually exercises them.
 * ==================================================================== */

import type { ProviderStatus as BackendProviderStatus } from './providers';
import type { ProviderStatus as LibraryProviderStatus } from './library/types';

export type RuntimeTrust =
  | 'unavailable'
  | 'not-installed'
  | 'installed'
  | 'ready'
  | 'runtime-verified'
  | 'failed';

export interface StatusView {
  trust: RuntimeTrust;
  label: string;
  detail: string;
  tone: 'dim' | 'tan' | 'brine';
}

export function trustFor(p: { ready: boolean; installed: boolean; error?: string | null }): RuntimeTrust {
  if (p.error) return 'failed';
  if (p.ready) return 'ready';
  if (p.installed) return 'installed';
  return 'not-installed';
}

export function statusView(p: BackendProviderStatus, runtimeVerified = false): StatusView {
  const trust: RuntimeTrust = runtimeVerified ? 'runtime-verified' : trustFor(p);
  switch (trust) {
    case 'runtime-verified':
      return { trust, label: 'runtime verified', detail: 'a real generation from this provider completed this session', tone: 'brine' };
    case 'ready':
      return { trust, label: 'ready', detail: 'model/weights are present and the provider will accept a request — not yet exercised in a generation this session', tone: 'brine' };
    case 'installed':
      return { trust, label: 'installed · not loaded', detail: 'dependencies/weights are present but the model is not ready to run', tone: 'tan' };
    case 'failed':
      return { trust, label: 'failed', detail: p.error ?? 'the last probe errored', tone: 'tan' };
    default:
      return { trust, label: 'not installed', detail: 'probing found no install — see the install command below', tone: 'dim' };
  }
}

/**
 * Library (retrieval) providers report `online`/`ready`/`reason`.
 * `ready && online` means a live search will really be attempted, so the
 * label is “ready”; everything else is shown as unavailable with the
 * provider’s own reason (missing key, offline mode, assisted-search only).
 */
export function libraryStatusView(p: LibraryProviderStatus): StatusView {
  if (p.online && p.ready) {
    return {
      trust: 'ready',
      label: p.capabilities.offline ? 'ready (offline source)' : 'ready',
      detail: p.reason ?? (p.capabilities.search ? 'search and preview available' : 'connected'),
      tone: 'brine',
    };
  }
  if (p.online && !p.ready) {
    return { trust: 'not-installed', label: 'needs attention', detail: p.reason ?? 'reachable but not ready', tone: 'tan' };
  }
  return { trust: 'unavailable', label: 'unavailable', detail: p.reason ?? 'not configured', tone: 'dim' };
}

/**
 * X-CLIP is an analysis layer (not an audio provider), but it must use the
 * same status ladder. `runtimeVerified` is only true after real X-CLIP
 * inference processed video frames — never on weights-on-disk alone.
 */
export function analysisStatusView(a: { installed: boolean; ready: boolean; runtimeVerified: boolean; error?: string | null }): StatusView {
  if (a.error) return { trust: 'failed', label: 'failed', detail: a.error, tone: 'tan' };
  if (a.runtimeVerified) {
    return {
      trust: 'runtime-verified',
      label: 'runtime verified',
      detail: 'real X-CLIP inference processed video frames this session',
      tone: 'brine',
    };
  }
  if (a.ready) {
    return {
      trust: 'ready',
      label: 'loaded · not verified',
      detail: 'weights/deps present and model loadable — no real inference has run yet',
      tone: 'tan',
    };
  }
  if (a.installed) {
    return {
      trust: 'installed',
      label: 'weights present · not loaded',
      detail: 'checkpoint on disk but torch/transformers/Pillow are missing',
      tone: 'tan',
    };
  }
  return { trust: 'not-installed', label: 'not installed', detail: 'run the install command below', tone: 'dim' };
}

/** Capability chips: declared until proven. */
export function capabilityEvidenceLabel(runtimeVerified: boolean): string {
  return runtimeVerified
    ? 'Capabilities exercised by a real generation this session'
    : 'Declared capabilities · not yet runtime-tested';
}

export function capabilityEvidenceNote(runtimeVerified: boolean): string {
  return runtimeVerified
    ? 'A real generation for this provider succeeded this session, so these capabilities were exercised end to end.'
    : 'These capabilities are declared from the installed provider/version. They describe what the provider supports — no inference has run in this session yet, so none of them are proof of a working model.';
}
