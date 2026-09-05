import { useEffect, useRef, useState } from 'react';
import { engine } from '../lib/audio';

export function Spectrum({ active, height = 46 }: { active: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    let phase = 0;
    const peaks: number[] = [];
    const draw = () => {
      const w = (cv.width = cv.clientWidth * 2);
      const h = (cv.height = cv.clientHeight * 2);
      ctx.clearRect(0, 0, w, h);
      const data = active ? engine.spectrum() : null;
      const bars = 64;
      phase += 0.028;
      for (let i = 0; i < bars; i++) {
        // log-ish frequency mapping so bass isn't squeezed into 3 bars
        const norm = i / bars;
        const idx = data ? Math.floor(Math.pow(norm, 1.9) * (data.length - 1)) : 0;
        const src = data ? data[idx] / 255 : 0;
        const idle = (Math.sin(phase + i * 0.35) * 0.5 + 0.5) * 0.05 + 0.015;
        const v = Math.max(idle, src);
        peaks[i] = Math.max(v, (peaks[i] ?? 0) - 0.012);
        const bw = w / bars;
        const bh = Math.max(2, v * h);
        const grd = ctx.createLinearGradient(0, h, 0, h - bh);
        grd.addColorStop(0, 'rgba(192,16,51,0.95)');
        grd.addColorStop(0.5, 'rgba(255,59,92,0.85)');
        grd.addColorStop(1, 'rgba(168,107,214,0.9)');
        ctx.fillStyle = grd;
        ctx.fillRect(i * bw + bw * 0.2, h - bh, bw * 0.6, bh);
        // peak hold
        const ph = Math.max(2, peaks[i] * h);
        ctx.fillStyle = 'rgba(236,231,244,0.5)';
        ctx.fillRect(i * bw + bw * 0.2, h - ph - 2, bw * 0.6, 2);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={ref} style={{ height }} className="w-full" />;
}

export function LayerMeter({ id, active }: { id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    let peak = 0;
    const loop = () => {
      const lv = active ? engine.level(id) : 0;
      peak = Math.max(lv, peak - 0.006);
      if (ref.current) ref.current.style.width = `${Math.min(100, lv * 100)}%`;
      if (peakRef.current) peakRef.current.style.left = `${Math.min(99, peak * 100)}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [id, active]);
  return (
    <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/[0.07]">
      <div ref={ref} className="h-full rounded-full bg-gradient-to-r from-brine via-ember to-orchid" style={{ width: 0 }} />
      <div ref={peakRef} className="absolute top-0 h-full w-[2px] bg-bone/70" style={{ left: 0 }} />
    </div>
  );
}

/** Master loudness + true-peak readout. */
export function LoudnessMeter({ active }: { active: boolean }) {
  const [lufs, setLufs] = useState(-60);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLufs(engine.loudness());
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  const pct = Math.min(100, Math.max(0, ((lufs + 50) / 50) * 100));
  const hot = lufs > -9;
  return (
    <div className="flex items-center gap-2">
      <span className="eyebrow text-[8px]">LUFS</span>
      <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full rounded-full transition-[width] duration-75"
          style={{
            width: `${active ? pct : 0}%`,
            background: hot ? 'linear-gradient(90deg,#b9a37e,#ff3b5c)' : 'linear-gradient(90deg,#4b8f9a,#7d6bff,#a86bd6)',
          }}
        />
        {/* -16 LUFS target marker */}
        <div className="absolute top-0 h-full w-[1.5px] bg-bone/45" style={{ left: '68%' }} />
      </div>
      <span className="tnum w-11 text-right text-[10px]" style={{ color: hot ? '#ff3b5c' : '#8d86a0' }}>
        {active ? lufs.toFixed(1) : '-∞'}
      </span>
    </div>
  );
}
