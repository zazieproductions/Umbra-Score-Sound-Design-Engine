"""
Stable Audio Open Provider

Integrates Stable Audio Open / stable-audio-tools for text-to-audio generation.
"""

import os
import uuid
import logging
import tempfile
from pathlib import Path
from typing import Optional

from .base import AudioProvider
from ..schemas.providers import ProviderCapability, DeviceType, ProviderStatus
from ..schemas.generation import GenerationRequest, GeneratedAudio, GenerationProvider

logger = logging.getLogger(__name__)


class StableAudioProvider(AudioProvider):
    """
    Stable Audio Open text-to-audio provider.
    
    Uses the stable-audio-tools library for generation.
    Model: stable-audio-open
    
    Capabilities:
    - TEXT_TO_AUDIO: Generate audio from text prompts
    - SFX: Sound effects
    - AMBIENCE: Ambient textures
    - MUSIC: Musical elements
    """
    
    name = "stable_audio"
    display_name = "Stable Audio Open"
    description = "Open-source text-to-audio generation using Stable Audio Open model"
    capabilities = [
        ProviderCapability.TEXT_TO_AUDIO,
        ProviderCapability.SFX,
        ProviderCapability.AMBIENCE,
        ProviderCapability.MUSIC,
    ]
    
    # Model configuration
    MODEL_NAME = "stable-audio-open"
    MODEL_REPO = "stabilityai/stable-audio-open"
    
    def __init__(self):
        super().__init__()
        self._device = DeviceType.CPU
        self._pipeline = None
        self._model_name = self.MODEL_NAME
    
    def _get_model_name(self) -> Optional[str]:
        return self._model_name
    
    def is_installed(self) -> bool:
        """Check if stable-audio-tools is installed."""
        try:
            import stable_audio
            return True
        except ImportError:
            return False
    
    async def is_available(self) -> bool:
        """Check if the provider can generate."""
        return self.is_installed() and self._loaded
    
    def _detect_device(self) -> DeviceType:
        """Detect the best available device."""
        try:
            import torch
            if torch.cuda.is_available():
                return DeviceType.CUDA
            if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                return DeviceType.MPS
        except (ImportError, AttributeError):
            pass
        return DeviceType.CPU
    
    async def _load_model(self) -> bool:
        """Load the Stable Audio Open model."""
        try:
            import torch
            from diffusers import StableAudioPipeline
            
            self._device = self._detect_device()
            logger.info(f"Loading Stable Audio Open on {self._device}")
            
            # Load the model
            device_str = "cuda" if self._device == DeviceType.CUDA else \
                         "mps" if self._device == DeviceType.MPS else "cpu"
            
            self._pipeline = StableAudioPipeline.from_pretrained(
                self.MODEL_REPO,
                torch_dtype=torch.float32,
            )
            self._pipeline = self._pipeline.to(device_str)
            
            if self._device in (DeviceType.CUDA, DeviceType.MPS):
                self._pipeline.enable_vae_tiling()
            
            self._model_name = self.MODEL_NAME
            logger.info(f"Stable Audio Open loaded successfully on {self._device}")
            return True
            
        except ImportError as e:
            logger.error(f"Missing dependencies for Stable Audio: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to load Stable Audio Open: {e}")
            return False
    
    async def _unload_model(self) -> None:
        """Unload the model from memory."""
        if self._pipeline is not None:
            del self._pipeline
            self._pipeline = None
        
        # Clear CUDA cache if applicable
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
    
    async def generate(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> list[GeneratedAudio]:
        """
        Generate audio from text prompt using Stable Audio Open.
        
        Args:
            request: Generation parameters
            output_dir: Directory to save generated audio
            
        Returns:
            List of GeneratedAudio objects
        """
        if not self._loaded or self._pipeline is None:
            raise RuntimeError("Stable Audio Open model not loaded")
        
        import torch
        import torchaudio
        import numpy as np
        
        results = []
        num_variants = max(1, request.num_variants)
        
        # Ensure output directory exists
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        
        for i in range(num_variants):
            try:
                # Generate seed for this variant
                seed = request.seed
                if seed is None:
                    seed = torch.randint(0, 2**32 - 1, (1,)).item()
                else:
                    seed = (seed + i) % (2**32)
                
                generator = torch.Generator(
                    device=str(self._device)
                ).manual_seed(seed)
                
                # Calculate number of steps based on duration
                # Model is optimized for specific durations
                steps = min(100, max(20, int(request.duration * 10)))
                
                # Generate audio
                with torch.no_grad():
                    audio = self._pipeline(
                        prompt=request.prompt or "",
                        negative_prompt=request.negative_prompt or "",
                        num_inference_steps=steps,
                        audio_length_in_s=request.duration,
                        guidance_scale=3.5,
                        generator=generator,
                    ).audios[0]
                
                # Convert to 32-bit float audio
                audio_float = audio.astype(np.float32)
                
                # Create output file
                result_id = f"sao_{uuid.uuid4().hex[:12]}"
                filepath = output_path / f"{result_id}.wav"
                
                # Normalize if requested
                if request.normalize:
                    peak = np.abs(audio_float).max()
                    if peak > 0:
                        audio_float = audio_float / peak * 0.95
                
                # Save as WAV (48kHz stereo)
                # Stable Audio outputs mono at model sample rate, upsample to 48kHz
                audio_tensor = torch.from_numpy(audio_float).unsqueeze(0)
                if audio_tensor.shape[0] == 1:
                    # Convert mono to stereo
                    audio_tensor = torch.cat([audio_tensor, audio_tensor], dim=0)
                
                torchaudio.save(
                    str(filepath),
                    audio_tensor,
                    sample_rate=48000,
                    bits_per_sample=24,
                )
                
                result = GeneratedAudio(
                    id=result_id,
                    filepath=str(filepath),
                    duration=audio_float.shape[-1] / 48000,
                    sample_rate=48000,
                    channels=2,
                    provider=GenerationProvider.STABLE_AUDIO,
                    model=self._model_name,
                    prompt=request.prompt,
                    negative_prompt=request.negative_prompt,
                    seed=seed,
                    variant_index=i,
                    metadata={
                        "num_variants": num_variants,
                        "inference_steps": steps,
                        "guidance_scale": 3.5,
                    },
                )
                results.append(result)
                
                logger.info(
                    f"Stable Audio generated: {result_id} "
                    f"prompt='{request.prompt[:50]}...' seed={seed}"
                )
                
            except Exception as e:
                logger.error(f"Generation failed for variant {i}: {e}")
                # Create error result
                results.append(GeneratedAudio(
                    id=f"sao_err_{uuid.uuid4().hex[:8]}",
                    filepath="",
                    duration=request.duration,
                    sample_rate=48000,
                    channels=2,
                    provider=GenerationProvider.STABLE_AUDIO,
                    error=str(e),
                    status="failed",
                ))
        
        return results
