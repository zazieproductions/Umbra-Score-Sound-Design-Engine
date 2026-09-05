import { useState } from 'react';
import { KeyRound, Lock, RefreshCw, Server, Shield } from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { Panel } from './Views';
import type { LicenseClass, LicenseMode } from '../lib/library/types';
import { LICENSE_CLASS_LABELS } from '../lib/library/types';

/* ------------------------------------------------------ licensing ---- */

export function LicenseSettings({ studio }: { studio: Studio }) {
  const policy = studio.libSettings.licensePolicy;
  const modes: { id: LicenseMode; label: string; note: string }[] = [
    { id: 'strict', label: 'STRICT / PORTABLE', note: 'CC0 and attribution-licensed material only. Best for anything reusable.' },
    { id: 'personal', label: 'PERSONAL NONCOMMERCIAL', note: 'Adds compatible noncommercial (CC BY-NC) assets. Current project.' },
    { id: 'custom', label: 'CUSTOM', note: 'You choose accepted license classes below.' },
  ];
  const classes: LicenseClass[] = ['CC0', 'CC_BY', 'CC_BY_NC', 'OTHER'];

  return (
    <Panel title="Library Licensing" sub="hard gate — no license is ever inferred from file names">
      <div className="mb-2.5 flex flex-col gap-1.5">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`btn justify-start px-2.5 py-2 text-left text-[11px] leading-snug ${policy.mode === m.id ? 'border-brine/50 bg-brine/10 text-bone' : ''}`}
            onClick={() => studio.setLicensePolicy(m.id)}
          >
            <Shield size={12} className={policy.mode === m.id ? 'text-brine' : 'text-dim'} />
            <span>
              <span className="block">{m.label}</span>
              <span className="block text-[9px] font-normal text-dim">{m.note}</span>
            </span>
          </button>
        ))}
      </div>
      {policy.mode === 'custom' && (
        <div className="mb-2 flex flex-wrap gap-1.5 rounded-lg border border-white/[0.07] bg-black/25 p-2">
          {classes.map((c) => {
            const on = policy.accepted.includes(c);
            return (
              <button
                key={c}
                className={`chip ${on ? 'border-brine/50 text-brine' : 'border-white/10 text-dim'}`}
                onClick={() =>
                  studio.setLicensePolicy('custom', on ? policy.accepted.filter((x) => x !== c) : [...policy.accepted, c])
                }
              >
                {LICENSE_CLASS_LABELS[c]} {on ? '✓' : ''}
              </button>
            );
          })}
          <p className="w-full text-[9px] text-dim">Unknown licenses are always blocked — attribution metadata must come from the source.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9.5px] text-dim">Attribution on placement:</span>
        <span className="chip border-brine/40 text-brine">auto-ledger</span>
        <span className="chip">never flattened</span>
        <button className="btn ml-auto px-2 py-1 text-[9.5px]" onClick={() => void studio.exportCredits('json')}>
          test export
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------ freesound ---- */

/**
 * Freesound is configured on the SERVER, not in the browser.
 *
 * The API key lives in a git-ignored `.env` next to the repo root and is read
 * by the FastAPI backend (`FREESOUND_API_KEY`). The UI can only report the
 * state the backend reports: configured, connected (key accepted), rejected,
 * or unknown. No input field here can — or ever should — hold a credential.
 */
export function FreesoundSettings({ studio }: { studio: Studio }) {
  const conn = studio.freesoundConnection;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const recheck = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const status = await studio.refreshFreesoundStatus(true);
      setMsg(status.reason ?? (status.ready ? 'Freesound connection verified.' : 'Freesound is not ready.'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const state = !conn.loaded
    ? { label: 'checking…', tone: 'border-white/10 text-dim' }
    : conn.configured && conn.connected
      ? { label: 'connected', tone: 'border-brine/40 text-brine' }
      : conn.configured && conn.connected === false
        ? { label: 'key rejected', tone: 'border-tan/40 text-tan' }
        : conn.configured
          ? { label: 'configured · not checked', tone: 'border-tan/40 text-tan' }
          : { label: 'not configured', tone: 'border-tan/40 text-tan' };

  return (
    <Panel
      title="Sound Libraries → Freesound"
      sub="official APIv2 · key held by the local backend · search + preview"
      right={<span className={`chip ${state.tone}`}>{state.label}</span>}
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <KeyRound size={12} className="text-orchid" />
            <span className="text-[11px] font-medium text-bone">Server-side credential</span>
            <button className="btn ml-auto px-1.5 py-1 text-[9px]" onClick={() => void recheck()} disabled={busy}>
              <RefreshCw size={10} className={busy ? 'animate-spin' : ''} /> Re-test
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[9.5px] leading-relaxed">
            <dt className="text-dim">key</dt>
            <dd className="text-ash">
              {conn.configured ? (
                <span className="text-bone">set on the backend ({conn.keySource ?? 'environment'})</span>
              ) : (
                <span className="text-tan">missing — add FREESOUND_API_KEY to .env</span>
              )}
            </dd>
            <dt className="text-dim">quality</dt>
            <dd className="text-ash">
              {conn.quality === 'original'
                ? 'preview + original (OAuth2 token present)'
                : 'preview only — original needs FREESOUND_OAUTH_TOKEN'}
            </dd>
            <dt className="text-dim">route</dt>
            <dd className="text-ash">browser → /api/integrations/freesound → Umbra backend → freesound.org</dd>
          </dl>
          {conn.reason && <p className="mt-1.5 text-[9.5px] leading-relaxed text-dim">{conn.reason}</p>}
          {msg && <p className="mt-1.5 text-[9.5px] leading-relaxed text-dim">{msg}</p>}
        </div>

        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Server size={12} className="text-ember" />
            <span className="text-[11px] font-medium text-bone">Add your key (once, locally)</span>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[9.5px] leading-relaxed text-ash">
            {`cp .env.example .env
# then edit .env:
FREESOUND_API_KEY=your-freesound-client-secret
# restart the backend, then click Re-test`}
          </pre>
          <p className="mt-1.5 text-[9.5px] leading-relaxed text-dim">
            Create the credential at freesound.org/apiv2/apply (the “Client secret/Api key” is the one Umbra uses).
            Full walkthrough and verification commands:{' '}
            <span className="text-bone">docs/development/FREESOUND.md</span>.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-brine/20 bg-brine/[0.05] p-2">
          <Shield size={12} className="mt-px shrink-0 text-brine" />
          <p className="text-[9.5px] leading-relaxed text-dim">
            <span className="text-bone">Never commit .env or a real key</span> — not to Git, not to a PR, an issue, a
            screenshot or a test fixture. <span className="text-bone">.env is git-ignored</span>; only
            <span className="text-bone"> .env.example</span> (names, no values) belongs in the repo. The key is never sent
            to this browser: it stays in the backend process and is used only on server-side requests to Freesound.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-white/[0.07] bg-black/25 p-2">
          <Lock size={12} className="mt-px shrink-0 text-dim" />
          <p className="text-[9.5px] leading-relaxed text-dim">
            Preview ≠ original. Candidates are labelled PREVIEW until an OAuth2 original is fetched from the server; the
            ledger records the actual quality. Nothing here substitutes demo or placeholder audio when Freesound is
            unavailable — the search reports the failure instead.
          </p>
        </div>
      </div>
    </Panel>
  );
}

