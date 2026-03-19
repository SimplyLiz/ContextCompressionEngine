import { describe, it, expect, vi } from 'vitest';
import {
  createFeedbackCollector,
  refineSummarizer,
  tightenSummarizer,
  refineSummarizerCandidates,
  createDistillationPairs,
  RECOMMENDED_HISTORY_THRESHOLD,
  RECOMMENDED_OBSERVATION_THRESHOLD,
} from '../src/feedback.js';
import type {
  CompressResult,
  CreateSummarizerOptions,
  FeedbackResult,
  Message,
  OverPreservationResult,
} from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// createFeedbackCollector — UT step (analyze)
// ---------------------------------------------------------------------------

describe('createFeedbackCollector', () => {
  it('returns empty feedback when no pairs added', async () => {
    const llm = vi.fn();
    const collector = createFeedbackCollector(llm);
    const result = await collector.analyze();
    expect(result).toEqual({ lostPatterns: [], suggestedTerms: [], guidelines: [] });
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns empty feedback when all pairs succeeded', async () => {
    const llm = vi.fn();
    const collector = createFeedbackCollector(llm);
    const original = [msg({ id: '1', index: 0, content: 'hello world' })];
    const compressed = [msg({ id: '1', index: 0, content: '[summary: hello]' })];
    collector.add(original, compressed, { success: true });
    const result = await collector.analyze();
    expect(result).toEqual({ lostPatterns: [], suggestedTerms: [], guidelines: [] });
    expect(llm).not.toHaveBeenCalled();
  });

  it('calls LLM with contrastive prompt when failed pairs exist', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        lostPatterns: ['API endpoint URLs'],
        suggestedTerms: ['fetchUser', 'POST /api/users'],
        guidelines: ['Preserve all URL paths verbatim'],
      }),
    );
    const collector = createFeedbackCollector(llm);
    const original = [msg({ id: '1', index: 0, content: 'Call POST /api/users to create' })];
    const compressed = [msg({ id: '1', index: 0, content: '[summary: API call]' })];
    collector.add(original, compressed, { success: false, error: 'Missing endpoint' });

    const result = await collector.analyze();
    expect(llm).toHaveBeenCalledOnce();
    expect(result.lostPatterns).toEqual(['API endpoint URLs']);
    expect(result.suggestedTerms).toEqual(['fetchUser', 'POST /api/users']);
    expect(result.guidelines).toEqual(['Preserve all URL paths verbatim']);

    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain('POST /api/users');
    expect(prompt).toContain('[summary: API call]');
    expect(prompt).toContain('Missing endpoint');
  });

  it('parses markdown-fenced JSON response', async () => {
    const llm = vi.fn().mockResolvedValue(
      '```json\n' +
        JSON.stringify({
          lostPatterns: ['config keys'],
          suggestedTerms: ['DB_HOST'],
          guidelines: ['Keep env var names'],
        }) +
        '\n```',
    );
    const collector = createFeedbackCollector(llm);
    collector.add(
      [msg({ id: '1', index: 0, content: 'Set DB_HOST=localhost' })],
      [msg({ id: '1', index: 0, content: '[summary: config]' })],
      { success: false },
    );
    const result = await collector.analyze();
    expect(result.lostPatterns).toEqual(['config keys']);
    expect(result.suggestedTerms).toEqual(['DB_HOST']);
  });

  it('throws on malformed JSON', async () => {
    const llm = vi.fn().mockResolvedValue('not json at all');
    const collector = createFeedbackCollector(llm);
    collector.add(
      [msg({ id: '1', index: 0, content: 'test' })],
      [msg({ id: '1', index: 0, content: '[summary]' })],
      { success: false },
    );
    await expect(collector.analyze()).rejects.toThrow();
  });

  it('reflects added pairs via .pairs', () => {
    const collector = createFeedbackCollector(vi.fn());
    expect(collector.pairs).toHaveLength(0);
    const original = [msg({ id: '1', index: 0, content: 'a' })];
    const compressed = [msg({ id: '1', index: 0, content: 'b' })];
    collector.add(original, compressed, { success: true });
    collector.add(original, compressed, { success: false });
    expect(collector.pairs).toHaveLength(2);
    expect(collector.pairs[0].outcome.success).toBe(true);
    expect(collector.pairs[1].outcome.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createFeedbackCollector — CO step (analyzeOverPreservation)
// ---------------------------------------------------------------------------

describe('createFeedbackCollector — analyzeOverPreservation', () => {
  it('returns empty result when no pairs added', async () => {
    const llm = vi.fn();
    const collector = createFeedbackCollector(llm);
    const result = await collector.analyzeOverPreservation();
    expect(result).toEqual({
      unnecessaryPatterns: [],
      removableTerms: [],
      tighteningGuidelines: [],
    });
    expect(llm).not.toHaveBeenCalled();
  });

  it('returns empty result when no successful pairs', async () => {
    const llm = vi.fn();
    const collector = createFeedbackCollector(llm);
    collector.add(
      [msg({ id: '1', index: 0, content: 'test' })],
      [msg({ id: '1', index: 0, content: '[summary]' })],
      { success: false },
    );
    const result = await collector.analyzeOverPreservation();
    expect(result).toEqual({
      unnecessaryPatterns: [],
      removableTerms: [],
      tighteningGuidelines: [],
    });
    expect(llm).not.toHaveBeenCalled();
  });

  it('calls LLM with over-preservation prompt for successful pairs', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        unnecessaryPatterns: ['verbose error descriptions'],
        removableTerms: ['DEBUG_MODE'],
        tighteningGuidelines: ['Omit debug-level details from summaries'],
      }),
    );
    const collector = createFeedbackCollector(llm);
    collector.add(
      [
        msg({
          id: '1',
          index: 0,
          content: 'DEBUG_MODE=true, error: connection timeout at 10.0.0.1',
        }),
      ],
      [msg({ id: '1', index: 0, content: '[summary: debug config and connection error]' })],
      { success: true },
    );

    const result = await collector.analyzeOverPreservation();
    expect(llm).toHaveBeenCalledOnce();
    expect(result.unnecessaryPatterns).toEqual(['verbose error descriptions']);
    expect(result.removableTerms).toEqual(['DEBUG_MODE']);
    expect(result.tighteningGuidelines).toEqual(['Omit debug-level details from summaries']);

    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain('compression efficiency');
    expect(prompt).toContain('DEBUG_MODE');
  });

  it('handles markdown-fenced JSON in CO response', async () => {
    const llm = vi.fn().mockResolvedValue(
      '```json\n' +
        JSON.stringify({
          unnecessaryPatterns: ['timestamps'],
          removableTerms: [],
          tighteningGuidelines: ['Skip timestamps'],
        }) +
        '\n```',
    );
    const collector = createFeedbackCollector(llm);
    collector.add(
      [msg({ id: '1', index: 0, content: 'data' })],
      [msg({ id: '1', index: 0, content: 'compressed' })],
      { success: true },
    );
    const result = await collector.analyzeOverPreservation();
    expect(result.unnecessaryPatterns).toEqual(['timestamps']);
  });

  it('throws on malformed CO JSON', async () => {
    const llm = vi.fn().mockResolvedValue('invalid');
    const collector = createFeedbackCollector(llm);
    collector.add(
      [msg({ id: '1', index: 0, content: 'test' })],
      [msg({ id: '1', index: 0, content: 'c' })],
      { success: true },
    );
    await expect(collector.analyzeOverPreservation()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// refineSummarizer (UT)
// ---------------------------------------------------------------------------

describe('refineSummarizer', () => {
  it('merges suggestedTerms into preserveTerms without duplicates', () => {
    const opts: CreateSummarizerOptions = { preserveTerms: ['foo', 'bar'] };
    const feedback: FeedbackResult = {
      lostPatterns: [],
      suggestedTerms: ['bar', 'baz'],
      guidelines: [],
    };
    const result = refineSummarizer(opts, feedback);
    expect(result.preserveTerms).toEqual(['foo', 'bar', 'baz']);
  });

  it('creates preserveTerms when none existed', () => {
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = {
      lostPatterns: [],
      suggestedTerms: ['fetchUser'],
      guidelines: [],
    };
    const result = refineSummarizer(opts, feedback);
    expect(result.preserveTerms).toEqual(['fetchUser']);
  });

  it('appends guidelines to existing systemPrompt', () => {
    const opts: CreateSummarizerOptions = { systemPrompt: 'You summarize code.' };
    const feedback: FeedbackResult = {
      lostPatterns: [],
      suggestedTerms: [],
      guidelines: ['Keep URLs', 'Keep error codes'],
    };
    const result = refineSummarizer(opts, feedback);
    expect(result.systemPrompt).toBe('You summarize code.\n\n- Keep URLs\n- Keep error codes');
  });

  it('creates systemPrompt from guidelines when none existed', () => {
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = {
      lostPatterns: [],
      suggestedTerms: [],
      guidelines: ['Preserve all identifiers'],
    };
    const result = refineSummarizer(opts, feedback);
    expect(result.systemPrompt).toBe('- Preserve all identifiers');
  });

  it('returns unchanged options on empty feedback', () => {
    const opts: CreateSummarizerOptions = {
      maxResponseTokens: 500,
      mode: 'aggressive',
      systemPrompt: 'existing',
      preserveTerms: ['x'],
    };
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };
    const result = refineSummarizer(opts, feedback);
    expect(result).toEqual(opts);
    expect(result).not.toBe(opts);
  });

  it('preserves maxResponseTokens and mode passthrough', () => {
    const opts: CreateSummarizerOptions = { maxResponseTokens: 500, mode: 'aggressive' };
    const feedback: FeedbackResult = {
      lostPatterns: [],
      suggestedTerms: ['term'],
      guidelines: ['rule'],
    };
    const result = refineSummarizer(opts, feedback);
    expect(result.maxResponseTokens).toBe(500);
    expect(result.mode).toBe('aggressive');
  });
});

// ---------------------------------------------------------------------------
// tightenSummarizer (CO)
// ---------------------------------------------------------------------------

describe('tightenSummarizer', () => {
  it('removes terms listed in removableTerms', () => {
    const opts: CreateSummarizerOptions = { preserveTerms: ['foo', 'bar', 'baz'] };
    const feedback: OverPreservationResult = {
      unnecessaryPatterns: [],
      removableTerms: ['bar'],
      tighteningGuidelines: [],
    };
    const result = tightenSummarizer(opts, feedback);
    expect(result.preserveTerms).toEqual(['foo', 'baz']);
  });

  it('appends tighteningGuidelines to systemPrompt', () => {
    const opts: CreateSummarizerOptions = { systemPrompt: 'Base prompt.' };
    const feedback: OverPreservationResult = {
      unnecessaryPatterns: [],
      removableTerms: [],
      tighteningGuidelines: ['Be more concise', 'Skip debug info'],
    };
    const result = tightenSummarizer(opts, feedback);
    expect(result.systemPrompt).toBe('Base prompt.\n\n- Be more concise\n- Skip debug info');
  });

  it('creates systemPrompt from tighteningGuidelines when none existed', () => {
    const opts: CreateSummarizerOptions = {};
    const feedback: OverPreservationResult = {
      unnecessaryPatterns: [],
      removableTerms: [],
      tighteningGuidelines: ['Remove timestamps'],
    };
    const result = tightenSummarizer(opts, feedback);
    expect(result.systemPrompt).toBe('- Remove timestamps');
  });

  it('returns unchanged options on empty feedback', () => {
    const opts: CreateSummarizerOptions = {
      maxResponseTokens: 300,
      preserveTerms: ['x'],
      systemPrompt: 'existing',
    };
    const feedback: OverPreservationResult = {
      unnecessaryPatterns: [],
      removableTerms: [],
      tighteningGuidelines: [],
    };
    const result = tightenSummarizer(opts, feedback);
    expect(result).toEqual(opts);
    expect(result).not.toBe(opts);
  });

  it('preserves maxResponseTokens and mode', () => {
    const opts: CreateSummarizerOptions = { maxResponseTokens: 500, mode: 'aggressive' };
    const feedback: OverPreservationResult = {
      unnecessaryPatterns: [],
      removableTerms: ['x'],
      tighteningGuidelines: [],
    };
    const result = tightenSummarizer(opts, feedback);
    expect(result.maxResponseTokens).toBe(500);
    expect(result.mode).toBe('aggressive');
  });
});

// ---------------------------------------------------------------------------
// refineSummarizerCandidates
// ---------------------------------------------------------------------------

describe('refineSummarizerCandidates', () => {
  it('generates N candidate options from LLM response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { preserveTerms: ['apiKey'], guidelines: ['Keep auth tokens'] },
        { preserveTerms: ['endpoint'], guidelines: ['Keep URLs'] },
        { preserveTerms: ['userId', 'apiKey'], guidelines: ['Keep all identifiers'] },
      ]),
    );
    const opts: CreateSummarizerOptions = { preserveTerms: ['base'] };
    const feedback: FeedbackResult = {
      lostPatterns: ['auth info'],
      suggestedTerms: ['apiKey'],
      guidelines: ['Keep tokens'],
    };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback, 3);
    expect(candidates).toHaveLength(3);
    expect(llm).toHaveBeenCalledOnce();

    // Each candidate should merge new terms with existing
    expect(candidates[0].preserveTerms).toEqual(['base', 'apiKey']);
    expect(candidates[1].preserveTerms).toEqual(['base', 'endpoint']);
    expect(candidates[2].preserveTerms).toEqual(['base', 'userId', 'apiKey']);
  });

  it('deduplicates terms against existing preserveTerms', async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ preserveTerms: ['existing', 'new'], guidelines: [] }]));
    const opts: CreateSummarizerOptions = { preserveTerms: ['existing'] };
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback, 1);
    expect(candidates[0].preserveTerms).toEqual(['existing', 'new']);
  });

  it('appends candidate guidelines to existing systemPrompt', async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ preserveTerms: [], guidelines: ['New rule'] }]));
    const opts: CreateSummarizerOptions = { systemPrompt: 'Base.' };
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback, 1);
    expect(candidates[0].systemPrompt).toBe('Base.\n\n- New rule');
  });

  it('handles markdown-fenced JSON', async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(
        '```json\n' + JSON.stringify([{ preserveTerms: ['a'], guidelines: ['b'] }]) + '\n```',
      );
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback, 1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].preserveTerms).toEqual(['a']);
  });

  it('returns fewer candidates when LLM provides fewer than requested', async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ preserveTerms: ['only'], guidelines: ['one'] }]));
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback, 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].preserveTerms).toEqual(['only']);
  });

  it('throws on non-array JSON', async () => {
    const llm = vi.fn().mockResolvedValue('{"not": "array"}');
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    await expect(refineSummarizerCandidates(llm, opts, feedback)).rejects.toThrow();
  });

  it('defaults to 5 candidates', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify(
        Array.from({ length: 5 }, (_, i) => ({
          preserveTerms: [`term_${i}`],
          guidelines: [`rule_${i}`],
        })),
      ),
    );
    const opts: CreateSummarizerOptions = {};
    const feedback: FeedbackResult = { lostPatterns: [], suggestedTerms: [], guidelines: [] };

    const candidates = await refineSummarizerCandidates(llm, opts, feedback);
    expect(candidates).toHaveLength(5);

    // Verify the prompt asked for 5
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// createDistillationPairs
// ---------------------------------------------------------------------------

describe('createDistillationPairs', () => {
  it('extracts pairs from compressed messages with verbatim originals', () => {
    const result: CompressResult = {
      messages: [
        msg({
          id: '1',
          index: 0,
          content: '[summary: discussed API design]',
          metadata: { _cce_original: { ids: ['orig_1'], summary_id: 'sum_1', version: 0 } },
        }),
        msg({ id: '2', index: 1, content: 'preserved message' }),
      ],
      compression: {
        original_version: 0,
        ratio: 2,
        token_ratio: 2,
        messages_compressed: 1,
        messages_preserved: 1,
      },
      verbatim: {
        orig_1: msg({
          id: 'orig_1',
          index: 0,
          content: 'We discussed the API design at length including REST vs GraphQL tradeoffs.',
        }),
      },
    };

    const pairs = createDistillationPairs(result);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].input).toContain('REST vs GraphQL');
    expect(pairs[0].output).toBe('[summary: discussed API design]');
  });

  it('handles merged messages (multiple source IDs)', () => {
    const result: CompressResult = {
      messages: [
        msg({
          id: 'merged',
          index: 0,
          content: '[summary: two discussions merged]',
          metadata: {
            _cce_original: { ids: ['a', 'b'], summary_id: 'sum_m', version: 0 },
          },
        }),
      ],
      compression: {
        original_version: 0,
        ratio: 2,
        token_ratio: 2,
        messages_compressed: 2,
        messages_preserved: 0,
      },
      verbatim: {
        a: msg({ id: 'a', index: 0, content: 'First discussion topic.' }),
        b: msg({ id: 'b', index: 1, content: 'Second discussion topic.' }),
      },
    };

    const pairs = createDistillationPairs(result);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].input).toContain('First discussion');
    expect(pairs[0].input).toContain('Second discussion');
  });

  it('skips messages without _cce_original metadata', () => {
    const result: CompressResult = {
      messages: [msg({ id: '1', index: 0, content: 'just a regular message' })],
      compression: {
        original_version: 0,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: 1,
      },
      verbatim: {},
    };

    const pairs = createDistillationPairs(result);
    expect(pairs).toHaveLength(0);
  });

  it('skips when verbatim entry is missing', () => {
    const result: CompressResult = {
      messages: [
        msg({
          id: '1',
          index: 0,
          content: '[summary: lost]',
          metadata: { _cce_original: { ids: ['gone'], summary_id: 'sum', version: 0 } },
        }),
      ],
      compression: {
        original_version: 0,
        ratio: 2,
        token_ratio: 2,
        messages_compressed: 1,
        messages_preserved: 0,
      },
      verbatim: {},
    };

    const pairs = createDistillationPairs(result);
    expect(pairs).toHaveLength(0);
  });

  it('returns empty array for no-op compression', () => {
    const result: CompressResult = {
      messages: [msg({ id: '1', index: 0, content: 'hello' })],
      compression: {
        original_version: 0,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: 1,
      },
      verbatim: {},
    };

    const pairs = createDistillationPairs(result);
    expect(pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recommended thresholds
// ---------------------------------------------------------------------------

describe('recommended thresholds', () => {
  it('exports RECOMMENDED_HISTORY_THRESHOLD as 4096', () => {
    expect(RECOMMENDED_HISTORY_THRESHOLD).toBe(4096);
  });

  it('exports RECOMMENDED_OBSERVATION_THRESHOLD as 1024', () => {
    expect(RECOMMENDED_OBSERVATION_THRESHOLD).toBe(1024);
  });
});
