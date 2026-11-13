# Just-Save-It: agent rules

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Guardrails for the coding agent. Keep this file in context while implementing. Your project's root rules file may point here; 6W never writes that file itself.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Locked decisions

- Fast Stack: Supabase + FastAPI Modular Monolith + Expo/Next.js/WXT ([DEC-001](DECISIONS.md#dec-001))
- Rich Preview Storage Cap: Cover-only WebP \(\<=800px/\<120KB\) + \<=5 images + official embeds ([DEC-002](DECISIONS.md#dec-002))
- Hybrid Reminders \(once & every\_n\_days\) with iOS pre-APNs local sync fallback ([DEC-003](DECISIONS.md#dec-003))
- Sequential Part 1 -\> Part 2 -\> Part 3 Backend Sprint + Day-2 Web-first UI Cut Line ([DEC-004](DECISIONS.md#dec-004))
- Part 1 Full Integrity Package & Configurable AI Language ([DEC-006](DECISIONS.md#dec-006))

## Form factor and integrations

- Fast stack: Web \(Next.js\) + Extension \(WXT\) + Mobile \(Expo Android/iOS\) over FastAPI modular monolith and Supabase. Mobile justified by OS Share Sheet & scheduled reminder notifications; Day-2 UI integration prioritizes Primary Web UI first.
- Clean module boundaries: Supabase \(Auth/Postgres/Storage/pg\_cron\) \<-\> FastAPI \(Database, Login, Ai, Unfurl, Reminders\) \<-\> 3-Tier LLM \(Gemini/Groq built-in, BYOK, Ollama/vLLM\).

## Anti-scope. Do not build these in v1

In Part 1: only DB+Auth+Encoding/Search/Ai-alignment \(no Part 2 Unfurl Worker or Part 3 Push/Cron yet\). In v1 overall: no video re-hosting, no Public Share discovery feeds, no Semantic pgvector, no Team workspaces \(deferred v1.1\).

## Mandatory edge-case handling

- [EDGE-001](AUDIENCE.md#edge-001) Non-UTF-8 / legacy charset & multi-language text mojibake or truncation: Detect encoding via HTTP Content-Type -\> HTML \<meta charset\> -\> charset-normalizer, unescape HTML entities, normalize Unicode NFC without stripping combining marks, store lossless full-length TEXT, and index across all 4 fields.
- [EDGE-002](AUDIENCE.md#edge-002) iOS Pre-APNs 64-slot local notification cap and cross-OS schedule drift: Persist canonical once/every\_n\_days schedule with IANA timezone in Supabase reminders table; push Android/Web via FCM/WebPush; provide atomic claim RPC + iOS local-sync unrolling endpoint.
- [EDGE-003](AUDIENCE.md#edge-003) Unfurl failure or tracking-parameter duplicate URLs risking data loss: Persist user item, folder, tags, and note to DB immediately with enrich\_status='pending' even when HTTP fetch fails; canonicalize URL and normalize url\_hash via DB trigger + Python helper.
- [EDGE-004](AUDIENCE.md#edge-004) Built-in AI free quota exhaustion \(50/mo\) or spoofed/expired auth headers: Enforce Supabase JWT signature verification via backend/Login dependency; gate X-User-Id behind ENV=development and ALLOW\_DEV\_AUTH\_BYPASS=true; surface remaining quota and seamless BYOK fallback.

## Working rules

- Build in the order of [DELIVERY.md](DELIVERY.md). Each task names how it is verified.
- Acceptance criteria in [REQUIREMENTS.md](REQUIREMENTS.md) define done.
- A contradiction between records is a question for the user, not a decision for you.
- Record consequential technical choices in [DECISIONS.md](DECISIONS.md) as proposed.
- Nothing here authorizes deploying, buying services, contacting people or publishing.
