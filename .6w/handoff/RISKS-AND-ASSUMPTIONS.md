# Just-Save-It: risks and assumptions

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Blockers, assumptions, evidence gaps and the validation tasks that close them.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Risks

### <a id="risk-001"></a>RISK-001. CRITICAL: backend/Ai/router.py currently accepts unverified X-User-Id bypass and decodes JWT without verifying signature

Severity critical. Status open.

- Mitigation: Fix immediately in Part 1 REQ-002 by migrating router.py dependency to shared Login.auth\_dep verify\_supabase\_jwt and strict dev-bypass env flags before any network exposure.
- Remaining exposure: 
- Links: [REQ-002](REQUIREMENTS.md#req-002), [EDGE-004](AUDIENCE.md#edge-004)

### <a id="risk-002"></a>RISK-002. Provisional unit economics margin depends on staying inside free/low-cost LLM quotas and \>=5% Pro conversion once \>1K MAU

Severity medium. Status open.

- Mitigation: Enforce atomic daily/monthly 50-call Free cap in Postgres, prioritize zero-token BYOK flow, and verify real cloud billing via TASK-002 & EXP-002.
- Remaining exposure: 
- Links: [ASM-001](RISKS-AND-ASSUMPTIONS.md#asm-001), [ASM-002](RISKS-AND-ASSUMPTIONS.md#asm-002), [DEC-005](DECISIONS.md#dec-005)

### <a id="risk-003"></a>RISK-003. Legal/Privacy: Thailand PDPA consent/deletion flow, EU/UK out-of-scope note, third-party scraping ToS, and Gemini/Groq data retention terms unchecked

Severity medium. Status open.

- Mitigation: Execute TASK-001 checklist before opening public beta: publish PDPA privacy notice, verify cascade delete account flow, and store only official/cover WebP previews \<=120KB.
- Remaining exposure: 
- Links: [TASK-001](DELIVERY.md#task-001)

### <a id="risk-004"></a>RISK-004. 2-Day Sprint Compression Risk: completing Backend Part 1-3 today + multi-client UI testing tomorrow without cutting Extension/Mobile scope could compromise quality

Severity high. Status open.

- Mitigation: Enforce strict sequential offline Pytest gate per part today \(Part 1 -\> Part 2 -\> Part 3\) and apply DEC-004 Day-2 Cut Line: Primary Web UI E2E first, Mobile Expo Notification second, Extension deferred if behind.
- Remaining exposure: 
- Links: [DEC-004](DECISIONS.md#dec-004), [TASK-003](DELIVERY.md#task-003)

## Assumptions

### <a id="asm-001"></a>ASM-001. Pro price hypothesis \(\~99-149 THB/mo\) converts \>=5% of frequent beta savers needing expanded AI quota

Status untested. If false: If \<2% convert in EXP-002, keep Free+BYOK model and defer paid infrastructure upgrades or test annual-only pricing. Links: [EXP-002](MARKETING.md#exp-002).

### <a id="asm-002"></a>ASM-002. Built-in AI free tier \(50 calls/mo cap\) averages \<=25 calls/MAU \(\~$0.015-$0.03 provisional variable cost/user when paid\)

Status untested. If false: If free-tier burn exceeds margin threshold, lower free quota to 20/mo or require BYOK earlier. Links: [DEC-005](DECISIONS.md#dec-005).

### <a id="asm-003"></a>ASM-003. Provisional 30-day success KPI: \>=30% Week-4 retention on core save/retrieve/reminder loop among first 50 beta users

Status untested. If false: If W4 active reuse \<15% in EXP-001, pause new feature expansion and revisit beachhead/onboarding trigger. Links: [EXP-001](MARKETING.md#exp-001).

### <a id="asm-004"></a>ASM-004. AI-accelerated execution completes Part 1 -\> Part 2 -\> Part 3 offline-verified today under sequential Pytest gates

Status untested. If false: If Part 1-3 exceeds today's budget, ship verified Part 1+2 cleanly before rushing unverified Part 3 or Day-2 UI clients. Links: [TASK-003](DELIVERY.md#task-003).

## Evidence gaps

- WHY value-capture: assumption
- WHY success-metric: assumption
- WHETHER unit-economics: assumption
- WHETHER legal-privacy-security: assumption
