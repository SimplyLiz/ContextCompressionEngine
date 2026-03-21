import { describe, it, expect } from 'vitest';
import { CodeAdapter, StructuredOutputAdapter } from '../src/adapters.js';
import { compress } from '../src/compress.js';
import type { FormatAdapter, Message } from '../src/types.js';

function msg(overrides: Partial<Message> & { id: string; index: number }): Message {
  return { role: 'user', content: '', metadata: {}, ...overrides };
}

describe('CodeAdapter', () => {
  it('detects content with code fences', () => {
    expect(CodeAdapter.detect('some text\n```ts\nconst x = 1;\n```\nmore text')).toBe(true);
  });

  it('does not detect content without code fences', () => {
    expect(CodeAdapter.detect('just plain text')).toBe(false);
  });

  it('extractPreserved returns code fences', () => {
    const content = 'some text\n```ts\nconst x = 1;\n```\nmore text\n```js\nlet y = 2;\n```';
    const preserved = CodeAdapter.extractPreserved(content);
    expect(preserved).toHaveLength(2);
    expect(preserved[0]).toContain('const x = 1;');
    expect(preserved[1]).toContain('let y = 2;');
  });

  it('extractCompressible returns prose segments', () => {
    const content = 'before code\n```ts\nconst x = 1;\n```\nafter code';
    const compressible = CodeAdapter.extractCompressible(content);
    expect(compressible).toHaveLength(2);
    expect(compressible[0]).toBe('before code');
    expect(compressible[1]).toBe('after code');
  });

  it('reconstruct combines summary and preserved fences', () => {
    const result = CodeAdapter.reconstruct(
      ['```ts\nconst x = 1;\n```', '```ts\nconst y = 2;\n```'],
      '[summary: code explanation]',
    );
    expect(result).toContain('[summary: code explanation]');
    expect(result).toContain('```ts\nconst x = 1;\n```');
    expect(result).toContain('```ts\nconst y = 2;\n```');
  });
});

describe('StructuredOutputAdapter', () => {
  const structuredContent = [
    'src/auth.ts:10: const token = jwt.verify()',
    'src/auth.ts:15: const session = createSession()',
    'src/auth.ts:20: return session',
    'src/auth.ts:25: const user = getUser()',
    'src/auth.ts:30: validate(token)',
    'src/auth.ts:35: return user',
    'Tests: 5 passed, 0 failed',
    'Duration: 1.2s',
  ].join('\n');

  it('detects structured output', () => {
    expect(StructuredOutputAdapter.detect(structuredContent)).toBe(true);
  });

  it('does not detect plain prose', () => {
    expect(StructuredOutputAdapter.detect('Just a normal sentence.')).toBe(false);
  });

  it('extractPreserved returns status lines and file paths', () => {
    const preserved = StructuredOutputAdapter.extractPreserved(structuredContent);
    expect(preserved.some((p) => p.includes('passed'))).toBe(true);
    expect(preserved.some((p) => p.includes('files:'))).toBe(true);
  });

  it('reconstruct joins preserved and summary with pipes', () => {
    const result = StructuredOutputAdapter.reconstruct(
      ['Tests: 5 passed', 'files: src/auth.ts'],
      'additional info',
    );
    expect(result).toContain('Tests: 5 passed');
    expect(result).toContain('files: src/auth.ts');
    expect(result).toContain('additional info');
    expect(result).toContain(' | ');
  });
});

describe('custom adapters in compress pipeline', () => {
  it('custom adapter is called when registered and content matches', () => {
    const customAdapter: FormatAdapter = {
      name: 'csv',
      detect: (content) => content.includes('col1,col2,col3'),
      extractPreserved: (content) => {
        // Keep the header line
        const lines = content.split('\n');
        return [lines[0]];
      },
      extractCompressible: (content) => {
        const lines = content.split('\n');
        return lines.slice(1);
      },
      reconstruct: (preserved, summary) => {
        return `${preserved.join('\n')}\n[${summary}]`;
      },
    };

    const csvContent =
      'col1,col2,col3\n' +
      Array.from(
        { length: 10 },
        (_, i) => `value${i},data${i},This is a long description that adds bulk to the content`,
      ).join('\n');

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'tool', content: csvContent })];

    const result = compress(messages, {
      recencyWindow: 0,
      adapters: [customAdapter],
    });

    // If the adapter reduced the size, it should have compressed
    const output = result.messages[0].content!;
    if (output.length < csvContent.length) {
      expect(result.compression.messages_compressed).toBe(1);
      expect(output).toContain('col1,col2,col3');
    } else {
      // Adapter reverted (compressed >= original)
      expect(result.compression.messages_preserved).toBe(1);
    }
  });

  it('custom adapter trace reason is recorded', () => {
    const customAdapter: FormatAdapter = {
      name: 'test_format',
      detect: (content) => content.startsWith('TEST_FORMAT:'),
      extractPreserved: () => [],
      extractCompressible: (content) => [content.slice(12)],
      reconstruct: (_preserved, summary) => `TEST_FORMAT: ${summary}`,
    };

    const content =
      'TEST_FORMAT: ' +
      'This is a long formatted content that will be processed by the custom adapter. '.repeat(5);

    const messages: Message[] = [msg({ id: '1', index: 0, role: 'tool', content })];

    const result = compress(messages, {
      recencyWindow: 0,
      adapters: [customAdapter],
      trace: true,
    });

    const d = result.compression.decisions!;
    expect(d).toHaveLength(1);
    expect(d[0].reason).toMatch(/adapter.*test_format/);
  });

  it('non-matching adapter does not affect compression', () => {
    const customAdapter: FormatAdapter = {
      name: 'never_match',
      detect: () => false,
      extractPreserved: () => [],
      extractCompressible: (content) => [content],
      reconstruct: (_preserved, summary) => summary,
    };

    const longProse =
      'This is a long general discussion that should be compressed normally by the standard pipeline. '.repeat(
        5,
      );
    const messages: Message[] = [msg({ id: '1', index: 0, role: 'user', content: longProse })];

    const resultWithAdapter = compress(messages, {
      recencyWindow: 0,
      adapters: [customAdapter],
    });
    const resultWithout = compress(messages, { recencyWindow: 0 });

    expect(resultWithAdapter.compression.messages_compressed).toBe(
      resultWithout.compression.messages_compressed,
    );
    expect(resultWithAdapter.compression.messages_preserved).toBe(
      resultWithout.compression.messages_preserved,
    );
  });

  it('existing compress tests still pass with no adapters', () => {
    // This is a regression safety check: built-in code-split behavior unchanged
    const longProse =
      'Detailed explanation of authentication that has enough content to compress. '.repeat(3);
    const content = `${longProse}\n\n\`\`\`ts\nconst token = auth.getToken();\n\`\`\``;
    const messages: Message[] = [msg({ id: '1', index: 0, role: 'assistant', content })];

    const result = compress(messages, { recencyWindow: 0 });
    expect(result.compression.messages_compressed).toBe(1);
    const output = result.messages[0].content!;
    expect(output).toContain('```ts');
    expect(output).toContain('auth.getToken()');
  });

  it('built-in code-split takes priority over custom adapter for code content', () => {
    const codeAdapter: FormatAdapter = {
      name: 'custom_code',
      detect: (content) => content.includes('```'),
      extractPreserved: () => ['custom preserved'],
      extractCompressible: () => ['custom compressible'],
      reconstruct: () => 'CUSTOM_OUTPUT',
    };

    const longProse = 'Explanation of the code behavior. '.repeat(5);
    const content = `${longProse}\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
    const messages: Message[] = [msg({ id: '1', index: 0, role: 'assistant', content })];

    const result = compress(messages, {
      recencyWindow: 0,
      adapters: [codeAdapter],
    });

    // Built-in code-split runs before adapters
    const output = result.messages[0].content!;
    expect(output).not.toBe('CUSTOM_OUTPUT');
    expect(output).toContain('```ts');
  });
});
