// Primary
export { compress, defaultTokenCounter } from './compress.js';
export { uncompress } from './expand.js';
export type { StoreLookup } from './expand.js';

// Helpers (LLM integration)
export { createSummarizer, createEscalatingSummarizer } from './summarizer.js';
export { createClassifier, createEscalatingClassifier } from './classifier.js';

// Format adapters
export { CodeAdapter, StructuredOutputAdapter } from './adapters.js';

// Types
export type {
  Classifier,
  ClassifierResult,
  CompressDecision,
  CompressOptions,
  CompressResult,
  CreateClassifierOptions,
  CreateSummarizerOptions,
  FormatAdapter,
  Message,
  Summarizer,
  UncompressOptions,
  UncompressResult,
  VerbatimMap,
} from './types.js';
