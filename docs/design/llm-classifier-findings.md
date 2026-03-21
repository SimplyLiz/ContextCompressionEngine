# LLM Classifier — Research Findings & Assessment

## Honest assessment: is this feature worth pursuing?

**Yes.** Three reasons:

### 1. The gap is real and already advertised

The README positions the library for "legal briefs, medical records, technical
documentation, support logs." But the heuristic classifier is blind to those domains
today. Everything without code fences, JSON, or SQL gets classified as compressible
prose. A user compressing legal contracts right now gets their clause references
summarized away. The `legal_term` pattern ("shall", "whereas") is a soft T0 reason —
it tags the message but doesn't prevent compression (compress.ts line 569 only checks
hard T0 reasons). The library promises domain breadth it can't deliver without this
feature.

### 2. The architecture is validated by research

The research confirms our design choices:

- **Hybrid mode is the right default.** The EDU paper (arxiv:2512.14244) found that
  even frontier LLMs perform poorly on fine-grained structural analysis. Our heuristic
  classifier is better than an LLM at detecting code fences, JSON, SQL, regex patterns.
  The LLM should only handle semantic decisions (is this paragraph important?), not
  structural ones (is this JSON?). Hybrid mode routes correctly.
- **Binary classification for compression works.** LLMLingua-2 (arxiv:2403.12968)
  reframed prompt compression as binary token classification (preserve/discard) and
  achieved better results than perplexity-based approaches. Our message-level
  preserve/compress decision follows the same principle at a coarser granularity.
- **Deterministic fallback is essential.** Factory.ai's evaluation found that structured
  summarization outperforms LLM-only approaches. Our three-level fallback
  (LLM → heuristic → deterministic) is the right architecture.

### 3. The cost is negligible

Classification responses are tiny (~50-80 tokens). At Haiku pricing, classifying an
entire 100-message conversation costs ~$0.001. Compare that to the cost of a single
LLM summarization call. The feature adds value disproportionate to its cost.

### Risks

- **Scope creep.** The feature is well-scoped in the design doc, but domain-specific
  prompt engineering could become a support burden. Mitigation: document prompts as
  recipes in `docs/domain-prompts.md`, don't ship them as code.
- **LLM confidence is unreliable.** The Amazon Science paper found that LLM
  classification confidences are systematically miscalibrated. We collect confidence
  for logging but must not use it for routing decisions. Our hybrid mode already
  routes on heuristic signals (hard T0 vs. prose bucket), not LLM confidence. This
  is correct and should stay that way.
- **Testing complexity.** The LLM classifier needs integration tests with mocked LLM
  responses. The test surface grows, but the pattern is identical to the summarizer
  tests we already have.

---

## Research findings

### Papers explored

| #   | Paper                                                                                     | Year           | Key relevance                                                         |
| --- | ----------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| 1   | **LLMLingua-2**: Data Distillation for Faithful Task-Agnostic Prompt Compression          | ACL 2024       | Binary classification framing for compression                         |
| 2   | **Selective Context** (Li et al.)                                                         | EMNLP 2023     | Self-information scoring for token importance                         |
| 3   | **From Context to EDUs**: Faithful and Structured Context Compression                     | Dec 2025       | Structural analysis is a heuristic strength, not LLM                  |
| 4   | **Understanding and Improving Information Preservation in Prompt Compression**            | 2025           | Evaluation framework for compression faithfulness                     |
| 5   | **RECOMP**: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation | ICLR 2024      | Three-way classification (preserve/compress/remove)                   |
| 6   | **Label with Confidence**: Effective Confidence Calibration in LLM-Powered Classification | Amazon Science | LLM confidence is unreliable — don't trust it for routing             |
| 7   | **Fundamental Limits of Prompt Compression**: A Rate-Distortion Perspective               | NeurIPS 2024   | Theoretical compression bounds                                        |
| 8   | **Factory.ai**: Compressing Context / Evaluating Context Compression                      | 2024           | Structured summarization beats LLM-only; task shape matters           |
| 9   | **Scikit-LLM / Hybrid AI**                                                                | Nov 2025       | LLM-as-feature-engineer pattern for production classification         |
| 10  | **Recursive Language Models** (Zhang, Kraska, Khattab — MIT CSAIL)                        | Dec 2025       | Context rot validation; compaction limits; alternative to compression |

### Paper URLs

- LLMLingua-2: https://arxiv.org/abs/2403.12968
- Selective Context: https://arxiv.org/abs/2310.06201
- EDU Context Compression: https://arxiv.org/abs/2512.14244
- Information Preservation: https://arxiv.org/abs/2503.19114
- RECOMP: https://arxiv.org/abs/2310.04408
- Label with Confidence: https://assets.amazon.science/9f/8f/5573088f450d840e7b4d4a9ffe3e/label-with-confidence-effective-confidence-calibration-and-ensembles-in-llm-powered-classification.pdf
- Fundamental Limits: https://proceedings.neurips.cc/paper_files/paper/2024/file/ac8fbba029dadca99d6b8c3f913d3ed6-Paper-Conference.pdf
- Factory.ai Compressing Context: https://factory.ai/news/compressing-context
- Factory.ai Evaluating Compression: https://factory.ai/news/evaluating-compression
- Scikit-LLM Hybrid AI: https://afafathar.medium.com/productionizing-hybrid-ai-a-technical-deep-dive-into-scikit-llm-for-scalable-text-classification-a0cba646f2f8
- Recursive Language Models: https://arxiv.org/abs/2512.24601

---

## Priority ranking: which papers to read first

### Tier 1 — Read these, they directly change our implementation

**1. LLMLingua-2** (arxiv:2403.12968)

Why: They solved the same problem at the token level. We're solving it at the message
level. Their key move was reframing compression from "score by perplexity" to "train a
binary classifier on preserve/discard labels." We're making the same conceptual move —
our heuristic `scoreSentence` is a proxy metric (like their perplexity), and the LLM
classifier is direct optimization (like their trained classifier).

What to look for:

- How they handle the preserve/discard boundary (threshold selection)
- Their data distillation process (GPT-4 generates training labels) — this could
  inform our prompt engineering for the classifier
- Their faithfulness evaluation methodology — how do they measure whether the
  compressed output preserves the right information?
- Performance across different content types (their dataset includes MeetingBank,
  LongBench, GSM8K, and more)

**2. RECOMP** (arxiv:2310.04408)

Why: Their compressor can output an **empty string** when content is irrelevant. This
is a three-way decision we haven't considered: preserve / compress / remove. Our
current design is binary (preserve / compress). But our heuristic classifier already
has T3 (filler/removable) as a tier — we just don't use it differently from T2. The
LLM classifier could make T3 meaningful by identifying messages that should be dropped
entirely rather than summarized.

What to look for:

- How their extractive vs. abstractive compressors decide "nothing here is worth
  keeping" — what signals trigger the empty-string output?
- Their selective augmentation logic — how the decision to include or exclude content
  is made
- Whether the three-way approach improves downstream task performance vs. binary

**3. Label with Confidence** (Amazon Science)

Why: Directly impacts our confidence score design. If LLM confidence is systematically
unreliable, we need to know HOW it's unreliable (overconfident? underconfident? biased
toward certain classes?) and whether there are cheap calibration techniques we should
apply.

What to look for:

- The specific miscalibration patterns (overconfidence on incorrect classifications)
- Whether their logit-based calibration is applicable to our setup (we only get text
  responses, not logits, from most LLM APIs)
- Their recommendation on when verbalized confidence (asking the LLM for a score) is
  acceptable vs. when it's dangerous
- Whether confidence is more reliable for binary classification (our case) vs.
  multi-class

### Tier 2 — Read if time permits, useful but not blocking

**4. EDU Context Compression** (arxiv:2512.14244)

Why: Validates our hybrid approach. Their finding that LLMs are bad at structural
analysis confirms that we should keep structural detection in heuristics. Also
introduces StructBench (248 diverse documents) — could be useful as a test dataset
for evaluating our classifier.

What to look for:

- StructBench composition — what document types are included?
- Their structural prediction accuracy metrics — how do different LLMs perform?
- Whether their EDU decomposition idea could improve our code-split logic

**5. Information Preservation** (arxiv:2503.19114)

Why: Evaluation methodology. If we ship an LLM classifier, we need to measure whether
it actually improves compression quality vs. heuristics-only. This paper provides a
framework for that comparison.

What to look for:

- Their three evaluation axes (downstream performance, grounding, information
  preservation) — can we adapt this for our test suite?
- Which compression methods fail at preservation and why
- Whether they tested domain-specific content (legal, medical, etc.)

### Tier 3 — Reference material, skim as needed

**6. Selective Context** (arxiv:2310.06201)
Context for understanding self-information scoring. Our `scoreSentence` is a cruder
version of their approach. Not directly actionable but good background.

**7. Fundamental Limits** (NeurIPS 2024)
Theoretical bounds. Useful if we want to understand how close our compression ratios
are to optimal. Not actionable for implementation.

**8. Factory.ai blog posts**
Engineering perspective, not academic. Good for understanding production patterns.
We already incorporate their key insight (task shape matters → multiple modes).

**9. Scikit-LLM / Hybrid AI**
Different architecture (LLM as feature engineer for traditional classifier). Not
directly applicable to our design, but the "don't use the LLM as the final decision
maker" principle is worth keeping in mind.

**10. Recursive Language Models** (arxiv:2512.24601, MIT CSAIL, Dec 2025)
RLMs treat long prompts as an external environment and let the LLM recursively
call itself over snippets, handling inputs 100x beyond context windows. Their key
finding for us: context compaction (repeated summarization) "is rarely expressive
enough for tasks that require dense access." This validates why intelligent
classification before compression matters — you must know what's safe to compress
vs. what needs verbatim access. Their Figure 1 demonstrates "context rot" in GPT-5
at scale. Orthogonal to our approach (they avoid compression entirely), but
reinforces the problem we're solving. The RLM approach could be complementary:
compress what's safe, provide recursive access to what's preserved.

### Paper locations

All downloaded to `~/documents/Papers/`:

```
LLM-Context-Compression/
  LLMLingua-2_2403.12968.pdf
  RECOMP_2310.04408.pdf
  SelectiveContext_2310.06201.pdf
  EDU-ContextCompression_2512.14244.pdf
  InformationPreservation_2503.19114.pdf
  FundamentalLimits_NeurIPS2024.pdf
  2512.24601v1.pdf                          (Recursive Language Models)

LLM-Classification/
  LabelWithConfidence_Amazon.pdf
```

---

## Deep-dive: Tier 1 paper findings

### LLMLingua-2 — What we learned

**Core approach:** Reframe compression as binary token classification (preserve/discard).
They train a small Transformer encoder (XLM-RoBERTa-large, ~560M params) on labels
distilled from GPT-4. At inference, each token gets a preserve probability; the top-τN
tokens are kept in original order.

**Key findings for our design:**

1. **No fixed compression ratio.** They explicitly removed compression ratio targets from
   their prompt because information density varies wildly by genre. GPT-4 assigns
   compression ratios ranging from 1x to 20x across different sentences in the same
   document (Figure 3). This validates our per-message classification — a single ratio
   doesn't work. The classifier should decide per-message, not apply a blanket policy.

2. **Extractive > abstractive for faithfulness.** Their prompt enforces strict extractive
   rules: "You can ONLY remove unimportant words. Do not reorder. Do not change. Do not
   use abbreviations. Do not add new words." The output is a subset of the input tokens
   in original order. This guarantees faithfulness by construction. Our deterministic
   summarizer already follows a similar principle (sentence scoring + extraction). The
   LLM classifier should similarly be extractive in nature — classify messages, don't
   rewrite them.

3. **Bidirectional context matters.** Their Transformer encoder sees the full context
   bidirectionally, which is why a BERT-base model outperforms LLaMA-2-7B (a causal LM)
   at compression. For us: our heuristic classifier already analyzes full message content
   bidirectionally. When asking a causal LLM to classify, it only sees the message in
   left-to-right order. This is another argument for hybrid mode — heuristics handle
   structural patterns better because they see the whole message at once.

4. **Quality control metrics we should adopt.**
   - **Variation Rate (VR):** Proportion of words in output absent from input. Measures
     hallucination risk in summaries. We could compute this for our deterministic
     summarizer output.
   - **Alignment Gap (AG):** High hit rate + low match rate = poor annotation quality.
     Useful if we ever evaluate LLM classifier consistency.

5. **Chunk-wise compression for long contexts.** They chunk inputs into ≤512 tokens because
   GPT-4 over-compresses long contexts (Figure 4). Relevant for our potential batching
   strategy — if we batch-classify messages, we should limit batch size.

6. **Cross-domain generalization.** Trained only on MeetingBank (meeting transcripts), the
   model generalizes to LongBench, ZeroSCROLLS, GSM8K, BBH. They conjecture that
   "redundancy patterns transfer across domains." This suggests our LLM classifier
   prompts don't need to be domain-specific to be effective — a good general prompt
   works across content types. Domain-specific prompts are an optimization, not a
   requirement.

**Compression performance reference points:**

- In-domain (MeetingBank): 3x compression, QA EM 86.92 vs 87.75 original (98.6% retention)
- Out-of-domain (LongBench): 5x compression, maintains competitive performance
- Latency: 0.4-0.5s vs 15.5s for Selective-Context (30x faster)

### RECOMP — What we learned

**Core approach:** Two compressors — extractive (select sentences) and abstractive
(generate summaries) — trained to optimize downstream LM task performance, not
compression quality metrics.

**Key findings for our design:**

1. **The "remove" decision is task-dependent.** The empty string output isn't triggered by
   content analysis alone. During training, the abstractive compressor learns to output
   empty when prepending the summary actually _hurts_ downstream performance (increases
   perplexity or reduces QA accuracy). This is fundamentally different from "is this
   filler?" — it's "does keeping this help the task?"

   **Implication for us:** Our "remove" tier shouldn't just identify conversational filler.
   It should identify messages where compression/summarization provides zero value —
   content that's so generic or disconnected that even a summary wastes tokens. This is
   harder than filler detection and probably not worth implementing in v1. Stick with
   binary (`preserve | compress`) for now. The heuristic classifier already handles
   obvious filler via the <120 char threshold and dedup.

2. **Extractive outperforms abstractive on most tasks.** Across language modeling,
   NQ, TriviaQA, and HotpotQA, extractive compression (selecting sentences verbatim)
   achieves better or comparable results with simpler architecture. Only on HotpotQA
   (multi-hop reasoning) does abstractive do better, because it can synthesize across
   documents.

   **Implication for us:** Our deterministic summarizer (extractive sentence scoring) is
   the right default. LLM summarization should remain opt-in. The LLM classifier should
   improve _what_ gets sent to the summarizer, not replace the summarizer itself.

3. **Irrelevant content actively hurts.** "Prepending a large number of documents in-context
   can further confuse LMs with irrelevant information, degrading model performances."
   Prepending 5 full documents sometimes performs worse than 1 document. The oracle
   extractive compressor (best single sentence) outperforms prepending full documents.

   **Implication for us:** This validates aggressive compression. Better to compress too
   much than too little. A message that's 90% filler and 10% useful information is
   better compressed than preserved — the 90% noise dilutes the 10% signal.

4. **Faithfulness vs. comprehensiveness trade-off.** Manual evaluation (Table 4) shows
   their abstractive compressor is less faithful than GPT-3.5 (more hallucination) but
   more comprehensive (captures more information). GPT-3.5 summaries are 90-97% faithful
   but their trained model is 67-83% faithful.

   **Implication for us:** When evaluating our LLM classifier, faithfulness should be the
   primary metric, not comprehensiveness. A classifier that incorrectly marks a message
   as "compress" (losing important content) is worse than one that incorrectly marks it
   as "preserve" (keeping too much). False negatives are cheaper than false positives.

5. **Compression rates achieved:**
   - Extractive: 25% compression (4x), <10% relative performance drop
   - Abstractive: 5% compression (20x), but less faithful
   - Oracle extractive: 6% compression (16x), _outperforms_ full documents

### Label with Confidence — What we learned

**Core approach:** Logit-based confidence calibration for LLM classification. They extract
raw logits from the LLM output, aggregate across tokens matching candidate classes, apply
softmax scaling with learnable parameters, then use calibrated scores for cascading
ensemble policies.

**Key findings for our design:**

1. **Logit-based calibration requires model access we don't have.** Their entire pipeline
   (Steps 1-4) requires raw logit values from the LLM's last layer. Most LLM APIs
   (OpenAI, Anthropic, etc.) don't expose logits. We only get text responses. Their
   approach is **not directly applicable** to our use case.

2. **Three methods for LLM confidence, ranked by reliability:**
   - **Logit-based** (their approach): Most accurate. Requires model access. Not available
     to us.
   - **Consistency-based** (ask multiple times, measure agreement): Moderate accuracy.
     Requires multiple API calls. Too expensive for classification.
   - **Verbalized confidence** (ask the LLM for a score): Least reliable. This is what
     we'd use. Referenced but not recommended by this paper.

   **Implication for us:** Our decision to collect but not use confidence for routing is
   correct. The only confidence method available to us (verbalized) is the least
   reliable. Don't design features around it.

3. **Calibration error reduces with in-task examples.** 100-shot in-task calibration
   reduces error by 46% over uncalibrated. But this requires a labeled dev-set from the
   target task, which our library users won't have.

4. **Cascading ensemble pattern validates our escalating classifier.** Their cascading
   policy: start with cheapest LLM, check calibrated confidence, escalate to costlier
   LLM only when confidence is low. This achieves best F1 across all policies while
   reducing cost by 2x+ vs majority voting. Our `createEscalatingClassifier` follows
   the same pattern (heuristic → cheap LLM → expensive LLM), but we route on heuristic
   signal strength rather than confidence scores. This is arguably more reliable given
   their own finding that confidence needs calibration.

5. **Binary classification shows lower calibration error.** Their experiments use binary
   yes/no classification. With 100 in-task examples, mean ACE drops to 0.036-0.041.
   This is our exact use case (preserve/compress). If we ever implement confidence-based
   routing, binary classification is the most favorable scenario for it.

6. **The cost-aware cascade is the real insight.** Beyond confidence calibration, the paper
   demonstrates that tiered LLM usage (cheap first, expensive if needed) is both cheaper
   and more accurate than always using the most expensive model. This pattern maps to:
   - **Our hybrid mode:** Heuristic first (free), LLM only for ambiguous cases
   - **Our escalating classifier:** If the cheap LLM is uncertain, escalate

---

## Insights that should change the design

### 1. Three-way classification — DECIDED: not for v1 (from RECOMP deep-dive)

Current design: `preserve | compress` (binary).
Previously considered: `preserve | compress | remove`.

**After reading RECOMP in depth, the recommendation is to stay binary for v1.**

RECOMP's "remove" decision is task-dependent — their compressor learns to output empty
when prepending the summary hurts downstream task performance. This requires training
signal from a specific downstream task, which our library doesn't have (we're
task-agnostic). A naive "is this filler?" heuristic for removal is already handled by
our <120 char threshold and dedup. The LLM classifier adds value for _semantic_
preserve/compress decisions on non-trivial content, not for filler detection.

The three-way approach remains a possible v2 feature if users request it.

### 2. Don't use LLM confidence for routing (from Amazon Science paper)

Current design: Collect confidence from LLM, use for stats/logging.
Confirmed: Do NOT use it for routing decisions in hybrid mode.

The hybrid routing should remain based on heuristic signals: hard T0 match → skip LLM,
everything else → ask LLM. Never "ask the LLM and only trust it if confidence > 0.8."
LLM confidence scores are systematically miscalibrated.

Impact: No design change needed — our current approach is already correct. But this
should be documented explicitly as a deliberate design choice, not an oversight.

### 3. Faithfulness evaluation (from LLMLingua-2 and RECOMP deep-dives)

We need a way to measure whether the LLM classifier actually improves compression
quality. Current benchmarks measure compression ratio and token savings. With the LLM
classifier, we also need to measure:

- Does the classifier preserve the right content? (faithfulness)
- Does it preserve more domain-relevant content than heuristics alone? (domain lift)
- Does hybrid mode match full mode quality at lower cost? (efficiency)

**New from paper deep-dives:**

From LLMLingua-2: adopt **Variation Rate** (proportion of output words absent from input)
as a hallucination metric for our summarizer output. Also consider **Alignment Gap** for
evaluating LLM classifier consistency.

From RECOMP: **faithfulness > comprehensiveness** as the primary metric. A classifier that
incorrectly marks important content as "compress" (false positive) is worse than one
that over-preserves (false negative). Design benchmarks with asymmetric error costs.

Impact: New benchmark scenarios needed. Not blocking for implementation, but needed
before we can claim the feature works well.

### 4. The LLM-as-feature-engineer pattern (from Scikit-LLM)

An alternative to our current design: instead of asking the LLM "preserve or compress?",
ask it "what are the key concepts in this message?" and feed that into a deterministic
decision function. The LLM extracts signals, the heuristic decides.

This is potentially more robust (deterministic decision layer, LLM only for feature
extraction) but more complex to implement and harder to explain to users. Not worth
pursuing in v1, but worth noting as a possible evolution if LLM confidence proves too
unreliable in practice.

---

## Design document status

The design document at `docs/design/llm-classifier.md` covers:

- [x] Problem statement
- [x] Three classification modes (off / hybrid / full)
- [x] Pipeline injection point
- [x] API design (Classifier type, CompressOptions, factory functions)
- [x] Classifier prompt template with domain examples
- [x] Integration with compress.ts (sync/async routing)
- [x] File structure decision (flat, single new file)
- [x] CompressResult additions
- [x] Response parsing strategy
- [x] Cost analysis
- [x] Documentation plan
- [x] Why we don't expand heuristics (preservePatterns instead)
- [x] Three composable classification layers
- [x] Open questions (batching, caching, confidence threshold)

Decided after Tier 1 deep-dive:

- [x] Three-way classification → **Stay binary for v1.** RECOMP's "remove" is
      task-dependent, not applicable to our task-agnostic library. Filler is already handled
      by <120 char threshold and dedup. Three-way remains a v2 possibility.
- [x] Confidence calibration caveat → **Yes, document it.** The Amazon paper confirms
      verbalized confidence (our only option) is the least reliable method. Document as
      deliberate design choice: collect for logging, never route on it.

Still to be decided:

- [ ] Faithfulness evaluation / benchmark strategy (metrics identified: Variation Rate
      from LLMLingua-2, asymmetric error costs from RECOMP)
- [ ] Whether cross-domain generalization (LLMLingua-2 finding) means we can ship a
      single general prompt vs. requiring domain-specific prompts
