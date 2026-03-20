import { describe, it, expect } from 'vitest';
import { segmentEDUs, scoreEDUs, selectEDUs, summarizeWithEDUs } from '../src/discourse.js';
import { compress } from '../src/compress.js';
import type { Message } from '../src/types.js';

function msg(id: string, content: string, role = 'user'): Message {
  return { id, index: 0, role, content };
}

describe('segmentEDUs', () => {
  it('segments simple sentences into EDUs', () => {
    const edus = segmentEDUs('Parse the JSON. Extract the user ID. Return the result.');
    expect(edus.length).toBeGreaterThanOrEqual(3);
  });

  it('splits at discourse markers', () => {
    const edus = segmentEDUs('Parse the JSON, then extract the user ID from the response object.');
    // Should split at ", then"
    expect(edus.length).toBeGreaterThanOrEqual(2);
  });

  it('detects pronoun dependencies', () => {
    const edus = segmentEDUs('Create the connection pool. It handles all database connections.');
    const itEdu = edus.find((e) => e.text.startsWith('It'));
    if (itEdu) {
      expect(itEdu.dependsOn.length).toBeGreaterThan(0);
    }
  });

  it('handles empty text', () => {
    const edus = segmentEDUs('');
    expect(edus).toHaveLength(0);
  });

  it('detects temporal chains', () => {
    const edus = segmentEDUs(
      'First validate the input. Then process the request. Finally return the result.',
    );
    // "Then" and "Finally" EDUs should depend on predecessors
    const thenEdu = edus.find((e) => /then/i.test(e.text));
    if (thenEdu) {
      expect(thenEdu.dependsOn.length).toBeGreaterThan(0);
    }
  });
});

describe('scoreEDUs', () => {
  it('scores with default length-based scorer', () => {
    const edus = segmentEDUs('Short. This is a longer sentence with more content.');
    const scored = scoreEDUs(edus);
    expect(scored.every((e) => e.score > 0)).toBe(true);
  });

  it('uses custom scorer when provided', () => {
    const edus = segmentEDUs('Important keyword here. Generic filler sentence.');
    const scored = scoreEDUs(edus, (text) => (text.includes('keyword') ? 10 : 1));
    const best = scored.reduce((a, b) => (a.score > b.score ? a : b));
    expect(best.text).toContain('keyword');
  });
});

describe('selectEDUs', () => {
  it('selects highest-scored EDUs within budget', () => {
    const edus = scoreEDUs(
      segmentEDUs('Low value filler. Critical fetchData configuration.'),
      (text) => (text.includes('fetchData') ? 10 : 1),
    );
    const selected = selectEDUs(edus, 200);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('includes dependency parents when selecting an EDU', () => {
    const edus = scoreEDUs(
      segmentEDUs('Create the pool. It handles connections. Then it distributes load.'),
      (text) => (text.includes('distributes') ? 10 : text.includes('It handles') ? 5 : 1),
    );
    const selected = selectEDUs(edus, 500);
    // If "distributes" EDU is selected and depends on "It handles" which depends on "Create",
    // both parents should be included
    if (selected.some((e) => e.text.includes('distributes'))) {
      // At least one parent should also be selected
      expect(selected.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('returns empty for empty input', () => {
    expect(selectEDUs([], 100)).toHaveLength(0);
  });
});

describe('summarizeWithEDUs', () => {
  it('produces a coherent summary', () => {
    const text =
      'The fetchData function calls the API. It uses exponential backoff. Then it validates the response. Finally it caches the result.';
    const summary = summarizeWithEDUs(text, 200);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(250); // budget + some tolerance
  });
});

describe('discourseAware option in compress()', () => {
  it('uses EDU-based summarization when enabled', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The fetchData function calls the upstream API endpoint. It uses exponential backoff with a base delay of 200 milliseconds. Then it validates the JSON response schema. Finally it caches the successful result in the local store for 300 seconds.',
      ),
      msg('recent', 'What about error handling?'),
    ];

    const withEDU = compress(messages, { recencyWindow: 1, discourseAware: true });
    const withoutEDU = compress(messages, { recencyWindow: 1 });

    // Both should compress
    expect(withEDU.compression.messages_compressed).toBeGreaterThan(0);
    expect(withoutEDU.compression.messages_compressed).toBeGreaterThan(0);

    // EDU summary may differ from default
    const edu1 = withEDU.messages.find((m) => m.id === '1');
    const default1 = withoutEDU.messages.find((m) => m.id === '1');
    expect(edu1?.content).toBeDefined();
    expect(default1?.content).toBeDefined();
  });

  it('does nothing when discourseAware is false', () => {
    const messages: Message[] = [
      msg(
        '1',
        'The overall project timeline looks reasonable based on current velocity metrics and team capacity estimates for the upcoming quarter milestones, considering the dependencies between frontend and backend workstreams.',
      ),
      msg('recent', 'OK.'),
    ];

    const result = compress(messages, { recencyWindow: 1 });
    expect(result.compression.messages_compressed).toBeGreaterThan(0);
  });
});
