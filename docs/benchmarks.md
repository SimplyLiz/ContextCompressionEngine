# Benchmarks

[Back to README](../README.md) | [All docs](README.md) | [Latest Results](benchmark-results.md)

## Running Benchmarks

```bash
npm run bench          # Run benchmarks (no baseline check)
npm run bench:check    # Run and compare against baseline
npm run bench:save     # Run, save new baseline, regenerate results doc
npm run bench:llm      # Run with LLM summarization benchmarks
```

### LLM benchmarks (opt-in)

LLM benchmarks require the `--llm` flag (`npm run bench:llm`). Set API keys in a `.env` file or export them. Ollama is auto-detected when running locally.

| Variable | Provider | Default Model | Notes |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI | `gpt-4.1-mini` | |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-haiku-4-5-20251001` | |
| *(none required)* | Ollama | `llama3.2` | Auto-detected on localhost:11434 |

## Scenarios

The benchmark covers 8 conversation types:

| Scenario | Description |
| --- | --- |
| Coding assistant | Mixed code fences and prose discussion |
| Long Q&A | Extended question-and-answer with repeated paragraphs |
| Tool-heavy | Messages with `tool_calls` arrays (preserved by default) |
| Short conversation | Brief exchanges, mostly under 120 chars |
| Deep conversation | 25 turns of multi-paragraph prose |
| Technical explanation | Pure prose Q&A about event-driven architecture |
| Structured content | JSON, YAML, SQL, API keys, test output |
| Agentic coding session | Repeated file reads, grep results, near-duplicate edits |

## Interpreting Results

### Compression ratio

| Ratio | Reduction |
| ---: | --- |
| 1.0x | no compression (all messages preserved) |
| 1.5x | 33% reduction |
| 2.0x | 50% reduction |
| 3.0x | 67% reduction |
| 6.0x | 83% reduction |

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

### Baseline files

| File | Purpose |
| --- | --- |
| `bench/baselines/current.json` | Active baseline compared in CI |
| `bench/baselines/history/v*.json` | Versioned snapshots, one per release |
| `bench/baselines/llm/*.json` | LLM benchmark reference data (non-deterministic) |
