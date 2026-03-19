# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
