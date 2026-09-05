# Adding a provider

A provider is one engine that can put sound on the timeline. Follow this
checklist exactly — it encodes invariants agents have violated before.

## 1. Decide what it is (before writing code)

- **Generator** (new audio: model or synth) or **retrieval source** (found audio)?
  Generators live in `backend/providers/`; retrieval sources live in
  `src/lib/library/`. Do not mix them.
- Which routing bucket (`registry.py`)? If none fits, say so in the PR.
- Code license **and** weight license. If the weight license is unknown or
  incompatible, stop and ask.

## 2. Trained-model provider (backend)

1. New file `backend/providers/<name>.py` implementing `AudioProvider`
   (`base.py`): `status()` (honest probes only), `generate()` (real inference
   or `ProviderError` with `http_status` + `hint`).
2. Register in `ProviderRegistry` (`registry.py`); add routing signals only if
   the bucket is genuinely distinct.
3. Capabilities: re-derive from the installed version at runtime. Unavailable
   ⇒ no capabilities. CLAP-class providers must never list generation caps.
4. Results go through `services/audio_store.py` decoding — no success path
   without a real file.
5. Mirror new `Capability` values in `src/lib/providers.ts` + `CAPABILITY_LABEL`.
6. Tests in `backend/tests/`: status honesty (installed/absent), capability
   gating, request mapping, failure-loudness. **Mocks prove plumbing only.**
7. Docs: `PROVIDERS.md` table + routing boundaries, `THIRD_PARTY_MODELS.md`
   (weight license, gating, install), `THIRD_PARTY_LICENSES.md` (code license),
   `CURRENT_STATE.md` runtime status (`NOT INSTALLED` until Tier 3 passes).

## 3. Retrieval source (frontend)

1. Speak the `src/lib/library/types.ts` vocabulary: return `LibraryAsset`s
   with real provider, soundId, license class, attribution, credit line.
   `UNKNOWN` licenses are rejected by the policy gate — never guess.
2. Wire search/download through `service.ts`; caching through `cache.ts`;
   ranking signals through `ranking.ts`.
3. Convert to `AudioClip` at the boundary (`soundClipToAudioClip` pattern);
   retain `asset` + `cacheKey` + `intentId`.
4. Extend `tests/library.acceptance.test.ts` with the source's search→place
   path (mocked HTTP, asserted fixtures).

## 4. Never

- Second provider registry, second router, second clip type.
- Silent fallback from a failed provider to fake output.
- New status words outside `PROVIDERS.md`.
- Committed weights, credentials, or user audio.
- `RUNTIME VERIFIED` without Tier 3 evidence (date, commit, machine).
