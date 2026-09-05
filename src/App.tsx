import { useEffect, useState } from 'react';
import { ChevronRight, Command, Film, Loader, Sparkles, Upload, Wand2 } from 'lucide-react';
import Rail, { type ViewId } from './components/Rail';
import Uploader from './components/Uploader';
import Viewer from './components/Viewer';
import Timeline from './components/Timeline';
import RightPanel from './components/RightPanel';
import { AssetsView, CloudView, ExportsView, PipelineView, ScenesView, SettingsView } from './components/Views';
import { useStudio } from './lib/useStudio';
import { tc } from './lib/format';

export default function App() {
  const studio = useStudio();
  const [view, setView] = useState<ViewId>('studio');
  const { project } = studio;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!project) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        studio.setPlaying(!studio.playing);
      }
      if (e.key === 'm') studio.toggleAudio();
      if (e.key === 'ArrowRight') studio.seek(Math.min(project.duration, studio.time + 2));
      if (e.key === 'ArrowLeft') studio.seek(Math.max(0, studio.time - 2));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, studio]);

  const activeJobs = studio.jobs.filter((j) => j.state === 'rendering').length;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Rail
        view={view}
        onView={setView}
        badge={{ scenes: project?.scenes.length, exports: activeJobs || undefined, assets: undefined }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="glass-deep flex h-[52px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="font-display text-[15px] font-extrabold tracking-[-0.02em] text-bone">
              UMBRA<span className="text-ember">·</span>SCORE
            </h1>
            <span className="hidden h-4 w-px bg-white/12 sm:block" />
            <span className="eyebrow hidden sm:block">AI Horror Audio Suite</span>
          </div>

          {project && (
            <div className="ml-2 hidden min-w-0 items-center gap-2 md:flex">
              <ChevronRight size={13} className="shrink-0 text-dim" />
              <Film size={13} className="shrink-0 text-orchid" />
              <span className="tnum truncate text-[11.5px] text-bone">{project.name}</span>
              <span className="chip tnum shrink-0">{tc(project.duration)}</span>
              <span className="chip tnum shrink-0 hidden lg:inline-flex">{project.resolution}</span>
              <span className="chip tnum shrink-0 hidden xl:inline-flex">{project.source}</span>
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {studio.analyzing && (
              <span className="chip border-orchid/40 text-orchid">
                <Loader size={9} className="animate-spin" /> analysing {Math.round(studio.analyzeProgress)}%
              </span>
            )}
            {!studio.analyzing && project && (
              <span className="chip border-brine/40 text-brine">
                <Sparkles size={9} /> {studio.layerCount} stems ready
              </span>
            )}
            <span className="chip hidden md:inline-flex">
              <Command size={9} /> space · play
            </span>
            {project ? (
              <>
                <button className="btn px-2.5 py-1.5" onClick={() => project.scenes.forEach((s) => studio.regenScene(s.id))}>
                  <Wand2 size={12} />
                  <span className="hidden lg:inline">Regen all</span>
                </button>
                <button className="btn btn-primary" onClick={() => studio.startRender('Full score master', 'WAV 24-bit / 48 kHz', 'stereo')}>
                  <Upload size={12} /> Export
                </button>
              </>
            ) : (
              <button className="btn btn-primary" onClick={studio.loadDemo}>
                <Film size={12} /> Load demo reel
              </button>
            )}
            <span className="ml-1 flex h-7 w-7 items-center justify-center rounded-full border border-white/12 bg-gradient-to-br from-blood/40 to-violet/30 text-[10px] font-semibold text-bone">
              RK
            </span>
          </div>
        </header>

        {/* body */}
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            {!project ? (
              <Uploader studio={studio} />
            ) : view === 'studio' ? (
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)] gap-3 p-3">
                <Viewer studio={studio} />
                <Timeline studio={studio} />
              </div>
            ) : view === 'scenes' ? (
              <ScenesView studio={studio} />
            ) : view === 'pipeline' ? (
              <PipelineView studio={studio} />
            ) : view === 'assets' ? (
              <AssetsView studio={studio} />
            ) : view === 'exports' ? (
              <ExportsView studio={studio} />
            ) : view === 'cloud' ? (
              <CloudView studio={studio} />
            ) : (
              <SettingsView studio={studio} />
            )}
          </main>

          {project && <div className="hidden xl:flex"><RightPanel studio={studio} /></div>}
        </div>

        {/* status bar */}
        <footer className="flex h-[26px] shrink-0 items-center gap-4 border-t border-white/[0.06] bg-black/45 px-4">
          <span className="eyebrow flex items-center gap-1.5 text-[8px]">
            <span className={`h-1.5 w-1.5 rounded-full ${studio.audioOn ? 'bg-ember livedot' : 'bg-dim'}`} />
            {studio.audioOn ? 'monitor live' : 'monitor idle'}
          </span>
          <span className="eyebrow text-[8px]">48 kHz / 24-bit</span>
          <span className="eyebrow hidden text-[8px] sm:block">-16 LUFS · -1 dBTP</span>
          {project && <span className="eyebrow tnum hidden text-[8px] md:block">{tc(studio.time, true, project.fps)} / {tc(project.duration, true, project.fps)}</span>}
          <span className="eyebrow ml-auto text-[8px]">gpu {studio.gpuLoad.toFixed(0)}%</span>
          <span className="eyebrow hidden text-[8px] sm:block">eu-north-1b</span>
        </footer>
      </div>
    </div>
  );
}
