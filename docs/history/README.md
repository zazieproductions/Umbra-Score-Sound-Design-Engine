# History (historical context only)

Files here are **snapshots of past thinking, not current specifications**.
They explain how Umbra got here; they do not define where it is.

- [`functionalization-prompt.md`](functionalization-prompt.md) — the large
  implementation prompt from an earlier parallel-agent development pass
  (kept via `git mv` from the repository root). Valuable for understanding
  *intent* ("replace simulations with real functionality"); obsolete wherever
  it conflicts with code, `AGENTS.md`, or `docs/architecture/`.

**Rule (also in `AGENTS.md` §3):** when history disagrees with code + tests,
code wins. Never implement from these files without checking the current
architecture docs.
