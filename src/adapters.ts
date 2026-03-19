/**
 * Format adapter pattern for extensible content handling.
 *
 * Formalizes the existing code-split and structured-output logic into a clean
 * interface. Users can register custom adapters for domain-specific formats.
 */

import type { FormatAdapter } from './types.js';

// ---------------------------------------------------------------------------
// Built-in: CodeAdapter
// ---------------------------------------------------------------------------

const FENCE_RE = /^[ ]{0,3}```[^\n]*\n[\s\S]*?\n\s*```/gm;

/**
 * Handles messages containing code fences interleaved with prose.
 * Code fences are preserved verbatim; surrounding prose is compressed.
 */
export const CodeAdapter: FormatAdapter = {
  name: 'code',

  detect(content: string): boolean {
    return content.includes('```');
  },

  extractPreserved(content: string): string[] {
    const fences: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(FENCE_RE.source, FENCE_RE.flags);
    while ((match = re.exec(content)) !== null) {
      fences.push(match[0]);
    }
    return fences;
  },

  extractCompressible(content: string): string[] {
    const prose: string[] = [];
    const re = new RegExp(FENCE_RE.source, FENCE_RE.flags);
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const segment = content.slice(lastIndex, match.index).trim();
      if (segment) prose.push(segment);
      lastIndex = match.index + match[0].length;
    }
    const trailing = content.slice(lastIndex).trim();
    if (trailing) prose.push(trailing);
    return prose;
  },

  reconstruct(preserved: string[], summary: string): string {
    return `${summary}\n\n${preserved.join('\n\n')}`;
  },
};

// ---------------------------------------------------------------------------
// Built-in: StructuredOutputAdapter
// ---------------------------------------------------------------------------

const STRUCTURAL_RE =
  /^(?:\S+\.\w+:\d+:|[ \t]+[-•*]|[ \t]*\w[\w ./-]*:\s|(?:PASS|FAIL|ERROR|WARNING|WARN|OK|SKIP)\b)/;

function isStructuredOutput(text: string): boolean {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 6) return false;
  const newlineDensity = (text.match(/\n/g) ?? []).length / text.length;
  if (newlineDensity < 1 / 80) return false;
  let structural = 0;
  for (const line of nonEmpty) {
    if (STRUCTURAL_RE.test(line)) structural++;
  }
  return structural / nonEmpty.length > 0.5;
}

/**
 * Handles structured tool output (test results, grep output, status lines).
 * Extracts status/summary lines and file paths as preserved elements;
 * the remaining bulk content is compressible.
 */
export const StructuredOutputAdapter: FormatAdapter = {
  name: 'structured_output',

  detect(content: string): boolean {
    return isStructuredOutput(content);
  },

  extractPreserved(content: string): string[] {
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const preserved: string[] = [];
    for (const line of lines) {
      if (/\b(?:PASS|FAIL|ERROR|WARNING|WARN|Tests?|Total|Duration|passed|failed)\b/i.test(line)) {
        preserved.push(line.trim());
      }
    }
    // File paths from grep-style output
    const filePaths = new Set<string>();
    for (const line of lines) {
      const m = line.match(/^(\S+\.\w+):\d+:/);
      if (m) filePaths.add(m[1]);
    }
    if (filePaths.size > 0) {
      preserved.push(`files: ${Array.from(filePaths).join(', ')}`);
    }
    return preserved;
  },

  extractCompressible(content: string): string[] {
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const compressible: string[] = [];
    for (const line of lines) {
      if (
        !/\b(?:PASS|FAIL|ERROR|WARNING|WARN|Tests?|Total|Duration|passed|failed)\b/i.test(line) &&
        !/^\S+\.\w+:\d+:/.test(line)
      ) {
        compressible.push(line.trim());
      }
    }
    return compressible;
  },

  reconstruct(preserved: string[], summary: string): string {
    const parts = [...preserved];
    if (summary) parts.push(summary);
    return parts.join(' | ');
  },
};
