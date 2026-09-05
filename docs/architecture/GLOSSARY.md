# Glossary

Single agreed vocabulary. Use these terms; do not invent synonyms
("sound clip", "generated clip", "asset clip" all mean `AudioClip` unless a
distinction is explicitly stated).

| Term | Meaning |
| --- | --- |
| **AudioClip** | Canonical timeline object (`src/lib/types.ts`). Every audible source becomes one. |
| **SoundClip** | Legacy library clip shape (`src/lib/library/types.ts`). Convert at the boundary; do not extend. |
| **Layer** | One procedural voice slot in a scene (17 `LayerKind`s). Live synthesis, not a file. |
| **Scene** | Time span of the reel with tension/motion/tags/hits and a procedural layer stack. |
| **SpottingEvent** | User-marked sync point (e.g. DOOR OPEN @ 00:18.4) that retrieval planning builds intents from. |
| **Asset** | A retrieved/imported sound with full provenance (`LibraryAsset`). |
| **Provider** | One engine that can put sound on the timeline (procedural, trained model, or library source). |
| **Generator** | A provider that synthesises new audio (procedural + trained models). Retrieval sources are providers but not generators. |
| **Retrieval** | Finding real recordings (Freesound / user library), ranking, license-gating, placing. Never synthesis. |
| **RetrievalIntent** | Structured "find this" request: role, query, anchor time, duration fit, priority, silence-allowed flag. |
| **Transform** | Nondestructive processing recipe on a retrieved clip (`TransformSpec`); original asset always kept. |
| **Provenance** | Provider + soundId + license + credit line + retrieval timestamp, recorded at placement, exportable as credits. |
| **Runtime Verified** | Strong claim: real inference succeeded on real hardware. See `PROVIDERS.md` status ladder. Never from mocks. |
| **Procedural** | Deterministic Web Audio synthesis in the browser. First-class, always available. |
| **Generated** | Produced by a trained model in the Python backend. Requires install + weights. |
| **Retrieved** | Found in a library, placed with provenance. Requires license acceptance. |
| **Match** | Retrieval score 0..1, informational only — never "objective truth". |
| **Bed / event** | Bed roles (`ROOM_TONE`, `AMBIENCE`, `DRONE`, `TEXTURE`, `WIND`, `RUMBLE`) span time; events anchor to a moment. |
| **Plan** | Structured musical intent (key, tempo, density, timestamped structure) produced *before* generation — Umbra's creative layer, not the model's. |
| **Negative direction** | Always-applied suppression list (song form, heroic resolution, EDM drops…) shown to the composer before commit. |
| **Job** | Async backend generation unit; `succeeded` requires decoded audio on disk. |
| **Audio store** | Content-addressed local file registry (`backend/services/audio_store.py`); measures, never trusts. |
| **Master chain** | Shared DSP path (glue → tape → tilt → widen → exciter → brickwall → limiter) identical in monitor and bounce. |
| **Stems** | Per-group renders (music / hits / sub). Never a flattened inaccessible master. |
