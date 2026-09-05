import { useEffect, useMemo, useRef, useState } from 'react';
import type { Studio } from '../lib/useStudio';
import { CLIP_PROVIDER_META, type AudioClip } from '../lib/types';
import { clipEnd, clipWaveform } from '../lib/clips';
import { engine } from '../lib/audio';

function ClipWave({ clip, color, width }: { clip: AudioClip; color: string; width: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let alive = true;
    void clipWaveform(engine.peakContext(), clip, 320).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [clip]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const w = (cv.width = Math.max(2, cv.clientWidth * 2));
    const h = (cv.height = Math.max(2, cv.clientHeight * 2));
    ctx.clearRect(0, 0, w, h);
    if (!peaks || !peaks.length) {
      // undecoded: a flat guide line rather than a fake waveform
      ctx.fillStyle = `${color}55`;
      ctx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    ctx.globalAlpha = clip.muted ? 0.25 : 1;
    const n = peaks.length;
    const bw = w / n;
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1.2, peaks[i] * h * 0.86);
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.72), bh);
    }
    ctx.globalAlpha = 1;
  }, [peaks, color, clip.muted, width]);

  return <canvas ref={ref} className="h-full w-full" />;
}

type DragState = {
  clipId: string;
  mode: 'move' | 'trim-start' | 'trim-end';
  originX: number;
  originStart: number;
};

/**
 * Generated clips share one lane per provider. Everything is edited in place —
 * there is no separate result player anywhere in Umbra.
 */
export default function ClipLane({
  studio,
  duration,
  pxPerSecond,
}: {
  studio: Studio;
  duration: number;
  pxPerSecond: number;
}) {
  const { clips, selectedClipId, setSelectedClipId } = studio;
  const [drag, setDrag] = useState<DragState | null>(null);

  const lanes = useMemo(() => {
    const byProvider = new Map<string, AudioClip[]>();
    for (const c of clips) {
      const list = byProvider.get(c.provider) ?? [];
      list.push(c);
      byProvider.set(c.provider, list);
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [clips]);

  useEffect(() => {
    if (!drag) return;
    const secsFrom = (dx: number) => dx / Math.max(1, pxPerSecond);
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.originX;
      if (drag.mode === 'move') {
        studio.dragClip(drag.clipId, drag.originStart + secsFrom(dx));
      }
    };
    const onUp = (e: MouseEvent) => {
      const dx = e.clientX - drag.originX;
      if (drag.mode === 'trim-start') studio.trimClip(drag.clipId, 'start', secsFrom(dx));
      if (drag.mode === 'trim-end') studio.trimClip(drag.clipId, 'end', secsFrom(dx));
      setDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, pxPerSecond, studio]);

  if (!lanes.length) return null;

  const anySolo = clips.some((c) => c.solo);

  return (
    <>
      {lanes.map(([providerId, list]) => {
        const meta = CLIP_PROVIDER_META[providerId as keyof typeof CLIP_PROVIDER_META];
        const color = meta?.color ?? '#7d6bff';
        return (
          <div key={providerId} className="relative h-[38px] border-b border-white/[0.04]">
            {list.map((c) => {
              const left = (c.start / duration) * 100;
              const width = (c.duration / duration) * 100;
              const on = c.id === selectedClipId;
              const dim = c.muted || (anySolo && !c.solo);
              return (
                <div
                  key={c.id}
                  className={`group absolute top-[3px] bottom-[3px] overflow-hidden rounded-[5px] border transition-shadow ${
                    on ? 'z-[2] ring-1 ring-ember/70' : 'z-[1]'
                  }`}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.2, width)}%`,
                    borderColor: on ? `${color}` : `${color}66`,
                    background: `linear-gradient(180deg, ${color}2e, ${color}12)`,
                    opacity: dim ? 0.4 : 1,
                    cursor: drag?.mode === 'move' ? 'grabbing' : 'grab',
                  }}
                  title={`${c.name} · ${c.duration.toFixed(2)}s · ${clipEnd(c).toFixed(2)}s out`}
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).dataset.handle) return;
                    e.stopPropagation();
                    setSelectedClipId(c.id);
                    setDrag({ clipId: c.id, mode: 'move', originX: e.clientX, originStart: c.start });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    studio.toggleClipMute(c.id);
                  }}
                >
                  <div className="absolute inset-0 px-[3px] py-[7px]">
                    <ClipWave clip={c} color={color} width={width} />
                  </div>
                  <span className="pointer-events-none absolute left-1 top-[1px] max-w-[85%] truncate text-[8.5px] font-medium text-bone/90">
                    {c.name}
                  </span>
                  {c.solo && (
                    <span className="pointer-events-none absolute right-1 top-[1px] text-[8px] font-bold text-brine">S</span>
                  )}
                  {/* trim handles */}
                  <span
                    data-handle="start"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setSelectedClipId(c.id);
                      setDrag({ clipId: c.id, mode: 'trim-start', originX: e.clientX, originStart: c.start });
                    }}
                    className="absolute inset-y-0 left-0 w-[5px] cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/25"
                  />
                  <span
                    data-handle="end"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setSelectedClipId(c.id);
                      setDrag({ clipId: c.id, mode: 'trim-end', originX: e.clientX, originStart: c.start });
                    }}
                    className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/25"
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export function ClipLaneHeaders({ studio }: { studio: Studio }) {
  const lanes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of studio.clips) seen.set(c.provider, (seen.get(c.provider) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [studio.clips]);

  return (
    <>
      {lanes.map(([providerId, count]) => {
        const meta = CLIP_PROVIDER_META[providerId as keyof typeof CLIP_PROVIDER_META];
        return (
          <div key={providerId} className="flex h-[38px] items-center gap-1.5 border-b border-white/[0.04] px-2.5">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: meta?.color ?? '#7d6bff', boxShadow: `0 0 7px ${meta?.color ?? '#7d6bff'}88` }}
            />
            <span className="truncate text-[10px] text-ash">{meta?.short ?? providerId}</span>
            <span className="tnum ml-auto text-[9px] text-dim">{count}</span>
          </div>
        );
      })}
    </>
  );
}
