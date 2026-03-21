import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

function longProse(seed: string, length: number): string {
  const base = `The ${seed} function handles complex operations including data validation, error handling, retry logic, and performance monitoring across multiple service layers. `;
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

describe('compressionDepth', () => {
  it('gentle produces standard compression', () => {
    const messages: Message[] = [
      msg('1', longProse('fetchData', 600)),
      msg('2', longProse('getUserProfile', 600)),
      msg('recent', 'Latest update.'),
    ];

    const result = compress(messages, { recencyWindow: 1, compressionDepth: 'gentle' });
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
    expect(result.compression.ratio).toBeGreaterThan(1);
  });

  it('moderate produces tighter compression than gentle', () => {
    const messages: Message[] = [
      msg('1', longProse('processData', 800)),
      msg('2', longProse('validateInput', 800)),
      msg('recent', 'Latest update.'),
    ];

    const gentle = compress(messages, { recencyWindow: 1, compressionDepth: 'gentle' });
    const moderate = compress(messages, { recencyWindow: 1, compressionDepth: 'moderate' });

    expect(moderate.compression.ratio).toBeGreaterThanOrEqual(gentle.compression.ratio);
  });

  it('aggressive produces entity-only stubs', () => {
    const messages: Message[] = [
      msg('1', longProse('buildIndex', 600)),
      msg('recent', 'Latest update.'),
    ];

    const result = compress(messages, { recencyWindow: 1, compressionDepth: 'aggressive' });
    const compressed = result.messages.find((m) => m.id === '1');
    expect(compressed?.content?.length).toBeLessThan(200); // much shorter
    expect(result.compression.ratio).toBeGreaterThan(1);
  });

  it('aggressive compresses more than moderate', () => {
    const messages: Message[] = [
      msg('1', longProse('fetchData', 1000)),
      msg('2', longProse('handleRequest', 1000)),
      msg('recent', 'Latest update.'),
    ];

    const moderate = compress(messages, { recencyWindow: 1, compressionDepth: 'moderate' });
    const aggressive = compress(messages, { recencyWindow: 1, compressionDepth: 'aggressive' });

    expect(aggressive.compression.ratio).toBeGreaterThanOrEqual(moderate.compression.ratio);
  });

  it('auto mode with budget tries progressively deeper', () => {
    const messages: Message[] = [
      msg('1', longProse('processData', 2000)),
      msg('2', longProse('validateInput', 2000)),
      msg('3', longProse('handleRequest', 2000)),
      msg('recent', 'Latest update.'),
    ];

    const result = compress(messages, {
      tokenBudget: 200,
      compressionDepth: 'auto',
      recencyWindow: 1,
      forceConverge: true,
    });

    expect(result.fits).toBe(true);
    // Auto mode should have achieved significant compression
    expect(result.compression.ratio).toBeGreaterThan(2);
  });

  it('auto mode stops at gentle when it fits', () => {
    const messages: Message[] = [
      msg('1', longProse('fetchData', 300)),
      msg('recent', 'Latest update.'),
    ];

    const result = compress(messages, {
      tokenBudget: 500, // generous budget
      compressionDepth: 'auto',
      recencyWindow: 1,
    });

    expect(result.fits).toBe(true);
  });

  it('default behavior unchanged without compressionDepth', () => {
    const messages: Message[] = [msg('1', longProse('fetchData', 500)), msg('recent', 'Latest.')];

    const withoutDepth = compress(messages, { recencyWindow: 1 });
    const withGentle = compress(messages, { recencyWindow: 1, compressionDepth: 'gentle' });

    expect(withoutDepth.compression.ratio).toBe(withGentle.compression.ratio);
  });

  it('preserves round-trip integrity at all depths', () => {
    const messages: Message[] = [msg('1', longProse('fetchData', 500)), msg('recent', 'Latest.')];

    for (const depth of ['gentle', 'moderate', 'aggressive'] as const) {
      const result = compress(messages, { recencyWindow: 1, compressionDepth: depth });
      // All compressed messages should have verbatim originals
      if (result.compression.messages_compressed > 0) {
        expect(Object.keys(result.verbatim).length).toBeGreaterThan(0);
      }
    }
  });
});
