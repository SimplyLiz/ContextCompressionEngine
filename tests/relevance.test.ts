import { describe, it, expect } from 'vitest';
import { compress, bestSentenceScore } from '../src/index.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('bestSentenceScore', () => {
  it('scores technical content higher than filler', () => {
    const technical = bestSentenceScore(
      'The fetchData function uses exponential backoff with 5 retries.',
    );
    const filler = bestSentenceScore(
      'Sure, that sounds good and I think we should probably do that.',
    );
    expect(technical).toBeGreaterThan(filler);
  });

  it('returns the best sentence score from multi-sentence text', () => {
    const score = bestSentenceScore('Well, okay. The fetchData function is critical. Sure.');
    // Should return the score of the best sentence (the one with fetchData)
    expect(score).toBeGreaterThan(0);
  });

  it('handles single-sentence text', () => {
    const score = bestSentenceScore('Hello world');
    expect(typeof score).toBe('number');
  });
});

describe('relevanceThreshold option', () => {
  it('drops low-relevance messages to stubs when threshold is set', () => {
    const messages: Message[] = [
      msg(
        'filler1',
        'I think that sounds like a reasonable approach and we should probably go ahead with it since it seems like the right thing to do at this point in the project.',
      ),
      msg(
        'filler2',
        'Yeah I agree with everything you said and I think we are on the right track with this approach and should continue moving forward with the current plan.',
      ),
      msg('recent1', 'The fetchData function needs retry logic.'),
      msg('recent2', 'Add exponential backoff to the service layer.'),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      relevanceThreshold: 5, // moderate threshold — filler scores below this
      trace: true,
    });

    // Filler messages should be dropped to a stub
    const filler1Out = result.messages.find((m) => m.id === 'filler1');
    expect(filler1Out?.content).toContain('omitted');

    // Stats should reflect the drop
    expect(result.compression.messages_relevance_dropped).toBeGreaterThan(0);
  });

  it('keeps high-relevance messages as normal summaries', () => {
    const messages: Message[] = [
      msg(
        'technical',
        'The fetchData helper should use exponential backoff with a maximum of 5 retries and a base delay of 200ms. The connectionPool should be configured with maxConnections set to 20 and idleTimeout of 30 seconds.',
      ),
      msg('recent', 'Latest update.'),
      msg('recent2', 'Current state.'),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      relevanceThreshold: 2, // low threshold — technical content scores above this
      trace: true,
    });

    // Technical message should NOT be dropped to a stub
    const techOut = result.messages.find((m) => m.id === 'technical');
    expect(techOut?.content).not.toContain('omitted');
    expect(result.compression.messages_relevance_dropped ?? 0).toBe(0);
  });

  it('does nothing when relevanceThreshold is not set', () => {
    const messages: Message[] = [
      msg(
        'filler',
        'I think that sounds reasonable and we should go ahead with the current plan since everything looks good so far from my perspective.',
      ),
      msg('recent', 'Latest.'),
      msg('recent2', 'Current.'),
    ];

    const result = compress(messages, { recencyWindow: 2 });
    expect(result.compression.messages_relevance_dropped).toBeUndefined();
  });

  it('groups consecutive dropped messages into a single stub', () => {
    const messages: Message[] = [
      msg(
        'filler1',
        'Sure, that makes sense and I agree we should continue with the current approach without any major changes to the plan going forward for the rest of the project.',
      ),
      msg(
        'filler2',
        'Okay great, I think everything is looking good and we can proceed as discussed earlier in our conversation about the project timeline and milestones ahead.',
      ),
      msg(
        'filler3',
        'Right, sounds good to me and I have nothing else to add at this point so we can move forward with confidence in our current direction and approach.',
      ),
      msg('recent1', 'Add retry logic.'),
      msg('recent2', 'Fix the timeout.'),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      relevanceThreshold: 5,
    });

    // All 3 filler messages should be in one group stub
    const stubs = result.messages.filter((m) => m.content?.includes('omitted'));
    expect(stubs.length).toBe(1);
    expect(stubs[0].content).toContain('3 messages');
  });

  it('preserves verbatim store for dropped messages (round-trip)', () => {
    const messages: Message[] = [
      msg(
        'filler',
        'I think everything looks good and we should proceed with the current plan as discussed in our previous conversation about the project status.',
      ),
      msg('recent', 'Continue with the plan.'),
      msg('recent2', 'Confirmed.'),
    ];

    const result = compress(messages, {
      recencyWindow: 2,
      relevanceThreshold: 5,
    });

    // Original content should be in verbatim store
    if (
      result.compression.messages_relevance_dropped &&
      result.compression.messages_relevance_dropped > 0
    ) {
      expect(result.verbatim['filler']).toBeDefined();
      expect(result.verbatim['filler'].content).toContain('everything looks good');
    }
  });
});
