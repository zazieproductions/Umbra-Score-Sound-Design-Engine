"""
Video Analysis Module

Utilities for video analysis and processing.
"""

import os
import subprocess
import logging
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


class VideoAnalyzer:
    """
    Video analysis utilities for Umbra.
    """
    
    @staticmethod
    def get_video_info(video_path: str) -> dict:
        """
        Get video metadata using ffprobe.
        
        Returns:
            Dict with duration, fps, resolution, codec info
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")
        
        try:
            result = subprocess.run([
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                video_path,
            ], capture_output=True, text=True, check=True)
            
            import json
            data = json.loads(result.stdout)
            
            video_stream = None
            audio_stream = None
            
            for stream in data.get("streams", []):
                if stream.get("codec_type") == "video" and not video_stream:
                    video_stream = stream
                elif stream.get("codec_type") == "audio" and not audio_stream:
                    audio_stream = stream
            
            format_info = data.get("format", {})
            
            return {
                "duration": float(format_info.get("duration", 0)),
                "size": int(format_info.get("size", 0)),
                "bitrate": int(format_info.get("bit_rate", 0)),
                "fps": VideoAnalyzer._parse_fps(video_stream.get("r_frame_rate") if video_stream else "0/1"),
                "resolution": (
                    video_stream.get("width", 0),
                    video_stream.get("height", 0)
                ) if video_stream else (0, 0),
                "video_codec": video_stream.get("codec_name", "unknown") if video_stream else None,
                "audio_codec": audio_stream.get("codec_name", "unknown") if audio_stream else None,
                "has_audio": audio_stream is not None,
            }
            
        except subprocess.CalledProcessError as e:
            logger.error(f"ffprobe failed: {e}")
            raise RuntimeError(f"Failed to analyze video: {e}")
        except Exception as e:
            logger.error(f"Video analysis error: {e}")
            raise
    
    @staticmethod
    def _parse_fps(fps_str: str) -> float:
        """Parse FPS from fraction string like '24000/1001'."""
        if '/' in fps_str:
            num, denom = fps_str.split('/')
            return float(num) / float(denom) if float(denom) != 0 else 0
        return float(fps_str)
    
    @staticmethod
    def extract_range(
        input_path: str,
        output_path: str,
        start_time: float,
        end_time: float,
        with_audio: bool = True,
    ) -> dict:
        """
        Extract a range from a video file.
        
        Args:
            input_path: Source video path
            output_path: Destination path
            start_time: Start time in seconds
            end_time: End time in seconds
            with_audio: Whether to include audio
            
        Returns:
            Dict with output info
        """
        if not os.path.exists(input_path):
            raise FileNotFoundError(f"Video not found: {input_path}")
        
        duration = end_time - start_time
        
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_time),
            "-i", input_path,
            "-t", str(duration),
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
        ]
        
        if with_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")
        
        cmd.append(output_path)
        
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            
            return {
                "input_path": input_path,
                "output_path": output_path,
                "start_time": start_time,
                "end_time": end_time,
                "duration": duration,
                "file_size_bytes": os.path.getsize(output_path),
            }
            
        except subprocess.CalledProcessError as e:
            logger.error(f"ffmpeg failed: {e.stderr}")
            raise RuntimeError(f"Failed to extract video range: {e}")
    
    @staticmethod
    def generate_thumbnail(
        video_path: str,
        output_path: str,
        time: float = 0,
        size: Tuple[int, int] = (320, 180),
    ) -> bool:
        """
        Generate a thumbnail from a video at a specific time.
        
        Args:
            video_path: Source video path
            output_path: Thumbnail output path
            time: Time in seconds to capture
            size: (width, height) for the thumbnail
            
        Returns:
            True if successful
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")
        
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(time),
            "-i", video_path,
            "-vframes", "1",
            "-vf", f"scale={size[0]}:{size[1]}",
            "-q:v", "2",
            output_path,
        ]
        
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return True
        except subprocess.CalledProcessError:
            return False
    
    @staticmethod
    def generate_preview_frames(
        video_path: str,
        output_dir: str,
        interval: float = 5.0,
    ) -> list[str]:
        """
        Generate preview frames from a video.
        
        Args:
            video_path: Source video path
            output_dir: Directory to save frames
            interval: Interval between frames in seconds
            
        Returns:
            List of generated frame paths
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")
        
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        
        # Get video duration
        info = VideoAnalyzer.get_video_info(video_path)
        duration = info["duration"]
        
        frames = []
        num_frames = int(duration / interval)
        
        for i in range(num_frames + 1):
            time = i * interval
            if time >= duration:
                break
            
            output_path = os.path.join(output_dir, f"frame_{i:04d}.jpg")
            
            if VideoAnalyzer.generate_thumbnail(video_path, output_path, time):
                frames.append(output_path)
        
        return frames
