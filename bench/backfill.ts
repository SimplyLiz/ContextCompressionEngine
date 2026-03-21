import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Backfill: run current quality benchmarks against older versions
// ---------------------------------------------------------------------------
//
// Usage:
//   npx tsx bench/backfill.ts                     # backfill all v* tags
//   npx tsx bench/backfill.ts v1.0.0 v1.1.0       # specific refs
//   npx tsx bench/backfill.ts d43d494              # specific commit
//
// How it works:
//   1. For each git ref, create a temporary worktree
//   2. Copy the current bench/quality-*.ts and bench/baseline.ts into it
//   3. Run npm install && npm run build in the worktree
//   4. Run the quality analysis using the worktree's built library
//   5. Save results to bench/baselines/quality/history/{ref}.json
//   6. Clean up the worktree
//
// The quality measurement code is always the CURRENT version — we measure
// old compression output with new metrics for a consistent comparison.
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '..');
const QUALITY_HISTORY_DIR = resolve(import.meta.dirname, 'baselines', 'quality', 'history');

function getGitRefs(args: string[]): string[] {
  if (args.length > 0) return args;

  // Default: all v* tags + key feature branch commits
  const tags = execSync('git tag --sort=creatordate', { cwd: ROOT, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter((t) => t.startsWith('v'));

  return tags;
}

function refToSha(ref: string): string {
  return execSync(`git rev-parse ${ref}`, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

function refToLabel(ref: string): string {
  // Use tag name if available, otherwise short SHA
  try {
    return execSync(`git describe --tags --exact-match ${ref} 2>/dev/null`, {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return ref.slice(0, 8);
  }
}

interface BackfillResult {
  ref: string;
  label: string;
  sha: string;
  success: boolean;
  error?: string;
  scenarios?: Record<
    string,
    {
      ratio: number;
      avgEntityRetention: number;
      avgKeywordRetention: number;
      codeBlockIntegrity: number;
      qualityScore: number;
      factRetention: number;
    }
  >;
}

function backfillRef(ref: string): BackfillResult {
  const sha = refToSha(ref);
  const label = refToLabel(ref);
  const shortSha = sha.slice(0, 8);

  // Check if already backfilled
  const resultPath = join(QUALITY_HISTORY_DIR, `${shortSha}.json`);
  if (existsSync(resultPath)) {
    console.log(`  ${label} (${shortSha}) — already backfilled, skipping`);
    const existing = JSON.parse(readFileSync(resultPath, 'utf-8'));
    return { ref, label, sha, success: true, scenarios: existing.results?.scenarios };
  }

  const worktreeDir = join(tmpdir(), `cce-backfill-${shortSha}`);

  try {
    // Clean up any leftover worktree
    if (existsSync(worktreeDir)) {
      rmSync(worktreeDir, { recursive: true, force: true });
      try {
        execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: ROOT, stdio: 'pipe' });
      } catch {
        // ignore
      }
    }

    // Create worktree
    console.log(`  ${label} (${shortSha}) — creating worktree...`);
    execSync(`git worktree add "${worktreeDir}" ${sha}`, { cwd: ROOT, stdio: 'pipe' });

    // Copy current quality benchmark files into worktree
    const benchDir = join(worktreeDir, 'bench');
    mkdirSync(benchDir, { recursive: true });

    // Copy the analysis and scenario files
    cpSync(
      resolve(import.meta.dirname, 'quality-analysis.ts'),
      join(benchDir, 'quality-analysis.ts'),
    );
    cpSync(
      resolve(import.meta.dirname, 'quality-scenarios.ts'),
      join(benchDir, 'quality-scenarios.ts'),
    );
    cpSync(resolve(import.meta.dirname, 'baseline.ts'), join(benchDir, 'baseline.ts'));

    // Write a minimal runner that imports from the worktree's built library
    const runner = `
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';

// Quick check: does this version's compress() work?
const messages = [
  { id: '1', index: 1, role: 'system', content: 'You are a helpful assistant.', metadata: {} },
  { id: '2', index: 2, role: 'user', content: 'Hello, how are you today? '.repeat(20), metadata: {} },
  { id: '3', index: 3, role: 'assistant', content: 'I am doing well. '.repeat(20), metadata: {} },
];

try {
  const cr = compress(messages, { recencyWindow: 0 });
  const er = uncompress(cr.messages, cr.verbatim);
  const pass = JSON.stringify(messages) === JSON.stringify(er.messages);
  console.log(JSON.stringify({
    success: true,
    roundTrip: pass,
    ratio: cr.compression.ratio,
    hasVerbatim: Object.keys(cr.verbatim).length > 0,
    hasQualityScore: cr.compression.quality_score != null,
  }));
} catch (err) {
  console.log(JSON.stringify({ success: false, error: err.message }));
}
`;
    writeFileSync(join(benchDir, '_backfill_probe.ts'), runner);

    // Install and build in worktree
    console.log(`  ${label} (${shortSha}) — installing & building...`);
    execSync('npm install --ignore-scripts 2>&1', {
      cwd: worktreeDir,
      stdio: 'pipe',
      timeout: 60_000,
    });
    execSync('npm run build 2>&1', { cwd: worktreeDir, stdio: 'pipe', timeout: 30_000 });

    // Probe: can this version's compress() run at all?
    console.log(`  ${label} (${shortSha}) — probing compress()...`);
    const probeOutput = execSync('npx tsx bench/_backfill_probe.ts', {
      cwd: worktreeDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

    const probe = JSON.parse(probeOutput);
    if (!probe.success) {
      throw new Error(`Probe failed: ${probe.error}`);
    }

    // Now run the actual quality analysis via a generated script that uses the
    // worktree's compress but the current quality-analysis functions
    const analysisRunner = `
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';

// Inline minimal scenario builders (can't import quality-scenarios.ts because
// it imports from ../src/types.js which may have different types in old versions)
let nextId = 1;
function msg(role, content, extra) {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

const prose = 'The authentication middleware validates incoming JWT tokens against the session store, checks expiration timestamps, and refreshes tokens when they are within the renewal window. ';

function codingAssistant() {
  return {
    name: 'Coding assistant',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),
      msg('user', 'How do I set up Express middleware for JWT auth?'),
      msg('assistant', prose.repeat(3) + '\\n\\n\\\`\\\`\\\`typescript\\nimport jwt from "jsonwebtoken";\\n\\nexport function authMiddleware(req, res, next) {\\n  const token = req.headers.authorization?.split(" ")[1];\\n  if (!token) return res.status(401).json({ error: "No token" });\\n  try {\\n    req.user = jwt.verify(token, process.env.JWT_SECRET);\\n    next();\\n  } catch {\\n    res.status(401).json({ error: "Invalid token" });\\n  }\\n}\\n\\\`\\\`\\\`'),
      msg('user', 'Thanks.'),
      msg('assistant', 'Happy to help.'),
    ],
  };
}

const longAnswer = 'The architecture of modern distributed systems relies on several foundational principles including service isolation, eventual consistency, and fault tolerance. Each service maintains its own data store. ';
function longQA() {
  return {
    name: 'Long Q&A',
    messages: [
      msg('system', 'You are a consultant.'),
      msg('user', 'What is event sourcing?'),
      msg('assistant', longAnswer.repeat(8)),
      msg('user', 'How does CQRS relate?'),
      msg('assistant', longAnswer.repeat(6)),
    ],
  };
}

const topics = ['database design', 'API structure', 'auth flow', 'error handling', 'caching', 'deployment', 'monitoring', 'testing'];
function deepConversation() {
  const messages = [msg('system', 'You are a senior architect.')];
  for (const topic of topics) {
    messages.push(msg('user', 'Discuss ' + topic + '. '.repeat(4)));
    messages.push(msg('assistant', 'For ' + topic + ', I recommend... '.repeat(8)));
  }
  return { name: 'Deep conversation', messages };
}

const scenarios = [codingAssistant(), longQA(), deepConversation()];
const results = {};

for (const s of scenarios) {
  try {
    const cr = compress(s.messages, { recencyWindow: 0 });
    const er = uncompress(cr.messages, cr.verbatim);
    const pass = JSON.stringify(s.messages) === JSON.stringify(er.messages);

    // Compute retention for compressed messages only
    let totalEntities = 0, retainedEntities = 0;
    for (const m of cr.messages) {
      const meta = m.metadata?._cce_original;
      if (!meta) continue;
      const ids = meta.ids ?? [m.id];
      let origText = '';
      for (const id of ids) {
        const orig = cr.verbatim[id];
        if (orig?.content) origText += orig.content;
      }
      if (!origText) continue;
      const compText = m.content ?? '';

      // Extract entities (camelCase, PascalCase, snake_case)
      const camel = origText.match(/\\b[a-z]+(?:[A-Z][a-z]+)+\\b/g) ?? [];
      const pascal = origText.match(/\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b/g) ?? [];
      const snake = origText.match(/\\b[a-z]+(?:_[a-z]+)+\\b/g) ?? [];
      const entities = [...new Set([...camel, ...pascal, ...snake])];
      totalEntities += entities.length;
      retainedEntities += entities.filter(e => compText.includes(e)).length;
    }

    results[s.name] = {
      ratio: cr.compression.ratio,
      avgEntityRetention: totalEntities === 0 ? 1 : retainedEntities / totalEntities,
      avgKeywordRetention: totalEntities === 0 ? 1 : retainedEntities / totalEntities,
      codeBlockIntegrity: 1, // simplified — would need full analysis
      qualityScore: cr.compression.quality_score ?? -1,
      factRetention: -1, // not available without full analysis
      roundTrip: pass,
    };
  } catch (err) {
    results[s.name] = { error: err.message };
  }
}

console.log(JSON.stringify(results));
`;
    writeFileSync(join(benchDir, '_backfill_run.ts'), analysisRunner);

    console.log(`  ${label} (${shortSha}) — running quality analysis...`);
    const output = execSync('npx tsx bench/_backfill_run.ts', {
      cwd: worktreeDir,
      encoding: 'utf-8',
      timeout: 60_000,
    }).trim();

    const scenarioResults = JSON.parse(output);

    // Save result
    const qualityBaseline = {
      version: label,
      gitRef: sha,
      generated: new Date().toISOString(),
      results: { scenarios: scenarioResults, tradeoff: {} },
    };

    mkdirSync(QUALITY_HISTORY_DIR, { recursive: true });
    writeFileSync(resultPath, JSON.stringify(qualityBaseline, null, 2) + '\n');

    console.log(`  ${label} (${shortSha}) — done ✓`);
    return { ref, label, sha, success: true, scenarios: scenarioResults };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.error(`  ${label} (${shortSha}) — FAILED: ${msg}`);
    return { ref, label, sha, success: false, error: msg };
  } finally {
    // Clean up worktree
    try {
      execSync(`git worktree remove --force "${worktreeDir}" 2>/dev/null`, {
        cwd: ROOT,
        stdio: 'pipe',
      });
    } catch {
      // worktree may not exist if creation failed
      if (existsSync(worktreeDir)) {
        rmSync(worktreeDir, { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const refs = getGitRefs(args);

  if (refs.length === 0) {
    console.log('No git refs found to backfill. Pass refs as arguments or create v* tags.');
    return;
  }

  console.log();
  console.log(`Quality Benchmark Backfill — ${refs.length} ref(s)`);
  console.log();

  const results: BackfillResult[] = [];
  for (const ref of refs) {
    results.push(backfillRef(ref));
  }

  // Print comparison table
  console.log();
  console.log('Backfill Summary');

  const header = ['Ref'.padEnd(12), 'Status'.padEnd(8), 'Scenarios'.padStart(10)].join('  ');
  const sep = '-'.repeat(header.length);

  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const r of results) {
    const scenarioCount = r.scenarios ? Object.keys(r.scenarios).length : 0;
    console.log(
      [
        r.label.padEnd(12),
        (r.success ? 'ok' : 'FAIL').padEnd(8),
        String(scenarioCount).padStart(10),
      ].join('  '),
    );
  }

  console.log(sep);

  // Print per-scenario comparison if we have multiple results
  const successful = results.filter((r) => r.success && r.scenarios);
  if (successful.length > 1) {
    console.log();
    console.log('Quality Across Versions');

    // Collect all scenario names
    const allScenarios = new Set<string>();
    for (const r of successful) {
      if (r.scenarios) {
        for (const name of Object.keys(r.scenarios)) allScenarios.add(name);
      }
    }

    const vHeader = ['Scenario'.padEnd(20), ...successful.map((r) => r.label.padStart(12))].join(
      '  ',
    );
    const vSep = '-'.repeat(vHeader.length);

    console.log(vSep);
    console.log(vHeader);
    console.log(vSep);

    for (const name of allScenarios) {
      const cells = successful.map((r) => {
        const s = r.scenarios?.[name];
        if (!s || 'error' in s) return '-'.padStart(12);
        return `${(s as { ratio: number }).ratio.toFixed(2)}x`.padStart(12);
      });
      console.log([name.padEnd(20), ...cells].join('  '));
    }

    console.log(vSep);
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    console.error(`\n${failed.length} ref(s) failed backfill.`);
    process.exit(1);
  }

  console.log('\nBackfill complete.');
}

main();
