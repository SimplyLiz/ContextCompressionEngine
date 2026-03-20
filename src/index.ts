// Primary
export { compress, defaultTokenCounter, bestSentenceScore } from './compress.js';
export { uncompress } from './expand.js';
export type { StoreLookup } from './expand.js';

// Helpers (LLM integration)
export { createSummarizer, createEscalatingSummarizer } from './summarizer.js';
export { createClassifier, createEscalatingClassifier } from './classifier.js';
export {
  createFeedbackCollector,
  refineSummarizer,
  tightenSummarizer,
  refineSummarizerCandidates,
  createDistillationPairs,
  RECOMMENDED_HISTORY_THRESHOLD,
  RECOMMENDED_OBSERVATION_THRESHOLD,
} from './feedback.js';

// Format adapters
export { CodeAdapter, StructuredOutputAdapter } from './adapters.js';

// Entity extraction & quality metrics
export {
  extractEntities,
  collectMessageEntities,
  computeEntityRetention,
  computeStructuralIntegrity,
  computeReferenceCoherence,
  computeQualityScore,
} from './entities.js';

// Importance scoring (ANCS-inspired)
export {
  computeImportance,
  scoreContentSignals,
  DEFAULT_IMPORTANCE_THRESHOLD,
} from './importance.js';
export type { ImportanceMap } from './importance.js';

// Conversation flow detection
export { detectFlowChains, summarizeChain } from './flow.js';
export type { FlowChain } from './flow.js';

// Entropy scoring utilities
export { splitSentences, normalizeScores, combineScores } from './entropy.js';

// Contradiction detection (ANCS-inspired)
export { analyzeContradictions } from './contradiction.js';
export type { ContradictionAnnotation } from './contradiction.js';

// Types
export type {
  Classifier,
  ClassifierResult,
  CompressDecision,
  CompressionPair,
  CompressOptions,
  CompressResult,
  CreateClassifierOptions,
  CreateSummarizerOptions,
  DistillationPair,
  FeedbackCollector,
  FeedbackResult,
  FormatAdapter,
  Message,
  OverPreservationResult,
  Summarizer,
  TaskOutcome,
  UncompressOptions,
  UncompressResult,
  VerbatimMap,
} from './types.js';
