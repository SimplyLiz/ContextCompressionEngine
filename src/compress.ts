import { classifyMessage, HARD_T0_REASONS } from './classify.js';
import { analyzeDuplicates, analyzeFuzzyDuplicates, type DedupAnnotation } from './dedup.js';
import {
  computeImportance,
  DEFAULT_IMPORTANCE_THRESHOLD,
  type ImportanceMap,
} from './importance.js';
import { analyzeContradictions, type ContradictionAnnotation } from './contradiction.js';
import { extractEntities, computeQualityScore } from './entities.js';
import { combineScores } from './entropy.js';
import type {
  Classifier,
  ClassifierResult,
  CompressDecision,
  CompressOptions,
  CompressResult,
  FormatAdapter,
  Message,
  Summarizer,
} from './types.js';

/**
 * Deterministic summary ID from sorted source message IDs.
 * Uses djb2 to avoid a crypto dependency; collisions are acceptable
 * because the ID is advisory provenance, not a security primitive.
 */
function makeSummaryId(ids: string[]): string {
  const key = ids.length === 1 ? ids[0] : ids.slice().sort().join('\0');
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return `cce_sum_${h.toString(36)}`;
}

/**
 * Collect summary_ids from source messages that were themselves compressed,
 * forming a provenance chain.
 */
function collectParentIds(msgs: Message[]): string[] {
  const parents: string[] = [];
  for (const m of msgs) {
    const orig = m.metadata?._cce_original as Record<string, unknown> | undefined;
    if (orig?.summary_id && typeof orig.summary_id === 'string') {
      parents.push(orig.summary_id);
    }
  }
  return parents;
}

const FILLER_RE =
  /^(?:great|sure|ok|okay|thanks|thank you|got it|right|yes|no|alright|absolutely|exactly|indeed|cool|nice|perfect|wonderful|awesome|fantastic|sounds good|makes sense|i see|i understand|understood|noted|certainly|of course|no problem|no worries|will do|let me|i'll|i can|i would|well|so|now)[,.!?\s]/i;

const EMPHASIS_RE =
  /\b(?:importantly|note that|however|critical|crucial|essential|significant|notably|key point|in particular|specifically|must|require[ds]?|never|always)\b/i;

const REASONING_SCORE_RE =
  /\b(?:therefore|hence|thus|consequently|accordingly|it follows that|we can (?:conclude|deduce|infer)|this (?:implies|proves|means) that|as a result|given that|in conclusion)\b/i;

function scoreSentence(sentence: string): number {
  let score = 0;
  // camelCase identifiers
  score += (sentence.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3;
  // PascalCase identifiers
  score += (sentence.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3;
  // snake_case identifiers
  score += (sentence.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).length * 3;
  // Emphasis phrases
  if (EMPHASIS_RE.test(sentence)) score += 4;
  // Reasoning connectives — defense-in-depth so reasoning sentences survive summarization
  if (REASONING_SCORE_RE.test(sentence)) score += 3;
  // Numbers with units
  score +=
    (
      sentence.match(
        /\b\d+(?:\.\d+)?\s*(?:seconds?|ms|MB|GB|TB|KB|retries?|workers?|threads?|nodes?|replicas?|requests?|%)\b/gi,
      ) ?? []
    ).length * 2;
  // Vowelless abbreviations (3+ consonants)
  score += (sentence.match(/\b[bcdfghjklmnpqrstvwxz]{3,}\b/gi) ?? []).length * 2;
  // PASS/FAIL/ERROR/WARNING/WARN status words
  score += (sentence.match(/\b(?:PASS|FAIL|ERROR|WARNING|WARN)\b/g) ?? []).length * 3;
  // Grep-style file:line references (e.g. src/foo.ts:42:)
  score += (sentence.match(/\S+\.\w+:\d+:/g) ?? []).length * 2;
  // Optimal length bonus
  if (sentence.length >= 40 && sentence.length <= 120) score += 2;
  // Filler penalty
  if (FILLER_RE.test(sentence.trim())) score -= 10;
  return score;
}

/**
 * Compute the best (highest) sentence score in a text.
 * Used for the relevance threshold: if the best score is below the threshold,
 * the content is too low-value to produce a useful summary.
 */
export function bestSentenceScore(text: string): number {
  const sentences = text.match(/[^.!?\n]+[.!?]+/g);
  if (!sentences || sentences.length === 0) return scoreSentence(text.trim());
  let best = -Infinity;
  for (const s of sentences) {
    const score = scoreSentence(s.trim());
    if (score > best) best = score;
  }
  return best;
}

/**
 * Deterministic summarization with optional external score overrides.
 *
 * @param text - text to summarize
 * @param maxBudget - character budget for the summary
 * @param externalScores - optional per-sentence scores (from entropy scorer).
 *   When provided, replaces the heuristic scorer for sentence ranking.
 *   Map key is the sentence index (matches paragraph/sentence iteration order).
 */
function summarize(text: string, maxBudget?: number, externalScores?: Map<number, number>): string {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);

  type Scored = { text: string; score: number; origIdx: number; primary: boolean };
  const allSentences: Scored[] = [];
  let globalIdx = 0;

  for (const para of paragraphs) {
    const sentences = para.match(/[^.!?\n]+[.!?]+/g);
    if (!sentences || sentences.length === 0) {
      const trimmed = para.trim();
      if (trimmed.length > 0) {
        const score = externalScores?.get(globalIdx) ?? scoreSentence(trimmed);
        allSentences.push({
          text: trimmed,
          score,
          origIdx: globalIdx++,
          primary: true,
        });
      }
      continue;
    }
    // Score all sentences, mark the best per paragraph as primary
    let bestIdx = 0;
    let bestScore = -Infinity;
    const paraSentences: Scored[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i].trim();
      const sc = externalScores?.get(globalIdx + i) ?? scoreSentence(s);
      paraSentences.push({ text: s, score: sc, origIdx: globalIdx + i, primary: false });
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
      }
    }
    paraSentences[bestIdx].primary = true;
    allSentences.push(...paraSentences);
    globalIdx += sentences.length;
  }

  const budget = maxBudget ?? 400;

  if (allSentences.length === 0) {
    return text.slice(0, budget).trim();
  }

  // Greedy budget packing: primary sentences first, then fill with others
  // Skip filler (negative score) and deduplicate by text
  const selected: Scored[] = [];
  const seenText = new Set<string>();
  let usedChars = 0;

  const primaryByScore = allSentences
    .filter((s) => s.primary && s.score >= 0)
    .sort((a, b) => b.score - a.score);
  const secondaryByScore = allSentences
    .filter((s) => !s.primary && s.score >= 0)
    .sort((a, b) => b.score - a.score);

  for (const pool of [primaryByScore, secondaryByScore]) {
    for (const entry of pool) {
      if (seenText.has(entry.text)) continue;
      const separatorLen = selected.length > 0 ? 5 : 0;
      if (usedChars + separatorLen + entry.text.length <= budget) {
        selected.push(entry);
        seenText.add(entry.text);
        usedChars += separatorLen + entry.text.length;
      }
    }
  }

  // If nothing fits (all filler or all too long), take the highest-scored and truncate
  if (selected.length === 0) {
    const best = allSentences.slice().sort((a, b) => b.score - a.score)[0];
    const truncated = best.text.slice(0, budget).trim();
    return truncated.length > budget - 3 ? truncated.slice(0, budget - 3) + '...' : truncated;
  }

  // Re-sort by original position to preserve reading order
  selected.sort((a, b) => a.origIdx - b.origIdx);

  const result = selected.map((s) => s.text).join(' ... ');
  if (result.length > budget) {
    return result.slice(0, budget - 3) + '...';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Structured tool output detection and summarization
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

function summarizeStructured(text: string, maxBudget: number): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  // Extract file paths from grep-style output (file.ext:line:)
  const filePaths = new Set<string>();
  for (const line of nonEmpty) {
    const m = line.match(/^(\S+\.\w+):\d+:/);
    if (m) filePaths.add(m[1]);
  }

  // Extract status/summary lines (PASS/FAIL counts, duration, totals)
  const statusLines: string[] = [];
  for (const line of nonEmpty) {
    if (/\b(?:PASS|FAIL|ERROR|WARNING|WARN|Tests?|Total|Duration|passed|failed)\b/i.test(line)) {
      statusLines.push(line.trim());
    }
  }

  const parts: string[] = [];

  // File paths summary
  if (filePaths.size > 0) {
    const allPaths = Array.from(filePaths);
    const shown = allPaths.slice(0, 3).join(', ');
    if (allPaths.length > 3) {
      parts.push(`files: ${shown} +${allPaths.length - 3} more`);
    } else {
      parts.push(`files: ${shown}`);
    }
  }

  // Status lines (deduplicated)
  const seenStatus = new Set<string>();
  for (const s of statusLines) {
    if (!seenStatus.has(s) && seenStatus.size < 3) {
      seenStatus.add(s);
      parts.push(s);
    }
  }

  // If we got meaningful structured content, use it
  if (parts.length > 0) {
    let result = parts.join(' | ');
    if (result.length > maxBudget) {
      result = result.slice(0, maxBudget - 3) + '...';
    }
    return result;
  }

  // Fallback: head/tail with line count
  const head = nonEmpty
    .slice(0, 3)
    .map((l) => l.trim())
    .join(' | ');
  const tail = nonEmpty[nonEmpty.length - 1].trim();
  let result = `${head} | ... | ${tail} (${nonEmpty.length} lines)`;
  if (result.length > maxBudget) {
    result = result.slice(0, maxBudget - 3) + '...';
  }
  return result;
}

/**
 * Adaptive summary budget: scales with content density.
 * Dense content (many entities per char) gets more budget to preserve identifiers.
 * Sparse content (general discussion) gets tighter budget for more aggressive compression.
 *
 * @param contentLength - character length of the content
 * @param entityCount - optional entity count for density-adaptive scaling
 */
function computeBudget(contentLength: number, entityCount?: number): number {
  const baseRatio = 0.3;

  if (entityCount != null && contentLength > 0) {
    const density = entityCount / contentLength;
    // Dense content: up to 45% budget; sparse content: down to 15%
    const densityBonus = Math.min(density * 500, 0.5); // 500 is a scaling factor
    const adaptiveRatio = Math.max(0.15, Math.min(baseRatio + densityBonus - 0.15, 0.45));
    return Math.max(100, Math.min(Math.round(contentLength * adaptiveRatio), 800));
  }

  return Math.max(200, Math.min(Math.round(contentLength * baseRatio), 600));
}

function splitCodeAndProse(text: string): Array<{ type: 'prose' | 'code'; content: string }> {
  const segments: Array<{ type: 'prose' | 'code'; content: string }> = [];
  const fenceRe = /^[ ]{0,3}```[^\n]*\n[\s\S]*?\n\s*```/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    const prose = text.slice(lastIndex, match.index).trim();
    if (prose) {
      segments.push({ type: 'prose', content: prose });
    }
    segments.push({ type: 'code', content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  const trailing = text.slice(lastIndex).trim();
  if (trailing) {
    segments.push({ type: 'prose', content: trailing });
  }

  return segments;
}

function isValidJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function contentLength(msg: Message): number {
  return typeof msg.content === 'string' ? msg.content.length : 0;
}

/**
 * Default token counter: ~3.5 chars/token heuristic.
 *
 * The 3.5 ratio is the empirical average for GPT-family BPE tokenizers
 * (cl100k_base, o200k_base) on mixed English text. Real-world values range
 * from ~3.2 (code-heavy) to ~4.5 (plain prose). We intentionally pick the
 * lower end so budget estimates stay conservative (slightly over-counting
 * tokens is safer than under-counting). Users who need exact counts can
 * supply a real tokenizer via the `tokenCounter` option.
 */
export function defaultTokenCounter(msg: Message): number {
  return Math.ceil(contentLength(msg) / 3.5);
}

// ---------------------------------------------------------------------------
// Shared helpers extracted for sync / async reuse
// ---------------------------------------------------------------------------

type _InternalOptions = CompressOptions & {
  _llmResults?: Map<number, ClassifierResult>;
};

type Classified = {
  msg: Message;
  preserved: boolean;
  codeSplit?: boolean;
  dedup?: DedupAnnotation;
  contradiction?: ContradictionAnnotation;
  patternPreserved?: boolean;
  llmPreserved?: boolean;
  importancePreserved?: boolean;
  traceReason?: string;
  adapterMatch?: FormatAdapter;
};

/** Build a compressed message with _cce_original provenance metadata. */
function buildCompressedMessage(
  base: Message,
  ids: string[],
  summaryContent: string,
  sourceVersion: number,
  verbatim: Record<string, Message>,
  sourceMessages: Message[],
): Message {
  const summaryId = makeSummaryId(ids);
  const parents = collectParentIds(sourceMessages);
  for (const m of sourceMessages) {
    verbatim[m.id] = m;
  }
  return {
    ...base,
    content: summaryContent,
    metadata: {
      ...(base.metadata ?? {}),
      _cce_original: {
        ids,
        summary_id: summaryId,
        ...(parents.length > 0 ? { parent_ids: parents } : {}),
        version: sourceVersion,
      },
    },
  };
}

/** Wrap summary text with entity suffix and optional merge count. */
function formatSummary(
  summaryText: string,
  rawText: string,
  mergeCount?: number,
  skipEntities?: boolean,
  summaryId?: string,
): string {
  const entitySuffix = skipEntities
    ? ''
    : (() => {
        const e = extractEntities(rawText);
        return e.length > 0 ? ` | entities: ${e.join(', ')}` : '';
      })();
  const mergeSuffix = mergeCount && mergeCount > 1 ? ` (${mergeCount} messages merged)` : '';
  const prefix = summaryId ? `[summary#${summaryId}: ` : '[summary: ';
  return `${prefix}${summaryText}${mergeSuffix}${entitySuffix}]`;
}

/** Collect consecutive non-preserved, non-codeSplit, non-dedup, non-adapter messages with the same role. */
function collectGroup(
  classified: Classified[],
  startIdx: number,
): { group: Classified[]; nextIdx: number } {
  const group: Classified[] = [];
  const role = classified[startIdx].msg.role;
  let i = startIdx;
  while (
    i < classified.length &&
    !classified[i].preserved &&
    !classified[i].codeSplit &&
    !classified[i].dedup &&
    !classified[i].adapterMatch &&
    classified[i].msg.role === role
  ) {
    group.push(classified[i]);
    i++;
  }
  return { group, nextIdx: i };
}

function classifyAll(
  messages: Message[],
  preserveRoles: Set<string>,
  recencyWindow: number,
  dedupAnnotations?: Map<number, DedupAnnotation>,
  preservePatterns?: Array<{ re: RegExp; label: string }>,
  llmResults?: Map<number, ClassifierResult>,
  classifierMode?: 'hybrid' | 'full',
  trace?: boolean,
  adapters?: FormatAdapter[],
  observationThreshold?: number,
  counter?: (msg: Message) => number,
  importanceScores?: ImportanceMap,
  importanceThreshold?: number,
  contradictionAnnotations?: Map<number, ContradictionAnnotation>,
): Classified[] {
  const recencyStart = Math.max(0, messages.length - recencyWindow);

  return messages.map((msg, idx) => {
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Per-message observation threshold: large messages get compressed even in recency window.
    // System roles, tool_calls, and already-compressed messages are exempt.
    const largeObservation =
      observationThreshold != null && counter != null && counter(msg) > observationThreshold;

    if (msg.role && preserveRoles.has(msg.role)) {
      return { msg, preserved: true, ...(trace && { traceReason: 'preserved_role' }) };
    }
    if (!largeObservation && recencyWindow > 0 && idx >= recencyStart) {
      return { msg, preserved: true, ...(trace && { traceReason: 'recency_window' }) };
    }
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return { msg, preserved: true, ...(trace && { traceReason: 'tool_calls' }) };
    }
    if (!largeObservation && content.length < 120) {
      return { msg, preserved: true, ...(trace && { traceReason: 'short_content' }) };
    }
    if (
      content.startsWith('[summary:') ||
      content.startsWith('[summary#') ||
      content.startsWith('[truncated')
    ) {
      return { msg, preserved: true, ...(trace && { traceReason: 'already_compressed' }) };
    }
    // Importance-based preservation: high-importance messages preserved even outside recency
    if (
      importanceScores &&
      importanceThreshold != null &&
      !largeObservation &&
      importanceScores.has(idx)
    ) {
      const score = importanceScores.get(idx)!;
      if (score >= importanceThreshold) {
        return {
          msg,
          preserved: true,
          importancePreserved: true,
          ...(trace && { traceReason: `importance:${score.toFixed(2)}` }),
        };
      }
    }
    if (dedupAnnotations?.has(idx)) {
      const ann = dedupAnnotations.get(idx)!;
      return {
        msg,
        preserved: false,
        dedup: ann,
        ...(trace && {
          traceReason: ann.similarity != null ? 'fuzzy_duplicate' : 'exact_duplicate',
        }),
      };
    }
    // Contradiction: earlier message superseded by a later correction
    if (contradictionAnnotations?.has(idx)) {
      const ann = contradictionAnnotations.get(idx)!;
      return {
        msg,
        preserved: false,
        contradiction: ann,
        ...(trace && {
          traceReason: `contradicted:${ann.signal}`,
        }),
      };
    }
    if (content.includes('```')) {
      const segments = splitCodeAndProse(content);
      const totalProse = segments
        .filter((s) => s.type === 'prose')
        .reduce((sum, s) => sum + s.content.length, 0);
      if (totalProse >= 80) {
        return {
          msg,
          preserved: false,
          codeSplit: true,
          ...(trace && { traceReason: 'code_split' }),
        };
      }
      return { msg, preserved: true, ...(trace && { traceReason: 'code_fence_no_prose' }) };
    }
    // Heuristic classification (skipped in full mode)
    if (classifierMode !== 'full' && content) {
      const cls = classifyMessage(content);
      if (cls.decision === 'T0') {
        const hasHardReason = cls.reasons.some((r) => HARD_T0_REASONS.has(r));
        if (!largeObservation && hasHardReason) {
          const hardReasons = cls.reasons.filter((r) => HARD_T0_REASONS.has(r));
          return {
            msg,
            preserved: true,
            ...(trace && { traceReason: `hard_t0:${hardReasons.join(',')}` }),
          };
        }
        // Soft T0 only — allow compression, entities will capture references
      }
    }
    if (preservePatterns && preservePatterns.length > 0 && content) {
      const matchedPattern = preservePatterns.find((p) => p.re.test(content));
      if (matchedPattern) {
        return {
          msg,
          preserved: true,
          patternPreserved: true,
          ...(trace && { traceReason: `pattern:${matchedPattern.label}` }),
        };
      }
    }
    // LLM classifier results (pre-computed)
    if (llmResults && llmResults.has(idx)) {
      const llmResult = llmResults.get(idx)!;
      if (llmResult.decision === 'preserve') {
        return {
          msg,
          preserved: true,
          llmPreserved: true,
          ...(trace && { traceReason: `llm_preserved:${llmResult.reason}` }),
        };
      }
      // decision === 'compress' — fall through
    }
    if (!largeObservation && content && isValidJson(content)) {
      return { msg, preserved: true, ...(trace && { traceReason: 'json_structure' }) };
    }

    // Custom format adapters
    if (adapters && adapters.length > 0 && content) {
      for (const adapter of adapters) {
        if (adapter.detect(content)) {
          return {
            msg,
            preserved: false,
            adapterMatch: adapter,
            ...(trace && { traceReason: `adapter:${adapter.name}` }),
          };
        }
      }
    }

    return { msg, preserved: false, ...(trace && { traceReason: 'compressible_prose' }) };
  });
}

function computeStats(
  originalMessages: Message[],
  resultMessages: Message[],
  messagesCompressed: number,
  messagesPreserved: number,
  sourceVersion: number,
  counter: (msg: Message) => number,
  messagesDeduped?: number,
  messagesFuzzyDeduped?: number,
  messagesPatternPreserved?: number,
  messagesLlmClassified?: number,
  messagesLlmPreserved?: number,
  messagesContradicted?: number,
  messagesImportancePreserved?: number,
  messagesRelevanceDropped?: number,
): CompressResult['compression'] {
  const originalTotalChars = originalMessages.reduce((sum, m) => sum + contentLength(m), 0);
  const compressedTotalChars = resultMessages.reduce((sum, m) => sum + contentLength(m), 0);
  const totalCompressed = messagesCompressed + (messagesDeduped ?? 0);
  const ratio = compressedTotalChars > 0 ? originalTotalChars / compressedTotalChars : 1;

  const originalTotalTokens = sumTokens(originalMessages, counter);
  const compressedTotalTokens = sumTokens(resultMessages, counter);
  const tokenRatio = compressedTotalTokens > 0 ? originalTotalTokens / compressedTotalTokens : 1;

  return {
    original_version: sourceVersion,
    ratio: totalCompressed === 0 ? 1 : ratio,
    token_ratio: totalCompressed === 0 ? 1 : tokenRatio,
    messages_compressed: messagesCompressed,
    messages_preserved: messagesPreserved,
    ...(messagesDeduped && messagesDeduped > 0 ? { messages_deduped: messagesDeduped } : {}),
    ...(messagesFuzzyDeduped && messagesFuzzyDeduped > 0
      ? { messages_fuzzy_deduped: messagesFuzzyDeduped }
      : {}),
    ...(messagesPatternPreserved && messagesPatternPreserved > 0
      ? { messages_pattern_preserved: messagesPatternPreserved }
      : {}),
    ...(messagesLlmClassified && messagesLlmClassified > 0
      ? { messages_llm_classified: messagesLlmClassified }
      : {}),
    ...(messagesLlmPreserved && messagesLlmPreserved > 0
      ? { messages_llm_preserved: messagesLlmPreserved }
      : {}),
    ...(messagesContradicted && messagesContradicted > 0
      ? { messages_contradicted: messagesContradicted }
      : {}),
    ...(messagesImportancePreserved && messagesImportancePreserved > 0
      ? { messages_importance_preserved: messagesImportancePreserved }
      : {}),
    ...(messagesRelevanceDropped && messagesRelevanceDropped > 0
      ? { messages_relevance_dropped: messagesRelevanceDropped }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// LLM pre-classification (runs once before the pipeline)
// ---------------------------------------------------------------------------

async function preClassify(
  messages: Message[],
  classifier: Classifier,
  classifierMode: 'hybrid' | 'full',
  preserveRoles: Set<string>,
): Promise<Map<number, ClassifierResult>> {
  const results = new Map<number, ClassifierResult>();
  const tasks: Array<{ idx: number; promise: Promise<ClassifierResult> }> = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Skip always-preserved messages
    if (msg.role && preserveRoles.has(msg.role)) continue;
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
    if (content.length < 120) continue;
    if (
      content.startsWith('[summary:') ||
      content.startsWith('[summary#') ||
      content.startsWith('[truncated')
    )
      continue;

    // In hybrid mode: skip hard T0 (heuristic handles those)
    if (classifierMode === 'hybrid' && content) {
      const cls = classifyMessage(content);
      if (cls.decision === 'T0') {
        const hasHard = cls.reasons.some((r) => HARD_T0_REASONS.has(r));
        if (hasHard) continue;
      }
    }

    const result = classifier(content);
    if (result instanceof Promise) {
      tasks.push({ idx, promise: result });
    } else {
      results.set(idx, result);
    }
  }

  if (tasks.length > 0) {
    const settled = await Promise.all(tasks.map((t) => t.promise));
    for (let i = 0; i < tasks.length; i++) {
      results.set(tasks[i].idx, settled[i]);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unified compression core (generator + sync/async runners)
// ---------------------------------------------------------------------------

type SummarizeRequest = { text: string; budget: number };

async function withFallback(
  text: string,
  userSummarizer?: Summarizer,
  maxBudget?: number,
): Promise<string> {
  if (userSummarizer) {
    try {
      const result = await userSummarizer(text);
      if (typeof result === 'string' && result.length > 0 && result.length < text.length)
        return result;
    } catch {
      /* fall through to deterministic */
    }
  }
  return summarize(text, maxBudget);
}

function* compressGen(
  messages: Message[],
  options: CompressOptions = {},
): Generator<SummarizeRequest, CompressResult, string> {
  const sourceVersion = options.sourceVersion ?? 0;
  const counter = options.tokenCounter ?? defaultTokenCounter;

  if (messages.length === 0) {
    return {
      messages: [],
      compression: {
        original_version: sourceVersion,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: 0,
      },
      verbatim: {},
    };
  }

  const preserveRoles = new Set(options.preserve ?? ['system']);
  const recencyWindow = options.recencyWindow ?? 4;
  const recencyStart = Math.max(0, messages.length - (recencyWindow > 0 ? recencyWindow : 0));
  let dedupAnnotations =
    (options.dedup ?? true) ? analyzeDuplicates(messages, recencyStart, preserveRoles) : undefined;

  if (options.fuzzyDedup) {
    const fuzzyAnnotations = analyzeFuzzyDuplicates(
      messages,
      recencyStart,
      preserveRoles,
      dedupAnnotations ?? new Map(),
      options.fuzzyThreshold ?? 0.85,
    );
    if (fuzzyAnnotations.size > 0) {
      if (!dedupAnnotations) dedupAnnotations = new Map();
      for (const [idx, ann] of fuzzyAnnotations) {
        dedupAnnotations.set(idx, ann);
      }
    }
  }

  const internalOpts = options as _InternalOptions;
  const llmResults = internalOpts._llmResults;
  const classifierMode = options.classifierMode ?? 'hybrid';

  const trace = options.trace ?? false;

  // Importance scoring (ANCS-inspired)
  const importanceScores = options.importanceScoring ? computeImportance(messages) : undefined;
  const importanceThreshold = options.importanceThreshold ?? DEFAULT_IMPORTANCE_THRESHOLD;

  // Contradiction detection (ANCS-inspired)
  let contradictionAnnotations: Map<number, ContradictionAnnotation> | undefined;
  if (options.contradictionDetection) {
    contradictionAnnotations = analyzeContradictions(
      messages,
      options.contradictionTopicThreshold ?? 0.15,
      preserveRoles,
    );
  }

  const classified = classifyAll(
    messages,
    preserveRoles,
    recencyWindow,
    dedupAnnotations,
    options.preservePatterns,
    llmResults,
    classifierMode,
    trace,
    options.adapters,
    options.observationThreshold,
    options.observationThreshold != null ? counter : undefined,
    importanceScores,
    importanceScores ? importanceThreshold : undefined,
    contradictionAnnotations,
  );

  const result: Message[] = [];
  const verbatim: Record<string, Message> = {};
  const decisions: CompressDecision[] = [];
  let messagesCompressed = 0;
  let messagesPreserved = 0;
  let messagesDeduped = 0;
  let messagesFuzzyDeduped = 0;
  let messagesContradicted = 0;
  let messagesImportancePreserved = 0;
  let messagesRelevanceDropped = 0;
  let messagesPatternPreserved = 0;
  let messagesLlmPreserved = 0;
  let i = 0;

  while (i < classified.length) {
    const { msg, preserved } = classified[i];

    if (preserved) {
      result.push(msg);
      messagesPreserved++;
      if (classified[i].patternPreserved) messagesPatternPreserved++;
      if (classified[i].llmPreserved) messagesLlmPreserved++;
      if (classified[i].importancePreserved) messagesImportancePreserved++;
      if (trace) {
        const inChars = contentLength(msg);
        decisions.push({
          messageId: msg.id,
          messageIndex: i,
          action: 'preserved',
          reason: classified[i].traceReason ?? 'preserved',
          inputChars: inChars,
          outputChars: inChars,
        });
      }
      i++;
      continue;
    }

    // Dedup: replace earlier duplicate/near-duplicate with compact reference
    if (classified[i].dedup) {
      const annotation = classified[i].dedup!;
      const keepTargetId = messages[annotation.duplicateOfIndex].id;
      const tag =
        annotation.similarity != null
          ? `[cce:near-dup of ${keepTargetId} — ${annotation.contentLength} chars, ~${Math.round(annotation.similarity * 100)}% match]`
          : `[cce:dup of ${keepTargetId} — ${annotation.contentLength} chars]`;
      result.push(buildCompressedMessage(msg, [msg.id], tag, sourceVersion, verbatim, [msg]));
      if (trace) {
        decisions.push({
          messageId: msg.id,
          messageIndex: i,
          action: annotation.similarity != null ? 'fuzzy_deduped' : 'deduped',
          reason:
            classified[i].traceReason ??
            (annotation.similarity != null ? 'fuzzy_duplicate' : 'exact_duplicate'),
          inputChars: annotation.contentLength,
          outputChars: tag.length,
        });
      }
      if (annotation.similarity != null) {
        messagesFuzzyDeduped++;
      } else {
        messagesDeduped++;
      }
      i++;
      continue;
    }

    // Contradiction: superseded message — compress with annotation
    if (classified[i].contradiction) {
      const annotation = classified[i].contradiction!;
      const supersederId = messages[annotation.supersededByIndex].id;
      const content = typeof msg.content === 'string' ? msg.content : '';
      const contradictionEntityCount = extractEntities(content, 500).length;
      const contentBudget = computeBudget(content.length, contradictionEntityCount);
      const summaryText: string = yield { text: content, budget: contentBudget };
      let tag = `[cce:superseded by ${supersederId} (${annotation.signal}) — ${summaryText}]`;
      // If full tag doesn't fit, use compact format
      if (tag.length >= content.length) {
        tag = `[cce:superseded by ${supersederId} — ${annotation.signal}]`;
      }

      if (tag.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        if (trace) {
          decisions.push({
            messageId: msg.id,
            messageIndex: i,
            action: 'preserved',
            reason: 'contradiction_reverted',
            inputChars: content.length,
            outputChars: content.length,
          });
        }
      } else {
        result.push(buildCompressedMessage(msg, [msg.id], tag, sourceVersion, verbatim, [msg]));
        messagesContradicted++;
        if (trace) {
          decisions.push({
            messageId: msg.id,
            messageIndex: i,
            action: 'contradicted',
            reason: `contradicted:${annotation.signal}`,
            inputChars: content.length,
            outputChars: tag.length,
          });
        }
      }
      i++;
      continue;
    }

    // Code-split: extract fences verbatim, summarize surrounding prose
    if (classified[i].codeSplit) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const segments = splitCodeAndProse(content);
      const proseText = segments
        .filter((s) => s.type === 'prose')
        .map((s) => s.content)
        .join(' ');
      const codeFences = segments.filter((s) => s.type === 'code').map((s) => s.content);
      const proseEntityCount = extractEntities(proseText, 500).length;
      const proseBudget = computeBudget(proseText.length, proseEntityCount);
      const summaryText: string = yield { text: proseText, budget: proseBudget };
      const embeddedId = options.embedSummaryId ? makeSummaryId([msg.id]) : undefined;
      const compressed = `${formatSummary(summaryText, proseText, undefined, true, embeddedId)}\n\n${codeFences.join('\n\n')}`;

      if (compressed.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        if (trace) {
          decisions.push({
            messageId: msg.id,
            messageIndex: i,
            action: 'preserved',
            reason: 'code_split_reverted',
            inputChars: content.length,
            outputChars: content.length,
          });
        }
        i++;
        continue;
      }

      result.push(
        buildCompressedMessage(msg, [msg.id], compressed, sourceVersion, verbatim, [msg]),
      );
      messagesCompressed++;
      if (trace) {
        decisions.push({
          messageId: msg.id,
          messageIndex: i,
          action: 'code_split',
          reason: 'code_split',
          inputChars: content.length,
          outputChars: compressed.length,
        });
      }
      i++;
      continue;
    }

    // Custom adapter: extract preserved/compressible, summarize compressible, reconstruct
    if (classified[i].adapterMatch) {
      const adapter = classified[i].adapterMatch!;
      const content = typeof msg.content === 'string' ? msg.content : '';
      const preserved = adapter.extractPreserved(content);
      const compressible = adapter.extractCompressible(content);
      const proseText = compressible.join(' ');
      const adapterEntityCount = extractEntities(proseText, 500).length;
      const proseBudget = computeBudget(proseText.length, adapterEntityCount);
      const summaryText: string =
        proseText.length > 0 ? yield { text: proseText, budget: proseBudget } : '';
      const compressed = adapter.reconstruct(preserved, summaryText);

      if (compressed.length >= content.length) {
        result.push(msg);
        messagesPreserved++;
        if (trace) {
          decisions.push({
            messageId: msg.id,
            messageIndex: i,
            action: 'preserved',
            reason: `adapter_reverted:${adapter.name}`,
            inputChars: content.length,
            outputChars: content.length,
          });
        }
      } else {
        result.push(
          buildCompressedMessage(msg, [msg.id], compressed, sourceVersion, verbatim, [msg]),
        );
        messagesCompressed++;
        if (trace) {
          decisions.push({
            messageId: msg.id,
            messageIndex: i,
            action: 'compressed',
            reason: `adapter:${adapter.name}`,
            inputChars: content.length,
            outputChars: compressed.length,
          });
        }
      }
      i++;
      continue;
    }

    // Collect consecutive non-preserved messages with the SAME role
    const groupStartIdx = i;
    const { group, nextIdx } = collectGroup(classified, i);
    i = nextIdx;

    const allContent = group
      .map((g) => (typeof g.msg.content === 'string' ? g.msg.content : ''))
      .join(' ');

    // Relevance threshold: if the best sentence score is below the threshold,
    // replace the entire group with a compact stub instead of a summary.
    const relevanceThreshold = options.relevanceThreshold;
    if (relevanceThreshold != null && relevanceThreshold > 0) {
      const topScore = bestSentenceScore(allContent);
      if (topScore < relevanceThreshold) {
        const stub = `[${group.length} message${group.length > 1 ? 's' : ''} of general discussion omitted]`;
        const sourceMsgs = group.map((g) => g.msg);
        const mergeIds = group.map((g) => g.msg.id);
        const base: Message = { ...sourceMsgs[0] };
        result.push(
          buildCompressedMessage(base, mergeIds, stub, sourceVersion, verbatim, sourceMsgs),
        );
        messagesRelevanceDropped += group.length;
        messagesCompressed += group.length;
        if (trace) {
          for (let gi = 0; gi < group.length; gi++) {
            decisions.push({
              messageId: group[gi].msg.id,
              messageIndex: groupStartIdx + gi,
              action: 'compressed',
              reason: `relevance_dropped:${topScore}`,
              inputChars: contentLength(group[gi].msg),
              outputChars: Math.round(stub.length / group.length),
            });
          }
        }
        continue;
      }
    }

    const entityCount = extractEntities(allContent, 500).length;
    const contentBudget = computeBudget(allContent.length, entityCount);
    const summaryText = isStructuredOutput(allContent)
      ? summarizeStructured(allContent, contentBudget)
      : yield { text: allContent, budget: contentBudget };

    if (group.length > 1) {
      const mergeIds = group.map((g) => g.msg.id);
      const embeddedId = options.embedSummaryId ? makeSummaryId(mergeIds) : undefined;
      let summary = formatSummary(summaryText, allContent, group.length, undefined, embeddedId);
      const combinedLength = group.reduce((sum, g) => sum + contentLength(g.msg), 0);
      if (summary.length >= combinedLength) {
        summary = formatSummary(summaryText, allContent, group.length, true, embeddedId);
      }

      if (summary.length >= combinedLength) {
        for (let gi = 0; gi < group.length; gi++) {
          result.push(group[gi].msg);
          messagesPreserved++;
          if (trace) {
            decisions.push({
              messageId: group[gi].msg.id,
              messageIndex: groupStartIdx + gi,
              action: 'preserved',
              reason: 'merge_reverted',
              inputChars: contentLength(group[gi].msg),
              outputChars: contentLength(group[gi].msg),
            });
          }
        }
      } else {
        const sourceMsgs = group.map((g) => g.msg);
        const base: Message = { ...sourceMsgs[0] };
        result.push(
          buildCompressedMessage(base, mergeIds, summary, sourceVersion, verbatim, sourceMsgs),
        );
        messagesCompressed += group.length;
        if (trace) {
          for (let gi = 0; gi < group.length; gi++) {
            decisions.push({
              messageId: group[gi].msg.id,
              messageIndex: groupStartIdx + gi,
              action: 'compressed',
              reason: group.length > 1 ? 'merged_compressed' : 'compressible_prose',
              inputChars: contentLength(group[gi].msg),
              outputChars: Math.round(summary.length / group.length),
            });
          }
        }
      }
    } else {
      const single = group[0].msg;
      const content = typeof single.content === 'string' ? single.content : '';
      const embeddedId = options.embedSummaryId ? makeSummaryId([single.id]) : undefined;
      let summary = formatSummary(summaryText, allContent, undefined, undefined, embeddedId);
      if (summary.length >= content.length) {
        summary = formatSummary(summaryText, allContent, undefined, true, embeddedId);
      }

      if (summary.length >= content.length) {
        result.push(single);
        messagesPreserved++;
        if (trace) {
          decisions.push({
            messageId: single.id,
            messageIndex: groupStartIdx,
            action: 'preserved',
            reason: 'single_reverted',
            inputChars: content.length,
            outputChars: content.length,
          });
        }
      } else {
        result.push(
          buildCompressedMessage(single, [single.id], summary, sourceVersion, verbatim, [single]),
        );
        messagesCompressed++;
        if (trace) {
          decisions.push({
            messageId: single.id,
            messageIndex: groupStartIdx,
            action: 'compressed',
            reason: classified[groupStartIdx].traceReason ?? 'compressible_prose',
            inputChars: content.length,
            outputChars: summary.length,
          });
        }
      }
    }
  }

  const stats = computeStats(
    messages,
    result,
    messagesCompressed,
    messagesPreserved,
    sourceVersion,
    counter,
    messagesDeduped,
    messagesFuzzyDeduped,
    messagesPatternPreserved,
    llmResults?.size,
    messagesLlmPreserved,
    messagesContradicted,
    messagesImportancePreserved,
    messagesRelevanceDropped,
  );

  if (trace) {
    stats.decisions = decisions;
  }

  // Quality metrics (always computed when compression occurred)
  if (messagesCompressed > 0 || messagesDeduped > 0 || messagesContradicted > 0) {
    const quality = computeQualityScore(messages, result);
    stats.entity_retention = Math.round(quality.entity_retention * 1000) / 1000;
    stats.structural_integrity = Math.round(quality.structural_integrity * 1000) / 1000;
    stats.reference_coherence = Math.round(quality.reference_coherence * 1000) / 1000;
    stats.quality_score = Math.round(quality.quality_score * 1000) / 1000;
  }

  return {
    messages: result,
    compression: stats,
    verbatim,
  };
}

/**
 * Build external score map from entropy scorer for use in summarize().
 * Splits text into sentences, scores them, and combines with heuristic scores.
 */
function buildEntropyScores(
  text: string,
  rawScores: number[],
  mode: 'replace' | 'augment',
): Map<number, number> {
  const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [text.trim()];
  const scoreMap = new Map<number, number>();

  if (mode === 'replace') {
    for (let i = 0; i < Math.min(sentences.length, rawScores.length); i++) {
      scoreMap.set(i, rawScores[i]);
    }
  } else {
    // augment: weighted average of heuristic and entropy
    const heuristicScores = sentences.map((s) => scoreSentence(s.trim()));
    const combined = combineScores(heuristicScores, rawScores.slice(0, sentences.length));
    for (let i = 0; i < combined.length; i++) {
      scoreMap.set(i, combined[i] * 20); // scale to heuristic range
    }
  }

  return scoreMap;
}

function runCompressSync(
  gen: Generator<SummarizeRequest, CompressResult, string>,
  entropyScorer?: (sentences: string[]) => number[] | Promise<number[]>,
  entropyScorerMode: 'replace' | 'augment' = 'augment',
): CompressResult {
  let next = gen.next();
  while (!next.done) {
    const { text, budget } = next.value;
    if (entropyScorer) {
      const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [text.trim()];
      const result = entropyScorer(sentences.map((s) => s.trim()));
      if (result instanceof Promise) {
        throw new Error(
          'compress(): entropyScorer returned a Promise in sync mode. Use a summarizer to enable async.',
        );
      }
      const externalScores = buildEntropyScores(text, result, entropyScorerMode);
      next = gen.next(summarize(text, budget, externalScores));
    } else {
      next = gen.next(summarize(text, budget));
    }
  }
  return next.value;
}

async function runCompressAsync(
  gen: Generator<SummarizeRequest, CompressResult, string>,
  userSummarizer?: Summarizer,
  entropyScorer?: (sentences: string[]) => number[] | Promise<number[]>,
  entropyScorerMode: 'replace' | 'augment' = 'augment',
): Promise<CompressResult> {
  let next = gen.next();
  while (!next.done) {
    const { text, budget } = next.value;
    if (entropyScorer) {
      const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [text.trim()];
      const rawScores = await Promise.resolve(entropyScorer(sentences.map((s) => s.trim())));
      const externalScores = buildEntropyScores(text, rawScores, entropyScorerMode);
      // When entropy scorer is set, use deterministic summarize with external scores
      // unless a user summarizer is also provided
      if (userSummarizer) {
        next = gen.next(await withFallback(text, userSummarizer, budget));
      } else {
        next = gen.next(summarize(text, budget, externalScores));
      }
    } else {
      next = gen.next(await withFallback(text, userSummarizer, budget));
    }
  }
  return next.value;
}

function compressSync(messages: Message[], options: CompressOptions = {}): CompressResult {
  return runCompressSync(
    compressGen(messages, options),
    options.entropyScorer,
    options.entropyScorerMode ?? 'augment',
  );
}

async function compressAsync(
  messages: Message[],
  options: CompressOptions = {},
): Promise<CompressResult> {
  const internalOpts = options as _InternalOptions;
  if (options.classifier && !internalOpts._llmResults) {
    const preserveRoles = new Set(options.preserve ?? ['system']);
    const llmResults = await preClassify(
      messages,
      options.classifier,
      options.classifierMode ?? 'hybrid',
      preserveRoles,
    );
    const opts: _InternalOptions = { ...options, _llmResults: llmResults };
    return runCompressAsync(
      compressGen(messages, opts),
      options.summarizer,
      options.entropyScorer,
      options.entropyScorerMode ?? 'augment',
    );
  }
  return runCompressAsync(
    compressGen(messages, options),
    options.summarizer,
    options.entropyScorer,
    options.entropyScorerMode ?? 'augment',
  );
}

// ---------------------------------------------------------------------------
// Token budget helpers (absorbed from compressToFit)
// ---------------------------------------------------------------------------

function sumTokens(messages: Message[], counter: (msg: Message) => number): number {
  return messages.reduce((sum, m) => sum + counter(m), 0);
}

function budgetFastPath(
  messages: Message[],
  tokenBudget: number,
  sourceVersion: number,
  counter: (msg: Message) => number,
): CompressResult | undefined {
  const totalTokens = sumTokens(messages, counter);
  if (totalTokens <= tokenBudget) {
    return {
      messages,
      compression: {
        original_version: sourceVersion,
        ratio: 1,
        token_ratio: 1,
        messages_compressed: 0,
        messages_preserved: messages.length,
      },
      verbatim: {},
      fits: true,
      tokenCount: totalTokens,
      recencyWindow: messages.length,
    };
  }
  return undefined;
}

function addBudgetFields(
  cr: CompressResult,
  tokenBudget: number,
  recencyWindow: number,
  counter: (msg: Message) => number,
): CompressResult {
  const tokens = sumTokens(cr.messages, counter);
  return { ...cr, fits: tokens <= tokenBudget, tokenCount: tokens, recencyWindow };
}

/**
 * Force-converge pass: hard-truncate non-recency messages to guarantee the
 * result fits within the token budget. Mirrors LCM Level 3 DeterministicTruncate.
 */
function forceConvergePass(
  cr: CompressResult,
  tokenBudget: number,
  preserveRoles: Set<string>,
  sourceVersion: number,
  counter: (msg: Message) => number,
  trace?: boolean,
  importanceScores?: ImportanceMap,
): CompressResult {
  if (cr.fits) return cr;

  const recencyWindow = cr.recencyWindow ?? 0;
  const cutoff = Math.max(0, cr.messages.length - recencyWindow);

  // Collect eligible messages: before recency cutoff, not in preserveRoles, content > 512 chars
  type Candidate = { idx: number; contentLen: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < cutoff; i++) {
    const m = cr.messages[i];
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role && preserveRoles.has(m.role)) continue;
    if (content.length <= 512) continue;
    candidates.push({ idx: i, contentLen: content.length });
  }

  // Sort by importance ascending (low-importance first), then by content length descending
  // This ensures low-value messages get truncated before high-value ones
  if (importanceScores) {
    candidates.sort((a, b) => {
      const impA = importanceScores.get(a.idx) ?? 0;
      const impB = importanceScores.get(b.idx) ?? 0;
      if (Math.abs(impA - impB) > 0.05) return impA - impB; // lower importance first
      return b.contentLen - a.contentLen; // then bigger savings first
    });
  } else {
    candidates.sort((a, b) => b.contentLen - a.contentLen);
  }

  // Clone messages and verbatim for mutation
  const messages = cr.messages.map((m) => ({
    ...m,
    metadata: m.metadata ? { ...m.metadata } : {},
  }));
  const verbatim = { ...cr.verbatim };
  let tokenCount = cr.tokenCount ?? 0;

  for (const cand of candidates) {
    if (tokenCount <= tokenBudget) break;

    const m = messages[cand.idx];
    const content = typeof m.content === 'string' ? m.content : '';
    const truncated = content.slice(0, 512);
    const tag = `[truncated — ${content.length} chars: ${truncated}]`;

    const oldTokens = counter(m);

    // If already compressed (has _cce_original), just replace content in-place
    const hasOriginal = !!m.metadata?._cce_original;
    if (hasOriginal) {
      messages[cand.idx] = { ...m, content: tag };
    } else {
      // Store original in verbatim and add provenance
      verbatim[m.id] = { ...m };
      messages[cand.idx] = {
        ...m,
        content: tag,
        metadata: {
          ...(m.metadata ?? {}),
          _cce_original: {
            ids: [m.id],
            summary_id: makeSummaryId([m.id]),
            version: sourceVersion,
          },
        },
      };
    }

    const newTokens = counter(messages[cand.idx]);
    tokenCount -= oldTokens - newTokens;

    if (trace && cr.compression.decisions) {
      // Find and update the existing decision for this message, or add a new one
      const existing = cr.compression.decisions.find((d) => d.messageId === m.id);
      if (existing) {
        existing.action = 'truncated';
        existing.reason = 'force_converge';
        existing.outputChars = tag.length;
      } else {
        cr.compression.decisions.push({
          messageId: m.id,
          messageIndex: cand.idx,
          action: 'truncated',
          reason: 'force_converge',
          inputChars: content.length,
          outputChars: tag.length,
        });
      }
    }
  }

  const fits = tokenCount <= tokenBudget;
  return { ...cr, messages, verbatim, fits, tokenCount };
}

// ---------------------------------------------------------------------------
// Tiered budget strategy
// ---------------------------------------------------------------------------

/**
 * Tiered budget: keeps recencyWindow fixed and progressively compresses
 * older content by priority tier instead of shrinking the recency window.
 *
 * Priority (protected → sacrificed):
 *   1. System messages — never touched
 *   2. T0 content (code, JSON, etc.) — never touched
 *   3. Recent window messages — protected
 *   4. Older compressed prose — tightened (re-summarize at smaller budget)
 *   5. Low-value older prose — stubbed (relevance drop)
 *   6. Remaining older prose — truncated (force-converge)
 */
function compressTieredSync(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): CompressResult {
  const sourceVersion = options.sourceVersion ?? 0;
  const counter = options.tokenCounter ?? defaultTokenCounter;
  const preserveRoles = new Set(options.preserve ?? ['system']);
  const rw = options.recencyWindow ?? 4;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion, counter);
  if (fast) return fast;

  // Step 1: Run standard compress with the user's recencyWindow
  const cr = compressSync(messages, {
    ...options,
    recencyWindow: rw,
    summarizer: undefined,
    tokenBudget: undefined,
  });
  const result = addBudgetFields(cr, tokenBudget, rw, counter);

  if (result.fits) return result;

  // Step 2: Tighten older messages — re-summarize compressed messages with smaller budgets
  const recencyStart = Math.max(0, result.messages.length - rw);
  const resultMessages = result.messages.map((m) => ({
    ...m,
    metadata: m.metadata ? { ...m.metadata } : {},
  }));
  const resultVerbatim = { ...result.verbatim };
  let tokenCount = result.tokenCount ?? sumTokens(resultMessages, counter);

  // Collect tightenable candidates: older compressed messages (have _cce_original, not system/T0)
  type TightenCandidate = { idx: number; tokens: number; content: string; isCompressed: boolean };
  const candidates: TightenCandidate[] = [];

  for (let i = 0; i < recencyStart; i++) {
    const m = resultMessages[i];
    if (m.role && preserveRoles.has(m.role)) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length <= 80) continue; // Already tiny
    candidates.push({
      idx: i,
      tokens: counter(m),
      content,
      isCompressed: !!m.metadata?._cce_original,
    });
  }

  // Sort: uncompressed first (more room to save), then by token count descending
  candidates.sort((a, b) => {
    if (a.isCompressed !== b.isCompressed) return a.isCompressed ? 1 : -1;
    return b.tokens - a.tokens;
  });

  // Pass 2a: Re-summarize with half budget
  for (const cand of candidates) {
    if (tokenCount <= tokenBudget) break;
    const m = resultMessages[cand.idx];
    const content = typeof m.content === 'string' ? m.content : '';

    // For already-compressed messages, try to tighten the summary
    if (cand.isCompressed && content.startsWith('[summary')) {
      const tighterBudget = Math.max(80, Math.round(content.length * 0.4));
      const tighter = summarize(content, tighterBudget);
      const tighterWrapped = `[summary: ${tighter}]`;
      if (tighterWrapped.length < content.length) {
        const oldTokens = counter(m);
        resultMessages[cand.idx] = { ...m, content: tighterWrapped };
        const newTokens = counter(resultMessages[cand.idx]);
        tokenCount -= oldTokens - newTokens;
      }
    } else if (!cand.isCompressed) {
      // Compress previously uncompressed messages with tight budget
      const tightBudget = Math.max(80, Math.round(content.length * 0.15));
      const summaryText = summarize(content, tightBudget);
      const entities = extractEntities(content);
      const entitySuffix =
        entities.length > 0 ? ` | entities: ${entities.slice(0, 3).join(', ')}` : '';
      const compressed = `[summary: ${summaryText}${entitySuffix}]`;
      if (compressed.length < content.length) {
        const oldTokens = counter(m);
        resultVerbatim[m.id] = { ...m };
        resultMessages[cand.idx] = {
          ...m,
          content: compressed,
          metadata: {
            ...(m.metadata ?? {}),
            _cce_original: {
              ids: [m.id],
              summary_id: makeSummaryId([m.id]),
              version: sourceVersion,
            },
          },
        };
        const newTokens = counter(resultMessages[cand.idx]);
        tokenCount -= oldTokens - newTokens;
      }
    }
  }

  if (tokenCount <= tokenBudget) {
    return {
      ...result,
      messages: resultMessages,
      verbatim: resultVerbatim,
      fits: true,
      tokenCount,
    };
  }

  // Pass 2b: Stub low-value messages (relevance drop)
  for (const cand of candidates) {
    if (tokenCount <= tokenBudget) break;
    const m = resultMessages[cand.idx];
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length <= 80) continue;

    const score = bestSentenceScore(content);
    if (score < 3) {
      const stub = '[message omitted]';
      const oldTokens = counter(m);
      if (!m.metadata?._cce_original) {
        resultVerbatim[m.id] = { ...m };
      }
      resultMessages[cand.idx] = {
        ...m,
        content: stub,
        metadata: {
          ...(m.metadata ?? {}),
          _cce_original: m.metadata?._cce_original ?? {
            ids: [m.id],
            summary_id: makeSummaryId([m.id]),
            version: sourceVersion,
          },
        },
      };
      const newTokens = counter(resultMessages[cand.idx]);
      tokenCount -= oldTokens - newTokens;
    }
  }

  let finalResult: CompressResult = {
    ...result,
    messages: resultMessages,
    verbatim: resultVerbatim,
    fits: tokenCount <= tokenBudget,
    tokenCount,
  };

  // Pass 3: Force-converge as last resort
  if (!finalResult.fits && options.forceConverge) {
    const impScores = options.importanceScoring ? computeImportance(messages) : undefined;
    finalResult = forceConvergePass(
      finalResult,
      tokenBudget,
      preserveRoles,
      sourceVersion,
      counter,
      options.trace,
      impScores,
    );
  }

  return finalResult;
}

async function compressTieredAsync(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): Promise<CompressResult> {
  const sourceVersion = options.sourceVersion ?? 0;
  const counter = options.tokenCounter ?? defaultTokenCounter;
  const preserveRoles = new Set(options.preserve ?? ['system']);
  const rw = options.recencyWindow ?? 4;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion, counter);
  if (fast) return fast;

  // Pre-classify ONCE
  let innerOpts: _InternalOptions = options;
  if (options.classifier && !(options as _InternalOptions)._llmResults) {
    const llmResults = await preClassify(
      messages,
      options.classifier,
      options.classifierMode ?? 'hybrid',
      preserveRoles,
    );
    innerOpts = { ...options, classifier: undefined, _llmResults: llmResults };
  }

  const cr = await compressAsync(messages, {
    ...innerOpts,
    recencyWindow: rw,
    tokenBudget: undefined,
  });
  const result = addBudgetFields(cr, tokenBudget, rw, counter);

  if (result.fits) return result;

  // Reuse sync tightening passes (summarize is deterministic for tightening)
  const recencyStart = Math.max(0, result.messages.length - rw);
  const resultMessages = result.messages.map((m) => ({
    ...m,
    metadata: m.metadata ? { ...m.metadata } : {},
  }));
  const resultVerbatim = { ...result.verbatim };
  let tokenCount = result.tokenCount ?? sumTokens(resultMessages, counter);

  type TightenCandidate = { idx: number; tokens: number; content: string; isCompressed: boolean };
  const candidates: TightenCandidate[] = [];

  for (let i = 0; i < recencyStart; i++) {
    const m = resultMessages[i];
    if (m.role && preserveRoles.has(m.role)) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length <= 80) continue;
    candidates.push({
      idx: i,
      tokens: counter(m),
      content,
      isCompressed: !!m.metadata?._cce_original,
    });
  }

  candidates.sort((a, b) => {
    if (a.isCompressed !== b.isCompressed) return a.isCompressed ? 1 : -1;
    return b.tokens - a.tokens;
  });

  // Pass 2a: Tighten summaries
  for (const cand of candidates) {
    if (tokenCount <= tokenBudget) break;
    const m = resultMessages[cand.idx];
    const content = typeof m.content === 'string' ? m.content : '';

    if (cand.isCompressed && content.startsWith('[summary')) {
      const tighterBudget = Math.max(80, Math.round(content.length * 0.4));
      const tighter = options.summarizer
        ? await withFallback(content, options.summarizer, tighterBudget)
        : summarize(content, tighterBudget);
      const tighterWrapped = `[summary: ${tighter}]`;
      if (tighterWrapped.length < content.length) {
        const oldTokens = counter(m);
        resultMessages[cand.idx] = { ...m, content: tighterWrapped };
        tokenCount -= oldTokens - counter(resultMessages[cand.idx]);
      }
    } else if (!cand.isCompressed) {
      const tightBudget = Math.max(80, Math.round(content.length * 0.15));
      const summaryText = options.summarizer
        ? await withFallback(content, options.summarizer, tightBudget)
        : summarize(content, tightBudget);
      const entities = extractEntities(content);
      const entitySuffix =
        entities.length > 0 ? ` | entities: ${entities.slice(0, 3).join(', ')}` : '';
      const compressed = `[summary: ${summaryText}${entitySuffix}]`;
      if (compressed.length < content.length) {
        const oldTokens = counter(m);
        resultVerbatim[m.id] = { ...m };
        resultMessages[cand.idx] = {
          ...m,
          content: compressed,
          metadata: {
            ...(m.metadata ?? {}),
            _cce_original: {
              ids: [m.id],
              summary_id: makeSummaryId([m.id]),
              version: sourceVersion,
            },
          },
        };
        tokenCount -= oldTokens - counter(resultMessages[cand.idx]);
      }
    }
  }

  if (tokenCount <= tokenBudget) {
    return {
      ...result,
      messages: resultMessages,
      verbatim: resultVerbatim,
      fits: true,
      tokenCount,
    };
  }

  // Pass 2b: Stub low-value messages
  for (const cand of candidates) {
    if (tokenCount <= tokenBudget) break;
    const m = resultMessages[cand.idx];
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length <= 80) continue;
    const score = bestSentenceScore(content);
    if (score < 3) {
      const stub = '[message omitted]';
      const oldTokens = counter(m);
      if (!m.metadata?._cce_original) resultVerbatim[m.id] = { ...m };
      resultMessages[cand.idx] = {
        ...m,
        content: stub,
        metadata: {
          ...(m.metadata ?? {}),
          _cce_original: m.metadata?._cce_original ?? {
            ids: [m.id],
            summary_id: makeSummaryId([m.id]),
            version: sourceVersion,
          },
        },
      };
      tokenCount -= oldTokens - counter(resultMessages[cand.idx]);
    }
  }

  let finalResult: CompressResult = {
    ...result,
    messages: resultMessages,
    verbatim: resultVerbatim,
    fits: tokenCount <= tokenBudget,
    tokenCount,
  };

  if (!finalResult.fits && options.forceConverge) {
    const impScores = options.importanceScoring ? computeImportance(messages) : undefined;
    finalResult = forceConvergePass(
      finalResult,
      tokenBudget,
      preserveRoles,
      sourceVersion,
      counter,
      options.trace,
      impScores,
    );
  }

  return finalResult;
}

function compressSyncWithBudget(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): CompressResult {
  const minRw = options.minRecencyWindow ?? 0;
  const sourceVersion = options.sourceVersion ?? 0;
  const counter = options.tokenCounter ?? defaultTokenCounter;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion, counter);
  if (fast) return fast;

  let lo = minRw;
  let hi = messages.length - 1;
  let lastResult: CompressResult | undefined;
  let lastRw = -1;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cr = compressSync(messages, {
      ...options,
      recencyWindow: mid,
      summarizer: undefined,
      tokenBudget: undefined,
    });
    lastResult = addBudgetFields(cr, tokenBudget, mid, counter);
    lastRw = mid;

    if (lastResult.fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  let result: CompressResult;
  if (lastRw === lo && lastResult) {
    result = lastResult;
  } else {
    const cr = compressSync(messages, {
      ...options,
      recencyWindow: lo,
      summarizer: undefined,
      tokenBudget: undefined,
    });
    result = addBudgetFields(cr, tokenBudget, lo, counter);
  }

  if (!result.fits && options.forceConverge) {
    const preserveRoles = new Set(options.preserve ?? ['system']);
    const impScores = options.importanceScoring ? computeImportance(messages) : undefined;
    result = forceConvergePass(
      result,
      tokenBudget,
      preserveRoles,
      sourceVersion,
      counter,
      options.trace,
      impScores,
    );
  }

  return result;
}

async function compressAsyncWithBudget(
  messages: Message[],
  tokenBudget: number,
  options: CompressOptions,
): Promise<CompressResult> {
  const minRw = options.minRecencyWindow ?? 0;
  const sourceVersion = options.sourceVersion ?? 0;
  const counter = options.tokenCounter ?? defaultTokenCounter;

  const fast = budgetFastPath(messages, tokenBudget, sourceVersion, counter);
  if (fast) return fast;

  // Pre-classify ONCE before binary search — prevents re-classification per iteration
  let innerOpts: _InternalOptions = options;
  if (options.classifier && !(options as _InternalOptions)._llmResults) {
    const preserveRoles = new Set(options.preserve ?? ['system']);
    const llmResults = await preClassify(
      messages,
      options.classifier,
      options.classifierMode ?? 'hybrid',
      preserveRoles,
    );
    innerOpts = { ...options, classifier: undefined, _llmResults: llmResults };
  }

  let lo = minRw;
  let hi = messages.length - 1;
  let lastResult: CompressResult | undefined;
  let lastRw = -1;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cr = await compressAsync(messages, {
      ...innerOpts,
      recencyWindow: mid,
      tokenBudget: undefined,
    });
    lastResult = addBudgetFields(cr, tokenBudget, mid, counter);
    lastRw = mid;

    if (lastResult.fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  let result: CompressResult;
  if (lastRw === lo && lastResult) {
    result = lastResult;
  } else {
    const cr = await compressAsync(messages, {
      ...innerOpts,
      recencyWindow: lo,
      tokenBudget: undefined,
    });
    result = addBudgetFields(cr, tokenBudget, lo, counter);
  }

  if (!result.fits && options.forceConverge) {
    const preserveRoles = new Set(options.preserve ?? ['system']);
    const impScores = options.importanceScoring ? computeImportance(messages) : undefined;
    result = forceConvergePass(
      result,
      tokenBudget,
      preserveRoles,
      sourceVersion,
      counter,
      options.trace,
      impScores,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API: compress() with overloads
// ---------------------------------------------------------------------------

/**
 * Compress a message array. Sync by default; async when a `summarizer` or `classifier` is provided.
 *
 * The caller MUST persist `messages` and `verbatim` atomically.
 * Partial writes (e.g. storing compressed messages without their
 * verbatim originals) will cause data loss that `uncompress()`
 * surfaces via `missing_ids`.
 */
export function compress(messages: Message[], options?: CompressOptions): CompressResult;
export function compress(
  messages: Message[],
  options: CompressOptions & { summarizer: Summarizer },
): Promise<CompressResult>;
export function compress(
  messages: Message[],
  options: CompressOptions & { classifier: Classifier },
): Promise<CompressResult>;
export function compress(
  messages: Message[],
  options: CompressOptions = {},
): CompressResult | Promise<CompressResult> {
  if (!Array.isArray(messages)) {
    throw new TypeError('compress(): messages must be an array');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m == null || typeof m !== 'object') {
      throw new TypeError(`compress(): messages[${i}] must be an object`);
    }
    if (m.id == null) {
      throw new TypeError(`compress(): messages[${i}] is missing required field "id"`);
    }
  }

  if (options.compressionThreshold != null) {
    const counter = options.tokenCounter ?? defaultTokenCounter;
    const total = sumTokens(messages, counter);
    if (total < options.compressionThreshold) {
      const fast: CompressResult = {
        messages,
        compression: {
          original_version: options.sourceVersion ?? 0,
          ratio: 1,
          token_ratio: 1,
          messages_compressed: 0,
          messages_preserved: messages.length,
        },
        verbatim: {},
      };
      return options.summarizer || options.classifier ? Promise.resolve(fast) : fast;
    }
  }

  const hasSummarizer = !!options.summarizer;
  const hasClassifier = !!options.classifier;
  const hasBudget = options.tokenBudget != null;

  const isTiered = options.budgetStrategy === 'tiered';

  if (hasSummarizer || hasClassifier) {
    // Async paths
    if (hasBudget) {
      return isTiered
        ? compressTieredAsync(messages, options.tokenBudget!, options)
        : compressAsyncWithBudget(messages, options.tokenBudget!, options);
    }
    return compressAsync(messages, options);
  }

  // Sync paths
  if (hasBudget) {
    return isTiered
      ? compressTieredSync(messages, options.tokenBudget!, options)
      : compressSyncWithBudget(messages, options.tokenBudget!, options);
  }
  return compressSync(messages, options);
}
