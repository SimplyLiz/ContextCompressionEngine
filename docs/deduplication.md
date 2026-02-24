# Deduplication

[Back to README](../README.md) | [All docs](README.md)

Exact and fuzzy duplicate detection for repeated content in long conversations.

## Why dedup

Long-running conversations — especially agentic coding sessions — accumulate repeated content: the same file read multiple times, identical grep results, duplicate test output. Dedup detects these repetitions and replaces earlier occurrences with a compact reference, keeping only the latest copy.

Both exact and fuzzy dedup are **fully lossless** — originals are always stored in the verbatim map and restored by `uncompress()`.

## Exact dedup (default: on)

```ts
const result = compress(messages, { dedup: true }); // default
```

### Algorithm

**Phase 1: Hash grouping**

1. Filter eligible messages (skip preserved roles, tool_calls, already-compressed, content < 200 chars)
2. Compute djb2 hash of each message's content (with length prefix to reduce collisions)
3. Group messages by hash value

**Phase 2: Full string comparison**

1. Within each hash group, sub-group by exact content match
2. For groups with 2+ identical messages, select a **keep target**:
   - Prefer the first occurrence within the recency window
   - Otherwise, keep the latest occurrence
3. Mark all other occurrences as duplicates

### Output format

```
[cce:dup of {keepTargetId} — {contentLength} chars]
```

### Eligibility rules

A message is eligible for exact dedup when:
- Role is not in the `preserve` list
- No `tool_calls` array
- Content doesn't start with `[summary:`, `[summary#`, or `[truncated`
- Content length >= 200 chars

## Fuzzy dedup (opt-in)

```ts
const result = compress(messages, { fuzzyDedup: true });
```

Detects near-duplicates using line-level Jaccard similarity. Useful when the same file is read across edit cycles — the content evolves slightly but remains largely the same.

### Algorithm

**Phase 1: Build eligible list**

Same eligibility as exact dedup, plus:
- Skip indices already handled by exact dedup
- Normalize lines: trim, lowercase, filter empty
- Extract fingerprint: first 5 non-empty normalized lines
- Require at least 2 normalized lines

**Phase 2: Fingerprint bucketing**

1. Build inverted index: fingerprint line -> list of eligible indices
2. Find candidate pairs: eligible indices that share >= 3 fingerprint lines
3. Only forward pairs (avoid duplicates)

**Phase 3: Jaccard comparison**

For each candidate pair:
1. **Length-ratio pre-filter** — skip pairs where `min/max length ratio < 0.7`
2. **Line-level Jaccard** — `|A intersection B| / |A union B|` using multiset frequency maps
3. Accept pairs above the `fuzzyThreshold` (default: 0.85)

**Phase 4: Union-find grouping**

1. Use union-find to group transitively connected fuzzy-duplicates
2. For each group with 2+ members:
   - Prefer the first occurrence in the recency window as keep target
   - Otherwise, keep the latest occurrence
3. Mark all others with their similarity score

### Output format

```
[cce:near-dup of {keepTargetId} — {contentLength} chars, ~{similarity}% match]
```

### Complexity

Worst case O(n^2), but effectively O(n * k) in practice due to:
- Length-ratio pre-filter discards obvious non-matches
- Fingerprint bucketing requires >= 3 shared first-5-lines to even compare

## Threshold tuning

```ts
// Strict (default) — only very similar content
compress(messages, { fuzzyDedup: true, fuzzyThreshold: 0.85 });

// Moderate — catch more variants
compress(messages, { fuzzyDedup: true, fuzzyThreshold: 0.7 });

// Relaxed — aggressive dedup
compress(messages, { fuzzyDedup: true, fuzzyThreshold: 0.6 });
```

| Threshold | Use case |
| --------- | -------- |
| `0.85`+   | Safe default. Catches near-identical content (whitespace changes, minor edits) |
| `0.7`     | Catches file reads across small edit cycles |
| `0.6`     | Aggressive. May group content that shares structure but differs in specifics |

Lower thresholds increase dedup rate but risk grouping content that a human would consider distinct.

## Use cases

**Agentic coding sessions** — An AI assistant reads the same file 5 times during a debugging session. With exact dedup, 4 of the 5 reads become compact references. With fuzzy dedup, reads across edits are also caught.

**Repeated tool output** — Test runners, linters, and build tools produce similar output across runs. Fuzzy dedup catches the minor variations.

**Long Q&A** — Users sometimes paste the same error message or log output multiple times. Exact dedup catches these.

## Interaction with other options

- Dedup runs **before** compression. Dedup-annotated messages are handled in the dedup path and skip the normal summarization path.
- Dedup respects `preserve` roles and `recencyWindow` — messages in these categories are never deduped.
- Both exact and fuzzy dedup annotations include provenance metadata (`_cce_original`), so `uncompress()` restores the original content.

---

## See also

- [Compression pipeline](compression-pipeline.md) - where dedup fits in the pipeline
- [Round-trip](round-trip.md) - how dedup references are expanded
- [API reference](api-reference.md) - `dedup`, `fuzzyDedup`, `fuzzyThreshold` options
