/**
 * Message importance scoring — ANCS-inspired per-message importance
 * beyond positional recency.
 *
 * Factors:
 * 1. Forward-reference density: how many later messages reference this message's entities
 * 2. Decision/directive content: messages with requirements, constraints, corrections
 * 3. Correction recency: messages that override earlier content get boosted
 *
 * Used by compress() when `importanceScoring: true` to:
 * - Preserve high-importance messages outside the recency window
 * - Order forceConverge truncation (low-importance first)
 */

import type { Message } from './types.js';

// ── Entity extraction (lightweight, no external deps) ─────────────

const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z]+)+\b/g;
const PASCAL_RE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const SNAKE_RE = /\b[a-z]+(?:_[a-z]+)+\b/g;
const VOWELLESS_RE = /\b[bcdfghjklmnpqrstvwxz]{3,}\b/gi;
const FILE_REF_RE = /\S+\.\w+:\d+/g;

function extractMessageEntities(content: string): Set<string> {
  const entities = new Set<string>();
  for (const re of [CAMEL_RE, PASCAL_RE, SNAKE_RE, VOWELLESS_RE, FILE_REF_RE]) {
    const matches = content.match(re);
    if (matches) {
      for (const m of matches) entities.add(m.toLowerCase());
    }
  }
  return entities;
}

// ── Decision / directive detection ────────────────────────────────

const DECISION_RE =
  /\b(?:must|should|require[ds]?|always|never|do not|don't|instead|use\s+\w+\s+(?:instead|rather)|the\s+(?:approach|solution|fix|answer)\s+is|decided? to|we(?:'ll| will)\s+(?:go with|use|implement))\b/i;

const CORRECTION_RE =
  /\b(?:actually|correction|no[,.]?\s+(?:use|it's|that's|the)|wait[,.]|sorry[,.]|instead[,.]|not\s+\w+[,.]?\s+(?:but|use|it's)|scratch that|disregard|ignore (?:that|my|the previous))\b/i;

const CONSTRAINT_RE =
  /\b(?:constraint|limitation|boundary|deadline|blocker|requirement|prerequisite|dependency|breaking change|backwards? compat)\b/i;

/** Content-based importance signals (0–1 range contributions). */
export function scoreContentSignals(content: string): number {
  let score = 0;
  if (DECISION_RE.test(content)) score += 0.15;
  if (CORRECTION_RE.test(content)) score += 0.25; // corrections are high-value
  if (CONSTRAINT_RE.test(content)) score += 0.1;
  return Math.min(score, 0.4); // cap content signal contribution
}

// ── Forward-reference graph ───────────────────────────────────────

export type ImportanceMap = Map<number, number>;

/**
 * Compute per-message importance scores for a message array.
 *
 * Algorithm:
 * 1. Extract entities from each message
 * 2. Build forward-reference counts: for each message, count how many
 *    later messages share at least one entity
 * 3. Normalize reference counts to 0–1, combine with content signals
 *
 * Returns a Map<messageIndex, importanceScore (0–1)>.
 */
export function computeImportance(messages: Message[]): ImportanceMap {
  const scores = new Map<number, number>();
  if (messages.length === 0) return scores;

  // Extract entities per message
  const entitySets: Array<Set<string>> = [];
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    entitySets.push(extractMessageEntities(content));
  }

  // Count forward references: how many later messages share entities with this one
  const refCounts = new Array<number>(messages.length).fill(0);
  let maxRefs = 0;

  for (let i = 0; i < messages.length; i++) {
    const myEntities = entitySets[i];
    if (myEntities.size === 0) continue;

    for (let j = i + 1; j < messages.length; j++) {
      const theirEntities = entitySets[j];
      let shared = false;
      for (const e of myEntities) {
        if (theirEntities.has(e)) {
          shared = true;
          break;
        }
      }
      if (shared) {
        refCounts[i]++;
      }
    }
    if (refCounts[i] > maxRefs) maxRefs = refCounts[i];
  }

  // Compute combined score per message
  for (let i = 0; i < messages.length; i++) {
    const content = typeof messages[i].content === 'string' ? (messages[i].content as string) : '';

    // Reference score: normalized 0–0.5
    const refScore = maxRefs > 0 ? (refCounts[i] / maxRefs) * 0.5 : 0;

    // Content signal score: 0–0.4
    const contentScore = scoreContentSignals(content);

    // Recency bonus: slight boost for more recent messages (0–0.1)
    const recencyScore = (i / Math.max(messages.length - 1, 1)) * 0.1;

    scores.set(i, Math.min(1, refScore + contentScore + recencyScore));
  }

  return scores;
}

/**
 * Default importance threshold for preservation.
 * Messages scoring above this are preserved even outside the recency window.
 */
export const DEFAULT_IMPORTANCE_THRESHOLD = 0.65;
