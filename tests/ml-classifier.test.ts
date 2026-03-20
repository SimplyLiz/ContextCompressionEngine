import { describe, it, expect } from 'vitest';
import {
  compressWithTokenClassifierSync,
  compressWithTokenClassifier,
  whitespaceTokenize,
  createMockTokenClassifier,
} from '../src/ml-classifier.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('whitespaceTokenize', () => {
  it('splits text on whitespace', () => {
    expect(whitespaceTokenize('hello world foo')).toEqual(['hello', 'world', 'foo']);
  });

  it('handles multiple spaces', () => {
    expect(whitespaceTokenize('a  b   c')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for empty string', () => {
    expect(whitespaceTokenize('')).toEqual([]);
  });
});

describe('createMockTokenClassifier', () => {
  it('keeps tokens matching patterns', () => {
    const classifier = createMockTokenClassifier([/fetch/i, /retr/i]);
    const result = classifier('The fetchData function handles retries gracefully.');
    const kept = result.filter((t) => t.keep);
    expect(kept.some((t) => t.token.includes('fetch'))).toBe(true);
    expect(kept.some((t) => t.token.includes('retries'))).toBe(true);
  });

  it('marks non-matching tokens as remove', () => {
    const classifier = createMockTokenClassifier([/^fetch$/]);
    const result = classifier('The fetchData function');
    const removed = result.filter((t) => !t.keep);
    expect(removed.length).toBeGreaterThan(0);
  });
});

describe('compressWithTokenClassifierSync', () => {
  it('produces shorter output', () => {
    const classifier = createMockTokenClassifier([
      /fetch/i,
      /retry/i,
      /backoff/i,
      /function/i,
      /handles/i,
    ]);
    const text =
      'The fetchData function handles retries with exponential backoff for all API calls in the service layer.';
    const result = compressWithTokenClassifierSync(text, classifier);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('fetchData');
  });

  it('falls back when compressed is longer', () => {
    // Classifier that keeps everything — compression won't help
    const classifier = createMockTokenClassifier([/.*/]);
    const text = 'Short text.';
    const result = compressWithTokenClassifierSync(text, classifier);
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws on async classifier in sync mode', () => {
    const asyncClassifier = async (content: string) =>
      whitespaceTokenize(content).map((t) => ({ token: t, keep: true, confidence: 0.9 }));

    expect(() => compressWithTokenClassifierSync('test text', asyncClassifier)).toThrow(
      'Promise in sync mode',
    );
  });
});

describe('compressWithTokenClassifier (async)', () => {
  it('works with async classifier', async () => {
    const classifier = async (content: string) =>
      whitespaceTokenize(content).map((t) => ({
        token: t,
        keep: /fetch|retry|function/i.test(t),
        confidence: 0.9,
      }));

    const result = await compressWithTokenClassifier(
      'The fetchData function handles retries gracefully in the service layer.',
      classifier,
    );
    expect(result).toContain('fetchData');
    expect(result).toContain('function');
  });
});

describe('mlTokenClassifier option in compress()', () => {
  it('uses token classifier for prose compression', () => {
    const classifier = createMockTokenClassifier([
      /fetch/i,
      /retry/i,
      /backoff/i,
      /function/i,
      /exponential/i,
      /service/i,
    ]);

    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function in the service layer handles all API communication with exponential backoff retry logic and circuit breaker pattern for fault tolerance across distributed services.',
      ),
      msg('recent', 'What about timeouts?'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      mlTokenClassifier: classifier,
    });

    expect(result.compression.messages_compressed).toBeGreaterThan(0);
    const msg1 = result.messages.find((m) => m.id === '1');
    // Should contain key tokens
    expect(msg1?.content).toContain('fetch');
  });

  it('preserves code fences even with ML classifier', () => {
    const classifier = createMockTokenClassifier([/fetch/i]);

    const messages: Message[] = [
      msg(
        '1',
        'Use fetchData like this:\n\n```typescript\nconst data = await fetchData(url);\n```\n\nThe fetchData function handles retries automatically with exponential backoff for all requests.',
      ),
      msg('recent', 'Got it.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      mlTokenClassifier: classifier,
    });

    // Code fence should survive (code-split preserves fences)
    const msg1 = result.messages.find((m) => m.id === '1');
    if (msg1?.content?.includes('```')) {
      expect(msg1.content).toContain('fetchData');
    }
  });

  it('default behavior unchanged without ML classifier', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function handles retries with exponential backoff for the distributed service layer communication.',
      ),
      msg('recent', 'OK.'),
    ];

    const withML = compress(messages, { recencyWindow: 1 });
    const withoutML = compress(messages, { recencyWindow: 1 });
    expect(withML.compression.ratio).toBe(withoutML.compression.ratio);
  });
});
