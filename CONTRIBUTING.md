# Contributing to UMBRA·SCORE

Umbra is an experimental but seriously engineered creative-audio system. This
guide keeps contributions — human or agent — coherent. **AI agents: read
`AGENTS.md` first; it is the binding operational contract. This file is the
human-readable companion.**

## Development setup

```bash
npm install
npm run dev                        # frontend with HMR; /api proxies to :8000
```

With the inference backend (optional — the app is complete without it):

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python scripts/run_backend.py
```

Full setup, model installs, and troubleshooting:
`docs/development/SETUP.md`. Test strategy: `docs/development/TESTING.md`.

## Branch guidance

- Branch from latest `main`. **Never commit to `main` directly, never force-push it.**
- One branch per coherent change: `refactor/<area>`, `feat/<area>`,
  `fix/<area>`, `docs/<area>`.
- Before branching: `git fetch origin`, check open PRs for overlapping work
  (parallel-agent protocol: `docs/ai/SAFE_CHANGE_PROTOCOL.md`).
- Keep branches short-lived; rebase or merge latest `main` before opening a PR
  and resolve conflicts yourself.

## Commit expectations

- Small, coherent commits with conventional prefixes:
  `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- One logical change per commit. No thousand-file formatting dumps mixed with
  behavior changes.
- Commit messages say *why*, not just *what*.

## Test requirements

Before opening a PR, all of these must pass:

```bash
npm run verify                        # typecheck + lint + frontend unit tests
npm run build                         # production build
python -m pytest backend/tests -q     # backend, no model downloads
```

- Behavior changes need tests. Mocked provider tests prove plumbing, **not**
  runtime — never claim `RUNTIME VERIFIED` from a mock (see
  `docs/architecture/PROVIDERS.md`).
- Major invariants (CLAP-never-generates, provenance retention, no fake
  fallback) are pinned in `tests/architecture.invariants.test.ts` and
  `backend/tests/test_invariants.py`. Extend them when you add invariants.

## PR expectations

Fill in `.github/pull_request_template.md` completely — especially
**subsystems affected**, **tests run**, **runtime verification**, and
**model/license impact**. UI changes need screenshots.

- A PR touching architecture must update the corresponding `docs/` page.
- A major architectural decision needs a lightweight ADR in `docs/decisions/`.
- A PR adding a provider must document: code license, **weight license**,
  capabilities, install method, runtime-verification state — and update
  `THIRD_PARTY_MODELS.md` / `THIRD_PARTY_LICENSES.md` as applicable.
  Follow `docs/development/ADDING_A_PROVIDER.md`.

## Architecture changes

Propose the shape before the code for anything crossing a subsystem boundary
(frontend ↔ backend, new provider, new canonical type). The boundaries are
defined in `docs/architecture/` and decided in `docs/decisions/` — read them
before redesigning them.

## Documentation expectations

- Explain *why* in comments, *architecture* in `docs/`, *what* in code.
- Keep `docs/ai/CURRENT_STATE.md` factual and short; update its
  `LAST VERIFIED` section only when the facts change.
- Record genuine new problems in `docs/TECH_DEBT.md` (ID / area /
  description / risk / priority / safe next step).
- Do not add speculative roadmap items as commitments; `docs/ROADMAP.md`
  separates NOW / NEXT / LATER / EXPERIMENTAL.
