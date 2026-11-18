# Flowchart โครงสร้างระบบ Backend (ภาพรวม)

```mermaid
flowchart TD
    subgraph Clients["Clients"]
        W["Web App (PWA)"]
        E["Browser Extension"]
        M["Mobile (Expo)"]
        EXT["AI ภายนอก (Claude / Cursor ฯลฯ)"]
    end

    W & E & M -->|"REST + Bearer JWT"| API["FastAPI Backend (Render)"]
    EXT -->|"Remote MCP + API Token"| MCP["MCP Server (13 tools)"]

    API --> AUTH{"ตรวจ JWT"}
    AUTH -->|"ไม่ผ่าน"| REJ["401 Unauthorized"]
    AUTH -->|"ผ่าน"| ROUTE{"Router"}

    ROUTE --> LOGIN["Login: สมัคร / Login / Magic Link / OAuth, โปรไฟล์, API Tokens"]
    ROUTE --> DB["Database: Items, Folders, Tags, แชร์/เชิญสมาชิก, Export"]
    ROUTE --> UNF["Unfurl: ดึง Preview รูป/วิดีโอ"]
    ROUTE --> AI["AI: สรุปเนื้อหา + แท็กอัตโนมัติ"]
    ROUTE --> REM["Reminders: ตั้ง / เลื่อน / ซ้ำ"]

    MCP -->|"แยกข้อมูลตามผู้ใช้"| DB
    MCP --> AI
    MCP --> REM

    LOGIN --> SBAUTH[("Supabase Auth")]
    DB --> PG[("Supabase PostgreSQL + RLS")]

    %% Unfurl
    PG -->|"DB Webhook: item-created"| UNF
    UNF -->|"SSRF Guard"| FETCH["Fetch + Platform Extractors"]
    FETCH --> STORE[("Supabase Storage: Thumbnail WebP")]
    FETCH -->|"อัปเดต preview / enrich_status"| PG

    %% AI
    AI --> TIER{"เลือก LLM"}
    TIER -->|"Tier 1: ฟรี (โควตา 50/เดือน)"| FREE["Gemini → failover Groq"]
    TIER -->|"Tier 2: BYOK"| BYOK["OpenAI / Gemini / Anthropic / OpenRouter / Groq"]
    TIER -->|"Tier 3: Custom"| CUSTOM["Custom / Local endpoint เช่น Ollama"]
    FREE & BYOK & CUSTOM -->|"บันทึก ai_summary / ai_tags"| PG

    %% Reminders
    REM --> PG
    CRON["pg_cron (ทุก 5 นาที)"] -->|"/cron/reminders"| REM
    CRON -->|"/cron/retry-enrich"| UNF
    REM -->|"ถึงเวลา"| PUSH["Push Adapters: Web Push / Expo / FCM"]
    PUSH --> DEV["แจ้งเตือนไปยังอุปกรณ์"]

    PG -.->|"Supabase Realtime sync"| Clients
```

## หลักการทำงานโดยสรุป
1. **Client** (Web, Extension, Mobile) เรียก REST API พร้อม JWT จาก Supabase Auth ส่วน **AI ภายนอก** เชื่อมผ่าน Remote MCP ด้วย API Token
2. **FastAPI** ตรวจตัวตน แล้วส่งไปยังโมดูล Login, Database, Unfurl, AI, Reminders
3. ข้อมูลทั้งหมดเก็บใน **Supabase PostgreSQL** (มี RLS) รูป thumbnail เก็บใน Supabase Storage
4. บันทึกลิงก์ใหม่ → DB Webhook เรียก **Unfurl** ดึง preview (ผ่าน SSRF Guard) → เก็บ WebP → อัปเดต item หากล้มเหลว `/cron/retry-enrich` จะลองใหม่
5. **AI** สรุปเนื้อหาและสร้างแท็ก โดยเลือก 3 ระดับ: ฟรีในตัว (Gemini → Groq), BYOK, Custom endpoint
6. **Reminders** ใช้ pg_cron ตรวจทุก 5 นาที แล้วส่ง Push (Web Push / Expo / FCM) ร่วมกับ local notification
7. **Supabase Realtime** sync ข้อมูลข้ามอุปกรณ์
