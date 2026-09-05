# ADR-0001: Browser Web Audio + local Python ML backend

- **Status:** Accepted
- **Date:** 2026-09

## Context

Umbra needs both frame-accurate interactive audio (timeline, transport,
sub-Hz synthesis, instant audition) and heavy trained-model inference
(ACE-Step, Stable Audio, MMAudio, CLAP — PyTorch, multi-GB weights).
A composer's reference audio must never leave their machine.

## Decision

- The **browser** (React + Web Audio) owns UI, timeline, playback, procedural
  synthesis, mixing, DSP, metering, offline bounce, and library UX.
- A **local Python service** (FastAPI) owns model loading, inference,
  embeddings, scene detection, the audio file store, and jobs.
- The browser talks to its own origin only; Vite proxies `/api` to the
  backend. No CORS games, no hard-coded localhost in UI code.
- No cloud backend, no VST/native layer. Browser + local ML is the whole target.

## Consequences

- The app is complete without the backend (procedural + library cache work).
- Contract between sides is HTTP + files: latent tensors never cross.
- Contributors need two runtimes (node + Python 3.11/12) for full-stack work.

## What this prevents

- PyTorch-in-the-browser rewrites; "just put the model in WASM" proposals.
- Cloud-credit / GPU-region theater in the UI.
- Reference/training audio leaving the composer's machine.
