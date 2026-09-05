"""Freesound HTTP surface: the only way the browser reaches Freesound.

Routes (all under ``/api/integrations/freesound``):

    GET  /status                       configuration + real connection state
    POST /search                       authenticated search
    GET  /sounds/{id}                  metadata for one sound
    GET  /sounds/{id}/similar          laion_clap similarity
    GET  /sounds/{id}/analysis         audio feature descriptors
    GET  /sounds/{id}/preview          preview audio (proxied, no key needed)
    GET  /sounds/{id}/download         original quality (OAuth2 required)

Two promises hold for every route:

1. **The credential never appears in a response.** Status reports
   ``configured`` / ``connected`` and a sha256 fingerprint — never the key.
2. **No silent substitution.** When the key is missing or rejected the route
   returns an explicit error code (``not_configured`` → 503,
   ``unauthorized`` → 502). Nothing here invents results.

Sound payloads are forwarded from Freesound unchanged, so the retrieval
pipeline keeps mapping creator / license / source-url / previews itself and
provenance is preserved end to end.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.integrations import freesound as fs

log = logging.getLogger("umbra.integrations.router")

router = APIRouter(prefix="/api/integrations/freesound", tags=["integrations"])


class SearchRequest(BaseModel):
    """Body of ``POST /api/integrations/freesound/search``."""

    query: str = Field(min_length=1, max_length=512)
    page: int = Field(default=1, ge=1, le=500)
    pageSize: int = Field(default=fs.DEFAULT_PAGE_SIZE, ge=1, le=fs.MAX_PAGE_SIZE)
    filters: List[str] = Field(default_factory=list)
    sort: str = Field(default="score", max_length=64)
    fields: Optional[str] = None


def get_client() -> fs.FreesoundClient:
    """FastAPI dependency — overridable in tests with a mocked transport."""
    return fs.get_client()


def _error(exc: fs.FreesoundError) -> JSONResponse:
    return JSONResponse(status_code=exc.http_status, content=exc.to_json())


# --------------------------------------------------------------------- status


@router.get("/status")
async def status(
    probe: str = Query("auto", pattern="^(never|auto|always)$"),
    client: fs.FreesoundClient = Depends(get_client),
) -> Dict[str, Any]:
    """Is Freesound configured, and does the configured key actually work?

    Always returns 200: a misconfigured integration is a *status*, not a
    server error. ``connected`` is ``true`` (key accepted), ``false`` (key
    rejected) or ``null`` (unknown — Freesound unreachable / not probed).
    """
    return await fs.status(probe=probe, client=client)


# --------------------------------------------------------------------- search


@router.post("/search")
async def search(
    payload: SearchRequest, client: fs.FreesoundClient = Depends(get_client)
) -> Dict[str, Any]:
    """Authenticated Freesound search. Raw sound objects, nothing invented."""
    try:
        body = await client.search(
            payload.query,
            page=payload.page,
            page_size=payload.pageSize,
            filters=payload.filters,
            sort=payload.sort,
            fields=payload.fields,
        )
    except fs.FreesoundError as exc:
        return _error(exc)
    results = body.get("results") or []
    return {
        "provider": "freesound",
        "query": payload.query,
        "count": body.get("count", len(results)),
        "page": payload.page,
        "pageSize": payload.pageSize,
        "next": body.get("next"),
        "previous": body.get("previous"),
        "sounds": results,
    }


# ---------------------------------------------------------------------- sound


@router.get("/sounds/{sound_id}")
async def sound(sound_id: int, client: fs.FreesoundClient = Depends(get_client)) -> Any:
    """Metadata for one sound (creator, license, source url, previews…)."""
    try:
        body = await client.sound(sound_id)
    except fs.FreesoundError as exc:
        return _error(exc)
    return {"provider": "freesound", "sound": body}


@router.get("/sounds/{sound_id}/similar")
async def similar(
    sound_id: int,
    page: int = Query(1, ge=1, le=500),
    page_size: int = Query(20, ge=1, le=fs.MAX_PAGE_SIZE),
    client: fs.FreesoundClient = Depends(get_client),
) -> Any:
    """Similar sounds via Freesound's ``laion_clap`` similarity space."""
    try:
        body = await client.similar(sound_id, page=page, page_size=page_size)
    except fs.FreesoundError as exc:
        return _error(exc)
    results = body.get("results") or []
    return {
        "provider": "freesound",
        "count": body.get("count", len(results)),
        "page": page,
        "pageSize": page_size,
        "sounds": results,
    }


@router.get("/sounds/{sound_id}/analysis")
async def analysis(
    sound_id: int,
    descriptors: Optional[str] = None,
    client: fs.FreesoundClient = Depends(get_client),
) -> Any:
    """Audio feature descriptors Freesound extracted from the sound."""
    try:
        body = await client.analysis(sound_id, descriptors)
    except fs.FreesoundError as exc:
        return _error(exc)
    return {"provider": "freesound", "soundId": str(sound_id), "features": body}


# ---------------------------------------------------------------------- media


@router.get("/sounds/{sound_id}/preview")
async def preview(
    sound_id: int,
    quality: str = Query("preview-hq-mp3", pattern="^preview-(hq|lq)-(mp3|ogg)$"),
    client: fs.FreesoundClient = Depends(get_client),
) -> Any:
    """Preview audio, proxied so the browser never needs the API key.

    Preview quality is *always* what this returns: previews are what the
    upstream preview URLs serve. Original quality is ``/download``.
    """
    try:
        data, content_type = await client.fetch_preview(sound_id, quality)
    except fs.FreesoundError as exc:
        return _error(exc)
    return Response(
        content=data,
        media_type=content_type or "audio/mpeg",
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Umbra-Quality": "preview",
            "X-Umbra-Sound-Id": str(sound_id),
        },
    )


@router.get("/sounds/{sound_id}/download")
async def download(sound_id: int, client: fs.FreesoundClient = Depends(get_client)) -> Any:
    """Original-quality file. Freesound requires OAuth2 for this endpoint.

    Without ``FREESOUND_OAUTH_TOKEN`` this fails loudly (501
    ``oauth_required``) — it never quietly returns a preview instead.
    """
    try:
        data, content_type = await client.fetch_original(sound_id)
    except fs.FreesoundError as exc:
        return _error(exc)
    return Response(
        content=data,
        media_type=content_type or "audio/wav",
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Umbra-Quality": "original",
            "X-Umbra-Sound-Id": str(sound_id),
        },
    )
