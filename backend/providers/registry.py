"""Provider registry and intent routing.

Umbra is a hybrid workstation, so the interesting question is not "which model
is best" but "which engine is *right for this request*":

    MUSICAL SCORE                 -> ACE-Step
    SYNTHETIC PRECISE ELEMENT     -> Umbra Procedural
    PHYSICAL / ENVIRONMENTAL      -> Stable Audio
    VIDEO-SYNCHRONISED FOLEY      -> MMAudio
    "find me something like…"     -> CLAP search

The router below is a transparent, inspectable keyword/geometry scorer rather
than a hidden heuristic: it returns its reasoning so the UI can show the
composer *why* a request was routed somewhere, and let them override it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.providers.base import AudioProvider, ProviderRole, ProviderStatus
from backend.providers.ace_step import AceStepProvider
from backend.providers.clap import ClapProvider
from backend.providers.mmaudio import MMAudioProvider
from backend.providers.stable_audio import StableAudioProvider
from backend.providers.umbra_procedural import UmbraProceduralProvider


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: Dict[str, AudioProvider] = {}
        for provider in (
            UmbraProceduralProvider(),
            AceStepProvider(),
            StableAudioProvider(),
            MMAudioProvider(),
            ClapProvider(),
        ):
            self._providers[provider.id] = provider

    def get(self, provider_id: str) -> Optional[AudioProvider]:
        return self._providers.get(provider_id)

    def all(self) -> List[AudioProvider]:
        return list(self._providers.values())

    def statuses(self) -> List[ProviderStatus]:
        out = []
        for p in self._providers.values():
            try:
                out.append(p.status())
            except Exception as exc:  # a broken probe must not take the app down
                out.append(
                    ProviderStatus(
                        id=p.id,
                        label=p.label,
                        blurb=p.blurb,
                        role=p.role,
                        installed=False,
                        ready=False,
                        error=str(exc),
                        install_hint=p.install_hint,
                    )
                )
        return out


# --------------------------------------------------------------------- router


@dataclass
class RouteDecision:
    provider: str
    confidence: float
    reason: str
    alternatives: List[str] = field(default_factory=list)
    matched: List[str] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "confidence": round(self.confidence, 3),
            "reason": self.reason,
            "alternatives": self.alternatives,
            "matched": self.matched,
        }


# Signal words, weighted. Deliberately horror-composer vocabulary.
_SIGNALS: Dict[str, List[tuple]] = {
    "ace-step": [
        (r"\bscore\b|\bscoring\b|\bcue\b|\bmusic(al)?\b", 3.0),
        (r"\bstring[s]?\b|\bcello\b|\bviola\b|\bviolin\b|\bbowed\b|\bharmonic[s]?\b", 2.5),
        (r"\bchoir\b|\bchoral\b|\bvoices\b|\bpiano\b|\bprepared piano\b", 2.2),
        (r"\bbrass\b|\borchestra(l)?\b|\bensemble\b", 2.2),
        (r"\bdissonan\w+|\bcluster\b|\btonal\b|\batonal\b|\bharmony\b|\bmelod\w+", 2.4),
        (r"\bbed\b|\btexture\b|\bdrone\b(?=.*\bmusic)|\bspectral\b", 1.4),
        (r"\bbpm\b|\bminor\b|\bmajor\b|\bkey of\b|\btempo\b|\btime signature\b", 2.0),
        (r"\bpercussion\b|\britual drum\w*|\btaiko\b", 1.8),
        (r"\bshoegaze\b|\bambient music\b|\bmotif\b|\btheme\b", 1.8),
    ],
    "umbra-procedural": [
        (r"\b\d+(\.\d+)?\s?hz\b", 4.0),
        (r"\bprecis\w+|\bexactly\b|\bexact\b|\bframe[- ]accurate\b|\bat \d+:\d+", 2.6),
        (r"\bsub\b|\bsub[- ]bass\b|\binfrasonic\b|\bsub swell\b|\bsub drop\b", 2.6),
        (r"\bstinger\b|\bbraam\b|\briser\b|\bdownlifter\b|\bwhoosh\b|\bimpact\b", 2.4),
        (r"\breverse\b|\breversed\b", 1.4),
        (r"\bsynth\w*|\bprocedural\b|\bdeterministic\b|\boscillator\b", 2.0),
        (r"\bheart\w*\s?(beat|pulse)|\btick\b|\bclock\b", 2.0),
    ],
    "stable-audio": [
        (r"\bfoley\b(?!.*\bvideo\b)", 1.6),
        (r"\bmachinery\b|\bventilation\b|\bengine\b|\bmotor\b|\bindustrial noise\b", 3.0),
        (r"\brust\w+|\bmetal\b|\bmetallic scrape\b|\bscrap\w+|\bcreak\w+", 2.4),
        (r"\bdoor\b|\bfootstep\w*(?!.*\bvideo\b)|\bwind\b|\brain\b|\bwater\b|\bfire\b", 2.4),
        (r"\broom tone\b|\bambience\b|\bambient (noise|sound)\b|\batmosphere\b", 2.2),
        (r"\brecording of\b|\bfield recording\b|\breal\w* sound\b|\bnoise of\b", 2.0),
        (r"\bdistant\b|\bhum\b|\bbuzz\b|\bdrip\w*|\brattle\b", 1.6),
    ],
    "mmaudio": [
        (r"\bsync\w*\s+to\s+(this|the)?\s*(video|picture|clip|selection|footage)", 4.0),
        (r"\bto (this|the) video\b|\bon screen\b|\bon-screen\b|\bwatch\w* the\b", 3.0),
        (r"\bpicture[- ]lock\w*|\bsee\w* in the (shot|frame)\b", 2.6),
        (r"\bfootstep\w*.*\bvideo\b|\bvideo\b.*\bfootstep\w*", 3.0),
        (r"\blip[- ]sync\b|\bmatch\w* the (action|motion|movement)\b", 2.4),
    ],
    "clap": [
        (r"\bfind\b|\bsearch\b|\blook (for|up)\b|\blocate\b", 3.2),
        (r"\bmy library\b|\bin my (files|sounds|library|collection)\b", 3.2),
        (r"\bsounds like\b|\bsimilar to\b|\blike the\b", 2.0),
        (r"\balready have\b|\bexisting (file|sound|asset)\b", 2.0),
    ],
}

_ROLE_BLURB = {
    "ace-step": "musical material — ACE-Step is Umbra's trained scoring engine",
    "umbra-procedural": "a precise synthetic element — Umbra Procedural is deterministic and sample-accurate",
    "stable-audio": "a physical or environmental sound — Stable Audio handles recorded-world texture",
    "mmaudio": "picture-locked Foley — MMAudio conditions on the video itself",
    "clap": "a library lookup rather than generation — CLAP searches your own sounds semantically",
}


def route_intent(
    text: str,
    *,
    has_video_selection: bool = False,
    available: Optional[List[str]] = None,
) -> RouteDecision:
    """Pick the right engine for a natural-language request.

    ``available`` restricts the answer to providers that are genuinely ready;
    when the best match is not installed we say so instead of silently
    substituting a different engine.
    """
    lowered = (text or "").lower().strip()
    scores: Dict[str, float] = {k: 0.0 for k in _SIGNALS}
    matched: Dict[str, List[str]] = {k: [] for k in _SIGNALS}

    for provider, patterns in _SIGNALS.items():
        for pattern, weight in patterns:
            found = re.search(pattern, lowered)
            if found:
                scores[provider] += weight
                matched[provider].append(found.group(0).strip())

    # A video selection is strong evidence for picture-locked Foley, but only
    # when the request is about physical sound, never for musical score.
    if has_video_selection and scores["mmaudio"] > 0:
        scores["mmaudio"] += 2.0

    # Explicit musical conditioning overrides sound-design vocabulary:
    # "dissonant low string bed" mentions neither music nor BPM, but strings win.
    if re.search(r"\b\d{2,3}\s?bpm\b|\b[a-g][#b]?\s+(minor|major)\b", lowered):
        scores["ace-step"] += 2.5
        matched["ace-step"].append("musical conditioning")

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, best_score = ranked[0]

    if best_score <= 0:
        return RouteDecision(
            provider="ace-step",
            confidence=0.0,
            reason="No routing signal found — defaulting to ACE-Step for scoring. Pick a generator manually.",
            alternatives=[p for p, _ in ranked[1:3]],
        )

    total = sum(max(0.0, s) for s in scores.values()) or 1.0
    confidence = best_score / total

    reason = f"Reads as {_ROLE_BLURB[best]}."
    if available is not None and best not in available:
        reason += f" {best} is not installed right now, so this request cannot be fulfilled by it."

    return RouteDecision(
        provider=best,
        confidence=confidence,
        reason=reason,
        alternatives=[p for p, s in ranked[1:3] if s > 0],
        matched=matched[best][:5],
    )


_registry: Optional[ProviderRegistry] = None


def get_registry() -> ProviderRegistry:
    global _registry
    if _registry is None:
        _registry = ProviderRegistry()
    return _registry
