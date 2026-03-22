import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { compress } from '../src/compress.js';
import { uncompress } from '../src/expand.js';
import type { Message } from '../src/types.js';
import {
  analyzeQuality,
  sweepTradeoff,
  summarizeTradeoff,
  compareQualityResults,
  computeOverheadRatio,
  runLlmJudge,
  type QualityBaseline,
  type QualityResult,
  type TradeoffResult,
  type LlmJudgeScore,
} from './quality-analysis.js';
import {
  buildEdgeCaseScenarios,
  getProbesForScenario,
  type Scenario,
} from './quality-scenarios.js';
import { detectProviders } from './llm.js';

// ---------------------------------------------------------------------------
// Reuse scenario builders from run.ts (inline minimal versions to avoid
// coupling — the existing buildScenarios() is not exported)
// ---------------------------------------------------------------------------

let nextId = 1;
function msg(role: string, content: string, extra?: Partial<Message>): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

function buildCoreScenarios(): Scenario[] {
  nextId = 1;
  return [
    codingAssistant(),
    longQA(),
    toolHeavy(),
    deepConversation(),
    technicalExplanation(),
    structuredContent(),
    agenticCodingSession(),
  ];
}

// --- Scenario definitions (copied from run.ts, trimmed to essentials) ---

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
      msg('assistant', 'I will search for those files now.', {
        tool_calls: [
          { id: 'tc1', function: { name: 'glob', arguments: '{"pattern":"**/*auth*.ts"}' } },
        ],
      }),
      msg(
        'tool',
        '["src/auth.ts","src/middleware/auth.ts","tests/auth.test.ts","docs/auth-guide.md"]',
      ),
      msg('assistant', 'Found 4 files. Let me read the documentation first.', {
        tool_calls: [
          { id: 'tc2', function: { name: 'read', arguments: '{"path":"docs/auth-guide.md"}' } },
        ],
      }),
      msg('tool', longProse),
      msg('assistant', 'Now let me check the database schema.', {
        tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{"path":"schema.sql"}' } }],
      }),
      msg(
        'tool',
        'SELECT u.id, u.email, u.created_at, r.name AS role_name\nFROM users u\nINNER JOIN user_roles ur ON ur.user_id = u.id\nINNER JOIN roles r ON r.id = ur.role_id\nWHERE u.active = true AND u.email_verified = true\nORDER BY u.created_at DESC',
      ),
      msg('assistant', 'Let me check the configuration.', {
        tool_calls: [
          { id: 'tc4', function: { name: 'read', arguments: '{"path":".env.example"}' } },
        ],
      }),
      msg(
        'tool',
        'STRIPE_SECRET_KEY=sk_live_abc123def456ghi789jkl012\nGITHUB_TOKEN=ghp_abc123def456ghi789jkl012mno345pqr678\nDATABASE_URL=postgresql://admin:secret@db.example.com:5432/myapp\nREDIS_URL=redis://cache.example.com:6379',
      ),
      msg('assistant', 'Let me read the main auth module.', {
        tool_calls: [
          { id: 'tc5', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg(
        'tool',
        'import jwt from "jsonwebtoken";\n\nexport function verify(token: string) {\n  return jwt.verify(token, process.env.SECRET!);\n}\n\nexport function sign(payload: object) {\n  return jwt.sign(payload, process.env.SECRET!, { expiresIn: "1h" });\n}',
      ),
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
          'pace.\n\n' +
          'The biggest advantage is temporal decoupling. Under the old model, a single slow downstream ' +
          'dependency could cascade latency across the entire checkout flow. With events, the order ' +
          'service does its own work, publishes, and returns. Downstream processing happens asynchronously.\n\n' +
          'The trade-off is eventual consistency. In an event-driven model, you have to design for the ' +
          'possibility that the inventory adjustment has not happened yet when the user sees their ' +
          'confirmation page. We handle this through careful UX design and idempotent consumers.',
      ),
      msg('user', 'What about schema evolution?'),
      msg(
        'assistant',
        'Schema evolution is one of the hardest problems in event-driven systems. We settled on a ' +
          'strategy combining explicit versioning with backward-compatible evolution rules. Every event ' +
          'type carries a schema version number in its header. For non-breaking changes like adding ' +
          'optional fields, we increment the minor version. For breaking changes, we run both versions ' +
          'in parallel during a migration window. We also maintain a central schema registry that ' +
          'validates events at publish time.',
      ),
      msg('user', 'How do we handle ordering?'),
      msg(
        'assistant',
        'Our event platform guarantees ordering within a partition, but not across partitions. Events ' +
          'for the same aggregate go to the same partition based on the aggregate identifier. For rare ' +
          'cases needing cross-aggregate ordering, we use a sequence number stamped by the producer. ' +
          'The consumer tracks the last processed sequence number and detects gaps.',
      ),
      msg('user', 'And failure handling?'),
      msg(
        'assistant',
        'The platform guarantees at-least-once delivery. Consumers must be idempotent. Dead letter ' +
          'queues catch events that fail repeatedly. A reconciliation process periodically compares ' +
          'event-derived state against the source of truth.',
      ),
    ],
  };
}

function structuredContent(): Scenario {
  const authProse =
    'Setting up authentication for a production environment requires careful planning across ' +
    'several layers of the system. The first step is establishing a strong identity provider. ' +
    'You will want to implement token-based authentication with short-lived access tokens and ' +
    'longer-lived refresh tokens. Password hashing should use a modern algorithm. Session ' +
    'management needs to handle concurrent logins gracefully. Rate limiting on authentication ' +
    'endpoints is essential to prevent brute force attacks.';
  const monitoringProse =
    'Monitoring a production environment effectively means collecting metrics at every layer. ' +
    'Start with infrastructure metrics like memory utilization and disk throughput. Application ' +
    'metrics should track request rates, error rates, and response time distributions. Log ' +
    'aggregation brings all service output into a single searchable store. Alerting rules ' +
    'should be tuned to minimize noise while catching real incidents.';
  return {
    name: 'Structured content',
    messages: [
      msg('system', 'You are a DevOps consultant helping set up a production environment.'),
      msg('user', 'Set up our production environment with all the credentials.'),
      msg(
        'assistant',
        'Here are the environment variables you need to configure:\n\n' +
          'STRIPE_SECRET_KEY=sk_live_Rz4x8Kp2Qm7Yn3Wv9Bt6Jh0L\n' +
          'GITHUB_TOKEN=ghp_Mn3Kx8Rz4Qp7Yv2Wt9Bj6Lh0Ds5Fa1Gc8Eu4Iw\n' +
          'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
          'SENDGRID_API_KEY=SG.xY7kZmN2pQ9rS4tU6vW8aB.cD3eF5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7f',
      ),
      msg('user', 'What about the database schema?'),
      msg(
        'assistant',
        'Here is the initial schema:\n\nCREATE TABLE audit_logs (\n  id SERIAL PRIMARY KEY,\n  user_id INTEGER NOT NULL,\n  action VARCHAR(100) NOT NULL,\n  resource_type VARCHAR(50),\n  resource_id INTEGER,\n  details TEXT,\n  created_at TIMESTAMP DEFAULT NOW(),\n  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE\n);',
      ),
      msg('user', 'How should we handle authentication?'),
      msg('assistant', authProse),
      msg('user', 'What about monitoring?'),
      msg('assistant', monitoringProse),
      msg('user', 'Show me a dashboard configuration.'),
      msg(
        'assistant',
        'Here is a starter dashboard configuration:\n\n```json\n{\n  "dashboard": "production-overview",\n  "refresh_interval": 30,\n  "panels": [\n    { "title": "Request Rate", "type": "graph", "metric": "http_requests_total" },\n    { "title": "Error Rate", "type": "graph", "metric": "http_errors_total" },\n    { "title": "P99 Latency", "type": "gauge", "metric": "http_duration_p99" }\n  ]\n}\n```',
      ),
      msg('user', 'Thanks, this is exactly what I needed.'),
    ],
  };
}

function agenticCodingSession(): Scenario {
  const authModule =
    'import jwt from "jsonwebtoken";\nimport { Request, Response, NextFunction } from "express";\n\nexport class AuthService {\n  private readonly secret: string;\n  private readonly refreshSecret: string;\n\n  constructor(secret: string, refreshSecret: string) {\n    this.secret = secret;\n    this.refreshSecret = refreshSecret;\n  }\n\n  verify(token: string): JWTPayload {\n    return jwt.verify(token, this.secret) as JWTPayload;\n  }\n\n  sign(payload: Omit<JWTPayload, "iat" | "exp">): string {\n    return jwt.sign(payload, this.secret, { expiresIn: "15m" });\n  }\n}\n';
  const authModuleV2 = authModule.replace('verify(', '// Validates token\n  validateToken(');
  const grepResults =
    'src/auth.ts:18:  verify(token: string): JWTPayload {\nsrc/middleware/validate.ts:7:  authService.verify(req.headers.authorization!);\ntests/auth.test.ts:14:      service.verify(token);\n';
  const testOutput =
    ' ✓ tests/auth.test.ts (5 tests) 42ms\n   ✓ sign and verify > produces a valid JWT\n   ✗ refresh > rotates token correctly\n     → expected "user1" but got undefined\n Tests  4 passed | 1 failed\n';

  return {
    name: 'Agentic coding session',
    messages: [
      msg('system', 'You are a senior TypeScript developer.'),
      msg('user', 'Read the auth module and tell me what it does.'),
      msg('assistant', 'Let me read that file.', {
        tool_calls: [
          { id: 'tc1', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg('tool', authModule),
      msg('assistant', 'This is an AuthService class handling JWT authentication.'),
      msg('user', 'Search for all usages of validateToken.'),
      msg('assistant', 'Searching.', {
        tool_calls: [{ id: 'tc2', function: { name: 'grep', arguments: '{"pattern":"verify"}' } }],
      }),
      msg('tool', grepResults),
      msg('assistant', 'Found references across auth.ts, validate.ts, and tests.'),
      msg('user', 'Add a test for refresh token rotation.'),
      msg('assistant', 'Let me re-read auth.ts.', {
        tool_calls: [
          { id: 'tc3', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } },
        ],
      }),
      msg('tool', authModuleV2), // near-duplicate
      msg('assistant', 'Adding the rotation test.', {
        tool_calls: [
          { id: 'tc4', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
        ],
      }),
      msg('tool', 'File updated successfully.'),
      msg('user', 'Run the tests.'),
      msg('assistant', 'Running.', {
        tool_calls: [
          { id: 'tc5', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testOutput),
      msg('assistant', 'The rotation test failed. Let me fix it.', {
        tool_calls: [
          { id: 'tc6', function: { name: 'edit', arguments: '{"path":"tests/auth.test.ts"}' } },
        ],
      }),
      msg('tool', 'File updated successfully.'),
      msg('assistant', 'Fixed. Running tests again.', {
        tool_calls: [
          { id: 'tc7', function: { name: 'exec', arguments: '{"cmd":"npx vitest run"}' } },
        ],
      }),
      msg('tool', testOutput), // duplicate
      msg('assistant', 'All 5 tests passing now.'),
      msg('user', 'Nice, looks good.'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fix(n: number, d: number = 2): string {
  return n.toFixed(d);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

const BASELINES_DIR = resolve(import.meta.dirname, 'baselines', 'quality');

function saveQualityBaseline(baseline: QualityBaseline): void {
  mkdirSync(BASELINES_DIR, { recursive: true });
  const json = JSON.stringify(baseline, null, 2) + '\n';
  writeFileSync(join(BASELINES_DIR, 'current.json'), json);
  const historyDir = join(BASELINES_DIR, 'history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${baseline.gitRef.slice(0, 8)}.json`), json);
}

function loadQualityBaseline(): QualityBaseline | null {
  const path = join(BASELINES_DIR, 'current.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const flagSave = args.includes('--save');
  const flagCheck = args.includes('--check');
  const flagLlmJudge = args.includes('--llm-judge');
  const flagFeatures = args.includes('--features');

  const version = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ).version;
  const gitRef = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

  console.log();
  console.log(`Compression Quality Benchmark — v${version} (${gitRef.slice(0, 8)})`);

  // --- Build all scenarios ---
  const coreScenarios = buildCoreScenarios();
  const edgeScenarios = buildEdgeCaseScenarios();
  const allScenarios = [...coreScenarios, ...edgeScenarios];

  // --- Run quality analysis ---
  const qualityResults: Record<string, QualityResult> = {};

  const qHeader = [
    'Scenario'.padEnd(24),
    'Ratio'.padStart(6),
    'EntRet'.padStart(7),
    'CodeOK'.padStart(7),
    'InfDen'.padStart(7),
    'Probes'.padStart(7),
    'Pass'.padStart(5),
    'NegCp'.padStart(6),
    'Coher'.padStart(6),
    'CmpQ'.padStart(6),
    'OvhdR'.padStart(7),
  ].join('  ');
  const qSep = '-'.repeat(qHeader.length);

  console.log();
  console.log('Quality Analysis');
  console.log(qSep);
  console.log(qHeader);
  console.log(qSep);

  for (const scenario of allScenarios) {
    const probes = getProbesForScenario(scenario.name);

    // Time the compression for overhead ratio
    const inputTokens = scenario.messages.reduce((sum, m) => {
      const len = typeof m.content === 'string' ? m.content.length : 0;
      return sum + Math.ceil(len / 3.5);
    }, 0);
    const t0 = performance.now();
    const q = analyzeQuality(scenario.messages, probes);
    const elapsed = performance.now() - t0;
    const overhead = computeOverheadRatio(elapsed, inputTokens);
    q.overheadRatio = overhead;

    qualityResults[scenario.name] = q;

    console.log(
      [
        scenario.name.padEnd(24),
        fix(q.ratio).padStart(6),
        pct(q.avgEntityRetention).padStart(7),
        pct(q.codeBlockIntegrity).padStart(7),
        fix(q.informationDensity).padStart(7),
        `${q.probesPassed}/${q.probesTotal}`.padStart(7),
        pct(q.probePassRate).padStart(5),
        String(q.negativeCompressions).padStart(6),
        String(q.coherenceIssues).padStart(6),
        fix(q.compressedQualityScore).padStart(6),
        fix(overhead, 3).padStart(7),
      ].join('  '),
    );
  }

  console.log(qSep);

  // --- Probe failure detail ---
  const failedProbes: { scenario: string; label: string }[] = [];
  for (const scenario of allScenarios) {
    const q = qualityResults[scenario.name];
    for (const pr of q.probeResults) {
      if (!pr.passed) {
        failedProbes.push({ scenario: scenario.name, label: pr.label });
      }
    }
  }

  if (failedProbes.length > 0) {
    console.log();
    console.log('Probe Failures');
    console.log('-'.repeat(60));
    for (const f of failedProbes) {
      console.log(`  ${f.scenario}: ${f.label}`);
    }
    console.log('-'.repeat(60));
  } else {
    console.log('\nAll probes passed.');
  }

  // --- Round-trip verification ---
  let rtFails = 0;
  for (const scenario of allScenarios) {
    const cr = compress(scenario.messages, { recencyWindow: 0 });
    const er = uncompress(cr.messages, cr.verbatim);
    const pass =
      JSON.stringify(scenario.messages) === JSON.stringify(er.messages) &&
      er.missing_ids.length === 0;
    if (!pass) {
      console.error(`  FAIL: ${scenario.name} failed round-trip`);
      rtFails++;
    }
  }

  if (rtFails > 0) {
    console.error(`\n${rtFails} scenario(s) failed round-trip verification.`);
    process.exit(1);
  }
  console.log('\nAll scenarios passed round-trip verification.');

  // --- Tradeoff sweep ---
  const tradeoffScenarios = [
    'Deep conversation',
    'Coding assistant',
    'Technical explanation',
    'Agentic coding session',
  ];
  const tradeoffResults: Record<string, TradeoffResult> = {};

  console.log();
  console.log('Tradeoff Sweep (ratio vs quality)');

  const tHeader = [
    'Scenario'.padEnd(24),
    'Points'.padStart(7),
    'Q@2x'.padStart(6),
    'Q@3x'.padStart(6),
    'MaxR@80%Q'.padStart(10),
  ].join('  ');
  const tSep = '-'.repeat(tHeader.length);

  console.log(tSep);
  console.log(tHeader);
  console.log(tSep);

  for (const scenario of allScenarios.filter((s) => tradeoffScenarios.includes(s.name))) {
    const points = sweepTradeoff(scenario.messages);
    const summary = summarizeTradeoff(points);
    tradeoffResults[scenario.name] = summary;

    console.log(
      [
        scenario.name.padEnd(24),
        String(summary.points.length).padStart(7),
        (summary.qualityAt2x != null ? fix(summary.qualityAt2x) : '-').padStart(6),
        (summary.qualityAt3x != null ? fix(summary.qualityAt3x) : '-').padStart(6),
        fix(summary.maxRatioAbove80pctQuality).padStart(10),
      ].join('  '),
    );
  }

  console.log(tSep);

  // --- Per-message quality details for entity-dense scenario ---
  const entityDense = qualityResults['Entity-dense technical'];
  if (entityDense && entityDense.messages.length > 0) {
    console.log();
    console.log('Per-Message Quality (Entity-dense technical)');

    const mHeader = [
      'MsgID'.padEnd(8),
      'Action'.padEnd(12),
      'In'.padStart(6),
      'Out'.padStart(6),
      'Ratio'.padStart(6),
      'EntRet'.padStart(7),
      'Code'.padStart(5),
    ].join('  ');
    const mSep = '-'.repeat(mHeader.length);

    console.log(mSep);
    console.log(mHeader);
    console.log(mSep);

    for (const m of entityDense.messages) {
      console.log(
        [
          m.messageId.padEnd(8),
          m.action.padEnd(12),
          String(m.inputChars).padStart(6),
          String(m.outputChars).padStart(6),
          fix(m.localRatio).padStart(6),
          pct(m.entityRetention).padStart(7),
          (m.codeBlocksIntact ? 'ok' : 'LOSS').padStart(5),
        ].join('  '),
      );
    }

    console.log(mSep);
  }

  // --- Opt-in features comparison (optional) ---
  if (flagFeatures) {
    const featureConfigs: { label: string; options: Record<string, unknown> }[] = [
      {
        label: 'importance + contradiction',
        options: { importanceScoring: true, contradictionDetection: true },
      },
      {
        label: 'semantic clustering',
        options: { semanticClustering: true },
      },
      {
        label: 'conversation flow',
        options: { conversationFlow: true },
      },
      {
        label: 'coreference',
        options: { coreference: true },
      },
      {
        label: 'all features',
        options: {
          importanceScoring: true,
          contradictionDetection: true,
          semanticClustering: true,
          conversationFlow: true,
          coreference: true,
        },
      },
    ];

    for (const config of featureConfigs) {
      console.log();
      console.log(`Feature: ${config.label}`);

      const fHeader = [
        'Scenario'.padEnd(24),
        'Ratio'.padStart(6),
        'EntRet'.padStart(7),
        'Probes'.padStart(7),
        'Pass'.padStart(5),
        'Coher'.padStart(6),
        'CmpQ'.padStart(6),
        'vs base'.padStart(8),
      ].join('  ');
      const fSep = '-'.repeat(fHeader.length);

      console.log(fSep);
      console.log(fHeader);
      console.log(fSep);

      for (const scenario of allScenarios) {
        const probes = getProbesForScenario(scenario.name);
        const q = analyzeQuality(scenario.messages, probes, config.options);
        const baseQ = qualityResults[scenario.name];

        // Compare probe pass rate vs baseline
        const probeDelta = q.probePassRate - baseQ.probePassRate;
        const deltaStr =
          probeDelta > 0.001 ? `+${pct(probeDelta)}` : probeDelta < -0.001 ? pct(probeDelta) : '=';

        console.log(
          [
            scenario.name.padEnd(24),
            fix(q.ratio).padStart(6),
            pct(q.avgEntityRetention).padStart(7),
            `${q.probesPassed}/${q.probesTotal}`.padStart(7),
            pct(q.probePassRate).padStart(5),
            String(q.coherenceIssues).padStart(6),
            fix(q.compressedQualityScore).padStart(6),
            deltaStr.padStart(8),
          ].join('  '),
        );
      }

      console.log(fSep);
    }
  }

  // --- LLM Judge (optional) ---
  if (flagLlmJudge) {
    const providers = await detectProviders();
    if (providers.length === 0) {
      console.log('\nNo LLM providers detected — skipping LLM judge.');
      console.log(
        '  Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OLLAMA_HOST',
      );
    } else {
      // Only judge scenarios that actually compress
      const judgeable = allScenarios.filter((s) => qualityResults[s.name]?.ratio > 1.01);

      for (const provider of providers) {
        console.log();
        console.log(`LLM Judge — ${provider.name}/${provider.model}`);

        const jHeader = [
          'Scenario'.padEnd(24),
          'Meaning'.padStart(8),
          'Coher'.padStart(6),
          'Overall'.padStart(8),
          'Info Loss'.padStart(40),
        ].join('  ');
        const jSep = '-'.repeat(jHeader.length);

        console.log(jSep);
        console.log(jHeader);
        console.log(jSep);

        const scores: LlmJudgeScore[] = [];
        for (const scenario of judgeable) {
          const cr = compress(scenario.messages, { recencyWindow: 0 });
          try {
            const score = await runLlmJudge(
              scenario.name,
              scenario.messages,
              cr.messages,
              provider.callLlm,
              provider.name,
              provider.model,
            );
            scores.push(score);

            const lossDisplay =
              score.informationLoss.length > 40
                ? score.informationLoss.slice(0, 37) + '...'
                : score.informationLoss;

            console.log(
              [
                scenario.name.padEnd(24),
                `${score.meaningPreserved}/5`.padStart(8),
                `${score.coherence}/5`.padStart(6),
                `${score.overall}/5`.padStart(8),
                lossDisplay.padStart(40),
              ].join('  '),
            );
          } catch (err) {
            console.log(
              `  ${scenario.name.padEnd(24)}  ERROR: ${(err as Error).message.slice(0, 60)}`,
            );
          }
        }

        console.log(jSep);

        if (scores.length > 0) {
          const avgMeaning = scores.reduce((s, sc) => s + sc.meaningPreserved, 0) / scores.length;
          const avgCoherence = scores.reduce((s, sc) => s + sc.coherence, 0) / scores.length;
          const avgOverall = scores.reduce((s, sc) => s + sc.overall, 0) / scores.length;
          console.log(
            `  Average: meaning=${fix(avgMeaning)}/5  coherence=${fix(avgCoherence)}/5  overall=${fix(avgOverall)}/5`,
          );
        }
      }
    }
  }

  // --- Save / Check ---
  const baseline: QualityBaseline = {
    version,
    gitRef,
    generated: new Date().toISOString(),
    results: {
      scenarios: qualityResults,
      tradeoff: tradeoffResults,
    },
  };

  if (flagSave) {
    saveQualityBaseline(baseline);
    console.log(`\nQuality baseline saved (v${version}, ${gitRef.slice(0, 8)}).`);
  }

  if (flagCheck) {
    const existing = loadQualityBaseline();
    if (!existing) {
      console.error('\nNo quality baseline found — run with --save first.');
      process.exit(1);
    }

    const regressions = compareQualityResults(existing, baseline);
    if (regressions.length > 0) {
      console.error(`\n${regressions.length} quality regression(s) detected:`);
      for (const r of regressions) {
        console.error(
          `  [${r.benchmark}] ${r.scenario} → ${r.metric}: expected ${fix(r.expected)}, got ${fix(r.actual)} (${r.delta})`,
        );
      }
      process.exit(1);
    }
    console.log(`\nQuality baseline check passed (v${existing.version}).`);
  }

  console.log();
  console.log('Quality benchmarks complete.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
