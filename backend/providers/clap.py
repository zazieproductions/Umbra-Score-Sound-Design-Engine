"""
CLAP Provider

Integrates CLAP (Contrastive Language-Audio Pretraining) for semantic audio search.
"""

import os
import uuid
import logging
import time
from pathlib import Path
from typing import Optional

from .base import AudioProvider
from ..schemas.providers import ProviderCapability, DeviceType, ProviderStatus
from ..schemas.generation import (
    GenerationRequest,
    GeneratedAudio,
    GenerationProvider,
    SemanticSearchRequest,
    SemanticSearchResponse,
    SemanticSearchResult,
)

logger = logging.getLogger(__name__)


class ClapProvider(AudioProvider):
    """
    CLAP semantic audio provider.
    
    Provides:
    - TEXT_EMBEDDING: Convert text to embedding
    - AUDIO_EMBEDDING: Convert audio to embedding
    - SEMANTIC_SEARCH: Find similar audio by text query
    
    Model: LAION-AI/CLAP
    """
    
    name = "clap"
    display_name = "CLAP"
    description = "Contrastive Language-Audio Pretraining for semantic audio understanding"
    capabilities = [
        ProviderCapability.TEXT_EMBEDDING,
        ProviderCapability.AUDIO_EMBEDDING,
        ProviderCapability.SEMANTIC_SEARCH,
    ]
    
    MODEL_REPO = "laion-ai/CLAP"
    
    def __init__(self):
        super().__init__()
        self._device = DeviceType.CPU
        self._model = None
        self._processor = None
        self._model_name = "CLAP"
        self._audio_index: dict[str, dict] = {}  # audio_id -> {filepath, embedding, prompt, ...}
    
    def _get_model_name(self) -> Optional[str]:
        return self._model_name
    
    def is_installed(self) -> bool:
        """Check if CLAP dependencies are installed."""
        try:
            import torch
            import transformers
            return True
        except ImportError:
            return False
    
    async def is_available(self) -> bool:
        """Check if the provider can perform inference."""
        if not self.is_installed():
            return False
        return self._loaded
    
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
        """Load the CLAP model."""
        try:
            import torch
            from transformers import ClapModel, ClapProcessor
            
            self._device = self._detect_device()
            logger.info(f"Loading CLAP on {self._device}")
            
            device_str = "cuda" if self._device == DeviceType.CUDA else \
                         "mps" if self._device == DeviceType.MPS else "cpu"
            
            self._processor = ClapProcessor.from_pretrained(self.MODEL_REPO)
            self._model = ClapModel.from_pretrained(self.MODEL_REPO)
            self._model = self._model.to(device_str)
            self._model.eval()
            
            logger.info(f"CLAP loaded successfully on {self._device}")
            return True
            
        except ImportError as e:
            logger.error(f"Missing dependencies for CLAP: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to load CLAP: {e}")
            return False
    
    async def _unload_model(self) -> None:
        """Unload the model from memory."""
        if self._model is not None:
            del self._model
            self._model = None
        if self._processor is not None:
            del self._processor
            self._processor = None
        
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
    
    def _get_audio_embedding(self, filepath: str) -> Optional[list[float]]:
        """Get embedding for an audio file."""
        import torch
        import torchaudio
        import numpy as np
        
        if self._model is None or self._processor is None:
            return None
        
        try:
            # Load audio
            waveform, sr = torchaudio.load(filepath)
            
            # Resample if needed (CLAP expects 48kHz)
            if sr != 48000:
                resampler = torchaudio.transforms.Resample(sr, 48000)
                waveform = resampler(waveform)
            
            # Convert to mono if stereo
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)
            
            # Get embedding
            device_str = str(self._device)
            with torch.no_grad():
                embeddings = self._model.get_audio_features(
                    self._processor(
                        audios=waveform.squeeze().numpy(),
                        sampling_rate=48000,
                        return_tensors="pt"
                    ).input_features.to(device_str)
                )
            
            return embeddings.cpu().numpy().flatten().tolist()
            
        except Exception as e:
            logger.error(f"Failed to get audio embedding for {filepath}: {e}")
            return None
    
    def _get_text_embedding(self, text: str) -> Optional[list[float]]:
        """Get embedding for text."""
        import torch
        
        if self._model is None or self._processor is None:
            return None
        
        try:
            device_str = str(self._device)
            with torch.no_grad():
                embeddings = self._model.get_text_features(
                    self._processor(
                        text=text,
                        return_tensors="pt"
                    ).input_ids.to(device_str)
                )
            
            return embeddings.cpu().numpy().flatten().tolist()
            
        except Exception as e:
            logger.error(f"Failed to get text embedding: {e}")
            return None
    
    def _cosine_similarity(self, a: list[float], b: list[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        import math
        
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        
        if norm_a == 0 or norm_b == 0:
            return 0.0
        
        return dot / (norm_a * norm_b)
    
    async def generate(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> list[GeneratedAudio]:
        """
        Generate embeddings for generated audio.
        
        Note: This provider doesn't generate audio, it provides embeddings.
        """
        # CLAP doesn't generate audio, just creates embeddings
        # Return placeholder results
        return [
            GeneratedAudio(
                id=f"clap_{uuid.uuid4().hex[:8]}",
                filepath="",
                duration=request.duration,
                sample_rate=48000,
                channels=2,
                provider=GenerationProvider.CLap_SEARCH,
                model=self._model_name,
                prompt=request.prompt,
                metadata={"note": "CLAP generates embeddings, not audio"},
            )
        ]
    
    async def search(
        self,
        request: SemanticSearchRequest,
    ) -> SemanticSearchResponse:
        """
        Perform semantic search on indexed audio.
        
        Args:
            request: Search parameters
            
        Returns:
            SemanticSearchResponse with ranked results
        """
        start_time = time.time()
        
        if not self._loaded or self._model is None:
            raise RuntimeError("CLAP model not loaded")
        
        # Get query embedding
        query_embedding = self._get_text_embedding(request.query)
        if query_embedding is None:
            raise RuntimeError("Failed to generate query embedding")
        
        # Search through indexed audio
        results = []
        for audio_id, info in self._audio_index.items():
            if info.get("embedding") is None:
                continue
            
            similarity = self._cosine_similarity(
                query_embedding,
                info["embedding"]
            )
            
            results.append(SemanticSearchResult(
                audio_id=audio_id,
                filepath=info["filepath"],
                similarity=similarity,
                prompt=info.get("prompt"),
                provider=info.get("provider", GenerationProvider.PROCEDURAL),
                duration=info.get("duration", 0),
            ))
        
        # Sort by similarity and limit
        results.sort(key=lambda x: x.similarity, reverse=True)
        results = results[:request.limit]
        
        search_time = (time.time() - start_time) * 1000
        
        return SemanticSearchResponse(
            query=request.query,
            results=results,
            total=len(results),
            search_time_ms=search_time,
        )
    
    def index_audio(
        self,
        audio_id: str,
        filepath: str,
        prompt: Optional[str] = None,
        duration: float = 0,
        provider: GenerationProvider = GenerationProvider.PROCEDURAL,
    ) -> bool:
        """
        Add an audio file to the search index.
        
        Args:
            audio_id: Unique identifier for the audio
            filepath: Path to the audio file
            prompt: Optional text prompt/description
            duration: Duration of the audio in seconds
            provider: Which provider generated this audio
            
        Returns:
            True if indexing was successful
        """
        embedding = self._get_audio_embedding(filepath)
        
        self._audio_index[audio_id] = {
            "filepath": filepath,
            "prompt": prompt,
            "duration": duration,
            "provider": provider,
            "embedding": embedding,
        }
        
        logger.info(f"Indexed audio: {audio_id} prompt='{prompt}'")
        return embedding is not None
    
    def remove_from_index(self, audio_id: str) -> bool:
        """
        Remove an audio file from the search index.
        
        Args:
            audio_id: The ID of the audio to remove
            
        Returns:
            True if the audio was removed
        """
        if audio_id in self._audio_index:
            del self._audio_index[audio_id]
            return True
        return False
    
    def clear_index(self) -> None:
        """Clear all indexed audio."""
        self._audio_index.clear()
        logger.info("CLAP audio index cleared")
    
    def get_index_size(self) -> int:
        """Get the number of indexed audio files."""
        return len(self._audio_index)
