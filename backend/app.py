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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backend.analysis import embeddings as embeddings_service
from backend.analysis.scenes import detect_cuts, plan_project, plan_scene
from backend.analysis.spotting import HORROR_PRESETS, build_prompt
from backend.providers.base import GenerationRequest, ProviderError
from backend.providers.registry import get_registry, route_intent
from backend.services import model_manager
from backend.services.audio_store import AudioDecodeError, get_audio_store
from backend.services.device import runtime_summary
from backend.services.generation_jobs import JobManager

logging.basicConfig(
    level=os.environ.get("UMBRA_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("umbra.app")

VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry = get_registry()
    store = get_audio_store()
    jobs = JobManager(registry, workers=int(os.environ.get("UMBRA_WORKERS", "1")))
    await jobs.start()

    app.state.registry = registry
    app.state.store = store
    app.state.jobs = jobs

    ready = [s.id for s in registry.statuses() if s.ready]
    log.info("UMBRA backend %s ready — providers online: %s", VERSION, ", ".join(ready) or "none")
    log.info("audio store: %s", store.root)
    try:
        yield
    finally:
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
