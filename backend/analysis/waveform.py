"""
Audio Feature Analysis Module

Utilities for analyzing audio files and generating waveforms.
"""

import os
import logging
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


class AudioAnalyzer:
    """
    Audio analysis utilities for Umbra.
    """
    
    @staticmethod
    def get_audio_info(audio_path: str) -> dict:
        """
        Get audio file metadata.
        
        Returns:
            Dict with duration, sample_rate, channels, etc.
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        
        try:
            import soundfile as sf
            info = sf.info(audio_path)
            
            return {
                "duration": info.duration,
                "sample_rate": info.samplerate,
                "channels": info.channels,
                "format": info.format,
                "subtype": info.subtype,
                "frames": info.frames,
            }
        except ImportError:
            # Fallback to torchaudio
            import torchaudio
            info = torchaudio.info(audio_path)
            
            return {
                "duration": info.num_frames / info.sample_rate,
                "sample_rate": info.sample_rate,
                "channels": info.num_channels,
                "format": "unknown",
                "subtype": "unknown",
                "frames": info.num_frames,
            }
    
    @staticmethod
    def generate_waveform(
        audio_path: str,
        num_peaks: int = 200,
        normalize: bool = True,
    ) -> list[float]:
        """
        Generate waveform peaks for visualization.
        
        Args:
            audio_path: Path to audio file
            num_peaks: Number of peak values to generate
            normalize: Whether to normalize peaks to 0-1
            
        Returns:
            List of peak values
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        
        try:
            import soundfile as sf
            data, sr = sf.read(audio_path)
        except ImportError:
            import torchaudio
            data, sr = torchaudio.load(audio_path)
            data = data.numpy().T if data.shape[0] > 1 else data.numpy().flatten()
        
        # Convert to mono if stereo
        if len(data.shape) > 1:
            data = data.mean(axis=1)
        
        # Calculate samples per peak
        samples_per_peak = max(1, len(data) // num_peaks)
        
        peaks = []
        for i in range(0, len(data), samples_per_peak):
            chunk = data[i:i + samples_per_peak]
            peak = float(np.abs(chunk).max())
            peaks.append(peak)
        
        # Normalize if requested
        if normalize and peaks:
            max_peak = max(peaks)
            if max_peak > 0:
                peaks = [p / max_peak for p in peaks]
        
        return peaks
    
    @staticmethod
    def analyze_features(audio_path: str) -> dict:
        """
        Analyze audio features for metadata.
        
        Returns:
            Dict with RMS, peak, spectral features
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        
        try:
            import soundfile as sf
            data, sr = sf.read(audio_path)
        except ImportError:
            import torchaudio
            data, sr = torchaudio.load(audio_path)
            data = data.numpy().T if data.shape[0] > 1 else data.numpy().flatten()
        
        # Convert to mono
        if len(data.shape) > 1:
            data = data.mean(axis=1)
        
        # RMS energy
        rms = float(np.sqrt(np.mean(data ** 2)))
        
        # Peak level
        peak = float(np.abs(data).max())
        
        # Convert to dB
        rms_db = 20 * np.log10(rms + 1e-10)
        peak_db = 20 * np.log10(peak + 1e-10)
        
        # Duration
        duration = len(data) / sr
        
        return {
            "duration": duration,
            "rms": rms,
            "rms_db": rms_db,
            "peak": peak,
            "peak_db": peak_db,
            "crest_factor": peak / (rms + 1e-10),
            "sample_rate": sr,
        }
