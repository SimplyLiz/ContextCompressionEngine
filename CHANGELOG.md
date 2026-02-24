# Changelog

## 1.0.0

First stable release. Published as `context-compression-engine` (renamed from `@cce/core`).

### Features

- **Pluggable token counter** — `tokenCounter` option for accurate budget decisions with real tokenizers
- **`forceConverge`** — hard-truncate non-recency messages when binary search bottoms out and budget is still exceeded
- **`embedSummaryId`** — embed `summary_id` in compressed content for downstream reference
- **Dedup target IDs** — dedup references now carry target IDs for provenance tracking
- **Fuzzy dedup** — line-level Jaccard similarity catches near-duplicate content (opt-in)
- **Cross-message deduplication** — exact-duplicate detection enabled by default
- **LLM benchmark suite** — multi-provider (OpenAI, Anthropic, Ollama) head-to-head comparison
- **Escalating summarizer** — `createEscalatingSummarizer` with three-level fallback (normal → aggressive → deterministic)

### Fixes

- Fix TDZ bug in summarizer initialization
- Fix field drops and double-counting in compression stats
- Fix pattern boundary false positives in classifier
- Add input validation for public API entry points

## 0.1.0

Initial release.

### Features

- **Lossless context compression** — compress/uncompress round-trip restores byte-identical originals
- **Code-aware classification** — fences, SQL, JSON, API keys, URLs, file paths stay verbatim
- **Paragraph-aware sentence scoring** — deterministic summarizer picks highest-signal sentences
- **Code-split messages** — prose compressed, code fences preserved inline
- **Exact dedup** — hash-based duplicate detection replaces earlier copies with compact references (on by default)
- **Fuzzy dedup** — line-level Jaccard similarity catches near-duplicate content (opt-in)
- **LLM summarizer** — `createSummarizer` and `createEscalatingSummarizer` for pluggable LLM-powered compression
- **Token budget** — `tokenBudget` option binary-searches recency window to fit a target token count
- **Verbatim store** — originals keyed by ID for lossless retrieval via `uncompress()`

### API

- `compress(messages, options?)` — sync or async depending on whether `summarizer` is provided
- `uncompress(messages, verbatim)` — restore originals from compressed messages + verbatim map
- `createSummarizer(callLlm)` — wrap an LLM call with an optimized summarization prompt
- `createEscalatingSummarizer(callLlm)` — three-level summarizer (normal → aggressive → deterministic)
