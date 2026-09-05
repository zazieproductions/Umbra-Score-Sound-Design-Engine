import { useState } from 'react';
import { ArrowRightToLine, Download, Loader, Paintbrush, RotateCw, Trash2, VolumeX, Radio } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { CLIP_PROVIDER_META } from '../lib/types';
import { backend } from '../lib/providers';
import { tc } from '../lib/format';
import { Slider } from './LayerPanel';

/**
 * The one and only inspector for generated audio. Clips are edited here and on
 * the timeline — there is deliberately no separate "AI result" player.
 */
export default function ClipInspector({ studio }: { studio: Studio }) {
  const clip = studio.selectedClip;
  const [contLength, setContLength] = useState(12);
  const [repaintPrompt, setRepaintPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (!clip) {
    return (
      <div className="rounded-lg border border-white/[0.07] bg-black/25 p-3">
        <span className="eyebrow mb-1 block">Clip inspector</span>
        <p className="text-[10.5px] leading-relaxed text-dim">
          Select a generated clip on the timeline to move, trim, fade, mute, solo, continue, repaint or export it.
        </p>
      </div>
    );
  }

  const meta = CLIP_PROVIDER_META[clip.provider];
  const m = clip.metadata;
  const canContinue = clip.provider === 'ace-step';
  const range = studio.range;

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
      <div className="flex items-start gap-2">
        <span
          className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ background: meta?.color, boxShadow: `0 0 8px ${meta?.color}88` }}
        />
        <div className="min-w-0 flex-1">
          <input
            value={clip.name}
            onChange={(e) => studio.patchClip(clip.id, { name: e.target.value })}
            className="w-full bg-transparent text-[12px] font-semibold text-bone outline-none"
          />
          <p className="tnum text-[9.5px] text-dim">
            {meta?.label} · {tc(clip.start)} → {tc(clip.start + clip.duration)} · {clip.duration.toFixed(2)}s
            {clip.version > 1 ? ` · v${clip.version}` : ''}
          </p>
        </div>
        <button
          className={`btn shrink-0 px-1.5 py-1 ${clip.muted ? 'border-tan/45 text-tan' : ''}`}
          onClick={() => studio.toggleClipMute(clip.id)}
          title="Mute"
        >
          <VolumeX size={11} />
        </button>
        <button
          className={`btn shrink-0 px-1.5 py-1 ${clip.solo ? 'border-brine/50 text-brine' : ''}`}
          onClick={() => studio.toggleClipSolo(clip.id)}
          title="Solo"
        >
          <Radio size={11} />
        </button>
      </div>

      {/* ------------------------------------------------------- editing */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-white/[0.06] pt-2.5">
        <Slider
          label="Gain"
          value={clip.gain}
          min={-36}
          max={12}
          step={0.5}
          fmt={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
          onChange={(v) => studio.patchClip(clip.id, { gain: v })}
        />
        <Slider
          label="Pan"
          value={clip.pan}
          min={-1}
          max={1}
          step={0.02}
          fmt={(v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)}
          onChange={(v) => studio.patchClip(clip.id, { pan: v })}
        />
        <Slider
          label="Fade in"
          value={clip.fadeIn}
          min={0}
          max={Math.max(0.5, clip.duration / 2)}
          step={0.05}
          fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => studio.patchClip(clip.id, { fadeIn: v })}
        />
        <Slider
          label="Fade out"
          value={clip.fadeOut}
          min={0}
          max={Math.max(0.5, clip.duration / 2)}
          step={0.05}
          fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => studio.patchClip(clip.id, { fadeOut: v })}
        />
        <Slider
          label="Start"
          value={clip.start}
          min={0}
          max={Math.max(1, (studio.project?.duration ?? 60) - 0.1)}
          step={0.01}
          fmt={(v) => tc(v, true)}
          onChange={(v) => studio.dragClip(clip.id, v)}
        />
        <Slider
          label="Offset into source"
          value={clip.offset}
          min={0}
          max={Math.max(0.01, clip.sourceDuration - 0.1)}
          step={0.01}
          fmt={(v) => `${v.toFixed(2)}s`}
          onChange={(v) =>
            studio.patchClip(clip.id, {
              offset: v,
              duration: Math.min(clip.duration, clip.sourceDuration - v),
            })
          }
        />
      </div>

      {/* ---------------------------------------------------- generation */}
      <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-2.5">
        <button
          className="btn px-2 py-1.5"
          disabled={!!busy || studio.generation.backendState !== 'online'}
          onClick={() => void run('regen', () => studio.regenerateClip(clip))}
          title="Re-run these settings with a new seed"
        >
          {busy === 'regen' ? <Loader size={11} className="animate-spin" /> : <RotateCw size={11} />} Regenerate
        </button>
        <button
          className="btn px-2 py-1.5"
          disabled={!!busy || !range || studio.generation.backendState !== 'online'}
          onClick={() =>
            range && void run('repaint', () => studio.repaintClip(clip, range.start, range.end, repaintPrompt || undefined))
          }
          title={range ? 'Regenerate only the selected span' : 'Mark an in/out range on the timeline first'}
        >
          {busy === 'repaint' ? <Loader size={11} className="animate-spin" /> : <Paintbrush size={11} />} Repaint selection
        </button>
        <button
          className="btn px-2 py-1.5"
          onClick={() =>
            studio.startRender(`${clip.name} stem`, 'WAV 24-bit / 48 kHz', 'clip stem', {
              clip,
              filename: `${clip.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wav`,
            })
          }
          title="Bounce this clip through the master chain"
        >
          <Download size={11} /> Stem
        </button>
        <button
          className="btn px-2 py-1.5"
          onClick={() => backend.downloadAudio(clip.audioId, `${clip.name}.wav`)}
          title="Download the exact generated file"
        >
          <Download size={11} /> Source
        </button>
        <button
          className="btn btn-ghost ml-auto px-2 py-1.5 text-tan"
          onClick={() => studio.removeClip(clip.id)}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {range && (
        <input
          value={repaintPrompt}
          onChange={(e) => setRepaintPrompt(e.target.value)}
          placeholder="optional new direction for the repainted span"
          className="w-full rounded-lg border border-white/[0.09] bg-white/[0.03] px-2.5 py-1.5 text-[10.5px] text-bone outline-none placeholder:text-dim focus:border-ember/40"
        />
      )}

      {canContinue && (
        <div className="flex items-end gap-2 border-t border-white/[0.06] pt-2.5">
          <div className="min-w-0 flex-1">
            <Slider
              label="Continue for"
              value={contLength}
              min={4}
              max={45}
              step={1}
              fmt={(v) => `${v}s`}
              onChange={setContLength}
            />
          </div>
          <button
            className="btn shrink-0 px-2 py-1.5"
            disabled={!!busy || studio.generation.backendState !== 'online'}
            onClick={() => void run('cont', () => studio.continueClip(clip, contLength))}
            title="Generate a continuation placed immediately after this clip"
          >
            {busy === 'cont' ? <Loader size={11} className="animate-spin" /> : <ArrowRightToLine size={11} />} Continue
          </button>
        </div>
      )}

      {/* ------------------------------------------------------ metadata */}
      <details className="border-t border-white/[0.06] pt-2.5">
        <summary className="eyebrow cursor-pointer select-none text-[8.5px]">Generation metadata</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {(
            [
              ['provider', m.provider],
              ['model', m.model],
              ['seed', m.seed],
              ['bpm', m.bpm],
              ['key', m.key && m.mode ? `${m.key} ${m.mode}` : m.key],
              ['time sig', m.timeSignature],
              ['duration', m.duration != null ? `${Number(m.duration).toFixed(2)}s` : null],
              ['reference', m.referenceAudioId],
              ['source', m.sourceAudioId],
              ['task', m.task],
              ['audio id', clip.audioId],
            ] as [string, unknown][]
          )
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="eyebrow text-[8px]">{k}</dt>
                <dd className="tnum min-w-0 truncate text-[9.5px] text-ash" title={String(v)}>
                  {String(v)}
                </dd>
              </div>
            ))}
        </dl>
        {typeof m.prompt === 'string' && (
          <p className="mt-2 text-[9.5px] leading-relaxed text-dim">{m.prompt}</p>
        )}
      </details>
    </div>
  );
}
