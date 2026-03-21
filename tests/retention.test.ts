import { describe, it, expect } from 'vitest';
import {
  extractKeywords,
  extractEntities,
  extractStructural,
  analyzeRetention,
} from '../bench/baseline.js';

describe('retention analysis', () => {
  describe('extractKeywords', () => {
    it('catches camelCase identifiers', () => {
      const keywords = extractKeywords('The getUserProfile function calls createSession.');
      expect(keywords).toContain('getUserProfile');
      expect(keywords).toContain('createSession');
    });

    it('catches PascalCase identifiers', () => {
      const keywords = extractKeywords('Use the WebSocket and TypeScript classes.');
      expect(keywords).toContain('WebSocket');
      expect(keywords).toContain('TypeScript');
    });

    it('catches snake_case identifiers', () => {
      const keywords = extractKeywords('Set max_retries and connection_timeout in config.');
      expect(keywords).toContain('max_retries');
      expect(keywords).toContain('connection_timeout');
    });

    it('returns empty array for plain prose', () => {
      const keywords = extractKeywords('This is a simple sentence with no identifiers.');
      expect(keywords).toHaveLength(0);
    });
  });

  describe('extractEntities', () => {
    it('catches proper nouns', () => {
      const entities = extractEntities('Redis and Docker are commonly used tools.');
      expect(entities).toContain('Redis');
      expect(entities).toContain('Docker');
    });

    it('catches file paths', () => {
      const entities = extractEntities('Edit the file at /src/auth/middleware.ts');
      expect(entities.some((e) => e.includes('/src/auth/middleware.ts'))).toBe(true);
    });

    it('catches URLs', () => {
      const entities = extractEntities('See https://example.com/docs for details.');
      expect(entities.some((e) => e.includes('https://example.com/docs'))).toBe(true);
    });

    it('excludes common sentence starters', () => {
      const entities = extractEntities('The system handles requests. This is important.');
      // "The" and "This" are common starters, not entities
      expect(entities.every((e) => e !== 'The')).toBe(true);
      expect(entities.every((e) => e !== 'This')).toBe(true);
    });
  });

  describe('extractStructural', () => {
    it('catches code fences', () => {
      const markers = extractStructural('Before\n```ts\nconst x = 1;\n```\nAfter');
      expect(markers.some((m) => m.startsWith('```'))).toBe(true);
    });

    it('catches bullet points', () => {
      const markers = extractStructural('List:\n- First item\n- Second item\n- Third item');
      expect(markers.length).toBe(3);
    });

    it('catches numbered lists', () => {
      const markers = extractStructural('Steps:\n1. First step\n2. Second step');
      expect(markers.length).toBe(2);
    });

    it('returns empty for plain prose', () => {
      const markers = extractStructural('Just a simple paragraph of text.');
      expect(markers).toHaveLength(0);
    });
  });

  describe('analyzeRetention', () => {
    it('returns 1.0 for identical texts', () => {
      const text = 'The getUserProfile function calls createSession on the WebSocket server.';
      const result = analyzeRetention(text, text);
      expect(result.keywordRetention).toBe(1);
      expect(result.entityRetention).toBe(1);
      expect(result.structuralRetention).toBe(1);
    });

    it('returns correct keyword retention for partial match', () => {
      const original =
        'The getUserProfile and createSession functions handle WebSocket authentication.';
      const compressed = 'The getUserProfile function handles authentication.';
      const result = analyzeRetention(original, compressed);
      // getUserProfile retained, createSession lost, WebSocket lost
      expect(result.keywordRetention).toBeGreaterThan(0);
      expect(result.keywordRetention).toBeLessThan(1);
    });

    it('returns 1.0 for keyword retention when no keywords in original', () => {
      const result = analyzeRetention('Just a simple sentence.', 'A short summary.');
      expect(result.keywordRetention).toBe(1);
    });

    it('returns 1.0 for structural retention when no structural markers in original', () => {
      const result = analyzeRetention('Plain text.', 'Summary.');
      expect(result.structuralRetention).toBe(1);
    });

    it('detects structural loss when code fences are removed', () => {
      const original = 'Code:\n```ts\nconst x = 1;\n```\nEnd.';
      const compressed = 'Code summary with x = 1.';
      const result = analyzeRetention(original, compressed);
      expect(result.structuralRetention).toBe(0);
    });

    it('handles real compression scenario', () => {
      const original = `The getUserProfile middleware validates JWT tokens using the WebSocket connection.
It calls createSession for each authenticated user.

\`\`\`typescript
const token = jwt.verify(req.headers.authorization);
\`\`\`

- Check token expiry
- Validate signature
- Refresh if needed

See https://docs.example.com/auth for details.`;

      const compressed = `[summary: getUserProfile validates JWT tokens via WebSocket. | entities: getUserProfile, WebSocket, createSession]

\`\`\`typescript
const token = jwt.verify(req.headers.authorization);
\`\`\``;

      const result = analyzeRetention(original, compressed);
      // Keywords: getUserProfile, WebSocket, createSession — all in compressed
      expect(result.keywordRetention).toBeGreaterThan(0.5);
      // Code fences preserved
      expect(result.structuralRetention).toBeGreaterThan(0);
    });
  });
});
