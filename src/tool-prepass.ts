/**
 * AgentDiet-inspired tool message pre-pass (arXiv:2509.23586).
 *
 * Runs before the main compression pipeline to strip three categories of
 * waste that are common in agentic tool responses:
 *
 *   1. Verbose output  — directory tree listings, build step counters,
 *                        package-manager noise, verbose test runner output.
 *   2. Echoed content  — blocks repeated verbatim from the preceding
 *                        assistant message (str_replace_editor-style echoes).
 *   3. Expired content — large file-read results superseded by a later write
 *                        to the same path.
 *
 * All trimming is content-only: message IDs, roles, and metadata are
 * preserved.  Stats are returned so the caller can surface them in
 * compression.messages_tool_prepass_trimmed.
 */

import type { Message } from './types.js';

export type ToolPrepassStats = {
  /** Messages whose content was trimmed by category 1 (verbose output). */
  verbose_trimmed: number;
  /** Messages whose content was trimmed by category 2 (echoed content). */
  echo_trimmed: number;
  /** Messages whose content was stubbed by category 3 (expired file reads). */
  expired_stubbed: number;
  /** Total characters removed across all categories. */
  chars_removed: number;
};

export type ToolPrepassResult = {
  messages: Message[];
  stats: ToolPrepassStats;
};

// ─── Roles that are subject to pre-pass trimming ─────────────────────────────

const TOOL_ROLES = new Set(['tool', 'function']);

// ─── Category 1: Verbose output ──────────────────────────────────────────────

// Directory tree lines that mix tree-drawing chars with noise directories.
const TREE_PREFIX_RE = /^[│├└|\\/ ─]+/;
const NOISE_DIR_RE =
  /(?:node_modules|__pycache__|\.git\/|\.cache\/|dist\/|\.next\/|\.nuxt\/|coverage\/)/;

// Build step progress lines: [N/M] or (N/M) at line start.
const BUILD_STEP_RE = /^\[?\s*\d+\s*\/\s*\d+\s*\]?\s+\S/;

// npm / yarn / pnpm / bun noise lines.
const PKG_NOISE_RE =
  /^(?:npm (?:warn|notice|http|timing|verb)|yarn (?:warn|info)|pnpm\s+(?:warn|notice)|[⠸⠼⠴⠦⠧⠇⠏⠋⠙⠹]+\s)/;
// Lines we always keep even inside a noise block.
const PKG_KEEP_RE = /^(?:added|removed|changed|audited|found)\s+\d+/;

// Test runner "passing" result lines — only trigger if ≥ PASS_LINE_THRESHOLD.
const TEST_PASS_RE = /^[\s]*[✓✔+]\s+.{3,}$/;
const TEST_SUMMARY_RE = /(?:Tests?:|Test Suites?:|Suites?:|Time:)\s+\d+/i;
const PASS_LINE_THRESHOLD = 10;

/** @internal exported for unit tests */
export function trimDirectoryListings(text: string): { text: string; removed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let run: string[] = [];
  let removed = 0;

  const flush = () => {
    if (run.length >= 5) {
      out.push(`[... ${run.length} directory entries omitted ...]`);
      removed += run.length;
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (TREE_PREFIX_RE.test(line) && NOISE_DIR_RE.test(line)) {
      run.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return { text: out.join('\n'), removed };
}

/** @internal exported for unit tests */
export function trimBuildStepCounters(text: string): { text: string; removed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let run: string[] = [];
  let removed = 0;

  const flush = () => {
    if (run.length >= 5) {
      // Keep first + last; collapse the middle
      out.push(run[0]);
      const omitted = run.length - 2;
      if (omitted > 0) {
        out.push(`[... ${omitted} build steps omitted ...]`);
        removed += omitted;
      }
      out.push(run[run.length - 1]);
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (BUILD_STEP_RE.test(line)) {
      run.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return { text: out.join('\n'), removed };
}

/** @internal exported for unit tests */
export function trimPackageManagerNoise(text: string): { text: string; removed: number } {
  const lines = text.split('\n');
  const noiseCount = lines.filter((l) => PKG_NOISE_RE.test(l) && !PKG_KEEP_RE.test(l)).length;
  if (noiseCount < 3) return { text, removed: 0 };

  const out = lines.filter((l) => !PKG_NOISE_RE.test(l) || PKG_KEEP_RE.test(l));
  return { text: out.join('\n'), removed: lines.length - out.length };
}

/** @internal exported for unit tests */
export function trimTestVerboseOutput(text: string): { text: string; removed: number } {
  const lines = text.split('\n');
  const passLines = lines.filter((l) => TEST_PASS_RE.test(l));
  if (passLines.length < PASS_LINE_THRESHOLD) return { text, removed: 0 };

  const out = lines.filter((l) => !TEST_PASS_RE.test(l));

  // Insert a note before the summary line if present, else at the end
  const summaryIdx = out.findIndex((l) => TEST_SUMMARY_RE.test(l));
  const note = `[... ${passLines.length} passing test lines omitted ...]`;
  if (summaryIdx >= 0) {
    out.splice(summaryIdx, 0, note);
  } else {
    out.push(note);
  }

  return { text: out.join('\n'), removed: passLines.length };
}

function applyCategory1(content: string): { text: string; removed: number } {
  let text = content;
  let removed = 0;

  const a = trimDirectoryListings(text);
  text = a.text;
  removed += a.removed;

  const b = trimBuildStepCounters(text);
  text = b.text;
  removed += b.removed;

  const c = trimPackageManagerNoise(text);
  text = c.text;
  removed += c.removed;

  const d = trimTestVerboseOutput(text);
  text = d.text;
  removed += d.removed;

  return { text, removed };
}

// ─── Category 2: Echoed content from preceding assistant messages ─────────────

const MIN_ECHO_BLOCK_CHARS = 200;
// Sliding window used to detect whether a block appears in the preceding turn.
const ECHO_PROBE_CHARS = 120;

/**
 * Collect the content of the most recent assistant messages before `endIdx`,
 * looking back up to `window` positions.
 */
function recentAssistantContent(messages: Message[], endIdx: number, window = 3): string {
  let result = '';
  let checked = 0;
  for (let i = endIdx - 1; i >= 0 && checked < window; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string') {
      result += m.content + '\n';
      checked++;
    }
  }
  return result;
}

/** @internal exported for unit tests */
export function trimEchoedContent(
  toolContent: string,
  assistantContext: string,
): { text: string; removed: number } {
  if (assistantContext.length < MIN_ECHO_BLOCK_CHARS || toolContent.length < MIN_ECHO_BLOCK_CHARS) {
    return { text: toolContent, removed: 0 };
  }

  const blocks = toolContent.split(/\n\n+/);
  let removed = 0;
  const out: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length < MIN_ECHO_BLOCK_CHARS) {
      out.push(block);
      continue;
    }
    // Probe: if the first ECHO_PROBE_CHARS chars of this block appear in the
    // assistant context, the block is an echo — replace with a stub.
    const probe = trimmed.slice(0, ECHO_PROBE_CHARS);
    if (assistantContext.includes(probe)) {
      removed += trimmed.length;
      out.push(`[content from preceding turn omitted (${trimmed.length} chars)]`);
    } else {
      out.push(block);
    }
  }

  return { text: out.join('\n\n'), removed };
}

// ─── Category 3: Expired file-read results ───────────────────────────────────

// Conservative path pattern: at least 3 slash-separated components with an extension.
const STRICT_FILE_PATH_RE = /(?:\/[\w.-]+){3,}\.\w{2,5}/g;
// Modification signal in the content of a later message.
const WRITE_SIGNAL_RE =
  /\b(?:wrote|written|created|saved|updated|modified|edited|replaced|overwritten)\b/i;
const EXPIRED_LOOKAHEAD = 15;
const MIN_FILE_READ_CHARS = 2000;

function extractStrictFilePaths(text: string): string[] {
  const matches = text.match(STRICT_FILE_PATH_RE);
  return matches ? [...new Set(matches)] : [];
}

function findExpiredReadIndices(messages: Message[]): Set<number> {
  const expired = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.role || !TOOL_ROLES.has(msg.role)) continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length < MIN_FILE_READ_CHARS) continue;

    // Collect file paths from this message and its immediately preceding message
    const prev = i > 0 ? messages[i - 1] : null;
    const prevContent = prev && typeof prev.content === 'string' ? prev.content : '';
    const paths = extractStrictFilePaths(prevContent + '\n' + content.slice(0, 800));
    if (paths.length === 0) continue;

    // Look ahead for a write to the same path
    const limit = Math.min(messages.length, i + EXPIRED_LOOKAHEAD + 1);
    for (let j = i + 1; j < limit; j++) {
      const later = messages[j];
      const laterContent = typeof later.content === 'string' ? later.content : '';
      if (!WRITE_SIGNAL_RE.test(laterContent)) continue;
      const laterPaths = extractStrictFilePaths(laterContent);
      if (paths.some((p) => laterPaths.includes(p))) {
        expired.add(i);
        break;
      }
    }
  }

  return expired;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function applyToolPrepass(messages: Message[]): ToolPrepassResult {
  if (messages.length === 0) {
    return {
      messages,
      stats: { verbose_trimmed: 0, echo_trimmed: 0, expired_stubbed: 0, chars_removed: 0 },
    };
  }

  // Category 3: identify expired reads in a forward pass (needs full array)
  const expiredIndices = findExpiredReadIndices(messages);

  const result: Message[] = [];
  const stats: ToolPrepassStats = {
    verbose_trimmed: 0,
    echo_trimmed: 0,
    expired_stubbed: 0,
    chars_removed: 0,
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isTool = msg.role != null && TOOL_ROLES.has(msg.role);
    const content = typeof msg.content === 'string' ? msg.content : null;

    if (!isTool || content === null || content.length === 0) {
      result.push(msg);
      continue;
    }

    let text = content;
    let modified = false;
    let charsRemoved = 0;

    // Category 3: expired file read — stub out immediately
    if (expiredIndices.has(i)) {
      const stub = `[file content omitted — superseded by a later write (${content.length} chars original)]`;
      result.push({ ...msg, content: stub });
      stats.expired_stubbed++;
      stats.chars_removed += content.length - stub.length;
      continue;
    }

    // Category 1: verbose output
    const cat1 = applyCategory1(text);
    if (cat1.removed > 0) {
      text = cat1.text;
      charsRemoved += cat1.removed;
      modified = true;
    }

    // Category 2: echoed content
    if (text.length >= MIN_ECHO_BLOCK_CHARS) {
      const assistantCtx = recentAssistantContent(messages, i);
      const cat2 = trimEchoedContent(text, assistantCtx);
      if (cat2.removed > 0) {
        text = cat2.text;
        charsRemoved += cat2.removed;
        modified = true;
      }
    }

    if (modified) {
      if (cat1.removed > 0) stats.verbose_trimmed++;
      // Re-check echo on original content to set the counter correctly
      // (cat2 may have been applied on already-cat1-trimmed text; use original
      // content.length as the guard, not the already-trimmed text.length)
      if (content.length >= MIN_ECHO_BLOCK_CHARS) {
        const probeCtx = recentAssistantContent(messages, i);
        if (trimEchoedContent(content, probeCtx).removed > 0) stats.echo_trimmed++;
      }
      result.push({ ...msg, content: text });
      stats.chars_removed += charsRemoved;
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats };
}
