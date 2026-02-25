# Round-trip Compression

[Back to README](../README.md) | [All docs](README.md)

Lossless compress/uncompress with the verbatim store.

## The lossless guarantee

Every call to `compress()` returns a `verbatim` map containing the original messages that were compressed. Calling `uncompress()` with this map restores byte-identical originals.

```ts
import { compress, uncompress } from 'context-compression-engine';

const { messages: compressed, verbatim } = compress(messages);

const { messages: restored } = uncompress(compressed, verbatim);
// restored is byte-identical to messages (for all compressed entries)
```

This works because:

- Each compressed message's `metadata._cce_original.ids` lists the original message IDs
- Those IDs are keys into the `verbatim` map
- `uncompress` looks up each ID and replaces the summary with the original(s)

## VerbatimMap

```ts
type VerbatimMap = Record<string, Message>;
```

A plain object mapping message IDs to their original `Message` objects. This is the simplest store — just serialize it alongside your compressed messages.

```ts
// Persist together
await db.save({
  messages: result.messages,
  verbatim: result.verbatim,
});
```

## StoreLookup

```ts
type StoreLookup = VerbatimMap | ((id: string) => Message | undefined);
```

`uncompress` accepts either:

**Plain object** — the `VerbatimMap` from `compress()`:

```ts
const { messages } = uncompress(compressed, verbatim);
```

**Lookup function** — for database-backed stores:

```ts
const { messages } = uncompress(compressed, (id) => db.getMessageById(id));
```

The function form is useful when verbatim data is too large for memory or lives in an external store (Redis, PostgreSQL, etc.).

## Atomicity requirement

**This is critical.** `messages` and `verbatim` must be persisted together in a single transaction.

```ts
// CORRECT — atomic write
await db.transaction(async (tx) => {
  await tx.saveMessages(result.messages);
  await tx.saveVerbatim(result.verbatim);
});

// WRONG — non-atomic write
await db.saveMessages(result.messages); // succeeds
await db.saveVerbatim(result.verbatim); // crashes here = data loss
```

If compressed messages are written without their verbatim originals, the originals are **irrecoverably lost**. The summaries remain readable but the byte-identical originals cannot be restored.

### Detecting data loss

`uncompress()` reports missing originals via `missing_ids`:

```ts
const { messages, missing_ids } = uncompress(compressed, verbatim);

if (missing_ids.length > 0) {
  console.error('Data loss detected — missing verbatim entries:', missing_ids);
  // The compressed summaries are still in the output as fallback
}
```

When IDs are missing, `uncompress` keeps the compressed summary in the output (rather than dropping the message entirely). This degrades gracefully — you lose the original content but retain the summary.

## Recursive expansion

When messages are compressed multiple times (e.g., compress -> persist -> load -> compress again), the originals stored in verbatim may themselves be compressed messages. Enable recursive expansion to follow the chain:

```ts
const { messages } = uncompress(compressed, store, { recursive: true });
```

Recursive expansion:

1. Expands the first layer of compressed messages
2. Checks if any expanded messages are themselves compressed
3. Repeats until no more compressed messages are found or 10 levels deep (safety limit)
4. Accumulates `messages_expanded` and `missing_ids` across all levels

## Merging verbatim stores

When compressing incrementally (compress, add new messages, compress again), merge the verbatim maps:

```ts
const round1 = compress(messages);
// ... add new messages ...
const round2 = compress(updatedMessages);

// Merge verbatim stores
const mergedVerbatim = { ...round1.verbatim, ...round2.verbatim };

// Now uncompress with recursive: true to follow the chain
const { messages } = uncompress(round2.messages, mergedVerbatim, { recursive: true });
```

Keys are message IDs, so there are no conflicts — each original message has a unique ID.

## Integrity checking

After loading compressed data from storage, verify integrity:

```ts
const { messages, missing_ids } = uncompress(loaded.messages, loaded.verbatim);

if (missing_ids.length > 0) {
  // Log, alert, or attempt recovery
  console.error(`Integrity check failed: ${missing_ids.length} missing verbatim entries`);
}
```

This catches:

- Partial writes (non-atomic persistence)
- Corrupted stores (missing keys)
- Schema migration issues
- Manual deletion of verbatim entries

---

## See also

- [Provenance](provenance.md) - metadata structure on compressed messages
- [Compression pipeline](compression-pipeline.md) - how messages get compressed
- [API reference](api-reference.md) - `uncompress`, `VerbatimMap`, `StoreLookup`, `UncompressResult`
