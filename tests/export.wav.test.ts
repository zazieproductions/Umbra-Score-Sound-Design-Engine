/* ==================================================================== *
 *  WAV / BWF WRITER — file integrity + honest BWF (§9, §13)
 *
 *  24-bit delivery must be bit-deterministic, frame-exact, byte-compatible
 *  with the legacy renderer for plain WAV, and — when BWF is selected —
 *  carry a real bext chunk at byte 64 whose fields re-parse identically
 *  (including the coding-history CRC).
 * ==================================================================== */

import { describe, expect, it } from 'vitest';
import { blobFromWave, codingHistoryRecord, crc32, decodeWaveSamples, encodeWaveBytes, parseWave } from '../src/lib/export/wavio';
import { encodeWav } from '../src/lib/render';

const SR = 48000;

function ramp(len: number, amp = 0.5): Float32Array {
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) d[i] = amp * Math.sin((i / len) * Math.PI * 20);
  return d;
}

describe('plain PCM WAV', () => {
  it('header + size are exact for the requested frame count (deterministic length §2)', () => {
    const L = ramp(96000);
    const R = ramp(96000);
    const bytes = encodeWaveBytes([L, R], SR, { bitDepth: 24 });
    expect(bytes.length).toBe(44 + 96000 * 2 * 3);
    const p = parseWave(bytes);
    expect(p.sampleRate).toBe(SR);
    expect(p.bitDepth).toBe(24);
    expect(p.channels).toBe(2);
    expect(p.frames).toBe(96000);
    expect(p.bwf).toBeUndefined();
  });

  it('is byte-identical to the legacy render.ts encodeWav output', async () => {
    const chans = [ramp(3600), ramp(3600)];
    const legacy = new Uint8Array(await encodeWav(chans, SR, 24).arrayBuffer());
    const modern = encodeWaveBytes(chans, SR, { bitDepth: 24 });
    expect(modern.length).toBe(legacy.length);
    expect(legacy.every((b, i) => b === modern[i])).toBe(true);
  });

  it('24-bit quantisation round-trips to ~2^-23 and 16-bit dither is deterministic', () => {
    const chans = [ramp(1200, 0.75)];
    const p24 = parseWave(encodeWaveBytes(chans, SR, { bitDepth: 24 }));
    const d24 = decodeWaveSamples(encodeWaveBytes(chans, SR, { bitDepth: 24 }), p24)[0];
    for (let i = 0; i < 1200; i++) expect(Math.abs(d24[i] - chans[0][i])).toBeLessThan(2 ** -23 + 1e-9);

    const bytesA = encodeWaveBytes(chans, SR, { bitDepth: 16 });
    const bytesB = encodeWaveBytes(chans, SR, { bitDepth: 16 });
    expect(bytesA.every((b, i) => b === bytesB[i])).toBe(true); // seeded TPDF — reproducible exports
  });

  it('rejects mismatched channels instead of writing garbage', () => {
    expect(() => encodeWaveBytes([ramp(10), ramp(12)], SR, { bitDepth: 24 })).toThrow(/channel length/);
    expect(() => encodeWaveBytes([new Float32Array(0)], SR, { bitDepth: 24 })).toThrow(/empty/);
  });
});

describe('BWF bext (§9 — real, not faked)', () => {
  const meta = {
    description: 'UMBRA stem: Post Stems SFX - Test Reel',
    originator: 'UMBRA-SCORE',
    originatorReference: 'UMBRA-DELIVERY-1/POST.SFX',
    originationDate: '2026-09-05',
    originationTime: '13:45:02',
    timeReferenceSample: 883200,
    codingHistory: codingHistoryRecord(SR, 24, '[POST.SFX] Σ-reconstructable pre-master stem'),
  };

  it('places bext at byte 64 after a JUNK pad, per EBU Tech 3285', () => {
    const bytes = encodeWaveBytes([ramp(480), ramp(480)], SR, { bitDepth: 24, bwf: meta });
    expect(String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])).toBe('fmt ');
    expect(String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39])).toBe('JUNK');
    expect(String.fromCharCode(bytes[64], bytes[65], bytes[66], bytes[67])).toBe('bext');
  });

  it('every field survives the write→parse round trip, including 64-bit sample times', () => {
    const huge = 5_000_000_000; // > 2^32 to prove the i64 split
    const bytes = encodeWaveBytes([ramp(240)], SR, { bitDepth: 24, bwf: { ...meta, timeReferenceSample: huge } });
    const p = parseWave(bytes);
    expect(p.bwf).toBeTruthy();
    const b = p.bwf!;
    expect(b.description).toBe(meta.description);
    expect(b.originator).toBe('UMBRA-SCORE');
    expect(b.originatorReference).toBe('UMBRA-DELIVERY-1/POST.SFX');
    expect(b.originationDate).toBe('2026-09-05');
    expect(b.originationTime).toBe('13:45:02');
    expect(b.timeReferenceSample).toBe(huge);
    expect(b.loudValue).toBe(0); // honestly "not measured", never faked
    expect(b.peakValue).toBe(0);
    expect(b.checksumOk).toBe(true);
    expect(b.codingHistory.length % 180).toBe(0); // 180-char records
    expect(b.codingHistory.startsWith('UMBR : PCM S24 @ 48000 fr/s')).toBe(true);
  });

  it('non-ASCII characters are replaced with ? (fields stay valid 7-bit)', () => {
    const bytes = encodeWaveBytes([ramp(240)], SR, {
      bitDepth: 24,
      bwf: { ...meta, originator: 'UMBRA·SCORE ✕', description: 'Café “Moog” drone' },
    });
    const b = parseWave(bytes).bwf!;
    expect(b.originator).toBe('UMBRA?SCORE ?'); // every non-ASCII → '?'
    expect(b.description.startsWith('Caf?')).toBe(true);
    // field must remain pure printable ASCII regardless of project names
    expect(/^[\x20-\x7e]*$/.test(b.description)).toBe(true);
  });

  it('a corrupted coding history fails its CRC', () => {
    const bytes = encodeWaveBytes([ramp(240)], SR, { bitDepth: 24, bwf: meta });
    // flip a byte inside the history area: a case flip keeps length, breaks CRC
    bytes[64 + 8 + 416] ^= 0x20;
    const p = parseWave(bytes);
    expect(p.bwf!.checksumOk).toBe(false);
  });

  it('crc32 matches the known test vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('blob wrapper', () => {
  it('produces an audio/wav blob of identical size', async () => {
    const bytes = encodeWaveBytes([ramp(960), ramp(960)], SR, { bitDepth: 24 });
    const blob = blobFromWave(bytes);
    expect(blob.size).toBe(bytes.length);
    const back = new Uint8Array(await blob.arrayBuffer());
    expect(back.every((b, i) => b === bytes[i])).toBe(true);
  });
});
