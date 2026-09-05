# Fine-Tuning Guide

> **Status**: This document describes potential future functionality.
> Fine-tuning is not currently implemented.

This guide explains how to fine-tune supported models on personal sound libraries.

---

## Overview

Umbra Score can use fine-tuned models for specialized sound generation. Fine-tuning allows you to adapt pretrained models to your specific style or requirements.

---

## Supported Models for Fine-Tuning

The following models support fine-tuning (when implemented):

1. **Stable Audio Open** - Text-to-audio generation
2. **CLAP** - Audio embedding model

---

## Requirements

### Hardware
- GPU with 8GB+ VRAM recommended
- 16GB+ system RAM
- 50GB+ storage for datasets and model checkpoints

### Software
- Python 3.10+
- PyTorch 2.0+
- CUDA 11.8+ or MPS (Apple Silicon)

### Data
- User-owned audio files
- Text captions/metadata for each file
- Rights to use the data for training

---

## User Data Structure

If fine-tuning is supported, organize your training data as follows:

```
training/
└── user_audio/
    ├── metadata.csv          # Required: file,caption,tags,duration
    ├── audio/
    │   ├── sound_001.wav
    │   ├── sound_002.wav
    │   └── ...
    └── license.txt           # Optional: your license terms
```

### metadata.csv Format
```csv
filename,caption,tags,duration
sound_001.wav,creaking wooden door in old house,horror,door,wood,2.5
sound_002.wav,distant pipe drip in basement,horror,ambience,water,4.0
sound_003.wav,metal scrape on concrete,danger,mechanical,metal,1.8
```

---

## Legal Considerations

### Training Data Rights
- **You must own or have rights to use** all training data
- **Do not include copyrighted audio** without permission
- **Document the source** of your training data

### License Compatibility
- Check that your fine-tuned model can be legally distributed
- Some pretrained model licenses restrict derivative works
- Consider using separate model weights for fine-tuned versions

### Attribution
- Fine-tuned models should still attribute the base model
- Include information about the training data source

---

## Implementation Notes

### When Fine-Tuning Is Implemented

1. **Setup Training Environment**
   ```bash
   python -m pip install torch transformers datasets
   ```

2. **Prepare Your Data**
   - Organize audio files
   - Create metadata CSV
   - Verify file formats (WAV, FLAC recommended)

3. **Run Fine-Tuning**
   ```bash
   python scripts/finetune.py --model stable-audio-open \
       --data training/user_audio \
       --epochs 10 \
       --batch-size 4 \
       --output models/my-finetuned-model
   ```

4. **Test the Fine-Tuned Model**
   - Generate test samples
   - Compare quality to base model
   - Verify the model works in Umbra Score

### Technical Considerations

- **LoRA fine-tuning** is recommended to reduce VRAM requirements
- **Learning rate scheduling** is important for audio quality
- **Data augmentation** (pitch shift, time stretch) can improve generalization
- **Evaluation metrics** should include both objective and subjective measures

---

## Disclaimer

Fine-tuning functionality is not currently implemented. This document describes the planned architecture and is subject to change.

Always verify that fine-tuning is legally permitted for your use case and that you have appropriate rights to your training data.
