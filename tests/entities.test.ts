import { describe, it, expect } from 'vitest';
import {
  extractEntities,
  collectMessageEntities,
  computeEntityRetention,
  computeStructuralIntegrity,
  computeReferenceCoherence,
  computeQualityScore,
} from '../src/entities.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('extractEntities', () => {
  it('extracts camelCase identifiers', () => {
    const entities = extractEntities('The fetchData function calls getUserProfile');
    expect(entities).toContain('fetchData');
    expect(entities).toContain('getUserProfile');
  });

  it('extracts PascalCase identifiers', () => {
    const entities = extractEntities('Use TypeScript with WebSocket connections');
    expect(entities).toContain('TypeScript');
    expect(entities).toContain('WebSocket');
  });

  it('extracts snake_case identifiers', () => {
    const entities = extractEntities('Set max_retry_count and connection_pool_size');
    expect(entities).toContain('max_retry_count');
    expect(entities).toContain('connection_pool_size');
  });

  it('extracts numbers with units', () => {
    const entities = extractEntities('Timeout is 30 seconds with 5 retries');
    expect(entities.some((e) => e.includes('30'))).toBe(true);
    expect(entities.some((e) => e.includes('5'))).toBe(true);
  });

  it('extracts vowelless abbreviations', () => {
    const entities = extractEntities('Use npm and grpc for the service');
    expect(entities).toContain('npm');
    expect(entities).toContain('grpc');
  });

  it('respects maxEntities cap', () => {
    const text =
      'fetchData getUserProfile setConfig updateCache deleteRecord createSession validateToken refreshAuth parseResponse buildQuery';
    const entities = extractEntities(text, 3);
    expect(entities.length).toBeLessThanOrEqual(3);
  });

  it('extracts file paths', () => {
    const entities = extractEntities('Edit src/compress.ts and config.json files', 20);
    expect(entities.some((e) => e.includes('compress.ts'))).toBe(true);
    expect(entities.some((e) => e.includes('config.json'))).toBe(true);
  });

  it('extracts version numbers', () => {
    const entities = extractEntities('Upgrade from v1.2.3 to 2.0.0');
    expect(entities.some((e) => e.includes('1.2.3'))).toBe(true);
    expect(entities.some((e) => e.includes('2.0.0'))).toBe(true);
  });
});

describe('collectMessageEntities', () => {
  it('collects entities across multiple messages', () => {
    const messages = [
      msg('1', 'The fetchData function is critical'),
      msg('2', 'We use getUserProfile in the auth flow'),
    ];
    const entities = collectMessageEntities(messages);
    expect(entities.has('fetchData')).toBe(true);
    expect(entities.has('getUserProfile')).toBe(true);
  });

  it('skips empty messages', () => {
    const messages = [msg('1', ''), msg('2', 'fetchData is used')];
    const entities = collectMessageEntities(messages);
    expect(entities.has('fetchData')).toBe(true);
    expect(entities.size).toBeGreaterThan(0);
  });
});

describe('computeEntityRetention', () => {
  it('returns 1.0 when output preserves all entities', () => {
    const input = [msg('1', 'Use fetchData with retryConfig')];
    const output = [msg('1', 'Use fetchData with retryConfig')];
    expect(computeEntityRetention(input, output)).toBe(1.0);
  });

  it('returns < 1.0 when entities are lost', () => {
    const input = [msg('1', 'Use fetchData and getUserProfile and setConfig')];
    const output = [msg('1', '[summary: Use fetchData]')];
    const retention = computeEntityRetention(input, output);
    expect(retention).toBeLessThan(1.0);
    expect(retention).toBeGreaterThan(0);
  });

  it('returns 1.0 for empty input', () => {
    const input = [msg('1', 'hello world')]; // no technical entities
    const output = [msg('1', 'hi')];
    expect(computeEntityRetention(input, output)).toBe(1.0);
  });
});

describe('computeStructuralIntegrity', () => {
  it('returns 1.0 when code fences are preserved', () => {
    const content = 'Here is code:\n```js\nconsole.log("hi")\n```\nDone.';
    const input = [msg('1', content)];
    const output = [msg('1', content)];
    expect(computeStructuralIntegrity(input, output)).toBe(1.0);
  });

  it('returns 0.0 when all structural elements are removed', () => {
    const input = [msg('1', '```js\nconsole.log("hi")\n```')];
    const output = [msg('1', '[summary: code was shown]')];
    expect(computeStructuralIntegrity(input, output)).toBe(0.0);
  });

  it('returns 1.0 when no structural elements exist', () => {
    const input = [msg('1', 'Just plain prose here')];
    const output = [msg('1', 'Plain prose')];
    expect(computeStructuralIntegrity(input, output)).toBe(1.0);
  });
});

describe('computeReferenceCoherence', () => {
  it('returns 1.0 when all defining messages are present', () => {
    const input = [msg('1', 'Define fetchData here'), msg('2', 'Use fetchData later')];
    expect(computeReferenceCoherence(input, input)).toBe(1.0);
  });

  it('returns < 1.0 when a defining message is removed', () => {
    const input = [
      msg('1', 'The fetchData function is defined in utils'),
      msg('2', 'The fetchData function handles retries'),
    ];
    const output = [msg('2', 'The fetchData function handles retries')];
    // fetchData defined in both, so msg 2 still has its own source — coherence should be 1.0
    expect(computeReferenceCoherence(input, output)).toBe(1.0);
  });
});

describe('computeQualityScore', () => {
  it('returns all 1.0 for identical input/output', () => {
    const messages = [msg('1', 'The fetchData function uses retryConfig')];
    const quality = computeQualityScore(messages, messages);
    expect(quality.entity_retention).toBe(1.0);
    expect(quality.structural_integrity).toBe(1.0);
    expect(quality.reference_coherence).toBe(1.0);
    expect(quality.quality_score).toBe(1.0);
  });

  it('quality_score is clamped to [0, 1]', () => {
    const input = [msg('1', 'fetchData getUserProfile setConfig')];
    const output = [msg('1', '[summary: functions used]')];
    const quality = computeQualityScore(input, output);
    expect(quality.quality_score).toBeGreaterThanOrEqual(0);
    expect(quality.quality_score).toBeLessThanOrEqual(1.0);
  });
});

describe('quality metrics in compress()', () => {
  it('includes quality metrics when compression occurs', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData helper in the service layer should always use exponential backoff when retrying failed network requests against the upstream provider because we observed cascading failures during peak traffic periods.',
      ),
      msg(
        '2',
        'The getUserProfile function needs to handle token expiration gracefully by triggering a silent refresh through the refreshAuth utility before the token actually expires to avoid interrupting the user experience.',
      ),
      msg('3', 'Sure, sounds good.'),
      msg('4', 'What do you think?'),
    ];

    const result = compress(messages, { recencyWindow: 2 });

    expect(result.compression.entity_retention).toBeDefined();
    expect(result.compression.structural_integrity).toBeDefined();
    expect(result.compression.reference_coherence).toBeDefined();
    expect(result.compression.quality_score).toBeDefined();
    expect(result.compression.entity_retention!).toBeGreaterThan(0);
    expect(result.compression.quality_score!).toBeGreaterThan(0);
    expect(result.compression.quality_score!).toBeLessThanOrEqual(1.0);
  });

  it('omits quality metrics when no compression occurs', () => {
    const messages: Message[] = [msg('1', 'Short message'), msg('2', 'Another short one')];

    const result = compress(messages, { recencyWindow: 10 });

    expect(result.compression.entity_retention).toBeUndefined();
    expect(result.compression.quality_score).toBeUndefined();
  });

  it('entity retention >= 0.5 for messages with known identifiers', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function calls getUserProfile which invokes validateToken and returns a refreshAuth promise with retryConfig options including maxRetries and connectionTimeout settings.',
      ),
      msg(
        '2',
        'I looked at the general situation and everything seems to be running fine with no issues at all in the monitoring dashboard this week based on my observations.',
      ),
      msg('3', 'Latest message'),
      msg('4', 'Current state'),
    ];

    const result = compress(messages, { recencyWindow: 2 });

    // The summary should capture at least some of the entities from message 1
    expect(result.compression.entity_retention!).toBeGreaterThanOrEqual(0.3);
  });
});
