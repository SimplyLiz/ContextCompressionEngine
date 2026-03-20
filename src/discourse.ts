/**
 * EDU-Lite: Elementary Discourse Unit decomposition.
 *
 * Breaks text into minimal coherent information chunks and builds
 * a lightweight dependency graph. When summarizing, selecting an EDU
 * also pulls in its dependency parents to maintain coherence.
 *
 * Based on concepts from "From Context to EDUs" (arXiv Dec 2025).
 * This is a rule-based approximation — no ML parser needed.
 */

/** A minimal coherent information unit. */
export type EDU = {
  /** The text content. */
  text: string;
  /** Index within the parent text's EDU array. */
  index: number;
  /** Indices of EDUs this one depends on (parents). */
  dependsOn: number[];
  /** Importance score (reusable from external scorer). */
  score: number;
};

// Discourse markers that signal clause boundaries
const CLAUSE_BOUNDARY_RE =
  /(?:,\s*(?:and |but |or |so |yet |then |which |where |while |although |because |since |after |before |when |if |unless |as ))|(?:\s+(?:however|therefore|consequently|furthermore|moreover|additionally|meanwhile|nevertheless|nonetheless|instead|otherwise|thus|hence|accordingly)\s*[,.]?)/i;

// Temporal chain markers
const TEMPORAL_RE = /\b(?:first|then|next|after that|finally|subsequently|later|eventually)\b/i;

// Causal markers
const CAUSAL_RE = /\b(?:because|since|therefore|thus|hence|so that|in order to|as a result)\b/i;

// Pronoun/demonstrative references (depend on preceding EDU)
const REFERENCE_RE =
  /^(?:it|this|that|these|those|the result|the output|the response|the value)\b/i;

/**
 * Segment text into Elementary Discourse Units.
 * Uses clause boundary detection with discourse markers.
 */
export function segmentEDUs(text: string): EDU[] {
  // First split into sentences
  const sentences = text.match(/[^.!?\n]+[.!?]+/g) ?? [text.trim()];
  const edus: EDU[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    // Try to split at clause boundaries
    const clauses = splitClauses(trimmed);
    for (const clause of clauses) {
      if (clause.trim().length > 5) {
        edus.push({
          text: clause.trim(),
          index: edus.length,
          dependsOn: [],
          score: 0,
        });
      }
    }
  }

  // Build dependency edges
  for (let i = 1; i < edus.length; i++) {
    const text = edus[i].text;

    // Pronoun/demonstrative → depends on immediately preceding EDU
    if (REFERENCE_RE.test(text)) {
      edus[i].dependsOn.push(i - 1);
    }

    // Temporal chain → depends on preceding EDU in sequence
    if (TEMPORAL_RE.test(text) && i > 0) {
      if (!edus[i].dependsOn.includes(i - 1)) {
        edus[i].dependsOn.push(i - 1);
      }
    }

    // Causal → the cause (preceding) is a dependency
    if (CAUSAL_RE.test(text) && i > 0) {
      if (!edus[i].dependsOn.includes(i - 1)) {
        edus[i].dependsOn.push(i - 1);
      }
    }
  }

  return edus;
}

/**
 * Split a sentence into clauses at discourse marker boundaries.
 */
function splitClauses(sentence: string): string[] {
  const parts: string[] = [];
  const remaining = sentence;

  let match: RegExpExecArray | null;
  const re = new RegExp(CLAUSE_BOUNDARY_RE.source, 'gi');

  let lastIdx = 0;
  while ((match = re.exec(remaining)) !== null) {
    const before = remaining.slice(lastIdx, match.index);
    if (before.trim().length > 10) {
      parts.push(before);
    }
    lastIdx = match.index;
  }

  const tail = remaining.slice(lastIdx);
  if (tail.trim().length > 0) {
    parts.push(tail);
  }

  return parts.length > 0 ? parts : [sentence];
}

/**
 * Score EDUs using an external scorer function.
 * Default scorer rewards information density: technical identifiers,
 * numbers with units, emphasis phrases — same signals as the main scorer.
 */
export function scoreEDUs(edus: EDU[], scorer?: (text: string) => number): EDU[] {
  return edus.map((edu) => ({
    ...edu,
    score: scorer ? scorer(edu.text) : defaultEduScore(edu.text),
  }));
}

function defaultEduScore(text: string): number {
  let score = 0;
  // Technical identifiers
  score += (text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3; // camelCase
  score += (text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []).length * 3; // PascalCase
  score += (text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).length * 3; // snake_case
  // Numbers with units
  score += (text.match(/\b\d+(?:\.\d+)?\s*(?:seconds?|ms|MB|GB|retries?|%)\b/gi) ?? []).length * 2;
  // Emphasis
  if (/\b(?:important|critical|must|never|always|require)\b/i.test(text)) score += 4;
  // Penalize filler starts
  if (/^(?:well|sure|ok|thanks|great|right|yes)\b/i.test(text.trim())) score -= 5;
  // Baseline: modest length bonus (prefer substance over brevity, but not bloat)
  score += Math.min(text.length / 50, 2);
  return score;
}

/**
 * Select EDUs for a summary budget, respecting dependency edges.
 * When an EDU is selected, its dependency parents are also included
 * (up to maxDepth levels).
 *
 * @param edus - scored EDU array
 * @param budget - character budget for the summary
 * @param maxDepth - maximum dependency depth to follow (default: 2)
 */
export function selectEDUs(edus: EDU[], budget: number, maxDepth = 2): EDU[] {
  if (edus.length === 0) return [];

  // Sort by score descending for greedy selection
  const sorted = [...edus].sort((a, b) => b.score - a.score);
  const selected = new Set<number>();
  let usedChars = 0;

  for (const edu of sorted) {
    if (usedChars >= budget) break;

    // Collect this EDU and its dependencies
    const toAdd = new Set<number>();
    collectDeps(edu.index, edus, toAdd, maxDepth, 0);
    toAdd.add(edu.index);

    // Check if adding all of them fits
    let addedChars = 0;
    for (const idx of toAdd) {
      if (!selected.has(idx)) {
        addedChars += edus[idx].text.length + 2; // +2 for separator
      }
    }

    if (usedChars + addedChars <= budget) {
      for (const idx of toAdd) {
        if (!selected.has(idx)) {
          selected.add(idx);
          usedChars += edus[idx].text.length + 2;
        }
      }
    }
  }

  // Return in original order
  return edus.filter((edu) => selected.has(edu.index));
}

function collectDeps(
  idx: number,
  edus: EDU[],
  result: Set<number>,
  maxDepth: number,
  currentDepth: number,
): void {
  if (currentDepth >= maxDepth) return;
  for (const dep of edus[idx].dependsOn) {
    if (!result.has(dep)) {
      result.add(dep);
      collectDeps(dep, edus, result, maxDepth, currentDepth + 1);
    }
  }
}

/**
 * Produce a discourse-aware summary by selecting and joining EDUs.
 */
export function summarizeWithEDUs(
  text: string,
  budget: number,
  scorer?: (text: string) => number,
): string {
  const edus = scoreEDUs(segmentEDUs(text), scorer);
  const selected = selectEDUs(edus, budget);

  if (selected.length === 0) {
    return text.slice(0, budget).trim();
  }

  return selected.map((e) => e.text).join(' ');
}
