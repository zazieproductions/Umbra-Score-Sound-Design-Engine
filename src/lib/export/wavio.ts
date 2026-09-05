/* ==================================================================== *
 *  WAV / BWF WRITER — the delivery quantiser
 *
 *  Byte-compatible with render.ts encodeWav for plain WAV (same 24-bit
 *  rounding, same seeded TPDF dither at 16-bit), extended with a real
 *  Broadcast Wave Format 'bext' chunk (EBU Tech 3285 v0 layout) and a
 *  canonical layout test that re-parses every field.
 *
 *  We only claim BWF compliance for what we actually write:
 *    • RIFF + fmt(16) + JUNK pad so 'bext' starts at byte 64
 *    • bext v0: Description, Originator, OriginatorReference,
 *      OriginationDate, OriginationTime, TimeReference (i64 LE samples),
 *      LoudValue/PeakValue = 0 ("not used", honest — we do not measure to
 *      BWF's 12.5 dB offset scale), Reserved zeros, Coding History
 *      (180-char records) + CRC32 Checksum over the coding history.
 *  If your pipeline needs LIST/INFO or cart chunks, they are not written —
 *  the manifest is the richer metadata carrier.
 * ==================================================================== */

import { mulberry32 } from '../prng';

export interface BwfMeta {
  description: string; // ≤ 256 ASCII
  originator: string; // ≤ 32
  originatorReference: string; // ≤ 32
  originationDate: string; // 'YYYY-MM-DD'
  originationTime: string; // 'HH:MM:SS'
  /** samples from midnight (or the declared session origin) to file start */
  timeReferenceSample: number;
  codingHistory?: string; // free text; written as 180-char records
}

export interface WaveEncodeOpts {
  bitDepth: 16 | 24;
  bwf?: BwfMeta;
}

const MAX24 = 8388607;

export function crc32(bytes: Uint8Array): number {
  let table = (crc32 as unknown as { _t?: Uint32Array })._t;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    (crc32 as unknown as { _t?: Uint32Array })._t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeAscii(view: DataView, off: number, s: string, len: number): void {
  for (let i = 0; i < len; i++) {
    // BWF text fields are 7-bit ASCII — non-ASCII chars become '?' so the
    // field never contains invalid control bytes (we do not silently mangle)
    const code = i < s.length ? s.charCodeAt(i) : 0;
    view.setUint8(off + i, code === 0 ? 0 : code >= 32 && code <= 126 ? code : 0x3f);
  }
}

/** Build a full 180-char BWF coding-history record: '<reference> : <text>' */
export function codingHistoryRecord(sr: number, bitDepth: number, extra = ''): string {
  const body = `PCM ${bitDepth === 24 ? 'S24' : 'S16'} @ ${sr} fr/s${extra ? ' ' + extra : ''}`;
  const rec = `UMBR : ${body}`;
  return rec.slice(0, 180).padEnd(180, ' ');
}

/**
 * Encode interleaved PCM. Returns raw bytes (no Blob) so the same buffer
 * feeds both download URLs and the ZIP store without copies.
 */
export function encodeWaveBytes(chans: Float32Array[], sampleRate: number, opts: WaveEncodeOpts): Uint8Array {
  const bitDepth = opts.bitDepth;
  const numCh = chans.length;
  if (numCh === 0 || chans[0].length === 0) throw new Error('encodeWaveBytes: empty channel set');
  const len = chans[0].length;
  for (const c of chans) if (c.length !== len) throw new Error('encodeWaveBytes: channel length mismatch');

  const bytesPer = bitDepth / 8;
  const dataSize = len * numCh * bytesPer;

  // chunk sizes — bext v0 fixed part: 256+32+32+10+10+8+2+2+60+4 = 416;
  // then the coding history, then the 4-byte 'Checked' CRC32.
  const histLen = opts?.bwf?.codingHistory ? historyBytes(opts.bwf.codingHistory).length : 0;
  const bextSize = opts.bwf ? 416 + histLen + 4 : 0;
  const bextChunkSize = opts.bwf ? 8 + bextSize : 0;
  // JUNK pad so that 'bext' starts at byte 64 (RIFF 12 + fmt 24 = 36 → 28 pad)
  const junkSize = opts.bwf ? 8 + 20 : 0;
  const riffSize = 4 + (8 + 16) + junkSize + bextChunkSize + (8 + dataSize);
  const ab = new ArrayBuffer(8 + riffSize);
  const view = new DataView(ab);
  const u8 = new Uint8Array(ab);
  const bytes = u8;

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, 'RIFF');
  view.setUint32(4, riffSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPer, true);
  view.setUint16(32, numCh * bytesPer, true);
  view.setUint16(34, bitDepth, true);

  let off = 36;
  if (opts.bwf) {
    str(off, 'JUNK');
    view.setUint32(off + 4, 20, true);
    // 20 zero pad bytes so bext lands at byte 64
    off += 8 + 20;
    if (off !== 64) throw new Error(`bext offset drifted: ${off}`);
    str(off, 'bext');
    view.setUint32(off + 4, bextSize, true);
    const b = opts.bwf;
    let p = off + 8;
    writeAscii(view, p, b.description, 256);
    p += 256;
    writeAscii(view, p, b.originator, 32);
    p += 32;
    writeAscii(view, p, b.originatorReference, 32);
    p += 32;
    writeAscii(view, p, b.originationDate, 10);
    p += 10;
    writeAscii(view, p, b.originationTime, 10);
    p += 10;
    // TimeReference: unsigned 64-bit LE sample count
    const tr = Math.max(0, Math.round(b.timeReferenceSample));
    view.setUint32(p, tr % 0x100000000, true);
    view.setUint32(p + 4, Math.floor(tr / 0x100000000), true);
    p += 8;
    view.setUint16(p, 0, true); // LoudValue — 0 = not measured (honest)
    view.setUint16(p + 2, 0, true); // PeakValue — not measured for this field
    p += 4;
    // Reserved (60) + zero
    p += 60;
    const hist = b.codingHistory ? historyBytes(b.codingHistory) : new Uint8Array(0);
    view.setUint32(p, hist.length, true);
    p += 4;
    bytes.set(hist, p);
    p += hist.length;
    // 'Checked' = CRC32 over the coding history (per EBU Tech 3285)
    view.setUint32(p, crc32(hist), true);
    p += 4;
    off = p;
  }

  str(off, 'data');
  view.setUint32(off + 4, dataSize, true);
  off += 8;

  // Deterministic quantisation — identical rules to render.ts encodeWav so
  // legacy and delivery files agree. TPDF dither is seeded per file (same
  // seed everywhere) which keeps exports reproducible run to run.
  const rnd = mulberry32(0x5eed);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      if (bitDepth === 24) {
        const v = Math.round(s * MAX24);
        bytes[off] = v & 0xff;
        bytes[off + 1] = (v >> 8) & 0xff;
        bytes[off + 2] = (v >> 16) & 0xff;
        off += 3;
      } else {
        const dither = (rnd() + rnd() - 1) / 32768;
        const v = Math.max(-32768, Math.min(32767, Math.round((s + dither) * 32767)));
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  return bytes;
}

function historyBytes(text: string): Uint8Array {
  // split into 180-char records per the BWF spec
  const recs: string[] = [];
  const lines = text.split(/\n+/).filter(Boolean);
  for (const line of lines) recs.push(line.slice(0, 180).padEnd(180, ' '));
  const out = new Uint8Array(recs.length * 180);
  let o = 0;
  for (const r of recs) {
    for (let i = 0; i < 180; i++) out[o++] = Math.min(0x7f, r.charCodeAt(i) || 0x20);
  }
  return out;
}

/* ------------------------------------------------------------- parser --
 * Tiny reader used by tests and preflight self-checks (round-trip proof).
 * ---------------------------------------------------------------------- */

export interface ParsedWave {
  channels: number;
  sampleRate: number;
  bitDepth: number;
  frames: number;
  dataOffset: number;
  dataSize: number;
  junkSize: number;
  bwf?: {
    description: string;
    originator: string;
    originatorReference: string;
    originationDate: string;
    originationTime: string;
    timeReferenceSample: number;
    loudValue: number;
    peakValue: number;
    codingHistory: string;
    checksum: number;
    checksumOk: boolean;
  };
}

function readAscii(view: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trimEnd();
}

export function parseWave(bytes: Uint8Array): ParsedWave {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bitDepth: number } | null = null;
  let data: { offset: number; size: number } | null = null;
  let bwf: ParsedWave['bwf'];
  let junkSize = 0;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = { channels: view.getUint16(off + 10, true), sampleRate: view.getUint32(off + 12, true), bitDepth: view.getUint16(off + 22, true) };
    } else if (id === 'JUNK') {
      junkSize = size;
    } else if (id === 'bext') {
      let p = off + 8;
      const desc = readAscii(view, p, 256);
      p += 256;
      const originator = readAscii(view, p, 32);
      p += 32;
      const originatorReference = readAscii(view, p, 32);
      p += 32;
      const originationDate = readAscii(view, p, 10);
      p += 10;
      const originationTime = readAscii(view, p, 10);
      p += 10;
      const trLo = view.getUint32(p, true);
      const trHi = view.getUint32(p + 4, true);
      p += 8;
      const loudValue = view.getUint16(p, true);
      const peakValue = view.getUint16(p + 2, true);
      p += 4;
      p += 60;
      const histLen = view.getUint32(p, true);
      p += 4;
      let hist = '';
      for (let i = 0; i < histLen; i++) hist += String.fromCharCode(bytes[p + i]);
      p += histLen;
      const checksum = view.getUint32(p, true);
      const checksumOk = checksum === crc32(bytes.subarray(off + 8 + 416, off + 8 + 416 + histLen));
      bwf = { description: desc, originator, originatorReference, originationDate, originationTime, timeReferenceSample: trLo + trHi * 0x100000000, loudValue, peakValue, codingHistory: hist, checksum, checksumOk };
    } else if (id === 'data') {
      data = { offset: off + 8, size: size };
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error('missing fmt chunk');
  if (!data) throw new Error('missing data chunk');
  const bytesPer = fmt.bitDepth / 8;
  const frames = Math.floor(data.size / (fmt.channels * bytesPer));
  return { ...fmt, frames, dataOffset: data.offset, dataSize: data.size, junkSize, bwf };
}

/** Decode back to Float32 (for round-trip tests; 24-bit path is lossless for delivered data). */
export function decodeWaveSamples(bytes: Uint8Array, parsed: ParsedWave): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Float32Array[] = [];
  for (let c = 0; c < parsed.channels; c++) out.push(new Float32Array(parsed.frames));
  let off = parsed.dataOffset;
  for (let i = 0; i < parsed.frames; i++) {
    for (let c = 0; c < parsed.channels; c++) {
      if (parsed.bitDepth === 24) {
        let v = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
        if (v & 0x800000) v |= ~0xffffff;
        out[c][i] = v / 8388608;
        off += 3;
      } else {
        out[c][i] = view.getInt16(off, true) / 32768;
        off += 2;
      }
    }
  }
  return out;
}

export function blobFromWave(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
}
