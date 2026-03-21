import { describe, it, expect, vi } from 'vitest';
import { createClassifier, createEscalatingClassifier } from '../src/classifier.js';

describe('createClassifier', () => {
  it('returns a function', () => {
    const classifier = createClassifier(() => '{}');
    expect(typeof classifier).toBe('function');
  });

  it('calls callLlm with prompt containing the content', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"compress","confidence":0.8,"reason":"prose"}');
    const classifier = createClassifier(callLlm);

    await classifier('This is a test message about deployment pipelines.');

    expect(callLlm).toHaveBeenCalledOnce();
    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('This is a test message about deployment pipelines.');
  });

  it('prompt contains classification instructions', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"compress","confidence":0.8,"reason":"prose"}');
    const classifier = createClassifier(callLlm);

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('PRESERVED verbatim');
    expect(prompt).toContain('COMPRESSED');
    expect(prompt).toContain('JSON format');
  });

  it('includes systemPrompt at the start when set', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"preserve","confidence":0.9,"reason":"legal"}');
    const classifier = createClassifier(callLlm, {
      systemPrompt: 'You are classifying legal documents.',
    });

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt.startsWith('You are classifying legal documents.')).toBe(true);
  });

  it('includes alwaysPreserve items as bullet points', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"preserve","confidence":0.9,"reason":"ok"}');
    const classifier = createClassifier(callLlm, {
      alwaysPreserve: ['clause references', 'party names'],
    });

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('- clause references');
    expect(prompt).toContain('- party names');
  });

  it('includes alwaysCompress items as bullet points', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"compress","confidence":0.8,"reason":"ok"}');
    const classifier = createClassifier(callLlm, {
      alwaysCompress: ['pleasantries', 'acknowledgments'],
    });

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('- pleasantries');
    expect(prompt).toContain('- acknowledgments');
  });

  it('includes custom maxResponseTokens in prompt', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"compress","confidence":0.8,"reason":"ok"}');
    const classifier = createClassifier(callLlm, { maxResponseTokens: 50 });

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('50 tokens');
  });

  it('includes default maxResponseTokens (100) in prompt', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"compress","confidence":0.8,"reason":"ok"}');
    const classifier = createClassifier(callLlm);

    await classifier('some content');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('100 tokens');
  });

  describe('response parsing', () => {
    it('parses clean JSON', async () => {
      const callLlm = vi
        .fn()
        .mockReturnValue(
          '{"decision":"preserve","confidence":0.95,"reason":"contains legal clause"}',
        );
      const classifier = createClassifier(callLlm);

      const result = await classifier('content');
      expect(result.decision).toBe('preserve');
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toBe('contains legal clause');
    });

    it('parses JSON with surrounding text', async () => {
      const callLlm = vi
        .fn()
        .mockReturnValue(
          'Here is my analysis:\n{"decision":"compress","confidence":0.7,"reason":"general prose"}',
        );
      const classifier = createClassifier(callLlm);

      const result = await classifier('content');
      expect(result.decision).toBe('compress');
      expect(result.confidence).toBe(0.7);
    });

    it('parses JSON from markdown code block', async () => {
      const callLlm = vi
        .fn()
        .mockReturnValue(
          '```json\n{"decision":"preserve","confidence":0.85,"reason":"critical decision"}\n```',
        );
      const classifier = createClassifier(callLlm);

      const result = await classifier('content');
      expect(result.decision).toBe('preserve');
      expect(result.confidence).toBe(0.85);
    });

    it('returns confidence=0 for garbage response', async () => {
      const callLlm = vi.fn().mockReturnValue('I cannot classify this message properly.');
      const classifier = createClassifier(callLlm);

      const result = await classifier('content');
      expect(result.decision).toBe('compress');
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe('unparseable');
    });

    it('clamps confidence to 0-1 range', async () => {
      const callLlm = vi
        .fn()
        .mockReturnValue('{"decision":"preserve","confidence":1.5,"reason":"very sure"}');
      const classifier = createClassifier(callLlm);

      const result = await classifier('content');
      expect(result.confidence).toBe(1);
    });
  });

  it('works with sync callLlm', () => {
    const classifier = createClassifier(
      () => '{"decision":"compress","confidence":0.8,"reason":"ok"}',
    );
    const result = classifier('content');
    // Sync callLlm returns a non-Promise
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { decision: string }).decision).toBe('compress');
  });

  it('works with async callLlm', async () => {
    const classifier = createClassifier(
      async () => '{"decision":"preserve","confidence":0.9,"reason":"important"}',
    );
    const result = classifier('content');
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved.decision).toBe('preserve');
  });
});

describe('createEscalatingClassifier', () => {
  it('returns a function', () => {
    const classifier = createEscalatingClassifier(() => '{}');
    expect(typeof classifier).toBe('function');
  });

  it('always returns a Promise', () => {
    const classifier = createEscalatingClassifier(
      () => '{"decision":"compress","confidence":0.8,"reason":"ok"}',
    );
    const result = classifier('content');
    expect(result).toBeInstanceOf(Promise);
  });

  it('returns LLM result when confidence > 0', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"preserve","confidence":0.9,"reason":"important content"}');
    const classifier = createEscalatingClassifier(callLlm);

    const result = await classifier('This is critical content about deployment decisions.');
    expect(result.decision).toBe('preserve');
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe('important content');
  });

  it('falls back to heuristic when LLM throws', async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error('LLM failed'));
    const classifier = createEscalatingClassifier(callLlm);

    // Plain prose — heuristic should classify as compressible
    const result = await classifier(
      'This is a long message about general topics that does not contain any code or structural patterns worth preserving.',
    );
    expect(result.decision).toBe('compress');
    expect(result.reason).toBe('heuristic_fallback');
  });

  it('falls back to heuristic when response is unparseable (confidence=0)', async () => {
    const callLlm = vi.fn().mockReturnValue('garbage response with no JSON');
    const classifier = createEscalatingClassifier(callLlm);

    const result = await classifier(
      'This is a long message about general topics that does not contain any code or structural patterns.',
    );
    expect(result.decision).toBe('compress');
    expect(result.reason).toBe('heuristic_fallback');
  });

  it('preserves hard T0 content via heuristic fallback', async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error('LLM down'));
    const classifier = createEscalatingClassifier(callLlm);

    const result = await classifier('```typescript\nconst x = 1;\nconst y = 2;\n```');
    expect(result.decision).toBe('preserve');
    expect(result.reason).toBe('heuristic_t0');
  });

  it('compresses prose via heuristic fallback', async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error('LLM down'));
    const classifier = createEscalatingClassifier(callLlm);

    const result = await classifier(
      'This is just some general conversational text that goes on and on without any technical content.',
    );
    expect(result.decision).toBe('compress');
    expect(result.reason).toBe('heuristic_fallback');
  });

  it('passes systemPrompt and alwaysPreserve through to LLM', async () => {
    const callLlm = vi
      .fn()
      .mockReturnValue('{"decision":"preserve","confidence":0.9,"reason":"legal clause"}');
    const classifier = createEscalatingClassifier(callLlm, {
      systemPrompt: 'Legal documents.',
      alwaysPreserve: ['clause references'],
    });

    await classifier('Section 4.2 requires written consent.');

    const prompt = callLlm.mock.calls[0][0] as string;
    expect(prompt.startsWith('Legal documents.')).toBe(true);
    expect(prompt).toContain('- clause references');
  });
});
