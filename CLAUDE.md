# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # Install dependencies (uses npm ci in CI)
npm run build            # Compile TypeScript (tsc)
npm test                 # Run Vitest once
npm run test:coverage    # Run tests with coverage (requires Node 20+)
npm run lint             # ESLint check
npm run format           # Prettier write
npm run format:check     # Prettier check
npm run bench            # Run benchmark suite
npm run bench:save       # Run, save baseline, regenerate docs/benchmark-results.md
npm run bench:quality    # Run quality benchmark (probes, coherence, info density)
npm run bench:quality:save   # Save quality baseline
npm run bench:quality:check  # Compare against quality baseline
npm run bench:quality:judge     # Run with LLM-as-judge (requires API key)
npm run bench:quality:features  # Compare opt-in features vs baseline
```

Run a single test file:

```bash
npx vitest run tests/classify.test.ts
```

## Architecture

Single-package ESM library with zero dependencies. Compresses LLM message arrays by summarizing prose while preserving code, structured data, and technical content verbatim. Every compression is losslessly reversible via a verbatim store.

### Compression pipeline

```
messages → classify → dedup → merge → summarize → size guard → result
```

- **classify** (`src/classify.ts`) — three-tier classification (T0 = preserve verbatim, T2 = compressible prose, T3 = filler/removable). Uses structural pattern detection (code fences, JSON, YAML, LaTeX), SQL/API-key anchors, and prose density scoring.
- **dedup** (`src/dedup.ts`) — exact (djb2 hash + full comparison) and fuzzy (line-level Jaccard similarity) duplicate detection. Earlier duplicates are replaced with compact references.
- **importance** (`src/importance.ts`) — per-message importance scoring: forward-reference density (how many later messages share entities), decision/correction content signals, and recency bonus. High-importance messages resist compression even outside recency window. Opt-in via `importanceScoring: true`.
- **contradiction** (`src/contradiction.ts`) — detects later messages that correct/override earlier ones (topic-overlap gating + correction signal patterns like "actually", "don't use", "instead"). Superseded messages are compressed with provenance annotations. Opt-in via `contradictionDetection: true`.
- **compress** (`src/compress.ts`) — orchestrator. Handles message merging, code-bearing message splitting (prose compressed, fences preserved inline), budget binary search over `recencyWindow`, and `forceConverge` hard-truncation (importance-aware ordering when `importanceScoring` is on).
- **summarize** (internal in `compress.ts`) — deterministic sentence scoring: rewards technical identifiers (camelCase, snake_case), emphasis phrases, status words; penalizes filler. Paragraph-aware to keep topic boundaries.
- **summarizer** (`src/summarizer.ts`) — LLM-powered summarization. `createSummarizer` wraps an LLM call with a prompt template. `createEscalatingSummarizer` adds three-level fallback: normal → aggressive → deterministic.
- **expand** (`src/expand.ts`) — `uncompress()` restores originals from a `VerbatimMap` or lookup function. Supports recursive expansion for multi-round compression chains (max depth 10).

### Key data flow concepts

- **Provenance** — every compressed message carries `metadata._cce_original` with `ids` (source message IDs into `verbatim`), `summary_id` (djb2 hash), and `parent_ids` (chain from prior compressions).
- **Verbatim store** — `compress()` returns `{ messages, verbatim }`. Both must be persisted atomically. `uncompress()` reports `missing_ids` when verbatim entries are absent.
- **Token budget** — when `tokenBudget` is set, binary search finds the largest `recencyWindow` that fits. Each iteration runs the full pipeline. `forceConverge` hard-truncates if the search bottoms out.
- **Sync/async** — `compress()` is synchronous by default. Providing a `summarizer` makes it return a `Promise`.

## Branching Strategy

```
main ← develop ← feature branches
```

- **`develop`** — default branch, all day-to-day work and PRs target here
- **`main`** — stable releases only, merge develop → main when releasing
- **Feature branches** — branch off `develop`, PR back to `develop`
- **Tags** `v*.*.*` on `main` — trigger CI → publish to npm
- **Dependabot** PRs target `develop`

## Code Conventions

- **TypeScript:** ES2020 target, NodeNext module resolution, strict mode, ESM-only
- **Unused params** must be prefixed with `_` (ESLint enforced)
- **Prettier:** 100 char width, 2-space indent, single quotes, trailing commas, semicolons
- **Tests:** Vitest 4, test files in `tests/`, coverage via `@vitest/coverage-v8` (Node 20+ only)
- **Node version:** ≥18 (.nvmrc: 22)
- **Always run `npm run format` before committing** — CI enforces `format:check`
- **No author/co-author attribution** in commits, code, or docs
