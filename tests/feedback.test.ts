import { describe, it, expect, vi } from 'vitest';
import { createFeedbackCollector, refineSummarizer } from '../src/feedback.js';
import type { CreateSummarizerOptions, FeedbackResult, Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

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

    // Verify prompt contains original and compressed content
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
    expect(result).not.toBe(opts); // new object
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
