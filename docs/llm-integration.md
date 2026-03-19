# LLM Integration

[Back to README](../README.md) | [All docs](README.md)

Plug any LLM into the compression engine for semantic summarization.

## Summarizer interface

```ts
type Summarizer = (text: string) => string | Promise<string>;
```

Any function matching this signature works. The engine calls it with prose text and expects a shorter summary back.

## `createSummarizer`

Wraps your LLM call with an optimized prompt that preserves technical content:

```ts
import { createSummarizer, compress } from 'context-compression-engine';

const summarizer = createSummarizer(async (prompt) => myLlm.complete(prompt), {
  maxResponseTokens: 300,
});

const result = await compress(messages, { summarizer });
```

The generated prompt:

- Instructs the LLM to summarize concisely (or as terse bullet points in `aggressive` mode)
- Sets a token budget hint
- Preserves: code references, file paths, function/variable names, URLs, API keys, error messages, numbers, and technical decisions
- Strips filler, pleasantries, and redundant explanations
- Keeps the same technical register

### Prompt customization

**Domain-specific instructions:**

```ts
const summarizer = createSummarizer(callLlm, {
  systemPrompt:
    'This is a legal contract. Preserve all clause numbers, party names, and defined terms.',
});
```

**Additional preserve terms:**

```ts
const summarizer = createSummarizer(callLlm, {
  preserveTerms: ['clause numbers', 'party names', 'defined terms'],
});
```

**Aggressive mode** (half the token budget, bullet points):

```ts
const summarizer = createSummarizer(callLlm, { mode: 'aggressive' });
```

## `createEscalatingSummarizer`

Tries normal first, escalates to aggressive if the result isn't shorter:

```ts
import { createEscalatingSummarizer, compress } from 'context-compression-engine';

const summarizer = createEscalatingSummarizer(async (prompt) => myLlm.complete(prompt), {
  maxResponseTokens: 300,
});

const result = await compress(messages, { summarizer });
```

Escalation levels:

1. **Normal** - concise prose summary
2. **Aggressive** - terse bullet points at half the token budget (if normal throws, returns empty, or returns equal-length or longer text)
3. **Deterministic** - sentence extraction fallback (handled by the compression pipeline's `withFallback`)

`mode` is not accepted as an option — the escalating summarizer manages both modes internally.

## Fallback behavior

When a `summarizer` is provided, each message goes through `withFallback`:

1. Call the summarizer
2. Accept the result if it's a non-empty string **and** strictly shorter than the input
3. If the summarizer throws, returns empty, or returns equal/longer text: fall back to deterministic `summarize`

After the fallback, the size guard still applies — if even the deterministic summary is larger than the original, the message is preserved as-is.

This design was validated by benchmarking: LLMs frequently produce summaries that are longer than the deterministic output (they try to be helpful rather than terse).

## Provider examples

### Anthropic (Claude)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createSummarizer, compress } from 'context-compression-engine';

const anthropic = new Anthropic();

const summarizer = createSummarizer(async (prompt) => {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].type === 'text' ? msg.content[0].text : '';
});

const result = await compress(messages, { summarizer });
```

### OpenAI

```ts
import OpenAI from 'openai';
import { createSummarizer, compress } from 'context-compression-engine';

const openai = new OpenAI();

const summarizer = createSummarizer(async (prompt) => {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content ?? '';
});

const result = await compress(messages, { summarizer });
```

### Google Gemini

```ts
import { GoogleGenAI } from '@google/genai';
import { createSummarizer, compress } from 'context-compression-engine';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const summarizer = createSummarizer(async (prompt) => {
  const res = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
  });
  return res.text ?? '';
});

const result = await compress(messages, { summarizer });
```

### xAI (Grok)

xAI's API is OpenAI-compatible — use the OpenAI SDK with a different base URL:

```ts
import OpenAI from 'openai';
import { createSummarizer, compress } from 'context-compression-engine';

const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const summarizer = createSummarizer(async (prompt) => {
  const res = await xai.chat.completions.create({
    model: 'grok-3-fast',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content ?? '';
});

const result = await compress(messages, { summarizer });
```

### Ollama

```ts
import { createSummarizer, compress } from 'context-compression-engine';

const summarizer = createSummarizer(async (prompt) => {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3', prompt, stream: false }),
  });
  const json = await res.json();
  return json.response;
});

const result = await compress(messages, { summarizer });
```

### Any provider

The summarizer is just a function. Use any HTTP API, local model, or custom logic:

```ts
// Simple truncation (no LLM needed)
const summarizer = (text: string) => text.slice(0, 200) + '...';

// Custom API
const summarizer = async (text: string) => {
  const res = await fetch('https://my-api.com/summarize', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return (await res.json()).summary;
};
```

## Classifier interface

```ts
type Classifier = (content: string) => ClassifierResult | Promise<ClassifierResult>;
type ClassifierResult = { decision: 'preserve' | 'compress'; confidence: number; reason: string };
```

The classifier decides whether each message should be preserved verbatim or compressed. It complements the summarizer — the summarizer controls _how_ to compress, the classifier controls _what_ to compress.

## `createClassifier`

Wraps your LLM call with a classification prompt:

```ts
import { createClassifier, compress } from 'context-compression-engine';

const classifier = createClassifier(async (prompt) => myLlm.complete(prompt), {
  systemPrompt: 'You are classifying content from legal documents.',
  alwaysPreserve: ['clause references', 'defined terms', 'party names'],
  alwaysCompress: ['boilerplate acknowledgments'],
});

const result = await compress(messages, { classifier });
```

### Domain examples

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
  ],
  alwaysCompress: [
    'recitals and background context already summarized',
    'boilerplate acknowledgments',
    'procedural correspondence (scheduling, confirmations)',
  ],
});
```

**Medical:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from medical records and clinical notes.',
  alwaysPreserve: [
    'diagnoses and ICD codes',
    'medication names, dosages, and frequencies',
    'lab values and vital signs with numbers',
    'allergies and contraindications',
    'procedure descriptions and outcomes',
  ],
  alwaysCompress: [
    'general health education text',
    'administrative notes about scheduling',
    'repeated disclaimer language',
  ],
});
```

**Academic:**

```ts
const classifier = createClassifier(callLlm, {
  systemPrompt: 'You are classifying content from academic papers and research documents.',
  alwaysPreserve: [
    'citations and references (author names, years, DOIs)',
    'statistical results (p-values, confidence intervals, effect sizes)',
    'methodology descriptions',
    'theorem statements and proofs',
  ],
  alwaysCompress: [
    'literature review summaries of well-known background',
    'verbose transitions between sections',
    'acknowledgments and funding boilerplate',
  ],
});
```

## `createEscalatingClassifier`

Tries the LLM first, falls back to heuristic classification on failure:

```ts
import { createEscalatingClassifier, compress } from 'context-compression-engine';

const classifier = createEscalatingClassifier(async (prompt) => myLlm.complete(prompt), {
  systemPrompt: 'Legal documents.',
});

const result = await compress(messages, { classifier });
```

If the LLM throws, returns unparseable output, or returns confidence=0, the escalating classifier falls back to the built-in heuristic `classifyMessage()`. Hard T0 heuristic results become `preserve`, everything else becomes `compress`.

## Classifier + Summarizer

Both can be used together. The classifier decides _what_ to compress, the summarizer decides _how_:

```ts
const result = await compress(messages, {
  classifier,
  summarizer,
  classifierMode: 'hybrid',
});
```

## Model recommendations

Fast, cheap models work best for compression summarization. The task is straightforward (shorten text while preserving technical terms), so frontier models are overkill.

| Provider  | Recommended model            | Why                                        |
| --------- | ---------------------------- | ------------------------------------------ |
| Anthropic | `claude-haiku-4-5-20251001`  | Fast, cheap, good at instruction following |
| OpenAI    | `gpt-4o-mini`                | Low latency, low cost                      |
| Google    | `gemini-2.0-flash`           | Fast, generous rate limits                 |
| xAI       | `grok-3-fast`                | OpenAI-compatible, fast                    |
| Ollama    | `llama3`, `llama3.2`, `phi3` | Local, no API costs                        |

The fallback chain means a worse model just falls back to deterministic more often — it won't produce worse output.

---

## See also

- [Compression pipeline](compression-pipeline.md) - how the fallback chain works
- [Token budget](token-budget.md) - budget-driven compression with LLM
- [API reference](api-reference.md) - `createSummarizer`, `createEscalatingSummarizer` signatures
