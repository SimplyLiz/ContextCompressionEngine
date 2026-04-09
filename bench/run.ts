import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import { applyToolPrepass } from '../src/tool-prepass.js';
import { createSummarizer, createEscalatingSummarizer } from '../src/summarizer.js';
import type { CompressResult, Message } from '../src/types.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { detectProviders } from './llm.js';
import type {
  LlmBenchmarkResult,
  LlmMethodResult,
  LlmTokenBudgetResult,
  BenchmarkResults,
} from './baseline.js';
import {
  saveLlmResult,
  saveBaseline,
  loadCurrentBaseline,
  compareResults,
  formatRegressions,
  generateBenchmarkDocs,
  analyzeRetention,
} from './baseline.js';

// ---------------------------------------------------------------------------
// Auto-load .env (no dependency, won't override existing vars)
// ---------------------------------------------------------------------------

const envPath = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    // Strip wrapping quotes (single or double)
    const val = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = val;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function msg(role: string, content: string, extra?: Partial<Message>): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

function chars(messages: Message[]): number {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type Scenario = { name: string; messages: Message[] };

function buildScenarios(): Scenario[] {
  nextId = 1;

  return [
    codingAssistant(),
    longQA(),
    toolHeavy(),
    shortConversation(),
    deepConversation(),
    technicalExplanation(),
    structuredContent(),
    agenticCodingSession(),
  ];
}

function codingAssistant(): Scenario {
  const prose =
    'The authentication middleware validates incoming JWT tokens against the session store, checks expiration timestamps, and refreshes tokens when they are within the renewal window. ';
  return {
    name: 'Coding assistant',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),
      msg('user', 'How do I set up Express middleware for JWT auth?'),
      msg(
        'assistant',
        `${prose.repeat(3)}\n\n\`\`\`typescript\nimport jwt from 'jsonwebtoken';\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'No token' });\n  try {\n    req.user = jwt.verify(token, process.env.JWT_SECRET);\n    next();\n  } catch {\n    res.status(401).json({ error: 'Invalid token' });\n  }\n}\n\`\`\``,
      ),
      msg('user', 'Can you add refresh token rotation?'),
      msg(
        'assistant',
        `${prose.repeat(4)}\n\n\`\`\`typescript\nasync function rotateRefreshToken(oldToken: string) {\n  const payload = jwt.verify(oldToken, REFRESH_SECRET);\n  await revokeToken(oldToken);\n  return {\n    access: jwt.sign({ sub: payload.sub }, ACCESS_SECRET, { expiresIn: '15m' }),\n    refresh: jwt.sign({ sub: payload.sub }, REFRESH_SECRET, { expiresIn: '7d' }),\n  };\n}\n\`\`\``,
      ),
      msg('user', 'What about rate limiting?'),
      msg(
        'assistant',
        `Rate limiting prevents abuse by capping the number of requests a client can make in a time window. ${prose.repeat(3)}\n\n\`\`\`typescript\nimport rateLimit from 'express-rate-limit';\n\nconst limiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 100,\n  standardHeaders: true,\n});\napp.use('/api/', limiter);\n\`\`\``,
      ),
      msg('user', 'How do I test this?'),
      msg(
        'assistant',
        `Testing middleware requires mocking the request and response objects. ${prose.repeat(2)}\n\n\`\`\`typescript\nimport { describe, it, expect, vi } from 'vitest';\nimport { authMiddleware } from './auth';\n\ndescribe('authMiddleware', () => {\n  it('rejects missing token', () => {\n    const req = { headers: {} } as any;\n    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;\n    authMiddleware(req, res, vi.fn());\n    expect(res.status).toHaveBeenCalledWith(401);\n  });\n});\n\`\`\``,
      ),
      msg('user', 'Thanks, this is very helpful.'),
      msg('assistant', 'Happy to help. Let me know if you need anything else.'),
      msg('user', 'One more thing — should I store refresh tokens in Redis?'),
      msg(
        'assistant',
        `Redis is an excellent choice for refresh token storage because of its built-in TTL support and atomic operations. ${prose.repeat(3)} You can use the ioredis library for a robust connection pool.`,
      ),
    ],
  };
}

function longQA(): Scenario {
  const longAnswer =
    'The architecture of modern distributed systems relies on several foundational principles including service isolation, eventual consistency, and fault tolerance. Each service maintains its own data store, communicating through asynchronous message queues or synchronous RPC calls depending on latency requirements. Circuit breakers prevent cascading failures by monitoring error rates and temporarily halting requests to degraded downstream services. ';
  return {
    name: 'Long Q&A',
    messages: [
      msg('system', 'You are a software architecture consultant.'),
      msg('user', 'What is event sourcing?'),
      msg('assistant', longAnswer.repeat(4)),
      msg('user', 'How does CQRS relate to it?'),
      msg('assistant', longAnswer.repeat(5)),
      msg('user', 'What about saga patterns?'),
      msg('assistant', longAnswer.repeat(4)),
      msg('user', 'Can you compare choreography vs orchestration?'),
      msg('assistant', longAnswer.repeat(6)),
      msg('user', 'Which one should I use for payments?'),
      msg('assistant', longAnswer.repeat(3)),
    ],
  };
}

function toolHeavy(): Scenario {
  // Long prose tool result: pure T3 prose, >120 chars, no code fences / SQL / API keys / URLs / JSON
  const longProse =
    'The authentication service handles all user identity verification across the platform. ' +
    'When a request arrives, the service first checks the session store for an active session, ' +
    'then validates the token signature against the current signing key. If the token has expired ' +
    'but falls within the renewal window, the service automatically issues a fresh token pair. ' +
    'The service maintains a blocklist of revoked tokens in memory, synchronized across instances ' +
    'through a pub-sub channel. Failed authentication attempts are tracked per account to enable ' +
    'progressive lockout after repeated failures. The service also provides hooks for downstream ' +
    'middleware to attach additional claims or enforce fine-grained access policies based on ' +
    'resource ownership.';

  return {
    name: 'Tool-heavy',
    messages: [
      msg('system', 'You are a coding assistant with tool access.'),
      msg('user', 'Find all TypeScript files with auth in the name'),
      // Tool call 1: glob → JSON array (preserved: short JSON)
      msg('assistant', 'I will search for those files now.', {
        tool_calls: [
          { id: 'tc1', function: { name: 'glob', arguments: '{"pattern":"**/*auth*.ts"}' } },
        ],
      }),
      msg(
        'tool',
        '["src/auth.ts","src/middleware/auth.ts","tests/auth.test.ts","docs/auth-guide.md"]',
      ),
      // Tool call 2: read docs → long prose (compressed: T3)
      msg('assistant', 'Found 4 files. Let me read the documentation first.', {
        tool_calls: [
          { id: 'tc2', function: { name: 'read', arguments: '{"path":"docs/auth-guide.md"}' } },
        ],
      }),
      msg('tool', longProse),
      // Tool call 3: read SQL → SQL query (preserved: T0 sql_content)
      msg('assistant', 'Now let me check the database schema.', {
        tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{"path":"schema.sql"}' } }],
      }),
      msg(
        'tool',
        'SELECT u.id, u.email, u.created_at, r.name AS role_name\n' +
          'FROM users u\n' +
          'INNER JOIN user_roles ur ON ur.user_id = u.id\n' +
          'INNER JOIN roles r ON r.id = ur.role_id\n' +
          'WHERE u.active = true AND u.email_verified = true\n' +
          'ORDER BY u.created_at DESC',
      ),
      // Tool call 4: read env → API keys in plaintext config (preserved: T0 api_key + url)
      msg('assistant', 'Let me check the configuration.', {
        tool_calls: [
          { id: 'tc4', function: { name: 'read', arguments: '{"path":".env.example"}' } },
        ],
      }),
      msg(
        'tool',
        'STRIPE_SECRET_KEY=sk_live_abc123def456ghi789jkl012\n' +
          'GITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678\n' +
          'DATABASE_URL=postgresql://admin:secret@db.example.com:5432/myapp\n' +
          'REDIS_URL=redis://cache.example.com:6379',
      ),
      // Tool call 5: read code → code snippet (preserved: T0 structural)
      msg('assistant', 'Let me read the main auth module.', {
        tool_calls: [
          { id: 'tc5', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg(
        'tool',
        'import jwt from "jsonwebtoken";\n\nexport function verify(token: string) {\n  return jwt.verify(token, process.env.SECRET!);\n}\n\nexport function sign(payload: object) {\n  return jwt.sign(payload, process.env.SECRET!, { expiresIn: "1h" });\n}',
      ),
      // Tool call 6: edit → short status (preserved: short)
      msg('user', 'Can you add a test for expired tokens?'),
      msg('assistant', 'I will add an expiration test.', {
        tool_calls: [
          { id: 'tc6', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
        ],
      }),
      msg('tool', 'File updated successfully.'),
      msg('assistant', 'Done. The test file now includes an expiration test case.'),
      msg('user', 'Great, looks good.'),
      msg('assistant', 'Happy to help! Let me know if you need anything else.'),
    ],
  };
}

function shortConversation(): Scenario {
  return {
    name: 'Short conversation',
    messages: [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'What is 2+2?'),
      msg('assistant', '4'),
      msg('user', 'And 3+3?'),
      msg('assistant', '6'),
      msg('user', 'Thanks'),
      msg('assistant', 'You are welcome!'),
    ],
  };
}

function deepConversation(): Scenario {
  const topics = [
    'database schema design',
    'API endpoint structure',
    'authentication flow',
    'error handling strategy',
    'caching layer',
    'deployment pipeline',
    'monitoring setup',
    'testing approach',
    'code review process',
    'documentation standards',
    'performance profiling',
    'logging strategy',
    'feature flags',
    'data migration',
    'API versioning',
    'circuit breakers',
    'message queuing',
    'secrets management',
    'load balancing',
    'container orchestration',
    'service discovery',
    'observability',
    'incident response',
    'capacity planning',
    'access control',
  ];

  const messages: Message[] = [
    msg('system', 'You are a senior software architect helping plan a new microservice.'),
  ];

  for (let i = 0; i < 25; i++) {
    const topic = topics[i];
    messages.push(
      msg(
        'user',
        `Let's discuss the ${topic}. What patterns do you recommend for a high-traffic production service handling thousands of concurrent requests? ` +
          `We need to consider scalability, maintainability, and operational overhead. `.repeat(2),
      ),
    );
    messages.push(
      msg(
        'assistant',
        `For ${topic}, I recommend the following approach based on industry best practices and patterns I have seen succeed at scale. ` +
          `The key consideration is balancing complexity against the actual traffic patterns your service will encounter. ` +
          `You should start with a simpler architecture and evolve it as your requirements become clearer through production usage. `.repeat(
            4,
          ) +
          ` This approach has proven effective across multiple production deployments.`,
      ),
    );
  }

  return { name: 'Deep conversation', messages };
}

function technicalExplanation(): Scenario {
  // Prose-heavy architectural discussion — no code fences, no structured data.
  // Tests whether LLM summarization outperforms deterministic on pure technical prose.
  return {
    name: 'Technical explanation',
    messages: [
      msg('system', 'You are a principal engineer explaining system design to a new team lead.'),
      msg(
        'user',
        'Can you walk me through how our event-driven architecture works and why we chose it over a traditional request-response model?',
      ),
      msg(
        'assistant',
        'The event-driven architecture we adopted grew out of a series of scaling problems we ' +
          'encountered roughly two years ago when the monolith started buckling under peak traffic. ' +
          'The core idea is that services communicate through immutable events published to a central ' +
          'log rather than making synchronous calls to each other. When the order service completes a ' +
          'checkout, it publishes an OrderPlaced event. The inventory service, the notification ' +
          'service, and the analytics pipeline each consume that event independently and at their own ' +
          'pace. None of them need to know about the others, and none of them can block the order ' +
          'service from finishing its work.\n\n' +
          'The biggest advantage is temporal decoupling. Under the old model, a single slow downstream ' +
          'dependency could cascade latency across the entire checkout flow. A payment verification ' +
          'that normally took fifty milliseconds would occasionally spike to several seconds, and ' +
          'because every call was synchronous, the user sat waiting while six services completed in ' +
          'sequence. With events, the order service does its own work, publishes, and returns. ' +
          'Downstream processing happens asynchronously, so the user experience stays fast even when ' +
          'one consumer is struggling.\n\n' +
          'The trade-off is eventual consistency. In a synchronous model, you get immediate confirmation ' +
          'that every step completed. In an event-driven model, you have to design for the possibility ' +
          'that the inventory adjustment or the email notification has not happened yet when the user ' +
          'sees their confirmation page. We handle this through careful UX design that sets appropriate ' +
          'expectations and through idempotent consumers that can safely replay events if something ' +
          'goes wrong during processing.',
      ),
      msg(
        'user',
        'That makes sense. What about the event schema evolution problem? How do we handle ' +
          'changes to event formats without breaking all the consumers?',
      ),
      msg(
        'assistant',
        'Schema evolution is one of the hardest problems in event-driven systems and we spent ' +
          'considerable time getting our approach right. We settled on a strategy that combines ' +
          'explicit versioning with backward-compatible evolution rules. Every event type carries a ' +
          'schema version number in its header. Consumers declare which versions they understand, and ' +
          'the platform routes accordingly.\n\n' +
          'For non-breaking changes like adding a new optional field, we increment the minor version. ' +
          'Consumers that do not understand the new field simply ignore it. This follows the robustness ' +
          'principle of being conservative in what you send and liberal in what you accept. The vast ' +
          'majority of our schema changes fall into this category, and they require zero coordination ' +
          'between teams.\n\n' +
          'For breaking changes like removing a field or changing a field type, we increment the major ' +
          'version and run both the old and new versions in parallel during a migration window. The ' +
          'producing service publishes to both versions, and consuming teams migrate on their own ' +
          'schedule within the agreed window. Once all consumers have migrated, we sunset the old ' +
          'version. This approach adds operational complexity but gives teams the autonomy to migrate ' +
          'at their own pace without coordinated deployment ceremonies.\n\n' +
          'We also maintain a central schema registry that validates events at publish time. If a ' +
          'service tries to publish an event that does not conform to its declared schema, the publish ' +
          'fails fast with a clear error. This catches drift between the code and the schema before ' +
          'it reaches consumers and prevents subtle data corruption that would be much harder to ' +
          'diagnose after the fact.',
      ),
      msg(
        'user',
        'How do we handle ordering guarantees? I noticed some of our consumers seem to ' +
          'process events out of order.',
      ),
      msg(
        'assistant',
        'Ordering is subtle in distributed event systems and the right answer depends on what ' +
          'level of ordering your consumer actually needs. Our event platform guarantees ordering ' +
          'within a partition, but not across partitions. Events for the same aggregate, like all ' +
          'events for a specific order, go to the same partition based on the aggregate identifier, ' +
          'so they arrive in the order they were published. Events for different aggregates may arrive ' +
          'in any order because they live on different partitions processed by different consumer ' +
          'instances.\n\n' +
          'Most consumers only care about ordering within an aggregate and they get it for free from ' +
          'the partitioning scheme. The inventory service needs to see OrderPlaced before OrderCancelled ' +
          'for the same order, and it does because both events share the same order identifier as their ' +
          'partition key. But it does not care whether order A events arrive before or after order B ' +
          'events because those are independent aggregates.\n\n' +
          'For the rare cases where a consumer needs cross-aggregate ordering, we use a sequence ' +
          'number stamped by the producer at publish time. The consumer tracks the last processed ' +
          'sequence number and detects gaps. When it encounters a gap, it buffers the event and waits ' +
          'briefly for the missing one to arrive. If the missing event does not appear within the ' +
          'timeout window, the consumer raises an alert and proceeds with compensating logic. This ' +
          'approach adds latency in the gap case but preserves correctness.\n\n' +
          'The consumers you noticed processing out of order are likely reading from a topic that ' +
          'mixes events from multiple aggregates. Check whether the partition key is set correctly ' +
          'on the producer side. A common mistake is using a random or missing partition key, which ' +
          'causes round-robin assignment and destroys any ordering guarantee.',
      ),
      msg(
        'user',
        'What about failure handling? If a consumer crashes mid-processing, do we lose events?',
      ),
      msg(
        'assistant',
        'No, the platform guarantees at-least-once delivery. When a consumer reads an event, it ' +
          'does not acknowledge the read until processing completes successfully. If the consumer ' +
          'crashes before acknowledging, the event remains available for redelivery. The next time ' +
          'the consumer starts up, or when another instance in the consumer group takes over the ' +
          'partition, it picks up from the last acknowledged position.\n\n' +
          'The flip side of at-least-once delivery is that consumers must be idempotent. They will ' +
          'occasionally see the same event twice, particularly after a crash or during a rebalance. ' +
          'We enforce idempotency through a combination of techniques depending on the consumer. ' +
          'Some use a deduplication table that records processed event identifiers and skips any event ' +
          'it has seen before. Others design their state mutations to be naturally idempotent, for ' +
          'example using upserts instead of inserts or applying absolute values instead of deltas.\n\n' +
          'Dead letter queues catch events that fail processing repeatedly. After a configurable number ' +
          'of retries with exponential backoff, the platform moves the event to a dead letter topic ' +
          'and advances the consumer offset so it does not block subsequent events. The operations team ' +
          'monitors the dead letter queue and investigates failures. Once the root cause is fixed, they ' +
          'can replay events from the dead letter queue back into the main topic.\n\n' +
          'We also run a reconciliation process that periodically compares the state derived from ' +
          'events against the source of truth in the originating service. This catches any silent data ' +
          'loss or corruption that might slip through the cracks. The reconciler runs daily during off-' +
          'peak hours and flags discrepancies for manual review.',
      ),
      msg(
        'user',
        'One more thing — how do we test all of this? Integration testing with events seems ' +
          'really hard.',
      ),
      msg(
        'assistant',
        'Testing event-driven systems requires a layered approach because no single testing ' +
          'strategy covers all the failure modes. At the unit level, each consumer is tested with ' +
          'synthetic events that exercise the happy path, edge cases, and error paths. These tests ' +
          'run in milliseconds and give fast feedback on business logic correctness.\n\n' +
          'At the integration level, we run each service against a local instance of the event ' +
          'platform. The test publishes events, waits for the consumer to process them, and verifies ' +
          'the resulting state. These tests are slower but catch serialization issues, schema ' +
          'mismatches, and configuration problems that unit tests miss. We keep the integration test ' +
          'suite focused on the boundaries: publishing, consuming, and acknowledging. Internal ' +
          'business logic is covered at the unit level.\n\n' +
          'At the system level, we maintain a staging environment that mirrors production topology. ' +
          'Every deployment goes through staging first, where we run end-to-end scenarios that ' +
          'exercise the full event flow from producer through all consumers. These tests use realistic ' +
          'data volumes and introduce controlled failures like consumer crashes and network partitions ' +
          'to verify that the retry and dead-letter mechanisms work correctly.\n\n' +
          'Contract testing bridges the gap between producers and consumers without requiring a ' +
          'shared integration environment. Each consumer publishes a contract describing the events ' +
          'it expects, and the producer runs those contracts as part of its build. If a producer ' +
          'change would break a consumer contract, the build fails before the change reaches any ' +
          'shared environment. This is particularly valuable in our setup where different teams own ' +
          "different services and may not be aware of each other's dependencies.",
      ),
    ],
  };
}

function structuredContent(): Scenario {
  // Pure prose about auth (~1500 chars): no code, URLs, SQL, API keys, JSON, paths, etc.
  const authProse =
    'Setting up authentication for a production environment requires careful planning across ' +
    'several layers of the system. The first step is establishing a strong identity provider ' +
    'that supports modern protocols. You will want to implement token-based authentication ' +
    'with short-lived access tokens and longer-lived refresh tokens stored securely on the ' +
    'client side. The server should validate tokens on every request through middleware that ' +
    'sits early in the request pipeline.\n\n' +
    'Password hashing should use a modern algorithm with appropriate cost factors that balance ' +
    'security against response time. Each user account should have a unique salt generated at ' +
    'registration time. The system should enforce minimum password complexity requirements ' +
    'without being overly restrictive, as research shows that overly strict rules often lead ' +
    'to weaker passwords in practice.\n\n' +
    'Session management needs to handle concurrent logins gracefully. You should decide whether ' +
    'to allow multiple active sessions per user or enforce single-session access. Each session ' +
    'should track the originating device and location to help users audit their account activity. ' +
    'Inactive sessions should expire automatically after a configurable timeout period.\n\n' +
    'Rate limiting on authentication endpoints is essential to prevent brute force attacks. ' +
    'Implement progressive delays after failed attempts, starting with short pauses and increasing ' +
    'exponentially. After a threshold of failures, temporarily lock the account and notify the ' +
    'user through an out-of-band channel. Keep detailed logs of all authentication events for ' +
    'security auditing and incident response.';

  // Pure prose about monitoring (~1200 chars): same constraints as above
  const monitoringProse =
    'Monitoring a production environment effectively means collecting metrics at every layer of ' +
    'the stack and correlating them to build a complete picture of system health. Start with ' +
    'infrastructure metrics like memory utilization, disk throughput, and network latency across ' +
    'all nodes in the cluster. These baseline metrics help you understand normal operating ' +
    'patterns so you can detect anomalies quickly.\n\n' +
    'Application-level metrics should track request rates, error rates, and response time ' +
    'distributions. Percentile-based measurements give a much more accurate picture than simple ' +
    'averages, which can mask problems affecting a subset of users. Track these metrics per ' +
    'endpoint to identify which parts of the system are under strain.\n\n' +
    'Log aggregation brings all service output into a single searchable store that lets you ' +
    'trace requests across service boundaries. Each log entry should carry a correlation ' +
    'identifier that follows the request starting at ingress through to the final response. ' +
    'This makes debugging distributed failures dramatically easier than searching individual ' +
    'service logs.\n\n' +
    'Alerting rules should be tuned to minimize noise while catching real incidents. Start with ' +
    'broad thresholds and tighten them as you learn what normal looks like for your system. Every ' +
    'alert should have a clear runbook that describes what the responder should check first and ' +
    'what remediation steps to take.';

  return {
    name: 'Structured content',
    messages: [
      msg('system', 'You are a DevOps consultant helping set up a production environment.'),
      msg('user', 'Set up our production environment with all the credentials.'),
      // Env block with API keys in plaintext config (preserved: T0 api_key)
      msg(
        'assistant',
        'Here are the environment variables you need to configure:\n\n' +
          'STRIPE_SECRET_KEY=sk_live_Rz4x8Kp2Qm7Yn3Wv9Bt6Jh0L\n' +
          'GITHUB_TOKEN=ghp_Mn3Kx8Rz4Qp7Yv2Wt9Bj6Lh0Ds5Fa1Gc8Eu4Iw\n' +
          'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
          'SENDGRID_API_KEY=SG.xY7kZmN2pQ9rS4tU6vW8aB.cD3eF5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7f',
      ),
      msg('user', 'What about the database schema?'),
      // SQL DDL (preserved: T0 sql_content)
      msg(
        'assistant',
        'Here is the initial schema for the audit log:\n\n' +
          'CREATE TABLE audit_logs (\n' +
          '  id SERIAL PRIMARY KEY,\n' +
          '  user_id INTEGER NOT NULL,\n' +
          '  action VARCHAR(100) NOT NULL,\n' +
          '  resource_type VARCHAR(50),\n' +
          '  resource_id INTEGER,\n' +
          '  details TEXT,\n' +
          '  created_at TIMESTAMP DEFAULT NOW(),\n' +
          '  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE\n' +
          ');',
      ),
      msg('user', 'How should we handle authentication?'),
      // Long prose about auth (compressed: T3)
      msg('assistant', authProse),
      msg('user', 'What about monitoring?'),
      // Long prose about monitoring (compressed: T3)
      msg('assistant', monitoringProse),
      msg('user', 'Show me a dashboard configuration.'),
      // JSON in code fence (preserved: T0 code_fence)
      msg(
        'assistant',
        'Here is a starter dashboard configuration:\n\n' +
          '```json\n' +
          '{\n' +
          '  "dashboard": "production-overview",\n' +
          '  "refresh_interval": 30,\n' +
          '  "panels": [\n' +
          '    { "title": "Request Rate", "type": "graph", "metric": "http_requests_total" },\n' +
          '    { "title": "Error Rate", "type": "graph", "metric": "http_errors_total" },\n' +
          '    { "title": "P99 Latency", "type": "gauge", "metric": "http_duration_p99" }\n' +
          '  ]\n' +
          '}\n' +
          '```',
      ),
      msg('user', 'Thanks, this is exactly what I needed.'),
    ],
  };
}

function agenticCodingSession(): Scenario {
  // Simulates a realistic agentic coding session with repeated file reads,
  // grep results, test output, and linter output across edit-test-fix cycles.

  const authModule =
    'import jwt from "jsonwebtoken";\nimport { Request, Response, NextFunction } from "express";\n\n' +
    'interface JWTPayload {\n  sub: string;\n  email: string;\n  roles: string[];\n  iat: number;\n  exp: number;\n}\n\n' +
    'export class AuthService {\n  private readonly secret: string;\n  private readonly refreshSecret: string;\n\n' +
    '  constructor(secret: string, refreshSecret: string) {\n    this.secret = secret;\n    this.refreshSecret = refreshSecret;\n  }\n\n' +
    '  verify(token: string): JWTPayload {\n    return jwt.verify(token, this.secret) as JWTPayload;\n  }\n\n' +
    '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {\n    return jwt.sign(payload, this.secret, { expiresIn: "15m" });\n  }\n\n' +
    '  signRefresh(payload: { sub: string }): string {\n    return jwt.sign(payload, this.refreshSecret, { expiresIn: "7d" });\n  }\n\n' +
    '  middleware(req: Request, res: Response, next: NextFunction): void {\n    const header = req.headers.authorization;\n' +
    '    if (!header?.startsWith("Bearer ")) {\n      res.status(401).json({ error: "Missing token" });\n      return;\n    }\n' +
    '    try {\n      (req as any).user = this.verify(header.slice(7));\n      next();\n    } catch {\n' +
    '      res.status(401).json({ error: "Invalid token" });\n    }\n  }\n}\n';

  // Near-duplicate: method renamed verify → validateToken, comment added
  const authModuleV2 =
    'import jwt from "jsonwebtoken";\nimport { Request, Response, NextFunction } from "express";\n\n' +
    'interface JWTPayload {\n  sub: string;\n  email: string;\n  roles: string[];\n  iat: number;\n  exp: number;\n}\n\n' +
    'export class AuthService {\n  private readonly secret: string;\n  private readonly refreshSecret: string;\n\n' +
    '  constructor(secret: string, refreshSecret: string) {\n    this.secret = secret;\n    this.refreshSecret = refreshSecret;\n  }\n\n' +
    '  // Validates token and returns decoded payload\n' +
    '  validateToken(token: string): JWTPayload {\n    return jwt.verify(token, this.secret) as JWTPayload;\n  }\n\n' +
    '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {\n    return jwt.sign(payload, this.secret, { expiresIn: "15m" });\n  }\n\n' +
    '  signRefresh(payload: { sub: string }): string {\n    return jwt.sign(payload, this.refreshSecret, { expiresIn: "7d" });\n  }\n\n' +
    '  middleware(req: Request, res: Response, next: NextFunction): void {\n    const header = req.headers.authorization;\n' +
    '    if (!header?.startsWith("Bearer ")) {\n      res.status(401).json({ error: "Missing token" });\n      return;\n    }\n' +
    '    try {\n      (req as any).user = this.validateToken(header.slice(7));\n      next();\n    } catch {\n' +
    '      res.status(401).json({ error: "Invalid token" });\n    }\n  }\n}\n';

  // Near-duplicate V3: added revokeToken method, updated expiresIn
  const authModuleV3 =
    'import jwt from "jsonwebtoken";\nimport { Request, Response, NextFunction } from "express";\n\n' +
    'interface JWTPayload {\n  sub: string;\n  email: string;\n  roles: string[];\n  iat: number;\n  exp: number;\n}\n\n' +
    'export class AuthService {\n  private readonly secret: string;\n  private readonly refreshSecret: string;\n\n' +
    '  constructor(secret: string, refreshSecret: string) {\n    this.secret = secret;\n    this.refreshSecret = refreshSecret;\n  }\n\n' +
    '  // Validates token and returns decoded payload\n' +
    '  validateToken(token: string): JWTPayload {\n    return jwt.verify(token, this.secret) as JWTPayload;\n  }\n\n' +
    '  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {\n    return jwt.sign(payload, this.secret, { expiresIn: "30m" });\n  }\n\n' +
    '  signRefresh(payload: { sub: string }): string {\n    return jwt.sign(payload, this.refreshSecret, { expiresIn: "7d" });\n  }\n\n' +
    '  async revokeToken(token: string): Promise<void> {\n    // Add token to blocklist\n  }\n\n' +
    '  middleware(req: Request, res: Response, next: NextFunction): void {\n    const header = req.headers.authorization;\n' +
    '    if (!header?.startsWith("Bearer ")) {\n      res.status(401).json({ error: "Missing token" });\n      return;\n    }\n' +
    '    try {\n      (req as any).user = this.validateToken(header.slice(7));\n      next();\n    } catch {\n' +
    '      res.status(401).json({ error: "Invalid token" });\n    }\n  }\n}\n';

  const grepResults =
    'src/auth.ts:18:  verify(token: string): JWTPayload {\n' +
    'src/auth.ts:22:    return jwt.verify(token, this.secret) as JWTPayload;\n' +
    'src/middleware/validate.ts:7:  const decoded = authService.verify(req.headers.authorization!);\n' +
    'src/middleware/validate.ts:12:  if (!decoded) throw new UnauthorizedError("Token verification failed");\n' +
    'src/routes/admin.ts:34:    const user = auth.verify(token);\n' +
    'src/routes/admin.ts:35:    if (!user.roles.includes("admin")) return res.status(403).json({ error: "Forbidden" });\n' +
    'tests/auth.test.ts:14:      const payload = service.verify(token);\n' +
    'tests/auth.test.ts:22:      expect(() => service.verify(expired)).toThrow();\n' +
    'tests/integration/auth.integration.ts:45:    const result = authService.verify(response.body.token);\n';

  const testOutput =
    ' RUN  v1.6.0 /project\n\n' +
    ' ✓ tests/auth.test.ts (5 tests) 42ms\n' +
    '   ✓ AuthService > sign and verify > produces a valid JWT\n' +
    '   ✓ AuthService > sign and verify > rejects expired tokens\n' +
    '   ✓ AuthService > middleware > rejects missing auth header\n' +
    '   ✓ AuthService > middleware > attaches user to request on valid token\n' +
    '   ✗ AuthService > refresh > rotates token correctly\n' +
    '     → expected "user1" but got undefined\n' +
    '     at tests/auth.test.ts:48:22\n\n' +
    ' Test Files  1 passed | 0 failed\n' +
    ' Tests  4 passed | 1 failed\n' +
    ' Duration  1.34s\n';

  const lintOutput =
    'src/auth.ts\n' +
    '  18:3  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n' +
    '  31:7  warning  Missing return type on function            @typescript-eslint/explicit-function-return-type\n' +
    '  42:5  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n\n' +
    'tests/auth.test.ts\n' +
    '  8:24  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n' +
    '  9:24  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n\n' +
    '✖ 5 problems (0 errors, 5 warnings)\n';

  return {
    name: 'Agentic coding session',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),

      // --- Phase 1: Initial exploration (file reads) ---
      msg('user', 'Read the auth module and tell me what it does.'),
      msg('assistant', 'Let me read that file.', {
        tool_calls: [
          { id: 'tc1', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg('tool', authModule), // 1st read of auth.ts
      msg(
        'assistant',
        'This is an AuthService class that handles JWT authentication with access and refresh tokens, plus Express middleware.',
      ),

      // --- Phase 2: Grep for usages ---
      msg('user', 'Search the codebase for all usages of validateToken.'),
      msg('assistant', 'Searching for validateToken references.', {
        tool_calls: [
          {
            id: 'tc2',
            function: {
              name: 'grep',
              arguments: '{"pattern":"validateToken|verify.*token","path":"src/"}',
            },
          },
        ],
      }),
      msg('tool', grepResults), // 1st grep
      msg(
        'assistant',
        'Found 9 references across auth.ts, validate.ts middleware, admin routes, and tests.',
      ),

      // --- Phase 3: Edit and test (first cycle) ---
      msg('user', 'Add a test for refresh token rotation.'),
      msg('assistant', 'Let me re-read the auth module to check the method signature.', {
        tool_calls: [
          { id: 'tc3', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg('tool', authModuleV2), // 2nd read of auth.ts — NEAR-DUPLICATE (method renamed)
      msg('assistant', 'The signRefresh method takes { sub: string }. Adding the rotation test.', {
        tool_calls: [
          { id: 'tc4', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
        ],
      }),
      msg('tool', 'File updated successfully.'), // short — stays below dedup threshold

      // --- Phase 4: Run tests (fail) ---
      msg('user', 'Run the tests.'),
      msg('assistant', 'Running the test suite.', {
        tool_calls: [
          { id: 'tc5', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testOutput), // 1st test output — shows failure

      // --- Phase 5: Fix and re-test ---
      msg(
        'assistant',
        'The rotation test failed — decoded payload is undefined. Let me check the verify call in the test.',
        {
          tool_calls: [
            { id: 'tc6', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
          ],
        },
      ),
      msg('tool', authModuleV3), // 3rd read of auth.ts — NEAR-DUPLICATE (method added)
      msg(
        'assistant',
        'Found it. The test was calling verify with the refresh token but using the access secret. Fixing.',
        {
          tool_calls: [
            { id: 'tc7', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
          ],
        },
      ),
      msg('tool', 'Updated tests/auth.test.ts'), // short

      // --- Phase 6: Lint check ---
      msg('user', 'Run the linter before we test again.'),
      msg('assistant', 'Running eslint.', {
        tool_calls: [
          { id: 'tc8', function: { name: 'exec', arguments: '{"cmd":"npx eslint src/ tests/"}' } },
        ],
      }),
      msg('tool', lintOutput), // 1st lint output

      // --- Phase 7: Re-run tests (still failing differently) ---
      msg('assistant', 'There are 5 warnings but no errors. Running tests again.', {
        tool_calls: [
          { id: 'tc9', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testOutput), // 2nd test output — DUPLICATE (same results)

      // --- Phase 8: Another grep to find related code ---
      msg(
        'assistant',
        'Still failing. Let me search for verify references again to check the middleware path.',
        {
          tool_calls: [
            {
              id: 'tc10',
              function: {
                name: 'grep',
                arguments: '{"pattern":"validateToken|verify.*token","path":"src/"}',
              },
            },
          ],
        },
      ),
      msg('tool', grepResults), // 2nd grep — DUPLICATE

      // --- Phase 9: Fix, lint, and final test ---
      msg(
        'assistant',
        'The issue is in the middleware — it also calls verify. Let me fix the test to use the correct secret.',
        {
          tool_calls: [
            { id: 'tc11', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
          ],
        },
      ),
      msg('tool', 'File updated successfully.'), // short
      msg('user', 'Lint and test again.'),
      msg('assistant', 'Running lint.', {
        tool_calls: [
          { id: 'tc12', function: { name: 'exec', arguments: '{"cmd":"npx eslint src/ tests/"}' } },
        ],
      }),
      msg('tool', lintOutput), // 2nd lint output — DUPLICATE

      msg('assistant', 'Same warnings, no new issues. Running tests.', {
        tool_calls: [
          { id: 'tc13', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testOutput), // 3rd test output — DUPLICATE
      msg(
        'assistant',
        'All 5 tests passing now. The rotation test verifies the new token contains the original subject claim.',
      ),
      msg('user', 'Nice, looks good.'),
    ],
  };
}

function agentToolPrepassHeavy(): Scenario {
  // Scenario designed to exercise all three AgentDiet pre-pass categories:
  //   Cat 1: verbose output (npm noise, directory tree, build steps, 30+ test pass lines)
  //   Cat 2: echoed content (assistant shows file content → tool echoes it back)
  //   Cat 3: expired file read (large file read superseded by a later write)

  // 15 npm warn/notice lines → stripped (threshold: 3)
  const npmInstallOutput = [
    'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
    'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported.',
    'npm warn deprecated @humanwhocodes/config-array@0.13.0: Use @eslint/config-array instead.',
    'npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported.',
    'npm warn deprecated @humanwhocodes/object-schema@2.0.3: Use @eslint/object-schema instead.',
    'npm notice created tarball: package.tgz',
    'npm notice tarball contents: 12 files, 284.5 kB',
    'npm warn peer dep missing: react@>=16, required by react-dom@18.2.0',
    'npm warn ERESOLVE overriding peer dependency',
    'npm warn While resolving: foo@1.0.0',
    'npm warn Found: bar@2.0.0',
    'npm notice Publishing to https://registry.npmjs.org/ with tag latest and no access',
    'npm warn deprecated lodash@4.17.21: Critical security vulnerability.',
    'npm warn peer dep missing: typescript@>=4.7, required by ts-node@10.9.2',
    'npm warn deprecated source-map-url@0.4.1: See https://github.com/lydell/source-map-url',
    'added 847 packages, and audited 848 packages in 12s',
    'found 0 vulnerabilities',
  ].join('\n');

  // 22 directory tree lines for node_modules → collapsed
  const dirListingOutput = [
    'project/',
    '├── node_modules/.package-lock.json',
    '├── node_modules/accepts',
    '├── node_modules/acorn',
    '├── node_modules/acorn-jsx',
    '├── node_modules/ajv',
    '│   ├── node_modules/json-schema-traverse',
    '│   └── node_modules/fast-deep-equal',
    '├── node_modules/ansi-regex',
    '├── node_modules/ansi-styles',
    '├── node_modules/argparse',
    '├── node_modules/array-flatten',
    '├── node_modules/balanced-match',
    '├── node_modules/brace-expansion',
    '├── node_modules/braces',
    '├── node_modules/browser-stdout',
    '├── node_modules/c8',
    '├── node_modules/callsites',
    '├── node_modules/camelcase',
    '├── node_modules/chalk',
    '│   └── node_modules/ansi-styles',
    '└── node_modules/chokidar',
    '├── src/',
    '│   ├── index.ts',
    '│   └── auth.ts',
    '└── tests/',
  ].join('\n');

  // 10 build steps → first + last kept, middle collapsed
  const buildStepsOutput =
    Array.from(
      { length: 10 },
      (_, i) =>
        `[${i + 1}/10] Compiling ${['src/index.ts', 'src/auth.ts', 'src/types.ts', 'src/utils.ts', 'src/middleware.ts', 'src/routes.ts', 'src/db.ts', 'src/cache.ts', 'src/logger.ts', 'src/config.ts'][i]}`,
    ).join('\n') + '\nBuild succeeded in 4.2s';

  // 32 passing test lines + summary → stripped (threshold: 10)
  const testRunOutput =
    ' RUN  v4.1.0 /project\n\n' +
    Array.from(
      { length: 32 },
      (_, i) =>
        `  ✓ AuthService > ${['sign', 'verify', 'refresh', 'middleware', 'rateLimit', 'blocklist', 'claims', 'expiry'][i % 8]} > test case ${Math.floor(i / 8) + 1} passes`,
    ).join('\n') +
    '\n\n Test Files  4 passed\n Tests: 32 passed, 0 failed\n Duration  2.1s\n';

  // Large file content (>2000 chars) that will be superseded by a write
  const configFileContent =
    '// config.ts — application configuration\n' +
    'export const config = {\n' +
    '  port: 3000,\n' +
    '  host: "0.0.0.0",\n' +
    '  database: {\n' +
    '    host: "localhost",\n' +
    '    port: 5432,\n' +
    '    name: "myapp",\n' +
    '    pool: { min: 2, max: 10, idleTimeoutMillis: 30000 },\n' +
    '  },\n' +
    '  redis: { host: "localhost", port: 6379, ttl: 3600 },\n' +
    '  jwt: { secret: process.env.JWT_SECRET!, expiresIn: "15m", refreshExpiresIn: "7d" },\n' +
    '  rateLimit: { windowMs: 15 * 60 * 1000, max: 100 },\n' +
    '  cors: { origin: ["https://app.example.com"], credentials: true },\n' +
    '  logging: { level: "info", format: "json", destination: "stdout" },\n' +
    '  features: { betaUsers: false, newDashboard: false, analyticsV2: true },\n' +
    '};\n\n' +
    '// Validation\n' +
    'if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");\n' +
    'if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");\n'.repeat(50);

  // Content echoed back by a tool (assistant shows it; tool echoes verbatim)
  const sharedCodeBlock =
    'export function validateRequest(schema: ZodSchema) {\n' +
    '  return (req: Request, res: Response, next: NextFunction) => {\n' +
    '    const result = schema.safeParse(req.body);\n' +
    '    if (!result.success) {\n' +
    '      return res.status(400).json({ errors: result.error.flatten() });\n' +
    '    }\n' +
    '    req.body = result.data;\n' +
    '    next();\n' +
    '  };\n' +
    '}\n\n' +
    '// Additional validation helpers used across multiple routes.\n' +
    'export const userSchema = z.object({ email: z.string().email(), password: z.string().min(8) });\n' +
    'export const loginSchema = z.object({ email: z.string().email(), password: z.string() });\n' +
    'export const refreshSchema = z.object({ refreshToken: z.string().min(10) });\n';

  return {
    name: 'Agent prepass heavy',
    messages: [
      msg('system', 'You are a senior TypeScript developer with tool access.'),

      // Phase 1: npm install (cat 1 — package manager noise)
      msg('user', 'Install the project dependencies.'),
      msg('assistant', 'Running npm install.', {
        tool_calls: [{ id: 'tc1', function: { name: 'exec', arguments: '{"cmd":"npm install"}' } }],
      }),
      msg('tool', npmInstallOutput),

      // Phase 2: list project files (cat 1 — directory tree)
      msg('user', 'Show me the project structure.'),
      msg('assistant', 'Listing the directory tree.', {
        tool_calls: [{ id: 'tc2', function: { name: 'exec', arguments: '{"cmd":"ls -R"}' } }],
      }),
      msg('tool', dirListingOutput),

      // Phase 3: build (cat 1 — build step counters)
      msg('user', 'Build the project.'),
      msg('assistant', 'Compiling TypeScript.', {
        tool_calls: [{ id: 'tc3', function: { name: 'exec', arguments: '{"cmd":"tsc"}' } }],
      }),
      msg('tool', buildStepsOutput),

      // Phase 4: run tests (cat 1 — verbose test output)
      msg('user', 'Run the full test suite.'),
      msg('assistant', 'Running all tests.', {
        tool_calls: [
          { id: 'tc4', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testRunOutput),

      // Phase 5: read large config file (cat 3 — will be expired by write below)
      msg('user', 'Read the config file so I can update the rate limit.'),
      msg('assistant', 'Reading /usr/local/src/app/config.ts.', {
        tool_calls: [
          {
            id: 'tc5',
            function: { name: 'read', arguments: '{"path":"/usr/local/src/app/config.ts"}' },
          },
        ],
      }),
      msg('tool', configFileContent),

      // Phase 6: assistant shows validation code; tool echoes it back (cat 2)
      msg(
        'assistant',
        `I can see the config. Now let me show you the validation middleware:\n\n\`\`\`typescript\n${sharedCodeBlock}\`\`\`\n\nI'll apply the rate limit change now.`,
        {
          tool_calls: [
            {
              id: 'tc6',
              function: {
                name: 'edit',
                arguments: '{"path":"/usr/local/src/app/config.ts","changes":"rateLimit.max=50"}',
              },
            },
          ],
        },
      ),
      // Tool echoes the shared code block back verbatim (cat 2 — echo)
      msg(
        'tool',
        `Applied changes. Current validation middleware:\n\n${sharedCodeBlock}\nFile /usr/local/src/app/config.ts written successfully.`,
      ),

      // Phase 7: the write makes the earlier read expired (cat 3 activates retroactively)
      msg(
        'assistant',
        'Rate limit updated from 100 to 50. I wrote /usr/local/src/app/config.ts with the new value.',
      ),

      msg('user', 'Perfect, run the tests again to confirm.'),
      msg('assistant', 'Re-running tests.', {
        tool_calls: [
          { id: 'tc7', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testRunOutput),

      msg('assistant', 'All 32 tests pass. The config change is live.'),
      msg('user', 'Great, ship it.'),
    ],
  };
}

function iterativeDesign(): Scenario {
  // Simulates a real design conversation where:
  // 1. Early messages establish important architectural decisions (importance scoring target)
  // 2. Some decisions get corrected/overridden later (contradiction detection target)
  // 3. Filler prose separates the signals
  const filler =
    'The team has been making steady progress on the overall project timeline and the stakeholders ' +
    'are generally satisfied with the direction things are heading. We should continue to monitor the ' +
    'situation and adjust our approach as needed based on feedback from the beta testing group.';

  return {
    name: 'Iterative design',
    messages: [
      msg('system', 'You are a senior architect helping design a data pipeline.'),
      // Important early decision — referenced by many later messages
      msg(
        'user',
        'We need to decide on the message queue. I think we should use the RabbitMQ broker with ' +
          'the AMQP protocol for our data pipeline because it supports complex routing topologies ' +
          'and has mature client libraries for our TypeScript and Python services.',
      ),
      msg(
        'assistant',
        'RabbitMQ with AMQP is a solid choice for the data pipeline. The exchange-based routing ' +
          'model lets you fan out events to multiple consumers without duplicating publish logic. ' +
          'For the TypeScript services, use the amqplib client with channel pooling to avoid ' +
          'connection churn. For Python, pika is the standard. Make sure to configure publisher ' +
          'confirms and consumer acknowledgments to prevent message loss.',
      ),
      // Filler
      msg('user', filler),
      msg(
        'assistant',
        'That sounds like a reasonable assessment of the current project state. Keeping an eye on ' +
          'the beta feedback loop is important for catching issues early. The weekly sync should give ' +
          'enough visibility into any blockers that arise during the testing phase.',
      ),
      // Another important decision — serialization format
      msg(
        'user',
        'For the serialization format in the data pipeline, lets use Protocol Buffers with the ' +
          'protobuf-ts generator for the TypeScript side. The schema evolution story is better ' +
          'than JSON and the binary encoding saves bandwidth on the RabbitMQ broker.',
      ),
      msg(
        'assistant',
        'Protocol Buffers are a strong fit here. The protobuf-ts generator produces clean ' +
          'TypeScript interfaces with full type safety. Define your schemas in a shared proto ' +
          'directory and generate both TypeScript and Python stubs from CI. Use proto3 syntax ' +
          'and leverage the optional keyword for fields that might be added later. This keeps ' +
          'backward compatibility without the versioning headaches of Avro.',
      ),
      // More filler
      msg(
        'user',
        'The onboarding documentation for new developers needs some updates. Several sections ' +
          'reference the old deployment process and the screenshots are from the previous version ' +
          'of the admin dashboard.',
      ),
      msg(
        'assistant',
        'Updating the onboarding docs should be a priority before the next hiring cycle. Have each ' +
          'recent joiner flag the sections that confused them during their own onboarding, then use ' +
          'those annotations to prioritize which pages to rewrite first. Screenshots can be automated ' +
          'with a headless browser script that captures the current UI state on each release.',
      ),
      // CONTRADICTION: override the RabbitMQ decision (shares vocabulary with original)
      msg(
        'user',
        'Actually, we need to change the message queue broker for our data pipeline. The RabbitMQ ' +
          'broker with AMQP protocol cannot handle our throughput requirements for the TypeScript ' +
          'and Python services. We should use Apache Kafka as the message broker instead because ' +
          'the partitioned log model supports complex routing topologies at higher scale and the ' +
          'client libraries are mature.',
      ),
      msg(
        'assistant',
        "Good call switching to Kafka after the load test validated the concern. Kafka's " +
          'partitioned log gives you the horizontal scaling RabbitMQ was missing. Use the kafkajs ' +
          'client for TypeScript with the confluent-kafka-python library for the Python services. ' +
          'Partition your topics by the pipeline entity ID to preserve ordering within each entity. ' +
          'You will need to update the protobuf message wrappers to include Kafka headers for ' +
          'tracing.',
      ),
      // Forward reference to the Kafka decision
      msg(
        'user',
        'How should we handle dead letter processing in Kafka? When a consumer fails to process ' +
          'a message from the data pipeline after retries, we need a recovery path.',
      ),
      msg(
        'assistant',
        'In Kafka, dead letter handling is a consumer-side concern unlike RabbitMQ which has ' +
          'built-in DLX support. Implement a retry topic pattern: after N failed attempts, the ' +
          'consumer publishes the message to a dedicated retry topic with a backoff delay header. ' +
          'A separate retry consumer reads from the retry topic and re-publishes to the original ' +
          'topic after the delay expires. After the final retry, send to a dead letter topic that ' +
          'feeds into an alert and manual review workflow.',
      ),
      // CONTRADICTION: override the protobuf decision (shares vocabulary with original)
      msg(
        'user',
        'Actually, the protobuf-ts generator for the serialization format in the data pipeline ' +
          'has a bug with our nested message types. Lets switch to using Avro instead of Protocol ' +
          'Buffers for the TypeScript side. The schema evolution story with the Confluent schema ' +
          'registry is better and the binary encoding saves bandwidth on the Kafka broker.',
      ),
      msg(
        'assistant',
        'Avro with the Confluent Schema Registry is the standard pairing for Kafka pipelines. ' +
          'The avsc library handles Avro encoding and schema resolution in Node. Register schemas ' +
          'on first produce and cache the schema ID for subsequent messages. The wire format is ' +
          'a magic byte, the 4-byte schema ID, then the Avro-encoded payload. This is a better ' +
          'fit than protobuf for the Kafka ecosystem since the schema registry handles evolution.',
      ),
      // Forward references
      msg(
        'user',
        'Can the Avro schemas we define for Kafka also be used to validate the REST API request ' +
          'bodies in the ingestion service?',
      ),
      msg(
        'assistant',
        'Yes, you can share the Avro schemas between the Kafka producers and the REST validation ' +
          'layer. The avsc library can compile an Avro schema into a validator function that checks ' +
          'incoming JSON payloads. This gives you a single source of truth for the data pipeline ' +
          'message format — the same schema validates HTTP input and serializes Kafka output.',
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// ANCS scenario builder (uses existing + new scenarios)
// ---------------------------------------------------------------------------

function buildAncsScenarios(): Scenario[] {
  nextId = 10000; // offset to avoid ID collisions
  return [deepConversation(), agenticCodingSession(), iterativeDesign()];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  msgCount: number;
  originalChars: number;
  compressedChars: number;
  ratio: string;
  tokenRatio: string;
  compressed: number;
  preserved: number;
  roundTrip: 'PASS' | 'FAIL';
  timeMs: string;
  entityRetention: number | undefined;
  structuralIntegrity: number | undefined;
  referenceCoherence: number | undefined;
  qualityScore: number | undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const flagSave = args.includes('--save');
  const flagCheck = args.includes('--check');
  const flagLlm = args.includes('--llm');
  const toleranceIdx = args.indexOf('--tolerance');
  const tolerance = toleranceIdx >= 0 ? Number(args[toleranceIdx + 1]) / 100 : 0;

  const scenarios = buildScenarios();
  const results: Result[] = [];

  // Structured results for baseline save/check
  const benchResults: BenchmarkResults = {
    basic: {},
    tokenBudget: {},
    dedup: {},
    fuzzyDedup: {},
    bundleSize: {},
  };

  for (const scenario of scenarios) {
    const t0 = performance.now();

    const cr = compress(scenario.messages, { recencyWindow: 0 });

    const er = uncompress(cr.messages, cr.verbatim);

    const t1 = performance.now();

    // Round-trip check: expanded messages should match originals
    const originalJson = JSON.stringify(scenario.messages);
    const expandedJson = JSON.stringify(er.messages);
    const roundTrip =
      originalJson === expandedJson && er.missing_ids.length === 0 ? 'PASS' : 'FAIL';

    results.push({
      name: scenario.name,
      msgCount: scenario.messages.length,
      originalChars: chars(scenario.messages),
      compressedChars: chars(cr.messages),
      ratio: cr.compression.ratio.toFixed(2),
      tokenRatio: cr.compression.token_ratio.toFixed(2),
      compressed: cr.compression.messages_compressed,
      preserved: cr.compression.messages_preserved,
      roundTrip,
      timeMs: (t1 - t0).toFixed(2),
      entityRetention: cr.compression.entity_retention,
      structuralIntegrity: cr.compression.structural_integrity,
      referenceCoherence: cr.compression.reference_coherence,
      qualityScore: cr.compression.quality_score,
    });

    benchResults.basic[scenario.name] = {
      ratio: cr.compression.ratio,
      tokenRatio: cr.compression.token_ratio,
      compressed: cr.compression.messages_compressed,
      preserved: cr.compression.messages_preserved,
    };

    // Quality metrics
    if (cr.compression.quality_score != null) {
      if (!benchResults.quality) benchResults.quality = {};
      benchResults.quality[scenario.name] = {
        entityRetention: cr.compression.entity_retention!,
        structuralIntegrity: cr.compression.structural_integrity!,
        referenceCoherence: cr.compression.reference_coherence!,
        qualityScore: cr.compression.quality_score!,
      };
    }

    // Retention analysis
    const originalText = scenario.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const compressedText = cr.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    if (!benchResults.retention) benchResults.retention = {};
    benchResults.retention[scenario.name] = analyzeRetention(originalText, compressedText);
  }

  // Print table
  const cols = {
    name: 24,
    msgs: 5,
    original: 9,
    compressed: 11,
    charRatio: 6,
    tokRatio: 6,
    comp: 5,
    pres: 5,
    rt: 5,
    time: 8,
  };

  const header = [
    'Scenario'.padEnd(cols.name),
    'Msgs'.padStart(cols.msgs),
    'Orig'.padStart(cols.original),
    'Compressed'.padStart(cols.compressed),
    'ChR'.padStart(cols.charRatio),
    'TkR'.padStart(cols.tokRatio),
    'Comp'.padStart(cols.comp),
    'Pres'.padStart(cols.pres),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');

  const sep = '-'.repeat(header.length);

  console.log();
  console.log('Compression Benchmark');
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const r of results) {
    console.log(
      [
        r.name.padEnd(cols.name),
        String(r.msgCount).padStart(cols.msgs),
        String(r.originalChars).padStart(cols.original),
        String(r.compressedChars).padStart(cols.compressed),
        r.ratio.padStart(cols.charRatio),
        r.tokenRatio.padStart(cols.tokRatio),
        String(r.compressed).padStart(cols.comp),
        String(r.preserved).padStart(cols.pres),
        r.roundTrip.padStart(cols.rt),
        (r.timeMs + 'ms').padStart(cols.time),
      ].join('  '),
    );
  }

  console.log(sep);
  console.log();

  const failures = results.filter((r) => r.roundTrip === 'FAIL');
  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} scenario(s) failed round-trip: ${failures.map((f) => f.name).join(', ')}`,
    );
    process.exit(1);
  }

  console.log('All scenarios passed round-trip verification.');

  // ---------------------------------------------------------------------------
  // Retention metrics
  // ---------------------------------------------------------------------------

  if (benchResults.retention && Object.keys(benchResults.retention).length > 0) {
    console.log();
    console.log('Retention Metrics');

    const retHeader = [
      'Scenario'.padEnd(24),
      'Keywords'.padStart(9),
      'Entities'.padStart(9),
      'Structural'.padStart(11),
    ].join('  ');
    const retSep = '-'.repeat(retHeader.length);

    console.log(retSep);
    console.log(retHeader);
    console.log(retSep);

    for (const [name, ret] of Object.entries(benchResults.retention)) {
      console.log(
        [
          name.padEnd(24),
          `${(ret.keywordRetention * 100).toFixed(0)}%`.padStart(9),
          `${(ret.entityRetention * 100).toFixed(0)}%`.padStart(9),
          `${(ret.structuralRetention * 100).toFixed(0)}%`.padStart(11),
        ].join('  '),
      );
    }

    console.log(retSep);
  }

  // ---------------------------------------------------------------------------
  // Quality metrics (v2)
  // ---------------------------------------------------------------------------

  if (benchResults.quality && Object.keys(benchResults.quality).length > 0) {
    console.log();
    console.log('Quality Metrics (v2)');

    const qHeader = [
      'Scenario'.padEnd(24),
      'Entities'.padStart(9),
      'Structure'.padStart(10),
      'Coherence'.padStart(10),
      'Quality'.padStart(8),
    ].join('  ');
    const qSep = '-'.repeat(qHeader.length);

    console.log(qSep);
    console.log(qHeader);
    console.log(qSep);

    for (const [name, q] of Object.entries(benchResults.quality)) {
      console.log(
        [
          name.padEnd(24),
          `${(q.entityRetention * 100).toFixed(0)}%`.padStart(9),
          `${(q.structuralIntegrity * 100).toFixed(0)}%`.padStart(10),
          `${(q.referenceCoherence * 100).toFixed(0)}%`.padStart(10),
          q.qualityScore.toFixed(3).padStart(8),
        ].join('  '),
      );
    }

    console.log(qSep);

    // Quality regression check
    const lowQuality = Object.entries(benchResults.quality).filter(([, q]) => q.qualityScore < 0.8);
    if (lowQuality.length > 0) {
      console.log();
      console.log(
        `WARNING: ${lowQuality.length} scenario(s) below 0.80 quality: ${lowQuality.map(([n]) => n).join(', ')}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // tokenBudget scenarios
  // ---------------------------------------------------------------------------

  const tokenBudget = 2000;
  const budgetScenarios: Scenario[] = [deepConversation(), agenticCodingSession()];

  console.log();
  console.log('tokenBudget Benchmark');

  const tbHeader = [
    'Scenario'.padEnd(cols.name),
    'Dedup'.padStart(6),
    'Msgs'.padStart(5),
    'Budget'.padStart(7),
    'Tokens'.padStart(7),
    'Fits'.padStart(5),
    'Rw'.padStart(4),
    'Comp'.padStart(5),
    'Pres'.padStart(5),
    'Ddup'.padStart(5),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');
  const tbSep = '-'.repeat(tbHeader.length);

  console.log(tbSep);
  console.log(tbHeader);
  console.log(tbSep);

  let tbFails = 0;

  for (const scenario of budgetScenarios) {
    for (const dedup of [false, true]) {
      const t0 = performance.now();
      const cr: CompressResult = compress(scenario.messages, { tokenBudget, dedup });
      const t1 = performance.now();

      const er = uncompress(cr.messages, cr.verbatim);
      const rt =
        JSON.stringify(scenario.messages) === JSON.stringify(er.messages) &&
        er.missing_ids.length === 0
          ? 'PASS'
          : 'FAIL';
      if (rt === 'FAIL') tbFails++;

      console.log(
        [
          scenario.name.padEnd(cols.name),
          (dedup ? 'yes' : 'no').padStart(6),
          String(scenario.messages.length).padStart(5),
          String(tokenBudget).padStart(7),
          String(cr.tokenCount).padStart(7),
          String(cr.fits).padStart(5),
          String(cr.recencyWindow ?? '-').padStart(4),
          String(cr.compression.messages_compressed).padStart(5),
          String(cr.compression.messages_preserved).padStart(5),
          String(cr.compression.messages_deduped ?? 0).padStart(5),
          rt.padStart(cols.rt),
          ((t1 - t0).toFixed(2) + 'ms').padStart(cols.time),
        ].join('  '),
      );

      const tbKey = `${scenario.name}|dedup=${dedup}`;
      benchResults.tokenBudget[tbKey] = {
        tokenCount: cr.tokenCount ?? 0,
        fits: cr.fits ?? false,
        recencyWindow: cr.recencyWindow,
        compressed: cr.compression.messages_compressed,
        preserved: cr.compression.messages_preserved,
        deduped: cr.compression.messages_deduped ?? 0,
      };
    }
  }

  console.log(tbSep);

  if (tbFails > 0) {
    console.error(`FAIL: ${tbFails} tokenBudget scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Dedup comparison (rw=0 and rw=4)
  // ---------------------------------------------------------------------------

  console.log();
  console.log('Dedup Comparison (dedup: true vs baseline)');

  const dedupHeader = [
    'Scenario'.padEnd(cols.name),
    'rw0 Base'.padStart(9),
    'rw0 Dup'.padStart(8),
    'rw4 Base'.padStart(9),
    'rw4 Dup'.padStart(8),
    'Deduped'.padStart(8),
    'R/T'.padStart(cols.rt),
  ].join('  ');
  const dedupSep = '-'.repeat(dedupHeader.length);

  console.log(dedupSep);
  console.log(dedupHeader);
  console.log(dedupSep);

  const dedupScenarios = buildScenarios();
  let dedupFails = 0;

  for (const scenario of dedupScenarios) {
    const baseRw0 = compress(scenario.messages, { recencyWindow: 0, dedup: false });
    const dedupRw0 = compress(scenario.messages, { recencyWindow: 0, dedup: true });
    const baseRw4 = compress(scenario.messages, { recencyWindow: 4, dedup: false });
    const dedupRw4 = compress(scenario.messages, { recencyWindow: 4, dedup: true });

    // Round-trip check on the rw=4 dedup result
    const er2 = uncompress(dedupRw4.messages, dedupRw4.verbatim);
    const rt2 =
      JSON.stringify(scenario.messages) === JSON.stringify(er2.messages) &&
      er2.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';
    if (rt2 === 'FAIL') dedupFails++;

    const deduped = dedupRw4.compression.messages_deduped ?? 0;

    console.log(
      [
        scenario.name.padEnd(cols.name),
        baseRw0.compression.ratio.toFixed(2).padStart(9),
        dedupRw0.compression.ratio.toFixed(2).padStart(8),
        baseRw4.compression.ratio.toFixed(2).padStart(9),
        dedupRw4.compression.ratio.toFixed(2).padStart(8),
        String(deduped).padStart(8),
        rt2.padStart(cols.rt),
      ].join('  '),
    );

    benchResults.dedup[scenario.name] = {
      rw0Base: baseRw0.compression.ratio,
      rw0Dup: dedupRw0.compression.ratio,
      rw4Base: baseRw4.compression.ratio,
      rw4Dup: dedupRw4.compression.ratio,
      deduped,
    };
  }

  console.log(dedupSep);

  if (dedupFails > 0) {
    console.error(`FAIL: ${dedupFails} dedup scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Fuzzy dedup benchmark
  // ---------------------------------------------------------------------------

  console.log();
  console.log('Fuzzy Dedup Benchmark (fuzzyDedup: true)');

  const fuzzyHeader = [
    'Scenario'.padEnd(cols.name),
    'Msgs'.padStart(5),
    'Exact'.padStart(6),
    'Fuzzy'.padStart(6),
    'Ratio'.padStart(6),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');
  const fuzzySep = '-'.repeat(fuzzyHeader.length);

  console.log(fuzzySep);
  console.log(fuzzyHeader);
  console.log(fuzzySep);

  const fuzzyScenarios = buildScenarios();
  let fuzzyFails = 0;

  for (const scenario of fuzzyScenarios) {
    const t0 = performance.now();
    const cr = compress(scenario.messages, { recencyWindow: 0, fuzzyDedup: true });
    const t1 = performance.now();

    const er = uncompress(cr.messages, cr.verbatim);
    const rt =
      JSON.stringify(scenario.messages) === JSON.stringify(er.messages) &&
      er.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';
    if (rt === 'FAIL') fuzzyFails++;

    console.log(
      [
        scenario.name.padEnd(cols.name),
        String(scenario.messages.length).padStart(5),
        String(cr.compression.messages_deduped ?? 0).padStart(6),
        String(cr.compression.messages_fuzzy_deduped ?? 0).padStart(6),
        cr.compression.ratio.toFixed(2).padStart(6),
        rt.padStart(cols.rt),
        ((t1 - t0).toFixed(2) + 'ms').padStart(cols.time),
      ].join('  '),
    );

    benchResults.fuzzyDedup[scenario.name] = {
      exact: cr.compression.messages_deduped ?? 0,
      fuzzy: cr.compression.messages_fuzzy_deduped ?? 0,
      ratio: cr.compression.ratio,
    };
  }

  console.log(fuzzySep);

  if (fuzzyFails > 0) {
    console.error(`FAIL: ${fuzzyFails} fuzzy dedup scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // ANCS-inspired features (importance scoring + contradiction detection)
  // ---------------------------------------------------------------------------

  console.log();
  console.log('ANCS Features (importanceScoring + contradictionDetection)');

  const ancsScenarios = buildAncsScenarios();

  const ancsHeader = [
    'Scenario'.padEnd(cols.name),
    'Msgs'.padStart(5),
    'Base R'.padStart(7),
    '+Imp R'.padStart(7),
    '+Con R'.padStart(7),
    'Both R'.padStart(7),
    'ImpP'.padStart(5),
    'Ctrd'.padStart(5),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');
  const ancsSep = '-'.repeat(ancsHeader.length);

  console.log(ancsSep);
  console.log(ancsHeader);
  console.log(ancsSep);

  if (!benchResults.ancs) benchResults.ancs = {};
  let ancsFails = 0;

  for (const scenario of ancsScenarios) {
    const t0 = performance.now();

    // Baseline: small recency window to leave room for ANCS features to act
    const baseline = compress(scenario.messages, { recencyWindow: 2 });

    // Importance only
    const withImportance = compress(scenario.messages, {
      recencyWindow: 2,
      importanceScoring: true,
      importanceThreshold: 0.25,
    });

    // Contradiction only
    const withContradiction = compress(scenario.messages, {
      recencyWindow: 2,
      contradictionDetection: true,
    });

    // Combined
    const combined = compress(scenario.messages, {
      recencyWindow: 2,
      importanceScoring: true,
      importanceThreshold: 0.25,
      contradictionDetection: true,
    });

    const t1 = performance.now();

    // Round-trip on combined (strictest test)
    const er = uncompress(combined.messages, combined.verbatim);
    const rt =
      JSON.stringify(scenario.messages) === JSON.stringify(er.messages) &&
      er.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';
    if (rt === 'FAIL') ancsFails++;

    // Report per-feature stats from their individual runs (not combined,
    // where importance can shadow contradictions)
    const impPreserved = withImportance.compression.messages_importance_preserved ?? 0;
    const contradicted = withContradiction.compression.messages_contradicted ?? 0;

    console.log(
      [
        scenario.name.padEnd(cols.name),
        String(scenario.messages.length).padStart(5),
        baseline.compression.ratio.toFixed(2).padStart(7),
        withImportance.compression.ratio.toFixed(2).padStart(7),
        withContradiction.compression.ratio.toFixed(2).padStart(7),
        combined.compression.ratio.toFixed(2).padStart(7),
        String(impPreserved).padStart(5),
        String(contradicted).padStart(5),
        rt.padStart(cols.rt),
        ((t1 - t0).toFixed(2) + 'ms').padStart(cols.time),
      ].join('  '),
    );

    benchResults.ancs[scenario.name] = {
      baselineRatio: baseline.compression.ratio,
      importanceRatio: withImportance.compression.ratio,
      contradictionRatio: withContradiction.compression.ratio,
      combinedRatio: combined.compression.ratio,
      importancePreserved: impPreserved,
      contradicted,
    };
  }

  console.log(ancsSep);

  if (ancsFails > 0) {
    console.error(`FAIL: ${ancsFails} ANCS scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Agent Tool Pre-pass benchmark
  // ---------------------------------------------------------------------------

  console.log();
  console.log('Agent Tool Pre-pass (agentToolPrepass: true)');

  // Re-assign IDs to avoid collisions with scenarios already run
  nextId = 50000;
  const prepassScenarios: Scenario[] = [
    agentToolPrepassHeavy(),
    agenticCodingSession(),
    toolHeavy(),
  ];

  // Columns: Baseline ratio uses original chars / baseline compressed chars.
  // Effective ratio uses original chars / prepass+compressed chars — the true
  // end-to-end savings when agentToolPrepass is enabled.
  const ppHeader = [
    'Scenario'.padEnd(cols.name),
    'Msgs'.padStart(5),
    'BaseR'.padStart(6),
    'EffR'.padStart(6),
    'CharsRmvd'.padStart(10),
    'MsgsTrmd'.padStart(9),
    'R/T'.padStart(cols.rt),
    'Time'.padStart(cols.time),
  ].join('  ');
  const ppSep = '-'.repeat(ppHeader.length);

  console.log(ppSep);
  console.log(ppHeader);
  console.log(ppSep);

  if (!benchResults.prepass) benchResults.prepass = {};
  let ppFails = 0;

  for (const scenario of prepassScenarios) {
    const t0 = performance.now();
    const baseline = compress(scenario.messages, { recencyWindow: 0 });
    const withPrepass = compress(scenario.messages, { recencyWindow: 0, agentToolPrepass: true });
    const t1 = performance.now();

    // Round-trip: prepass is lossy, so compare uncompress result against
    // post-prepass messages (not original). The compression layer must be
    // fully reversible even if the prepass itself is not.
    const postPrepass = applyToolPrepass(scenario.messages).messages;
    const er = uncompress(withPrepass.messages, withPrepass.verbatim);
    const rt =
      JSON.stringify(postPrepass) === JSON.stringify(er.messages) && er.missing_ids.length === 0
        ? 'PASS'
        : 'FAIL';
    if (rt === 'FAIL') ppFails++;

    const charsRemoved = withPrepass.compression.chars_tool_prepass_removed ?? 0;
    const msgsTrimmed = withPrepass.compression.messages_tool_prepass_trimmed ?? 0;

    // Effective ratio: original input chars / final prepass+compressed chars
    const originalChars = chars(scenario.messages);
    const finalChars = chars(withPrepass.messages);
    const effectiveRatio = finalChars > 0 ? originalChars / finalChars : 1;

    console.log(
      [
        scenario.name.padEnd(cols.name),
        String(scenario.messages.length).padStart(5),
        baseline.compression.ratio.toFixed(2).padStart(6),
        effectiveRatio.toFixed(2).padStart(6),
        String(charsRemoved).padStart(10),
        String(msgsTrimmed).padStart(9),
        rt.padStart(cols.rt),
        ((t1 - t0).toFixed(2) + 'ms').padStart(cols.time),
      ].join('  '),
    );

    benchResults.prepass[scenario.name] = {
      baselineRatio: baseline.compression.ratio,
      prepassRatio: effectiveRatio,
      charsRemoved,
      messagesTrimmed: msgsTrimmed,
    };
  }

  console.log(ppSep);

  if (ppFails > 0) {
    console.error(`FAIL: ${ppFails} prepass scenario(s) failed round-trip`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // V2 Features Comparison (default vs each feature vs recommended combo)
  // ---------------------------------------------------------------------------

  console.log();
  console.log('V2 Features Comparison');

  type V2Config = { name: string; options: CompressOptions };
  const v2Configs: V2Config[] = [
    { name: 'Default (v1)', options: { recencyWindow: 0 } },
    { name: '+conversationFlow', options: { recencyWindow: 0, conversationFlow: true } },
    { name: '+semanticClustering', options: { recencyWindow: 0, semanticClustering: true } },
    { name: '+relevanceThresh=3', options: { recencyWindow: 0, relevanceThreshold: 3 } },
    { name: '+depth=moderate', options: { recencyWindow: 0, compressionDepth: 'moderate' } },
    { name: '+importanceScoring', options: { recencyWindow: 0, importanceScoring: true } },
    { name: '+coreference', options: { recencyWindow: 0, coreference: true } },
    {
      name: 'Recommended combo',
      options: {
        recencyWindow: 0,
        conversationFlow: true,
        relevanceThreshold: 3,
        compressionDepth: 'moderate',
      },
    },
  ];

  const v2Scenarios = buildScenarios();

  // Compute all results
  type V2Row = {
    config: string;
    scenario: string;
    ratio: number;
    quality: number | undefined;
    rt: string;
  };
  const v2Rows: V2Row[] = [];
  let v2Fails = 0;

  for (const cfg of v2Configs) {
    for (const scenario of v2Scenarios) {
      const cr = compress(scenario.messages, cfg.options);
      const er = uncompress(cr.messages, cr.verbatim);
      const rt =
        JSON.stringify(scenario.messages) === JSON.stringify(er.messages) &&
        er.missing_ids.length === 0
          ? 'PASS'
          : 'FAIL';
      if (rt === 'FAIL') v2Fails++;
      v2Rows.push({
        config: cfg.name,
        scenario: scenario.name,
        ratio: cr.compression.ratio,
        quality: cr.compression.quality_score,
        rt,
      });
    }
  }

  // Print matrix: rows = configs, columns = scenarios
  const v2ScenarioNames = v2Scenarios.map((s) => s.name);
  const scColW = 14;
  const v2NameW = 22;

  const v2Header = [
    'Config'.padEnd(v2NameW),
    ...v2ScenarioNames.map((n) => n.slice(0, scColW).padStart(scColW)),
    'R/T'.padStart(5),
  ].join('  ');
  const v2Sep = '-'.repeat(v2Header.length);

  console.log(v2Sep);
  console.log(
    ''.padEnd(v2NameW) +
      '  ' +
      v2ScenarioNames.map((_n) => 'ratio / qual'.padStart(scColW)).join('  '),
  );
  console.log(v2Header);
  console.log(v2Sep);

  for (const cfg of v2Configs) {
    const cfgRows = v2Rows.filter((r) => r.config === cfg.name);
    const allPass = cfgRows.every((r) => r.rt === 'PASS');
    const cells = v2ScenarioNames.map((sn) => {
      const row = cfgRows.find((r) => r.scenario === sn);
      if (!row) return '—'.padStart(scColW);
      const r = row.ratio.toFixed(1) + 'x';
      const q = row.quality != null ? (row.quality * 100).toFixed(0) + '%' : '—';
      return (r + '/' + q).padStart(scColW);
    });
    console.log(
      [cfg.name.padEnd(v2NameW), ...cells, (allPass ? 'PASS' : 'FAIL').padStart(5)].join('  '),
    );
  }

  // Print delta row (recommended combo vs default)
  const defaultRows = v2Rows.filter((r) => r.config === 'Default (v1)');
  const comboRows = v2Rows.filter((r) => r.config === 'Recommended combo');
  const deltaCells = v2ScenarioNames.map((sn) => {
    const def = defaultRows.find((r) => r.scenario === sn);
    const combo = comboRows.find((r) => r.scenario === sn);
    if (!def || !combo) return '—'.padStart(scColW);
    const pct = ((combo.ratio / def.ratio - 1) * 100).toFixed(0);
    return ((pct.startsWith('-') ? '' : '+') + pct + '%').padStart(scColW);
  });
  console.log(['Δ combo vs default'.padEnd(v2NameW), ...deltaCells, ''.padStart(5)].join('  '));

  console.log(v2Sep);

  if (v2Fails > 0) {
    console.error(`FAIL: ${v2Fails} V2 scenario(s) failed round-trip`);
    process.exit(1);
  }

  console.log();
  console.log('All V2 scenarios passed round-trip verification.');

  // ---------------------------------------------------------------------------
  // Bundle size
  // ---------------------------------------------------------------------------

  console.log();
  console.log('Bundle Size');

  execSync('npm run build', { stdio: 'pipe', cwd: resolve(import.meta.dirname, '..') });

  const distDir = resolve(import.meta.dirname, '..', 'dist');
  const distFiles = readdirSync(distDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .sort();

  let totalBytes = 0;
  let totalGzip = 0;

  const bsHeader = ['File'.padEnd(30), 'Size'.padStart(10), 'Gzip'.padStart(10)].join('  ');
  const bsSep = '-'.repeat(bsHeader.length);

  console.log(bsSep);
  console.log(bsHeader);
  console.log(bsSep);

  for (const file of distFiles) {
    const fullPath = join(distDir, file);
    const bytes = statSync(fullPath).size;
    const gzipBytes = gzipSync(readFileSync(fullPath)).length;
    totalBytes += bytes;
    totalGzip += gzipBytes;

    benchResults.bundleSize[file] = { bytes, gzipBytes };

    const fmtBytes = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    const fmtGzip = gzipBytes < 1024 ? `${gzipBytes} B` : `${(gzipBytes / 1024).toFixed(1)} KB`;
    console.log([file.padEnd(30), fmtBytes.padStart(10), fmtGzip.padStart(10)].join('  '));
  }

  benchResults.bundleSize['total'] = { bytes: totalBytes, gzipBytes: totalGzip };

  const fmtTotal = totalBytes < 1024 ? `${totalBytes} B` : `${(totalBytes / 1024).toFixed(1)} KB`;
  const fmtTotalGz = totalGzip < 1024 ? `${totalGzip} B` : `${(totalGzip / 1024).toFixed(1)} KB`;
  console.log(bsSep);
  console.log(['total'.padEnd(30), fmtTotal.padStart(10), fmtTotalGz.padStart(10)].join('  '));
  console.log(bsSep);

  // ---------------------------------------------------------------------------
  // --save / --check
  // ---------------------------------------------------------------------------

  const baselinesDir = resolve(import.meta.dirname, 'baselines');
  const version = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ).version;

  if (flagSave) {
    saveBaseline(baselinesDir, version, benchResults);
    generateBenchmarkDocs(
      baselinesDir,
      resolve(import.meta.dirname, '..', 'docs', 'benchmark-results.md'),
    );
    console.log();
    console.log(`Baseline saved (v${version}) and docs/benchmark-results.md regenerated.`);
  }

  if (flagCheck) {
    const current = loadCurrentBaseline(baselinesDir);
    if (!current) {
      console.error(
        'No baseline found at bench/baselines/current.json — run `npm run bench:save` first.',
      );
      process.exit(1);
    }
    const regressions = compareResults(current.results, benchResults, tolerance);
    if (regressions.length > 0) {
      console.error();
      console.error(formatRegressions(regressions));
      process.exit(1);
    }
    console.log();
    console.log(`Baseline check passed (v${current.version}, tolerance ${tolerance * 100}%).`);
  }

  // ---------------------------------------------------------------------------
  // Real Claude Code sessions (if available locally)
  // ---------------------------------------------------------------------------

  runRealSessions();

  // LLM benchmarks require explicit --llm flag (they cost money and take minutes)
  if (flagLlm) {
    await runLlmBenchmark();
  }

  console.log();
  console.log('All benchmarks passed.');
}

// ---------------------------------------------------------------------------
// LLM summarization benchmark (requires --llm flag)
// ---------------------------------------------------------------------------

function roundTrip(messages: Message[], cr: CompressResult): 'PASS' | 'FAIL' {
  const er = uncompress(cr.messages, cr.verbatim);
  return JSON.stringify(messages) === JSON.stringify(er.messages) && er.missing_ids.length === 0
    ? 'PASS'
    : 'FAIL';
}

async function runLlmBenchmark(): Promise<void> {
  const providers = await detectProviders();

  if (providers.length === 0) {
    console.log();
    console.log(
      'LLM Summarization Benchmark — no providers detected (set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env, or start Ollama)',
    );
    return;
  }

  const scenarios = buildScenarios().filter((s) => s.name !== 'Short conversation');
  const baselinesDir = resolve(import.meta.dirname, 'baselines');

  for (const provider of providers) {
    console.log();
    console.log(`LLM Summarization Benchmark — ${provider.name} (${provider.model})`);

    const basicSummarizer = createSummarizer(provider.callLlm);
    const escalatingSummarizer = createEscalatingSummarizer(provider.callLlm);

    const cols = {
      name: 24,
      method: 14,
      chr: 6,
      tkr: 6,
      vsDet: 6,
      comp: 5,
      pres: 5,
      rt: 5,
      time: 10,
    };

    const header = [
      'Scenario'.padEnd(cols.name),
      'Method'.padStart(cols.method),
      'ChR'.padStart(cols.chr),
      'TkR'.padStart(cols.tkr),
      'vsDet'.padStart(cols.vsDet),
      'Comp'.padStart(cols.comp),
      'Pres'.padStart(cols.pres),
      'R/T'.padStart(cols.rt),
      'Time'.padStart(cols.time),
    ].join('  ');
    const sep = '-'.repeat(header.length);

    console.log(sep);
    console.log(header);
    console.log(sep);

    let llmFails = 0;
    const llmResult: LlmBenchmarkResult = {
      provider: provider.name,
      model: provider.model,
      generated: new Date().toISOString(),
      scenarios: {},
    };

    for (const scenario of scenarios) {
      try {
        const scenarioResult: Record<string, LlmMethodResult> = {};

        // Deterministic baseline
        const t0d = performance.now();
        const detResult = compress(scenario.messages, { recencyWindow: 0 });
        const t1d = performance.now();
        const detRt = roundTrip(scenario.messages, detResult);
        const detRatio = detResult.compression.ratio;

        printLlmRow(scenario.name, 'deterministic', detResult, detRt, t1d - t0d, undefined, cols);
        scenarioResult['deterministic'] = {
          ratio: detRatio,
          tokenRatio: detResult.compression.token_ratio,
          compressed: detResult.compression.messages_compressed,
          preserved: detResult.compression.messages_preserved,
          roundTrip: detRt,
          timeMs: t1d - t0d,
        };

        // LLM basic summarizer
        const t0b = performance.now();
        const llmBasicResult = await compress(scenario.messages, {
          recencyWindow: 0,
          summarizer: basicSummarizer,
        });
        const t1b = performance.now();
        const basicRt = roundTrip(scenario.messages, llmBasicResult);
        if (basicRt === 'FAIL') llmFails++;
        const basicVsDet = llmBasicResult.compression.ratio / detRatio;

        printLlmRow('', 'llm-basic', llmBasicResult, basicRt, t1b - t0b, basicVsDet, cols);
        scenarioResult['llm-basic'] = {
          ratio: llmBasicResult.compression.ratio,
          tokenRatio: llmBasicResult.compression.token_ratio,
          compressed: llmBasicResult.compression.messages_compressed,
          preserved: llmBasicResult.compression.messages_preserved,
          roundTrip: basicRt,
          timeMs: t1b - t0b,
          vsDet: basicVsDet,
        };

        // LLM escalating summarizer
        const t0e = performance.now();
        const llmEscResult = await compress(scenario.messages, {
          recencyWindow: 0,
          summarizer: escalatingSummarizer,
        });
        const t1e = performance.now();
        const escRt = roundTrip(scenario.messages, llmEscResult);
        if (escRt === 'FAIL') llmFails++;
        const escVsDet = llmEscResult.compression.ratio / detRatio;

        printLlmRow('', 'llm-escalate', llmEscResult, escRt, t1e - t0e, escVsDet, cols);
        scenarioResult['llm-escalate'] = {
          ratio: llmEscResult.compression.ratio,
          tokenRatio: llmEscResult.compression.token_ratio,
          compressed: llmEscResult.compression.messages_compressed,
          preserved: llmEscResult.compression.messages_preserved,
          roundTrip: escRt,
          timeMs: t1e - t0e,
          vsDet: escVsDet,
        };

        console.log(sep);
        llmResult.scenarios[scenario.name] = { methods: scenarioResult };
      } catch (err) {
        console.error(`  ${scenario.name}: ERROR — ${(err as Error).message}`);
        console.log(sep);
      }
    }

    // --- Token budget + LLM ---
    const tokenBudget = 2000;
    const budgetScenarios: Scenario[] = scenarios.filter(
      (s) => s.name === 'Deep conversation' || s.name === 'Agentic coding session',
    );

    if (budgetScenarios.length > 0) {
      console.log();
      console.log(
        `LLM Token Budget — ${provider.name} (${provider.model}) — target: ${tokenBudget} tokens`,
      );

      const tbCols = { name: 24, method: 14, tokens: 7, fits: 5, rw: 4, chr: 6, rt: 5, time: 10 };
      const tbHeader = [
        'Scenario'.padEnd(tbCols.name),
        'Method'.padStart(tbCols.method),
        'Tokens'.padStart(tbCols.tokens),
        'Fits'.padStart(tbCols.fits),
        'Rw'.padStart(tbCols.rw),
        'ChR'.padStart(tbCols.chr),
        'R/T'.padStart(tbCols.rt),
        'Time'.padStart(tbCols.time),
      ].join('  ');
      const tbSep = '-'.repeat(tbHeader.length);

      console.log(tbSep);
      console.log(tbHeader);
      console.log(tbSep);

      llmResult.tokenBudget = {};

      for (const scenario of budgetScenarios) {
        const entries: LlmTokenBudgetResult[] = [];

        try {
          // Deterministic with token budget
          const t0d = performance.now();
          const detCr = compress(scenario.messages, { tokenBudget });
          const t1d = performance.now();
          const detRt = roundTrip(scenario.messages, detCr);

          const detEntry: LlmTokenBudgetResult = {
            budget: tokenBudget,
            method: 'deterministic',
            tokenCount: detCr.tokenCount ?? 0,
            fits: detCr.fits ?? false,
            ratio: detCr.compression.ratio,
            recencyWindow: detCr.recencyWindow,
            roundTrip: detRt,
            timeMs: t1d - t0d,
          };
          entries.push(detEntry);
          printBudgetRow(scenario.name, detEntry, tbCols);

          // LLM escalating with token budget
          const t0e = performance.now();
          const llmCr = await compress(scenario.messages, {
            tokenBudget,
            summarizer: escalatingSummarizer,
          });
          const t1e = performance.now();
          const llmRt = roundTrip(scenario.messages, llmCr);

          const llmEntry: LlmTokenBudgetResult = {
            budget: tokenBudget,
            method: 'llm-escalate',
            tokenCount: llmCr.tokenCount ?? 0,
            fits: llmCr.fits ?? false,
            ratio: llmCr.compression.ratio,
            recencyWindow: llmCr.recencyWindow,
            roundTrip: llmRt,
            timeMs: t1e - t0e,
          };
          entries.push(llmEntry);
          printBudgetRow('', llmEntry, tbCols);

          console.log(tbSep);
        } catch (err) {
          console.error(`  ${scenario.name}: ERROR — ${(err as Error).message}`);
          console.log(tbSep);
        }

        if (entries.length > 0) {
          llmResult.tokenBudget[scenario.name] = entries;
        }
      }
    }

    // Always save LLM results (informational, not gated behind --save)
    saveLlmResult(baselinesDir, llmResult);
    console.log(`  Results saved to bench/baselines/llm/`);

    if (llmFails > 0) {
      console.error(`  WARNING: ${llmFails} LLM scenario(s) failed round-trip`);
    }
  }
}

function printLlmRow(
  name: string,
  method: string,
  cr: CompressResult,
  rt: string,
  timeMs: number,
  vsDet: number | undefined,
  cols: {
    name: number;
    method: number;
    chr: number;
    tkr: number;
    vsDet: number;
    comp: number;
    pres: number;
    rt: number;
    time: number;
  },
): void {
  console.log(
    [
      name.padEnd(cols.name),
      method.padStart(cols.method),
      cr.compression.ratio.toFixed(2).padStart(cols.chr),
      cr.compression.token_ratio.toFixed(2).padStart(cols.tkr),
      (vsDet != null ? vsDet.toFixed(2) : '-').padStart(cols.vsDet),
      String(cr.compression.messages_compressed).padStart(cols.comp),
      String(cr.compression.messages_preserved).padStart(cols.pres),
      rt.padStart(cols.rt),
      (timeMs < 1000 ? timeMs.toFixed(0) + 'ms' : (timeMs / 1000).toFixed(1) + 's').padStart(
        cols.time,
      ),
    ].join('  '),
  );
}

function printBudgetRow(
  name: string,
  entry: LlmTokenBudgetResult,
  cols: {
    name: number;
    method: number;
    tokens: number;
    fits: number;
    rw: number;
    chr: number;
    rt: number;
    time: number;
  },
): void {
  console.log(
    [
      name.padEnd(cols.name),
      entry.method.padStart(cols.method),
      String(entry.tokenCount).padStart(cols.tokens),
      String(entry.fits).padStart(cols.fits),
      String(entry.recencyWindow ?? '-').padStart(cols.rw),
      entry.ratio.toFixed(2).padStart(cols.chr),
      entry.roundTrip.padStart(cols.rt),
      (entry.timeMs < 1000
        ? entry.timeMs.toFixed(0) + 'ms'
        : (entry.timeMs / 1000).toFixed(1) + 's'
      ).padStart(cols.time),
    ].join('  '),
  );
}

// ---------------------------------------------------------------------------
// Real session support — convert Claude Code JSONL transcripts to Message[]
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'thinking':
        break; // skip chain-of-thought
      case 'tool_use':
        parts.push(
          `[tool_call: ${block.name}(${JSON.stringify(block.input ?? {}).slice(0, 200)})]`,
        );
        break;
      case 'tool_result': {
        const rc = block.content;
        if (typeof rc === 'string') parts.push(rc);
        else if (Array.isArray(rc)) {
          for (const rb of rc) {
            if (rb.text) parts.push(rb.text);
          }
        }
        break;
      }
      default:
        if (block.text) parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function loadClaudeSession(jsonlPath: string): Message[] {
  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const messages: Message[] = [];
  let index = 0;

  for (const line of lines) {
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (!line.message) continue;
    const content = flattenContent(line.message.content);
    if (!content.trim()) continue;

    let role: string;
    if (line.type === 'user') {
      const blocks = line.message.content;
      role =
        Array.isArray(blocks) && blocks.every((b: ContentBlock) => b.type === 'tool_result')
          ? 'tool'
          : 'user';
    } else {
      role = 'assistant';
    }

    const m: Message = { id: line.uuid ?? `msg-${index + 1}`, index, role, content };

    if (line.type === 'assistant' && Array.isArray(line.message.content)) {
      const toolUses = (line.message.content as ContentBlock[]).filter(
        (b: ContentBlock) => b.type === 'tool_use',
      );
      if (toolUses.length > 0) {
        m.tool_calls = toolUses.map((t: ContentBlock) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
    }

    messages.push(m);
    index++;
  }
  return messages;
}

function discoverClaudeSessions(limit: number): { path: string; label: string; size: number }[] {
  const claudeDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeDir)) return [];

  const results: { path: string; label: string; size: number }[] = [];

  for (const dir of readdirSync(claudeDir)) {
    const dirPath = join(claudeDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, file);
      const size = statSync(filePath).size;
      // Convert dir name back to readable project path
      const project = dir.replace(/-/g, '/').slice(1).split('/').slice(-2).join('/');
      results.push({ path: filePath, label: project, size });
    }
  }

  return results.sort((a, b) => b.size - a.size).slice(0, limit);
}

function runRealSessions(): void {
  const sessions = discoverClaudeSessions(10);
  if (sessions.length === 0) {
    console.log();
    console.log(
      'Real Session Benchmark — skipped (no Claude Code sessions found in ~/.claude/projects/)',
    );
    return;
  }

  console.log();
  console.log(`Real Session Benchmark (${sessions.length} sessions from ~/.claude/projects/)`);

  const fenceRe = /```[\s\S]*?```/g;

  const rrHeader = [
    'Session'.padEnd(24),
    'Msgs'.padStart(6),
    'Orig'.padStart(10),
    'Base R'.padStart(7),
    'Dup R'.padStart(7),
    'Fuz R'.padStart(7),
    'Exact'.padStart(6),
    'Fuzzy'.padStart(6),
    'Neg'.padStart(4),
    'R/T'.padStart(5),
    'Time'.padStart(8),
  ].join('  ');
  const rrSep = '-'.repeat(rrHeader.length);

  console.log(rrSep);
  console.log(rrHeader);
  console.log(rrSep);

  let totOrig = 0,
    totBase = 0,
    totDedup = 0,
    totFuzzy = 0,
    totMsgs = 0;
  let totAFOrig = 0,
    totAFComp = 0,
    totNeg = 0;
  let totExact = 0,
    totFuzzyCount = 0;
  let totPreserved = 0,
    totCodeSplit = 0,
    totSummarized = 0;
  let rtFails = 0;

  for (const session of sessions) {
    try {
      const messages = loadClaudeSession(session.path);
      const t0 = performance.now();
      const crBase = compress(messages, { recencyWindow: 4, dedup: false });
      const crDedup = compress(messages, { recencyWindow: 4 }); // dedup defaults true
      const crFuzzy = compress(messages, { recencyWindow: 4, fuzzyDedup: true });
      const t1 = performance.now();

      // Round-trip on most aggressive config
      const er = uncompress(crFuzzy.messages, crFuzzy.verbatim);
      const rtOk =
        JSON.stringify(messages) === JSON.stringify(er.messages) && er.missing_ids.length === 0;
      if (!rtOk) rtFails++;

      const origC = chars(messages);
      const baseC = chars(crBase.messages);
      const dedupC = chars(crDedup.messages);
      const fuzzyC = chars(crFuzzy.messages);
      totOrig += origC;
      totBase += baseC;
      totDedup += dedupC;
      totFuzzy += fuzzyC;
      totMsgs += messages.length;

      // Dedup counts
      const exact = crDedup.compression.messages_deduped ?? 0;
      const fuzzy = crFuzzy.compression.messages_fuzzy_deduped ?? 0;
      totExact += exact;
      totFuzzyCount += fuzzy;

      // Classify compressed messages (on fuzzy result for aggregate)
      let preserved = 0,
        codeSplit = 0,
        summarized = 0;
      for (const m of crFuzzy.messages) {
        if (!m.metadata?._cce_original) preserved++;
        else if ((m.content ?? '').includes('```')) codeSplit++;
        else summarized++;
      }
      totPreserved += preserved;
      totCodeSplit += codeSplit;
      totSummarized += summarized;

      // Assistant fence integrity (on fuzzy result)
      const afOrig = messages
        .filter((m) => m.role === 'assistant')
        .reduce((s, m) => s + ((m.content ?? '').match(fenceRe) ?? []).length, 0);
      const afComp = crFuzzy.messages
        .filter((m) => m.role === 'assistant')
        .reduce((s, m) => s + ((m.content ?? '').match(fenceRe) ?? []).length, 0);
      totAFOrig += afOrig;
      totAFComp += afComp;

      // Negative savings (merged-message-aware, on fuzzy result)
      let negatives = 0;
      for (const m of crFuzzy.messages) {
        const meta = m.metadata?._cce_original as { ids?: string[] } | undefined;
        if (!meta) continue;
        const ids = meta.ids ?? [m.id];
        const combinedLen = ids.reduce((sum, id) => {
          const orig = messages.find((o) => o.id === id);
          return sum + (orig?.content?.length ?? 0);
        }, 0);
        if ((m.content ?? '').length > combinedLen) negatives++;
      }
      totNeg += negatives;

      const baseR = origC > 0 ? (origC / baseC).toFixed(2) : '-';
      const dedupR = origC > 0 ? (origC / dedupC).toFixed(2) : '-';
      const fuzzyR = origC > 0 ? (origC / fuzzyC).toFixed(2) : '-';

      console.log(
        [
          session.label.slice(0, 24).padEnd(24),
          String(messages.length).padStart(6),
          origC.toLocaleString().padStart(10),
          baseR.padStart(7),
          dedupR.padStart(7),
          fuzzyR.padStart(7),
          String(exact).padStart(6),
          String(fuzzy).padStart(6),
          String(negatives).padStart(4),
          (rtOk ? 'PASS' : 'FAIL').padStart(5),
          ((t1 - t0).toFixed(0) + 'ms').padStart(8),
        ].join('  '),
      );
    } catch (err) {
      console.log(`  ${session.label.padEnd(24)}  ERROR: ${(err as Error).message.slice(0, 60)}`);
    }
  }

  console.log(rrSep);

  // Aggregate
  const aggBaseR = totBase > 0 ? (totOrig / totBase).toFixed(2) : '-';
  const aggDedupR = totDedup > 0 ? (totOrig / totDedup).toFixed(2) : '-';
  const aggFuzzyR = totFuzzy > 0 ? (totOrig / totFuzzy).toFixed(2) : '-';
  const afOk = totAFComp >= totAFOrig;

  console.log(`  Aggregate: ${totMsgs.toLocaleString()} msgs  ${totOrig.toLocaleString()} chars`);
  console.log(`  Ratios: base ${aggBaseR}x → dedup ${aggDedupR}x → fuzzy ${aggFuzzyR}x`);
  console.log(
    `  Deduped: ${totExact} exact, ${totFuzzyCount} fuzzy  |  P/CS/S: ${totPreserved}/${totCodeSplit}/${totSummarized}`,
  );
  console.log(
    `  Asst fences: ${totAFComp}/${totAFOrig} ${afOk ? '✓' : '✗ LOSS'}  Negatives: ${totNeg}${totNeg === 0 ? ' ✓' : ' ✗'}`,
  );

  if (rtFails > 0) {
    console.log(`  WARNING: ${rtFails} session(s) failed round-trip verification`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
