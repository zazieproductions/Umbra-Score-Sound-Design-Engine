"""UMBRA · backend-managed Freesound integration — security + behavior tests.

Every Freesound HTTP response here is a controlled mock (httpx.MockTransport).
These tests prove the *security properties* of the integration deterministically
in CI:

  1.  credentials can be stored and retrieved server-side
  2.  the raw database value is never plaintext
  3.  the status API never returns secret fields
  4.  application logs redact the API key
  5.  (frontend persistence — pinned by tests/freesound.security.test.ts)
  6.  search uses backend-side authentication
  7.  invalid credentials return honest failures
  8.  OAuth state cannot be reused (and expires)
  9.  expired access tokens refresh automatically
  10. disconnect deletes stored secrets
  11. provenance/license metadata passes through unmodified
  12. (retrieval/ranking compatibility — the frontend acceptance suite)

They deliberately do NOT prove the live Freesound API works — that is the
documented manual live-acceptance gate
(docs/development/FREESOUND_LIVE_ACCEPTANCE.md) and must never be claimed
from mocked tests.
"""

from __future__ import annotations

import base64
import json
import logging
import sqlite3
import time
from typing import Any, Dict, List, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.services import credentials as credsvc
from backend.services.freesound import OAuthStateError, OAuthStateStore, reset_freesound_client

# ------------------------------------------------------------------ fixtures

KEY = base64.b64encode(bytes(range(32))).decode("ascii")
PASSPHRASE_KEY = "correct horse battery staple"  # exercises the scrypt path

FREESOUND_ENV_VARS = [
    "UMBRA_FREESOUND_API_KEY",
    "UMBRA_FREESOUND_CLIENT_ID",
    "UMBRA_FREESOUND_CLIENT_SECRET",
    "UMBRA_FREESOUND_REDIRECT_URI",
    "UMBRA_FREESOUND_ACCESS_TOKEN",
    "UMBRA_FREESOUND_REFRESH_TOKEN",
    "UMBRA_FREESOUND_ACCESS_TOKEN_EXPIRES_AT",
]

SECRET_API_KEY = "fs-key-CANARY-a71b3c"
SECRET_CLIENT_SECRET = "fs-secret-CANARY-9e2f44"
SECRET_ACCESS = "fs-access-CANARY-5c1d"
SECRET_REFRESH = "fs-refresh-CANARY-08aa"
ALL_SECRETS = (SECRET_API_KEY, SECRET_CLIENT_SECRET, SECRET_ACCESS, SECRET_REFRESH)

SAFE_STATUS_KEYS = {
    "provider",
    "configured",
    "searchAvailable",
    "oauthAvailable",
    "oauthConfigured",
    "tokenExpired",
    "refreshable",
    "expiresAt",
    "lastVerifiedAt",
    "verification",
    "user",
    "redirectUri",
    "error",
    "storage",
    "encryptionKeyConfigured",
}


def fs_fixture(sound_id: int, license_: str = "Creative Commons 0") -> Dict[str, Any]:
    """A Freesound API sound fixture (subset of SEARCH_FIELDS)."""
    return {
        "id": sound_id,
        "url": f"https://freesound.org/sounds/{sound_id}/",
        "name": f"fixture_{sound_id}",
        "tags": ["door", "metal"],
        "description": "fixture sound",
        "username": "fixture-user",
        "license": license_,
        "type": "wav",
        "channels": 2,
        "filesize": 1234,
        "duration": 2.5,
        "samplerate": 48000,
        "created": "2021-01-01T00:00:00Z",
        "previews": {
            "preview-hq-mp3": f"https://freesound.org/data/previews/{sound_id}_hq.mp3",
        },
        "score": 88,
    }


class FreesoundMock:
    """Deterministic stand-in for freesound.org, with request capture."""

    def __init__(self):
        self.requests: List[httpx.Request] = []
        self.routes: List[tuple] = []  # (test(request) -> bool, handler)

    def route(self, match, handler) -> None:
        self.routes.append((match, handler))

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for match, handler in self.routes:
            if match(request):
                return handler(request)
        return httpx.Response(404, json={"detail": f"unmapped {request.url.path}"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def sent(self, path: str) -> List[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith(path)]


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """An isolated encrypted credential vault (tmp DB + key, no env creds)."""
    monkeypatch.setenv("UMBRA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("UMBRA_CREDENTIAL_ENCRYPTION_KEY", KEY)
    for var in FREESOUND_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    credsvc.reset_credential_store()
    reset_freesound_client()
    yield credsvc.get_credential_store()
    credsvc.reset_credential_store()
    reset_freesound_client()


@pytest.fixture
def freesound():
    return FreesoundMock()


@pytest.fixture
def client(vault, freesound):
    """TestClient with the Freesound HTTP layer swapped for the mock."""
    with TestClient(app) as c:
        c.app.state.freesound.install_transport(freesound.transport())
        yield c


def configure(c: TestClient, **payload) -> Any:
    return c.post("/api/integrations/freesound/configure", json=payload)


def status_of(c: TestClient) -> Dict[str, Any]:
    return c.get("/api/integrations/freesound/status").json()


# ------------------------------------------------- 1. store and retrieve


def test_credentials_stored_and_retrieved_server_side(vault, client):
    r = configure(client, apiKey=SECRET_API_KEY, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET, redirectUri="http://localhost:5173/")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["saved"] is True
    assert body["status"]["configured"] is True
    assert body["status"]["searchAvailable"] is True
    assert body["status"]["oauthConfigured"] is True

    # round-trip: the decrypted payload is retrievable by the service layer
    stored = vault.get("freesound")
    assert stored["apiKey"] == SECRET_API_KEY
    assert stored["clientSecret"] == SECRET_CLIENT_SECRET
    assert stored["redirectUri"] == "http://localhost:5173/"

    # patch semantics: re-configuring one field keeps the others
    configure(client, apiKey="fs-key-rotated-2211")
    assert vault.get("freesound")["clientSecret"] == SECRET_CLIENT_SECRET
    assert vault.get("freesound")["apiKey"] == "fs-key-rotated-2211"


def test_passphrase_encryption_key_round_trips(tmp_path, monkeypatch):
    """A human passphrase key is stretched with scrypt and still round-trips."""
    monkeypatch.setenv("UMBRA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("UMBRA_CREDENTIAL_ENCRYPTION_KEY", PASSPHRASE_KEY)
    for var in FREESOUND_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    credsvc.reset_credential_store()
    try:
        store = credsvc.get_credential_store()
        store.save("freesound", {"apiKey": SECRET_API_KEY})
        raw = sqlite3.connect(store.db_path).execute(
            "SELECT payload FROM integration_credentials WHERE provider='freesound'"
        ).fetchone()[0]
        envelope = json.loads(raw)
        assert envelope["kdf"] == "scrypt" and envelope["salt"]
        assert store.get("freesound")["apiKey"] == SECRET_API_KEY
    finally:
        credsvc.reset_credential_store()


# ------------------------------------------- 2. raw DB is not plaintext


def test_database_value_is_not_plaintext(vault, client):
    configure(client, apiKey=SECRET_API_KEY, clientSecret=SECRET_CLIENT_SECRET)

    conn = sqlite3.connect(vault.db_path)
    (payload,) = conn.execute(
        "SELECT payload FROM integration_credentials WHERE provider='freesound'"
    ).fetchone()
    conn.close()

    for secret in (SECRET_API_KEY, SECRET_CLIENT_SECRET):
        assert secret not in payload, "PLAINTEXT CREDENTIAL IN DATABASE"
    envelope = json.loads(payload)
    assert envelope["alg"] == "AES-256-GCM"
    assert envelope["v"] == 1
    assert envelope["nonce"] and envelope["ct"]
    # and the DB never stores the encryption key itself
    assert KEY not in payload
    columns = [row[1] for row in sqlite3.connect(vault.db_path).execute("PRAGMA table_info(integration_credentials)")]
    assert set(columns) == {
        "provider",
        "payload",
        "created_at",
        "updated_at",
        "last_verified_at",
        "verification_status",
        "verification_error",
    }


def test_no_plaintext_fallback_without_encryption_key(tmp_path, monkeypatch):
    """No key configured → storing is refused, never downgraded to plaintext."""
    monkeypatch.setenv("UMBRA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("UMBRA_CREDENTIAL_ENCRYPTION_KEY", raising=False)
    for var in FREESOUND_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    credsvc.reset_credential_store()
    reset_freesound_client()
    try:
        with TestClient(app) as c:
            r = c.post(
                "/api/integrations/freesound/configure", json={"apiKey": SECRET_API_KEY}
            )
            assert r.status_code == 503
            assert "UMBRA_CREDENTIAL_ENCRYPTION_KEY" in r.json()["detail"]
            # nothing was written — not even a row
            store = c.app.state.credentials
            assert not store.has_record("freesound")
            assert status_of(c)["configured"] is False
            assert status_of(c)["encryptionKeyConfigured"] is False
    finally:
        credsvc.reset_credential_store()
        reset_freesound_client()


# --------------------------------------- 3. status never returns secrets


def test_status_response_never_contains_secret_fields(vault, client):
    configure(
        client,
        apiKey=SECRET_API_KEY,
        clientId="umbra-app",
        clientSecret=SECRET_CLIENT_SECRET,
        redirectUri="http://localhost:5173/",
    )
    # also store OAuth tokens directly in the vault
    vault.save(
        "freesound",
        {
            "accessToken": SECRET_ACCESS,
            "refreshToken": SECRET_REFRESH,
            "expiresAt": int(time.time() * 1000) + 3_600_000,
        },
    )

    for path in (
        "/api/integrations/freesound/status",
        "/api/integrations/freesound/configure",  # POST re-configure is also safe
    ):
        if path.endswith("status"):
            r = client.get(path)
        else:
            r = client.post(path, json={"redirectUri": "http://localhost:5173/"})
        text = r.text
        for secret in ALL_SECRETS:
            assert secret not in text, f"secret {secret[:8]}… leaked from {path}"
        assert set(r.json().get("status", r.json()).keys()) <= SAFE_STATUS_KEYS

    # verify + delete responses too (verify hits an unmapped mock route →
    # honest failure — the response shape is what matters here)
    v = client.post("/api/integrations/freesound/verify").json()
    assert set(v["status"].keys()) <= SAFE_STATUS_KEYS
    assert not (set(v["verification"].keys()) & {"apiKey", "clientSecret", "accessToken", "refreshToken"})
    for secret in ALL_SECRETS:
        assert secret not in json.dumps(v)

    d = client.delete("/api/integrations/freesound/configure").json()
    assert set(d["status"].keys()) <= SAFE_STATUS_KEYS


# --------------------------------------------- 4. logs redact the key


def test_application_logs_redact_the_api_key(vault, client, caplog):
    configure(client, apiKey=SECRET_API_KEY)

    # an upstream that echoes credentials back (defense-in-depth case):
    # the error detail is redacted before it is raised or logged
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(401, json={"detail": f"invalid token {SECRET_API_KEY}"})

    client.app.state.freesound.install_transport(httpx.MockTransport(handler))

    with caplog.at_level(logging.WARNING, logger="umbra"):
        r = client.post("/api/integrations/freesound/verify")
    body = r.json()
    assert body["verification"]["verified"] is False

    # neither the response nor the captured logs contain the raw key
    assert SECRET_API_KEY not in json.dumps(body)
    assert SECRET_API_KEY not in caplog.text
    # the API key never traveled in a URL either (header auth, not query param)
    assert "token" not in seen["url"]
    # and the redaction marker is visible where the key would have been
    assert "***" in caplog.text or "***" in json.dumps(body)


def test_secret_redacting_filter_scrubs_log_records(vault):
    configure_store_directly(vault)
    record = logging.LogRecord(
        "umbra.test", logging.INFO, __file__, 1, "token=%s api_key=%s", (SECRET_API_KEY, SECRET_API_KEY), None
    )
    filt = credsvc.SecretRedactingFilter(vault)
    assert filt.filter(record) is True
    message = record.getMessage()
    assert SECRET_API_KEY not in message
    assert "***" in message


def test_redaction_filter_is_installed_at_startup(vault, client):
    filters_on_root_handlers = [
        f
        for h in logging.getLogger().handlers
        for f in h.filters
        if isinstance(f, credsvc.SecretRedactingFilter)
    ]
    assert filters_on_root_handlers, "secret-redacting filter not installed on root log handlers"


def configure_store_directly(store):  # noqa: ANN001 - helper
    store.save("freesound", {"apiKey": SECRET_API_KEY})


# --------------------------- 6. search uses backend-side authentication


def test_search_proxy_authenticates_with_the_backend_credential(vault, client, freesound):
    configure(client, apiKey=SECRET_API_KEY)
    freesound.route(
        lambda req: req.url.path.endswith("/search/"),
        lambda req: httpx.Response(
            200, json={"count": 1, "next": None, "previous": None, "results": [fs_fixture(4242)]}
        ),
    )

    # the browser-facing request carries NO credential at all
    r = client.get("/api/library/freesound/search", params={"query": "metal door creak", "page": 1})
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1

    # the backend→Freesound request DID authenticate, via the Authorization
    # header (never a query parameter — nothing leaks into access logs)
    sent = freesound.sent("/search/")
    assert len(sent) == 1
    assert sent[0].headers["Authorization"] == f"Token {SECRET_API_KEY}"
    assert "token" not in str(sent[0].url)
    assert SECRET_API_KEY not in str(sent[0].url)


def test_search_proxy_requires_configuration(vault, client):
    r = client.get("/api/library/freesound/search", params={"query": "door"})
    assert r.status_code == 409
    assert "not configured" in r.json()["error"].lower() or "configure" in r.json()["error"].lower()


def test_search_query_parameter_is_required(vault, client):
    configure(client, apiKey=SECRET_API_KEY)
    r = client.get("/api/library/freesound/search")
    assert r.status_code == 400


def test_env_provided_credentials_work_without_database(tmp_path, monkeypatch):
    """The documented headless fallback: server env vars instead of the vault."""
    monkeypatch.setenv("UMBRA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("UMBRA_CREDENTIAL_ENCRYPTION_KEY", raising=False)
    monkeypatch.setenv("UMBRA_FREESOUND_API_KEY", SECRET_API_KEY)
    for var in FREESOUND_ENV_VARS:
        if var != "UMBRA_FREESOUND_API_KEY":
            monkeypatch.delenv(var, raising=False)
    credsvc.reset_credential_store()
    reset_freesound_client()
    try:
        mock = FreesoundMock()
        mock.route(
            lambda req: req.url.path.endswith("/search/"),
            lambda req: httpx.Response(200, json={"count": 0, "results": []}),
        )
        with TestClient(app) as c:
            c.app.state.freesound.install_transport(mock.transport())
            st = status_of(c)
            assert st["configured"] is True
            assert st["searchAvailable"] is True
            assert st["storage"] == "env"
            r = c.get("/api/library/freesound/search", params={"query": "door"})
            assert r.status_code == 200
            assert mock.sent("/search/")[0].headers["Authorization"] == f"Token {SECRET_API_KEY}"
    finally:
        credsvc.reset_credential_store()
        reset_freesound_client()


# --------------------------------- 7. invalid credential fails honestly


def test_invalid_credential_returns_honest_failure(vault, client, freesound):
    configure(client, apiKey="fs-definitely-wrong-key")
    freesound.route(
        lambda req: req.url.path.endswith("/search/"),
        lambda req: httpx.Response(401, json={"detail": "Invalid token"}),
    )

    r = client.post("/api/integrations/freesound/verify")
    assert r.status_code == 200
    body = r.json()
    # a key merely existing proves nothing — Freesound said no
    assert body["verification"]["verified"] is False
    assert "401" in body["verification"]["error"]
    assert body["status"]["verification"] == "failed"
    assert body["status"]["lastVerifiedAt"] is not None
    assert body["status"]["error"]

    # the search proxy fails loudly too — no fake results
    r2 = client.get("/api/library/freesound/search", params={"query": "door"})
    assert r2.status_code >= 400
    assert "rejected" in r2.json()["error"].lower()


def test_verification_succeeds_only_on_real_freesound_responses(vault, client, freesound):
    configure(client, apiKey=SECRET_API_KEY)
    freesound.route(
        lambda req: req.url.path.endswith("/search/"),
        lambda req: httpx.Response(200, json={"count": 0, "next": None, "previous": None, "results": []}),
    )
    r = client.post("/api/integrations/freesound/verify")
    body = r.json()
    assert body["verification"]["verified"] is True
    assert body["verification"]["searchVerified"] is True
    st = status_of(client)
    assert st["verification"] == "verified"
    assert st["lastVerifiedAt"] is not None
    assert st["error"] is None


# ------------------------------------------- 8. OAuth state: single use


def oauth_flow(client, freesound):  # noqa: ANN001 - helper
    freesound.route(
        lambda req: req.url.path.endswith("/oauth2/access_token/"),
        lambda req: httpx.Response(
            200,
            json={"access_token": SECRET_ACCESS, "refresh_token": SECRET_REFRESH, "expires_in": 86400},
        ),
    )
    freesound.route(
        lambda req: req.url.path.endswith("/me/"),
        lambda req: httpx.Response(200, json={"id": 7, "username": "ghost-composer"}),
    )


def test_oauth_state_is_cryptographically_random_and_single_use(vault, client, freesound):
    configure(client, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET)
    oauth_flow(client, freesound)

    start = client.post("/api/integrations/freesound/oauth/start").json()
    url = start["authorizeUrl"]
    assert url.startswith("https://freesound.org/apiv2/oauth2/authorize/")
    assert "client_id=umbra-app" in url
    state = url.split("state=")[1].split("&")[0]
    # cryptographically random, not a counter or Math.random-grade value
    assert len(state) >= 40
    start2 = client.post("/api/integrations/freesound/oauth/start").json()
    assert start2["authorizeUrl"].split("state=")[1] != state

    # first exchange consumes the state and succeeds
    r1 = client.post(
        "/api/integrations/freesound/oauth/exchange", json={"code": "auth-code-1", "state": state}
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["status"]["oauthAvailable"] is True
    assert r1.json()["status"]["user"] == "ghost-composer"

    # replaying the same code+state is rejected — the state is burned
    r2 = client.post(
        "/api/integrations/freesound/oauth/exchange", json={"code": "auth-code-1", "state": state}
    )
    assert r2.status_code == 400
    assert "already used" in r2.json()["detail"]


def test_oauth_state_unknown_is_rejected(vault, client):
    configure(client, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET)
    r = client.post(
        "/api/integrations/freesound/oauth/exchange",
        json={"code": "c", "state": "never-issued-state"},
    )
    assert r.status_code == 400


def test_oauth_state_expires(vault):
    store = OAuthStateStore(ttl_seconds=0.05)
    state, _ = store.issue()
    time.sleep(0.1)
    with pytest.raises(OAuthStateError):
        store.consume(state)
    # and once consumed it is gone for good
    state2, _ = store.issue()
    store.consume(state2)
    with pytest.raises(OAuthStateError):
        store.consume(state2)


def test_oauth_exchange_never_leaks_the_client_secret(vault, client, freesound):
    """The token exchange (which uses the client secret) happens server-side;
    its response to the browser carries only safe status."""
    configure(client, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET)
    oauth_flow(client, freesound)
    start = client.post("/api/integrations/freesound/oauth/start").json()
    state = start["authorizeUrl"].split("state=")[1].split("&")[0]
    r = client.post(
        "/api/integrations/freesound/oauth/exchange", json={"code": "auth-code-2", "state": state}
    )
    assert r.status_code == 200
    assert SECRET_CLIENT_SECRET not in r.text
    assert SECRET_ACCESS not in r.text
    assert SECRET_REFRESH not in r.text


# ------------------------------- 9. expired access token auto-refreshes


def test_expired_access_token_refreshes_and_download_works(vault, client, freesound):
    configure(client, apiKey=SECRET_API_KEY, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET)
    # stored token already expired
    vault.save(
        "freesound",
        {
            "accessToken": "fs-access-OLD",
            "refreshToken": "fs-refresh-OLD",
            "expiresAt": int(time.time() * 1000) - 60_000,
        },
    )

    def token_handler(request: httpx.Request) -> httpx.Response:
        form = dict(pair.split("=") for pair in request.read().decode().split("&") if "=" in pair)
        assert form["grant_type"] == "refresh_token"
        assert form["refresh_token"] == "fs-refresh-OLD"
        return httpx.Response(
            200, json={"access_token": SECRET_ACCESS, "expires_in": 86400}
        )

    freesound.route(lambda req: req.url.path.endswith("/oauth2/access_token/"), token_handler)
    freesound.route(
        lambda req: req.url.path.endswith("/download/"),
        lambda req: httpx.Response(200, content=b"ORIGINAL-QUALITY-AUDIO", headers={"content-type": "audio/wav"}),
    )

    st = status_of(client)
    assert st["tokenExpired"] is True and st["oauthAvailable"] is False

    r = client.get("/api/library/freesound/sounds/4242/download")
    assert r.status_code == 200, r.text
    assert r.content == b"ORIGINAL-QUALITY-AUDIO"
    assert r.headers["content-type"].startswith("audio/wav")

    # the refreshed token was used for the download (not the stale one)
    dl = freesound.sent("/download/")[0]
    assert dl.headers["Authorization"] == f"Bearer {SECRET_ACCESS}"

    # and the new token + expiry were persisted for next time
    stored = vault.get("freesound")
    assert stored["accessToken"] == SECRET_ACCESS
    assert stored["expiresAt"] > int(time.time() * 1000)
    assert status_of(client)["oauthAvailable"] is True


def test_manual_refresh_endpoint(vault, client, freesound):
    configure(client, clientId="umbra-app", clientSecret=SECRET_CLIENT_SECRET)
    vault.save("freesound", {"accessToken": "old", "refreshToken": "fs-refresh-OLD", "expiresAt": int(time.time() * 1000) - 1000})
    freesound.route(
        lambda req: req.url.path.endswith("/oauth2/access_token/"),
        lambda req: httpx.Response(200, json={"access_token": SECRET_ACCESS, "expires_in": 3600}),
    )
    r = client.post("/api/integrations/freesound/oauth/refresh")
    assert r.status_code == 200
    assert r.json()["status"]["oauthAvailable"] is True


# ---------------------------------- 10. disconnect deletes the secrets


def test_disconnect_deletes_stored_freesound_secrets(vault, client, freesound):
    configure(
        client,
        apiKey=SECRET_API_KEY,
        clientId="umbra-app",
        clientSecret=SECRET_CLIENT_SECRET,
        redirectUri="http://localhost:5173/",
    )
    vault.save(
        "freesound",
        {"accessToken": SECRET_ACCESS, "refreshToken": SECRET_REFRESH, "expiresAt": int(time.time() * 1000) + 3_600_000},
    )
    assert vault.get("freesound") is not None

    r = client.delete("/api/integrations/freesound/configure")
    assert r.status_code == 200
    body = r.json()
    assert body["deleted"] is True
    assert body["status"]["configured"] is False

    # the decrypted payload is gone and so is the raw row
    assert vault.get("freesound") is None
    conn = sqlite3.connect(vault.db_path)
    rows = conn.execute("SELECT COUNT(*) FROM integration_credentials").fetchone()[0]
    conn.close()
    assert rows == 0


# ------------------ 11. provenance / license metadata stays intact


def test_search_proxy_passes_license_metadata_through_unmodified(vault, client, freesound):
    configure(client, apiKey=SECRET_API_KEY)
    fixture = fs_fixture(5150, license_="Attribution NonCommercial")
    freesound.route(
        lambda req: req.url.path.endswith("/search/"),
        lambda req: httpx.Response(200, json={"count": 1, "next": None, "previous": None, "results": [fixture]}),
    )
    r = client.get(
        "/api/library/freesound/search",
        params={"query": "door", "fields": "id,url,name,license,username,previews"},
    )
    body = r.json()
    sent = freesound.sent("/search/")[0]
    # the provider's requested fields were forwarded to Freesound
    assert "license" in str(sent.url.params.get("fields", ""))
    result = body["results"][0]
    assert result["license"] == "Attribution NonCommercial"
    assert result["username"] == "fixture-user"
    assert result["url"] == fixture["url"]
    assert result["previews"] == fixture["previews"]


def test_similar_and_analysis_and_sound_proxies_authenticate(vault, client, freesound):
    configure(client, apiKey=SECRET_API_KEY)
    freesound.route(
        lambda req: req.url.path.endswith("/similar/"),
        lambda req: httpx.Response(200, json={"count": 0, "results": []}),
    )
    freesound.route(
        lambda req: req.url.path.endswith("/analysis/"),
        lambda req: httpx.Response(200, json={"bpm": 120}),
    )
    freesound.route(
        lambda req: req.method == "GET" and req.url.path.endswith("/sounds/4242/"),
        lambda req: httpx.Response(200, json=fs_fixture(4242)),
    )
    assert client.get("/api/library/freesound/sounds/4242/similar", params={"page": 1}).status_code == 200
    assert client.get("/api/library/freesound/sounds/4242/analysis").status_code == 200
    assert client.get("/api/library/freesound/sounds/4242").status_code == 200
    for path in ("/similar/", "/analysis/", "/sounds/4242/"):
        sent = freesound.sent(path)
        assert sent[0].headers.get("Authorization") == f"Token {SECRET_API_KEY}"


# ------------------------------------------------------ origin hardening


def test_untrusted_origins_are_rejected_on_integration_endpoints(vault, client):
    evil = {"Origin": "https://evil.example.com"}
    r = client.post(
        "/api/integrations/freesound/configure",
        json={"apiKey": SECRET_API_KEY},
        headers=evil,
    )
    assert r.status_code == 403
    assert not vault.has_record("freesound")

    r2 = client.post("/api/integrations/freesound/oauth/start", headers=evil)
    assert r2.status_code == 403

    r3 = client.delete("/api/integrations/freesound/configure", headers=evil)
    assert r3.status_code == 403


def test_same_origin_and_originless_requests_are_allowed(vault, client):
    r = client.get(
        "/api/integrations/freesound/status",
        headers={"Origin": "http://localhost:5173"},
    )
    assert r.status_code == 200
    # no Origin header at all (curl / server-side tooling) is fine
    r2 = client.get("/api/integrations/freesound/status")
    assert r2.status_code == 200


def test_status_works_even_with_an_empty_vault(vault, client):
    st = status_of(client)
    assert st["configured"] is False
    assert st["searchAvailable"] is False
    assert st["storage"] == "none"
    assert st["encryptionKeyConfigured"] is True


def test_reconfiguring_credentials_invalidates_stale_verification(vault, client, freesound):
    """A stored 'failed' verdict belongs to the OLD key — saving a new key
    resets verification so the status ladder never lies about the new one."""
    configure(client, apiKey="fs-old-wrong-key")
    freesound.route(
        lambda req: req.url.path.endswith("/search/"),
        lambda req: httpx.Response(401, json={"detail": "Invalid token"}),
    )
    client.post("/api/integrations/freesound/verify")
    assert status_of(client)["verification"] == "failed"

    configure(client, apiKey=SECRET_API_KEY)
    st = status_of(client)
    assert st["verification"] is None
    assert st["lastVerifiedAt"] is None
    assert st["error"] is None
