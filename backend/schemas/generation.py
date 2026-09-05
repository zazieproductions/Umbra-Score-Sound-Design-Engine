"""
Umbra Score Generation Schemas

Request and response structures for audio generation.
"""

from typing import Optional
from pydantic import BaseModel, Field
from enum import Enum


class GenerationProvider(str, Enum):
    """Available generation providers."""
    PROCEDURAL = "procedural"
    STABLE_AUDIO = "stable_audio"
    MMAUDIO = "mmaudio"
    CLAP_SEARCH = "clap_search"


class AudioFormat(str, Enum):
    """Output audio format."""
    WAV_24BIT = "wav_24bit"
    WAV_16BIT = "wav_16bit"
    FLAC = "flac"


class GenerationRequest(BaseModel):
    """Request for audio generation."""
    provider: GenerationProvider
    prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    duration: float = Field(default=5.0, ge=0.5, le=120.0, description="Duration in seconds")
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)
    num_variants: int = Field(default=1, ge=1, le=5)
    
    # Timing information
    scene_id: Optional[str] = None
    timeline_start: Optional[float] = None
    
    # Video source for MMAudio
    source_video: Optional[str] = None
    source_range_start: Optional[float] = None
    source_range_end: Optional[float] = None
    
    # Audio processing parameters
    sample_rate: int = 48000
    normalize: bool = True
    
    class Config:
        json_schema_extra = {
            "example": {
                "provider": "stable_audio",
                "prompt": "thin corroded metal scraping behind a concrete wall, distant, sparse, no music",
                "negative_prompt": "music, dialogue, bright sounds",
                "duration": 4.0,
                "num_variants": 3
            }
        }


class GenerationResult(BaseModel):
    """Result of audio generation."""
    id: str
    provider: GenerationProvider
    filepath: Optional[str] = None
    duration: float
    sample_rate: int
    channels: int
    seed: Optional[int] = None
    prompt: Optional[str] = None
    metadata: dict = Field(default_factory=dict)
    error: Optional[str] = None
    status: str = "pending"


class GeneratedAudio(BaseModel):
    """Generated audio with full metadata."""
    id: str
    filepath: str
    duration: float
    sample_rate: int
    channels: int
    provider: GenerationProvider
    model: Optional[str] = None
    prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    seed: Optional[int] = None
    variant_index: Optional[int] = None
    metadata: dict = Field(default_factory=dict)
    waveform_peaks: Optional[list[float]] = None
    embedding: Optional[list[float]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "id": "gen_abc123",
                "filepath": "/data/audio/gen_abc123.wav",
                "duration": 4.0,
                "sample_rate": 48000,
                "channels": 2,
                "provider": "stable_audio",
                "prompt": "distant pipe resonance"
            }
        }


class SemanticSearchRequest(BaseModel):
    """Request for semantic audio search."""
    query: str = Field(description="Text query to search for")
    limit: int = Field(default=10, ge=1, le=50)
    include_generated: bool = True
    include_imported: bool = True
    provider: Optional[GenerationProvider] = None


class SemanticSearchResult(BaseModel):
    """Result of semantic search."""
    audio_id: str
    filepath: str
    similarity: float = Field(ge=0.0, le=1.0)
    prompt: Optional[str] = None
    provider: GenerationProvider
    duration: float


class SemanticSearchResponse(BaseModel):
    """Response containing search results."""
    query: str
    results: list[SemanticSearchResult]
    total: int
    search_time_ms: float
