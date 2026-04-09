/**
 * Format adapters for structured data formats commonly found in LLM contexts.
 *
 * XML, YAML, and Markdown each have different compression strategies:
 *
 * - XmlAdapter: preserves the structural skeleton (tags + attributes); compresses
 *   text nodes that look like prose (6+ words, 100+ chars). Config values,
 *   version strings, and commands are preserved verbatim.
 *
 * - YamlAdapter: preserves keys with short atomic values (names, versions,
 *   booleans, numbers, commands); compresses long prose string values only.
 *
 * - MarkdownAdapter: preserves headings and tables (structural anchors);
 *   compresses paragraph prose between structural elements. Note: content
 *   with code fences is handled upstream by the built-in code-split pass
 *   before adapters are checked.
 *
 * All adapters are zero-dependency (no external parsing libraries).
 */

import type { FormatAdapter } from './types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Returns true if a string reads as prose rather than a structured value. */
function looksLikeProse(text: string): boolean {
  const t = text.trim();
  return t.split(/\s+/).length >= 6 && t.length >= 100;
}

// ---------------------------------------------------------------------------
// XmlAdapter
// ---------------------------------------------------------------------------

const XML_DETECT_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?<[a-zA-Z]/;
const XML_CLOSE_RE = /<\/[a-zA-Z]/;
// Text node: content between > and < that contains meaningful characters
const XML_TEXT_NODE_RE = />([^<]{1,})</g;

function xmlSkeleton(content: string): string {
  // Collapse prose text nodes to a placeholder; keep short values intact.
  return content.replace(XML_TEXT_NODE_RE, (_match, text: string) => {
    if (looksLikeProse(text)) return '>[…]<';
    return `>${text}<`;
  });
}

function xmlProseNodes(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(XML_TEXT_NODE_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    if (looksLikeProse(m[1])) out.push(m[1].trim());
  }
  // Also capture XML comments that contain prose
  const commentRe = /<!--([\s\S]*?)-->/g;
  while ((m = commentRe.exec(content)) !== null) {
    const text = m[1].trim();
    if (looksLikeProse(text)) out.push(text);
  }
  return out;
}

/**
 * Handles XML documents (configs, schemas, API responses, manifests).
 * Structural tags and short values are preserved; long prose text nodes
 * and verbose comments are compressed.
 */
export const XmlAdapter: FormatAdapter = {
  name: 'xml',

  detect(content: string): boolean {
    return XML_DETECT_RE.test(content) && XML_CLOSE_RE.test(content);
  },

  extractPreserved(content: string): string[] {
    return [xmlSkeleton(content).trim()];
  },

  extractCompressible(content: string): string[] {
    return xmlProseNodes(content);
  },

  reconstruct(preserved: string[], summary: string): string {
    if (!summary) return preserved.join('\n');
    return `${preserved.join('\n')}\n<!-- ${summary} -->`;
  },
};

// ---------------------------------------------------------------------------
// YamlAdapter
// ---------------------------------------------------------------------------

// Matches: optional indent, key (word chars + - .), colon, optional value
const YAML_KEY_LINE_RE = /^([ \t]*)([\w][\w.-]*)\s*:\s*(.*)$/;

function isYamlDocument(content: string): boolean {
  const lines = content.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() && !l.trimStart().startsWith('#'));
  if (nonEmpty.length < 4) return false;
  const keyLines = nonEmpty.filter((l) => YAML_KEY_LINE_RE.test(l));
  return keyLines.length / nonEmpty.length > 0.35;
}

/** Returns true if a YAML value should be preserved (atomic / short). */
function isAtomicValue(value: string): boolean {
  const v = value.trim();
  // Empty (nested object follows), anchors, references, block indicators
  if (v === '' || v.startsWith('&') || v.startsWith('*') || v === '|' || v === '>') return true;
  // Booleans, null, numbers
  if (/^(?:true|false|null|~|\d[\d.,_]*(?:e[+-]?\d+)?)$/i.test(v)) return true;
  // Short values: version strings, image names, paths, env var patterns
  if (v.length <= 60) return true;
  return false;
}

/**
 * Handles YAML configuration files (k8s manifests, Docker Compose, CI/CD configs).
 * Keys with short/atomic values are preserved; keys with long prose string values
 * are candidates for compression.
 */
export const YamlAdapter: FormatAdapter = {
  name: 'yaml',

  detect(content: string): boolean {
    return isYamlDocument(content);
  },

  extractPreserved(content: string): string[] {
    return content
      .split('\n')
      .filter((line) => {
        const m = line.match(YAML_KEY_LINE_RE);
        if (!m) return true; // list items, --- markers, comments, blank lines
        return isAtomicValue(m[3]);
      });
  },

  extractCompressible(content: string): string[] {
    const out: string[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(YAML_KEY_LINE_RE);
      if (m && !isAtomicValue(m[3])) {
        out.push(`${m[2]}: ${m[3].trim()}`);
      }
    }
    return out;
  },

  reconstruct(preserved: string[], summary: string): string {
    const parts = [...preserved];
    if (summary) parts.push(`# ${summary}`);
    return parts.join('\n');
  },
};

// ---------------------------------------------------------------------------
// MarkdownAdapter
// ---------------------------------------------------------------------------

const MD_HEADING_RE = /^#{1,6}\s+\S/;
// Table detection: line starts and ends with |
const MD_TABLE_LINE_RE = /^\|.+\|$/;

function hasStructuredMarkdown(content: string): boolean {
  const lines = content.split('\n');
  const headingCount = lines.filter((l) => MD_HEADING_RE.test(l)).length;
  // Require at least 2 headings — single-heading docs aren't structured enough
  // to warrant special treatment. Also require enough content to compress.
  return headingCount >= 2 && content.length >= 200;
}

/**
 * Handles structured Markdown documents (READMEs, changelogs, API docs, specs).
 * Headings and tables are preserved as structural anchors; paragraph prose
 * between structural elements is compressible.
 *
 * Note: content containing code fences is intercepted by the built-in
 * code-split pass before adapters are checked, so this adapter focuses on
 * prose-heavy Markdown.
 */
export const MarkdownAdapter: FormatAdapter = {
  name: 'markdown',

  detect(content: string): boolean {
    return hasStructuredMarkdown(content);
  },

  extractPreserved(content: string): string[] {
    const preserved: string[] = [];
    // Collect table blocks and headings in document order
    let tableLines: string[] = [];

    for (const line of content.split('\n')) {
      if (MD_HEADING_RE.test(line)) {
        // Flush any pending table
        if (tableLines.length > 0) {
          preserved.push(tableLines.join('\n'));
          tableLines = [];
        }
        preserved.push(line);
      } else if (MD_TABLE_LINE_RE.test(line) || /^\|[-| :]+\|$/.test(line)) {
        tableLines.push(line);
      } else {
        if (tableLines.length > 0) {
          preserved.push(tableLines.join('\n'));
          tableLines = [];
        }
      }
    }
    if (tableLines.length > 0) preserved.push(tableLines.join('\n'));

    return preserved;
  },

  extractCompressible(content: string): string[] {
    // Strip headings, tables, and horizontal rules → remaining text is compressible
    const prose = content
      .split('\n')
      .filter(
        (l) =>
          !MD_HEADING_RE.test(l) &&
          !MD_TABLE_LINE_RE.test(l) &&
          !/^\|[-| :]+\|$/.test(l) &&
          !/^[-*_]{3,}\s*$/.test(l),
      )
      .join('\n');

    return prose
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  },

  reconstruct(preserved: string[], summary: string): string {
    const parts = [...preserved];
    if (summary) parts.push(summary);
    return parts.join('\n\n');
  },
};
