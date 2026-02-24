# Token Budget

[Back to README](../README.md) | [All docs](README.md)

Automatically find the least compression needed to fit a target token count.

## How it works

When `tokenBudget` is set, the engine **binary-searches `recencyWindow`** to find the largest recency window that fits within the budget. This maximizes preserved recent context while still hitting the target.

### Binary search algorithm

```
1. Fast path: if total tokens <= budget, return immediately (no compression needed)
2. Set lo = minRecencyWindow (default 0), hi = messages.length - 1
3. Binary search:
   a. mid = ceil((lo + hi) / 2)
   b. Compress with recencyWindow = mid
   c. If result fits budget: lo = mid (try larger window)
   d. If over budget: hi = mid - 1 (try smaller window)
4. Final compress at recencyWindow = lo
5. If still over budget and forceConverge enabled: hard-truncate pass
```

The binary search runs compression at each iteration. When a `summarizer` is provided, each iteration calls the LLM — so budget + LLM is slower than budget alone.

### Basic usage

```ts
import { compress } from 'context-compression-engine';

const result = compress(messages, {
  tokenBudget: 4000,
  minRecencyWindow: 2,
});

result.fits;          // true if result fits within budget
result.tokenCount;    // token count (via tokenCounter)
result.recencyWindow; // the recencyWindow the binary search settled on
```

## `defaultTokenCounter`

The built-in estimator:

```ts
function defaultTokenCounter(msg: Message): number {
  return Math.ceil(msg.content.length / 3.5);
}
```

~3.5 characters per token is a rough heuristic. It's fast and works for ballpark estimates, but real tokenizers vary:

| Tokenizer | Typical chars/token |
| --------- | ------------------- |
| GPT-4/4o  | ~3.5-4.0            |
| Claude     | ~3.5-4.0            |
| Llama 3   | ~3.0-3.5            |

For accurate budgeting, replace it.

## Custom tokenCounter

The `tokenCounter` function is called for **all** budget decisions: binary search iterations, force-converge deltas, `token_ratio` stats, and the final `tokenCount`/`fits` fields.

### With gpt-tokenizer

```ts
import { compress } from 'context-compression-engine';
import { encode } from 'gpt-tokenizer';

const result = compress(messages, {
  tokenBudget: 4000,
  tokenCounter: (msg) => {
    const text = typeof msg.content === 'string' ? msg.content : '';
    return encode(text).length;
  },
});
```

### With tiktoken

```ts
import { encoding_for_model } from 'tiktoken';

const enc = encoding_for_model('gpt-4o');

const result = compress(messages, {
  tokenBudget: 4000,
  tokenCounter: (msg) => {
    const text = typeof msg.content === 'string' ? msg.content : '';
    return enc.encode(text).length;
  },
});

enc.free(); // tiktoken uses WASM — free when done
```

## `minRecencyWindow`

Floor for `recencyWindow` during binary search. Guarantees that at least N recent messages are always preserved, even under tight budgets.

```ts
const result = compress(messages, {
  tokenBudget: 2000,
  minRecencyWindow: 4, // always keep at least 4 recent messages
});
```

Default: `0` (no floor).

## `forceConverge`

When the binary search bottoms out (reaches `minRecencyWindow`) and the result still exceeds the budget, `forceConverge` runs a hard-truncation pass.

### How it works

1. Collect eligible messages: before the recency cutoff, not in `preserve` roles, content > 512 chars
2. Sort by content length descending (biggest savings first)
3. Truncate each to 512 chars: `[truncated — {original_length} chars: {first 512 chars}]`
4. Stop once the budget is satisfied

```ts
const result = compress(messages, {
  tokenBudget: 4000,
  forceConverge: true,
});
// result.fits is guaranteed true (unless only system/recency messages remain)
```

Truncated messages get `_cce_original` provenance metadata, so `uncompress()` restores the full content. Messages that were already compressed (have `_cce_original`) get their content replaced in-place without double-wrapping.

### When to use it

- **CI/CD pipelines** where you need a hard guarantee that context fits
- **Streaming applications** where exceeding the context window is a crash
- **Agentic loops** where the budget must be respected each iteration

Without `forceConverge`, the result may exceed the budget when conversations are heavily system-message or short-message dominated (since those are preserved).

## Budget with LLM summarizer

```ts
const result = await compress(messages, {
  tokenBudget: 4000,
  summarizer: mySummarizer,
});
```

The binary search calls the LLM at each iteration, so cost and latency scale with `log2(messages.length)` iterations. The LLM path still has the three-level fallback (LLM -> deterministic -> size guard) at each step.

---

## See also

- [Compression pipeline](compression-pipeline.md) - overall pipeline flow
- [LLM integration](llm-integration.md) - setting up summarizers
- [API reference](api-reference.md) - `tokenBudget`, `minRecencyWindow`, `forceConverge`, `tokenCounter`
