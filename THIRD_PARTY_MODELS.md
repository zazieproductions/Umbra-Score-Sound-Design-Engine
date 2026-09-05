# Third-party models

Umbra ships **no model weights**. Nothing in this repository contains, mirrors or redistributes a
checkpoint. Every model below is downloaded by you, from its official source, into a local
directory (`checkpoints/` by default) that is excluded from Git.

> **A permissive code licence does not mean a permissive weights licence.** ACE-Step's code is
> MIT; Stable Audio Open's code is MIT but its *weights* are under a Stability community licence
> with a revenue threshold. Read the weight licence for each model you enable, especially before
> commercial use.

Verified against upstream in September 2026. Terms change — re-check before shipping.

---

## ACE-Step 1.5 — primary musical scoring provider

| | |
| --- | --- |
| Role in Umbra | Musical score, tonal beds, orchestral/synthetic texture, continuation, repaint, reference-conditioned generation |
| Code licence | **MIT** (`ace-step/ACE-Step-1.5`) |
| Main repo | `ACE-Step/Ace-Step1.5` |
| Components | `acestep-v15-turbo`, `vae`, `Qwen3-Embedding-0.6B`, `acestep-5Hz-lm-1.7B` |
| Install | `python scripts/setup_models.py --ace-step` |
| Gated | No |

ACE-Step's README carries a responsible-use disclaimer: verify originality, disclose AI
involvement, obtain permission when adapting protected styles, and accept that the authors are
not liable for misuse. Umbra surfaces this expectation rather than hiding it.

**Umbra deliberately does not use ACE-Step for foley, footsteps, door sounds, room tone or
realistic environmental audio.** It is a scoring instrument here, not a general sound generator,
and it never authors a whole soundtrack unattended.

Additional checkpoints (`acestep-v15-base`, `-sft`, `-xl-*`, `acestep-5Hz-lm-0.6B/-4B`) are
optional and fetched the same way. Capabilities such as `repaint`, `complete` (continuation) and
`cover` are only advertised in the UI when the *installed* checkpoint actually declares support
for that task type — Umbra reads this from the package rather than assuming it.

---

## Stable Audio Open 1.0 — environmental sound and SFX

| | |
| --- | --- |
| Role in Umbra | Physical/environmental sound: ventilation hum, water, wind, debris, room tone |
| Repository | `stabilityai/stable-audio-open-1.0` on Hugging Face |
| Weights licence | **Stability AI Community License** (`license: other`, `license_name: stable-audio-community`) — **not** an OSI open-source licence |
| Commercial limit | Organisations above **US$1M annual revenue** require a separate Stability enterprise licence (<https://stability.ai/license>) |
| Gated | **Yes** — you must accept the licence on Hugging Face and supply an `HF_TOKEN` |
| Training data | CC0 / CC-BY / CC-Sampling+ audio from Freesound and the Free Music Archive |
| Capability | Up to ~47 s stereo at 44.1 kHz, T5-conditioned latent diffusion |
| Install | `python scripts/setup_models.py --stable-audio` (opt-in only) |

Umbra never downloads this model silently. The provider reports "not installed" until you
explicitly opt in, and the Models view states the licence constraint on screen.

---

## MMAudio — video-conditioned foley

| | |
| --- | --- |
| Role in Umbra | Foley synchronised to picture (footsteps, impacts, motion-driven sound) |
| Code licence | **MIT** (`hkchengrex/MMAudio`) |
| Weights | Distributed by the authors; check the repository's model card for the weight terms, which may differ from the code licence |
| Install | `python scripts/setup_models.py --mmaudio` |

**FoleyCrafter** (`open-mmlab/FoleyCrafter`, **Apache-2.0** code) is supported as an alternative
video-conditioned provider. Its weights build on Stable Diffusion components; check that lineage
before commercial use.

---

## X-CLIP — semantic video analysis (optional)

| | |
| --- | --- |
| Role in Umbra | "What does this event window represent" for Foley/environmental sound retrieval — used *on top of* the pixel motion detector, never instead of it |
| Model | `microsoft/xclip-base-patch32` on Hugging Face |
| Weights licence | **MIT** per the model card (re-check before commercial use) |
| Approx. size | ~1.58 GB |
| Install | `python scripts/setup_models.py --xclip` |
| Gated | No |

X-CLIP produces **probabilistic semantic interpretation**, not guaranteed
object/action recognition. It only analyses meaningful event windows produced
by Umbra's existing pixel analyzer, and its results are advisory to retrieval.
Full details: [`docs/development/XCLIP.md`](./docs/development/XCLIP.md).

## CLAP — semantic audio search

| | |
| --- | --- |
| Role in Umbra | "Find something like this in my library" — text↔audio embeddings over *your own* files |
| Code licence | **CC0-1.0** (`LAION-AI/CLAP`) |
| Weights | LAION-published checkpoints on Hugging Face; see each checkpoint's model card |
| Install | `python scripts/setup_models.py --clap` |

CLAP only ever indexes audio you point Umbra at. It does not fetch, scrape or upload audio.

---

## PySceneDetect — shot detection

Software only, no weights. **BSD-3-Clause** (`Breakthrough/PySceneDetect`). Used for spotting
scene boundaries in the loaded picture, entirely locally.

---

## Umbra Procedural — no model at all

The default provider is not a trained model. It is deterministic Web Audio synthesis running in
your browser: 17 synthesis classes, no download, no network, no checkpoint, no licence
constraints beyond this repository's own. It remains a first-class provider and the only one
that works with the Python backend switched off.

---

## Checkpoint sizes

Approximate on-disk footprint, so you can plan before downloading. `scripts/setup_models.py
--list` reports the real figures once something is installed.

| Model | Approx. size |
| --- | --- |
| ACE-Step 1.5 (turbo + VAE + Qwen3-Embedding-0.6B + 1.7B LM) | ~8–10 GB |
| Stable Audio Open 1.0 | ~1.5 GB |
| MMAudio | ~2 GB |
| CLAP | ~1 GB |
| X-CLIP (`microsoft/xclip-base-patch32`) | ~1.58 GB |

## Before you use any of these commercially

1. **Read the individual model licence** at the linked source — not this table, which is a
   summary and may go stale.
2. **Check attribution requirements.** Several licences require crediting the original authors.
3. **Check whether changes must be indicated**, and whether share-alike applies to derivatives.
4. **Check revenue thresholds.** Stable Audio Open's community licence has one at US$1M.
5. **Verify your specific use case.** "Available to download" is not "licensed for your
   product".

Umbra is built for personal and professional sound design work, but the licence obligations
attach to *you* as the operator of the models, not to this repository.

## Where weights live

```
checkpoints/            # default download root, git-ignored
  ace-step/
  stable-audio/
  mmaudio/
  clap/
  xclip-base-patch32/
```

Override with `--dir` on `scripts/setup_models.py` or the `UMBRA_CHECKPOINT_DIR` environment
variable. `python scripts/setup_models.py --list` reports what is present, how large it is, and
which devices were actually detected.

## Data handling

- Reference audio you supply stays on your machine and is never uploaded.
- Personalization material lives in `training/user_audio/`, which is git-ignored. See
  [`docs/personalization/PERSONALIZATION.md`](./docs/personalization/PERSONALIZATION.md).
- Umbra ships no training datasets and performs no scraping.
