import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { classifyMessage } from '../src/classify.js';
import type { Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

/**
 * Determinism tests: same input → same output, verified across multiple runs.
 * These catch accidental non-determinism from Map iteration order, Set ordering,
 * floating-point rounding, or any other source of instability.
 */
describe('determinism', () => {
  function runN<T>(n: number, fn: () => T): T[] {
    return Array.from({ length: n }, () => fn());
  }

  function assertAllEqual(results: unknown[]) {
    const serialized = results.map((r) => JSON.stringify(r));
    for (let i = 1; i < serialized.length; i++) {
      expect(serialized[i]).toBe(serialized[0]);
    }
  }

  it('basic compression is deterministic across 5 runs', () => {
    const longProse =
      'The authentication middleware validates incoming JWT tokens against the session store and checks expiration timestamps. '.repeat(
        5,
      );
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'You are a helpful assistant.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: longProse }),
      msg({
        id: 'a1',
        index: 2,
        role: 'assistant',
        content: longProse + ' The service also handles refresh token rotation.',
      }),
      msg({ id: 'u2', index: 3, role: 'user', content: 'Thanks for the explanation.' }),
    ];

    const results = runN(5, () => compress(messages, { recencyWindow: 1 }));
    assertAllEqual(results);
  });

  it('dedup is deterministic across 5 runs', () => {
    const LONG =
      'This is a repeated message with enough content to exceed the two hundred character minimum threshold for dedup eligibility so we can test dedup properly across multiple messages in the conversation. Extra padding here.';
    const messages: Message[] = [
      msg({ id: '1', index: 0, content: LONG }),
      msg({
        id: '2',
        index: 1,
        role: 'assistant',
        content:
          'The system processes the request through several stages including validation and enrichment. '.repeat(
            4,
          ),
      }),
      msg({ id: '3', index: 2, content: LONG }),
    ];

    const results = runN(5, () => compress(messages, { recencyWindow: 0, dedup: true }));
    assertAllEqual(results);
  });

  it('fuzzy dedup is deterministic across 5 runs', () => {
    const base =
      'The deployment pipeline starts with pulling the latest Docker image from the registry and running pre-flight health checks against the staging environment to verify service connectivity.';
    const variant =
      'The deployment pipeline starts with pulling the latest Docker image from the registry and running pre-flight health checks against the production environment to verify service connectivity.';
    // Pad both to > 200 chars
    const padded1 = base + ' ' + 'Additional context about the deployment process. '.repeat(2);
    const padded2 = variant + ' ' + 'Additional context about the deployment process. '.repeat(2);

    const messages: Message[] = [
      msg({ id: '1', index: 0, content: padded1 }),
      msg({ id: '2', index: 1, content: padded2 }),
    ];

    const results = runN(5, () =>
      compress(messages, { recencyWindow: 0, fuzzyDedup: true, fuzzyThreshold: 0.8 }),
    );
    assertAllEqual(results);
  });

  it('code-split compression is deterministic across 5 runs', () => {
    const longProse =
      'This is a detailed explanation of how the authentication system works and integrates with the session manager for token rotation. '.repeat(
        3,
      );
    const content = `${longProse}\n\n\`\`\`typescript\nconst token = await auth.getToken();\nconst session = createSession(token);\n\`\`\``;
    const messages: Message[] = [msg({ id: '1', index: 0, role: 'assistant', content })];

    const results = runN(5, () => compress(messages, { recencyWindow: 0 }));
    assertAllEqual(results);
  });

  it('token budget binary search is deterministic across 5 runs', () => {
    const longProse =
      'The system architecture relies on distributed message queues for inter-service communication with circuit breakers preventing cascading failures. '.repeat(
        3,
      );
    const messages: Message[] = Array.from({ length: 8 }, (_, i) =>
      msg({
        id: String(i + 1),
        index: i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longProse,
      }),
    );

    const results = runN(5, () => compress(messages, { tokenBudget: 2000 }));
    assertAllEqual(results);
  });

  it('force-converge is deterministic across 5 runs', () => {
    const longProse =
      'The system processes the request through validation, enrichment, and routing stages before forwarding to the appropriate downstream service. '.repeat(
        8,
      );
    const messages: Message[] = Array.from({ length: 6 }, (_, i) =>
      msg({
        id: String(i + 1),
        index: i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longProse,
      }),
    );

    const results = runN(5, () => compress(messages, { tokenBudget: 200, forceConverge: true }));
    assertAllEqual(results);
  });

  it('classifyMessage is deterministic across 100 runs', () => {
    const inputs = [
      'Just a plain prose message about general topics without any special formatting.',
      '```typescript\nconst x = 1;\n```\nSome code here.',
      'SELECT * FROM users WHERE id = 1 ORDER BY name',
      'The deployment requires 15 retries with 200ms timeout per request.',
      JSON.stringify({ key: 'value', nested: { a: 1 } }),
    ];

    for (const input of inputs) {
      const results = runN(100, () => classifyMessage(input));
      assertAllEqual(results);
    }
  });

  it('trace output is deterministic across 5 runs', () => {
    const longProse =
      'The authentication middleware validates incoming JWT tokens against the session store. '.repeat(
        5,
      );
    const messages: Message[] = [
      msg({ id: 'sys', index: 0, role: 'system', content: 'System prompt.' }),
      msg({ id: 'u1', index: 1, role: 'user', content: longProse }),
      msg({ id: 'a1', index: 2, role: 'assistant', content: 'Short response.' }),
    ];

    const results = runN(5, () => compress(messages, { recencyWindow: 0, trace: true }));
    assertAllEqual(results);
  });
});
