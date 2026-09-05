# Adding a feature

## Where does it go?

| Feature touches… | Put it in… |
| --- | --- |
| Timeline editing op (move/trim/split/fade/…) | `src/lib/clips.ts` (geometry) + `useStudio.ts` (state action) |
| Playback / monitoring | `src/lib/audio.ts` |
| Export / loudness / stems | `src/lib/render.ts` (+ shared math in `dsp.ts`) |
| New DSP node | `src/lib/dsp.ts` — must be used by **both** monitor and bounce |
| New synthesis voice | `src/lib/voices.ts` (+ `KIND_META` in `types.ts`) |
| Backend call | `src/lib/providers.ts` client + `useGeneration.ts` state |
| New backend analysis | `backend/analysis/` + thin route in `app.py` |
| New sound source | `docs/development/ADDING_A_PROVIDER.md`, not this page |
| Retrieval planning/ranking | `src/lib/library/planner.ts` / `ranking.ts` |
| New view / panel | `src/components/` (presentational; logic lives in lib) |
| New domain concept | Canonical type file first (`types.ts` / `library/types.ts` / `base.py`), then usages — never a duplicate declaration |

If the feature crosses the frontend↔backend boundary, read both
`../architecture/FRONTEND.md` and `../architecture/BACKEND.md` first, and keep
`providers.ts` the single crossing point.

## Checklist

1. Fits an existing abstraction? Use it. New abstraction needs a stated reason.
2. Canonical types updated, not duplicated.
3. Tests: unit/contract first; acceptance scenario if user-visible workflow.
4. Invariants still hold (`npm run verify`, backend pytest, invariant suites).
5. Docs: architecture page if ownership changed; ADR if a past decision is
   being revised; `CURRENT_STATE.md` if status/facts changed.
6. PR template filled, screenshots for UI.
