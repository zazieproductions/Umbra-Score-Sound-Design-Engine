# Personalization — teaching Umbra your own horror voice

**Status: design document. Nothing here is implemented yet, by intent.**

Fine-tuning is the last phase of the roadmap (P7), and it only begins once inference,
timeline integration, conditioning, continuation and repaint are all genuinely stable. This
document exists so the architecture is decided *before* any training code is written — and so
the data rules are unambiguous from day one.

---

## 1. Why bother

Prompt engineering gets you a *generic* dissonant texture. It cannot get you *your* texture —
the particular bow pressure, the particular decay, the particular way you leave a cluster
unresolved. A composer's signature lives in details that no text prompt reliably reaches.

A small adapter trained on a composer's own cues can capture:

- characteristic harmonic language (which unresolved intervals you actually favour)
- orchestration fingerprints (how you voice low strings against sub)
- articulation and envelope habits (bow noise, attack shapes, release lengths)
- production character (your room, your processing, your noise floor)

The goal is not a better general model. It is a model that sounds like **you**, on your machine.

---

## 2. Hard data rules

These are constraints, not preferences.

1. **Training data comes solely from a user-supplied local folder.** `training/user_audio/`.
   Nothing else is ever a source.
2. **Umbra ships no datasets.** Not samples, not "starter packs", not curated corpora.
3. **No scraping. Ever.** No YouTube rips, no streaming captures, no library crawling.
4. **ACE-Step's training data is not copied or reconstructed.**
5. **Training audio is never committed to Git.** `training/user_audio/`, `training/datasets/`
   and `training/runs/` are all in `.gitignore`.
6. **Nothing is uploaded.** Training runs locally against local files. There is no telemetry,
   no dataset sync, no "help improve the model" path.
7. **Ownership is asserted per file** (below) and the tooling refuses to run without it.

You are responsible for having the rights to every file you place in that folder. Umbra makes
that explicit rather than burying it.

---

## 3. Dataset layout

```
training/
  user_audio/
    manifest.jsonl          # one JSON object per clip
    audio/
      dread_bed_01.wav
      cluster_low_02.wav
      ...
  runs/                     # checkpoints and logs, git-ignored
```

### `manifest.jsonl`

One object per line, one line per audio file:

```json
{
  "file": "audio/dread_bed_01.wav",
  "caption": "slow bowed low-string cluster, unresolved, sparse, no percussion",
  "tags": ["dread", "strings", "sustained", "unresolved"],
  "bpm": 44,
  "key": "D",
  "mode": "minor",
  "time_signature": "4",
  "duration": 38.2,
  "ownership": "original",
  "rights_holder": "Jane Composer",
  "notes": "from NIGHTSHIFT reel, cue 4B"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | yes | Path relative to `training/user_audio/` |
| `caption` | yes | Natural-language description in the same register as your prompts |
| `tags` | no | Short controlled vocabulary for filtering |
| `bpm` / `key` / `mode` / `time_signature` | no | Conditioning targets; blank is allowed and preferable to a guess |
| `duration` | no | Filled in by the ingest tool if absent |
| `ownership` | **yes** | One of `original`, `licensed`, `public-domain`, `cc0` |
| `rights_holder` | yes unless `ownership: original` | Who owns it |
| `notes` | no | Free text for your own bookkeeping |

**The ingest tool must refuse to build a dataset if any entry lacks `ownership`.** No default,
no "unknown", no silent skip — an explicit failure with the offending filenames listed.

### Audio requirements

- WAV or FLAC, 44.1 or 48 kHz, mono or stereo
- 10–240 s per file; longer material should be split at musical boundaries
- Aim for **30+ minutes** of consistent material; 10 minutes can work for a narrow texture
- Clean sources. Do not train on material that already has a limiter slammed on it
- Consistency beats volume: 20 minutes of one coherent voice outperforms 3 hours of everything

---

## 4. Adapter architecture

Full fine-tuning of ACE-Step is out of scope — it is expensive, it needs hardware most composers
do not have, and it risks catastrophic forgetting of the general musical prior we actually want
to keep. Adapters are the right tool.

### Recommended: LoRA via PEFT

- **Target modules**: attention projections (`to_q`, `to_k`, `to_v`, `to_out`) in the diffusion
  transformer blocks. Leave the VAE and the text/LM encoder frozen.
- **Rank**: start at `r=16`, `alpha=32`. Raise to `r=32` only if the adapter underfits a
  genuinely complex voice.
- **Dropout**: `0.05`.
- **Trainable parameter count**: low tens of millions, i.e. a 50–200 MB adapter file rather
  than a multi-gigabyte checkpoint.

### Alternative: LyCORIS (LoHa / LoKr)

Better parameter efficiency for very small datasets, at the cost of a more fragile training
recipe. Worth offering as an option once LoRA works, not before.

### Why not full fine-tuning

It requires far more VRAM, it destroys generality, it produces checkpoints too large to manage
per-project, and it is unnecessary — style transfer is exactly what adapters are for.

---

## 5. Training recipe (starting point)

| Setting | Value | Note |
| --- | --- | --- |
| Base | `acestep-v15-base` or `-sft` | **Not** a turbo checkpoint — distilled models train poorly |
| Precision | bf16 | fp16 on older CUDA; fp32 on CPU is impractical |
| Batch size | 1–2 | Gradient accumulation to an effective 8–16 |
| Learning rate | `1e-4` | Cosine schedule, ~100 warmup steps |
| Steps | 1500–4000 | Small datasets overfit fast; watch, don't just wait |
| Checkpoint every | 250 steps | You will want to A/B intermediate adapters |
| Validation | Fixed prompt + fixed seed, rendered every checkpoint | Listening is the only real metric |

**Hardware reality:** this needs a CUDA GPU with ≥16 GB VRAM, or an Apple Silicon machine with
≥32 GB unified memory and a great deal of patience. CPU-only training is not viable, and Umbra
should say so plainly rather than starting a run that will never finish.

### Overfitting symptoms

- The model reproduces recognisable phrases from the training set → too many steps, or dataset
  too small
- Everything comes out the same regardless of prompt → learning rate too high, or captions too
  uniform
- Output degrades into noise → wrong base checkpoint (probably a turbo variant), or LR far too
  high

---

## 6. Planned tooling

Deliberately CLI-first. **No complicated training UI.** A composer starting a multi-hour run
wants a terminal they can leave open, not a web form.

```bash
# 1. validate the folder: ownership present, audio readable, captions non-empty
python scripts/personalize.py validate

# 2. build the training manifest (resamples, splits, computes durations)
python scripts/personalize.py prepare --out training/runs/dread-v1

# 3. train the adapter
python scripts/personalize.py train \
    --run training/runs/dread-v1 \
    --base acestep-v15-base \
    --rank 16 --steps 2000

# 4. audition: render the validation prompt with and without the adapter
python scripts/personalize.py audition --run training/runs/dread-v1

# 5. register it so the Scoring panel can select it
python scripts/personalize.py install --run training/runs/dread-v1 --name "Dread v1"
```

Installed adapters then appear in the Scoring panel's **Advanced** section as a style selector —
one dropdown, plus a strength slider (adapter scale, 0–1). Not thirty exposed hyperparameters.

---

## 7. Integration points

Once adapters exist, these are the touch points in the current codebase:

- `backend/services/model_manager.py` — discover installed adapters alongside base checkpoints
- `backend/providers/ace_step.py` — load/unload an adapter per request, apply adapter scale
- `backend/app.py` — a `/api/adapters` endpoint listing installed adapters
- `src/lib/providers.ts` — `adapters` on `ProviderStatus`, `adapterId`/`adapterScale` on
  `GenerateRequest`
- `src/components/ScoringPanel.tsx` — adapter selector inside the Advanced section
- `ClipMetadata` — record `adapterId` and `adapterScale` so a cue can be reproduced exactly

Metadata matters here: a clip generated with a personal adapter must record *which* adapter, or
the project is not reproducible six months later.

---

## 8. Sequencing

1. ✅ Backend + provider architecture
2. ✅ Timeline clip integration
3. ⬜ Verified ACE-Step inference on real hardware (the acceptance test)
4. ⬜ Conditioning, continuation, repaint proven in practice
5. ⬜ `personalize.py validate` + `prepare` (dataset tooling only — no training yet)
6. ⬜ LoRA training loop
7. ⬜ Adapter loading in the provider
8. ⬜ Adapter selector in the Advanced section

Steps 5–8 do not begin until step 3 has actually been demonstrated on hardware that can run the
model. Writing training code against unverified inference is how projects accumulate plausible
machinery that has never produced a sound.
