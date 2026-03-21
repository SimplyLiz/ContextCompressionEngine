import { classifyMessage, HARD_T0_REASONS } from './classify.js';
import type { Classifier, ClassifierResult, CreateClassifierOptions } from './types.js';

const DEFAULT_MAX_RESPONSE_TOKENS = 100;

function buildClassifierPrompt(
  content: string,
  maxResponseTokens: number,
  options?: Pick<CreateClassifierOptions, 'systemPrompt' | 'alwaysPreserve' | 'alwaysCompress'>,
): string {
  const prefix = options?.systemPrompt ? `${options.systemPrompt}\n\n` : '';

  const preserveExtra =
    options?.alwaysPreserve && options.alwaysPreserve.length > 0
      ? '\n' + options.alwaysPreserve.map((t) => `- ${t}`).join('\n')
      : '';

  const compressExtra =
    options?.alwaysCompress && options.alwaysCompress.length > 0
      ? '\n' + options.alwaysCompress.map((t) => `- ${t}`).join('\n')
      : '';

  return `${prefix}Classify the following message for a context compression engine.

Your task: Decide whether this message should be PRESERVED verbatim or can be safely COMPRESSED (summarized).

Preserve content that:
- Contains critical decisions, conclusions, or commitments
- Would lose meaning if paraphrased
- Contains domain-specific terms, definitions, or references that must stay exact${preserveExtra}

Compress content that:
- Is general discussion, explanation, or elaboration
- Can be summarized without losing actionable information
- Contains filler, pleasantries, or redundant restatements${compressExtra}

Respond with EXACTLY this JSON format, nothing else (keep your response under ${maxResponseTokens} tokens):
{"decision": "preserve" | "compress", "confidence": 0.0-1.0, "reason": "one sentence"}

Message:
${content}`;
}

function parseClassifierResponse(response: string): ClassifierResult | null {
  // Strategy 1: direct JSON.parse
  try {
    const parsed = JSON.parse(response);
    if (isValidResult(parsed)) return normalizeResult(parsed);
  } catch {
    /* fall through */
  }

  // Strategy 2: extract first {...} substring
  const braceMatch = response.match(/\{[^}]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]);
      if (isValidResult(parsed)) return normalizeResult(parsed);
    } catch {
      /* fall through */
    }
  }

  // Strategy 3: extract from markdown code block
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (isValidResult(parsed)) return normalizeResult(parsed);
    } catch {
      /* fall through */
    }
  }

  return null;
}

function isValidResult(obj: unknown): boolean {
  if (obj == null || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    (o.decision === 'preserve' || o.decision === 'compress') &&
    typeof o.confidence === 'number' &&
    typeof o.reason === 'string'
  );
}

function normalizeResult(obj: Record<string, unknown>): ClassifierResult {
  return {
    decision: obj.decision as 'preserve' | 'compress',
    confidence: Math.max(0, Math.min(1, obj.confidence as number)),
    reason: obj.reason as string,
  };
}

const UNPARSEABLE: ClassifierResult = {
  decision: 'compress',
  confidence: 0,
  reason: 'unparseable',
};

export function createClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier {
  const maxResponseTokens = options?.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS;
  const promptOpts = {
    systemPrompt: options?.systemPrompt || undefined,
    alwaysPreserve: options?.alwaysPreserve,
    alwaysCompress: options?.alwaysCompress,
  };

  return (content: string) => {
    const prompt = buildClassifierPrompt(content, maxResponseTokens, promptOpts);
    const result = callLlm(prompt);
    if (result instanceof Promise) {
      return result.then((r) => parseClassifierResponse(r) ?? UNPARSEABLE);
    }
    return parseClassifierResponse(result) ?? UNPARSEABLE;
  };
}

export function createEscalatingClassifier(
  callLlm: (prompt: string) => string | Promise<string>,
  options?: CreateClassifierOptions,
): Classifier {
  const inner = createClassifier(callLlm, options);

  return async (content: string): Promise<ClassifierResult> => {
    // Level 1: LLM classification
    try {
      const result = await inner(content);
      if (result.confidence > 0) return result;
    } catch {
      /* fall through to heuristic */
    }

    // Level 2: Heuristic fallback
    const heuristic = classifyMessage(content);
    if (heuristic.decision === 'T0') {
      const hasHard = heuristic.reasons.some((r) => HARD_T0_REASONS.has(r));
      if (hasHard) {
        return { decision: 'preserve', confidence: heuristic.confidence, reason: 'heuristic_t0' };
      }
    }
    return { decision: 'compress', confidence: heuristic.confidence, reason: 'heuristic_fallback' };
  };
}
