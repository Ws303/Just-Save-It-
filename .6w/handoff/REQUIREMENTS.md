# Just-Save-It: requirements

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Requirements with observable acceptance criteria, their personas, decisions and edge cases.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## <a id="req-001"></a>REQ-001. 11-table Supabase Postgres schema, RLS policies, canonical triggers, accept\_invite RPC, atomic claim\_due\_reminders RPC, and FastAPI CRUD API

Priority P0. Status proposed.

Outcome: Fast, normalized, zero-loss storage of link metadata, user organization/notes, AI summaries, and cross-OS reminders with tenant isolation.

Acceptance:
- All 11 tables, constraints, FK indexes, and RLS policies with \(select auth.uid\(\)\) apply idempotently.
- accept\_invite\(token\) validates expiry/revocation/max\_uses atomically; claim\_due\_reminders advances every\_n\_days in IANA timezone.

Links: none

## <a id="req-002"></a>REQ-002. Shared Supabase JWT signature verification \(backend/Login/\) and strict ENV=development + ALLOW\_DEV\_AUTH\_BYPASS gating for X-User-Id

Priority P0. Status proposed.

Outcome: Closes unverified JWT & header bypass vulnerability across both Database/Login routes and existing Ai/router.py.

Acceptance:
- Invalid or tampered Bearer JWT returns HTTP 401; expired JWT returns HTTP 401.
- X-User-Id without valid JWT returns HTTP 401 unless ENV=development and ALLOW\_DEV\_AUTH\_BYPASS=true.

Links: none

## <a id="req-003"></a>REQ-003. Multi-charset HTML detection \(UTF-8/TIS-620/Windows-874/Shift\_JIS/GBK\), Unicode NFC normalization preserving tone marks, lossless full title/description TEXT, and 4-field FTS+trigram search

Priority P0. Status proposed.

Outcome: Full non-truncated title and description across every script/language without mojibake, searchable sub-second across Thai, CJK, and English.

Acceptance:
- Raw HTML bytes in TIS-620, Windows-874, Shift\_JIS, and UTF-8 decode accurately to UTF-8 NFC without stripping Thai tone marks or emoji.
- Search query matches substring phrases in title, description, note, and ai\_summary across languages.

Links: none

## <a id="req-004"></a>REQ-004. Immediate DB persistence of link + user folder/tags/note regardless of unfurl status, plus configurable AI summary\_language \(default th\) preserving summary\_th compatibility

Priority P0. Status proposed.

Outcome: Zero user data loss even on remote fetch failure, while keeping existing AI/MCP clients backward-compatible and supporting per-user/request language.

Acceptance:
- POST /api/items saves user URL, folder, tags, note, and optional reminder with enrich\_status='pending' without waiting on live scraping.
- AI summary honors requested/profile language \(th/en/auto\) while preserving summary\_th response field compatibility.

Links: none

## <a id="req-005"></a>REQ-005. Owned waitlist/feedback capture channel and visible per-account Free AI quota indicator before hitting 50/mo cap

Priority P1. Status proposed.

Outcome: Captures beta testers directly into an owned feedback loop and avoids sudden AI quota surprise by encouraging timely BYOK setup or Pro upgrade.

Acceptance:
- GET /api/auth/me exposes monthly built-in AI usage count and remaining free quota.
- Beta onboarding collects tester feedback email/channel consent safely.

Links: [EXP-001](MARKETING.md#exp-001)

## Anti-scope

In Part 1: only DB+Auth+Encoding/Search/Ai-alignment \(no Part 2 Unfurl Worker or Part 3 Push/Cron yet\). In v1 overall: no video re-hosting, no Public Share discovery feeds, no Semantic pgvector, no Team workspaces \(deferred v1.1\).
