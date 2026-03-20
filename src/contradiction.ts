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

// ── Topic overlap (word-level Jaccard, fast) ──────────────────────

function extractTopicWords(content: string): Set<string> {
  const words = new Set<string>();
  // Extract meaningful words (3+ chars, not common stopwords)
  const matches = content.toLowerCase().match(/\b[a-z]{3,}\b/g);
  if (matches) {
    for (const w of matches) {
      if (!STOP_WORDS.has(w)) words.add(w);
    }
  }
  return words;
}

function wordJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
 * @param topicThreshold - Minimum word-level Jaccard for topic overlap. Default: 0.15.
 * @param preserveRoles - Roles to skip (e.g. 'system').
 */
export function analyzeContradictions(
  messages: Message[],
  topicThreshold = 0.15,
  preserveRoles?: Set<string>,
): Map<number, ContradictionAnnotation> {
  const annotations = new Map<number, ContradictionAnnotation>();

  // Extract topic words per message
  const topics: Array<{ index: number; words: Set<string>; content: string }> = [];
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

    topics.push({ index: i, words: extractTopicWords(content), content });
  }

  // For each message with a correction signal, find the most-overlapping earlier message
  for (let ti = 1; ti < topics.length; ti++) {
    const later = topics[ti];
    const signal = detectCorrectionSignal(later.content);
    if (!signal) continue;

    let bestOverlap = 0;
    let bestEarlierIdx = -1;

    for (let ei = ti - 1; ei >= 0; ei--) {
      const earlier = topics[ei];
      // Same role check — corrections usually come from the same speaker
      if (
        messages[earlier.index].role &&
        messages[later.index].role &&
        messages[earlier.index].role !== messages[later.index].role
      ) {
        // Cross-role corrections are also valid (user correcting assistant)
        // but we require higher topic overlap
        const overlap = wordJaccard(earlier.words, later.words);
        if (overlap >= topicThreshold * 1.5 && overlap > bestOverlap) {
          bestOverlap = overlap;
          bestEarlierIdx = earlier.index;
        }
      } else {
        const overlap = wordJaccard(earlier.words, later.words);
        if (overlap >= topicThreshold && overlap > bestOverlap) {
          bestOverlap = overlap;
          bestEarlierIdx = earlier.index;
        }
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

// ── Stopwords (small set, just enough to avoid noise) ─────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'his',
  'how',
  'its',
  'let',
  'may',
  'new',
  'now',
  'old',
  'see',
  'way',
  'who',
  'did',
  'get',
  'got',
  'him',
  'she',
  'too',
  'use',
  'that',
  'this',
  'with',
  'have',
  'from',
  'they',
  'been',
  'said',
  'each',
  'make',
  'like',
  'just',
  'over',
  'such',
  'take',
  'than',
  'them',
  'very',
  'some',
  'could',
  'would',
  'about',
  'there',
  'these',
  'other',
  'into',
  'more',
  'also',
  'what',
  'when',
  'will',
  'which',
  'their',
  'then',
  'here',
  'were',
  'being',
  'does',
  'doing',
  'done',
  'should',
]);
