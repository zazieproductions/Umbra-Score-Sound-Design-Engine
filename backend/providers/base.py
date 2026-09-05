"""
Umbra Score Base Provider

Abstract base class for all audio generation providers.
"""

from abc import ABC, abstractmethod
from typing import Optional, Any
import logging

from ..schemas.providers import (
    ProviderCapability,
    ProviderInfo,
    ProviderStatus,
    DeviceType,
)
from ..schemas.generation import (
    GeneratedAudio,
    GenerationRequest,
    SemanticSearchRequest,
    SemanticSearchResponse,
)

logger = logging.getLogger(__name__)


class AudioProvider(ABC):
    """
    Abstract base class for all audio providers.
    
    Providers implement specific audio generation methods:
    - Procedural synthesis (UMBRA PROCEDURAL)
    - Text-to-audio (Stable Audio Open)
    - Video-to-audio (MMAudio)
    - Semantic search (CLAP)
    - Scene detection (PySceneDetect)
    """
    
    name: str
    display_name: str
    description: str
    capabilities: list[ProviderCapability]
    
    def __init__(self):
        self._device: DeviceType = DeviceType.CPU
        self._loaded: bool = False
        self._model: Optional[Any] = None
    
    @property
    def device(self) -> DeviceType:
        """Current device type."""
        return self._device
    
    @property
    def is_loaded(self) -> bool:
        """Whether the provider/model is loaded."""
        return self._loaded
    
    @property
    def info(self) -> ProviderInfo:
        """Get provider information."""
        return ProviderInfo(
            name=self.name,
            display_name=self.display_name,
            description=self.description,
            capabilities=self.capabilities,
            device=self._device,
            status=self._get_status(),
            model_name=self._get_model_name(),
        )
    
    def _get_status(self) -> ProviderStatus:
        """Get the current status of the provider."""
        if not self.is_installed():
            return ProviderStatus.NOT_INSTALLED
        if not self._loaded:
            return ProviderStatus.MODEL_MISSING
        return ProviderStatus.READY
    
    @abstractmethod
    def _get_model_name(self) -> Optional[str]:
        """Get the model name if applicable."""
        pass
    
    @abstractmethod
    def is_installed(self) -> bool:
        """Check if the provider is installed/available."""
        pass
    
    @abstractmethod
    async def is_available(self) -> bool:
        """Check if the provider can currently generate audio."""
        pass
    
    async def load(self) -> bool:
        """
        Load the provider/model into memory.
        Returns True if successful.
        """
        if self._loaded:
            return True
        
        try:
            self._loaded = await self._load_model()
            if self._loaded:
                logger.info(f"Provider '{self.name}' loaded successfully on {self._device}")
            return self._loaded
        except Exception as e:
            logger.error(f"Failed to load provider '{self.name}': {e}")
            self._loaded = False
            return False
    
    async def unload(self) -> None:
        """
        Unload the provider/model from memory.
        """
        if not self._loaded:
            return
        
        try:
            await self._unload_model()
            self._loaded = False
            self._model = None
            logger.info(f"Provider '{self.name}' unloaded")
        except Exception as e:
            logger.error(f"Error unloading provider '{self.name}': {e}")
    
    @abstractmethod
    async def _load_model(self) -> bool:
        """Internal method to load the model. Implement in subclasses."""
        pass
    
    @abstractmethod
    async def _unload_model(self) -> None:
        """Internal method to unload the model. Implement in subclasses."""
        pass
    
    @abstractmethod
    async def generate(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> list[GeneratedAudio]:
        """
        Generate audio based on the request.
        
        Args:
            request: Generation request parameters
            output_dir: Directory to save generated audio files
            
        Returns:
            List of GeneratedAudio objects (one per variant)
        """
        pass
    
    async def generate_single(
        self,
        request: GenerationRequest,
        output_dir: str,
    ) -> GeneratedAudio:
        """
        Generate a single audio result.
        Convenience method that calls generate and returns the first result.
        """
        results = await self.generate(request, output_dir)
        if not results:
            raise ValueError(f"Provider '{self.name}' returned no results")
        return results[0]
    
    async def search(
        self,
        request: SemanticSearchRequest,
    ) -> SemanticSearchResponse:
        """
        Perform semantic search on audio assets.
        
        Args:
            request: Search request parameters
            
        Returns:
            SemanticSearchResponse with ranked results
        """
        raise NotImplementedError(f"Provider '{self.name}' does not support semantic search")
    
    def supports_capability(self, capability: ProviderCapability) -> bool:
        """Check if this provider supports a specific capability."""
        return capability in self.capabilities
