"""Embedding helpers.

Thin facade over the CLAP provider so routes and future features (dedupe,
"more like this", auto-tagging a user's training folder) share one code path.

Latent tensors from generative models never appear here and never reach the
frontend — Umbra's contract stops at decoded audio.
"""

from __future__ import annotations

from typing import Any, Dict, List

from backend.providers.registry import get_registry


async def search_library(query: str, limit: int = 12) -> Dict[str, Any]:
    """Semantic search across the local audio store."""
    provider = get_registry().get("clap")
    if provider is None:
        return {"available": False, "results": [], "message": "CLAP provider not registered"}
    status = provider.status()
    if not status.ready:
        return {
            "available": False,
            "results": [],
            "message": "CLAP is not installed — semantic search unavailable.",
            "installHint": status.install_hint,
        }
    results: List[Dict[str, Any]] = await provider.search(query, limit=limit)  # type: ignore[attr-defined]
    return {"available": True, "results": results, "query": query}
