import type {
  CompressResult,
  CompressionPair,
  CreateSummarizerOptions,
  DistillationPair,
  FeedbackCollector,
  FeedbackResult,
  Message,
  OverPreservationResult,
  TaskOutcome,
} from './types.js';

// ---------------------------------------------------------------------------
// Recommended thresholds from ACON ablations (§4.5, Figure 6)
// ---------------------------------------------------------------------------

/** Recommended history compression threshold in tokens (ACON §4.5). */
export const RECOMMENDED_HISTORY_THRESHOLD = 4096;

/** Recommended per-message observation compression threshold in tokens (ACON §4.5). */
export const RECOMMENDED_OBSERVATION_THRESHOLD = 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EMPTY_FEEDBACK: FeedbackResult = {
  lostPatterns: [],
  suggestedTerms: [],
  guidelines: [],
};

const EMPTY_OVER_PRESERVATION: OverPreservationResult = {
  unnecessaryPatterns: [],
  removableTerms: [],
  tighteningGuidelines: [],
};

function messagesToText(msgs: Message[]): string {
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((c) => c.length > 0)
    .join('\n---\n');
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenceRe = /^```[^\n]*\n([\s\S]*?)\n\s*```$/;
  const match = fenceRe.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function parseStringArray(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((v: unknown) => typeof v === 'string') : [];
}

function mergeTerms(current: string[] | undefined, additions: string[]): string[] {
  const existing = new Set(current ?? []);
  const merged = [...(current ?? [])];
  for (const term of additions) {
    if (!existing.has(term)) {
      merged.push(term);
      existing.add(term);
    }
  }
  return merged;
}

function appendGuidelines(current: string | undefined, guidelines: string[]): string {
  const bullets = guidelines.map((g) => `- ${g}`).join('\n');
  return current ? `${current}\n\n${bullets}` : bullets;
}

// ---------------------------------------------------------------------------
// UT step: analyze lost information (contrastive feedback)
// ---------------------------------------------------------------------------

function parseFeedbackResponse(raw: string): FeedbackResult {
  const json = stripFences(raw);
  const parsed = JSON.parse(json);
  return {
    lostPatterns: parseStringArray(parsed.lostPatterns),
    suggestedTerms: parseStringArray(parsed.suggestedTerms),
    guidelines: parseStringArray(parsed.guidelines),
  };
}

function buildContrastivePrompt(pairs: readonly CompressionPair[]): string {
  const failed = pairs.filter((p) => !p.outcome.success);
  const succeeded = pairs.filter((p) => p.outcome.success);

  let prompt = `You are analyzing compression quality. Compare original and compressed messages to identify what information was lost during compression that may have caused downstream failures.

## Failed cases (compression likely lost critical info)\n`;

  for (const pair of failed) {
    prompt += `\n### Original:\n${messagesToText(pair.original)}\n`;
    prompt += `### Compressed:\n${messagesToText(pair.compressed)}\n`;
    if (pair.outcome.error) {
      prompt += `### Error: ${pair.outcome.error}\n`;
    }
  }

  if (succeeded.length > 0) {
    prompt += `\n## Successful cases (compression preserved enough info)\n`;
    for (const pair of succeeded) {
      prompt += `\n### Original:\n${messagesToText(pair.original)}\n`;
      prompt += `### Compressed:\n${messagesToText(pair.compressed)}\n`;
    }
  }

  prompt += `
Respond with a JSON object (no markdown fences, no preamble):
{
  "lostPatterns": ["patterns of information that were lost in failed cases but preserved in successful ones"],
  "suggestedTerms": ["specific technical terms/identifiers that should be preserved during summarization"],
  "guidelines": ["actionable rules for the summarizer to follow to avoid these failures"]
}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// CO step: analyze over-preservation in successful compressions
// ---------------------------------------------------------------------------

function parseOverPreservationResponse(raw: string): OverPreservationResult {
  const json = stripFences(raw);
  const parsed = JSON.parse(json);
  return {
    unnecessaryPatterns: parseStringArray(parsed.unnecessaryPatterns),
    removableTerms: parseStringArray(parsed.removableTerms),
    tighteningGuidelines: parseStringArray(parsed.tighteningGuidelines),
  };
}

function buildOverPreservationPrompt(pairs: readonly CompressionPair[]): string {
  const succeeded = pairs.filter((p) => p.outcome.success);

  let prompt = `You are analyzing compression efficiency. For each successful case below, the compressed version was sufficient for the task to succeed. Identify what information was preserved in the compressed version but was NOT actually needed for success — this is over-preservation that wastes tokens.

## Successful cases (task succeeded with compressed context)\n`;

  for (const pair of succeeded) {
    prompt += `\n### Original:\n${messagesToText(pair.original)}\n`;
    prompt += `### Compressed:\n${messagesToText(pair.compressed)}\n`;
  }

  prompt += `
Respond with a JSON object (no markdown fences, no preamble):
{
  "unnecessaryPatterns": ["patterns of information that were preserved but not needed for task success"],
  "removableTerms": ["specific terms/identifiers that were preserved but could safely be omitted"],
  "tighteningGuidelines": ["actionable rules for the summarizer to produce shorter summaries without losing critical info"]
}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Feedback collector
// ---------------------------------------------------------------------------

export function createFeedbackCollector(
  callLlm: (prompt: string) => string | Promise<string>,
): FeedbackCollector {
  const _pairs: CompressionPair[] = [];

  return {
    add(original: Message[], compressed: Message[], outcome: TaskOutcome): void {
      _pairs.push({ original, compressed, outcome });
    },

    async analyze(): Promise<FeedbackResult> {
      const hasFailures = _pairs.some((p) => !p.outcome.success);
      if (_pairs.length === 0 || !hasFailures) {
        return { ...EMPTY_FEEDBACK };
      }

      const prompt = buildContrastivePrompt(_pairs);
      const raw = await callLlm(prompt);
      return parseFeedbackResponse(raw);
    },

    async analyzeOverPreservation(): Promise<OverPreservationResult> {
      const hasSuccesses = _pairs.some((p) => p.outcome.success);
      if (_pairs.length === 0 || !hasSuccesses) {
        return { ...EMPTY_OVER_PRESERVATION };
      }

      const prompt = buildOverPreservationPrompt(_pairs);
      const raw = await callLlm(prompt);
      return parseOverPreservationResponse(raw);
    },

    get pairs(): readonly CompressionPair[] {
      return _pairs;
    },
  };
}

// ---------------------------------------------------------------------------
// UT: refineSummarizer — merge feedback into options (additive)
// ---------------------------------------------------------------------------

export function refineSummarizer(
  currentOptions: CreateSummarizerOptions,
  feedback: FeedbackResult,
): CreateSummarizerOptions {
  const hasTerms = feedback.suggestedTerms.length > 0;
  const hasGuidelines = feedback.guidelines.length > 0;

  if (!hasTerms && !hasGuidelines) {
    return { ...currentOptions };
  }

  const result: CreateSummarizerOptions = { ...currentOptions };

  if (hasTerms) {
    result.preserveTerms = mergeTerms(currentOptions.preserveTerms, feedback.suggestedTerms);
  }

  if (hasGuidelines) {
    result.systemPrompt = appendGuidelines(currentOptions.systemPrompt, feedback.guidelines);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CO: tightenSummarizer — apply over-preservation feedback (subtractive)
// ---------------------------------------------------------------------------

export function tightenSummarizer(
  currentOptions: CreateSummarizerOptions,
  feedback: OverPreservationResult,
): CreateSummarizerOptions {
  const hasTerms = feedback.removableTerms.length > 0;
  const hasGuidelines = feedback.tighteningGuidelines.length > 0;

  if (!hasTerms && !hasGuidelines) {
    return { ...currentOptions };
  }

  const result: CreateSummarizerOptions = { ...currentOptions };

  if (hasTerms) {
    const removable = new Set(feedback.removableTerms);
    result.preserveTerms = (currentOptions.preserveTerms ?? []).filter((t) => !removable.has(t));
  }

  if (hasGuidelines) {
    result.systemPrompt = appendGuidelines(
      currentOptions.systemPrompt,
      feedback.tighteningGuidelines,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Candidate selection: generate N diverse refinements for evaluation
// ---------------------------------------------------------------------------

function buildCandidatePrompt(
  currentOptions: CreateSummarizerOptions,
  feedback: FeedbackResult,
  count: number,
): string {
  const currentTerms = currentOptions.preserveTerms?.join(', ') || '(none)';
  const currentPrompt = currentOptions.systemPrompt || '(none)';

  const prompt = `You are optimizing a text summarizer's configuration. Given the current settings and feedback from compression failures, generate ${count} diverse candidate configurations that each address the feedback differently.

## Current configuration
- Preserve terms: ${currentTerms}
- System prompt: ${currentPrompt}

## Feedback from failures
- Lost patterns: ${feedback.lostPatterns.join('; ') || '(none)'}
- Suggested terms: ${feedback.suggestedTerms.join(', ') || '(none)'}
- Guidelines: ${feedback.guidelines.join('; ') || '(none)'}

Generate ${count} DIFFERENT candidate configurations. Each should take a different approach to addressing the feedback (e.g., one conservative, one aggressive, one focused on terms, one on guidelines).

Respond with a JSON array of ${count} objects (no markdown fences, no preamble):
[
  {
    "preserveTerms": ["terms to add to the preserve list"],
    "guidelines": ["actionable rules for the summarizer"]
  }
]`;

  return prompt;
}

function parseCandidates(
  raw: string,
  count: number,
): Array<{ preserveTerms: string[]; guidelines: string[] }> {
  const json = stripFences(raw);
  const parsed = JSON.parse(json);

  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array of candidates');
  }

  return parsed.slice(0, count).map((c: Record<string, unknown>) => ({
    preserveTerms: parseStringArray(c.preserveTerms),
    guidelines: parseStringArray(c.guidelines),
  }));
}

export async function refineSummarizerCandidates(
  callLlm: (prompt: string) => string | Promise<string>,
  currentOptions: CreateSummarizerOptions,
  feedback: FeedbackResult,
  count: number = 5,
): Promise<CreateSummarizerOptions[]> {
  const prompt = buildCandidatePrompt(currentOptions, feedback, count);
  const raw = await callLlm(prompt);
  const candidates = parseCandidates(raw, count);

  return candidates.map((candidate) => {
    const result: CreateSummarizerOptions = { ...currentOptions };

    if (candidate.preserveTerms.length > 0) {
      result.preserveTerms = mergeTerms(currentOptions.preserveTerms, candidate.preserveTerms);
    }

    if (candidate.guidelines.length > 0) {
      result.systemPrompt = appendGuidelines(currentOptions.systemPrompt, candidate.guidelines);
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Distillation: extract (input, output) pairs for fine-tuning a smaller model
// ---------------------------------------------------------------------------

export function createDistillationPairs(result: CompressResult): DistillationPair[] {
  const pairs: DistillationPair[] = [];

  for (const msg of result.messages) {
    const orig = msg.metadata?._cce_original as { ids?: string[] } | undefined;
    if (!orig?.ids || !Array.isArray(orig.ids)) continue;

    const originalTexts = orig.ids
      .map((id) => result.verbatim[id])
      .filter(Boolean)
      .map((m) => (typeof m.content === 'string' ? m.content : ''));

    const input = originalTexts.join('\n');
    const output = typeof msg.content === 'string' ? msg.content : '';

    if (input.length > 0 && output.length > 0 && input !== output) {
      pairs.push({ input, output });
    }
  }

  return pairs;
}
