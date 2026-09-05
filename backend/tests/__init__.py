"""
Umbra Score Backend Tests

Tests for the Python ML backend.
"""

import pytest
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))


class TestProviderRegistry:
    """Tests for the provider registry."""
    
    def test_registry_singleton(self):
        """Test that registry is a singleton."""
        from backend.providers.registry import ProviderRegistry
        
        r1 = ProviderRegistry()
        r2 = ProviderRegistry()
        
        assert r1 is r2
    
    def test_register_provider(self):
        """Test provider registration."""
        from backend.providers.registry import ProviderRegistry
        from backend.providers.procedural_bridge import ProceduralBridge
        
        registry = ProviderRegistry()
        provider = ProceduralBridge()
        
        registry.register(provider)
        
        assert registry.get("procedural") is not None
        assert len(registry) == 1
    
    def test_get_by_capability(self):
        """Test getting providers by capability."""
        from backend.providers.registry import ProviderRegistry
        from backend.providers.procedural_bridge import ProceduralBridge
        from backend.schemas.providers import ProviderCapability
        
        registry = ProviderRegistry()
        registry.register(ProceduralBridge())
        
        procedural_providers = registry.get_by_capability(
            ProviderCapability.PROCEDURAL
        )
        
        assert len(procedural_providers) == 1


class TestProceduralBridge:
    """Tests for the procedural bridge provider."""
    
    def test_is_installed(self):
        """Test that procedural is always 'installed'."""
        from backend.providers.procedural_bridge import ProceduralBridge
        
        provider = ProceduralBridge()
        assert provider.is_installed() is True
    
    def test_is_available(self):
        """Test that procedural is always available."""
        import asyncio
        from backend.providers.procedural_bridge import ProceduralBridge
        
        provider = ProceduralBridge()
        
        async def check():
            return await provider.is_available()
        
        assert asyncio.run(check()) is True
    
    @pytest.mark.asyncio
    async def test_generate(self):
        """Test procedural generation creates metadata."""
        from backend.providers.procedural_bridge import ProceduralBridge
        from backend.schemas.generation import GenerationRequest, GenerationProvider
        
        provider = ProceduralBridge()
        request = GenerationRequest(
            provider=GenerationProvider.PROCEDURAL,
            prompt="droning horror atmosphere",
            duration=5.0,
            num_variants=3,
        )
        
        results = await provider.generate(request, "/tmp/audio")
        
        assert len(results) == 3
        assert all(r.provider == GenerationProvider.PROCEDURAL for r in results)
        assert all(r.duration == 5.0 for r in results)


class TestModelManager:
    """Tests for the model manager."""
    
    def test_device_detection(self):
        """Test device detection."""
        from backend.services.model_manager import ModelManager
        
        manager = ModelManager(models_dir="/tmp/models")
        device = manager.get_device()
        
        # Should return a valid device type
        assert device.value in ["cuda", "mps", "cpu"]
    
    def test_get_device_info(self):
        """Test device info retrieval."""
        from backend.services.model_manager import ModelManager
        
        manager = ModelManager(models_dir="/tmp/models")
        info = manager.get_device_info()
        
        assert "device" in info
        assert "device_name" in info


class TestAudioStore:
    """Tests for the audio store."""
    
    def test_save_load_delete(self):
        """Test audio metadata save/load/delete."""
        import tempfile
        from pathlib import Path
        from backend.services.audio_store import AudioStore
        from backend.schemas.generation import GeneratedAudio, GenerationProvider
        
        with tempfile.TemporaryDirectory() as tmpdir:
            store = AudioStore(data_dir=tmpdir, audio_dir=tmpdir)
            
            audio = GeneratedAudio(
                id="test_001",
                filepath="/test/audio.wav",
                duration=5.0,
                sample_rate=48000,
                channels=2,
                provider=GenerationProvider.PROCEDURAL,
            )
            
            # Save
            assert store.save(audio) is True
            
            # Load
            loaded = store.load("test_001")
            assert loaded is not None
            assert loaded.id == "test_001"
            assert loaded.duration == 5.0
            
            # Delete
            assert store.delete("test_001") is True
            
            # Load after delete
            assert store.load("test_001") is None
    
    def test_storage_stats(self):
        """Test storage statistics."""
        import tempfile
        from backend.services.audio_store import AudioStore
        
        with tempfile.TemporaryDirectory() as tmpdir:
            store = AudioStore(data_dir=tmpdir, audio_dir=tmpdir)
            stats = store.get_storage_stats()
            
            assert "audio_files" in stats
            assert "metadata_files" in stats
            assert stats["audio_files"] == 0


class TestJobManager:
    """Tests for the job manager."""
    
    def test_create_job(self):
        """Test job creation."""
        from backend.services.jobs import JobManager
        
        manager = JobManager()
        job_id = manager.create_job("test_job", {"key": "value"})
        
        job = manager.get_job(job_id)
        assert job is not None
        assert job.job_type == "test_job"
    
    def test_job_lifecycle(self):
        """Test job progress updates."""
        import asyncio
        from backend.services.jobs import JobManager
        
        manager = JobManager()
        job_id = manager.create_job("test_job")
        
        async def update():
            await manager.update_progress(job_id, 0.5, "Half done")
            await manager.update_progress(job_id, 1.0, "Complete")
            await manager.complete_job(job_id, {"result": "success"})
        
        asyncio.run(update())
        
        job = manager.get_job(job_id)
        assert job.state.value == "complete"
        assert job.progress == 1.0
        assert job.result == {"result": "success"}


class TestSchemas:
    """Tests for schema validation."""
    
    def test_generation_request(self):
        """Test GenerationRequest validation."""
        from backend.schemas.generation import GenerationRequest, GenerationProvider
        
        request = GenerationRequest(
            provider=GenerationProvider.STABLE_AUDIO,
            prompt="horror ambience",
            duration=10.0,
            num_variants=3,
        )
        
        assert request.provider == GenerationProvider.STABLE_AUDIO
        assert request.prompt == "horror ambience"
        assert request.duration == 10.0
        assert request.num_variants == 3
    
    def test_generation_request_defaults(self):
        """Test GenerationRequest defaults."""
        from backend.schemas.generation import GenerationRequest, GenerationProvider
        
        request = GenerationRequest(provider=GenerationProvider.PROCEDURAL)
        
        assert request.duration == 5.0
        assert request.num_variants == 1
        assert request.seed is None
    
    def test_semantic_search_request(self):
        """Test SemanticSearchRequest validation."""
        from backend.schemas.generation import SemanticSearchRequest
        
        request = SemanticSearchRequest(
            query="distant metallic resonance",
            limit=5,
        )
        
        assert request.query == "distant metallic resonance"
        assert request.limit == 5


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
