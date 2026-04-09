# API Reference

[Back to README](../README.md) | [All docs](README.md)

Complete reference for all exports from `context-compression-engine`.

## Exports

```ts
// Primary
export { compress, defaultTokenCounter, bestSentenceScore } from './compress.js';
export { uncompress } from './expand.js';
export type { StoreLookup } from './expand.js';

// Format adapters
export { CodeAdapter, StructuredOutputAdapter } from './adapters.js';
export { XmlAdapter, YamlAdapter, MarkdownAdapter } from './format-adapters.js';

// Helpers (LLM integration)
export { createSummarizer, createEscalatingSummarizer } from './summarizer.js';
export { createClassifier, createEscalatingClassifier } from './classifier.js';

// Entity extraction & quality metrics
export {
  extractEntities,
  collectMessageEntities,
  computeEntityRetention,
  computeStructuralIntegrity,
  computeReferenceCoherence,
  computeQualityScore,
} from './entities.js';

// ML token classifier
export {
  compressWithTokenClassifier,
  compressWithTokenClassifierSync,
  whitespaceTokenize,
  createMockTokenClassifier,
} from './ml-classifier.js';

// Discourse decomposition (EDU-lite)
export { segmentEDUs, scoreEDUs, selectEDUs, summarizeWithEDUs } from './discourse.js';
export type { EDU } from './discourse.js';

// Semantic clustering
export { clusterMessages, summarizeCluster } from './cluster.js';
export type { MessageCluster } from './cluster.js';

// Cross-message coreference
export {
  buildCoreferenceMap,
  findOrphanedReferences,
  generateInlineDefinitions,
} from './coreference.js';
export type { EntityDefinition } from './coreference.js';

// Conversation flow detection
export { detectFlowChains, summarizeChain } from './flow.js';
export type { FlowChain } from './flow.js';

// Entropy scoring utilities
export { splitSentences, normalizeScores, combineScores } from './entropy.js';

// Importance scoring
export {
  computeImportance,
  scoreContentSignals,
  DEFAULT_IMPORTANCE_THRESHOLD,
} from './importance.js';
export type { ImportanceMap } from './importance.js';

// Contradiction detection
export { analyzeContradictions } from './contradiction.js';
export type { ContradictionAnnotation } from './contradiction.js';

// Types
export type {
  Classifier,
  ClassifierResult,
  CompressOptions,
  CompressResult,
  CreateClassifierOptions,
  CreateSummarizerOptions,
  Message,
  MLTokenClassifier,
  TokenClassification,
  Summarizer,
  UncompressOptions,
  UncompressResult,
  VerbatimMap,
} from './types.js';
```

---

## `compress`

Deterministic compression by default. Returns a `Promise` when a `summarizer` or `classifier` is provided.

### Signatures

```ts
function compress(messages: Message[], options?: CompressOptions): CompressResult;
function compress(
  messages: Message[],
  options: CompressOptions & { summarizer: Summarizer },
): Promise<CompressResult>;
function compress(
  messages: Message[],
  options: CompressOptions & { classifier: Classifier },
): Promise<CompressResult>;
```

### Parameters

| Parameter  | Type              | Description                     |
| ---------- | ----------------- | ------------------------------- |
| `messages` | `Message[]`       | Messages to compress            |
| `options`  | `CompressOptions` | Compression options (see below) |

### CompressOptions

| Option                        | Type                                               | Default               | Description                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preserve`                    | `string[]`                                         | `['system']`          | Roles to never compress                                                                                                                                                                                                                                                                                              |
| `recencyWindow`               | `number`                                           | `4`                   | Protect the last N messages from compression                                                                                                                                                                                                                                                                         |
| `sourceVersion`               | `number`                                           | `0`                   | Version tag for [provenance tracking](provenance.md)                                                                                                                                                                                                                                                                 |
| `summarizer`                  | `Summarizer`                                       | -                     | LLM-powered summarizer. When provided, `compress()` returns a `Promise`. See [LLM integration](llm-integration.md)                                                                                                                                                                                                   |
| `tokenBudget`                 | `number`                                           | -                     | Target token count. Binary-searches `recencyWindow` to fit. See [Token budget](token-budget.md)                                                                                                                                                                                                                      |
| `minRecencyWindow`            | `number`                                           | `0`                   | Floor for `recencyWindow` when using `tokenBudget`                                                                                                                                                                                                                                                                   |
| `dedup`                       | `boolean`                                          | `true`                | Replace earlier exact-duplicate messages with a compact reference. See [Deduplication](deduplication.md)                                                                                                                                                                                                             |
| `fuzzyDedup`                  | `boolean`                                          | `false`               | Detect near-duplicate messages using line-level similarity. See [Deduplication](deduplication.md)                                                                                                                                                                                                                    |
| `fuzzyThreshold`              | `number`                                           | `0.85`                | Similarity threshold for fuzzy dedup (0-1)                                                                                                                                                                                                                                                                           |
| `embedSummaryId`              | `boolean`                                          | `false`               | Embed `summary_id` in compressed content for downstream reference. See [Provenance](provenance.md)                                                                                                                                                                                                                   |
| `forceConverge`               | `boolean`                                          | `false`               | Hard-truncate non-recency messages when binary search bottoms out. See [Token budget](token-budget.md)                                                                                                                                                                                                               |
| `preservePatterns`            | `Array<{ re: RegExp; label: string }>`             | -                     | Custom regex patterns that force hard T0 preservation. See [Preservation rules](preservation-rules.md)                                                                                                                                                                                                               |
| `classifier`                  | `Classifier`                                       | -                     | LLM-powered classifier. When provided, `compress()` returns a `Promise`. See [LLM integration](llm-integration.md)                                                                                                                                                                                                   |
| `classifierMode`              | `'hybrid' \| 'full'`                               | `'hybrid'`            | Classification mode. `'hybrid'`: heuristics first, LLM for prose. `'full'`: LLM for all eligible. Ignored without `classifier`                                                                                                                                                                                       |
| `tokenCounter`                | `(msg: Message) => number`                         | `defaultTokenCounter` | Custom token counter per message. See [Token budget](token-budget.md)                                                                                                                                                                                                                                                |
| `importanceScoring`           | `boolean`                                          | `false`               | Score messages by forward-reference density, decision/correction content, and recency. High-importance messages are preserved outside the recency window. `forceConverge` truncates low-importance first. **Note:** preserving extra messages reduces compression ratio, which may make `tokenBudget` harder to meet |
| `importanceThreshold`         | `number`                                           | `0.65`                | Importance score threshold for preservation (0–1). Only used when `importanceScoring: true`                                                                                                                                                                                                                          |
| `contradictionDetection`      | `boolean`                                          | `false`               | Detect later messages that correct/override earlier ones. Superseded messages are compressed with a provenance annotation                                                                                                                                                                                            |
| `contradictionTopicThreshold` | `number`                                           | `0.15`                | IDF-weighted Dice similarity threshold for topic overlap in contradiction detection (0–1)                                                                                                                                                                                                                            |
| `relevanceThreshold`          | `number`                                           | -                     | Sentence score threshold. Messages whose best sentence score falls below this are replaced with a stub. See [V2 features](v2-features.md#relevance-threshold)                                                                                                                                                        |
| `budgetStrategy`              | `'binary-search' \| 'tiered'`                      | `'binary-search'`     | Budget strategy when `tokenBudget` is set. `'tiered'` keeps recency window fixed and progressively compresses older content. See [V2 features](v2-features.md#tiered-budget-strategy)                                                                                                                                |
| `entropyScorer`               | `(sentences: string[]) => number[]`                | -                     | External self-information scorer. Can be sync or async. See [V2 features](v2-features.md#entropy-scorer)                                                                                                                                                                                                             |
| `entropyScorerMode`           | `'replace' \| 'augment'`                           | `'augment'`           | How to combine entropy and heuristic scores. `'augment'` = weighted average, `'replace'` = entropy only                                                                                                                                                                                                              |
| `conversationFlow`            | `boolean`                                          | `false`               | Group Q&A, request→action, correction, and acknowledgment chains into compression units. See [V2 features](v2-features.md#conversation-flow)                                                                                                                                                                         |
| `discourseAware`              | `boolean`                                          | `false`               | **Experimental.** EDU decomposition with dependency-aware selection. Reduces ratio 8–28% without a custom ML scorer — use `segmentEDUs`/`scoreEDUs`/`selectEDUs` directly instead. See [V2 features](v2-features.md#discourse-aware-summarization)                                                                   |
| `coreference`                 | `boolean`                                          | `false`               | Inline entity definitions into compressed summaries when references would be orphaned. See [V2 features](v2-features.md#cross-message-coreference)                                                                                                                                                                   |
| `semanticClustering`          | `boolean`                                          | `false`               | Group messages by topic using TF-IDF + entity overlap, compress as units. See [V2 features](v2-features.md#semantic-clustering)                                                                                                                                                                                      |
| `clusterThreshold`            | `number`                                           | `0.15`                | Similarity threshold for semantic clustering (0–1). Lower = larger clusters                                                                                                                                                                                                                                          |
| `compressionDepth`            | `'gentle' \| 'moderate' \| 'aggressive' \| 'auto'` | `'gentle'`            | Controls summarization aggressiveness. `'auto'` tries each level until `tokenBudget` fits. See [V2 features](v2-features.md#compression-depth)                                                                                                                                                                       |
| `mlTokenClassifier`           | `MLTokenClassifier`                                | -                     | Per-token keep/remove classifier. T0 rules still override for code/structured content. See [V2 features](v2-features.md#ml-token-classifier)                                                                                                                                                                         |
| `agentToolPrepass`            | `boolean`                                          | `false`               | Strip verbose output, echoed content, and expired file reads from tool/function messages before the main pipeline runs. See [V2 features](v2-features.md#agent-tool-pre-pass)                                                                                                                                        |

### CompressResult

| Field                                       | Type                   | Description                                                                         |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `messages`                                  | `Message[]`            | Compressed message array                                                            |
| `verbatim`                                  | `VerbatimMap`          | Original messages keyed by ID. Must be persisted atomically with `messages`         |
| `compression.original_version`              | `number`               | Mirrors `sourceVersion`                                                             |
| `compression.ratio`                         | `number`               | Character-based compression ratio. >1 means savings                                 |
| `compression.token_ratio`                   | `number`               | Token-based compression ratio. >1 means savings                                     |
| `compression.messages_compressed`           | `number`               | Messages that were compressed                                                       |
| `compression.messages_preserved`            | `number`               | Messages kept as-is                                                                 |
| `compression.messages_deduped`              | `number \| undefined`  | Exact duplicates replaced (when `dedup: true`)                                      |
| `compression.messages_fuzzy_deduped`        | `number \| undefined`  | Near-duplicates replaced (when `fuzzyDedup: true`)                                  |
| `compression.messages_pattern_preserved`    | `number \| undefined`  | Messages preserved by `preservePatterns` (when patterns are provided)               |
| `compression.messages_llm_classified`       | `number \| undefined`  | Messages classified by LLM (when `classifier` is provided)                          |
| `compression.messages_llm_preserved`        | `number \| undefined`  | Messages where LLM decided to preserve (when `classifier` is provided)              |
| `compression.messages_contradicted`         | `number \| undefined`  | Messages superseded by a later correction (when `contradictionDetection: true`)     |
| `compression.messages_importance_preserved` | `number \| undefined`  | Messages preserved due to high importance score (when `importanceScoring: true`)    |
| `compression.messages_relevance_dropped`    | `number \| undefined`  | Messages replaced with stubs (when `relevanceThreshold` is set)                     |
| `compression.messages_tool_prepass_trimmed` | `number \| undefined`  | Messages whose content was trimmed by the agent tool pre-pass (when `agentToolPrepass: true`) |
| `compression.chars_tool_prepass_removed`    | `number \| undefined`  | Characters removed by the agent tool pre-pass before the main pipeline ran          |
| `compression.entity_retention`              | `number \| undefined`  | Fraction of technical identifiers preserved (0–1). Present when compression occurs  |
| `compression.structural_integrity`          | `number \| undefined`  | Fraction of structural elements preserved (0–1). Present when compression occurs    |
| `compression.reference_coherence`           | `number \| undefined`  | Fraction of entity references with surviving sources (0–1)                          |
| `compression.quality_score`                 | `number \| undefined`  | Composite quality: `0.4×entity + 0.4×structural + 0.2×coherence`                    |
| `fits`                                      | `boolean \| undefined` | Whether result fits within `tokenBudget`. Present when `tokenBudget` is set         |
| `tokenCount`                                | `number \| undefined`  | Estimated token count. Present when `tokenBudget` is set                            |
| `recencyWindow`                             | `number \| undefined`  | The `recencyWindow` the binary search settled on. Present when `tokenBudget` is set |

### Example

```ts
import { compress } from 'context-compression-engine';

// Sync
const result = compress(messages, {
  preserve: ['system'],
  recencyWindow: 4,
  sourceVersion: 1,
});

// Async (with LLM summarizer)
const result = await compress(messages, {
  summarizer: async (text) => myLlm.summarize(text),
});
```

---

## `uncompress`

Restore originals from the verbatim store. Always synchronous. See [Round-trip](round-trip.md) for full details.

### Signature

```ts
function uncompress(
  messages: Message[],
  store: StoreLookup,
  options?: UncompressOptions,
): UncompressResult;
```

### Parameters

| Parameter  | Type                | Description                                                             |
| ---------- | ------------------- | ----------------------------------------------------------------------- |
| `messages` | `Message[]`         | Compressed messages to expand                                           |
| `store`    | `StoreLookup`       | `VerbatimMap` object or `(id: string) => Message \| undefined` function |
| `options`  | `UncompressOptions` | Expansion options (see below)                                           |

### UncompressOptions

| Option      | Type      | Default | Description                                                                       |
| ----------- | --------- | ------- | --------------------------------------------------------------------------------- |
| `recursive` | `boolean` | `false` | Recursively expand messages whose originals are also compressed (up to 10 levels) |

### UncompressResult

| Field                  | Type        | Description                                        |
| ---------------------- | ----------- | -------------------------------------------------- |
| `messages`             | `Message[]` | Expanded messages                                  |
| `messages_expanded`    | `number`    | How many compressed messages were restored         |
| `messages_passthrough` | `number`    | How many messages passed through unchanged         |
| `missing_ids`          | `string[]`  | IDs looked up but not found. Non-empty = data loss |

### Example

```ts
import { uncompress } from 'context-compression-engine';

const { messages, missing_ids } = uncompress(compressed, verbatim);

// Recursive expansion
const deep = uncompress(compressed, verbatim, { recursive: true });

// Function store (database-backed)
const result = uncompress(compressed, (id) => db.getMessageById(id));
```

---

## `defaultTokenCounter`

The built-in token estimator used when no custom `tokenCounter` is provided.

### Signature

```ts
function defaultTokenCounter(msg: Message): number;
```

### Formula

```ts
Math.ceil(msg.content.length / 3.5);
```

The 3.5 chars/token ratio is the empirical average for GPT-family BPE tokenizers (cl100k_base, o200k_base) on mixed English text. The lower end of the range (~3.2–4.5) is chosen intentionally so budget estimates stay conservative — over-counting tokens is safer than under-counting. For accurate budgeting, replace with a real tokenizer. See [Token budget](token-budget.md).

---

## `createSummarizer`

Creates an LLM-powered summarizer with an optimized prompt template. See [LLM integration](llm-integration.md) for provider examples.

### Signature

```ts
function createSummarizer(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateSummarizerOptions,
): Summarizer;
```

### CreateSummarizerOptions

| Option              | Type                       | Default    | Description                                                          |
| ------------------- | -------------------------- | ---------- | -------------------------------------------------------------------- |
| `maxResponseTokens` | `number`                   | `300`      | Hint for maximum tokens in the LLM response                          |
| `systemPrompt`      | `string`                   | -          | Domain-specific instructions prepended to the built-in rules         |
| `mode`              | `'normal' \| 'aggressive' \| 'structured'` | `'normal'` | `'aggressive'` produces terse bullet points at half the token budget; `'structured'` outputs ACON-style REASONING / VARS / GUARDRAILS sections optimised for multi-turn agents |
| `preserveTerms`     | `string[]`                 | -          | Domain-specific terms appended to the built-in preserve list         |

### Built-in preserve list

The prompt always preserves: code references, file paths, function/variable names, URLs, API keys, error messages, numbers, and technical decisions. Add domain terms via `preserveTerms`.

### Example

```ts
import { createSummarizer, compress } from 'context-compression-engine';

const summarizer = createSummarizer(async (prompt) => myLlm.complete(prompt), {
  maxResponseTokens: 300,
  systemPrompt: 'This is a legal contract. Preserve all clause numbers.',
  preserveTerms: ['clause numbers', 'party names'],
});

const result = await compress(messages, { summarizer });
```

### Structured mode output

`mode: 'structured'` instructs the LLM to produce sections rather than prose. Sections are omitted when empty:

```
### REASONING
One or two sentences on key decisions and why they matter for future steps.

### VARS
| name | value | purpose |
|------|-------|---------|
| sessionId | abc123 | required for all subsequent API calls |

### GUARDRAILS
- Login with password alone returns 422; username is required.
```

Use this mode for long-running agentic sessions where the summarized message needs to survive multiple compression rounds — the VARS table preserves exact runtime values (tokens, IDs, counts) that plain prose summarization tends to drop.

---

## `createEscalatingSummarizer`

Three-level escalation summarizer. See [LLM integration](llm-integration.md) and [Compression pipeline](compression-pipeline.md) for how the fallback chain works.

### Signature

```ts
function createEscalatingSummarizer(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: Omit<CreateSummarizerOptions, 'mode'>,
): Summarizer;
```

### Escalation levels

1. **Level 1: Normal** - concise prose summary via the LLM
2. **Level 2: Aggressive** - terse bullet points at half the token budget (if Level 1 fails or returns longer text)
3. **Level 3: Deterministic** - sentence extraction fallback via the compression pipeline (handled by `withFallback` in `compress`)

### Options

Same as `CreateSummarizerOptions` but without `mode` (managed internally).

| Option              | Type       | Default | Description                                                  |
| ------------------- | ---------- | ------- | ------------------------------------------------------------ |
| `maxResponseTokens` | `number`   | `300`   | Hint for maximum tokens in the LLM response                  |
| `systemPrompt`      | `string`   | -       | Domain-specific instructions prepended to the built-in rules |
| `preserveTerms`     | `string[]` | -       | Domain-specific terms appended to the built-in preserve list |

---

## `createClassifier`

Creates an LLM-powered classifier that decides whether messages should be preserved or compressed. See [LLM integration](llm-integration.md) for domain examples.

### Signature

```ts
function createClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier;
```

### CreateClassifierOptions

| Option              | Type       | Default | Description                                                         |
| ------------------- | ---------- | ------- | ------------------------------------------------------------------- |
| `maxResponseTokens` | `number`   | `100`   | Hint for maximum tokens in the LLM response                         |
| `systemPrompt`      | `string`   | -       | Domain-specific instructions prepended to the classification prompt |
| `alwaysPreserve`    | `string[]` | -       | Content types to always preserve, injected as bullet points         |
| `alwaysCompress`    | `string[]` | -       | Content types always safe to compress, injected as bullet points    |

### Example

```ts
import { createClassifier, compress } from 'context-compression-engine';

const classifier = createClassifier(async (prompt) => myLlm.complete(prompt), {
  systemPrompt: 'You are classifying content from legal documents.',
  alwaysPreserve: ['clause references', 'defined terms', 'party names'],
  alwaysCompress: ['boilerplate acknowledgments', 'scheduling correspondence'],
});

const result = await compress(messages, { classifier });
```

---

## `createEscalatingClassifier`

Two-level escalation classifier. Tries LLM first, falls back to heuristic `classifyMessage()` on failure.

### Signature

```ts
function createEscalatingClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier;
```

### Escalation levels

1. **Level 1: LLM** - send content to LLM, parse structured JSON response
2. **Level 2: Heuristic** - if LLM throws, returns unparseable output, or confidence=0, fall back to `classifyMessage()`. Hard T0 heuristic results map to `preserve`, everything else to `compress`.

### Options

Same as `CreateClassifierOptions`.

---

## Types

### `Message`

```ts
type Message = {
  id: string;
  index: number;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tool_calls?: unknown[];
  [key: string]: unknown;
};
```

### `Summarizer`

```ts
type Summarizer = (text: string) => string | Promise<string>;
```

### `VerbatimMap`

```ts
type VerbatimMap = Record<string, Message>;
```

### `Classifier`

```ts
type Classifier = (content: string) => ClassifierResult | Promise<ClassifierResult>;
```

### `ClassifierResult`

```ts
type ClassifierResult = {
  decision: 'preserve' | 'compress';
  confidence: number;
  reason: string;
};
```

### `MLTokenClassifier`

```ts
type MLTokenClassifier = (
  content: string,
) => TokenClassification[] | Promise<TokenClassification[]>;
```

### `TokenClassification`

```ts
type TokenClassification = {
  token: string;
  keep: boolean;
  confidence: number;
};
```

### `StoreLookup`

```ts
type StoreLookup = VerbatimMap | ((id: string) => Message | undefined);
```

---

---

## Format adapters

See [Format adapters](format-adapters.md) for the full guide. Quick reference:

### `FormatAdapter` interface

```ts
interface FormatAdapter {
  name: string;
  detect(content: string): boolean;
  extractPreserved(content: string): string[];
  extractCompressible(content: string): string[];
  reconstruct(preserved: string[], summary: string): string;
}
```

Adapters are registered via `CompressOptions.adapters`. The first adapter whose `detect()` returns `true` handles the message. Adapters run after the built-in code-split pass, so content containing code fences is already handled before adapters are checked.

If the adapter's `reconstruct()` output is not shorter than the original, the message is preserved unchanged (adapter reverts automatically — no size regression possible).

### Built-in adapters

| Adapter | Export | Detects | Preserves | Compresses |
|---|---|---|---|---|
| `CodeAdapter` | `adapters.js` | `` ``` `` fences | Code fences verbatim | Surrounding prose |
| `StructuredOutputAdapter` | `adapters.js` | Test output, grep, status lines | Status lines, file paths | Bulk line content |
| `XmlAdapter` | `format-adapters.js` | XML documents | Tag skeleton + short values | Prose text nodes (6+ words, 100+ chars) |
| `YamlAdapter` | `format-adapters.js` | YAML configs | Keys with atomic values (≤60 chars, booleans, numbers) | Keys with long prose string values |
| `MarkdownAdapter` | `format-adapters.js` | Structured Markdown (2+ headings) | All headings + tables | Paragraph prose between structural elements |

### Example

```ts
import { compress, XmlAdapter, YamlAdapter, MarkdownAdapter } from 'context-compression-engine';

const result = compress(messages, {
  adapters: [XmlAdapter, YamlAdapter, MarkdownAdapter],
});
```

Custom adapter:

```ts
import type { FormatAdapter } from 'context-compression-engine';

const CsvAdapter: FormatAdapter = {
  name: 'csv',
  detect: (content) => content.includes(',') && content.split('\n').length > 5,
  extractPreserved: (content) => [content.split('\n')[0]], // header row
  extractCompressible: (content) => content.split('\n').slice(1),
  reconstruct: (preserved, summary) => `${preserved.join('\n')}\n[${summary}]`,
};

compress(messages, { adapters: [CsvAdapter] });
```

---

## See also

- [Format adapters](format-adapters.md) - adapter pattern, built-in adapters, writing custom adapters
- [V2 features](v2-features.md) - quality metrics, flow detection, clustering, depth, ML classifier
- [Compression pipeline](compression-pipeline.md) - how the engine processes messages
- [Token budget](token-budget.md) - budget-driven compression
- [LLM integration](llm-integration.md) - provider examples
- [Round-trip](round-trip.md) - lossless compress/uncompress
- [Provenance](provenance.md) - metadata tracking
