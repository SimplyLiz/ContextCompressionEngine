import { describe, it, expect } from 'vitest';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

function longProse(seed: string, length: number): string {
  const base = `The ${seed} function handles complex operations including data validation, error handling, retry logic, and performance monitoring across multiple service layers in the distributed system architecture. `;
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

describe('tiered budget strategy', () => {
  it('fits within budget while preserving recent messages', () => {
    const messages: Message[] = [
      msg('sys', 'You are a helpful assistant.', 'system'),
      msg('old1', longProse('processData', 500)),
      msg('old2', longProse('validateInput', 500)),
      msg('old3', longProse('handleRequest', 500)),
      msg('recent1', 'The fetchData function needs retry logic with exponential backoff.'),
      msg('recent2', 'Add the connectionPool configuration to the service layer.'),
    ];

    const result = compress(messages, {
      tokenBudget: 300,
      budgetStrategy: 'tiered',
      recencyWindow: 2,
      forceConverge: true,
    });

    // Recent messages should be preserved verbatim
    const recent1 = result.messages.find((m) => m.id === 'recent1');
    const recent2 = result.messages.find((m) => m.id === 'recent2');
    expect(recent1?.content).toContain('fetchData');
    expect(recent2?.content).toContain('connectionPool');

    // Should fit budget
    expect(result.fits).toBe(true);
  });

  it('preserves system messages', () => {
    const messages: Message[] = [
      msg('sys', 'You are a coding assistant. Always explain your reasoning.', 'system'),
      msg('old1', longProse('analyzeCode', 600)),
      msg('old2', longProse('refactorModule', 600)),
      msg('recent', 'What about the parseConfig function?'),
    ];

    const result = compress(messages, {
      tokenBudget: 200,
      budgetStrategy: 'tiered',
      recencyWindow: 1,
      forceConverge: true,
    });

    const sys = result.messages.find((m) => m.id === 'sys');
    expect(sys?.content).toContain('coding assistant');
  });

  it('compresses older messages before touching recent ones', () => {
    const messages: Message[] = [
      msg('old1', longProse('handleAuth', 400)),
      msg('old2', longProse('validateToken', 400)),
      msg('recent1', 'The getUserProfile function returns the complete user object.'),
      msg('recent2', 'We need to add caching to the fetchData service.'),
    ];

    const binaryResult = compress(messages, {
      tokenBudget: 200,
      budgetStrategy: 'binary-search',
      recencyWindow: 2,
    });

    const tieredResult = compress(messages, {
      tokenBudget: 200,
      budgetStrategy: 'tiered',
      recencyWindow: 2,
      forceConverge: true,
    });

    // Tiered should keep recent messages intact
    const tieredRecent1 = tieredResult.messages.find((m) => m.id === 'recent1');
    expect(tieredRecent1?.content).toContain('getUserProfile');

    // Binary search may have shrunk recencyWindow, potentially losing recent content
    // (or it may have compressed old messages differently)
    // Both should produce valid results
    expect(binaryResult.messages.length).toBeGreaterThan(0);
    expect(tieredResult.messages.length).toBeGreaterThan(0);
  });

  it('fits very tight budgets through progressive tightening and forceConverge', () => {
    const messages: Message[] = [
      msg('old1', longProse('buildIndex', 2000)),
      msg('old2', longProse('queryEngine', 2000)),
      msg('old3', longProse('cacheManager', 2000)),
      msg('recent', 'Check the results.'),
    ];

    const result = compress(messages, {
      tokenBudget: 100,
      budgetStrategy: 'tiered',
      recencyWindow: 1,
      forceConverge: true,
    });

    expect(result.fits).toBe(true);
    // Older messages should be heavily compressed (summary, stub, or truncated)
    const old1 = result.messages.find((m) => m.id === 'old1');
    expect(old1).toBeDefined();
    expect(old1!.content!.length).toBeLessThan(2000);
  });

  it('returns early when input already fits budget', () => {
    const messages: Message[] = [msg('1', 'Short message.'), msg('2', 'Another short one.')];

    const result = compress(messages, {
      tokenBudget: 1000,
      budgetStrategy: 'tiered',
    });

    expect(result.fits).toBe(true);
    expect(result.compression.messages_compressed).toBe(0);
  });

  it('preserves verbatim store for round-trip integrity', () => {
    const messages: Message[] = [
      msg('old', longProse('transformData', 600)),
      msg('recent', 'Latest update on the project.'),
    ];

    const result = compress(messages, {
      tokenBudget: 100,
      budgetStrategy: 'tiered',
      recencyWindow: 1,
      forceConverge: true,
    });

    // Old message should be in verbatim store
    if (result.compression.messages_compressed > 0) {
      expect(result.verbatim['old']).toBeDefined();
    }
  });

  it('quality metrics are present when compression occurs', () => {
    const messages: Message[] = [
      msg('old1', longProse('fetchData', 400)),
      msg('old2', longProse('getUserProfile', 400)),
      msg('recent', 'Check the service status.'),
    ];

    const result = compress(messages, {
      tokenBudget: 150,
      budgetStrategy: 'tiered',
      recencyWindow: 1,
      forceConverge: true,
    });

    expect(result.compression.quality_score).toBeDefined();
    expect(result.compression.entity_retention).toBeDefined();
  });
});
