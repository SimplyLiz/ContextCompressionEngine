import type { CompressResult, Message } from '../src/types.js';
import { compress } from '../src/compress.js';
import { extractKeywords, extractEntities, extractStructural } from './baseline.js';
import { extractEntities as extractTechEntities } from '../src/entities.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageQuality {
  messageId: string;
  action: string;
  inputChars: number;
  outputChars: number;
  localRatio: number;
  entityRetention: number;
  keywordRetention: number;
  codeBlocksIntact: boolean;
}

export interface CompressedRetentionResult {
  keywordRetention: number;
  entityRetention: number;
  structuralRetention: number;
  codeBlockIntegrity: number;
}

export interface SemanticFidelityResult {
  factRetention: number;
  negationErrors: number;
  factCount: number;
}

export interface QualityResult {
  ratio: number;
  avgEntityRetention: number;
  avgKeywordRetention: number;
  minEntityRetention: number;
  codeBlockIntegrity: number;
  qualityScore: number;
  factRetention: number;
  negationErrors: number;
  factCount: number;
  messages: MessageQuality[];
}

export interface TradeoffPoint {
  recencyWindow: number;
  ratio: number;
  entityRetention: number;
  keywordRetention: number;
  qualityScore: number;
}

export interface TradeoffResult {
  points: TradeoffPoint[];
  qualityAt2x: number | null;
  qualityAt3x: number | null;
  maxRatioAbove80pctQuality: number;
}

export interface QualityBaseline {
  version: string;
  gitRef: string;
  generated: string;
  results: {
    scenarios: Record<string, QualityResult>;
    tradeoff: Record<string, TradeoffResult>;
  };
}

export interface QualityRegression {
  benchmark: string;
  scenario: string;
  metric: string;
  expected: number;
  actual: number;
  delta: string;
}

// ---------------------------------------------------------------------------
// Code block extraction
// ---------------------------------------------------------------------------

const CODE_FENCE_RE = /```[\w]*\n([\s\S]*?)```/g;

function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(CODE_FENCE_RE.source, CODE_FENCE_RE.flags);
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// analyzeCompressedRetention
// ---------------------------------------------------------------------------

/**
 * Measures retention ONLY for messages that were actually compressed.
 * Identifies compressed messages via _cce_original metadata, pulls originals
 * from the verbatim map, and compares against the compressed output.
 */
export function analyzeCompressedRetention(
  _originalMessages: Message[],
  result: CompressResult,
): CompressedRetentionResult {
  let totalKeywords = 0;
  let retainedKeywords = 0;
  let totalEntities = 0;
  let retainedEntities = 0;
  let totalStructural = 0;
  let retainedStructural = 0;
  let totalCodeBlocks = 0;
  let intactCodeBlocks = 0;

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[]; summary_id?: string } | undefined;
    if (!meta) continue; // not compressed

    // Reconstruct original text from verbatim store
    const ids = meta.ids ?? [msg.id];
    const originalTexts: string[] = [];
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig && typeof orig.content === 'string') {
        originalTexts.push(orig.content);
      }
    }
    if (originalTexts.length === 0) continue;

    const originalText = originalTexts.join('\n');
    const compressedText = typeof msg.content === 'string' ? msg.content : '';

    // Keyword retention
    const origKw = extractKeywords(originalText);
    totalKeywords += origKw.length;
    retainedKeywords += origKw.filter((k) => compressedText.includes(k)).length;

    // Entity retention
    const origEnt = extractEntities(originalText);
    totalEntities += origEnt.length;
    retainedEntities += origEnt.filter((e) => compressedText.includes(e)).length;

    // Structural retention
    const origStruct = extractStructural(originalText);
    totalStructural += origStruct.length;
    retainedStructural += origStruct.filter((s) => compressedText.includes(s)).length;

    // Code block integrity — byte-identical check
    const origBlocks = extractCodeBlocks(originalText);
    const compBlocks = extractCodeBlocks(compressedText);
    totalCodeBlocks += origBlocks.length;
    for (const ob of origBlocks) {
      if (compBlocks.some((cb) => cb === ob)) {
        intactCodeBlocks++;
      }
    }
  }

  return {
    keywordRetention: totalKeywords === 0 ? 1 : retainedKeywords / totalKeywords,
    entityRetention: totalEntities === 0 ? 1 : retainedEntities / totalEntities,
    structuralRetention: totalStructural === 0 ? 1 : retainedStructural / totalStructural,
    codeBlockIntegrity: totalCodeBlocks === 0 ? 1 : intactCodeBlocks / totalCodeBlocks,
  };
}

// ---------------------------------------------------------------------------
// Fact extraction & semantic fidelity
// ---------------------------------------------------------------------------

interface Fact {
  terms: string[];
  negated: boolean;
}

/**
 * Extract lightweight "facts" from text — technical assertions that
 * should survive compression.
 */
export function extractFacts(text: string): Fact[] {
  const facts: Fact[] = [];

  // Pattern 1: identifier + verb phrase
  // e.g. "getUserProfile validates JWT", "the service handles retries"
  const identVerb =
    /\b([a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+)\s+((?:(?:does\s+)?not\s+)?(?:should|must|will|can|is|are|has|have|handles?|validates?|returns?|sends?|stores?|creates?|checks?|uses?|supports?|requires?|prevents?|enables?|processes?|runs?|calls?|reads?|writes?|takes?|provides?))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = identVerb.exec(text)) !== null) {
    const negated = /\bnot\b/i.test(m[2]);
    facts.push({ terms: [m[1], m[2].replace(/\b(does\s+)?not\s+/i, '').trim()], negated });
  }

  // Pattern 2: number + unit assertions
  // e.g. "timeout is 30 seconds", "max 100 requests"
  const numUnit =
    /\b(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|ms|MB|GB|KB|retries?|attempts?|requests?|errors?|workers?|threads?|replicas?|%|percent)\b/gi;
  while ((m = numUnit.exec(text)) !== null) {
    facts.push({ terms: [m[1], m[2]], negated: false });
  }

  // Pattern 3: "should/must/will" + action
  // e.g. "should use HTTPS", "must validate tokens"
  const modalAction = /\b(should|must|will|need\s+to)\s+((?:not\s+)?[a-z]+(?:\s+[a-z]+)?)\b/gi;
  while ((m = modalAction.exec(text)) !== null) {
    const negated = /\bnot\b/i.test(m[2]);
    facts.push({ terms: [m[1], m[2].replace(/\bnot\s+/i, '').trim()], negated });
  }

  return facts;
}

/**
 * Measure semantic fidelity: what fraction of extracted facts survive compression,
 * and whether any negation inversions were introduced.
 */
export function analyzeSemanticFidelity(
  _originalMessages: Message[],
  result: CompressResult,
): SemanticFidelityResult {
  let totalFacts = 0;
  let retainedFacts = 0;
  let negationErrors = 0;

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    const ids = meta.ids ?? [msg.id];
    const originalTexts: string[] = [];
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig && typeof orig.content === 'string') {
        originalTexts.push(orig.content);
      }
    }
    if (originalTexts.length === 0) continue;

    const originalText = originalTexts.join('\n');
    const compressedText = typeof msg.content === 'string' ? msg.content : '';

    const facts = extractFacts(originalText);
    totalFacts += facts.length;

    for (const fact of facts) {
      const allTermsPresent = fact.terms.every((t) =>
        compressedText.toLowerCase().includes(t.toLowerCase()),
      );
      if (allTermsPresent) {
        retainedFacts++;

        // Check for negation inversion: original was not negated but compressed has negation
        // adjacent to the terms, or vice versa
        if (!fact.negated) {
          const negRe = new RegExp(
            `\\b(?:not|never|don't|doesn't|shouldn't|won't|cannot|can't)\\s+(?:\\w+\\s+){0,2}${escapeRegex(fact.terms[fact.terms.length - 1])}`,
            'i',
          );
          if (negRe.test(compressedText)) {
            negationErrors++;
          }
        }
      }
    }
  }

  return {
    factRetention: totalFacts === 0 ? 1 : retainedFacts / totalFacts,
    negationErrors,
    factCount: totalFacts,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Per-message quality analysis
// ---------------------------------------------------------------------------

/**
 * Build per-message quality breakdown for compressed messages.
 */
export function analyzePerMessageQuality(
  _originalMessages: Message[],
  result: CompressResult,
): MessageQuality[] {
  const messages: MessageQuality[] = [];

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    const ids = meta.ids ?? [msg.id];
    const originalTexts: string[] = [];
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig && typeof orig.content === 'string') {
        originalTexts.push(orig.content);
      }
    }
    if (originalTexts.length === 0) continue;

    const originalText = originalTexts.join('\n');
    const compressedText = typeof msg.content === 'string' ? msg.content : '';
    const inputChars = originalText.length;
    const outputChars = compressedText.length;

    // Entity retention (using the richer entities extractor)
    const origEntities = extractTechEntities(originalText, 500);
    const retainedCount = origEntities.filter((e) => compressedText.includes(e)).length;
    const entityRetention = origEntities.length === 0 ? 1 : retainedCount / origEntities.length;

    // Keyword retention
    const origKw = extractKeywords(originalText);
    const kwRetained = origKw.filter((k) => compressedText.includes(k)).length;
    const keywordRetention = origKw.length === 0 ? 1 : kwRetained / origKw.length;

    // Code block integrity
    const origBlocks = extractCodeBlocks(originalText);
    const compBlocks = extractCodeBlocks(compressedText);
    const codeBlocksIntact =
      origBlocks.length === 0 || origBlocks.every((ob) => compBlocks.some((cb) => cb === ob));

    // Determine action from decisions if available
    const decision = result.compression.decisions?.find((d) => d.messageId === msg.id);
    const action = decision?.action ?? 'compressed';

    messages.push({
      messageId: msg.id,
      action,
      inputChars,
      outputChars,
      localRatio: outputChars > 0 ? inputChars / outputChars : inputChars,
      entityRetention,
      keywordRetention,
      codeBlocksIntact,
    });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Tradeoff sweep
// ---------------------------------------------------------------------------

/**
 * Sweep recencyWindow from 0 to messages.length, measuring quality at each step.
 * Returns sorted points from most aggressive (rw=0) to least (rw=len).
 */
export function sweepTradeoff(messages: Message[], step?: number): TradeoffPoint[] {
  const maxRw = messages.length;
  const inc = step ?? Math.max(1, Math.floor(maxRw / 20)); // ~20 sample points
  const points: TradeoffPoint[] = [];

  for (let rw = 0; rw <= maxRw; rw += inc) {
    const cr = compress(messages, { recencyWindow: rw, trace: true });
    const retention = analyzeCompressedRetention(messages, cr);

    points.push({
      recencyWindow: rw,
      ratio: cr.compression.ratio,
      entityRetention: retention.entityRetention,
      keywordRetention: retention.keywordRetention,
      qualityScore: cr.compression.quality_score ?? 1,
    });

    // No need to continue if ratio is 1.0 (no compression happening)
    if (cr.compression.ratio <= 1.001) break;
  }

  return points;
}

/**
 * Derive summary statistics from a tradeoff curve.
 */
export function summarizeTradeoff(points: TradeoffPoint[]): TradeoffResult {
  // Find quality at specific ratio targets
  const qualityAtRatio = (target: number): number | null => {
    // Find the point closest to the target ratio
    let best: TradeoffPoint | null = null;
    let bestDist = Infinity;
    for (const p of points) {
      const dist = Math.abs(p.ratio - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best && bestDist < 0.5 ? best.qualityScore : null;
  };

  // Max ratio achievable while keeping quality above 0.8
  let maxRatioAbove80 = 1;
  for (const p of points) {
    if (p.qualityScore >= 0.8 && p.ratio > maxRatioAbove80) {
      maxRatioAbove80 = p.ratio;
    }
  }

  return {
    points,
    qualityAt2x: qualityAtRatio(2),
    qualityAt3x: qualityAtRatio(3),
    maxRatioAbove80pctQuality: maxRatioAbove80,
  };
}

// ---------------------------------------------------------------------------
// Full quality analysis for a single scenario
// ---------------------------------------------------------------------------

/**
 * Run complete quality analysis on a scenario.
 */
export function analyzeQuality(messages: Message[]): QualityResult {
  const cr = compress(messages, { recencyWindow: 0, trace: true });

  const retention = analyzeCompressedRetention(messages, cr);
  const fidelity = analyzeSemanticFidelity(messages, cr);
  const perMessage = analyzePerMessageQuality(messages, cr);

  const entityRetentions = perMessage.map((m) => m.entityRetention);
  const keywordRetentions = perMessage.map((m) => m.keywordRetention);

  return {
    ratio: cr.compression.ratio,
    avgEntityRetention:
      entityRetentions.length > 0
        ? entityRetentions.reduce((a, b) => a + b, 0) / entityRetentions.length
        : 1,
    avgKeywordRetention:
      keywordRetentions.length > 0
        ? keywordRetentions.reduce((a, b) => a + b, 0) / keywordRetentions.length
        : 1,
    minEntityRetention: entityRetentions.length > 0 ? Math.min(...entityRetentions) : 1,
    codeBlockIntegrity: retention.codeBlockIntegrity,
    qualityScore: cr.compression.quality_score ?? 1,
    factRetention: fidelity.factRetention,
    negationErrors: fidelity.negationErrors,
    factCount: fidelity.factCount,
    messages: perMessage,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

export function compareQualityResults(
  baseline: QualityBaseline,
  current: QualityBaseline,
): QualityRegression[] {
  const regressions: QualityRegression[] = [];

  for (const [name, exp] of Object.entries(baseline.results.scenarios)) {
    const act = current.results.scenarios[name];
    if (!act) continue;

    // Entity retention: max 5% drop
    if (exp.avgEntityRetention - act.avgEntityRetention > 0.05) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'avgEntityRetention',
        expected: exp.avgEntityRetention,
        actual: act.avgEntityRetention,
        delta: `${((act.avgEntityRetention - exp.avgEntityRetention) * 100).toFixed(1)}%`,
      });
    }

    // Code block integrity: zero tolerance
    if (exp.codeBlockIntegrity === 1 && act.codeBlockIntegrity < 1) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'codeBlockIntegrity',
        expected: exp.codeBlockIntegrity,
        actual: act.codeBlockIntegrity,
        delta: `${((act.codeBlockIntegrity - exp.codeBlockIntegrity) * 100).toFixed(1)}%`,
      });
    }

    // Fact retention: max 10% drop
    if (exp.factRetention - act.factRetention > 0.1) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'factRetention',
        expected: exp.factRetention,
        actual: act.factRetention,
        delta: `${((act.factRetention - exp.factRetention) * 100).toFixed(1)}%`,
      });
    }

    // Negation errors: must stay at 0
    if (act.negationErrors > 0 && exp.negationErrors === 0) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'negationErrors',
        expected: 0,
        actual: act.negationErrors,
        delta: `+${act.negationErrors}`,
      });
    }
  }

  // Tradeoff: maxRatioAbove80pctQuality must not regress
  for (const [name, exp] of Object.entries(baseline.results.tradeoff)) {
    const act = current.results.tradeoff[name];
    if (!act) continue;

    if (exp.maxRatioAbove80pctQuality - act.maxRatioAbove80pctQuality > 0.1) {
      regressions.push({
        benchmark: 'tradeoff',
        scenario: name,
        metric: 'maxRatioAbove80pctQuality',
        expected: exp.maxRatioAbove80pctQuality,
        actual: act.maxRatioAbove80pctQuality,
        delta: `${(act.maxRatioAbove80pctQuality - exp.maxRatioAbove80pctQuality).toFixed(2)}`,
      });
    }
  }

  return regressions;
}
