import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  ChevronDown,
  Ear,
  ExternalLink,
  FileJson,
  FileText,
  ListMusic,
  Loader,
  Lock,
  Play,
  Search,
  Shield,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { tc, bytes } from '../lib/format';
import { Panel, ViewShell } from './Views';
import type {
  AutoMode,
  LibraryAsset,
  RankedCandidate,
  RetrievalIntent,
  SoundDensity,
  SoundRole,
  ProviderStatus,
} from '../lib/library/types';
import { LICENSE_CLASS_LABELS, ROLE_LABELS } from '../lib/library/types';
import { provenanceStore, soundCache } from '../lib/library/cache';

/* ------------------------------------------------------------- shell -- */

export function LibraryView({ studio }: { studio: Studio }) {
  const { project, activeScene } = studio;
  if (!project) return <ViewShell><Panel title="Sound Library" sub="Load or upload a project to retrieve sounds."><p className="text-[11px] text-dim">No project open.</p></Panel></ViewShell>;

  return (
    <ViewShell>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          {activeScene && <AutoSoundDesign studio={studio} />}
          <CandidateBrowser studio={studio} />
          <PixabayAssisted studio={studio} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <ProviderCards studio={studio} />
          <ProvenanceLedger studio={studio} />
          <CachePanel studio={studio} />
        </div>
      </div>
    </ViewShell>
  );
}

/* ------------------------------------------------- auto sound design -- */

function AutoSoundDesign({ studio }: { studio: Studio }) {
  const s = studio.activeScene!;
  const mode = studio.libSettings.autoMode;
  const [open, setOpen] = useState(false);
  const [densityOpen, setDensityOpen] = useState(false);
  const intents = useMemo(() => studio.planScene(s.id), [studio, s.id]);
  const running = studio.retrieval.busy;
  const last = studio.retrieval.lastAuto;

  const modes: { id: AutoMode; label: string; note: string }[] = [
    { id: 'off', label: 'OFF', note: 'No library retrieval.' },
    { id: 'suggest', label: 'SUGGEST', note: 'Shows proposed layers — places nothing without your selection.' },
    { id: 'auto-safe', label: 'AUTO SAFE', note: 'Auto-places only high-confidence, license-ok sounds.' },
    { id: 'auto-full', label: 'AUTO FULL', note: 'Builds a fuller pass. All clips editable, nothing flattened.' },
  ];
  const densities: SoundDensity[] = ['minimal', 'restrained', 'normal', 'dense'];

  return (
    <Panel
      title="Auto Sound Design"
      sub={`Scene ${s.index} · ${s.title} · planner derived ${intents.filter((i) => !i.isSilenceChoice).length} retrieval intent(s)`}
      right={
        <span className="chip tnum">{last ? `${last.placed} placed / ${last.suggested} suggested` : 'idle'}</span>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`btn justify-start px-2 py-1.5 text-[10px] leading-tight ${mode === m.id ? 'border-ember/45 bg-blood/15 text-bone' : ''}`}
            title={m.note}
            onClick={() => {
              studio.setSettingsPatch({ autoMode: m.id });
              if (m.id !== 'off') void studio.runAutoDesign(s.id, m.id);
            }}
          >
            <Sparkles size={10} className={mode === m.id ? 'text-ember' : 'text-dim'} />
            <span>{m.label}</span>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn px-2 py-1 text-[10px]" onClick={() => setDensityOpen((o) => !o)}>
          <AudioLines size={10} /> Density <ChevronDown size={10} className={densityOpen ? 'rotate-180' : ''} />
        </button>
        {densityOpen &&
          densities.map((d) => (
            <button
              key={d}
              className={`btn px-2 py-1 text-[10px] ${studio.libSettings.density === d ? 'border-orchid/50 text-orchid' : ''}`}
              onClick={() => {
                studio.setSettingsPatch({ density: d });
                setDensityOpen(false);
              }}
            >
              {d}
            </button>
          ))}
        <button className="btn px-2 py-1 text-[10px]" onClick={() => setOpen((o) => !o)} title="Show derived intents">
          <ListMusic size={10} /> Intents <ChevronDown size={10} className={open ? 'rotate-180' : ''} />
        </button>
        <span className="chip ml-auto border-brine/30 text-brine">
          <Shield size={9} /> license {studio.libSettings.licensePolicy.mode}
        </span>
      </div>

      {running && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-orchid/30 bg-orchid/[0.06] px-2.5 py-2">
          <Loader size={12} className="animate-spin text-orchid" />
          <span className="text-[10.5px] text-ash">retrieving + ranking candidates…</span>
        </div>
      )}

      {open && (
        <div className="mb-2 flex flex-col gap-1 rounded-lg border border-white/[0.07] bg-black/25 p-2">
          {intents.map((i) => (
            <div key={i.id} className="flex items-center gap-2 border-b border-white/[0.04] py-1 last:border-0">
              <span className="w-[104px] shrink-0 truncate text-[10px] text-bone">{ROLE_LABELS[i.role]}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-dim" title={i.reason}>
                {i.isSilenceChoice ? '· SILENCE ·' : i.query}
              </span>
              {i.time !== null && !i.isSilenceChoice && <span className="tnum shrink-0 text-[9px] text-ash">{tc(i.time, true)}</span>}
              {i.transform && <span className="chip hidden shrink-0 border-orchid/40 text-orchid lg:inline-flex">+transform</span>}
              <span className="tnum shrink-0 text-[9px] text-dim">{(i.priority * 100).toFixed(0)}</span>
            </div>
          ))}
        </div>
      )}

      {last && (
        <p className="text-[9.5px] text-dim">
          last run: {last.mode} · {last.placed} placed · {last.suggested} suggested · {last.skipped} skipped — all clips remain separate + undoable.
        </p>
      )}
    </Panel>
  );
}

/* -------------------------------------------------- candidate browser -- */

function CandidateBrowser({ studio }: { studio: Studio }) {
  const s = studio.activeScene ?? studio.project?.scenes[0] ?? null;
  const [query, setQuery] = useState('wood door creak');
  const [role, setRole] = useState<SoundRole>('DOOR');
  const [anchor, setAnchor] = useState<number | null>(null);
  const [openCount, setOpenCount] = useState(8);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const result = studio.retrieval.result;
  const busy = studio.retrieval.busy;

  // scene → intent (user editable query)
  const manualIntent = useCallback(
    (q: string): RetrievalIntent | null => {
      if (!s) return null;
      const t = anchor ?? studio.time;
      return {
        id: `m${Date.now().toString(36)}`,
        sceneId: s.id,
        role,
        query: q,
        altQueries: [],
        time: t,
        offset: 0,
        durationFit: role === 'ROOM_TONE' || role === 'DRONE' || role === 'AMBIENCE' ? 'long' : role === 'MECHANICAL' ? 'medium' : 'short',
        minDuration: role === 'ROOM_TONE' || role === 'DRONE' ? 8 : 0.1,
        maxDuration: role === 'ROOM_TONE' || role === 'DRONE' ? 120 : 6,
        priority: 0.9,
        allowSilence: false,
        reason: 'manual retrieval',
      };
    },
    [s, role, anchor, studio.time],
  );

  const doSearch = useCallback(
    (q: string) => {
      const intent = manualIntent(q);
      if (!intent) return;
      void studio.runSearch(intent);
    },
    [manualIntent, studio],
  );

  useEffect(() => {
    if (query.trim() && !studio.retrieval.result && !studio.retrieval.busy) {
      // defer past the first paint — avoids cascading render from the effect
      const t = window.setTimeout(() => doSearch(query), 50);
      return () => window.clearTimeout(t);
    }
  }, [query, studio.retrieval.result, studio.retrieval.busy, doSearch]);

  const roles: SoundRole[] = ['DOOR', 'FOOTSTEP', 'ROOM_TONE', 'DRONE', 'WOOD', 'CREAK', 'CLOTHING', 'MECHANICAL', 'METAL', 'GLASS', 'WIND', 'WATER', 'KNOCK', 'IMPACT', 'SCRAPE', 'BREATH', 'ELECTRICAL', 'RUMBLE', 'TEXTURE'];

  const candidates = result?.candidates ?? [];
  const visible = candidates.slice(0, openCount);

  return (
    <Panel
      title="Search Candidate Browser"
      sub="Real results from real providers — rank + license gate applied in-app"
      right={
        result && (
          <span className="chip tnum">
            {result.count} results · {result.candidates.length} ranked · {result.elapsedMs}ms
          </span>
        )
      }
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch(query)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/35 px-2.5 py-1.5 text-[11.5px] text-bone outline-none placeholder:text-dim focus:border-ember/40"
          placeholder="Describe the audible phenomenon…"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as SoundRole)}
          className="rounded-lg border border-white/10 bg-black/35 px-2 py-1.5 text-[10.5px] text-ash outline-none"
        >
          {roles.map((r) => (
            <option key={r} value={r} className="bg-void">
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary px-2.5 py-1.5" onClick={() => doSearch(query)} disabled={busy}>
          {busy ? <Loader size={12} className="animate-spin" /> : <Search size={12} />} Search
        </button>
      </div>

      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <button className={`chip ${anchor === null ? 'border-brine/40 text-brine' : ''}`} onClick={() => setAnchor(null)}>
          @ playhead
        </button>
        {s && (
          <button
            className={`chip ${anchor !== null ? 'border-brine/40 text-brine' : ''}`}
            onClick={() => setAnchor(anchor === null ? studio.time : null)}
          >
            lock {tc(studio.time, true)}
          </button>
        )}
        <span className="chip">{role === 'ROOM_TONE' || role === 'DRONE' ? 'bed · long material preferred' : 'event · short material preferred'}</span>
        {result?.error && <span className="chip border-tan/40 text-tan">{result.error}</span>}
      </div>

      {busy && !candidates.length && (
        <div className="flex items-center gap-2 rounded-lg border border-orchid/30 bg-orchid/[0.06] px-3 py-4">
          <Loader size={13} className="animate-spin text-orchid" />
          <span className="text-[11px] text-ash">querying providers…</span>
        </div>
      )}

      {!candidates.length && !busy && (
        <div className="rounded-lg border border-dashed border-white/10 p-4 text-center">
          <p className="text-[11px] text-dim">No candidates yet. Search or run Auto Sound Design.</p>
          <p className="mt-1 text-[9.5px] text-dim/70">Tip: queries describe actual sounds — “wooden door hinge slow” beats “dark scary door”.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {visible.map((c, i) => (
          <CandidateRow
            key={`${c.asset.soundId}-${i}`}
            studio={studio}
            c={c}
            index={i}
            previewing={previewing}
            setPreviewing={setPreviewing}
          />
        ))}
      </div>

      {candidates.length > openCount && (
        <button className="btn mt-2 w-full px-2 py-1.5 text-[10.5px]" onClick={() => setOpenCount((n) => n + 8)}>
          Show more ({candidates.length - openCount} hidden)
        </button>
      )}

      {result && candidates.length > 0 && (
        <div className="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2">
          <span className="text-[9.5px] text-dim">CLAP rerank:</span>
          <span className={`chip ${result.clap === 'metadata' ? 'border-white/10 text-ash' : 'border-brine/40 text-brine'}`}>
            {result.clap === 'metadata' ? 'not installed — metadata ranking only' : result.clap}
          </span>
          <span className="ml-auto text-[9px] text-dim/70">MATCH is informational; CLAP never overrules you.</span>
        </div>
      )}
    </Panel>
  );
}

function CandidateRow({
  studio,
  c,
  index,
  previewing,
  setPreviewing,
}: {
  studio: Studio;
  c: RankedCandidate;
  index: number;
  previewing: string | null;
  setPreviewing: (v: string | null) => void;
}) {
  const a = c.asset;
  const isFav = studio.isFavorite(a);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const preview = async () => {
    setPreviewing(a.soundId);
    await studio.auditionAsset(a);
    setPreviewing(null);
  };

  const use = async () => {
    const intent = studio.retrieval.result?.intent;
    if (!intent) return;
    setBusy(true);
    // if this search came from FIND ALTERNATIVE, swap source in place
    if (intent.id.startsWith('alt-')) {
      const clipId = intent.id.slice(4);
      await studio.replaceClipSource(clipId, c);
    } else {
      const t = intent.time ?? studio.time;
      await studio.placeCandidate(intent, c, t);
    }
    setBusy(false);
  };

  return (
    <div
      className={`rounded-lg border transition-colors ${
        index === 0 && c.licenseOk ? 'border-brine/30 bg-brine/[0.04]' : 'border-white/[0.06] bg-black/25'
      }`}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button className="btn h-7 w-7 shrink-0 px-0 py-0" onClick={() => void preview()} title="Audition preview">
          {previewing === a.soundId ? <Loader size={11} className="animate-spin" /> : <Ear size={11} />}
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <span className="flex items-center gap-1.5">
            <span className="tnum text-[8.5px] text-dim">#{index + 1}</span>
            <span className="truncate text-[11.5px] font-medium text-bone">{a.title}</span>
          </span>
          <span className="mt-px flex flex-wrap items-center gap-1.5 text-[9px] text-dim">
            <span className="rounded-[3px] border border-white/10 px-1 py-px">{a.providerLabel}</span>
            <span className={`rounded-[3px] border px-1 py-px ${a.licenseClass === 'CC0' ? 'border-brine/50 text-brine' : a.licenseClass === 'CC_BY' ? 'border-orchid/50 text-orchid' : a.licenseClass === 'CC_BY_NC' ? 'border-tan/50 text-tan' : 'border-tan/50 text-tan'}`}>
              {LICENSE_CLASS_LABELS[a.licenseClass]} · {a.license}
            </span>
            <span className="tnum">{a.duration ? `${a.duration.toFixed(1)}s` : '—'}</span>
            {a.sampleRate ? <span className="tnum">{a.sampleRate / 1000} kHz</span> : null}
            {a.creator && <span>by {a.creator}</span>}
          </span>
        </button>
        <span
          className="tnum w-[44px] shrink-0 rounded-[4px] border px-1 py-0.5 text-center text-[11px] font-bold"
          style={{
            borderColor: c.match >= 0.75 ? 'rgba(75,143,154,0.55)' : 'rgba(185,163,126,0.5)',
            color: c.match >= 0.75 ? '#6fc1cd' : '#c9b283',
          }}
          title={c.signals.map((sg) => `${sg.label}: ${sg.value}`).join('\n')}
        >
          {Math.round(c.match * 100)}%
        </span>
        <button className={`rounded p-1 ${isFav ? 'text-amber-300' : 'text-dim hover:text-amber-200'}`} onClick={() => studio.toggleFavorite(a)} title="Favorite">
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
        <a className="rounded p-1 text-dim hover:text-bone" href={a.sourceUrl} target="_blank" rel="noreferrer" title="Open source page">
          <ExternalLink size={12} />
        </a>
        <button className={`btn px-2 py-1 text-[10px] ${!c.licenseOk ? 'opacity-45' : ''}`} disabled={busy || !c.licenseOk} onClick={() => void use()} title={c.licenseReason ?? 'Place at intent time'}>
          {busy ? <Loader size={10} className="animate-spin" /> : <Play size={10} />} USE
        </button>
      </div>

      {open && (
        <div className="border-t border-white/[0.05] bg-black/30 px-2.5 py-2">
          {c.licenseOk ? (
            <p className="mb-1.5 text-[9.5px] text-brine/80">
              ✓ allowed by policy · {a.attributionRequired ? 'attribution required (auto-added to credits)' : 'no attribution required'}
            </p>
          ) : (
            <p className="mb-1.5 text-[9.5px] text-tan">✕ {c.licenseReason} — visible for inspection, never auto-placed.</p>
          )}
          <p className="mb-1 text-[9.5px] leading-relaxed text-dim">{a.description ?? 'No description returned.'}</p>
          <p className="tnum mb-1 text-[9px] text-dim">id {a.soundId} · retrieved {new Date(a.retrievedAt).toLocaleString()} · {a.type ?? '?'} · {a.channels ?? '?'}ch {a.fileSize ? `· ${bytes(a.fileSize)}` : ''}</p>
          <p className="mb-1.5 text-[9px] text-dim">credit: {a.creditLine}</p>
          <div className="flex flex-wrap gap-1">
            {c.signals.slice(0, 6).map((sg) => (
              <span key={sg.label} className="chip text-[8.5px]">
                {sg.label} {sg.value} × {sg.weight}
              </span>
            ))}
          </div>
          <button className="btn mt-1.5 px-2 py-1 text-[9.5px]" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- providers -- */

function ProviderCards({ studio }: { studio: Studio }) {
  const list = useMemo<ProviderStatus[]>(() => studio.providerStatuses(), [studio]);

  const caps = (s: ProviderStatus) =>
    [
      s.capabilities.search ? 'Search: YES' : s.capabilities.assistedSearch ? 'Search via Umbra: NO · Assisted: YES' : 'Search: NO',
      s.capabilities.preview ? 'Preview: YES' : 'Preview: NO',
      s.capabilities.download === 'oauth' ? 'Original quality: OAuth required' : s.capabilities.download === 'local' ? 'Automatic acquisition: LOCAL' : 'Automatic acquisition: NO',
      s.capabilities.manualImport ? 'Manual import: YES' : '',
      s.capabilities.similarity ? 'Similar sounds: YES' : 'Similar sounds: NO',
      s.capabilities.audioFeatures ? 'Audio features: YES' : '',
    ].filter(Boolean);

  return (
    <Panel title="Providers" sub="truthful capability reporting">
      <div className="flex flex-col gap-2">
        {list.map((s) => (
          <div key={s.provider} className="rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.ready ? '#4b8f9a' : '#7a5b46', boxShadow: `0 0 6px ${s.ready ? '#4b8f9a88' : '#7a5b4688'}` }} />
              <span className="text-[11.5px] font-medium text-bone">{s.label}</span>
              {s.provider === 'freesound' && (
                <span className="chip ml-auto border-white/10 text-[8.5px]">
                  {studio.creds.apiToken ? <Lock size={8} /> : <X size={8} />} token {studio.creds.apiToken ? 'set' : 'missing'}
                </span>
              )}
            </div>
            <p className="mt-1 text-[9.5px] leading-relaxed text-dim">{s.reason}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {caps(s).map((c) => (
                <span key={c} className="chip text-[8px]">
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------ pixabay assisted -- */

function PixabayAssisted({ studio }: { studio: Studio }) {
  const [phrase, setPhrase] = useState('old wooden door creak');
  const open = () => {
    const u = new URL('https://pixabay.com/sound-effects/');
    u.searchParams.set('search', phrase);
    window.open(u.toString(), '_blank', 'noopener');
  };
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFile = async (f: File | null) => {
    if (!f) return;
    setImporting(true);
    await studio.importUserAudio(f, {
      role: 'foley',
      tags: phrase.split(/\s+/),
      license: 'Pixabay Content License',
      licenseClass: 'OTHER',
      creator: 'Imported',
      sourceUrl: `https://pixabay.com/sound-effects/`,
      note: 'Pixabay assisted import — confirm license on asset page',
    });
    setImporting(false);
  };

  return (
    <Panel title="Pixabay Assisted" sub="no scraping · no undocumented endpoints · official/terms-respecting path only">
      <p className="mb-2 text-[10px] leading-relaxed text-dim">
        Pixabay's public API does not expose sound-effects search, so Umbra does not pretend to. It opens Pixabay's own search for
        your phrase; after you download the file, import it here — Umbra adds it to your user library (offline-available), ready to
        place like any other clip.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/35 px-2.5 py-1.5 text-[11px] text-bone outline-none focus:border-ember/40"
          placeholder="search phrase"
        />
        <button className="btn px-2.5 py-1.5" onClick={open}>
          <ExternalLink size={11} /> Search Pixabay
        </button>
        <button className="btn px-2.5 py-1.5" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? <Loader size={11} className="animate-spin" /> : <Upload size={11} />} Import downloaded file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-dim/80">license note: {`Pixabay Content License — no attribution required, but check the asset page and do not redistribute unmodified copies.`}</p>
    </Panel>
  );
}

/* -------------------------------------------------- provenance ------ */

function ProvenanceLedger({ studio }: { studio: Studio }) {
  const [entries, setEntries] = useState<{ id: string; clipId: string; usedAt: number; asset: LibraryAsset; role: string }[]>([]);
  const load = useCallback(() => {
    provenanceStore.list().then((all) => {
      const clipIds = new Set(studio.project?.clips.map((c) => c.id) ?? []);
      setEntries(all.filter((e) => clipIds.has(e.clipId)).sort((a, b) => a.usedAt - b.usedAt));
    });
  }, [studio.project?.clips]);

  useEffect(load, [load]);

  return (
    <Panel
      title="Asset Provenance Ledger"
      sub={`${entries.length} external sound(s) in this project`}
      right={
        <div className="flex gap-1">
          <button className="btn px-2 py-1 text-[9.5px]" onClick={() => void studio.exportCredits('txt')} title="Export sound_credits.txt">
            <FileText size={10} /> .txt
          </button>
          <button className="btn px-2 py-1 text-[9.5px]" onClick={() => void studio.exportCredits('json')} title="Export sound_credits.json">
            <FileJson size={10} /> .json
          </button>
        </div>
      }
    >
      <div className="max-h-[280px] overflow-y-auto">
        {entries.length === 0 && <p className="py-3 text-center text-[10.5px] text-dim">No external assets used yet.</p>}
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.07] text-[8px] uppercase tracking-wider text-dim">
              <th className="py-1 pr-2 font-medium">Source</th>
              <th className="py-1 pr-2 font-medium">Title</th>
              <th className="py-1 pr-2 font-medium">Creator</th>
              <th className="py-1 pr-2 font-medium">ID</th>
              <th className="py-1 pr-2 font-medium">License</th>
              <th className="py-1 font-medium">Used at</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-white/[0.04] text-[9.5px] last:border-0">
                <td className="py-1 pr-2 text-ash">{e.asset.providerLabel}</td>
                <td className="max-w-[130px] truncate py-1 pr-2 text-bone" title={e.asset.creditLine}>
                  {e.asset.title}
                </td>
                <td className="py-1 pr-2 text-ash">{e.asset.creator}</td>
                <td className="tnum py-1 pr-2 text-dim">{e.asset.soundId}</td>
                <td className="py-1 pr-2 text-orchid/90">{e.asset.license}</td>
                <td className="tnum py-1 text-ash">{tc(e.usedAt, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length > 0 && (
        <p className="mt-2 border-t border-white/[0.06] pt-2 text-[9px] leading-relaxed text-dim/80">
          Attribution preserved per source metadata. Exports include source URL, retrieval date, quality and MD5.
        </p>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------- cache -- */

function CachePanel({ studio }: { studio: Studio }) {
  const [recs, setRecs] = useState<{ key: string; size: number; title: string; provider: string; addedAt: number }[]>([]);
  const [total, setTotal] = useState(0);
  const load = useCallback(() => {
    void soundCache.list().then((all) => {
      setTotal(all.reduce((a, r) => a + r.blob.size, 0));
      setRecs(all.map((r) => ({ key: r.cacheKey, size: r.blob.size, title: r.asset.title, provider: r.asset.providerLabel, addedAt: r.addedAt })));
    });
  }, []);
  useEffect(load, [load]);

  return (
    <Panel title="Audio Cache" sub={`${recs.length} asset(s) · ${bytes(total)} — selected sounds only`} right={
      <button className="btn px-2 py-1 text-[9.5px]" onClick={() => void studio.clearUnusedCache()} title="Removes cache entries not referenced by the open project">
        <Trash2 size={10} /> Clear unused
      </button>
    }>
      <div className="max-h-[220px] overflow-y-auto">
        {recs.length === 0 && <p className="py-3 text-center text-[10.5px] text-dim">Cache empty. Sounds are cached when you audition or use them.</p>}
        {recs.map((r) => (
          <div key={r.key} className="flex items-center gap-2 border-b border-white/[0.04] py-1 last:border-0">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brine/70" />
            <span className="min-w-0 flex-1 truncate text-[10px] text-ash">{r.title}</span>
            <span className="shrink-0 text-[8.5px] text-dim">{r.provider}</span>
            <span className="tnum shrink-0 text-[9px] text-dim">{bytes(r.size)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default LibraryView;
