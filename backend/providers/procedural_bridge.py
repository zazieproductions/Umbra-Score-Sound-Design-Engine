"""
Umbra Procedural Provider

Bridges the existing browser-based procedural audio engine.
This provider is always available and requires no model downloads.
"""

import logging
import uuid
import os
from pathlib import Path

from .base import AudioProvider
from ..schemas.providers import ProviderCapability, DeviceType, ProviderStatus
from ..schemas.generation import GenerationRequest, GeneratedAudio, GenerationProvider

logger = logging.getLogger(__name__)


class ProceduralBridge(AudioProvider):
    """
    Bridge to Umbra's procedural audio engine.
    
    This provider handles integration with the frontend's procedural synthesis.
    Since the procedural engine runs in-browser via Web Audio API,
    this bridge manages metadata and file references.
    
    Capabilities:
    - PROCEDURAL: Core synthesis
    - SFX: Sound effects
    - AMBIENCE: Ambient textures
    - MUSIC: Musical elements
    """
    
    name = "procedural"
    display_name = "UMBRA PROCEDURAL"
    description = "Deterministic browser-based synthesis engine for instant, local audio generation"
    capabilities = [
        ProviderCapability.PROCEDURAL,
        ProviderCapability.SFX,
        ProviderCapability.AMBIENCE,
        ProviderCapability.MUSIC,
    ]
    
    def __init__(self):
        super().__init__()
        self._device = DeviceType.CPU
        self._loaded = True  # Always available
    
    def _get_model_name(self) -> str:
        """Procedural engine has no model."""
        return "built-in"
    
    def is_installed(self) -> bool:
        """Procedural engine is always installed."""
        return True
    
    async def is_available(self) -> bool:
        """Procedural engine is always available."""
        return True
    
    async def _load_model(self) -> bool:
        """No loading needed."""
        return True
    
    async def _unload_model(self) -> None:
        """No cleanup needed."""
        pass
    
    async def generate(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> list[GeneratedAudio]:
        """
        Generate procedural audio metadata.
        
        Note: Actual procedural synthesis happens in the browser.
        This method creates metadata that the frontend uses.
        """
        results = []
        num_variants = max(1, request.num_variants)
        
        for i in range(num_variants):
            result_id = f"proc_{uuid.uuid4().hex[:12]}"
            
            # Generate seed if not provided
            seed = request.seed
            if seed is None:
                import random
                seed = random.randint(0, 2**32 - 1)
            else:
                # Vary seed for each variant
                seed = (seed + i) % (2**32)
            
            # Create metadata file for the frontend to process
            metadata = {
                "provider": "procedural",
                "kind": self._infer_kind(request.prompt),
                "seed": seed,
                "variant_index": i,
                "num_variants": num_variants,
                "scene_id": request.scene_id,
                "timeline_start": request.timeline_start,
                "duration": request.duration,
            }
            
            result = GeneratedAudio(
                id=result_id,
                filepath="",  # Frontend generates actual audio
                duration=request.duration,
                sample_rate=request.sample_rate,
                channels=2,
                provider=GenerationProvider.PROCEDURAL,
                model="UMBRA-PROCEDURAL",
                prompt=request.prompt,
                seed=seed,
                variant_index=i,
                metadata=metadata,
            )
            results.append(result)
            
            logger.info(
                f"Procedural generation: id={result_id}, "
                f"prompt='{request.prompt[:50]}...' seed={seed}"
            )
        
        return results
    
    def _infer_kind(self, prompt: Optional[str]) -> str:
        """Infer the layer kind from the prompt."""
        if not prompt:
            return "drone"
        
        prompt_lower = prompt.lower()
        
        # Horror-specific mappings
        if any(w in prompt_lower for w in ["sub", "bass", "low", "pressure"]):
            return "sub"
        if any(w in prompt_lower for w in ["drone", "bed", "sustain"]):
            return "drone"
        if any(w in prompt_lower for w in ["ambience", "room", "atmosphere", "background"]):
            return "ambience"
        if any(w in prompt_lower for w in ["whisper", "breath", "texture", "vocal"]):
            return "texture"
        if any(w in prompt_lower for w in ["string", "orchestra"]):
            return "strings"
        if any(w in prompt_lower for w in ["choir", "vocal", "pad"]):
            return "choir"
        if any(w in prompt_lower for w in ["foley", "footstep", "cloth"]):
            return "foley"
        if any(w in prompt_lower for w in ["pulse", "heart", "beat"]):
            return "pulse"
        if any(w in prompt_lower for w in ["tick", "clock", "mechanical"]):
            return "tick"
        if any(w in prompt_lower for w in ["riser", "swell", "ascend"]):
            return "riser"
        if any(w in prompt_lower for w in ["downlifter", "fall", "descend"]):
            return "downlifter"
        if any(w in prompt_lower for w in ["whoosh", "sweep", "doppler"]):
            return "whoosh"
        if any(w in prompt_lower for w in ["braam", "hit", "horror"]):
            return "braam"
        if any(w in prompt_lower for w in ["brass", "stab", "horn"]):
            return "brass"
        if any(w in prompt_lower for w in ["percussion", "drum", "taiko"]):
            return "percussion"
        if any(w in prompt_lower for w in ["stinger", "sting"]):
            return "stinger"
        if any(w in prompt_lower for w in ["impact", "boom", "hit", "thud"]):
            return "impact"
        
        return "drone"  # Default
    
    async def search(self, request) -> None:
        """Procedural provider doesn't support search."""
        raise NotImplementedError("Procedural provider does not support semantic search")
