import { useState } from 'react';
import { Activity, CheckCircle2, Cpu, Download, HardDriveDownload, Server, SlidersHorizontal, Sparkles, Terminal, Waves } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import LayerPanel, { Slider } from './LayerPanel';
import { LoudnessMeter } from './Meter';
import { bytes, tc } from '../lib/format';

const EXPORTS: { label: string; format: string; res: string; scene?: boolean; max?: number }[] = [
  { label: 'Full score master', format: 'WAV 24-bit / 48 kHz', res: 'stereo' },
  { label: 'Scene bounce', format: 'WAV 24-bit / 48 kHz', res: 'active scene', scene: true },
  { label: 'Trailer cut (60 s)', format: 'WAV 24-bit / 48 kHz', res: 'stereo', max: 60 },
];

function Gauge({ label, value, unit = '%', color = '#ff3b5c' }: { label: string; value: number; unit?: string; color?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="eyebrow text-[8px]">{label}</span>
        <span className="tnum text-[10px] text-ash">
          {value.toFixed(0)}
          {unit}
        </span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${Math.min(100, value)}%`, background: color, boxShadow: `0 0 8px ${color}` }}
        />
      </div>
    </div>
  );
}

export function MasterStrip({ studio }: { studio: Studio }) {
  const m = studio.master;
  const live = studio.audioOn && studio.playing;
  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Waves size={13} className="text-ember" />
        <span className="eyebrow text-bone/80">Master bus</span>
        <span className="chip ml-auto">glue → tape → M/S → limit</span>
      </div>
      <div className="mb-2.5">
        <LoudnessMeter active={live} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Slider label="Volume" value={m.volume} max={1.2} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ volume: v })} />
        <Slider label="Tape drive" value={m.drive} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ drive: v })} />
        <Slider label="Stereo width" value={m.width} max={1.8} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ width: v })} />
        <Slider label="Bus glue" value={m.glue} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ glue: v })} />
        <Slider label="Sub weight" value={m.subBoost} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ subBoost: v })} />
        <Slider label="Hit ducking" value={m.ducking} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ ducking: v })} />
        <Slider label="Air" value={m.air} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ air: v })} />
        <Slider label="Room" value={m.roomMix} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ roomMix: v })} />
        <Slider label="Stage" value={m.hallMix} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ hallMix: v })} />
        <Slider label="Cathedral" value={m.cathMix} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => studio.setMaster({ cathMix: v })} />
        <Slider label="Ceiling" value={m.ceiling} min={-6} max={0} step={0.1} fmt={(v) => `${v.toFixed(1)} dB`} onChange={(v) => studio.setMaster({ ceiling: v })} />
      </div>
    </div>
  );
}

export default function RightPanel({ studio }: { studio: Studio }) {
  const [tab, setTab] = useState<'mix' | 'cloud' | 'out'>('mix');
  const { project, activeScene, gpuLoad, analyzing, analyzeProgress, logs, jobs } = studio;

  const TABS = [
    { id: 'mix' as const, label: 'Mix', icon: SlidersHorizontal },
    { id: 'cloud' as const, label: 'Cloud', icon: Server },
    { id: 'out' as const, label: 'Export', icon: Download },
  ];

  return (
    <aside className="glass-deep flex w-[330px] shrink-0 flex-col border-l border-white/[0.06]">
      <div className="flex shrink-0 gap-1 border-b border-white/[0.06] p-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`btn flex-1 px-2 py-1.5 text-[11px] ${tab === t.id ? 'border-ember/40 bg-blood/15 text-bone' : 'border-transparent bg-transparent text-dim'}`}
          >
            <t.icon size={12} /> {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'mix' && activeScene && (
          <div className="flex flex-col gap-3.5">
            <MasterStrip studio={studio} />

            <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="eyebrow">Scene analysis</span>
                <span className="chip tnum">
                  {tc(activeScene.start)} → {tc(activeScene.end)}
                </span>
              </div>
              <p className="mb-2.5 text-[11px] leading-relaxed text-ash">{activeScene.summary}</p>
              <div className="mb-2.5 flex flex-wrap gap-1">
                {activeScene.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Gauge label="Tension curve" value={activeScene.tension * 100} />
                <Gauge label="Motion energy" value={activeScene.motion * 100} color="#7d6bff" />
                <Gauge label="Sync hits" value={Math.min(100, activeScene.hits.length * 20)} color="#a86bd6" />
              </div>
            </div>

            <LayerPanel studio={studio} />
          </div>
        )}

        {tab === 'cloud' && (
          <div className="flex flex-col gap-3.5">
            <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
              <div className="mb-2.5 flex items-center gap-2">
                <Cpu size={13} className="text-ember" />
                <span className="eyebrow text-bone/80">Compute shard</span>
                <span className="chip ml-auto border-ember/30 text-ember">
                  <span className="h-1.5 w-1.5 rounded-full bg-ember livedot" /> live
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <Gauge label="GPU A100 · eu-north-1b" value={gpuLoad} />
                <Gauge label="VRAM 80 GB" value={34 + gpuLoad * 0.4} color="#7d6bff" />
                <Gauge label="Diffusion queue" value={analyzing ? analyzeProgress : 100} color="#4b8f9a" />
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-2.5">
                {[
                  ['Scenes', project ? `${studio.readyCount}/${project.scenes.length}` : '—'],
                  ['Layers', String(studio.layerCount)],
                  ['Credits', '842'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="eyebrow text-[8px]">{k}</p>
                    <p className="tnum text-[13px] font-semibold text-bone">{v}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/[0.07] bg-black/25">
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
                <Terminal size={12} className="text-orchid" />
                <span className="eyebrow text-bone/80">Processing log</span>
                <span className="chip tnum ml-auto">{logs.length}</span>
              </div>
              <div className="max-h-[320px] overflow-y-auto p-2">
                {logs.length === 0 && <p className="p-3 text-center text-[11px] text-dim">No activity yet.</p>}
                {logs.map((l) => (
                  <div key={l.id} className="flex gap-2 border-b border-white/[0.03] py-1.5 last:border-0">
                    <span className="tnum shrink-0 text-[9px] text-dim">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
                    <span
                      className="tnum shrink-0 text-[9px] uppercase"
                      style={{ color: l.level === 'ok' ? '#4b8f9a' : l.level === 'warn' ? '#b9a37e' : l.level === 'gpu' ? '#a86bd6' : '#5c566e' }}
                    >
                      {l.level}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-[10.5px] leading-snug text-ash">{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'out' && (
          <div className="flex flex-col gap-3.5">
            <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
              <span className="eyebrow mb-2 block text-bone/80">Offline bounce</span>
              <div className="flex flex-col gap-1.5">
                {EXPORTS.map((e) => (
                  <button
                    key={e.label}
                    disabled={!project}
                    className="group flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-ember/40 hover:bg-blood/10 disabled:opacity-40"
                    onClick={() =>
                      studio.startRender(e.label, e.format, e.res, e.scene && activeScene ? { scene: activeScene } : e.max ? { maxSeconds: e.max } : undefined)
                    }
                  >
                    <HardDriveDownload size={14} className="shrink-0 text-orchid" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-medium text-bone">{e.label}</span>
                      <span className="tnum block truncate text-[9.5px] text-dim">
                        {e.format} · {e.res}
                      </span>
                    </span>
                    <Download size={12} className="shrink-0 text-dim group-hover:text-ember" />
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[9.5px] leading-relaxed text-dim">
                Rendered in-browser through the same DSP graph as the monitor — real 24-bit PCM, not a placeholder.
              </p>
            </div>

            <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
              <div className="mb-2 flex items-center gap-2">
                <Activity size={12} className="text-ember" />
                <span className="eyebrow text-bone/80">Render queue</span>
              </div>
              {jobs.length === 0 && <p className="py-3 text-center text-[11px] text-dim">Queue is empty.</p>}
              <div className="flex flex-col gap-2">
                {jobs.map((j) => (
                  <div key={j.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="truncate text-[11px] font-medium text-bone">{j.label}</span>
                      <span
                        className={`chip ml-auto shrink-0 ${
                          j.state === 'complete' ? 'border-brine/40 text-brine' : j.state === 'failed' ? 'border-tan/40 text-tan' : 'border-ember/35 text-ember'
                        }`}
                      >
                        {j.state === 'complete' ? 'ready' : j.state === 'failed' ? 'failed' : j.state === 'encoding' ? 'encoding' : `${Math.round(j.progress)}%`}
                      </span>
                    </div>
                    <div className="mb-1.5 h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="h-full rounded-full transition-[width] duration-300"
                        style={{ width: `${j.progress}%`, background: j.state === 'complete' ? '#4b8f9a' : 'linear-gradient(90deg,#c01033,#a86bd6)' }}
                      />
                    </div>
                    <p className="tnum text-[9.5px] text-dim">
                      {j.id} · {j.format}
                      {j.bytes ? ` · ${bytes(j.bytes)}` : ''}
                      {j.lufs !== undefined ? ` · ${j.lufs.toFixed(1)} LUFS` : ''}
                    </p>
                    {j.state === 'complete' && (
                      <button className="btn btn-primary mt-1.5 w-full px-2 py-1 text-[10.5px]" onClick={() => studio.downloadJob(j)}>
                        <Download size={11} /> Download WAV
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-brine/25 bg-brine/[0.06] p-2.5">
              <CheckCircle2 size={13} className="mt-px shrink-0 text-brine" />
              <p className="text-[10px] leading-relaxed text-ash">
                <Sparkles size={9} className="mr-1 inline text-brine" />
                Bounces are true-peak limited to your ceiling setting and loudness-reported per job.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
