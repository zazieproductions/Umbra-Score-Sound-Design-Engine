# Freesound integration — LIVE acceptance test (real account, real API)

> **Status: NOT YET EXECUTED.** This is the manual gate that proves the
> backend-managed Freesound integration against the real freesound.org with a
> real account. Mocked CI tests (`backend/tests/test_freesound_integration.py`,
> `tests/freesound.security.test.ts`) prove the security properties
> deterministically; they never prove the live API works, and runtime
> verification must never be claimed from them. The development sandbox used
> to build this feature had no egress route to freesound.org, so every step
> below still needs a machine with normal internet access.

## Preconditions

1. A Freesound account and an API application
   (https://freesound.org/apiv2/apply). For the *Umbra Score Sound Design
   Engine* app, note the **Client ID** and the **Api key / Client secret**.
2. In the Freesound app settings, register a **redirect URI** matching where
   you run Umbra, e.g. `http://localhost:5173/` for the dev server.
3. A generated encryption key (one-time, then keep it in your shell profile
   or secret manager — never in Git):

   ```bash
   python -m backend.services.credentials generate-key
   ```

   Either `export UMBRA_CREDENTIAL_ENCRYPTION_KEY=…` or put it in a local
   `.env` file (git-ignored; the backend loads it automatically).

## Run the stack

```bash
# terminal 1 — backend (owns the credentials)
python scripts/run_backend.py

# terminal 2 — frontend
npm run dev
```

## The test

Perform each step and tick it. Every step must actually pass — if any fails,
the integration is **not** runtime-verified, and the failure text from the UI
is the bug report.

- [ ] **1. Configure the credential.** Settings → Sound Libraries → Freesound
  → *Configure*: paste the API key (and client id / secret / redirect URL for
  OAuth). Click **Save to backend**.
  - The inputs clear immediately after saving and never redisplay the value.
  - Status chip shows `CONFIGURED`, then runs the connection test.
- [ ] **2. Backend reports SEARCH READY.** After **Test Connection** succeeds
  (a real authenticated request to freesound.org), the chip shows
  `SEARCH READY` with a "verified …" timestamp.
- [ ] **3. Search "metal door creak".** In the Library view, search
  `metal door creak`. **Real Freesound results** appear (names, creators,
  durations, license badges).
- [ ] **4. Preview loads.** Audition a result — the preview MP3/OGG plays.
- [ ] **5. Provenance + license preserved.** The candidate (and the placed
  clip / credits ledger) shows creator, source URL and the actual license
  class from Freesound (e.g. CC0 / CC BY). The candidate is labeled PREVIEW.
- [ ] **6. Place on timeline.** Place the sound at a spotting event. It
  becomes a normal editable `AudioClip` (move / trim / fade / gain / pan).
- [ ] **7. Playback works.** Monitor playback includes the clip.
- [ ] **8. Export works.** Export the project (master and/or stems); the
  rendered audio contains the clip; the delivery manifest / cue sheet /
  credits include its attribution line.
- [ ] **9. OAuth original-quality retrieval works.** Click **Reconnect**,
  approve access on freesound.org, return to Umbra. Status shows
  `OAUTH READY` (and the connected username). Fetch an original-quality
  version of a placed sound — the clip quality in the ledger flips to
  `original`, the file is the full-quality download.
- [ ] **10. Token lifecycle.** (Optional, or simulate by waiting ~24h / using
  an expired token) — the chip shows `TOKEN EXPIRED`, **Refresh token**
  restores `OAUTH READY` without re-authorization.
- [ ] **11. Credentials never appear in browser devtools.** With devtools
  open (Network + Application + console): the API key appears exactly once,
  in the one-time `POST /api/integrations/freesound/configure` request body.
  It never appears in localStorage, IndexedDB, sessionStorage, any other
  request URL/body/header, any console line, or any rendered UI.
- [ ] **12. Disconnect.** Click **Disconnect** — status returns to
  `NOT CONFIGURED`; Freesound search now reports an honest "not configured"
  error; the vault row is gone
  (`sqlite3 .umbra/integrations.db 'select count(*) from integration_credentials'`
  → 0).

## What "verified" means here

`lastVerifiedAt` / `verification: "verified"` are written **only** when
freesound.org returned a successful authenticated response during step 2 (or
any later **Test Connection**). Existence of a stored key never counts.

After running, record the result (date, machine, Freesound account name) in
`docs/ai/CURRENT_STATE.md` — only then may the integration be described as
runtime-verified.
