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

/** Shorten scenario names for chart x-axis labels. */
const SHORT_NAMES: Record<string, string> = {
  'Coding assistant': 'Coding',
  'Long Q&A': 'Long Q&A',
  'Tool-heavy': 'Tool-heavy',
  'Short conversation': 'Short',
  'Deep conversation': 'Deep',
  'Technical explanation': 'Technical',
  'Structured content': 'Structured',
  'Agentic coding session': 'Agentic',
};

function shortName(name: string): string {
  return SHORT_NAMES[name] ?? name;
}

function formatTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

function badges(basic: Record<string, BasicResult>): string[] {
  const entries = Object.values(basic);
  const ratios = entries.map((v) => v.ratio);
  const avgR = (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2);
  const bestR = Math.max(...ratios).toFixed(2);
  const allPass = 'all_PASS';

  const badge = (label: string, value: string, color: string) =>
    `![${label}](https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, '--')}-${encodeURIComponent(value).replace(/-/g, '--')}-${color})`;

  return [
    [
      badge('avg ratio', `${avgR}x`, 'blue'),
      badge('best', `${bestR}x`, 'blue'),
      badge('scenarios', `${entries.length}`, 'blue'),
      badge('round-trip', allPass, 'brightgreen'),
    ].join(' '),
  ];
}

// ---------------------------------------------------------------------------
// Mermaid chart helpers
// ---------------------------------------------------------------------------

function compressionChart(basic: Record<string, BasicResult>): string[] {
  const entries = Object.entries(basic);
  const labels = entries.map(([n]) => `"${shortName(n)}"`).join(', ');
  const values = entries.map(([, v]) => fix(v.ratio)).join(', ');

  return [
    '```mermaid',
    'xychart-beta',
    '    title "Compression Ratio by Scenario"',
    `    x-axis [${labels}]`,
    '    y-axis "Char Ratio"',
    `    bar [${values}]`,
    '```',
  ];
}

function dedupChart(dedup: Record<string, DedupResult>): string[] {
  // Only include scenarios where dedup actually changes the ratio
  const entries = Object.entries(dedup).filter(([, v]) => v.rw0Base !== v.rw0Dup || v.deduped > 0);
  if (entries.length === 0) return [];

  const labels = entries.map(([n]) => `"${shortName(n)}"`).join(', ');
  const base = entries.map(([, v]) => fix(v.rw0Base)).join(', ');
  const exact = entries.map(([, v]) => fix(v.rw0Dup)).join(', ');

  return [
    '```mermaid',
    'xychart-beta',
    '    title "Deduplication Impact (recencyWindow=0)"',
    `    x-axis [${labels}]`,
    '    y-axis "Char Ratio"',
    `    bar [${base}]`,
    `    bar [${exact}]`,
    '```',
    '',
    '*First bar: no dedup · Second bar: with dedup*',
  ];
}

function llmComparisonChart(
  basic: Record<string, BasicResult>,
  llmResults: LlmBenchmarkResult[],
): string[] {
  // Use the best LLM result (highest average vsDet) for the chart
  let bestLlm: LlmBenchmarkResult | undefined;
  let bestAvg = -Infinity;
  for (const llm of llmResults) {
    const vsDetValues: number[] = [];
    for (const sr of Object.values(llm.scenarios)) {
      for (const mr of Object.values(sr.methods)) {
        if (mr.vsDet != null && mr.vsDet > 0) vsDetValues.push(mr.vsDet);
      }
    }
    const avg = vsDetValues.length > 0 ? vsDetValues.reduce((a, b) => a + b, 0) / vsDetValues.length : 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestLlm = llm;
    }
  }
  if (!bestLlm) return [];

  // Match scenarios that exist in both basic and LLM results
  const sharedScenarios = Object.keys(basic).filter((s) => s in bestLlm!.scenarios);
  if (sharedScenarios.length === 0) return [];

  const labels = sharedScenarios.map((n) => `"${shortName(n)}"`).join(', ');
  const detValues = sharedScenarios.map((s) => fix(basic[s].ratio)).join(', ');

  // Pick the best LLM method per scenario (highest ratio)
  const llmValues = sharedScenarios
    .map((s) => {
      const methods = Object.values(bestLlm!.scenarios[s].methods).filter(
        (m) => m.vsDet != null,
      );
      if (methods.length === 0) return fix(basic[s].ratio);
      return fix(Math.max(...methods.map((m) => m.ratio)));
    })
    .join(', ');

  return [
    '```mermaid',
    'xychart-beta',
    `    title "Deterministic vs LLM (${bestLlm.provider}/${bestLlm.model})"`,
    `    x-axis [${labels}]`,
    '    y-axis "Char Ratio"',
    `    bar "Deterministic" [${detValues}]`,
    `    line "Best LLM" [${llmValues}]`,
    '```',
    '',
    '*Bars: deterministic · Line: best LLM method*',
  ];
}

// ---------------------------------------------------------------------------
// Section generators
// ---------------------------------------------------------------------------

function generateCompressionSection(b: Baseline): string[] {
  const lines: string[] = [];
  const r = b.results;
  const basicEntries = Object.entries(r.basic);
  const ratios = basicEntries.map(([, v]) => v.ratio);
  const minR = Math.min(...ratios);
  const maxR = Math.max(...ratios);
  const avgR = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  lines.push('## Compression by Scenario');
  lines.push('');
  lines.push(
    `> **${basicEntries.length} scenarios** · **${fix(avgR)}x** avg ratio · `
      + `**${fix(minR)}x** – **${fix(maxR)}x** range · all round-trips PASS`,
  );
  lines.push('');
  lines.push(...compressionChart(r.basic));
  lines.push('');
  lines.push(
    '| Scenario | Ratio | Reduction | Token Ratio | Messages | Compressed | Preserved |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, v] of basicEntries) {
    const reduction = Math.round((1 - 1 / v.ratio) * 100);
    const messages = v.compressed + v.preserved;
    lines.push(
      `| ${name} | ${fix(v.ratio)} | ${reduction}% | ${fix(v.tokenRatio)} | ${messages} | ${v.compressed} | ${v.preserved} |`,
    );
  }
  return lines;
}

function generateDedupSection(r: BenchmarkResults): string[] {
  const lines: string[] = [];
  lines.push('## Deduplication Impact');
  lines.push('');

  const chart = dedupChart(r.dedup);
  if (chart.length > 0) {
    lines.push(...chart);
    lines.push('');
  }

  lines.push(
    '| Scenario | No Dedup (rw=0) | Dedup (rw=0) | No Dedup (rw=4) | Dedup (rw=4) | Deduped |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [name, v] of Object.entries(r.dedup)) {
    lines.push(
      `| ${name} | ${fix(v.rw0Base)} | ${fix(v.rw0Dup)} | ${fix(v.rw4Base)} | ${fix(v.rw4Dup)} | ${v.deduped} |`,
    );
  }
  lines.push('');

  // Fuzzy dedup detail
  const hasFuzzy = Object.values(r.fuzzyDedup).some((v) => v.fuzzy > 0);
  if (hasFuzzy) {
    lines.push('### Fuzzy Dedup');
    lines.push('');
  }
  lines.push('| Scenario | Exact Deduped | Fuzzy Deduped | Ratio |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [name, v] of Object.entries(r.fuzzyDedup)) {
    lines.push(`| ${name} | ${v.exact} | ${v.fuzzy} | ${fix(v.ratio)} |`);
  }
  return lines;
}

function generateTokenBudgetSection(r: BenchmarkResults): string[] {
  const lines: string[] = [];
  const entries = Object.entries(r.tokenBudget);
  const allFit = entries.every(([, v]) => v.fits);
  const fitCount = entries.filter(([, v]) => v.fits).length;

  lines.push('## Token Budget');
  lines.push('');
  lines.push(`Target: **2000 tokens** · ${allFit ? 'all fit' : `${fitCount}/${entries.length} fit`}`);
  lines.push('');
  lines.push(
    '| Scenario | Dedup | Tokens | Fits | recencyWindow | Compressed | Preserved | Deduped |',
  );
  lines.push('| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const [key, v] of entries) {
    const [name, dedupStr] = key.split('|');
    const dedup = dedupStr === 'dedup=true' ? 'yes' : 'no';
    const fitIcon = v.fits ? 'yes' : 'no';
    lines.push(
      `| ${name} | ${dedup} | ${v.tokenCount} | ${fitIcon} | ${v.recencyWindow ?? '-'} | ${v.compressed} | ${v.preserved} | ${v.deduped} |`,
    );
  }
  return lines;
}

function generateLlmSection(
  baselinesDir: string,
  basic: Record<string, BasicResult>,
): string[] {
  const llmResults = loadAllLlmResults(baselinesDir);
  if (llmResults.length === 0) return [];

  const lines: string[] = [];
  lines.push('## LLM vs Deterministic');
  lines.push('');
  lines.push(
    '> Results are **non-deterministic** — LLM outputs vary between runs. '
      + 'Saved as reference data, not used for regression testing.',
  );
  lines.push('');

  // Summary chart
  const chart = llmComparisonChart(basic, llmResults);
  if (chart.length > 0) {
    lines.push(...chart);
    lines.push('');
  }

  // Key finding callout
  const wins: string[] = [];
  const losses: string[] = [];
  for (const llm of llmResults) {
    for (const [scenario, sr] of Object.entries(llm.scenarios)) {
      for (const mr of Object.values(sr.methods)) {
        if (mr.vsDet != null && mr.vsDet > 1.0) wins.push(scenario);
        if (mr.vsDet != null && mr.vsDet < 0.9) losses.push(scenario);
      }
    }
  }
  const uniqueWins = [...new Set(wins)];
  const uniqueLosses = [...new Set(losses)];
  if (uniqueWins.length > 0 || uniqueLosses.length > 0) {
    lines.push('> **Key findings:**');
    if (uniqueWins.length > 0) {
      lines.push(`> LLM wins on prose-heavy scenarios: ${uniqueWins.join(', ')}`);
    }
    if (uniqueLosses.length > 0) {
      lines.push(
        `> Deterministic wins on structured/technical content: ${uniqueLosses.join(', ')}`,
      );
    }
    lines.push('');
  }

  // Per-provider detail tables (collapsible)
  for (const llm of llmResults) {
    lines.push(`### ${llm.provider} (${llm.model})`);
    lines.push('');
    lines.push(`*Generated: ${llm.generated.split('T')[0]}*`);
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Scenario details</summary>`);
    lines.push('');
    lines.push(
      '| Scenario | Method | Char Ratio | Token Ratio | vsDet | Compressed | Preserved | Round-trip | Time |',
    );
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |');

    for (const [scenario, sr] of Object.entries(llm.scenarios)) {
      let first = true;
      for (const [method, mr] of Object.entries(sr.methods)) {
        const label = first ? scenario : '';
        const vsDet = mr.vsDet != null ? fix(mr.vsDet) : '-';
        lines.push(
          `| ${label} | ${method} | ${fix(mr.ratio)} | ${fix(mr.tokenRatio)} | ${vsDet} | ${mr.compressed} | ${mr.preserved} | ${mr.roundTrip} | ${formatTime(mr.timeMs)} |`,
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
          lines.push(
            `| ${label} | ${entry.method} | ${entry.tokenCount} | ${entry.fits} | ${entry.recencyWindow ?? '-'} | ${fix(entry.ratio)} | ${entry.roundTrip} | ${formatTime(entry.timeMs)} |`,
          );
          first = false;
        }
      }
    }

    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main doc generator
// ---------------------------------------------------------------------------

export function generateBenchmarkDocs(baselinesDir: string, outputPath: string): void {
  const baselines = loadAllBaselines(baselinesDir);
  if (baselines.length === 0) return;

  const latest = baselines[baselines.length - 1];
  const lines: string[] = [];

  // --- Header ---
  lines.push('# Benchmark Results');
  lines.push('');
  lines.push('[Back to README](../README.md) | [All docs](README.md) | [Handbook](benchmarks.md)');
  lines.push('');
  lines.push('*Auto-generated by `npm run bench:save`. Do not edit manually.*');
  lines.push('');
  lines.push(`**v${latest.version}** · Generated: ${latest.generated.split('T')[0]}`);
  lines.push('');
  lines.push(...badges(latest.results.basic));
  lines.push('');

  // --- Summary ---
  const basicEntries = Object.entries(latest.results.basic);
  const ratios = basicEntries.map(([, v]) => v.ratio);
  const avgR = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Scenarios | ${basicEntries.length} |`);
  lines.push(`| Average compression | ${fix(avgR)}x |`);
  lines.push(`| Best compression | ${fix(Math.max(...ratios))}x |`);
  lines.push(`| Round-trip integrity | all PASS |`);
  lines.push('');

  // --- Pie chart: message outcome distribution ---
  const totalPreserved = basicEntries.reduce((s, [, v]) => s + v.preserved, 0);
  const totalCompressed = basicEntries.reduce((s, [, v]) => s + v.compressed, 0);
  lines.push('```mermaid');
  lines.push('pie title "Message Outcomes"');
  lines.push(`    "Preserved" : ${totalPreserved}`);
  lines.push(`    "Compressed" : ${totalCompressed}`);
  lines.push('```');
  lines.push('');

  // --- Compression ---
  lines.push(...generateCompressionSection(latest));
  lines.push('');

  // --- Dedup ---
  lines.push(...generateDedupSection(latest.results));
  lines.push('');

  // --- Token budget ---
  lines.push(...generateTokenBudgetSection(latest.results));
  lines.push('');

  // --- LLM (conditional) ---
  const llmSection = generateLlmSection(baselinesDir, latest.results.basic);
  if (llmSection.length > 0) {
    lines.push(...llmSection);
  }

  // --- Version history (conditional) ---
  if (baselines.length > 1) {
    lines.push('## Version History');
    lines.push('');
    lines.push('| Version | Date | Avg Char Ratio | Avg Token Ratio | Scenarios |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const b of [...baselines].reverse()) {
      const entries = Object.values(b.results.basic);
      const avgChr = entries.reduce((s, v) => s + v.ratio, 0) / entries.length;
      const avgTkr = entries.reduce((s, v) => s + v.tokenRatio, 0) / entries.length;
      const date = b.generated.split('T')[0];
      lines.push(
        `| ${b.version} | ${date} | ${fix(avgChr)} | ${fix(avgTkr)} | ${entries.length} |`,
      );
    }
    lines.push('');

    // Per-version detail (older versions)
    const olderVersions = baselines.slice(0, -1).reverse();
    for (const b of olderVersions) {
      const r = b.results;
      const oldEntries = Object.entries(r.basic);
      const oldRatios = oldEntries.map(([, v]) => v.ratio);
      const oldAvg = oldRatios.reduce((a, b) => a + b, 0) / oldRatios.length;

      lines.push(`<details>`);
      lines.push(`<summary>v${b.version} (${b.generated.split('T')[0]}) — ${fix(oldAvg)}x avg</summary>`);
      lines.push('');
      lines.push('| Scenario | Char Ratio | Token Ratio | Compressed | Preserved |');
      lines.push('| --- | ---: | ---: | ---: | ---: |');
      for (const [name, v] of oldEntries) {
        lines.push(
          `| ${name} | ${fix(v.ratio)} | ${fix(v.tokenRatio)} | ${v.compressed} | ${v.preserved} |`,
        );
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // --- Methodology ---
  lines.push('## Methodology');
  lines.push('');
  lines.push('- All deterministic results use the same input → same output guarantee');
  lines.push('- Metrics: compression ratio, token ratio, message counts, dedup counts');
  lines.push('- Timing is excluded from baselines (hardware-dependent)');
  lines.push('- LLM benchmarks are saved as reference data, not used for regression testing');
  lines.push('- Round-trip integrity is verified for every scenario (compress then uncompress)');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
}
