# Compression Pipeline

How `compress()` processes messages from start to finish.

## Pipeline overview

```
messages
  |
  v
classify ──> dedup ──> merge consecutive ──> summarize ──> size guard
  |            |              |                  |              |
  |            |              |                  |              v
  |            |              |                  |         preserve original
  |            |              |                  |         if summary >= original
  |            |              |                  v
  |            |              |            LLM or deterministic
  |            |              v
  |            |         same-role groups
  |            v
  |       exact + fuzzy
  v
 T0/T2/T3 + preservation rules
```

## 1. Classification

Every message is evaluated against [preservation rules](preservation-rules.md) in order. Messages that survive all checks are eligible for compression.

The classifier (`classifyAll`) applies rules in this order:

1. Role in `preserve` list (default: `['system']`) -> preserved
2. Within `recencyWindow` -> preserved
3. Has `tool_calls` -> preserved
4. Content < 120 chars -> preserved
5. Already compressed (`[summary:`, `[summary#`, or `[truncated` prefix) -> preserved
6. Marked as duplicate by dedup analysis -> dedup path
7. Contains code fences with >= 80 chars of prose -> code-split path
8. Has code fences with < 80 chars prose -> preserved
9. Classified as hard T0 (code, JSON, SQL, API keys, etc.) -> preserved
10. Valid JSON -> preserved
11. Everything else -> compress

See [Preservation rules](preservation-rules.md) for classification tiers and the hard vs. soft T0 distinction.

## 2. Deduplication

Before compression, messages are scanned for duplicates. See [Deduplication](deduplication.md) for full details.

- **Exact dedup** (default: on) - djb2 hash grouping, full string comparison
- **Fuzzy dedup** (opt-in) - fingerprint bucketing + line-level Jaccard similarity

Duplicates are replaced with compact references like `[cce:dup of msg_42 - 1234 chars]`.

## 3. Merge consecutive

Non-preserved, non-dedup messages with the **same role** are collected into groups. This merges consecutive messages from the same speaker before summarization, producing tighter summaries.

The `collectGroup` function walks forward from the current position, collecting messages that are:
- Not preserved
- Not code-split
- Not dedup-annotated
- Same role as the first message in the group

## 4. Summarize

Each group (or standalone message) goes through summarization.

### Structured output detection

Before summarizing, the engine checks if content looks like structured tool output (grep results, test output, status lines). Content is classified as structured when:

- 6+ non-empty lines
- Newline density > 1/80
- More than 50% of lines match structural patterns (file:line references, bullet points, key-value pairs, PASS/FAIL status words)

Structured output gets a specialized summarizer (`summarizeStructured`) that extracts file paths and status lines rather than trying to summarize prose.

### Deterministic summarization

The `summarize` function uses sentence scoring:

1. Split text into paragraphs, then sentences
2. Score each sentence with `scoreSentence`:
   - **+3** per camelCase identifier (e.g., `myFunction`)
   - **+3** per PascalCase identifier (e.g., `WebSocket`)
   - **+3** per snake_case identifier (e.g., `my_var`)
   - **+4** for emphasis phrases (`importantly`, `however`, `critical`, `must`, etc.)
   - **+2** per number with units (`10 seconds`, `500 MB`, etc.)
   - **+2** per vowelless abbreviation (3+ consonants, e.g., `npm`, `ssh`)
   - **+3** per status word (`PASS`, `FAIL`, `ERROR`, `WARNING`, `WARN`)
   - **+2** per grep-style reference (`src/foo.ts:42:`)
   - **+2** for optimal length (40-120 chars)
   - **-10** for filler starters (`great`, `sure`, `ok`, `thanks`, etc.)
3. Mark the highest-scored sentence per paragraph as "primary"
4. Greedy budget packing: primary sentences first (by score), then secondary
5. Re-sort selected sentences by original position to preserve reading order
6. Join with ` ... ` separator

Budget: 200 chars if input < 600 chars, 400 chars otherwise.

### Entity extraction

After summarizing, `extractEntities` pulls out key identifiers from the original text:

- Proper nouns (excluding common sentence starters)
- PascalCase, camelCase, snake_case identifiers
- Vowelless abbreviations
- Numbers with units/context

Up to 10 entities are appended as `| entities: foo, bar, baz`.

### Code-split processing

Messages containing code fences with significant prose (>= 80 chars) get split:

1. `splitCodeAndProse` extracts code fences and surrounding prose separately
2. Prose is summarized (budget: 200 if < 600 chars, else 400)
3. Code fences are preserved verbatim
4. Result: `[summary: ...]\n\n```code here````

If the code-split result is longer than the original, the message is preserved as-is.

### LLM summarization (async path)

When a `summarizer` is provided, the async path uses `withFallback`:

1. Call the user's summarizer
2. Accept the result only if it's a non-empty string **and** strictly shorter than the input
3. If the summarizer throws or returns longer text, fall back to deterministic `summarize`

This three-level fallback (LLM -> deterministic -> size guard) ensures compression never makes output worse.

## 5. Size guard

After summarization, the engine checks if the summary (with formatting, entities, merge count) is shorter than the original. If it isn't, the original message is preserved unchanged.

This check happens for:
- Single compressed messages
- Merged groups
- Code-split messages

## Output format

### Summary format

```
[summary: {text}{merge_suffix}{entity_suffix}]
```

- `{text}` - the summary text
- `{merge_suffix}` - ` (N messages merged)` when multiple messages were combined
- `{entity_suffix}` - ` | entities: foo, bar, baz` (omitted for code-split messages)

With `embedSummaryId: true`:
```
[summary#{cce_sum_abc123}: {text}{merge_suffix}{entity_suffix}]
```

### Dedup format

```
[cce:dup of {keepTargetId} — {contentLength} chars]
[cce:near-dup of {keepTargetId} — {contentLength} chars, ~{similarity}% match]
```

### Force-converge format

```
[truncated — {contentLength} chars: {first 512 chars}]
```

---

## See also

- [Preservation rules](preservation-rules.md) - classification details
- [Deduplication](deduplication.md) - exact and fuzzy dedup algorithms
- [Token budget](token-budget.md) - budget-driven compression with binary search
- [LLM integration](llm-integration.md) - summarizer setup
- [Provenance](provenance.md) - metadata attached to compressed messages
- [API reference](api-reference.md) - full signatures and types
