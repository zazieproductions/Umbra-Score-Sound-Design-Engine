"""Architecture invariants — structural contracts, no model downloads.

If an invariant needs to change, update AGENTS.md / docs first, then this
file. Covers what test_backend.py leaves implicit: cross-provider rules that
past agents have violated (CLAP generating, procedural rendered in Python,
silent fake fallbacks, invented statuses).
"""

from __future__ import annotations

import asyncio

import pytest

from backend.providers.base import (
    Capability,
    GenerationRequest,
    ProviderError,
    ProviderRole,
)
from backend.providers.clap import ClapProvider
from backend.providers.registry import ProviderRegistry, get_registry
from backend.providers.umbra_procedural import UmbraProceduralProvider


def test_clap_never_advertises_generation():
    caps = ClapProvider().status().capabilities
    assert Capability.MUSIC_GENERATION not in caps
    assert Capability.SFX_GENERATION not in caps
    assert set(caps) <= {Capability.SEMANTIC_SEARCH, Capability.EMBEDDINGS}


def test_unavailable_providers_declare_no_capabilities():
    registry = ProviderRegistry()
    for status in registry.statuses():
        if not status.ready:
            assert status.capabilities == [], status.id


def test_procedural_is_browser_side_only():
    provider = UmbraProceduralProvider()
    assert provider.role == ProviderRole.PROCEDURAL
    status = provider.status()
    assert status.ready  # always available — never gated on weights


def test_registry_contains_exactly_the_known_providers():
    registry = get_registry()
    assert sorted(p.id for p in registry.all()) == [
        "ace-step",
        "clap",
        "mmaudio",
        "stable-audio",
        "umbra-procedural",
    ]


def test_provider_failure_is_loud_not_fabricated():
    # An unknown provider id resolves to None so the API layer 404s;
    # generation with no ready provider must raise, never synthesize filler.
    registry = ProviderRegistry()
    assert registry.get("no-such-provider") is None
    procedural = registry.get("umbra-procedural")
    assert procedural is not None
    # Procedural is described in Python but rendered in the browser:
    # its generate() refuses loudly instead of fabricating audio.
    with pytest.raises(ProviderError):
        asyncio.run(procedural.generate(GenerationRequest(provider="umbra-procedural")))
