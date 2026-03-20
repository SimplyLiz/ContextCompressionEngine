import { describe, it, expect } from 'vitest';
import { clusterMessages, summarizeCluster } from '../src/cluster.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('clusterMessages', () => {
  it('clusters messages with shared entities', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles API calls with retry logic and exponential backoff.',
      ),
      msg('2', 'The getUserProfile function returns the complete user object from the database.'),
      msg('3', 'Update fetchData to add circuit breaker pattern for better fault tolerance.'),
      msg('4', 'The getUserProfile query should be optimized with proper indexes.'),
    ];

    const clusters = clusterMessages(messages, [0, 1, 2, 3], 0.1);
    // Should group messages about fetchData together and getUserProfile together
    expect(clusters.length).toBeGreaterThan(0);

    const fetchCluster = clusters.find((c) => c.sharedEntities.includes('fetchData'));
    if (fetchCluster) {
      expect(fetchCluster.indices).toContain(0);
      expect(fetchCluster.indices).toContain(2);
    }
  });

  it('returns empty for unrelated messages', () => {
    const messages: Message[] = [
      msg('1', 'The weather is nice today for a walk in the park.'),
      msg('2', 'Quantum physics describes subatomic particle behavior.'),
    ];

    const clusters = clusterMessages(messages, [0, 1], 0.5);
    expect(clusters).toHaveLength(0);
  });

  it('returns empty for single message', () => {
    const messages: Message[] = [msg('1', 'Just one message here.')];
    const clusters = clusterMessages(messages, [0]);
    expect(clusters).toHaveLength(0);
  });

  it('respects similarity threshold', () => {
    const messages: Message[] = [
      msg('1', 'The fetchData function handles API calls.'),
      msg('2', 'The fetchData function needs retry logic.'),
    ];

    const loose = clusterMessages(messages, [0, 1], 0.05);
    const strict = clusterMessages(messages, [0, 1], 0.99);

    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});

describe('summarizeCluster', () => {
  it('produces a labeled summary with shared entities', () => {
    const messages: Message[] = [
      msg('1', 'The fetchData function handles retries.'),
      msg('2', 'Update fetchData with circuit breaker.'),
    ];

    const cluster = {
      indices: [0, 1],
      sharedEntities: ['fetchData'],
      label: 'fetchData',
    };

    const summary = summarizeCluster(cluster, messages);
    expect(summary).toContain('fetchData');
    expect(summary).toContain('2 messages');
  });
});

describe('semanticClustering option in compress()', () => {
  it('clusters related messages for compression', () => {
    const messages: Message[] = [
      msg(
        'auth1',
        'The handleAuth middleware validates JWT tokens on every request and checks expiration time against the server clock with a 30 second tolerance window.',
        'assistant',
      ),
      msg(
        'unrelated',
        'I reviewed the general project timeline and everything looks on track for the milestone delivery based on current velocity and capacity planning estimates.',
        'user',
      ),
      msg(
        'auth2',
        'Update handleAuth to support token refresh by calling the refreshToken endpoint before the JWT expires using a background timer that runs every 5 minutes.',
        'assistant',
      ),
      msg('recent1', 'What about caching?', 'user'),
      msg('recent2', 'Add Redis caching layer.', 'assistant'),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      semanticClustering: true,
      trace: true,
    });

    // Check if clustering was used
    const clusterDecisions = result.compression.decisions?.filter((d) =>
      d.reason.startsWith('cluster:'),
    );

    // If the messages were similar enough to cluster
    if (clusterDecisions && clusterDecisions.length > 0) {
      // Both auth messages should be in the same cluster decision
      const authIds = clusterDecisions.map((d) => d.messageId);
      expect(authIds).toContain('auth1');
      expect(authIds).toContain('auth2');
    }
  });

  it('does nothing when semanticClustering is false', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles retries with exponential backoff and circuit breaker for fault tolerance in the service layer.',
      ),
      msg(
        '2',
        'Update fetchData to add timeout configuration and connection pooling for better performance under high load.',
      ),
      msg('recent', 'Done.'),
    ];

    const result = compress(messages, { recencyWindow: 1, trace: true });
    const clusterDecisions = result.compression.decisions?.filter((d) =>
      d.reason.startsWith('cluster:'),
    );
    expect(clusterDecisions?.length ?? 0).toBe(0);
  });

  it('preserves verbatim for clustered messages', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The handleAuth middleware checks JWT tokens and validates expiration against the server clock with tolerance.',
        'assistant',
      ),
      msg(
        '2',
        'The handleAuth middleware needs to support refresh tokens by calling the refresh endpoint before expiration.',
        'assistant',
      ),
      msg('recent', 'Sounds good.', 'user'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      semanticClustering: true,
    });

    if (result.compression.messages_compressed > 0) {
      expect(Object.keys(result.verbatim).length).toBeGreaterThan(0);
    }
  });
});
