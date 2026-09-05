# ADR-0006: Freesound credentials are backend-managed and encrypted at rest

- **Status:** Accepted
- **Date:** 2026-09

## Context

Freesound retrieval originally kept the API token, OAuth client secret and
tokens in the browser (localStorage + React state) and called freesound.org
directly from the page. That puts a long-lived secret in the least defensible
place we have: it survives in browser storage, shows up in devtools state and
network panels, can leak into query strings, and cannot be revoked without
user action. The task also demanded honest runtime status: "a key exists" must
never be presented as "the integration works".

## Decision

**The browser never holds a Freesound credential.** The integration becomes a
backend service:

```
browser ──► /api/integrations/freesound/*   safe status ladder + one-time configure POST
         ──► /api/library/freesound/*       retrieval (no credentials in the request)
backend ──► freesound.org/apiv2             API key / OAuth2 attached here, server-side
```

1. **Encrypted-at-rest vault** (`backend/services/credentials.py`). One row
   per provider in `.umbra/integrations.db`: `provider`, AES-256-GCM
   encrypted `payload`, `created_at`, `updated_at`, `last_verified_at`,
   `verification_status`, `verification_error`. The encryption key comes only
   from the server-side `UMBRA_CREDENTIAL_ENCRYPTION_KEY` environment
   variable (or secret manager) — never from the database, Git, or the
   browser. Obtaining the DB alone does not yield the secrets. No key
   configured → storing is refused (503); there is **no plaintext fallback**.
   A headless alternative supplies credentials via `UMBRA_FREESOUND_*` env
   vars (also server-only).
2. **Single server-side Freesound client**
   (`backend/services/freesound.py`) is the only code that uses the
   credentials. API key via `Authorization: Token` header (not a query
   parameter), OAuth2 exchange/refresh exclusively server-side, original-
   quality downloads proxied with automatic token refresh.
3. **Retrieval architecture unchanged.** The planner → provider search →
   license gate → ranking → CLAP rerank → cache → AudioClip pipeline stays in
   the frontend; only the provider's transport moved from freesound.org to
   `/api/library/freesound/*`. Asset mapping, licensing and provenance remain
   in one place (`src/lib/library/freesound.ts`).
4. **Honest status ladder.** `GET …/status` returns only safe fields
   (`configured`, `searchAvailable`, `oauthAvailable`, `tokenExpired`,
   `expiresAt`, `lastVerifiedAt`, `error`, …). `POST …/verify` makes a real
   authenticated request to freesound.org; `verified` is earned only by a
   successful real response. OAuth failures surface actionable errors — an
   original-quality request never silently downgrades.
5. **OAuth2 CSRF protection.** State values are cryptographically random,
   validated server-side, expire in 10 minutes and are single-use.
6. **Secret hygiene everywhere else.** Secrets are redacted at error
   construction and again by a root-handler log filter; status/configure/
   verify responses are pinned secret-free by tests on both sides of the
   wire; the settings UI clears secret inputs the moment a submit resolves
   and never redisplays stored values; a one-time purge removes the legacy
   localStorage key older versions wrote.

## Consequences

- Freesound search now requires the local backend to be running (procedural
  and user-library retrieval still work without it, and the UI says so
  honestly).
- Losing `UMBRA_CREDENTIAL_ENCRYPTION_KEY` makes stored credentials
  unrecoverable — they must be re-entered.
- CI never proves the live API works: mocked-HTTP security tests and the
  documented manual live-acceptance gate
  (`docs/development/FREESOUND_LIVE_ACCEPTANCE.md`) are explicitly separate
  things.
