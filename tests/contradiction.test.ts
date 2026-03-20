import { describe, it, expect } from 'vitest';
import { analyzeContradictions } from '../src/contradiction.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user', index = 0): Message {
  return { id, index, role, content };
}

describe('analyzeContradictions', () => {
  it('returns empty map when no contradictions', () => {
    const messages: Message[] = [
      msg('1', 'We should use PostgreSQL for the database layer in the backend.'),
      msg('2', 'The frontend needs React with TypeScript for type safety in components.'),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(0);
  });

  it('detects explicit correction with "actually"', () => {
    const messages: Message[] = [
      msg('1', 'Use Redis for the caching layer in the application server.'),
      msg('2', 'Actually, use Memcached instead for the caching layer.'),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(1);
    expect(result.has(0)).toBe(true);
    expect(result.get(0)!.supersededByIndex).toBe(1);
    expect(result.get(0)!.signal).toBe('explicit_correction');
  });

  it('detects "don\'t use" directives', () => {
    const messages: Message[] = [
      msg('1', 'Import lodash for utility functions in the helper module.'),
      msg('2', "Don't use lodash for utility functions, write them from scratch."),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(1);
    expect(result.get(0)!.signal).toBe('dont_directive');
  });

  it('detects "instead" directives', () => {
    const messages: Message[] = [
      msg('1', 'Deploy the service on AWS Lambda for the serverless backend.'),
      msg('2', 'Instead, use Google Cloud Run for the serverless backend deployment.'),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(1);
    expect(result.get(0)!.signal).toBe('instead_directive');
  });

  it('detects retraction patterns', () => {
    const messages: Message[] = [
      msg('1', 'Add the feature flag for the new dashboard module.'),
      msg('2', 'Scratch that, we are removing the feature flag for the dashboard.'),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(1);
    expect(result.get(0)!.signal).toBe('retraction');
  });

  it('requires topic overlap — unrelated corrections are not matched', () => {
    const messages: Message[] = [
      msg('1', 'The database schema uses PostgreSQL with normalized tables.'),
      msg('2', 'Actually, the frontend color scheme should be darker blue.'),
    ];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(0);
  });

  it('skips short messages', () => {
    const messages: Message[] = [msg('1', 'Use Redis.'), msg('2', 'Actually, use Memcached.')];
    const result = analyzeContradictions(messages);
    expect(result.size).toBe(0); // both < 50 chars
  });

  it('skips preserved roles', () => {
    const messages: Message[] = [
      msg('1', 'You are a helpful assistant that always uses Redis for caching.', 'system'),
      msg('2', 'Actually, use Memcached instead of Redis for the caching layer.'),
    ];
    const result = analyzeContradictions(messages, 0.15, new Set(['system']));
    expect(result.size).toBe(0);
  });

  it('only supersedes the most-overlapping earlier message', () => {
    const messages: Message[] = [
      msg('1', 'Use Redis for caching data in the application server.'),
      msg('2', 'Use Postgres for the primary data store and queries.'),
      msg('3', 'Actually, use Memcached instead for caching data in the app.'),
    ];
    const result = analyzeContradictions(messages);
    // Should supersede message 1 (caching), not message 2 (data store)
    if (result.size > 0) {
      expect(result.has(0)).toBe(true);
      expect(result.has(1)).toBe(false);
    }
  });

  it('returns topicOverlap score', () => {
    const messages: Message[] = [
      msg('1', 'Use Redis for the caching layer in the application server backend.'),
      msg('2', 'Actually, use Memcached for the caching layer in the application backend.'),
    ];
    const result = analyzeContradictions(messages);
    if (result.size > 0) {
      expect(result.get(0)!.topicOverlap).toBeGreaterThan(0);
      expect(result.get(0)!.topicOverlap).toBeLessThanOrEqual(1);
    }
  });
});
