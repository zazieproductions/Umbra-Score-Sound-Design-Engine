import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { Studio } from '../lib/useStudio';
import { Panel } from './Views';
import type { LicenseClass, LicenseMode } from '../lib/library/types';
import { LICENSE_CLASS_LABELS } from '../lib/library/types';
import { freesoundLadder } from '../lib/library/freesoundBackend';
import type { FreesoundLadderLabel } from '../lib/library/freesoundBackend';

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

const LADDER_TONE: Record<FreesoundLadderLabel, string> = {
  'BACKEND OFFLINE': 'border-tan/40 text-tan',
  'NOT CONFIGURED': 'border-tan/40 text-tan',
  CONFIGURED: 'border-ember/40 text-ember',
  'SEARCH READY': 'border-brine/40 text-brine',
  'OAUTH READY': 'border-brine/40 text-brine',
  'TOKEN EXPIRED': 'border-ember/40 text-ember',
  ERROR: 'border-red-400/40 text-red-300',
};

const LADDER_ICON: Record<FreesoundLadderLabel, typeof Shield> = {
  'BACKEND OFFLINE': Server,
  'NOT CONFIGURED': Server,
  CONFIGURED: Shield,
  'SEARCH READY': ShieldCheck,
  'OAUTH READY': ShieldCheck,
  'TOKEN EXPIRED': ShieldAlert,
  ERROR: AlertTriangle,
};

export function FreesoundSettings({ studio }: { studio: Studio }) {
  const st = studio.freesoundStatus;
  const online = studio.freesoundOnline;
  const ladder = useMemo(() => freesoundLadder({ status: st, backendOnline: online }), [st, online]);
  const LadderIcon = LADDER_ICON[ladder.label];

  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(st.redirectUri ?? defaultOrigin());
  const [editing, setEditing] = useState(!st.configured);
  const [busy, setBusy] = useState<null | 'configure' | 'verify' | 'disconnect' | 'refresh'>(null);
  const [msg, setMsg] = useState<{ text: string; level: 'ok' | 'warn' } | null>(null);

  /** Clear every secret-bearing input — called the moment a submit resolves. */
  const clearSecretInputs = () => {
    setApiKey('');
    setClientSecret('');
    setClientId('');
  };

  const submit = async () => {
    const payload = {
      apiKey: apiKey.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      redirectUri: redirectUri.trim(),
    };
    const filled = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== ''));
    if (Object.keys(filled).length === 0) {
      setMsg({ text: 'Nothing entered — paste at least the API key.', level: 'warn' });
      return;
    }
    setBusy('configure');
    setMsg(null);
    try {
      await studio.configureFreesound(filled);
      // SECURITY: the secret existed in browser memory only between typing
      // and the one-time POST — clear it immediately, never redisplay it.
      clearSecretInputs();
      setEditing(false);
      setMsg({ text: 'Stored on the backend, encrypted at rest. Testing the connection…', level: 'ok' });
      // honest follow-up: configured ≠ working — verify for real
      try {
        const r = await studio.testFreesoundConnection();
        setMsg(
          r.verification.verified
            ? { text: `Verified — ${r.verification.checks.join('; ')}`, level: 'ok' }
            : { text: `Stored, but verification failed — ${r.verification.error ?? 'unknown error'}`, level: 'warn' },
        );
      } catch (e) {
        setMsg({ text: `Stored, but the connection test failed — ${(e as Error).message}`, level: 'warn' });
      }
    } catch (e) {
      clearSecretInputs();
      setMsg({ text: (e as Error).message, level: 'warn' });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setMsg(null);
    try {
      await studio.disconnectFreesound();
      setEditing(true);
      setMsg({ text: 'Disconnected — every stored Freesound secret was deleted from the backend.', level: 'ok' });
    } catch (e) {
      setMsg({ text: (e as Error).message, level: 'warn' });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setMsg(null);
    try {
      await studio.refreshFreesoundToken();
      setMsg({ text: 'Access token refreshed — original-quality downloads re-enabled.', level: 'ok' });
    } catch (e) {
      setMsg({ text: (e as Error).message, level: 'warn' });
    } finally {
      setBusy(null);
    }
  };

  // snapshot of "now" at panel mount — recomputed when the panel remounts,
  // keeping render pure (no Date.now() during render)
  const [nowTick] = useState(() => Date.now());
  const oauthHoursLeft = st.expiresAt ? Math.max(0, Math.round((st.expiresAt - nowTick) / 3600000)) : null;

  return (
    <Panel
      title="Sound Libraries → Freesound"
      sub="backend-managed integration · credentials live encrypted in the Umbra backend, never in this browser"
      right={
        <span className={`chip ${LADDER_TONE[ladder.label]}`}>
          <LadderIcon size={9} /> {ladder.label}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <p className="text-[9.5px] leading-relaxed text-dim">{ladder.detail}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[8.5px] text-dim">
            <span className="chip">
              <Server size={8} /> {online ? 'backend up' : 'backend down'}
            </span>
            <span className="chip">{st.storage === 'encrypted-db' ? 'AES-256-GCM vault' : st.storage === 'env' ? 'server env vars' : 'no storage'}</span>
            {st.lastVerifiedAt && (
              <span className="chip">
                <CheckCircle2 size={8} /> verified {new Date(st.lastVerifiedAt).toLocaleString()}
              </span>
            )}
            {st.user && <span className="chip">@{st.user}</span>}
            {oauthHoursLeft !== null && st.oauthAvailable && <span className="chip">bearer ~{oauthHoursLeft}h</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {st.configured && !editing && (
              <button className="btn px-2 py-1 text-[10px]" onClick={() => void studio.testFreesoundConnection()} disabled={busy !== null}>
                {busy === 'verify' ? <Loader2 size={10} className="animate-spin" /> : <PlugZap size={10} />} Test Connection
              </button>
            )}
            {st.configured && st.oauthConfigured && (
              <button className="btn px-2 py-1 text-[10px]" onClick={() => void studio.reconnectFreesound()} disabled={busy !== null}>
                <ExternalLink size={10} /> Reconnect
              </button>
            )}
            {st.tokenExpired && st.refreshable && (
              <button className="btn px-2 py-1 text-[10px]" onClick={() => void refresh()} disabled={busy !== null}>
                {busy === 'refresh' ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Refresh token
              </button>
            )}
            {st.configured && !editing && (
              <button className="btn px-2 py-1 text-[10px]" onClick={() => setEditing(true)} disabled={busy !== null}>
                <KeyRound size={10} /> Edit credentials
              </button>
            )}
            {st.configured && (
              <button
                className="btn ml-auto px-2 py-1 text-[10px] text-red-300/90"
                onClick={() => void disconnect()}
                disabled={busy !== null}
                title="Delete every stored Freesound secret from the backend"
              >
                {busy === 'disconnect' ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />} Disconnect
              </button>
            )}
          </div>
        </div>

        {online && editing && (
          <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <KeyRound size={12} className="text-orchid" />
              <span className="text-[11px] font-medium text-bone">Configure (one-time POST to the backend)</span>
            </div>
            <p className="mb-1.5 text-[9.5px] leading-relaxed text-dim">
              Values are sent once over the local backend connection, then exist only server-side — encrypted at
              rest with a key that never leaves the server environment. Inputs clear on save and are never
              redisplayed. Find the key at <span className="text-ash">freesound.org/apiv2/apply</span> (API key / client secret).
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={st.searchAvailable ? 'API key — stored (leave blank to keep)' : 'API key / client secret (required for search)'}
                className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40 sm:col-span-2"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="client id (for OAuth2 original quality)"
                className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="client secret (leave blank to keep)"
                className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                placeholder="redirect url (must match your Freesound app)"
                className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40 sm:col-span-2"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button className="btn px-2.5 py-1 text-[10px]" onClick={() => void submit()} disabled={busy !== null}>
                {busy === 'configure' ? <Loader2 size={10} className="animate-spin" /> : <Shield size={10} />} Save to backend
              </button>
              {st.configured && (
                <button className="btn px-2 py-1 text-[10px]" onClick={() => { setEditing(false); clearSecretInputs(); }} disabled={busy !== null}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {msg && <p className={`text-[9.5px] leading-relaxed ${msg.level === 'ok' ? 'text-brine' : 'text-ember'}`}>{msg.text}</p>}

        <div className="flex items-start gap-2 rounded-lg border border-brine/20 bg-brine/[0.05] p-2">
          <Shield size={12} className="mt-px shrink-0 text-brine" />
          <p className="text-[9.5px] leading-relaxed text-dim">
            Preview ≠ original. The candidate browser plainly labels every asset PREVIEW until an OAuth2 original is fetched; the
            ledger records the actual quality. Search and preview need only the API key; original-quality downloads use OAuth2
            and refresh automatically.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function defaultOrigin(): string {
  try {
    return typeof location !== 'undefined' ? location.origin : 'http://localhost:5173';
  } catch {
    return 'http://localhost:5173';
  }
}
