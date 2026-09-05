"""
Model Manager Service

Manages model downloads, caching, and lifecycle.
"""

import os
import logging
from pathlib import Path
from typing import Optional

from ..schemas.providers import DeviceType, ProviderStatus

logger = logging.getLogger(__name__)


class ModelManager:
    """
    Manages ML model downloads and caching.
    
    Handles:
    - Model availability checking
    - Device detection (CUDA/MPS/CPU)
    - Model directory management
    - Cache configuration
    """
    
    def __init__(
        self,
        models_dir: str = "./models",
        cache_dir: str = "./data/cache",
    ):
        self.models_dir = Path(models_dir)
        self.cache_dir = Path(cache_dir)
        
        # Create directories
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Configure HuggingFace cache
        os.environ.setdefault("HF_HOME", str(self.cache_dir / "huggingface"))
        os.environ.setdefault("TRANSFORMERS_CACHE", str(self.cache_dir / "transformers"))
    
    def get_device(self) -> DeviceType:
        """
        Detect the best available device.
        
        Returns:
            DeviceType enum value
        """
        # Check CUDA
        try:
            import torch
            if torch.cuda.is_available():
                return DeviceType.CUDA
        except ImportError:
            pass
        
        # Check Apple MPS
        try:
            import torch
            if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                return DeviceType.MPS
        except (ImportError, AttributeError):
            pass
        
        return DeviceType.CPU
    
    def get_device_info(self) -> dict:
        """
        Get detailed device information.
        
        Returns:
            Dict with device details
        """
        device = self.get_device()
        info = {
            "device": device,
            "device_name": self._get_device_name(device),
            "torch_available": False,
            "cuda_available": False,
            "mps_available": False,
        }
        
        try:
            import torch
            info["torch_available"] = True
            info["torch_version"] = torch.__version__
            info["cuda_available"] = torch.cuda.is_available()
            
            if torch.cuda.is_available():
                info["cuda_version"] = torch.version.cuda
                info["gpu_name"] = torch.cuda.get_device_name(0)
                info["gpu_memory_total"] = torch.cuda.get_device_properties(0).total_memory
                info["gpu_memory_allocated"] = torch.cuda.memory_allocated(0)
            
            info["mps_available"] = (
                hasattr(torch.backends, 'mps') and 
                torch.backends.mps.is_available()
            )
            
        except ImportError:
            pass
        
        return info
    
    def _get_device_name(self, device: DeviceType) -> str:
        """Get a human-readable device name."""
        names = {
            DeviceType.CUDA: "NVIDIA GPU (CUDA)",
            DeviceType.MPS: "Apple Silicon GPU (Metal)",
            DeviceType.CPU: "CPU",
        }
        return names.get(device, "Unknown")
    
    def get_model_status(self, model_name: str) -> dict:
        """
        Check the status of a specific model.
        
        Returns:
            Dict with model availability and path info
        """
        model_path = self.models_dir / model_name
        
        return {
            "name": model_name,
            "installed": model_path.exists(),
            "path": str(model_path) if model_path.exists() else None,
            "size_bytes": self._get_dir_size(model_path) if model_path.exists() else 0,
        }
    
    def _get_dir_size(self, path: Path) -> int:
        """Get total size of a directory."""
        if not path.exists():
            return 0
        total = 0
        for entry in path.rglob('*'):
            if entry.is_file():
                total += entry.stat().st_size
        return total
    
    def cleanup_cache(self) -> dict:
        """
        Clean up model cache.
        
        Returns:
            Dict with cleanup results
        """
        import shutil
        
        freed_bytes = 0
        freed_files = 0
        
        for cache_path in [
            self.cache_dir / "huggingface",
            self.cache_dir / "transformers",
        ]:
            if cache_path.exists():
                size = self._get_dir_size(cache_path)
                try:
                    shutil.rmtree(cache_path)
                    freed_bytes += size
                    freed_files += 1
                except Exception as e:
                    logger.error(f"Failed to clean {cache_path}: {e}")
        
        return {
            "freed_bytes": freed_bytes,
            "freed_directories": freed_files,
        }
    
    def list_installed_models(self) -> list[dict]:
        """
        List all installed models.
        
        Returns:
            List of model info dicts
        """
        models = []
        
        for item in self.models_dir.iterdir():
            if item.is_dir():
                models.append({
                    "name": item.name,
                    "path": str(item),
                    "size_bytes": self._get_dir_size(item),
                    "files": len(list(item.rglob("*"))),
                })
        
        return models
