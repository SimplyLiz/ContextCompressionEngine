export type Summarizer = (text: string) => string | Promise<string>;

export type ClassifierResult = {
  decision: 'preserve' | 'compress';
  confidence: number;
  reason: string;
};

export type Classifier = (content: string) => ClassifierResult | Promise<ClassifierResult>;

export type CreateClassifierOptions = {
  /** Domain-specific instructions for the LLM. */
  systemPrompt?: string;
  /** Content types to always preserve, regardless of LLM decision. */
  alwaysPreserve?: string[];
  /** Content types that are always safe to compress. */
  alwaysCompress?: string[];
  /** Maximum tokens for the LLM response. Default: 100. */
  maxResponseTokens?: number;
};

export type CreateSummarizerOptions = {
  /** Maximum tokens for the LLM response. Default: 300. */
  maxResponseTokens?: number;
  /** Domain-specific instructions prepended to the built-in rules. */
  systemPrompt?: string;
  /** Summarization mode. 'normal' (default) = concise prose, 'aggressive' = terse bullet points at half token budget. */
  mode?: 'normal' | 'aggressive';
  /** Domain-specific terms appended to the built-in preserve list. */
  preserveTerms?: string[];
};

export interface FormatAdapter {
  /** Adapter name for identification. */
  name: string;
  /** Returns true if this adapter handles the given content. */
  detect(content: string): boolean;
  /** Extract elements that must survive compression verbatim. */
  extractPreserved(content: string): string[];
  /** Extract elements that can be summarized. */
  extractCompressible(content: string): string[];
  /** Reconstruct output from preserved elements and a summary string. */
  reconstruct(preserved: string[], summary: string): string;
}

export type CompressDecision = {
  messageId: string;
  messageIndex: number;
  action: 'preserved' | 'compressed' | 'deduped' | 'fuzzy_deduped' | 'truncated' | 'code_split';
  reason: string;
  inputChars: number;
  outputChars: number;
};

export type CompressOptions = {
  preserve?: string[];
  recencyWindow?: number;
  /** Context version at the time of compression. Flows into _cce_original.version and compression.original_version. */
  sourceVersion?: number;
  /** LLM-powered summarizer. When provided, compress() returns a Promise. */
  summarizer?: Summarizer;
  /** Target token budget. When set, compress binary-searches recencyWindow to fit. */
  tokenBudget?: number;
  /** Skip compression entirely when total input tokens are below this threshold. Returns messages unmodified. */
  compressionThreshold?: number;
  /** Minimum recencyWindow when using tokenBudget. Default: 0. */
  minRecencyWindow?: number;
  /** Replace earlier duplicate messages with a compact reference. Default: true. */
  dedup?: boolean;
  /** Detect near-duplicate messages using line-level similarity. Default: false. */
  fuzzyDedup?: boolean;
  /** Similarity threshold for fuzzy dedup (0-1). Default: 0.85. */
  fuzzyThreshold?: number;
  /** Embed summary_id in compressed content so downstream tools can reference it. Default: false. */
  embedSummaryId?: boolean;
  /** Hard-truncate non-recency messages when binary search bottoms out and budget still exceeded. Default: false. */
  forceConverge?: boolean;
  /** Custom patterns that force preservation (hard T0). Matched against message content.
   *  Each pattern needs a regex and a label used in classification reasons.
   *  Example: `[{ re: /§\s*\d+/, label: 'section_ref' }]` */
  preservePatterns?: Array<{ re: RegExp; label: string }>;
  /** LLM-powered classifier. Determines which messages to preserve vs. compress.
   *  When provided, compress() returns a Promise. */
  classifier?: Classifier;
  /** Classification mode. Controls how the LLM classifier interacts with heuristics.
   *  - 'hybrid': Heuristics first, LLM for low-confidence cases (default when classifier is set)
   *  - 'full': LLM classifies every message, heuristics skipped
   *  Ignored when classifier is not set. */
  classifierMode?: 'hybrid' | 'full';
  /** Custom token counter per message. Default: ceil(content.length / 3.5) — see defaultTokenCounter for rationale. */
  tokenCounter?: (msg: Message) => number;
  /** Emit a decisions array in the result explaining what happened to each message. Default: false. */
  trace?: boolean;
  /** Custom format adapters for domain-specific content handling.
   *  Each adapter can detect, extract, and reconstruct format-specific content.
   *  Built-in adapters (code fences, structured output) always run first. */
  adapters?: FormatAdapter[];
};

export type VerbatimMap = Record<string, Message>;

export type UncompressOptions = {
  /** Recursively expand messages whose originals are also compressed. Default: false. */
  recursive?: boolean;
};

export type UncompressResult = {
  messages: Message[];
  messages_expanded: number;
  messages_passthrough: number;
  /** IDs looked up but not found. Non-empty = data loss in the verbatim store. */
  missing_ids: string[];
};

export type CompressResult = {
  messages: Message[];
  compression: {
    original_version: number;
    /** Character-based compression ratio: original_chars / compressed_chars. >1 means savings. */
    ratio: number;
    /** Token-based compression ratio: original_tokens / compressed_tokens. >1 means savings. */
    token_ratio: number;
    messages_compressed: number;
    messages_preserved: number;
    messages_deduped?: number;
    messages_fuzzy_deduped?: number;
    messages_pattern_preserved?: number;
    /** Messages classified by LLM (when classifier is provided). */
    messages_llm_classified?: number;
    /** Messages where LLM decided to preserve (when classifier is provided). */
    messages_llm_preserved?: number;
    decisions?: CompressDecision[];
  };
  /**
   * Original verbatim messages keyed by ID — every compressed message's
   * source appears here.
   *
   * ATOMICITY: `messages` and `verbatim` must be persisted together in a
   * single transaction. Writing `messages` without `verbatim` causes
   * irrecoverable data loss. Use `uncompress()` after loading to
   * verify integrity — non-empty `missing_ids` indicates a partial write.
   */
  verbatim: VerbatimMap;
  /** Whether the result fits within the token budget. Present when tokenBudget is used. */
  fits?: boolean;
  /** Estimated token count of the result. Present when tokenBudget is used. */
  tokenCount?: number;
  /** The recencyWindow the binary search settled on. Present when tokenBudget is used. */
  recencyWindow?: number;
};

export type TaskOutcome = { success: boolean; error?: string };

export type CompressionPair = {
  original: Message[];
  compressed: Message[];
  outcome: TaskOutcome;
};

export type FeedbackResult = {
  lostPatterns: string[];
  suggestedTerms: string[];
  guidelines: string[];
};

export type FeedbackCollector = {
  add(original: Message[], compressed: Message[], outcome: TaskOutcome): void;
  analyze(): Promise<FeedbackResult>;
  readonly pairs: readonly CompressionPair[];
};

export type Message = {
  id: string;
  index: number;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  tool_calls?: unknown[];
  [key: string]: unknown;
};
