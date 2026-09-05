"""UMBRA · Freesound API client (server-side).

Every Freesound request that needs a credential goes through this module.
The browser never sees an API key, client secret, or OAuth token: it talks
to ``/api/library/freesound/*`` and ``/api/integrations/freesound/*`` on the
Umbra backend, and this is the only code that talks to freesound.org with
credentials attached.

Endpoint map (official APIv2, verified 2026-09):

    search        GET /search/                    (API key)
    sound         GET /sounds/<id>/               (API key)
    analysis      GET /sounds/<id>/analysis/      (API key)
    similar       GET /sounds/<id>/similar/       (API key)
    download      GET /sounds/<id>/download/      (OAuth2 Bearer only)
    me            GET /me/                        (OAuth2 Bearer only)
    authorize     GET /oauth2/authorize/          (browser, no secret)
    token         POST /oauth2/access_token/      (client secret — server only)

The API key is sent as an ``Authorization: Token <key>`` header (documented
alternative to the ``token`` query parameter) so it never appears in URLs,
access logs, or exception traces. Errors are redacted before they are raised
or logged.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import httpx

from backend.services.credentials import (
    CredentialStore,
    CredentialsError,
    get_credential_store,
    redact,
)

log = logging.getLogger("umbra.freesound")

DEFAULT_BASE_URL = "https://freesound.org/apiv2"
ENV_BASE_URL = "UMBRA_FREESOUND_BASE_URL"

#: Refresh this long before the real expiry so clock skew never produces a
#: doomed request.
EXPIRY_SKEW_MS = 60_000


class FreesoundError(Exception):
    """Freesound call failed. Message is safe to show (redacted), and
    ``http_status`` is the status the Umbra API should return to the browser."""

    def __init__(self, message: str, http_status: int = 502, hint: Optional[str] = None):
        super().__init__(message)
        self.http_status = http_status
        self.hint = hint


class FreesoundNotConfigured(FreesoundError):
    def __init__(self, message: str, hint: Optional[str] = None):
        super().__init__(message, http_status=409, hint=hint)


class OAuthStateError(FreesoundError):
    def __init__(self, message: str):
        super().__init__(message, http_status=400)


# ------------------------------------------------------------------ OAuth state


class OAuthStateStore:
    """CSRF protection for the OAuth2 authorization-code flow.

    States are cryptographically random (``secrets.token_urlsafe``), validated
    server-side, expire after ``ttl_seconds`` and are strictly single-use —
    the state is consumed by the first exchange attempt, success or failure.
    """

    def __init__(self, ttl_seconds: float = 600.0):
        self.ttl_seconds = ttl_seconds
        self._states: Dict[str, float] = {}
        self._lock = threading.Lock()

    def issue(self) -> Tuple[str, int]:
        state = secrets.token_urlsafe(32)
        with self._lock:
            self._prune()
            self._states[state] = time.monotonic() + self.ttl_seconds
        return state, int(self.ttl_seconds)

    def consume(self, state: str) -> None:
        """Validate and burn a state. Raises :class:`OAuthStateError` when the
        state is unknown, already used, or expired."""
        if not state:
            raise OAuthStateError("OAuth state is missing — restart the authorization flow.")
        with self._lock:
            self._prune()
            expiry = self._states.pop(state, None)  # single use: gone either way
        if expiry is None:
            raise OAuthStateError(
                "OAuth state is unknown or was already used — restart the "
                "authorization flow (Reconnect in Settings → Sound Libraries)."
            )
        if time.monotonic() > expiry:
            raise OAuthStateError(
                "OAuth state expired — authorization links are valid for "
                f"{int(self.ttl_seconds // 60)} minutes. Reconnect and try again."
            )

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [k for k, exp in self._states.items() if exp < now]
        for key in expired:
            del self._states[key]


# ---------------------------------------------------------------------- client


class FreesoundClient:
    """The one place Freesound credentials are used."""

    def __init__(
        self,
        credential_store: Optional[CredentialStore] = None,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.store = credential_store or get_credential_store()
        self.base_url = (base_url or os.environ.get(ENV_BASE_URL) or DEFAULT_BASE_URL).rstrip("/")
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            follow_redirects=True,
            transport=transport,
        )

    def install_transport(self, transport: httpx.AsyncBaseTransport) -> None:
        """Test seam: swap the HTTP transport for a deterministic mock."""
        self._http = httpx.AsyncClient(
            base_url=self.base_url, timeout=30.0, follow_redirects=True, transport=transport
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------ helpers --

    def _creds(self) -> Dict[str, Any]:
        return self.store.effective_freesound_credentials()

    def _redact(self, text: str) -> str:
        return redact(text, self.store.known_secrets())

    def _raise_for_status(self, resp: httpx.Response, action: str) -> None:
        if resp.status_code < 400:
            return
        detail = ""
        try:
            body = resp.json()
            detail = str(body.get("detail") or body.get("error") or "")
        except Exception:
            detail = resp.text[:200]
        detail = self._redact(detail)
        if resp.status_code in (401, 403):
            raise FreesoundError(
                f"Freesound rejected the credential while {action} ({resp.status_code}"
                f"{f': {detail}' if detail else ''}).",
                hint="The stored API key / OAuth token is invalid or expired — "
                "re-enter or reconnect it in Settings → Sound Libraries.",
            )
        if resp.status_code == 429:
            raise FreesoundError(
                f"Freesound rate limit reached while {action} (429).",
                http_status=429,
                hint="Wait a moment and try again.",
            )
        raise FreesoundError(
            f"Freesound API error while {action} ({resp.status_code}"
            f"{f': {detail}' if detail else ''})."
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, str]] = None,
        token: Optional[str] = None,
        bearer: Optional[str] = None,
    ) -> httpx.Response:
        headers: Dict[str, str] = {}
        if token:
            headers["Authorization"] = f"Token {token}"
        elif bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        try:
            resp = await self._http.request(
                method, path, params=params, data=data, headers=headers
            )
        except httpx.HTTPError as exc:
            raise FreesoundError(
                f"Freesound is unreachable while {path.split('?')[0]}: "
                f"{exc.__class__.__name__}.",
                http_status=502,
                hint="Check the backend's network connectivity to freesound.org.",
            ) from exc
        return resp

    def _require_api_key(self) -> str:
        key = self._creds().get("apiKey")
        if not key:
            raise FreesoundNotConfigured(
                "Freesound search needs an API key — configure the integration "
                "in Settings → Sound Libraries (it is stored server-side)."
            )
        return key

    # ------------------------------------------------------------- search --

    async def search(
        self,
        query: str,
        page: int = 1,
        page_size: int = 30,
        filter_: Optional[str] = None,
        sort: Optional[str] = None,
        fields: Optional[str] = None,
    ) -> Dict[str, Any]:
        key = self._require_api_key()
        params: Dict[str, Any] = {"query": query, "page": page, "page_size": page_size}
        if filter_:
            params["filter"] = filter_
        if sort:
            params["sort"] = sort
        if fields:
            params["fields"] = fields
        resp = await self._request("GET", "/search/", params=params, token=key)
        self._raise_for_status(resp, "searching Freesound")
        return resp.json()

    async def sound(self, sound_id: int, fields: Optional[str] = None) -> Dict[str, Any]:
        key = self._require_api_key()
        params = {"fields": fields} if fields else None
        resp = await self._request("GET", f"/sounds/{sound_id}/", params=params, token=key)
        self._raise_for_status(resp, f"fetching sound {sound_id}")
        return resp.json()

    async def similar(
        self,
        sound_id: int,
        page: int = 1,
        page_size: int = 20,
        similarity_space: str = "laion_clap",
        fields: Optional[str] = None,
    ) -> Dict[str, Any]:
        key = self._require_api_key()
        params: Dict[str, Any] = {
            "page": page,
            "page_size": page_size,
            "similarity_space": similarity_space,
        }
        if fields:
            params["fields"] = fields
        resp = await self._request(
            "GET", f"/sounds/{sound_id}/similar/", params=params, token=key
        )
        self._raise_for_status(resp, f"finding sounds similar to {sound_id}")
        return resp.json()

    async def analysis(self, sound_id: int, fields: Optional[str] = None) -> Dict[str, Any]:
        key = self._require_api_key()
        params = {"fields": fields} if fields else None
        resp = await self._request("GET", f"/sounds/{sound_id}/analysis/", params=params, token=key)
        self._raise_for_status(resp, f"analyzing sound {sound_id}")
        return resp.json()

    # ------------------------------------------------------------- OAuth --

    def authorize_url(self, state: str, redirect_uri: Optional[str] = None) -> str:
        creds = self._creds()
        client_id = creds.get("clientId")
        if not client_id:
            raise FreesoundNotConfigured(
                "Freesound OAuth2 needs a client id — save your API app "
                "credentials first (Settings → Sound Libraries → Configure)."
            )
        params = {"client_id": client_id, "response_type": "code", "state": state}
        if redirect_uri:
            params["redirect_uri"] = redirect_uri
        return f"{self.base_url}/oauth2/authorize/?{urlencode(params)}"

    async def exchange_code(self, code: str) -> Dict[str, Any]:
        """Exchange a one-time authorization code for tokens, server-side.

        The client secret never leaves this process. Tokens are persisted in
        the encrypted credential store."""
        creds = self._creds()
        client_id = creds.get("clientId")
        client_secret = creds.get("clientSecret")
        if not (client_id and client_secret):
            raise FreesoundNotConfigured(
                "Freesound OAuth2 exchange needs the API app's client id and "
                "secret — configure them first (Settings → Sound Libraries)."
            )
        resp = await self._request(
            "POST",
            "/oauth2/access_token/",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "authorization_code",
                "code": code,
            },
        )
        self._raise_for_status(resp, "exchanging the OAuth2 authorization code")
        payload = resp.json()
        patch = self._token_patch(payload)
        user = await self._me_username(patch["accessToken"])
        if user:
            patch["user"] = user
        self.store.save("freesound", patch)
        log.info("freesound oauth2: tokens exchanged and stored%s", f" for {user}" if user else "")
        return patch

    async def refresh_access_token(self) -> Dict[str, Any]:
        """Refresh the stored access token and persist the new one."""
        creds = self._creds()
        client_id = creds.get("clientId")
        client_secret = creds.get("clientSecret")
        refresh_token = creds.get("refreshToken")
        if not (client_id and client_secret and refresh_token):
            raise FreesoundNotConfigured(
                "Freesound OAuth2 refresh needs the client id/secret and a "
                "refresh token — reconnect in Settings → Sound Libraries."
            )
        resp = await self._request(
            "POST",
            "/oauth2/access_token/",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
        self._raise_for_status(resp, "refreshing the OAuth2 access token")
        patch = self._token_patch(resp.json())
        # Freesound may or may not rotate the refresh token; keep the old one
        # when the response does not include a new one.
        if not patch.get("refreshToken"):
            patch["refreshToken"] = refresh_token
        self.store.save("freesound", patch)
        log.info("freesound oauth2: access token refreshed (valid for %ss)", resp.json().get("expires_in"))
        return patch

    async def ensure_access_token(self) -> str:
        """A currently-valid OAuth2 bearer token, refreshing when expired."""
        creds = self._creds()
        access = creds.get("accessToken")
        expires_at = creds.get("expiresAt")
        expired = bool(
            isinstance(expires_at, (int, float))
            and expires_at > 0
            and expires_at <= time.time() * 1000 + EXPIRY_SKEW_MS
        )
        if access and not expired:
            return str(access)
        if creds.get("refreshToken"):
            patch = await self.refresh_access_token()
            return str(patch["accessToken"])
        if not access:
            raise FreesoundNotConfigured(
                "Freesound original-quality download requires OAuth2 — connect "
                "your Freesound account in Settings → Sound Libraries. The "
                "preview workflow is unaffected."
            )
        raise FreesoundError(
            "The Freesound OAuth2 access token has expired and there is no "
            "refresh token — reconnect in Settings → Sound Libraries.",
            http_status=409,
        )

    def _token_patch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            expires_in = int(payload["expires_in"])
        except (KeyError, TypeError, ValueError) as exc:
            raise FreesoundError(
                "Freesound returned a malformed OAuth2 token response."
            ) from exc
        return {
            "accessToken": str(payload.get("access_token") or ""),
            "refreshToken": str(payload.get("refresh_token") or ""),
            "expiresAt": int(time.time() * 1000) + expires_in * 1000,
        }

    async def _me_username(self, bearer: str) -> Optional[str]:
        try:
            resp = await self._request("GET", "/me/", bearer=bearer)
            self._raise_for_status(resp, "reading the Freesound account")
            return str(resp.json().get("username") or "") or None
        except FreesoundError:
            return None

    # ---------------------------------------------------------- download --

    async def download(self, sound_id: int) -> httpx.Response:
        """Original-quality download (OAuth2 only). Refreshes first when the
        access token is expired."""
        bearer = await self.ensure_access_token()
        resp = await self._request("GET", f"/sounds/{sound_id}/download/", bearer=bearer)
        self._raise_for_status(resp, f"downloading sound {sound_id}")
        return resp

    async def me(self) -> Dict[str, Any]:
        bearer = await self.ensure_access_token()
        resp = await self._request("GET", "/me/", bearer=bearer)
        self._raise_for_status(resp, "reading the Freesound account")
        return resp.json()

    # ------------------------------------------------------------ verify --

    async def verify(self) -> Dict[str, Any]:
        """Real connection test against the official Freesound API.

        A key merely existing proves nothing — a check only passes when
        freesound.org returns a successful authenticated response.
        """
        creds = self._creds()
        report: Dict[str, Any] = {
            "verified": False,
            "searchVerified": False,
            "oauthVerified": False,
            "user": None,
            "error": None,
            "checks": [],
        }
        if creds.get("apiKey"):
            try:
                resp = await self._request(
                    "GET", "/search/", params={"query": "sound", "page_size": 1},
                    token=str(creds["apiKey"]),
                )
                self._raise_for_status(resp, "verifying the API key")
                report["searchVerified"] = True
                report["checks"].append("API key: accepted by freesound.org")
            except FreesoundError as exc:
                report["checks"].append(f"API key: rejected — {exc}")
                report["error"] = str(exc)
        if creds.get("accessToken") or creds.get("refreshToken"):
            try:
                me = await self.me()
                report["oauthVerified"] = True
                report["user"] = me.get("username")
                report["checks"].append(
                    f"OAuth2: valid account token ({me.get('username', 'unknown user')})"
                )
            except FreesoundError as exc:
                report["checks"].append(f"OAuth2: rejected — {exc}")
                if not report["error"]:
                    report["error"] = str(exc)
        if not (creds.get("apiKey") or creds.get("accessToken") or creds.get("refreshToken")):
            report["error"] = "No Freesound credentials are configured on the backend."
        report["verified"] = report["searchVerified"] or report["oauthVerified"]
        return report


# ------------------------------------------------------------------ singletons

_client: Optional[FreesoundClient] = None
_client_lock = threading.Lock()


def get_freesound_client() -> FreesoundClient:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = FreesoundClient()
    return _client


def reset_freesound_client() -> None:
    """Test seam: drop the cached singleton (env changes take effect)."""
    global _client
    with _client_lock:
        _client = None
