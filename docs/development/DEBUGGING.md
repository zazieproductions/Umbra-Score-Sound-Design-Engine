# Debugging

## Where to look first

| Symptom | Start here |
| --- | --- |
| No sound / wrong mix | `src/lib/audio.ts` (monitor graph), then `src/lib/dsp.ts` strip gains; check mute/solo on clip **and** layer |
| Export differs from monitor | `src/lib/render.ts` vs `audio.ts` — they must build the same graph; check `clipsPlaced`/`clipsFailed` in the render result |
| Clip won't play | `audioId` (backend file?) vs `cacheKey` (IndexedDB blob?) — one must resolve; see `clips.ts loadClipBuffer` |
| Provider stuck / job never finishes | `GET /api/jobs`, backend log, `services/generation_jobs.py`; jobs fail loudly with `hint` |
| Provider says unavailable | `GET /api/providers` → `installHint`; locally run `python scripts/verify_environment.py` |
| Retrieval returns nothing | License policy filter? Token set? Intent query too narrow? (`lib/library/service.ts`, `ranking.ts`) |
| Search ranks badly | `ranking.ts` signals; CLAP rerank only when installed (honest `clap: 'none'` otherwise) |
| Video features dead | `GET /api/analysis/toolchain` — ffmpeg on PATH? |
| UI state stale after edit | `useStudio.ts` action for that op; clip identity is `clip.id`, edits bump nothing but fields |

## Useful commands

```bash
npm run dev                                   # HMR + /api proxy
python scripts/run_backend.py                 # backend on :8000
python scripts/verify_environment.py --json   # machine-readable ground truth
curl localhost:8000/api/health | python3 -m json.tool
curl localhost:8000/api/providers | python3 -m json.tool
```

## Rules

- Reproduce with the smallest path (one clip, one provider, one intent).
- Distrust the UI copy before distrusting the API payload: read `/api/*`
  JSON directly.
- Never "fix" an honest `UNAVAILABLE` by faking readiness. Fix the install,
  the probe, or the hint text — in that order.
