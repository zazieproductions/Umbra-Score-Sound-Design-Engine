"""Small, dependency-free MMAudio install contract shared by setup and discovery.

Sources: hkchengrex/MMAudio at CODE_REVISION and the official HF repositories.
Only inference assets for small_44k; never whole-repository weight downloads.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

CODE_REVISION = "974010a026c731054592d8f777218bd9d85a6c24"
MODEL = "small_44k"
CHECKPOINT = "weights/mmaudio_small_44k.pth"
REPO = "hkchengrex/MMAudio"
REVISION = "eb13a1a98fdbec91753775c57b074ccdfc60587c"
LICENSE = "CC BY-NC 4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"
NOTICE = "EXPERIMENTAL · NONCOMMERCIAL"
INSTALL_HINT = "pip install -r backend/requirements-mmaudio.txt && python scripts/setup_models.py --mmaudio"

# path: (byte count, SHA-256 from the official HF LFS metadata).
WEIGHTS = {
    CHECKPOINT: (629946624, "11fd92e860a58f0fac972706dd06034e49dceff2e1450bbde5703785c812b0f1"),
    "ext_weights/v1-44.pth": (1221942998, "ab6cc15dc31947675f75c950c41f4dcfd0d6d1817555ac871f809ec388e4651a"),
    "ext_weights/synchformer_state_dict.pth": (950058171, "8aff082f2df5c3bc52759db0c865c7ee772ae6400b860d1b7e90413f2defb67c"),
}

# Upstream FeaturesUtils loads these exact repo IDs, without revision arguments.
# Setup pins their snapshots and refs/main in a provider-private HF cache;
# the inference child is offline. 384 is upstream's alias for Apple's 378 repo.
AUXILIARIES = {
    "apple/DFN5B-CLIP-ViT-H-14-384": {
        "revision": "01b771ed0d1395ca5ffdd279897d665ebe00dfd2",
        "license": "apple-amlr",
        "files": {
            "open_clip_config.json": (735, None),
            "open_clip_pytorch_model.bin": (3947081637, "c07a17b547d461c60a3cce5062b26bf8545b13de602c4c59d8490361eb716033"),
        },
    },
    "nvidia/bigvgan_v2_44khz_128band_512x": {
        "revision": "95a9d1dcb12906c03edd938d77b9333d6ded7dfb",
        "license": "MIT",
        "files": {
            "config.json": (1403, None),
            "bigvgan_generator.pt": (489041291, "d9fe7ec6bd0b44ed9d66973d5012d8181c1570b01e5c72df51973e241dccd357"),
        },
    },
}


def model_root(root: Path | None = None) -> Path:
    from backend.services.model_manager import checkpoints_root

    return (root if root is not None else checkpoints_root()).expanduser().resolve() / "mmaudio"


def cache_repo(root: Path, repo: str) -> Path:
    return root / "hf-cache" / ("models--" + repo.replace("/", "--"))


def required_files(root: Path) -> dict[Path, tuple[int, str | None]]:
    files = {root / name: spec for name, spec in WEIGHTS.items()}
    for repo, aux in AUXILIARIES.items():
        snapshot = cache_repo(root, repo) / "snapshots" / aux["revision"]
        files.update({snapshot / name: spec for name, spec in aux["files"].items()})
    return files


def missing_files(root: Path) -> list[str]:
    """Fast, offline completeness check; README/LFS pointers never count as weights."""
    missing = []
    for path, (size, _) in required_files(root).items():
        if not path.is_file() or path.stat().st_size != size:
            missing.append(str(path.relative_to(root)))
    for repo, aux in AUXILIARIES.items():
        ref = cache_repo(root, repo) / "refs" / "main"
        if not ref.is_file() or ref.read_text() != aux["revision"]:
            missing.append(str(ref.relative_to(root)))
    return missing


def verify_files(root: Path) -> None:
    """Stream hashes at setup/inference, not during UI polling. Never download."""
    missing = missing_files(root)
    if missing:
        raise ValueError("Missing/incomplete MMAudio assets: " + ", ".join(missing))
    for path, (_, expected) in required_files(root).items():
        if expected:
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != expected:
                raise ValueError(f"MMAudio checksum mismatch: {path.name}; remove it and rerun --mmaudio")


def provenance() -> dict:
    return {
        "provider": "mmaudio",
        "model": Path(CHECKPOINT).name,
        "modelVersion": MODEL,
        "modelRevision": REVISION,
        "modelSha256": WEIGHTS[CHECKPOINT][1],
        "sourceUrl": f"https://huggingface.co/{REPO}",
        "codeUrl": "https://github.com/hkchengrex/MMAudio",
        "codeLicense": "MIT",
        "license": LICENSE,
        "licenseClass": "CC_BY_NC",
        "licenseUrl": LICENSE_URL,
        "commercialSafe": False,
        "experimental": True,
        "creditLine": "MMAudio — Ho Kei Cheng et al., Sony Research; pretrained checkpoints CC BY-NC 4.0. Generated audio, not an original recording.",
        "auxiliaryModels": [
            {"repo": repo, "revision": aux["revision"], "license": aux["license"]}
            for repo, aux in AUXILIARIES.items()
        ],
    }
