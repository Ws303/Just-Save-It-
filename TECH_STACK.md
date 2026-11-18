# Tech Stack & Architecture Overview — Sharely / Just-Save-It-

> **Project Concept:** ระบบเซฟลิงก์และข้อความ (Save for later) ข้ามแพลตฟอร์ม — Web App (PWA), Browser Extension, Mobile App (Expo) ใช้ Backend และฐานข้อมูล Supabase ร่วมกัน มีระบบ Link Unfurling (พรีวิวรูป/วิดีโอ), AI สรุปเนื้อหา (ใช้โมเดลฟรีในตัว หรือ BYOK/Custom endpoint), เตือนอ่านแบบ Hybrid (local + push) และ Remote MCP Server สำหรับ AI ภายนอก
>
> เอกสารนี้อัปเดตให้ตรงกับโค้ดปัจจุบัน (ชื่อแบรนด์ใน UI/Extension = **Sharely**, ชื่อ repo = Just-Save-It-)

---

## 1. ภาพรวมสถาปัตยกรรม (System Architecture)

```
[ Clients ]
 ├── 1. Web App   (frontend/ — Vanilla JS ES Modules + CSS, PWA + Service Worker)  → Render Static Site
 ├── 2. Extension (extension/ — Chrome/Edge Manifest V3)
 └── 3. Mobile    (mobile/ — Expo / React Native + expo-router, TypeScript)
        │  HTTP REST + Bearer JWT (Supabase Auth)  /  API Token (สำหรับ MCP)
        ▼
[ Backend API — FastAPI (Python 3.12 บน Render, region Singapore) ]
 ├── Login/      → /api/auth/*       (register, login, magic-link, native, oauth/callback,
 │                                    refresh, logout, me, profile, tokens, DELETE me)
 ├── Database/   → /api/*            (items, workspace, folders, invites, members, tags,
 │                                    devices, export, feedback)
 ├── Ai/         → /api/ai/*         (summarize, test) + MCP Server
 ├── Unfurl/     → /api/preview, /api/items/{id}/refresh-preview, /api/items/{id}/video,
 │                 /hooks/item-created, /cron/retry-enrich
 ├── Reminders/  → /api/reminders/*, /api/devices/deactivate, /cron/reminders
 ├── /health     (Render health check)
 └── /mcp        Remote MCP (Streamable HTTP + SSE: /mcp/sse, /mcp/messages)
        │  supabase-py / JWT verification
        ▼
[ Supabase ]
 ├── PostgreSQL (+ RLS, triggers, pg_cron, extensions: pgcrypto, pg_trgm)
 ├── Supabase Auth (JWT, Magic Link, OAuth)
 ├── Supabase Storage (bucket `thumbnails` — เก็บ WebP ที่ unfurl)
 └── Supabase Realtime (publication สำหรับ sync ข้ามอุปกรณ์)
```

---

## 2. รายละเอียดแต่ละส่วน (Component Breakdown)

### 🎨 2.1 Web Frontend (`frontend/`)
- **Stack:** Vanilla JavaScript (ES Modules, ไม่มี build step / ไม่ใช้ React/Next.js/Tailwind) — entry `src/main.js`
- **โครงสร้าง:** `src/screens/` (home, links, folders, ai, auth, profile, webExtension, testbed), `src/services/` (apiClient, supabaseAuth, realtimeClient, pushClient, routeGuard), `src/state/store.js`, `src/components/icons.js` (inline SVG)
- **Styling:** CSS ธรรมดา (`styles/tokens.css` design tokens + `styles/app.css`), Mobile-first, ฟอนต์ Noto Sans Thai / Nunito / JetBrains Mono
- **PWA:** `manifest.webmanifest` + `sw.js` (Service Worker รับ Web Push RFC 8291)
- **Config:** `config.js` ตั้ง `window.SHARELY_CONFIG.apiBaseUrl` (สร้างตอน build บน Render จาก `BACKEND_HOST`)
- **Tests:** `frontend/tests/*.test.mjs` (Node test runner)
- **Deploy:** Render Static Site (`render.yaml`, rewrite `/*` → `/index.html`)

### 📱 2.2 Mobile App (`mobile/`)
- **Framework:** Expo ~53, React Native 0.79, React 19, **expo-router** (`app/`: tabs, folder, item, login, auth-callback), TypeScript 5.8
- **Modules:** `expo-notifications`, `expo-secure-store`, `expo-web-browser`, `expo-linking`, `expo-file-system`, `expo-crypto`
- **โค้ดหลัก:** `src/api.ts`, `storage.ts`, `notifications.ts`, `shareIntent.ts` (รับ Share จากแอปอื่น), `actionGuards.ts`
- **Build:** EAS (`eas.json`), มี native `ios/` และ config plugins

### 🧩 2.3 Browser Extension (`extension/`)
- **Platform:** Chrome/Edge **Manifest V3** (v1.1.0)
- **ไฟล์:** `popup.html/js/css`, `background.js` (service worker), `content_assist.js`, `web_bridge.js` (รับ token จาก Web App ผ่าน `externally_connectable`), `api.js`
- **Context Menu:** "บันทึกหน้านี้ลง Sharely" (page/selection) และ "บันทึกลิงก์นี้ลง Sharely" (link)
- **Permissions:** `activeTab, tabs, storage, contextMenus, scripting, alarms, notifications` (+ optional host permissions)
- **ความสามารถ:** บันทึก URL พร้อมภาพปก แท็ก โฟลเดอร์ เตือนอ่าน และสรุป AI

### ⚙️ 2.4 Backend API (`backend/`)
- **Framework:** FastAPI + Uvicorn, Pydantic v2 (`pydantic[email]`), Python 3.12 (Render)
- **HTTP/Security:** `httpx`, `PyJWT` + `cryptography` (ตรวจ JWT), `python-dotenv`, CORS (origin ของ Web + regex `chrome-extension://…`), middleware จับ exception, SSRF guard (`Unfurl/security.py`, `Ai/content_extractor.validate_safe_url`)
- **Docs:** Swagger `/docs`, ReDoc `/redoc`
- **Internal endpoints:** `/hooks/*` และ `/cron/*` ป้องกันด้วย `INTERNAL_WEBHOOK_SECRET` (เรียกจาก Supabase DB Webhook / pg_cron)
- **Tests:** `pytest` + `pytest-asyncio` (`backend/tests/`)

### 🔍 2.5 Link Unfurling Engine (`backend/Unfurl/`)
- **การดึงเนื้อหา:** `httpx` + `selectolax` (parse HTML/meta: og:*, twitter:*, favicon), `trafilatura` (สกัดเนื้อหาบทความ), `charset-normalizer`
- **Platform extractors:** YouTube, TikTok, Vimeo, Spotify, Reddit (.json/gallery/oEmbed), X (publish.twitter.com oEmbed), Instagram/Facebook (Meta oEmbed ถ้ามี `META_OEMBED_ACCESS_TOKEN` ไม่เช่นนั้น fallback og:*); YouTube ใช้ oEmbed + noembed fallback
- **รูปภาพ:** `Pillow` แปลงเป็น WebP แล้วเก็บใน Supabase Storage (`webp_storage.py`) ; รองรับ `media_items` ได้สูงสุด 5 รายการ และ `embed_type` (youtube, tiktok, instagram, facebook, x, reddit, vimeo, spotify)
- **Enrichment:** `/hooks/item-created` (trigger จาก DB) + `/cron/retry-enrich` ลองใหม่เมื่อล้มเหลว (`enrich_status`, `enrich_attempts`)
- _หมายเหตุ: ไม่ได้ใช้ `yt-dlp`, `newspaper3k`, `beautifulsoup4`_

### 🤖 2.6 AI & MCP (`backend/Ai/`)
- **AI Summarization (`POST /api/ai/summarize`, `POST /api/ai/test`):** สรุปเนื้อหา + แท็กอัตโนมัติ (`ai_summary`, `ai_tags`, ภาษา th/en/auto)
  - **Tier 1 (Built-in ฟรี):** Google Gemini `gemini-3.1-flash-lite` (`GEMINI_MODEL`) → failover ไป Groq `openai/gpt-oss-20b` (`GROQ_MODEL`) เมื่อ 429/timeout; โควตาฟรี 50 ครั้ง/เดือน (`FREE_TIER_MONTHLY_AI_LIMIT`, ตาราง `daily_ai_usage`)
  - **Tier 2 (BYOK):** ผู้ใช้ส่ง header `X-AI-Provider` (openai | gemini | anthropic | openrouter | groq), `X-AI-Key`, `X-AI-Model`
  - **Tier 3 (Custom/Local endpoint):** `X-AI-Base-Url` (เช่น Ollama `http://localhost:11434/v1`)
- **ยังไม่มี:** Semantic Search / pgvector / embeddings — การค้นหาใช้ Postgres full-text (`search_tsv`, config `simple`) + `pg_trgm`
- **Remote MCP Server:** `mcp` SDK (FastMCP) ที่ `/mcp` (Streamable HTTP) และ `/mcp/sse`; ยืนยันตัวตนด้วย **API Token** (`Authorization`/`X-API-Token` หรือ `?token=`) ที่สร้างจาก `/api/auth/tokens`, แยกข้อมูลตามผู้ใช้ (tenant isolation) — **13 tools**:
  `search_and_list_items`, `get_item_detail`, `create_item`, `update_item`, `delete_item`, `summarize_item_to_note`, `list_tags`, `manage_item_tags`, `rename_or_delete_tag`, `list_folders`, `manage_folder`, `share_folder_link`, `set_or_cancel_reminder`

### ⏰ 2.7 Reminders & Push (`backend/Reminders/`)
- Hybrid Reminders: local notification (mobile/extension `alarms`) + remote push
- รองรับ recurring reminders (`unroller.py`), snooze, local-sync, `/cron/reminders` (pg_cron ทุก 5 นาที)
- **Push adapters:** Web Push (VAPID), Expo Push (iOS, `IOS_REMOTE_PUSH_ENABLED`), FCM (Android)

### 🗄️ 2.8 Database & Auth (Supabase)
- **Provider:** Supabase (PostgreSQL) — schema รวมที่ `backend/Database/schema.sql`, migrations ที่ `supabase/migrations/0001–0009`
- **Auth:** Supabase Auth (email/password, Magic Link, OAuth, native) → JWT ใช้ร่วมกันทุก Client; ตั้ง `ENV=production`, `ALLOW_DEV_AUTH_BYPASS=false`
- **ตารางหลัก (schema `public`):**
  - `profiles` — ข้อมูลผู้ใช้
  - `folders`, `folder_members`, `folder_invites` — โฟลเดอร์ + แชร์/เชิญสมาชิก
  - `items` — ลิงก์/โน้ต (`url`, `canonical_url`, `url_hash`, `title`, `description`, `image_url`, `media_items`, `embed_type/url`, `site_name`, `favicon_url`, `content_type`, `platform`, `note`, `ai_summary`, `ai_tags`, `is_favorite`, `status` inbox/…, `enrich_status`, `saved_at`, `done_at`, `search_tsv`; unique `(owner_id, url_hash)`)
  - `tags`, `item_tags` — แท็ก (N:M)
  - `reminders`, `devices` — เตือน + อุปกรณ์สำหรับ push
  - `daily_ai_usage` — โควตา AI
  - `api_tokens` — token สำหรับ MCP
  - `beta_feedback`; และ `private.app_config`
- **Security/Infra:** Row Level Security, triggers/functions, Storage bucket `thumbnails`, Realtime, pg_cron

---

## 3. Key REST Endpoints

| Method | Endpoint | หน้าที่ |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` · `/login` · `/magic-link` · `/native` · `/oauth/callback` · `/refresh` · `/logout` | ระบบสมาชิก |
| `GET/PATCH/DELETE` | `/api/auth/me` (`PATCH /profile`) | โปรไฟล์ / ลบบัญชี |
| `GET/POST/DELETE` | `/api/auth/tokens` | จัดการ API Token สำหรับ MCP |
| `GET` | `/api/workspace` | โหลด items/folders/tags รวมครั้งเดียว |
| `GET/POST` | `/api/items` | รายการ / บันทึกลิงก์ใหม่ |
| `GET/PATCH/DELETE` | `/api/items/{item_id}` | อ่าน/แก้ไข/ลบ |
| `GET/POST` | `/api/folders` ; `PATCH/DELETE /api/folders/{id}` | โฟลเดอร์ |
| `POST` | `/api/folders/{id}/invites` ; `GET /api/invites/{token}` ; `POST /api/invites/{token}/accept` | แชร์โฟลเดอร์ |
| `GET/PATCH/DELETE` | `/api/folders/{id}/members[/{user_id}]` | สมาชิกโฟลเดอร์ |
| `GET/POST/PATCH/DELETE` | `/api/tags[/{tag_id}]` | แท็ก |
| `POST` | `/api/preview` | ดึงพรีวิวจาก URL |
| `POST` | `/api/items/{id}/refresh-preview` · `GET /api/items/{id}/video` | รีเฟรชพรีวิว / วิดีโอ |
| `POST` | `/api/ai/summarize` · `/api/ai/test` | AI สรุป / ทดสอบ credential |
| `GET/POST/PUT/PATCH/DELETE` | `/api/reminders[/{item_id}]` (+ `/snooze`, `/local-sync`, `/push-config`) | เตือนอ่าน |
| `POST` | `/api/devices` · `/api/devices/deactivate` | ลงทะเบียน/ยกเลิกอุปกรณ์ push |
| `GET` | `/api/export` | ส่งออกข้อมูล |
| `GET/POST` | `/api/feedback` | Beta feedback |
| `POST` | `/hooks/item-created`, `/cron/reminders`, `/cron/retry-enrich` | Internal (ต้องมี secret) |
| `ANY` | `/mcp`, `/mcp/sse`, `/mcp/messages` | Remote MCP |
| `GET` | `/health` | Health check |

---

## 4. โครงสร้าง Repo (Monorepo Layout)

```text
Just-Save-It-/
├── README.md, DEVELOPER_GUIDE.md, PRODUCT_SPEC.md, TECH_STACK.md (ฉบับนี้)
├── AI_IMPLEMENTATION_PLAN.md, BACKEND_LOGIN_DB_PLAN.md, BACKEND_FLOWCHART.md
├── render.yaml                    # Deploy: just-save-it-api (Python) + just-save-it-web (static)
│
├── frontend/                      # Web/PWA (Vanilla JS)
│   ├── index.html, config.js, manifest.webmanifest, sw.js
│   ├── src/{main.js, screens/, services/, state/, components/, data/}
│   ├── styles/{tokens.css, app.css}, assets/, tests/
│
├── mobile/                        # Expo / React Native (expo-router)
│   ├── app/, src/, assets/, plugins/, ios/, eas.json
│
├── extension/                     # Chrome/Edge MV3
│   ├── manifest.json, background.js, popup.{html,js,css}
│   ├── content_assist.js, web_bridge.js, api.js, icons/
│
├── supabase/migrations/           # 0001–0009 SQL migrations
│
└── backend/                       # FastAPI
    ├── main.py                    # Entrypoint, routers, MCP mount, CORS
    ├── requirements.txt           # fastapi, uvicorn, httpx, trafilatura, selectolax, Pillow,
    │                              # PyJWT, google-genai, groq, mcp, supabase, pytest
    ├── .env.example
    ├── Ai/                        # LLM client, summarizer, content extractor, MCP server
    ├── Login/                     # Auth routes & JWT dependencies
    ├── Database/                  # Repository, schemas, schema.sql, Supabase/local DB clients
    ├── Unfurl/                    # Extractors, SSRF security, WebP storage
    ├── Reminders/                 # Reminder service, unroller, push adapters
    ├── scripts/                   # verify_supabase_live.py
    └── tests/                     # pytest suites
```
