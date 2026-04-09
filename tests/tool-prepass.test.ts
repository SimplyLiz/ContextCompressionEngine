import { describe, expect, it } from 'vitest';
import {
  applyToolPrepass,
  trimBuildStepCounters,
  trimDirectoryListings,
  trimEchoedContent,
  trimPackageManagerNoise,
  trimTestVerboseOutput,
} from '../src/tool-prepass.js';
import type { Message } from '../src/types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function msg(
  id: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
): Message {
  return { id, index: 0, role, content, ...extra };
}

// ─── trimDirectoryListings ────────────────────────────────────────────────────

describe('trimDirectoryListings', () => {
  it('collapses ≥5 consecutive noise-dir tree lines into a stub', () => {
    const lines = [
      '├── node_modules/foo',
      '├── node_modules/bar',
      '│   ├── node_modules/baz',
      '│   └── node_modules/qux',
      '└── node_modules/quux',
    ];
    const { text, removed } = trimDirectoryListings(lines.join('\n'));
    expect(text).toContain('[... 5 directory entries omitted ...]');
    expect(removed).toBe(5);
  });

  it('passes through short runs (< 5 lines) unchanged', () => {
    const lines = ['├── node_modules/foo', '└── node_modules/bar'];
    const { text, removed } = trimDirectoryListings(lines.join('\n'));
    expect(text).toBe(lines.join('\n'));
    expect(removed).toBe(0);
  });

  it('keeps non-noise-dir tree lines', () => {
    const input = '├── src/\n└── tests/';
    const { text, removed } = trimDirectoryListings(input);
    expect(text).toBe(input);
    expect(removed).toBe(0);
  });
});

// ─── trimBuildStepCounters ────────────────────────────────────────────────────

describe('trimBuildStepCounters', () => {
  it('keeps first and last of ≥5 build step lines, collapses middle', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `[${i + 1}/8] Compiling step${i + 1}`);
    const { text, removed } = trimBuildStepCounters(lines.join('\n'));
    expect(text).toContain(lines[0]);
    expect(text).toContain(lines[7]);
    expect(text).toContain('[... 6 build steps omitted ...]');
    expect(removed).toBe(6);
  });

  it('leaves short runs (< 5) intact', () => {
    const lines = ['[1/3] a', '[2/3] b', '[3/3] c'];
    const { text, removed } = trimBuildStepCounters(lines.join('\n'));
    expect(text).toBe(lines.join('\n'));
    expect(removed).toBe(0);
  });
});

// ─── trimPackageManagerNoise ──────────────────────────────────────────────────

describe('trimPackageManagerNoise', () => {
  it('strips npm warn/notice lines when ≥3 present', () => {
    const lines = [
      'npm warn deprecated foo@1.0.0',
      'npm notice created tarball',
      'npm warn peer dep',
      'added 100 packages',
    ];
    const { text, removed } = trimPackageManagerNoise(lines.join('\n'));
    expect(text).not.toContain('npm warn deprecated');
    expect(text).not.toContain('npm notice created');
    expect(text).toContain('added 100 packages');
    expect(removed).toBe(3);
  });

  it('leaves content alone when fewer than 3 noise lines', () => {
    const lines = ['npm warn deprecated foo@1.0.0', 'normal output'];
    const { text, removed } = trimPackageManagerNoise(lines.join('\n'));
    expect(text).toBe(lines.join('\n'));
    expect(removed).toBe(0);
  });
});

// ─── trimTestVerboseOutput ────────────────────────────────────────────────────

describe('trimTestVerboseOutput', () => {
  it('strips ✓ pass lines when ≥10, inserts count note', () => {
    const passLines = Array.from({ length: 12 }, (_, i) => `  ✓ test case ${i + 1}`);
    const summary = 'Tests: 12 passed';
    const { text, removed } = trimTestVerboseOutput([...passLines, summary].join('\n'));
    expect(text).toContain('[... 12 passing test lines omitted ...]');
    expect(text).toContain(summary);
    expect(removed).toBe(12);
  });

  it('appends note at end when no summary line is present', () => {
    const passLines = Array.from({ length: 12 }, (_, i) => `  ✓ test ${i}`);
    const { text, removed } = trimTestVerboseOutput(passLines.join('\n'));
    expect(text.trim().endsWith('[... 12 passing test lines omitted ...]')).toBe(true);
    expect(removed).toBe(12);
  });

  it('leaves output unchanged when fewer than 10 pass lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `  ✓ test ${i}`);
    const input = lines.join('\n');
    const { text, removed } = trimTestVerboseOutput(input);
    expect(text).toBe(input);
    expect(removed).toBe(0);
  });
});

// ─── trimEchoedContent ────────────────────────────────────────────────────────

describe('trimEchoedContent', () => {
  const longBlock = 'x'.repeat(300);

  it('replaces a large block that echoes assistant context with a stub', () => {
    const assistantCtx = longBlock + ' some other stuff';
    const toolContent = longBlock + '\n\nsome new info here that is not echoed';
    const { text, removed } = trimEchoedContent(toolContent, assistantCtx);
    expect(text).toContain('[content from preceding turn omitted');
    expect(removed).toBeGreaterThan(0);
  });

  it('keeps content that does not appear in assistant context', () => {
    const assistantCtx = 'a'.repeat(300);
    const toolContent = 'b'.repeat(300) + '\n\nmore content';
    const { text, removed } = trimEchoedContent(toolContent, assistantCtx);
    expect(text).toBe(toolContent);
    expect(removed).toBe(0);
  });

  it('does nothing when either string is too short', () => {
    const { text, removed } = trimEchoedContent('short', 'also short');
    expect(text).toBe('short');
    expect(removed).toBe(0);
  });
});

// ─── applyToolPrepass (integration) ──────────────────────────────────────────

describe('applyToolPrepass', () => {
  it('returns empty stats for empty message array', () => {
    const { messages, stats } = applyToolPrepass([]);
    expect(messages).toHaveLength(0);
    expect(stats.chars_removed).toBe(0);
  });

  it('passes non-tool messages through untouched', () => {
    const msgs = [msg('1', 'user', 'Hello'), msg('2', 'assistant', 'Hi there')];
    const { messages, stats } = applyToolPrepass(msgs);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello');
    expect(stats.verbose_trimmed).toBe(0);
  });

  it('category 1: trims verbose build output in tool messages', () => {
    const buildLines = Array.from({ length: 8 }, (_, i) => `[${i + 1}/8] Compiling module${i}`);
    const toolContent = ['Starting build...', ...buildLines, 'Build complete.'].join('\n');
    const msgs = [msg('1', 'tool', toolContent)];
    const { messages, stats } = applyToolPrepass(msgs);
    expect(messages[0].content).toContain('[... 6 build steps omitted ...]');
    expect(stats.verbose_trimmed).toBe(1);
    expect(stats.chars_removed).toBeGreaterThan(0);
  });

  it('category 2: stubs echoed blocks from preceding assistant message', () => {
    const sharedContent = 'z'.repeat(300);
    const msgs = [
      msg('1', 'assistant', sharedContent + ' assistant follow-up'),
      msg('2', 'tool', sharedContent + '\n\nsome tool metadata'),
    ];
    const { messages, stats } = applyToolPrepass(msgs);
    expect(messages[1].content).toContain('[content from preceding turn omitted');
    expect(stats.echo_trimmed).toBe(1);
  });

  it('category 3: stubs expired file reads when a later write covers the same path', () => {
    const filePath = '/usr/local/src/app/main.ts';
    const fileContent = `File: ${filePath}\n${'x'.repeat(2500)}`;
    const msgs = [
      msg('1', 'assistant', `read_file ${filePath}`),
      msg('2', 'tool', fileContent),
      msg('3', 'assistant', 'I wrote the updated version'),
      msg('4', 'tool', `wrote ${filePath} successfully`),
    ];
    const { messages, stats } = applyToolPrepass(msgs);
    expect(messages[1].content).toContain('[file content omitted');
    expect(stats.expired_stubbed).toBe(1);
  });

  it('preserves message id, role, and metadata after trimming', () => {
    const buildLines = Array.from({ length: 8 }, (_, i) => `[${i + 1}/8] Compiling step${i}`);
    const toolContent = buildLines.join('\n');
    const msgs = [msg('abc', 'tool', toolContent, { metadata: { tag: 'test' } })];
    const { messages } = applyToolPrepass(msgs);
    expect(messages[0].id).toBe('abc');
    expect(messages[0].role).toBe('tool');
    expect(messages[0].metadata).toEqual({ tag: 'test' });
  });

  it('surfaces trimmed stats in compress() result when agentToolPrepass is true', async () => {
    const { compress } = await import('../src/compress.js');
    const buildLines = Array.from({ length: 8 }, (_, i) => `[${i + 1}/8] Compiling step${i}`);
    const msgs: Message[] = [
      { id: 'm1', index: 0, role: 'user', content: 'run build' },
      { id: 'm2', index: 1, role: 'tool', content: buildLines.join('\n') },
    ];
    const result = compress(msgs, { agentToolPrepass: true });
    expect(result.compression.messages_tool_prepass_trimmed).toBeGreaterThanOrEqual(1);
    expect(result.compression.chars_tool_prepass_removed).toBeGreaterThan(0);
  });

  it('does not add prepass fields when agentToolPrepass is false', async () => {
    const { compress } = await import('../src/compress.js');
    const msgs: Message[] = [{ id: 'm1', index: 0, role: 'user', content: 'hello' }];
    const result = compress(msgs, { agentToolPrepass: false });
    expect(result.compression.messages_tool_prepass_trimmed).toBeUndefined();
    expect(result.compression.chars_tool_prepass_removed).toBeUndefined();
  });
});
