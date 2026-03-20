/**
 * Conversation flow detection.
 *
 * Detects common conversation patterns (Q&A, request→action→confirmation,
 * correction chains) and groups them into compression units that produce
 * more coherent summaries than compressing individual messages.
 */

import type { Message } from './types.js';

export type FlowChain = {
  /** Indices of messages in this chain. */
  indices: number[];
  /** Type of conversation flow detected. */
  type: 'qa' | 'request_action' | 'correction' | 'acknowledgment';
  /** Brief description of what the chain represents. */
  label: string;
};

const QUESTION_RE = /\?(?:\s|$)/;
const REQUEST_RE =
  /\b(?:can you|could you|please|would you|I need|add|create|update|fix|change|modify|implement|remove|delete|make)\b/i;
const CONFIRMATION_RE =
  /^(?:great|perfect|thanks|thank you|awesome|looks good|lgtm|sounds good|yes|ok|okay|done|confirmed|approved|ship it)/i;
const CORRECTION_RE = /^(?:actually|wait|no[,.]|not that|instead|correction|sorry|my bad|I meant)/i;
const ACTION_RE =
  /\b(?:done|added|created|updated|fixed|changed|modified|implemented|removed|deleted|here['']?s|I['']ve)\b/i;

/**
 * Detect conversation flow chains in a message array.
 * Only analyzes messages outside the recency window (those eligible for compression).
 * Returns chains sorted by first message index.
 */
export function detectFlowChains(
  messages: Message[],
  recencyStart: number,
  preserveRoles: Set<string>,
): FlowChain[] {
  const chains: FlowChain[] = [];
  const claimed = new Set<number>();

  // Only look at messages before the recency window
  const eligible = (idx: number): boolean => {
    if (idx >= recencyStart) return false;
    if (claimed.has(idx)) return false;
    const m = messages[idx];
    if (m.role && preserveRoles.has(m.role)) return false;
    if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length < 10) return false;
    if (content.startsWith('[summary:') || content.startsWith('[summary#')) return false;
    // Don't include messages with code fences — they need code-split handling
    if (content.includes('```')) return false;
    return true;
  };

  for (let i = 0; i < recencyStart - 1; i++) {
    if (!eligible(i)) continue;

    const msg1 = messages[i];
    const content1 = typeof msg1.content === 'string' ? msg1.content : '';
    const role1 = msg1.role ?? '';

    // Look for patterns with the next eligible message
    for (let j = i + 1; j < Math.min(i + 4, recencyStart); j++) {
      if (!eligible(j)) continue;

      const msg2 = messages[j];
      const content2 = typeof msg2.content === 'string' ? msg2.content : '';
      const role2 = msg2.role ?? '';

      // Request → Action: user requests → assistant acts (check before Q&A since requests often contain ?)
      if (
        role1 === 'user' &&
        role2 === 'assistant' &&
        REQUEST_RE.test(content1) &&
        ACTION_RE.test(content2)
      ) {
        const chain: FlowChain = {
          indices: [i, j],
          type: 'request_action',
          label: `Request: ${content1.slice(0, 50).replace(/\n/g, ' ').trim()}`,
        };

        // Check for confirmation
        for (let k = j + 1; k < Math.min(j + 3, recencyStart); k++) {
          if (!eligible(k)) continue;
          const content3 = (messages[k].content as string | undefined) ?? '';
          if (CONFIRMATION_RE.test(content3.trim())) {
            chain.indices.push(k);
            break;
          }
        }

        for (const idx of chain.indices) claimed.add(idx);
        chains.push(chain);
        break;
      }

      // Q&A: user asks question → assistant answers
      if (
        role1 === 'user' &&
        role2 === 'assistant' &&
        QUESTION_RE.test(content1) &&
        !QUESTION_RE.test(content2)
      ) {
        const chain: FlowChain = {
          indices: [i, j],
          type: 'qa',
          label: `Q&A: ${content1.slice(0, 50).replace(/\n/g, ' ').trim()}`,
        };

        // Check for follow-up confirmation
        for (let k = j + 1; k < Math.min(j + 3, recencyStart); k++) {
          if (!eligible(k)) continue;
          const content3 = (messages[k].content as string | undefined) ?? '';
          if (CONFIRMATION_RE.test(content3.trim())) {
            chain.indices.push(k);
            break;
          }
        }

        for (const idx of chain.indices) claimed.add(idx);
        chains.push(chain);
        break;
      }

      // Correction: correction follows a statement
      if (role1 === role2 || (role1 === 'user' && role2 === 'assistant')) {
        if (CORRECTION_RE.test(content2.trim())) {
          const chain: FlowChain = {
            indices: [i, j],
            type: 'correction',
            label: `Correction: ${content2.slice(0, 50).replace(/\n/g, ' ').trim()}`,
          };
          for (const idx of chain.indices) claimed.add(idx);
          chains.push(chain);
          break;
        }
      }

      // Acknowledgment chain: short confirmations after substantive messages
      if (
        role2 !== role1 &&
        content1.length > 200 &&
        content2.length < 100 &&
        CONFIRMATION_RE.test(content2.trim())
      ) {
        const chain: FlowChain = {
          indices: [i, j],
          type: 'acknowledgment',
          label: `Ack: ${content1.slice(0, 50).replace(/\n/g, ' ').trim()}`,
        };
        for (const idx of chain.indices) claimed.add(idx);
        chains.push(chain);
        break;
      }
    }
  }

  return chains.sort((a, b) => a.indices[0] - b.indices[0]);
}

/**
 * Produce a flow-aware summary for a chain of messages.
 * Returns a summary that captures the conversational arc.
 */
export function summarizeChain(chain: FlowChain, messages: Message[]): string {
  const contents = chain.indices.map((idx) => {
    const m = messages[idx];
    return typeof m.content === 'string' ? m.content : '';
  });

  switch (chain.type) {
    case 'qa': {
      const question = contents[0].replace(/\n/g, ' ').trim();
      const answer = contents[1]?.replace(/\n/g, ' ').trim() ?? '';
      const qSnippet = question.length > 80 ? question.slice(0, 77) + '...' : question;
      const aSnippet = answer.length > 120 ? answer.slice(0, 117) + '...' : answer;
      const suffix = chain.indices.length > 2 ? ' (confirmed)' : '';
      return `Q: ${qSnippet} → A: ${aSnippet}${suffix}`;
    }
    case 'request_action': {
      const request = contents[0].replace(/\n/g, ' ').trim();
      const action = contents[1]?.replace(/\n/g, ' ').trim() ?? '';
      const rSnippet = request.length > 80 ? request.slice(0, 77) + '...' : request;
      const aSnippet = action.length > 120 ? action.slice(0, 117) + '...' : action;
      const suffix = chain.indices.length > 2 ? ' → confirmed' : '';
      return `Request: ${rSnippet} → ${aSnippet}${suffix}`;
    }
    case 'correction': {
      const correction = contents[1]?.replace(/\n/g, ' ').trim() ?? '';
      const cSnippet = correction.length > 150 ? correction.slice(0, 147) + '...' : correction;
      return `Correction: ${cSnippet}`;
    }
    case 'acknowledgment': {
      const substance = contents[0].replace(/\n/g, ' ').trim();
      const sSnippet = substance.length > 150 ? substance.slice(0, 147) + '...' : substance;
      return `${sSnippet} (acknowledged)`;
    }
  }
}
