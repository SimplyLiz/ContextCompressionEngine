# V2 Features

[Back to README](../README.md) | [All docs](README.md)

New compression features added in v2. All features are **opt-in** with backward-compatible defaults — existing code produces identical output without changes. Zero new runtime dependencies.

## Quick reference

| Feature                                                          | Option                     | Default                    | Effect                                                                                            | Tradeoff                                                                                    |
| ---------------------------------------------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Quality metrics](#quality-metrics)                              | _automatic_                | on when compression occurs | Adds `entity_retention`, `structural_integrity`, `reference_coherence`, `quality_score` to result | ~1% overhead from entity extraction                                                         |
| [Relevance threshold](#relevance-threshold)                      | `relevanceThreshold`       | off                        | Drops low-value messages to stubs                                                                 | Higher ratio, may lose context in filler-heavy conversations                                |
| [Tiered budget](#tiered-budget-strategy)                         | `budgetStrategy: 'tiered'` | `'binary-search'`          | Compresses old prose first, protects recent messages                                              | Better quality at the same budget; slightly slower (tightening passes)                      |
| [Entropy scorer](#entropy-scorer)                                | `entropyScorer`            | off                        | Information-theoretic sentence scoring via external LM                                            | Better sentence selection; requires a local model or API                                    |
| [Adaptive budgets](#adaptive-summary-budgets)                    | _automatic_                | on                         | Scales summary budget with content density                                                        | Entity-dense content gets more room; sparse filler compresses harder                        |
| [Conversation flow](#conversation-flow)                          | `conversationFlow`         | `false`                    | Groups Q&A / request→action chains                                                                | More coherent summaries; reduces ratio on conversations without clear patterns              |
| [Discourse-aware](#discourse-aware-summarization) (experimental) | `discourseAware`           | `false`                    | EDU decomposition with dependency tracking                                                        | **Reduces ratio 8–28%** without an ML scorer. Infrastructure only — provide your own scorer |
| [Coreference](#cross-message-coreference)                        | `coreference`              | `false`                    | Inlines entity definitions into compressed summaries                                              | Prevents orphaned references; adds bytes to summaries                                       |
| [Semantic clustering](#semantic-clustering)                      | `semanticClustering`       | `false`                    | Groups messages by topic for cluster-aware compression                                            | Better coherence on topic-scattered conversations; O(n²) similarity computation             |
| [Compression depth](#compression-depth)                          | `compressionDepth`         | `'gentle'`                 | Controls aggressiveness: gentle/moderate/aggressive/auto                                          | Higher depth = higher ratio but lower quality                                               |
| [ML token classifier](#ml-token-classifier)                      | `mlTokenClassifier`        | off                        | Per-token keep/remove via external ML model                                                       | Highest quality compression; requires a trained model (~500MB)                              |
| [Agent tool pre-pass](#agent-tool-pre-pass)                      | `agentToolPrepass`         | `false`                    | Strips verbose output, echoed content, and expired file reads from tool messages before compression | Lossy for removed content; up to 5.8x effective ratio on agentic sessions                  |

---

## Quality metrics

Quality metrics are computed automatically whenever compression occurs. No option needed.

### Fields

| Field                              | Range | Meaning                                                                                                |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `compression.entity_retention`     | 0–1   | Fraction of technical identifiers (camelCase, snake_case, file paths, URLs, version numbers) preserved |
| `compression.structural_integrity` | 0–1   | Fraction of structural elements (code fences, JSON blocks, tables) preserved                           |
| `compression.reference_coherence`  | 0–1   | Fraction of output entity references whose defining message is still present                           |
| `compression.quality_score`        | 0–1   | Weighted composite: `0.4 × entity_retention + 0.4 × structural_integrity + 0.2 × reference_coherence`  |

### Example

```ts
const result = compress(messages, { recencyWindow: 4 });

console.log(result.compression.quality_score); // 0.95
console.log(result.compression.entity_retention); // 0.92
console.log(result.compression.structural_integrity); // 1.0
```

### Tradeoffs

- Quality metrics add ~1% overhead from entity extraction on every compression
- `entity_retention` only tracks identifiers (camelCase, snake_case, PascalCase, file paths, URLs, version numbers). Plain English nouns are not tracked
- `reference_coherence` checks if defining messages survived, not whether the definition text survived — a message can be compressed (losing the definition prose) and still count as "present" if its ID is in the output
- Scores of 1.0 do not mean lossless — they mean no tracked entities/structures were lost

---

## Relevance threshold

Drops low-value messages to compact stubs instead of producing low-quality summaries.

### Usage

```ts
const result = compress(messages, {
  relevanceThreshold: 5, // sentence score threshold
});
```

### How it works

Before summarizing a group of compressible messages, the engine scores each sentence using the heuristic scorer. If the best sentence score in the group falls below `relevanceThreshold`, the entire group is replaced with `[N messages of general discussion omitted]`. Consecutive dropped messages are grouped into a single stub.

Original content is still stored in `verbatim` — round-trip integrity is preserved.

### Tradeoffs

- **Higher values** = more aggressive dropping. Values around 3–5 catch most filler. Values above 8 will drop messages containing some technical content
- **Lower values** = only pure filler is dropped
- Messages with any code identifiers (camelCase, snake_case) tend to score above 3, so they survive
- The threshold operates on the _best_ sentence in a group — a message with one technical sentence among filler will be preserved
- `messages_relevance_dropped` stat tracks how many messages were stubbed

---

## Tiered budget strategy

An alternative to binary search that keeps the recency window fixed and progressively compresses older content.

### Usage

```ts
const result = compress(messages, {
  tokenBudget: 4000,
  budgetStrategy: 'tiered',
  forceConverge: true, // recommended with tiered
});
```

### How it works

```
1. Run standard compress with the user's recencyWindow
2. If result fits budget → done
3. Pass 2a: Tighten older summaries (re-summarize at 40% budget)
4. Pass 2b: Stub low-value older messages (score < 3 → "[message omitted]")
5. Pass 3: forceConverge as last resort (if enabled)
```

### Tradeoffs

|                | Binary search (default)      | Tiered                                          |
| -------------- | ---------------------------- | ----------------------------------------------- |
| Recency window | Shrinks to fit budget        | Fixed — recent messages always preserved        |
| Older messages | Compressed uniformly         | Progressively tightened by priority             |
| Speed          | O(log n) compress iterations | Single compress + tightening passes             |
| Best for       | General use, simple budgets  | Conversations where recent context matters most |

- Tiered is strictly better at preserving recent context but may produce lower quality on older messages (tighter budgets)
- Without `forceConverge`, tiered may fail to meet very tight budgets
- Works with both sync and async paths

---

## Entropy scorer

Plug in a small causal language model for information-theoretic sentence scoring. Based on [Selective Context (EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.391/).

### Usage

```ts
// Sync scorer (e.g., local model via llama.cpp bindings)
const result = compress(messages, {
  entropyScorer: (sentences) => sentences.map((s) => myLocalModel.selfInformation(s)),
  entropyScorerMode: 'augment', // combine with heuristic (default)
});

// Async scorer (e.g., remote inference)
const result = await compress(messages, {
  entropyScorer: async (sentences) => myApi.scoreSentences(sentences),
  summarizer: mySummarizer, // required to enable async path
});
```

### Modes

| Mode                  | Behavior                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `'augment'` (default) | Weighted average of heuristic + entropy scores (60% entropy, 40% heuristic) |
| `'replace'`           | Entropy scores only, heuristic skipped                                      |

### Tradeoffs

- `'augment'` is safer — heuristic catches structural patterns (code identifiers, status words) that entropy might miss in short sentences
- `'replace'` gives the entropy scorer full control — use when your model is well-calibrated
- Async scorers throw in sync mode (no `summarizer`/`classifier` provided). Use a sync scorer or add a summarizer to enable async
- The engine stays zero-dependency — the scorer function is user-provided

---

## Adaptive summary budgets

Summary budgets now scale with content density. This is automatic — no option needed.

### How it works

The `computeBudget` function measures entity density (identifiers per character):

- **Dense content** (many identifiers): up to 45% of content length as budget, max 800 chars
- **Sparse content** (general discussion): down to 15% of content length, min 100 chars
- **Default** (no density signal): 30% of content length, 200–600 chars (backward compatible)

### Tradeoffs

- Entity-dense messages (e.g., architecture discussions with many function names) get longer summaries, preserving more identifiers. This improves `entity_retention` but slightly reduces compression ratio on those messages
- Sparse filler messages get tighter summaries, improving ratio where it matters most
- Messages near the 120-char short-content threshold that previously escaped compression may now be compressed, since the lower budget minimum (100 chars vs. 200) allows shorter summaries

---

## Conversation flow

Groups common conversation patterns into compression units that produce more coherent summaries.

### Usage

```ts
const result = compress(messages, {
  conversationFlow: true,
});
```

### Detected patterns

| Pattern          | Detection                                                                      | Summary format                  |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Q&A              | User question (has `?`) → assistant answer                                     | `Q: {question} → A: {answer}`   |
| Request → action | User request (`can you`, `please`, `add`) → assistant action (`done`, `added`) | `Request: {request} → {action}` |
| Correction       | `actually`, `wait`, `no,` followed by same-topic content                       | `Correction: {correction text}` |
| Acknowledgment   | Substantive message (>200 chars) → short confirmation (`great`, `thanks`)      | `{substance} (acknowledged)`    |

Follow-up confirmations (`perfect`, `thanks`) are included in Q&A and request chains when detected within 2 messages.

### Tradeoffs

- Flow chains produce more coherent summaries than independent compression — a Q&A pair as `Q: ... → A: ...` preserves the relationship between question and answer
- **Messages with code fences are excluded** from flow chains to prevent code loss — they use the code-split path instead
- Conversations without clear patterns (e.g., multi-party discussions, brainstorming) see no benefit
- Flow chains can override soft preservation (recency, short content) but not hard blocks (system roles, dedup, tool_calls)
- The detection is conservative — only well-established patterns are matched. Ambiguous exchanges fall through to normal compression

---

## Discourse-aware summarization (experimental)

> **Status: experimental.** The infrastructure is in place (EDU segmentation, dependency graph, greedy selector) but the built-in rule-based scorer **reduces compression ratio by 8–28%** with no measurable quality gain over the default sentence scorer. The dependency tracking inherently fights compression — pulling in parent EDUs when selecting children keeps more text than necessary. This feature needs an ML-backed scorer to identify which dependencies are actually load-bearing. Until then, leave it off unless you provide a custom scorer.

Breaks content into Elementary Discourse Units (EDUs) with dependency tracking. Based on [From Context to EDUs (arXiv 2025)](https://arxiv.org/abs/2512.14244).

### Usage

```ts
// Not recommended without a custom scorer — reduces ratio
const result = compress(messages, {
  discourseAware: true,
});

// With a custom scorer (e.g., backed by an ML model) — the intended use
import { segmentEDUs, scoreEDUs, selectEDUs } from 'context-compression-engine';

const edus = segmentEDUs(text);
const scored = scoreEDUs(edus, (text) => myModel.importance(text));
const selected = selectEDUs(scored, budget);
```

### How it works

1. Segment text into EDUs at clause boundaries (discourse markers: `then`, `because`, `which`, `however`, etc.)
2. Build dependency edges: pronoun references (`it`, `this`) → preceding EDU; temporal chains (`first...then...finally`); causal chains (`because...therefore`)
3. Score EDUs (information-density heuristic by default, or custom scorer)
4. Greedy selection: highest-scored EDUs first, pulling in dependency parents (up to 2 levels)

### Why it underperforms without an ML scorer

The rule-based scorer rewards technical identifiers and penalizes filler — the same signals as the default sentence scorer. But the dependency tracking adds a tax: selecting one high-value EDU forces inclusion of its parent EDUs, which may be low-value. The default scorer can't distinguish load-bearing dependencies (removing the parent makes the child meaningless) from decorative ones (the parent adds context but the child stands alone). An ML scorer trained on discourse coherence would solve this.

### Tradeoffs

- Prevents incoherent summaries where removing a sentence orphans a pronoun reference — **in theory**, but the ratio cost currently outweighs the coherence benefit
- The EDU segmenter, dependency builder, and selector are fully functional and exported — use them directly with a custom scorer via `segmentEDUs`, `scoreEDUs`, `selectEDUs`
- Mutually exclusive with `entropyScorer` — when both are set, `discourseAware` takes priority

---

## Cross-message coreference

Tracks entity references across messages to prevent orphaned references when source messages are compressed.

### Usage

```ts
const result = compress(messages, {
  coreference: true,
});
```

### How it works

1. Build coreference map: for each identifier (camelCase, snake_case, PascalCase), track where it first appears and which later messages reference it
2. After compression: check if any preserved message references an entity defined only in a compressed message
3. If so: prepend `[context: {defining sentence}]` to the compressed message's summary

### Example

Without coreference:

```
Message 3 (compressed): [summary: handles retries with backoff | entities: fetchData]
Message 7 (preserved):  "Make sure fetchData uses a 30s timeout"
```

With coreference:

```
Message 3 (compressed): [context: The fetchData function handles API calls.] [summary: handles retries with backoff | entities: fetchData]
Message 7 (preserved):  "Make sure fetchData uses a 30s timeout"
```

### Tradeoffs

- Prevents the common failure mode where compressing an early definition message makes later references meaningless
- Adds bytes to compressed summaries (the `[context: ...]` prefix). This slightly reduces compression ratio
- Only tracks code-style identifiers (camelCase, snake_case, PascalCase) — not plain English nouns. This avoids false positives but misses some references
- The inline definition is the first sentence containing the entity, truncated to 80 chars. Complex multi-sentence definitions are only partially captured

---

## Semantic clustering

Groups messages by topic using lightweight TF-IDF and entity overlap, then compresses each cluster as a unit.

### Usage

```ts
const result = compress(messages, {
  semanticClustering: true,
  clusterThreshold: 0.15, // similarity threshold (default)
});
```

### How it works

1. Compute TF-IDF vectors per message (content words, stopwords removed)
2. Compute entity overlap (Jaccard similarity on extracted identifiers)
3. Combined similarity: `0.7 × cosine(TF-IDF) + 0.3 × jaccard(entities)`
4. Agglomerative clustering with average linkage until similarity drops below threshold
5. Multi-message clusters compressed as a unit with topic label

### Tradeoffs

- Long conversations that drift across topics benefit most — scattered messages about `fetchData` in messages 3, 7, 12, 19 get merged into one compressed block
- O(n²) similarity computation. For conversations under 50 messages this is negligible. For 500+ messages, consider whether the coherence benefit justifies the cost
- `clusterThreshold` controls sensitivity: lower values (0.05–0.10) create larger clusters; higher values (0.20–0.30) require stronger topic similarity
- Messages already claimed by flow chains are excluded from clustering — the two features cooperate without overlap
- Messages with fewer than 80 chars are excluded (not enough content for meaningful similarity)

---

## Compression depth

Controls how aggressively the summarizer compresses content.

### Usage

```ts
// Fixed depth
const result = compress(messages, {
  compressionDepth: 'moderate',
});

// Auto: progressively tries gentle → moderate → aggressive until budget fits
const result = compress(messages, {
  tokenBudget: 2000,
  compressionDepth: 'auto',
  forceConverge: true,
});
```

### Depth levels

| Level                | Summary budget    | Strategy                                  | Typical ratio    |
| -------------------- | ----------------- | ----------------------------------------- | ---------------- |
| `'gentle'` (default) | 30% of content    | Sentence selection                        | ~2x              |
| `'moderate'`         | 15% of content    | Tighter sentence selection                | ~3–4x            |
| `'aggressive'`       | Entity-only stubs | Key identifiers only                      | ~6–8x            |
| `'auto'`             | Progressive       | Tries each level until `tokenBudget` fits | Adapts to budget |

### Auto mode quality gate

In `'auto'` mode, the engine stops escalating if `quality_score` drops below 0.60 (unless forced by a very tight budget). This prevents aggressive compression from destroying too much context.

### Tradeoffs

- `'gentle'` is the safest — identical to default behavior. Start here
- `'moderate'` halves the summary budget. Entity-dense content keeps identifiers; sparse content gets very short summaries. Good for conversations with lots of boilerplate
- `'aggressive'` produces entity-only stubs (`fetchData, getUserProfile, retryConfig`). Use for archival compression where only the topics matter, not the details
- `'auto'` with `tokenBudget` is the most practical — it finds the minimum aggressiveness needed to fit. Without a budget, `'auto'` is equivalent to `'gentle'`

---

## ML token classifier

Per-token keep/remove classification via a user-provided ML model. Based on [LLMLingua-2 (ACL 2024)](https://arxiv.org/abs/2403.12968).

### Usage

```ts
import { compress, createMockTokenClassifier } from 'context-compression-engine';

// Mock classifier for testing
const classifier = createMockTokenClassifier([/fetch/i, /retry/i, /config/i]);
const result = compress(messages, { mlTokenClassifier: classifier });

// Real classifier (e.g., ONNX model)
const result = compress(messages, {
  mlTokenClassifier: (content) => {
    const tokens = myTokenizer.tokenize(content);
    const predictions = myModel.predict(tokens);
    return tokens.map((token, i) => ({
      token,
      keep: predictions[i] > 0.5,
      confidence: predictions[i],
    }));
  },
});
```

### Types

```ts
type TokenClassification = {
  token: string;
  keep: boolean;
  confidence: number; // 0–1
};

type MLTokenClassifier = (
  content: string,
) => TokenClassification[] | Promise<TokenClassification[]>;
```

### Tradeoffs

- Highest potential compression quality — a well-trained encoder model (XLM-RoBERTa, ~500MB) can achieve 2–5x compression at 95–98% accuracy retention
- T0 classification rules still override for code/structured content — the ML classifier only handles T2 prose
- Falls back to deterministic summarization if the ML-compressed output is longer than the original
- Async classifiers throw in sync mode — provide a `summarizer` or `classifier` to enable async
- The engine stays zero-dependency — you provide the model and tokenizer

### Helper utilities

```ts
import { whitespaceTokenize, createMockTokenClassifier } from 'context-compression-engine';

// Simple whitespace tokenizer
const tokens = whitespaceTokenize('The fetchData function'); // ['The', 'fetchData', 'function']

// Mock classifier for testing — keeps tokens matching any pattern
const mock = createMockTokenClassifier([/fetch/i, /retry/i], 0.9);
```

---

## Agent tool pre-pass

Strips three categories of agentic waste from `tool` and `function` role messages before the main compression pipeline runs. Based on [AgentDiet (arXiv:2509.23586)](https://arxiv.org/abs/2509.23586).

### Usage

```ts
const result = compress(messages, {
  agentToolPrepass: true,
});

// Stats in the result
result.compression.messages_tool_prepass_trimmed; // messages whose content was trimmed
result.compression.chars_tool_prepass_removed;    // characters removed before the main pipeline
```

### What it removes

| Category | Trigger | What happens |
| --- | --- | --- |
| **Verbose output** | Directory trees (≥5 `node_modules` lines), build step counters `[N/M]` (≥5 lines), npm/yarn noise (≥3 lines), test runner passing lines (≥10 `✓` lines) | Collapsed to stubs: `[... N directory entries omitted ...]`, `[... N build steps omitted ...]`, `[... N passing test lines omitted ...]` |
| **Echoed content** | Blocks ≥200 chars whose first 120 chars appear in a preceding assistant message | Replaced with `[content from preceding turn omitted (N chars)]` |
| **Expired file reads** | Tool messages ≥2000 chars whose path appears in a write-signal message within the next 15 turns | Replaced with `[file content omitted — superseded by a later write (N chars original)]` |

### Why this matters

Standard compression sees the waste patterns as T2 prose and compresses them to short summaries — but a summary of `[1/48] Compiling index.ts … [48/48] done` is worthless. The pre-pass drops the content entirely before classification runs, so the compressible budget is spent on signal instead of noise.

On sessions heavy with tool output, effective end-to-end ratio reaches **5.8x** vs **1.6x** baseline. Sessions without these patterns are unaffected — the pre-pass exits early at each threshold.

### Important: the pre-pass is lossy

The removed content is **not** stored in the verbatim map. `uncompress` restores originals back to the post-prepass state, not the original tool messages. This is intentional — verbose npm output and expired file reads have no value in a restored context.

If you need full fidelity on tool messages, do not enable `agentToolPrepass`.

### Tradeoffs

- No effect on sessions without the waste patterns — safe to enable by default in agentic pipelines
- The `expired file reads` category uses a conservative path pattern (≥3 slash-separated components with an extension) and a 15-turn lookahead — short or unconventional paths are not detected
- Echo detection uses the first 120 chars of each block as a probe — blocks that only partially overlap are not collapsed
- `system` messages and messages with `tool_calls` are never subject to pre-pass trimming; only `tool` and `function` role messages are processed

---

## Combining features

Features can be combined freely. Here are recommended combinations:

### Quality-focused (preserve context, moderate compression)

```ts
const result = compress(messages, {
  recencyWindow: 6,
  importanceScoring: true,
  contradictionDetection: true,
  coreference: true,
  conversationFlow: true,
});
```

### Ratio-focused (maximum compression, acceptable quality loss)

```ts
const result = compress(messages, {
  tokenBudget: 2000,
  compressionDepth: 'auto',
  budgetStrategy: 'tiered',
  relevanceThreshold: 3,
  semanticClustering: true,
  forceConverge: true,
});
```

### Balanced (good ratio + quality)

```ts
const result = compress(messages, {
  tokenBudget: 4000,
  conversationFlow: true,
  importanceScoring: true,
  coreference: true,
});
```

### Agentic coding sessions

```ts
const result = compress(messages, {
  agentToolPrepass: true,   // strip tool message waste first
  dedup: true,              // remove repeated file reads / test runs
  recencyWindow: 6,
  importanceScoring: true,
});
```

### Feature interaction notes

- `agentToolPrepass` runs before everything else — it reduces the input the main pipeline sees, so all other feature ratios are measured on the already-trimmed messages
- `conversationFlow` and `semanticClustering` cooperate — flow chains are detected first, remaining messages are clustered
- `discourseAware` is experimental and not included in any recommended combination — it reduces ratio without a custom ML scorer
- `mlTokenClassifier` takes priority over `discourseAware` and `entropyScorer`
- `relevanceThreshold` applies after flow/cluster detection — messages already grouped into chains/clusters are not individually threshold-checked
- `compressionDepth` affects all summarization (groups, code-split prose, contradictions) — not just the main group path

---

## See also

- [API reference](api-reference.md) — all options and result fields
- [Token budget](token-budget.md) — `budgetStrategy`, `compressionDepth: 'auto'`
- [Compression pipeline](compression-pipeline.md) — how features fit into the pipeline
- [Benchmark results](benchmark-results.md) — quality metrics per scenario
