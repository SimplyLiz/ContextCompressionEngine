# Preservation Rules

[Back to README](../README.md) | [All docs](README.md)

What gets preserved, what gets compressed, and why.

## Rule priority

Messages are evaluated in this order. The **first matching rule** determines the outcome:

| Priority | Rule                                                        | Outcome                   |
| -------- | ----------------------------------------------------------- | ------------------------- |
| 1        | Role in `preserve` list                                     | Preserved                 |
| 2        | Within `recencyWindow`                                      | Preserved                 |
| 3        | Has `tool_calls` array                                      | Preserved                 |
| 4        | Content < 120 chars                                         | Preserved                 |
| 5        | Already compressed (`[summary:`, `[summary#`, `[truncated`) | Preserved                 |
| 6        | Duplicate (exact or fuzzy)                                  | Dedup path                |
| 7        | Code fences + prose >= 80 chars                             | Code-split path           |
| 8        | Code fences + prose < 80 chars                              | Preserved                 |
| 9        | Hard T0 classification (skipped in `full` mode)             | Preserved                 |
| 10       | Custom `preservePatterns` match                             | Preserved                 |
| 11       | LLM classifier (when `classifier` is provided)              | Preserved or fall through |
| 12       | Valid JSON                                                  | Preserved                 |
| 13       | Everything else                                             | Compressed                |

Soft T0 classifications (file paths, URLs, version numbers, etc.) do **not** prevent compression — entities capture the important references, and the prose is still compressible.

## Classification tiers

The classifier (`classifyMessage` in `src/classify.ts`) assigns one of three tiers:

### T0 — Structural / Preserve

Content with structural patterns that would be destroyed by summarization.

**Hard T0 reasons** (prevent compression):

| Reason                      | Detection                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `code_fence`                | Markdown code fences (` ``` `)                                                                                 |
| `indented_code`             | 4-space or tab-indented code blocks                                                                            |
| `json_structure`            | Starts with `{` or `[` followed by JSON-like content                                                           |
| `yaml_structure`            | Key-value pairs on consecutive lines                                                                           |
| `high_special_char_ratio`   | > 15% special characters (``{}[]<>\|\\;:@#$%^&*()=+`~``)                                                       |
| `high_line_length_variance` | Coefficient of variation > 1.2 with > 3 lines                                                                  |
| `api_key`                   | Known provider patterns (OpenAI, AWS, GitHub, Stripe, Slack, etc.) or generic high-entropy tokens              |
| `latex_math`                | `$$...$$` or `$...$` blocks                                                                                    |
| `unicode_math`              | Mathematical symbols                                                                                           |
| `sql_content`               | SQL keyword density (strong anchors like `GROUP BY`, `PRIMARY KEY` or 3+ distinct keywords with a weak anchor) |
| `verse_pattern`             | Poetry/verse pattern (consecutive capitalized lines without terminal punctuation)                              |
| `reasoning_chain`           | Reasoning chains: explicit labels (`Reasoning:`, `Proof:`), formal inference, or 3+ logical connectives        |

**Soft T0 reasons** (do not prevent compression):

| Reason               | Detection                                              |
| -------------------- | ------------------------------------------------------ |
| `url`                | HTTP/HTTPS URLs                                        |
| `email`              | Email addresses                                        |
| `phone`              | Phone numbers                                          |
| `version_number`     | Semantic versions, `v1.2.3`                            |
| `hash_or_sha`        | 40-64 character hex strings                            |
| `file_path`          | Unix-style paths                                       |
| `ip_or_semver`       | Dotted number sequences                                |
| `quoted_key`         | JSON-style quoted keys                                 |
| `legal_term`         | Legal language (`shall`, `notwithstanding`, `whereas`) |
| `direct_quote`       | Quoted strings > 10 chars                              |
| `numeric_with_units` | Numbers with SI units                                  |

Soft T0 content is still compressible because the entity extraction step captures these references in the summary suffix.

### T2 — Short prose

Prose under 20 words. Treated identically to T3 in the current deterministic pipeline — the distinction is preserved for future LLM classifier integration, which can apply lighter compression to short prose.

### T3 — Long prose

Prose of 20+ words. The primary target for summarization. Treated identically to T2 in the current pipeline; the LLM classifier will use the T2/T3 distinction for tier-specific strategies.

## API key detection

The classifier detects API keys from known providers:

- OpenAI / Anthropic: `sk-...`
- AWS access keys: `AKIA...`
- GitHub tokens: `ghp_...`, `gho_...`, `ghs_...`, `ghr_...`, `ght_...`, `github_pat_...`
- Stripe: `sk_live_...`, `sk_test_...`, `rk_live_...`, `rk_test_...`
- Slack: `xoxb-...`, `xoxp-...`
- SendGrid: `SG....`
- GitLab: `glpat-...`
- npm: `npm_...`
- Google: `AIza...`

A generic fallback catches high-entropy tokens with a prefix-separator-body pattern, with rejection for CSS/BEM-style hyphenated words.

## SQL detection

SQL detection uses a tiered anchor system to avoid false positives on English prose:

- **Strong anchors** (1 alone is enough): `GROUP BY`, `PRIMARY KEY`, `FOREIGN KEY`, `NOT NULL`, `VARCHAR`, `INNER JOIN`, `LEFT JOIN`, etc.
- **Weak anchors** (need 3+ total keywords): `WHERE`, `JOIN`, `HAVING`, `UNION`, `DISTINCT`, etc.
- Common words like `VIEW`, `SCHEMA`, `FETCH` are keywords but not anchors (too common in tech prose).

## Code-aware splitting

Messages with code fences and significant prose (>= 80 chars) are split:

1. Code fences are extracted verbatim
2. Surrounding prose is summarized (budget scales adaptively: 200–600 chars based on prose length)
3. Result: summary + preserved code fences

If the total prose is < 80 chars, the entire message is preserved (not enough prose to justify splitting).

## What gets preserved — quick reference

| Content Type    | Example                           | Preserved?              |
| --------------- | --------------------------------- | ----------------------- |
| Code fences     | ` ```ts const x = 1; ``` `        | Yes                     |
| SQL             | `SELECT * FROM users WHERE ...`   | Yes                     |
| JSON            | `{"key": "value"}`                | Yes                     |
| API keys        | `sk-proj-abc123...`               | Yes                     |
| URLs            | `https://docs.example.com/api`    | Yes (as entity)         |
| File paths      | `/etc/config.json`                | Yes (as entity)         |
| Short messages  | `< 120 chars`                     | Yes                     |
| Tool calls      | Messages with `tool_calls` array  | Yes                     |
| System messages | `role: 'system'` (default)        | Yes                     |
| Duplicates      | Repeated content (exact or fuzzy) | Replaced with reference |
| Long prose      | General discussion, explanations  | Compressed              |

## Customization

### `preserve` option

Add roles to never compress:

```ts
compress(messages, { preserve: ['system', 'tool'] });
```

### `recencyWindow` option

Protect more or fewer recent messages:

```ts
compress(messages, { recencyWindow: 10 }); // protect last 10
compress(messages, { recencyWindow: 0 }); // no recency protection
```

### `preservePatterns` option

Force preservation of messages matching domain-specific regex patterns. Each pattern is a hard T0 — the message is preserved verbatim, no summarization. Patterns are checked after the built-in heuristic classifier but before JSON detection.

```ts
compress(messages, {
  preservePatterns: [
    { re: /§\s*\d+/, label: 'section_ref' },
    { re: /\d+\s*mg\b/i, label: 'dosage' },
  ],
});
```

**Domain examples:**

**Legal** — preserve clause references, case citations, regulatory references:

```ts
preservePatterns: [
  { re: /§\s*\d+/, label: 'section_ref' },
  { re: /\b\d+\s+U\.S\.C\.\s*§/, label: 'usc_cite' },
  { re: /\bArticle\s+[IVX]+\b/, label: 'article_ref' },
  { re: /\bGDPR\s+Art\.\s*\d+/, label: 'gdpr_ref' },
];
```

**Medical** — preserve dosages, diagnostic codes, lab values:

```ts
preservePatterns: [
  { re: /\d+\s*mg\b/i, label: 'dosage' },
  { re: /\bICD-10:\s*[A-Z]\d+/i, label: 'icd_code' },
  { re: /\bCPT\s+\d{5}/, label: 'cpt_code' },
  { re: /\bBP\s+\d+\/\d+/, label: 'vital_sign' },
];
```

**Academic** — preserve DOIs, citation markers, theorem references:

```ts
preservePatterns: [
  { re: /\bdoi:\s*10\.\d{4,}/, label: 'doi' },
  { re: /\[(\d+(?:,\s*\d+)*)\]/, label: 'citation_marker' },
  { re: /\bTheorem\s+\d+/i, label: 'theorem_ref' },
];
```

The stat `compression.messages_pattern_preserved` reports how many messages were preserved by custom patterns.

### `classifier` option

LLM-powered classification for domain-specific content. When provided, `compress()` returns a `Promise`. The classifier runs once before the pipeline (pre-classification) so that `tokenBudget` binary search doesn't re-classify messages on each iteration.

The `classifierMode` option controls how the LLM classifier interacts with heuristics:

| Mode       | Behavior                                                               | When to use                                   |
| ---------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| `'hybrid'` | Heuristics first; LLM only for messages that aren't hard T0 (default)  | Best cost/accuracy tradeoff. Most use cases.  |
| `'full'`   | Heuristic classification skipped; LLM classifies all eligible messages | Domain content where heuristics add no value. |

In both modes, standard preservation rules (role, recency window, tool_calls, short content, already-compressed) still apply — the classifier only sees messages that pass those checks.

```ts
import { createClassifier, compress } from 'context-compression-engine';

const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from medical records.',
  alwaysPreserve: ['diagnoses', 'medication dosages', 'lab values'],
});

const result = await compress(messages, {
  classifier,
  classifierMode: 'hybrid',
});

console.log(result.compression.messages_llm_classified); // messages sent to LLM
console.log(result.compression.messages_llm_preserved); // messages LLM decided to preserve
```

---

## See also

- [Compression pipeline](compression-pipeline.md) - how classification feeds into the pipeline
- [Deduplication](deduplication.md) - the dedup path for duplicates
- [Provenance](provenance.md) - metadata on compressed messages
- [API reference](api-reference.md) - `preserve`, `recencyWindow` options
