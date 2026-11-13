# Just-Save-It: audience

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Personas with their evidence status, the buyer and user relationship, and the edge cases that change product decisions.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Personas

### <a id="persona-001"></a>PERSONA-001. Thai Knowledge & Tech Prosumer Switching Mobile \<-\> Desktop

Role Beachhead champion. Priority primary. Evidence user.

| Field | Value |
| --- | --- |
| Situation | Saves mixed Thai/English/Japanese articles, code docs, tutorials, and social posts daily across phone and computer, losing track across disconnected bookmark folders and chat Keep. |
| Desired outcome | Capture links cleanly in full text across any language, preview fast, summarize in chosen language with BYOK option, and get cross-OS scheduled reminders that never drop. |
| Workaround today | Browser bookmarks, LINE Keep, IG Saved, Notion tables |
| Trigger | Missing a deadline on a saved post or wasting time hunting for a Thai/English link across apps. |
| Objections | Data loss or truncated descriptions when sites break or change; Privacy of saved URLs/notes and locked-in AI subscriptions; Reliability of reminders across Android, Web, and pre-APNs iOS |
| Channels | Owned: In-app onboarding & beta waitlist landing form \(REQ-005\); Rented: Thai Dev / Productivity Facebook Groups, Discord servers, X/Twitter threads; Borrowed: Thai tech newsletter / dev creator demos \(post-MVP beta\) |
| First value | Save any Thai/English URL -\> full clean preview title/description stored immediately -\> trigger configurable AI summary + recurring reminder synced across devices. |

Links: [REQ-001](REQUIREMENTS.md#req-001), [REQ-002](REQUIREMENTS.md#req-002), [REQ-003](REQUIREMENTS.md#req-003), [REQ-004](REQUIREMENTS.md#req-004), [REQ-005](REQUIREMENTS.md#req-005), [EXP-001](MARKETING.md#exp-001). Sources: [SRC-001](START-HERE.md#src-001), [SRC-002](START-HERE.md#src-002).

### <a id="persona-002"></a>PERSONA-002. Bulk Video Downloader / Piracy Archiver / Enterprise Compliance Team

Role Anti-persona. Priority excluded. Evidence user.

| Field | Value |
| --- | --- |
| Why excluded | Product rejects video re-hosting, DRM/paywall circumvention scraping, and enterprise legal compliance archiving. |

Links: none. Sources: [SRC-001](START-HERE.md#src-001), [SRC-002](START-HERE.md#src-002).

## Edge cases

### <a id="edge-001"></a>EDGE-001. Non-UTF-8 / legacy charset & multi-language text mojibake or truncation

Persona [PERSONA-001](AUDIENCE.md#persona-001). Severity high. Frequency frequent on Thai \(TIS-620/Windows-874\), Japanese \(Shift\_JIS\), and Chinese websites. Scope decision support-now.

- Impact: Garbled titles/descriptions, lost Thai tone marks, failed search matches, unreadable previews
- Response: Detect encoding via HTTP Content-Type -\> HTML \<meta charset\> -\> charset-normalizer, unescape HTML entities, normalize Unicode NFC without stripping combining marks, store lossless full-length TEXT, and index across all 4 fields.
- Test: Given HTML bytes encoded in TIS-620, Windows-874, Shift\_JIS, or UTF-8 with Thai tone marks, CJK, RTL, and emoji, when processed and saved, then DB stores lossless readable UTF-8 NFC text searchable via FTS and trigram.
- Links: [REQ-003](REQUIREMENTS.md#req-003)

### <a id="edge-002"></a>EDGE-002. iOS Pre-APNs 64-slot local notification cap and cross-OS schedule drift

Persona [PERSONA-001](AUDIENCE.md#persona-001). Severity high. Frequency every iOS user with cross-device or recurring reminders. Scope decision support-now.

- Impact: Reminders created on Web/Extension fail to trigger on iOS if un-synced or \>64 local slots
- Response: Persist canonical once/every\_n\_days schedule with IANA timezone in Supabase reminders table; push Android/Web via FCM/WebPush; provide atomic claim RPC + iOS local-sync unrolling endpoint.
- Test: Given an every\_n\_days reminder created on desktop Web, when claimed by backend RPC or synced by iOS device endpoint, remind\_at advances deterministically by exact repeat\_every\_days in user timezone.
- Links: [REQ-001](REQUIREMENTS.md#req-001)

### <a id="edge-003"></a>EDGE-003. Unfurl failure or tracking-parameter duplicate URLs risking data loss

Persona [PERSONA-001](AUDIENCE.md#persona-001). Severity high. Frequency frequent across social shares \(utm\_, fbclid, igsh\) and rate-limited sites. Scope decision support-now.

- Impact: User loses saved link/notes if save depends on live HTTP unfurl, or creates duplicate items
- Response: Persist user item, folder, tags, and note to DB immediately with enrich\_status='pending' even when HTTP fetch fails; canonicalize URL and normalize url\_hash via DB trigger + Python helper.
- Test: Given an unreachable URL saved with user note and tags, when created via API or MCP, then item and user note persist cleanly with enrich\_status='pending' and duplicate utm\_ variants map to identical canonical url\_hash.
- Links: [REQ-001](REQUIREMENTS.md#req-001), [REQ-004](REQUIREMENTS.md#req-004)

### <a id="edge-004"></a>EDGE-004. Built-in AI free quota exhaustion \(50/mo\) or spoofed/expired auth headers

Persona [PERSONA-001](AUDIENCE.md#persona-001). Severity critical. Frequency active users hitting free limit or unauthenticated API calls. Scope decision support-now.

- Impact: Unexpected API failures or unauthorized cross-tenant access if X-User-Id bypass stays open
- Response: Enforce Supabase JWT signature verification via backend/Login dependency; gate X-User-Id behind ENV=development and ALLOW\_DEV\_AUTH\_BYPASS=true; surface remaining quota and seamless BYOK fallback.
- Test: Given production environment settings, when request sends X-User-Id without valid signed Bearer JWT, then FastAPI returns HTTP 401.
- Links: [REQ-002](REQUIREMENTS.md#req-002), [RISK-001](RISKS-AND-ASSUMPTIONS.md#risk-001)
