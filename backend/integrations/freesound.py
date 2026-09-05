"""Official Freesound APIv2 client — **server-side only**.

Why this module exists
----------------------
Freesound used to be called straight from the browser with a token pasted
into the UI and kept in ``localStorage``. That put a live credential in the
one place it can never be kept safe. This module moves the credential behind
the FastAPI backend:

    local .env (git-ignored)  →  this module  →  freesound.org
                                     ↑
              browser only ever sees "configured / connected"

Contract
--------
* The API key is read from the environment only (``FREESOUND_API_KEY``),
  optionally via the repo-root ``.env``. It is never written to disk, never
  logged, never returned in a response — only a salted-position-free
  ``sha256`` fingerprint is exposed so two machines can tell whether they
  are running the same key.
* Every failure is honest. Missing key → ``not_configured``. Rejected key →
  ``unauthorized``. No code path fabricates, caches-stale-substitutes,
  or falls back to "demo" results.
* Metadata is passed through untouched. Creator, source URL, license string,
  sound id, preview URLs and quality belong to the retrieval pipeline, which
  maps them into an ``AudioClip`` with provenance intact.

Endpoints used (APIv2, current as of the integration):

    search     GET /apiv2/search/
    sound      GET /apiv2/sounds/<id>/
    similar    GET /apiv2/sounds/<id>/similar/?similarity_space=laion_clap
    analysis   GET /apiv2/sounds/<id>/analysis/
    preview    GET <previews.*>           (no credential needed upstream)
    download   GET /apiv2/sounds/<id>/download/   (OAuth2 bearer only)

Authentication: ``Authorization: Token <api key>`` header (the key is never
placed in a URL, so it cannot leak into logs or referrers).
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any, AsyncIterator, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

import httpx

from backend.env import load_local_env

log = logging.getLogger("umbra.integrations.freesound")

#: Environment variable holding the client secret / API key.
API_KEY_ENV = "FREESOUND_API_KEY"
#: Optional OAuth2 bearer enabling original-quality downloads.
OAUTH_TOKEN_ENV = "FREESOUND_OAUTH_TOKEN"

API_BASE_DEFAULT = "https://freesound.org/apiv2"
SEARCH_PATH = "/search/"
SOUND_PATH = "/sounds/{sound_id}/"
SIMILAR_PATH = "/sounds/{sound_id}/similar/"
ANALYSIS_PATH = "/sounds/{sound_id}/analysis/"
DOWNLOAD_PATH = "/sounds/{sound_id}/download/"

#: Fields requested from Freesound — everything the retrieval pipeline maps
#: into a LibraryAsset (license, creator, source url, previews, quality).
SEARCH_FIELDS = ",".join(
    [
        "id",
        "url",
        "name",
        "tags",
        "description",
        "username",
        "license",
        "type",
        "channels",
        "filesize",
        "duration",
        "samplerate",
        "created",
        "num_downloads",
        "avg_rating",
        "previews",
        "images",
        "score",
        "gen_ai_preference",
        "md5",
        "category",
        "subcategory",
    ]
)

#: Which preview rendition the UI asks for, in preference order.
PREVIEW_ORDER: Tuple[str, ...] = (
    "preview-hq-mp3",
    "preview-hq-ogg",
    "preview-lq-mp3",
    "preview-lq-ogg",
)

DEFAULT_TIMEOUT = 15.0
DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 150
#: Hard ceilings so a surprise response cannot exhaust the process.
MAX_PREVIEW_BYTES = 32 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

#: Hosts the backend will fetch media (previews) from. Freesound's media
#: hosts only — this is the SSRF guard for the preview proxy.
MEDIA_HOST_SUFFIXES = ("freesound.org",)

_PROBE_TTL_SECONDS = 60.0
_probe_cache: Dict[str, Dict[str, Any]] = {}


class FreesoundError(RuntimeError):
    """A Freesound request failed, or the integration is not configured.

    ``code`` is stable and machine-readable; ``http_status`` is what the
    FastAPI layer returns to the browser.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 502,
        hint: Optional[str] = None,
        upstream_status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.hint = hint
        self.upstream_status = upstream_status

    def to_json(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"error": self.message, "code": self.code}
        if self.hint:
            payload["hint"] = self.hint
        if self.upstream_status is not None:
            payload["upstreamStatus"] = self.upstream_status
        return payload


# --------------------------------------------------------------------- config


def api_key() -> Optional[str]:
    """The Freesound API key from the environment, or ``None``.

    Reads ``.env`` on first use so the key works whether the backend was
    started with ``scripts/run_backend.py`` or ``uvicorn`` directly. The
    process environment always wins over the file.
    """
    load_local_env()
    raw = os.environ.get(API_KEY_ENV, "")
    key = raw.strip()
    return key or None


def oauth_token() -> Optional[str]:
    """Optional OAuth2 bearer used for original-quality downloads."""
    load_local_env()
    raw = os.environ.get(OAUTH_TOKEN_ENV, "")
    token = raw.strip()
    return token or None


def api_base() -> str:
    """Base URL of the Freesound API (env-overridable for testing)."""
    load_local_env()
    return (os.environ.get("FREESOUND_API_BASE") or API_BASE_DEFAULT).rstrip("/")


def _extra_media_hosts() -> Sequence[str]:
    raw = (os.environ.get("FREESOUND_ALLOWED_MEDIA_HOSTS") or "").strip()
    if not raw:
        return ()
    return tuple(h.strip().lower().lstrip(".") for h in raw.split(",") if h.strip())


def key_hint(key: Optional[str]) -> Optional[str]:
    """A non-reversible fingerprint so two runs can be compared safely.

    Never returns any part of the key itself.
    """
    if not key:
        return None
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return f"sha256:{digest}"


def describe_credentials() -> Dict[str, Any]:
    """Everything the browser is allowed to know about the credential."""
    key = api_key()
    oauth = oauth_token()
    return {
        "configured": bool(key),
        "keySource": f"environment:{API_KEY_ENV}" if key else None,
        "keyHint": key_hint(key),
        "oauth": {
            "configured": bool(oauth),
            "quality": "original" if oauth else "preview",
        },
        "apiBase": api_base(),
        "envFile": str(os.environ.get("UMBRA_ENV_FILE") or ".env"),
    }


# --------------------------------------------------------------------- client


class FreesoundClient:
    """Thin, honest wrapper around the Freesound APIv2 endpoints we use.

    ``transport`` exists so tests can inject ``httpx.MockTransport`` — the
    mocked suites never touch the network.
    """

    def __init__(
        self,
        key: Optional[str] = None,
        *,
        oauth: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.key = key if key is not None else api_key()
        self.oauth = oauth if oauth is not None else oauth_token()
        self.base_url = (base_url or api_base()).rstrip("/")
        self.timeout = timeout
        self._transport = transport

    # -------------------------------------------------------------- plumbing

    def _client(self) -> httpx.AsyncClient:
        kwargs: Dict[str, Any] = {"timeout": self.timeout, "follow_redirects": True}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    def _headers(self, *, oauth: bool = False) -> Dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": "umbra-score/0.1"}
        if oauth:
            if not self.oauth:
                raise FreesoundError(
                    "oauth_required",
                    "Original-quality download needs a Freesound OAuth2 access "
                    f"token in {OAUTH_TOKEN_ENV}. Previews are unaffected.",
                    http_status=501,
                    hint=(
                        "Freesound requires OAuth2 for /download/. Set "
                        f"{OAUTH_TOKEN_ENV} in .env, or keep using previews."
                    ),
                )
            headers["Authorization"] = f"Bearer {self.oauth}"
        else:
            if not self.key:
                raise FreesoundError(
                    "not_configured",
                    f"No Freesound API key configured on the backend ({API_KEY_ENV} is unset).",
                    http_status=503,
                    hint=(
                        f"Copy .env.example to .env and set {API_KEY_ENV}=<your key>, "
                        "then restart the backend. See docs/development/FREESOUND.md."
                    ),
                )
            headers["Authorization"] = f"Token {self.key}"
        return headers

    def _error_for(self, response: httpx.Response) -> FreesoundError:
        status = response.status_code
        detail = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("detail") or body.get("error") or "")
        except Exception:  # noqa: BLE001 - body is not JSON, that is fine
            detail = (response.text or "")[:200]
        suffix = f": {detail}" if detail else ""
        if status in (401, 403):
            return FreesoundError(
                "unauthorized",
                f"Freesound rejected the configured API key ({status}){suffix}.",
                http_status=502,
                upstream_status=status,
                hint=f"Check {API_KEY_ENV} in .env — the key is invalid, revoked, or belongs to another app.",
            )
        if status == 404:
            return FreesoundError(
                "not_found",
                f"Freesound has no such resource ({status}){suffix}.",
                http_status=404,
                upstream_status=status,
            )
        if status == 429:
            return FreesoundError(
                "rate_limited",
                f"Freesound rate limit reached ({status}). Wait a moment and retry.",
                http_status=429,
                upstream_status=status,
            )
        return FreesoundError(
            "upstream_error",
            f"Freesound API error {status}{suffix}.",
            http_status=502,
            upstream_status=status,
        )

    async def request(
        self,
        method: str,
        path: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        oauth: bool = False,
        timeout: Optional[float] = None,
    ) -> Any:
        """Call a JSON API endpoint and return the decoded body."""
        url = f"{self.base_url}{path}"
        cleaned = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        headers = self._headers(oauth=oauth)
        try:
            async with self._client() as client:
                response = await client.request(
                    method,
                    url,
                    params=cleaned,
                    headers=headers,
                    timeout=timeout if timeout is not None else self.timeout,
                )
        except FreesoundError:
            raise
        except httpx.TimeoutException:
            raise FreesoundError(
                "timeout",
                "Freesound did not respond in time.",
                http_status=504,
            ) from None
        except httpx.HTTPError as exc:
            raise FreesoundError(
                "upstream_unreachable",
                f"Could not reach Freesound: {type(exc).__name__}.",
                http_status=502,
            ) from None
        if response.status_code >= 400:
            raise self._error_for(response)
        try:
            return response.json()
        except Exception as exc:  # noqa: BLE001
            raise FreesoundError(
                "upstream_error",
                "Freesound returned a non-JSON response.",
                http_status=502,
            ) from exc

    # --------------------------------------------------------------- search

    async def search(
        self,
        query: str,
        *,
        page: int = 1,
        page_size: int = DEFAULT_PAGE_SIZE,
        filters: Optional[Sequence[str]] = None,
        sort: str = "score",
        fields: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Search the official ``/apiv2/search/`` endpoint."""
        q = (query or "").strip()
        if not q:
            raise FreesoundError(
                "bad_request",
                "A search query is required.",
                http_status=422,
            )
        params: Dict[str, Any] = {
            "query": q,
            "page": max(1, page),
            "page_size": max(1, min(page_size, MAX_PAGE_SIZE)),
            "fields": fields or SEARCH_FIELDS,
            "sort": sort,
        }
        active = [f for f in (filters or []) if str(f).strip()]
        if active:
            params["filter"] = " ".join(active)
        body = await self.request("GET", SEARCH_PATH, params)
        if not isinstance(body, dict):
            raise FreesoundError(
                "upstream_error",
                "Freesound returned an unexpected search payload.",
                http_status=502,
            )
        return body

    async def sound(self, sound_id: int, *, fields: Optional[str] = None) -> Dict[str, Any]:
        body = await self.request(
            "GET",
            SOUND_PATH.format(sound_id=sound_id),
            {"fields": fields or SEARCH_FIELDS},
        )
        if not isinstance(body, dict):
            raise FreesoundError(
                "upstream_error", "Freesound returned an unexpected sound payload.", http_status=502
            )
        return body

    async def similar(
        self,
        sound_id: int,
        *,
        page: int = 1,
        page_size: int = 20,
        fields: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = await self.request(
            "GET",
            SIMILAR_PATH.format(sound_id=sound_id),
            {
                "fields": fields or SEARCH_FIELDS,
                "page": max(1, page),
                "page_size": max(1, min(page_size, MAX_PAGE_SIZE)),
                "similarity_space": "laion_clap",
            },
        )
        if not isinstance(body, dict):
            raise FreesoundError(
                "upstream_error", "Freesound returned an unexpected similar payload.", http_status=502
            )
        return body

    async def analysis(self, sound_id: int, descriptors: Optional[str] = None) -> Dict[str, Any]:
        fields = descriptors or (
            "mfcc,bpm,spectral_centroid,zero_crossing_rate,log_attack_time,"
            "temporal_centroid,dynamic_range,warmth,sharpness,roughness"
        )
        body = await self.request(
            "GET", ANALYSIS_PATH.format(sound_id=sound_id), {"all": "1", "descriptors": fields}
        )
        return body if isinstance(body, dict) else {"features": body}

    # ---------------------------------------------------------------- media

    def assert_media_url(self, url: str) -> str:
        """SSRF guard: only Freesound media hosts may be proxied.

        Plain ``http`` is accepted only for hosts listed explicitly in
        ``FREESOUND_ALLOWED_MEDIA_HOSTS`` (i.e. a developer pointing the
        integration at a local mock), never for Freesound itself.
        """
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        extra = tuple(_extra_media_hosts())
        if parsed.scheme == "https":
            allowed = MEDIA_HOST_SUFFIXES + extra
        elif parsed.scheme == "http":
            allowed = extra
        else:
            allowed = ()
        if not any(host == h or host.endswith(f".{h}") for h in allowed):
            raise FreesoundError(
                "upstream_error",
                f"Refusing to fetch media from unexpected host '{host}'.",
                http_status=502,
            )
        return url

    async def resolve_preview_url(self, sound_id: int, quality: str = "preview-hq-mp3") -> str:
        """Resolve the preview URL for a sound (metadata call, then pick)."""
        data = await self.sound(sound_id, fields="id,name,license,previews")
        previews = (data or {}).get("previews") or {}
        if not isinstance(previews, dict) or not previews:
            raise FreesoundError(
                "not_found",
                f"Freesound returned no preview URLs for sound {sound_id}.",
                http_status=404,
            )
        wanted = quality if quality in previews else None
        if wanted is None:
            wanted = next((q for q in PREVIEW_ORDER if previews.get(q)), None)
        if wanted is None:
            raise FreesoundError(
                "not_found",
                f"Freesound returned no usable preview for sound {sound_id}.",
                http_status=404,
            )
        return self.assert_media_url(str(previews[wanted]))

    async def fetch_media(
        self,
        url: str,
        *,
        oauth: bool = False,
        max_bytes: int = MAX_PREVIEW_BYTES,
    ) -> Tuple[bytes, str]:
        """Fetch bytes (preview or original) with a hard size ceiling."""
        headers = self._headers(oauth=oauth)
        headers.pop("Accept", None)
        total = 0
        chunks: List[bytes] = []
        content_type = "application/octet-stream"
        try:
            async with self._client() as client:
                async with client.stream("GET", url, headers=headers, timeout=self.timeout) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise self._error_for(response)
                    content_type = response.headers.get("content-type", content_type).split(";")[0]
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > max_bytes:
                            raise FreesoundError(
                                "upstream_error",
                                f"Freesound media exceeded the {max_bytes} byte safety limit.",
                                http_status=502,
                            )
                        chunks.append(chunk)
        except FreesoundError:
            raise
        except httpx.TimeoutException:
            raise FreesoundError("timeout", "Freesound did not respond in time.", http_status=504) from None
        except httpx.HTTPError as exc:
            raise FreesoundError(
                "upstream_unreachable",
                f"Could not reach Freesound: {type(exc).__name__}.",
                http_status=502,
            ) from None
        return b"".join(chunks), content_type

    async def fetch_preview(self, sound_id: int, quality: str = "preview-hq-mp3") -> Tuple[bytes, str]:
        """Preview audio for a sound (preview quality, no OAuth needed)."""
        url = await self.resolve_preview_url(sound_id, quality)
        return await self.fetch_media(url)

    async def fetch_original(self, sound_id: int) -> Tuple[bytes, str]:
        """Original-quality file. Requires an OAuth2 bearer token."""
        url = f"{self.base_url}{DOWNLOAD_PATH.format(sound_id=sound_id)}"
        return await self.fetch_media(url, oauth=True, max_bytes=MAX_DOWNLOAD_BYTES)

    # ---------------------------------------------------------------- probe

    async def probe(self) -> Dict[str, Any]:
        """One cheap authenticated request that proves the key works.

        Returns a truthful verdict — ``connected`` is ``True`` (key accepted),
        ``False`` (key rejected) or ``None`` (unknown: network/unreachable).
        """
        started = time.time()
        try:
            await self.request(
                "GET",
                SEARCH_PATH,
                {"query": "umbra", "page_size": "1", "fields": "id"},
                timeout=min(self.timeout, 10.0),
            )
        except FreesoundError as exc:
            return {
                "connected": False if exc.code in ("unauthorized", "rate_limited") else None,
                "code": exc.code,
                "reason": exc.message,
                "hint": exc.hint,
                "upstreamStatus": exc.upstream_status,
                "elapsedMs": int((time.time() - started) * 1000),
                "checkedAt": time.time(),
            }
        return {
            "connected": True,
            "code": None,
            "reason": None,
            "hint": None,
            "upstreamStatus": 200,
            "elapsedMs": int((time.time() - started) * 1000),
            "checkedAt": time.time(),
        }


# -------------------------------------------------------------------- status


def get_client(*, transport: Optional[httpx.AsyncBaseTransport] = None) -> FreesoundClient:
    """Build a client from the current environment."""
    return FreesoundClient(transport=transport)


def _probe_cache_key(client: Optional["FreesoundClient"] = None) -> str:
    client = client or get_client()
    return f"{client.base_url}|{key_hint(client.key)}"


def cached_probe(client: Optional["FreesoundClient"] = None) -> Optional[Dict[str, Any]]:
    """Last probe result for this key/base-url pair, if still fresh."""
    entry = _probe_cache.get(_probe_cache_key(client))
    if not entry:
        return None
    if time.time() - float(entry.get("checkedAt") or 0) > _PROBE_TTL_SECONDS:
        return None
    return entry


def forget_probes() -> None:
    """Drop cached probe results (tests, credential rotation)."""
    _probe_cache.clear()


async def status(
    *, probe: str = "auto", client: Optional["FreesoundClient"] = None
) -> Dict[str, Any]:
    """Connection status for the browser. Never includes the key.

    ``probe`` is ``never`` (config only), ``auto`` (cached for 60s) or
    ``always`` (force a live check). ``client`` is injectable so tests and the
    FastAPI dependency share one configured client.
    """
    client = client or get_client()
    has_key = bool(client.key)
    payload: Dict[str, Any] = {
        "provider": "freesound",
        "configured": has_key,
        "connected": None,
        "keySource": f"environment:{API_KEY_ENV}" if has_key else None,
        "keyHint": key_hint(client.key),
        "oauth": {
            "configured": bool(client.oauth),
            "quality": "original" if client.oauth else "preview",
        },
        "apiBase": client.base_url,
        "probed": False,
        "reason": None,
        "hint": None,
        "checkedAt": None,
        "elapsedMs": None,
        "capabilities": {
            "search": True,
            "metadata": True,
            "preview": True,
            "similar": True,
            "audioFeatures": True,
            "originalDownload": bool(client.oauth),
        },
    }
    if not has_key:
        payload["reason"] = (
            f"No Freesound API key configured on the backend ({API_KEY_ENV} is unset)."
        )
        payload["hint"] = (
            "Copy .env.example to .env, set FREESOUND_API_KEY=<your Freesound client "
            "secret / API key>, then restart the backend. The key is never stored in "
            "the browser. See docs/development/FREESOUND.md."
        )
        return payload

    cached = cached_probe(client)
    if probe == "never":
        if cached:
            payload.update(
                connected=cached.get("connected"),
                reason=cached.get("reason"),
                hint=cached.get("hint"),
                probed=True,
                checkedAt=cached.get("checkedAt"),
                elapsedMs=cached.get("elapsedMs"),
            )
        else:
            payload["reason"] = "Not checked yet — the last status call did not probe Freesound."
        return payload

    if probe == "auto" and cached:
        payload.update(
            connected=cached.get("connected"),
            reason=cached.get("reason"),
            hint=cached.get("hint"),
            probed=True,
            checkedAt=cached.get("checkedAt"),
            elapsedMs=cached.get("elapsedMs"),
        )
        return payload

    result = await client.probe()
    _probe_cache[_probe_cache_key(client)] = result
    payload.update(
        connected=result.get("connected"),
        probed=True,
        reason=result.get("reason"),
        hint=result.get("hint"),
        checkedAt=result.get("checkedAt"),
        elapsedMs=result.get("elapsedMs"),
    )
    if result.get("connected"):
        payload["reason"] = None
        payload["hint"] = None
    return payload


def configured() -> bool:
    """Whether an API key is present (no network)."""
    return bool(api_key())


async def iter_preview(sound_id: int, quality: str) -> AsyncIterator[bytes]:  # pragma: no cover
    """Streaming helper kept for future use; previews are fetched in full."""
    data, _ = await get_client().fetch_preview(sound_id, quality)
    yield data
