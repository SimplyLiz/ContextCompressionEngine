# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-03-21

### Added

- **Quality benchmark overhaul** — replaced broken metrics (keywordRetention, factRetention, negationErrors) with five meaningful ones: task-based probes (~70 across 13 scenarios), information density, compressed-only quality score, negative compression detection, and summary coherence checks.
- **Task-based probes** — hand-curated per-scenario checks that verify whether specific critical information (identifiers, code patterns, config values) survives compression. Probe failures surface real quality issues.
- **LLM-as-judge scoring** (`--llm-judge` flag) — optional LLM evaluation of compression quality. Multi-provider support: OpenAI, Anthropic, Gemini (`@google/genai`), Ollama. Display-only, not used for regression testing.
- **Gemini provider** for LLM benchmarks via `GEMINI_API_KEY` env var (default model: `gemini-2.5-flash`).
- **Opt-in feature comparison** (`--features` flag) — runs quality benchmark with each opt-in feature enabled to measure their impact vs baseline.
- **Quality history documentation** (`docs/quality-history.md`) — version-over-version quality tracking across v1.0.0, v1.1.0, v1.2.0 with opt-in feature impact analysis.
- **Min-output-chars probes** to catch over-aggressive compression.
- **Code block language aliases** in benchmarks (typescript/ts, python/py, yaml/yml).
- New npm scripts: `bench:quality:judge`, `bench:quality:features`.

### Changed

- Coherence and negative compression regression thresholds now track increases from baseline, not just zero-to-nonzero transitions.
- Information density regression check only applies when compression actually occurs (ratio > 1.01).
- Quality benchmark table now shows: `Ratio EntRet CodeOK InfDen Probes Pass NegCp Coher CmpQ`.
- `analyzeQuality()` accepts optional `CompressOptions` for feature testing.

### Removed

- `keywordRetention` metric (tautological — 100% on 12/13 scenarios).
- `factRetention` and `factCount` metrics (fragile regex-based fact extractor).
- `negationErrors` metric (noisy, rarely triggered).
- `extractFacts()` and `analyzeSemanticFidelity()` functions.

## [1.2.0] - 2026-03-20

### Added

- **Quality metrics** — `entity_retention`, `structural_integrity`, `reference_coherence`, and composite `quality_score` (0–1) computed automatically on every compression. Tracks identifier preservation, code fence survival, and reference coherence.
- **Relevance threshold** (`relevanceThreshold`) — drops low-value messages to compact stubs instead of producing low-quality summaries. Consecutive stubs grouped. New stat: `messages_relevance_dropped`.
- **Tiered budget strategy** (`budgetStrategy: 'tiered'`) — alternative to binary search that keeps recency window fixed and progressively compresses older content (tighten → stub → truncate).
- **Entropy scorer** (`entropyScorer`) — plug in a small causal LM for information-theoretic sentence scoring. Modes: `'augment'` (weighted average with heuristic) or `'replace'` (entropy only).
- **Conversation flow detection** (`conversationFlow: true`) — groups Q&A pairs, request→action→confirmation chains, corrections, and acknowledgments into compression units for more coherent summaries.
- **Cross-message coreference** (`coreference: true`) — inlines entity definitions into compressed summaries when a preserved message references an entity defined only in a compressed message.
- **Semantic clustering** (`semanticClustering: true`) — groups consecutive messages by topic using TF-IDF cosine similarity + entity overlap Jaccard, compresses each cluster as a unit.
- **Compression depth** (`compressionDepth`) — `'gentle'` (default), `'moderate'` (tighter budgets), `'aggressive'` (entity-only stubs), `'auto'` (progressive escalation until `tokenBudget` fits).
- **Discourse-aware summarization** (`discourseAware: true`) — experimental EDU-lite decomposition with dependency tracking. Reduces ratio 8–28% without a custom ML scorer; use exported `segmentEDUs`/`scoreEDUs`/`selectEDUs` directly instead.
- **ML token classifier** (`mlTokenClassifier`) — per-token keep/remove classification via user-provided model (LLMLingua-2 style). Includes `createMockTokenClassifier` for testing.
- **Importance-weighted retention** (`importanceScoring: true`) — per-message importance scoring based on forward-reference density, decision/correction content signals, and recency. Default threshold raised to 0.65.
- **Contradiction detection** (`contradictionDetection: true`) — detects later messages that correct earlier ones. Superseded messages compressed with provenance annotation.
- **A/B comparison tool** (`npm run bench:compare`) — side-by-side comparison of default vs v2 features.
- **V2 Features Comparison** section in benchmark output — per-feature and recommended combo vs default.
- **Adversarial test suite** — 8 edge-case tests (pronoun-heavy, scattered entities, correction chains, code-interleaved prose, near-duplicates, 10k+ char messages, mixed SQL/JSON/bash, full round-trip with all features).
- New modules: `entities.ts`, `entropy.ts`, `flow.ts`, `coreference.ts`, `cluster.ts`, `discourse.ts`, `ml-classifier.ts`.
- New types: `ImportanceMap`, `ContradictionAnnotation`, `MLTokenClassifier`, `TokenClassification`, `FlowChain`, `MessageCluster`, `EDU`, `EntityDefinition`.
- Comprehensive [V2 features documentation](docs/v2-features.md) with tradeoff analysis per feature.

### Changed

- Adaptive summary budgets scale with content density when `compressionDepth` is set to `'moderate'` or higher (entity-dense content gets up to 45% budget, sparse content down to 15%).
- Default path (no v2 options) produces identical output to v1.1.0 — all new features are opt-in.
- Quality metrics section added to benchmark reporter and generated docs.

### Fixed

- Flow chains no longer skip non-member messages between chain endpoints.
- Semantic clusters restricted to consecutive indices to preserve round-trip ordering.
- Flow chains exclude messages with code fences to prevent structural integrity loss.

## [1.1.0] - 2026-03-19

### Added

- Reasoning chain detection in classifier — preserves chain-of-thought, step-by-step analysis, formal proofs, and multi-step logical arguments as hard T0 (verbatim). Uses two-tier anchor system: strong anchors (explicit labels like `Reasoning:`, formal inference phrases) trigger on a single match; weak anchors (logical connectives like `therefore`, `hence`, `thus`) require 3+ distinct to fire. Defense-in-depth scoring boost in the summarizer ensures reasoning sentences survive even if classification is bypassed.

## [1.0.0] - 2025-02-24

First stable release. Published as `context-compression-engine`.

### Added

- Lossless context compression with `compress()` and `uncompress()`
- Code-aware classification: fences, SQL, JSON/YAML, API keys, URLs, file paths preserved verbatim
- Paragraph-aware sentence scoring in `summarize()`
- Code-bearing message splitting to compress surrounding prose
- Exact and fuzzy cross-message deduplication (enabled by default)
- LLM-powered summarization with `createSummarizer()` and `createEscalatingSummarizer()`
- Three-level fallback: LLM → deterministic → size guard
- `tokenBudget` with binary search over `recencyWindow`
- `forceConverge` hard-truncation pass for guaranteed budget convergence
- Pluggable `tokenCounter` option (default: `ceil(content.length / 3.5)`)
- `embedSummaryId` option to embed summary IDs directly into message content
- Provenance tracking via `_cce_original` metadata (origin IDs, summary hashes, version chains)
- Verbatim store for lossless round-trip (`VerbatimMap` or lookup function)
- Recursive `uncompress()` for multi-round compression chains
- `preserve` option for role-based message protection
- `recencyWindow` to protect recent messages from compression
- Tool/function result compression through the classifier
- Compression stats: `ratio`, `token_ratio`, `messages_compressed`, `messages_removed`
- Input validation on public API surface
- 333 tests with coverage across all compression paths
- Benchmark suite with synthetic and real-session scenarios
- LLM benchmark with multi-provider support (Claude, GPT, Gemini, Grok, Ollama)

[1.1.0]: https://github.com/SimplyLiz/ContextCompressionEngine/releases/tag/v1.1.0
[1.0.0]: https://github.com/SimplyLiz/ContextCompressionEngine/releases/tag/v1.0.0
