import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../src/sqlite-store.js';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { Message } from '../src/types.js';

function msg(id: string, index: number, role: string, content: string): Message {
  return { id, index, role, content, metadata: {} };
}

function makeMessages(): Message[] {
  return [
    msg('1', 0, 'system', 'You are a helpful assistant.'),
    msg('2', 1, 'user', 'Explain how caching works in distributed systems.'),
    msg(
      '3',
      2,
      'assistant',
      'Caching in distributed systems involves storing frequently accessed data in a fast storage layer. ' +
        'The cache invalidation strategy determines when stale entries are removed. ' +
        'Common approaches include TTL-based expiration, write-through caching, and cache-aside patterns. ' +
        'Each approach has different trade-offs for consistency, latency, and complexity. '.repeat(
          3,
        ),
    ),
    msg('4', 3, 'user', 'What about Redis specifically?'),
    msg(
      '5',
      4,
      'assistant',
      'Redis is an in-memory data structure store that supports multiple data types including strings, hashes, lists, and sorted sets. ' +
        'It provides built-in replication, Lua scripting, LRU eviction, and persistence options. '.repeat(
          3,
        ),
    ),
  ];
}

describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(async () => {
    store = await SqliteStore.open(':memory:');
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });

  it('opens an in-memory database', async () => {
    const s = await SqliteStore.open(':memory:');
    expect(s).toBeInstanceOf(SqliteStore);
    s.close();
  });

  it('save and load roundtrip', () => {
    const messages = makeMessages();
    const result = compress(messages, { recencyWindow: 0 });

    store.save('conv-1', result);
    const loaded = store.load('conv-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toEqual(result.messages);
    expect(loaded!.verbatim).toEqual(result.verbatim);
  });

  it('load returns null for nonexistent conversation', () => {
    expect(store.load('nonexistent')).toBeNull();
  });

  it('save replaces messages but accumulates verbatim', () => {
    const messages = makeMessages();
    const result1 = compress(messages, { recencyWindow: 0 });
    store.save('conv-1', result1);

    const verbatimCount1 = Object.keys(result1.verbatim).length;

    // Second compression with different messages
    const messages2 = [
      msg(
        '10',
        0,
        'user',
        'New conversation content about deployment pipelines and CI/CD. '.repeat(5),
      ),
      msg(
        '11',
        1,
        'assistant',
        'Deployment pipelines automate the build, test, and release process. '.repeat(5),
      ),
    ];
    const result2 = compress(messages2, { recencyWindow: 0 });
    store.save('conv-1', result2);

    const loaded = store.load('conv-1');
    expect(loaded).not.toBeNull();

    // Messages should be from the second save only
    expect(loaded!.messages).toEqual(result2.messages);

    // Verbatim should contain entries from both rounds
    const totalVerbatim = Object.keys(loaded!.verbatim).length;
    const verbatimCount2 = Object.keys(result2.verbatim).length;
    expect(totalVerbatim).toBe(verbatimCount1 + verbatimCount2);
  });

  it('lookup returns a working StoreLookup function for uncompress', () => {
    const messages = makeMessages();
    const result = compress(messages, { recencyWindow: 0 });
    store.save('conv-1', result);

    const lookupFn = store.lookup('conv-1');
    const expanded = uncompress(result.messages, lookupFn);

    expect(expanded.missing_ids).toEqual([]);
    expect(expanded.messages).toEqual(messages);
  });

  it('lookup returns undefined for missing IDs', () => {
    const lookupFn = store.lookup('conv-1');
    expect(lookupFn('nonexistent-id')).toBeUndefined();
  });

  it('delete removes conversation', () => {
    const messages = makeMessages();
    const result = compress(messages, { recencyWindow: 0 });
    store.save('conv-1', result);

    store.delete('conv-1');
    expect(store.load('conv-1')).toBeNull();

    // Verbatim should also be gone
    const lookupFn = store.lookup('conv-1');
    for (const id of Object.keys(result.verbatim)) {
      expect(lookupFn(id)).toBeUndefined();
    }
  });

  it('multiple conversations are isolated', () => {
    const messages = makeMessages();
    const result = compress(messages, { recencyWindow: 0 });
    store.save('conv-a', result);

    const other = [msg('20', 0, 'user', 'Different conversation entirely.')];
    const result2 = compress(other, { recencyWindow: 0 });
    store.save('conv-b', result2);

    const loadedA = store.load('conv-a');
    const loadedB = store.load('conv-b');

    expect(loadedA!.messages).toEqual(result.messages);
    expect(loadedB!.messages).toEqual(result2.messages);
    expect(Object.keys(loadedA!.verbatim).length).toBe(Object.keys(result.verbatim).length);
  });

  it('list returns stored conversation IDs', () => {
    const messages = makeMessages();
    const result = compress(messages, { recencyWindow: 0 });
    store.save('conv-b', result);
    store.save('conv-a', result);

    const ids = store.list();
    expect(ids).toEqual(['conv-a', 'conv-b']);
  });

  it('list returns empty array when no conversations stored', () => {
    expect(store.list()).toEqual([]);
  });

  it('messages with extra fields survive serialization', () => {
    const messages: Message[] = [
      {
        id: '1',
        index: 0,
        role: 'assistant',
        content: 'Test content that is long enough to trigger compression in the pipeline. '.repeat(
          5,
        ),
        metadata: { custom: 'value' },
        tool_calls: [{ id: 'tc1', function: { name: 'test', arguments: '{}' } }],
        customField: 42,
      },
    ];
    const result = compress(messages, { recencyWindow: 0 });
    store.save('conv-1', result);

    const loaded = store.load('conv-1');
    expect(loaded).not.toBeNull();

    // The messages array from compress might have modified the content,
    // but all fields present in the result should survive the roundtrip
    expect(loaded!.messages).toEqual(result.messages);
  });

  it('recursive uncompress works across multiple compression rounds', () => {
    const messages = makeMessages();

    // Round 1: compress
    const round1 = compress(messages, { recencyWindow: 0 });
    store.save('conv-1', round1);

    // Round 2: compress the already-compressed messages again
    const round2 = compress(round1.messages, { recencyWindow: 0 });
    store.save('conv-1', round2);

    // Recursive uncompress should restore originals through the chain
    const lookupFn = store.lookup('conv-1');
    const expanded = uncompress(round2.messages, lookupFn, { recursive: true });

    // Should have no missing IDs — both rounds' verbatim entries are in the store
    expect(expanded.missing_ids).toEqual([]);
    expect(expanded.messages).toEqual(messages);
  });

  it('close prevents subsequent operations', () => {
    store.close();
    expect(() => store.list()).toThrow();
  });
});
