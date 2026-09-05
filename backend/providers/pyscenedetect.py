"""
PySceneDetect Provider

Integrates PySceneDetect for real video scene detection.
"""

import os
import uuid
import logging
import time
from pathlib import Path
from typing import Optional

from .base import AudioProvider
from ..schemas.providers import ProviderCapability, DeviceType, ProviderStatus
from ..schemas.generation import GenerationRequest, GeneratedAudio, GenerationProvider
from ..schemas.analysis import (
    SceneDetectionRequest,
    SceneDetectionResponse,
    DetectedScene,
)

logger = logging.getLogger(__name__)


class PySceneDetectProvider(AudioProvider):
    """
    PySceneDetect scene detection provider.
    
    Performs real shot/scene detection on video files.
    Replaces fake scene boundaries with actual cut detection.
    
    Capabilities:
    - SCENE_DETECTION: Detect scene boundaries in video
    """
    
    name = "pyscenedetect"
    display_name = "PySceneDetect"
    description = "Real video shot/scene boundary detection using content analysis"
    capabilities = [
        ProviderCapability.SCENE_DETECTION,
    ]
    
    def __init__(self):
        super().__init__()
        self._device = DeviceType.CPU
        self._model_name = "PySceneDetect"
    
    def _get_model_name(self) -> Optional[str]:
        return self._model_name
    
    def is_installed(self) -> bool:
        """Check if PySceneDetect is installed."""
        try:
            import scenedetect
            return True
        except ImportError:
            return False
    
    async def is_available(self) -> bool:
        """Check if scene detection can be performed."""
        return self.is_installed()
    
    async def _load_model(self) -> bool:
        """No model loading needed for PySceneDetect."""
        return True
    
    async def _unload_model(self) -> None:
        """No cleanup needed."""
        pass
    
    async def detect_scenes(
        self,
        request: SceneDetectionRequest,
        output_dir: Optional[str] = None,
    ) -> SceneDetectionResponse:
        """
        Detect scene boundaries in a video file.
        
        Args:
            request: Scene detection parameters
            output_dir: Optional directory for thumbnails
            
        Returns:
            SceneDetectionResponse with detected scenes
        """
        if not self.is_installed():
            raise RuntimeError("PySceneDetect not installed")
        
        import cv2
        from scenedetect import SceneManager, VideoManager
        from scenedetect.detectors import ContentDetector, ThresholdDetector
        from scenedetect.stats_manager import StatsManager
        
        start_time = time.time()
        
        # Validate video exists
        if not os.path.exists(request.video_path):
            raise FileNotFoundError(f"Video not found: {request.video_path}")
        
        # Create output directory for thumbnails
        if output_dir:
            thumb_dir = Path(output_dir) / "thumbnails"
            thumb_dir.mkdir(parents=True, exist_ok=True)
        else:
            thumb_dir = None
        
        # Open video
        video_manager = VideoManager([request.video_path])
        stats_manager = StatsManager()
        scene_manager = SceneManager(stats_manager)
        
        # Add detector based on type
        if request.detector == "threshold":
            scene_manager.add_detector(
                ThresholdDetector(
                    threshold=request.threshold,
                    min_scene_len=int(request.min_scene_len * 24),  # Assuming 24fps
                )
            )
        else:  # content detector (default)
            scene_manager.add_detector(
                ContentDetector(
                    threshold=request.threshold,
                    min_scene_len=int(request.min_scene_len * 24),
                )
            )
        
        # Get video info
        video_manager.set_downscale_factor(1)  # Full resolution for accurate detection
        video_fps = video_manager.get_framerate()
        video_duration = video_manager.get_duration()
        
        try:
            # Start detection
            video_manager.start()
            scene_manager.detect_scenes(frame_source=video_manager)
            
            # Get scene list
            scene_list = scene_manager.get_scene_list()
            
            # Build response
            scenes = []
            cap = cv2.VideoCapture(request.video_path)
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            
            for i, scene in enumerate(scene_list):
                start_frame, end_frame = scene
                start_time_sec = start_frame / video_fps
                end_time_sec = end_frame / video_fps
                
                # Generate thumbnail if requested
                thumbnail_path = None
                if thumb_dir:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
                    ret, frame = cap.read()
                    if ret:
                        thumbnail_path = str(thumb_dir / f"scene_{i:03d}.jpg")
                        cv2.imwrite(thumbnail_path, frame)
                
                # Determine cut type (simplified - real implementation would analyze transitions)
                cut_type = self._detect_cut_type(
                    request.video_path,
                    start_frame,
                    end_frame,
                    video_fps,
                )
                
                scenes.append(DetectedScene(
                    index=i,
                    start_frame=int(start_frame),
                    end_frame=int(end_frame),
                    start_time=start_time_sec,
                    end_time=end_time_sec,
                    duration=end_time_sec - start_time_sec,
                    cut_type=cut_type,
                    confidence=0.85,  # Placeholder confidence
                    thumbnail_path=thumbnail_path,
                ))
            
            cap.release()
            
        finally:
            video_manager.release()
        
        processing_time = time.time() - start_time
        
        logger.info(
            f"Scene detection complete: {len(scenes)} scenes "
            f"in {processing_time:.2f}s for {request.video_path}"
        )
        
        return SceneDetectionResponse(
            video_path=request.video_path,
            total_frames=total_frames,
            fps=float(video_fps),
            duration=float(video_duration),
            scenes=scenes,
            total_scenes=len(scenes),
            processing_time_seconds=processing_time,
        )
    
    def _detect_cut_type(
        self,
        video_path: str,
        start_frame: int,
        end_frame: int,
        fps: float,
    ) -> str:
        """
        Detect the type of cut between scenes.
        
        Returns: 'cut', 'fade', 'dissolve', 'wipe', etc.
        """
        import cv2
        
        cap = cv2.VideoCapture(video_path)
        
        # Sample frames around the cut
        n_samples = 5
        mid_frame = (start_frame + end_frame) // 2
        frames = []
        
        for f in range(
            max(0, start_frame - n_samples),
            min(int(fps * 60), start_frame + n_samples)
        ):
            cap.set(cv2.CAP_PROP_POS_FRAMES, f)
            ret, frame = cap.read()
            if ret:
                frames.append(frame)
        
        cap.release()
        
        if len(frames) < 2:
            return "cut"
        
        # Simple heuristic for cut type detection
        # Brightness analysis
        brightness = [f.mean() for f in frames]
        brightness_change = abs(brightness[-1] - brightness[0])
        
        # Check for fade (gradual brightness change)
        if brightness_change < 10:
            # Check if it's gradual
            if len(frames) > 3:
                brightness_diff = [abs(brightness[i+1] - brightness[i]) 
                                  for i in range(len(brightness)-1)]
                if max(brightness_diff) < 5:
                    return "dissolve"
            return "fade"
        
        return "cut"
    
    async def generate(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> list[GeneratedAudio]:
        """Scene detection doesn't generate audio."""
        raise NotImplementedError("Scene detection provider does not generate audio")
    
    async def search(self, request) -> None:
        """Scene detection doesn't support search."""
        raise NotImplementedError("Scene detection provider does not support semantic search")
