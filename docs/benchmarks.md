# Benchmarks

[Back to README](../README.md) | [All docs](README.md) | [Latest Results](benchmark-results.md)

## Running Benchmarks

```bash
npm run bench              # Run compression benchmarks (no baseline check)
npm run bench:check        # Run and compare against baseline
npm run bench:save         # Run, save new baseline, regenerate results doc
npm run bench:llm          # Run with LLM summarization benchmarks
```

### Quality benchmarks

```bash
npm run bench:quality        # Run quality analysis (probes, coherence, info density)
npm run bench:quality:save   # Save quality baseline
npm run bench:quality:check  # Compare against saved quality baseline
npm run bench:quality:judge  # Run with LLM-as-judge scoring (requires API key)
```

### LLM benchmarks (opt-in)

LLM benchmarks require the `--llm` flag (`npm run bench:llm`). The LLM judge (`--llm-judge`) runs with the quality benchmark. Set API keys in a `.env` file or export them. Ollama is auto-detected when running locally.

| Variable            | Provider  | Default Model               | Notes                            |
| ------------------- | --------- | --------------------------- | -------------------------------- |
| `OPENAI_API_KEY`    | OpenAI    | `gpt-4.1-mini`              |                                  |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-haiku-4-5-20251001` |                                  |
| `GEMINI_API_KEY`    | Gemini    | `gemini-2.5-flash`          | Requires `@google/genai` SDK     |
| _(none required)_   | Ollama    | `llama3.2`                  | Auto-detected on localhost:11434 |

Model overrides: `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `OLLAMA_MODEL`.

## Scenarios

The benchmark covers 13 conversation types across core and edge-case categories:

### Core scenarios

| Scenario               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| Coding assistant       | Mixed code fences and prose discussion                   |
| Long Q&A               | Extended question-and-answer with repeated paragraphs    |
| Tool-heavy             | Messages with `tool_calls` arrays (preserved by default) |
| Deep conversation      | 25 turns of multi-paragraph prose                        |
| Technical explanation  | Pure prose Q&A about event-driven architecture           |
| Structured content     | JSON, YAML, SQL, API keys, test output                   |
| Agentic coding session | Repeated file reads, grep results, near-duplicate edits  |

### Edge-case scenarios

| Scenario                | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| Single-char messages    | Trivially short messages ("y", "n", "k")             |
| Giant single message    | One ~50KB message with mixed prose and code          |
| Code-only conversation  | All messages are entirely code fences, no prose      |
| Entity-dense technical  | Packed with identifiers, file paths, version numbers |
| Prose-only conversation | Pure prose with zero technical content               |
| Mixed languages         | Code in Python, SQL, JSON, YAML in one conversation  |

## Quality Metrics

The quality benchmark (`bench/quality.ts`) measures compression quality across several dimensions:

### Metrics

| Metric                   | Column   | Description                                                               |
| ------------------------ | -------- | ------------------------------------------------------------------------- |
| Entity retention         | `EntRet` | Fraction of technical entities (identifiers, paths, versions) preserved   |
| Code block integrity     | `CodeOK` | Whether code fences survive compression byte-identical                    |
| Information density      | `InfDen` | Output entity density / input entity density. >1.0 = denser output (good) |
| Probes                   | `Probes` | Task-based checks: does specific critical information survive?            |
| Probe pass rate          | `Pass`   | Fraction of probes that passed                                            |
| Negative compressions    | `NegCp`  | Messages where compressed output is larger than original                  |
| Coherence issues         | `Coher`  | Sentence fragments, duplicate sentences, trivial summaries                |
| Compressed quality score | `CmpQ`   | Quality score computed over only compressed messages                      |

### Probes

Each scenario has hand-curated probes that check whether specific critical information survives compression. For example:

- **Coding assistant**: Does `JWT_SECRET` survive? Is `jwt.verify` still in a code block? Are the `15m`/`7d` expiry values present?
- **Entity-dense technical**: Are `redis-prod-001`, `v22.3.0`, `PR #142`, `max_connections` preserved?
- **Code-only conversation**: Are all TypeScript, Python, and SQL code blocks intact?

Probe failures reveal real quality issues — information the compression engine drops that it shouldn't.

### LLM Judge

The `--llm-judge` flag adds an LLM-as-judge evaluation. For each scenario with actual compression (ratio > 1.01), it sends the original and compressed conversations to an LLM and asks for three 1-5 scores:

- **Meaning preserved**: Are important decisions, facts, code, and technical details retained?
- **Coherence**: Do compressed messages read naturally without fragments or duplicates?
- **Overall**: Combined assessment of compression quality

LLM judge scores are **display-only** — not saved to baselines and not used for regression testing (non-deterministic).

## Interpreting Results

### Compression ratio

| Ratio | Reduction                               |
| ----: | --------------------------------------- |
|  1.0x | no compression (all messages preserved) |
|  1.5x | 33% reduction                           |
|  2.0x | 50% reduction                           |
|  3.0x | 67% reduction                           |
|  6.0x | 83% reduction                           |

Higher is better. Token ratio is more meaningful for LLM context budgeting; character ratio is useful for storage.

### Deduplication

Dedup effectiveness is measured across two axes:

- **recencyWindow=0** vs **recencyWindow=4** — how much compression improves when recent messages are protected
- **With dedup** vs **without** — the marginal gain from exact + fuzzy duplicate detection

Scenarios with repeated content (Long Q&A, Agentic coding session) show the largest dedup gains. Scenarios with unique messages show no difference.

### LLM vs deterministic

The `vsDet` column shows LLM compression relative to deterministic:

- **vsDet > 1.0** — LLM achieves better compression (common for long prose)
- **vsDet < 1.0** — deterministic wins (common for structured/technical content)
- **vsDet = 1.0** — no difference (content is already optimal or fully preserved)

## Regression Testing

Baselines are stored in [`bench/baselines/`](../bench/baselines/) as JSON. CI runs `npm run bench:check` on every push and PR to catch regressions.

- **Tolerance:** 0% by default (all metrics are deterministic)
- **On regression:** CI fails with a diff showing which metrics changed
- **After intentional changes:** run `npm run bench:save` to update the baseline and regenerate the results doc
- **Custom tolerance:** `npx tsx bench/run.ts --check --tolerance 5` allows 5% deviation

### Quality regression thresholds

| Metric                | Threshold                           |
| --------------------- | ----------------------------------- |
| Probe pass rate       | max 5% drop from baseline           |
| Entity retention      | max 5% drop from baseline           |
| Code block integrity  | zero tolerance                      |
| Information density   | must stay ≥ 0.8 (when ratio > 1.01) |
| Negative compressions | must not increase from baseline     |
| Coherence issues      | must not increase from baseline     |

### Baseline files

| File                                     | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `bench/baselines/current.json`           | Active baseline compared in CI                   |
| `bench/baselines/history/v*.json`        | Versioned snapshots, one per release             |
| `bench/baselines/llm/*.json`             | LLM benchmark reference data (non-deterministic) |
| `bench/baselines/quality/current.json`   | Active quality baseline                          |
| `bench/baselines/quality/history/*.json` | Quality baseline snapshots by git ref            |
