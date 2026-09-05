import { mulberry32 } from './prng';
import { biquad, buildChannel, gainNode, driveCurve, type Channel, type MasterChain } from './dsp';
import { KIND_META, type Layer } from './types';

/* ==================================================================== *
 *  VOICE LIBRARY
 *  Each layer kind builds a dedicated synthesis graph feeding a channel
 *  strip. Sustained kinds run continuously; event kinds schedule
 *  one-shots with full transient design (click → body → tail).
 * ==================================================================== */

export interface Voice {
  ch: Channel;
  update(l: Layer, tension: number, when: number, glide: number): void;
  /** schedule a one-shot; force 0..1 */
  fire?(when: number, force: number, l: Layer): void;
  /** interval in seconds until the next scheduled event */
  interval?(l: Layer, tension: number): number;
  start(when: number): void;
  stop(when: number): void;
  dispose(): void;
}

const MINOR = [0, 3, 7, 10, 14]; // minor-7 add-9 cluster (semitones)

function semi(base: number, n: number) {
  return base * Math.pow(2, n / 12);
}

function ramp(p: AudioParam, v: number, when: number, glide: number) {
  if (glide > 0) p.setTargetAtTime(v, when, glide);
  else p.setValueAtTime(v, when);
}

/** Common channel-strip parameter application. */
function applyStrip(ch: Channel, l: Layer, tension: number, when: number, glide: number) {
  const meta = KIND_META[l.kind];
  const active = l.muted ? 0 : l.gain * meta.trim * (0.72 + tension * 0.5);
  ramp(ch.fader.gain, active, when, glide);
  ramp(ch.pan.pan, l.pan, when, glide);
  ramp(ch.widePan.pan, -l.pan * 0.85, when, glide);
  ramp(ch.wideGain.gain, l.width * 0.55, when, glide);
  const send = l.reverb * (0.35 + tension * 0.3);
  ramp(ch.sendRoom.gain, l.space === 'room' ? send : send * 0.14, when, glide);
  ramp(ch.sendHall.gain, l.space === 'hall' ? send : send * 0.14, when, glide);
  ramp(ch.sendCath.gain, l.space === 'cathedral' ? send : send * 0.1, when, glide);
  ramp(ch.airEq.gain, -2 + l.tone * 8, when, glide);
}

export function buildVoice(m: MasterChain, l: Layer): Voice {
  const ctx = m.ctx;
  const ch = buildChannel(m, l.kind);
  const rnd = mulberry32(l.seed || 1);
  const started: { n: AudioScheduledSourceNode }[] = [];

  const noiseSrc = () => {
    const s = ctx.createBufferSource();
    s.buffer = m.noise;
    s.loop = true;
    return s;
  };

  switch (l.kind) {
    /* -------------------------------------------------- DRONE BED ----- */
    case 'drone': {
      const bus = gainNode(ctx, 1);
      const lp = biquad(ctx, 'lowpass', 800, 2.6);
      const body = biquad(ctx, 'peaking', 180, 1.1, 3);
      const oscs: OscillatorNode[] = [];
      const detunes: OscillatorNode[] = [];
      const lfos: OscillatorNode[] = [];

      MINOR.forEach((iv, i) => {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sawtooth' : 'triangle';
        const det = ctx.createOscillator();
        det.frequency.value = 0.07 + rnd() * 0.13;
        const detAmt = gainNode(ctx, 4 + rnd() * 7);
        det.connect(detAmt);
        detAmt.connect(o.detune);
        const g = gainNode(ctx, (0.26 / (1 + i * 0.35)) * (0.7 + rnd() * 0.6));
        // slow amplitude breathing per partial
        const bre = ctx.createOscillator();
        bre.frequency.value = 0.03 + rnd() * 0.09;
        const breAmt = gainNode(ctx, g.gain.value * 0.55);
        bre.connect(breAmt);
        breAmt.connect(g.gain);
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / MINOR.length) * 1.4 - 0.7;
        o.connect(g);
        g.connect(pan);
        pan.connect(bus);
        oscs.push(o);
        detunes.push(det);
        lfos.push(bre);
        void iv;
      });

      const swell = ctx.createOscillator();
      swell.frequency.value = 0.045;
      const swellAmt = gainNode(ctx, 340);
      swell.connect(swellAmt);
      swellAmt.connect(lp.frequency);
      lfos.push(swell);

      bus.connect(lp);
      lp.connect(body);
      body.connect(ch.input);
      ch.hp.frequency.value = 32;

      return {
        ch,
        update(x, tension, when, glide) {
          const root = 32 + x.tone * 30;
          oscs.forEach((o, i) => ramp(o.frequency, semi(root, MINOR[i]), when, glide));
          ramp(lp.frequency, 240 + x.tone * 1700 + x.intensity * 900 + tension * 500, when, glide);
          ramp(swellAmt.gain, 140 + x.intensity * 520, when, glide);
          ramp(ch.bell.frequency, 260 + x.tone * 900, when, glide);
          ramp(ch.bell.gain, x.intensity * 3.5, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          [...oscs, ...detunes, ...lfos].forEach((o) => {
            o.start(when);
            started.push({ n: o });
          });
        },
        stop(when) {
          started.forEach((s) => {
            try {
              s.n.stop(when);
            } catch {
              /* noop */
            }
          });
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------ SUB PRESSURE ---- */
    case 'sub': {
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      const o2g = gainNode(ctx, 0.4);
      const shape = gainNode(ctx, 0.7);
      const breathe = ctx.createOscillator();
      breathe.frequency.value = 0.09;
      const breatheAmt = gainNode(ctx, 0.3);
      breathe.connect(breatheAmt);
      breatheAmt.connect(shape.gain);
      const lp = biquad(ctx, 'lowpass', 140, 0.8);
      o1.connect(shape);
      o2.connect(o2g);
      o2g.connect(shape);
      shape.connect(lp);
      lp.connect(ch.input);
      ch.hp.frequency.value = 18;

      return {
        ch,
        update(x, tension, when, glide) {
          const f = 24 + x.tone * 26;
          ramp(o1.frequency, f, when, glide);
          ramp(o2.frequency, f * 1.5, when, glide);
          ramp(o2g.gain, 0.16 + x.intensity * 0.4, when, glide);
          ramp(breathe.frequency, 0.04 + x.intensity * 0.4, when, glide);
          ramp(lp.frequency, 90 + x.tone * 120, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          [o1, o2, breathe].forEach((o) => {
            o.start(when);
            started.push({ n: o });
          });
        },
        stop(when) {
          started.forEach((s) => {
            try {
              s.n.stop(when);
            } catch {
              /* noop */
            }
          });
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ---------------------------------------------------- AMBIENCE ---- */
    case 'ambience': {
      const src = noiseSrc();
      const bank: BiquadFilterNode[] = [];
      const bus = gainNode(ctx, 1);
      const freqs = [220, 760, 2400];
      freqs.forEach((f, i) => {
        const bp = biquad(ctx, 'bandpass', f, 0.8 + i * 0.5);
        const g = gainNode(ctx, 0.6 / (1 + i * 0.4));
        const pan = ctx.createStereoPanner();
        pan.pan.value = i === 0 ? 0 : i === 1 ? -0.6 : 0.6;
        src.connect(bp);
        bp.connect(g);
        g.connect(pan);
        pan.connect(bus);
        bank.push(bp);
      });
      const drift = ctx.createOscillator();
      drift.frequency.value = 0.035;
      const driftAmt = gainNode(ctx, 260);
      drift.connect(driftAmt);
      driftAmt.connect(bank[1].frequency);
      bus.connect(ch.input);
      ch.hp.frequency.value = 60;

      return {
        ch,
        update(x, tension, when, glide) {
          ramp(bank[0].frequency, 120 + x.tone * 320, when, glide);
          ramp(bank[1].frequency, 520 + x.tone * 2000, when, glide);
          ramp(bank[2].frequency, 1800 + x.tone * 6000, when, glide);
          ramp(driftAmt.gain, 120 + x.intensity * 700, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          src.start(when);
          drift.start(when);
          started.push({ n: src }, { n: drift });
        },
        stop(when) {
          started.forEach((s) => {
            try {
              s.n.stop(when);
            } catch {
              /* noop */
            }
          });
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------- WHISPER TEXTURE ------ */
    case 'texture': {
      const src = noiseSrc();
      src.playbackRate.value = 0.55;
      const bus = gainNode(ctx, 1);
      // vowel formant bank — reads as breath / whispered voice
      const formants = [
        { f: 620, q: 9, g: 1 },
        { f: 1180, q: 12, g: 0.7 },
        { f: 2600, q: 14, g: 0.42 },
      ].map((v) => {
        const bp = biquad(ctx, 'bandpass', v.f, v.q);
        const g = gainNode(ctx, v.g);
        src.connect(bp);
        bp.connect(g);
        g.connect(bus);
        return bp;
      });
      const vowel = ctx.createOscillator();
      vowel.type = 'triangle';
      vowel.frequency.value = 0.12;
      const vowelAmt = gainNode(ctx, 220);
      vowel.connect(vowelAmt);
      vowelAmt.connect(formants[0].frequency);
      const vowelAmt2 = gainNode(ctx, 420);
      vowel.connect(vowelAmt2);
      vowelAmt2.connect(formants[1].frequency);

      // breath envelope: irregular gate
      const gate = gainNode(ctx, 0.5);
      const breath = ctx.createOscillator();
      breath.type = 'sine';
      breath.frequency.value = 0.32;
      const breathAmt = gainNode(ctx, 0.45);
      breath.connect(breathAmt);
      breathAmt.connect(gate.gain);
      bus.connect(gate);
      gate.connect(ch.input);
      ch.hp.frequency.value = 200;

      return {
        ch,
        update(x, tension, when, glide) {
          ramp(formants[0].frequency, 380 + x.tone * 520, when, glide);
          ramp(formants[1].frequency, 900 + x.tone * 1500, when, glide);
          ramp(formants[2].frequency, 2100 + x.tone * 3200, when, glide);
          ramp(breath.frequency, 0.16 + x.intensity * 0.9, when, glide);
          ramp(src.playbackRate, 0.4 + x.intensity * 0.6, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          [src, vowel, breath].forEach((o) => {
            o.start(when);
            started.push({ n: o });
          });
        },
        stop(when) {
          started.forEach((s) => {
            try {
              s.n.stop(when);
            } catch {
              /* noop */
            }
          });
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------- STRING CLUSTER ------- */
    case 'strings': {
      const bus = gainNode(ctx, 1);
      const oscs: OscillatorNode[] = [];
      const mods: OscillatorNode[] = [];
      const cluster = [0, 1, 6, 7, 13]; // dissonant semitone/tritone stack
      cluster.forEach((iv, i) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        // bow noise via fast tremolo + slight FM
        const trem = ctx.createOscillator();
        trem.type = 'sine';
        trem.frequency.value = 5.4 + rnd() * 2.4;
        const g = gainNode(ctx, 0.14);
        const tremAmt = gainNode(ctx, 0.09);
        trem.connect(tremAmt);
        tremAmt.connect(g.gain);
        const vib = ctx.createOscillator();
        vib.frequency.value = 4.6 + rnd() * 1.6;
        const vibAmt = gainNode(ctx, 7);
        vib.connect(vibAmt);
        vibAmt.connect(o.detune);
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / cluster.length) * 1.5 - 0.75;
        o.connect(g);
        g.connect(pan);
        pan.connect(bus);
        oscs.push(o);
        mods.push(trem, vib);
        void iv;
      });
      // sul ponticello: aggressive bandpass + light drive
      const bp = biquad(ctx, 'bandpass', 1400, 1.1);
      const rasp = ctx.createWaveShaper();
      rasp.curve = driveCurve(0.25);
      rasp.oversample = '2x';
      bus.connect(bp);
      bp.connect(rasp);
      rasp.connect(ch.input);
      ch.hp.frequency.value = 130;

      return {
        ch,
        update(x, tension, when, glide) {
          const root = 150 + x.tone * 210;
          oscs.forEach((o, i) => ramp(o.frequency, semi(root, cluster[i]), when, glide));
          ramp(bp.frequency, 900 + x.tone * 2600 + tension * 700, when, glide);
          ramp(bp.Q, 0.8 + x.intensity * 2.4, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          [...oscs, ...mods].forEach((o) => {
            o.start(when);
            started.push({ n: o });
          });
        },
        stop(when) {
          started.forEach((s) => {
            try {
              s.n.stop(when);
            } catch {
              /* noop */
            }
          });
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------------- FOLEY ---- */
    case 'foley': {
      ch.hp.frequency.value = 90;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x, tension) => 0.22 + Math.random() * (2.1 - x.intensity * 1.2 - tension * 0.4),
        fire(when, force) {
          const atk = 0.001 + cur.attack * 0.02;
          // 1. click transient
          const click = noiseSrc();
          click.playbackRate.value = 1.4 + Math.random();
          const chp = biquad(ctx, 'highpass', 2400 + cur.tone * 3600, 0.8);
          const cg = gainNode(ctx, 0);
          cg.gain.setValueAtTime(0.0001, when);
          cg.gain.exponentialRampToValueAtTime(0.5 * force, when + atk);
          cg.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
          click.connect(chp);
          chp.connect(cg);
          cg.connect(ch.input);
          click.start(when, Math.random() * 3);
          click.stop(when + 0.09);

          // 2. body — resonant band
          const body = noiseSrc();
          body.playbackRate.value = 0.5 + Math.random() * 1.3;
          const bp = biquad(ctx, 'bandpass', 260 + cur.tone * 1600 + Math.random() * 500, 3 + Math.random() * 6);
          const bg = gainNode(ctx, 0);
          const dur = 0.06 + Math.random() * 0.26 + cur.attack * 0.2;
          bg.gain.setValueAtTime(0.0001, when);
          bg.gain.exponentialRampToValueAtTime(0.62 * force, when + atk + 0.004);
          bg.gain.exponentialRampToValueAtTime(0.0001, when + dur);
          body.connect(bp);
          bp.connect(bg);
          bg.connect(ch.input);
          body.start(when, Math.random() * 3);
          body.stop(when + dur + 0.06);

          // 3. low thud for weight
          const th = ctx.createOscillator();
          th.type = 'sine';
          const tg = gainNode(ctx, 0);
          th.frequency.setValueAtTime(120 + Math.random() * 60, when);
          th.frequency.exponentialRampToValueAtTime(48, when + 0.14);
          tg.gain.setValueAtTime(0.0001, when);
          tg.gain.exponentialRampToValueAtTime(0.3 * force, when + 0.008);
          tg.gain.exponentialRampToValueAtTime(0.0001, when + 0.19);
          th.connect(tg);
          tg.connect(ch.input);
          th.start(when);
          th.stop(when + 0.24);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------- HEART PULSE ---- */
    case 'pulse': {
      ch.hp.frequency.value = 22;
      let cur = l;
      const beat = (when: number, amp: number, force: number) => {
        // sub thump
        const o = ctx.createOscillator();
        o.type = 'sine';
        const g = gainNode(ctx, 0);
        const f0 = 66 + cur.tone * 44;
        o.frequency.setValueAtTime(f0, when);
        o.frequency.exponentialRampToValueAtTime(29, when + 0.24);
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(amp * force, when + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.34);
        o.connect(g);
        g.connect(ch.input);
        o.start(when);
        o.stop(when + 0.4);
        // chest resonance — muffled noise slap
        const n = noiseSrc();
        const lp = biquad(ctx, 'lowpass', 340 + cur.tone * 400, 1.6);
        const ng = gainNode(ctx, 0);
        ng.gain.setValueAtTime(0.0001, when);
        ng.gain.exponentialRampToValueAtTime(amp * force * 0.42, when + 0.01);
        ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.15);
        n.connect(lp);
        lp.connect(ng);
        ng.connect(ch.input);
        n.start(when, Math.random() * 3);
        n.stop(when + 0.2);
      };
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x, tension) => 60 / (36 + x.intensity * 54 + tension * 26),
        fire(when, force) {
          beat(when, 0.95, force);
          beat(when + 0.26, 0.52, force);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------------- RISER ---- */
    case 'riser': {
      ch.hp.frequency.value = 70;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 5.5 + Math.random() * 7 - x.intensity * 2.5,
        fire(when, force) {
          const dur = 2.4 + cur.intensity * 2.6;
          const end = when + dur;
          // noise sweep
          const n = noiseSrc();
          const bp = biquad(ctx, 'bandpass', 300, 3.5);
          bp.frequency.setValueAtTime(240, when);
          bp.frequency.exponentialRampToValueAtTime(5200 + cur.tone * 4000, end);
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.42 * force, end - 0.08);
          ng.gain.exponentialRampToValueAtTime(0.0001, end + 0.5);
          n.connect(bp);
          bp.connect(ng);
          ng.connect(ch.input);
          n.start(when, Math.random() * 2);
          n.stop(end + 0.6);
          // shepard-ish pitch swell (3 stacked saws)
          for (let k = 0; k < 3; k++) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            const g = gainNode(ctx, 0);
            const base = 70 * Math.pow(2, k);
            o.frequency.setValueAtTime(base, when);
            o.frequency.exponentialRampToValueAtTime(base * (4 + cur.intensity * 4), end);
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(0.16 * force * (1 - k * 0.22), end - 0.1);
            g.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
            const lp = biquad(ctx, 'lowpass', 4000, 1);
            o.connect(lp);
            lp.connect(g);
            g.connect(ch.input);
            o.start(when);
            o.stop(end + 0.35);
          }
          // resolve: drop into the reverse verb tail
          const drop = ctx.createOscillator();
          drop.type = 'sine';
          const dg = gainNode(ctx, 0);
          drop.frequency.setValueAtTime(120, end);
          drop.frequency.exponentialRampToValueAtTime(30, end + 0.9);
          dg.gain.setValueAtTime(0.0001, end);
          dg.gain.exponentialRampToValueAtTime(0.5 * force, end + 0.02);
          dg.gain.exponentialRampToValueAtTime(0.0001, end + 1.2);
          drop.connect(dg);
          dg.connect(ch.input);
          drop.start(end);
          drop.stop(end + 1.3);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------------ WHOOSH ---- */
    case 'whoosh': {
      ch.hp.frequency.value = 120;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 3.5 + Math.random() * 6 - x.intensity * 2,
        fire(when, force) {
          const dur = 0.7 + Math.random() * 0.9;
          const dir = Math.random() > 0.5 ? 1 : -1;
          const n = noiseSrc();
          n.playbackRate.value = 0.8 + Math.random() * 0.7;
          const bp = biquad(ctx, 'bandpass', 600, 1.4);
          bp.frequency.setValueAtTime(400, when);
          bp.frequency.exponentialRampToValueAtTime(2600 + cur.tone * 3400, when + dur * 0.55);
          bp.frequency.exponentialRampToValueAtTime(320, when + dur);
          const pan = ctx.createStereoPanner();
          pan.pan.setValueAtTime(-dir, when);
          pan.pan.linearRampToValueAtTime(dir, when + dur);
          const g = gainNode(ctx, 0);
          g.gain.setValueAtTime(0.0001, when);
          g.gain.exponentialRampToValueAtTime(0.5 * force, when + dur * 0.5);
          g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.15);
          n.connect(bp);
          bp.connect(pan);
          pan.connect(g);
          g.connect(ch.input);
          n.start(when, Math.random() * 3);
          n.stop(when + dur + 0.25);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------------- BRAAM ---- */
    case 'braam': {
      ch.hp.frequency.value = 45;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 6 + Math.random() * 9 - x.intensity * 3,
        fire(when, force) {
          const dur = 1.8 + cur.intensity * 1.8;
          const root = 46 + cur.tone * 26;
          const rasp = ctx.createWaveShaper();
          rasp.curve = driveCurve(0.4 + cur.intensity * 0.4);
          rasp.oversample = '4x';
          const lp = biquad(ctx, 'lowpass', 900, 1.4);
          lp.frequency.setValueAtTime(500, when);
          lp.frequency.linearRampToValueAtTime(2400 + cur.tone * 1800, when + 0.35);
          lp.frequency.exponentialRampToValueAtTime(420, when + dur);
          rasp.connect(lp);
          lp.connect(ch.input);
          // pre-bloom through the reverse convolver
          const pre = gainNode(ctx, 0.32 * force);
          lp.connect(pre);
          pre.connect(ch.m.reverseVerb);

          [0, 7, 12, 19].forEach((iv, i) => {
            const o = ctx.createOscillator();
            o.type = i % 2 ? 'sawtooth' : 'square';
            o.frequency.setValueAtTime(semi(root, iv) * 0.985, when);
            o.frequency.linearRampToValueAtTime(semi(root, iv), when + 0.5);
            const g = gainNode(ctx, 0);
            const amp = (0.3 / (1 + i * 0.4)) * force;
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(amp, when + 0.12 + cur.attack * 0.2);
            g.gain.setValueAtTime(amp, when + dur * 0.55);
            g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
            o.connect(g);
            g.connect(rasp);
            o.start(when);
            o.stop(when + dur + 0.1);
          });
          // sub underpin
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          const sg = gainNode(ctx, 0);
          sub.frequency.setValueAtTime(root / 2, when);
          sg.gain.setValueAtTime(0.0001, when);
          sg.gain.exponentialRampToValueAtTime(0.55 * force, when + 0.09);
          sg.gain.exponentialRampToValueAtTime(0.0001, when + dur * 1.1);
          sub.connect(sg);
          sg.connect(ch.input);
          sub.start(when);
          sub.stop(when + dur * 1.2);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------------------ IMPACT ---- */
    case 'impact': {
      ch.hp.frequency.value = 18;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 7 + Math.random() * 10 - x.intensity * 3.5,
        fire(when, force) {
          // sub sweep — the theatrical "boom"
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          const sg = gainNode(ctx, 0);
          sub.frequency.setValueAtTime(120, when);
          sub.frequency.exponentialRampToValueAtTime(22, when + 1.1);
          sg.gain.setValueAtTime(0.0001, when);
          sg.gain.exponentialRampToValueAtTime(0.95 * force, when + 0.014);
          sg.gain.exponentialRampToValueAtTime(0.0001, when + 1.9);
          sub.connect(sg);
          sg.connect(ch.input);
          sub.start(when);
          sub.stop(when + 2);

          // distorted mid thwack
          const n = noiseSrc();
          const bp = biquad(ctx, 'bandpass', 420 + cur.tone * 900, 1.1);
          const dist = ctx.createWaveShaper();
          dist.curve = driveCurve(0.55);
          dist.oversample = '4x';
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.6 * force, when + 0.006);
          ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
          n.connect(bp);
          bp.connect(dist);
          dist.connect(ng);
          ng.connect(ch.input);
          n.start(when, Math.random() * 3);
          n.stop(when + 0.7);

          // metallic ring-out
          [1.0, 1.47, 2.09].forEach((r, i) => {
            const o = ctx.createOscillator();
            o.type = 'triangle';
            o.frequency.value = (620 + cur.tone * 900) * r;
            const g = gainNode(ctx, 0);
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(0.1 * force * (1 - i * 0.25), when + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, when + 1.6 + i * 0.4);
            o.connect(g);
            g.connect(ch.input);
            o.start(when);
            o.stop(when + 2.2);
          });
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ----------------------------------------------------- STINGER ---- */
    case 'stinger':
    default: {
      ch.hp.frequency.value = 30;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 4.5 + Math.random() * 8 - x.intensity * 3,
        fire(when, force) {
          // FM metallic crack
          const car = ctx.createOscillator();
          car.type = 'sine';
          const mod = ctx.createOscillator();
          mod.type = 'square';
          const modAmt = gainNode(ctx, 900 + cur.tone * 2600);
          mod.frequency.value = 173 + cur.tone * 420;
          mod.connect(modAmt);
          modAmt.connect(car.frequency);
          car.frequency.setValueAtTime(880 + cur.tone * 700, when);
          const cg = gainNode(ctx, 0);
          cg.gain.setValueAtTime(0.0001, when);
          cg.gain.exponentialRampToValueAtTime(0.34 * force, when + 0.004);
          cg.gain.exponentialRampToValueAtTime(0.0001, when + 0.5 + cur.intensity * 0.6);
          car.connect(cg);
          cg.connect(ch.input);
          car.start(when);
          mod.start(when);
          car.stop(when + 1.4);
          mod.stop(when + 1.4);

          // shriek band of noise
          const n = noiseSrc();
          const hp = biquad(ctx, 'highpass', 900 + cur.tone * 3200, 0.9);
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.4 * force, when + 0.005);
          ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
          n.connect(hp);
          hp.connect(ng);
          ng.connect(ch.input);
          // reverse pre-bloom
          const pre = gainNode(ctx, 0.4 * force);
          hp.connect(pre);
          pre.connect(ch.m.reverseVerb);
          n.start(when, Math.random() * 2);
          n.stop(when + 0.6);

          // sub drop underneath
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          const lp = biquad(ctx, 'lowpass', 1600, 1.2);
          lp.frequency.exponentialRampToValueAtTime(110, when + 0.8);
          const g2 = gainNode(ctx, 0);
          o.frequency.setValueAtTime(260 + cur.tone * 180, when);
          o.frequency.exponentialRampToValueAtTime(34, when + 0.7);
          g2.gain.setValueAtTime(0.0001, when);
          g2.gain.exponentialRampToValueAtTime(0.62 * force, when + 0.018);
          g2.gain.exponentialRampToValueAtTime(0.0001, when + 1.05);
          o.connect(lp);
          lp.connect(g2);
          g2.connect(ch.input);
          o.start(when);
          o.stop(when + 1.2);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }
  }
}
