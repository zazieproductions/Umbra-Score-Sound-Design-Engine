# Architecture Decision Records

Lightweight, permanent records of decisions future agents might otherwise
accidentally reverse. Read these before "simplifying" the architecture.

Each ADR: Status · Context · Decision · Consequences · What this prevents.

| ADR | Decision |
| --- | --- |
| [0001](ADR-0001-hybrid-browser-python-architecture.md) | Browser Web Audio + local Python ML backend (no browser inference, no cloud) |
| [0002](ADR-0002-unified-audio-clip-model.md) | One canonical `AudioClip` for every sound source |
| [0003](ADR-0003-procedural-engine-first-class.md) | Procedural synthesis beside (not beneath) generative models |
| [0004](ADR-0004-library-retrieval-and-provenance.md) | Retrieval with license/provenance preservation, never flattened |
| [0005](ADR-0005-stem-delivery-reuses-live-graph.md) | Stem delivery re-runs the live graph; one clock, master-only loudness, stems sum to the mix |

Add a new ADR only for a decision of comparable weight — a future agent must
be able to read all of them in ten minutes. Propose the ADR in the same PR
that makes the decision.
