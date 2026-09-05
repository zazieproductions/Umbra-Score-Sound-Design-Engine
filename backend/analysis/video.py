"""Video metadata and frame extraction via ffmpeg/ffprobe.

Adapted from the PR #5 ``VideoAnalyzer`` into Umbra's architecture: results are
dataclasses with an explicit ``available`` flag rather than raised exceptions,
so a missing ffmpeg degrades to an honest "not installed" in the UI exactly
like a missing model checkpoint does.

ffmpeg is an external binary, not a Python package, so it is probed with
``shutil.which`` rather than through ``model_manager.package_installed``.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("umbra.video")

FFPROBE_TIMEOUT = 30
FFMPEG_TIMEOUT = 120


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def toolchain_status() -> Dict[str, Any]:
    """Report the external video toolchain honestly, for the Models view."""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    return {
        "ffmpeg": {"available": ffmpeg is not None, "path": ffmpeg},
        "ffprobe": {"available": ffprobe is not None, "path": ffprobe},
        "note": (
            None
            if ffmpeg and ffprobe
            else "Install ffmpeg for video metadata, thumbnails and range extraction."
        ),
    }


# ------------------------------------------------------------------- metadata


@dataclass
class VideoInfo:
    available: bool
    path: Optional[str] = None
    duration: float = 0.0
    fps: float = 0.0
    width: int = 0
    height: int = 0
    size_bytes: int = 0
    bitrate: int = 0
    video_codec: Optional[str] = None
    audio_codec: Optional[str] = None
    has_audio: bool = False
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "path": self.path,
            "duration": round(self.duration, 3),
            "fps": round(self.fps, 4),
            "resolution": {"width": self.width, "height": self.height},
            "sizeBytes": self.size_bytes,
            "bitrate": self.bitrate,
            "videoCodec": self.video_codec,
            "audioCodec": self.audio_codec,
            "hasAudio": self.has_audio,
            "message": self.message,
        }


def _parse_fps(fps_str: Optional[str]) -> float:
    """Parse an ffprobe frame-rate fraction such as ``24000/1001``."""
    if not fps_str:
        return 0.0
    try:
        if "/" in fps_str:
            num, denom = fps_str.split("/", 1)
            d = float(denom)
            return float(num) / d if d else 0.0
        return float(fps_str)
    except (TypeError, ValueError):
        return 0.0


def probe_video(video_path: Path) -> VideoInfo:
    """Read real container/stream metadata with ffprobe."""
    if not ffprobe_available():
        return VideoInfo(
            available=False,
            message="ffprobe not found — install ffmpeg for real video metadata.",
        )
    if not video_path.exists():
        return VideoInfo(available=False, message=f"video not found: {video_path}")

    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=FFPROBE_TIMEOUT,
        )
        data = json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return VideoInfo(available=False, message="ffprobe timed out")
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        return VideoInfo(available=False, message=f"ffprobe failed: {exc}")

    video_stream = None
    audio_stream = None
    for stream in data.get("streams", []):
        kind = stream.get("codec_type")
        if kind == "video" and video_stream is None:
            video_stream = stream
        elif kind == "audio" and audio_stream is None:
            audio_stream = stream

    fmt = data.get("format", {})

    def _num(value: Any, cast, default):
        try:
            return cast(value)
        except (TypeError, ValueError):
            return default

    return VideoInfo(
        available=True,
        path=str(video_path),
        duration=_num(fmt.get("duration"), float, 0.0),
        size_bytes=_num(fmt.get("size"), int, 0),
        bitrate=_num(fmt.get("bit_rate"), int, 0),
        fps=_parse_fps(video_stream.get("r_frame_rate") if video_stream else None),
        width=_num(video_stream.get("width"), int, 0) if video_stream else 0,
        height=_num(video_stream.get("height"), int, 0) if video_stream else 0,
        video_codec=video_stream.get("codec_name") if video_stream else None,
        audio_codec=audio_stream.get("codec_name") if audio_stream else None,
        has_audio=audio_stream is not None,
    )


# ------------------------------------------------------------------- extraction


@dataclass
class ExtractResult:
    ok: bool
    output_path: Optional[str] = None
    start: float = 0.0
    end: float = 0.0
    duration: float = 0.0
    size_bytes: int = 0
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "outputPath": self.output_path,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "sizeBytes": self.size_bytes,
            "message": self.message,
        }


def extract_range(
    input_path: Path,
    output_path: Path,
    start: float,
    end: float,
    *,
    with_audio: bool = True,
) -> ExtractResult:
    """Cut a span out of a video.

    Used to hand a video-conditioned provider (MMAudio / FoleyCrafter) exactly
    the span the composer selected, rather than the whole reel.
    """
    if not ffmpeg_available():
        return ExtractResult(ok=False, message="ffmpeg not found — install it to extract ranges.")
    if not input_path.exists():
        return ExtractResult(ok=False, message=f"video not found: {input_path}")

    duration = max(0.0, end - start)
    if duration <= 0:
        return ExtractResult(ok=False, message="range must be longer than zero seconds")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-i", str(input_path),
        "-t", str(duration),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
    ]
    cmd += ["-c:a", "aac", "-b:a", "192k"] if with_audio else ["-an"]
    cmd.append(str(output_path))

    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT)
    except subprocess.TimeoutExpired:
        return ExtractResult(ok=False, message="ffmpeg timed out")
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", "replace")[-400:]
        return ExtractResult(ok=False, message=f"ffmpeg failed: {stderr}")

    return ExtractResult(
        ok=True,
        output_path=str(output_path),
        start=start,
        end=end,
        duration=duration,
        size_bytes=output_path.stat().st_size if output_path.exists() else 0,
    )


def generate_thumbnail(
    video_path: Path,
    output_path: Path,
    *,
    at: float = 0.0,
    size: Tuple[int, int] = (320, 180),
) -> bool:
    """Grab a single frame. Returns False rather than raising."""
    if not ffmpeg_available() or not video_path.exists():
        return False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(at),
        "-i", str(video_path),
        "-vframes", "1",
        "-vf", f"scale={size[0]}:{size[1]}",
        "-q:v", "2",
        str(output_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT)
        return output_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


@dataclass
class FrameSet:
    available: bool
    frames: List[Dict[str, Any]] = field(default_factory=list)
    message: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {"available": self.available, "frames": self.frames, "message": self.message}


def generate_preview_frames(
    video_path: Path,
    output_dir: Path,
    *,
    interval: float = 5.0,
    max_frames: int = 240,
) -> FrameSet:
    """Sample frames across a reel for the timeline's scene strip."""
    if not ffmpeg_available():
        return FrameSet(available=False, message="ffmpeg not found — install it for preview frames.")

    info = probe_video(video_path)
    if not info.available:
        return FrameSet(available=False, message=info.message)
    if info.duration <= 0:
        return FrameSet(available=False, message="could not determine video duration")

    interval = max(0.25, interval)
    output_dir.mkdir(parents=True, exist_ok=True)

    frames: List[Dict[str, Any]] = []
    count = min(max_frames, int(info.duration / interval) + 1)
    for i in range(count):
        at = i * interval
        if at >= info.duration:
            break
        target = output_dir / f"frame_{i:04d}.jpg"
        if generate_thumbnail(video_path, target, at=at):
            frames.append({"at": round(at, 3), "path": str(target)})

    return FrameSet(available=True, frames=frames, message=f"{len(frames)} frames")
