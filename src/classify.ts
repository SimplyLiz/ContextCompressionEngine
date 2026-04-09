export type ClassifyResult = {
  decision: 'T0' | 'T2' | 'T3';
  /**
   * Classification confidence (0–1). Higher values indicate stronger signal.
   *
   * For T0: starts at 0.70, increases by 0.05 per additional structural reason
   * (capped at 0.95). Multiple overlapping signals → higher confidence.
   * For T2/T3: fixed at 0.65 (pure prose heuristic, no structural anchors).
   *
   * The deterministic pipeline does not route on confidence — it uses the
   * hard/soft T0 distinction instead. Consumers can use confidence for custom
   * routing (e.g. only compress below a threshold), monitoring dashboards,
   * or LLM classifier fallback decisions (cf. Amazon Science "Label with
   * Confidence" for confidence-weighted routing patterns).
   */
  confidence: number;
  reasons: string[];
};

// -- Head 1: Structural Pattern Detector (SPD) --

const CODE_FENCE_RE = /^[ ]{0,3}```[\w]*\n[\s\S]*?\n\s*```/m;
const INDENT_CODE_RE = /^( {4}|\t).+\n( {4}|\t).+/m;
const LATEX_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/;
const UNICODE_MATH_RE = /[∀∃∈∉⊆⊇∪∩∧∨¬→↔∑∏∫√∞≈≠≤≥±×÷]/;
const JSON_RE = /^\s*(?:\{\s*"|\[\s*[[{"0-9-])/;
const YAML_RE = /^[\w-]+:\s+.+\n[\w-]+:\s+.+/m;
const POETRY_RE = /\n[A-Z][^.!?\n]*\n[A-Z][^.!?\n]*\n[A-Z][^.!?\n]*(?:\n|$)/;

function detectStructuralPatterns(text: string): {
  isT0: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (CODE_FENCE_RE.test(text)) reasons.push('code_fence');
  if (INDENT_CODE_RE.test(text)) reasons.push('indented_code');
  if (LATEX_RE.test(text)) reasons.push('latex_math');
  if (UNICODE_MATH_RE.test(text)) reasons.push('unicode_math');
  if (JSON_RE.test(text)) reasons.push('json_structure');
  if (YAML_RE.test(text)) reasons.push('yaml_structure');
  if (POETRY_RE.test(text)) reasons.push('verse_pattern');

  // Line-length variance — high variation signals structured content
  const lines = text.split('\n');
  const lengths = lines.map((l) => l.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  if (cv > 1.2 && lines.length > 3) reasons.push('high_line_length_variance');

  // Special character density
  const specialChars = (text.match(/[{}[\]<>|\\;:@#$%^&*()=+`~]/g) ?? []).length;
  const ratio = specialChars / Math.max(text.length, 1);
  if (ratio > 0.15) reasons.push('high_special_char_ratio');

  return { isT0: reasons.length > 0, reasons };
}

// -- Head 5: Content-Type Detector (CTD) --

// SQL keyword density — tiered anchor system to avoid false-positives on English prose.
// Strong anchors (compound keywords / near-zero English usage) → 1 alone is enough.
// Weak anchors (single words that *can* appear in English) → need 3+ total keywords.
const SQL_ALL_RE =
  /\b(?:SELECT|FROM|WHERE|JOIN|INSERT|INTO|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE|GRANT|REVOKE|HAVING|UNION|GROUP\s+BY|ORDER\s+BY|DISTINCT|LIMIT|OFFSET|VALUES|PRIMARY\s+KEY|FOREIGN\s+KEY|NOT\s+NULL|VARCHAR|INTEGER|BOOLEAN|CONSTRAINT|CASCADE|FETCH|CURSOR|DECLARE|PROCEDURE|TRIGGER|SCHEMA|VIEW|RETURNING|ON\s+CONFLICT|UPSERT|WITH\s+RECURSIVE|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|NATURAL\s+JOIN)\b/gi;
const SQL_STRONG_ANCHORS = new Set([
  'GROUP BY',
  'ORDER BY',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'NOT NULL',
  'VARCHAR',
  'INTEGER',
  'BOOLEAN',
  'CONSTRAINT',
  'CASCADE',
  'RETURNING',
  'ON CONFLICT',
  'WITH RECURSIVE',
  'UPSERT',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'FULL JOIN',
  'NATURAL JOIN',
  'TRUNCATE',
]);
const SQL_WEAK_ANCHORS = new Set([
  'WHERE',
  'JOIN',
  'HAVING',
  'UNION',
  'DISTINCT',
  'OFFSET',
  'VALUES',
  'MERGE',
  'GRANT',
  'REVOKE',
  'CURSOR',
  'DECLARE',
  'PROCEDURE',
  'TRIGGER',
  // VIEW, SCHEMA, FETCH omitted — too common in non-SQL tech prose
  // ("dashboard view", "JSON schema", "fetch API"). They stay in SQL_ALL_RE
  // as non-anchor keywords contributing to the count.
]);

function detectSqlContent(text: string): boolean {
  const matches = text.match(SQL_ALL_RE);
  if (!matches) return false;
  const distinct = new Set(matches.map((m) => m.toUpperCase().replace(/\s+/g, ' ')));

  // 1+ strong anchor → unambiguous SQL
  for (const kw of distinct) {
    if (SQL_STRONG_ANCHORS.has(kw)) return true;
  }

  // 3+ distinct keywords AND 1+ weak anchor → likely SQL
  if (distinct.size >= 3) {
    for (const kw of distinct) {
      if (SQL_WEAK_ANCHORS.has(kw)) return true;
    }
  }

  return false;
}

// API key patterns: known providers + generic entropy fallback
const API_KEY_PATTERNS: RegExp[] = [
  /(?<![a-zA-Z0-9-])sk-[a-zA-Z0-9_-]{20,}/, // OpenAI / Anthropic
  /\bAKIA[A-Z0-9]{16}\b/, // AWS access key ID
  /\bgh[posrt]_[a-zA-Z0-9]{36,}\b/, // GitHub tokens (PAT, OAuth, etc.)
  /\bgithub_pat_[a-zA-Z0-9_]{36,}\b/, // GitHub fine-grained PAT
  /\b[sr]k_(live|test)_[a-zA-Z0-9]{24,}\b/, // Stripe
  /\bxox[bpra]-[a-zA-Z0-9-]{20,}\b/, // Slack
  /\bSG\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/, // SendGrid
  /\bglpat-[a-zA-Z0-9_-]{20,}\b/, // GitLab
  /\bnpm_[a-zA-Z0-9]{36,}\b/, // npm
  /\bAIza[a-zA-Z0-9_-]{35}\b/, // Google API
];
// Generic fallback: prefix (with non-hex letter) + separator + 20+ mixed body
// Prefix must contain [g-zG-Z] to exclude UUID hex segments (0-9a-f only)
const GENERIC_TOKEN_RE =
  /\b[a-zA-Z](?=[a-zA-Z0-9]{0,13}[g-zG-Z])[a-zA-Z0-9]{1,14}[-_](?=[a-zA-Z0-9_-]*[0-9])(?=[a-zA-Z0-9_-]*[a-zA-Z])[a-zA-Z0-9_-]{20,}\b/;

// Reasoning chain detection — two-tier anchor system (mirrors SQL detection).
// Strong anchors: explicit reasoning labels or formal inference → 1 match is enough.
// Weak anchors: logical connectives / causal phrases → need 3+ distinct to trigger.
const REASONING_STRONG_RE =
  /^[ \t]*(?:Reasoning|Analysis|Conclusion|Proof|Derivation|Chain of Thought|Step[- ]by[- ]step)\s*:/im;
const REASONING_INFERENCE_RE =
  /\b(?:it follows that|we can (?:conclude|deduce|infer)|this (?:implies|proves) that|QED)\b|∴/i;
// Note: `g` flag is safe here — these regexes are only used via String.match(),
// which ignores lastIndex. Do NOT use .test()/.exec() on them without resetting.
const REASONING_WEAK_ANCHORS_RE =
  /\b(?:therefore|hence|thus|consequently|accordingly|this means that|as a result|because of this|which (?:implies|means|shows)|given that|assuming that|since we know)\b/gi;
const NUMBERED_STEP_RE = /(?:^|\n)\s*(?:Step\s+\d+[:.)]|\d+[.)]\s)/gi;
const SEQUENCE_MARKERS_RE =
  /\b(?:Let me (?:think|reason|analyze)|Let's (?:consider|break this down)|First(?:ly)?|Second(?:ly)?|Third(?:ly)?|In conclusion|To summarize|In summary)\b/gi;

export function detectReasoningChain(text: string): boolean {
  // 1+ strong anchor → unambiguous reasoning chain
  if (REASONING_STRONG_RE.test(text)) return true;
  if (REASONING_INFERENCE_RE.test(text)) return true;

  // Count distinct weak anchors
  const weakMatches = text.match(REASONING_WEAK_ANCHORS_RE);
  const distinctWeak = weakMatches
    ? new Set(weakMatches.map((m) => m.toLowerCase().replace(/\s+/g, ' '))).size
    : 0;

  // Count distinct sequence markers (each counts as 1 weak anchor)
  const seqMatches = text.match(SEQUENCE_MARKERS_RE);
  const seqCount = seqMatches
    ? new Set(seqMatches.map((m) => m.toLowerCase().replace(/\s+/g, ' '))).size
    : 0;

  // 3+ numbered steps AND 1+ weak anchor → reasoning chain
  const stepMatches = text.match(NUMBERED_STEP_RE);
  const stepCount = stepMatches ? stepMatches.length : 0;
  if (stepCount >= 3 && distinctWeak + seqCount >= 1) return true;

  // 3+ distinct weak anchors (including sequence contribution) → reasoning chain
  if (distinctWeak + seqCount >= 3) return true;

  return false;
}

// -- Head 6: Guardrail Pattern Detector (GPD) --
//
// Detects error tracebacks, HTTP error responses, and named failure signatures.
// These messages carry information an agent must not lose: a summarizer that drops
// "401 Unauthorized — username is required" will cause the agent to repeat the same
// failed approach. Classified as hard T0 so they are never compressed.

const ERROR_TRACEBACK_RE =
  /^(?:Traceback \(most recent call last\)|Exception in thread\b|\s+at \w[\w$.]*\()/m;
const HTTP_ERROR_RE =
  /\bResponse\s+status\s+code\s+is\s+[45]\d\d\b|\bHTTP\/\d[.]\d\s+[45]\d\d\b|\bstatus(?:\s+code)?[:\s]+[45]\d\d\b/i;
const EXPLICIT_FAILURE_RE =
  /\b(?:Execution\s+failed|Authentication\s+(?:failed|error)|Authorization\s+(?:failed|denied)|Connection\s+(?:refused|timeout|timed\s+out)|Permission\s+denied)\b/i;

function detectGuardrailPatterns(text: string): {
  isT0: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (ERROR_TRACEBACK_RE.test(text)) reasons.push('error_traceback');
  if (HTTP_ERROR_RE.test(text)) reasons.push('http_error');
  if (EXPLICIT_FAILURE_RE.test(text)) reasons.push('failure_signature');
  return { isT0: reasons.length > 0, reasons };
}

const FORCE_T0_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /https?:\/\/[^\s]+/, label: 'url' },
  { re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, label: 'email' },
  { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: 'phone' },
  { re: /\b(v\d+\.\d+(\.\d+)?|version\s+\d+)\b/i, label: 'version_number' },
  { re: /[a-f0-9]{40,64}/i, label: 'hash_or_sha' },
  { re: /[A-Za-z0-9+/]{40,}={0,2}/, label: 'base64_content' },
  { re: /(?:\/[\w.-]+){2,}/, label: 'file_path' },
  { re: /\b\d+(\.\d+){1,5}\b/, label: 'ip_or_semver' },
  { re: /"[^"]{3,}"(?:\s*[,:])/, label: 'quoted_key' },
  { re: /\b(shall|may not|notwithstanding|whereas|hereby)\b/i, label: 'legal_term' },
  { re: /["\u201c][^\u201d\u201c]{10,}["\u201d]|"[^"]{10,}"/, label: 'direct_quote' },
  {
    re: /\b\d+\.?\d*\s*(km|m|kg|s|°C|°F|Hz|MHz|GHz|ms|µs|ns|MB|GB|TB)\b/i,
    label: 'numeric_with_units',
  },
];

function detectContentTypes(text: string): {
  isT0: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // SQL keyword density
  if (detectSqlContent(text)) reasons.push('sql_content');

  // API key detection — known providers first, then generic with CSS/BEM rejection
  let apiKeyFound = false;
  for (const re of API_KEY_PATTERNS) {
    if (re.test(text)) {
      apiKeyFound = true;
      break;
    }
  }
  if (!apiKeyFound) {
    const genericMatch = text.match(GENERIC_TOKEN_RE);
    if (genericMatch) {
      const sepIdx = genericMatch[0].search(/[-_]/);
      const body = sepIdx >= 0 ? genericMatch[0].slice(sepIdx + 1) : '';
      // Reject if body looks like hyphenated words (3+ segments of 2+ lowercase letters)
      if (!/(?:[a-z]{2,}-){2,}/.test(body)) {
        apiKeyFound = true;
      }
    }
  }
  if (apiKeyFound) reasons.push('api_key');

  // Reasoning chain detection
  if (detectReasoningChain(text)) reasons.push('reasoning_chain');

  // Other content-type patterns
  for (const { re, label } of FORCE_T0_PATTERNS) {
    if (re.test(text)) reasons.push(label);
  }

  return { isT0: reasons.length > 0, reasons };
}

// -- Tier heuristic for clean prose --

/**
 * Assign T2 (short prose, < 20 words) or T3 (long prose, >= 20 words).
 *
 * Both tiers are compressed identically in the current deterministic pipeline.
 * The distinction exists so a future LLM classifier can apply different
 * strategies per tier — e.g. lighter summarization for T2 or aggressive
 * compression for verbose T3 content.
 */
function inferProseTier(text: string): 'T2' | 'T3' {
  const words = text.split(/\s+/).length;
  if (words < 20) return 'T2';
  return 'T3';
}

// -- Main classifier entry point --

// Hard T0 reasons: genuinely structural content that can't be summarized.
// Soft T0 reasons (file_path, url, version_number, etc.): incidental
// references in prose — entities capture them, prose is still compressible.
export const HARD_T0_REASONS = new Set([
  'code_fence',
  'indented_code',
  'json_structure',
  'yaml_structure',
  'high_special_char_ratio',
  'high_line_length_variance',
  'api_key',
  'latex_math',
  'unicode_math',
  'sql_content',
  'verse_pattern',
  'reasoning_chain',
  'base64_content',
  // Guardrail signals: failure context an agent must not lose across sessions
  'error_traceback',
  'http_error',
  'failure_signature',
]);

export function classifyMessage(content: string): ClassifyResult {
  const structural = detectStructuralPatterns(content);
  const contentTypes = detectContentTypes(content);
  const guardrails = detectGuardrailPatterns(content);

  const allReasons = [...structural.reasons, ...contentTypes.reasons, ...guardrails.reasons];
  const isT0 = structural.isT0 || contentTypes.isT0 || guardrails.isT0;

  let decision: ClassifyResult['decision'];
  let confidence: number;

  if (isT0) {
    decision = 'T0';
    confidence = Math.min(0.95, 0.7 + allReasons.length * 0.05);
  } else {
    decision = inferProseTier(content);
    confidence = 0.65;
  }

  return { decision, confidence, reasons: allReasons };
}
