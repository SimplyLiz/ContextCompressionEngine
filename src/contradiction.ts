/**
 * Contradiction detection — identifies messages that correct or override
 * earlier messages on the same topic.
 *
 * When two messages have high topic overlap but opposing directives,
 * the earlier one is marked for compression while the later one
 * (the correction) is preserved.
 *
 * Inspired by ANCS conflict detection (pairwise scanning with topic-overlap gating).
 */

import type { Message } from './types.js';

export type ContradictionAnnotation = {
  /** Index of the later message that supersedes this one. */
  supersededByIndex: number;
  /** Topic overlap score (0–1). */
  topicOverlap: number;
  /** Which correction signal was detected. */
  signal: string;
};

// ── Topic overlap (IDF-weighted Sørensen-Dice) ──────────────────

/** Extract topic words from content: plain words (3+ chars) plus technical identifiers. */
function extractRawWords(content: string): Set<string> {
  const words = new Set<string>();
  // Plain lowercase words (3+ chars)
  const plain = content.toLowerCase().match(/\b[a-z]{3,}\b/g);
  if (plain) {
    for (const w of plain) words.add(w);
  }
  // camelCase, PascalCase, snake_case — lowercased for uniform matching
  const identifiers = content.match(
    /\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g,
  );
  if (identifiers) {
    for (const id of identifiers) words.add(id.toLowerCase());
  }
  return words;
}

/**
 * Compute IDF weights for all words across a set of documents.
 * Uses smoothed IDF: `log(1 + N/df)`.
 *
 * Language-agnostic: common words get low weight regardless of language.
 * No hardcoded stopword list needed.
 *
 * Returns null when there are fewer than 3 documents — IDF needs enough
 * documents to distinguish common from rare words.
 */
function computeIdfWeights(documents: Set<string>[]): Map<string, number> | null {
  const n = documents.length;
  if (n < 3) return null;

  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const word of doc) {
      df.set(word, (df.get(word) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [word, count] of df) {
    // Smoothed IDF: log(1 + N/df). Gentler than BM25's `log((N-df+0.5)/(df+0.5))`
    // which is too aggressive for small document sets (zeroes out words at N/2).
    // A word in all N docs gets log(2) ≈ 0.69; a word in 1 doc gets log(1+N).
    idf.set(word, Math.log(1 + n / count));
  }
  return idf;
}

/**
 * IDF-weighted Sørensen-Dice similarity.
 *
 * Dice = 2 * weightedIntersection / (weightedA + weightedB)
 *
 * Compared to unweighted Jaccard:
 * - Dice weights shared terms more heavily (2x numerator), better for short docs
 * - IDF weighting means rare/topical words dominate, common words contribute ~0
 *
 * When IDF is null (too few documents for reliable DF), falls back to
 * unweighted Dice (all words weight 1).
 */
function weightedDice(a: Set<string>, b: Set<string>, idf: Map<string, number> | null): number {
  if (a.size === 0 && b.size === 0) return 0;

  // Unweighted Dice when IDF is unavailable
  if (!idf) {
    let intersection = 0;
    for (const w of a) {
      if (b.has(w)) intersection++;
    }
    const denom = a.size + b.size;
    return denom === 0 ? 0 : (2 * intersection) / denom;
  }

  let weightedIntersection = 0;
  let weightedA = 0;
  let weightedB = 0;

  for (const w of a) {
    const weight = idf.get(w) ?? 0;
    weightedA += weight;
    if (b.has(w)) weightedIntersection += weight;
  }
  for (const w of b) {
    weightedB += idf.get(w) ?? 0;
  }

  const denom = weightedA + weightedB;
  return denom === 0 ? 0 : (2 * weightedIntersection) / denom;
}

// ── Correction signal detection ───────────────────────────────────

/** Patterns that indicate a message is correcting/overriding earlier content. */
const CORRECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(?:actually|correction)[,.:]/i, label: 'explicit_correction' },
  { re: /\bno[,.]?\s+(?:use|it's|that's|it should|we should)/i, label: 'negation_directive' },
  { re: /\b(?:instead|rather)[,.]?\s+(?:use|do|we|you)/i, label: 'instead_directive' },
  { re: /\b(?:scratch that|disregard|ignore)\b/i, label: 'retraction' },
  { re: /\bdon'?t\s+(?:use|do|add|include|import)\b/i, label: 'dont_directive' },
  { re: /\bnot\s+\w+[,.]?\s+(?:but|use|go with)\b/i, label: 'not_but_pattern' },
  { re: /\bwait[,.]\s/i, label: 'wait_correction' },
  { re: /\bsorry[,.]\s+(?:I|that|the)/i, label: 'sorry_correction' },
  { re: /\bI was wrong\b/i, label: 'self_correction' },
  { re: /\blet me (?:correct|rephrase|clarify)\b/i, label: 'rephrase' },
];

function detectCorrectionSignal(content: string): string | null {
  for (const { re, label } of CORRECTION_PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}

// ── Main API ──────────────────────────────────────────────────────

/**
 * Scan messages for contradictions: later messages that correct earlier ones.
 *
 * Returns a map of message indices to contradiction annotations.
 * Only the *earlier* (superseded) message gets annotated — the later
 * message (the correction) is left untouched for preservation.
 *
 * @param messages - The message array to scan.
 * @param topicThreshold - Minimum IDF-weighted Dice similarity for topic overlap. Default: 0.15.
 * @param preserveRoles - Roles to skip (e.g. 'system').
 */
export function analyzeContradictions(
  messages: Message[],
  topicThreshold = 0.15,
  preserveRoles?: Set<string>,
): Map<number, ContradictionAnnotation> {
  const annotations = new Map<number, ContradictionAnnotation>();

  // Pass 1: extract raw words per eligible message
  const eligible: Array<{ index: number; words: Set<string>; content: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (preserveRoles && msg.role && preserveRoles.has(msg.role)) continue;
    if (content.length < 50) continue; // skip very short messages
    if (
      content.startsWith('[summary:') ||
      content.startsWith('[summary#') ||
      content.startsWith('[truncated')
    )
      continue;

    eligible.push({ index: i, words: extractRawWords(content), content });
  }

  // Pass 2: compute IDF weights (language-agnostic — common words get low weight)
  const idf = computeIdfWeights(eligible.map((e) => e.words));

  // Use eligible directly as topics (IDF handles weighting, no filtering needed)
  const topics = eligible;

  // For each message with a correction signal, find the most-overlapping earlier message
  for (let ti = 1; ti < topics.length; ti++) {
    const later = topics[ti];
    const signal = detectCorrectionSignal(later.content);
    if (!signal) continue;

    let bestOverlap = 0;
    let bestEarlierIdx = -1;

    for (let ei = ti - 1; ei >= 0; ei--) {
      const earlier = topics[ei];
      const overlap = weightedDice(earlier.words, later.words, idf);

      // Cross-role corrections (user correcting assistant) require higher overlap
      const crossRole =
        messages[earlier.index].role &&
        messages[later.index].role &&
        messages[earlier.index].role !== messages[later.index].role;
      const effectiveThreshold = crossRole ? topicThreshold * 1.5 : topicThreshold;

      if (overlap >= effectiveThreshold && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestEarlierIdx = earlier.index;
      }
    }

    if (bestEarlierIdx >= 0 && !annotations.has(bestEarlierIdx)) {
      annotations.set(bestEarlierIdx, {
        supersededByIndex: later.index,
        topicOverlap: bestOverlap,
        signal,
      });
    }
  }

  return annotations;
}
