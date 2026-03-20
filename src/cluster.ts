/**
 * Semantic clustering for topic-aware compression.
 *
 * Groups messages by topic using lightweight TF-IDF and entity overlap,
 * then compresses each cluster as a unit. Scattered messages about the
 * same topic get merged into a single compressed block.
 */

import { extractEntities } from './entities.js';
import type { Message } from './types.js';

export type MessageCluster = {
  /** Indices of messages in this cluster, in chronological order. */
  indices: number[];
  /** Shared entities across cluster members. */
  sharedEntities: string[];
  /** Cluster label derived from top entities. */
  label: string;
};

// Common English stopwords
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'because',
  'but',
  'and',
  'or',
  'if',
  'while',
  'although',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'whose',
]);

/**
 * Tokenize text into content words (lowercase, no stopwords, 3+ chars).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Compute TF-IDF vectors for each message.
 * Returns term weights per message and the IDF table.
 */
function computeTfIdf(messages: Message[], indices: number[]): Map<number, Map<string, number>> {
  // Document frequency
  const df = new Map<string, number>();
  const docs = new Map<number, string[]>();

  for (const idx of indices) {
    const content = (messages[idx].content as string | undefined) ?? '';
    const tokens = tokenize(content);
    docs.set(idx, tokens);
    const unique = new Set(tokens);
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = indices.length;
  const tfidf = new Map<number, Map<string, number>>();

  for (const idx of indices) {
    const tokens = docs.get(idx)!;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const idf = Math.log(N / (df.get(term) ?? 1));
      vec.set(term, count * idf);
    }
    tfidf.set(idx, vec);
  }

  return tfidf;
}

/**
 * Cosine similarity between two TF-IDF vectors.
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, wA] of a) {
    normA += wA * wA;
    const wB = b.get(term);
    if (wB != null) dot += wA * wB;
  }
  for (const [, wB] of b) normB += wB * wB;

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Agglomerative clustering using cosine similarity on TF-IDF + entity overlap.
 * Merges closest clusters until similarity drops below threshold.
 */
export function clusterMessages(
  messages: Message[],
  eligibleIndices: number[],
  similarityThreshold = 0.15,
): MessageCluster[] {
  if (eligibleIndices.length < 2) return [];

  const tfidf = computeTfIdf(messages, eligibleIndices);

  // Entity overlap boost
  const entitySets = new Map<number, Set<string>>();
  for (const idx of eligibleIndices) {
    const content = (messages[idx].content as string | undefined) ?? '';
    entitySets.set(idx, new Set(extractEntities(content, 100)));
  }

  // Combined similarity: 0.7 * cosine(tfidf) + 0.3 * jaccard(entities)
  function similarity(i: number, j: number): number {
    const cos = cosineSimilarity(tfidf.get(i)!, tfidf.get(j)!);
    const eA = entitySets.get(i)!;
    const eB = entitySets.get(j)!;
    let intersection = 0;
    for (const e of eA) if (eB.has(e)) intersection++;
    const union = eA.size + eB.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    return 0.7 * cos + 0.3 * jaccard;
  }

  // Start with each message as its own cluster
  const clusters: number[][] = eligibleIndices.map((idx) => [idx]);

  // Agglomerative: merge closest pair until threshold
  while (clusters.length > 1) {
    let bestSim = -1;
    let bestI = -1;
    let bestJ = -1;

    for (let ci = 0; ci < clusters.length; ci++) {
      for (let cj = ci + 1; cj < clusters.length; cj++) {
        // Average-linkage similarity between clusters
        let totalSim = 0;
        let count = 0;
        for (const a of clusters[ci]) {
          for (const b of clusters[cj]) {
            totalSim += similarity(a, b);
            count++;
          }
        }
        const avgSim = count > 0 ? totalSim / count : 0;
        if (avgSim > bestSim) {
          bestSim = avgSim;
          bestI = ci;
          bestJ = cj;
        }
      }
    }

    if (bestSim < similarityThreshold) break;

    // Merge bestJ into bestI
    clusters[bestI] = [...clusters[bestI], ...clusters[bestJ]];
    clusters.splice(bestJ, 1);
  }

  // Convert to MessageCluster format (only multi-message clusters)
  return clusters
    .filter((c) => c.length >= 2)
    .map((indices) => {
      indices.sort((a, b) => a - b);
      // Find shared entities
      const entityCounts = new Map<string, number>();
      for (const idx of indices) {
        for (const e of entitySets.get(idx)!) {
          entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
        }
      }
      const shared = [...entityCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([e]) => e)
        .slice(0, 5);

      return {
        indices,
        sharedEntities: shared,
        label: shared.length > 0 ? shared.slice(0, 3).join(', ') : `cluster-${indices[0]}`,
      };
    });
}

/**
 * Produce a cluster-aware summary by merging messages chronologically.
 */
export function summarizeCluster(cluster: MessageCluster, messages: Message[]): string {
  const topicPrefix =
    cluster.sharedEntities.length > 0 ? `[${cluster.sharedEntities.slice(0, 3).join(', ')}] ` : '';

  const snippets: string[] = [];
  for (const idx of cluster.indices) {
    const content = (messages[idx].content as string | undefined) ?? '';
    const snippet = content.length > 100 ? content.slice(0, 97) + '...' : content;
    snippets.push(snippet);
  }

  return `${topicPrefix}${snippets.join(' → ')} (${cluster.indices.length} messages)`;
}
