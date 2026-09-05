#!/usr/bin/env python3
"""
Verify Umbra Score Environment

Checks that all dependencies are correctly installed.
"""

import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def check_python():
    """Check Python version."""
    print("=" * 60)
    print("Python Environment")
    print("=" * 60)
    
    print(f"Python version: {sys.version}")
    
    if sys.version_info < (3, 10):
        print("  ⚠️  Python 3.10+ recommended")
        return False
    else:
        print("  ✓ Python version OK")
        return True


def check_core_packages():
    """Check core packages."""
    print("\n" + "=" * 60)
    print("Core Packages")
    print("=" * 60)
    
    packages = [
        ("fastapi", "FastAPI"),
        ("uvicorn", "Uvicorn"),
        ("pydantic", "Pydantic"),
        ("starlette", "Starlette"),
    ]
    
    all_ok = True
    for module, name in packages:
        try:
            mod = __import__(module)
            version = getattr(mod, "__version__", "unknown")
            print(f"  ✓ {name} ({version})")
        except ImportError:
            print(f"  ✗ {name} NOT INSTALLED")
            all_ok = False
    
    return all_ok


def check_ml_packages():
    """Check ML packages."""
    print("\n" + "=" * 60)
    print("ML Packages (optional)")
    print("=" * 60)
    
    packages = [
        ("torch", "PyTorch"),
        ("transformers", "Transformers"),
        ("diffusers", "Diffusers"),
        ("accelerate", "Accelerate"),
        ("torchaudio", "Torchaudio"),
        ("soundfile", "Soundfile"),
        ("numpy", "NumPy"),
    ]
    
    installed = []
    not_installed = []
    
    for module, name in packages:
        try:
            mod = __import__(module)
            version = getattr(mod, "__version__", "unknown")
            print(f"  ✓ {name} ({version})")
            installed.append(name)
        except ImportError:
            print(f"  ○ {name} not installed (optional)")
            not_installed.append(name)
    
    return installed


def check_device():
    """Check compute device."""
    print("\n" + "=" * 60)
    print("Compute Device")
    print("=" * 60)
    
    try:
        import torch
        
        print(f"PyTorch version: {torch.__version__}")
        
        if torch.cuda.is_available():
            print(f"  ✓ CUDA available")
            print(f"    Device: {torch.cuda.get_device_name(0)}")
            props = torch.cuda.get_device_properties(0)
            memory_gb = props.total_memory / (1024**3)
            print(f"    Memory: {memory_gb:.1f} GB")
            return "cuda"
        
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            print("  ✓ Apple MPS available (Metal GPU)")
            return "mps"
        
        else:
            print("  ⚠ No GPU acceleration available")
            print("    CPU-only mode will be used")
            return "cpu"
            
    except ImportError:
        print("  ⚠ PyTorch not installed")
        return None


def check_specialized_packages():
    """Check specialized audio/video packages."""
    print("\n" + "=" * 60)
    print("Specialized Packages")
    print("=" * 60)
    
    packages = [
        ("scenedetect", "PySceneDetect"),
        ("cv2", "OpenCV"),
        ("laion_clap", "LAION-CLAP"),
    ]
    
    available = []
    
    for module, name in packages:
        try:
            mod = __import__(module)
            version = getattr(mod, "__version__", "unknown")
            print(f"  ✓ {name} ({version})")
            available.append(name)
        except ImportError:
            print(f"  ○ {name} not installed (optional)")
    
    return available


def check_ffmpeg():
    """Check ffmpeg."""
    print("\n" + "=" * 60)
    print("External Tools")
    print("=" * 60)
    
    import subprocess
    
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            check=True
        )
        version_line = result.stdout.split("\n")[0]
        print(f"  ✓ ffmpeg: {version_line}")
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("  ○ ffmpeg not found (optional, for video processing)")
        return False


def check_directories():
    """Check required directories."""
    print("\n" + "=" * 60)
    print("Directories")
    print("=" * 60)
    
    base_dir = Path(__file__).parent.parent
    dirs = [
        ("data", "Data directory"),
        ("data/audio", "Audio storage"),
        ("data/cache", "Model cache"),
        ("models", "Local models"),
    ]
    
    all_ok = True
    for dir_name, desc in dirs:
        path = base_dir / dir_name
        if path.exists():
            print(f"  ✓ {desc}: {path}")
        else:
            print(f"  ○ {desc}: {path} (will be created)")
    
    return all_ok


def main():
    print("\n" + "=" * 60)
    print("UMBRA SCORE - Environment Verification")
    print("=" * 60)
    
    checks = [
        ("Python", check_python()),
        ("Core Packages", check_core_packages()),
    ]
    
    ml_pkgs = check_ml_packages()
    device = check_device()
    specialized = check_specialized_packages()
    ffmpeg = check_ffmpeg()
    check_directories()
    
    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    print("\nInstalled ML packages:")
    for pkg in ml_pkgs:
        print(f"  - {pkg}")
    
    print(f"\nCompute device: {device}")
    
    if specialized:
        print("\nAvailable specialized features:")
        for feat in specialized:
            print(f"  - {feat}")
    
    print("\n" + "=" * 60)
    
    # Recommendations
    if not ml_pkgs:
        print("\nRECOMMENDATION:")
        print("Install ML packages for generative audio:")
        print("  python backend/scripts/setup_models.py --all")
    elif device == "cpu":
        print("\nNOTE: Running in CPU-only mode.")
        print("GPU acceleration would significantly improve generation speed.")
    
    print("\nTo start the backend:")
    print("  cd backend")
    print("  python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
