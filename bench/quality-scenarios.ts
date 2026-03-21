import type { Message } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 50000; // high offset to avoid collisions with run.ts scenarios

function msg(role: string, content: string, extra?: Partial<Message>): Message {
  const id = String(nextId++);
  return { id, index: nextId - 1, role, content, metadata: {}, ...extra };
}

export function resetEdgeIds(): void {
  nextId = 50000;
}

// ---------------------------------------------------------------------------
// Edge case scenarios
// ---------------------------------------------------------------------------

export interface Scenario {
  name: string;
  messages: Message[];
}

/**
 * 10 messages with trivially short content — "y", "n", "k", etc.
 * Tests that the engine does not crash or produce garbage on minimal input.
 */
export function singleCharMessages(): Scenario {
  return {
    name: 'Single-char messages',
    messages: [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'Ready?'),
      msg('assistant', 'y'),
      msg('user', 'Deploy?'),
      msg('assistant', 'k'),
      msg('user', 'Rollback?'),
      msg('assistant', 'n'),
      msg('user', 'Again?'),
      msg('assistant', 'y'),
      msg('user', 'ok'),
    ],
  };
}

/**
 * One user message with ~50KB of mixed prose and code.
 * Tests summarizer behavior on extremely long single messages.
 */
export function giantSingleMessage(): Scenario {
  const prose =
    'The distributed tracing system collects span data from each microservice ' +
    'and correlates them into a single trace using a propagated trace identifier. ' +
    'Each span records the service name, operation, duration, and any error status. ';

  const code =
    '```typescript\n' +
    'export class TracingService {\n' +
    '  private readonly spans: Map<string, Span> = new Map();\n' +
    '\n' +
    '  startSpan(traceId: string, operation: string): Span {\n' +
    '    const span: Span = {\n' +
    '      traceId,\n' +
    '      spanId: crypto.randomUUID(),\n' +
    '      operation,\n' +
    '      startTime: Date.now(),\n' +
    '      status: "ok",\n' +
    '    };\n' +
    '    this.spans.set(span.spanId, span);\n' +
    '    return span;\n' +
    '  }\n' +
    '\n' +
    '  endSpan(spanId: string, error?: Error): void {\n' +
    '    const span = this.spans.get(spanId);\n' +
    '    if (!span) return;\n' +
    '    span.endTime = Date.now();\n' +
    '    span.duration = span.endTime - span.startTime;\n' +
    '    if (error) span.status = "error";\n' +
    '  }\n' +
    '}\n' +
    '```';

  // Build ~50KB content
  const chunks: string[] = [];
  let size = 0;
  while (size < 50_000) {
    chunks.push(prose.repeat(5));
    chunks.push(code);
    size = chunks.join('\n\n').length;
  }

  return {
    name: 'Giant single message',
    messages: [
      msg('system', 'You are a senior software architect.'),
      msg('user', 'Explain our tracing infrastructure in detail.'),
      msg('assistant', chunks.join('\n\n')),
      msg('user', 'Thanks, that helps.'),
    ],
  };
}

/**
 * All messages are entirely code fences with no prose.
 * Tests that code preservation is 100% and the engine does not compress inside fences.
 */
export function codeOnlyConversation(): Scenario {
  return {
    name: 'Code-only conversation',
    messages: [
      msg('system', 'You are a code assistant. Only respond with code.'),
      msg(
        'user',
        '```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```',
      ),
      msg(
        'assistant',
        '```typescript\nimport { describe, it, expect } from "vitest";\nimport { add } from "./math";\n\ndescribe("add", () => {\n  it("adds two numbers", () => {\n    expect(add(2, 3)).toBe(5);\n  });\n\n  it("handles negatives", () => {\n    expect(add(-1, 1)).toBe(0);\n  });\n});\n```',
      ),
      msg(
        'user',
        '```python\ndef fibonacci(n: int) -> list[int]:\n    if n <= 0:\n        return []\n    if n == 1:\n        return [0]\n    seq = [0, 1]\n    for _ in range(2, n):\n        seq.append(seq[-1] + seq[-2])\n    return seq\n```',
      ),
      msg(
        'assistant',
        '```python\nimport pytest\nfrom fibonacci import fibonacci\n\ndef test_empty():\n    assert fibonacci(0) == []\n\ndef test_single():\n    assert fibonacci(1) == [0]\n\ndef test_sequence():\n    assert fibonacci(7) == [0, 1, 1, 2, 3, 5, 8]\n```',
      ),
      msg(
        'user',
        "```sql\nSELECT u.id, u.email, COUNT(o.id) AS order_count\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nWHERE u.created_at > NOW() - INTERVAL '30 days'\nGROUP BY u.id, u.email\nHAVING COUNT(o.id) > 5\nORDER BY order_count DESC;\n```",
      ),
      msg(
        'assistant',
        "```sql\nCREATE INDEX idx_orders_user_id ON orders (user_id);\nCREATE INDEX idx_users_created_at ON users (created_at);\n\nEXPLAIN ANALYZE\nSELECT u.id, u.email, COUNT(o.id) AS order_count\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nWHERE u.created_at > NOW() - INTERVAL '30 days'\nGROUP BY u.id, u.email\nHAVING COUNT(o.id) > 5\nORDER BY order_count DESC;\n```",
      ),
    ],
  };
}

/**
 * Messages packed with identifiers, file paths, version numbers, and config values.
 * Tests entity retention under pressure.
 */
export function entityDenseTechnical(): Scenario {
  return {
    name: 'Entity-dense technical',
    messages: [
      msg('system', 'You are a DevOps engineer.'),
      msg(
        'user',
        'The getUserProfile endpoint in src/api/users.ts is failing with a 503 from the authService. ' +
          'We see the error in the CloudWatch dashboard at https://console.aws.amazon.com/cloudwatch/metrics/api-gateway. ' +
          'The Redis cluster (redis-prod-001.abc123.usw2.cache.amazonaws.com:6379) has 98% memory utilization. ' +
          'The PostgreSQL connection pool (max_connections=200) is exhausted per pg_stat_activity. ' +
          "Node version is v22.3.0 and we're running context-compression-engine@1.2.0.",
      ),
      msg(
        'assistant',
        'Looking at the getUserProfile failure chain: the authService depends on validateToken which ' +
          'reads from Redis via ioredis v5.4.1. At 98% memory on redis-prod-001, the eviction policy ' +
          '(allkeys-lru) is likely expiring session tokens before the 7d TTL. The PostgreSQL pool ' +
          'exhaustion (200/200 in pg_stat_activity) suggests the connection leak I flagged in PR #142. ' +
          'Check src/db/pool.ts — the acquireTimeout of 30 seconds is too generous. Reduce to 5 seconds ' +
          'and add the connection.release() call in the finally block of src/middleware/auth.ts:L47. ' +
          'For Redis, either scale to r7g.xlarge or reduce the session TTL to 24 hours in config/redis.yaml.',
      ),
      msg(
        'user',
        'The getOrderHistory endpoint at /api/v2/orders is also slow. The p99 latency jumped from ' +
          '120ms to 3400ms after we deployed commit abc123f. The Datadog trace shows the bottleneck is ' +
          'in src/services/orderService.ts:buildOrderSummary where it makes N+1 queries. The MySQL ' +
          'table orders has 14M rows and the idx_orders_user_created index is missing. We need to add ' +
          'it before the v2.5.0 release on 2026-04-01.',
      ),
      msg(
        'assistant',
        'The N+1 in orderService.ts:buildOrderSummary is the root cause. Each iteration calls ' +
          'getOrderItems which runs a separate SELECT against the order_items table (28M rows). Fix: ' +
          'rewrite to a single JOIN query in src/repositories/orderRepository.ts. Add the composite ' +
          'index: CREATE INDEX idx_orders_user_created ON orders (user_id, created_at DESC). The ' +
          'p99 should drop back to ~150ms. For the v2.5.0 release, also run the migration in ' +
          'migrations/20260321_add_order_indexes.sql and update the Terraform config in ' +
          'infra/rds.tf to set max_connections=300.',
      ),
    ],
  };
}

/**
 * Pure prose with zero technical content.
 * Tests that the engine compresses aggressively when there is nothing to preserve.
 */
export function proseOnlyConversation(): Scenario {
  const prose1 =
    'The team meeting yesterday covered several important topics that we should keep in mind ' +
    'going forward. The project timeline is still on track according to the product manager, ' +
    'though there were some concerns raised about the quality of recent deliverables. The ' +
    'design team presented their latest mockups and received generally positive feedback from ' +
    'the stakeholders. There was a brief discussion about hiring plans for the next quarter, ' +
    'and the consensus was to focus on filling the two open senior positions before adding any ' +
    'junior roles. The marketing team mentioned that the campaign metrics have been trending ' +
    'upward over the past month, which was encouraging news for everyone.';

  const prose2 =
    'Following up on the discussion about workflow improvements, several team members suggested ' +
    'that the current review process takes too long and could benefit from some streamlining. ' +
    'The main bottleneck seems to be the handoff between the content creation phase and the ' +
    'editorial review phase, where items often sit in a queue for several days before being ' +
    'picked up. One proposal was to implement a rotating reviewer system so that no single ' +
    'person becomes a bottleneck. Another suggestion was to add clearer guidelines about what ' +
    'constitutes a review-ready submission, which could reduce the number of items bounced ' +
    'back for revision. The group agreed to try both approaches on a trial basis for the next ' +
    'sprint and evaluate the results.';

  const prose3 =
    'The retrospective highlighted both positive developments and areas for improvement. On ' +
    'the positive side, communication within the team has improved significantly since we ' +
    'started the weekly sync meetings, and cross-team collaboration on the last project was ' +
    'notably smoother than previous efforts. Areas for improvement include documentation ' +
    'practices, which remain inconsistent across the organization, and the onboarding process ' +
    'for new team members, which several recent hires described as disorganized and incomplete. ' +
    'Action items from the retrospective include creating a documentation template, updating ' +
    'the onboarding checklist, and scheduling a follow-up session to track progress on these ' +
    'initiatives.';

  return {
    name: 'Prose-only conversation',
    messages: [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'Can you summarize our team meeting notes?'),
      msg('assistant', prose1),
      msg('user', 'What about the workflow discussion?'),
      msg('assistant', prose2),
      msg('user', 'And the retrospective?'),
      msg('assistant', prose3),
      msg('user', 'Great summary, thanks.'),
      msg('assistant', 'You are welcome. Let me know if you need anything else.'),
    ],
  };
}

/**
 * Messages with inline code in different languages (Python, SQL, JSON, YAML).
 * Tests multi-format preservation in the same conversation.
 */
export function mixedLanguages(): Scenario {
  return {
    name: 'Mixed languages',
    messages: [
      msg('system', 'You are a full-stack developer.'),
      msg(
        'user',
        'Show me the Python data processing script, the SQL migration, the JSON config, and the YAML deployment manifest.',
      ),
      msg(
        'assistant',
        'Here is the data processing pipeline:\n\n' +
          '```python\n' +
          'import pandas as pd\n' +
          'from datetime import datetime, timedelta\n\n' +
          'def process_daily_metrics(df: pd.DataFrame) -> pd.DataFrame:\n' +
          '    cutoff = datetime.now() - timedelta(days=30)\n' +
          '    filtered = df[df["timestamp"] >= cutoff]\n' +
          '    return (\n' +
          '        filtered\n' +
          '        .groupby("service_name")\n' +
          '        .agg({"latency_ms": ["mean", "p99"], "error_count": "sum"})\n' +
          '        .reset_index()\n' +
          '    )\n' +
          '```\n\n' +
          'The SQL migration for the metrics table:\n\n' +
          '```sql\n' +
          'CREATE TABLE daily_metrics (\n' +
          '  id BIGSERIAL PRIMARY KEY,\n' +
          '  service_name VARCHAR(100) NOT NULL,\n' +
          '  metric_date DATE NOT NULL,\n' +
          '  avg_latency_ms DECIMAL(10, 2),\n' +
          '  p99_latency_ms DECIMAL(10, 2),\n' +
          '  total_errors INTEGER DEFAULT 0,\n' +
          '  UNIQUE (service_name, metric_date)\n' +
          ');\n' +
          '```\n\n' +
          'The service configuration:\n\n' +
          '```json\n' +
          '{\n' +
          '  "service": "metrics-processor",\n' +
          '  "version": "2.1.0",\n' +
          '  "database": {\n' +
          '    "host": "metrics-db.internal",\n' +
          '    "port": 5432,\n' +
          '    "pool_size": 20\n' +
          '  },\n' +
          '  "processing": {\n' +
          '    "batch_size": 1000,\n' +
          '    "max_retries": 3,\n' +
          '    "timeout_ms": 30000\n' +
          '  }\n' +
          '}\n' +
          '```\n\n' +
          'And the Kubernetes deployment:\n\n' +
          '```yaml\n' +
          'apiVersion: apps/v1\n' +
          'kind: Deployment\n' +
          'metadata:\n' +
          '  name: metrics-processor\n' +
          '  namespace: data-pipeline\n' +
          'spec:\n' +
          '  replicas: 3\n' +
          '  selector:\n' +
          '    matchLabels:\n' +
          '      app: metrics-processor\n' +
          '  template:\n' +
          '    spec:\n' +
          '      containers:\n' +
          '        - name: processor\n' +
          '          image: registry.internal/metrics-processor:2.1.0\n' +
          '          resources:\n' +
          '            requests:\n' +
          '              memory: "512Mi"\n' +
          '              cpu: "500m"\n' +
          '            limits:\n' +
          '              memory: "1Gi"\n' +
          '              cpu: "1000m"\n' +
          '```',
      ),
      msg('user', 'Looks good. What about monitoring for this service?'),
      msg(
        'assistant',
        'For monitoring, add Prometheus annotations to the deployment and set up alerting. ' +
          'The metrics-processor service should expose a /metrics endpoint that Prometheus scrapes ' +
          'every 15 seconds. Configure alerts for error_count exceeding 100 per minute and p99 ' +
          'latency exceeding 5000 milliseconds. Use the Grafana dashboard at ' +
          'grafana.internal/d/metrics-processor for visualization.',
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildEdgeCaseScenarios(): Scenario[] {
  resetEdgeIds();
  return [
    singleCharMessages(),
    giantSingleMessage(),
    codeOnlyConversation(),
    entityDenseTechnical(),
    proseOnlyConversation(),
    mixedLanguages(),
  ];
}
