# UMBRA·SCORE documentation

Start with the question you are trying to answer.

## I am new — what is this?

- [`../README.md`](../README.md) — public entry point, 5-minute overview.
- [`architecture/OVERVIEW.md`](architecture/OVERVIEW.md) — system diagram,
  subsystem boundaries, and the journey from video to exported WAV.
- [`architecture/GLOSSARY.md`](architecture/GLOSSARY.md) — the shared
  vocabulary (AudioClip, Provider, Retrieval, Provenance, …).

## I want to understand a subsystem

- [`architecture/FRONTEND.md`](architecture/FRONTEND.md) — browser app:
  UI, timeline, Web Audio engine, DSP, offline render, library UX.
- [`architecture/BACKEND.md`](architecture/BACKEND.md) — Python service:
  providers, analysis, jobs, audio store, API map.
- [`architecture/AUDIO_PIPELINE.md`](architecture/AUDIO_PIPELINE.md) — how
  audio gets onto the timeline and into the final export.
- [`architecture/PROVIDERS.md`](architecture/PROVIDERS.md) — provider model,
  capability honesty, status vocabulary, runtime-verification rules.
- [`architecture/PROJECT_MODEL.md`](architecture/PROJECT_MODEL.md) — canonical
  domain types: Project, Scene, AudioClip, provenance, and where each lives.

## I want to build / change something

- [`development/SETUP.md`](development/SETUP.md) — reproducible dev environment.
- [`development/TESTING.md`](development/TESTING.md) — test strategy: what each
  suite proves (and what it does not).
- [`development/DEBUGGING.md`](development/DEBUGGING.md) — where to look when
  something breaks.
- [`development/ADDING_A_PROVIDER.md`](development/ADDING_A_PROVIDER.md) —
  checklist for a new sound source.
- [`development/ADDING_A_FEATURE.md`](development/ADDING_A_FEATURE.md) — where
  a new feature belongs.

## I want to know why it is shaped this way

- [`decisions/`](decisions/) — Architecture Decision Records. Short, permanent,
  and the reason "obvious simplifications" were already rejected.

## I am an AI agent

- [`../AGENTS.md`](../AGENTS.md) — **read first.** Binding operational contract.
- [`ai/AGENT_GUIDE.md`](ai/AGENT_GUIDE.md) — navigation guide for agents.
- [`ai/CURRENT_STATE.md`](ai/CURRENT_STATE.md) — compact factual briefing:
  architecture, runtime status, test counts, debt, safe next work.
- [`ai/SAFE_CHANGE_PROTOCOL.md`](ai/SAFE_CHANGE_PROTOCOL.md) — parallel-agent
  collaboration protocol. Follow it; divergent PRs have happened before.

## Supporting material

- [`personalization/`](personalization/) — LoRA/adapter architecture and the
  data rules for training on your own cues.
- [`history/`](history/) — historical design prompts. **Context only, never
  specifications.** See its README.
- [`TECH_DEBT.md`](TECH_DEBT.md) — known problems with safe next steps.
- [`ROADMAP.md`](ROADMAP.md) — NOW / NEXT / LATER / EXPERIMENTAL.
