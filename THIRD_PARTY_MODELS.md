# Third-Party Models Integration

This document records the pretrained models integrated into Umbra Score.

## Important Notice

This project **does not include training datasets or model checkpoints in the repository**.

Model weights are downloaded separately from their original sources at runtime or via setup scripts.

---

## Integrated Models

### Stable Audio Open

| Property | Value |
|----------|-------|
| **Project** | Stable Audio Open |
| **Source Repository** | https://github.com/Stability-AI/stable-audio-tools |
| **HuggingFace** | https://huggingface.co/stabilityai/stable-audio-open |
| **Code License** | Creative Commons CC BY-SA 4.0 |
| **Model License** | Stability AI Community License |
| **Purpose in Umbra** | Text-to-audio generation (SFX, ambience, textures) |
| **Checkpoint Size** | ~1.5 GB |

### MMAudio

| Property | Value |
|----------|-------|
| **Project** | MMAudio |
| **Source Repository** | https://github.com/MMAudio/MMAudio |
| **Model Source** | HuggingFace (to be confirmed) |
| **Code License** | Apache 2.0 (to be verified) |
| **Model License** | Custom (to be verified) |
| **Purpose in Umbra** | Video-to-audio synchronization |
| **Checkpoint Size** | ~2 GB (estimated) |

### CLAP (Contrastive Language-Audio Pretraining)

| Property | Value |
|----------|-------|
| **Project** | LAION-CLAP |
| **Source Repository** | https://github.com/LAION-AI/CLAP |
| **HuggingFace** | https://huggingface.co/laion-aai/CLAP |
| **Code License** | MIT |
| **Model License** | Creative Commons CC BY-SA 4.0 |
| **Purpose in Umbra** | Semantic audio search and embedding |
| **Checkpoint Size** | ~1 GB |

### PySceneDetect

| Property | Value |
|----------|-------|
| **Project** | PySceneDetect |
| **Source Repository** | https://github.com/Breakthrough/PySceneDetect |
| **PyPI** | https://pypi.org/project/scenedetect/ |
| **Code License** | BSD 3-Clause |
| **Model License** | N/A (algorithm, no ML model) |
| **Purpose in Umbra** | Real video scene boundary detection |
| **Dependencies** | OpenCV |

---

## Model Download Methods

Models are downloaded from HuggingFace Hub using the respective libraries:

```bash
# Stable Audio Open
python -m pip install stable-audio-tools
# Downloads automatically on first use

# CLAP
python -m pip install laion-clap
# Downloads automatically on first use

# MMAudio
python -m pip install transformers torch
# Downloads automatically on first use
```

---

## License Compliance

This project is for **personal, experimental, noncommercial** sound design and composition.

Before using these models:

1. **Read the individual model licenses** at the linked repositories
2. **Understand the attribution requirements** for each model
3. **Verify your use case complies** with the respective licenses

Common requirements include:
- Attribution to the original creators
- Indication of changes made (if any)
- Share-alike for CC-licensed content
- Non-commercial use restrictions where applicable

---

## Future Fine-Tuning

If fine-tuning support is added in the future:

1. **User-supplied datasets only** - Do not include training data in this repository
2. **Separate download** - Users must explicitly download their training data
3. **License verification** - Users are responsible for ensuring they have rights to fine-tune on their data
4. **Documentation** - See `docs/FINE_TUNING.md` for technical details
