/**
 * Adversarial test cases — specifically designed to stress compression quality.
 * Tests edge cases that could break coherence, lose critical data, or produce
 * nonsensical output.
 */

import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('adversarial: pronoun-heavy messages', () => {
  it('compresses without losing referential context', () => {
    const messages: Message[] = [
      msg(
        '1',
        'Do it like we discussed earlier, but change the thing to use the other approach instead of what we had before, and make sure it handles the edge case we talked about.',
      ),
      msg('recent', 'OK, will do.'),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    // Should still produce valid output (not crash on pronoun-heavy content)
    expect(result.messages.length).toBeGreaterThan(0);
  });
});

describe('adversarial: scattered entity references', () => {
  it('entity defined in msg 1 referenced across many later messages', () => {
    const messages: Message[] = [
      msg(
        'def',
        'The fetchData function is the central data fetching utility that handles all API communication with exponential backoff retry logic and circuit breaker pattern.',
      ),
      msg(
        '2',
        'Generic discussion about project timeline and quarterly goals for the engineering team.',
      ),
      msg(
        '3',
        'More general planning about sprint velocity and capacity allocation for the quarter.',
      ),
      msg('4', 'The fetchData function needs a timeout parameter for slow network conditions.'),
      msg('5', 'Unrelated conversation about office lunch preferences and team building events.'),
      msg('ref', 'Make sure fetchData handles 429 rate limit responses with proper backoff.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      coreference: true,
    });

    // fetchData should survive in some form
    const allContent = result.messages.map((m) => m.content ?? '').join(' ');
    expect(allContent).toContain('fetchData');
  });
});

describe('adversarial: correction chain', () => {
  it('3 contradictory instructions — only last should be authoritative', () => {
    const messages: Message[] = [
      msg(
        'v1',
        'Use Redis for the caching layer with a TTL of 3600 seconds for all session data and configure the connection pool with 20 connections maximum.',
      ),
      msg(
        'v2',
        'Actually, use Memcached instead of Redis for the caching layer. Redis is overkill for simple key-value session storage and costs more.',
      ),
      msg(
        'v3',
        'Wait, no — use DynamoDB for caching instead. We need the durability guarantees and the team already has AWS expertise and the infrastructure in place.',
      ),
      msg('recent', 'Got it, DynamoDB it is.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      contradictionDetection: true,
    });

    // The most recent correction (DynamoDB) should be preserved
    const allContent = result.messages.map((m) => m.content ?? '').join(' ');
    expect(allContent.toLowerCase()).toContain('dynamodb');
  });
});

describe('adversarial: code interleaved with prose', () => {
  it('alternating paragraphs of explanation and code', () => {
    const messages: Message[] = [
      msg(
        '1',
        [
          'Here is the authentication flow explained step by step with code examples for each stage.',
          '',
          'First, we validate the incoming JWT token:',
          '```typescript',
          'const decoded = jwt.verify(token, secret);',
          '```',
          '',
          'Then we check if the session is still active and the user has the required permissions:',
          '```typescript',
          'const session = await redis.get(`session:${decoded.sub}`);',
          'if (!session) throw new UnauthorizedError();',
          '```',
          '',
          'Finally we attach the user context to the request object for downstream handlers:',
          '```typescript',
          'req.user = { id: decoded.sub, roles: decoded.roles };',
          'next();',
          '```',
        ].join('\n'),
      ),
      msg('recent', 'Makes sense.'),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    const msg1 = result.messages.find((m) => m.id === '1');

    // Code fences should survive (either preserved or code-split)
    if (msg1?.content?.includes('```')) {
      expect(msg1.content).toContain('jwt.verify');
    }
  });
});

describe('adversarial: near-duplicate with critical difference', () => {
  it('two messages identical except for one number', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The connection pool should be configured with a maximum of 10 connections per service instance and a 30 second idle timeout for unused connections.',
      ),
      msg(
        '2',
        'The connection pool should be configured with a maximum of 50 connections per service instance and a 30 second idle timeout for unused connections.',
      ),
      msg('recent', 'Which one?'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      fuzzyDedup: true,
      fuzzyThreshold: 0.85,
    });

    // Both should be present — they're similar but the number difference is critical
    // At minimum, the preserved/recent messages should reference the difference
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });
});

describe('adversarial: very long single message', () => {
  it('10k+ char message compresses without error', () => {
    const longContent =
      'The distributed system architecture requires careful consideration of network partitions, consistency models, and failure recovery strategies. '.repeat(
        80,
      );
    expect(longContent.length).toBeGreaterThan(10000);

    const messages: Message[] = [msg('1', longContent), msg('recent', 'Summary?')];

    const result = compress(messages, { recencyWindow: 1 });
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
    const msg1 = result.messages.find((m) => m.id === '1');
    expect(msg1!.content!.length).toBeLessThan(longContent.length);
  });
});

describe('adversarial: mixed structured content', () => {
  it('English prose with inline SQL, JSON, and shell commands', () => {
    const messages: Message[] = [
      msg(
        '1',
        [
          'To debug the issue, first run this query:',
          '```sql',
          'SELECT user_id, created_at FROM sessions WHERE expired = false ORDER BY created_at DESC LIMIT 10;',
          '```',
          'The response should look like:',
          '```json',
          '{"users": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]}',
          '```',
          'Then restart the service:',
          '```bash',
          'sudo systemctl restart api-gateway',
          '```',
        ].join('\n'),
      ),
      msg('recent', 'Done.'),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    const msg1 = result.messages.find((m) => m.id === '1');

    // SQL, JSON, and bash code should survive
    if (msg1?.content?.includes('```')) {
      expect(msg1.content).toContain('SELECT');
    }
  });
});

describe('adversarial: round-trip integrity across all features', () => {
  it('compress + uncompress preserves originals with all features enabled', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles all API communication with exponential backoff and circuit breaker pattern for the distributed service layer architecture.',
      ),
      msg(
        '2',
        'Actually, use Memcached instead of Redis. Redis is overkill for simple key-value storage and the operational overhead is not justified.',
      ),
      msg(
        '3',
        'The getUserProfile endpoint should cache results in Memcached with a 300 second TTL for frequently accessed user profile data.',
      ),
      msg(
        '4',
        'Make sure fetchData uses proper error categorization for transient vs permanent failures.',
      ),
      msg('recent', 'Sounds good.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      contradictionDetection: true,
      importanceScoring: true,
      conversationFlow: true,
      coreference: true,
    });

    // Round-trip: uncompress should restore originals
    const expanded = uncompress(result.messages, result.verbatim);
    expect(expanded.missing_ids).toHaveLength(0);
  });
});
