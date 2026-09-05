import { useState } from 'react';
import { ChevronDown, Download, Ear, Headphones, Plus, RotateCw, Trash2, VolumeX } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { KIND_META, KIND_ORDER, SPACES, type Layer, type LayerKind, type SpaceId } from '../lib/types';
import { db } from '../lib/format';
import { LayerMeter } from './Meter';

export function Slider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="eyebrow text-[8px]">{label}</span>
        <span className="tnum text-[9.5px] text-ash">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function LayerCard({ studio, sceneId, layer }: { studio: Studio; sceneId: string; layer: Layer }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[layer.kind];
  const prog = studio.regenerating[layer.id];
  const busy = prog !== undefined;
  const live = studio.audioOn && studio.playing;
  const scene = studio.project?.scenes.find((s) => s.id === sceneId);

  const patch = (p: Partial<Layer>) => studio.patchLayer(sceneId, layer.id, p);

  return (
    <div
      className="relative overflow-hidden rounded-lg border transition-colors"
      style={{
        borderColor: open ? `${meta.color}55` : 'rgba(255,255,255,0.07)',
        background: `linear-gradient(160deg, ${meta.color}14, rgba(255,255,255,0.015))`,
      }}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span
          className="tnum flex h-[19px] w-[30px] shrink-0 items-center justify-center rounded-[4px] text-[8.5px] font-semibold tracking-wide text-void"
          style={{ background: meta.color }}
        >
          {meta.short}
        </span>
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <span className="block truncate text-[11.5px] font-medium leading-tight text-bone">{layer.name}</span>
          <span className="tnum block truncate text-[9px] text-dim">
            {layer.model} · v{layer.version} · {db(layer.gain)} dB · {layer.space}
          </span>
        </button>
        <button
          className={`rounded p-1 transition-colors ${layer.solo ? 'bg-orchid/25 text-orchid' : 'text-dim hover:text-bone'}`}
          onClick={() => patch({ solo: !layer.solo })}
          title="Solo"
        >
          <Headphones size={12} />
        </button>
        <button
          className={`rounded p-1 transition-colors ${layer.muted ? 'bg-blood/30 text-ember' : 'text-dim hover:text-bone'}`}
          onClick={() => patch({ muted: !layer.muted })}
          title="Mute"
        >
          <VolumeX size={12} />
        </button>
        <button className="rounded p-1 text-dim transition-colors hover:text-bone" onClick={() => studio.audition(layer)} title="Audition">
          <Ear size={12} />
        </button>
        <ChevronDown
          size={12}
          className={`shrink-0 cursor-pointer text-dim transition-transform ${open ? 'rotate-180' : ''}`}
          onClick={() => setOpen((o) => !o)}
        />
      </div>

      <div className="px-2.5 pb-2">
        <LayerMeter id={layer.id} active={live && !layer.muted} />
      </div>

      {busy && (
        <div className="px-2.5 pb-2">
          <div className="mb-1 flex justify-between">
            <span className="eyebrow text-[8px] text-ember">diffusing</span>
            <span className="tnum text-[9px] text-ash">{Math.round(prog)}%</span>
          </div>
          <div className="h-[3px] overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-blood to-orchid transition-[width] duration-200" style={{ width: `${prog}%` }} />
          </div>
        </div>
      )}

      {open && (
        <div className="border-t border-white/[0.06] bg-black/25 px-2.5 py-2.5">
          <p className="mb-2.5 text-[10px] leading-relaxed text-dim">{meta.blurb}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Slider label="Gain" value={layer.gain} max={1.3} fmt={(v) => `${db(v)} dB`} onChange={(v) => patch({ gain: v })} />
            <Slider
              label="Pan"
              value={layer.pan}
              min={-1}
              max={1}
              fmt={(v) => (Math.abs(v) < 0.03 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)}
              onChange={(v) => patch({ pan: v })}
            />
            <Slider label="Send" value={layer.reverb} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ reverb: v })} />
            <Slider label="Width" value={layer.width} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ width: v })} />
            <Slider label="Tone" value={layer.tone} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ tone: v })} />
            <Slider label="Attack" value={layer.attack} fmt={(v) => `${(1 + v * 40).toFixed(0)} ms`} onChange={(v) => patch({ attack: v })} />
            <div className="col-span-2">
              <Slider label="Intensity" value={layer.intensity} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ intensity: v })} />
            </div>
          </div>

          <div className="mt-2.5">
            <span className="eyebrow mb-1 block text-[8px]">Reverb space</span>
            <div className="grid grid-cols-3 gap-1">
              {SPACES.map((s) => (
                <button
                  key={s.id}
                  title={s.note}
                  onClick={() => patch({ space: s.id as SpaceId })}
                  className={`btn px-1 py-1 text-[9.5px] ${layer.space === s.id ? 'border-ember/45 bg-blood/15 text-bone' : ''}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5">
            <button className="btn flex-1 px-2 py-1.5 text-[11px]" disabled={busy} onClick={() => studio.regenLayer(sceneId, layer.id)}>
              <RotateCw size={11} /> Regenerate
            </button>
            <button
              className="btn px-2 py-1.5"
              title="Render this stem to WAV"
              onClick={() => scene && studio.startRender(`${layer.name} stem`, 'WAV 24-bit / 48 kHz', 'stem', { scene, layer })}
            >
              <Download size={11} />
            </button>
            <button className="btn px-2 py-1.5 text-ember/80 hover:text-ember" onClick={() => studio.removeLayer(sceneId, layer.id)} title="Delete layer">
              <Trash2 size={11} />
            </button>
          </div>
          <p className="tnum mt-2 text-[9px] text-dim">seed {layer.seed} · 48 kHz · 24-bit float</p>
        </div>
      )}
    </div>
  );
}

export default function LayerPanel({ studio }: { studio: Studio }) {
  const [adding, setAdding] = useState(false);
  const scene = studio.activeScene;
  if (!scene) return null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow text-bone/80">Scene {scene.index} layers</span>
        <span className="chip tnum">{scene.layers.length}</span>
        <button className="btn btn-ghost ml-auto px-2 py-1" onClick={() => setAdding((a) => !a)}>
          <Plus size={12} /> Layer
        </button>
      </div>

      {adding && (
        <div className="mb-2 grid grid-cols-2 gap-1.5 rounded-lg border border-white/10 bg-black/30 p-2">
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              className="btn justify-start px-2 py-1.5 text-[10.5px]"
              onClick={() => {
                studio.appendLayer(scene.id, k as LayerKind);
                setAdding(false);
              }}
            >
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: KIND_META[k].color }} />
              <span className="truncate">{KIND_META[k].label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {scene.layers.map((l) => (
          <LayerCard key={l.id} studio={studio} sceneId={scene.id} layer={l} />
        ))}
        {scene.layers.length === 0 && (
          <p className="rounded-lg border border-dashed border-white/10 p-4 text-center text-[11px] text-dim">
            No layers on this scene bus. Add one to start generating.
          </p>
        )}
      </div>
    </div>
  );
}
