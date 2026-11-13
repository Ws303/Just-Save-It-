# Just-Save-It: product

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

The six decisions, the problem, the value, the scope and the anti-scope.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## WHY. Unified cross-platform link hub with clean multi-language retrieval, preview, AI summary, and cross-OS reminders; Freemium + BYOK model

Readiness 70/100, ... Evidence: assumption.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| pain-severity | 3/4 | user | Users save articles, tutorials, reels, and posts daily across phone and desktop but forget them or fail to search across fragmented bookmark tools. |
| broken-workaround | 3/4 | user | Workarounds \(browser bookmarks, chat Keep, generic notes, social Saved tabs\) lack cross-device search in mixed charsets, rich preview, AI summary, and recurring reminders. |
| value-capture | 3/4 | assumption | Model: Freemium + Unlimited BYOK. Value metric: built-in AI summaries/month and media storage capacity. Free tier: 50 built-in AI calls/mo + unlimited BYOK/custom. Pro hypothesis: 99-149 THB/mo \(\~$3/mo provisional\) for expanded quota/storage. Clears provisional cost per active user cleanly when AI ceiling holds \(EXP-002 to falsify\). |
| success-metric | 2/4 | assumption | Provisional 30-day gate proposed: \>=30% Week-4 active save/retrieve/reminder retention among first 50 Thai tech prosumer beta testers \(ASM-003, EXP-001\); awaiting live beta confirmation. |


Open questions:
- Confirm final 30-day retention stop-or-continue threshold \(\>=30% W4 active reuse\) before public beta launch.

## WHO. Beachhead locked: Thai Knowledge & Tech Prosumers switching between mobile and desktop; anti-persona excludes bulk video downloaders

Readiness 69/100, ... Evidence: user.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| beachhead-persona | 3/4 | user | Locked beachhead: Thai knowledge workers, software devs, and technical students saving cross-language articles/tutorials/clips across mobile & desktop. |
| switching-trigger-and-objections | 3/4 | user | Triggers: forgetting critical saved links/deadlines and losing context across languages. Objections: trusting data persistence \(answered by REQ-001/REQ-004\), privacy/BYOK \(REQ-002\), cost \(DEC-005\). |
| distribution | 2/4 | user | Rented channels identified \(Thai Dev/Productivity Facebook groups, Discord servers, X/Twitter threads\); owned beta waitlist/onboarding channel \(REQ-005\) and borrowed creator outreach planned in EXP-001. |
| buyer-user-anti-persona | 3/4 | user | Same individual prosumer buys and uses. Anti-persona \(PERSONA-002\): bulk video downloaders/piracy archivers and enterprise legal-discovery teams. |


## WHAT. Core loop & \<=5 v1 MVP pillars locked; Part 1 Full Integrity Package scoped cleanly ahead of Part 2 Unfurl and Part 3 Reminders

Readiness 75/100, ... Evidence: user.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| core-loop | 3/4 | user | Save URL \(+ folder/tags/note/schedule\) -\> immediately persist in Postgres without waiting on unfurl -\> decode clean multi-language metadata + configurable AI summary -\> fast FTS+trigram search or cross-OS reminder trigger. |
| v1-must-haves | 3/4 | user | Bounded to \<=5 v1 MVP pillars: \(1\) Lossless Save & Multi-language Data Capture, \(2\) Fast 4-field Search, \(3\) Cover-only Rich Preview \<=5 imgs, \(4\) 3-Tier Configurable AI Summary, \(5\) Cross-OS Hybrid Reminders. |
| explicit-anti-scope | 3/4 | user | In Part 1: only DB+Auth+Encoding/Search/Ai-alignment \(no Part 2 Unfurl Worker or Part 3 Push/Cron yet\). In v1 overall: no video re-hosting, no Public Share discovery feeds, no Semantic pgvector, no Team workspaces \(deferred v1.1\). |
| day-one-inputs | 3/4 | user | Only a URL \(plus optional note, folder, or reminder rule\) is required; user notes save even if remote website metadata fetch fails. |


## WHICH. Fast stack \(Supabase + FastAPI + Next.js/Expo/WXT\) with 3-tier AI and Day-2 Web-first UI cut line

Readiness 75/100, ... Evidence: user.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| primary-form-factor | 3/4 | user | Fast stack: Web \(Next.js\) + Extension \(WXT\) + Mobile \(Expo Android/iOS\) over FastAPI modular monolith and Supabase. Mobile justified by OS Share Sheet & scheduled reminder notifications; Day-2 UI integration prioritizes Primary Web UI first. |
| workflow-fit | 3/4 | user | Captures at point of discovery \(Share Sheet / Extension / MCP\) and delivers actionable reminders & multi-language search when returning to desk. |
| device-and-environment-constraints | 3/4 | user | Handles iOS Pre-APNs 64-slot local notification sync constraint cleanly in DB, non-UTF-8 web pages \(TIS-620/Windows-874/Shift\_JIS\), and zero-downtime DB fallback on offline/unfurl fail. |
| integration-boundary | 3/4 | observed | Clean module boundaries: Supabase \(Auth/Postgres/Storage/pg\_cron\) \<-\> FastAPI \(Database, Login, Ai, Unfurl, Reminders\) \<-\> 3-Tier LLM \(Gemini/Groq built-in, BYOK, Ollama/vLLM\). |


## WHETHER. Provisional unit economics modeled at 100/1K/10K MAU \($0 beta start\); critical JWT fix, multi-charset safety, and PDPA tasks mapped

Readiness 75/100, ... Evidence: assumption.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| unit-economics | 3/4 | assumption | Provisional Unit Economics Table \(USD/mo, verify live billing pages in TASK-002; paying conversion 5% @ \~$3.00/mo avg from \~99-149 THB Pro tier\): \| Monthly active users \| 100 \(Beta\) \| 1,000 \| 10,000 \| \| Fixed infra \(Supabase Free-\>$25 Pro\) \| $0 \(Free\) \| $25 \(Pro\) \| $50 \(Pro+compute prov.\) \| \| Variable AI \(50% use within 50/mo cap\) \| $0 \(Free tier\) \| \~$15 \(prov.\) \| \~$150 \(prov.\) \| \| Variable Storage/Push \(Cover \<=120KB WebP\) \| $0 \(Free\) \| \~$2 \(prov.\) \| \~$25 \(prov. / R2 switch\) \| \| Support hrs x cost \(solo founder\) \| $0 \| $0 \| $50 \(prov.\) \| \| Total cost \| $0 \| \~$42 \| \~$275 \| \| Revenue \(5% paying x \~$3/mo\) \| $0-$15 \| \~$150 \| \~$1,500 \| \| Provisional margin \| $0 to +$15 \| +$108 \| +$1,225 \| Note: Free tier 50/mo cap prevents runaway LLM burn; BYOK drives variable AI cost to $0. |
| technical-bottlenecks | 3/4 | observed | Identified & mapped: \(1\) unverified JWT & X-User-Id bypass in Ai/router.py, \(2\) legacy HTML charset mojibake via raw resp.text, \(3\) pg\_trgm gap on description/note/ai\_summary, \(4\) MCP create\_item canonical/reminder schema drift. |
| legal-privacy-security | 3/4 | assumption | Jurisdiction: Thailand PDPA primary; EU/UK/California not yet targeted in beachhead \(note explicitly\). Data: email/auth, saved URLs, private notes, API token hashes, push tokens, optional BYOK headers \(stateless\). Security REQ-002 enforces JWT sig + dev-only bypass. Investigation tasks \(TASK-001\) + scraping/LLM risks \(RISK-003\) tracked with owner & launch gate. |
| persona-ux-edge-cases | 3/4 | user | Explicitly covers EDGE-001 \(multi-charset/NFC/full text\), EDGE-002 \(iOS 64-slot local notification sync\), EDGE-003 \(canonical URL dedup & non-loss DB save on unfurl fail\), EDGE-004 \(quota/auth expiry\). |


## WHEN. AI-accelerated sprint targeting Backend Part 1-3 today & UI live test tomorrow, protected by per-part gates & Primary Web UI cut line

Readiness 69/100, ... Evidence: user.

| Sub-criterion | Rating | Evidence | Rationale |
| --- | --- | --- | --- |
| builder-bandwidth | 3/4 | user | Human operator directing full-cycle AI engineering \(Claudy + deterministic test gates\) in a dedicated sprint today \(backend\) and tomorrow \(UI integration\). |
| proof-of-concept | 3/4 | observed | backend/Ai/ and backend/tests/test\_ai\_module.py exist and pass 10/10 tests \(verified baseline\), providing proven template for Parts 1-3. |
| mvp-date | 2/4 | user | Aggressive 2-day sprint \(Day 1 = Backend Part 1 -\> Part 2 -\> Part 3 with offline SQL + Pytest gates; Day 2 = Live UI & Cloud integration\). Tight schedule carries multi-client UI compression risk \(RISK-004\) without buffer. |
| cut-line | 3/4 | user | Clear sequential cut line: Part 1 DB+Auth -\> Part 2 Unfurl -\> Part 3 Reminders must pass tests independently before next part starts; Day-2 real test verifies Primary Web UI + API end-to-end first, then Mobile Expo reminder sync, deferring Browser Extension polish if Day-2 runs late. |


## Anti-scope

In Part 1: only DB+Auth+Encoding/Search/Ai-alignment \(no Part 2 Unfurl Worker or Part 3 Push/Cron yet\). In v1 overall: no video re-hosting, no Public Share discovery feeds, no Semantic pgvector, no Team workspaces \(deferred v1.1\).

## Success metric

Provisional 30-day gate proposed: \>=30% Week-4 active save/retrieve/reminder retention among first 50 Thai tech prosumer beta testers \(ASM-003, EXP-001\); awaiting live beta confirmation.
