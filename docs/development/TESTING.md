# Testing

Three tiers. Know which tier you ran, and what it does and does not prove.

## Tier 1 — unit / contract (fast, always run)

```bash
npm run verify                        # typecheck + lint + frontend unit tests
npm run build                         # production build (also runs tsc)
python -m pytest backend/tests -q     # backend: 57 tests, zero model downloads
```

| Suite | Proves | Does NOT prove |
| --- | --- | --- |
| `tests/library.acceptance.test.ts` (19) | Retrieval plumbing: intent→search→rank→license→cache→place→edit→replace→credits, against mocked Freesound HTTP + fake IndexedDB | Anything about the live Freesound API, real audio quality, or model inference |
| `tests/architecture.invariants.test.ts` | Structural invariants: CLAP advertises no generation caps, procedural needs no backend, clip providers come from the canonical enum, retrieval conversion keeps provenance | Runtime behavior |
| `backend/tests/test_backend.py` (57) | Real-audio contract (decode-before-register), capability honesty, prompt/payload mapping, routing, job lifecycle | Any model weights, hardware, or real inference |
| `backend/tests/test_invariants.py` | Cross-cutting backend invariants (CLAP ⊆ search caps, procedural is described-not-rendered, failures carry hints) | Runtime behavior |

**Mocked provider test ≠ model runtime verification.** This sentence is load-bearing.
See `../architecture/PROVIDERS.md`.

## Tier 2 — integration (real services, no weights)

- Backend up + frontend dev server: Models view shows honest states, `/api/health`
  reports real torch/CUDA/MPS/CPU, `verify_environment.py` output matches the UI.
- Retrieval against the **live** Freesound API with a Level 1 token: the same
  acceptance tests run unchanged (code paths identical; HTTP layer unmocked).

## Tier 3 — runtime acceptance (requires hardware + weights, manual, opt-in)

End-to-end: prompt D minor 44 BPM 12 s → real file → timeline → play sync →
move/trim → master contains it (see `tests/ACCEPTANCE-REPORT.md` for the
retrieval tiers). Passing Tier 3 for a provider is the **only** way it earns
`RUNTIME VERIFIED`, recorded in `docs/ai/CURRENT_STATE.md` with date, commit,
and machine. CI never runs Tier 3 and never downloads weights.

## CI

`.github/workflows/ci.yml` runs Tier 1 on PRs (frontend install → lint →
typecheck → tests → build; backend lightweight install → pytest). Heavyweight
runtime testing stays manual by design.
