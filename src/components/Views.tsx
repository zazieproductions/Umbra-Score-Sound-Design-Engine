import { useMemo, useState } from 'react';
import {
  Activity,
  AudioLines,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Download,
  Ear,
  Gauge,
  Globe2,
  HardDrive,
  Layers,
  Loader,
  Search,
  Server,
  Shield,
  Sparkles,
  Trash2,
  Wand2,
  Waves,
} from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { KIND_META, KIND_ORDER, SPACES, type LayerKind, type SceneStatus } from '../lib/types';
import { DEMO_ASSETS, addLayer } from '../lib/generate';
import { bytes, tc } from '../lib/format';
import { MasterStrip } from './RightPanel';
import { Slider } from './LayerPanel';
import { FreesoundSettings, LicenseSettings } from './SoundLibrarySettings';

/* ------------------------------------------------------------------ shell */

export function Panel({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="glass-deep neon-t relative overflow-hidden rounded-xl">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="font-display text-[13px] font-semibold tracking-[-0.01em] text-bone">{title}</h3>
          {sub && <p className="truncate text-[10.5px] text-dim">{sub}</p>}
        </div>
        {right && <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>}
      </header>
      <div className="p-3.5">{children}</div>
    </div>
  );
}

export function ViewShell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">{children}</div>;
}

function StatusPill({ status }: { status: SceneStatus }) {
  const map: Record<SceneStatus, { t: string; c: string; I: typeof CheckCircle2 }> = {
    queued: { t: 'queued', c: '#5c566e', I: CircleDashed },
    analyzing: { t: 'analysing', c: '#4b8f9a', I: Loader },
    generating: { t: 'generating', c: '#a86bd6', I: Loader },
    ready: { t: 'ready', c: '#4b8f9a', I: CheckCircle2 },
  };
  const m = map[status];
  return (
    <span className="chip" style={{ borderColor: `${m.c}55`, color: m.c }}>
      <m.I size={9} className={status === 'analyzing' || status === 'generating' ? 'animate-spin' : ''} /> {m.t}
    </span>
  );
}

/* ----------------------------------------------------------------- scenes */

export function ScenesView({ studio }: { studio: Studio }) {
  const { project } = studio;
  if (!project) return null;
  return (
    <ViewShell>
      <Panel
        title="Scene detection"
        sub={`${project.scenes.length} shots segmented · ${project.fps} fps · optical-flow boundary model`}
        right={
          <span className="chip tnum">
            {studio.readyCount}/{project.scenes.length} ready
          </span>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {project.scenes.map((s, i) => (
            <div
              key={s.id}
              className={`rise group overflow-hidden rounded-xl border transition-all ${
                s.id === studio.activeSceneId ? 'border-ember/55 shadow-[0_0_28px_-12px_rgba(255,59,92,0.8)]' : 'border-white/[0.07] hover:border-white/20'
              }`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <button
                onClick={() => {
                  studio.setActiveSceneId(s.id);
                  studio.seek(s.start);
                }}
                className="block w-full text-left"
              >
                <div className="grain relative aspect-video overflow-hidden bg-black">
                  <img src={s.frame} alt={s.title} className="h-full w-full object-cover opacity-80 transition-transform duration-500 group-hover:scale-[1.04]" />
                  <span className="absolute inset-0 bg-gradient-to-t from-void via-void/20 to-transparent" />
                  <span className="tnum absolute left-2 top-2 rounded border border-white/15 bg-void/80 px-1.5 py-0.5 text-[9px] font-semibold text-bone">
                    S{String(s.index).padStart(2, '0')}
                  </span>
                  <span className="tnum absolute right-2 top-2 rounded border border-white/15 bg-void/80 px-1.5 py-0.5 text-[9px] text-ash">
                    {tc(s.start)}–{tc(s.end)}
                  </span>
                  <span className="absolute bottom-2 left-2 right-2 flex items-end gap-1">
                    {s.layers.map((l) => (
                      <span key={l.id} className="h-1.5 flex-1 rounded-full" style={{ background: KIND_META[l.kind].color, opacity: l.muted ? 0.3 : 0.95 }} />
                    ))}
                  </span>
                </div>
                <div className="bg-black/30 p-2.5">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="truncate text-[12px] font-semibold text-bone">{s.title}</span>
                    <span className="ml-auto shrink-0">
                      <StatusPill status={s.status} />
                    </span>
                  </div>
                  <p className="mb-2 line-clamp-2 text-[10.5px] leading-relaxed text-dim">{s.summary}</p>
                  <div className="flex items-center gap-2">
                    <span className="eyebrow text-[8px]">tension</span>
                    <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                      <span className="block h-full rounded-full bg-gradient-to-r from-brine via-orchid to-ember" style={{ width: `${s.tension * 100}%` }} />
                    </span>
                    <span className="tnum text-[9.5px] text-ash">{(s.tension * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </button>
              <div className="flex gap-1.5 border-t border-white/[0.06] bg-black/40 px-2.5 py-2">
                <button className="btn flex-1 px-2 py-1 text-[10.5px]" onClick={() => studio.regenScene(s.id)}>
                  <Wand2 size={11} /> Regen
                </button>
                <button
                  className="btn flex-1 px-2 py-1 text-[10.5px]"
                  onClick={() => studio.startRender(`Scene ${s.index} bounce`, 'WAV 24-bit / 48 kHz', 'stereo', { scene: s })}
                >
                  <Download size={11} /> Bounce
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </ViewShell>
  );
}

/* --------------------------------------------------------------- pipeline */

export function PipelineView({ studio }: { studio: Studio }) {
  const { project } = studio;
  if (!project) return null;

  const stages = [
    { k: 'Ingest & probe', d: 'container demux, colour + fps probe, checksum', done: true },
    { k: 'Shot segmentation', d: 'frame differential, flow clustering, cut refine', done: studio.readyCount > 0 },
    { k: 'Semantic tagging', d: 'CLIP scene labels, motion energy, tension curve', done: studio.readyCount > 1 },
    { k: 'Layer planning', d: 'assigns 6–9 layer classes, a musical key and a reverb space per scene', done: studio.readyCount > 1 },
    { k: 'Orchestration & synthesis', d: 'CINEWORKS v5 · 32 steps · 48 kHz layered audio', done: !studio.analyzing },
    { k: 'Conform & master', d: 'glue comp → tape drive → M/S widen → true-peak limit', done: !studio.analyzing },
  ];

  const kindTotals = KIND_ORDER.map((k) => ({
    k,
    n: project.scenes.reduce((a, s) => a + s.layers.filter((l) => l.kind === k).length, 0),
  })).filter((x) => x.n > 0);
  const maxN = Math.max(1, ...kindTotals.map((x) => x.n));

  return (
    <ViewShell>
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <Panel title="Generation pipeline" sub="six-stage cloud graph, per-scene fan-out">
          <ol className="relative flex flex-col gap-3 pl-1">
            {stages.map((s, i) => (
              <li key={s.k} className="rise relative flex gap-3" style={{ animationDelay: `${i * 70}ms` }}>
                <span className="relative flex flex-col items-center">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                      s.done ? 'border-brine/60 bg-brine/15 text-brine' : 'border-ember/50 bg-blood/15 text-ember'
                    }`}
                  >
                    {s.done ? <CheckCircle2 size={11} /> : <Loader size={11} className="animate-spin" />}
                  </span>
                  {i < stages.length - 1 && <span className="mt-1 w-px flex-1 bg-white/10" />}
                </span>
                <span className="pb-1">
                  <span className="block text-[12px] font-semibold text-bone">{s.k}</span>
                  <span className="block text-[10.5px] leading-relaxed text-dim">{s.d}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel title="Layer distribution" sub="stems generated per class across the cut">
            <div className="flex flex-col gap-2">
              {kindTotals.map((x) => (
                <div key={x.k} className="flex items-center gap-2.5">
                  <span className="w-[104px] shrink-0 truncate text-[11px] text-ash">{KIND_META[x.k].label}</span>
                  <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <span
                      className="block h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${(x.n / maxN) * 100}%`, background: KIND_META[x.k].color, boxShadow: `0 0 10px ${KIND_META[x.k].color}77` }}
                    />
                  </span>
                  <span className="tnum w-5 shrink-0 text-right text-[10.5px] text-bone">{x.n}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Batch operations" sub="apply across every ready scene">
            <div className="grid grid-cols-2 gap-1.5">
              <button className="btn" onClick={() => project.scenes.forEach((s) => studio.regenScene(s.id))}>
                <Wand2 size={12} /> Regen all scenes
              </button>
              <button
                className="btn"
                onClick={() => {
                  project.scenes.forEach((s) => studio.appendLayer(s.id, 'strings'));
                  studio.log('batch: string cluster added to every scene', 'ok');
                }}
              >
                <Layers size={12} /> +String pass
              </button>
              <button
                className="btn"
                onClick={() => {
                  project.scenes.forEach((s) => s.layers.forEach((l) => studio.patchLayer(s.id, l.id, { reverb: Math.min(1, l.reverb + 0.15), width: Math.min(1, l.width + 0.15) })));
                  studio.log('batch: +15% send and Haas width', 'info');
                }}
              >
                <AudioLines size={12} /> Widen space
              </button>
              <button
                className="btn"
                onClick={() => {
                  project.scenes.forEach((s) => s.layers.forEach((l) => studio.patchLayer(s.id, l.id, { intensity: Math.min(1, l.intensity + 0.12) })));
                  studio.log('batch: intensity ceiling raised 12%', 'warn');
                }}
              >
                <Gauge size={12} /> Push intensity
              </button>
              <button
                className="btn"
                onClick={() => {
                  project.scenes.forEach((s) => s.layers.forEach((l) => studio.patchLayer(s.id, l.id, { space: 'cathedral' })));
                  studio.log('batch: all layers routed to cathedral convolver', 'info');
                }}
              >
                <Waves size={12} /> All → cathedral
              </button>
              <button
                className="btn"
                onClick={() => {
                  project.scenes.forEach((s) => studio.appendLayer(s.id, 'impact'));
                  studio.log('batch: cinema impact seeded per scene', 'gpu');
                }}
              >
                <Sparkles size={12} /> +Impact stack
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </ViewShell>
  );
}

/* ----------------------------------------------------------------- assets */

export function AssetsView({ studio }: { studio: Studio }) {
  const [q, setQ] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const project = studio.project;

  const library = useMemo(
    () => DEMO_ASSETS.map((a) => ({ ...a, layer: addLayer(a.kind), scene: undefined as undefined })),
    [],
  );

  const generated = project
    ? project.scenes.flatMap((s) =>
        s.layers.map((l) => ({
          name: `S${String(s.index).padStart(2, '0')}_${l.kind}_v${l.version}_${l.seed}.wav`,
          kind: l.kind as LayerKind,
          len: s.end - s.start,
          size: Math.floor((s.end - s.start) * 48000 * 3 * 2),
          tag: 'scene',
          layer: l,
          scene: s,
        })),
      )
    : [];

  const all = [...generated, ...library].filter((a) => !removed.includes(a.name)).filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
  const total = all.reduce((a, x) => a + x.size, 0);

  return (
    <ViewShell>
      <Panel
        title="Asset manager"
        sub={`${all.length} files · ${bytes(total)} in project bucket · click ear to audition, arrow to render`}
        right={
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.09] bg-white/[0.03] px-2 py-1">
            <Search size={11} className="text-dim" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter assets"
              className="w-[130px] bg-transparent text-[11px] text-bone outline-none placeholder:text-dim"
            />
          </div>
        }
      >
        <div className="overflow-hidden rounded-lg border border-white/[0.06]">
          <div className="hidden grid-cols-[1fr_98px_66px_78px_84px] gap-2 border-b border-white/[0.06] bg-black/30 px-3 py-1.5 md:grid">
            {['File', 'Class', 'Length', 'Size', ''].map((h, i) => (
              <span key={i} className="eyebrow text-[8px]">
                {h}
              </span>
            ))}
          </div>
          {all.map((a, i) => (
            <div
              key={a.name + i}
              className="grid grid-cols-[1fr_auto] gap-2 border-b border-white/[0.04] px-3 py-2 transition-colors last:border-0 hover:bg-white/[0.03] md:grid-cols-[1fr_98px_66px_78px_84px] md:items-center"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: KIND_META[a.kind].color, boxShadow: `0 0 7px ${KIND_META[a.kind].color}88` }} />
                <span className="tnum truncate text-[11px] text-bone">{a.name}</span>
                <span className="chip shrink-0 border-white/10 md:hidden">{KIND_META[a.kind].short}</span>
              </div>
              <span className="hidden text-[10.5px] text-ash md:block">
                {KIND_META[a.kind].short} · {a.tag}
              </span>
              <span className="tnum hidden text-[10.5px] text-ash md:block">{a.len.toFixed(1)}s</span>
              <span className="tnum hidden text-[10.5px] text-ash md:block">{bytes(a.size)}</span>
              <div className="flex shrink-0 items-center gap-1">
                <button className="rounded p-1 text-dim hover:text-bone" title="Audition" onClick={() => studio.audition(a.layer)}>
                  <Ear size={12} />
                </button>
                <button
                  className="rounded p-1 text-dim hover:text-bone"
                  title="Render stem to WAV"
                  onClick={() => {
                    const scene = a.scene ?? studio.activeScene;
                    if (scene) studio.startRender(a.name, 'WAV 24-bit / 48 kHz', 'stem', { scene, layer: a.layer, filename: a.name });
                  }}
                >
                  <Download size={12} />
                </button>
                <button className="rounded p-1 text-dim hover:text-ember" title="Remove" onClick={() => setRemoved((r) => [...r, a.name])}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
          {all.length === 0 && <p className="p-6 text-center text-[11px] text-dim">No assets match that filter.</p>}
        </div>
      </Panel>
    </ViewShell>
  );
}

/* ---------------------------------------------------------------- exports */

export function ExportsView({ studio }: { studio: Studio }) {
  const scene = studio.activeScene;
  const presets = [
    { label: 'Full score master', format: 'WAV 24-bit / 48 kHz', res: 'stereo', note: 'Complete timeline bounce, true-peak limited, loudness reported.', scene: false },
    { label: 'Active scene bounce', format: 'WAV 24-bit / 48 kHz', res: 'stereo', note: 'Just the selected scene with its crossfade tails intact.', scene: true },
    { label: 'Trailer cut (60 s)', format: 'WAV 24-bit / 48 kHz', res: 'stereo', note: 'First 60 s of the score for cut-down delivery.', scene: false, max: 60 },
  ];

  return (
    <ViewShell>
      <Panel
        title="HD export"
        sub="real offline bounces rendered in-browser through the full DSP chain"
        right={<span className="chip tnum">{studio.jobs.length} jobs</span>}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {presets.map((p, i) => (
            <div key={p.label} className="rise flex flex-col rounded-xl border border-white/[0.07] bg-gradient-to-br from-white/[0.045] to-transparent p-3" style={{ animationDelay: `${i * 55}ms` }}>
              <div className="mb-2 flex items-start gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-orchid/30 bg-violet/10">
                  <Download size={14} className="text-orchid" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-semibold text-bone">{p.label}</span>
                  <span className="tnum block truncate text-[9.5px] text-dim">
                    {p.format} · {p.res}
                  </span>
                </span>
              </div>
              <p className="mb-3 flex-1 text-[10.5px] leading-relaxed text-ash">{p.note}</p>
              <button
                className="btn btn-primary w-full"
                disabled={!studio.project}
                onClick={() =>
                  studio.startRender(p.label, p.format, p.res, p.scene && scene ? { scene } : p.max ? { maxSeconds: p.max } : undefined)
                }
              >
                <Download size={12} /> Render
              </button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Stem delivery" sub="bounce any layer of the active scene in isolation">
        {!scene ? (
          <p className="py-4 text-center text-[11.5px] text-dim">Select a scene first.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {scene.layers.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: KIND_META[l.kind].color }} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-bone">{l.name}</span>
                <button className="rounded p-1 text-dim hover:text-bone" title="Audition" onClick={() => studio.audition(l)}>
                  <Ear size={12} />
                </button>
                <button
                  className="rounded p-1 text-dim hover:text-ember"
                  title="Render stem"
                  onClick={() => studio.startRender(`${l.name} stem`, 'WAV 24-bit / 48 kHz', 'stem', { scene, layer: l })}
                >
                  <Download size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Render history" sub="downloads stay available for this session">
        {studio.jobs.length === 0 ? (
          <p className="py-6 text-center text-[11.5px] text-dim">Nothing rendered yet — queue a bounce above.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {studio.jobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2">
                <span className="tnum text-[10px] text-dim">{j.id}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-bone">{j.label}</span>
                <span className="tnum hidden text-[10px] text-ash sm:block">{j.format}</span>
                {!!j.bytes && <span className="tnum text-[10px] text-ash">{bytes(j.bytes)}</span>}
                {j.lufs !== undefined && <span className="tnum text-[10px] text-brine">{j.lufs.toFixed(1)} LUFS</span>}
                {j.peak !== undefined && <span className="tnum text-[10px] text-orchid">{j.peak.toFixed(1)} dBTP</span>}
                <span className="h-[3px] w-[90px] overflow-hidden rounded-full bg-white/[0.08]">
                  <span className="block h-full rounded-full" style={{ width: `${j.progress}%`, background: j.state === 'complete' ? '#4b8f9a' : 'linear-gradient(90deg,#c01033,#a86bd6)' }} />
                </span>
                {j.state === 'complete' ? (
                  <button className="btn btn-primary px-2 py-1 text-[10.5px]" onClick={() => studio.downloadJob(j)}>
                    <Download size={11} /> WAV
                  </button>
                ) : (
                  <span className={`chip ${j.state === 'failed' ? 'border-tan/40 text-tan' : 'border-ember/35 text-ember'}`}>
                    {j.state === 'failed' ? 'failed' : j.state === 'encoding' ? 'encoding' : `${Math.round(j.progress)}%`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </ViewShell>
  );
}

/* ------------------------------------------------------------------ cloud */

export function CloudView({ studio }: { studio: Studio }) {
  const regions = [
    { r: 'eu-north-1b', gpu: 'A100 80GB ×4', load: studio.gpuLoad, ping: 14, active: true },
    { r: 'us-east-2a', gpu: 'H100 ×2', load: 61, ping: 92, active: false },
    { r: 'ap-southeast-1', gpu: 'L40S ×8', load: 24, ping: 218, active: false },
  ];
  return (
    <ViewShell>
      <div className="grid gap-3 lg:grid-cols-3">
        {[
          { I: Cpu, k: 'Diffusion throughput', v: `${(1.6 + studio.gpuLoad / 90).toFixed(2)}×`, d: 'realtime vs. cut length' },
          { I: Activity, k: 'Queue depth', v: studio.analyzing ? 'active' : 'idle', d: `${studio.layerCount} layers resident` },
          { I: HardDrive, k: 'Bucket usage', v: '38.4 GB', d: 'of 250 GB studio plan' },
        ].map((c, i) => (
          <div key={c.k} className="rise glass rounded-xl p-3.5" style={{ animationDelay: `${i * 70}ms` }}>
            <c.I size={15} className="mb-2 text-ember" />
            <p className="eyebrow">{c.k}</p>
            <p className="font-display text-[22px] font-semibold text-bone">{c.v}</p>
            <p className="text-[10.5px] text-dim">{c.d}</p>
          </div>
        ))}
      </div>

      <Panel title="Cloud processing status" sub="regional shards available to your workspace">
        <div className="flex flex-col gap-2">
          {regions.map((r) => (
            <div key={r.r} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5">
              <Globe2 size={14} className={r.active ? 'text-ember' : 'text-dim'} />
              <span className="tnum w-[118px] text-[11.5px] text-bone">{r.r}</span>
              <span className="text-[10.5px] text-ash">{r.gpu}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="h-[3px] w-[130px] overflow-hidden rounded-full bg-white/[0.08]">
                  <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${r.load}%`, background: r.active ? '#ff3b5c' : '#5c566e' }} />
                </span>
                <span className="tnum w-8 text-right text-[10px] text-ash">{r.load.toFixed(0)}%</span>
                <span className="tnum w-14 text-right text-[10px] text-dim">{r.ping} ms</span>
                <span className={`chip ${r.active ? 'border-ember/40 text-ember' : ''}`}>{r.active ? 'attached' : 'standby'}</span>
              </span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Activity stream" sub="signed, immutable job log">
        <div className="max-h-[300px] overflow-y-auto">
          {studio.logs.length === 0 && <p className="py-6 text-center text-[11.5px] text-dim">No events yet.</p>}
          {studio.logs.map((l) => (
            <div key={l.id} className="flex gap-3 border-b border-white/[0.04] py-1.5 last:border-0">
              <span className="tnum shrink-0 text-[9.5px] text-dim">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
              <span
                className="tnum w-9 shrink-0 text-[9.5px] uppercase"
                style={{ color: l.level === 'ok' ? '#4b8f9a' : l.level === 'warn' ? '#b9a37e' : l.level === 'gpu' ? '#a86bd6' : '#5c566e' }}
              >
                {l.level}
              </span>
              <span className="min-w-0 flex-1 break-words text-[11px] text-ash">{l.text}</span>
            </div>
          ))}
        </div>
      </Panel>
    </ViewShell>
  );
}

/* --------------------------------------------------------------- settings */

export function SettingsView({ studio }: { studio: Studio }) {
  const [model, setModel] = useState('CINEWORKS-v5');
  const [steps, setSteps] = useState(32);
  const [sr, setSr] = useState('48 kHz');
  const [guidance, setGuidance] = useState(7.5);
  const [safety, setSafety] = useState(true);

  return (
    <ViewShell>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Panel title="Synthesis engine" sub="applies to all future generation passes">
            <div className="flex flex-col gap-3.5">
              <div>
                <span className="eyebrow mb-1.5 block">Base model</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {['CINEWORKS-v5', 'HOLOGRAD-2', 'TITANSCORE-3', 'CHORALIS-2'].map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setModel(m);
                        studio.log(`engine: base model → ${m}`, 'gpu');
                      }}
                      className={`btn justify-start text-[11px] ${model === m ? 'border-ember/45 bg-blood/15' : ''}`}
                    >
                      <Sparkles size={11} className={model === m ? 'text-ember' : 'text-dim'} /> {m}
                    </button>
                  ))}
                </div>
              </div>
              <Slider label="Diffusion steps" value={steps} min={8} max={64} step={1} fmt={(v) => String(v)} onChange={setSteps} />
              <Slider label="Guidance scale" value={guidance} min={1} max={16} step={0.1} fmt={(v) => v.toFixed(1)} onChange={setGuidance} />
              <div>
                <span className="eyebrow mb-1.5 block">Sample rate</span>
                <div className="flex gap-1.5">
                  {['44.1 kHz', '48 kHz', '96 kHz'].map((s) => (
                    <button key={s} onClick={() => setSr(s)} className={`btn flex-1 text-[11px] ${sr === s ? 'border-ember/45 bg-blood/15' : ''}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <button className="btn" onClick={() => setSafety((s) => !s)}>
                <Shield size={12} className={safety ? 'text-brine' : 'text-dim'} /> True-peak limiter {safety ? 'on' : 'off'}
              </button>
            </div>
          </Panel>

          <Panel title="Convolution spaces" sub="procedural impulse responses used by the send buses">
            <div className="flex flex-col gap-2">
              {SPACES.map((s) => (
                <div key={s.id} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2">
                  <Waves size={13} className="shrink-0 text-orchid" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] font-medium text-bone">{s.label}</span>
                    <span className="tnum block text-[9.5px] text-dim">{s.note}</span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-3">
          <Panel title="Master chain" sub="live processing on the monitor and every bounce">
            <MasterStrip studio={studio} />
          </Panel>

          <FreesoundSettings studio={studio} />
          <LicenseSettings studio={studio} />

          <Panel title="Workspace" sub="studio plan · 4 seats">
            <div className="flex flex-col gap-2">
              {[
                ['Plan', 'Studio · $89/mo'],
                ['Render credits', '842 remaining'],
                ['Concurrency', '3 parallel jobs'],
                ['Retention', '30 days'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between border-b border-white/[0.05] pb-1.5 last:border-0">
                  <span className="text-[11px] text-dim">{k}</span>
                  <span className="tnum text-[11px] text-bone">{v}</span>
                </div>
              ))}
              <button className="btn mt-1" onClick={() => void studio.clearUnusedCache()}>
                <Server size={12} /> Clear unused sound cache
              </button>
              {studio.project && (
                <button className="btn text-ember/85 hover:text-ember" onClick={studio.reset}>
                  <Trash2 size={12} /> Close project
                </button>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </ViewShell>
  );
}
