/* ==================================================================== *
 *  UMBRA · RETRIEVED CLIP AUDIO (live + offline)  —  LEGACY
 *
 *  Superseded by the unified path: src/lib/clips.ts `scheduleClip` is the
 *  single graph shared by the live monitor and the offline bounce and now
 *  applies clip.transform itself. This module's voice builder was the first
 *  TransformSpec implementation but nothing imports it any more
 *  (makeClipScheduler/pollClips/buildClipVoice have no callers); keep it
 *  only as the reference implementation until the transform semantics are
 *  fully covered by tests, then delete it.
 *
 *  NONDESTRUCTIVE: the original blob in the cache is never modified.
 *  Reverse and crossfade-loop use derived in-memory buffers only.
 * ==================================================================== */

import { biquad, buildChannel, dbToGain, gainNode, type Channel, type MasterChain } from '../dsp';
import type { SoundClip } from './types';
import { isBedRole } from './types';

export interface ClipVoice {
  ch: Channel;
  start(when: number): void;
  stop(when: number): void;
  dispose(): void;
}

/* ---------------------------------------------- derived buffers ----- */

const derived = new Map<string, AudioBuffer>();

/** Loop-splice a buffer: tail crossfades into the head (seamless-ish). */
export function crossfadeLoopBuffer(ctx: BaseAudioContext, src: AudioBuffer, crossfadeSec = 0.5): AudioBuffer {
  const key = `${src.sampleRate}:${src.length}:${crossfadeSec}`;
  const hit = derived.get(key);
  if (hit && hit.sampleRate === ctx.sampleRate) return hit;
  const xf = Math.min(src.length - 1, Math.floor(ctx.sampleRate * crossfadeSec));
  const len = src.length;
  const out = ctx.createBuffer(src.numberOfChannels, len, ctx.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const inD = src.getChannelData(c);
    const outD = out.getChannelData(c);
    outD.set(inD);
    // overlap-add the tail into the head with an equal-power fade
    for (let i = 0; i < xf; i++) {
      const t = i / xf; // 0..1
      const tailIn = inD[len - xf + i];
      const headOut = outD[i] * Math.sin((Math.PI / 2) * t);
      outD[i] = headOut + tailIn * Math.cos((Math.PI / 2) * t);
    }
  }
  derived.set(key, out);
  return out;
}

/** Time-reversed copy (source asset is untouched). */
export function reversedBuffer(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  const key = `rev:${src.sampleRate}:${src.length}:${src.numberOfChannels}`;
  const hit = derived.get(key);
  if (hit && hit.sampleRate === ctx.sampleRate) return hit;
  const out = ctx.createBuffer(src.numberOfChannels, src.length, ctx.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const d = src.getChannelData(c);
    const o = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) o[i] = d[d.length - 1 - i];
  }
  derived.set(key, out);
  return out;
}

/* ---------------------------------------------- clip voice graph ---- */

export function buildClipVoice(m: MasterChain, clip: SoundClip, buffer: AudioBuffer): ClipVoice {
  const ctx = m.ctx;
  const ch = buildChannel(m, 'foley'); // clip channel routing below
  const bed = isBedRole(clip.role);

  // routing: beds sit on the ducked music bus so hits can pump around them;
  // events ride the un-ducked hit bus. We re-wire the fader outputs because
  // buildChannel already connected them to the music bus per kind.
  ch.fader.disconnect();
  ch.fader.connect(ch.meter);
  ch.fader.connect(bed ? m.musicSum : m.hitSum);
  ch.fader.connect(ch.sendRoom);
  ch.fader.connect(ch.sendHall);
  ch.fader.connect(ch.sendCath);
  ch.fader.connect(ch.subFeed);
  if (clip.role === 'RUMBLE' || clip.role === 'DRONE') {
    ch.subFeed.gain.value = 0.35;
  }

  const src = ctx.createBufferSource();
  let base = buffer;
  if (clip.transform.reverse) base = reversedBuffer(ctx, buffer);
  src.buffer = base;

  // pitch via detune on the source; rate separately so they are independent
  src.playbackRate.value = clip.transform.playbackRate || 1;
  src.detune.value = clip.transform.pitch * 100;

  const gate = gainNode(ctx, 1); // fade automation lands here
  src.connect(gate);

  // transform filters: gate → hp? → lp? → ch.input (linear chain)
  const lp = clip.transform.lowpassHz ? biquad(ctx, 'lowpass', clip.transform.lowpassHz, 0.9) : null;
  const hp = clip.transform.highpassHz ? biquad(ctx, 'highpass', clip.transform.highpassHz, 0.8) : null;
  const head = lp ?? hp ?? gate;
  let tailIn: AudioNode = gate;
  if (hp) {
    gate.connect(hp);
    tailIn = hp;
  }
  if (lp) {
    tailIn.connect(lp);
    tailIn = lp;
  }
  tailIn.connect(ch.input);
  void head;

  // slow amplitude breathing for transformed horror beds
  let lfo: OscillatorNode | null = null;
  let lfoAmt: GainNode | null = null;
  if (clip.transform.slowModulate > 0) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = 0.032 + clip.transform.slowModulate * 0.09;
    lfoAmt = gainNode(ctx, clip.transform.slowModulate * 0.22);
    lfo.connect(lfoAmt);
    lfoAmt.connect(ch.fader.gain);
  }

  // loop: when loop is set, sources run indefinitely and the clip length is
  // the timeline span; non-loop sources stop at (clip duration)/rate.
  src.loop = clip.transform.loop;
  if (clip.transform.loop && clip.transform.crossfadeLoop) {
    src.buffer = crossfadeLoopBuffer(ctx, base, 0.5);
  }

  const start = (when: number) => {
    const projectDur = (clip.end - clip.start) / Math.max(0.05, clip.transform.playbackRate || 1);
    if (!clip.transform.loop) {
      // trim: play from clip.offset, and limit to the timeline span
      const avail = base.duration - clip.offset;
      const want = projectDur;
      const dur = Math.max(0.02, Math.min(avail, want));
      src.start(when, clip.offset, dur);
    } else {
      src.start(when, clip.offset);
      src.stop(when + projectDur);
    }
    if (lfo) lfo.start(when);
    // fades on the gate; total fader from gain/gainDb lands on the strip
    const target = Math.max(0.00001, clip.gain * dbToGain(clip.transform.gainDb));
    const g = gate.gain;
    const fIn = Math.min(Math.max(0.001, clip.fadeIn), projectDur / 2);
    const fOut = Math.min(Math.max(0.001, clip.fadeOut), projectDur / 2);
    g.cancelScheduledValues(when);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(1, when + fIn);
    if (fOut > 0.02) {
      g.setValueAtTime(1, Math.max(when + fIn, when + projectDur - fOut));
      g.linearRampToValueAtTime(0, when + projectDur);
    }
    ch.pan.pan.value = clip.pan;
    ch.fader.gain.setValueAtTime(target, when);
    // reverb send driven by transform + clip role default
    const send = clip.transform.reverb > 0 ? clip.transform.reverb * 0.8 : clip.role === 'ROOM_TONE' || clip.role === 'DRONE' ? 0.3 : 0.08;
    ch.sendRoom.gain.value = send * 0.7;
    ch.sendHall.gain.value = send * 0.4;
    ch.sendCath.gain.value = send * 0.25;
    // keep the strip filters at neutral for retrieved material unless used
    ch.hp.frequency.value = 20;
  };

  const stop = (when: number) => {
    try {
      src.stop(when);
    } catch {
      /* already stopped */
    }
    if (lfo) lfo.stop(when);
    ch.fader.gain.cancelScheduledValues(when);
    ch.fader.gain.setTargetAtTime(0, when, 0.05);
  };

  return {
    ch,
    start,
    stop,
    dispose() {
      ch.dispose();
      try {
        src.disconnect();
        gate.disconnect();
      } catch {
        /* noop */
      }
    },
  };
}

/* --------------------------------------- timeline-aware scheduling -- */

export interface ClipScheduleState {
  /** project time → ctx time mapping for the current start() */
  ctxBase: number;
  projectBase: number;
  scheduled: Set<string>;
  active: Map<string, ClipVoice>;
}

export function makeClipScheduler(): ClipScheduleState {
  return { ctxBase: 0, projectBase: 0, scheduled: new Set(), active: new Map() };
}

/**
 * Schedule any clip whose start falls inside [projectTime, projectTime+horizon].
 * Call every animation frame while playing. Idempotent per clip.
 */
export function pollClips(
  st: ClipScheduleState,
  m: MasterChain,
  clips: SoundClip[],
  buffers: Map<string, AudioBuffer>,
  projectTime: number,
  horizon = 0.5,
) {
  const now = m.ctx.currentTime;
  // rebase whenever the project time jumps (seek / restart)
  if (Math.abs(projectTime - (st.projectBase + (now - st.ctxBase))) > 0.3 && st.scheduled.size) {
    // transport seek: drop everything and reschedule from scratch
    for (const [, v] of st.active) {
      try {
        v.stop(now);
        v.dispose();
      } catch {
        /* noop */
      }
    }
    st.active.clear();
    st.scheduled.clear();
  }
  st.ctxBase = now;
  st.projectBase = projectTime;
  for (const clip of clips) {
    if (clip.muted || st.scheduled.has(clip.id)) continue;
    const when = now + (clip.start - projectTime);
    if (when > now + horizon) continue;
    if (when + (clip.end - clip.start) < now - 0.1) {
      st.scheduled.add(clip.id); // fell behind (seek) — don't spam
      continue;
    }
    const buf = buffers.get(clip.cacheKey);
    if (!buf) continue;
    try {
      const v = buildClipVoice(m, clip, buf);
      v.start(Math.max(now + 0.01, when));
      st.active.set(clip.id, v);
      st.scheduled.add(clip.id);
    } catch {
      /* audio decode race — skip this frame */
    }
  }
  // retire finished voices
  for (const [id, v] of st.active) {
    const clip = clips.find((c) => c.id === id);
    if (!clip) continue;
    const endCtx = now + (clip.end - projectTime);
    if (endCtx < now) {
      try {
        v.stop(now);
        v.dispose();
      } catch {
        /* noop */
      }
    }
    st.active.delete(id);
  }
}

export function clearClipScheduler(st: ClipScheduleState) {
  for (const [, v] of st.active) {
    try {
      v.dispose();
    } catch {
      /* noop */
    }
  }
  st.active.clear();
  st.scheduled.clear();
}
