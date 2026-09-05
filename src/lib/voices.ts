import { mulberry32 } from './prng';
import { biquad, buildChannel, gainNode, driveCurve, BASS_KINDS, type Channel, type MasterChain } from './dsp';
import { KIND_META, type Layer } from './types';

/* ==================================================================== *
 *  VOICE LIBRARY
 *  Each layer kind builds a dedicated synthesis graph feeding a channel
 *  strip. Sustained kinds run continuously; event kinds schedule
 *  one-shots with full transient design (click → body → tail).
 *  Pitched kinds resolve to the scene's musical key (Layer.root).
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

const WIDE = [0, 3, 7, 10, 14, 17, 19, 24]; // extended minor cluster for drone
const OPEN = [0, 7, 12, 16, 19]; // open-fifth pad voicing for choir

function semi(base: number, n: number) {
  return base * Math.pow(2, n / 12);
}

function rootOf(l: Layer): number {
  return l.root || 55;
}

function ramp(p: AudioParam, v: number, when: number, glide: number) {
  if (glide > 0) p.setTargetAtTime(v, when, glide);
  else p.setValueAtTime(v, when);
}

/** Common channel-strip parameter application. */
function applyStrip(ch: Channel, l: Layer, tension: number, when: number, glide: number) {
  const meta = KIND_META[l.kind];
  const active = l.muted ? 0 : l.gain * meta.trim * (0.5 + tension * 0.75);
  ramp(ch.fader.gain, active, when, glide);
  ramp(ch.pan.pan, l.pan, when, glide);
  ramp(ch.widePan.pan, -l.pan * 0.85, when, glide);
  ramp(ch.wideGain.gain, l.width * 0.55, when, glide);
  const send = l.reverb * (0.35 + tension * 0.3);
  ramp(ch.sendRoom.gain, l.space === 'room' ? send : send * 0.14, when, glide);
  ramp(ch.sendHall.gain, l.space === 'hall' ? send : send * 0.14, when, glide);
  ramp(ch.sendCath.gain, l.space === 'cathedral' ? send : send * 0.1, when, glide);
  ramp(ch.airEq.gain, -2 + l.tone * 8, when, glide);
  // LFE tap for bass-heavy kinds
  ramp(ch.subFeed.gain, BASS_KINDS.includes(l.kind) ? l.intensity * 0.4 * (0.4 + tension * 0.5) : 0, when, glide);
}

/** Sidechain the music bed under a hit — theatrical pump. */
function duckFor(m: MasterChain, l: Layer, when: number) {
  const depth = (0.2 + l.intensity * 0.34) * (m.params.ducking * 1.45);
  m.duck(when, Math.min(0.85, depth), 0.006, 0.32);
}

function startAll(nodes: AudioScheduledSourceNode[], started: { n: AudioScheduledSourceNode }[], when: number) {
  nodes.forEach((o) => {
    o.start(when);
    started.push({ n: o });
  });
}

function stopAll(started: { n: AudioScheduledSourceNode }[], when: number) {
  started.forEach((s) => {
    try {
      s.n.stop(when);
    } catch {
      /* noop */
    }
  });
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
      const lp = biquad(ctx, 'lowpass', 900, 2.2);
      const body = biquad(ctx, 'peaking', 180, 1.1, 3.5);
      const oscs: OscillatorNode[] = [];
      const detunes: OscillatorNode[] = [];
      const lfos: OscillatorNode[] = [];

      WIDE.forEach((iv, i) => {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sawtooth' : 'triangle';
        const det = ctx.createOscillator();
        det.frequency.value = 0.05 + rnd() * 0.12;
        const detAmt = gainNode(ctx, 3 + rnd() * 8);
        det.connect(detAmt);
        detAmt.connect(o.detune);
        const g = gainNode(ctx, (0.2 / (1 + i * 0.32)) * (0.75 + rnd() * 0.5));
        // slow amplitude breathing per partial
        const bre = ctx.createOscillator();
        bre.frequency.value = 0.02 + rnd() * 0.08;
        const breAmt = gainNode(ctx, g.gain.value * 0.5);
        bre.connect(breAmt);
        breAmt.connect(g.gain);
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / (WIDE.length - 1)) * 1.5 - 0.75;
        o.connect(g);
        g.connect(pan);
        pan.connect(bus);
        oscs.push(o);
        detunes.push(det);
        lfos.push(bre);
        void iv;
      });

      // sub-octave anchor for weight
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      const subG = gainNode(ctx, 0.5);
      sub.connect(subG);
      subG.connect(bus);
      // airy shimmer partial
      const shimmer = ctx.createOscillator();
      shimmer.type = 'sine';
      const shimmerLp = biquad(ctx, 'lowpass', 6000, 0.7);
      const shimG = gainNode(ctx, 0.1);
      shimmer.connect(shimmerLp);
      shimmerLp.connect(shimG);
      shimG.connect(bus);

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
          const root = rootOf(x);
          oscs.forEach((o, i) => ramp(o.frequency, semi(root, WIDE[i]), when, glide));
          ramp(sub.frequency, root / 2, when, glide);
          ramp(shimmer.frequency, root * 4, when, glide);
          ramp(lp.frequency, 300 + x.tone * 1800 + x.intensity * 800 + tension * 600, when, glide);
          ramp(swellAmt.gain, 140 + x.intensity * 520, when, glide);
          ramp(ch.bell.frequency, 260 + x.tone * 900, when, glide);
          ramp(ch.bell.gain, x.intensity * 3.5, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          startAll([...oscs, ...detunes, ...lfos, sub, shimmer], started, when);
        },
        stop(when) {
          stopAll(started, when);
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
      const o3 = ctx.createOscillator(); // sub-octave
      o3.type = 'triangle';
      const o3g = gainNode(ctx, 0.34);
      const shape = gainNode(ctx, 0.7);
      const breathe = ctx.createOscillator();
      breathe.frequency.value = 0.09;
      const breatheAmt = gainNode(ctx, 0.3);
      breathe.connect(breatheAmt);
      breatheAmt.connect(shape.gain);
      const lp = biquad(ctx, 'lowpass', 150, 0.8);
      o1.connect(shape);
      o2.connect(o2g);
      o2g.connect(shape);
      o3.connect(o3g);
      o3g.connect(shape);
      shape.connect(lp);
      lp.connect(ch.input);
      ch.hp.frequency.value = 18;

      return {
        ch,
        update(x, tension, when, glide) {
          const f = rootOf(x);
          ramp(o1.frequency, f, when, glide);
          ramp(o2.frequency, f * 1.5, when, glide);
          ramp(o3.frequency, f / 2, when, glide);
          ramp(o2g.gain, 0.16 + x.intensity * 0.4, when, glide);
          ramp(o3g.gain, 0.1 + x.intensity * 0.28, when, glide);
          ramp(breathe.frequency, 0.04 + x.intensity * 0.4, when, glide);
          ramp(lp.frequency, 90 + x.tone * 120, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          startAll([o1, o2, o3, breathe], started, when);
        },
        stop(when) {
          stopAll(started, when);
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
      // low rumble + air band
      const rumble = biquad(ctx, 'lowpass', 130, 0.7);
      const rumbleG = gainNode(ctx, 0.5);
      src.connect(rumble);
      rumble.connect(rumbleG);
      rumbleG.connect(bus);
      const air = biquad(ctx, 'highpass', 4200, 0.7);
      const airG = gainNode(ctx, 0.16);
      src.connect(air);
      air.connect(airG);
      airG.connect(bus);

      const drift = ctx.createOscillator();
      drift.frequency.value = 0.035;
      const driftAmt = gainNode(ctx, 260);
      drift.connect(driftAmt);
      driftAmt.connect(bank[1].frequency);
      // slow stereo drift for immersion
      const panDrift = ctx.createOscillator();
      panDrift.frequency.value = 0.02;
      const panAmt = gainNode(ctx, 0.22);
      const panTarget = ctx.createStereoPanner();
      panDrift.connect(panAmt);
      panAmt.connect(panTarget.pan);
      bus.connect(panTarget);
      panTarget.connect(ch.input);
      ch.hp.frequency.value = 60;

      return {
        ch,
        update(x, tension, when, glide) {
          ramp(bank[0].frequency, 120 + x.tone * 320, when, glide);
          ramp(bank[1].frequency, 520 + x.tone * 2000, when, glide);
          ramp(bank[2].frequency, 1800 + x.tone * 6000, when, glide);
          ramp(driftAmt.gain, 120 + x.intensity * 700, when, glide);
          ramp(panAmt.gain, 0.08 + x.width * 0.3, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          startAll([src, drift, panDrift], started, when);
        },
        stop(when) {
          stopAll(started, when);
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
          startAll([src, vowel, breath], started, when);
        },
        stop(when) {
          stopAll(started, when);
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ------------------------------------------- STRING SECTION ------- */
    case 'strings': {
      const bus = gainNode(ctx, 1);
      const oscs: OscillatorNode[] = [];
      const mods: OscillatorNode[] = [];
      const sections = [
        { iv: -12, n: 3, pan: -0.55 },
        { iv: 0, n: 3, pan: -0.22 },
        { iv: 12, n: 3, pan: 0.22 },
        { iv: 24, n: 2, pan: 0.55 },
      ];
      sections.forEach((sec) => {
        const secLp = biquad(ctx, 'lowpass', 4200, 0.8); // bow warmth
        const trem = ctx.createOscillator();
        trem.type = 'sine';
        trem.frequency.value = 4.6 + rnd() * 2.2;
        const tremAmt = gainNode(ctx, 0.1);
        const secG = gainNode(ctx, 0.8);
        trem.connect(tremAmt);
        tremAmt.connect(secG.gain);
        const secPan = ctx.createStereoPanner();
        secPan.pan.value = sec.pan + (rnd() * 0.2 - 0.1);
        secG.connect(secLp);
        secLp.connect(secPan);
        secPan.connect(bus);
        mods.push(trem);
        for (let j = 0; j < sec.n; j++) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.detune.value = (j - (sec.n - 1) / 2) * 7 + (rnd() * 4 - 2);
          const vib = ctx.createOscillator();
          vib.frequency.value = 4.6 + rnd() * 1.6;
          const vibAmt = gainNode(ctx, 7);
          vib.connect(vibAmt);
          vibAmt.connect(o.detune);
          o.connect(secG);
          oscs.push(o);
          mods.push(vib);
        }
      });

      // sul ponticello rasp when intensity climbs
      const bp = biquad(ctx, 'bandpass', 1500, 1.1);
      const rasp = ctx.createWaveShaper();
      rasp.curve = driveCurve(0.25);
      rasp.oversample = '2x';
      const raspMix = gainNode(ctx, 0.35);
      const dry = gainNode(ctx, 0.75);
      bus.connect(bp);
      bp.connect(rasp);
      rasp.connect(raspMix);
      raspMix.connect(ch.input);
      bus.connect(dry);
      dry.connect(ch.input);
      ch.hp.frequency.value = 110;

      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          const root = rootOf(x);
          let k = 0;
          sections.forEach((sec) => {
            for (let j = 0; j < sec.n; j++) ramp(oscs[k++].frequency, semi(root, sec.iv), when, glide);
          });
          ramp(bp.frequency, 1000 + x.tone * 2600 + tension * 700, when, glide);
          ramp(bp.Q, 0.8 + x.intensity * 2.4, when, glide);
          ramp(raspMix.gain, x.intensity * 0.7, when, glide);
          ramp(dry.gain, 1 - x.intensity * 0.4, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x, tension) => 6 + Math.random() * 8 - x.intensity * 3 - tension * 2,
        fire(when, force) {
          // spiccato ostinato stab
          const root = rootOf(cur) * 2;
          [0, 7, 12, 19].forEach((iv, i) => {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.setValueAtTime(semi(root, iv), when);
            const lp = biquad(ctx, 'lowpass', 3200, 0.9);
            const g = gainNode(ctx, 0);
            const amp = (0.16 / (1 + i * 0.3)) * force;
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(amp, when + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
            o.connect(lp);
            lp.connect(g);
            g.connect(ch.input);
            o.start(when);
            o.stop(when + 0.22);
          });
          // bow click
          const n = noiseSrc();
          n.playbackRate.value = 1.6;
          const hp = biquad(ctx, 'highpass', 2600, 0.8);
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.14 * force, when + 0.004);
          ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
          n.connect(hp);
          hp.connect(ng);
          ng.connect(ch.input);
          n.start(when, Math.random() * 3);
          n.stop(when + 0.05);
        },
        start(when) {
          startAll([...oscs, ...mods], started, when);
        },
        stop(when) {
          stopAll(started, when);
        },
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ---------------------------------------------------- CHOIR PAD ---- */
    case 'choir': {
      const bus = gainNode(ctx, 1);
      const oscs: OscillatorNode[] = [];
      const mods: OscillatorNode[] = [];
      OPEN.forEach((iv, i) => {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sawtooth' : 'triangle';
        o.detune.value = (rnd() * 10 - 5);
        const det = ctx.createOscillator();
        det.frequency.value = 0.08 + rnd() * 0.1;
        const detAmt = gainNode(ctx, 5 + rnd() * 6);
        det.connect(detAmt);
        detAmt.connect(o.detune);
        const g = gainNode(ctx, (0.2 / (1 + i * 0.3)) * (0.7 + rnd() * 0.5));
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / (OPEN.length - 1)) * 1.4 - 0.7;
        o.connect(g);
        g.connect(pan);
        pan.connect(bus);
        oscs.push(o);
        mods.push(det);
      });
      // formant bank shapes the airy vowel quality
      const formant = [520, 1100, 2400].map((f) => biquad(ctx, 'bandpass', f, 4));
      const formantGain = gainNode(ctx, 1);
      bus.connect(formant[0]);
      formant[0].connect(formant[1]);
      formant[1].connect(formant[2]);
      formant[2].connect(formantGain);
      const vowel = ctx.createOscillator();
      vowel.frequency.value = 0.06;
      const vowelAmt = gainNode(ctx, 180);
      vowel.connect(vowelAmt);
      vowelAmt.connect(formant[0].frequency);
      const vowelAmt2 = gainNode(ctx, 360);
      vowel.connect(vowelAmt2);
      vowelAmt2.connect(formant[1].frequency);
      const breath = ctx.createOscillator();
      breath.frequency.value = 0.05;
      const breathAmt = gainNode(ctx, 0.25);
      breath.connect(breathAmt);
      breathAmt.connect(formantGain.gain);
      mods.push(vowel, breath);
      formantGain.connect(ch.input);
      ch.hp.frequency.value = 140;

      return {
        ch,
        update(x, tension, when, glide) {
          const root = rootOf(x);
          oscs.forEach((o, i) => ramp(o.frequency, semi(root, OPEN[i]), when, glide));
          ramp(formant[0].frequency, 380 + x.tone * 400, when, glide);
          ramp(formant[1].frequency, 900 + x.tone * 900, when, glide);
          ramp(formant[2].frequency, 2000 + x.tone * 1800, when, glide);
          ramp(vowelAmt.gain, 120 + x.intensity * 320, when, glide);
          applyStrip(ch, x, tension, when, glide);
        },
        start(when) {
          startAll([...oscs, ...mods], started, when);
        },
        stop(when) {
          stopAll(started, when);
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
        const f0 = rootOf(cur) * 1.2;
        o.frequency.setValueAtTime(f0, when);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.45, when + 0.24);
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

    /* --------------------------------------------------- TENSION TICK -- */
    case 'tick': {
      ch.hp.frequency.value = 300;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x, tension) => Math.max(0.09, 1.4 - (x.intensity * 0.85 + tension * 0.8) * 1.4),
        fire(when, force) {
          const o = ctx.createOscillator();
          o.type = 'square';
          o.frequency.setValueAtTime(2100 + cur.tone * 2600, when);
          const bp = biquad(ctx, 'bandpass', 3200 + cur.tone * 3000, 6);
          const g = gainNode(ctx, 0);
          g.gain.setValueAtTime(0.0001, when);
          g.gain.exponentialRampToValueAtTime(0.32 * force, when + 0.002);
          g.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
          o.connect(bp);
          bp.connect(g);
          g.connect(ch.input);
          o.start(when);
          o.stop(when + 0.05);
          // faint mechanical knock
          const k = ctx.createOscillator();
          k.type = 'sine';
          k.frequency.setValueAtTime(260, when);
          k.frequency.exponentialRampToValueAtTime(120, when + 0.03);
          const kg = gainNode(ctx, 0);
          kg.gain.setValueAtTime(0.0001, when);
          kg.gain.exponentialRampToValueAtTime(0.1 * force, when + 0.003);
          kg.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
          k.connect(kg);
          kg.connect(ch.input);
          k.start(when);
          k.stop(when + 0.08);
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
          const base = rootOf(cur);
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
            const b = base * Math.pow(2, k);
            o.frequency.setValueAtTime(b, when);
            o.frequency.exponentialRampToValueAtTime(b * (4 + cur.intensity * 4), end);
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
          drop.frequency.setValueAtTime(base * 2, end);
          drop.frequency.exponentialRampToValueAtTime(base / 2, end + 0.9);
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

    /* --------------------------------------------------- DOWNLIFTER ---- */
    case 'downlifter': {
      ch.hp.frequency.value = 60;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 7 + Math.random() * 9 - x.intensity * 3,
        fire(when, force) {
          const dur = 1.0 + cur.intensity * 1.4;
          const end = when + dur;
          const base = rootOf(cur);
          // pitch fall: stacked saws diving into the sub range
          [1, 1.5, 2].forEach((m, k) => {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            const g = gainNode(ctx, 0);
            o.frequency.setValueAtTime(base * m, when);
            o.frequency.exponentialRampToValueAtTime(base / 4, end);
            const lp = biquad(ctx, 'lowpass', 3000, 1);
            lp.frequency.setValueAtTime(3200, when);
            lp.frequency.exponentialRampToValueAtTime(220, end);
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(0.2 * force * (1 - k * 0.25), when + 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, end + 0.2);
            o.connect(lp);
            lp.connect(g);
            g.connect(ch.input);
            o.start(when);
            o.stop(end + 0.3);
          });
          // noise sweep down
          const n = noiseSrc();
          const bp = biquad(ctx, 'bandpass', 1400, 2);
          bp.frequency.setValueAtTime(3600, when);
          bp.frequency.exponentialRampToValueAtTime(180, end);
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.3 * force, when + 0.1);
          ng.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
          n.connect(bp);
          bp.connect(ng);
          ng.connect(ch.input);
          n.start(when, Math.random() * 2);
          n.stop(end + 0.35);
          // bloom through reverse verb + sub drop landing on the cut
          const pre = gainNode(ctx, 0.3 * force);
          bp.connect(pre);
          pre.connect(ch.m.reverseVerb);
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          const sg = gainNode(ctx, 0);
          sub.frequency.setValueAtTime(base, end);
          sub.frequency.exponentialRampToValueAtTime(base / 3, end + 0.7);
          sg.gain.setValueAtTime(0.0001, end);
          sg.gain.exponentialRampToValueAtTime(0.4 * force, end + 0.02);
          sg.gain.exponentialRampToValueAtTime(0.0001, end + 1.0);
          sub.connect(sg);
          sg.connect(ch.input);
          sub.start(end);
          sub.stop(end + 1.1);
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
          const root = rootOf(cur);
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

          // octave-down doubled partials for mass
          [-12, 0, 7, 12, 19].forEach((iv, i) => {
            const o = ctx.createOscillator();
            o.type = i % 2 ? 'sawtooth' : 'square';
            o.frequency.setValueAtTime(semi(root, iv) * 0.985, when);
            o.frequency.linearRampToValueAtTime(semi(root, iv), when + 0.5);
            const g = gainNode(ctx, 0);
            const amp = (0.28 / (1 + i * 0.4)) * force;
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
          duckFor(ch.m, cur, when);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ---------------------------------------------------- BRASS STAB --- */
    case 'brass': {
      ch.hp.frequency.value = 70;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 3.5 + Math.random() * 7 - x.intensity * 3,
        fire(when, force) {
          const dur = 0.3 + cur.intensity * 0.4;
          const root = rootOf(cur);
          const rasp = ctx.createWaveShaper();
          rasp.curve = driveCurve(0.3 + cur.intensity * 0.5);
          rasp.oversample = '4x';
          const lp = biquad(ctx, 'lowpass', 1800, 1.2);
          lp.frequency.setValueAtTime(900, when);
          lp.frequency.exponentialRampToValueAtTime(3200 + cur.tone * 2200, when + 0.05);
          lp.frequency.exponentialRampToValueAtTime(500, when + dur);
          rasp.connect(lp);
          lp.connect(ch.input);
          [0, 7, 12, 16].forEach((iv, i) => {
            const o = ctx.createOscillator();
            o.type = i % 2 ? 'sawtooth' : 'square';
            // marcato pitch-dip attack
            o.frequency.setValueAtTime(semi(root, iv) * 0.94, when);
            o.frequency.exponentialRampToValueAtTime(semi(root, iv), when + 0.03);
            const g = gainNode(ctx, 0);
            const amp = (0.24 / (1 + i * 0.35)) * force;
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(amp, when + 0.012);
            g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
            o.connect(g);
            g.connect(rasp);
            o.start(when);
            o.stop(when + dur + 0.1);
          });
          // sub weight
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          const sg = gainNode(ctx, 0);
          sub.frequency.setValueAtTime(root / 2, when);
          sg.gain.setValueAtTime(0.0001, when);
          sg.gain.exponentialRampToValueAtTime(0.35 * force, when + 0.02);
          sg.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.1);
          sub.connect(sg);
          sg.connect(ch.input);
          sub.start(when);
          sub.stop(when + dur + 0.2);
          duckFor(ch.m, cur, when);
        },
        start() {},
        stop() {},
        dispose() {
          ch.dispose();
        },
      };
    }

    /* ---------------------------------------------------- PERCUSSION --- */
    case 'percussion': {
      ch.hp.frequency.value = 30;
      let cur = l;
      return {
        ch,
        update(x, tension, when, glide) {
          cur = x;
          applyStrip(ch, x, tension, when, glide);
        },
        interval: (x) => 2.2 + Math.random() * 5 - x.intensity * 2,
        fire(when, force) {
          const root = rootOf(cur);
          // deep taiko thump — pitch drop with long resonance
          const o = ctx.createOscillator();
          o.type = 'sine';
          const og = gainNode(ctx, 0);
          o.frequency.setValueAtTime(root * 1.4, when);
          o.frequency.exponentialRampToValueAtTime(root * 0.6, when + 0.5);
          og.gain.setValueAtTime(0.0001, when);
          og.gain.exponentialRampToValueAtTime(0.8 * force, when + 0.01);
          og.gain.exponentialRampToValueAtTime(0.0001, when + 0.9);
          o.connect(og);
          og.connect(ch.input);
          o.start(when);
          o.stop(when + 1.0);
          // skin slap — noise body
          const n = noiseSrc();
          n.playbackRate.value = 0.7 + Math.random() * 0.5;
          const lp = biquad(ctx, 'lowpass', 420 + cur.tone * 500, 1.4);
          const ng = gainNode(ctx, 0);
          ng.gain.setValueAtTime(0.0001, when);
          ng.gain.exponentialRampToValueAtTime(0.5 * force, when + 0.006);
          ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
          n.connect(lp);
          lp.connect(ng);
          ng.connect(ch.input);
          n.start(when, Math.random() * 3);
          n.stop(when + 0.4);
          // rim crack
          const r = noiseSrc();
          r.playbackRate.value = 1.5 + Math.random();
          const hp = biquad(ctx, 'highpass', 2600, 0.8);
          const rg = gainNode(ctx, 0);
          rg.gain.setValueAtTime(0.0001, when);
          rg.gain.exponentialRampToValueAtTime(0.28 * force, when + 0.003);
          rg.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
          r.connect(hp);
          hp.connect(rg);
          rg.connect(ch.input);
          r.start(when, Math.random() * 3);
          r.stop(when + 0.08);
          duckFor(ch.m, cur, when);
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
          const root = rootOf(cur);
          // pre-thud — tiny anticipatory knock
          const th = ctx.createOscillator();
          th.type = 'sine';
          const thg = gainNode(ctx, 0);
          th.frequency.setValueAtTime(root * 2, when);
          th.frequency.exponentialRampToValueAtTime(root, when + 0.05);
          thg.gain.setValueAtTime(0.0001, when);
          thg.gain.exponentialRampToValueAtTime(0.25 * force, when + 0.004);
          thg.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
          th.connect(thg);
          thg.connect(ch.input);
          th.start(when);
          th.stop(when + 0.12);
          // sub sweep — the theatrical "boom"
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          const sg = gainNode(ctx, 0);
          sub.frequency.setValueAtTime(root * 1.6, when);
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
          // air burst — high splash
          const airN = noiseSrc();
          airN.playbackRate.value = 1.8;
          const airHp = biquad(ctx, 'highpass', 5000 + cur.tone * 3000, 0.8);
          const airG = gainNode(ctx, 0);
          airG.gain.setValueAtTime(0.0001, when);
          airG.gain.exponentialRampToValueAtTime(0.22 * force, when + 0.004);
          airG.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
          airN.connect(airHp);
          airHp.connect(airG);
          airG.connect(ch.input);
          airN.start(when, Math.random() * 2);
          airN.stop(when + 0.3);
          // metallic ring-out (inharmonic)
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
          duckFor(ch.m, cur, when);
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
          const root = rootOf(cur);
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
          o.frequency.setValueAtTime(root * 1.8, when);
          o.frequency.exponentialRampToValueAtTime(root * 0.5, when + 0.7);
          g2.gain.setValueAtTime(0.0001, when);
          g2.gain.exponentialRampToValueAtTime(0.62 * force, when + 0.018);
          g2.gain.exponentialRampToValueAtTime(0.0001, when + 1.05);
          o.connect(lp);
          lp.connect(g2);
          g2.connect(ch.input);
          o.start(when);
          o.stop(when + 1.2);
          duckFor(ch.m, cur, when);
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
