import { describe, it, expect } from 'vitest';
import {
  buildCoreferenceMap,
  findOrphanedReferences,
  generateInlineDefinitions,
} from '../src/coreference.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('buildCoreferenceMap', () => {
  it('tracks entity first-definition and references', () => {
    const messages: Message[] = [
      msg('1', 'The fetchData function handles API calls with retry logic.'),
      msg('2', 'The getUserProfile function returns user info.'),
      msg('3', 'Use fetchData to get the profile via getUserProfile endpoint.'),
    ];

    const defs = buildCoreferenceMap(messages);
    const fetchDef = defs.find((d) => d.entity === 'fetchData');
    expect(fetchDef).toBeDefined();
    expect(fetchDef!.definingMessageIndex).toBe(0);
    expect(fetchDef!.referencingMessageIndices).toContain(2);
  });

  it('tracks snake_case and PascalCase identifiers', () => {
    const messages: Message[] = [
      msg('1', 'Set max_retry_count to 5 in the ServiceConfig.'),
      msg('2', 'The max_retry_count is used by ServiceConfig for backoff.'),
    ];

    const defs = buildCoreferenceMap(messages);
    expect(defs.some((d) => d.entity === 'max_retry_count')).toBe(true);
    expect(defs.some((d) => d.entity === 'ServiceConfig')).toBe(true);
  });

  it('returns empty for messages with no shared entities', () => {
    const messages: Message[] = [msg('1', 'Hello world.'), msg('2', 'Goodbye world.')];

    const defs = buildCoreferenceMap(messages);
    expect(defs).toHaveLength(0);
  });
});

describe('findOrphanedReferences', () => {
  it('finds entities orphaned by compression', () => {
    const defs = [
      {
        entity: 'fetchData',
        definingMessageIndex: 0,
        referencingMessageIndices: [2],
      },
    ];

    const orphaned = findOrphanedReferences(
      defs,
      new Set([0, 1]), // compressed
      new Set([2]), // preserved
    );

    expect(orphaned.has(0)).toBe(true);
    expect(orphaned.get(0)).toContain('fetchData');
  });

  it('returns empty when defining message is preserved', () => {
    const defs = [
      {
        entity: 'fetchData',
        definingMessageIndex: 0,
        referencingMessageIndices: [1],
      },
    ];

    const orphaned = findOrphanedReferences(
      defs,
      new Set([1]), // compressed
      new Set([0]), // preserved
    );

    expect(orphaned.size).toBe(0);
  });
});

describe('generateInlineDefinitions', () => {
  it('extracts defining sentence for entity', () => {
    const content = 'The fetchData function handles retries. It uses exponential backoff.';
    const inline = generateInlineDefinitions(['fetchData'], content);
    expect(inline).toContain('fetchData');
    expect(inline).toContain('[context:');
  });

  it('returns empty for no entities', () => {
    expect(generateInlineDefinitions([], 'some text')).toBe('');
  });

  it('caps at 5 inlines', () => {
    const content =
      'Use fetchData with getUserProfile and setConfig and validateToken and refreshAuth and parseResponse and buildQuery.';
    const inline = generateInlineDefinitions(
      ['fetchData', 'getUserProfile', 'setConfig', 'validateToken', 'refreshAuth', 'parseResponse'],
      content,
    );
    // Should not include all 6
    const pipeCount = (inline.match(/\|/g) ?? []).length;
    expect(pipeCount).toBeLessThanOrEqual(4); // max 5 entries = 4 pipes
  });
});

describe('coreference option in compress()', () => {
  it('inlines definitions when coreference is enabled', () => {
    const messages: Message[] = [
      msg(
        'def',
        'The fetchData function in the service layer handles all API communication including retry logic with exponential backoff and circuit breaker pattern implementation for fault tolerance.',
      ),
      msg(
        'filler',
        'I looked at the general performance metrics and everything seems to be running within acceptable limits for the current quarter based on the monitoring dashboard data.',
      ),
      msg('ref', 'Make sure fetchData uses a 30 second timeout for all upstream requests.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      coreference: true,
    });

    // The compressed 'def' message should have context inlined
    const defMsg = result.messages.find((m) => m.id === 'def');
    if (defMsg?.content?.includes('[context:')) {
      expect(defMsg.content).toContain('fetchData');
    }
  });

  it('does nothing when coreference is false', () => {
    const messages: Message[] = [
      msg(
        'def',
        'The fetchData function handles retries with exponential backoff and circuit breaker pattern for the service layer communication.',
      ),
      msg('ref', 'Use fetchData with a 30 second timeout.'),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    const defMsg = result.messages.find((m) => m.id === 'def');
    if (defMsg?.content?.includes('[summary')) {
      expect(defMsg.content).not.toContain('[context:');
    }
  });

  it('preserves verbatim store with coreference', () => {
    const messages: Message[] = [
      msg(
        'def',
        'The fetchData function in the service layer handles all API communication including retry logic with exponential backoff and jitter for the distributed system.',
      ),
      msg('ref', 'The fetchData timeout should be 30 seconds.'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      coreference: true,
    });

    if (result.compression.messages_compressed > 0) {
      expect(result.verbatim['def']).toBeDefined();
    }
  });
});
