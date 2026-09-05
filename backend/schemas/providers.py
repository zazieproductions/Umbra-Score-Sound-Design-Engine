"""
Umbra Score Provider Schemas

Core data structures for the hybrid audio generation system.
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class ProviderCapability(str, Enum):
    """Capabilities that audio providers can offer."""
    PROCEDURAL = "procedural"
    TEXT_TO_AUDIO = "text_to_audio"
    VIDEO_TO_AUDIO = "video_to_audio"
    AUDIO_EMBEDDING = "audio_embedding"
    TEXT_EMBEDDING = "text_embedding"
    SEMANTIC_SEARCH = "semantic_search"
    SCENE_DETECTION = "scene_detection"
    FOLEY = "foley"
    AMBIENCE = "ambience"
    MUSIC = "music"
    SFX = "sfx"


class DeviceType(str, Enum):
    """Hardware acceleration types."""
    CUDA = "cuda"
    MPS = "mps"  # Apple Metal Performance Shaders
    CPU = "cpu"


class ProviderStatus(str, Enum):
    """Provider availability status."""
    READY = "ready"
    NOT_INSTALLED = "not_installed"
    MODEL_MISSING = "model_missing"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class ProviderInfo(BaseModel):
    """Information about an audio provider."""
    name: str
    display_name: str
    description: str
    capabilities: list[ProviderCapability]
    device: DeviceType = DeviceType.CPU
    status: ProviderStatus = ProviderStatus.NOT_INSTALLED
    model_name: Optional[str] = None
    model_size_mb: Optional[float] = None
    error_message: Optional[str] = None
    version: Optional[str] = None


class ModelStatus(BaseModel):
    """Status information for a model."""
    name: str
    installed: bool
    device: DeviceType
    status: ProviderStatus
    size_mb: Optional[float] = None
    path: Optional[str] = None
    error: Optional[str] = None
