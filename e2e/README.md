# E2E Smoke Test

Installs `context-compression-engine` as a real consumer would and exercises every public export.

Catches issues that unit tests can't: broken `exports` map, missing files in the tarball, ESM resolution failures, async path regressions.

## Usage

```bash
# Test local changes (build → pack → install → test)
npm run test:e2e

# Test the published npm package (post-release sanity check)
npm run test:e2e:published
```

Both commands are defined in the root `package.json`.

## What it covers

| #   | Area                         | What's tested                                                  |
| --- | ---------------------------- | -------------------------------------------------------------- |
| 1   | Basic compress               | ratio, token_ratio, message count, verbatim store              |
| 2   | Uncompress round-trip        | lossless content restoration                                   |
| 3   | Dedup                        | exact duplicate detection (>=200 char messages)                |
| 4   | Token budget (fit)           | binary search finds a recencyWindow that fits                  |
| 5   | Token budget (tight)         | correctly reports `fits: false` when impossible                |
| 6   | defaultTokenCounter          | returns positive number                                        |
| 7   | Preserve keywords            | keywords retained in compressed output                         |
| 8   | sourceVersion                | flows into compression metadata                                |
| 9   | embedSummaryId               | summary_id embedded in compressed content                      |
| 10  | Factory functions            | createSummarizer, createEscalatingSummarizer exported          |
| 11  | forceConverge                | best-effort truncation, no regression                          |
| 12  | Fuzzy dedup                  | runs without errors, message count preserved                   |
| 13  | Provenance metadata          | \_cce_original structure (ids, summary_id, version)            |
| 14  | Missing verbatim store       | missing_ids reported correctly                                 |
| 15  | Custom tokenCounter          | invoked and used for ratio calculation                         |
| 16  | Edge cases                   | empty input, single message                                    |
| 17  | Async path (mock summarizer) | compress returns Promise, summarizer called, round-trip works  |
| 18  | Async + token budget         | async binary search produces fits/tokenCount/recencyWindow     |
| 19  | System role                  | system messages auto-preserved, never compressed               |
| 20  | tool_calls                   | messages with tool_calls pass through intact                   |
| 21  | Re-compression               | compress already-compressed output, recover via chained stores |
| 22  | Recursive uncompress         | nested provenance fully expanded                               |
| 23  | minRecencyWindow             | floor enforced during budget binary search                     |
| 24  | Large conversation (31 msgs) | compression + lossless round-trip at scale                     |
| 25  | Large conversation + budget  | binary search converges on 50% budget target                   |
| 26  | Verbatim store as object     | uncompress accepts plain Record, not just function             |
