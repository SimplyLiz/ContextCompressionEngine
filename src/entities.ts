import type { Message } from './types.js';

const COMMON_STARTERS = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'When',
  'Where',
  'What',
  'Which',
  'Who',
  'How',
  'Why',
  'Here',
  'There',
  'Now',
  'Then',
  'But',
  'And',
  'Or',
  'So',
  'If',
  'It',
  'Its',
  'My',
  'Your',
  'His',
  'Her',
  'Our',
  'They',
  'We',
  'You',
  'He',
  'She',
  'In',
  'On',
  'At',
  'To',
  'For',
  'With',
  'From',
  'As',
  'By',
  'An',
  'Each',
  'Every',
  'Some',
  'All',
  'Most',
  'Many',
  'Much',
  'Any',
  'No',
  'Not',
  'Also',
  'Just',
  'Only',
  'Even',
  'Still',
  'Yet',
  'Let',
  'See',
  'Note',
  'Yes',
  'Sure',
  'Great',
  'Thanks',
  'Well',
  'First',
  'Second',
  'Third',
  'Next',
  'Last',
  'Finally',
  'However',
  'After',
  'Before',
  'Since',
  'Once',
  'While',
  'Although',
  'Because',
  'Unless',
  'Until',
  'About',
  'Over',
  'Under',
  'Between',
  'Into',
]);

/**
 * Extract technical entities from text: identifiers, abbreviations, numbers with units.
 * Used for entity suffixes in summaries and for retention metrics.
 */
export function extractEntities(text: string, maxEntities?: number): string[] {
  const entities = new Set<string>();

  // Proper nouns: capitalized words not at common sentence starters
  const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  if (properNouns) {
    for (const noun of properNouns) {
      const first = noun.split(/\s+/)[0];
      if (!COMMON_STARTERS.has(first)) {
        entities.add(noun);
      }
    }
  }

  // PascalCase identifiers (TypeScript, WebSocket, JavaScript, etc.)
  const pascalCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (pascalCase) {
    for (const id of pascalCase) entities.add(id);
  }

  // camelCase identifiers
  const camelCase = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (camelCase) {
    for (const id of camelCase) entities.add(id);
  }

  // snake_case identifiers
  const snakeCase = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g);
  if (snakeCase) {
    for (const id of snakeCase) entities.add(id);
  }

  // Vowelless words (3+ consonants, no aeiou/y) — abbreviations/tool names: pnpm, npm, ssh, grpc
  const vowelless = text.match(/\b[bcdfghjklmnpqrstvwxz]{3,}\b/gi);
  if (vowelless) {
    for (const w of vowelless) entities.add(w.toLowerCase());
  }

  // Numbers with context
  const numbersCtx = text.match(
    /\b\d+(?:\.\d+)?\s*(?:seconds?|retries?|attempts?|MB|GB|TB|KB|ms|minutes?|hours?|days?|bytes?|workers?|threads?|nodes?|replicas?|instances?|users?|requests?|errors?|percent|%)\b/gi,
  );
  if (numbersCtx) {
    for (const n of numbersCtx) entities.add(n.trim());
  }

  // File paths (e.g., src/foo.ts, ./config.json)
  const filePaths = text.match(/(?:\.\/|\.\.\/)?\b[\w./-]+\.\w{1,6}\b/g);
  if (filePaths) {
    for (const fp of filePaths) {
      // Filter out common false positives (e.g., "e.g.", "i.e.")
      if (fp.length > 4 && !fp.match(/^[a-z]\.[a-z]\.$/)) {
        entities.add(fp);
      }
    }
  }

  // URLs
  const urls = text.match(/https?:\/\/\S+/g);
  if (urls) {
    for (const u of urls) entities.add(u);
  }

  // Version numbers (v1.2.3, 2.0.0)
  const versions = text.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g);
  if (versions) {
    for (const v of versions) entities.add(v);
  }

  const cap = maxEntities ?? Math.max(3, Math.min(Math.round(text.length / 200), 15));
  return Array.from(entities).slice(0, cap);
}

/**
 * Collect all unique entities from an array of messages.
 * Returns a Set for efficient intersection/union operations.
 */
export function collectMessageEntities(messages: Message[]): Set<string> {
  const all = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== 'string' || m.content.length === 0) continue;
    // Use a high cap so we don't artificially limit collection
    const entities = extractEntities(m.content, 500);
    for (const e of entities) all.add(e);
  }
  return all;
}

/**
 * Compute entity retention: fraction of input entities present in output.
 * Returns 1.0 when no entities exist in input (nothing to lose).
 */
export function computeEntityRetention(
  inputMessages: Message[],
  outputMessages: Message[],
): number {
  const inputEntities = collectMessageEntities(inputMessages);
  if (inputEntities.size === 0) return 1.0;

  const outputEntities = collectMessageEntities(outputMessages);
  let retained = 0;
  for (const e of inputEntities) {
    if (outputEntities.has(e)) retained++;
  }
  return retained / inputEntities.size;
}

/**
 * Count structural elements in text: code fences, JSON blocks, tables.
 */
export function countStructuralElements(text: string): number {
  let count = 0;
  // Code fences
  count += (text.match(/^[ ]{0,3}```/gm) ?? []).length / 2; // pairs
  // JSON blocks (standalone { or [)
  const jsonBlocks = text.match(/^\s*[{[]\s*$/gm);
  if (jsonBlocks) count += jsonBlocks.length;
  // Markdown tables (lines with |)
  const tableRows = text.match(/^\|.+\|$/gm);
  if (tableRows && tableRows.length >= 2) count += 1;
  return Math.floor(count);
}

/**
 * Compute structural integrity: fraction of structural elements preserved.
 * Returns 1.0 when no structural elements exist in input.
 */
export function computeStructuralIntegrity(
  inputMessages: Message[],
  outputMessages: Message[],
): number {
  let inputCount = 0;
  for (const m of inputMessages) {
    if (typeof m.content === 'string') inputCount += countStructuralElements(m.content);
  }
  if (inputCount === 0) return 1.0;

  let outputCount = 0;
  for (const m of outputMessages) {
    if (typeof m.content === 'string') outputCount += countStructuralElements(m.content);
  }
  return Math.min(outputCount / inputCount, 1.0);
}

/**
 * Check for orphaned references: identifiers in output that were defined
 * in input messages that got compressed away.
 * Returns coherence score 0–1 (1.0 = no orphans).
 */
export function computeReferenceCoherence(
  inputMessages: Message[],
  outputMessages: Message[],
): number {
  // Build a map: entity → set of message IDs where it appears in input
  const entitySources = new Map<string, Set<string>>();
  for (const m of inputMessages) {
    if (typeof m.content !== 'string') continue;
    const entities = extractEntities(m.content, 500);
    for (const e of entities) {
      if (!entitySources.has(e)) entitySources.set(e, new Set());
      entitySources.get(e)!.add(m.id);
    }
  }

  // Collect IDs of messages that survived in output
  const outputIds = new Set(outputMessages.map((m) => m.id));

  // For each entity in the output, check if at least one of its defining messages survived
  const outputEntities = collectMessageEntities(outputMessages);
  let total = 0;
  let coherent = 0;

  for (const e of outputEntities) {
    const sources = entitySources.get(e);
    if (!sources) continue; // entity only in output (e.g., from summary text) — skip
    total++;
    // Check if any source message is still in output
    let hasSource = false;
    for (const srcId of sources) {
      if (outputIds.has(srcId)) {
        hasSource = true;
        break;
      }
    }
    if (hasSource) coherent++;
  }

  return total === 0 ? 1.0 : coherent / total;
}

/**
 * Compute composite quality score combining entity retention, structural integrity,
 * and reference coherence.
 */
export function computeQualityScore(
  inputMessages: Message[],
  outputMessages: Message[],
): {
  entity_retention: number;
  structural_integrity: number;
  reference_coherence: number;
  quality_score: number;
} {
  const entity_retention = computeEntityRetention(inputMessages, outputMessages);
  const structural_integrity = computeStructuralIntegrity(inputMessages, outputMessages);
  const reference_coherence = computeReferenceCoherence(inputMessages, outputMessages);

  const quality_score = Math.min(
    entity_retention * 0.4 + structural_integrity * 0.4 + reference_coherence * 0.2,
    1.0,
  );

  return { entity_retention, structural_integrity, reference_coherence, quality_score };
}
