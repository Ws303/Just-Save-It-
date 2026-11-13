# Just-Save-It: decisions

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Accepted, proposed, deferred, rejected and superseded decisions with rationale. Append new consequential decisions as proposed.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## <a id="dec-001"></a>DEC-001. Fast Stack: Supabase + FastAPI Modular Monolith + Expo/Next.js/WXT

Status **accepted**. Evidence user.

Fast stack: Supabase Free-\>Pro + FastAPI \(Database, Login, Ai, Unfurl, Reminders\) + Next.js/Expo/WXT minimizes upfront $0 burn and leverages existing Ai/ codebase. Scale stack alternative: dedicated PgBouncer/workers + Cloudflare R2 CDN + APNs push service. Switch when: DB \>400MB or egress \>80% free limit or \>500 paying users \(provisional triggers\).

Alternatives considered: Scale-first microservices + self-hosted Postgres/Redis: rejected for 2-day sprint overhead; Pure serverless Next.js only without Python backend: rejected because existing Ai/ & trafilatura ecosystem are Python.


## <a id="dec-002"></a>DEC-002. Rich Preview Storage Cap: Cover-only WebP \(\<=800px/\<120KB\) + \<=5 images + official embeds

Status **accepted**. Evidence user.

Compressing only cover thumbnail to Supabase Storage and referencing indices 1..4 via external URL keeps storage cost negligible at 100-10K users.

Alternatives considered: Re-host all carousel images or videos: rejected due to egress cost and copyright risk.


## <a id="dec-003"></a>DEC-003. Hybrid Reminders \(once & every\_n\_days\) with iOS pre-APNs local sync fallback

Status **accepted**. Evidence user.

Delivers cross-OS reminders immediately without $99/yr Apple Developer gate during MVP test phase, cleanly upgradeable to APNs later.

Alternatives considered: Require Apple Developer APNs from Day 1: deferred until post-beta public iOS release.


## <a id="dec-004"></a>DEC-004. Sequential Part 1 -\> Part 2 -\> Part 3 Backend Sprint + Day-2 Web-first UI Cut Line

Status **accepted**. Evidence user.

Part 1 \(DB + Auth + Integrity\) locks contracts first, followed sequentially by Part 2 \(Unfurl\) and Part 3 \(Reminders\) today, then Day-2 live UI starting with Primary Web UI before Mobile Expo Local Sync and Browser Extension.

Alternatives considered: Parallelize ungrounded frontend & backend changes across all 3 clients simultaneously: rejected for regression risk.


## <a id="dec-005"></a>DEC-005. Monetization Model: Price by AI Quota & Cloud Capacity \(Freemium Free 50 AI/mo + BYOK + Pro \~99-149 THB/mo\)

Status **proposed**. Evidence assumption.

Model: Freemium + Unlimited BYOK. Value metric: monthly built-in AI summaries & cloud thumbnail storage. Tiers: Free \(unlimited links/reminders + 50 built-in AI/mo + unlimited BYOK, 0 THB\), Pro \(\~99-149 THB/mo provisional for higher AI quota/media/export extras\). Why this model over alternatives: aligns variable LLM cost directly to quota without gating core bookmarking behind paywall. Clears provisional cost per active user by +$108/mo at 1K MAU assuming 5% conversion \(EXP-002 tests\).

Alternatives considered: Pure flat paywall with no free tier: rejected because bookmarking switching friction demands try-before-buy; Pure usage-based billing per link: rejected for bill-shock anxiety; Per-seat B2B pricing: rejected because beachhead is individual prosumer.


## <a id="dec-006"></a>DEC-006. Part 1 Full Integrity Package & Configurable AI Language

Status **accepted**. Evidence user.

Combines 11-table Postgres schema + RLS + accept\_invite + 4-field FTS/pg\_trgm search + multi-charset/NFC text hygiene + JWT security fix + configurable summary\_language \(default th\) + backward-compatible backend/Ai alignment.

Alternatives considered: Schema-only Part 1 leaving JWT bypass & encoding fixes until later: rejected by user in Focus Mode Round 1 & 2.

