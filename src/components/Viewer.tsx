import { Headphones, Pause, Play, RefreshCcw, SkipBack, SkipForward, Volume2, VolumeX, Wand2 } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { tc } from '../lib/format';
import { LoudnessMeter, Spectrum } from './Meter';

export default function Viewer({ studio }: { studio: Studio }) {
  const { project, activeScene, time, playing, setPlaying, seek, audioOn, toggleAudio, master, setMaster, videoRef } = studio;
  if (!project || !activeScene) return null;

  const scenes = project.scenes;
  const idx = scenes.findIndex((s) => s.id === activeScene.id);
  const go = (d: number) => {
    const n = Math.max(0, Math.min(scenes.length - 1, idx + d));
    studio.setActiveSceneId(scenes[n].id);
    seek(scenes[n].start);
  };

  return (
    <section className="glass-deep neon-t relative flex min-h-0 flex-col overflow-hidden rounded-xl">
      <div className="grain scan relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {project.videoUrl ? (
          <video ref={videoRef} src={project.videoUrl} className="h-full w-full object-contain" muted playsInline />
        ) : (
          <img src={activeScene.frame} alt={activeScene.title} className="h-full w-full object-contain" />
        )}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_50%,transparent_38%,rgba(0,0,0,0.72))]" />

        <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5">
          <span className="chip border-ember/40 bg-void/70 text-ember">
            <span className="h-1.5 w-1.5 rounded-full bg-ember livedot" /> SCENE {activeScene.index}/{scenes.length}
          </span>
          <span className="chip border-white/10 bg-void/70">{activeScene.title}</span>
        </div>
        <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1.5">
          <span className="chip tnum border-white/10 bg-void/70">{project.resolution}</span>
          <span className="chip tnum border-white/10 bg-void/70">{tc(time, true, project.fps)}</span>
          <span className="chip tnum border-white/10 bg-void/70">{activeScene.layers.length} layers</span>
        </div>
        <div className="pointer-events-none absolute bottom-2.5 left-3 right-3">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Spectrum active={audioOn && playing} height={36} />
            </div>
            <div className="hidden w-[190px] shrink-0 rounded-lg border border-white/10 bg-void/70 px-2 py-1.5 sm:block">
              <LoudnessMeter active={audioOn && playing} />
            </div>
            <span className="chip tnum shrink-0 border-white/10 bg-void/70">tension {(activeScene.tension * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.07] bg-black/35 px-3 py-2.5">
        <button className="btn px-2 py-1.5" onClick={() => go(-1)} title="Previous scene">
          <SkipBack size={13} />
        </button>
        <button className="btn btn-primary h-8 w-11" onClick={() => setPlaying(!playing)}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="btn px-2 py-1.5" onClick={() => go(1)} title="Next scene">
          <SkipForward size={13} />
        </button>

        <div className="mx-1 flex min-w-[130px] flex-1 items-center gap-2">
          <span className="tnum text-[10.5px] text-ash">{tc(time, true, project.fps)}</span>
          <input type="range" min={0} max={project.duration} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} className="flex-1" />
          <span className="tnum text-[10.5px] text-dim">{tc(project.duration)}</span>
        </div>

        <button className={`btn px-2.5 py-1.5 ${audioOn ? 'border-ember/45 text-ember' : ''}`} onClick={toggleAudio} title="Toggle live monitor">
          {audioOn ? <Headphones size={13} /> : <VolumeX size={13} />}
          <span className="hidden md:inline">{audioOn ? 'Monitor on' : 'Monitor off'}</span>
        </button>

        <div className="flex w-[104px] items-center gap-1.5">
          <Volume2 size={12} className="shrink-0 text-dim" />
          <input type="range" min={0} max={1.2} step={0.01} value={master.volume} onChange={(e) => setMaster({ volume: Number(e.target.value) })} />
        </div>

        <button className="btn px-2.5 py-1.5" onClick={() => studio.regenScene(activeScene.id)} title="Regenerate whole scene">
          <Wand2 size={13} />
          <span className="hidden lg:inline">Regen scene</span>
        </button>
        <button className="btn btn-ghost px-2 py-1.5" onClick={() => seek(activeScene.start)} title="Return to scene start">
          <RefreshCcw size={12} />
        </button>
      </div>
    </section>
  );
}
