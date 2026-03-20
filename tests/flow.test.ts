import { describe, it, expect } from 'vitest';
import { detectFlowChains, summarizeChain } from '../src/flow.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('detectFlowChains', () => {
  it('detects Q&A pairs', () => {
    const messages: Message[] = [
      msg(
        'q',
        'How does the fetchData function handle retries when the upstream service is unavailable?',
        'user',
      ),
      msg(
        'a',
        'The fetchData function uses exponential backoff with a base delay of 200ms and a maximum of 5 retries. It also implements a circuit breaker pattern.',
        'assistant',
      ),
      msg('recent', 'Thanks!', 'user'),
    ];

    const chains = detectFlowChains(messages, 2, new Set(['system']));
    expect(chains.length).toBe(1);
    expect(chains[0].type).toBe('qa');
    expect(chains[0].indices).toContain(0);
    expect(chains[0].indices).toContain(1);
  });

  it('detects request → action chains', () => {
    const messages: Message[] = [
      msg('req', 'Can you add logging to the authentication middleware for debugging?', 'user'),
      msg(
        'action',
        "Done! I've added structured logging to the auth middleware. Each request now logs the token validation step and any errors.",
        'assistant',
      ),
      msg('conf', 'Perfect, thanks!', 'user'),
      msg('recent', 'Now lets work on the API.', 'user'),
    ];

    const chains = detectFlowChains(messages, 3, new Set(['system']));
    expect(chains.length).toBe(1);
    expect(chains[0].type).toBe('request_action');
    expect(chains[0].indices).toContain(0);
    expect(chains[0].indices).toContain(1);
    // Confirmation should be included
    expect(chains[0].indices).toContain(2);
  });

  it('detects correction chains', () => {
    const messages: Message[] = [
      msg(
        'original',
        'Use Redis for the caching layer with a 3600 second TTL for all session data.',
        'user',
      ),
      msg(
        'correction',
        'Actually, use Memcached instead. Redis is overkill for simple key-value session storage.',
        'user',
      ),
      msg('recent', 'Got it.', 'assistant'),
    ];

    const chains = detectFlowChains(messages, 2, new Set(['system']));
    expect(chains.length).toBe(1);
    expect(chains[0].type).toBe('correction');
  });

  it('skips system messages', () => {
    const messages: Message[] = [
      msg('sys', 'You are a helpful assistant.', 'system'),
      msg('q', 'How does authentication work in this app?', 'user'),
      msg('recent', 'It uses JWT tokens.', 'assistant'),
    ];

    const chains = detectFlowChains(messages, 2, new Set(['system']));
    // System message should not be part of any chain
    for (const chain of chains) {
      expect(chain.indices).not.toContain(0);
    }
  });

  it('returns empty for messages all in recency window', () => {
    const messages: Message[] = [
      msg('1', 'How does it work?', 'user'),
      msg('2', 'It uses JWT tokens.', 'assistant'),
    ];

    const chains = detectFlowChains(messages, 0, new Set(['system']));
    expect(chains).toHaveLength(0);
  });
});

describe('summarizeChain', () => {
  it('produces Q&A summary', () => {
    const messages: Message[] = [
      msg('q', 'How does the fetchData function handle retries?', 'user'),
      msg('a', 'It uses exponential backoff with 5 retries.', 'assistant'),
    ];

    const chain = { indices: [0, 1], type: 'qa' as const, label: 'test' };
    const summary = summarizeChain(chain, messages);
    expect(summary).toContain('Q:');
    expect(summary).toContain('A:');
  });

  it('produces request→action summary', () => {
    const messages: Message[] = [
      msg('req', 'Can you add logging to the auth middleware?', 'user'),
      msg('action', 'Done! Added structured logging.', 'assistant'),
      msg('conf', 'Perfect!', 'user'),
    ];

    const chain = { indices: [0, 1, 2], type: 'request_action' as const, label: 'test' };
    const summary = summarizeChain(chain, messages);
    expect(summary).toContain('Request:');
    expect(summary).toContain('confirmed');
  });

  it('produces correction summary', () => {
    const messages: Message[] = [
      msg('old', 'Use Redis for caching.', 'user'),
      msg('fix', 'Actually, use Memcached instead.', 'user'),
    ];

    const chain = { indices: [0, 1], type: 'correction' as const, label: 'test' };
    const summary = summarizeChain(chain, messages);
    expect(summary).toContain('Correction:');
    expect(summary).toContain('Memcached');
  });
});

describe('conversationFlow option in compress()', () => {
  it('compresses Q&A pairs as units', () => {
    const messages: Message[] = [
      msg(
        'q',
        'How does the fetchData function handle retries when the upstream service is down and returning 503 errors consistently across all endpoints in the distributed system?',
        'user',
      ),
      msg(
        'a',
        'The fetchData function uses exponential backoff with a base delay of 200 milliseconds and a maximum of 5 retries before giving up and throwing a ServiceUnavailable error to the calling service layer code.',
        'assistant',
      ),
      msg(
        'filler',
        'I also looked at the general monitoring data and everything seems to be running within acceptable parameters for this quarter without any unexpected issues in the system.',
        'assistant',
      ),
      msg('recent1', 'What about caching?', 'user'),
      msg('recent2', 'We can add Redis caching.', 'assistant'),
    ];

    const withFlow = compress(messages, {
      recencyWindow: 2,
      conversationFlow: true,
      trace: true,
    });

    // Q&A should be compressed as a unit
    const flowDecisions = withFlow.compression.decisions?.filter((d) =>
      d.reason.startsWith('flow:'),
    );
    expect(flowDecisions?.length).toBeGreaterThan(0);

    // The compressed Q&A should mention both question and answer
    const qaMsg = withFlow.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('Q:'),
    );
    expect(qaMsg).toBeDefined();
  });

  it('does nothing when conversationFlow is false', () => {
    const messages: Message[] = [
      msg(
        'q',
        'How does the fetchData function handle retries when upstream returns 503 errors and the circuit breaker is open?',
        'user',
      ),
      msg(
        'a',
        'It uses exponential backoff with a maximum of 5 retries and 200ms base delay before throwing ServiceUnavailable.',
        'assistant',
      ),
      msg('recent', 'Got it.', 'user'),
    ];

    const result = compress(messages, { recencyWindow: 1, trace: true });
    const flowDecisions = result.compression.decisions?.filter((d) => d.reason.startsWith('flow:'));
    expect(flowDecisions?.length ?? 0).toBe(0);
  });

  it('preserves verbatim store for flow-compressed messages', () => {
    const messages: Message[] = [
      msg(
        'q',
        'How does the fetchData function handle retries when the upstream service returns 503 errors during peak traffic?',
        'user',
      ),
      msg(
        'a',
        'The fetchData function uses exponential backoff with a base delay of 200 milliseconds. After 5 retries it throws a ServiceUnavailable error.',
        'assistant',
      ),
      msg('recent', 'Thanks, that helps.', 'user'),
    ];

    const result = compress(messages, {
      recencyWindow: 1,
      conversationFlow: true,
    });

    // Both original messages should be in verbatim
    if (result.compression.messages_compressed > 0) {
      expect(result.verbatim['q']).toBeDefined();
      expect(result.verbatim['a']).toBeDefined();
    }
  });
});
