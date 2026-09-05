"""
Umbra Score Provider Registry

Central registry for all audio generation providers.
"""

from typing import Optional
import logging

from .base import AudioProvider
from ..schemas.providers import (
    ProviderCapability,
    ProviderInfo,
    DeviceType,
    ProviderStatus,
    ModelStatus,
)

logger = logging.getLogger(__name__)


class ProviderRegistry:
    """
    Central registry for all audio providers.
    
    Manages provider registration, lookup, and lifecycle.
    """
    
    _instance: Optional['ProviderRegistry'] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._providers = {}
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._providers: dict[str, AudioProvider] = {}
        self._initialized = True
    
    def register(self, provider: AudioProvider) -> None:
        """
        Register a provider.
        
        Args:
            provider: The provider instance to register
        """
        if provider.name in self._providers:
            logger.warning(f"Provider '{provider.name}' already registered, replacing")
        self._providers[provider.name] = provider
        logger.info(f"Registered provider: {provider.display_name}")
    
    def unregister(self, name: str) -> bool:
        """
        Unregister a provider by name.
        
        Args:
            name: Provider name
            
        Returns:
            True if the provider was removed
        """
        if name in self._providers:
            del self._providers[name]
            logger.info(f"Unregistered provider: {name}")
            return True
        return False
    
    def get(self, name: str) -> Optional[AudioProvider]:
        """
        Get a provider by name.
        
        Args:
            name: Provider name
            
        Returns:
            The provider instance or None
        """
        return self._providers.get(name)
    
    def list_providers(self) -> list[ProviderInfo]:
        """
        List all registered providers with their status.
        
        Returns:
            List of ProviderInfo objects
        """
        return [p.info for p in self._providers.values()]
    
    def get_by_capability(
        self,
        capability: ProviderCapability,
    ) -> list[AudioProvider]:
        """
        Get all providers that support a specific capability.
        
        Args:
            capability: The capability to search for
            
        Returns:
            List of matching providers
        """
        return [
            p for p in self._providers.values()
            if p.supports_capability(capability)
        ]
    
    async def load_all(self) -> dict[str, bool]:
        """
        Load all registered providers.
        
        Returns:
            Dict mapping provider names to load success status
        """
        results = {}
        for name, provider in self._providers.items():
            results[name] = await provider.load()
        return results
    
    async def unload_all(self) -> None:
        """Unload all providers."""
        for provider in self._providers.values():
            await provider.unload()
    
    def get_model_status(self) -> list[ModelStatus]:
        """
        Get status of all models.
        
        Returns:
            List of ModelStatus objects
        """
        statuses = []
        for name, provider in self._providers.items():
            info = provider.info
            status = ModelStatus(
                name=name,
                installed=info.status != ProviderStatus.NOT_INSTALLED,
                device=info.device,
                status=info.status,
                error=info.error_message,
            )
            statuses.append(status)
        return statuses
    
    def detect_device(self) -> DeviceType:
        """
        Detect the best available device for inference.
        
        Returns:
            The detected DeviceType
        """
        # Check for CUDA first
        try:
            import torch
            if torch.cuda.is_available():
                return DeviceType.CUDA
        except ImportError:
            pass
        
        # Check for Apple MPS (Metal Performance Shaders)
        try:
            import torch
            if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                return DeviceType.MPS
        except (ImportError, AttributeError):
            pass
        
        # Default to CPU
        return DeviceType.CPU
    
    def __len__(self) -> int:
        """Number of registered providers."""
        return len(self._providers)
    
    def __iter__(self):
        """Iterate over providers."""
        return iter(self._providers.values())
    
    @property
    def available_providers(self) -> list[ProviderInfo]:
        """List providers that are ready to use."""
        return [
            p.info for p in self._providers.values()
            if p.info.status == ProviderStatus.READY
        ]


# Global registry instance
registry = ProviderRegistry()
