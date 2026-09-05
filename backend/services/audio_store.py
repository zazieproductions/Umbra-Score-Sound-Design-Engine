"""
Audio Store Service

Manages generated and imported audio files.
"""

import os
import json
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime

from ..schemas.generation import GeneratedAudio, GenerationProvider

logger = logging.getLogger(__name__)


class AudioStore:
    """
    Persistent storage for generated and imported audio.
    
    Manages:
    - Audio file storage
    - Metadata persistence
    - Waveform caching
    - Project associations
    """
    
    def __init__(
        self,
        data_dir: str = "./data",
        audio_dir: str = "./data/audio",
    ):
        self.data_dir = Path(data_dir)
        self.audio_dir = Path(audio_dir)
        
        # Create directories
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.joinpath("metadata").mkdir(exist_ok=True)
    
    def save(self, audio: GeneratedAudio) -> bool:
        """
        Save audio metadata to the store.
        
        Args:
            audio: GeneratedAudio object to save
            
        Returns:
            True if successful
        """
        try:
            meta_path = self.data_dir / "metadata" / f"{audio.id}.json"
            
            with open(meta_path, 'w') as f:
                json.dump(audio.model_dump(mode='json'), f, indent=2)
            
            logger.info(f"Saved audio metadata: {audio.id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to save audio metadata: {e}")
            return False
    
    def load(self, audio_id: str) -> Optional[GeneratedAudio]:
        """
        Load audio metadata from the store.
        
        Args:
            audio_id: ID of the audio to load
            
        Returns:
            GeneratedAudio object or None
        """
        meta_path = self.data_dir / "metadata" / f"{audio_id}.json"
        
        if not meta_path.exists():
            return None
        
        try:
            with open(meta_path) as f:
                data = json.load(f)
            return GeneratedAudio(**data)
        except Exception as e:
            logger.error(f"Failed to load audio metadata: {e}")
            return None
    
    def delete(self, audio_id: str) -> bool:
        """
        Delete audio from the store.
        
        Args:
            audio_id: ID of the audio to delete
            
        Returns:
            True if successful
        """
        deleted = False
        
        # Delete metadata
        meta_path = self.data_dir / "metadata" / f"{audio_id}.json"
        if meta_path.exists():
            meta_path.unlink()
            deleted = True
        
        # Delete waveform cache
        wave_path = self.data_dir / "waveforms" / f"{audio_id}.json"
        if wave_path.exists():
            wave_path.unlink()
            deleted = True
        
        # Note: Don't delete the actual audio file here
        # It's managed separately and may be referenced by multiple projects
        
        return deleted
    
    def list_by_provider(
        self,
        provider: GenerationProvider,
        limit: int = 100,
    ) -> list[GeneratedAudio]:
        """
        List audio files by provider.
        
        Args:
            provider: Filter by provider
            limit: Maximum results
            
        Returns:
            List of GeneratedAudio objects
        """
        results = []
        meta_dir = self.data_dir / "metadata"
        
        for meta_file in meta_dir.glob("*.json"):
            try:
                with open(meta_file) as f:
                    data = json.load(f)
                
                audio = GeneratedAudio(**data)
                if audio.provider == provider:
                    results.append(audio)
                    
                    if len(results) >= limit:
                        break
            except Exception:
                continue
        
        # Sort by creation time (newest first)
        results.sort(key=lambda x: x.metadata.get("created_at", ""), reverse=True)
        
        return results[:limit]
    
    def search(
        self,
        query: Optional[str] = None,
        provider: Optional[GenerationProvider] = None,
        min_duration: Optional[float] = None,
        max_duration: Optional[float] = None,
        limit: int = 100,
    ) -> list[GeneratedAudio]:
        """
        Search audio files by various criteria.
        
        Args:
            query: Text search in prompt/tags
            provider: Filter by provider
            min_duration: Minimum duration in seconds
            max_duration: Maximum duration in seconds
            limit: Maximum results
            
        Returns:
            List of matching GeneratedAudio objects
        """
        results = []
        meta_dir = self.data_dir / "metadata"
        
        for meta_file in meta_dir.glob("*.json"):
            try:
                with open(meta_file) as f:
                    data = json.load(f)
                
                audio = GeneratedAudio(**data)
                
                # Apply filters
                if provider and audio.provider != provider:
                    continue
                
                if min_duration and audio.duration < min_duration:
                    continue
                
                if max_duration and audio.duration > max_duration:
                    continue
                
                if query:
                    query_lower = query.lower()
                    prompt_match = audio.prompt and query_lower in audio.prompt.lower()
                    name_match = query_lower in audio.id.lower()
                    if not (prompt_match or name_match):
                        continue
                
                results.append(audio)
                
            except Exception:
                continue
        
        return results[:limit]
    
    def get_storage_stats(self) -> dict:
        """
        Get storage statistics.
        
        Returns:
            Dict with storage info
        """
        # Count audio files
        audio_files = list(self.audio_dir.glob("**/*.wav")) + \
                      list(self.audio_dir.glob("**/*.flac")) + \
                      list(self.audio_dir.glob("**/*.mp3"))
        
        # Count metadata files
        meta_files = list((self.data_dir / "metadata").glob("*.json"))
        
        # Calculate total sizes
        audio_size = sum(f.stat().st_size for f in audio_files)
        meta_size = sum(f.stat().st_size for f in meta_files)
        
        return {
            "audio_files": len(audio_files),
            "metadata_files": len(meta_files),
            "audio_size_bytes": audio_size,
            "metadata_size_bytes": meta_size,
            "total_size_bytes": audio_size + meta_size,
        }
    
    def cleanup_orphaned(self) -> dict:
        """
        Remove orphaned metadata files (no corresponding audio).
        
        Returns:
            Dict with cleanup results
        """
        removed = 0
        
        for meta_file in (self.data_dir / "metadata").glob("*.json"):
            try:
                with open(meta_file) as f:
                    data = json.load(f)
                
                audio = GeneratedAudio(**data)
                
                # Check if audio file exists
                if audio.filepath:
                    audio_path = Path(audio.filepath)
                    if not audio_path.exists():
                        meta_file.unlink()
                        removed += 1
                        
            except Exception:
                # Remove corrupted metadata
                meta_file.unlink()
                removed += 1
        
        return {"removed": removed}
