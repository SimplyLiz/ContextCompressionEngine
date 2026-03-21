# E2E Smoke Test

Installs `context-compression-engine` as a real consumer would and exercises every public export.

Catches issues that unit tests can't: broken `exports` map, missing files in the tarball, ESM resolution failures, async path regressions.

## Pipeline

```
npm run test:e2e
```

Runs: **build → pack → publint + attw → smoke test → cleanup**

| Step               | What it does                                                                            |
| ------------------ | --------------------------------------------------------------------------------------- |
| `npm run build`    | Compile TypeScript                                                                      |
| `npm pack`         | Create tarball from `files` field                                                       |
| `publint --strict` | Validate package.json exports, files, types                                             |
| `attw`             | Check TypeScript type resolution across all `moduleResolution` settings                 |
| `smoke.mjs`        | 41 tests / 74 assertions exercising the public API (`node:test` + `node:assert/strict`) |
| cleanup            | Remove `.tgz`, `e2e/node_modules`, `e2e/package-lock.json`                              |

Cleanup always runs, even on failure. The exit code from the smoke test is preserved.

## Other scripts

```bash
# Test the published npm package (post-publish validation)
npm run test:e2e:published
```

## What the smoke test covers

| Area                      | What's tested                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Basic compression**     | ratio, token_ratio, message count, verbatim store, preserve keywords, sourceVersion, embedSummaryId, forceConverge, provenance metadata |
| **Uncompress round-trip** | lossless content restoration, missing verbatim store, plain object store                                                                |
| **Dedup**                 | exact duplicate detection (>=200 char), fuzzy dedup detects near-duplicates                                                             |
| **Token budget**          | binary search fit, impossible budget (fits=false), minRecencyWindow floor                                                               |
| **Token counter**         | defaultTokenCounter, custom tokenCounter                                                                                                |
| **Factory functions**     | createSummarizer, createEscalatingSummarizer exported                                                                                   |
| **Edge cases**            | empty input, single message                                                                                                             |
| **Async path**            | mock summarizer + round-trip, async + token budget                                                                                      |
| **Role handling**         | system messages auto-preserved, tool_calls pass through + other messages compressed                                                     |
| **Re-compression**        | compress already-compressed output + chained stores, recursive uncompress                                                               |
| **Large conversation**    | 31-message fixture, compression + round-trip, 50% budget target                                                                         |
| **Error handling**        | TypeError on non-array compress, null entry, missing id, non-array uncompress, invalid store; graceful handling of null/empty content   |
