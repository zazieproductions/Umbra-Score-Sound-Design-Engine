You are the senior audio-software engineer, creative-ML engineer, and product architect responsible for turning this repository into a genuinely functioning application:

https://github.com/zazieproductions/Umbra-Score-Sound-Design-Engine

PROJECT: UMBRA·SCORE  
PURPOSE: A free, horror-specialized video scoring and sound-design workstation.

Do not redesign the application from scratch. The existing visual identity and interaction model are strong. Preserve the charcoal/crimson/violet interface, timeline, scene inspector, layer controls, transport, meters, asset views, and horror terminology wherever possible.

The task is to progressively replace simulations with real functionality.

## PRODUCT PHILOSOPHY

Umbra should not become a generic AI music generator.

Think of it as:

VIDEO → ANALYSIS → HORROR SPOTTING MAP → EDITABLE SOUND OBJECTS → PROCEDURAL / GENERATED AUDIO → HUMAN EDITING → STEMS / MASTER

The user's film remains the center of the application.

The program should behave more like an unusually intelligent horror composer/sound designer sitting beside the filmmaker than a button that produces a finished song.

Take conceptual inspiration from the strongest aspects of ACE Studio Video Composer:

1. Analyze the actual video rather than merely its duration.
2. Detect scenes, cuts, motion, visual events, pacing changes, and likely synchronization points.
3. Construct a temporal "spotting map" of the film.
4. Generate or synthesize sounds as separate editable objects rather than one flattened soundtrack.
5. Place individual SFX at meaningful frame/timecode positions.
6. Allow generation for the entire film, one scene, a selected timeline range, or one event.
7. Allow users to regenerate only one sound without destroying the rest of the score.
8. Allow natural-language direction and revision.
9. Keep every generated decision editable.
10. Treat silence as an intentional possible result.

However, make all implementation, terminology, UX, presets, analysis logic, and sonic behavior distinctly UMBRA and horror-specific.

## FIRST: AUDIT THE EXISTING REPO

Before changing anything, understand what already works.

Classify current behavior internally into:

REAL
SIMULATED
PARTIAL
UI-ONLY

Do not replace functioning systems unnecessarily.

The repository already contains useful real infrastructure, including Web Audio synthesis, DSP, transport synchronization, live meters, horror layer voices, parameter editing, and offline WAV rendering. Build on these systems.

The current scene analysis and fake model/cloud/GPU behavior are simulations. Replace them incrementally.

Never leave a newly introduced button pretending to work. If functionality is unavailable, disable it and label it appropriately rather than faking execution.

## PHASE 1 — REAL VIDEO ANALYSIS

Replace the seeded SCENE_BANK analysis with analysis of the user's actual uploaded video.

Implement a local-first VideoAnalysisService behind a clean provider interface.

Extract representative frames at sensible intervals and around detected cuts.

Create actual shot-boundary detection using frame differences, histogram differences, perceptual similarity, or another lightweight browser-compatible method.

For every detected shot/scene, generate structured metadata such as:

startTime
endTime
duration
shotType
motionLevel
motionDirection
brightness
contrast
colorTemperature
visualEntropy
cutStrength
facesPresent
personCount
interiorExteriorEstimate
cameraMovementEstimate
eventCandidates
tensionEstimate
confidence

Do not pretend these values came from an AI model if they came from heuristics.

The system must work at a basic level without paid APIs.

Design the provider interface so a future local vision-language model or optional remote model can enrich these results without requiring a rewrite.

## PHASE 2 — HORROR SPOTTING ENGINE

This is Umbra's key differentiator.

Create a HorrorSpottingEngine that translates objective visual analysis into sound-design possibilities.

It should identify candidate moments such as:

CUT
REVEAL
APPROACH
IMPACT
DOOR / CONTACT
FOOTSTEP / GAIT
CAMERA WHIP
SUDDEN MOTION
LIGHT CHANGE
EMPTY HOLD
SLOW PUSH
FACE REVEAL
OBJECT ENTRY
OBJECT EXIT
TENSION BUILD
TENSION RELEASE
SCENE TRANSITION

Each event receives:

timecode
frame
event type
confidence
visual evidence
suggested audio roles
suggested intensity
priority

Crucially, separate OBSERVATION from CREATIVE INTERPRETATION.

Example:

Observation:
"Large foreground object enters rapidly at 00:41.820."

Possible interpretations:
- literal Foley
- low metallic impact
- reverse swell ending at entry
- sub-pressure accent
- no sound

Never automatically equate every visual event with a loud cinematic hit.

## PHASE 3 — HORROR ARC

Replace the current simplistic tension number with an editable TENSION CURVE across the film.

Derive an initial curve from:

motion
shot duration
cut frequency
luminance changes
visual uncertainty
detected events
scene changes

Display this curve on or above the timeline.

Allow the user to draw/edit it.

Use it to influence procedural synthesis density, dissonance, spectral brightness, dynamics, event probability, sub pressure, pulse rate, texture density, and reverb behavior.

Add a second editable parameter:

DREAD

Tension = immediate physiological intensity.

Dread = sustained anticipatory unease.

A static hallway may therefore have:

Tension: 0.18
Dread: 0.91

This distinction should materially change the generated sound.

## PHASE 4 — MAKE THE TIMELINE A REAL EDITOR

At present, generated layer waveforms largely occupy whole scenes.

Change the data model.

Introduce actual AudioClip objects with:

id
trackId
sceneId
kind
start
duration
offset
fadeIn
fadeOut
gain
pan
pitch
playbackRate
source
generationPrompt
seed
version
locked
muted
metadata

Users must be able to:

drag clips
trim clips
move clips
duplicate clips
delete clips
split clips
fade clips
snap to cuts
snap to spotting events
layer clips
select multiple clips
regenerate one clip
regenerate selected clips

The current scissors button must actually split something, not merely log that a marker was placed.

Support selection ranges on the ruler.

Generation should respect the selected range.

## PHASE 5 — SOUND OBJECTS, NOT GENERIC TRACKS

Preserve the existing Umbra horror layer categories and expand them thoughtfully.

Existing concepts such as:

Drone Bed
Sub Pressure
Ambience
Whisper Texture
String Cluster
Foley
Heart Pulse
Riser
Whoosh Pass
Braam
Stinger
Impact

are useful.

Add a second taxonomy oriented toward horror sound design:

ROOM
BODY
BREATH
WOOD
METAL
GLASS
FABRIC
MACHINE
ELECTRIC
WIND
VOICE_FRAGMENT
SCRAPE
CREAK
KNOCK
RUMBLE
REVERSE
TONAL
INHARMONIC
SILENCE

Separate:

MUSICAL
ENVIRONMENTAL
FOLEY
PSYCHOACOUSTIC
TRANSITION
IMPACT

so the user can filter and mix meaningfully.

## PHASE 6 — BUILD ON THE REAL PROCEDURAL ENGINE

The existing Web Audio horror synthesis system is valuable.

Do not throw it away merely to substitute external AI APIs.

Turn it into Umbra's native procedural generator.

Improve voices so their parameters are deterministic from a saved seed.

Add more sonic variation and modulation.

Expose sophisticated but comprehensible horror controls such as:

Dread
Instability
Decay
Physicality
Distance
Air
Corrosion
Pitch Drift
Spectral Smear
Granularity
Sub Weight
Dissonance
Human Presence
Stereo Uncertainty
Reversal
Transient Violence

Map these macros onto real DSP parameters.

A user should be able to make a whisper texture "farther away, less human, slower, more unstable" and hear a meaningful change.

## PHASE 7 — PROMPTABLE SOUND DIRECTION

Create an Umbra Director panel.

The user should be able to type commands like:

"Keep the opening almost silent. Add distant building resonance but no music."

"Make the hallway feel larger and less physically plausible."

"Give me a restrained sub-pressure event three seconds before the reveal."

"Remove the obvious impact. Let the reveal happen into silence."

"Add deteriorating fluorescent electrical texture during this selection."

"Create three different sounds for this door."

"Make the score less cinematic and more like damaged location audio."

Translate these commands into structured edits whenever possible.

Do NOT make the language-model response itself the product.

The agent should produce actions against the project model:

ADD_CLIP
REMOVE_CLIP
CHANGE_PARAM
MOVE_CLIP
GENERATE_VARIANT
SET_TENSION
SET_DREAD
CREATE_AUTOMATION
CHANGE_SPACE
etc.

Always show the proposed action and allow undo.

## PHASE 8 — EVENT-AWARE GENERATION

When an event exists at an exact timestamp, generation must understand its relationship to that event.

Support timing relationships:

ON
BEFORE
AFTER
LEAD_IN
TAIL
BRIDGE
UNDER
AVOID

Example:

event: reveal @ 01:13.420
sound: reverse metallic breath
relationship: LEAD_IN
start: event - 2.8 sec
end: event

This is much more useful to film composers than merely saying "generate scary sound."

## PHASE 9 — THREE GENERATION MODES

UMBRA should eventually have three complementary generation systems.

A. PROCEDURAL

Runs locally in Web Audio.
Instant.
Deterministic.
Best for drones, subs, pulses, synthetic texture, risers, impacts and transformations.

B. LIBRARY / ASSET

Allow users to import their own WAV/AIFF/MP3 files.

Analyze and tag them.

Search by semantic or acoustic qualities.

Automatically suggest local assets for spotting events.

This is important because a useful free product should not depend entirely on generative inference.

C. OPTIONAL GENERATIVE PROVIDERS

Design adapters for future open/local text-to-audio or music models.

Never hard-code the entire application around one proprietary API.

Provider failure should never break the project.

## PHASE 10 — REAL ASSET MANAGER

Replace demo asset entries with actual user assets.

Support drag-and-drop import.

Store metadata using IndexedDB or another appropriate local persistence layer.

Generate waveform previews.

Store duration/sample rate/channel count.

Add tags, favorites and collections.

Support search.

Later add acoustic similarity/embedding search behind an optional index.

Users should be able to drag assets directly from the library onto the timeline.

## PHASE 11 — PROJECT PERSISTENCE

Users must not lose work when the browser reloads.

Implement a real project schema with versioning.

Persist:

video reference/metadata
scenes
analysis
spotting events
tracks
clips
seeds
parameters
automation
assets
tension curve
dread curve
generation history
undo history where practical

Provide:

Save Project
Load Project
Export Project JSON
Import Project JSON

Build migrations so the schema can evolve.

## PHASE 12 — EXPORT

Preserve the current real WAV renderer and make it production-oriented.

Support:

full mix WAV
individual stems
scene stems
track stems
selected-range render
SFX-only mix
music-only mix
ambience-only mix

Eventually support 24-bit / 48 kHz as the canonical film output.

Do not claim exact LUFS or true peak values unless they are actually measured.

## HORROR-SPECIFIC CREATIVE SYSTEM

Develop "Horror Strategies" rather than generic genre presets.

Examples:

NEGATIVE SPACE
ROOM IS WRONG
BODY WITHOUT BODY
MECHANICAL DREAD
DOMESTIC UNEASE
SUBJECTIVE HEARING
FALSE FOLEY
PRE-ECHO
DECAYED MEMORY
INFRASTRUCTURAL HUM
PREDATOR PERSPECTIVE
RITUAL SPACE
ELECTRICAL FAILURE
ORGANIC MACHINE
UNRELIABLE ROOM TONE

A strategy should alter spotting and generation behavior, not merely change EQ.

Example:

NEGATIVE SPACE should cause the engine to generate fewer sounds and deliberately preserve silence around important events.

ROOM IS WRONG might generate plausible room tone, then slowly introduce acoustically impossible resonances.

FALSE FOLEY might create sounds that nearly correspond to visible gestures but are materially incorrect.

This is where Umbra should become substantially more interesting than generic video-to-audio systems.

## CREATIVE PRIORITIES

Do not optimize for making everything "cinematic."

Avoid constant braams, risers and impacts.

Avoid automatically scoring every cut.

Embrace:

silence
room tone
near-silence
slow spectral evolution
unresolved sounds
misaligned cause and effect
low-frequency pressure
close-mic bodily detail
distant mechanical systems
electrical artifacts
unstable pitch
inharmonic resonance
acoustic ambiguity

The engine should sometimes explicitly recommend:

NO SOUND

as the best sound-design decision.

## ENGINEERING REQUIREMENTS

Use modular TypeScript.

Separate UI, project state, video analysis, spotting, audio generation, audio rendering, persistence, asset management, and optional AI providers.

Do not create giant components.

Add proper interfaces for providers.

Add tests around timing math, scene detection, project serialization, deterministic generation, timeline edits, and spotting rules.

Do not expose API keys in the frontend.

Do not fabricate backend/cloud status.

Do not display invented model names as if real inference occurred.

Use feature detection and graceful degradation.

Keep a demo mode, but label demo/simulated data clearly.

Maintain good performance with longer short films.

## IMPLEMENTATION ORDER

Do not attempt all of this simultaneously.

First produce a concise audit and implementation plan.

Then implement the first vertical slice:

UPLOAD REAL VIDEO
→ DETECT REAL CUTS
→ CREATE REAL SCENES
→ CREATE REAL SPOTTING EVENTS
→ DISPLAY THEM ON TIMELINE
→ ALLOW USER TO SELECT AN EVENT
→ GENERATE ONE REAL PROCEDURAL SOUND
→ PLACE IT AT THAT EVENT
→ MOVE/TRIM/DELETE IT
→ SAVE PROJECT
→ EXPORT THAT RESULT TO WAV

That complete vertical slice is more important than twenty additional cosmetic panels.

Once it works reliably, proceed outward.

## DEFINITION OF SUCCESS FOR MVP

I should be able to open Umbra in a browser, upload a horror short, and see cuts detected from the actual footage.

I should be able to inspect why Umbra thinks certain moments may deserve sound.

I should be able to select one of those moments and create an actual sound.

That sound must appear as an independent editable timeline clip.

I must be able to move it, change it, delete it, regenerate it, save the project, reload the project, and export real audio.

Nothing in that workflow should be simulated.

Preserve the existing aesthetic sophistication while replacing theatrical fake functionality with transparent, real systems.

UMBRA's long-term identity is:

not "AI automatically scores your movie"

but

"A horror sound-design intelligence that watches the film with you and gives you editable sonic possibilities."