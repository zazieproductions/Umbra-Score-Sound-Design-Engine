"""Horror-first prompt interpretation.

ACE-Step is a general music model. Left alone it will happily answer "dark
scene" with a four-on-the-floor trailer cue in D minor with a heroic
resolution. That is the single most common failure mode when a music model is
pointed at a horror film.

This module is Umbra's translation layer: it turns a composer's intent into
conditioning ACE-Step actually responds to, and — just as importantly —
builds the *negative direction* that suppresses song-form behaviour.

Nothing here is a model. It is deterministic, inspectable, and editable: the
composer always sees the final prompt before it is sent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Things a horror score must almost never do. These become negative direction.
BASE_NEGATIVES = [
    "pop song structure",
    "verse chorus form",
    "heroic trailer harmony",
    "triumphant resolution",
    "major-key uplift",
    "four-on-the-floor drums",
    "EDM drop",
    "danceable groove",
    "clean radio mix",
    "vocal hook",
    "cheerful",
    "upbeat",
]

# Extra negatives switched on by explicit user direction.
CONDITIONAL_NEGATIVES = {
    "no drums": ["drums", "percussion", "drum kit", "beat"],
    "no percussion": ["percussion", "drums", "rhythmic pulse"],
    "no melody": ["melodic lead", "singable melody", "hook"],
    "no vocals": ["vocals", "singing", "choir words", "lyrics"],
    "no resolution": ["resolved cadence", "tonic resolution", "consonant ending"],
    "no bass": ["bass guitar", "sub bass", "low end"],
    "no synth": ["synthesizer", "electronic pads"],
}

# Composer shorthand -> descriptive language the model understands.
INTENT_EXPANSIONS = [
    (r"\bdread\b", "slow-building dread, unresolved tension"),
    (r"\bunstable\b", "microtonal instability, wavering pitch"),
    (r"\bbarely tonal\b", "ambiguous tonality, no clear key centre"),
    (r"\bsparse\b", "sparse texture with long silences between gestures"),
    (r"\bspectral\b", "spectral smear, inharmonic partials, bowed overtones"),
    (r"\bcorroded\b|\bcorrosion\b", "corroded degraded timbre, tape damage"),
    (r"\bsub[- ]?pressure\b", "low-register pressure, felt more than heard"),
    (r"\bcluster\b", "semitone cluster voicing, no triadic harmony"),
    (r"\britual\b", "ritual repetition, ceremonial pacing"),
    (r"\bprepared piano\b", "prepared piano, muted damped strings, object-on-string"),
    (r"\breversed choir\b", "reversed choral texture, backwards vocal swell"),
]

# Register hints derived from tempo and density.
DENSITY_LANGUAGE = {
    "empty": "almost nothing — single sustained element, extreme space",
    "low": "very sparse, one or two elements at a time",
    "medium": "restrained layering, three or four elements",
    "high": "dense layered texture",
}


@dataclass
class PromptPlan:
    """A finished, inspectable ACE-Step conditioning package."""

    prompt: str
    negative_prompt: str
    key: Optional[str] = None
    mode: Optional[str] = None
    bpm: Optional[int] = None
    time_signature: Optional[str] = None
    duration: float = 12.0
    instrumental: bool = True
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> Dict[str, Any]:
        return {
            "prompt": self.prompt,
            "negativePrompt": self.negative_prompt,
            "key": self.key,
            "mode": self.mode,
            "bpm": self.bpm,
            "timeSignature": self.time_signature,
            "duration": self.duration,
            "instrumental": self.instrumental,
            "notes": self.notes,
        }


def _detect_exclusions(text: str) -> List[str]:
    """Pull 'no X' / 'without X' / 'avoid X' out of the composer's own words."""
    lowered = text.lower()
    found: List[str] = []
    for phrase, negatives in CONDITIONAL_NEGATIVES.items():
        token = phrase.replace("no ", "")
        if re.search(rf"\b(no|without|avoid|minus)\s+{re.escape(token)}\b", lowered):
            found.extend(negatives)
    # generic "avoid <thing>" / "without <thing>"
    for match in re.finditer(r"\b(?:avoid|without|no)\s+([a-z][a-z \-]{2,30}?)(?:[,.]|$| and )", lowered):
        candidate = match.group(1).strip()
        if candidate and candidate not in found and len(candidate.split()) <= 4:
            found.append(candidate)
    return found


def expand_intent(text: str) -> List[str]:
    """Expand horror shorthand into model-legible description."""
    lowered = text.lower()
    out: List[str] = []
    for pattern, expansion in INTENT_EXPANSIONS:
        if re.search(pattern, lowered):
            out.append(expansion)
    return out


def build_prompt(
    intent: str,
    *,
    key: Optional[str] = None,
    mode: Optional[str] = None,
    bpm: Optional[int] = None,
    time_signature: Optional[str] = None,
    duration: float = 12.0,
    density: Optional[str] = None,
    dread: Optional[float] = None,
    tension: Optional[float] = None,
    extra_negatives: Optional[List[str]] = None,
    instrumental: bool = True,
) -> PromptPlan:
    """Compose a horror-first ACE-Step conditioning package.

    The composer's own words always lead the prompt — Umbra augments, never
    replaces, their intent.
    """
    intent = (intent or "").strip()
    parts: List[str] = []
    notes: List[str] = []

    if intent:
        parts.append(intent)

    expansions = expand_intent(intent)
    if expansions:
        parts.extend(expansions)
        notes.append(f"Expanded {len(expansions)} horror shorthand term(s)")

    # Always state the medium so the model does not reach for song form.
    if not re.search(r"\b(score|cue|underscore|soundtrack)\b", intent.lower()):
        parts.append("film underscore, cinematic cue")

    if instrumental and not re.search(r"\binstrumental\b", intent.lower()):
        parts.append("instrumental")

    if density and density in DENSITY_LANGUAGE:
        parts.append(DENSITY_LANGUAGE[density])

    if dread is not None and dread >= 0.6:
        parts.append("pervasive dread, oppressive atmosphere")
    if tension is not None and tension <= 0.35:
        parts.append("held back, withheld tension, nothing releases")
    elif tension is not None and tension >= 0.75:
        parts.append("acute tension, on the edge of breaking")

    if bpm is not None and bpm <= 60:
        parts.append(f"very slow {bpm} BPM pacing, long note values")
        notes.append("Low-BPM phrasing hint added")

    negatives = list(BASE_NEGATIVES)
    negatives.extend(_detect_exclusions(intent))
    if extra_negatives:
        negatives.extend(extra_negatives)

    # de-duplicate, preserve order
    seen = set()
    deduped = []
    for n in negatives:
        k = n.strip().lower()
        if k and k not in seen:
            seen.add(k)
            deduped.append(n.strip())

    return PromptPlan(
        prompt=", ".join(p for p in parts if p),
        negative_prompt=", ".join(deduped),
        key=key,
        mode=mode,
        bpm=bpm,
        time_signature=time_signature,
        duration=duration,
        instrumental=instrumental,
        notes=notes,
    )


# ------------------------------------------------------------------ presets

HORROR_PRESETS: List[Dict[str, str]] = [
    {
        "id": "bowed-unstable",
        "label": "Slow unstable bowed texture",
        "prompt": "slow unstable bowed string texture, wavering intonation, no vibrato",
    },
    {
        "id": "low-cluster",
        "label": "Low-register cluster, no resolution",
        "prompt": "low-register semitone cluster with no melodic resolution, sustained",
    },
    {
        "id": "barely-tonal",
        "label": "Barely tonal sustained score",
        "prompt": "barely tonal sustained score, ambiguous key centre, slow drift",
    },
    {
        "id": "prepared-piano",
        "label": "Sparse prepared-piano gestures",
        "prompt": "sparse prepared-piano gestures, damped strings, long silences between notes",
    },
    {
        "id": "string-harmonics",
        "label": "Dissonant string harmonics",
        "prompt": "dissonant string harmonics, sul ponticello, glassy and thin",
    },
    {
        "id": "ritual-percussion",
        "label": "Ritual percussion, empty spaces",
        "prompt": "ritual percussion with long empty spaces, distant hand drums, no groove",
    },
    {
        "id": "spectral-smear",
        "label": "Shoegaze-like spectral smear",
        "prompt": "shoegaze-like spectral smear without drums, washed guitar drone, buried harmony",
    },
    {
        "id": "corroded-drone",
        "label": "Corroded drone bed",
        "prompt": "corroded drone bed, tape degradation, slowly detuning sustained tone",
    },
]
