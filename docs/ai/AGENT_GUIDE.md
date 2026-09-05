# Agent guide (navigation)

You know nothing except the repo URL. Do this, in order:

1. Read `AGENTS.md` (root) — identity, invariants, done-means, commands.
2. Read `docs/ai/CURRENT_STATE.md` — what is true right now.
3. Read the architecture doc for your subsystem:
   - changing sound/playback/export → `architecture/AUDIO_PIPELINE.md` + `FRONTEND.md`
   - changing models/providers/search → `architecture/PROVIDERS.md` + `BACKEND.md`
   - changing clip/project shapes → `architecture/PROJECT_MODEL.md` + `GLOSSARY.md`
   - unsure why something is shaped oddly → `decisions/` (10-minute read)
4. Check `git log` on your files + open PRs (protocol: `SAFE_CHANGE_PROTOCOL.md`).
5. Run baseline tests before changing anything (`development/TESTING.md`).
6. Make the change per `development/ADDING_A_*`; extend invariant tests if you
   add an invariant.
7. Re-run `npm run verify` + backend pytest + `npm run build`; update
   `CURRENT_STATE.md` only if facts changed; fill the PR template.

 answers to the 11 orientation questions:

1. What is Umbra? → `AGENTS.md` §1, `README.md`.
2. Frontend vs backend? → `architecture/OVERVIEW.md` diagram + `FRONTEND.md`/`BACKEND.md`.
3. Realtime audio owner? → `src/lib/audio.ts` (+ `FRONTEND.md` table).
4. Generated audio owner? → `backend/providers/` (+ `PROVIDERS.md`).
5. Library retrieval owner? → `src/lib/library/` (+ `AUDIO_PIPELINE.md` §1).
6. What is an AudioClip? → `architecture/PROJECT_MODEL.md`, `src/lib/types.ts`.
7. How does audio reach the timeline? → `AUDIO_PIPELINE.md` §1.
8. How does export work? → `AUDIO_PIPELINE.md` §3, `src/lib/render.ts`.
9/10. Which providers exist / are verified? → `PROVIDERS.md` + `CURRENT_STATE.md`.
11. Canonical types? → `AGENTS.md` §4, `PROJECT_MODEL.md`.
