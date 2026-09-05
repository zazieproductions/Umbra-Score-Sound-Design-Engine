"""
Umbra Score Analysis Schemas

Schemas for video analysis and scene detection.
"""

from typing import Optional
from pydantic import BaseModel, Field


class SceneDetectionRequest(BaseModel):
    """Request for video scene detection."""
    video_path: str
    threshold: float = Field(default=30.0, ge=1.0, le=100.0, description="Detection threshold")
    min_scene_len: float = Field(default=0.5, ge=0.1, le=30.0, description="Minimum scene duration in seconds")
    detector: str = Field(default="threshold", description="Detector type: threshold, content, or adaptive")
    show_progress: bool = True


class DetectedScene(BaseModel):
    """A detected scene boundary."""
    index: int
    start_frame: int
    end_frame: int
    start_time: float
    end_time: float
    duration: float
    cut_type: str = "cut"  # cut, fade, dissolve, wipe, etc.
    confidence: float = Field(ge=0.0, le=1.0)
    thumbnail_path: Optional[str] = None


class SceneDetectionResponse(BaseModel):
    """Response from scene detection."""
    video_path: str
    total_frames: int
    fps: float
    duration: float
    scenes: list[DetectedScene]
    total_scenes: int
    processing_time_seconds: float


class VideoAnalysisRequest(BaseModel):
    """Request for comprehensive video analysis."""
    video_path: str
    extract_thumbnails: bool = True
    thumbnail_interval: float = Field(default=5.0, ge=1.0, le=60.0)
    detect_scenes: bool = True
    analyze_audio: bool = False


class VideoAnalysisResponse(BaseModel):
    """Response from video analysis."""
    video_path: str
    duration: float
    fps: float
    resolution: tuple[int, int]
    total_frames: int
    codec: str
    audio_codec: Optional[str] = None
    has_audio: bool
    scenes: Optional[list[DetectedScene]] = None
    thumbnails: Optional[list[str]] = None
    processing_time_seconds: float


class VideoRangeExtractRequest(BaseModel):
    """Request to extract a range from video."""
    video_path: str
    start_time: float = Field(ge=0)
    end_time: float
    output_path: str
    codec: str = "libx264"
    audio_codec: str = "aac"


class VideoRangeExtractResponse(BaseModel):
    """Response from video range extraction."""
    input_path: str
    output_path: str
    start_time: float
    end_time: float
    duration: float
    file_size_bytes: int
