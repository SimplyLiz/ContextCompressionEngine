/**
 * ML token-level classifier integration.
 *
 * Wraps an external ML token classifier (LLMLingua-2 style) to produce
 * compressed text by keeping only tokens classified as important.
 * The actual model is user-provided — this module handles reconstruction.
 *
 * Based on LLMLingua-2 (ACL 2024): token classification via small encoder.
 */

import type { MLTokenClassifier, TokenClassification } from './types.js';

/**
 * Compress text using token-level classification.
 * Keeps tokens marked as `keep: true` and reconstructs them into readable text.
 *
 * @param content - the text to compress
 * @param classifier - the ML token classifier function
 * @param minConfidence - minimum confidence to respect the classifier's decision (default: 0.5)
 */
export async function compressWithTokenClassifier(
  content: string,
  classifier: MLTokenClassifier,
  minConfidence = 0.5,
): Promise<string> {
  const classifications = await Promise.resolve(classifier(content));
  return reconstructFromClassifications(classifications, minConfidence);
}

/**
 * Synchronous version — only works with sync classifiers.
 */
export function compressWithTokenClassifierSync(
  content: string,
  classifier: MLTokenClassifier,
  minConfidence = 0.5,
): string {
  const result = classifier(content);
  if (result instanceof Promise) {
    throw new Error(
      'mlTokenClassifier returned a Promise in sync mode. Provide a summarizer or classifier to enable async.',
    );
  }
  return reconstructFromClassifications(result, minConfidence);
}

/**
 * Reconstruct readable text from token classifications.
 * Handles whitespace normalization and punctuation attachment.
 */
function reconstructFromClassifications(
  classifications: TokenClassification[],
  minConfidence: number,
): string {
  const kept: string[] = [];

  for (const tc of classifications) {
    // Keep token if classified as keep with sufficient confidence,
    // OR if confidence is too low (uncertain → keep to be safe)
    if (tc.keep && tc.confidence >= minConfidence) {
      kept.push(tc.token);
    } else if (!tc.keep && tc.confidence < minConfidence) {
      // Low confidence removal → keep to be safe
      kept.push(tc.token);
    }
  }

  // Reconstruct: join tokens, normalize whitespace
  let text = kept.join(' ');

  // Fix punctuation spacing: remove space before . , ; : ! ? ) ] }
  text = text.replace(/\s+([.,;:!?\])}])/g, '$1');
  // Remove space after ( [ {
  text = text.replace(/([([{])\s+/g, '$1');
  // Collapse multiple spaces
  text = text.replace(/\s{2,}/g, ' ');

  return text.trim();
}

/**
 * Simple whitespace tokenizer for use with ML classifiers that expect
 * pre-tokenized input. Splits on whitespace boundaries.
 */
export function whitespaceTokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Create a mock token classifier for testing.
 * Keeps tokens matching any of the given patterns.
 */
export function createMockTokenClassifier(
  keepPatterns: RegExp[],
  confidence = 0.9,
): MLTokenClassifier {
  return (content: string) => {
    const tokens = whitespaceTokenize(content);
    return tokens.map((token) => ({
      token,
      keep: keepPatterns.some((p) => p.test(token)),
      confidence,
    }));
  };
}
