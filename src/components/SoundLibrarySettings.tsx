import { useMemo, useState } from 'react';
import { ExternalLink, KeyRound, Lock, RefreshCw, Server, Shield, Unlock } from 'lucide-react';
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

export function FreesoundSettings({ studio }: { studio: Studio }) {
  const c = studio.creds;
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState(c.apiToken);
  const [clientId, setClientId] = useState(c.clientId);
  const [clientSecret, setClientSecret] = useState(c.clientSecret);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const tokenOk = c.apiToken.trim().length > 0;
  const oauthOk = c.accessToken.trim().length > 0 && c.expiresAt > nowTick;
  const u = c.redirectUri || (typeof location !== 'undefined' ? location.origin : 'http://localhost:5173');
  const oauthHrs = useMemo(() => Math.max(0, Math.round((c.expiresAt - nowTick) / 3600000)), [c.expiresAt, nowTick]);

  const saveToken = () => {
    studio.saveCreds({ apiToken: token.trim() });
    setNowTick(Date.now());
    setMsg(token.trim() ? 'API token saved locally. Search + preview workflow unlocked.' : 'Token cleared. Preview workflow disabled.');
  };

  const saveOAuth = () => {
    studio.saveCreds({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri: u });
    setMsg('OAuth2 application credentials saved locally.');
  };

  const authorize = () => {
    const state = Math.random().toString(36).slice(2);
    let url = `https://freesound.org/apiv2/oauth2/authorize/?client_id=${encodeURIComponent(clientId)}&response_type=code&state=${state}`;
    // Freesound needs a registered redirect_uri; if user gave none, use the
    // API-app redirect URL as printed on freesound.org/apiv2/apply
    url += `&redirect_uri=${encodeURIComponent(u)}`;
    window.open(url, '_blank', 'noopener');
  };

  const exchange = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      });
      const res = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body });
      if (!res.ok) throw new Error(`exchange failed ${res.status}`);
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      studio.saveCreds({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 });
      setNowTick(Date.now());
      setCode('');
      setMsg('Access token exchanged. Original-quality downloads enabled for 24h.');
      logAuth(studio, `freesound oauth2: access token acquired (${j.expires_in}s)`, 'ok');
    } catch (e) {
      setMsg((e as Error).message);
      logAuth(studio, `freesound oauth2: ${(e as Error).message}`, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!c.refreshToken) return;
    setBusy(true);
    try {
      const body = new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: c.refreshToken,
      });
      const res = await fetch('https://freesound.org/apiv2/oauth2/access_token/', { method: 'POST', body });
      if (!res.ok) throw new Error(`refresh failed ${res.status}`);
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
      studio.saveCreds({ accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 });
      setNowTick(Date.now());
      setMsg('Access token refreshed.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Sound Libraries → Freesound"
      sub="official APIv2 · token for search/preview · OAuth2 only for original quality"
      right={
        <span className={`chip ${tokenOk ? 'border-brine/40 text-brine' : 'border-tan/40 text-tan'}`}>
          {tokenOk ? 'token ready' : 'no token'}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <KeyRound size={12} className="text-orchid" />
            <span className="text-[11px] font-medium text-bone">Level 1 · API token</span>
            <span className="ml-auto flex gap-1">
              <button className="btn px-1.5 py-1 text-[9px]" onClick={() => setShowToken((s) => !s)} title={showToken ? 'Hide' : 'Show'}>
                {showToken ? <Unlock size={10} /> : <Lock size={10} />}
              </button>
              <button className="btn px-1.5 py-1 text-[9px]" onClick={saveToken}>
                Save
              </button>
            </span>
          </div>
          <p className="mb-1.5 text-[9.5px] leading-relaxed text-dim">
            Enables search, metadata and preview retrieval. Stored in your browser's local storage only — never in Git, never uploaded.
          </p>
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="your Freesound API token (Client secret/Api key)"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-bone outline-none focus:border-ember/40"
            autoComplete="off"
          />
        </div>

        <div className="rounded-lg border border-white/[0.07] bg-black/25 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Server size={12} className="text-ember" />
            <span className="text-[11px] font-medium text-bone">Level 2 · OAuth2 (original quality)</span>
            <span className={`chip ml-auto ${oauthOk ? 'border-brine/40 text-brine' : 'border-white/10 text-dim'}`}>
              {oauthOk ? `bearer ${oauthHrs}h` : 'not connected'}
            </span>
          </div>
          <p className="mb-1.5 text-[9.5px] leading-relaxed text-dim">
            Only for original-quality downloads — the API requires OAuth2 for <span className="text-ash">/sound/&lt;id&gt;/download/</span>.
            The preview workflow stays fully useful without it. Credentials: your Freesound API app's client id/secret (created at
            freesound.org/apiv2/apply), redirect URI must match.
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="client id" className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40" autoComplete="off" />
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="client secret (local only)" type="password" className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40" autoComplete="off" />
            <input value={u} onChange={(e) => studio.saveCreds({ redirectUri: e.target.value })} placeholder="redirect url" className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10.5px] text-bone outline-none focus:border-ember/40 sm:col-span-2" autoComplete="off" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button className="btn px-2 py-1 text-[10px]" onClick={authorize} disabled={!clientId}>
              <ExternalLink size={10} /> Authorize on Freesound
            </button>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste authorization code"
              className="min-w-[150px] flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-[10.5px] text-bone outline-none focus:border-ember/40"
              autoComplete="off"
            />
            <button className="btn px-2 py-1 text-[10px]" onClick={() => void exchange()} disabled={busy || !code}>
              {busy ? <RefreshCw size={10} className="animate-spin" /> : <KeyRound size={10} />} Exchange
            </button>
            <button className="btn px-2 py-1 text-[10px]" onClick={() => void refresh()} disabled={busy || !c.refreshToken} title="Use stored refresh token">
              <RefreshCw size={10} /> Refresh
            </button>
            <button className="btn px-2 py-1 text-[10px]" onClick={saveOAuth}>
              Save
            </button>
          </div>
          {msg && <p className="mt-1.5 text-[9.5px] text-dim">{msg}</p>}
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-brine/20 bg-brine/[0.05] p-2">
          <Shield size={12} className="mt-px shrink-0 text-brine" />
          <p className="text-[9.5px] leading-relaxed text-dim">
            Preview ≠ original. The candidate browser plainly labels every asset PREVIEW until an OAuth2 original is fetched; the
            ledger records the actual quality.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function logAuth(studio: Studio, text: string, level: 'info' | 'ok' | 'warn' = 'info') {
  studio.log(text, level);
}
