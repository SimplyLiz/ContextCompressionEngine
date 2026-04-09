# Format adapters

[Back to README](../README.md) | [All docs](README.md)

Format adapters teach the compression engine how to handle structured data formats found in LLM conversations: XML configs, YAML manifests, Markdown documentation, CSV output, and anything else with predictable structure.

Without an adapter, the engine treats all content as prose and applies sentence-level scoring. Adapters let you split content into parts that must survive verbatim (structure) and parts that can be compressed (prose), then reassemble them after summarization.

---

## How it works

Adapters hook into the classification phase. For each message, the engine checks `detect()` on each registered adapter in order. The first match wins.

```
message content
    │
    ├─ built-in code-split (``` fences) ← runs first, before adapters
    │
    └─ adapters[0].detect() → false
       adapters[1].detect() → true
           │
           ├─ extractPreserved()  → kept verbatim
           ├─ extractCompressible() → sent to summarizer/sentence scorer
           │       │
           │       └─ summary string
           │
           └─ reconstruct(preserved, summary) → compressed message
```

If `reconstruct()` output is ≥ the original length, the message is kept unchanged. You can never make output larger by registering an adapter.

---

## Registering adapters

Pass adapters via `CompressOptions.adapters`. Order matters — first match wins.

```ts
import { compress, XmlAdapter, YamlAdapter, MarkdownAdapter } from 'context-compression-engine';

const result = compress(messages, {
  adapters: [XmlAdapter, YamlAdapter, MarkdownAdapter],
  recencyWindow: 4,
});
```

Adapters compose cleanly with all other options (`summarizer`, `tokenBudget`, `trace`, etc.).

---

## Built-in adapters

### `CodeAdapter`

Handles messages containing code fences interleaved with prose.

```ts
import { CodeAdapter } from 'context-compression-engine';
```

| Method | Behavior |
|---|---|
| `detect` | `content.includes('```')` |
| `extractPreserved` | All ` ``` ` fenced blocks verbatim |
| `extractCompressible` | Prose segments between fences |
| `reconstruct` | `summary + '\n\n' + fences.join('\n\n')` |

**Note:** The built-in code-split pass in the engine runs *before* adapters are checked. Content with code fences is already handled at the classification stage — `CodeAdapter` is provided as an opt-in for cases where you need the same behavior via the adapter API (e.g., custom pipeline ordering).

---

### `StructuredOutputAdapter`

Handles test results, grep output, and status-line-heavy tool messages.

```ts
import { StructuredOutputAdapter } from 'context-compression-engine';
```

| Method | Behavior |
|---|---|
| `detect` | ≥6 non-empty lines, >1 line per 80 chars, >50% structural lines (status keywords, file:line: patterns, indented bullets) |
| `extractPreserved` | Status lines (PASS/FAIL/ERROR/Tests/Duration), file paths from `file.ext:N:` patterns |
| `extractCompressible` | All other lines |
| `reconstruct` | `preserved.join(' | ') + ' | ' + summary` |

---

### `XmlAdapter`

Handles XML documents: Maven POMs, Kubernetes manifests, Spring configs, WSDL, SVG, Atom/RSS feeds, JUnit reports.

```ts
import { XmlAdapter } from 'context-compression-engine';
```

| Method | Behavior |
|---|---|
| `detect` | Starts with `<?xml` or `<letter`, AND has at least one closing tag |
| `extractPreserved` | Structural skeleton: all tags with attributes, text nodes ≤5 words or <100 chars kept inline; longer text nodes collapsed to `[…]` |
| `extractCompressible` | Text nodes with ≥6 words AND ≥100 chars; XML comments with ≥6 words AND ≥100 chars |
| `reconstruct` | Skeleton + `<!-- summary -->` appended when summary is non-empty |

**What gets preserved:** tag names, attributes, version strings, IDs, short values (`<version>2.1.0</version>`, `<port>8080</port>`).

**What gets compressed:** verbose descriptions (`<description>This lengthy text...</description>`), long XML comments.

```xml
<!-- Input -->
<project>
  <artifactId>myapp</artifactId>
  <description>This is a lengthy explanation of what the project does and how it integrates with other systems in the organization.</description>
</project>

<!-- After XmlAdapter -->
<project>
  <artifactId>myapp</artifactId>
  <description>[…]</description>
</project>
<!-- project that integrates with org systems -->
```

---

### `YamlAdapter`

Handles YAML configuration files: Kubernetes manifests, Docker Compose, GitHub Actions, Helm charts, CI/CD configs.

```ts
import { YamlAdapter } from 'context-compression-engine';
```

| Method | Behavior |
|---|---|
| `detect` | ≥4 non-empty non-comment lines, >35% are `key: value` lines |
| `extractPreserved` | Lines where value is atomic: empty (nested), `\|`/`>` block indicators, booleans, null, numbers, or strings ≤60 chars; list items and structural lines always preserved |
| `extractCompressible` | `key: value` lines where value is a string >60 chars |
| `reconstruct` | Preserved lines joined with `\n`, summary appended as `# summary` comment |

**What gets preserved:** `apiVersion`, `kind`, `name`, `image`, `replicas`, `port`, boolean flags, version strings.

**What gets compressed:** long description fields, verbose annotations, multi-sentence string values.

```yaml
# Input
name: myservice
image: nginx:1.25
replicas: 3
description: This service handles all incoming requests and routes them to appropriate backends based on load balancing logic and health check status.

# After YamlAdapter
name: myservice
image: nginx:1.25
replicas: 3
# routes requests to backends via load balancing and health checks
```

---

### `MarkdownAdapter`

Handles structured Markdown documents: READMEs, changelogs, API docs, specs, runbooks, blog posts.

```ts
import { MarkdownAdapter } from 'context-compression-engine';
```

| Method | Behavior |
|---|---|
| `detect` | ≥2 heading lines (`#`–`######`) AND content ≥200 chars |
| `extractPreserved` | All heading lines; table blocks (pipes and separator rows) in document order |
| `extractCompressible` | Paragraph text after stripping headings, tables, and horizontal rules; split on double newlines |
| `reconstruct` | Preserved elements joined with `\n\n`, summary appended |

**What gets preserved:** `## Installation`, `## API Reference`, `| Column | Type |` tables — the navigational skeleton.

**What gets compressed:** paragraph prose between headings.

```markdown
# API Reference           ← preserved
## Authentication         ← preserved
All requests require...   ← compressed
(three more paragraphs)
## Endpoints              ← preserved
| Method | Path | ... |   ← preserved
```

**Interaction with `CodeAdapter`:** content with code fences is intercepted by the built-in code-split pass before adapters run. `MarkdownAdapter` focuses on prose-heavy Markdown without code blocks. If you want unified handling for Markdown that may or may not contain code, register `CodeAdapter` first:

```ts
compress(messages, { adapters: [CodeAdapter, MarkdownAdapter] });
```

---

## Writing a custom adapter

Implement the `FormatAdapter` interface:

```ts
import type { FormatAdapter } from 'context-compression-engine';

export const CsvAdapter: FormatAdapter = {
  name: 'csv',

  detect(content: string): boolean {
    const lines = content.split('\n').filter((l) => l.trim());
    return lines.length >= 3 && lines[0].includes(',') && lines[1].includes(',');
  },

  extractPreserved(content: string): string[] {
    // Always keep the header row
    return [content.split('\n')[0]];
  },

  extractCompressible(content: string): string[] {
    // Data rows are compressible
    return content.split('\n').slice(1).filter((l) => l.trim());
  },

  reconstruct(preserved: string[], summary: string): string {
    return `${preserved.join('\n')}\n[${summary}]`;
  },
};
```

**Rules:**
- `name` must be unique — it appears in `trace` decisions as `adapter:name` or `adapter_reverted:name`.
- `detect()` is called on every eligible message — keep it fast.
- `reconstruct()` must return something shorter than the original for compression to apply. If it doesn't, the engine reverts automatically.
- `extractCompressible()` returns text that will be summarized. Return an empty array to skip summarization entirely.

---

## Tracing adapter decisions

Use `trace: true` to see which adapter matched each message:

```ts
const result = compress(messages, {
  adapters: [XmlAdapter, YamlAdapter],
  trace: true,
});

for (const d of result.compression.decisions ?? []) {
  console.log(d.messageId, d.action, d.reason);
  // "msg-3" "compressed" "adapter:yaml"
  // "msg-7" "preserved"  "adapter_reverted:xml"  ← compressed >= original, reverted
}
```

---

## See also

- [API reference](api-reference.md) — `FormatAdapter` type, `CompressOptions.adapters`
- [Compression pipeline](compression-pipeline.md) — where adapters fit in the full pipeline
