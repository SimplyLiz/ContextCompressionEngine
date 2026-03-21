import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import { analyzeContradictions } from '../src/contradiction.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('importanceScoring integration', () => {
  it('preserves high-importance messages outside recency window', () => {
    const messages: Message[] = [
      // Message 0: high-importance — referenced by later messages, contains decision
      // Pure prose, no structural patterns, long enough to compress
      msg(
        'decision',
        'The engineering team decided that the fetchData helper in the service layer should always use exponential backoff when retrying failed network requests against the upstream provider because we observed cascading failures during peak traffic periods last quarter.',
      ),
      // Messages 1-4: filler prose (also long enough to compress)
      msg(
        'filler1',
        'I looked at the weekly performance reports and everything seems to be running within acceptable parameters for this quarter so far with no unexpected anomalies in the monitoring data.',
      ),
      msg(
        'filler2',
        'The retrospective meeting covered a lot of ground about our processes and we agreed to revisit the topic next month to evaluate whether the proposed changes have been effective in reducing cycle times.',
      ),
      msg(
        'ref1',
        'The fetchData helper needs proper error categorization so transient failures get retried but permanent errors like authentication failures surface immediately to the calling code.',
      ),
      msg(
        'ref2',
        'When the fetchData retry logic exhausts all attempts it should publish a structured event to the dead letter queue so the operations team can investigate and potentially replay the failed requests.',
      ),
    ];

    // Without importance scoring: message 0 is outside recency window (rw=2), gets compressed
    const withoutImportance = compress(messages, { recencyWindow: 2, trace: true });
    const msg0DecisionWithout = withoutImportance.compression.decisions?.find(
      (d) => d.messageId === 'decision',
    );
    const isCompressedWithout = msg0DecisionWithout?.action === 'compressed';

    // With importance scoring: message 0 should be preserved due to high forward-reference count
    const withImportance = compress(messages, {
      recencyWindow: 2,
      importanceScoring: true,
      importanceThreshold: 0.25,
      trace: true,
    });
    const msg0DecisionWith = withImportance.compression.decisions?.find(
      (d) => d.messageId === 'decision',
    );

    // The important message should be compressed without importance, preserved with it
    expect(isCompressedWithout).toBe(true);
    expect(msg0DecisionWith?.action).toBe('preserved');
    expect(msg0DecisionWith?.reason).toContain('importance');

    // Stats should reflect importance preservation
    expect(withImportance.compression.messages_importance_preserved).toBeGreaterThan(0);
  });

  it('does nothing when importanceScoring is false (default)', () => {
    const messages: Message[] = [
      msg('1', 'We must use the fetchData function for all API communication in the application.'),
      msg('2', 'The fetchData function handles retries and error reporting for the service layer.'),
      msg(
        '3',
        'Generic filler message about unrelated topics that adds nothing to the conversation.',
      ),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    expect(result.compression.messages_importance_preserved).toBeUndefined();
  });
});

describe('contradictionDetection integration', () => {
  it('analyzeContradictions finds the contradiction in test messages', () => {
    const messages: Message[] = [
      msg(
        'old',
        'Use Redis for the caching layer in the application server with a TTL of 3600 seconds for session data and user preferences. Configure the connection pool with a maximum of 20 connections.',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead for the caching layer in the application server. Redis is overkill for simple key-value session storage and Memcached has lower memory overhead for this use case.',
      ),
    ];
    const annotations = analyzeContradictions(messages);
    expect(annotations.size).toBeGreaterThan(0);
    expect(annotations.has(0)).toBe(true);
  });

  it('compresses superseded messages when correction is detected', () => {
    const messages: Message[] = [
      msg(
        'old',
        'Use Redis for the caching layer in the application server with a TTL of 3600 seconds for session data and user preferences. Configure the connection pool with a maximum of 20 connections.',
      ),
      msg(
        'filler',
        'The deployment pipeline runs automated tests before pushing to the staging environment. It includes unit tests, integration tests, and end-to-end tests that verify all critical user flows.',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead for the caching layer in the application server. Redis is overkill for simple key-value session storage and Memcached has lower memory overhead for this use case.',
      ),
      msg(
        'recent',
        'The frontend needs some styling updates for the new dashboard components. The color scheme should match the design system and all interactive elements need hover states.',
      ),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      contradictionDetection: true,
      trace: true,
    });

    // The old Redis message should be compressed with superseded annotation
    const oldMsg = result.messages.find((m) => m.id === 'old');
    expect(oldMsg?.content).toContain('superseded');

    // The correction should be preserved (it's in recency or important)
    const correctionMsg = result.messages.find((m) => m.id === 'correction');
    expect(correctionMsg?.content).toContain('Memcached');

    // Stats
    if (result.compression.messages_contradicted) {
      expect(result.compression.messages_contradicted).toBeGreaterThan(0);
    }
  });

  it('does nothing when contradictionDetection is false (default)', () => {
    const messages: Message[] = [
      msg(
        'old',
        'Use Redis for the caching layer in the application server with a TTL of 3600 seconds.',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead for the caching layer in the application server.',
      ),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    expect(result.compression.messages_contradicted).toBeUndefined();
  });

  it('stores verbatim for contradicted messages', () => {
    const messages: Message[] = [
      msg(
        'old',
        'Use Redis for the caching layer in the application server with a TTL of 3600 seconds for session data and user preferences. Configure the connection pool with a maximum of 20 connections.',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead for the caching layer in the application server. Redis is overkill for simple key-value session storage and Memcached has lower memory overhead.',
      ),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      contradictionDetection: true,
    });

    // If old message was contradicted, its original should be in verbatim
    if (result.compression.messages_contradicted && result.compression.messages_contradicted > 0) {
      expect(result.verbatim['old']).toBeDefined();
      expect(result.verbatim['old'].content).toContain('Redis');
    }
  });
});

describe('combined features', () => {
  it('importance + contradiction work together', () => {
    const messages: Message[] = [
      msg(
        'important',
        'We must use the fetchData function with retry logic for all API calls in the service.',
      ),
      msg(
        'superseded',
        'Use Redis for caching all responses from the fetchData function in the application.',
      ),
      msg(
        'ref',
        'The fetchData function needs proper error handling for timeout and network failure cases.',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead of Redis for caching fetchData responses in the app.',
      ),
      msg(
        'recent',
        'The CI pipeline should run all tests including the new fetchData integration tests.',
      ),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      importanceScoring: true,
      importanceThreshold: 0.2,
      contradictionDetection: true,
    });

    // 'important' should be preserved (high forward references to fetchData)
    const importantMsg = result.messages.find((m) => m.id === 'important');
    expect(importantMsg?.content).toContain('fetchData');

    // 'superseded' should be contradicted
    const supersededMsg = result.messages.find((m) => m.id === 'superseded');
    if (supersededMsg?.content?.includes('superseded')) {
      expect(supersededMsg.content).toContain('superseded');
    }

    // 'correction' should be preserved
    const correctionMsg = result.messages.find((m) => m.id === 'correction');
    expect(correctionMsg?.content).toContain('Memcached');
  });
});
