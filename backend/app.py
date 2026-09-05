"""UMBRA local ML backend.

A small FastAPI service that owns everything Python should own:

    trained-model inference · model loading · embeddings · heavy analysis

and nothing that the browser already does well. Web Audio keeps the timeline,
playback, editing, realtime procedural synthesis, mixing and metering.

Run it with::

    python -m uvicorn backend.app:app --port 8000 --reload

or::

    python scripts/run_backend.py

The Vite dev server proxies ``/api`` here, so the browser only ever talks to
its own origin — no CORS games and nothing hard-coded to localhost in
frontend code.
"""

from __future__ import annotations

import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from backend.analysis import embeddings as embeddings_service
from backend.analysis.events import analyze_video_events
from backend.analysis.scenes import detect_cuts, plan_project, plan_scene
from backend.analysis.spotting import HORROR_PRESETS, build_prompt
from backend.analysis.video import probe_video, toolchain_status
from backend.analysis.waveform import analyze_features, generate_peaks
from backend.providers.base import GenerationRequest, ProviderError
from backend.providers.registry import get_registry, route_intent
from backend.services import model_manager
from backend.services import credentials as credentials_service
from backend.services.audio_store import AudioDecodeError, get_audio_store
from backend.services.device import runtime_summary
from backend.services.freesound import (
    FreesoundClient,
    FreesoundError,
    OAuthStateError,
    OAuthStateStore,
    get_freesound_client,
)
from backend.services.generation_jobs import JobManager

# Best-effort .env loading for the local installation (never overrides real
# environment variables). python-dotenv is optional at runtime.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=os.environ.get("UMBRA_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("umbra.app")

VERSION = "0.1.0"

#: The exact origin allowlist already used by the CORS middleware. The
#: integration endpoints additionally *enforce* it for browser requests so a
#: drive-by page can never POST credentials or consume OAuth state. Requests
#: without an Origin header (curl, the Vite server proxy) pass.
_TRUSTED_ORIGIN = re.compile(
    r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://.*\.e2b\.app$"
)


def require_trusted_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and not _TRUSTED_ORIGIN.match(origin):
        raise HTTPException(status_code=403, detail="request origin is not allowed here")


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry = get_registry()
    store = get_audio_store()
    jobs = JobManager(registry, workers=int(os.environ.get("UMBRA_WORKERS", "1")))
    await jobs.start()

    # Freesound integration: encrypted credential vault + server-side client.
    cred_store = credentials_service.get_credential_store()
    freesound = get_freesound_client()

    app.state.registry = registry
    app.state.store = store
    app.state.jobs = jobs
    app.state.credentials = cred_store
    app.state.freesound = freesound
    app.state.oauth_states = OAuthStateStore()

    # Scrub known secret values from every log record that reaches a root
    # handler (defense in depth — error paths redact at construction too).
    redaction = credentials_service.SecretRedactingFilter(cred_store)
    for handler in logging.getLogger().handlers:
        if not any(isinstance(f, credentials_service.SecretRedactingFilter) for f in handler.filters):
            handler.addFilter(redaction)

    ready = [s.id for s in registry.statuses() if s.ready]
    log.info("UMBRA backend %s ready — providers online: %s", VERSION, ", ".join(ready) or "none")
    log.info("audio store: %s", store.root)
    log.info(
        "credential vault: %s (encryption key %s)",
        cred_store.db_path,
        "configured" if cred_store.encryption_key_configured else "NOT configured — set "
        "UMBRA_CREDENTIAL_ENCRYPTION_KEY to store integration credentials",
    )
    try:
        yield
    finally:
        await freesound.aclose()
        await jobs.stop()


app = FastAPI(title="UMBRA local ML backend", version=VERSION, lifespan=lifespan)

# The browser talks to the Vite origin and Vite proxies here, so CORS is only
# a convenience for direct API poking during development.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://.*\.e2b\.app$",
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


def _err(exc: ProviderError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"error": str(exc), "hint": exc.hint},
    )


# --------------------------------------------------------------------- health


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    """Liveness plus a fully-real runtime snapshot."""
    return {
        "status": "ok",
        "service": "umbra-backend",
        "version": VERSION,
        "runtime": runtime_summary(),
        "audioStore": app.state.store.stats(),
        "jobs": app.state.jobs.stats(),
    }


# ------------------------------------------------------------------ providers


@app.get("/api/providers")
async def providers() -> Dict[str, Any]:
    """Every provider with genuinely-probed install state and capabilities."""
    return {"providers": [s.to_json() for s in app.state.registry.statuses()]}


@app.get("/api/models")
async def models() -> Dict[str, Any]:
    """The Models view: real checkpoints on disk, real packages, real devices."""
    return {
        "runtime": runtime_summary(),
        "providers": [s.to_json() for s in app.state.registry.statuses()],
        **model_manager.model_report().to_json(),
    }


# ------------------------------------------------------------------- planning


@app.post("/api/plan/scene")
async def plan_one_scene(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Structured musical intent for one span of film, before any generation."""
    start = float(payload.get("start", 0.0))
    # accept either an explicit end or a duration
    if payload.get("end") is not None:
        end = float(payload["end"])
    elif payload.get("duration") is not None:
        end = start + float(payload["duration"])
    else:
        end = start + 12.0

    plan = plan_scene(
        start=start,
        end=end,
        tension=float(payload.get("tension", 0.5)),
        motion=float(payload.get("motion", 0.4)),
        scene_id=payload.get("sceneId"),
        label=payload.get("label") or "Scene",
        index=int(payload.get("index", 1)),
        intent=payload.get("intent") or "",
    )
    return {"plan": plan.to_json(), "text": plan.as_text()}


@app.post("/api/plan/project")
async def plan_whole_project(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    scenes = payload.get("scenes") or []
    plans = plan_project(scenes)
    return {"plans": [p.to_json() for p in plans]}


@app.post("/api/prompt/build")
async def prompt_build(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Horror-first prompt interpretation — always shown to the composer."""
    plan = build_prompt(
        payload.get("intent") or payload.get("prompt") or "",
        key=payload.get("key"),
        mode=payload.get("mode"),
        bpm=payload.get("bpm"),
        time_signature=payload.get("timeSignature"),
        duration=float(payload.get("duration", 12.0)),
        density=payload.get("density"),
        dread=payload.get("dread"),
        tension=payload.get("tension"),
        extra_negatives=payload.get("extraNegatives"),
        instrumental=bool(payload.get("instrumental", True)),
    )
    return {"plan": plan.to_json()}


@app.get("/api/prompt/presets")
async def prompt_presets() -> Dict[str, Any]:
    return {"presets": HORROR_PRESETS}


@app.post("/api/route")
async def route(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Explain which engine should handle a natural-language request."""
    available = [s.id for s in app.state.registry.statuses() if s.ready]
    decision = route_intent(
        payload.get("text") or "",
        has_video_selection=bool(payload.get("hasVideoSelection")),
        available=available,
    )
    return {"route": decision.to_json(), "available": available}


# ----------------------------------------------------------------- generation


@app.post("/api/generate")
async def generate(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Queue a generation job. Returns immediately with a job id."""
    request = GenerationRequest.from_json(payload)
    provider = app.state.registry.get(request.provider)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"unknown provider '{request.provider}'")

    status = provider.status()
    if not status.ready:
        return JSONResponse(
            status_code=503,
            content={
                "error": f"{status.label} is not ready.",
                "hint": status.install_hint,
                "notes": status.notes,
            },
        )

    job = app.state.jobs.submit(request)
    return {"job": job.to_json()}


@app.get("/api/jobs")
async def list_jobs(limit: int = Query(50, ge=1, le=200)) -> Dict[str, Any]:
    return {
        "jobs": [j.to_json() for j in app.state.jobs.list(limit)],
        "stats": app.state.jobs.stats(),
    }


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> Dict[str, Any]:
    job = app.state.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {"job": job.to_json()}


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> Dict[str, Any]:
    ok = app.state.jobs.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail="job is not cancellable")
    return {"cancelled": True}


# ---------------------------------------------------------------------- audio


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    """Serve real audio bytes. This is what the timeline decodes and plays."""
    rec = app.state.store.get(audio_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="audio not found")
    path = Path(rec.path)
    if not path.exists():
        raise HTTPException(status_code=410, detail="audio file no longer on disk")
    media = "audio/wav" if path.suffix.lower() == ".wav" else "application/octet-stream"
    return FileResponse(path, media_type=media, filename=rec.filename)


@app.get("/api/audio")
async def list_audio(kind: Optional[str] = None) -> Dict[str, Any]:
    return {
        "audio": [r.to_json() for r in app.state.store.list(kind)],
        "stats": app.state.store.stats(),
    }


@app.delete("/api/audio/{audio_id}")
async def delete_audio(audio_id: str) -> Dict[str, Any]:
    if not app.state.store.delete(audio_id):
        raise HTTPException(status_code=404, detail="audio not found")
    return {"deleted": True}


@app.post("/api/audio/upload")
async def upload_audio(
    file: UploadFile = File(...),
    kind: str = Query("reference"),
) -> Dict[str, Any]:
    """Accept composer-supplied reference audio.

    It stays on this machine. Umbra never uploads a user's reference material
    anywhere, and never fetches third-party copyrighted audio to condition on.
    """
    data = await file.read()
    suffix = Path(file.filename or "reference.wav").suffix or ".wav"
    try:
        rec = app.state.store.register_bytes(
            data,
            provider="user",
            suffix=suffix,
            kind=kind,
            metadata={"originalName": file.filename, "local": True},
            filename=file.filename,
        )
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"audio": rec.to_json()}


# --------------------------------------------------------------------- search


@app.post("/api/search")
async def search(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Semantic library search via CLAP, over local files only."""
    query = (payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    return await embeddings_service.search_library(query, limit=int(payload.get("limit", 12)))


# ------------------------------------------------------------------- analysis


@app.post("/api/analysis/cuts")
async def analysis_cuts(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Real cut detection with PySceneDetect, or an honest 'not installed'."""
    path = payload.get("path")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    result = detect_cuts(
        Path(path),
        threshold=float(payload.get("threshold", 27.0)),
        min_scene_seconds=float(payload.get("minSceneSeconds", 1.5)),
    )
    return result.to_json()


@app.post("/api/analysis/video")
async def analysis_video(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Real container metadata via ffprobe, or an honest 'ffmpeg not found'."""
    path = payload.get("path")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    return probe_video(Path(path)).to_json()


@app.post("/api/analysis/events")
async def analysis_events(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Pixel motion-event analysis for a video file on the backend.

    Same deterministic spec as the browser analyzer. Bounded frame budget;
    missing ffmpeg degrades to ``available:false`` (never fabricated).
    """
    path = payload.get("path")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    result = analyze_video_events(
        Path(path),
        fps=float(payload.get("fps", 6.0)),
        max_frames=int(payload.get("maxFrames", 480)),
        scene_id=payload.get("sceneId") or "",
        scene_start=float(payload.get("sceneStart", 0.0)),
        title=payload.get("title") or "",
        tags=payload.get("tags") or [],
        summary=payload.get("summary") or "",
    )
    return result


@app.get("/api/analysis/toolchain")
async def analysis_toolchain() -> Dict[str, Any]:
    """Which external video tools are actually on PATH."""
    return toolchain_status()


@app.get("/api/audio/{audio_id}/peaks")
async def audio_peaks(audio_id: str, bins: int = Query(200, ge=16, le=2000)) -> Dict[str, Any]:
    """Waveform peaks for a stored file.

    The frontend normally draws from its own decoded AudioBuffer; this exists
    for reference material the browser has not decoded.
    """
    path = app.state.store.path_for(audio_id)
    if path is None:
        raise HTTPException(status_code=404, detail=f"unknown audio id '{audio_id}'")
    return generate_peaks(path, bins).to_json()


@app.get("/api/audio/{audio_id}/features")
async def audio_features(audio_id: str) -> Dict[str, Any]:
    """Measured RMS / peak / crest for a stored file.

    Real measurements — used to catch a silent or clipped generation result
    rather than letting it reach the timeline unnoticed.
    """
    path = app.state.store.path_for(audio_id)
    if path is None:
        raise HTTPException(status_code=404, detail=f"unknown audio id '{audio_id}'")
    return analyze_features(path).to_json()


# ------------------------------------------------- integrations: freesound
#
# Credentials are backend-managed. The browser may only learn whether the
# integration is configured and usable — status responses never contain
# apiKey / clientSecret / accessToken / refreshToken / the encryption key.


def _fs() -> FreesoundClient:
    return app.state.freesound


def _vault():
    return app.state.credentials


def _freesound_http_error(exc: FreesoundError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"error": str(exc), "hint": exc.hint},
    )


@app.get("/api/integrations/freesound/status", dependencies=[Depends(require_trusted_origin)])
async def freesound_integration_status() -> Dict[str, Any]:
    """Safe status ladder — configured / usable / verified, never secrets."""
    return _vault().freesound_status()


@app.post("/api/integrations/freesound/configure", dependencies=[Depends(require_trusted_origin)])
async def freesound_integration_configure(
    payload: Dict[str, Any] = Body(...),
) -> Dict[str, Any]:
    """Store Freesound credentials server-side (encrypted at rest).

    Accepts any subset of {apiKey, clientId, clientSecret, redirectUri}.
    Provided-but-empty values clear a field. The secret travels exactly
    once, in this POST body over the local connection, and is never
    returned or redisplayed.
    """
    patch: Dict[str, str] = {}
    for field in ("apiKey", "clientId", "clientSecret", "redirectUri"):
        if field not in payload:
            continue
        value = payload[field]
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise HTTPException(status_code=400, detail=f"'{field}' must be a string")
        patch[field] = value.strip()
    if not patch:
        raise HTTPException(
            status_code=400,
            detail="nothing to configure — provide apiKey, clientId, clientSecret and/or redirectUri",
        )
    if not any(patch.values()) and not _vault().has_record("freesound"):
        raise HTTPException(status_code=400, detail="no credentials provided")
    try:
        _vault().save("freesound", patch)
    except credentials_service.CredentialsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    log.info(
        "freesound integration: credentials updated (fields: %s)",
        ", ".join(sorted(k for k, v in patch.items() if v)) or "cleared",
    )
    return {"saved": True, "status": _vault().freesound_status()}


@app.delete("/api/integrations/freesound/configure", dependencies=[Depends(require_trusted_origin)])
async def freesound_integration_disconnect() -> Dict[str, Any]:
    """Disconnect: delete every stored Freesound secret from the backend."""
    deleted = _vault().delete("freesound")
    log.info("freesound integration: disconnected (stored credentials deleted: %s)", deleted)
    return {"deleted": deleted, "status": _vault().freesound_status()}


@app.post("/api/integrations/freesound/verify", dependencies=[Depends(require_trusted_origin)])
async def freesound_integration_verify() -> Dict[str, Any]:
    """Test Connection: a real authenticated request to freesound.org.

    Verified means Freesound returned a successful response — never merely
    that a key exists. The outcome (and honest error) is recorded.
    """
    try:
        report = await _fs().verify()
    except FreesoundError as exc:
        return _freesound_http_error(exc)
    if _vault().has_record("freesound"):
        _vault().record_verification("freesound", report["verified"], report.get("error"))
    if report["verified"]:
        log.info("freesound integration: connection verified (%s)", "; ".join(report["checks"]))
    else:
        log.warning("freesound integration: verification FAILED — %s", report.get("error"))
    return {
        "verification": {**report, "checkedAt": int(time.time() * 1000)},
        "status": _vault().freesound_status(),
    }


@app.post("/api/integrations/freesound/oauth/start", dependencies=[Depends(require_trusted_origin)])
async def freesound_oauth_start(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    """Begin the OAuth2 authorization-code flow.

    The backend issues a cryptographically random, single-use, expiring
    state and returns the (secret-free) authorization URL for the browser to
    open. The secret-bearing exchange happens server-side in /oauth/exchange.
    """
    try:
        state, ttl = app.state.oauth_states.issue()
        redirect_uri = (payload.get("redirectUri") or "").strip() or None
        url = _fs().authorize_url(state, redirect_uri)
    except FreesoundError as exc:
        return _freesound_http_error(exc)
    return {"authorizeUrl": url, "expiresInSeconds": ttl}


@app.post("/api/integrations/freesound/oauth/exchange", dependencies=[Depends(require_trusted_origin)])
async def freesound_oauth_exchange(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Exchange the authorization code for tokens (server-side only).

    The state is validated against the one issued by /oauth/start: it must
    exist, be unexpired, and is consumed on first use (CSRF-safe).
    """
    code = str(payload.get("code") or "").strip()
    state = str(payload.get("state") or "")
    if not code or not state:
        raise HTTPException(status_code=400, detail="both 'code' and 'state' are required")
    try:
        app.state.oauth_states.consume(state)
    except OAuthStateError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        await _fs().exchange_code(code)
    except credentials_service.CredentialsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except FreesoundError as exc:
        return _freesound_http_error(exc)
    return {"status": _vault().freesound_status()}


@app.post("/api/integrations/freesound/oauth/refresh", dependencies=[Depends(require_trusted_origin)])
async def freesound_oauth_refresh() -> Dict[str, Any]:
    """Refresh the stored OAuth2 access token now."""
    try:
        await _fs().refresh_access_token()
    except credentials_service.CredentialsError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except FreesoundError as exc:
        return _freesound_http_error(exc)
    return {"status": _vault().freesound_status()}


# ---------------------------------------------------- library: freesound
#
# The retrieval pipeline (planner → provider search → license gate →
# ranking → CLAP rerank → cache → AudioClip) stays in the frontend; these
# endpoints are the authenticated Freesound transport it calls. The browser
# request carries no Freesound credential — the backend attaches the stored
# one when talking to freesound.org.

_SEARCH_PARAM_ALLOWLIST = ("query", "page", "page_size", "filter", "sort", "fields", "group_by_pack")
_SIMILAR_PARAM_ALLOWLIST = ("page", "page_size", "similarity_space", "fields")
_ANALYSIS_PARAM_ALLOWLIST = ("fields",)


def _forwarded(query_params, allowlist: tuple) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key in allowlist:
        if key in query_params:
            out[key] = query_params[key]
    for key in ("page", "page_size"):
        if key in out:
            try:
                out[key] = int(out[key])
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"'{key}' must be an integer")
    return out


@app.get("/api/library/freesound/search", dependencies=[Depends(require_trusted_origin)])
async def library_freesound_search(request: Request) -> Dict[str, Any]:
    params = _forwarded(request.query_params, _SEARCH_PARAM_ALLOWLIST)
    if not params.get("query"):
        raise HTTPException(status_code=400, detail="'query' is required")
    try:
        return await _fs().search(
            params["query"],
            page=params.get("page", 1),
            page_size=params.get("page_size", 30),
            filter_=params.get("filter"),
            sort=params.get("sort"),
            fields=params.get("fields"),
        )
    except FreesoundError as exc:
        return _freesound_http_error(exc)


@app.get("/api/library/freesound/sounds/{sound_id}", dependencies=[Depends(require_trusted_origin)])
async def library_freesound_sound(sound_id: int, request: Request) -> Dict[str, Any]:
    fields = request.query_params.get("fields")
    try:
        return await _fs().sound(sound_id, fields)
    except FreesoundError as exc:
        return _freesound_http_error(exc)


@app.get("/api/library/freesound/sounds/{sound_id}/similar", dependencies=[Depends(require_trusted_origin)])
async def library_freesound_similar(sound_id: int, request: Request) -> Dict[str, Any]:
    params = _forwarded(request.query_params, _SIMILAR_PARAM_ALLOWLIST)
    try:
        return await _fs().similar(
            sound_id,
            page=params.get("page", 1),
            page_size=params.get("page_size", 20),
            similarity_space=params.get("similarity_space", "laion_clap"),
            fields=params.get("fields"),
        )
    except FreesoundError as exc:
        return _freesound_http_error(exc)


@app.get("/api/library/freesound/sounds/{sound_id}/analysis", dependencies=[Depends(require_trusted_origin)])
async def library_freesound_analysis(sound_id: int, request: Request) -> Dict[str, Any]:
    fields = request.query_params.get("fields")
    try:
        return await _fs().analysis(sound_id, fields)
    except FreesoundError as exc:
        return _freesound_http_error(exc)


@app.get("/api/library/freesound/sounds/{sound_id}/download", dependencies=[Depends(require_trusted_origin)])
async def library_freesound_download(sound_id: int):
    """Original-quality file. OAuth2 Bearer is attached by the backend (with
    automatic refresh); the browser sends nothing but the sound id."""
    try:
        resp = await _fs().download(sound_id)
    except FreesoundError as exc:
        return _freesound_http_error(exc)
    media_type = resp.headers.get("content-type", "application/octet-stream")
    return Response(content=resp.content, media_type=media_type)
