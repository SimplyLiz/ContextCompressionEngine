#!/usr/bin/env npx tsx
/**
 * A/B Comparison Tool
 *
 * Compresses the same input with two different option sets and shows a
 * side-by-side comparison of ratio, quality, entity retention, and output.
 *
 * Usage:
 *   npx tsx bench/compare.ts [--scenario <name>]
 *
 * Compares default options vs. all v2 features enabled.
 */

import { compress, defaultTokenCounter } from '../src/compress.js';
import type { CompressOptions, CompressResult, Message } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function msg(role: string, content: string): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {} };
}

function tokens(result: CompressResult): number {
  return result.messages.reduce((sum, m) => sum + defaultTokenCounter(m), 0);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = { name: string; messages: Message[] };

function buildScenarios(): Scenario[] {
  nextId = 1;
  return [codingAssistant(), deepConversation(), agenticSession()];
}

function codingAssistant(): Scenario {
  const prose =
    'The authentication middleware validates incoming JWT tokens against the session store, checks expiration timestamps, and refreshes tokens when they are within the renewal window. ';
  return {
    name: 'Coding assistant',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),
      msg('user', 'How do I set up Express middleware for JWT auth?'),
      msg(
        'assistant',
        `${prose.repeat(3)}\n\n\`\`\`typescript\nimport jwt from 'jsonwebtoken';\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'No token' });\n  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }\n  catch { res.status(401).json({ error: 'Invalid token' }); }\n}\n\`\`\``,
      ),
      msg('user', 'Can you add refresh token rotation?'),
      msg(
        'assistant',
        `${prose.repeat(4)} The refresh token rotation ensures single-use tokens prevent replay attacks.`,
      ),
      msg('user', 'What about rate limiting?'),
      msg('assistant', `Rate limiting prevents abuse. ${prose.repeat(3)}`),
      msg('user', 'Thanks, very helpful!'),
      msg('assistant', 'Happy to help. Let me know if you need anything else.'),
    ],
  };
}

function deepConversation(): Scenario {
  const filler =
    'I think that sounds reasonable and we should continue with the current approach. ';
  const technical =
    'The fetchData function uses exponential backoff with a base delay of 200ms and a maximum of 5 retries before throwing ServiceUnavailable. ';
  return {
    name: 'Deep conversation',
    messages: [
      msg('system', 'You are a helpful assistant.'),
      ...Array.from({ length: 20 }, (_, i) =>
        msg(
          i % 2 === 0 ? 'user' : 'assistant',
          i % 5 === 0
            ? technical.repeat(3)
            : i % 3 === 0
              ? `Actually, use Memcached instead of Redis for caching. ${technical}`
              : filler.repeat(4),
        ),
      ),
      msg('user', 'What should we do next?'),
    ],
  };
}

function agenticSession(): Scenario {
  return {
    name: 'Agentic session',
    messages: [
      msg('system', 'You are an AI coding assistant with tool access.'),
      msg('user', 'Fix the failing tests in the auth module.'),
      msg('assistant', "I'll look at the test output first."),
      msg('assistant', 'Tool call: run_tests(path="tests/auth")'),
      msg(
        'user',
        'PASS tests/auth/login.test.ts\nFAIL tests/auth/refresh.test.ts\n  Expected: 200\n  Received: 401\n\n  at tests/auth/refresh.test.ts:42:5',
      ),
      msg(
        'assistant',
        'The refresh test is failing because the token rotation logic has a timing issue. Let me check the implementation.',
      ),
      msg('assistant', 'Tool call: read_file(path="src/auth/refresh.ts")'),
      msg(
        'user',
        'export async function refreshToken(old: string) {\n  const payload = jwt.verify(old, REFRESH_SECRET);\n  await revokeToken(old);\n  return jwt.sign({ sub: payload.sub }, ACCESS_SECRET, { expiresIn: "15m" });\n}',
      ),
      msg(
        'assistant',
        'Found it — the function revokes the old token before creating the new one. If the verification fails after revocation, the user loses their session. Let me fix this.',
      ),
      msg('assistant', 'Tool call: edit_file(path="src/auth/refresh.ts", changes=[...])'),
      msg('user', 'File updated.'),
      msg('assistant', 'Now let me re-run the tests to verify the fix.'),
      msg('assistant', 'Tool call: run_tests(path="tests/auth")'),
      msg(
        'user',
        'PASS tests/auth/login.test.ts\nPASS tests/auth/refresh.test.ts\n\nTests: 2 passed, 2 total',
      ),
      msg(
        'assistant',
        'All tests pass now. The fix was to create the new token before revoking the old one.',
      ),
      msg('user', 'Great, thanks!'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

type OptionSet = { name: string; options: CompressOptions };

const optionSets: OptionSet[] = [
  {
    name: 'Default (v1)',
    options: { recencyWindow: 4 },
  },
  {
    name: 'V2 features',
    options: {
      recencyWindow: 4,
      relevanceThreshold: 3,
      conversationFlow: true,
      coreference: true,
      importanceScoring: true,
      contradictionDetection: true,
    },
  },
];

function formatNum(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function runComparison(scenario: Scenario): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${scenario.name} (${scenario.messages.length} messages)`);
  console.log(`${'='.repeat(70)}`);

  const results: Array<{ name: string; result: CompressResult }> = [];

  for (const os of optionSets) {
    const result = compress(scenario.messages, os.options) as CompressResult;
    results.push({ name: os.name, result });
  }

  // Header
  const colWidth = 25;
  const header = ['Metric'.padEnd(colWidth), ...results.map((r) => r.name.padEnd(colWidth))].join(
    ' | ',
  );
  console.log(`\n  ${header}`);
  console.log(`  ${'-'.repeat(header.length)}`);

  // Rows
  const rows: Array<[string, ...string[]]> = [
    ['Compression ratio', ...results.map((r) => `${formatNum(r.result.compression.ratio)}x`)],
    ['Token ratio', ...results.map((r) => `${formatNum(r.result.compression.token_ratio)}x`)],
    [
      'Messages compressed',
      ...results.map((r) => String(r.result.compression.messages_compressed)),
    ],
    ['Messages preserved', ...results.map((r) => String(r.result.compression.messages_preserved))],
    [
      'Entity retention',
      ...results.map((r) =>
        r.result.compression.entity_retention != null
          ? `${formatNum(r.result.compression.entity_retention * 100, 1)}%`
          : 'N/A',
      ),
    ],
    [
      'Structural integrity',
      ...results.map((r) =>
        r.result.compression.structural_integrity != null
          ? `${formatNum(r.result.compression.structural_integrity * 100, 1)}%`
          : 'N/A',
      ),
    ],
    [
      'Quality score',
      ...results.map((r) =>
        r.result.compression.quality_score != null
          ? formatNum(r.result.compression.quality_score, 3)
          : 'N/A',
      ),
    ],
    ['Output tokens', ...results.map((r) => String(tokens(r.result)))],
    ['Verbatim entries', ...results.map((r) => String(Object.keys(r.result.verbatim).length))],
  ];

  for (const [label, ...values] of rows) {
    const row = [label.padEnd(colWidth), ...values.map((v) => v.padEnd(colWidth))].join(' | ');
    console.log(`  ${row}`);
  }

  // Delta
  if (results.length === 2) {
    const [a, b] = results;
    const ratioDelta = (
      (b.result.compression.ratio / a.result.compression.ratio - 1) *
      100
    ).toFixed(1);
    const tokenDelta = tokens(a.result) - tokens(b.result);
    console.log(`\n  Delta: ${ratioDelta}% ratio improvement, ${tokenDelta} tokens saved`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const targetScenario = process.argv.find((_, i) => process.argv[i - 1] === '--scenario');
const scenarios = buildScenarios();

console.log('CCE A/B Comparison Tool');
console.log(`Comparing: ${optionSets.map((o) => o.name).join(' vs ')}`);

for (const scenario of scenarios) {
  if (targetScenario && scenario.name.toLowerCase() !== targetScenario.toLowerCase()) continue;
  runComparison(scenario);
}

console.log('\n');
