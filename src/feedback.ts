import type {
  CompressionPair,
  CreateSummarizerOptions,
  FeedbackCollector,
  FeedbackResult,
  Message,
  TaskOutcome,
} from './types.js';

const EMPTY_FEEDBACK: FeedbackResult = {
  lostPatterns: [],
  suggestedTerms: [],
  guidelines: [],
};

function messagesToText(msgs: Message[]): string {
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((c) => c.length > 0)
    .join('\n---\n');
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const match = fenceRe.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function parseResponse(raw: string): FeedbackResult {
  const json = stripFences(raw);
  const parsed = JSON.parse(json);

  return {
    lostPatterns: Array.isArray(parsed.lostPatterns)
      ? parsed.lostPatterns.filter((v: unknown) => typeof v === 'string')
      : [],
    suggestedTerms: Array.isArray(parsed.suggestedTerms)
      ? parsed.suggestedTerms.filter((v: unknown) => typeof v === 'string')
      : [],
    guidelines: Array.isArray(parsed.guidelines)
      ? parsed.guidelines.filter((v: unknown) => typeof v === 'string')
      : [],
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
      return parseResponse(raw);
    },

    get pairs(): readonly CompressionPair[] {
      return _pairs;
    },
  };
}

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
    const existing = new Set(currentOptions.preserveTerms ?? []);
    const merged = [...(currentOptions.preserveTerms ?? [])];
    for (const term of feedback.suggestedTerms) {
      if (!existing.has(term)) {
        merged.push(term);
        existing.add(term);
      }
    }
    result.preserveTerms = merged;
  }

  if (hasGuidelines) {
    const bullets = feedback.guidelines.map((g) => `- ${g}`).join('\n');
    result.systemPrompt = currentOptions.systemPrompt
      ? `${currentOptions.systemPrompt}\n\n${bullets}`
      : bullets;
  }

  return result;
}
