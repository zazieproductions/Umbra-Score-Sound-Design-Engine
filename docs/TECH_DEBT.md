# Technical debt register

Genuine known problems only — each supported by the current code. Not a
rewrite wishlist.

| ID | Area | Description | Risk | Priority | Safe next step |
| --- | --- | --- | --- | --- | --- |
| DEBT-001 | Domain | Legacy `SoundClip` still lives at the retrieval boundary (`library/types.ts` + compat shims in `lib/types.ts`). Two clip shapes invite a second fork. | Medium | High | Migrate remaining `SoundClip` usages to `AudioClip`; delete shims when unused |
| DEBT-002 | Frontend | `useStudio.ts` (~900 lines) coordinates state + transport + export + retrieval wiring. Fine today, but new logic keeps landing here by default. | Medium | Medium | Extract retrieval wiring into a `useRetrieval` hook behind the same interface |
| DEBT-003 | Providers | Models view renders its own status ladder; backend reports booleans + caps. Mapping is implicit — a new status word could render inconsistently. | Low | Medium | Centralise the boolean→ladder mapping next to `PROVIDER_FALLBACK` with a test |
| DEBT-005 | Retrieval | Ranking weights (`ranking.ts`) are hand-tuned with no eval harness; regressions are invisible. | Low | Medium | Fixture-based ranking eval: fixed intents + candidate sets, assert order stability |
| DEBT-006 | Backend | No Tier 3 runtime acceptance has passed in CI-accessible environments (by design — weights are heavy). Hardware gate status lives only in `CURRENT_STATE.md`. | Low | Low | Document a manual Tier 3 runbook; record first verified machine when available |
| DEBT-007 | Persistence | Project persistence / browser-cache durability story is implicit (`clearUnusedCache` protects timeline blobs, but no documented save/load contract). | Medium | Medium | Specify the project save format + cache-eviction guarantees in `PROJECT_MODEL.md` |
| DEBT-008 | Docs | Architecture docs can drift from code (no automated check). | Low | Low | Add a lightweight docs-drift check (canonical-type existence, route inventory) to CI |

Resolved items are deleted from this table (history remains in git).
