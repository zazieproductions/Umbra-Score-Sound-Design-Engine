/* ==================================================================== *
 *  UMBRA · ASSET PROVENANCE LEDGER
 *
 *  Every external sound used in the project must appear here:
 *  source, title, creator, sound ID, license, attribution, retrieval
 *  date, placement. Exports to sound_credits.txt and sound_credits.json.
 * ==================================================================== */

import type { ProvenanceEntry } from './types';

export function ledgerFromClips(entries: ProvenanceEntry[], projectName: string, duration: number) {
  const unique = new Map<string, ProvenanceEntry>();
  for (const e of entries) {
    const key = `${e.asset.provider}|${e.asset.soundId}`;
    if (!unique.has(key)) unique.set(key, e);
  }
  const rows = [...unique.values()].sort((a, b) => a.usedAt - b.usedAt);
  return {
    project: projectName,
    duration,
    exportedAt: new Date().toISOString(),
    count: rows.length,
    entries: rows.map((e) => ({
      source: e.asset.providerLabel,
      provider: e.asset.provider,
      title: e.asset.title,
      creator: e.asset.creator,
      soundId: e.asset.soundId,
      sourceUrl: e.asset.sourceUrl,
      license: e.asset.license,
      licenseClass: e.asset.licenseClass,
      attributionRequired: e.asset.attributionRequired,
      creditLine: e.asset.creditLine,
      quality: e.asset.quality,
      retrievedAt: new Date(e.asset.retrievedAt).toISOString(),
      usedAt: secondsToTc(e.usedAt),
      role: e.role,
      md5: e.asset.md5 ?? null,
    })),
  };
}

export function exportCreditsTxt(entries: ProvenanceEntry[], projectName: string, duration: number): string {
  const data = ledgerFromClips(entries, projectName, duration);
  const lines: string[] = [
    'UMBRA·SCORE — SOUND CREDITS',
    '===========================',
    `Project : ${data.project}`,
    `Length  : ${secondsToTc(data.duration)}`,
    `Exported: ${data.exportedAt}`,
    '',
    'Every retrieved/imported sound used in this project:',
    '',
  ];
  for (const e of data.entries) {
    lines.push(`SOUND      : ${e.title}`);
    lines.push(`SOURCE     : ${e.source}  (${e.soundId})`);
    lines.push(`CREATOR    : ${e.creator}`);
    lines.push(`LICENSE    : ${e.license}${e.attributionRequired ? '' : '  (no attribution required)'}`);
    lines.push(`CREDIT     : ${e.creditLine}`);
    lines.push(`USED AT    : ${e.usedAt}`);
    lines.push(`RETRIEVED  : ${e.retrievedAt}`);
    lines.push(`QUALITY    : ${e.quality}`);
    if (e.md5) lines.push(`MD5        : ${e.md5}`);
    lines.push('');
  }
  if (!data.entries.length) lines.push('(no external sounds used in this project)');
  lines.push('Sources: Freesound.org API · user library · assisted imports.');
  lines.push('Attribution according to the license returned by each source.');
  return lines.join('\n');
}

export function exportCreditsJson(entries: ProvenanceEntry[], projectName: string, duration: number): string {
  return JSON.stringify(ledgerFromClips(entries, projectName, duration), null, 2);
}

export function downloadText(name: string, text: string, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function secondsToTc(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const f = Math.floor((t % 1) * 24);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
