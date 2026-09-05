/* ==================================================================== *
 *  UMBRA · RETRIEVAL RANKING PIPELINE
 *
 *  Never trust the first search result. This pipeline combines:
 *    semantic text similarity         (query/tag/name overlap)
 *    CLAP similarity                  (optional in-browser reranker)
 *    duration suitability             (event vs. bed roles)
 *    license policy                   (hard gate + preference)
 *    audio quality                    (sample rate, channels, format)
 *    popularity / ratings             (provider signals)
 *
 *  MATCH is informational transparency — a weighted blend, NOT a claim
 *  of objective quality. CLAP is one signal among many and can never
 *  overrule the user.
 * ==================================================================== */

import type { LicensePolicy, LibraryAsset, RankedCandidate, RetrievalIntent } from './types';
import { isBedRole, licenseAllowed } from './types';

export interface ClapReranker {
  id: string;
  label: string;
  /** score 0..1 semantic match of candidate audio vs. the intended sound */
  score(query: string, audio: AudioBuffer | Float32Array, sampleRate: number): Promise<number>;
}

let clapReranker: ClapReranker | null = null;
export function registerClapReranker(r: ClapReranker | null) {
  clapReranker = r;
}
export function getClapReranker(): ClapReranker | null {
  return clapReranker;
}

/* --------------------------------------------------- text scoring --- */

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'for', 'with', 'from', 'by', 'into', 'very', 'old', 'new', 'dark', 'scary', 'creepy', 'horror',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

function scoreText(query: string, asset: LibraryAsset): number {
  const q = tokens(query);
  // name/tags dominate; description is weak evidence (freesound descriptions
  // often contain noise)
  const name = tokens(asset.title);
  const tags = tokens(asset.tags.join(' '));
  const desc = tokens(asset.description ?? '');
  const sName = jaccard(q, name) * 0.9;
  const sTags = jaccard(q, tags) * 0.7;
  const sDesc = jaccard(q, desc) * 0.3;
  // direct substring bonus (e.g. query "wood step" vs name "wood_step_01")
  const hay = `${asset.title} ${asset.tags.join(' ')} ${asset.description ?? ''}`.toLowerCase();
  let subBonus = 0;
  for (const t of q) if (hay.includes(t)) subBonus += 0.16;
  return Math.min(1, sName + sTags + sDesc + subBonus);
}

/* ----------------------------------------------- duration fitness --- */

function scoreDuration(intent: RetrievalIntent, asset: LibraryAsset): number {
  const d = asset.duration || 0;
  const bed = isBedRole(intent.role);
  if (intent.durationFit === 'short' && !bed) {
    // one-shot foley: 0.05s..3s ideal, decaying beyond
    if (d <= 0.05) return 0.1;
    if (d <= 3) return 1;
    return Math.max(0.1, 1 - (d - 3) / 20);
  }
  if (intent.durationFit === 'medium' && !bed) {
    if (d >= 1 && d <= 6) return 1;
    if (d > 6) return Math.max(0.1, 1 - (d - 6) / 30);
    return Math.max(0.1, d / 1);
  }
  if (bed || intent.durationFit === 'long') {
    if (d >= 8) return 1;
    return Math.max(0.05, d / 8);
  }
  return 0.5;
}

/* ------------------------------------------------------ licensing --- */

function scoreLicense(policy: LicensePolicy, asset: LibraryAsset): { ok: boolean; reason: string | null; pref: number } {
  const allowed = licenseAllowed(policy, asset.licenseClass);
  if (!allowed) {
    return { ok: false, reason: `${asset.license} is not allowed by the current license policy.`, pref: 0 };
  }
  // CC0 preferred; BY fine; NC fine everywhere once the policy allows it
  const pref = asset.licenseClass === 'CC0' ? 1 : asset.licenseClass === 'CC_BY' ? 0.85 : 0.7;
  return { ok: true, reason: null, pref };
}

/* --------------------------------------------------------- quality -- */

function scoreQuality(asset: LibraryAsset): number {
  let s = 0.5;
  if (asset.sampleRate && asset.sampleRate >= 44100) s += 0.25;
  else if (asset.sampleRate) s += 0.05;
  if (asset.channels && asset.channels >= 2) s += 0.15;
  if (asset.type && ['wav', 'flac', 'aiff', 'aif', 'ogg'].includes(asset.type)) s += 0.1;
  return Math.min(1, s);
}

/* ------------------------------------------------------ popularity -- */

function scorePopularity(asset: LibraryAsset): number {
  const d = asset.numDownloads ?? 0;
  const r = asset.avgRating ?? 0;
  const pop = d > 0 ? Math.min(1, Math.log10(1 + d) / 6) : 0;
  const rating = r > 0 ? Math.min(1, r / 5) : 0;
  return pop * 0.7 + rating * 0.3;
}

/* ------------------------------------------------------- pipeline --- */

export interface RankInput {
  intent: RetrievalIntent;
  assets: LibraryAsset[];
  policy: LicensePolicy;
  /** optional CLAP scores keyed by soundId */
  clapScores?: Map<string, number>;
  clapLabel?: string;
}

const W = { text: 0.34, duration: 0.16, license: 0.2, quality: 0.1, popularity: 0.08, clap: 0.22 };
// license is a gate + preference, so effective weight applies when allowed

export function rankCandidates(input: RankInput): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const asset of input.assets) {
    const lic = scoreLicense(input.policy, asset);
    const signals: RankedCandidate['signals'] = [];
    const text = scoreText(input.intent.query, asset);
    signals.push({ label: 'text', value: text.toFixed(2), weight: W.text });
    const dur = scoreDuration(input.intent, asset);
    signals.push({ label: 'duration', value: dur.toFixed(2), weight: W.duration });
    const qual = scoreQuality(asset);
    signals.push({ label: 'audio quality', value: qual.toFixed(2), weight: W.quality });
    const pop = scorePopularity(asset);
    signals.push({ label: 'popularity', value: pop.toFixed(2), weight: W.popularity });
    let clap = 0;
    if (input.clapScores?.has(asset.soundId)) {
      clap = input.clapScores.get(asset.soundId) ?? 0;
      signals.push({ label: input.clapLabel ?? 'clap', value: clap.toFixed(2), weight: W.clap });
    }
    // provider relevance score (Freesound search engine) — blends with text
    const provider = asset.score !== undefined ? Math.min(1, asset.score / 100) : 0;
    signals.push({ label: 'provider relevance', value: provider.toFixed(2), weight: 0.12 });

    let raw;
    if (!lic.ok) raw = 0;
    else {
      // normalize weights after removing the license gate penalty
      raw =
        (text * W.text +
          dur * W.duration +
          lic.pref * W.license +
          qual * W.quality +
          pop * W.popularity +
          clap * W.clap +
          provider * 0.12) /
        (W.text + W.duration + W.license + W.quality + W.popularity + W.clap + 0.12);
    }
    ranked.push({
      asset,
      match: Math.max(0, Math.min(1, raw)),
      signals,
      licenseOk: lic.ok,
      licenseReason: lic.reason,
    });
  }
  return ranked.sort((a, b) => b.match - a.match);
}

/**
 * Rerank the top candidates with CLAP when a reranker is registered.
 * CLAP is advisory: a failure here never breaks retrieval, and the
 * license policy gate is re-applied afterwards.
 */
export async function applyClapRerank(
  intent: RetrievalIntent,
  candidates: RankedCandidate[],
  policy: LicensePolicy,
  fetchAudio: (asset: LibraryAsset) => Promise<Blob>,
  decode: (blob: Blob) => Promise<Float32Array | null>,
  label = 'clap',
): Promise<{ candidates: RankedCandidate[]; used: boolean }> {
  const r = clapReranker;
  if (!r) return { candidates, used: false };
  const scores = new Map<string, number>();
  for (const c of candidates.slice(0, 12)) {
    try {
      const blob = await fetchAudio(c.asset);
      const pcm = await decode(blob);
      if (!pcm) continue;
      const s = await r.score(intent.query, pcm, 48000);
      scores.set(c.asset.soundId, s);
    } catch {
      /* CLAP must never break retrieval */
    }
  }
  if (!scores.size) return { candidates, used: false };
  const merged = rankCandidates({
    intent,
    assets: candidates.map((c) => c.asset),
    policy,
    clapScores: scores,
    clapLabel: label,
  });
  return { candidates: merged, used: true };
}
