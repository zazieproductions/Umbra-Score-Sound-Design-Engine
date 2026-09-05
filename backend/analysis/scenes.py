"""
Video Scene Detection Module

Wrapper for PySceneDetect scene detection with Umbra integration.
"""

import os
import logging
from pathlib import Path
from typing import Optional

from ..providers.pyscenedetect import PySceneDetectProvider
from ..schemas.analysis import (
    SceneDetectionRequest,
    SceneDetectionResponse,
)

logger = logging.getLogger(__name__)


class SceneDetector:
    """
    Scene detection service integrating with Umbra's timeline system.
    """
    
    def __init__(self, data_dir: str = "./data"):
        self.data_dir = Path(data_dir)
        self.thumb_dir = self.data_dir / "thumbnails"
        self.thumb_dir.mkdir(parents=True, exist_ok=True)
        
        self.provider = PySceneDetectProvider()
    
    def is_available(self) -> bool:
        """Check if scene detection is available."""
        return self.provider.is_installed()
    
    async def detect(
        self,
        video_path: str,
        threshold: float = 30.0,
        min_scene_len: float = 0.5,
        detector: str = "content",
        generate_thumbnails: bool = True,
    ) -> SceneDetectionResponse:
        """
        Detect scenes in a video file.
        
        Args:
            video_path: Path to the video file
            threshold: Detection threshold (1-100, lower = more sensitive)
            min_scene_len: Minimum scene duration in seconds
            detector: 'content' or 'threshold' detector type
            generate_thumbnails: Whether to generate scene thumbnails
            
        Returns:
            SceneDetectionResponse with detected scenes
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")
        
        request = SceneDetectionRequest(
            video_path=video_path,
            threshold=threshold,
            min_scene_len=min_scene_len,
            detector=detector,
            show_progress=True,
        )
        
        # Generate thumbnails in our data directory
        thumb_dir = str(self.thumb_dir) if generate_thumbnails else None
        
        response = await self.provider.detect_scenes(request, thumb_dir)
        
        logger.info(
            f"Detected {response.total_scenes} scenes "
            f"in {response.duration:.1f}s video"
        )
        
        return response
    
    def detect_sync(
        self,
        video_path: str,
        threshold: float = 30.0,
        min_scene_len: float = 0.5,
        detector: str = "content",
        generate_thumbnails: bool = True,
    ) -> SceneDetectionResponse:
        """
        Synchronous version of detect for use in non-async contexts.
        """
        import asyncio
        return asyncio.get_event_loop().run_until_complete(
            self.detect(
                video_path=video_path,
                threshold=threshold,
                min_scene_len=min_scene_len,
                detector=detector,
                generate_thumbnails=generate_thumbnails,
            )
        )
