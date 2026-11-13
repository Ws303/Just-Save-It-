# Just-Save-It: architecture

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Form factor, boundaries, integrations and diagram descriptions. Designs here are proposed until implemented.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Form factor

Fast stack: Web \(Next.js\) + Extension \(WXT\) + Mobile \(Expo Android/iOS\) over FastAPI modular monolith and Supabase. Mobile justified by OS Share Sheet & scheduled reminder notifications; Day-2 UI integration prioritizes Primary Web UI first.

## Workflow fit and constraints

Captures at point of discovery \(Share Sheet / Extension / MCP\) and delivers actionable reminders & multi-language search when returning to desk.

Handles iOS Pre-APNs 64-slot local notification sync constraint cleanly in DB, non-UTF-8 web pages \(TIS-620/Windows-874/Shift\_JIS\), and zero-downtime DB fallback on offline/unfurl fail.

## Integration boundary

Clean module boundaries: Supabase \(Auth/Postgres/Storage/pg\_cron\) \<-\> FastAPI \(Database, Login, Ai, Unfurl, Reminders\) \<-\> 3-Tier LLM \(Gemini/Groq built-in, BYOK, Ollama/vLLM\).

## Technical bottlenecks

Identified & mapped: \(1\) unverified JWT & X-User-Id bypass in Ai/router.py, \(2\) legacy HTML charset mojibake via raw resp.text, \(3\) pg\_trgm gap on description/note/ai\_summary, \(4\) MCP create\_item canonical/reminder schema drift.

## Diagrams

The rendered diagrams are embedded in the HTML blueprint. Their text descriptions are here so you do not need to parse HTML.

- workflow (fallback): Pitch flow: Problem: Unified cross-platform link hub with clean multi-language retrieval, preview, AI summary, and cross-OS reminders; Freemium + BYOK model. Trigger: Missing a deadline on a saved post or wasting time hunting for a Thai/English link across apps.. Core loop: Core loop & \<=5 v1 MVP pillars locked; Part 1 Full Integrity Package scoped cleanly ahead of Part 2 Unfurl and Part 3 Reminders. Value: Model: Freemium + Unlimited BYOK..
- architecture (fallback): Just-Save-It sits between Thai Knowledge & Tech Prosumer Switching Mobile \<-\> Desktop and no external services.
- sequence (fallback): Sequence between Thai Knowledge & Tech Prosumer Switching Mobile \<-\> Desktop, Just-Save-It: Thai Knowledge & Tech Prosumer Switching Mobile \<-\> Desktop to Just-Save-It: Trigger: Missing a deadline on a saved post or wasting t...; Just-Save-It to Just-Save-It: Core loop & \<=5 v1 MVP pillars locked; Part 1 Full Integr...; Just-Save-It to Just-Save-It: Result; Just-Save-It to Thai Knowledge & Tech Prosumer Switching Mobile \<-\> Desktop: Value delivered. Branches: EDGE-001 Non-UTF-8 / legacy charset & multi-language text mojibake or truncation; EDGE-002 iOS Pre-APNs 64-slot local notification cap and cross-OS schedule drift; EDGE-003 Unfurl failure or tracking-parameter duplicate URLs risking data loss.
- erd (none): No data entities are recorded in state. The v1 schema is an implementation task \(see DELIVERY.md\), not a planning decision.

## Data model

No data entities are recorded in state. The v1 schema is an implementation task \(see DELIVERY.md\), not a planning decision.
