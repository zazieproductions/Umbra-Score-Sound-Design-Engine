import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Cpu,
  HardDrive,
  Music4,
  Radar,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Terminal,
  Video,
  Waves,
} from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import {
  CAPABILITY_LABEL,
  backend,
  type ModelsReport,
  type ProviderId,
  type ProviderStatus,
} from '../lib/providers';

const ICON: Record<ProviderId, typeof Waves> = {
  'umbra-procedural': Waves,
  'ace-step': Music4,
  'stable-audio': Sparkles,
  mmaudio: Video,
  clap: Radar,
};

function Cmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="group flex w-full items-center gap-2 rounded-md border border-white/[0.08] bg-black/45 px-2.5 py-1.5 text-left"
      onClick={() => {
        void navigator.clipboard?.writeText(children);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      <Terminal size={11} className="shrink-0 text-dim" />
      <code className="tnum min-w-0 flex-1 truncate text-[10px] text-ash">{children}</code>
      {copied ? (
        <Check size={11} className="shrink-0 text-brine" />
      ) : (
        <Copy size={11} className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

function StateBadge({ p }: { p: ProviderStatus }) {
  if (p.ready) return <span className="chip border-brine/40 text-brine">ready</span>;
  if (p.installed) return <span className="chip border-tan/40 text-tan">installed · not loaded</span>;
  return <span className="chip border-white/12 text-dim">not installed</span>;
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const Icon = ICON[p.id] ?? Waves;
  return (
    <div className="glass flex flex-col gap-2.5 rounded-xl p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
          <Icon size={15} className={p.ready ? 'text-ember' : 'text-dim'} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[12.5px] font-semibold text-bone">{p.label}</h3>
            <StateBadge p={p} />
          </div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-dim">{p.blurb}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-white/[0.06] pt-2.5">
        <div>
          <dt className="eyebrow text-[8px]">Runtime</dt>
          <dd className="tnum text-[10.5px] text-ash">{p.version ? `v${p.version}` : '—'}</dd>
        </div>
        <div>
          <dt className="eyebrow text-[8px]">Device</dt>
          <dd className="tnum text-[10.5px] text-ash">
            {p.device ?? '—'}
            {p.deviceDetail ? <span className="text-dim"> · {p.deviceDetail}</span> : null}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="eyebrow text-[8px]">Checkpoint</dt>
          <dd className="tnum truncate text-[10.5px] text-ash" title={p.model ?? undefined}>
            {p.model ?? '—'}
          </dd>
        </div>
        {p.sizeBytes != null && (
          <div>
            <dt className="eyebrow text-[8px]">On disk</dt>
            <dd className="tnum text-[10.5px] text-ash">{(p.sizeBytes / 1e9).toFixed(2)} GB</dd>
          </div>
        )}
        {p.availableModels.length > 1 && (
          <div>
            <dt className="eyebrow text-[8px]">Variants</dt>
            <dd className="tnum text-[10.5px] text-ash">{p.availableModels.length}</dd>
          </div>
        )}
      </dl>

      {p.capabilities.length > 0 && (
        <div className="border-t border-white/[0.06] pt-2.5">
          <span className="eyebrow mb-1 block text-[8px]">
            Verified capabilities · {p.capabilities.length}
          </span>
          <div className="flex flex-wrap gap-1">
            {p.capabilities.map((c) => (
              <span key={c} className="chip text-[8.5px]">
                {CAPABILITY_LABEL[c]}
              </span>
            ))}
          </div>
        </div>
      )}

      {p.notes.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-white/[0.06] pt-2.5">
          {p.notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5 text-[10px] leading-relaxed text-dim">
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-dim" />
              {n}
            </li>
          ))}
        </ul>
      )}

      {p.error && (
        <p className="flex items-start gap-1.5 border-t border-white/[0.06] pt-2.5 text-[9.5px] leading-relaxed text-tan/85">
          <ShieldAlert size={10} className="mt-px shrink-0" />
          {p.error}
        </p>
      )}

      {!p.ready && p.installHint && <Cmd>{p.installHint}</Cmd>}
    </div>
  );
}

export default function ModelsView({ studio }: { studio: Studio }) {
  const { generation } = studio;
  const [report, setReport] = useState<ModelsReport | null>(null);

  const load = () => {
    backend
      .models()
      .then(setReport)
      .catch(() => setReport(null));
  };

  useEffect(load, [generation.backendState]);

  const rt = report?.runtime;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <header className="mb-3 flex items-center gap-3">
        <div>
          <h2 className="font-display text-[17px] font-bold tracking-[-0.02em] text-bone">Model manager</h2>
          <p className="text-[10.5px] text-dim">
            Everything here is read from the local machine. Umbra never reports hardware it cannot see.
          </p>
        </div>
        <button
          className="btn ml-auto px-2.5 py-1.5"
          onClick={() => {
            generation.refresh();
            load();
          }}
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </header>

      {/* ------------------------------------------------------ backend */}
      <div
        className={`mb-3 flex items-start gap-2.5 rounded-xl border p-3 ${
          generation.backendState === 'online'
            ? 'border-brine/25 bg-brine/[0.05]'
            : 'border-tan/25 bg-tan/[0.05]'
        }`}
      >
        {generation.backendState === 'online' ? (
          <Check size={14} className="mt-px shrink-0 text-brine" />
        ) : (
          <AlertTriangle size={14} className="mt-px shrink-0 text-tan" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium text-bone">
            {generation.backendState === 'online'
              ? 'Local inference backend connected'
              : generation.backendState === 'checking'
                ? 'Contacting local inference backend…'
                : 'Local inference backend offline'}
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-dim">
            Trained models run in a local FastAPI service. Umbra Procedural runs entirely in this browser and needs
            no backend at all.
          </p>
          {generation.backendState === 'offline' && (
            <div className="mt-2 flex flex-col gap-1">
              <Cmd>python scripts/run_backend.py</Cmd>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ hardware */}
      {rt && (
        <div className="glass mb-3 rounded-xl p-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <Cpu size={13} className="text-orchid" />
            <span className="eyebrow">Detected hardware</span>
            <span className="chip tnum ml-auto">
              {rt.platform.system} · {rt.platform.machine}
              {rt.platform.appleSilicon ? ' · Apple Silicon' : ''}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {rt.devices.map((d) => (
              <div
                key={d.id}
                className={`rounded-lg border px-2.5 py-2 ${
                  d.id === rt.preferredDevice
                    ? 'border-ember/45 bg-blood/10'
                    : d.available
                      ? 'border-white/[0.07] bg-white/[0.02]'
                      : 'border-white/[0.05] bg-white/[0.01] opacity-50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-bone">{d.label}</span>
                  {d.id === rt.preferredDevice && <span className="chip text-[8px]">preferred</span>}
                </div>
                <p className="tnum mt-0.5 text-[9.5px] text-dim">{d.detail ?? d.id}</p>
                {d.totalMemoryBytes != null && (
                  <p className="tnum mt-0.5 text-[9.5px] text-ash">{(d.totalMemoryBytes / 1e9).toFixed(1)} GB</p>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.06] pt-2.5">
            <span className="tnum text-[9.5px] text-dim">python {rt.platform.python}</span>
            <span className="tnum text-[9.5px] text-dim">torch {rt.torch ?? 'not installed'}</span>
            {report?.checkpointsRoot && (
              <span className="tnum flex items-center gap-1 truncate text-[9.5px] text-dim">
                <HardDrive size={9} /> {report.checkpointsRoot}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- providers */}
      <div className="grid gap-3 lg:grid-cols-2">
        {generation.providers.map((p) => (
          <ProviderCard key={p.id} p={p} />
        ))}
      </div>

      <div className="glass mt-3 rounded-xl p-3.5">
        <span className="eyebrow mb-2 block">Installation</span>
        <p className="mb-2.5 text-[10.5px] leading-relaxed text-dim">
          No weights ship with Umbra. Checkpoints are fetched from their official sources into a local directory
          that is excluded from Git. Gated models require you to accept their licence and supply an{' '}
          <code className="tnum text-ash">HF_TOKEN</code>.
        </p>
        <div className="flex flex-col gap-1.5">
          <Cmd>python scripts/setup_models.py --list</Cmd>
          <Cmd>python scripts/setup_models.py --core</Cmd>
          <Cmd>python scripts/setup_models.py --ace-step</Cmd>
        </div>
      </div>
    </div>
  );
}
