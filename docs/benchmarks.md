# Benchmarks

[Back to README](../README.md) | [All docs](README.md)

Running benchmarks, interpreting results, and comparing compression methods.

## Running tests

```bash
# Run the test suite (333 tests)
npm test

# Type check
npx tsc --noEmit
```

## Deterministic benchmarks

No API keys needed. Runs entirely locally:

```bash
npm run bench
```

### Scenarios

The benchmark covers 7 conversation types:

| Scenario               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| Coding assistant       | Mixed code fences and prose discussion                   |
| Long Q&A               | Extended question-and-answer with detailed explanations  |
| Tool-heavy             | Messages with `tool_calls` arrays (preserved by default) |
| Short conversation     | Brief exchanges, mostly under 120 chars                  |
| Deep conversation      | Long, multi-paragraph prose exchanges                    |
| Structured content     | JSON, YAML, SQL, test output                             |
| Agentic coding session | Repeated file reads, grep results, test runs             |

### What gets measured

For each scenario:

- **Characters**: original vs. compressed character counts
- **Compression ratio**: `original_chars / compressed_chars` (>1 = savings)
- **Token ratio**: `original_tokens / compressed_tokens`
- **Messages compressed**: how many messages were summarized
- **Messages preserved**: how many were kept as-is
- **Messages deduped**: exact duplicates replaced (agentic scenario)
- **Timing**: milliseconds per compression

Additional benchmark sections:

- **Token budget optimization** with and without dedup
- **Fuzzy dedup accuracy** across thresholds
- **Real-session compression** on actual Claude Code transcripts (if `~/.claude/projects/` exists)

### Real-session benchmarks

The benchmark automatically scans for real Claude Code conversation files in `~/.claude/projects/`. It parses JSONL conversation files, extracts message arrays, and runs compression on actual production data.

This provides the most realistic performance numbers since synthetic scenarios can't capture the full diversity of real conversations.

## LLM benchmarks

Compare deterministic compression against real LLM-powered summarization. Set one or more environment variables to enable:

| Variable            | Provider  | Default model                                             |
| ------------------- | --------- | --------------------------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI    | `gpt-4.1-mini` (override: `OPENAI_MODEL`)                 |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-haiku-4-5-20251001` (override: `ANTHROPIC_MODEL`) |
| `OLLAMA_MODEL`      | Ollama    | `llama3.2` (host override: `OLLAMA_HOST`)                 |

```bash
# Run with OpenAI
OPENAI_API_KEY=sk-... npm run bench

# Run with Ollama (local)
OLLAMA_MODEL=llama3.2 npm run bench

# Run with multiple providers
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... npm run bench
```

### Three methods compared

Each scenario runs three methods side-by-side:

| Method          | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `deterministic` | No LLM, pure sentence scoring + entity extraction                    |
| `llm-basic`     | `createSummarizer` with the detected provider                        |
| `llm-escalate`  | `createEscalatingSummarizer` (normal -> aggressive -> deterministic) |

All methods verify round-trip integrity — `uncompress()` is called to confirm originals are restored.

### What to look for

- **Ratio comparison** — deterministic often beats LLM on compression ratio because LLMs write fuller, more helpful summaries
- **Latency** — deterministic is < 2ms; LLM adds network round-trip time per message
- **Fallback rate** — how often the engine rejects LLM output and falls back to deterministic
- **Round-trip integrity** — all methods must pass (no data loss)

### SDK requirements

LLM providers require their SDKs:

- OpenAI: `openai` package
- Anthropic: `@anthropic-ai/sdk` package
- Ollama: `openai` package (uses OpenAI-compatible API)

Missing SDKs are detected at runtime and print a skip message — no crash, no hard dependency.

## Interpreting results

### Compression ratio

- `1.0` = no compression (all messages preserved)
- `1.5` = 33% reduction
- `2.0` = 50% reduction
- `3.0` = 67% reduction
- `6.0` = 83% reduction

Higher is better. The deterministic engine typically achieves 1.3-6.1x on synthetic scenarios.

### Token ratio vs. character ratio

Token ratio is more meaningful for LLM context budgeting since tokens are what models count. Character ratio is useful for storage optimization.

### When LLM wins

LLM summarization can outperform deterministic in:

- Very long prose-heavy conversations where paraphrasing and concept merging genuinely helps
- Domain-specific content where the LLM understands what's important

### When deterministic wins

Deterministic typically wins when:

- Messages contain mixed code and prose (code-aware splitting is already optimal)
- Messages are structured (test output, grep results)
- The LLM writes helpful but verbose summaries

---

## See also

- [Compression pipeline](compression-pipeline.md) - the deterministic algorithm
- [LLM integration](llm-integration.md) - setting up providers for benchmarks
- [Token budget](token-budget.md) - budget optimization
- [Deduplication](deduplication.md) - dedup in benchmarks
