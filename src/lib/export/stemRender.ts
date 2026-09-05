/* ==================================================================== *
 *  STEM RENDER — executes a StemPassPlan through the REAL graph
 *
 *  No second audio engine: this file builds the same master chain
 *  (dsp.ts buildMaster), schedules procedural voices with the same
 *  schedule() used by renderScore, and places clips with the same
 *  scheduleClip() used by the live monitor. The only differences per pass:
 *
 *    • which sources are scheduled (the pass's layer/clip membership),
 *    • masterFx: stems run the linear stages, the master runs the full chain,
 *    • subOut: the nonlinear sub-chain output belongs to SUB_LFE /
 *      PROCEDURAL / MASTER+REF passes only, so its energy is counted once,
 *    • loudnessConform: MASTER only, ever.
 *
 *  Placement values come from the plan's SAMPLE numbers (clock.ts) and are
 *  converted to seconds by exact division, so every pass — and the manifest
 *  — agree on where material starts, to the sample.
 * ==================================================================== */

import { buildMaster, type MasterParams } from '../dsp';
import { loadClipBuffer, scheduleClip } from '../clips';
import { finalizeMaster, measureLufs, schedule, TARGET_LUFS } from '../render';
import { sampleToSec } from './clock';
import type { DeliveryPlan, PassLayerRef, StemPassPlan } from './stemPlan';

export interface PassRenderResult {
  /** interleaved-free stereo channels, exactly pass.frameCount long */
  L: Float32Array;
  R: Float32Array;
  peakDb: number;
  lufs: number;
  clipsPlaced: number;
  /** names of clips whose audio could not be decoded — reported, never hidden */
  clipsFailed: string[];
}

function offlineCtx(channels: number, frames: number, sampleRate: number): OfflineAudioContext {
  const Ctor: typeof OfflineAudioContext =
    (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ||
    (globalThis as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext unavailable — stem rendering requires a browser runtime');
  return new Ctor(channels, frames, sampleRate);
}

const layerKey = (sceneId: string, layerId: string) => `${sceneId}/${layerId}`;

/**
 * Render one delivery pass to stereo Float32 audio.
 *
 * `pass.frameCount` governs the OfflineAudioContext length directly — so the
 * file is deterministically sized, identically for every stem, and the DAW
 * import-at-zero workflow is exact.
 */
export async function renderPassWebAudio(
  plan: DeliveryPlan,
  pass: StemPassPlan,
  masterParams: MasterParams,
): Promise<PassRenderResult> {
  const sr = plan.clock.sampleRate;
  const frames = pass.frameCount;
  if (frames <= 0) throw new Error(`pass ${pass.id} has zero frames`);

  const ctx = offlineCtx(2, frames, sr);
  const master = buildMaster(ctx, masterParams, 'render', { masterFx: pass.masterFx });

  // sub-chain ownership gate — see ADR-0005
  master.subOut.gain.value = pass.subOut ? 1 : 0;

  /* ---- procedural voices: identical scheduling code to the master bounce -- */
  const layerFlags = new Map<string, PassLayerRef>();
  for (const l of pass.layers) layerFlags.set(layerKey(l.sceneId, l.layerId), l);
  const pictureSeconds = plan.pictureEnd;

  schedule(ctx, master, plan.scenes, pictureSeconds, {
    includeLayer: (scene, layer) => layerFlags.has(layerKey(scene.id, layer.id)),
    afterVoice: (scene, layer, voice) => {
      const ref = layerFlags.get(layerKey(scene.id, layer.id));
      if (!ref) return;
      if (!ref.dry) {
        // keep the voice running (sub-feed must stay alive) but mute its
        // dry path into the summed buses
        try {
          voice.ch.fader.disconnect(master.musicSum);
        } catch {
          /* not connected (sub-owned voices) */
        }
        try {
          voice.ch.fader.disconnect(master.hitSum);
        } catch {
          /* not connected */
        }
      }
      if (!ref.verb) {
        for (const s of [voice.ch.sendRoom, voice.ch.sendHall, voice.ch.sendCath]) {
          s.gain.cancelScheduledValues(0);
          s.gain.setValueAtTime(0, 0);
        }
      }
    },
  });

  /* ---- clips: same scheduleClip primitive as the monitor, placed by samples  */
  let placed = 0;
  const failed: string[] = [];
  const clipById = new Map(plan.clips.map((c) => [c.id, c]));
  const decoded = await Promise.all(
    pass.clips.map(async (p) => {
      const clip = clipById.get(p.clipId);
      if (!clip) return { p, clip: null, buffer: null as AudioBuffer | null };
      try {
        return { p, clip, buffer: await loadClipBuffer(ctx, clip.url) };
      } catch {
        return { p, clip, buffer: null as AudioBuffer | null };
      }
    }),
  );
  for (const { p, clip, buffer } of decoded) {
    if (!clip || !buffer) {
      if (clip) failed.push(clip.name);
      continue;
    }
    if (p.frameCount <= 0) continue;
    // clamp to what the decoded source can actually supply
    const avail = Math.max(0, buffer.length - p.offsetSample);
    const framesOut = Math.min(p.frameCount, avail);
    if (framesOut <= 0) {
      failed.push(clip.name);
      continue;
    }
    scheduleClip(master, clip, buffer, {
      at: sampleToSec(p.atSample, plan.clock),
      offset: sampleToSec(p.offsetSample, plan.clock),
      duration: sampleToSec(framesOut, plan.clock),
    });
    placed++;
  }

  const buffer = await ctx.startRendering();

  let chans: Float32Array[];
  let lufs: number;
  let peakDb: number;
  if (pass.loudnessConform) {
    // MASTER deliverable only: BS.1770 conform to -16 LUFS + true-peak limit
    const fin = finalizeMaster(buffer, masterParams.ceiling, TARGET_LUFS);
    chans = fin.chans;
    lufs = fin.lufs;
    peakDb = fin.peakDb;
  } else {
    // mix stems / source stems / clip passes: measure, never process.
    chans = [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()];
    lufs = measureLufs(chans, sr);
    let peak = 0;
    for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    peakDb = peak > 1e-7 ? 20 * Math.log10(peak) : -70;
  }

  return {
    L: chans[0],
    R: chans[1] ?? new Float32Array(frames),
    peakDb,
    lufs,
    clipsPlaced: placed,
    clipsFailed: failed,
  };
}
