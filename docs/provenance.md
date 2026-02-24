# Provenance

Metadata tracking for compressed messages.

## `_cce_original` metadata

Every compressed message carries provenance in its `metadata._cce_original` field:

```ts
{
  ids: string[];          // original message IDs this summary covers
  summary_id: string;     // deterministic hash-based ID for this summary
  parent_ids?: string[];  // summary_ids of prior compressions (provenance chain)
  version: number;        // sourceVersion at time of compression
}
```

## `ids`

Always an array, even for single messages. These are the keys into the `verbatim` map.

When multiple consecutive same-role messages are merged into one summary, `ids` contains all their IDs:

```ts
// Single message compressed
{ ids: ['msg_5'] }

// Three consecutive user messages merged
{ ids: ['msg_3', 'msg_4', 'msg_5'] }
```

## `summary_id`

A deterministic identifier for the summary, derived from the source message IDs.

### Format

```
cce_sum_{base36_hash}
```

Example: `cce_sum_1a2b3c`

### Generation

Uses djb2 hash over the sorted, null-separated IDs:

```ts
function makeSummaryId(ids: string[]): string {
  const key = ids.length === 1 ? ids[0] : ids.slice().sort().join('\0');
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return `cce_sum_${h.toString(36)}`;
}
```

**Deterministic:** Same input IDs always produce the same `summary_id`. No randomness.

**Not cryptographic:** djb2 is used to avoid a crypto dependency. Collisions are acceptable because the ID is advisory provenance, not a security primitive.

## `embedSummaryId`

When `embedSummaryId: true` is set in [CompressOptions](api-reference.md), the `summary_id` is embedded directly in the compressed content:

```
[summary#cce_sum_1a2b3c: This message discussed the authentication flow...]
```

Without `embedSummaryId` (default):
```
[summary: This message discussed the authentication flow...]
```

This is useful when downstream tools need to reference specific summaries by ID without parsing metadata.

## `parent_ids`

Present only when compressing already-compressed messages (re-compression). Forms a provenance chain.

```ts
// Round 1: compress messages 1-5
// msg_1 gets summary_id "cce_sum_abc"

// Round 2: compress again (msg_1's summary gets re-compressed)
// New summary's parent_ids: ["cce_sum_abc"]
```

`collectParentIds` scans source messages for existing `_cce_original.summary_id` values:

```ts
function collectParentIds(msgs: Message[]): string[] {
  const parents: string[] = [];
  for (const m of msgs) {
    const orig = m.metadata?._cce_original;
    if (orig?.summary_id && typeof orig.summary_id === 'string') {
      parents.push(orig.summary_id);
    }
  }
  return parents;
}
```

Only present when there are parents (empty array is omitted).

## `version`

Mirrors `CompressOptions.sourceVersion`. Defaults to `0`.

Use this to track which version of your context was compressed. Useful for:
- Knowing when a summary was created
- Debugging stale summaries
- Versioned compression strategies

```ts
const result = compress(messages, { sourceVersion: 42 });
// All compressed messages have metadata._cce_original.version === 42
```

## Dedup provenance

Dedup-replaced messages also get `_cce_original` metadata:

```ts
// Exact duplicate
{
  content: '[cce:dup of msg_10 — 1234 chars]',
  metadata: {
    _cce_original: {
      ids: ['msg_3'],              // the message that was replaced
      summary_id: 'cce_sum_xyz',
      version: 0,
    }
  }
}

// Fuzzy duplicate
{
  content: '[cce:near-dup of msg_10 — 1234 chars, ~92% match]',
  metadata: {
    _cce_original: {
      ids: ['msg_3'],
      summary_id: 'cce_sum_xyz',
      version: 0,
    }
  }
}
```

The `ids` point to the replaced message (not the keep target). `uncompress()` uses these IDs to restore the original content.

## Force-converge provenance

When `forceConverge` truncates a message, it adds provenance if the message wasn't already compressed:

```ts
{
  content: '[truncated — 5000 chars: first 512 chars here...]',
  metadata: {
    _cce_original: {
      ids: ['msg_7'],
      summary_id: 'cce_sum_abc',
      version: 0,
    }
  }
}
```

If the message was already compressed (has `_cce_original`), only the content is replaced — the existing provenance is preserved.

---

## See also

- [Round-trip](round-trip.md) - how provenance enables lossless expansion
- [Compression pipeline](compression-pipeline.md) - where provenance is attached
- [Deduplication](deduplication.md) - dedup reference format
- [API reference](api-reference.md) - `embedSummaryId`, `sourceVersion` options
