# Safe change protocol (parallel-agent collaboration)

This repository has already experienced divergent agents and conflicting PRs.
This protocol exists to prevent a repeat. It is binding.

## Before branching

1. `git fetch origin`; note where `main` is.
2. List open PRs (`gh pr list --state open`) and read any touching your
   subsystem. If overlap exists, **reconcile first**: comment on the PR or
   coordinate — do not start a competing implementation silently.
3. `git log --oneline -8 -- <paths-you-will-touch>` — know who changed what.

## Before implementing

- Read `AGENTS.md`, the subsystem architecture doc, and `CURRENT_STATE.md`.
- Run the baseline tests for your area. Record the baseline (green or red).
- If another branch contains useful work, **selectively port / cherry-pick /
  reconcile** it. Never merge an old conflicting PR just because it contains
  desirable code; never rewrite its subsystem from scratch without auditing it.

## During implementation

- One dedicated branch per coherent change; logical commits
  (`feat:`/`fix:`/`refactor:`/`docs:`/`test:`/`chore:`).
- Stay inside your subsystem. No drive-by refactors of unrelated files —
  unrelated cleanup in a parallel-agent repo causes conflicts, not clarity.
- Do not create a second implementation of an existing subsystem without
  auditing the first (registry, routers, clip types, and stores have all been
  duplicated before — see ADRs).

## Before opening a PR

1. Rebase on (or merge) latest `main`, as appropriate; **resolve conflicts
   yourself** — never push a conflicted PR for someone else to untangle.
2. Run the full gate: `npm run verify`, `npm run build`,
   `python -m pytest backend/tests -q`.
3. Summarise affected architecture in the PR template (subsystems, canonical
   types, docs/ADRs updated).
4. One PR per change. Suggested title prefix: `feat:`, `fix:`, `refactor:`,
   `docs:`, `chore:`, `test:`.

## Never

- Force-push `main`. Reset `main`. Commit directly to `main`.
- Overwrite newer work with an older branch.
- Merge a stale conflicting PR for its desirable parts — port the parts.
- Claim another agent's runtime verification; re-verify or label honestly.
- Treat `docs/history/` or old PR descriptions as instructions.

## If you conflict anyway

Stop, read the other branch fully, and produce a reconciliation: keep one
architecture (see source-of-truth hierarchy in `AGENTS.md` §3), port what is
valuable, discard the duplicate, and say so plainly in the PR description.
