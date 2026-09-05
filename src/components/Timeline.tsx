import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Magnet, Minus, Plus, Scissors, ZoomIn } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { KIND_META } from '../lib/types';
import { waveform } from '../lib/generate';
import { tc } from '../lib/format';
import type { LayerKind } from '../lib/types';
import { ROLE_LABELS } from '../lib/library/types';
import type { SoundClip } from '../lib/library/types';

const SOURCE_STYLE: Record<SoundClip['source'], { label: string; color: string }> = {
  LIB: { label: 'LIB', color: '#4b8f9a' },
  USR: { label: 'USR', color: '#7d6bff' },
  GEN: { label: 'GEN', color: '#a86bd6' },
  VID: { label: 'VID', color: '#e0663f' },
  PROC: { label: 'PROC', color: '#b9a37e' },
  PIX: { label: 'PIX', color: '#d8a24a' },
};

function WaveRow({
  seed,
  intensity,
  color,
  muted,
  kind,
  width,
}: {
  seed: number;
  intensity: number;
  color: string;
  muted: boolean;
  kind: LayerKind;
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const data = useMemo(() => waveform(seed, 300, intensity, kind), [seed, intensity, kind]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const w = (cv.width = Math.max(2, cv.clientWidth * 2));
    const h = (cv.height = Math.max(2, cv.clientHeight * 2));
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = muted ? 0.22 : 1;
    const n = data.length;
    const bw = w / n;
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, `${color}bb`);
    grd.addColorStop(0.5, color);
    grd.addColorStop(1, `${color}bb`);
    ctx.fillStyle = grd;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1.4, data[i] * h * 0.9);
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.66), bh);
    }
    ctx.globalAlpha = 1;
  }, [data, color, muted, width]);
  return <canvas ref={ref} className="h-full w-full" />;
}

export default function Timeline({ studio }: { studio: Studio }) {
  const { project, activeScene, time, seek, zoom, setZoom, audioOn, playing } = studio;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState(false);

  const duration = project?.duration ?? 1;

  const posFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !project) return 0;
      const inner = el.firstElementChild as HTMLElement | null;
      const width = inner?.scrollWidth || el.scrollWidth;
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left + el.scrollLeft) / Math.max(1, width)));
      let t = ratio * duration;
      if (snap) {
        const cuts = [0, ...project.scenes.map((s) => s.start), ...project.scenes.flatMap((s) => s.hits), duration];
        const near = cuts.reduce((a, c) => (Math.abs(c - t) < Math.abs(a - t) ? c : a), cuts[0]);
        if (Math.abs(near - t) < duration * 0.01) t = near;
      }
      return t;
    },
    [project, duration, snap],
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => seek(posFromEvent(e.clientX));
    const up = () => setDrag(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag, posFromEvent, seek]);

  if (!project) return null;
  const playheadPct = (time / duration) * 100;
  const ticks = Array.from({ length: Math.floor(duration / 10) + 1 }, (_, i) => i * 10);

  return (
    <section className="glass-deep neon-t relative flex min-h-0 flex-col rounded-xl">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-2">
        <span className="eyebrow text-bone/80">Timeline</span>
        <span className="chip">{project.scenes.length} scenes</span>
        <span className="chip">{project.fps} fps</span>
        {activeScene && <span className="chip hidden sm:inline-flex">{activeScene.layers[0]?.space ?? 'hall'} space</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button className={`btn px-2 py-1.5 ${snap ? 'text-ember' : ''}`} onClick={() => setSnap((s) => !s)} title="Snap to cuts & hits">
            <Magnet size={12} />
            <span className="hidden sm:inline">Snap</span>
          </button>
          <button className="btn px-2 py-1.5" onClick={() => studio.log(`split marker placed @ ${tc(time, true)}`, 'info')} title="Split at playhead">
            <Scissors size={12} />
          </button>
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.09] bg-white/[0.03] px-1.5 py-1">
            <button className="text-ash hover:text-bone" onClick={() => setZoom((z) => Math.max(0.6, z - 0.4))}>
              <Minus size={12} />
            </button>
            <ZoomIn size={11} className="text-dim" />
            <span className="tnum w-8 text-center text-[10px] text-ash">{zoom.toFixed(1)}×</span>
            <button className="text-ash hover:text-bone" onClick={() => setZoom((z) => Math.min(4, z + 0.4))}>
              <Plus size={12} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-[128px] shrink-0 overflow-hidden border-r border-white/[0.06] bg-black/25">
          <div className="h-6 border-b border-white/[0.05]" />
          <div className="h-[34px] border-b border-white/[0.05] px-2.5 py-2">
            <span className="eyebrow text-[8.5px] text-ash">Video · V1</span>
          </div>
          {activeScene?.layers.map((l) => (
            <div key={l.id} className="flex h-[30px] items-center gap-1.5 border-b border-white/[0.04] px-2.5">
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: KIND_META[l.kind].color, boxShadow: `0 0 7px ${KIND_META[l.kind].color}88`, opacity: l.muted ? 0.3 : 1 }}
              />
              <span className="truncate text-[10px] text-ash">{l.name}</span>
            </div>
          ))}
        </div>

        <div className="relative min-w-0 flex-1 overflow-x-auto overflow-y-auto" ref={trackRef}>
          <div className="relative" style={{ width: `${100 * zoom}%`, minWidth: '100%' }}>
            <div
              className="relative h-6 cursor-pointer border-b border-white/[0.06] bg-black/20"
              onMouseDown={(e) => {
                setDrag(true);
                seek(posFromEvent(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-white/[0.08]" style={{ left: `${(t / duration) * 100}%` }}>
                  <span className="tnum ml-1 text-[8.5px] text-dim">{tc(t)}</span>
                </div>
              ))}
            </div>

            <div className="relative flex h-[34px] border-b border-white/[0.05]">
              {project.scenes.map((s) => {
                const on = s.id === activeScene?.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      studio.setActiveSceneId(s.id);
                      seek(s.start);
                    }}
                    className={`group relative h-full overflow-hidden border-r border-void/80 text-left transition-all ${on ? 'ring-1 ring-inset ring-ember/60' : ''}`}
                    style={{ width: `${((s.end - s.start) / duration) * 100}%` }}
                  >
                    <img src={s.frame} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45 transition-opacity group-hover:opacity-70" />
                    <span className="absolute inset-0 bg-gradient-to-r from-void/80 to-void/25" />
                    <span className="tnum relative ml-1.5 text-[9px] font-semibold text-bone/90">S{s.index}</span>
                    {/* tension ribbon */}
                    <span
                      className="absolute bottom-0 left-0 h-[3px] bg-gradient-to-r from-brine via-orchid to-ember"
                      style={{ width: `${s.tension * 100}%` }}
                    />
                    {s.status !== 'ready' && (
                      <span className="absolute bottom-0 left-0 h-[2px] w-full overflow-hidden bg-white/10">
                        <span className="sweep absolute inset-0 block" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {activeScene?.layers.map((l) => {
              const meta = KIND_META[l.kind];
              const left = (activeScene.start / duration) * 100;
              const w = ((activeScene.end - activeScene.start) / duration) * 100;
              return (
                <div key={l.id} className="relative h-[30px] border-b border-white/[0.04]">
                  <div className="absolute inset-0 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.028)_0_1px,transparent_1px_64px)]" />
                  <div
                    className="absolute top-[3px] h-[24px] overflow-hidden rounded-[5px] border"
                    style={{
                      left: `${left}%`,
                      width: `${w}%`,
                      borderColor: `${meta.color}55`,
                      background: `linear-gradient(180deg, ${meta.color}22, ${meta.color}0d)`,
                      opacity: l.muted ? 0.32 : 1,
                    }}
                  >
                    <WaveRow seed={l.seed} intensity={l.intensity} color={meta.color} muted={l.muted} kind={l.kind} width={w} />
                  </div>
                  {(l.kind === 'stinger' || l.kind === 'impact' || l.kind === 'braam') &&
                    activeScene.hits.map((h, i) => (
                      <span
                        key={i}
                        title={`sync hit @ ${tc(h, true)}`}
                        className="absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded bg-ember shadow-[0_0_8px_2px_rgba(255,59,92,0.7)]"
                        style={{ left: `${(h / duration) * 100}%` }}
                      />
                    ))}
                </div>
              );
            })}

            {(() => {
              const sceneClips = project.clips.filter((c) => c.sceneId === activeScene?.id);
              if (!sceneClips.length) return null;
              return (
                <div className="relative h-[30px] border-b border-white/[0.04]">
                  <span className="eyebrow absolute left-1 top-0 z-10 py-0.5 text-[7.5px] text-brine/80">RETRIEVED</span>
                  {sceneClips.map((c) => (
                    <ClipBlock key={c.id} studio={studio} clip={c} duration={duration} />
                  ))}
                </div>
              );
            })()}

            <div className="pointer-events-none absolute top-0 z-10 h-full" style={{ left: `${playheadPct}%` }}>
              <div className={`h-full w-[1.5px] bg-ember ${playing && audioOn ? 'shadow-[0_0_14px_3px_rgba(255,59,92,0.55)]' : 'shadow-[0_0_8px_1px_rgba(255,59,92,0.4)]'}`} />
              <div className="absolute -left-[5px] top-0 h-2.5 w-3 rounded-b-sm bg-ember" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Retrieved sample clip block — draggable, trimmable, selectable.     */
/* ------------------------------------------------------------------ */

function ClipBlock({ studio, clip, duration }: { studio: Studio; clip: SoundClip; duration: number }) {
  const [dragMode, setDragMode] = useState<'none' | 'move' | 'left' | 'right'>('none');
  const [ox, setOx] = useState({ x: 0, start: clip.start, end: clip.end });
  const meta = SOURCE_STYLE[clip.source];
  const selected = studio.selectedClipId === clip.id;
  const left = (clip.start / duration) * 100;
  const width = ((clip.end - clip.start) / duration) * 100;

  const begin = (e: React.MouseEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    setDragMode(mode);
    setOx({ x: e.clientX, start: clip.start, end: clip.end });
    studio.setSelectedClipId(clip.id);
  };

  useEffect(() => {
    if (dragMode === 'none') return;
    const move = (e: MouseEvent) => {
      const dxT = ((e.clientX - ox.x) / Math.max(1, duration)) * duration;
      if (dragMode === 'move') {
        const next = Math.max(0, ox.start + dxT);
        studio.patchClip(clip.id, {
          start: next,
          end: next + (ox.end - ox.start),
        });
      } else if (dragMode === 'left') {
        const start = Math.min(Math.max(0, ox.start + dxT), ox.end - 0.05);
        studio.patchClip(clip.id, { start, offset: clip.offset + (start - ox.start) });
      } else {
        const end = Math.max(ox.end + dxT, ox.start + 0.05);
        studio.patchClip(clip.id, { end });
      }
    };
    const up = () => setDragMode('none');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragMode, ox, clip.id, clip.offset, duration, studio]);

  return (
    <div
      className={`group absolute top-[4px] h-[22px] cursor-grab overflow-hidden rounded-[4px] border select-none active:cursor-grabbing ${
        selected ? 'ring-1 ring-inset ring-ember/70' : ''
      }`}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        borderColor: `${meta.color}66`,
        background: `linear-gradient(180deg, ${meta.color}2e, ${meta.color}10)`,
        opacity: clip.muted ? 0.35 : 1,
      }}
      onMouseDown={(e) => begin(e, 'move')}
      onDoubleClick={() => void studio.auditionClip(clip.id)}
      onClick={(e) => {
        e.stopPropagation();
        studio.setSelectedClipId(clip.id);
      }}
      title={`${clip.name} · ${ROLE_LABELS[clip.role]} · ${tc(clip.start, true)} · ${clip.asset.providerLabel} · ${clip.asset.license} · MATCH ${Math.round(clip.match * 100)}%`}
    >
      <span
        className="absolute inset-y-0 left-0 w-[5px] cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100"
        onMouseDown={(e) => begin(e, 'left')}
      />
      <span
        className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100"
        onMouseDown={(e) => begin(e, 'right')}
      />
      <span className="pointer-events-none absolute inset-y-0 left-[7px] flex items-center gap-1">
        <span
          className="tnum rounded-[2px] px-[3px] py-px text-[7px] font-bold text-void"
          style={{ background: meta.color, opacity: 0.9 }}
        >
          {meta.label}
        </span>
        <span className="max-w-[120px] truncate text-[8.5px] text-bone/85">{clip.name}</span>
      </span>
      <span className="pointer-events-none absolute inset-y-0 right-[7px] hidden items-center text-[7.5px] text-ash/80 group-hover:flex">
        {Math.round(clip.match * 100)}%
      </span>
    </div>
  );
}
