# LLM Classifier — Design Document

## Problem statement

The heuristic classifier (`src/classify.ts`) is excellent at detecting **structural** content — code fences, JSON, SQL, API keys, LaTeX, etc. These are pattern-matching tasks where regex is the right tool.

But the engine is used beyond code-heavy contexts: legal briefs, academic papers, novels, medical records, support logs, financial reports. For these domains, the heuristic classifier has two blind spots:

1. **Semantic importance in pure prose** — "we chose PostgreSQL over MongoDB because of ACID compliance" has no structural markers but contains a critical architectural decision. The heuristic classifies it as T2 or T3 based on word count alone (`inferProseTier` is literally `words < 20 ? T2 : T3`).

2. **Domain-specific preservation** — a legal "material adverse change clause" or a medical "contraindication" has zero structural markers. Regex can't know what matters in a domain it wasn't designed for.

An LLM classifier can understand **meaning**, not just **shape**.

---

## Three classification modes

| Mode       | Behavior                                                                | When to use                                            |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| **off**    | Current heuristic classifier only. Zero cost, deterministic, sync.      | Code-heavy contexts, cost-sensitive, offline use       |
| **hybrid** | Heuristics first; LLM only for low-confidence cases (the prose bucket). | Best cost/accuracy tradeoff. Most use cases.           |
| **full**   | Every message classified by the LLM. Heuristics skipped entirely.       | Domain-specific content where heuristics add no value. |

### Mode semantics

- **off** — The default. Existing behavior. No API change needed. The current `classifyMessage()` and `classifyAll()` remain untouched and continue to serve all sync paths.

- **hybrid** — Heuristics run first. If the result is high-confidence T0 (hard structural reason), the LLM is skipped. If the result falls into the prose bucket (T2/T3, confidence 0.65), the LLM classifier is invoked to make the preserve/compress decision. This minimizes LLM calls — only prose messages that the heuristics can't confidently classify get routed to the LLM.

- **full** — The heuristic classifier is bypassed entirely. Every message (subject to the standard preservation rules: role, recency window, tool_calls, content length, already-compressed) is sent to the LLM classifier. For domain-specific content like legal contracts or medical records, the heuristic patterns (code fences, SQL, API keys) are irrelevant noise.

---

## Where classification happens in the pipeline

```
messages
  |
  v
preservation rules (role, recencyWindow, tool_calls, <120 chars, already-compressed)
  |
  v
dedup annotations
  |
  v
code-split check (code fences + prose >= 80 chars)
  |
  v
 ┌────────────────────────────────────────────────────┐
 │ CLASSIFICATION (this is the injection point)       │
 │                                                    │
 │  off:    classifyMessage() → hard T0 → preserve    │
 │          else → compress                           │
 │                                                    │
 │  hybrid: classifyMessage() → hard T0 → preserve    │
 │          if low-confidence → llmClassify() →       │
 │            preserve or compress                    │
 │                                                    │
 │  full:   llmClassify() → preserve or compress      │
 └────────────────────────────────────────────────────┘
  |
  v
JSON check → preserve
  |
  v
compress (summarize, merge, size guard)
```

The classification decision happens inside `classifyAll()` in `compress.ts` (lines 523-582). This is the only function that needs to change. The heuristic `classifyMessage()` in `classify.ts` stays untouched.

---

## API design

### The `Classifier` type

Mirrors the `Summarizer` pattern:

```ts
type ClassifyResult = {
  decision: 'preserve' | 'compress';
  confidence: number;
  reason: string;
};

type Classifier = (content: string) => ClassifyResult | Promise<ClassifyResult>;
```

The LLM returns structured output: a decision (preserve or compress), a confidence score, and a reason explaining why. The reason is advisory (for debugging/logging), not consumed by the pipeline.

Note: The existing `ClassifyResult` type in `classify.ts` uses `T0 | T2 | T3` internally. The LLM classifier uses `preserve | compress` because the tier distinction (T0/T2/T3) is a heuristic implementation detail. From the LLM's perspective, the question is binary: "should this content be preserved verbatim, or is it safe to compress?"

### `CompressOptions` addition

```ts
type CompressOptions = {
  // ... existing options ...

  /** LLM-powered classifier. Determines which messages to preserve vs. compress.
   *  When provided, compress() returns a Promise.
   *  Default behavior: heuristic classification only (classifier off). */
  classifier?: Classifier;

  /** Classification mode. Controls how the LLM classifier interacts with heuristics.
   *  - 'hybrid': Heuristics first, LLM for low-confidence cases (default when classifier is set)
   *  - 'full': LLM classifies every message, heuristics skipped
   *  Ignored when classifier is not set. */
  classifierMode?: 'hybrid' | 'full';

  /** Custom patterns to force T0 (preserve) classification.
   *  Injected at runtime alongside the built-in FORCE_T0_PATTERNS.
   *  Allows domain-specific preservation without an LLM. */
  preservePatterns?: Array<{ re: RegExp; label: string }>;
};
```

Design decisions:

- **No `classifierMode: 'off'`** — omitting the `classifier` option is "off". No redundant state.
- **Default when classifier is set** — `'hybrid'`. Most cost-effective, and mirrors how the summarizer defaults to the safe path.
- **Triggers async** — like `summarizer`, providing a `classifier` makes `compress()` return a `Promise`.

### `createClassifier` factory

```ts
type CreateClassifierOptions = {
  /** Domain-specific instructions for the LLM. This is critical for non-code use cases. */
  systemPrompt?: string;

  /** Content types to always preserve, regardless of LLM decision.
   *  Examples: 'clause references', 'patient identifiers', 'theorem statements' */
  alwaysPreserve?: string[];

  /** Content types that are always safe to compress.
   *  Examples: 'pleasantries', 'meta-commentary', 'acknowledgments' */
  alwaysCompress?: string[];

  /** Maximum tokens for the LLM response. Default: 100 (classification is terse). */
  maxResponseTokens?: number;
};

function createClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier;
```

Design decisions:

- **`systemPrompt` is the primary customization point.** This is where domain knowledge lives. A legal prompt looks completely different from a medical one. This is the "custom prompt" we discussed.
- **`alwaysPreserve` and `alwaysCompress`** — structured lists that get injected into the prompt. More machine-friendly than asking users to encode everything in prose.
- **No `mode` option** — unlike the summarizer, the classifier doesn't have normal/aggressive. The decision is binary.
- **Low `maxResponseTokens`** — classification responses are short (a decision + one sentence reason). No need for 300 tokens.

### `createEscalatingClassifier` factory

Mirrors `createEscalatingSummarizer`:

```ts
function createEscalatingClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier;
```

Escalation levels:

1. **LLM classification** — send content to LLM, parse structured response
2. **Deterministic fallback** — if LLM throws, returns unparseable output, or times out, fall back to heuristic `classifyMessage()`

This ensures the classifier never blocks the pipeline. LLM failures gracefully degrade to heuristic behavior.

---

## The classifier prompt

The prompt needs to be structured enough to get reliable output, but flexible enough for domain customization.

### Base prompt template

```
{systemPrompt}

Classify the following message for a context compression engine.

Your task: Decide whether this message should be PRESERVED verbatim or can be safely COMPRESSED (summarized).

Preserve content that:
- Contains critical decisions, conclusions, or commitments
- Would lose meaning if paraphrased
- Contains domain-specific terms, definitions, or references that must stay exact
{alwaysPreserve as bullet points}

Compress content that:
- Is general discussion, explanation, or elaboration
- Can be summarized without losing actionable information
- Contains filler, pleasantries, or redundant restatements
{alwaysCompress as bullet points}

Respond with EXACTLY this JSON format, nothing else:
{"decision": "preserve" | "compress", "confidence": 0.0-1.0, "reason": "one sentence"}

Message:
{content}
```

### Why structured JSON output

- **Parseable** — regex/JSON.parse, no ambiguity
- **Machine-friendly** — the confidence score feeds back into the pipeline for potential future use (logging, metrics, debugging)
- **Small** — a single JSON line is ~50-80 tokens in the response, keeping costs down

### Domain-specific prompt examples

**Legal:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt:
    'You are classifying content from legal documents (contracts, briefs, court filings).',
  alwaysPreserve: [
    'clause references and numbers (e.g., Section 4.2, Article III)',
    'defined terms (capitalized terms with specific legal meaning)',
    'party names and roles',
    'dates, deadlines, and time periods',
    'monetary amounts and payment terms',
    'obligations (shall, must, agrees to)',
    'conditions and contingencies',
    'governing law and jurisdiction references',
  ],
  alwaysCompress: [
    'recitals and background context already summarized',
    'boilerplate acknowledgments',
    'procedural correspondence (scheduling, confirmations)',
  ],
});
```

**Medical / Clinical:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from medical records and clinical notes.',
  alwaysPreserve: [
    'diagnoses and ICD codes',
    'medication names, dosages, and frequencies',
    'lab values and vital signs with numbers',
    'allergies and contraindications',
    'procedure descriptions and outcomes',
    'patient identifiers and dates of service',
  ],
  alwaysCompress: [
    'general health education text',
    'administrative notes about scheduling',
    'repeated disclaimer language',
  ],
});
```

**Academic / Research:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from academic papers and research documents.',
  alwaysPreserve: [
    'citations and references (author names, years, DOIs)',
    'statistical results (p-values, confidence intervals, effect sizes)',
    'methodology descriptions',
    'theorem statements and proofs',
    'figure and table references',
    'dataset descriptions and sample sizes',
  ],
  alwaysCompress: [
    'literature review summaries of well-known background',
    'verbose transitions between sections',
    'acknowledgments and funding boilerplate',
  ],
});
```

**Novel / Creative writing:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from fiction and creative writing.',
  alwaysPreserve: [
    'dialogue (direct speech)',
    'character names and descriptions on first appearance',
    'plot-critical events and reveals',
    'setting descriptions that establish atmosphere',
    'foreshadowing and symbolic elements',
  ],
  alwaysCompress: [
    'transitional passages between scenes',
    'repetitive internal monologue',
    'extended descriptions of routine actions',
  ],
});
```

---

## Integration with `compress.ts`

### Current flow (simplified)

```ts
// classifyAll() — lines 523-582 in compress.ts
function classifyAll(messages, preserveRoles, recencyWindow, dedupAnnotations) {
  return messages.map((msg, idx) => {
    // ... preservation rules (role, recency, tool_calls, <120 chars, already-compressed) ...
    // ... dedup check ...
    // ... code-split check ...

    // THE CLASSIFICATION POINT (lines 566-575)
    if (content) {
      const cls = classifyMessage(content);
      if (cls.decision === 'T0') {
        const hasHardReason = cls.reasons.some((r) => HARD_T0_REASONS.has(r));
        if (hasHardReason) return { msg, preserved: true };
      }
    }

    // ... JSON check ...
    return { msg, preserved: false };
  });
}
```

### New flow

`classifyAll` becomes async-capable when a classifier is provided. The function signature changes:

```ts
// Overloaded: sync when no classifier, async when classifier provided
function classifyAll(
  messages: Message[],
  preserveRoles: Set<string>,
  recencyWindow: number,
  dedupAnnotations?: Map<number, DedupAnnotation>,
  classifier?: Classifier,
  classifierMode?: 'hybrid' | 'full',
): Classified[] | Promise<Classified[]>;
```

The internal logic for the classification point:

```ts
// MODE: off (no classifier provided)
// Unchanged from current behavior
if (content) {
  const cls = classifyMessage(content);
  if (cls.decision === 'T0' && cls.reasons.some((r) => HARD_T0_REASONS.has(r))) {
    return { msg, preserved: true };
  }
}

// MODE: hybrid (classifier provided, mode = 'hybrid')
if (content) {
  const cls = classifyMessage(content);
  if (cls.decision === 'T0' && cls.reasons.some((r) => HARD_T0_REASONS.has(r))) {
    return { msg, preserved: true }; // high-confidence structural — skip LLM
  }
  // Low-confidence prose — ask the LLM
  const llmResult = await classifier(content);
  if (llmResult.decision === 'preserve') {
    return { msg, preserved: true };
  }
}

// MODE: full (classifier provided, mode = 'full')
if (content) {
  const llmResult = await classifier(content);
  if (llmResult.decision === 'preserve') {
    return { msg, preserved: true };
  }
}
```

### Sync/async routing in `compress()`

The existing routing logic already handles this pattern:

```ts
export function compress(messages, options) {
  const hasSummarizer = !!options.summarizer;
  const hasClassifier = !!options.classifier;
  const isAsync = hasSummarizer || hasClassifier;

  if (isAsync) {
    // async paths
    if (hasBudget) return compressAsyncWithBudget(messages, options);
    return compressAsync(messages, options);
  }

  // sync paths (unchanged)
  if (hasBudget) return compressSyncWithBudget(messages, options);
  return compressSync(messages, options);
}
```

The function overload signatures need one addition:

```ts
// Existing
function compress(messages: Message[], options?: CompressOptions): CompressResult;
function compress(
  messages: Message[],
  options: CompressOptions & { summarizer: Summarizer },
): Promise<CompressResult>;
// New
function compress(
  messages: Message[],
  options: CompressOptions & { classifier: Classifier },
): Promise<CompressResult>;
```

---

## File structure

### Decision: flat layout, single new file

The source stays flat. No subdirectories. The classifier follows the same pattern as
the summarizer — a single file containing factory functions, prompt builder, and
response parser.

**Why not a subdirectory?** Every other concern in this library (summarizer, dedup,
expand, classify) is a single file. A `classifier/` directory with 3-4 small files
would be inconsistent. The classifier is ~130-150 lines — proportional to
`summarizer.ts` (87 lines).

**Why not extract the analyzer?** `classifyAll()` in `compress.ts` produces
`Classified[]`, an internal type consumed only by `compressSync`/`compressAsync` in
the same file. Extracting it would split tightly coupled code for organizational
purity without a real benefit. The mode routing adds ~20 lines to an existing 60-line
function.

**Naming:** `classify.ts` = heuristic pattern detection, `classifier.ts` = LLM
classification factory. The orchestration (`classifyAll`) stays in `compress.ts`.

```
src/
  classify.ts       ← UNTOUCHED. Heuristic pattern detection (regex, structural).
  classifier.ts     ← NEW. LLM classifier factory (~130-150 lines).
                       - createClassifier(callLlm, options?)
                       - createEscalatingClassifier(callLlm, options?)
                       - buildClassifierPrompt(content, options) [internal]
                       - parseClassifierResponse(response)       [internal]
  compress.ts       ← MODIFIED. classifyAll gains classifier/mode params,
                       compress() async routing adds classifier check.
  dedup.ts          ← UNTOUCHED.
  expand.ts         ← UNTOUCHED.
  index.ts          ← MODIFIED. New exports.
  summarizer.ts     ← UNTOUCHED.
  types.ts          ← MODIFIED. Classifier, CreateClassifierOptions, CompressOptions.

tests/
  classifier.test.ts ← NEW.
  classify.test.ts   ← UNTOUCHED.
  compress.test.ts   ← MODIFIED. Integration tests for hybrid/full modes.
  dedup.test.ts      ← UNTOUCHED.
  expand.test.ts     ← UNTOUCHED.
  summarizer.test.ts ← UNTOUCHED.
```

### `classifier.test.ts` coverage

- `createClassifier` factory (prompt generation, response parsing)
- `createEscalatingClassifier` fallback behavior (LLM fail → heuristic)
- `parseClassifierResponse` robustness (clean JSON, JSON with preamble,
  markdown code blocks, garbage → null)
- Prompt customization (systemPrompt, alwaysPreserve, alwaysCompress)
- Integration with `compress()` in hybrid and full modes
- Edge cases (empty content, LLM returns empty string, unparseable response)

---

## `CompressResult` additions

```ts
type CompressResult = {
  // ... existing fields ...
  compression: {
    // ... existing fields ...
    /** Messages classified by LLM (when classifier is provided). */
    messages_llm_classified?: number;
    /** Messages where LLM overrode the heuristic (hybrid mode). */
    messages_llm_preserved?: number;
  };
};
```

These stats let users understand how much the LLM classifier contributed.

---

## Response parsing

The LLM response parser needs to handle:

1. **Clean JSON** — `{"decision": "preserve", "confidence": 0.9, "reason": "contains legal clause reference"}`
2. **JSON with surrounding text** — `Here is my analysis:\n{"decision": "compress", ...}`
3. **Markdown code blocks** — `json\n{"decision": "compress", ...}\n`
4. **Malformed JSON** — fall back to heuristic

```ts
function parseClassifierResponse(response: string): ClassifyResult | null {
  // Try direct JSON.parse
  // Try extracting JSON from response (first { to last })
  // Try extracting from code block
  // Return null if unparseable → triggers fallback
}
```

---

## Cost analysis

### Hybrid mode

Assume a 100-message conversation:

- ~20 preserved by hard rules (system, recency, tool_calls, short)
- ~30 preserved by hard T0 (code, JSON, SQL, API keys)
- ~50 fall into the prose bucket → sent to LLM classifier
- At ~200 tokens per classification call (prompt + response): **~10K tokens total**
- With Haiku: ~$0.001 for the entire conversation

### Full mode

- Same 100 messages, 80 eligible after hard rules
- 80 LLM calls: **~16K tokens total**
- With Haiku: ~$0.002

For comparison, a single LLM summarization call typically costs more than all classification calls combined. Classification is cheap because the responses are tiny.

---

## Documentation plan

### New documentation

| Document                        | Audience  | Content                                                                                      |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `docs/llm-classifier.md`        | Users     | How to use the classifier: modes, prompt customization, domain examples, cost considerations |
| `docs/domain-prompts.md`        | Users     | Curated prompt examples for common domains (legal, medical, academic, creative, financial)   |
| `docs/design/llm-classifier.md` | Engineers | This document. Architecture, rationale, integration points                                   |

### Updated documentation

| Document                       | Changes                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/api-reference.md`        | Add `Classifier` type, `CreateClassifierOptions`, `classifier`/`classifierMode` in `CompressOptions`, `createClassifier`/`createEscalatingClassifier` exports, new `CompressResult` stats |
| `docs/llm-integration.md`      | Add classifier section alongside summarizer, link to `llm-classifier.md`                                                                                                                  |
| `docs/compression-pipeline.md` | Update pipeline diagram to show classification injection point with modes                                                                                                                 |
| `docs/preservation-rules.md`   | Add section on LLM-driven classification and how it overrides/supplements heuristics                                                                                                      |
| `README.md`                    | Add classifier to features list, add to API overview, add to docs table                                                                                                                   |

---

## Why we don't expand the heuristic classifier with domain patterns

The heuristic classifier (`classify.ts`) is tuned for code and technical content. When
used on legal documents, medical records, or academic papers, it's essentially blind —
everything without structural markers (code fences, JSON, SQL, API keys) falls into the
prose bucket and gets compressed.

We considered three approaches and rejected two:

### Rejected: expand `classify.ts` with domain-specific patterns

Adding regex for legal clause references (`§ 4.2`, `Article III`), ICD codes (`J18.9`),
DOIs (`doi:10.1000/...`), statistical notation (`p < 0.05`, `χ² = 12.3`), etc.

Problems:

- **File bloat.** The patterns accumulate. Every domain adds 10-20 regex patterns, most
  irrelevant to most users. `classify.ts` grows from a focused structural detector into
  an unfocused grab-bag of domain trivia.
- **Cross-domain conflicts.** "Section" in a legal document is a clause reference. In a
  technical doc it's just a word. "Compound" in a medical record is a medication detail.
  In chemistry it's a structural formula. In software it's a design pattern. The same
  token triggers different preservation decisions depending on domain, and regex can't
  resolve that ambiguity — it has no context.
- **Maintenance burden.** Every pattern needs tests. False positives in one domain break
  another. The classifier becomes fragile because it tries to serve everyone.
- **Diminishing returns.** The easy patterns (section numbers, ICD codes) are finite.
  The hard cases (is this paragraph a material obligation or boilerplate?) are semantic
  and regex will never solve them. Investing in heuristics hits a ceiling quickly.

### Rejected: multiple domain-specific classifiers

Ship `classifyLegal()`, `classifyMedical()`, `classifyAcademic()`, etc. User picks one.

Problems:

- **N classifiers = N test suites.** Each domain classifier needs comprehensive tests
  with real-world examples. We'd need legal expertise to write legal classification tests,
  medical expertise for medical tests, etc.
- **Combinatorial explosion.** What about a medical-legal document? A technical paper with
  code samples? The domains aren't mutually exclusive, and composing classifiers is a
  hard problem.
- **Every new domain is a feature request.** Users in finance, architecture, journalism,
  or government would need us to build their classifier. The library becomes a bottleneck
  for domain support.
- **Ships dead code.** A user compressing legal documents ships medical, academic, and
  creative writing patterns they never use. Contradicts the zero-bloat philosophy.

### Chosen: LLM classifier + `preservePatterns` escape hatch

The domain-specific classification problem is fundamentally semantic. "Is this paragraph
a material obligation or boilerplate?" is a question about meaning, not pattern. That's
exactly what the LLM classifier solves — the user provides domain context via
`systemPrompt`, `alwaysPreserve`, and `alwaysCompress`, and the LLM understands the
domain.

But not every user wants or can use an LLM. Offline environments, cost-sensitive
pipelines, and air-gapped systems need a deterministic path. For these cases,
`preservePatterns` is a minimal escape hatch:

```ts
// Legal — offline, no LLM
compress(messages, {
  preservePatterns: [
    { re: /§\s*\d+(\.\d+)*/i, label: 'section_reference' },
    { re: /\bArticle\s+[IVX]+\b/i, label: 'article_reference' },
    { re: /\b(herein|thereof|hereby|hereinafter|whereupon)\b/i, label: 'legal_term' },
    { re: /\b(Licensor|Licensee|Borrower|Lender|Guarantor)\b/, label: 'party_role' },
  ],
});

// Medical — offline, no LLM
compress(messages, {
  preservePatterns: [
    { re: /\b[A-Z]\d{2}(\.\d{1,2})?\b/, label: 'icd_code' },
    { re: /\b\d+\s*(mg|mcg|mL|units)\b/i, label: 'dosage' },
    { re: /\b(BP|HR|SpO2|RR|GCS)\s*[\d/]+/, label: 'vital_sign' },
  ],
});

// Academic — offline, no LLM
compress(messages, {
  preservePatterns: [
    { re: /\bdoi:\s*10\.\d{4,}\/\S+/i, label: 'doi' },
    { re: /\bp\s*[<>=]\s*0?\.\d+/i, label: 'p_value' },
    { re: /\([\w\s]+et\s+al\.,?\s*\d{4}\)/, label: 'citation' },
  ],
});
```

Why this works:

- **Users own their patterns.** No domain expertise needed in the library. A legal team
  writes legal patterns. A medical team writes medical patterns. We ship none.
- **Zero library bloat.** `preservePatterns` is an empty array by default. No dead code.
- **Composable.** A medical-legal document? Merge both pattern arrays. No combinator
  problem.
- **Same mechanism.** Patterns are injected into the existing `FORCE_T0_PATTERNS` loop
  at runtime. No new code path — just more patterns in the same scan.
- **Sync and deterministic.** Works offline, no LLM, no cost, no latency.
- **Documented, not coded.** We ship domain pattern examples in `docs/domain-prompts.md`
  as copy-paste recipes. Users adapt them. We don't maintain them as code.

### How the three layers compose

| Layer                | Cost    | Latency | Accuracy        | When to use                            |
| -------------------- | ------- | ------- | --------------- | -------------------------------------- |
| Heuristic (built-in) | Free    | <1ms    | High for code   | Code/technical content (default)       |
| `preservePatterns`   | Free    | <1ms    | Medium (regex)  | Offline domain use, known patterns     |
| LLM classifier       | ~$0.001 | ~100ms  | High (semantic) | Domain content requiring understanding |

All three are optional and composable. A user can use `preservePatterns` alone,
`classifier` alone, or both together. In hybrid mode with `preservePatterns`, the
evaluation order is: built-in heuristics → custom patterns → LLM (if still
low-confidence). Each layer narrows the set of messages that need the next layer.

### Implementation note

`preservePatterns` requires a small change in `classifyAll()` in `compress.ts` — the
custom patterns are checked after the built-in classification and before the LLM
classifier. If any custom pattern matches, the message is preserved as hard T0 (same
as a code fence or JSON detection). The patterns are also added as reasons in the
`ClassifyResult` for transparency.

Alternatively, the patterns could be injected into `classifyMessage()` via a parameter,
keeping all pattern evaluation in `classify.ts`. This is a minor implementation choice
that doesn't affect the API.

---

## Open questions

### 1. Batching

Should the classifier support batch classification? Instead of N individual LLM calls, send all eligible messages in a single prompt:

```
Classify each of the following messages. Respond with a JSON array.

Message 1: ...
Message 2: ...
```

**Pros:** Dramatically fewer API calls (1 instead of N), lower latency, context between messages helps classification.
**Cons:** Larger prompt = higher per-call cost, risk of partial failure, harder to parse, max context window limits.

**Recommendation:** Start without batching. The per-message approach is simpler, more robust, and the cost is already low. Batching can be added later as an optimization without API changes.

### 2. Caching

Should we cache classification results? Messages with identical content could reuse previous LLM classifications.

**Recommendation:** Not in v1. The caller can implement caching in their `callLlm` function. Keep the library stateless.

### 3. Confidence threshold for hybrid mode

In hybrid mode, what heuristic confidence threshold triggers the LLM? Currently, all prose gets confidence 0.65.

**Recommendation:** Don't expose this as an option in v1. The internal logic is simple: hard T0 = skip LLM, everything else = ask LLM. If we later improve the heuristic classifier's confidence scoring, the threshold becomes meaningful.

---

## Summary

This feature adds three composable classification layers to the compression pipeline:

1. **Built-in heuristics** (`classify.ts`) — structural pattern detection for code/technical content. Untouched.
2. **`preservePatterns`** — user-supplied regex patterns for offline domain support. Injected at runtime, zero library bloat.
3. **LLM classifier** (`classifier.ts`) — semantic classification for domain-specific content. Factory functions, `callLlm` injection, async routing, deterministic fallback. Follows the summarizer pattern exactly.

The heuristic classifier is not expanded with domain patterns. Domain-specific classification is a semantic problem, not a syntactic one. Regex can detect `§ 4.2` but can't decide whether a paragraph is a material obligation or boilerplate. The LLM classifier solves the semantic problem. `preservePatterns` solves the offline/deterministic case for known patterns.

The API surface grows by two factory functions (`createClassifier`, `createEscalatingClassifier`), two types (`Classifier`, `CreateClassifierOptions`), and three options on `CompressOptions` (`classifier`, `classifierMode`, `preservePatterns`). All additive, non-breaking.
