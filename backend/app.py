"""
Umbra Score ML Backend

FastAPI application for the hybrid procedural + generative audio system.
"""

import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .providers.registry import registry
from .providers.procedural_bridge import ProceduralBridge
from .providers.stable_audio import StableAudioProvider
from .providers.mmaudio import MMAudioProvider
from .providers.clap import ClapProvider
from .providers.pyscenedetect import PySceneDetectProvider

from .schemas.providers import ProviderInfo, DeviceType, ProviderStatus
from .schemas.generation import (
    GenerationRequest,
    GenerationResult,
    GeneratedAudio,
    SemanticSearchRequest,
    SemanticSearchResponse,
)
from .schemas.analysis import SceneDetectionRequest, SceneDetectionResponse

from .services.model_manager import ModelManager
from .services.audio_store import AudioStore
from .services.jobs import JobManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Paths
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Services
model_manager = ModelManager(
    models_dir=str(BASE_DIR / "models"),
    cache_dir=str(DATA_DIR / "cache"),
)
audio_store = AudioStore(
    data_dir=str(DATA_DIR),
    audio_dir=str(AUDIO_DIR),
)
job_manager = JobManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    # Startup
    logger.info("Starting Umbra Score ML Backend")
    
    # Register providers
    registry.register(ProceduralBridge())
    
    if StableAudioProvider().is_installed():
        registry.register(StableAudioProvider())
    
    if MMAudioProvider().is_installed():
        registry.register(MMAudioProvider())
    
    if ClapProvider().is_installed():
        registry.register(ClapProvider())
    
    if PySceneDetectProvider().is_installed():
        registry.register(PySceneDetectProvider())
    
    # Try to load all available providers
    await registry.load_all()
    
    logger.info(f"Registered {len(registry)} providers")
    
    yield
    
    # Shutdown
    logger.info("Shutting down Umbra Score ML Backend")
    await registry.unload_all()


# Create FastAPI app
app = FastAPI(
    title="Umbra Score ML Backend",
    description="Hybrid procedural + generative audio generation API",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===================== Health & Status =====================

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "0.1.0",
        "providers": len(registry),
    }


@app.get("/api/providers")
async def list_providers():
    """List all registered providers."""
    return {
        "providers": [p.model_dump() for p in registry.list_providers()],
        "available": [p.model_dump() for p in registry.available_providers],
    }


@app.get("/api/providers/{provider_name}")
async def get_provider(provider_name: str):
    """Get details about a specific provider."""
    provider = registry.get(provider_name)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_name}' not found")
    return provider.info.model_dump()


@app.get("/api/system/device")
async def get_device_info():
    """Get system device information."""
    return model_manager.get_device_info()


@app.get("/api/system/models")
async def list_models():
    """List installed models."""
    return {
        "models": model_manager.list_installed_models(),
        "cache": str(DATA_DIR / "cache"),
    }


# ===================== Generation =====================

@app.post("/api/generate", response_model=list[GenerationResult])
async def generate_audio(request: GenerationRequest):
    """
    Generate audio using the specified provider.
    
    Returns list of GeneratedAudio (one per variant).
    """
    provider = registry.get(request.provider.value)
    if not provider:
        raise HTTPException(
            status_code=400,
            detail=f"Provider '{request.provider.value}' not found"
        )
    
    if not await provider.is_available():
        raise HTTPException(
            status_code=503,
            detail=f"Provider '{request.provider.value}' is not available"
        )
    
    try:
        results = await provider.generate(request, str(AUDIO_DIR))
        
        # Save results to audio store
        for result in results:
            if result.filepath:
                audio_store.save(result)
        
        return [r.model_dump() for r in results]
        
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    """Get audio metadata."""
    audio = audio_store.load(audio_id)
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")
    return audio.model_dump()


@app.get("/api/audio/{audio_id}/download")
async def download_audio(audio_id: str):
    """Download audio file."""
    audio = audio_store.load(audio_id)
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")
    
    if not audio.filepath or not Path(audio.filepath).exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    return FileResponse(
        audio.filepath,
        media_type="audio/wav",
        filename=f"{audio_id}.wav",
    )


@app.get("/api/audio/{audio_id}/waveform")
async def get_waveform(
    audio_id: str,
    peaks: int = Query(default=200, ge=50, le=1000),
):
    """Get waveform peaks for visualization."""
    from .analysis.waveform import AudioAnalyzer
    
    audio = audio_store.load(audio_id)
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")
    
    if not audio.filepath or not Path(audio.filepath).exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    try:
        waveform_peaks = AudioAnalyzer.generate_waveform(audio.filepath, peaks)
        return {"audio_id": audio_id, "peaks": waveform_peaks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/audio/{audio_id}")
async def delete_audio(audio_id: str):
    """Delete audio from store."""
    if audio_store.delete(audio_id):
        return {"status": "deleted", "id": audio_id}
    raise HTTPException(status_code=404, detail="Audio not found")


# ===================== Semantic Search =====================

@app.post("/api/search", response_model=SemanticSearchResponse)
async def semantic_search(request: SemanticSearchRequest):
    """
    Perform semantic search on audio assets.
    """
    # Find CLAP provider
    providers = registry.get_by_capability(
        __import__('backend.schemas.providers', fromlist=['ProviderCapability']).ProviderCapability.SEMANTIC_SEARCH
    )
    
    if not providers:
        raise HTTPException(
            status_code=503,
            detail="Semantic search not available (CLAP not installed)"
        )
    
    clap = providers[0]
    
    try:
        response = await clap.search(request)
        return response.model_dump()
    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/index")
async def index_audio(
    audio_id: str,
    filepath: str,
    prompt: str = None,
    duration: float = 0,
):
    """
    Add an audio file to the search index.
    """
    # Find CLAP provider
    from backend.schemas.providers import ProviderCapability
    
    providers = registry.get_by_capability(ProviderCapability.AUDIO_EMBEDDING)
    
    if not providers:
        raise HTTPException(
            status_code=503,
            detail="Audio indexing not available (CLAP not installed)"
        )
    
    clap = providers[0]
    
    try:
        success = clap.index_audio(
            audio_id=audio_id,
            filepath=filepath,
            prompt=prompt,
            duration=duration,
        )
        return {"indexed": success, "audio_id": audio_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================== Scene Detection =====================

@app.post("/api/scenes/detect", response_model=SceneDetectionResponse)
async def detect_scenes(request: SceneDetectionRequest):
    """
    Detect scene boundaries in a video file.
    """
    # Find PySceneDetect provider
    providers = registry.get_by_capability(
        __import__('backend.schemas.providers', fromlist=['ProviderCapability']).ProviderCapability.SCENE_DETECTION
    )
    
    if not providers:
        raise HTTPException(
            status_code=503,
            detail="Scene detection not available (PySceneDetect not installed)"
        )
    
    pyscenedetect = providers[0]
    
    try:
        response = await pyscenedetect.detect_scenes(
            request,
            output_dir=str(DATA_DIR / "thumbnails"),
        )
        return response.model_dump()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Scene detection failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ===================== Jobs =====================

@app.get("/api/jobs")
async def list_jobs(state: str = None):
    """List all jobs."""
    from .services.jobs import JobState
    
    job_state = JobState(state) if state else None
    jobs = job_manager.list_jobs(state=job_state)
    
    return {
        "jobs": [
            {
                "id": j.id,
                "type": j.job_type,
                "state": j.state.value,
                "progress": j.progress,
                "message": j.message,
                "created_at": j.created_at.isoformat(),
                "started_at": j.started_at.isoformat() if j.started_at else None,
                "completed_at": j.completed_at.isoformat() if j.completed_at else None,
                "error": j.error,
            }
            for j in jobs
        ]
    }


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    """Get job details."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    return {
        "id": job.id,
        "type": job.job_type,
        "state": job.state.value,
        "progress": job.progress,
        "message": job.message,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "error": job.error,
        "result": job.result,
    }


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Cancel a running job."""
    if job_manager.cancel_job(job_id):
        return {"status": "cancelled", "job_id": job_id}
    raise HTTPException(status_code=400, detail="Job cannot be cancelled")


# ===================== Storage =====================

@app.get("/api/storage/stats")
async def get_storage_stats():
    """Get storage statistics."""
    return audio_store.get_storage_stats()


@app.post("/api/storage/cleanup")
async def cleanup_storage():
    """Clean up orphaned metadata."""
    result = audio_store.cleanup_orphaned()
    return result


# ===================== Run Server =====================

if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info",
    )
