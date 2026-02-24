# API Reference

Complete reference for all exports from `context-compression-engine`.

## Exports

```ts
// Primary
export { compress, defaultTokenCounter } from './compress.js';
export { uncompress } from './expand.js';
export type { StoreLookup } from './expand.js';

// Helpers (LLM integration)
export { createSummarizer, createEscalatingSummarizer } from './summarizer.js';

// Types
export type {
  CompressOptions,
  CompressResult,
  CreateSummarizerOptions,
  Message,
  Summarizer,
  UncompressOptions,
  UncompressResult,
  VerbatimMap,
} from './types.js';
```

---

## `compress`

Deterministic compression by default. Returns a `Promise` when a `summarizer` is provided.

### Signatures

```ts
function compress(messages: Message[], options?: CompressOptions): CompressResult;
function compress(
  messages: Message[],
  options: CompressOptions & { summarizer: Summarizer },
): Promise<CompressResult>;
```

### Parameters

| Parameter  | Type              | Description        |
| ---------- | ----------------- | ------------------ |
| `messages` | `Message[]`       | Messages to compress |
| `options`  | `CompressOptions` | Compression options (see below) |

### CompressOptions

| Option             | Type                       | Default               | Description                                                                                 |
| ------------------ | -------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `preserve`         | `string[]`                 | `['system']`          | Roles to never compress                                                                     |
| `recencyWindow`    | `number`                   | `4`                   | Protect the last N messages from compression                                                |
| `sourceVersion`    | `number`                   | `0`                   | Version tag for [provenance tracking](provenance.md)                                        |
| `summarizer`       | `Summarizer`               | -                     | LLM-powered summarizer. When provided, `compress()` returns a `Promise`. See [LLM integration](llm-integration.md) |
| `tokenBudget`      | `number`                   | -                     | Target token count. Binary-searches `recencyWindow` to fit. See [Token budget](token-budget.md) |
| `minRecencyWindow` | `number`                   | `0`                   | Floor for `recencyWindow` when using `tokenBudget`                                          |
| `dedup`            | `boolean`                  | `true`                | Replace earlier exact-duplicate messages with a compact reference. See [Deduplication](deduplication.md) |
| `fuzzyDedup`       | `boolean`                  | `false`               | Detect near-duplicate messages using line-level similarity. See [Deduplication](deduplication.md) |
| `fuzzyThreshold`   | `number`                   | `0.85`                | Similarity threshold for fuzzy dedup (0-1)                                                  |
| `embedSummaryId`   | `boolean`                  | `false`               | Embed `summary_id` in compressed content for downstream reference. See [Provenance](provenance.md) |
| `forceConverge`    | `boolean`                  | `false`               | Hard-truncate non-recency messages when binary search bottoms out. See [Token budget](token-budget.md) |
| `tokenCounter`     | `(msg: Message) => number` | `defaultTokenCounter` | Custom token counter per message. See [Token budget](token-budget.md)                       |

### CompressResult

| Field                                | Type                    | Description                                                              |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------ |
| `messages`                           | `Message[]`             | Compressed message array                                                 |
| `verbatim`                           | `VerbatimMap`           | Original messages keyed by ID. Must be persisted atomically with `messages` |
| `compression.original_version`       | `number`                | Mirrors `sourceVersion`                                                  |
| `compression.ratio`                  | `number`                | Character-based compression ratio. >1 means savings                      |
| `compression.token_ratio`            | `number`                | Token-based compression ratio. >1 means savings                          |
| `compression.messages_compressed`    | `number`                | Messages that were compressed                                            |
| `compression.messages_preserved`     | `number`                | Messages kept as-is                                                      |
| `compression.messages_deduped`       | `number \| undefined`   | Exact duplicates replaced (when `dedup: true`)                           |
| `compression.messages_fuzzy_deduped` | `number \| undefined`   | Near-duplicates replaced (when `fuzzyDedup: true`)                       |
| `fits`                               | `boolean \| undefined`  | Whether result fits within `tokenBudget`. Present when `tokenBudget` is set |
| `tokenCount`                         | `number \| undefined`   | Estimated token count. Present when `tokenBudget` is set                 |
| `recencyWindow`                      | `number \| undefined`   | The `recencyWindow` the binary search settled on. Present when `tokenBudget` is set |

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

| Parameter  | Type               | Description |
| ---------- | ------------------ | ----------- |
| `messages` | `Message[]`        | Compressed messages to expand |
| `store`    | `StoreLookup`      | `VerbatimMap` object or `(id: string) => Message \| undefined` function |
| `options`  | `UncompressOptions` | Expansion options (see below) |

### UncompressOptions

| Option      | Type      | Default | Description |
| ----------- | --------- | ------- | ----------- |
| `recursive` | `boolean` | `false` | Recursively expand messages whose originals are also compressed (up to 10 levels) |

### UncompressResult

| Field                 | Type       | Description |
| --------------------- | ---------- | ----------- |
| `messages`            | `Message[]` | Expanded messages |
| `messages_expanded`   | `number`   | How many compressed messages were restored |
| `messages_passthrough` | `number`  | How many messages passed through unchanged |
| `missing_ids`         | `string[]` | IDs looked up but not found. Non-empty = data loss |

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
Math.ceil(msg.content.length / 3.5)
```

Approximates ~3.5 characters per token. Suitable for rough estimates. For accurate budgeting, replace with a real tokenizer. See [Token budget](token-budget.md).

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
| `maxResponseTokens` | `number`                   | `300`      | Hint for maximum tokens in the LLM response                         |
| `systemPrompt`      | `string`                   | -          | Domain-specific instructions prepended to the built-in rules         |
| `mode`              | `'normal' \| 'aggressive'` | `'normal'` | `'aggressive'` produces terse bullet points at half the token budget |
| `preserveTerms`     | `string[]`                 | -          | Domain-specific terms appended to the built-in preserve list         |

### Built-in preserve list

The prompt always preserves: code references, file paths, function/variable names, URLs, API keys, error messages, numbers, and technical decisions. Add domain terms via `preserveTerms`.

### Example

```ts
import { createSummarizer, compress } from 'context-compression-engine';

const summarizer = createSummarizer(
  async (prompt) => myLlm.complete(prompt),
  {
    maxResponseTokens: 300,
    systemPrompt: 'This is a legal contract. Preserve all clause numbers.',
    preserveTerms: ['clause numbers', 'party names'],
  },
);

const result = await compress(messages, { summarizer });
```

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

### `StoreLookup`

```ts
type StoreLookup = VerbatimMap | ((id: string) => Message | undefined);
```

---

## See also

- [Compression pipeline](compression-pipeline.md) - how the engine processes messages
- [Token budget](token-budget.md) - budget-driven compression
- [LLM integration](llm-integration.md) - provider examples
- [Round-trip](round-trip.md) - lossless compress/uncompress
- [Provenance](provenance.md) - metadata tracking
