/**
 * Entropy-based sentence scoring utilities.
 *
 * Provides integration with external self-information scorers (e.g., small
 * causal LMs) for information-theoretic sentence importance scoring.
 * Based on concepts from Selective Context (EMNLP 2023).
 */

/**
 * Split text into sentences for scoring.
 * Returns the sentences and their original indices for reassembly.
 */
export function splitSentences(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]+/g);
  if (!sentences || sentences.length === 0) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Normalize entropy scores to 0–1 range using min-max scaling.
 * Handles edge cases (all same value, empty array).
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 0.5); // all equal → middle
  return scores.map((s) => (s - min) / (max - min));
}

/**
 * Combine heuristic and entropy scores using weighted average.
 * Both score arrays must have the same length.
 *
 * @param heuristicScores - scores from the rule-based scorer
 * @param entropyScores - scores from the entropy scorer (already normalized 0–1)
 * @param entropyWeight - weight for entropy scores (0–1, default 0.6)
 */
export function combineScores(
  heuristicScores: number[],
  entropyScores: number[],
  entropyWeight = 0.6,
): number[] {
  if (heuristicScores.length !== entropyScores.length) {
    throw new Error('Score arrays must have the same length');
  }

  // Normalize heuristic scores to 0–1
  const normHeuristic = normalizeScores(heuristicScores);
  const normEntropy = normalizeScores(entropyScores);
  const heuristicWeight = 1 - entropyWeight;

  return normHeuristic.map((h, i) => h * heuristicWeight + normEntropy[i] * entropyWeight);
}
