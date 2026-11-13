# Just-Save-It: marketing

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Positioning, message hypotheses, objections, channels and experiments. Hypotheses to test, not claims. Hypothetical copy is never a customer quote.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Positioning hypothesis

- Audience: Saves mixed Thai/English/Japanese articles, code docs, tutorials, and social posts daily across phone and computer, losing track across disconnected bookmark folders and chat Keep.
- Problem: Unified cross-platform link hub with clean multi-language retrieval, preview, AI summary, and cross-OS reminders; Freemium + BYOK model
- Benefit: Capture links cleanly in full text across any language, preview fast, summarize in chosen language with BYOK option, and get cross-OS scheduled reminders that never drop.
- Alternative today: Browser bookmarks, LINE Keep, IG Saved, Notion tables

## Objections and the proof each needs

- Data loss or truncated descriptions when sites break or change. Proof needed: not yet recorded.
- Privacy of saved URLs/notes and locked-in AI subscriptions. Proof needed: not yet recorded.
- Reliability of reminders across Android, Web, and pre-APNs iOS. Proof needed: not yet recorded.

## Channels

- Owned: In-app onboarding & beta waitlist landing form \(REQ-005\)
- Rented: Thai Dev / Productivity Facebook Groups, Discord servers, X/Twitter threads
- Borrowed: Thai tech newsletter / dev creator demos \(post-MVP beta\)

## Experiments

### <a id="exp-001"></a>EXP-001. Beta Activation & Week-4 Reuse Test with 50 Thai Knowledge/Tech Prosumers

- Measure: Share of activated testers completing \>=1 search/open/reminder trigger in Week 4 \(provisional \>=30% threshold; zero data loss as guardrail\).
- Timebox: First 50 beta sign-ups or 30 calendar days post-UI beta open
- Decision rule: \>=30% W4 active reuse -\> proceed to v1.1 \(Public Share/Semantic Search\); \<15% -\> re-interview churned testers and pivot beachhead or reminder UX before adding features.
- Status: planned
- Links: [ASM-003](RISKS-AND-ASSUMPTIONS.md#asm-003), [PERSONA-001](AUDIENCE.md#persona-001), [REQ-005](REQUIREMENTS.md#req-005)

### <a id="exp-002"></a>EXP-002. Pro Tier Value Metric & Price Sensitivity Test \(99-149 THB/mo\)

- Measure: Pro upgrade intent click rate among quota-hit users over 14 days \(guardrail: Free core save retention does not drop\).
- Timebox: 14 days after beta reaches 50 active users
- Decision rule: \>=5% upgrade intent -\> implement Stripe/PromptPay checkout at tested THB price; \<2% -\> stay BYOK-first or test lower price/annual bundle before building billing.
- Status: planned
- Links: [ASM-001](RISKS-AND-ASSUMPTIONS.md#asm-001), [DEC-005](DECISIONS.md#dec-005), [PERSONA-001](AUDIENCE.md#persona-001)
