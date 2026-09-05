#!/usr/bin/env python3
"""
Umbra Score Model Setup Script

Downloads and configures pretrained models for the ML backend.
"""

import argparse
import os
import sys
import logging
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def setup_core():
    """Install core dependencies (always needed)."""
    logger.info("Setting up core dependencies...")
    
    core_packages = [
        "fastapi>=0.100.0",
        "uvicorn[standard]>=0.23.0",
        "pydantic>=2.0.0",
        "python-multipart>=0.0.6",
    ]
    
    import subprocess
    for pkg in core_packages:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=True)
            logger.info(f"Installed: {pkg}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install {pkg}: {e}")
            return False
    
    return True


def setup_stable_audio():
    """Setup Stable Audio Open."""
    logger.info("Setting up Stable Audio Open...")
    
    packages = [
        "stable-audio-tools",
        "diffusers>=0.25.0",
        "transformers>=4.35.0",
        "accelerate>=0.25.0",
        "torch>=2.0.0",
        "torchaudio>=2.0.0",
        "soundfile>=0.12.0",
    ]
    
    import subprocess
    for pkg in packages:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=True)
            logger.info(f"Installed: {pkg}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install {pkg}: {e}")
    
    logger.info("Stable Audio Open setup complete.")
    logger.info("Note: The model (~2GB) will be downloaded on first use.")
    
    return True


def setup_mmaudio():
    """Setup MMAudio."""
    logger.info("Setting up MMAudio...")
    
    packages = [
        "transformers>=4.35.0",
        "torch>=2.0.0",
        "numpy>=1.24.0",
    ]
    
    import subprocess
    for pkg in packages:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=True)
            logger.info(f"Installed: {pkg}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install {pkg}: {e}")
    
    logger.info("MMAudio setup complete.")
    logger.info("Note: The model will be downloaded on first use.")
    
    return True


def setup_clap():
    """Setup CLAP."""
    logger.info("Setting up CLAP...")
    
    packages = [
        "laion-clap",
        "torch>=2.0.0",
        "transformers>=4.35.0",
        "torchaudio>=2.0.0",
    ]
    
    import subprocess
    for pkg in packages:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=True)
            logger.info(f"Installed: {pkg}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install {pkg}: {e}")
    
    logger.info("CLAP setup complete.")
    logger.info("Note: The model will be downloaded on first use.")
    
    return True


def setup_pyscenedetect():
    """Setup PySceneDetect."""
    logger.info("Setting up PySceneDetect...")
    
    packages = [
        "scenedetect[videoio]>=0.6.0",
        "opencv-python>=4.8.0",
    ]
    
    import subprocess
    for pkg in packages:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=True)
            logger.info(f"Installed: {pkg}")
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to install {pkg}: {e}")
    
    logger.info("PySceneDetect setup complete.")
    
    return True


def setup_ffmpeg():
    """Check/install ffmpeg."""
    import subprocess
    
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True)
        if result.returncode == 0:
            logger.info("ffmpeg is installed")
            return True
    except FileNotFoundError:
        pass
    
    logger.warning("ffmpeg not found. Some features may not work.")
    logger.info("Install ffmpeg:")
    logger.info("  macOS: brew install ffmpeg")
    logger.info("  Ubuntu: sudo apt install ffmpeg")
    logger.info("  Windows: choco install ffmpeg")
    
    return False


def verify_environment():
    """Verify the environment is set up correctly."""
    logger.info("Verifying environment...")
    
    issues = []
    
    # Check Python version
    if sys.version_info < (3, 10):
        issues.append("Python 3.10+ required")
    
    # Check core packages
    try:
        import fastapi
        import uvicorn
        import pydantic
    except ImportError as e:
        issues.append(f"Core dependency missing: {e}")
    
    # Check optional packages
    if not issues:
        logger.info("Core dependencies: OK")
    
    # Check device support
    try:
        import torch
        if torch.cuda.is_available():
            logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            logger.info("Apple MPS available")
        else:
            logger.info("CPU only (no GPU acceleration)")
    except ImportError:
        logger.warning("PyTorch not installed - ML models won't work")
    
    # Check ffmpeg
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        logger.warning("ffmpeg not found")
    
    if issues:
        logger.error("Environment issues found:")
        for issue in issues:
            logger.error(f"  - {issue}")
        return False
    
    logger.info("Environment verification complete!")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Setup Umbra Score ML backend"
    )
    parser.add_argument(
        "--core",
        action="store_true",
        help="Install core dependencies only"
    )
    parser.add_argument(
        "--stable-audio",
        action="store_true",
        help="Install Stable Audio Open"
    )
    parser.add_argument(
        "--mmaudio",
        action="store_true",
        help="Install MMAudio"
    )
    parser.add_argument(
        "--clap",
        action="store_true",
        help="Install CLAP"
    )
    parser.add_argument(
        "--pyscenedetect",
        action="store_true",
        help="Install PySceneDetect"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Install all dependencies"
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify environment setup"
    )
    
    args = parser.parse_args()
    
    if not any([
        args.core, args.stable_audio, args.mmaudio,
        args.clap, args.pyscenedetect, args.all, args.verify
    ]):
        parser.print_help()
        print("\nExamples:")
        print("  python setup_models.py --core           # Core dependencies only")
        print("  python setup_models.py --stable-audio   # Stable Audio Open")
        print("  python setup_models.py --all            # Everything")
        print("  python setup_models.py --verify         # Check setup")
        return 0
    
    success = True
    
    if args.verify:
        success = verify_environment()
    else:
        if args.core or args.all:
            success = setup_core() and success
        
        if args.stable_audio or args.all:
            success = setup_stable_audio() and success
        
        if args.mmaudio or args.all:
            success = setup_mmaudio() and success
        
        if args.clap or args.all:
            success = setup_clap() and success
        
        if args.pyscenedetect or args.all:
            success = setup_pyscenedetect() and success
        
        # Always check ffmpeg
        setup_ffmpeg()
    
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
