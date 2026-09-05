/* ==================================================================== *
 *  REALTIME MONITOR ENGINE (ScoreEngine)
 *
 *  Owns:
 *    live Web Audio playback — procedural voices + scheduled AudioClips
 *    through the shared master chain (dsp.ts), transport sync, metering.
 *
 *  Does not own:
 *    project state (useStudio.ts) · offline bounce (render.ts) ·
 *    clip decode/scheduling primitives (clips.ts) · inference (backend).
 *
 *  Invariant:
 *    the monitor and the offline renderer build the SAME graph from the
 *    same dsp.ts primitives, so what you hear is what gets exported.
 * ==================================================================== */

import { buildMaster, DEFAULT_MASTER, f32, type MasterChain, type MasterParams } from './dsp';
import { buildVoice, type Voice } from './voices';
import { clipEnd, loadClipBuffer, scheduleClip, type ClipVoice } from './clips';
import { KIND_META, type AudioClip, type Layer } from './types';

export type { MasterParams };
export { DEFAULT_MASTER };

interface Live {
  voice: Voice;
  layer: Layer;
  nextEvent: number;
}

/** A generated clip currently sounding in the monitor. */
interface LiveClip {
  voice: ClipVoice;
  clip: AudioClip;
  /** transport position this clip was scheduled against */
  scheduledAt: number;
}

/**
 * Realtime monitoring engine. Keeps a pool of voices matching the active
 * scene, drives event scheduling with lookahead, and exposes metering.
 * Unified for procedural + generative + library clips.
 */
export class ScoreEngine {
  ctx: AudioContext | null = null;
  private decodeCtx: OfflineAudioContext | null = null;
  master: MasterChain | null = null;
  private live = new Map<string, Live>();
  private liveClips = new Map<string, LiveClip>();
  private clipBuffers = new Map<string, AudioBuffer>();
  private raf = 0;
  private running = false;
  private params: MasterParams = { ...DEFAULT_MASTER };
  private tension = 0.5;
  private specBuf = new Uint8Array(new ArrayBuffer(256));
  private loudBuf = f32(2048);
  private lufs = -60;

  ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive', sampleRate: 48000 });
    this.ctx = ctx;
    this.master = buildMaster(ctx, this.params, 'live');
    this.specBuf = new Uint8Array(new ArrayBuffer(this.master.spec.frequencyBinCount));
    this.loudBuf = f32(this.master.loud.fftSize);
    return ctx;
  }

  /** Compatibility accessor for legacy library clip scheduler */
  getMasterNode(): MasterChain {
    this.ensure();
    return this.master!;
  }

  /**
   * A decode-only context for drawing waveforms. Uses the live context when it
   * already exists, otherwise a throwaway offline one so we never trip the
   * browser's autoplay policy just to draw a clip.
   */
  peakContext(): BaseAudioContext {
    if (this.ctx) return this.ctx;
    if (!this.decodeCtx) this.decodeCtx = new OfflineAudioContext(2, 1, 48000);
    return this.decodeCtx;
  }

  setMaster(p: Partial<MasterParams>) {
    Object.assign(this.params, p);
    if (this.master && this.ctx) this.master.setParams(p, this.ctx.currentTime, 0.05);
  }

  getMaster(): MasterParams {
    return { ...this.params };
  }

  setTension(t: number) {
    this.tension = t;
    if (!this.master || !this.ctx) return;
    const g = 0.34 + t * 0.92;
    this.master.dynamics.gain.setTargetAtTime(g, this.ctx.currentTime, 0.6);
  }

  spectrum(): Uint8Array {
    if (this.master && this.running) this.master.spec.getByteFrequencyData(this.specBuf);
    else this.specBuf.fill(0);
    return this.specBuf;
  }

  /** Approximate short-term loudness in LUFS. */
  loudness(): number {
    if (!this.master || !this.running) {
      this.lufs = this.lufs * 0.9 + -60 * 0.1;
      return this.lufs;
    }
    this.master.loud.getFloatTimeDomainData(this.loudBuf);
    let sum = 0;
    for (let i = 0; i < this.loudBuf.length; i++) sum += this.loudBuf[i] * this.loudBuf[i];
    const rms = Math.sqrt(sum / this.loudBuf.length);
    const v = rms > 1e-6 ? 20 * Math.log10(rms) - 0.7 : -60;
    this.lufs = this.lufs * 0.82 + Math.max(-60, v) * 0.18;
    return this.lufs;
  }

  level(id: string): number {
    const l = this.live.get(id);
    if (!l || !this.running) return 0;
    const ch = l.voice.ch;
    ch.meter.getFloatTimeDomainData(ch.meterBuf);
    let peak = 0;
    for (let i = 0; i < ch.meterBuf.length; i++) peak = Math.max(peak, Math.abs(ch.meterBuf[i]));
    return Math.min(1, peak * 2.6);
  }

  isRunning() {
    return this.running;
  }

  /* ------------------------------------------------------------------ */

  private sync(layers: Layer[]) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const keep = new Set(layers.map((l) => l.id));
    for (const [id, l] of this.live) {
      if (!keep.has(id)) {
        try {
          l.voice.ch.fader.gain.setTargetAtTime(0, now, 0.05);
          l.voice.stop(now + 0.3);
          window.setTimeout(() => l.voice.dispose(), 500);
        } catch {
          /* noop */
        }
        this.live.delete(id);
      }
    }
    const anySolo = layers.some((x) => x.solo);
    for (const layer of layers) {
      const effective: Layer = { ...layer, muted: layer.muted || (anySolo && !layer.solo) };
      let entry = this.live.get(layer.id);
      if (!entry) {
        const voice = buildVoice(this.master, effective);
        voice.update(effective, this.tension, now, 0);
        voice.ch.fader.gain.setValueAtTime(0, now);
        voice.start(now + 0.02);
        entry = { voice, layer: effective, nextEvent: now + 0.25 + Math.random() * 0.6 };
        this.live.set(layer.id, entry);
        voice.update(effective, this.tension, now + 0.03, 0.35);
      } else {
        entry.layer = effective;
        entry.voice.update(effective, this.tension, now, 0.12);
      }
    }
  }

  /* ------------------------------------------------- generated clip audio */

  async prepareClip(clip: AudioClip): Promise<AudioBuffer> {
    const ctx = this.ensure();
    const buf = await loadClipBuffer(ctx, clip.url);
    this.clipBuffers.set(clip.audioId, buf);
    // also store by cacheKey for library clips that use cacheKey as identifier
    if (clip.cacheKey) this.clipBuffers.set(clip.cacheKey, buf);
    return buf;
  }

  // Library compat: prepare from raw AudioBuffer (already decoded)
  prepareBuffer(key: string, buf: AudioBuffer): void {
    this.clipBuffers.set(key, buf);
  }

  hasClipBuffer(key: string): boolean {
    return this.clipBuffers.has(key);
  }

  getClipBuffer(key: string): AudioBuffer | undefined {
    return this.clipBuffers.get(key);
  }

  private syncClips(clips: AudioClip[], time: number) {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const anySolo = clips.some((c) => c.solo);
    const shouldPlay = new Map<string, AudioClip>();
    for (const clip of clips) {
      const silent = clip.muted || (anySolo && !clip.solo);
      if (silent) continue;
      if (time >= clip.start && time < clipEnd(clip) - 0.02) shouldPlay.set(clip.id, clip);
    }
    for (const [id, entry] of this.liveClips) {
      const next = shouldPlay.get(id);
      const changed =
        !next ||
        next.offset !== entry.clip.offset ||
        next.duration !== entry.clip.duration ||
        next.start !== entry.clip.start ||
        next.audioId !== entry.clip.audioId;
      if (changed) {
        entry.voice.stop(now);
        const v = entry.voice;
        window.setTimeout(() => v.dispose(), 400);
        this.liveClips.delete(id);
      }
    }
    for (const [id, clip] of shouldPlay) {
      if (this.liveClips.has(id)) {
        const entry = this.liveClips.get(id)!;
        entry.voice.fader.gain.setTargetAtTime(Math.max(0, clip.gain), now, 0.05);
        entry.clip = clip;
        continue;
      }
      // library clips may be keyed by cacheKey rather than audioId
      const buffer = this.clipBuffers.get(clip.audioId) ?? (clip.cacheKey ? this.clipBuffers.get(clip.cacheKey) : undefined);
      if (!buffer) continue;
      const into = Math.max(0, time - clip.start);
      const remaining = clip.duration - into;
      if (remaining <= 0.05) continue;
      // For library clips with complex transforms, we still use the simple
      // scheduleClip path — the transform filters are applied at generation
      // time via offline rendering or via the library's own derived buffers
      // when needed. Keeping one path avoids duplicating voice graphs.
      const voice = scheduleClip(this.master, clip, buffer, {
        at: now + 0.02,
        offset: clip.offset + into,
        duration: remaining,
      });
      this.liveClips.set(id, { voice, clip, scheduledAt: time });
    }
  }

  private stopClips() {
    if (!this.ctx) {
      this.liveClips.clear();
      return;
    }
    const now = this.ctx.currentTime;
    for (const [, entry] of this.liveClips) {
      entry.voice.stop(now);
      const v = entry.voice;
      window.setTimeout(() => v.dispose(), 400);
    }
    this.liveClips.clear();
  }

  start(layers: Layer[], clips: AudioClip[] = [], time = 0) {
    const ctx = this.ensure();
    void ctx.resume();
    this.running = true;
    this.sync(layers);
    this.syncClips(clips, time);
    this.loop();
  }

  update(layers: Layer[], clips: AudioClip[] = [], time = 0) {
    if (!this.running) return;
    this.sync(layers);
    this.syncClips(clips, time);
  }

  tickClips(clips: AudioClip[], time: number) {
    if (!this.running) return;
    this.syncClips(clips, time);
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.running || !this.ctx) return;
      const now = this.ctx.currentTime;
      const horizon = now + 0.4;
      for (const entry of this.live.values()) {
        const { voice, layer } = entry;
        if (!voice.fire || !voice.interval) continue;
        if (layer.muted) {
          entry.nextEvent = Math.max(entry.nextEvent, now + 0.3);
          continue;
        }
        let guard = 0;
        while (entry.nextEvent < horizon && guard++ < 8) {
          const at = Math.max(entry.nextEvent, now + 0.03);
          voice.fire(at, 0.42 + layer.intensity * 0.58, layer);
          entry.nextEvent = at + voice.interval(layer, this.tension);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Listen to a buffer through the master graph — used for library previews */
  auditionBuffer(buffer: AudioBuffer, duration = 3) {
    const ctx = this.ensure();
    void ctx.resume();
    const master = this.master!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.9, now + 0.03);
    g.gain.setValueAtTime(0.9, now + Math.max(0.05, duration - 0.25));
    g.gain.linearRampToValueAtTime(0, now + Math.max(0.3, duration));
    src.connect(g);
    g.connect(master.musicSum);
    src.start(now);
    src.stop(now + Math.max(0.35, duration + 0.1));
    if (!this.running) {
      this.running = true;
      this.loop();
      window.setTimeout(() => {
        if (this.live.size === 0) this.running = false;
      }, (duration + 1.5) * 1000);
    }
  }

  /** Short solo audition of one layer, independent of the transport. */
  audition(layer: Layer) {
    const ctx = this.ensure();
    void ctx.resume();
    const master = this.master!;
    const now = ctx.currentTime;
    const voice = buildVoice(master, layer);
    const clean: Layer = { ...layer, muted: false, solo: false };
    voice.update(clean, 0.75, now, 0);
    voice.start(now + 0.02);
    const meta = KIND_META[layer.kind];
    const dur = meta.event ? 3.4 : 3.0;
    if (voice.fire) {
      voice.fire(now + 0.08, 0.9, clean);
      if (voice.interval) {
        let t = now + 0.08 + voice.interval(clean, 0.75);
        let guard = 0;
        while (t < now + dur - 0.4 && guard++ < 24) {
          voice.fire(t, 0.75, clean);
          t += voice.interval(clean, 0.75);
        }
      }
    }
    voice.ch.fader.gain.setTargetAtTime(0, now + dur, 0.28);
    window.setTimeout(() => {
      try {
        voice.stop(ctx.currentTime);
        voice.dispose();
      } catch {
        /* noop */
      }
    }, (dur + 1.6) * 1000);
    if (!this.running) {
      this.running = true;
      this.loop();
      window.setTimeout(() => {
        if (this.live.size === 0) this.running = false;
      }, (dur + 1.8) * 1000);
    }
  }

  stop() {
    this.stopClips();
    if (!this.ctx) {
      this.running = false;
      return;
    }
    const now = this.ctx.currentTime;
    for (const [, l] of this.live) {
      try {
        l.voice.ch.fader.gain.setTargetAtTime(0, now, 0.06);
        l.voice.stop(now + 0.35);
        const v = l.voice;
        window.setTimeout(() => v.dispose(), 600);
      } catch {
        /* noop */
      }
    }
    this.live.clear();
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

export const engine = new ScoreEngine();
