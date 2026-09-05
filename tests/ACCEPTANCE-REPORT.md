# UMBRA·SCORE — Sound Library Retrieval Acceptance Report

**Run:** `npm test` (Vitest; Node environment, Freesound HTTP mocked at the `fetch` layer)

**Status:** ✅ 19 / 19 passing · lint 0 errors · `tsc -b` clean · production build clean

**Environment note:** The live Freesound API is unreachable from this sandbox, so every
provider HTTP exchange is a controlled fixture — each mock route is asserted (endpoint,
`token` param, `fields`, `page_size`, preview URLs) rather than trusted blindly. The same
acceptance tests run unchanged against the real API once network access and a Level 1
token are available; the code paths are identical.

---

## T1 — DOOR OPEN @ 00:18.4  (acceptance test 1)

| Step | What is verified | Test |
|---|---|---|
| Spotting event → intent | `planScene` emits a `DOOR` intent with `time = 18.4`, short-fit, top priority | `planner turns the spotting event into a DOOR intent anchored at 18.4s` |
| Automated Freesound search | `GET /apiv2/search/` (current endpoint, not deprecated `/search/text/`), `token=` auth, `fields` includes `previews` + `license`, duration filter sent | `searches Freesound via the official /apiv2/search/ endpoint` |
| License + attribution | Candidate carries real provider metadata: creator, `Attribution` / `CC_BY`, source URL, credit line, preview URLs | same |
| In-app audition | Preview blob fetched from `preview-hq-mp3`, cached under `fs-<id>-preview`; second audition hits cache (1 network fetch total) | `auditions the preview: fetches the hq-mp3 once, caches by sound id` |
| Place at 00:18.4 | `placeClip` → real editable clip, `start = 18.4`, `source = LIB`, license + `retrievedAt` attached | `places a REAL editable clip at 00:18.4 with license + provenance attached` |
| Editable / movable / trimmed / fade / gain / pan | Clip is a discrete `SoundClip` — start/end/offset/gain/pan/fades/transform all patchable | same |
| Provenance + credits | Ledger row has creator/license/URL; `sound_credits.txt` + `.json` export include them | same |
| FIND ALTERNATIVE / replace | New intent keeps role/time; replacement preserves location, gain, pan, fades, offset, transform — swaps only source + cache key + intent id | `FIND ALTERNATIVE keeps timeline edits and swaps only the source audio` |

## T2 — Dark industrial basement → AUTO SOUND DESIGN → SUGGEST (acceptance test 2)

| Step | What is verified | Test |
|---|---|---|
| Planner role separation | Room tone + machine + water/pipe + footstep intents as **distinct roles with distinct queries** (no giant whole-scene query) | `planner produces room tone / pipe (water) / footstep / machine intents` |
| SUGGEST mode | `autoDesign(..., 'suggest')` places **nothing**; returns ≥3 separate candidate sets (room tone, pipe resonance, footstep foley, distant machine) | `AUTO SOUND DESIGN (SUGGEST) returns three+ separate candidate sets and places nothing` |
| No flattening | Each intent → its own clip/candidate set; Freesound hit per intent (not one chained query) | same |
| AUTO FULL | One clip per role, distinct ids, each with its own asset + license + provenance; footstep spotting event lands at 8.0s | `AUTO FULL places several separate clips — one per role, never a flattened file` |
| Transform applied correctly | MECHANICAL bed → `HORROR_DRONE_TRANSFORM`; ROOM_TONE stays `NO_TRANSFORM` | same |

## T3 — Real mechanical recording → Umbra processing → dark drone (acceptance test 3)

| Step | What is verified | Test |
|---|---|---|
| Import | User library import keeps name/role/tags/**declared** license/creator/source; never infers license from filename | `user library import keeps full metadata` |
| User library priority | Imported recording (role-tagged + query-matching) ranks **above** a valid external result; provider = `user-library` | `searches the USER LIBRARY first and ranks it above external sources` |
| Drone transform | `HORROR_DRONE_TRANSFORM` = pitch **−12 st**, playbackRate **0.4** (250% duration), lowpass 1800 Hz, reverb 0.74, loop + crossfade + slow modulation | `places the mechanical recording with the horror-drone transform + provenance, source and transform retained` |
| Provenance | Source indicator `USR`; creator, source URL, license, retrieval date, role survive placement; quality = `original` for user files | same |
| Editable source+transform | Transform can be edited afterward (e.g. pitch −6, reverb 0.4) while provenance stays intact | same |

---

## Licensing honesty & offline behavior

- `mapFreesoundLicense` reads the API's actual license strings — CC0 / Attribution / Attribution NonCommercial; anything else → `UNKNOWN` (**never inferred**).
- STRICT policy rejects CC BY-NC; PERSONAL NONCOMMERCIAL accepts it. Disallowed candidates stay visible but flagged (transparency), never auto-placed.
- AUTO SAFE skips a candidate with an unknown license (`skipped > 0`, `placed = 0`).
- Network failure → zero candidates + honest error text (no fake results, no silent generative substitution).
- No token → provider `ready = false` with a "enter API token" reason; search returns an honest error.
- Preview vs original are never conflated: previews are `quality = 'preview'`; originals require OAuth2 Bearer (`/sounds/<id>/download/`) and get a distinct cache key (`fs-<id>-original`).

## CLAP reranking

- CLAP is one weighted signal among text/duration/license/quality/popularity/provider-relevance; MATCH remains informational (0..1 blend, never "objective best").
- CLAP failure never breaks retrieval (`used = false`, candidates intact).

## File map

- `tests/library.acceptance.test.ts` — the 19 acceptance tests
- `tests/setup.ts` — Node shims: fake IndexedDB, localStorage, AudioContext stub, object URLs, fetch mock wiring
- `vitest.config.ts` — Vitest config (Node env)
