// Primary
export { compress, defaultTokenCounter } from './compress.js';
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
