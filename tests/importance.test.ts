import { describe, it, expect } from 'vitest';
import {
  computeImportance,
  scoreContentSignals,
  DEFAULT_IMPORTANCE_THRESHOLD,
} from '../src/importance.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('scoreContentSignals', () => {
  it('returns 0 for plain prose', () => {
    expect(scoreContentSignals('The weather is nice today.')).toBe(0);
  });

  it('scores decision content', () => {
    const score = scoreContentSignals('We must use PostgreSQL for the database.');
    expect(score).toBeGreaterThan(0);
  });

  it('scores correction content highest', () => {
    const correctionScore = scoreContentSignals('Actually, use Redis instead of Memcached.');
    const decisionScore = scoreContentSignals('We should use Redis for caching.');
    expect(correctionScore).toBeGreaterThan(decisionScore);
  });

  it('scores constraint content', () => {
    const score = scoreContentSignals('There is a hard deadline for this feature.');
    expect(score).toBeGreaterThan(0);
  });

  it('caps at 0.40', () => {
    // Message with all signals
    const score = scoreContentSignals(
      'Actually, we must use PostgreSQL. This is a hard requirement and a blocker for the deadline.',
    );
    expect(score).toBeLessThanOrEqual(0.4);
  });
});

describe('computeImportance', () => {
  it('returns empty map for empty messages', () => {
    const scores = computeImportance([]);
    expect(scores.size).toBe(0);
  });

  it('gives higher score to messages referenced by later messages', () => {
    const messages: Message[] = [
      msg('1', 'We should use the fetchData function to get results from the API.'),
      msg('2', 'The fetchData function needs error handling for timeout cases.'),
      msg('3', 'Also add retry logic to fetchData for network failures.'),
      msg('4', 'The weather looks nice today and I had a great lunch.'),
    ];

    const scores = computeImportance(messages);

    // Message 1 mentions fetchData which is referenced by messages 2 and 3
    const score1 = scores.get(0)!;
    const score4 = scores.get(3)!;
    expect(score1).toBeGreaterThan(score4);
  });

  it('gives recency bonus to later messages', () => {
    const messages: Message[] = [
      msg('1', 'Some generic content about nothing in particular here.'),
      msg('2', 'Another generic message about different unrelated topics.'),
    ];

    const scores = computeImportance(messages);
    // Message 2 (index 1) should have higher recency than message 1 (index 0)
    expect(scores.get(1)!).toBeGreaterThan(scores.get(0)!);
  });

  it('boosts messages with decision/correction content', () => {
    const messages: Message[] = [
      msg('1', 'The sky is blue and the grass is green today.'),
      msg('2', 'We must always validate user input before processing.'),
    ];

    const scores = computeImportance(messages);
    expect(scores.get(1)!).toBeGreaterThan(scores.get(0)!);
  });

  it('all scores are in 0–1 range', () => {
    const messages: Message[] = [
      msg('1', 'Actually, we must use the fetchData function. This is a hard requirement.'),
      msg('2', 'The fetchData function handles all API calls.'),
      msg('3', 'Make sure fetchData has retry logic.'),
    ];

    const scores = computeImportance(messages);
    for (const [_, score] of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('DEFAULT_IMPORTANCE_THRESHOLD', () => {
  it('is 0.35', () => {
    expect(DEFAULT_IMPORTANCE_THRESHOLD).toBe(0.35);
  });
});
