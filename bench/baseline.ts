import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BasicResult {
  ratio: number;
  tokenRatio: number;
  compressed: number;
  preserved: number;
}

export interface TokenBudgetResult {
  tokenCount: number;
  fits: boolean;
  recencyWindow: number | undefined;
  compressed: number;
  preserved: number;
  deduped: number;
}

export interface DedupResult {
  rw0Base: number;
  rw0Dup: number;
  rw4Base: number;
  rw4Dup: number;
  deduped: number;
}

export interface FuzzyDedupResult {
  exact: number;
  fuzzy: number;
  ratio: number;
}

export interface BenchmarkResults {
  basic: Record<string, BasicResult>;
  tokenBudget: Record<string, TokenBudgetResult>;
  dedup: Record<string, DedupResult>;
  fuzzyDedup: Record<string, FuzzyDedupResult>;
}

export interface Baseline {
  version: string;
  generated: string;
  results: BenchmarkResults;
}

// ---------------------------------------------------------------------------
// LLM benchmark types
// ---------------------------------------------------------------------------

export interface LlmMethodResult {
  ratio: number;
  tokenRatio: number;
  compressed: number;
  preserved: number;
  roundTrip: 'PASS' | 'FAIL';
  timeMs: number;
  /** ratio / deterministic ratio — values < 1.0 mean LLM expanded instead of compressing */
  vsDet?: number;
}

export interface LlmScenarioResult {
  methods: Record<string, LlmMethodResult>;
}

export interface LlmTokenBudgetResult {
  budget: number;
  method: string;
  tokenCount: number;
  fits: boolean;
  ratio: number;
  recencyWindow: number | undefined;
  roundTrip: 'PASS' | 'FAIL';
  timeMs: number;
}

export interface LlmBenchmarkResult {
  provider: string;
  model: string;
  generated: string;
  scenarios: Record<string, LlmScenarioResult>;
  tokenBudget?: Record<string, LlmTokenBudgetResult[]>;
}

// ---------------------------------------------------------------------------
// Save / Load
// ---------------------------------------------------------------------------

export function saveBaseline(
  baselinesDir: string,
  version: string,
  results: BenchmarkResults,
): void {
  const baseline: Baseline = {
    version,
    generated: new Date().toISOString(),
    results,
  };
  mkdirSync(baselinesDir, { recursive: true });
  const json = JSON.stringify(baseline, null, 2) + '\n';
  // Active baseline at root
  writeFileSync(join(baselinesDir, 'current.json'), json);
  // Versioned snapshot in history/
  const historyDir = join(baselinesDir, 'history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `v${version}.json`), json);
}

export function loadBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function loadCurrentBaseline(baselinesDir: string): Baseline | null {
  const path = join(baselinesDir, 'current.json');
  if (!existsSync(path)) return null;
  return loadBaseline(path);
}

// ---------------------------------------------------------------------------
// LLM result persistence
// ---------------------------------------------------------------------------

export function saveLlmResult(baselinesDir: string, result: LlmBenchmarkResult): void {
  const llmDir = join(baselinesDir, 'llm');
  mkdirSync(llmDir, { recursive: true });
  const filename = `${result.provider}-${result.model.replace(/[/:]/g, '-')}.json`;
  writeFileSync(join(llmDir, filename), JSON.stringify(result, null, 2) + '\n');
}

export function loadAllLlmResults(baselinesDir: string): LlmBenchmarkResult[] {
  const llmDir = join(baselinesDir, 'llm');
  if (!existsSync(llmDir)) return [];

  const results: LlmBenchmarkResult[] = [];
  for (const f of readdirSync(llmDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    try {
      results.push(JSON.parse(readFileSync(join(llmDir, f), 'utf-8')));
    } catch {
      console.warn(`  Warning: skipping malformed LLM result file: ${f}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface Regression {
  benchmark: string;
  scenario: string;
  metric: string;
  expected: number | boolean;
  actual: number | boolean;
  delta?: string;
}

function checkNum(
  regressions: Regression[],
  bench: string,
  scenario: string,
  metric: string,
  expected: number,
  actual: number,
  tolerance: number,
): void {
  const denom = Math.max(Math.abs(expected), 1);
  const pctDiff = Math.abs(actual - expected) / denom;
  if (pctDiff > tolerance) {
    const sign = actual > expected ? '+' : '';
    regressions.push({
      benchmark: bench,
      scenario,
      metric,
      expected,
      actual,
      delta: `${sign}${(((actual - expected) / denom) * 100).toFixed(1)}%`,
    });
  }
}

function checkBool(
  regressions: Regression[],
  bench: string,
  scenario: string,
  metric: string,
  expected: boolean,
  actual: boolean,
): void {
  if (expected !== actual) {
    regressions.push({ benchmark: bench, scenario, metric, expected, actual });
  }
}

function missing(regressions: Regression[], bench: string, scenario: string): void {
  regressions.push({
    benchmark: bench,
    scenario,
    metric: '(missing)',
    expected: true,
    actual: false,
  });
}

export function compareResults(
  baseline: BenchmarkResults,
  current: BenchmarkResults,
  tolerance: number = 0,
): Regression[] {
  const regressions: Regression[] = [];

  // Basic
  for (const [name, exp] of Object.entries(baseline.basic)) {
    const act = current.basic[name];
    if (!act) {
      missing(regressions, 'basic', name);
      continue;
    }
    checkNum(regressions, 'basic', name, 'ratio', exp.ratio, act.ratio, tolerance);
    checkNum(regressions, 'basic', name, 'tokenRatio', exp.tokenRatio, act.tokenRatio, tolerance);
    checkNum(regressions, 'basic', name, 'compressed', exp.compressed, act.compressed, tolerance);
    checkNum(regressions, 'basic', name, 'preserved', exp.preserved, act.preserved, tolerance);
  }

  // Token budget
  for (const [name, exp] of Object.entries(baseline.tokenBudget)) {
    const act = current.tokenBudget[name];
    if (!act) {
      missing(regressions, 'tokenBudget', name);
      continue;
    }
    checkNum(
      regressions,
      'tokenBudget',
      name,
      'tokenCount',
      exp.tokenCount,
      act.tokenCount,
      tolerance,
    );
    checkBool(regressions, 'tokenBudget', name, 'fits', exp.fits, act.fits);
    if (exp.recencyWindow != null && act.recencyWindow != null) {
      checkNum(
        regressions,
        'tokenBudget',
        name,
        'recencyWindow',
        exp.recencyWindow,
        act.recencyWindow,
        tolerance,
      );
    }
    checkNum(
      regressions,
      'tokenBudget',
      name,
      'compressed',
      exp.compressed,
      act.compressed,
      tolerance,
    );
    checkNum(
      regressions,
      'tokenBudget',
      name,
      'preserved',
      exp.preserved,
      act.preserved,
      tolerance,
    );
    checkNum(regressions, 'tokenBudget', name, 'deduped', exp.deduped, act.deduped, tolerance);
  }

  // Dedup
  for (const [name, exp] of Object.entries(baseline.dedup)) {
    const act = current.dedup[name];
    if (!act) {
      missing(regressions, 'dedup', name);
      continue;
    }
    checkNum(regressions, 'dedup', name, 'rw0Base', exp.rw0Base, act.rw0Base, tolerance);
    checkNum(regressions, 'dedup', name, 'rw0Dup', exp.rw0Dup, act.rw0Dup, tolerance);
    checkNum(regressions, 'dedup', name, 'rw4Base', exp.rw4Base, act.rw4Base, tolerance);
    checkNum(regressions, 'dedup', name, 'rw4Dup', exp.rw4Dup, act.rw4Dup, tolerance);
    checkNum(regressions, 'dedup', name, 'deduped', exp.deduped, act.deduped, tolerance);
  }

  // Fuzzy dedup
  for (const [name, exp] of Object.entries(baseline.fuzzyDedup)) {
    const act = current.fuzzyDedup[name];
    if (!act) {
      missing(regressions, 'fuzzyDedup', name);
      continue;
    }
    checkNum(regressions, 'fuzzyDedup', name, 'exact', exp.exact, act.exact, tolerance);
    checkNum(regressions, 'fuzzyDedup', name, 'fuzzy', exp.fuzzy, act.fuzzy, tolerance);
    checkNum(regressions, 'fuzzyDedup', name, 'ratio', exp.ratio, act.ratio, tolerance);
  }

  return regressions;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatRegressions(regressions: Regression[]): string {
  if (regressions.length === 0) return 'No regressions detected.';

  const lines: string[] = [`${regressions.length} regression(s) detected:`, ''];

  for (const r of regressions) {
    const delta = r.delta ? ` (${r.delta})` : '';
    lines.push(
      `  [${r.benchmark}] ${r.scenario} → ${r.metric}: expected ${r.expected}, got ${r.actual}${delta}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Doc generation
// ---------------------------------------------------------------------------

function semverSort(a: string, b: string): number {
  const pa = a
    .replace(/^v|\.json$/g, '')
    .split('.')
    .map(Number);
  const pb = b
    .replace(/^v|\.json$/g, '')
    .split('.')
    .map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function loadAllBaselines(baselinesDir: string): Baseline[] {
  const historyDir = join(baselinesDir, 'history');
  if (!existsSync(historyDir)) return [];

  const files = readdirSync(historyDir)
    .filter((f) => f.startsWith('v') && f.endsWith('.json'))
    .sort(semverSort);

  return files.map((f) => loadBaseline(join(historyDir, f)));
}

function fix(n: number, d: number = 2): string {
  return n.toFixed(d);
}

function generateSection(b: Baseline): string {
  const lines: string[] = [];
  const r = b.results;

  // Basic compression table
  const basicEntries = Object.entries(r.basic);
  const ratios = basicEntries.map(([, v]) => v.ratio);
  const minR = Math.min(...ratios);
  const maxR = Math.max(...ratios);
  const avgR = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  lines.push(`### Basic Compression`);
  lines.push('');
  lines.push(
    `**Range:** ${fix(minR)}x \u2013 ${fix(maxR)}x \u00b7 **Average:** ${fix(avgR)}x \u00b7 **Round-trip:** all PASS`,
  );
  lines.push('');
  lines.push('| Scenario | Char Ratio | Token Ratio | Compressed | Preserved |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [name, v] of basicEntries) {
    lines.push(
      `| ${name} | ${fix(v.ratio)} | ${fix(v.tokenRatio)} | ${v.compressed} | ${v.preserved} |`,
    );
  }

  // Token budget table
  lines.push('');
  lines.push('### Token Budget (target: 2000 tokens)');
  lines.push('');
  lines.push(
    '| Scenario | Dedup | Tokens | Fits | recencyWindow | Compressed | Preserved | Deduped |',
  );
  lines.push('| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const [key, v] of Object.entries(r.tokenBudget)) {
    const [name, dedupStr] = key.split('|');
    const dedup = dedupStr === 'dedup=true' ? 'yes' : 'no';
    lines.push(
      `| ${name} | ${dedup} | ${v.tokenCount} | ${v.fits} | ${v.recencyWindow ?? '-'} | ${v.compressed} | ${v.preserved} | ${v.deduped} |`,
    );
  }

  // Dedup comparison table
  lines.push('');
  lines.push('### Dedup Effectiveness');
  lines.push('');
  lines.push(
    '| Scenario | No Dedup (rw=0) | Dedup (rw=0) | No Dedup (rw=4) | Dedup (rw=4) | Deduped |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, v] of Object.entries(r.dedup)) {
    lines.push(
      `| ${name} | ${fix(v.rw0Base)} | ${fix(v.rw0Dup)} | ${fix(v.rw4Base)} | ${fix(v.rw4Dup)} | ${v.deduped} |`,
    );
  }

  // Fuzzy dedup table
  lines.push('');
  lines.push('### Fuzzy Dedup');
  lines.push('');
  lines.push('| Scenario | Exact Deduped | Fuzzy Deduped | Ratio |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [name, v] of Object.entries(r.fuzzyDedup)) {
    lines.push(`| ${name} | ${v.exact} | ${v.fuzzy} | ${fix(v.ratio)} |`);
  }

  return lines.join('\n');
}

export function generateBenchmarkDocs(baselinesDir: string, outputPath: string): void {
  const baselines = loadAllBaselines(baselinesDir);
  if (baselines.length === 0) return;

  const latest = baselines[baselines.length - 1];
  const lines: string[] = [];

  lines.push('# Benchmark Results');
  lines.push('');
  lines.push('[Back to README](../README.md) | [All docs](README.md)');
  lines.push('');
  lines.push('<!-- Auto-generated from bench/baselines/. Do not edit manually. -->');
  lines.push('<!-- Run `npm run bench:save` to regenerate. -->');
  lines.push('');

  // --- How to run section ---
  lines.push('## Running Benchmarks');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run bench          # Run benchmarks (no baseline check)');
  lines.push('npm run bench:check    # Run and compare against baseline');
  lines.push('npm run bench:save     # Run, save new baseline, regenerate this doc');
  lines.push('```');
  lines.push('');
  lines.push('### LLM benchmarks (opt-in)');
  lines.push('');
  lines.push(
    'LLM benchmarks require the `--llm` flag (`npm run bench:llm`). Set API keys in a `.env` file or export them. Ollama is auto-detected when running locally.',
  );
  lines.push('');
  lines.push('| Variable | Provider | Default Model | Notes |');
  lines.push('| --- | --- | --- | --- |');
  lines.push('| `OPENAI_API_KEY` | OpenAI | `gpt-4.1-mini` | |');
  lines.push('| `ANTHROPIC_API_KEY` | Anthropic | `claude-haiku-4-5-20251001` | |');
  lines.push('| *(none required)* | Ollama | `llama3.2` | Auto-detected on localhost:11434 |');
  lines.push('');

  // --- Latest version results ---
  lines.push(`## Current Results (v${latest.version})`);
  lines.push('');
  lines.push(generateSection(latest));
  lines.push('');

  // --- Version history ---
  if (baselines.length > 1) {
    lines.push('## Version History');
    lines.push('');
    lines.push('| Version | Date | Avg Char Ratio | Avg Token Ratio | Scenarios |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const b of [...baselines].reverse()) {
      const basicEntries = Object.values(b.results.basic);
      const avgChr = basicEntries.reduce((s, v) => s + v.ratio, 0) / basicEntries.length;
      const avgTkr = basicEntries.reduce((s, v) => s + v.tokenRatio, 0) / basicEntries.length;
      const date = b.generated.split('T')[0];
      lines.push(
        `| ${b.version} | ${date} | ${fix(avgChr)} | ${fix(avgTkr)} | ${basicEntries.length} |`,
      );
    }
    lines.push('');
  }

  // --- Per-version detail (older versions) ---
  const olderVersions = baselines.slice(0, -1).reverse();
  if (olderVersions.length > 0) {
    lines.push('## Previous Versions');
    lines.push('');
    for (const b of olderVersions) {
      lines.push(`<details>`);
      lines.push(`<summary>v${b.version} (${b.generated.split('T')[0]})</summary>`);
      lines.push('');
      lines.push(generateSection(b));
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // --- Scenarios ---
  lines.push('## Scenarios');
  lines.push('');
  lines.push('The benchmark covers 8 conversation types:');
  lines.push('');
  lines.push('| Scenario | Description |');
  lines.push('| --- | --- |');
  lines.push('| Coding assistant | Mixed code fences and prose discussion |');
  lines.push('| Long Q&A | Extended question-and-answer with repeated paragraphs |');
  lines.push('| Tool-heavy | Messages with `tool_calls` arrays (preserved by default) |');
  lines.push('| Short conversation | Brief exchanges, mostly under 120 chars |');
  lines.push('| Deep conversation | 25 turns of multi-paragraph prose |');
  lines.push('| Technical explanation | Pure prose Q&A about event-driven architecture |');
  lines.push('| Structured content | JSON, YAML, SQL, API keys, test output |');
  lines.push(
    '| Agentic coding session | Repeated file reads, grep results, near-duplicate edits |',
  );
  lines.push('');

  // --- Interpreting results ---
  lines.push('## Interpreting Results');
  lines.push('');
  lines.push('### Compression ratio');
  lines.push('');
  lines.push('| Ratio | Reduction |');
  lines.push('| ---: | --- |');
  lines.push('| 1.0x | no compression (all messages preserved) |');
  lines.push('| 1.5x | 33% reduction |');
  lines.push('| 2.0x | 50% reduction |');
  lines.push('| 3.0x | 67% reduction |');
  lines.push('| 6.0x | 83% reduction |');
  lines.push('');
  lines.push(
    'Higher is better. Token ratio is more meaningful for LLM context budgeting; character ratio is useful for storage.',
  );
  lines.push('');

  // --- Regression testing ---
  lines.push('## Regression Testing');
  lines.push('');
  lines.push(
    'Baselines are stored in [`bench/baselines/`](../bench/baselines/) as JSON. CI runs `npm run bench:check` on every push and PR to catch regressions.',
  );
  lines.push('');
  lines.push('- **Tolerance:** 0% by default (all metrics are deterministic)');
  lines.push('- **On regression:** CI fails with a diff showing which metrics changed');
  lines.push(
    '- **After intentional changes:** run `npm run bench:save` to update the baseline and regenerate this doc',
  );
  lines.push(
    '- **Custom tolerance:** `npx tsx bench/run.ts --check --tolerance 5` allows 5% deviation',
  );
  lines.push('');
  lines.push('### Baseline files');
  lines.push('');
  lines.push('| File | Purpose |');
  lines.push('| --- | --- |');
  lines.push('| `bench/baselines/current.json` | Active baseline compared in CI |');
  lines.push('| `bench/baselines/history/v*.json` | Versioned snapshots, one per release |');
  lines.push('| `bench/baselines/llm/*.json` | LLM benchmark reference data (non-deterministic) |');
  lines.push('');

  // --- LLM comparison (if result files exist) ---
  const llmResults = loadAllLlmResults(baselinesDir);
  if (llmResults.length > 0) {
    lines.push('## LLM Summarization Comparison');
    lines.push('');
    lines.push(
      '> Results are **non-deterministic** — LLM outputs vary between runs. These are saved as reference data, not used for regression testing.',
    );
    lines.push('');

    for (const llm of llmResults) {
      lines.push(`### ${llm.provider} (${llm.model})`);
      lines.push('');
      lines.push(`*Generated: ${llm.generated.split('T')[0]}*`);
      lines.push('');
      lines.push(
        '| Scenario | Method | Char Ratio | Token Ratio | vs Det | Compressed | Preserved | Round-trip | Time |',
      );
      lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |');

      for (const [scenario, sr] of Object.entries(llm.scenarios)) {
        let first = true;
        for (const [method, mr] of Object.entries(sr.methods)) {
          const label = first ? scenario : '';
          const time =
            mr.timeMs < 1000 ? `${Math.round(mr.timeMs)}ms` : `${(mr.timeMs / 1000).toFixed(1)}s`;
          const vsDet = mr.vsDet != null ? fix(mr.vsDet) : '-';
          lines.push(
            `| ${label} | ${method} | ${fix(mr.ratio)} | ${fix(mr.tokenRatio)} | ${vsDet} | ${mr.compressed} | ${mr.preserved} | ${mr.roundTrip} | ${time} |`,
          );
          first = false;
        }
      }

      // Token budget table (if present)
      if (llm.tokenBudget && Object.keys(llm.tokenBudget).length > 0) {
        lines.push('');
        lines.push('#### Token Budget (target: 2000 tokens)');
        lines.push('');
        lines.push(
          '| Scenario | Method | Tokens | Fits | recencyWindow | Ratio | Round-trip | Time |',
        );
        lines.push('| --- | --- | ---: | --- | ---: | ---: | --- | ---: |');

        for (const [scenario, entries] of Object.entries(llm.tokenBudget)) {
          let first = true;
          for (const entry of entries) {
            const label = first ? scenario : '';
            const time =
              entry.timeMs < 1000
                ? `${Math.round(entry.timeMs)}ms`
                : `${(entry.timeMs / 1000).toFixed(1)}s`;
            lines.push(
              `| ${label} | ${entry.method} | ${entry.tokenCount} | ${entry.fits} | ${entry.recencyWindow ?? '-'} | ${fix(entry.ratio)} | ${entry.roundTrip} | ${time} |`,
            );
            first = false;
          }
        }
      }

      lines.push('');
    }
  }

  // --- Methodology ---
  lines.push('## Methodology');
  lines.push('');
  lines.push('- All results are **deterministic** — same input always produces the same output');
  lines.push('- Metrics tracked: compression ratio, token ratio, message counts, dedup counts');
  lines.push('- Timing is excluded from baselines (hardware-dependent)');
  lines.push(
    '- Real-session and LLM benchmarks are excluded from baselines (environment-dependent)',
  );
  lines.push('- Round-trip integrity is verified for every scenario (compress then uncompress)');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
}
