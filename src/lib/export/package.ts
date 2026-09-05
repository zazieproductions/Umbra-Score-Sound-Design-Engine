/* ==================================================================== *
 *  DELIVERY PACKAGING — UMBRA_*_Delivery.zip
 *
 *  ZIP via fflate (MIT, zero-dependency, used across the ecosystem) rather
 *  than a hand-rolled container. Audio entries are STORED (no deflate):
 *  24-bit PCM barely compresses, and store + CRC32 keeps the write path
 *  trivial to verify byte-for-byte (tests decompress and compare).
 *  Text/manifest entries use normal deflate level 6.
 * ==================================================================== */

import { zip } from 'fflate';

export interface ZipEntry {
  /** path inside the archive, e.g. 'Post_Stems/UMBRA_X_SFX.wav' */
  path: string;
  data: Uint8Array;
}

const AUDIO_EXT = /\.(wav|bwf)$/i;

export async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const files: Record<string, [Uint8Array, { level: 0 | 6; store?: boolean }]> = {};
  for (const e of entries) {
    if (files[e.path]) throw new Error(`duplicate zip entry: ${e.path}`);
    files[e.path] = e.data.length && AUDIO_EXT.test(e.path) ? [e.data, { level: 0, store: true }] : [e.data, { level: e.data.length > 0 ? 6 : 0 }];
  }
  return new Promise((resolve, reject) => {
    zip(files, {}, (err, zipped) => {
      if (err) reject(err);
      else resolve(zipped);
    });
  });
}

export function zipBlob(zipped: Uint8Array): Blob {
  return new Blob([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' });
}

/** Deterministic package tree per the delivery spec. */
export function deliveryZipName(projectSlug: string): string {
  return `UMBRA_${projectSlug}_Delivery.zip`;
}
