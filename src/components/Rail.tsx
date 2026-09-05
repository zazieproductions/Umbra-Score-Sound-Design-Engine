import { Aperture, AudioLines, Boxes, Cpu, Download, Layers, Radio, Settings, Waves } from 'lucide-react';

export type ViewId = 'studio' | 'scenes' | 'pipeline' | 'library' | 'assets' | 'exports' | 'models' | 'settings';

const ITEMS: { id: ViewId; label: string; icon: typeof Waves }[] = [
  { id: 'studio', label: 'Studio', icon: Waves },
  { id: 'scenes', label: 'Scenes', icon: Aperture },
  { id: 'pipeline', label: 'Pipeline', icon: Layers },
  { id: 'library', label: 'Library', icon: AudioLines },
  { id: 'assets', label: 'Assets', icon: Boxes },
  { id: 'exports', label: 'Exports', icon: Download },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'settings', label: 'Engine', icon: Settings },
];

export default function Rail({
  view,
  onView,
  badge,
}: {
  view: ViewId;
  onView: (v: ViewId) => void;
  badge: Partial<Record<ViewId, number>>;
}) {
  return (
    <nav className="glass-deep relative z-20 flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] py-4">
      <div className="relative mb-4 flex h-10 w-10 items-center justify-center">
        <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-blood/70 to-violet/40 blur-[10px]" />
        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-void/80">
          <Radio size={17} className="text-ember" strokeWidth={2.2} />
        </div>
      </div>

      {ITEMS.map((it) => {
        const on = view === it.id;
        const n = badge[it.id];
        return (
          <button
            key={it.id}
            onClick={() => onView(it.id)}
            title={it.label}
            className={`group relative flex w-full flex-col items-center gap-1 py-2.5 transition-colors ${
              on ? 'text-bone' : 'text-dim hover:text-ash'
            }`}
          >
            {on && <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-r bg-ember shadow-[0_0_10px_2px_rgba(255,59,92,0.6)]" />}
            <span
              className={`relative flex h-9 w-9 items-center justify-center rounded-[10px] border transition-all ${
                on
                  ? 'border-ember/35 bg-gradient-to-br from-blood/25 to-violet/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                  : 'border-transparent group-hover:border-white/10 group-hover:bg-white/[0.05]'
              }`}
            >
              <it.icon size={16} strokeWidth={1.9} />
              {!!n && (
                <span className="tnum absolute -right-1 -top-1 rounded-full border border-void bg-ember px-[4px] text-[8px] font-semibold leading-[13px] text-void">
                  {n}
                </span>
              )}
            </span>
            <span className="eyebrow text-[8px] tracking-[0.14em]">{it.label}</span>
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <span className="eyebrow rotate-180 text-[8px] [writing-mode:vertical-rl]">v3.4.1</span>
        <span className="h-1.5 w-1.5 rounded-full bg-ember livedot shadow-[0_0_8px_2px_rgba(255,59,92,0.7)]" />
      </div>
    </nav>
  );
}
