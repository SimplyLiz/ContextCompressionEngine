# CCE v2 Improvement Roadmap

Working document for systematically improving compression rate, quality, and observability.
Based on a survey of ~20 papers (2023–2026) mapped against the current pipeline.

**Baseline (v1.1.0):** 2.01x avg compression | 4.90x peak | 42% messages compressed | 100% round-trip integrity

---

## Phase 1 — Quick Wins (low effort, high signal)

### 1.1 Entity Retention Metric

**Status:** [ ] Not started
**Files:** `src/compress.ts`, `src/types.ts`
**Papers:** Understanding and Improving Information Preservation (EMNLP 2025 Findings) — arxiv.org/abs/2503.19114

**What:** Add `entity_retention` to `CompressResult.compression` — ratio of technical identifiers (camelCase, snake_case, file paths, URLs, version numbers, code refs) preserved after compression vs. before.

**Why:** We currently report ratio and token_ratio but have no quality signal. Entity retention is concrete, measurable, and we already extract entities in the summarizer. Users get a number they can trust: "95% of identifiers survived."

**Implementation:**

- [ ] Extract entities from all input messages (reuse existing entity regex from `compress.ts` lines 120–140)
- [ ] Extract entities from all output messages
- [ ] Compute `entity_retention = entities_in_output / entities_in_input`
- [ ] Add to `CompressResult.compression` type
- [ ] Add to benchmark report output
- [ ] Add test: compress a message with 10 known identifiers, assert retention >= 0.9

**Acceptance:** Benchmark reports show entity_retention per scenario. All existing tests pass.

---

### 1.2 Relevance Threshold ("Output Nothing" Strategy)

**Status:** [ ] Not started
**Files:** `src/compress.ts`, `src/types.ts`
**Papers:** RECOMP (ICLR 2024) — arxiv.org/abs/2310.04408

**What:** When no sentence in a T2 message scores above a minimum threshold, replace the entire message with a stub like `[N messages of general discussion omitted]` instead of producing a low-quality summary. Verbatim still stored.

**Why:** Current pipeline always produces _some_ output for T2 messages, even when content adds nothing. The agentic (1.48x) and tool-heavy (1.41x) scenarios have lots of low-value assistant prose that should be eliminated, not summarized.

**Implementation:**

- [ ] Add `relevanceThreshold?: number` to `CompressOptions` (default: off / 0)
- [ ] In summarize stage: if best sentence score < threshold, return stub instead of summary
- [ ] Group consecutive stubbed messages into a single `[N messages omitted]` block
- [ ] Track `messages_relevance_dropped` in stats
- [ ] Verbatim store still holds originals (round-trip integrity preserved)
- [ ] Add test: 5 filler messages in a row → single stub, expandable
- [ ] Benchmark: compare agentic/tool-heavy scenarios with threshold=0.3 vs. off

**Acceptance:** Agentic scenario moves from 1.48x toward ~1.8x+. Round-trip integrity maintained. No regression on technical/coding scenarios.

---

### 1.3 Compression Quality Score (Composite)

**Status:** [ ] Not started
**Files:** `src/compress.ts`, `src/types.ts`
**Papers:** Information Preservation paper (EMNLP 2025), Selective Context (EMNLP 2023)

**What:** Combine entity_retention, structural_integrity (code fences, JSON blocks survived intact), and summary_coherence (no dangling references) into a single `quality_score` in `CompressResult`.

**Why:** A single number lets users make compression-vs-quality tradeoffs. "I got 3x compression at 0.92 quality" is actionable.

**Implementation:**

- [ ] `entity_retention` (from 1.1): weight 0.4
- [ ] `structural_integrity`: count structural elements (fences, JSON blocks, tables) before/after — weight 0.4
- [ ] `reference_coherence`: check that identifiers mentioned in kept messages aren't orphaned by removed messages — weight 0.2
- [ ] `quality_score = weighted sum`, clamped [0, 1]
- [ ] Add to `CompressResult.compression`
- [ ] Benchmark: report quality_score alongside ratio for all scenarios

**Acceptance:** All scenarios report quality_score >= 0.85. Score is intuitive (1.0 = perfect preservation).

---

## Phase 2 — Budget & Scoring Upgrades (medium effort, compression gain)

### 2.1 Component-Level Budget Allocation

**Status:** [ ] Not started
**Files:** `src/compress.ts`
**Papers:** LLMLingua (EMNLP 2023) — arxiv.org/abs/2310.05736

**What:** Replace the single binary-search-over-recencyWindow with per-tier budget allocation. Instead of uniformly shrinking the window, allocate token budget across message categories and compress each category to its sub-budget.

**Why:** Current binary search treats all messages equally. When budget is tight, it shrinks `recencyWindow` which can lose recent important messages. Per-tier allocation compresses old prose aggressively while keeping recent context intact.

**Tier budget distribution (configurable):**

```
System messages:     5% of budget  (light compression)
T0 content:          pass-through  (no compression, counted against budget)
Recent window:       40% of budget (preserved or light compression)
T2 older prose:      remaining     (aggressive compression)
T3 filler:           0%            (removed entirely)
```

**Implementation:**

- [ ] Add `budgetStrategy?: 'binary-search' | 'tiered'` to `CompressOptions` (default: 'binary-search' for backward compat)
- [ ] Implement tiered allocation: count T0 tokens first (fixed cost), distribute remainder
- [ ] Within T2 tier: compress oldest messages most aggressively (sliding scale)
- [ ] Integrate with importance scoring: high-importance T2 messages get more budget
- [ ] Add test: same tokenBudget, tiered vs binary-search — tiered preserves more recent messages
- [ ] Benchmark: compare both strategies across all scenarios

**Acceptance:** Tiered strategy matches or beats binary-search on all scenarios. Recent messages (last 4) never get truncated when older prose is available to compress.

---

### 2.2 Self-Information Scoring (Optional)

**Status:** [ ] Not started
**Files:** `src/compress.ts`, `src/types.ts`, new: `src/entropy.ts`
**Papers:** Selective Context (EMNLP 2023) — aclanthology.org/2023.emnlp-main.391

**What:** Replace or augment heuristic sentence scoring with information-theoretic scoring. Users provide an `entropyScorer` function that returns per-token surprise values from a small causal LM. High self-information tokens/sentences are preserved; predictable ones pruned.

**Why:** Heuristic scoring misses context-dependent importance. "The service returns 503" scores low on our heuristics (no camelCase, no emphasis) but "503" is highly surprising in context and crucial to preserve. Self-information captures this automatically.

**Implementation:**

- [ ] Add `entropyScorer?: (tokens: string[]) => number[] | Promise<number[]>` to `CompressOptions`
- [ ] New `src/entropy.ts`: sentence-level self-information aggregation (mean or sum of token scores)
- [ ] In summarize stage: if entropyScorer provided, use it instead of heuristic scoring
- [ ] Fallback: heuristic scoring when no scorer provided (zero-dependency preserved)
- [ ] Hybrid mode: combine entropy + heuristic (weighted average) for best of both
- [ ] Add test with mock scorer: high-entropy sentences preserved, low-entropy pruned
- [ ] Benchmark: compare heuristic vs mock-entropy on all scenarios

**Acceptance:** With a reasonable entropy scorer, compression ratio improves on prose-heavy scenarios. Deterministic fallback unchanged. Zero new runtime dependencies.

---

### 2.3 Adaptive Summary Budget

**Status:** [ ] Not started
**Files:** `src/compress.ts`

**What:** Current summary budget is fixed at 30% of content length, capped 200–600 chars. Make it adaptive based on content density: high-density messages (lots of entities, code refs) get a larger budget; low-density messages (general discussion) get a smaller budget.

**Why:** A message with 15 technical identifiers in 500 chars needs more summary space than 500 chars of "I think we should consider..." The fixed 30% either wastes budget on filler or under-compresses dense content.

**Implementation:**

- [ ] Compute content density: `entities_count / char_count`
- [ ] Scale budget: `base_ratio * (1 + density_bonus)`, where density_bonus = min(density \* k, 0.5)
- [ ] Dense content: up to 45% budget (more room for entities)
- [ ] Sparse content: down to 15% budget (more aggressive compression)
- [ ] Keep hard caps (min 100, max 800 chars)
- [ ] Add test: dense message gets longer summary than sparse message of same length

**Acceptance:** Entity retention improves on dense messages. Compression ratio improves on sparse messages. No regression on existing tests.

---

## Phase 3 — Structural Intelligence (high effort, quality gain)

### 3.1 Discourse Unit Decomposition (EDU-Lite)

**Status:** [ ] Not started
**Files:** new: `src/discourse.ts`, `src/compress.ts`
**Papers:** From Context to EDUs (arXiv Dec 2025) — arxiv.org/abs/2512.14244

**What:** Break messages into Elementary Discourse Units and build a lightweight dependency graph. When summarizing, select important subtrees rather than independent sentences.

**Why:** Sentence-level scoring treats sentences as independent. "Parse the JSON, then extract the user ID from the result" — removing the first sentence makes the second incoherent. Discourse structure captures these dependencies.

**Implementation (pragmatic / rule-based, no ML):**

- [ ] Segment sentences into EDUs using clause boundary detection (commas + discourse markers: "then", "so", "because", "which", "but", "however", "therefore")
- [ ] Build dependency edges: pronoun/demonstrative resolution ("it", "this", "that", "the result" → preceding EDU)
- [ ] Temporal chains: "first...then...finally" → sequential dependency
- [ ] Causal chains: "because...therefore" → causal dependency
- [ ] Score EDUs (reuse existing sentence scoring)
- [ ] Selection: when keeping an EDU, also keep its dependency parents (up to 2 levels)
- [ ] Integrate into summarize stage as an alternative to sentence-level scoring
- [ ] Add `discourseAware?: boolean` to `CompressOptions`
- [ ] Test: message with pronoun chain → referent preserved when reference is kept
- [ ] Test: "first X, then Y, finally Z" → keeping Z also keeps X and Y

**Acceptance:** Compressed output has fewer dangling references. reference_coherence metric (from 1.3) improves. No significant impact on compression ratio.

---

### 3.2 Cross-Message Coreference Tracking

**Status:** [ ] Not started
**Files:** new: `src/coreference.ts`, `src/compress.ts`

**What:** Track entity references across messages. When message B refers to an entity defined in message A, and B is kept, A (or at least the defining sentence) should be preserved or its definition inlined into B's summary.

**Why:** Current pipeline compresses messages independently. If message 3 says "the auth middleware" and message 7 says "update it to use JWT", compressing message 3 can lose what "it" refers to. Cross-message coreference prevents this.

**Implementation:**

- [ ] Build entity definition map: first mention of each entity → message index + sentence
- [ ] Build reference map: subsequent mentions → list of message indices that reference it
- [ ] During compression: if a referencing message is kept, check if its referents' defining messages are also kept
- [ ] If not: inline the entity definition into the referencing message's summary, or promote the defining message to preserved
- [ ] Lightweight approach: only track camelCase/snake_case/PascalCase identifiers and explicit noun phrases
- [ ] Add test: entity defined in msg 2, referenced in msg 8 — compressing msg 2 inlines definition into msg 8
- [ ] Ensure verbatim store still works (inlined definitions are compression artifacts, not original content)

**Acceptance:** No orphaned references in compressed output. Entity retention metric stays >= 0.95.

---

### 3.3 Conversation Flow Compression

**Status:** [ ] Not started
**Files:** `src/compress.ts`

**What:** Detect conversation patterns (question→answer, request→implementation→confirmation) and compress them as units rather than individual messages.

**Why:** A 3-message exchange "Can you add logging?" → "Done, added logger.info calls in auth.ts and api.ts" → "Perfect" compresses better as a unit: `[User requested logging → added to auth.ts, api.ts → confirmed]` than as 3 independent compressions.

**Implementation:**

- [ ] Detect Q&A pairs: user question followed by assistant answer
- [ ] Detect request chains: user request → assistant action → user confirmation
- [ ] Detect correction chains: assertion → correction → acknowledgment
- [ ] Merge detected chains into single compression units
- [ ] Produce chain-aware summaries that capture the arc (request → outcome)
- [ ] Respect importance scoring: high-importance chains get more budget
- [ ] Add `conversationFlow?: boolean` to `CompressOptions`
- [ ] Test: Q&A pair compressed into single summary preserving both question and answer key points

**Acceptance:** Conversation-heavy scenarios (deep conversation, long Q&A) see improved compression ratio while preserving the logical flow.

---

## Phase 4 — Advanced Compression Modes (medium-high effort, big ratio gains)

### 4.1 ML Token Classifier (Optional)

**Status:** [ ] Not started
**Files:** new: `src/ml-classifier.ts`, `src/types.ts`
**Papers:** LLMLingua-2 (ACL 2024) — arxiv.org/abs/2403.12968

**What:** Optional token-level keep/remove classifier using a small encoder model (BERT-class). Each token gets a binary label from full bidirectional context. Replaces rule-based classification for users who can run a ~500MB model.

**Why:** LLMLingua-2 achieves 2-5x compression at 95-98% accuracy retention, 3-6x faster than perplexity methods. Our rule-based classifier works well for structured content but misses nuance in prose.

**Implementation:**

- [ ] Define `MLClassifier` interface: `(content: string) => { keep: boolean, confidence: number }[]`
- [ ] Add `mlClassifier` to `CompressOptions`
- [ ] When provided: use ML classifier for T2 content (T0 rules still override for code/structured)
- [ ] Token-level output → reconstruct kept tokens into compressed text
- [ ] Training data: generate from existing test cases + GPT-4 compression pairs
- [ ] Ship as separate optional package (`@cce/ml-classifier`) to keep core zero-dependency
- [ ] Benchmark: compare rule-based vs ML on all scenarios

**Acceptance:** ML classifier improves compression on prose-heavy scenarios by 30%+. Core package stays zero-dependency. Rule-based fallback unchanged.

---

### 4.2 Progressive Compression Depth

**Status:** [ ] Not started
**Files:** `src/compress.ts`, `src/types.ts`
**Papers:** LLM-DCP (2025) — arxiv.org/abs/2504.11004, ACON (2025) — arxiv.org/abs/2510.00615

**What:** Multi-pass compression with increasing aggressiveness. First pass: gentle (sentence selection). Second pass: moderate (clause pruning). Third pass: aggressive (entity-only stubs). Each pass has quality gates.

**Why:** Single-pass compression has a fixed quality/ratio tradeoff. Progressive compression lets us push ratios higher while checking quality at each step. If a pass drops quality below threshold, we stop and use the previous pass's output.

**Implementation:**

- [ ] Define compression levels: `gentle` (sentence selection, ~2x) → `moderate` (clause pruning + entity stubs, ~4x) → `aggressive` (entity-only, ~8x)
- [ ] Add `compressionDepth?: 'gentle' | 'moderate' | 'aggressive' | 'auto'` to `CompressOptions`
- [ ] `auto` mode: compress progressively until tokenBudget is met or quality_score drops below threshold
- [ ] Quality gate between passes: check entity_retention and reference_coherence
- [ ] Each pass feeds into the next (use previous pass's output as input)
- [ ] Provenance: chain parent_ids across passes (already supported)
- [ ] Test: auto mode with tight budget produces 3-pass compression with quality above threshold
- [ ] Benchmark: compare single-pass vs progressive on deep conversation scenario

**Acceptance:** Deep conversation scenario (currently 2.50x) reaches 4x+ with quality_score >= 0.80. Progressive mode never produces worse output than single-pass.

---

### 4.3 Semantic Clustering

**Status:** [ ] Not started
**Files:** new: `src/cluster.ts`, `src/compress.ts`

**What:** Group messages by topic using lightweight semantic similarity (TF-IDF or entity overlap), then compress each cluster as a unit. Cross-cluster references get bridging stubs.

**Why:** Long conversations drift across topics. Compressing chronologically misses the opportunity to merge scattered messages about the same topic. "We discussed auth in messages 3, 7, 12, 19" → single compressed block about auth decisions.

**Implementation:**

- [ ] Extract topic vectors per message: TF-IDF over content words + entity overlap
- [ ] Cluster using simple agglomerative clustering (no ML dependency)
- [ ] Within each cluster: merge messages chronologically, compress as unit
- [ ] Cross-cluster bridges: when a message references entities from another cluster, add a brief bridge
- [ ] Add `semanticClustering?: boolean` to `CompressOptions`
- [ ] Respect recency window: recent messages stay unclustered
- [ ] Test: 20 messages alternating between 2 topics → 2 compressed cluster summaries
- [ ] Benchmark: long/deep conversation scenarios

**Acceptance:** Deep conversation (currently 2.50x) and long Q&A (4.90x) improve. Compressed output organized by topic is more coherent than chronological compression.

---

## Phase 5 — Evaluation & Benchmarking Infrastructure

### 5.1 Quality Benchmark Suite

**Status:** [ ] Not started
**Files:** `bench/`

**What:** Automated benchmark that measures compression quality, not just ratio. Run after every change to catch quality regressions.

**Metrics to track per scenario:**

- [ ] Compression ratio (existing)
- [ ] Token ratio (existing)
- [ ] Entity retention (from 1.1)
- [ ] Structural integrity (from 1.3)
- [ ] Reference coherence (from 1.3)
- [ ] Quality score (from 1.3)
- [ ] Round-trip integrity (existing)

**Implementation:**

- [ ] Extend `bench/run.ts` to compute and report quality metrics
- [ ] Add quality regression detection: fail if quality_score drops > 0.05 from baseline
- [ ] Generate comparison tables: before/after each phase
- [ ] Track metrics history in `bench/baselines/history/`

**Acceptance:** `npm run bench` reports both ratio and quality. CI fails on quality regression.

---

### 5.2 Adversarial Test Cases

**Status:** [ ] Not started
**Files:** `tests/`

**What:** Test cases specifically designed to break compression quality.

**Cases:**

- [ ] Pronoun-heavy message: "Do it like we discussed, but change the thing to use the other approach" — tests coreference
- [ ] Scattered entity: entity defined in msg 1, referenced in msgs 5, 10, 15 — tests cross-message tracking
- [ ] Correction chain: 3 contradictory instructions, only last is valid — tests contradiction detection
- [ ] Code interleaved with prose: alternating paragraphs of explanation and code — tests code-split
- [ ] Near-duplicate with critical difference: two messages identical except for one number — tests fuzzy dedup precision
- [ ] Very long single message (10k+ chars): tests per-message compression
- [ ] Mixed languages: English prose with inline SQL, JSON, and shell commands — tests T0 detection
- [ ] Nested structure: JSON containing prose containing code fences — tests recursive classification

**Acceptance:** All adversarial cases have explicit expected behavior. Tests catch regressions from any phase.

---

### 5.3 A/B Comparison Tool

**Status:** [ ] Not started
**Files:** `bench/`

**What:** CLI tool to compress the same input with two different option sets and compare results side-by-side.

**Implementation:**

- [ ] `npm run bench:compare -- --a="default" --b="tiered,entropy"`
- [ ] Output: side-by-side ratio, quality, entity retention, diff of compressed output
- [ ] Useful for validating each phase's improvement

---

## Progress Tracker

| Phase | Item                          | Effort  | Ratio Impact              | Quality Impact    | Status |
| ----- | ----------------------------- | ------- | ------------------------- | ----------------- | ------ |
| 1.1   | Entity retention metric       | Low     | —                         | Observability     | [x]    |
| 1.2   | Relevance threshold           | Low     | +15-30% on weak scenarios | Neutral           | [x]    |
| 1.3   | Quality score composite       | Low     | —                         | Observability     | [x]    |
| 2.1   | Tiered budget allocation      | Medium  | +10-20% overall           | +Quality          | [x]    |
| 2.2   | Self-information scoring      | Medium  | +20-30% on prose          | +Quality          | [x]    |
| 2.3   | Adaptive summary budget       | Low-Med | +5-10%                    | +Entity retention | [x]    |
| 3.1   | EDU-lite decomposition        | High    | Neutral                   | +Coherence        | [x]    |
| 3.2   | Cross-message coreference     | High    | Neutral                   | +Coherence        | [x]    |
| 3.3   | Conversation flow compression | Medium  | +15-25% on conv.          | +Coherence        | [x]    |
| 4.1   | ML token classifier           | High    | +30-50% on prose          | +Quality          | [x]    |
| 4.2   | Progressive compression       | Medium  | +50-100% on deep          | +Quality          | [x]    |
| 4.3   | Semantic clustering           | High    | +20-40% on long           | +Coherence        | [x]    |
| 5.1   | Quality benchmark suite       | Medium  | —                         | Infrastructure    | [x]    |
| 5.2   | Adversarial test cases        | Medium  | —                         | Infrastructure    | [x]    |
| 5.3   | A/B comparison tool           | Low     | —                         | Infrastructure    | [x]    |

**Target:** 3.5x+ avg compression at quality_score >= 0.90

---

## Key Papers Referenced

| Short Name           | Venue      | Key Contribution                                 | Link                                 |
| -------------------- | ---------- | ------------------------------------------------ | ------------------------------------ |
| LLMLingua            | EMNLP 2023 | Budget controller, coarse-to-fine compression    | arxiv.org/abs/2310.05736             |
| LongLLMLingua        | ACL 2024   | Question-aware compression, "lost in middle" fix | arxiv.org/abs/2310.06839             |
| LLMLingua-2          | ACL 2024   | Token classification via small encoder           | arxiv.org/abs/2403.12968             |
| Selective Context    | EMNLP 2023 | Self-information based pruning                   | aclanthology.org/2023.emnlp-main.391 |
| RECOMP               | ICLR 2024  | Extractive + abstractive, "output nothing"       | arxiv.org/abs/2310.04408             |
| From Context to EDUs | arXiv 2025 | Discourse unit decomposition                     | arxiv.org/abs/2512.14244             |
| LLM-DCP              | arXiv 2025 | RL-based progressive compression                 | arxiv.org/abs/2504.11004             |
| ACON                 | arXiv 2025 | Failure-analysis feedback for agent compression  | arxiv.org/abs/2510.00615             |
| HyCo2                | arXiv 2025 | Hard + soft hybrid compression                   | arxiv.org/abs/2505.15774             |
| Info Preservation    | EMNLP 2025 | Three-axis quality evaluation framework          | arxiv.org/abs/2503.19114             |
| Compression Survey   | NAACL 2025 | Taxonomy of all approaches                       | arxiv.org/abs/2410.12388             |
| ComprExIT            | arXiv 2026 | Globally optimized compression plan              | arxiv.org/abs/2602.03784             |
| LCIRC                | NAACL 2025 | Recurrent compression for multi-round            | arxiv.org/abs/2502.06139             |
| TokenSkip            | EMNLP 2025 | Controllable CoT compression                     | arxiv.org/abs/2502.12067             |

---

## Design Principles

1. **Zero-dependency core stays zero-dependency.** ML features ship as optional packages or user-provided functions.
2. **Every compression is reversible.** Round-trip integrity is non-negotiable. New features must preserve the verbatim store contract.
3. **Deterministic by default.** LLM/ML features are opt-in enhancements, never requirements.
4. **Measure before and after.** Every phase must show benchmark improvement. No "should be better" — prove it.
5. **Backward compatible.** Default options produce identical output to current version. New features are opt-in.
