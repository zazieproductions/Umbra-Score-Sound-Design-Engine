# Freesound integration (server-side credential)

> **Goal:**
> `local .env secret → Umbra FastAPI backend → official Freesound API →
> existing retrieval/ranking system → timeline`

Freesound's API key is a **server-side secret**. It is read by the Python
backend from the environment and used only on requests to
`freesound.org/apiv2`. The browser never holds it, never sees it, and never
calls Freesound directly.

```
 ┌─ browser ─────────────┐   ┌─ Umbra backend ───────────┐   ┌─ freesound.org ─┐
 │ retrieval pipeline    │   │ FREESOUND_API_KEY (.env)  │   │  APIv2          │
 │ plan → rank → gate    │──►│ /api/integrations/        │──►│  Authorization: │
 │ → AudioClip           │   │   freesound/*             │   │  Token <key>    │
 │  (no credential here) │◄──│ maps + proxies metadata   │◄──│                 │
 └───────────────────────┘   └───────────────────────────┘   └─────────────────┘
        "configured / connected" only
```

* Backend client: `backend/integrations/freesound.py`
* HTTP surface: `backend/integrations/router.py` (mounted in `backend/app.py`)
* Browser client: `src/lib/library/freesoundBackend.ts`
* Provider (transport only): `src/lib/library/freesound.ts` — mapping,
  ranking, license gate, provenance and clip construction are untouched.

---

## 1 · Create your `.env`

From the repository root:

```bash
cp .env.example .env
```

Then edit `.env` and set your key (the **"Client secret / Api key"** shown for
your app at <https://freesound.org/apiv2/apply>):

```dotenv
FREESOUND_API_KEY=your-freesound-client-secret
```

Optional — original-quality downloads only (Freesound requires OAuth2 for them;
previews do not need it):

```dotenv
FREESOUND_OAUTH_TOKEN=your-oauth2-access-token
```

`.env.example` lists the **variable names** and no values. `.env` is
**git-ignored** (`.gitignore` lines: `.env`, `.env.*`, `!.env.example`).

> ### ⚠️ Never commit credentials
>
> * Never commit `.env`, never paste a real key into a PR, issue, commit
>   message, screenshot, test fixture, log or chat.
> * Never put a secret in a `VITE_`-prefixed variable — `VITE_*` is inlined
>   into the browser bundle and shipped to every visitor.
> * If a key is ever exposed, **revoke/rotate it first** at
>   <https://freesound.org/apiv2/apply>, then put the new one in `.env`.
> * To confirm Git cannot see your file: `git check-ignore -v .env`.

The key is loaded by `backend/env.py` (a tiny dependency-free reader) when the
backend starts. Variables already set in your shell always win over the file.

---

## 2 · Start frontend + backend

Two terminals, from the repository root.

**Backend** (Python 3.11 / 3.12):

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py        # http://127.0.0.1:8000
```

Startup logs tell you the truth without ever printing the key:

```
freesound integration: key configured
freesound integration: NOT configured (set FREESOUND_API_KEY in .env to enable retrieval)
```

**Frontend:**

```bash
npm install
npm run dev                                    # http://localhost:5173
```

Vite proxies `/api/*` to the backend, so the browser only ever talks to its own
origin. Add or change the key and **restart the backend** (the environment is
read at startup).

---

## 3 · Verify Freesound

Configuration + a real connection check (the backend asks Freesound whether the
key is accepted):

```bash
curl -s http://127.0.0.1:8000/api/integrations/freesound/status | python3 -m json.tool
```

Through the browser origin (proves the Vite proxy):

```bash
curl -s http://localhost:5173/api/integrations/freesound/status | python3 -m json.tool
```

Reading the answer:

Nothing derived from the key is ever published — not the value, not a hash or
fingerprint, not even its length. The status payload carries `configured`,
`connected` and `keySource` (which environment variable it came from) and
nothing more.

| `configured` | `connected` | Meaning |
| --- | --- | --- |
| `false` | `null` | No key in the backend environment — add `FREESOUND_API_KEY` to `.env` and restart. |
| `true` | `true` | Key accepted. Search + preview work. |
| `true` | `false` | Freesound **rejected** the key (`reason` carries the upstream message). Rotate/fix the key. |
| `true` | `null` | Unknown — Freesound unreachable or not probed yet. Not claimed as working. |

`probe` control: `?probe=always` forces a live check, `?probe=never` reports
configuration only, `?probe=auto` (default) reuses a 60-second cache.

A real search (the same call the UI makes):

```bash
curl -s -X POST http://127.0.0.1:8000/api/integrations/freesound/search \
     -H 'Content-Type: application/json' \
     -d '{"query":"wooden door creak","page":1,"pageSize":5,"filters":["duration:[0 TO 3]"]}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['count'], [(s['id'], s['name'], s['username'], s['license']) for s in d['sounds']])"
```

Preview bytes (proxied, so the browser needs no key):

```bash
curl -sI http://127.0.0.1:8000/api/integrations/freesound/sounds/9201/preview
# 200 · content-type: audio/mpeg · X-Umbra-Quality: preview
```

Original quality (needs an OAuth2 token on the server):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
     http://127.0.0.1:8000/api/integrations/freesound/sounds/9201/download
# 200 with FREESOUND_OAUTH_TOKEN set · 501 oauth_required without it
```

In the app: **Library → Settings → Sound Libraries → Freesound** shows the same
state and has a **Re-test** button. There is deliberately no key input field —
a browser field could not keep the key safe.

Other endpoints: `GET /sounds/{id}` (metadata), `GET /sounds/{id}/similar`
(laion_clap similarity), `GET /sounds/{id}/analysis` (feature descriptors).
`GET /api/health` reports `integrations.freesound.configured` (never a value).

---

## 4 · Failure behaviour (no silent substitution)

| Situation | What happens |
| --- | --- |
| No key | `503 not_configured` + hint to set `FREESOUND_API_KEY`; search returns **no** candidates and an explicit error. |
| Invalid/revoked key | `502 unauthorized` with the upstream message; status reports `connected: false`. |
| Rate limited | `429 rate_limited` with the upstream message. |
| Freesound unreachable / timeout | `502 upstream_unreachable` / `504 timeout`; status reports `connected: null` (unknown), never "connected". |
| Original download without OAuth2 | `501 oauth_required` — never a preview dressed up as an original. |
| Backend not running | The provider reports "backend is not running" and returns zero candidates. |

No code path fabricates, caches-stale-substitutes or falls back to demo audio.

---

## 5 · What was verified — and what was not

**Runtime-verified in the integration environment (mocked upstream):**

* backend starts with and without `FREESOUND_API_KEY`;
* `GET /api/integrations/freesound/status` returns `configured: true /
  connected: true` against a live HTTP Freesound stand-in, and
  `connected: false` for a wrong key, `configured: false` with no key;
* search, metadata, similar, preview-proxy and the `501 oauth_required`
  download path all exercised end to end through the backend **and** through
  the Vite dev-server proxy (browser origin);
* frontend dev server + production build both start; no secret value appears in
  the built bundle (only the variable *name* in on-screen instructions);
* `.env` is ignored by Git (`git check-ignore -v .env`).

**NOT runtime-verified here:**

* a request to the **real** `freesound.org` — outbound TLS to that host is
  blocked in the sandbox used for this change, so "the key works against
  production Freesound" is unverified. Run §3 on your machine: a `200` from
  `/status` with `connected: true` is the proof.

**Automated (mocked) coverage:**

* `backend/tests/test_freesound_integration.py` — 21 tests: env loading,
  status/config/rejection/unreachable, authenticated search, metadata, similar,
  analysis, preview proxy + SSRF host guard, OAuth-required download, error
  mapping, and an assertion that the key never appears in a response or log.
* `tests/freesound.backend.test.ts` — 12 tests: browser-side routing, no
  credential in any request or in localStorage, honest failure states, legacy
  credential purge.
* `tests/library.acceptance.test.ts` — 19 tests, unchanged in intent; the
  Freesound seam is now the backend instead of `freesound.org`.
