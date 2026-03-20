/**
 * Cross-message coreference tracking.
 *
 * Tracks entity references across messages so that when message B refers
 * to an entity defined in message A, compressing A doesn't orphan the
 * reference in B. Either A's definition is inlined into B's summary,
 * or A is promoted to preserved.
 */

import type { Message } from './types.js';

export type EntityDefinition = {
  /** The entity string (e.g., "fetchData", "auth_middleware"). */
  entity: string;
  /** Index of the message where this entity first appears. */
  definingMessageIndex: number;
  /** Indices of messages that reference this entity after its first appearance. */
  referencingMessageIndices: number[];
};

/**
 * Build a coreference map: for each entity, track where it's first defined
 * and which later messages reference it.
 *
 * Only tracks identifiers (camelCase, snake_case, PascalCase) — not generic
 * proper nouns, to avoid false positives.
 */
export function buildCoreferenceMap(messages: Message[]): EntityDefinition[] {
  const firstSeen = new Map<string, number>(); // entity → first message index
  const references = new Map<string, number[]>(); // entity → later message indices

  for (let i = 0; i < messages.length; i++) {
    const content = (messages[i].content as string | undefined) ?? '';
    if (content.length === 0) continue;

    const entities = extractIdentifiers(content);
    for (const entity of entities) {
      if (!firstSeen.has(entity)) {
        firstSeen.set(entity, i);
        references.set(entity, []);
      } else if (firstSeen.get(entity) !== i) {
        references.get(entity)!.push(i);
      }
    }
  }

  const result: EntityDefinition[] = [];
  for (const [entity, defIdx] of firstSeen) {
    const refs = references.get(entity)!;
    if (refs.length > 0) {
      result.push({
        entity,
        definingMessageIndex: defIdx,
        referencingMessageIndices: [...new Set(refs)],
      });
    }
  }

  return result;
}

/**
 * Extract only code-style identifiers (camelCase, snake_case, PascalCase).
 * More conservative than extractEntities — avoids proper nouns and abbreviations
 * to reduce false-positive coreference links.
 */
function extractIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();

  const camelCase = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (camelCase) for (const id of camelCase) ids.add(id);

  const pascalCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
  if (pascalCase) for (const id of pascalCase) ids.add(id);

  const snakeCase = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g);
  if (snakeCase) for (const id of snakeCase) ids.add(id);

  return ids;
}

/**
 * Given which messages are being compressed (by index), find entities
 * that would be orphaned: referenced in a kept message but defined
 * only in a compressed message.
 *
 * Returns a map: compressed message index → entities to inline from it.
 */
export function findOrphanedReferences(
  definitions: EntityDefinition[],
  compressedIndices: Set<number>,
  preservedIndices: Set<number>,
): Map<number, string[]> {
  const inlineMap = new Map<number, string[]>();

  for (const def of definitions) {
    // If the defining message is being compressed...
    if (!compressedIndices.has(def.definingMessageIndex)) continue;

    // ...and at least one referencing message is preserved
    const hasPreservedRef = def.referencingMessageIndices.some((idx) => preservedIndices.has(idx));
    if (!hasPreservedRef) continue;

    // For simplicity, always inline — it's cheap and prevents subtle context loss.
    if (!inlineMap.has(def.definingMessageIndex)) {
      inlineMap.set(def.definingMessageIndex, []);
    }
    inlineMap.get(def.definingMessageIndex)!.push(def.entity);
  }

  return inlineMap;
}

/**
 * Generate a compact inline definition for entities from a compressed message.
 * Used to prepend context to summaries so references aren't orphaned.
 */
export function generateInlineDefinitions(entities: string[], sourceContent: string): string {
  if (entities.length === 0) return '';

  // For each entity, find the sentence where it first appears
  const sentences = sourceContent.match(/[^.!?\n]+[.!?]+/g) ?? [sourceContent];
  const definitions: string[] = [];

  for (const entity of entities.slice(0, 5)) {
    // max 5 inlines
    const defining = sentences.find((s) => s.includes(entity));
    if (defining) {
      const trimmed = defining.trim();
      definitions.push(trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed);
    }
  }

  if (definitions.length === 0) return '';
  return `[context: ${definitions.join(' | ')}] `;
}
