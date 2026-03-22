import type { CompressOptions, CompressResult, Message } from '../src/types.js';
import { compress } from '../src/compress.js';
import { extractEntities, extractStructural } from './baseline.js';
import { extractEntities as extractTechEntities, computeQualityScore } from '../src/entities.js';
import type { ProbeDefinition } from './quality-scenarios.js';

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
  codeBlocksIntact: boolean;
}

export interface ProbeResult {
  label: string;
  passed: boolean;
}

export interface CompressedRetentionResult {
  entityRetention: number;
  structuralRetention: number;
  codeBlockIntegrity: number;
}

export interface QualityResult {
  ratio: number;
  avgEntityRetention: number;
  minEntityRetention: number;
  codeBlockIntegrity: number;
  informationDensity: number;
  compressedQualityScore: number;
  probesPassed: number;
  probesTotal: number;
  probePassRate: number;
  probeResults: ProbeResult[];
  negativeCompressions: number;
  coherenceIssues: number;
  overheadRatio?: number;
  messages: MessageQuality[];
}

export interface TradeoffPoint {
  recencyWindow: number;
  ratio: number;
  entityRetention: number;
  informationDensity: number;
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
    entityRetention: totalEntities === 0 ? 1 : retainedEntities / totalEntities,
    structuralRetention: totalStructural === 0 ? 1 : retainedStructural / totalStructural,
    codeBlockIntegrity: totalCodeBlocks === 0 ? 1 : intactCodeBlocks / totalCodeBlocks,
  };
}

// ---------------------------------------------------------------------------
// Probe runner
// ---------------------------------------------------------------------------

export function runProbes(
  messages: Message[],
  probes: ProbeDefinition[],
): { passed: number; total: number; rate: number; results: ProbeResult[] } {
  const results: ProbeResult[] = [];
  let passed = 0;
  for (const probe of probes) {
    const ok = probe.check(messages);
    results.push({ label: probe.label, passed: ok });
    if (ok) passed++;
  }
  return {
    passed,
    total: probes.length,
    rate: probes.length === 0 ? 1 : passed / probes.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Information density
// ---------------------------------------------------------------------------

/**
 * Compute information density: (output_entities/output_chars) / (input_entities/input_chars).
 * >1.0 means the compressed output is denser in technical entities than the input (good).
 */
export function computeInformationDensity(result: CompressResult): number {
  let inputEntities = 0;
  let inputChars = 0;
  let outputEntities = 0;
  let outputChars = 0;

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    const ids = meta.ids ?? [msg.id];
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig && typeof orig.content === 'string') {
        inputEntities += extractTechEntities(orig.content, 500).length;
        inputChars += orig.content.length;
      }
    }

    const compressedText = typeof msg.content === 'string' ? msg.content : '';
    outputEntities += extractTechEntities(compressedText, 500).length;
    outputChars += compressedText.length;
  }

  if (inputChars === 0 || outputChars === 0) return 1.0;

  const inputDensity = inputEntities / inputChars;
  const outputDensity = outputEntities / outputChars;

  if (inputDensity === 0) return 1.0;
  return outputDensity / inputDensity;
}

// ---------------------------------------------------------------------------
// Compressed-only quality score
// ---------------------------------------------------------------------------

/**
 * Compute quality score over only the compressed messages (not the full set).
 * This isolates the quality signal to where compression actually happened.
 */
export function computeCompressedQualityScore(result: CompressResult): number {
  const originalMessages: Message[] = [];
  const compressedMessages: Message[] = [];

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    // Build original messages from verbatim
    const ids = meta.ids ?? [msg.id];
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig) originalMessages.push(orig);
    }

    compressedMessages.push(msg);
  }

  if (originalMessages.length === 0) return 1.0;

  const { quality_score } = computeQualityScore(originalMessages, compressedMessages);
  return quality_score;
}

// ---------------------------------------------------------------------------
// Negative compression detection
// ---------------------------------------------------------------------------

/**
 * Count messages where the compressed output is larger than the original input.
 */
export function detectNegativeCompressions(result: CompressResult): number {
  let count = 0;

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    const ids = meta.ids ?? [msg.id];
    let inputChars = 0;
    for (const id of ids) {
      const orig = result.verbatim[id];
      if (orig && typeof orig.content === 'string') {
        inputChars += orig.content.length;
      }
    }

    const outputChars = typeof msg.content === 'string' ? msg.content.length : 0;
    if (outputChars > inputChars) count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Coherence checks
// ---------------------------------------------------------------------------

/**
 * Check compressed messages for coherence issues:
 * (a) sentence fragments (no verb)
 * (b) duplicate sentences
 * (c) trivial summaries (<10 chars)
 */
export function checkCoherence(result: CompressResult): number {
  let issues = 0;
  const SUMMARY_RE = /\[summary:\s*(.*?)\]/gi;
  const VERB_RE =
    /\b(?:is|are|was|were|has|have|had|do|does|did|will|would|could|should|can|may|might|shall|must|being|been|get|got|make|made|take|took|give|gave|use|used|run|runs|call|calls|read|reads|write|writes|send|sends|return|returns|create|creates|handle|handles|check|checks|provide|provides|include|includes|require|requires|allow|allows|enable|enables|support|supports|prevent|prevents|need|needs|want|wants|seem|seems|mean|means|show|shows|work|works|keep|keeps|start|starts|set|sets|find|finds|move|moves|try|tries|add|adds|help|helps|turn|turns|play|plays|hold|holds|bring|brings|begin|begins|end|ends|change|changes|follow|follows|stop|stops|go|goes|come|comes|put|puts|tell|tells|say|says|think|thinks|know|knows|see|sees|look|looks|build|builds|test|tests|deploy|deploys|monitor|monitors|configure|configures|validate|validates|compress|compresses|store|stores|load|loads|save|saves|publish|publishes|consume|consumes|process|processes|implement|implements|define|defines|contain|contains|maintain|maintains|manage|manages|connect|connects|execute|executes|receive|receives|apply|applies|ensure|ensures|track|tracks|detect|detects|resolve|resolves|replace|replaces|reduce|reduces|increase|increases|measure|measures|analyze|analyzes|convert|converts|establish|establishes|improve|improves|generate|generates|represent|represents|provide|provides)\b/i;

  for (const msg of result.messages) {
    const meta = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!meta) continue;

    const content = typeof msg.content === 'string' ? msg.content : '';

    // Extract summary text from [summary: ...] markers
    let summaryText = '';
    let match: RegExpExecArray | null;
    const re = new RegExp(SUMMARY_RE.source, SUMMARY_RE.flags);
    while ((match = re.exec(content)) !== null) {
      summaryText += match[1] + ' ';
    }

    // If no [summary:] markers, check the whole content for non-code text
    if (!summaryText) {
      // Strip code blocks and check remaining text
      summaryText = content.replace(/```[\w]*\n[\s\S]*?```/g, '').trim();
    }

    if (!summaryText) continue;

    // (c) trivial summary
    if (summaryText.trim().length < 10) {
      issues++;
      continue;
    }

    // Split into sentences for fragment/duplicate checks
    const sentences = summaryText
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3);

    // (a) sentence fragments — sentences with no verb
    for (const sentence of sentences) {
      if (!VERB_RE.test(sentence) && sentence.length > 15) {
        issues++;
        break; // count at most one fragment issue per message
      }
    }

    // (b) duplicate sentences within the same message
    const seen = new Set<string>();
    for (const sentence of sentences) {
      const normalized = sentence.toLowerCase();
      if (seen.has(normalized)) {
        issues++;
        break; // count at most one duplicate issue per message
      }
      seen.add(normalized);
    }
  }

  return issues;
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
    const infDensity = computeInformationDensity(cr);

    points.push({
      recencyWindow: rw,
      ratio: cr.compression.ratio,
      entityRetention: retention.entityRetention,
      informationDensity: infDensity,
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
export function analyzeQuality(
  messages: Message[],
  probes: ProbeDefinition[] = [],
  compressOptions?: Partial<CompressOptions>,
): QualityResult {
  const cr = compress(messages, { recencyWindow: 0, trace: true, ...compressOptions });

  const retention = analyzeCompressedRetention(messages, cr);
  const perMessage = analyzePerMessageQuality(messages, cr);
  const probeResult = runProbes(cr.messages, probes);
  const infDensity = computeInformationDensity(cr);
  const cmpQuality = computeCompressedQualityScore(cr);
  const negComps = detectNegativeCompressions(cr);
  const coherence = checkCoherence(cr);

  const entityRetentions = perMessage.map((m) => m.entityRetention);

  return {
    ratio: cr.compression.ratio,
    avgEntityRetention:
      entityRetentions.length > 0
        ? entityRetentions.reduce((a, b) => a + b, 0) / entityRetentions.length
        : 1,
    minEntityRetention: entityRetentions.length > 0 ? Math.min(...entityRetentions) : 1,
    codeBlockIntegrity: retention.codeBlockIntegrity,
    informationDensity: infDensity,
    compressedQualityScore: cmpQuality,
    probesPassed: probeResult.passed,
    probesTotal: probeResult.total,
    probePassRate: probeResult.rate,
    probeResults: probeResult.results,
    negativeCompressions: negComps,
    coherenceIssues: coherence,
    messages: perMessage,
  };
}

// ---------------------------------------------------------------------------
// Compression overhead ratio
// ---------------------------------------------------------------------------

/**
 * Compute compression overhead ratio: how much time the compression takes
 * relative to the time those tokens would take in an LLM inference pass.
 *
 * A ratio of 0.1 means compression took 10% of the LLM processing time
 * for the same token count — i.e. compression is 10x cheaper.
 *
 * @param compressionTimeMs - wall-clock time for the compress() call
 * @param originalTokens - estimated token count of the original messages
 * @param msPerToken - assumed LLM inference cost per token (default: 20ms)
 */
export function computeOverheadRatio(
  compressionTimeMs: number,
  originalTokens: number,
  msPerToken: number = 20,
): number {
  const llmTime = originalTokens * msPerToken;
  if (llmTime <= 0) return 0;
  return compressionTimeMs / llmTime;
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

    // Probe pass rate: max 5% drop
    if (exp.probePassRate - act.probePassRate > 0.05) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'probePassRate',
        expected: exp.probePassRate,
        actual: act.probePassRate,
        delta: `${((act.probePassRate - exp.probePassRate) * 100).toFixed(1)}%`,
      });
    }

    // Information density: must stay ≥ 0.8 (only meaningful when compression occurs)
    if (act.ratio > 1.01 && act.informationDensity < 0.8) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'informationDensity',
        expected: 0.8,
        actual: act.informationDensity,
        delta: `${((act.informationDensity - 0.8) * 100).toFixed(1)}%`,
      });
    }

    // Coherence issues: must not increase from baseline
    if (act.coherenceIssues > exp.coherenceIssues) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'coherenceIssues',
        expected: exp.coherenceIssues,
        actual: act.coherenceIssues,
        delta: `+${act.coherenceIssues - exp.coherenceIssues}`,
      });
    }

    // Negative compressions: must not increase from baseline
    if (act.negativeCompressions > exp.negativeCompressions) {
      regressions.push({
        benchmark: 'quality',
        scenario: name,
        metric: 'negativeCompressions',
        expected: exp.negativeCompressions,
        actual: act.negativeCompressions,
        delta: `+${act.negativeCompressions - exp.negativeCompressions}`,
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

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

export interface LlmJudgeScore {
  scenario: string;
  provider: string;
  model: string;
  meaningPreserved: number; // 1-5
  informationLoss: string; // free-text
  coherence: number; // 1-5
  overall: number; // 1-5
  raw: string;
}

const LLM_JUDGE_PROMPT = `You are evaluating a compression system that summarizes LLM conversations.
You will receive the ORIGINAL conversation and the COMPRESSED version.

Rate the compression on three dimensions (1-5 each):

1. **meaning_preserved** (1=major meaning lost, 5=all key meaning retained)
   - Are the important decisions, facts, code, and technical details still present?
   - Would someone reading only the compressed version understand the same things?

2. **coherence** (1=incoherent fragments, 5=reads naturally)
   - Do the compressed messages make sense on their own?
   - Are there sentence fragments, duplicate phrases, or nonsensical summaries?

3. **overall** (1=unusable compression, 5=excellent compression)
   - Considering both meaning preservation and readability, how good is this compression?

Respond in EXACTLY this format (no other text):
meaning_preserved: <1-5>
information_loss: <brief description of what was lost, or "none">
coherence: <1-5>
overall: <1-5>`;

function formatConversationForJudge(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role ?? 'unknown';
      const content = typeof m.content === 'string' ? m.content : '[non-text]';
      // Truncate very long messages to keep prompt size reasonable
      const truncated = content.length > 2000 ? content.slice(0, 2000) + '...[truncated]' : content;
      return `[${role}]: ${truncated}`;
    })
    .join('\n\n');
}

function parseLlmJudgeResponse(raw: string): {
  meaningPreserved: number;
  informationLoss: string;
  coherence: number;
  overall: number;
} {
  const getNum = (key: string): number => {
    const match = raw.match(new RegExp(`${key}:\\s*(\\d)`, 'i'));
    return match ? Math.min(5, Math.max(1, parseInt(match[1], 10))) : 3;
  };
  const lossMatch = raw.match(/information_loss:\s*(.+)/i);
  return {
    meaningPreserved: getNum('meaning_preserved'),
    informationLoss: lossMatch ? lossMatch[1].trim() : 'unknown',
    coherence: getNum('coherence'),
    overall: getNum('overall'),
  };
}

export async function runLlmJudge(
  scenarioName: string,
  originalMessages: Message[],
  compressedMessages: Message[],
  callLlm: (prompt: string) => Promise<string>,
  providerName: string,
  modelName: string,
): Promise<LlmJudgeScore> {
  const original = formatConversationForJudge(originalMessages);
  const compressed = formatConversationForJudge(compressedMessages);

  const prompt = `${LLM_JUDGE_PROMPT}

--- ORIGINAL CONVERSATION ---
${original}

--- COMPRESSED CONVERSATION ---
${compressed}`;

  const raw = await callLlm(prompt);
  const parsed = parseLlmJudgeResponse(raw);

  return {
    scenario: scenarioName,
    provider: providerName,
    model: modelName,
    meaningPreserved: parsed.meaningPreserved,
    informationLoss: parsed.informationLoss,
    coherence: parsed.coherence,
    overall: parsed.overall,
    raw,
  };
}
