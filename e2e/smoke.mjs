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

import {
  compress,
  uncompress,
  defaultTokenCounter,
  createSummarizer,
  createEscalatingSummarizer,
} from "context-compression-engine";

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
  { id: "1", index: 0, role: "user", content: longContent },
  { id: "2", index: 1, role: "assistant", content: veryLongContent },
  {
    id: "3",
    index: 2,
    role: "user",
    content: "That sounds good. Can you also add refresh token support?",
  },
  {
    id: "4",
    index: 3,
    role: "assistant",
    content: veryLongContent.replace("step-by-step", "detailed"),
  },
  {
    id: "5",
    index: 4,
    role: "user",
    content:
      "Perfect, lets also add rate limiting to prevent brute force attacks on the login endpoint.",
  },
  {
    id: "6",
    index: 5,
    role: "assistant",
    content:
      "Good idea. I recommend using express-rate-limit with a sliding window. We can set it to 5 attempts per minute per IP address.",
  },
  {
    id: "7",
    index: 6,
    role: "user",
    content: "Great, please proceed with the implementation.",
  },
  {
    id: "8",
    index: 7,
    role: "assistant",
    content: "Starting implementation now.",
  },
];

/**
 * Realistic 30-message conversation with system prompt, tool_calls,
 * long assistant responses, and repeated user patterns.
 */
function buildLargeConversation() {
  const msgs = [
    {
      id: "L0",
      index: 0,
      role: "system",
      content:
        "You are a senior backend engineer. Always suggest tests. Prefer TypeScript.",
    },
  ];
  const userPrompts = [
    "Set up a new Express project with TypeScript and ESLint.",
    "Add a PostgreSQL connection pool using pg.",
    "Create a users table migration with id, email, password_hash, created_at.",
    "Implement the POST /users signup endpoint with input validation.",
    "Add bcrypt password hashing to the signup flow.",
    "Write integration tests for the signup endpoint.",
    "Implement POST /auth/login returning a JWT access token.",
    "Add a GET /users/me endpoint that requires authentication.",
    "Implement refresh token rotation with a tokens table.",
    "Add rate limiting middleware to auth endpoints.",
    "Set up a CI pipeline with GitHub Actions.",
    "Add request logging with pino.",
    "Implement soft-delete for users.",
    "Add pagination to GET /users.",
    "Write a database seeder for development.",
  ];
  let idx = 1;
  for (const prompt of userPrompts) {
    msgs.push({ id: `L${idx}`, index: idx, role: "user", content: prompt });
    idx++;
    // Simulate a substantive assistant response (>200 chars)
    const response = `Sure, here is how we can ${prompt.toLowerCase()}\n\nFirst, we need to install the required dependencies and configure the project structure. Then we will implement the core logic, add proper error handling, and write tests to verify everything works correctly. Let me walk you through each step in detail with code examples and explanations of the design decisions involved.`;
    msgs.push({
      id: `L${idx}`,
      index: idx,
      role: "assistant",
      content: response,
    });
    idx++;
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.error(`  \u2717 ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n1. Basic compress (recencyWindow=2)");
const result = compress(messages, { recencyWindow: 2 });
assert(
  result.messages.length === messages.length,
  `message count preserved (${result.messages.length})`,
);
assert(
  result.compression.ratio > 1,
  `ratio > 1 (${result.compression.ratio.toFixed(2)})`,
);
assert(
  result.compression.token_ratio > 1,
  `token_ratio > 1 (${result.compression.token_ratio.toFixed(2)})`,
);
assert(
  result.compression.messages_compressed > 0,
  `some messages compressed (${result.compression.messages_compressed})`,
);
assert(
  result.compression.messages_preserved > 0,
  `some messages preserved (${result.compression.messages_preserved})`,
);
assert(
  Object.keys(result.verbatim).length > 0,
  `verbatim store populated (${Object.keys(result.verbatim).length} entries)`,
);

console.log("\n2. Uncompress round-trip");
const lookup = (id) => result.verbatim[id] ?? null;
const expanded = uncompress(result.messages, lookup);
assert(
  expanded.messages.length === messages.length,
  `expanded count matches (${expanded.messages.length})`,
);
assert(
  expanded.messages_expanded > 0,
  `messages expanded (${expanded.messages_expanded})`,
);
assert(expanded.missing_ids.length === 0, `no missing IDs`);
assert(
  messages.map((m) => m.content).join("|") ===
    expanded.messages.map((m) => m.content).join("|"),
  "content fully restored after round-trip",
);

console.log("\n3. Dedup (exact duplicates >=200 chars)");
const dupMessages = [
  ...messages,
  { id: "9", index: 8, role: "user", content: longContent },
];
const dedupResult = compress(dupMessages, { recencyWindow: 2, dedup: true });
assert(
  dedupResult.compression.messages_deduped > 0,
  `messages deduped (${dedupResult.compression.messages_deduped})`,
);

console.log("\n4. Token budget (binary search finds a fit)");
// Use a generous budget that the binary search can actually meet
const totalTokens = messages.reduce(
  (sum, m) => sum + defaultTokenCounter(m),
  0,
);
const fitBudget = Math.ceil(totalTokens * 0.8);
const budgetResult = compress(messages, { tokenBudget: fitBudget });
assert(budgetResult.fits === true, `fits within ${fitBudget} tokens`);
assert(
  budgetResult.tokenCount <= fitBudget,
  `tokenCount (${budgetResult.tokenCount}) <= budget (${fitBudget})`,
);
assert(
  typeof budgetResult.recencyWindow === "number",
  `recencyWindow resolved (${budgetResult.recencyWindow})`,
);

console.log("\n5. Token budget (too tight — cannot fit)");
const tightResult = compress(messages, { tokenBudget: 10 });
assert(tightResult.fits === false, `correctly reports cannot fit`);
assert(tightResult.tokenCount > 10, `tokenCount exceeds budget`);

console.log("\n6. defaultTokenCounter");
const count = defaultTokenCounter({ id: "x", index: 0, content: "Hello" });
assert(
  typeof count === "number" && count > 0,
  `returns positive number (${count})`,
);

console.log("\n7. Preserve keywords");
const preserveResult = compress(messages, {
  recencyWindow: 1,
  preserve: ["JWT", "refresh"],
});
const compressedWithPreserve = preserveResult.messages.filter(
  (m) => m.metadata?._cce_original,
);
for (const cm of compressedWithPreserve) {
  const orig = messages.find((m) => m.id === cm.id);
  if (orig?.content?.includes("JWT")) {
    assert(cm.content.includes("JWT"), `preserved "JWT" in message ${cm.id}`);
  }
}
assert(compressedWithPreserve.length > 0, `at least one message compressed`);

console.log("\n8. sourceVersion");
const vResult = compress(messages, { recencyWindow: 2, sourceVersion: 42 });
assert(vResult.compression.original_version === 42, `original_version = 42`);

console.log("\n9. embedSummaryId");
const embedResult = compress(messages, {
  recencyWindow: 2,
  embedSummaryId: true,
});
const compressedMsgs = embedResult.messages.filter(
  (m) => m.metadata?._cce_original,
);
assert(compressedMsgs.length > 0, `some messages compressed`);
let embedOk = 0;
for (const cm of compressedMsgs) {
  if (cm.content?.includes(cm.metadata._cce_original.summary_id)) embedOk++;
}
assert(
  embedOk === compressedMsgs.length,
  `summary_id embedded in all ${compressedMsgs.length} compressed msgs`,
);

console.log("\n10. Exported factory functions");
assert(typeof createSummarizer === "function", "createSummarizer exported");
assert(
  typeof createEscalatingSummarizer === "function",
  "createEscalatingSummarizer exported",
);

console.log("\n11. forceConverge (best-effort truncation)");
const fcResult = compress(messages, { tokenBudget: 200, forceConverge: true });
assert(
  fcResult.tokenCount <=
    compress(messages, { tokenBudget: 200 }).tokenCount,
  `forceConverge tokens <= without`,
);
assert(fcResult.messages.length === messages.length, `message count preserved`);

console.log("\n12. Fuzzy dedup");
const fuzzyResult = compress(messages, {
  recencyWindow: 2,
  fuzzyDedup: true,
  fuzzyThreshold: 0.5,
});
assert(
  fuzzyResult.messages.length === messages.length,
  `message count preserved`,
);
assert(fuzzyResult.compression.ratio >= 1, `ratio valid`);

console.log("\n13. Provenance metadata");
const compMsg = result.messages.find((m) => m.metadata?._cce_original);
assert(compMsg !== undefined, `compressed message has provenance`);
if (compMsg) {
  const orig = compMsg.metadata._cce_original;
  assert(
    Array.isArray(orig.ids) && orig.ids.length > 0,
    `_cce_original.ids is non-empty array`,
  );
  assert(typeof orig.summary_id === "string", `_cce_original.summary_id`);
  assert(typeof orig.version === "number", `_cce_original.version`);
}

console.log("\n14. Uncompress with missing verbatim store");
const missingResult = uncompress(result.messages, () => null);
assert(
  missingResult.missing_ids.length > 0,
  `missing_ids reported (${missingResult.missing_ids.length})`,
);

console.log("\n15. Custom tokenCounter");
let counterCalls = 0;
compress(messages, {
  recencyWindow: 2,
  tokenCounter: (msg) => {
    counterCalls++;
    return Math.ceil((msg.content?.length ?? 0) / 4);
  },
});
assert(counterCalls > 0, `custom counter invoked (${counterCalls} calls)`);

console.log("\n16. Edge cases");
const emptyResult = compress([], { recencyWindow: 0 });
assert(emptyResult.messages.length === 0, `empty input -> empty output`);
assert(emptyResult.compression.ratio === 1, `empty ratio = 1`);

const singleResult = compress(
  [{ id: "1", index: 0, role: "user", content: "Hello" }],
  { recencyWindow: 1 },
);
assert(singleResult.messages.length === 1, `single message preserved`);
assert(
  singleResult.compression.messages_preserved === 1,
  `single message counted as preserved`,
);

// ---------------------------------------------------------------------------
// New coverage: async path, system role, tool_calls, re-compression,
// recursive uncompress, minRecencyWindow, large conversation
// ---------------------------------------------------------------------------

console.log("\n17. Async path (mock summarizer)");
{
  let summarizerCalled = 0;
  const mockSummarizer = async (text) => {
    summarizerCalled++;
    return `[mock summary of ${text.length} chars]`;
  };
  const asyncResult = await compress(messages, {
    recencyWindow: 2,
    summarizer: mockSummarizer,
  });
  assert(summarizerCalled > 0, `summarizer was called (${summarizerCalled}x)`);
  assert(
    asyncResult.messages.length === messages.length,
    `message count preserved`,
  );
  assert(
    asyncResult.compression.messages_compressed > 0,
    `messages compressed via summarizer`,
  );
  assert(
    Object.keys(asyncResult.verbatim).length > 0,
    `verbatim store populated`,
  );
  // Round-trip the async result
  const asyncExpanded = uncompress(
    asyncResult.messages,
    (id) => asyncResult.verbatim[id] ?? null,
  );
  assert(asyncExpanded.missing_ids.length === 0, `async round-trip: no missing IDs`);
  assert(
    asyncExpanded.messages.map((m) => m.content).join("|") ===
      messages.map((m) => m.content).join("|"),
    `async round-trip: content fully restored`,
  );
}

console.log("\n18. Async path with token budget");
{
  const mockSummarizer = async (text) =>
    `[summary: ${text.substring(0, 30)}...]`;
  const asyncBudget = await compress(messages, {
    tokenBudget: fitBudget,
    summarizer: mockSummarizer,
  });
  assert(asyncBudget.fits !== undefined, `fits field present`);
  assert(typeof asyncBudget.tokenCount === "number", `tokenCount present`);
  assert(typeof asyncBudget.recencyWindow === "number", `recencyWindow present`);
}

console.log("\n19. System role auto-preserved");
{
  const withSystem = [
    {
      id: "s0",
      index: 0,
      role: "system",
      content: "You are a helpful assistant with expertise in security.",
    },
    ...messages.map((m, i) => ({ ...m, id: `s${i + 1}`, index: i + 1 })),
  ];
  const sysResult = compress(withSystem, { recencyWindow: 1 });
  // System message should never be compressed
  const sysMsg = sysResult.messages.find((m) => m.role === "system");
  assert(sysMsg !== undefined, `system message present in output`);
  assert(
    !sysMsg.metadata?._cce_original,
    `system message not compressed (no _cce_original)`,
  );
  assert(
    sysMsg.content === withSystem[0].content,
    `system message content untouched`,
  );
}

console.log("\n20. Messages with tool_calls pass through");
{
  const withTools = [
    {
      id: "t0",
      index: 0,
      role: "user",
      content: "What is the weather in Berlin?",
    },
    {
      id: "t1",
      index: 1,
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } },
      ],
    },
    {
      id: "t2",
      index: 2,
      role: "tool",
      content: '{"temp": 18, "condition": "cloudy"}',
    },
    {
      id: "t3",
      index: 3,
      role: "assistant",
      content: "It is currently 18 degrees and cloudy in Berlin.",
    },
    { id: "t4", index: 4, role: "user", content: "Thanks!" },
  ];
  const toolResult = compress(withTools, { recencyWindow: 1 });
  // tool_calls message should be preserved (has tool_calls array)
  const toolMsg = toolResult.messages.find((m) => m.id === "t1");
  assert(toolMsg !== undefined, `tool_calls message present`);
  assert(
    Array.isArray(toolMsg.tool_calls) && toolMsg.tool_calls.length === 1,
    `tool_calls array preserved intact`,
  );
  assert(
    toolMsg.tool_calls[0].function.name === "get_weather",
    `tool_calls content intact`,
  );
}

console.log("\n21. Re-compression (compress already-compressed output)");
{
  // First compression
  const first = compress(messages, { recencyWindow: 2 });
  // Second compression on the already-compressed messages
  const second = compress(first.messages, { recencyWindow: 1 });
  assert(
    second.messages.length === first.messages.length,
    `message count preserved after re-compression`,
  );
  // Verify we can still recover originals via chained stores
  const chainedLookup = (id) =>
    second.verbatim[id] ?? first.verbatim[id] ?? null;
  const recovered = uncompress(second.messages, chainedLookup, {
    recursive: true,
  });
  assert(
    recovered.messages_expanded > 0,
    `recursive uncompress expanded messages`,
  );
  // All original content should be recoverable
  const origContents = messages.map((m) => m.content);
  const recoveredContents = recovered.messages.map((m) => m.content);
  let allFound = true;
  for (const oc of origContents) {
    if (!recoveredContents.includes(oc)) {
      allFound = false;
      break;
    }
  }
  assert(allFound, `all original content recoverable after re-compression`);
}

console.log("\n22. Recursive uncompress");
{
  // Compress, then compress again to create nested provenance
  const first = compress(messages, { recencyWindow: 2 });
  const second = compress(first.messages, { recencyWindow: 1 });
  const allVerbatim = { ...first.verbatim, ...second.verbatim };
  const storeFn = (id) => allVerbatim[id] ?? null;
  // Without recursive: should still have compressed messages
  const shallow = uncompress(second.messages, storeFn);
  // With recursive: should fully expand
  const deep = uncompress(second.messages, storeFn, { recursive: true });
  assert(
    deep.messages_expanded >= shallow.messages_expanded,
    `recursive expands more (${deep.messages_expanded} >= ${shallow.messages_expanded})`,
  );
}

console.log("\n23. minRecencyWindow");
{
  const minRWResult = compress(messages, {
    tokenBudget: 50,
    minRecencyWindow: 4,
  });
  assert(
    minRWResult.recencyWindow >= 4,
    `recencyWindow (${minRWResult.recencyWindow}) >= minRecencyWindow (4)`,
  );
}

console.log("\n24. Large conversation (31 messages)");
{
  const largeMsgs = buildLargeConversation();
  assert(largeMsgs.length === 31, `fixture has 31 messages`);

  const largeResult = compress(largeMsgs, { recencyWindow: 4 });
  assert(
    largeResult.messages.length === largeMsgs.length,
    `message count preserved (${largeResult.messages.length})`,
  );
  assert(
    largeResult.compression.ratio > 1,
    `achieves compression (ratio=${largeResult.compression.ratio.toFixed(2)})`,
  );
  assert(
    largeResult.compression.messages_compressed >= 10,
    `substantial compression (${largeResult.compression.messages_compressed} msgs)`,
  );

  // Round-trip
  const largeLookup = (id) => largeResult.verbatim[id] ?? null;
  const largeExpanded = uncompress(largeResult.messages, largeLookup);
  assert(largeExpanded.missing_ids.length === 0, `no missing IDs`);
  assert(
    largeMsgs.map((m) => m.content).join("|") ===
      largeExpanded.messages.map((m) => m.content).join("|"),
    `full content restored`,
  );
}

console.log("\n25. Large conversation with token budget");
{
  const largeMsgs = buildLargeConversation();
  const largeTotalTokens = largeMsgs.reduce(
    (sum, m) => sum + defaultTokenCounter(m),
    0,
  );
  const largeBudget = Math.ceil(largeTotalTokens * 0.5);
  const largeBudgetResult = compress(largeMsgs, { tokenBudget: largeBudget });
  assert(
    largeBudgetResult.fits === true,
    `fits within 50% budget (${largeBudgetResult.tokenCount} <= ${largeBudget})`,
  );
  assert(
    largeBudgetResult.recencyWindow >= 0,
    `binary search resolved recencyWindow (${largeBudgetResult.recencyWindow})`,
  );
}

console.log("\n26. Verbatim store as plain object (not function)");
{
  const r = compress(messages, { recencyWindow: 2 });
  // uncompress accepts both a function and a plain Record<string, Message>
  const expandedObj = uncompress(r.messages, r.verbatim);
  assert(expandedObj.missing_ids.length === 0, `works with plain object store`);
  assert(
    messages.map((m) => m.content).join("|") ===
      expandedObj.messages.map((m) => m.content).join("|"),
    `content restored via object store`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
