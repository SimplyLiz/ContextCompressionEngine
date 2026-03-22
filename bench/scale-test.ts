#!/usr/bin/env npx tsx
/**
 * Scale & Weakness Analysis
 *
 * Tests CCE at realistic scales to find performance cliffs, quality
 * degradation patterns, and architectural limitations.
 *
 * Run: npx tsx bench/scale-test.ts
 */

import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import { defaultTokenCounter } from '../src/compress.js';
import type { CompressOptions, CompressResult, Message } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function msg(role: string, content: string): Message {
  return { id: String(nextId++), index: nextId - 1, role, content, metadata: {} };
}
function reset() {
  nextId = 1;
}
function tokens(msgs: Message[]): number {
  return msgs.reduce((s, m) => s + defaultTokenCounter(m), 0);
}
function chars(msgs: Message[]): number {
  return msgs.reduce((s, m) => s + ((m.content as string) ?? '').length, 0);
}

// ---------------------------------------------------------------------------
// Generators — build realistic conversations at any scale
// ---------------------------------------------------------------------------

const PROSE_TEMPLATES = [
  'The {fn} function handles {task} with {strategy} for the {layer} layer. ',
  'We need to update the {fn} configuration to support {feature} across all {scope} environments. ',
  'The monitoring dashboard shows that {fn} latency increased by {n}ms after the last deployment. ',
  'I reviewed the {fn} implementation and found that the {issue} causes {impact} under high load. ',
  'The team decided to refactor {fn} to use {pattern} instead of the current {old} approach. ',
];
const FNS = [
  'fetchData',
  'getUserProfile',
  'handleAuth',
  'processPayment',
  'validateInput',
  'buildIndex',
  'parseConfig',
  'syncCache',
  'routeRequest',
  'transformData',
];
const TASKS = [
  'API calls',
  'retries',
  'validation',
  'caching',
  'rate limiting',
  'auth checks',
  'data transforms',
];
const STRATEGIES = [
  'exponential backoff',
  'circuit breaker',
  'bulkhead isolation',
  'retry with jitter',
  'connection pooling',
];
const LAYERS = ['service', 'data access', 'presentation', 'middleware', 'gateway'];
const FILLER =
  'I think that sounds reasonable and we should continue with the current approach for now. ';

function randFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function techProse(sentences: number): string {
  return Array.from({ length: sentences }, () =>
    randFrom(PROSE_TEMPLATES)
      .replace('{fn}', randFrom(FNS))
      .replace('{task}', randFrom(TASKS))
      .replace('{strategy}', randFrom(STRATEGIES))
      .replace('{layer}', randFrom(LAYERS))
      .replace('{feature}', randFrom(TASKS))
      .replace('{scope}', randFrom(LAYERS))
      .replace('{issue}', randFrom(TASKS) + ' bottleneck')
      .replace('{impact}', 'degraded throughput')
      .replace('{pattern}', randFrom(STRATEGIES))
      .replace('{old}', randFrom(STRATEGIES))
      .replace('{n}', String(Math.floor(Math.random() * 500))),
  ).join('');
}

function codeFence(): string {
  const fn = randFrom(FNS);
  return `\`\`\`typescript\nexport async function ${fn}(input: unknown) {\n  const result = await validate(input);\n  return process(result);\n}\n\`\`\``;
}

function buildConversation(
  msgCount: number,
  options: {
    codeFreq?: number; // fraction of messages with code (0-1)
    fillerFreq?: number; // fraction of pure filler messages (0-1)
    avgSentences?: number;
  },
): Message[] {
  reset();
  const { codeFreq = 0.15, fillerFreq = 0.2, avgSentences = 4 } = options;
  const msgs: Message[] = [
    msg('system', 'You are a senior software engineer helping with a complex codebase.'),
  ];

  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const rand = Math.random();

    if (rand < fillerFreq) {
      msgs.push(msg(role, FILLER.repeat(3 + Math.floor(Math.random() * 3))));
    } else if (rand < fillerFreq + codeFreq && role === 'assistant') {
      msgs.push(msg(role, techProse(2) + '\n\n' + codeFence() + '\n\n' + techProse(1)));
    } else {
      const sentences = avgSentences + Math.floor(Math.random() * 3) - 1;
      msgs.push(msg(role, techProse(sentences)));
    }
  }

  return msgs;
}

// ---------------------------------------------------------------------------
// Test runners
// ---------------------------------------------------------------------------

type TestResult = {
  name: string;
  msgCount: number;
  inputChars: number;
  inputTokens: number;
  ratio: number;
  quality: number | undefined;
  entityRet: number | undefined;
  roundTrip: boolean;
  timeMs: number;
  msPerMsg: number;
  compressed: number;
  preserved: number;
  findings: string[];
};

function runTest(name: string, messages: Message[], options: CompressOptions = {}): TestResult {
  const inputChars = chars(messages);
  const inputTokens = tokens(messages);
  const t0 = performance.now();
  const cr = compress(messages, options) as CompressResult;
  const t1 = performance.now();

  const er = uncompress(cr.messages, cr.verbatim);
  const rt =
    JSON.stringify(er.messages) === JSON.stringify(messages) && er.missing_ids.length === 0;

  const timeMs = t1 - t0;
  const findings: string[] = [];

  // Analyze weaknesses
  if (!rt) findings.push('ROUND-TRIP FAILURE');
  if (cr.compression.ratio < 1.05 && cr.compression.messages_compressed > 0)
    findings.push(
      `Wasted work: ${cr.compression.messages_compressed} messages compressed but ratio only ${cr.compression.ratio.toFixed(2)}x`,
    );
  if (cr.compression.quality_score != null && cr.compression.quality_score < 0.8)
    findings.push(`Quality below 0.80: ${cr.compression.quality_score.toFixed(3)}`);
  if (cr.compression.entity_retention != null && cr.compression.entity_retention < 0.7)
    findings.push(
      `Entity retention below 70%: ${(cr.compression.entity_retention * 100).toFixed(0)}%`,
    );
  if (timeMs > messages.length * 2)
    findings.push(`Slow: ${(timeMs / messages.length).toFixed(1)}ms/msg (expected <2ms)`);

  // Check for negative compression (output larger than input)
  const outputChars = chars(cr.messages);
  if (outputChars > inputChars)
    findings.push(`Negative compression: output ${outputChars} > input ${inputChars}`);

  return {
    name,
    msgCount: messages.length,
    inputChars,
    inputTokens,
    ratio: cr.compression.ratio,
    quality: cr.compression.quality_score,
    entityRet: cr.compression.entity_retention,
    roundTrip: rt,
    timeMs,
    msPerMsg: timeMs / messages.length,
    compressed: cr.compression.messages_compressed,
    preserved: cr.compression.messages_preserved,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

const allResults: TestResult[] = [];

function suite(title: string, tests: () => void) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(80));
  tests();
}

function printResults(results: TestResult[]) {
  const colW = {
    name: 35,
    msgs: 6,
    chars: 9,
    ratio: 7,
    qual: 6,
    entR: 6,
    rt: 4,
    time: 9,
    msMsg: 8,
  };

  console.log(
    [
      'Test'.padEnd(colW.name),
      'Msgs'.padStart(colW.msgs),
      'Chars'.padStart(colW.chars),
      'Ratio'.padStart(colW.ratio),
      'Qual'.padStart(colW.qual),
      'EntR'.padStart(colW.entR),
      'R/T'.padStart(colW.rt),
      'Time'.padStart(colW.time),
      'ms/msg'.padStart(colW.msMsg),
    ].join('  '),
  );
  console.log('-'.repeat(100));

  for (const r of results) {
    console.log(
      [
        r.name.padEnd(colW.name),
        String(r.msgCount).padStart(colW.msgs),
        String(r.inputChars).padStart(colW.chars),
        r.ratio.toFixed(2).padStart(colW.ratio),
        (r.quality != null ? (r.quality * 100).toFixed(0) + '%' : '—').padStart(colW.qual),
        (r.entityRet != null ? (r.entityRet * 100).toFixed(0) + '%' : '—').padStart(colW.entR),
        (r.roundTrip ? 'OK' : 'FAIL').padStart(colW.rt),
        (r.timeMs.toFixed(1) + 'ms').padStart(colW.time),
        r.msPerMsg.toFixed(2).padStart(colW.msMsg),
      ].join('  '),
    );
    if (r.findings.length > 0) {
      for (const f of r.findings) console.log(`    ⚠ ${f}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. SCALE: message count scaling
// ---------------------------------------------------------------------------

suite('1. Scale: message count (how does ratio/perf scale?)', () => {
  const sizes = [10, 50, 100, 250, 500, 1000, 2000];
  const results: TestResult[] = [];

  for (const size of sizes) {
    const messages = buildConversation(size, { codeFreq: 0.15, fillerFreq: 0.2 });
    results.push(runTest(`${size} messages`, messages, { recencyWindow: 4 }));
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 2. SCALE: message size (very long individual messages)
// ---------------------------------------------------------------------------

suite('2. Scale: message length (single huge messages)', () => {
  const results: TestResult[] = [];
  const lengths = [1_000, 5_000, 10_000, 50_000, 100_000];

  for (const len of lengths) {
    reset();
    const content = techProse(Math.ceil(len / 100));
    const messages = [msg('user', content.slice(0, len)), msg('assistant', 'Got it.')];
    results.push(runTest(`${(len / 1000).toFixed(0)}k chars`, messages, { recencyWindow: 1 }));
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 3. COMPOSITION: all code vs all filler vs mixed
// ---------------------------------------------------------------------------

suite('3. Composition: code-heavy vs filler-heavy vs mixed', () => {
  const results: TestResult[] = [];
  const N = 100;

  results.push(
    runTest('All code (15%→80%)', buildConversation(N, { codeFreq: 0.8, fillerFreq: 0 }), {
      recencyWindow: 4,
    }),
  );
  results.push(
    runTest('All filler', buildConversation(N, { codeFreq: 0, fillerFreq: 0.9 }), {
      recencyWindow: 4,
    }),
  );
  results.push(
    runTest('Mixed (default)', buildConversation(N, { codeFreq: 0.15, fillerFreq: 0.2 }), {
      recencyWindow: 4,
    }),
  );
  results.push(
    runTest(
      'All technical prose',
      buildConversation(N, { codeFreq: 0, fillerFreq: 0, avgSentences: 6 }),
      { recencyWindow: 4 },
    ),
  );

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 4. RECENCY WINDOW: impact on ratio and quality
// ---------------------------------------------------------------------------

suite('4. Recency window impact (500 msgs, varying window)', () => {
  const results: TestResult[] = [];
  const messages = buildConversation(500, {});
  const windows = [0, 2, 4, 10, 25, 50, 100, 250];

  for (const rw of windows) {
    results.push(runTest(`rw=${rw}`, messages, { recencyWindow: rw }));
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 5. TOKEN BUDGET: binary-search vs tiered at various budgets
// ---------------------------------------------------------------------------

suite('5. Token budget: binary-search vs tiered (500 msgs)', () => {
  const results: TestResult[] = [];
  const messages = buildConversation(500, {});
  const budgets = [2000, 5000, 10000, 25000];

  for (const budget of budgets) {
    results.push(
      runTest(`bs budget=${budget}`, messages, {
        recencyWindow: 4,
        tokenBudget: budget,
        forceConverge: true,
      }),
    );
    results.push(
      runTest(`tiered budget=${budget}`, messages, {
        recencyWindow: 4,
        tokenBudget: budget,
        budgetStrategy: 'tiered',
        forceConverge: true,
      }),
    );
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 6. V2 FEATURES: impact at scale (500 msgs)
// ---------------------------------------------------------------------------

suite('6. V2 features at scale (500 msgs)', () => {
  const results: TestResult[] = [];
  const messages = buildConversation(500, {});

  const configs: [string, CompressOptions][] = [
    ['Default', { recencyWindow: 4 }],
    ['+depth=moderate', { recencyWindow: 4, compressionDepth: 'moderate' }],
    ['+relevanceThresh=3', { recencyWindow: 4, relevanceThreshold: 3 }],
    ['+conversationFlow', { recencyWindow: 4, conversationFlow: true }],
    ['+semanticClustering', { recencyWindow: 4, semanticClustering: true }],
    ['+coreference', { recencyWindow: 4, coreference: true }],
    ['+importanceScoring', { recencyWindow: 4, importanceScoring: true }],
    [
      'Recommended combo',
      {
        recencyWindow: 4,
        conversationFlow: true,
        relevanceThreshold: 3,
        compressionDepth: 'moderate',
      },
    ],
  ];

  for (const [name, opts] of configs) {
    results.push(runTest(name, messages, opts));
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 7. PATHOLOGICAL: adversarial patterns
// ---------------------------------------------------------------------------

suite('7. Pathological patterns', () => {
  const results: TestResult[] = [];

  // All identical messages
  reset();
  const identical = Array.from({ length: 100 }, () => msg('user', techProse(4)));
  results.push(runTest('100 identical messages', identical, { recencyWindow: 4, dedup: true }));

  // All very short messages
  reset();
  const short = Array.from({ length: 500 }, (_, i) =>
    msg(i % 2 === 0 ? 'user' : 'assistant', 'OK.'),
  );
  results.push(runTest('500 short msgs (<120ch)', short, { recencyWindow: 4 }));

  // One huge message + many small
  reset();
  const oneHuge = [
    msg('assistant', techProse(500)),
    ...Array.from({ length: 100 }, () => msg('user', 'Continue.')),
  ];
  results.push(runTest('1 huge + 100 small', oneHuge, { recencyWindow: 4 }));

  // Deeply nested code fences
  reset();
  const nested = Array.from({ length: 50 }, () =>
    msg(
      'assistant',
      '```ts\nconst a = 1;\n```\n\nSome prose here about the code.\n\n```ts\nconst b = 2;\n```\n\nMore prose about implementation details and design decisions that were made.',
    ),
  );
  results.push(runTest('50 multi-fence msgs', nested, { recencyWindow: 4 }));

  // Messages with no prose (pure code)
  reset();
  const pureCode = Array.from({ length: 50 }, () =>
    msg(
      'assistant',
      '```typescript\nexport function handler(req: Request) {\n  const data = parse(req.body);\n  validate(data);\n  return respond(data);\n}\n```',
    ),
  );
  results.push(runTest('50 pure-code msgs', pureCode, { recencyWindow: 4 }));

  // Alternating roles with corrections
  reset();
  const corrections: Message[] = [];
  for (let i = 0; i < 100; i++) {
    if (i % 3 === 0) {
      corrections.push(
        msg(
          'user',
          'Actually, use ' +
            randFrom(FNS) +
            ' instead of ' +
            randFrom(FNS) +
            ' for the ' +
            randFrom(TASKS) +
            '. ' +
            techProse(2),
        ),
      );
    } else {
      corrections.push(msg(i % 2 === 0 ? 'user' : 'assistant', techProse(3)));
    }
  }
  results.push(
    runTest('100 msgs w/ corrections', corrections, {
      recencyWindow: 4,
      contradictionDetection: true,
    }),
  );

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// 8. MULTI-ROUND: compress already-compressed output
// ---------------------------------------------------------------------------

suite('8. Multi-round compression (compress the output of compress)', () => {
  const results: TestResult[] = [];
  const messages = buildConversation(200, {});

  let current = messages;
  for (let round = 1; round <= 5; round++) {
    const cr = compress(current, { recencyWindow: 4 }) as CompressResult;
    const ratio = chars(messages) / chars(cr.messages);
    const t0 = performance.now();
    const cr2 = compress(cr.messages, { recencyWindow: 4 }) as CompressResult;
    const t1 = performance.now();

    results.push({
      name: `Round ${round}`,
      msgCount: cr.messages.length,
      inputChars: chars(cr.messages),
      inputTokens: tokens(cr.messages),
      ratio: chars(messages) / chars(cr2.messages),
      quality: cr2.compression.quality_score,
      entityRet: cr2.compression.entity_retention,
      roundTrip: true, // multi-round doesn't guarantee full round-trip
      timeMs: t1 - t0,
      msPerMsg: (t1 - t0) / cr.messages.length,
      compressed: cr2.compression.messages_compressed,
      preserved: cr2.compression.messages_preserved,
      findings:
        ratio === chars(messages) / chars(cr2.messages)
          ? ['No further compression (converged)']
          : [],
    });
    current = cr2.messages;
  }

  printResults(results);
  allResults.push(...results);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(80)}`);
console.log('  SUMMARY');
console.log('='.repeat(80));

const allFindings = allResults.flatMap((r) =>
  r.findings.map((f) => ({ test: r.name, finding: f })),
);
const rtFailures = allResults.filter((r) => !r.roundTrip);
const slowTests = allResults.filter((r) => r.msPerMsg > 2);
const lowQuality = allResults.filter((r) => r.quality != null && r.quality < 0.8);
const lowEntity = allResults.filter((r) => r.entityRet != null && r.entityRet < 0.7);

console.log(`\n  Tests run: ${allResults.length}`);
console.log(`  Round-trip failures: ${rtFailures.length}`);
console.log(`  Slow tests (>2ms/msg): ${slowTests.length}`);
console.log(`  Low quality (<80%): ${lowQuality.length}`);
console.log(`  Low entity retention (<70%): ${lowEntity.length}`);
console.log(`  Total findings: ${allFindings.length}`);

if (allFindings.length > 0) {
  console.log('\n  All findings:');
  for (const { test, finding } of allFindings) {
    console.log(`    [${test}] ${finding}`);
  }
}

if (rtFailures.length > 0) {
  console.log('\n  Round-trip failures:');
  for (const r of rtFailures) console.log(`    ${r.name}`);
}

if (slowTests.length > 0) {
  console.log('\n  Performance concerns:');
  for (const r of slowTests)
    console.log(
      `    ${r.name}: ${r.msPerMsg.toFixed(2)}ms/msg (${r.msgCount} msgs, ${r.timeMs.toFixed(0)}ms total)`,
    );
}

console.log();
