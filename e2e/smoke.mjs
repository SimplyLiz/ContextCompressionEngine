/**
 * End-to-end smoke test for context-compression-engine.
 *
 * Installs the package from npm (or a local tarball) and exercises every
 * public export the way a real consumer would.
 *
 * Run:
 *   cd e2e && npm install context-compression-engine && npm test
 *
 * Or with a local tarball:
 *   cd e2e && npm install ../context-compression-engine-*.tgz && npm test
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compress,
  uncompress,
  defaultTokenCounter,
  createSummarizer,
  createEscalatingSummarizer,
} from 'context-compression-engine';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Content >=200 chars — required for dedup eligibility. */
const longContent = `I need to refactor the authentication module. It currently uses session-based auth but we want to switch to JWT tokens. The module handles login, signup, password reset, and session management. We also need to update the middleware and all protected routes to use the new token-based approach instead of cookies.`;

/** Content >512 chars — required for forceConverge truncation eligibility. */
const veryLongContent = `Here is a comprehensive step-by-step plan for the authentication refactoring:
1. Install jsonwebtoken and bcryptjs packages
2. Create a token signing utility in src/auth/tokens.js
3. Add middleware for token verification in src/middleware/auth.js
4. Update login endpoint to issue access and refresh tokens
5. Remove session dependencies from express configuration
6. Update all protected routes to use the new middleware
7. Create a /refresh endpoint for token rotation
8. Implement token blacklisting for logout
9. Add rate limiting to auth endpoints
10. Write comprehensive integration tests for the new auth flow
11. Update API documentation to reflect the new auth scheme
12. Create a migration script for existing sessions
13. Add monitoring and alerting for auth failures
This is going to be a significant change that touches many parts of the codebase.`;

const messages = [
  { id: '1', index: 0, role: 'user', content: longContent },
  { id: '2', index: 1, role: 'assistant', content: veryLongContent },
  {
    id: '3',
    index: 2,
    role: 'user',
    content: 'That sounds good. Can you also add refresh token support?',
  },
  {
    id: '4',
    index: 3,
    role: 'assistant',
    content: veryLongContent.replace('step-by-step', 'detailed'),
  },
  {
    id: '5',
    index: 4,
    role: 'user',
    content:
      'Perfect, lets also add rate limiting to prevent brute force attacks on the login endpoint.',
  },
  {
    id: '6',
    index: 5,
    role: 'assistant',
    content:
      'Good idea. I recommend using express-rate-limit with a sliding window. We can set it to 5 attempts per minute per IP address.',
  },
  {
    id: '7',
    index: 6,
    role: 'user',
    content: 'Great, please proceed with the implementation.',
  },
  {
    id: '8',
    index: 7,
    role: 'assistant',
    content: 'Starting implementation now.',
  },
];

/**
 * Realistic 30-message conversation with system prompt, tool_calls,
 * long assistant responses, and repeated user patterns.
 */
function buildLargeConversation() {
  const msgs = [
    {
      id: 'L0',
      index: 0,
      role: 'system',
      content: 'You are a senior backend engineer. Always suggest tests. Prefer TypeScript.',
    },
  ];
  const userPrompts = [
    'Set up a new Express project with TypeScript and ESLint.',
    'Add a PostgreSQL connection pool using pg.',
    'Create a users table migration with id, email, password_hash, created_at.',
    'Implement the POST /users signup endpoint with input validation.',
    'Add bcrypt password hashing to the signup flow.',
    'Write integration tests for the signup endpoint.',
    'Implement POST /auth/login returning a JWT access token.',
    'Add a GET /users/me endpoint that requires authentication.',
    'Implement refresh token rotation with a tokens table.',
    'Add rate limiting middleware to auth endpoints.',
    'Set up a CI pipeline with GitHub Actions.',
    'Add request logging with pino.',
    'Implement soft-delete for users.',
    'Add pagination to GET /users.',
    'Write a database seeder for development.',
  ];
  let idx = 1;
  for (const prompt of userPrompts) {
    msgs.push({ id: `L${idx}`, index: idx, role: 'user', content: prompt });
    idx++;
    // Simulate a substantive assistant response (>200 chars)
    const response = `Sure, here is how we can ${prompt.toLowerCase()}\n\nFirst, we need to install the required dependencies and configure the project structure. Then we will implement the core logic, add proper error handling, and write tests to verify everything works correctly. Let me walk you through each step in detail with code examples and explanations of the design decisions involved.`;
    msgs.push({
      id: `L${idx}`,
      index: idx,
      role: 'assistant',
      content: response,
    });
    idx++;
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('basic compression', () => {
  const result = compress(messages, { recencyWindow: 2 });

  test('preserves message count', () => {
    assert.equal(result.messages.length, messages.length);
  });

  test('achieves compression ratio > 1', () => {
    assert.ok(result.compression.ratio > 1, `ratio was ${result.compression.ratio.toFixed(2)}`);
  });

  test('achieves token ratio > 1', () => {
    assert.ok(
      result.compression.token_ratio > 1,
      `token_ratio was ${result.compression.token_ratio.toFixed(2)}`,
    );
  });

  test('compresses some messages', () => {
    assert.ok(result.compression.messages_compressed > 0);
  });

  test('preserves some messages', () => {
    assert.ok(result.compression.messages_preserved > 0);
  });

  test('populates verbatim store', () => {
    assert.ok(Object.keys(result.verbatim).length > 0);
  });

  test('preserve keywords retained in compressed output', () => {
    const preserveResult = compress(messages, {
      recencyWindow: 1,
      preserve: ['JWT', 'refresh'],
    });
    const compressedWithPreserve = preserveResult.messages.filter((m) => m.metadata?._cce_original);
    assert.ok(compressedWithPreserve.length > 0, 'at least one message compressed');
    for (const cm of compressedWithPreserve) {
      const orig = messages.find((m) => m.id === cm.id);
      if (orig?.content?.includes('JWT')) {
        assert.ok(cm.content.includes('JWT'), `preserved "JWT" in message ${cm.id}`);
      }
    }
  });

  test('sourceVersion flows into compression metadata', () => {
    const vResult = compress(messages, { recencyWindow: 2, sourceVersion: 42 });
    assert.equal(vResult.compression.original_version, 42);
  });

  test('embedSummaryId embeds summary_id in compressed content', () => {
    const embedResult = compress(messages, {
      recencyWindow: 2,
      embedSummaryId: true,
    });
    const compressedMsgs = embedResult.messages.filter((m) => m.metadata?._cce_original);
    assert.ok(compressedMsgs.length > 0, 'some messages compressed');
    for (const cm of compressedMsgs) {
      assert.ok(
        cm.content?.includes(cm.metadata._cce_original.summary_id),
        `summary_id embedded in message ${cm.id}`,
      );
    }
  });

  test('forceConverge reduces tokens', () => {
    const fcResult = compress(messages, { tokenBudget: 200, forceConverge: true });
    const noFcResult = compress(messages, { tokenBudget: 200 });
    assert.ok(
      fcResult.tokenCount <= noFcResult.tokenCount,
      `forceConverge ${fcResult.tokenCount} <= without ${noFcResult.tokenCount}`,
    );
    assert.equal(fcResult.messages.length, messages.length);
  });

  test('provenance metadata structure', () => {
    const compMsg = result.messages.find((m) => m.metadata?._cce_original);
    assert.ok(compMsg !== undefined, 'compressed message has provenance');
    const orig = compMsg.metadata._cce_original;
    assert.ok(Array.isArray(orig.ids) && orig.ids.length > 0, '_cce_original.ids is non-empty');
    assert.equal(typeof orig.summary_id, 'string');
    assert.equal(typeof orig.version, 'number');
  });
});

describe('uncompress round-trip', () => {
  test('lossless content restoration', () => {
    const result = compress(messages, { recencyWindow: 2 });
    const lookup = (id) => result.verbatim[id] ?? null;
    const expanded = uncompress(result.messages, lookup);

    assert.equal(expanded.messages.length, messages.length);
    assert.ok(expanded.messages_expanded > 0);
    assert.equal(expanded.missing_ids.length, 0);
    assert.equal(
      messages.map((m) => m.content).join('|'),
      expanded.messages.map((m) => m.content).join('|'),
    );
  });

  test('reports missing IDs when verbatim store is empty', () => {
    const result = compress(messages, { recencyWindow: 2 });
    const missingResult = uncompress(result.messages, () => null);
    assert.ok(missingResult.missing_ids.length > 0);
  });

  test('accepts plain object as verbatim store', () => {
    const r = compress(messages, { recencyWindow: 2 });
    const expandedObj = uncompress(r.messages, r.verbatim);
    assert.equal(expandedObj.missing_ids.length, 0);
    assert.equal(
      messages.map((m) => m.content).join('|'),
      expandedObj.messages.map((m) => m.content).join('|'),
    );
  });
});

describe('dedup', () => {
  test('detects exact duplicates (>=200 char messages)', () => {
    const dupMessages = [...messages, { id: '9', index: 8, role: 'user', content: longContent }];
    const dedupResult = compress(dupMessages, { recencyWindow: 2, dedup: true });
    assert.ok(
      dedupResult.compression.messages_deduped > 0,
      `messages deduped: ${dedupResult.compression.messages_deduped}`,
    );
  });

  test('fuzzy dedup detects near-duplicate messages', () => {
    const fuzzyResult = compress(messages, {
      recencyWindow: 2,
      fuzzyDedup: true,
      fuzzyThreshold: 0.5,
    });
    assert.equal(fuzzyResult.messages.length, messages.length);
    assert.ok(fuzzyResult.compression.ratio >= 1);
    assert.ok(
      fuzzyResult.compression.messages_fuzzy_deduped > 0,
      `expected fuzzy dedup to detect near-duplicates, got messages_fuzzy_deduped=${fuzzyResult.compression.messages_fuzzy_deduped}`,
    );
  });
});

describe('token budget', () => {
  const totalTokens = messages.reduce((sum, m) => sum + defaultTokenCounter(m), 0);
  const fitBudget = Math.ceil(totalTokens * 0.8);

  test('binary search finds a recencyWindow that fits', () => {
    const budgetResult = compress(messages, { tokenBudget: fitBudget });
    assert.equal(budgetResult.fits, true);
    assert.ok(budgetResult.tokenCount <= fitBudget);
    assert.equal(typeof budgetResult.recencyWindow, 'number');
  });

  test('reports fits=false when budget is impossible', () => {
    const tightResult = compress(messages, { tokenBudget: 10 });
    assert.equal(tightResult.fits, false);
    assert.ok(tightResult.tokenCount > 10);
  });

  test('minRecencyWindow floor is enforced', () => {
    const minRWResult = compress(messages, {
      tokenBudget: 50,
      minRecencyWindow: 4,
    });
    assert.ok(
      minRWResult.recencyWindow >= 4,
      `recencyWindow ${minRWResult.recencyWindow} should be >= 4`,
    );
  });
});

describe('token counter', () => {
  test('defaultTokenCounter returns positive number', () => {
    const count = defaultTokenCounter({ id: 'x', index: 0, content: 'Hello' });
    assert.equal(typeof count, 'number');
    assert.ok(count > 0);
  });

  test('custom tokenCounter is invoked', () => {
    let counterCalls = 0;
    compress(messages, {
      recencyWindow: 2,
      tokenCounter: (msg) => {
        counterCalls++;
        return Math.ceil((msg.content?.length ?? 0) / 4);
      },
    });
    assert.ok(counterCalls > 0, `custom counter invoked ${counterCalls} times`);
  });
});

describe('factory functions', () => {
  test('createSummarizer is exported', () => {
    assert.equal(typeof createSummarizer, 'function');
  });

  test('createEscalatingSummarizer is exported', () => {
    assert.equal(typeof createEscalatingSummarizer, 'function');
  });
});

describe('edge cases', () => {
  test('empty input returns empty output', () => {
    const emptyResult = compress([], { recencyWindow: 0 });
    assert.equal(emptyResult.messages.length, 0);
    assert.equal(emptyResult.compression.ratio, 1);
  });

  test('single message is preserved', () => {
    const singleResult = compress([{ id: '1', index: 0, role: 'user', content: 'Hello' }], {
      recencyWindow: 1,
    });
    assert.equal(singleResult.messages.length, 1);
    assert.equal(singleResult.compression.messages_preserved, 1);
  });
});

describe('async path', () => {
  test('mock summarizer is called and round-trip works', async () => {
    let summarizerCalled = 0;
    const mockSummarizer = async (text) => {
      summarizerCalled++;
      return `[mock summary of ${text.length} chars]`;
    };
    const asyncResult = await compress(messages, {
      recencyWindow: 2,
      summarizer: mockSummarizer,
    });
    assert.ok(summarizerCalled > 0, `summarizer was called ${summarizerCalled}x`);
    assert.equal(asyncResult.messages.length, messages.length);
    assert.ok(asyncResult.compression.messages_compressed > 0);
    assert.ok(Object.keys(asyncResult.verbatim).length > 0);

    // Round-trip the async result
    const asyncExpanded = uncompress(
      asyncResult.messages,
      (id) => asyncResult.verbatim[id] ?? null,
    );
    assert.equal(asyncExpanded.missing_ids.length, 0);
    assert.equal(
      asyncExpanded.messages.map((m) => m.content).join('|'),
      messages.map((m) => m.content).join('|'),
    );
  });

  test('async path with token budget', async () => {
    const totalTokens = messages.reduce((sum, m) => sum + defaultTokenCounter(m), 0);
    const fitBudget = Math.ceil(totalTokens * 0.8);
    const mockSummarizer = async (text) => `[summary: ${text.substring(0, 30)}...]`;
    const asyncBudget = await compress(messages, {
      tokenBudget: fitBudget,
      summarizer: mockSummarizer,
    });
    assert.notEqual(asyncBudget.fits, undefined);
    assert.equal(typeof asyncBudget.tokenCount, 'number');
    assert.equal(typeof asyncBudget.recencyWindow, 'number');
  });
});

describe('role handling', () => {
  test('system messages are auto-preserved', () => {
    const withSystem = [
      {
        id: 's0',
        index: 0,
        role: 'system',
        content: 'You are a helpful assistant with expertise in security.',
      },
      ...messages.map((m, i) => ({ ...m, id: `s${i + 1}`, index: i + 1 })),
    ];
    const sysResult = compress(withSystem, { recencyWindow: 1 });
    const sysMsg = sysResult.messages.find((m) => m.role === 'system');
    assert.ok(sysMsg !== undefined, 'system message present in output');
    assert.equal(sysMsg.metadata?._cce_original, undefined, 'system message not compressed');
    assert.equal(sysMsg.content, withSystem[0].content);
  });

  test('tool_calls messages pass through intact and other messages are compressed', () => {
    const withTools = [
      {
        id: 't0',
        index: 0,
        role: 'user',
        content:
          'I need to check the weather forecast for Berlin because I am planning a trip there next week and want to know what clothes to pack. Can you look up the current conditions and the extended forecast for the next seven days so I can prepare accordingly?',
      },
      {
        id: 't1',
        index: 1,
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
          },
        ],
      },
      {
        id: 't2',
        index: 2,
        role: 'tool',
        content: '{"temp": 18, "condition": "cloudy"}',
      },
      {
        id: 't3',
        index: 3,
        role: 'assistant',
        content:
          'Based on the weather data, Berlin is currently 18 degrees Celsius and cloudy. For your trip next week, I would recommend packing layers including a light jacket and an umbrella. The extended forecast shows temperatures ranging from 15 to 22 degrees with intermittent rain expected on Wednesday and Thursday.',
      },
      { id: 't4', index: 4, role: 'user', content: 'Thanks, that is very helpful!' },
    ];
    const toolResult = compress(withTools, { recencyWindow: 1 });

    // tool_calls message should be preserved
    const toolMsg = toolResult.messages.find((m) => m.id === 't1');
    assert.ok(toolMsg !== undefined, 'tool_calls message present');
    assert.ok(Array.isArray(toolMsg.tool_calls) && toolMsg.tool_calls.length === 1);
    assert.equal(toolMsg.tool_calls[0].function.name, 'get_weather');

    // Non-recent, non-tool messages should be compressed
    const compressedMsgs = toolResult.messages.filter((m) => m.metadata?._cce_original);
    assert.ok(
      compressedMsgs.length > 0,
      'at least one non-tool message was compressed (has _cce_original)',
    );
  });
});

describe('re-compression', () => {
  test('compress already-compressed output and recover via chained stores', () => {
    const first = compress(messages, { recencyWindow: 2 });
    const second = compress(first.messages, { recencyWindow: 1 });
    assert.equal(second.messages.length, first.messages.length);

    const chainedLookup = (id) => second.verbatim[id] ?? first.verbatim[id] ?? null;
    const recovered = uncompress(second.messages, chainedLookup, { recursive: true });
    assert.ok(recovered.messages_expanded > 0);

    const origContents = messages.map((m) => m.content);
    const recoveredContents = recovered.messages.map((m) => m.content);
    for (const oc of origContents) {
      assert.ok(
        recoveredContents.includes(oc),
        `original content recoverable: ${oc.slice(0, 40)}...`,
      );
    }
  });

  test('recursive uncompress fully expands nested provenance', () => {
    const first = compress(messages, { recencyWindow: 2 });
    const second = compress(first.messages, { recencyWindow: 1 });
    const allVerbatim = { ...first.verbatim, ...second.verbatim };
    const storeFn = (id) => allVerbatim[id] ?? null;

    const shallow = uncompress(second.messages, storeFn);
    const deep = uncompress(second.messages, storeFn, { recursive: true });
    assert.ok(
      deep.messages_expanded >= shallow.messages_expanded,
      `recursive ${deep.messages_expanded} >= shallow ${shallow.messages_expanded}`,
    );
  });
});

describe('large conversation', () => {
  const largeMsgs = buildLargeConversation();

  test('fixture has 31 messages', () => {
    assert.equal(largeMsgs.length, 31);
  });

  test('compression + lossless round-trip at scale', () => {
    const largeResult = compress(largeMsgs, { recencyWindow: 4 });
    assert.equal(largeResult.messages.length, largeMsgs.length);
    assert.ok(largeResult.compression.ratio > 1);
    assert.ok(largeResult.compression.messages_compressed >= 10);

    const largeLookup = (id) => largeResult.verbatim[id] ?? null;
    const largeExpanded = uncompress(largeResult.messages, largeLookup);
    assert.equal(largeExpanded.missing_ids.length, 0);
    assert.equal(
      largeMsgs.map((m) => m.content).join('|'),
      largeExpanded.messages.map((m) => m.content).join('|'),
    );
  });

  test('binary search converges on 50% budget target', () => {
    const largeTotalTokens = largeMsgs.reduce((sum, m) => sum + defaultTokenCounter(m), 0);
    const largeBudget = Math.ceil(largeTotalTokens * 0.5);
    const largeBudgetResult = compress(largeMsgs, { tokenBudget: largeBudget });
    assert.equal(largeBudgetResult.fits, true);
    assert.ok(largeBudgetResult.recencyWindow >= 0);
  });
});

describe('error handling', () => {
  test('non-array to compress throws TypeError', () => {
    assert.throws(() => compress('not an array', {}), TypeError);
  });

  test('null entry in messages array throws TypeError', () => {
    assert.throws(() => compress([null], {}), TypeError);
  });

  test('message missing required "id" field throws TypeError', () => {
    assert.throws(() => compress([{ index: 0, role: 'user', content: 'hi' }], {}), TypeError);
  });

  test('non-array to uncompress throws TypeError', () => {
    assert.throws(() => uncompress('not an array', () => null), TypeError);
  });

  test('invalid store to uncompress throws TypeError', () => {
    assert.throws(() => uncompress([], null), TypeError);
  });

  test('null content does not throw and returns valid result', () => {
    const result = compress([{ id: '1', index: 0, role: 'user', content: null }], {
      recencyWindow: 0,
    });
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.messages.length, 1);
  });

  test('empty string content does not throw and returns valid result', () => {
    const result = compress([{ id: '1', index: 0, role: 'user', content: '' }], {
      recencyWindow: 0,
    });
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.messages.length, 1);
  });
});
