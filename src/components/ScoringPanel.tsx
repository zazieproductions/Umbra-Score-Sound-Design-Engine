import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cpu,
  Dices,
  Loader,
  Music4,
  Radar,
  Sparkles,
  Video,
  Wand2,
  Waves,
} from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import {
  CAPABILITY_LABEL,
  MUSICAL_KEYS,
  TIME_SIGNATURES,
  backend,
  type Capability,
  type ProviderId,
  type ProviderStatus,
} from '../lib/providers';
import { tc } from '../lib/format';
import { Slider } from './LayerPanel';

const PROVIDER_ICON: Record<ProviderId, typeof Waves> = {
  'umbra-procedural': Waves,
  'ace-step': Music4,
  'stable-audio': Sparkles,
  mmaudio: Video,
  clap: Radar,
};

function CapChip({ cap }: { cap: Capability }) {
  return <span className="chip text-[8.5px]">{CAPABILITY_LABEL[cap]}</span>;
}

/* ------------------------------------------------------------- generator */

function GeneratorPicker({
  providers,
  value,
  onChange,
}: {
  providers: ProviderStatus[];
  value: ProviderId;
  onChange: (id: ProviderId) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">Generator</span>
      {providers.map((p) => {
        const Icon = PROVIDER_ICON[p.id] ?? Waves;
        const on = p.id === value;
        return (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            disabled={!p.ready}
            title={p.ready ? p.blurb : p.notes[0] ?? 'not available'}
            className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              on
                ? 'border-ember/50 bg-blood/15'
                : 'border-white/[0.07] bg-white/[0.02] hover:border-white/20'
            }`}
          >
            <Icon size={14} className={`mt-px shrink-0 ${on ? 'text-ember' : 'text-dim'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[11.5px] font-semibold text-bone">{p.label}</span>
                {p.ready ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brine" title="ready" />
                ) : (
                  <span className="chip shrink-0 border-white/10 text-[8px] text-dim">
                    {p.installed ? 'offline' : 'not installed'}
                  </span>
                )}
              </span>
              <span className="block truncate text-[10px] text-dim">{p.blurb}</span>
              {!p.ready && p.installHint && (
                <span className="tnum mt-0.5 block truncate text-[9px] text-tan/80">{p.installHint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export default function ScoringPanel({ studio }: { studio: Studio }) {
  const { generation, project, activeScene, range, time } = studio;
  const [provider, setProvider] = useState<ProviderId>('ace-step');
  const [prompt, setPrompt] = useState('dark underscore, sparse low strings, deep sub drone, slow spectral movement');
  const [negative, setNegative] = useState('');
  const [durationInput, setDurationInput] = useState(12);
  const [key, setKey] = useState('D');
  const [mode, setMode] = useState<'minor' | 'major'>('minor');
  const [bpm, setBpm] = useState(44);
  const [timeSig, setTimeSig] = useState('4');
  const [seedLocked, setSeedLocked] = useState(false);
  const [seed, setSeed] = useState(1337);
  const [advanced, setAdvanced] = useState(false);
  const [steps, setSteps] = useState(8);
  const [guidance, setGuidance] = useState(7);
  const [coverStrength, setCoverStrength] = useState(0.35);
  const [presets, setPresets] = useState<{ id: string; label: string; prompt: string }[]>([]);
  const [preview, setPreview] = useState<{ prompt: string; negativePrompt: string; notes: string[] } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [routeHint, setRouteHint] = useState<string | null>(null);

  const readyProviders = generation.providers;

  // Never leave the panel pointing at a provider that is not actually usable.
  const resolved = useMemo<ProviderId>(() => {
    const wanted = readyProviders.find((p) => p.id === provider);
    if (wanted?.ready) return provider;
    return readyProviders.find((p) => p.ready)?.id ?? provider;
  }, [readyProviders, provider]);

  const active = generation.providerById(resolved);
  const caps = useMemo(() => active?.capabilities ?? [], [active]);
  const has = useCallback((c: Capability) => caps.includes(c), [caps]);

  useEffect(() => {
    backend.presets().then(setPresets).catch(() => setPresets([]));
  }, [generation.backendState]);

  /*
   * An explicit in/out range on the timeline *is* the duration — the composer
   * should not have to type it twice.
   */
  const duration = range
    ? Math.max(1, Math.round((range.end - range.start) * 10) / 10)
    : durationInput;
  const setDuration = setDurationInput;

  const target = useMemo(() => {
    if (range) return range;
    if (activeScene) return { start: activeScene.start, end: activeScene.end };
    return { start: time, end: time + duration };
  }, [range, activeScene, time, duration]);

  const start = target.start;

  /* Prompt preview — the composer always sees what is actually sent. */
  const refreshPreview = useCallback(async () => {
    if (generation.backendState !== 'online') return;
    try {
      const plan = await backend.buildPrompt({
        intent: prompt,
        key,
        mode,
        bpm,
        timeSignature: timeSig,
        duration,
        extraNegatives: negative ? negative.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      setPreview({ prompt: plan.prompt, negativePrompt: plan.negativePrompt, notes: plan.notes });
    } catch {
      setPreview(null);
    }
  }, [prompt, key, mode, bpm, timeSig, duration, negative, generation.backendState]);

  useEffect(() => {
    const t = window.setTimeout(() => void refreshPreview(), 400);
    return () => window.clearTimeout(t);
  }, [refreshPreview]);

  /* Ask the router where this request belongs. */
  useEffect(() => {
    if (generation.backendState !== 'online' || !prompt.trim()) {
      const clear = window.setTimeout(() => setRouteHint(null), 0);
      return () => window.clearTimeout(clear);
    }
    const t = window.setTimeout(async () => {
      try {
        const d = await backend.route(prompt, !!project?.videoUrl);
        setRouteHint(d.provider !== resolved && d.confidence > 0.35 ? d.reason : null);
      } catch {
        setRouteHint(null);
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [prompt, resolved, project?.videoUrl, generation.backendState]);

  const submit = async () => {
    const plan = preview;
    await studio.generateClip({
      provider: resolved,
      prompt: plan?.prompt || prompt,
      negativePrompt: plan?.negativePrompt,
      duration,
      seed: seedLocked ? seed : null,
      key: has('KEY_CONDITIONING') ? key : null,
      mode: has('KEY_CONDITIONING') ? mode : null,
      bpm: has('BPM_CONDITIONING') ? bpm : null,
      timeSignature: has('TIME_SIGNATURE_CONDITIONING') ? timeSig : null,
      timelineStart: start,
      sceneId: activeScene?.id ?? null,
      label: prompt.slice(0, 34) || 'Generated cue',
      referenceStrength: coverStrength,
      advanced: advanced
        ? { inferenceSteps: steps, guidanceScale: guidance, coverStrength }
        : {},
    });
  };

  const disabled = !active?.ready || !prompt.trim() || !project;

  return (
    <div className="flex flex-col gap-3.5">
      {generation.backendState !== 'online' && (
        <div className="flex items-start gap-2 rounded-lg border border-tan/25 bg-tan/[0.06] p-2.5">
          <AlertTriangle size={13} className="mt-px shrink-0 text-tan" />
          <div className="min-w-0">
            <p className="text-[10.5px] leading-relaxed text-ash">
              {generation.backendState === 'checking'
                ? 'Looking for the local ML backend…'
                : 'Local ML backend is offline. Umbra Procedural still works entirely in this browser.'}
            </p>
            {generation.backendState === 'offline' && (
              <p className="tnum mt-1 text-[9.5px] text-tan/85">python scripts/run_backend.py</p>
            )}
          </div>
        </div>
      )}

      <GeneratorPicker providers={readyProviders} value={resolved} onChange={setProvider} />

      {active?.ready && (
        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Cpu size={12} className="text-orchid" />
            <span className="eyebrow">Engine</span>
            <span className="tnum ml-auto text-[9.5px] text-ash">
              {active.device ?? '—'}
              {active.deviceDetail ? ` · ${active.deviceDetail}` : ''}
            </span>
          </div>
          {active.model && <p className="tnum mb-1.5 truncate text-[10px] text-dim">{active.model}</p>}
          <div className="flex flex-wrap gap-1">
            {caps.map((c) => (
              <CapChip key={c} cap={c} />
            ))}
          </div>
          {active.notes.slice(0, 2).map((n) => (
            <p key={n} className="mt-1.5 text-[9.5px] leading-relaxed text-dim">
              {n}
            </p>
          ))}
        </div>
      )}

      {/* ----------------------------------------------------------- target */}
      <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="eyebrow">Target</span>
          <span className="chip tnum ml-auto">
            {tc(start)} → {tc(start + duration)}
          </span>
        </div>
        <p className="text-[10px] leading-relaxed text-dim">
          {range
            ? 'Using the timeline in/out selection.'
            : activeScene
              ? `Scene ${activeScene.index} — ${activeScene.title}. Drag an in/out range on the timeline to be precise.`
              : 'Placed at the playhead.'}
        </p>
      </div>

      {/* ----------------------------------------------------------- prompt */}
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="eyebrow">Prompt</span>
          {presets.length > 0 && (
            <select
              className="ml-auto rounded border border-white/[0.09] bg-white/[0.03] px-1.5 py-0.5 text-[9.5px] text-ash outline-none"
              value=""
              onChange={(e) => {
                const p = presets.find((x) => x.id === e.target.value);
                if (p) setPrompt(p.prompt);
              }}
            >
              <option value="">horror presets…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="slow dissonant string texture in D minor, no percussion"
          className="w-full resize-none rounded-lg border border-white/[0.09] bg-white/[0.03] px-2.5 py-2 text-[11px] leading-relaxed text-bone outline-none placeholder:text-dim focus:border-ember/40"
        />
        {routeHint && (
          <p className="mt-1 flex items-start gap-1.5 text-[9.5px] leading-relaxed text-orchid/90">
            <Radar size={10} className="mt-px shrink-0" /> {routeHint}
          </p>
        )}
      </div>

      <div>
        <span className="eyebrow mb-1 block">Negative direction</span>
        <input
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          placeholder="extra things to avoid, comma separated"
          className="w-full rounded-lg border border-white/[0.09] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-bone outline-none placeholder:text-dim focus:border-ember/40"
        />
        <p className="mt-1 text-[9.5px] leading-relaxed text-dim">
          Sent verbatim to the generator as the negative prompt. The local prompt builder folds your words and intent into
          the final conditioning — the exact text is shown in “Conditioning sent to the model” before you commit.
        </p>
      </div>

      {/* ------------------------------------------------------ conditioning */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Slider
          label="Duration"
          value={duration}
          min={2}
          max={60}
          step={0.5}
          fmt={(v) => `${v.toFixed(1)}s`}
          onChange={setDuration}
        />
        {has('BPM_CONDITIONING') && (
          <Slider label="BPM" value={bpm} min={30} max={140} step={1} fmt={(v) => String(v)} onChange={setBpm} />
        )}
      </div>

      {has('KEY_CONDITIONING') && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <span className="eyebrow mb-1 block">Key</span>
            <div className="flex flex-wrap gap-1">
              {MUSICAL_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKey(k)}
                  className={`tnum rounded border px-1.5 py-0.5 text-[9.5px] transition-colors ${
                    key === k ? 'border-ember/50 bg-blood/20 text-bone' : 'border-white/[0.08] text-dim hover:text-ash'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="eyebrow mb-1 block">Mode</span>
            <div className="flex flex-col gap-1">
              {(['minor', 'major'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded border px-2 py-0.5 text-[9.5px] transition-colors ${
                    mode === m ? 'border-ember/50 bg-blood/20 text-bone' : 'border-white/[0.08] text-dim hover:text-ash'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {has('TIME_SIGNATURE_CONDITIONING') && (
        <div>
          <span className="eyebrow mb-1 block">Time signature</span>
          <div className="flex gap-1">
            {TIME_SIGNATURES.map((t) => (
              <button
                key={t.value}
                onClick={() => setTimeSig(t.value)}
                className={`tnum flex-1 rounded border px-2 py-1 text-[10px] transition-colors ${
                  timeSig === t.value
                    ? 'border-ember/50 bg-blood/20 text-bone'
                    : 'border-white/[0.08] text-dim hover:text-ash'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {has('SEED_CONTROL') && (
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="eyebrow mb-1 block">Seed</span>
            <input
              type="number"
              value={seed}
              disabled={!seedLocked}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="tnum w-full rounded-lg border border-white/[0.09] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-bone outline-none disabled:opacity-40"
            />
          </label>
          <button
            className={`btn shrink-0 px-2 py-1.5 ${seedLocked ? 'border-ember/45 text-ember' : ''}`}
            onClick={() => setSeedLocked((s) => !s)}
            title={seedLocked ? 'Using a fixed seed' : 'Random seed each run'}
          >
            <Dices size={12} /> {seedLocked ? 'fixed' : 'random'}
          </button>
        </div>
      )}

      {/* -------------------------------------------------------- advanced */}
      <div className="rounded-lg border border-white/[0.07] bg-black/20">
        <button
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
          onClick={() => setAdvanced((a) => !a)}
        >
          <ChevronDown size={12} className={`text-dim transition-transform ${advanced ? '' : '-rotate-90'}`} />
          <span className="eyebrow">Advanced</span>
          <span className="ml-auto text-[9.5px] text-dim">expert model controls</span>
        </button>
        {advanced && active && active.id !== 'umbra-procedural' && (
          <div className="flex flex-col gap-2.5 border-t border-white/[0.06] px-2.5 py-2.5">
            <Slider
              label="Inference steps"
              value={steps}
              min={1}
              max={64}
              step={1}
              fmt={(v) => String(v)}
              onChange={setSteps}
            />
            <Slider
              label="Guidance scale"
              value={guidance}
              min={1}
              max={16}
              step={0.1}
              fmt={(v) => v.toFixed(1)}
              onChange={setGuidance}
            />
            {has('REFERENCE_AUDIO') && (
              <Slider
                label="Reference strength"
                value={coverStrength}
                min={0.05}
                max={1}
                step={0.05}
                fmt={(v) => `${Math.round(v * 100)}%`}
                onChange={setCoverStrength}
              />
            )}
            <p className="text-[9.5px] leading-relaxed text-dim">
              Turbo checkpoints ignore guidance scale; 8 steps is the recommended default. These controls are sent to the
              model only when it is selected and ready.
            </p>
          </div>
        )}
        {advanced && active?.id === 'umbra-procedural' && (
          <p className="border-t border-white/[0.06] px-2.5 py-2 text-[9.5px] leading-relaxed text-dim">
            Umbra Procedural is deterministic browser synthesis — inference steps and guidance do not apply. The prompt, seed
            and duration above are its only creative controls.
          </p>
        )}
      </div>

      {/* --------------------------------------------------------- preview */}
      {preview && (
        <div className="rounded-lg border border-white/[0.07] bg-black/25">
          <button
            className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
            onClick={() => setShowPreview((s) => !s)}
          >
            <ChevronDown size={12} className={`text-dim transition-transform ${showPreview ? '' : '-rotate-90'}`} />
            <span className="eyebrow">Conditioning sent to the model</span>
            {preview.notes.length > 0 && <span className="chip ml-auto text-[8px]">{preview.notes.length} rewrites</span>}
          </button>
          {showPreview && (
            <div className="flex flex-col gap-2 border-t border-white/[0.06] px-2.5 py-2.5">
              <div>
                <span className="eyebrow text-[8px] text-brine">prompt</span>
                <p className="mt-0.5 text-[10px] leading-relaxed text-ash">{preview.prompt}</p>
              </div>
              <div>
                <span className="eyebrow text-[8px] text-tan">negative</span>
                <p className="mt-0.5 text-[10px] leading-relaxed text-dim">{preview.negativePrompt}</p>
              </div>
            </div>
          )}
        </div>
      )}

      <button className="btn btn-primary w-full py-2" disabled={disabled} onClick={() => void submit()}>
        {generation.busy ? <Loader size={13} className="animate-spin" /> : <Wand2 size={13} />}
        Generate {duration.toFixed(1)}s cue
      </button>

      {/* ------------------------------------------------------------ jobs */}
      {generation.jobs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Generation queue</span>
          {generation.jobs.slice(0, 6).map((j) => (
            <div key={j.jobId} className="rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="tnum shrink-0 text-[9px] text-dim">{j.jobId.slice(0, 6)}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-bone">{j.label ?? j.provider}</span>
                {j.state === 'succeeded' ? (
                  <Check size={11} className="shrink-0 text-brine" />
                ) : j.state === 'failed' ? (
                  <span className="chip shrink-0 border-tan/40 text-[8px] text-tan">failed</span>
                ) : j.state === 'cancelled' ? (
                  <span className="chip shrink-0 text-[8px]">cancelled</span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-[9px] text-ember">
                    <Loader size={9} className="animate-spin" /> {j.stage}
                  </span>
                )}
              </div>
              {j.state === 'succeeded' && j.result && (
                <p className="tnum mt-0.5 text-[9px] text-dim">
                  {j.result.duration.toFixed(2)}s · {j.result.sampleRate} Hz · {j.result.channels}ch ·{' '}
                  {(j.result.bytes / 1024).toFixed(0)} KB · {j.elapsed.toFixed(1)}s
                </p>
              )}
              {j.error && <p className="mt-0.5 text-[9px] leading-relaxed text-tan/90">{j.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
