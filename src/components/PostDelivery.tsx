import { useMemo, useState } from 'react';
import { Archive, CheckCircle2, CircleAlert, CircleX, Download, Loader, PackageOpen } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import {
  POST_PRESETS,
  TAIL_PRESETS,
  downloadDeliveryFile,
  runPostExport,
  DeliveryPreflightError,
  type DeliveryResult,
  type DeliverySampleRate,
  type PostExportPreset,
  type TailPolicy,
} from '../lib/export';
import { provenanceStore } from '../lib/library/cache';
import { bytes } from '../lib/format';

/* ==================================================================== *
 *  EXPORT FOR POST — professional stem delivery panel
 *
 *  Thin UI over src/lib/export/. All authority lives there: this panel
 *  only assembles options, calls runPostExport, and renders the honest
 *  preflight + the resulting file list.
 * ==================================================================== */

export function PostDeliveryPanel({ studio }: { studio: Studio }) {
  const [preset, setPreset] = useState<PostExportPreset>('ALL_STEMS');
  const [tailId, setTailId] = useState('tail2');
  const [customTail, setCustomTail] = useState(2);
  const [sampleRate, setSampleRate] = useState<DeliverySampleRate>(48000);
  const [bitDepth, setBitDepth] = useState<16 | 24>(24);
  const [container, setContainer] = useState<'bwav' | 'wav'>('bwav');
  const [zip, setZip] = useState(true);
  const [honorSolo, setHonorSolo] = useState(false);
  const [rawSources, setRawSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<DeliveryResult | null>(null);
  const [error, setError] = useState<{ title: string; lines: string[] } | null>(null);

  const tail: TailPolicy = useMemo(() => {
    if (tailId === 'custom') return { kind: 'custom', seconds: Math.max(0, customTail) };
    return TAIL_PRESETS.find((t) => t.id === tailId)?.tail ?? { kind: 'picture_plus', seconds: 2 };
  }, [tailId, customTail]);

  const project = studio.project;
  const hasRange = !!studio.range;

  async function run(force = false) {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPct(0);
    try {
      const res = await runPostExport(
        project,
        studio.master,
        {
          preset,
          tail,
          sampleRate,
          bitDepth,
          container,
          zip,
          soloPolicy: honorSolo ? 'honor' : 'ignore',
          rawSourceFiles: rawSources,
          force,
        },
        {
          onProgress: (s, p) => {
            setStage(s);
            setPct(p);
          },
          log: (m, lvl) => studio.log(m, lvl ?? 'info'),
          provenance: async () => provenanceStore.list(),
          fetchRaw: async (clip) => {
            try {
              const r = await fetch(clip.url);
              return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
            } catch {
              return null;
            }
          },
        },
        studio.range,
      );
      setResult(res);
      studio.log(
        `delivery: ${res.files.length} file(s)${res.zip ? ` · ${res.zip.name}` : ''} · ${res.stats.clipsPlacedTotal} clip placements`,
        'ok',
      );
    } catch (e) {
      if (e instanceof DeliveryPreflightError) {
        setError({
          title: 'Preflight blocked the export',
          lines: e.report.checks.filter((c) => c.level === 'error' || c.level === 'warn').map((c) => `${c.level === 'error' ? '✕' : '⚠'} ${c.message}`),
        });
        studio.log('delivery: blocked by preflight — nothing was written', 'warn');
      } else {
        setError({ title: 'Delivery failed', lines: [(e as Error).message] });
        studio.log(`delivery failed: ${(e as Error).message}`, 'warn');
      }
    } finally {
      setBusy(false);
      setStage('');
    }
  }

  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <button
      className={`chip !cursor-pointer ${on ? 'border-brine/50 text-brine' : 'text-dim'}`}
      onClick={() => set(!on)}
      title={label}
    >
      {on ? <CheckCircle2 size={9} /> : <CircleAlert size={9} />} {label}
    </button>
  );

  return (
    <div className="glass-deep neon-t relative overflow-hidden rounded-xl">
      <header className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="font-display text-[13px] font-semibold tracking-[-0.01em] text-bone">Export for post</h3>
          <p className="truncate text-[10.5px] text-dim">
            full-session stems · sample-exact sync · reconstruction-verified delivery package
          </p>
        </div>
        <span className="chip tnum ml-auto shrink-0 border-white/10">{result ? `${result.files.length + (result.zip ? 1 : 0)} files` : 'ready'}</span>
      </header>
      <div className="flex flex-col gap-3 p-3.5">
        {/* presets */}
        <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {POST_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              disabled={p.id === 'SELECTED_RANGE' && !hasRange}
              title={p.id === 'SELECTED_RANGE' && !hasRange ? 'Mark an in/out range on the timeline first' : p.blurb}
              className={`flex flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition-all disabled:opacity-40 ${
                preset === p.id ? 'border-ember/55 bg-ember/8 shadow-[0_0_20px_-10px_rgba(255,59,92,0.9)]' : 'border-white/[0.07] bg-black/25 hover:border-white/25'
              }`}
            >
              <span className="text-[11.5px] font-semibold text-bone">{p.label}</span>
              <span className="text-[9.5px] leading-snug text-dim">{p.blurb}</span>
            </button>
          ))}
        </div>

        {/* format row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={tailId} onChange={(e) => setTailId(e.target.value)} className="rounded-md border border-white/[0.09] bg-void px-1.5 py-1 text-[10.5px] text-bone outline-none">
            {TAIL_PRESETS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
            <option value="custom">Custom tail…</option>
          </select>
          {tailId === 'custom' && (
            <input
              type="number"
              min={0}
              step={0.5}
              value={customTail}
              onChange={(e) => setCustomTail(Number(e.target.value))}
              className="tnum w-16 rounded-md border border-white/[0.09] bg-void px-1.5 py-1 text-[10.5px] text-bone outline-none"
            />
          )}
          <select value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value) as DeliverySampleRate)} className="rounded-md border border-white/[0.09] bg-void px-1.5 py-1 text-[10.5px] text-bone outline-none">
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
            <option value={96000}>96 kHz</option>
          </select>
          <select value={bitDepth} onChange={(e) => setBitDepth(Number(e.target.value) as 16 | 24)} className="rounded-md border border-white/[0.09] bg-void px-1.5 py-1 text-[10.5px] text-bone outline-none">
            <option value={24}>24-bit</option>
            <option value={16}>16-bit</option>
          </select>
          <select value={container} onChange={(e) => setContainer(e.target.value as 'bwav' | 'wav')} className="rounded-md border border-white/[0.09] bg-void px-1.5 py-1 text-[10.5px] text-bone outline-none" title="BWF writes a spec-correct bext chunk with the project-origin sample reference">
            <option value="bwav">BWF (bext)</option>
            <option value="wav">WAV PCM</option>
          </select>
          {toggle('zip package', zip, setZip)}
          {toggle('raw sources', rawSources, setRawSources)}
          {toggle('honor solo', honorSolo, setHonorSolo)}
          <button className="btn btn-primary ml-auto flex-1 justify-center sm:flex-none sm:px-4" disabled={!project || busy} onClick={() => void run(false)}>
            {busy ? <Loader size={12} className="animate-spin" /> : <PackageOpen size={12} />}
            {busy ? stage || 'rendering…' : 'EXPORT FOR POST'}
          </button>
        </div>

        {/* preflight / errors */}
        {error && (
          <div className="rounded-lg border border-ember/40 bg-blood/10 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-ember">
              <CircleX size={11} /> {error.title}
            </div>
            {error.lines.map((l, i) => (
              <p key={i} className="tnum text-[10px] leading-relaxed text-ash">{l}</p>
            ))}
            {error.title === 'Preflight blocked the export' && (
              <button className="btn mt-2 px-2 py-1 text-[10px]" onClick={() => void run(true)}>
                Export anyway (manifest records the omissions)
              </button>
            )}
          </div>
        )}

        {busy && (
          <div className="flex items-center gap-2">
            <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <span className="block h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#c01033,#a86bd6)' }} />
            </span>
            <span className="tnum text-[9.5px] text-dim">{Math.round(pct)}%</span>
          </div>
        )}

        {result && (
          <div className="overflow-hidden rounded-lg border border-white/[0.06]">
            {result.zip && (
              <div className="flex items-center gap-2 border-b border-white/[0.06] bg-black/30 px-3 py-2">
                <Archive size={13} className="shrink-0 text-brine" />
                <span className="tnum min-w-0 flex-1 truncate text-[11px] text-bone">{result.zip.name}</span>
                <span className="tnum text-[10px] text-dim">{bytes(result.zip.size)}</span>
                <button className="btn btn-primary px-2 py-1 text-[10.5px]" onClick={() => downloadDeliveryFile(result.zip!)}>
                  <Download size={11} /> Delivery ZIP
                </button>
              </div>
            )}
            <div className="hidden grid-cols-[1fr_120px_66px_70px] gap-2 border-b border-white/[0.06] bg-black/30 px-3 py-1.5 md:grid">
              {['File', 'Folder', 'Frames', ''].map((h, i) => (
                <span key={i} className="eyebrow text-[8px]">{h}</span>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {result.files.map((f) => (
                <div key={f.path} className="grid grid-cols-[1fr_auto] gap-2 border-b border-white/[0.04] px-3 py-1.5 last:border-0 hover:bg-white/[0.03] md:grid-cols-[1fr_120px_66px_70px] md:items-center">
                  <span className="tnum min-w-0 truncate text-[10.5px] text-bone">{f.name}</span>
                  <span className="hidden truncate text-[9.5px] text-dim md:block">{f.path.split('/').slice(0, -1).join('/') || '—'}</span>
                  <span className="tnum hidden text-[9.5px] text-ash md:block">{f.frames ?? '—'}</span>
                  <div className="flex items-center justify-end gap-2">
                    <span className="tnum text-[9.5px] text-dim">{bytes(f.size)}</span>
                    <button className="rounded p-1 text-dim hover:text-bone" title="Download" onClick={() => downloadDeliveryFile(f)}>
                      <Download size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!result && !busy && !error && (
          <p className="text-[10px] leading-relaxed text-dim">
            Every consolidated stem spans the full delivery window from 00:00 and shares one sample grid — drag them all
            to zero in Logic / Pro Tools / Reaper / DaVinci and the session reassembles exactly. Stems sum back to the
            pre-master mix; only the MASTER is loudness-conformed.
          </p>
        )}
      </div>
    </div>
  );
}
