import { useRef, useState } from 'react';
import { Film, Sparkles, UploadCloud, Cpu, ShieldCheck, Waypoints } from 'lucide-react';
import type { Studio } from '../lib/useStudio';

const STEPS = [
  { icon: Waypoints, t: 'Shot boundary detection', d: 'Frame-differential + optical-flow segmentation, tension and motion curves per cut.' },
  { icon: Cpu, t: 'Layered orchestration', d: 'Strings, choir, brass, taiko, drones, sub pressure and foley scored to the scene key.' },
  { icon: ShieldCheck, t: 'Conform & deliver', d: '-16 LUFS loudness-normalised master, true-peak limited stems and HD export.' },
];

export default function Uploader({ studio }: { studio: Studio }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  return (
    <div className="grain relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8">
      <div className="pointer-events-none absolute inset-0 flick bg-[radial-gradient(700px_360px_at_50%_18%,rgba(192,16,51,0.35),transparent_65%)]" />
      <div className="relative w-full max-w-[820px]">
        <div className="rise mb-7 text-center" style={{ animationDelay: '40ms' }}>
          <span className="chip mx-auto mb-4 border-ember/30 bg-blood/10 text-ember">
            <Sparkles size={10} /> UMBRA SCORE ENGINE · Cinematic Composer
          </span>
          <h1 className="font-display text-[38px] font-extrabold leading-[1.05] tracking-[-0.03em] text-bone sm:text-[52px]">
            Score it like a Hollywood mix.
            <span className="block bg-gradient-to-r from-ember via-orchid to-violet bg-clip-text text-transparent">Frame by frame.</span>
          </h1>
          <p className="mx-auto mt-3.5 max-w-[520px] text-[13.5px] leading-relaxed text-ash">
            Drop a cut. UMBRA analyses every scene and scores it like a theatrical soundtrack — full string sections, choir,
            brass and taiko layered over deep sub pressure, immersive convolution spaces, hit-ducked dynamics and polished
            transitions — ready for HD delivery.
          </p>
        </div>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) studio.uploadFile(f);
          }}
          className={`rise glass group relative block cursor-pointer overflow-hidden rounded-2xl p-8 text-center transition-all ${
            over ? 'border-ember/60 bg-blood/[0.12]' : 'hover:border-white/20'
          }`}
          style={{ animationDelay: '140ms' }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) studio.uploadFile(f);
            }}
          />
          <div className="pointer-events-none absolute -inset-px rounded-2xl bg-[conic-gradient(from_140deg,transparent,rgba(255,59,92,0.22),transparent_45%,rgba(125,107,255,0.2),transparent)] opacity-0 transition-opacity group-hover:opacity-100" />
          <div className="relative">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-ember/30 bg-gradient-to-br from-blood/30 to-violet/15 shadow-[0_0_36px_-8px_rgba(255,59,92,0.7)]">
              <UploadCloud size={22} className="text-ember" strokeWidth={1.9} />
            </div>
            <p className="font-display text-[17px] font-semibold text-bone">Drop your video, or click to browse</p>
            <p className="mt-1.5 text-[12px] text-dim">MP4 · MOV · ProRes · WebM — up to 4K / 10 min per pass</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <span
                className="btn btn-primary"
                onClick={(e) => {
                  e.preventDefault();
                  inputRef.current?.click();
                }}
              >
                <UploadCloud size={13} /> Select file
              </span>
              <span
                className="btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  studio.loadDemo();
                }}
              >
                <Film size={13} /> Load demo reel
              </span>
            </div>
          </div>
        </label>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.t} className="rise glass rounded-xl p-3.5" style={{ animationDelay: `${240 + i * 90}ms` }}>
              <s.icon size={15} className="mb-2.5 text-orchid" strokeWidth={1.9} />
              <p className="text-[12.5px] font-semibold text-bone">{s.t}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-dim">{s.d}</p>
            </div>
          ))}
        </div>

        <div className="rise mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5" style={{ animationDelay: '540ms' }}>
          {['48 kHz / 24-bit', '17 layer classes', 'true-peak -1 dBTP', '-16 LUFS master', 'stem + master delivery', 'frame-accurate sync'].map((t) => (
            <span key={t} className="eyebrow text-[8.5px]">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
