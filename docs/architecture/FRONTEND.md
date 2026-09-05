# Frontend (browser application)

React 19 · Vite 7 · TypeScript · Web Audio. Runs fully standalone:
procedural synthesis, timeline, mixing, offline render, and library cache all
work with no backend. Trained providers simply report unavailable until the
Python service answers.

## Module ownership (`src/`)

| File | Owns | Does not own |
| --- | --- | --- |
| `lib/types.ts` | **Canonical domain types**: `AudioClip`, `ClipMetadata`, `Project`, `Scene`, `Layer`, provider metadata. The vocabulary every other module speaks. | Rendering, state, I/O |
| `lib/audio.ts` | Realtime monitor: `ScoreEngine`, transport sync, procedural voices + clip buffers through the master chain, metering taps. | Project state, offline bounce, inference |
| `lib/clips.ts` | Clip primitives: decode cache, `loadClipBuffer`, `scheduleClip`, `move/trim/split` geometry. Playable anywhere audio is needed. | Provider inference, persistence |
| `lib/render.ts` | Offline bounce: `OfflineAudioContext` render of the **same graph** as the monitor, BS.1770 loudness conform, true-peak limiting, 24-bit WAV encode, stems. | Realtime playback |
| `lib/dsp.ts` | Shared DSP: channel strips, convolvers, ducking, sub bus, master chain, loudness/limiting math. Imported by both `audio.ts` and `render.ts` — this sharing is what makes "what you hear = what you export" true. | Any React state |
| `lib/voices.ts` | 17 procedural voice classes (per-layer synthesis graphs). Deterministic given seed. | Scheduling, mixing |
| `lib/proceduralClip.ts` | Bridge: bounces a procedural voice offline to a real WAV so procedural requests become ordinary `AudioClip`s. | Model inference |
| `lib/providers.ts` | **The only frontend↔backend boundary.** Typed client for `/api/*`, offline fallback descriptions, capability labels. All fetches are relative URLs (Vite proxies `/api`). | Any synthesis or DSP |
| `lib/generate.ts` | Deterministic scene/layer planning for the procedural engine (keys, stacks, seeds). | Trained-model prompting (that lives in `backend/analysis/spotting.py`) |
| `lib/useGeneration.ts` | Backend connection state, provider statuses, job polling, generation→`AudioClip` placement. Kept separate so the procedural engine never depends on the backend. | Project editing |
| `lib/useStudio.ts` | Project state, transport, clip editing ops, export orchestration, retrieval wiring. The largest module (~900 lines) — a coordinator, not a junk drawer: new logic belongs in the module it coordinates, not here. | Rendering, ranking, HTTP |
| `lib/library/*` | Retrieval subsystem: `types.ts` (roles, assets, intents, provenance), `planner.ts` (intent building), `ranking.ts`, `freesound.ts` / `pixabay.ts` / `userLibrary.ts` (sources), `freesoundBackend.ts` (HTTP client for `/api/integrations/freesound/*` — the Freesound API key is **server-side**, never in the browser), `service.ts` (orchestration), `cache.ts` (IndexedDB), `clipAudio.ts` (audition/decode), `credits.ts` (attribution export). | Generation, mixing |
| `components/*` | Views only: `Timeline`/`ClipLane`, `ClipInspector`, `LibraryView`, `ScoringPanel`, `ModelsView`, `RightPanel`, `Viewer`, `Rail`, `Meter`, … No audio math in components. | Engine logic |
| `App.tsx` | Shell: navigation, view switching, studio hook instantiation. | Everything else |

## Data flow (frontend)

```
useStudio (Project + clips)
   ├─► audio.ts ScoreEngine ──► Web Audio graph (monitor)
   ├─► render.ts ──► OfflineAudioContext (export; same dsp.ts graph)
   ├─► useGeneration ──► providers.ts ──► /api (Python backend)
   └─► library/service.ts ──► Freesound / IndexedDB / CLAP-rerank ──► AudioClip
```

## Rules for changing the frontend

1. New audible thing? It must become an `AudioClip` (`lib/types.ts`) —
   no parallel clip types (see ADR-0002).
2. New DSP? Put it in `dsp.ts` so monitor and bounce share it. A DSP node
   that exists in only one path is a mix-vs-export divergence bug.
3. New backend call? Add it to `providers.ts`. No ad-hoc `fetch('/api/…')`
   scattered through components.
4. New retrieval source? Implement the provider vocabulary in
   `lib/library/types.ts` and wire through `service.ts` — see
   `../development/ADDING_A_PROVIDER.md`.
5. Components stay presentational: read from the studio hook, call its
   actions, do math nowhere else.
6. Never hard-code `localhost`/`127.0.0.1` in browser code — use relative
   `/api` URLs so remote previews keep working.
