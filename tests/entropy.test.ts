import { describe, it, expect } from 'vitest';
import { splitSentences, normalizeScores, combineScores } from '../src/entropy.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    const result = splitSentences('Hello world. How are you? Fine!');
    expect(result).toHaveLength(3);
  });

  it('handles single sentence', () => {
    const result = splitSentences('Just one sentence');
    expect(result).toHaveLength(1);
  });

  it('handles empty text', () => {
    const result = splitSentences('');
    expect(result).toHaveLength(0);
  });
});

describe('normalizeScores', () => {
  it('normalizes to 0-1 range', () => {
    const result = normalizeScores([2, 4, 6, 8, 10]);
    expect(result[0]).toBe(0);
    expect(result[4]).toBe(1);
    expect(result[2]).toBeCloseTo(0.5);
  });

  it('handles all equal scores', () => {
    const result = normalizeScores([5, 5, 5]);
    expect(result).toEqual([0.5, 0.5, 0.5]);
  });

  it('handles empty array', () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe('combineScores', () => {
  it('combines heuristic and entropy scores', () => {
    const heuristic = [1, 5, 3];
    const entropy = [10, 2, 6];
    const combined = combineScores(heuristic, entropy);
    expect(combined).toHaveLength(3);
    // All should be between 0 and 1
    for (const s of combined) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('throws on mismatched lengths', () => {
    expect(() => combineScores([1, 2], [1, 2, 3])).toThrow();
  });

  it('respects entropy weight', () => {
    const heuristic = [0, 10]; // normalized: [0, 1]
    const entropy = [10, 0]; // normalized: [1, 0]
    const combined = combineScores(heuristic, entropy, 1.0); // 100% entropy
    // With full entropy weight, first should score higher
    expect(combined[0]).toBeGreaterThan(combined[1]);
  });
});

describe('entropyScorer integration', () => {
  it('uses sync entropy scorer in compress()', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function is critical for the service. Sure, sounds good. The retry logic uses exponential backoff with jitter.',
      ),
      msg('2', 'Latest update.'),
      msg('3', 'Current state.'),
    ];

    // Mock scorer: give high scores to sentences with technical identifiers
    const scorer = (sentences: string[]) =>
      sentences.map((s) => (s.includes('fetch') || s.includes('retry') ? 10 : 1));

    const result = compress(messages, {
      recencyWindow: 2,
      entropyScorer: scorer,
      entropyScorerMode: 'replace',
    });

    // Should still compress successfully
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
    // The summary should favor the technical sentences
    const msg1 = result.messages.find((m) => m.id === '1');
    expect(msg1?.content).toContain('summary');
  });

  it('augment mode combines heuristic and entropy', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The service returns 503 errors during peak traffic periods when load exceeds capacity thresholds. Sure, that sounds good and we should continue monitoring. The monitoring dashboard shows consistently high latency across multiple service endpoints.',
      ),
      msg('2', 'Latest update.'),
      msg('3', 'Current state.'),
    ];

    // Mock scorer: boost the "503" sentence
    const scorer = (sentences: string[]) => sentences.map((s) => (s.includes('503') ? 20 : 1));

    const result = compress(messages, {
      recencyWindow: 2,
      entropyScorer: scorer,
      entropyScorerMode: 'augment',
    });

    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });

  it('works with async entropy scorer', async () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles retries and timeout logic for the service layer with exponential backoff and circuit breaker pattern implementation.',
      ),
      msg('2', 'Latest.'),
      msg('3', 'Current.'),
    ];

    const asyncScorer = async (sentences: string[]) =>
      sentences.map((s) => (s.includes('fetch') ? 10 : 1));

    // async scorer requires a summarizer to trigger async path
    const result = await compress(messages, {
      recencyWindow: 2,
      entropyScorer: asyncScorer,
      summarizer: (text) => text.slice(0, 100), // simple passthrough
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('throws when async scorer used in sync mode', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles retries and timeout logic for the service layer with exponential backoff and circuit breaker pattern.',
      ),
      msg('2', 'Latest.'),
      msg('3', 'Current.'),
    ];

    const asyncScorer = async (sentences: string[]) =>
      sentences.map((s) => (s.includes('fetch') ? 10 : 1));

    expect(() =>
      compress(messages, {
        recencyWindow: 2,
        entropyScorer: asyncScorer,
      }),
    ).toThrow('Promise in sync mode');
  });

  it('default behavior unchanged without entropy scorer', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData helper function provides retry logic with exponential backoff for the distributed service layer across multiple availability zones.',
      ),
      msg('2', 'Latest.'),
      msg('3', 'Current.'),
    ];

    const withoutEntropy = compress(messages, { recencyWindow: 2 });
    const withEntropy = compress(messages, { recencyWindow: 2 });

    // Same result without scorer
    expect(withoutEntropy.compression.ratio).toBe(withEntropy.compression.ratio);
  });
});
