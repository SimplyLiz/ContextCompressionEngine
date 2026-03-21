# Domain-Specific Enhancements

## Problem

The README (line 35) claims the engine is useful for "LLM conversations, legal briefs, medical records, technical documentation, support logs." The classifier only delivers on two of those: LLM conversations and technical documentation. The other three have minimal or zero domain-specific detection, meaning domain-critical content gets classified as compressible prose.

## Current State

### Delivered

- **LLM conversations** — benchmarked on real Claude Code sessions (8,004 messages, 11.7M chars)
- **Technical documentation** — code fences, JSON, YAML, LaTeX, file paths, versions, URLs, API keys

### Gaps

#### Legal briefs

What exists: 5 keywords as a force-T0 pattern (`shall`, `may not`, `notwithstanding`, `whereas`, `hereby`).

What's missing:

- Case law citations (e.g., `42 U.S.C. § 1983`, `Smith v. Jones, 500 U.S. 123 (1995)`)
- Section/clause references (e.g., `Section 4(a)(ii)`, `Article III`)
- Defined terms (capitalized terms with specific legal meaning)
- Contract clause numbering patterns
- Regulatory references (e.g., `GDPR Art. 6(1)(f)`, `HIPAA § 164.502`)

Risk: legal citations and defined terms compressed away, changing the meaning of the document.

#### Medical records

What exists: nothing domain-specific.

What's missing:

- Drug names and dosage patterns (e.g., `Metformin 500mg po bid x30d`)
- ICD/CPT codes (e.g., `ICD-10: E11.9`, `CPT 99213`)
- Lab values with ranges (e.g., `HbA1c 7.2% (ref: <5.7%)`)
- Vital signs (e.g., `BP 120/80 mmHg`, `HR 72 bpm`)
- Anatomical/clinical terms at high density
- Allergy/adverse reaction flags

Risk: dosages, codes, or lab values treated as prose and summarized — direct patient safety concern.

#### Support logs

What exists: stack traces in code fences survive; `numeric_with_units` catches some metrics.

What's missing:

- Log level patterns (e.g., `[ERROR]`, `WARN`, `INFO 2024-01-15T10:23:45Z`)
- Ticket/incident IDs (e.g., `JIRA-1234`, `INC0012345`)
- Structured timestamp lines
- Request/response pairs with status codes
- Process/thread IDs

Risk: lower than legal/medical — support logs are often semi-structured enough to trigger existing detectors. But explicit patterns would improve reliability.

## Approach Options

### Option A: Add force-T0 patterns (same as SQL detector)

Add regex patterns to `FORCE_T0_PATTERNS` in `src/classify.ts` for each domain. Low complexity, consistent with existing architecture.

Pros:

- Minimal code change
- Same pattern as SQL, API keys, legal terms
- No new dependencies

Cons:

- Regex-based detection has false positive/negative tradeoffs
- Each domain needs careful tuning to avoid over-preserving

### Option B: Domain-specific detector functions (same as `detectSqlContent`)

Create dedicated detector functions with tiered anchor systems (strong/weak) per domain. More nuanced than flat regex.

Pros:

- Can use anchor tiering to reduce false positives (proven with SQL)
- Can combine multiple weak signals for higher confidence
- Testable in isolation

Cons:

- More code to maintain per domain
- Need domain expertise to get the anchor lists right

### Recommendation

Build detector functions for legal and medical (highest risk domains), add simple patterns for support logs. Research needed before implementation to validate pattern lists against real-world samples. Once domain detection is proven, update the README to re-advertise broader domain support.

## Research TODO

- [ ] Collect sample legal documents — contracts, briefs, regulations
- [ ] Collect sample medical records — clinical notes, lab reports, discharge summaries
- [ ] Collect sample support logs — Zendesk, Jira, PagerDuty exports
- [ ] Run current classifier against samples, measure false negatives (domain content classified as T2/T3)
- [ ] Draft pattern lists per domain, validate false positive rates
- [ ] Determine if `numeric_with_units` already covers enough medical/lab values
- [ ] Benchmark compression quality on domain samples before/after enhancements
