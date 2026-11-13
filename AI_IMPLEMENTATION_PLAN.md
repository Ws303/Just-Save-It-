<!-- NOUS-SPEC: domain=ai-module | purpose=flash-worker-brief | stack=fastapi-gemini-groq-trafilatura-mcp-supabase | target=C:\Projects\Just-Save-It-\backend\Ai -->
# แผนงานละเอียดพาร์ท AI (`backend/Ai/`) & บรีฟส่งต่อให้ Gemini 3.8 Flash

> **เจ้าของพาร์ท:** ทีม AI (`C:\Projects\Just-Save-It-\backend\Ai\`)
> **หลักการทำงาน (Summarize-Once & Persist):**
> 1. **ตอนเซฟลิงก์:** ไม่ใช้ AI (ดึงแค่พรีวิว OG/oEmbed ธรรมดา)
> 2. **ตอนกดปุ่ม `"✨ สรุปด้วย AI"`:** เช็ก Database ก่อน ถ้ามีสรุปอยู่แล้วดึงมาแสดงทันที (ไม่เรียก AI ซ้ำ) ถ้ายังไม่มีค่อยดึงเนื้อหาหน้าเว็บ $\rightarrow$ ส่งให้ Gemini สรุป $\rightarrow$ บันทึกลง Database ถาวร (สรุปแล้วสรุปเลย)
> 3. **MCP Server:** เปิดให้ AI ภายนอก (Claude Desktop / Cursor) เข้ามาค้นหาลิงก์, อ่านสรุป/โน้ต, เซฟลิงก์ใหม่ และเขียนสรุปลงโน้ตผ่าน Personal Access Token (`jsi_live_xxx`)

---

## 1. โครงสร้างไฟล์ใน `C:\Projects\Just-Save-It-\backend\Ai\`

ออกแบบให้แยกหน้าที่ชัดเจน (Modular) เพื่อให้ **Gemini 3.8 Flash** เขียนทีละ 1–2 ไฟล์แล้วรันเทสต์ผ่านทีละขั้น:

```text
C:\Projects\Just-Save-It-\backend\
├── main.py                      # FastAPI Entrypoint (รวม router จาก Ai/)
├── requirements.txt             # รายการไลบรารีทั้งหมด
├── .env.example                 # ตัวแปรแวดล้อม (GEMINI_API_KEY, GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
├── Ai/
│   ├── __init__.py
│   ├── schemas.py               # [Step 1] Pydantic v2 Models (Request/Response & AI Structured Output)
│   ├── content_extractor.py     # [Step 2] ดึงเนื้อหาหน้าเว็บด้วย trafilatura + oEmbed สำหรับส่งให้ AI อ่าน
│   ├── llm_client.py            # [Step 3] ตัวเรียก Gemini Flash (หลัก) + Failover ไป Groq (สำรองเมื่อติด 429)
│   ├── summarizer_service.py    # [Step 4] Logic หลัก: เช็ก DB -> ถ้าไม่มีค่อยดึงเนื้อหา -> สรุป -> เซฟลง DB ถาวร + นับโควต้า
│   ├── router.py                # [Step 5] FastAPI Endpoints: POST /api/ai/summarize
│   └── mcp_server.py            # [Step 6] Remote MCP Server (5 Tools + ตรวจ Token SHA-256)
└── tests/
    └── test_ai_module.py        # [ทุก Step] Unit Tests (pytest) ทดสอบโดยจำลอง DB/LLM (ไม่ต้องเสียโควต้าจริงตอนรันเทสต์)
```

---

## 2. รายละเอียดแต่ละไฟล์ (Spec รายโมดูลสำหรับให้ Flash 3.8 เขียนตามเป๊ะๆ)

### Step 1: `Ai/schemas.py` (โครงสร้างข้อมูลเข้า-ออก)
- **`AIConfig`** (การตั้งค่า AI สำหรับรองรับ Built-in / BYOK / Custom Endpoint):
  - `provider: Literal["built-in", "byok", "custom"] = "built-in"`
  - `api_key: Optional[str] = None` (Key ของผู้ใช้ เช่น OpenAI, Anthropic, Gemini, OpenRouter — รับทาง Header/Body แบบ Ephemeral ไม่เซฟลง DB)
  - `base_url: Optional[str] = None` (Custom Base URL เช่น `http://localhost:11434/v1` สำหรับ Ollama / vLLM / Private GPU)
  - `model: Optional[str] = None` (ชื่อโมเดลที่เลือก เช่น `llama3.2`, `gpt-4o-mini`, `claude-3-5-haiku`, `gemini-2.5-flash`)
- **`SummarizeRequest`**:
  - `item_id: str` (UUID ของลิงก์ในตาราง `items`)
  - `force_refresh: bool = False` (ค่าเริ่มต้นคือ `False` = ถ้ามีสรุปใน DB แล้วให้ใช้ของเดิมทันที, ถ้าตั้ง `True` คือบังคับสรุปใหม่)
  - `save_to_note: bool = True` (บันทึกข้อความสรุปต่อท้ายลงช่อง `note` ด้วยหรือไม่)
  - `ai_config: Optional[AIConfig] = None` (ถ้าผู้ใช้ส่ง Key หรือ Custom Endpoint ของตัวเองมา)
- **`AISummaryOutput`** (Schema บังคับรูปแบบ JSON ที่ LLM ต้องตอบกลับ):
  - `summary_th: str` — สรุปใจความสำคัญภาษาไทย 3 บรรทัด (Bullet points อ่านเข้าใจง่าย)
  - `suggested_tags: list[str]` — แท็กแนะนำไม่เกิน 5 คำ (เลือกจากแท็กเดิมของผู้ใช้ก่อน ถ้าไม่ตรงค่อยสร้างคำใหม่)
  - `content_type: Literal["article", "video", "post", "product", "other"]`
- **`SummarizeResponse`**:
  - `item_id: str`
  - `url: str`
  - `summary_th: str`
  - `suggested_tags: list[str]`
  - `cached_from_db: bool` (`True` = ดึงจากที่เคยสรุปไว้แล้วใน DB ไม่เสียโควต้าใหม่, `False` = เพิ่งสรุปใหม่ด้วย AI)
  - `engine_used: str` (เช่น `"built-in:gemini-flash"`, `"byok:openai/gpt-4o-mini"`, `"custom:ollama/llama3.2"`)

---

### Step 2: `Ai/content_extractor.py` (ตัวดึงเนื้อหาหน้าเว็บมาป้อน AI)
- **ฟังก์ชันหลัก:** `async def extract_text_for_ai(url: str, fallback_title: str = "", fallback_desc: str = "") -> str`
- **ลำดับการทำงาน:**
  1. **SSRF Guard:** ตรวจสอบก่อนว่า `url` เป็น `http/https` ปกติ และไม่ได้ชี้ไปที่ `localhost`, `127.0.0.1`, หรือ Private IP (`10.x`, `192.168.x`, `169.254.x`)
  2. **ถ้าเป็น YouTube / TikTok / X:** ยิง `oEmbed` ดึง `title` + `author_name` มารวมกับ `fallback_desc`
  3. **ถ้าเป็นเว็บทั่วไป:** ใช้ `httpx.AsyncClient(timeout=8.0, follow_redirects=True)` ดึง HTML แล้วส่งเข้า `trafilatura.extract(html, include_comments=False, include_tables=True)` เพื่อเอาเฉพาะเนื้อหาบทความล้วนๆ
  4. **Token Trimming:** รวม `Title + Description + Extracted Body` แล้วตัดความยาวไม่ให้เกิน **`6,000 ตัวอักษร`** เพื่อคุมความเร็วและประหยัดโทเค็น

---

### Step 3: `Ai/llm_client.py` (ตัวเชื่อมต่อแบบ 3 Tiers: Built-in, BYOK และ Custom Endpoint)
- **ฟังก์ชันหลัก:** `async def generate_structured_summary(content_text: str, existing_user_tags: list[str], config: Optional[AIConfig] = None) -> tuple[AISummaryOutput, str]`
- **Prompt มาตรฐาน:**
  - บทบาท: ผู้ช่วยสรุปเนื้อหาอัจฉริยะของแอป Just-Save-It
  - กฎเหล็ก:
    1. สรุปเป็นภาษาไทย 3 ข้อสั้นๆ (`• ...`) อ่านจบใน 5 วินาที
    2. แนะนำแท็ก 3–5 คำ โดย **ต้องเลือกจาก `existing_user_tags` ก่อน** หากมีความหมายใกล้เคียง เพื่อไม่ให้แท็กซ้ำซ้อน
    3. ตอบกลับเป็น JSON ที่ตรงกับ `AISummaryOutput` เท่านั้น
- **การเลือก Engine ตามโหมด (Hybrid Router & Stateless BYOK Relay):**
  1. **Tier 1 (Built-in Free):** ไม่ส่ง Key มา (`config is None` หรือ `provider == 'built-in'`)
     - ยิง **Google Gemini Flash** ผ่าน Platform Key (`.env`)
     - ถ้าเกิด `429 Too Many Requests` หรือ Timeout $\rightarrow$ สลับไปยิง **Groq (`llama-3.3-70b-versatile`)** อัตโนมัติ (นับโควต้าผู้ใช้)
  2. **Tier 2 (BYOK — Bring Your Own Key):** ผู้ใช้ส่ง API Key ของตัวเองมา
     - รองรับ OpenAI (`gpt-4o-mini`), Gemini Key, Anthropic, OpenRouter, Groq
     - ยิงผ่าน OpenAI-compatible format (`httpx` ไปยัง Endpoint ของเจ้านั้น) โดยใช้ Key ของผู้ใช้เอง
     - **ไม่นับโควต้าของแพลตฟอร์ม** และ **ไม่บันทึก Key ลง Database** (Stateless Header Relay ปลอดภัย 100%)
  3. **Tier 3 (Custom / Local Endpoint):** ผู้ใช้รันโมเดลเอง (Ollama / vLLM / LMStudio / GPU ส่วนตัว)
     - รับ `base_url` (เช่น `http://localhost:11434/v1` หรือ IP ส่วนตัว) + `model`
     - ยิงตรงไปยัง `base_url/chat/completions` (รองรับทั้งแบบใส่ Bearer Token หรือ **Keyless** ไม่ต้องใส่คีย์)
     - **ไม่นับโควต้า** สรุปได้ไม่จำกัดจำนวนครั้งฟรีตลอดชีพ

---

### Step 4: `Ai/summarizer_service.py` (หัวใจหลัก: สรุปแล้วสรุปเลย + เก็บลง DB)
- **ฟังก์ชันหลัก:** `async def summarize_item_once(db, user_id: str, req: SummarizeRequest) -> SummarizeResponse`
- **ลำดับการทำงาน (5 ขั้นตอน):**
  1. **ดึงข้อมูลลิงก์จาก DB:** Query ตาราง `items` ด้วย `id = req.item_id` (เช็กสิทธิ์ว่า `owner_id == user_id` หรืออยู่ใน Shared Folder ที่มีสิทธิ์อ่าน)
  2. **เช็กว่าเคยสรุปไว้หรือยัง (Summarize-Once Check):**
     - ถ้า `item.ai_summary` มีข้อความอยู่แล้ว และ `req.force_refresh == False`:
       - **ส่งค่าเดิมกลับทันที (`cached_from_db=True`)** ไม่ต้องดึงเว็บใหม่ ไม่ต้องเรียก AI ซ้ำ!
     - *(โบนัสประหยัดงบ)* ถ้าลิงก์นี้ยังไม่มี `ai_summary` แต่ในตาราง `items` มีคนอื่นเคยกดสรุปลิงก์ `url_hash` เดียวกันไว้แล้ว $\rightarrow$ ก๊อปปี้ `ai_summary` นั้นมาบันทึกให้เลยโดยไม่ต้องเสียโควต้าเรียก AI ใหม่!
  3. **เช็กโควต้าผู้ใช้ (ข้ามขั้นตอนนี้ถ้าเป็น BYOK หรือ Custom Endpoint!):**
     - ถ้าผู้ใช้ใช้ `built-in` $\rightarrow$ ตรวจสอบตาราง `daily_ai_usage` (เช่น Free tier ไม่เกิน 50 ครั้ง/เดือน)
     - ถ้าผู้ใช้ใส่ **BYOK / Custom Endpoint** ของตัวเองมา $\rightarrow$ **อนุญาตให้ผ่านทันที ไม่จำกัดโควต้า**
  4. **ดึงเนื้อหา + เรียก AI:**
     - ดึงรายชื่อแท็กเดิมของผู้ใช้จากตาราง `tags` (`SELECT name FROM tags WHERE owner_id = user_id`)
     - เรียก `extract_text_for_ai(item.url, item.title, item.description)`
     - เรียก `generate_structured_summary(text, existing_tags, req.ai_config)`
  5. **บันทึกลง Database ถาวร (Persist Forever):**
     - `UPDATE items SET ai_summary = ..., ai_tags = ..., enrich_status = 'done'`
     - ถ้า `req.save_to_note == True` และใน `note` ยังไม่มีสรุปนี้ ให้บันทึกสรุปลงใน `note` ด้วย
     - ถ้าเป็น `built-in` ให้บวกจำนวนการใช้โควต้าใน `daily_ai_usage` +1 (ถ้าเป็น BYOK/Custom ไม่ต้องบวก)

---

### Step 5: `Ai/router.py` (FastAPI Endpoint สำหรับปุ่มกดหน้าบ้าน)
- **`POST /api/ai/summarize`**
  - รับ `SummarizeRequest` + ตรวจ JWT Token ของผู้ใช้จาก Header `Authorization: Bearer <supabase_jwt>`
  - เรียก `summarize_item_once(...)`
  - คืนค่า `SummarizeResponse` ให้หน้าบ้านเอาไปแสดงผลทันที

---

### Step 6: `Ai/mcp_server.py` (Full-Featured Remote MCP Server — ทำได้ครบทุกฟังก์ชันของแอป)
- ใช้ `FastMCP` จากไลบรารี `mcp`
- **การยืนยันตัวตน (Tenant Isolation Invariant):**
  - อ่าน Token `jsi_live_xxxx` จาก Header/Query $\rightarrow$ แปลงเป็น `SHA-256` $\rightarrow$ ค้นหา `user_id` จากตาราง `api_tokens` ใน Supabase
  - **ห้ามรับ `user_id` จากพารามิเตอร์ที่ AI ส่งมาเด็ดขาด** (ป้องกัน AI อ่าน/แก้ข้อมูลข้ามคน)
- **Tools ครบทุกมิติของแอป (12 Tools แบ่งตามหมวด):**

#### 🗂️ หมวดที่ 1: จัดการลิงก์และบันทึก (Items & Notes CRUD)
1. **`search_and_list_items(query: str = None, folder_id: str = None, tag_name: str = None, status: str = None, limit: int = 20)`**
   - ดูรายการลิงก์ทั้งหมด หรือค้นหาจากคำค้น/โฟลเดอร์/แท็ก/สถานะ (`inbox`, `todo`, `done`, `archived`)
2. **`get_item_detail(item_id: str)`**
   - ดูรายละเอียดลิงก์แบบเต็ม (URL, ชื่อ, คำโปรย, โน้ต, บทสรุป AI, แท็กทั้งหมด, โฟลเดอร์ที่อยู่, และเวลาแจ้งเตือน)
3. **`create_item(url: str, title: str = None, note: str = None, folder_id: str = None, tags: list[str] = None, status: str = "inbox")`**
   - เพิ่ม/เซฟลิงก์ใหม่เข้าคลัง พร้อมใส่โน้ต เลือกโฟลเดอร์ และติดแท็กได้ทันที
4. **`update_item(item_id: str, title: str = None, note: str = None, folder_id: str = None, status: str = None)`**
   - แก้ไขข้อมูลบันทึก: แก้ชื่อเรื่อง, เขียน/แก้ไขบันทึก (`note`), ย้ายไปโฟลเดอร์อื่น, หรือติ๊กเปลี่ยนสถานะ (`inbox` $\rightarrow$ `todo` $\rightarrow$ `done` / `archived`)
5. **`delete_item(item_id: str)`**
   - ลบลิงก์ออกจากคลัง
6. **`summarize_item_to_note(item_id: str, force_refresh: bool = False)`**
   - สั่งให้ AI อ่านเนื้อหาลิงก์แล้วสรุปเก็บลงช่อง `ai_summary` และ `note` ถาวร (ใช้ `summarize_item_once` ตัวเดียวกับปุ่มหน้าเว็บ)

#### 🏷️ หมวดที่ 2: จัดการแท็ก (Tags Management)
7. **`list_tags()`**
   - ดูแท็กทั้งหมดที่มีในบัญชีพร้อมจำนวนลิงก์ในแต่ละแท็ก
8. **`manage_item_tags(item_id: str, add_tags: list[str] = None, remove_tags: list[str] = None)`**
   - ติดแท็กเพิ่ม (ถ้าแท็กยังไม่มีในระบบจะสร้างให้อัตโนมัติ) หรือเอาแท็กออกจากลิงก์
9. **`rename_or_delete_tag(tag_name: str, new_name: str = None, delete: bool = False)`**
   - เปลี่ยนชื่อแท็ก หรือลบแท็กออกจากระบบ

#### 📁 หมวดที่ 3: จัดการโฟลเดอร์ และการแชร์ให้เพื่อน (Folders & Sharing Link)
10. **`list_folders()`**
    - ดูโฟลเดอร์ทั้งหมด (ทั้งโฟลเดอร์ส่วนตัวและโฟลเดอร์ที่แชร์กับเพื่อน) พร้อมสถานะการแชร์
11. **`manage_folder(action: Literal["create", "rename", "delete"], name: str = None, folder_id: str = None, emoji: str = None)`**
    - สร้างโฟลเดอร์ใหม่, เปลี่ยนชื่อ/อีโมจิของโฟลเดอร์, หรือลบโฟลเดอร์
12. **`share_folder_link(folder_id: str, role: Literal["viewer", "editor"] = "editor", expires_in_days: int = 7, revoke_all: bool = False)`**
    - **กดแชร์โฟลเดอร์เป็นลิงก์ให้เพื่อน:** สร้าง Invite Token ลงตาราง `folder_invites` ตั้งค่า `folders.is_shared = True` แล้วคืนค่าลิงก์เต็มรูปแบบ (เช่น `https://app.justsaveit.com/invite/<token>`) ให้ผู้ใช้ก๊อปปี้ส่งให้เพื่อนเข้ามาร่วมดู (`viewer`) หรือร่วมเพิ่ม/แก้ไขบันทึก (`editor`) ได้ทันที (หรือส่ง `revoke_all=True` เพื่อยกเลิกลิงก์แชร์เดิมทั้งหมด)

#### ⏰ หมวดที่ 4: ตั้งเวลาแจ้งเตือน (Reminders)
13. **`set_or_cancel_reminder(item_id: str, remind_at_iso: str = None, cancel: bool = False)`**
    - ตั้งเวลาแจ้งเตือนให้กลับมาดูลิงก์ (หรือยกเลิกการเตือน)

---

## 3. ✅ ตารางเช็คลิสต์ครบทุกฟังก์ชัน & เกณฑ์ผ่าน/ไม่ผ่าน (Self-Verification Matrix)

> **กฎการตรวจตัวเองของ AI (Mandatory Self-Audit):** หลังเขียนโค้ดเสร็จ เอเจนต์ต้องเขียน Unit Tests (`tests/test_ai_module.py`) เพื่อทดสอบฟังก์ชันทั้งหมด **21 ฟังก์ชัน** ด้านล่างนี้ และต้องรัน `pytest` ให้ผ่านครบทุกข้อ (`Exit Code 0`) ก่อนส่งงาน

### ส่วนที่ A: Core AI & Extraction Functions (8 ฟังก์ชัน)

| # | ไฟล์ | ชื่อฟังก์ชัน / คลาส | หน้าที่ | ✅ เกณฑ์ผ่าน (PASS Criteria) | ❌ เกณฑ์ไม่ผ่าน (FAIL Criteria) |
|---|---|---|---|---|---|
| **A1** | `Ai/schemas.py` | `AIConfig`, `SummarizeRequest`, `AISummaryOutput`, `SummarizeResponse` | ตรวจสอบโครงสร้างข้อมูลเข้า-ออก | แปลง JSON เป็น Object ได้ถูกต้อง, บังคับ `suggested_tags` ไม่เกิน 5 คำ, `provider` รับเฉพาะ `built-in`, `byok`, `custom` | รับค่าผิดประเภทแล้วยังผ่าน หรือไม่มี field `cached_from_db` และ `engine_used` |
| **A2** | `Ai/content_extractor.py` | `validate_safe_url(url: str) -> str` | ป้องกัน SSRF (ห้ามยิงเข้า IP ภายในเครื่อง) | บล็อก `localhost`, `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, `169.254.x.x`, `file://` โดยโยน `ValueError` ทันที และอนุญาต `https://` ปกติ | ยอมให้ URL ที่ชี้เข้า `127.0.0.1` หรือ `localhost` ผ่านไปยิง HTTP ได้ |
| **A3** | `Ai/content_extractor.py` | `extract_text_for_ai(url: str, fallback_title: str, fallback_desc: str) -> str` | ดึงเนื้อหาเว็บ/oEmbed มาป้อน AI | 1) สกัดเนื้อหาบทความด้วย `trafilatura` ได้<br>2) ถ้าเว็บดึงไม่ได้ ให้คืนค่า `fallback_title + fallback_desc` แทน (ไม่พัง)<br>3) **ตัดความยาวข้อความไม่เกิน 6,000 ตัวอักษรเสมอ** | คืนค่าเกิน 6,000 ตัวอักษร หรือโยน Exception จนระบบค้างเมื่อเว็บปลายทางล่ม |
| **A4** | `Ai/llm_client.py` | `call_builtin_llm(prompt: str) -> tuple[AISummaryOutput, str]` | Tier 1: เรียก Gemini Flash + สลับไป Groq เมื่อติด 429 | 1) ถ้ายิง Gemini สำเร็จ คืนค่า `(AISummaryOutput, "built-in:gemini-flash")`<br>2) **ถ้า Gemini ตอบ HTTP 429 หรือ Error ต้องสลับไปเรียก Groq อัตโนมัติ** และคืนค่า `"built-in:groq-llama3"` | พอ Gemini ติด 429 แล้วโยน Error พังทันทีโดยไม่สลับไปเรียก Groq |
| **A5** | `Ai/llm_client.py` | `call_byok_or_custom_llm(prompt: str, config: AIConfig) -> tuple[AISummaryOutput, str]` | Tier 2 & 3: เรียกด้วย API Key ผู้ใช้ หรือ Custom Endpoint (Ollama/vLLM) | 1) ส่ง Header `Authorization: Bearer <config.api_key>` เมื่อมีคีย์ หรือส่งแบบ Keyless ได้เมื่อเป็น `custom`<br>2) ยิงไปที่ `<base_url>/chat/completions` ได้ถูกต้อง<br>3) ไม่บันทึก `api_key` ลงไฟล์หรือ DB | บังคับต้องมี `api_key` เสมอจนรัน Ollama แบบ Keyless ไม่ได้ หรือแอบเก็บ Key ลง DB |
| **A6** | `Ai/llm_client.py` | `generate_structured_summary(content_text: str, existing_user_tags: list[str], config: Optional[AIConfig])` | ตัวเลือก Router กลาง + บังคับแท็กเดิม | แนบ `existing_user_tags` เข้าไปใน System Prompt เสมอ และเลือกเรียก `call_builtin_llm` หรือ `call_byok_or_custom_llm` ตาม `config.provider` ได้ถูกต้อง | ไม่ส่งรายชื่อแท็กเดิมของผู้ใช้เข้า Prompt หรือเลือก Tier ผิด |
| **A7** | `Ai/summarizer_service.py` | `summarize_item_once(db, user_id: str, req: SummarizeRequest) -> SummarizeResponse` | **หัวใจหลัก: สรุปแล้วสรุปเลย (Summarize-Once)** | 1) **ถ้าใน DB มี `ai_summary` อยู่แล้ว (`force_refresh=False`) ต้องคืนค่าจาก DB ทันที (`cached_from_db=True`) โดยห้ามเรียก `extract_text_for_ai` หรือ LLM เด็ดขาด**<br>2) ถ้ายังไม่มีใน DB ต้องเรียก AI แล้ว `UPDATE` ลง `items.ai_summary` (และ `note` ถ้าตั้ง `save_to_note=True`)<br>3) หักโควต้า `daily_ai_usage` เฉพาะเมื่อ `provider == 'built-in'` และไม่ได้ดึงจาก Cache | เรียก LLM ซ้ำทั้งที่มี `ai_summary` ใน DB อยู่แล้ว, หรือหักโควต้าผู้ใช้ทั้งที่ใช้ BYOK/Custom Endpoint หรือดึงจาก Cache |
| **A8** | `Ai/router.py` | `POST /api/ai/summarize` | API Endpoint สำหรับปุ่มกดสรุปหน้าบ้าน | รับ Header `Authorization`, `X-AI-Provider`, `X-AI-Key`, `X-AI-Base-Url`, `X-AI-Model` มาประกอบเป็น `AIConfig` ส่งให้ `summarize_item_once` และตอบ HTTP 200 พร้อม JSON ตาม `SummarizeResponse` | ไม่รองรับการส่ง Key/Base URL ผ่าน Header หรือคืน Status Code ผิดเมื่อไม่ได้ส่ง Token ยืนยันตัวตน |

---

### ส่วนที่ B: Remote MCP Server Tools (`Ai/mcp_server.py` — 14 ฟังก์ชัน: Auth 1 + Tools 13)

| # | ชื่อฟังก์ชัน / MCP Tool | หน้าที่ | ✅ เกณฑ์ผ่าน (PASS Criteria) | ❌ เกณฑ์ไม่ผ่าน (FAIL Criteria) |
|---|---|---|---|---|
| **B0** | `verify_mcp_token(raw_token: str) -> str` | ตรวจรหัส Token `jsi_live_xxx` แล้วคืน `user_id` | นำ `raw_token` ไปแปลงเป็น `SHA-256` แล้วค้นในตาราง `api_tokens` (ที่ `revoked_at IS NULL`) คืนค่า `user_id` ของเจ้าของ Token; ถ้าไม่เจอหรือถูกยกเลิกให้โยน `PermissionError` (401) | เปรียบเทียบ Token แบบ Plaintext โดยไม่ Hash SHA-256 หรือยอมให้รับ `user_id` จากพารามิเตอร์ที่ AI ส่งมาเอง |
| **B1** | `search_and_list_items(query, folder_id, tag_name, status, limit)` | ดู/ค้นหาลิงก์ในคลัง | คืนเฉพาะรายการที่ `owner_id == user_id` (หรืออยู่ใน Shared Folder ที่มีสิทธิ์) กรองตามคำค้น/โฟลเดอร์/แท็ก/สถานะได้ถูกต้อง | ดึงข้อมูลของ User คนอื่นที่ไม่ได้แชร์มาปน หรือกรองสถานะไม่ได้ |
| **B2** | `get_item_detail(item_id)` | ดูรายละเอียดลิงก์แบบเต็ม | คืนข้อมูลลิงก์ครบ (`url`, `title`, `note`, `ai_summary`, `tags`, `folder_id`, `reminders`) เฉพาะที่มีสิทธิ์เข้าถึง | อ่าน `item_id` ของคนอื่นที่ไม่ได้แชร์ได้ (รั่วข้าม Tenant) |
| **B3** | `create_item(url, title, note, folder_id, tags, status)` | เซฟลิงก์ใหม่ผ่าน MCP | `INSERT` ลงตาราง `items` ด้วย `owner_id = user_id` เสมอ หากส่ง `tags` มาด้วยต้องผูก `item_tags` ให้ครบ | สร้าง Item โดยไม่ผูก `owner_id` หรือไม่ผูกแท็กที่ส่งมา |
| **B4** | `update_item(item_id, title, note, folder_id, status)` | แก้ไขบันทึก/โน้ต/ย้ายโฟลเดอร์/ติ๊กสถานะ | อัปเดตเฉพาะฟิลด์ที่ส่งค่ามา (`title`, `note`, `folder_id`, `status`) และถ้าเปลี่ยน `status='done'` ต้องบันทึกเวลา `done_at` ด้วย | เขียนทับฟิลด์อื่นที่ไม่ได้ส่งมาให้กลายเป็น `None` หรือยอมให้แก้ของคนอื่นโดยไม่มีสิทธิ์ `editor` |
| **B5** | `delete_item(item_id)` | ลบลิงก์ออกจากคลัง | ลบเฉพาะเมื่อ `owner_id == user_id` เท่านั้น และคืนข้อความยืนยันการลบ | ลบลิงก์ของคนอื่นได้ |
| **B6** | `summarize_item_to_note(item_id, force_refresh)` | สั่งให้ AI สรุปลิงก์เก็บลงโน้ตผ่าน MCP | เรียกใช้ `summarize_item_once(..., save_to_note=True)` ตัวเดียวกับระบบหลัก แล้วคืนบทสรุปภาษาไทย + แท็กแนะนำ | เขียนโค้ดแยกต่างหากจนไม่เช็ก Cache ใน DB หรือไม่เซฟลงช่อง `note` |
| **B7** | `list_tags()` | ดูแท็กทั้งหมดของผู้ใช้ | คืนรายชื่อแท็กทั้งหมดของ `user_id` พร้อมจำนวนรายการที่ใช้แท็กนั้น | คืนแท็กของ User คนอื่นปนมาด้วย |
| **B8** | `manage_item_tags(item_id, add_tags, remove_tags)` | เพิ่ม/ลบแท็กในบันทึก | 1) ถ้าชื่อแท็กใน `add_tags` ยังไม่มีในตาราง `tags` ให้สร้างให้อัตโนมัติแล้วผูกเข้า `item_tags`<br>2) ลบความสัมพันธ์ใน `item_tags` สำหรับแท็กใน `remove_tags` | เพิ่มแท็กซ้ำแล้วพัง หรือลบแท็กออกจากตัวลิงก์ไม่ได้ |
| **B9** | `rename_or_delete_tag(tag_name, new_name, delete)` | เปลี่ยนชื่อแท็ก หรือลบแท็ก | เปลี่ยนชื่อแท็กในตาราง `tags` ของ `user_id` เมื่อส่ง `new_name` หรือลบแท็กทิ้งเมื่อ `delete=True` | กระทบแท็กชื่อเดียวกันของ User คนอื่น |
| **B10** | `list_folders()` | ดูโฟลเดอร์ส่วนตัวและโฟลเดอร์ที่แชร์ร่วมกัน | คืนทั้งโฟลเดอร์ที่ `owner_id == user_id` และโฟลเดอร์ที่ตัวเองอยู่ใน `folder_members` พร้อมระบุ `is_shared` และ `role` | แสดงเฉพาะโฟลเดอร์ที่สร้างเอง แต่ไม่แสดงโฟลเดอร์ที่เพื่อนแชร์มาให้ |
| **B11** | `manage_folder(action, name, folder_id, emoji)` | สร้าง/เปลี่ยนชื่อ/ลบโฟลเดอร์ | รองรับครบทั้ง `action="create"`, `"rename"`, `"delete"` โดยตรวจสิทธิ์ว่าเป็นเจ้าของโฟลเดอร์ (`owner_id == user_id`) | ยอมให้คนที่ไม่ใช่เจ้าของลบโฟลเดอร์ได้ |
| **B12** | `share_folder_link(folder_id, role, expires_in_days, revoke_all)` | **สร้างลิงก์แชร์โฟลเดอร์ให้เพื่อน** | 1) ตรวจว่า `owner_id == user_id`<br>2) ถ้า `revoke_all=True` ให้ลบ Invite เดิมใน `folder_invites` และตั้ง `is_shared=False`<br>3) ถ้าแชร์ปกติ ให้ตั้ง `folders.is_shared=True` สร้าง Token ลง `folder_invites` พร้อมกำหนด `role` (`viewer`/`editor`) และคืนลิงก์เต็มรูปแบบ `https://.../invite/<token>` | คืนค่าแต่ Token เปล่าๆ ไม่มีลิงก์พร้อมส่งให้เพื่อน, หรือตั้ง `role='owner'` ได้ (ห้ามโอน owner ผ่านลิงก์เชิญ) |
| **B13** | `set_or_cancel_reminder(item_id, remind_at_iso, cancel)` | ตั้งเวลาแจ้งเตือนหรือยกเลิก | ถ้า `cancel=False` ให้บันทึกเวลา `remind_at` ลงตาราง `reminders` ของ `user_id`; ถ้า `cancel=True` ให้ลบรายการเตือนที่ยังไม่ส่ง (`sent_at IS NULL`) ของลิงก์นั้น | ตั้งเวลาเตือนโดยไม่ผูก `user_id` หรือยกเลิกการเตือนไม่ได้ |

---

## 4. 📋 บรีฟพร้อมก๊อปปี้ไปวางในแชทใหม่ (สำหรับ Gemini 3.8 Flash)

> 💡 **วิธีใช้:** เปิดแชทใหม่ เลือกโมเดล **Gemini 3.8 Flash** แล้วก๊อปปี้ข้อความในกล่องด้านล่างนี้ไปวางได้เลยครับ

```markdown
ช่วยเขียนโค้ดพาร์ท AI และ MCP Server ทั้งหมดของโปรเจกต์ Just-Save-It ในโฟลเดอร์ `C:\Projects\Just-Save-It-\backend\Ai\` ตามแผนและตารางเช็คลิสต์ในไฟล์ `C:\Projects\Just-Save-It-\AI_IMPLEMENTATION_PLAN.md`

### กฎเหล็กการทำงาน (Strict Execution Guardrails):
1. ก่อนเริ่มเขียนไฟล์ ให้รัน `python tools/nous_preflight.py --task "Implement Just-Save-It AI module"`
2. อ่านไฟล์ `C:\Projects\Just-Save-It-\AI_IMPLEMENTATION_PLAN.md` ให้ครบทุกบรรทัด โดยเฉพาะ **หัวข้อที่ 3 (ตารางเช็คลิสต์ครบทุกฟังก์ชัน A1–A8 และ B0–B13 พร้อมเกณฑ์ PASS/FAIL)**
3. **ห้ามเขียนรวดเดียวทั้งหมดเด็ดขาด!** ให้ทำตามลำดับ Micro-Batch ด้านล่าง **ทีละ 1 Batch เท่านั้น** เมื่อทำเสร็จในแต่ละ Batch ให้รันตรวจสอบไวยากรณ์ด้วย `python tools/step_verify.py --files <path>` และสรุปผลสั้นๆ แล้วหยุดรอฉันสั่ง "ไปต่อ" จึงค่อยเริ่ม Batch ถัดไป
4. โค้ดทุกไฟล์ต้องเขียนตัวเต็มครบทุกฟังก์ชันตามตาราง A1–A8 และ B0–B13 ห้ามใช้คอมเมนต์ย่อโค้ด เช่น `# ... rest of code ...` หรือ `# TODO`

---

### ลำดับการทำทีละ Batch:
- **[เริ่มที่นี่] Batch 1: โครงสร้างข้อมูลและไลบรารี (เช็คลิสต์ข้อ A1)**
  - สร้าง `C:\Projects\Just-Save-It-\backend\requirements.txt`
  - สร้าง `C:\Projects\Just-Save-It-\backend\.env.example`
  - สร้าง `C:\Projects\Just-Save-It-\backend\Ai\__init__.py` และ `Ai/schemas.py` (`AIConfig`, `SummarizeRequest`, `AISummaryOutput`, `SummarizeResponse`)
- **Batch 2: ท่อดึงเนื้อหา & ตัวเรียก LLM 3 Tiers (เช็คลิสต์ข้อ A2–A6)**
  - สร้าง `Ai/content_extractor.py` (`validate_safe_url` SSRF guard + `extract_text_for_ai` ตัดไม่เกิน 6,000 ตัวอักษร)
  - สร้าง `Ai/llm_client.py` (`call_builtin_llm` Gemini Flash/Groq failover + `call_byok_or_custom_llm` รองรับ BYOK และ Ollama/vLLM Keyless + `generate_structured_summary`)
- **Batch 3: Logic สรุปแล้วสรุปเลย & FastAPI Router (เช็คลิสต์ข้อ A7–A8)**
  - สร้าง `Ai/summarizer_service.py` (`summarize_item_once`: เช็ก DB ก่อนเสมอ ถ้ามี `ai_summary` แล้วคืนค่าทันทีไม่เรียก AI ซ้ำ, ถ้าไม่มีค่อยสรุปและเซฟถาวรลง `ai_summary` + `note`, หักโควต้าเฉพาะ `built-in`)
  - สร้าง `Ai/router.py` (`POST /api/ai/summarize` รองรับทั้ง Body และ Headers `X-AI-Provider`, `X-AI-Key`, `X-AI-Base-Url`, `X-AI-Model`)
- **Batch 4: Remote MCP Server เต็มรูปแบบ (เช็คลิสต์ข้อ B0–B13)**
  - สร้าง `Ai/mcp_server.py` (ต้องมีครบทั้ง `verify_mcp_token` ด้วย SHA-256 และ MCP Tools ทั้ง 13 ตัวตามตาราง B1–B13: จัดการบันทึก, โน้ต, แท็ก, โฟลเดอร์, สร้างลิงก์แชร์โฟลเดอร์ให้เพื่อน `share_folder_link`, และตั้งเตือน)
  - เชื่อม Router และ MCP เข้ากับ `C:\Projects\Just-Save-It-\backend\main.py`
- **Batch 5: ชุดทดสอบตรวจตัวเอง (Self-Verification Unit Tests ครบทุกข้อ A1–A8 & B0–B13)**
  - สร้าง `C:\Projects\Just-Save-It-\backend\tests\test_ai_module.py` โดยใช้ Mock สำหรับ Supabase/HTTP เพื่อทดสอบพิสูจน์เกณฑ์ PASS/FAIL ทุกข้อในตารางเช็คลิสต์:
    1. ทดสอบ SSRF Guard บล็อก `localhost`/`127.0.0.1` และการตัดข้อความเหลือ 6,000 ตัวอักษร (A2–A3)
    2. ทดสอบ Gemini ติด 429 แล้วสลับไป Groq อัตโนมัติ + ทดสอบ BYOK และ Custom Endpoint แบบ Keyless ไม่หักโควต้า (A4–A6)
    3. ทดสอบ Summarize-Once: มีสรุปใน DB แล้วต้องได้ `cached_from_db=True` และไม่เรียก LLM ซ้ำ vs ยังไม่มีสรุปต้องเรียก LLM และอัปเดตลง DB ถาวร (A7–A8)
    4. ทดสอบ MCP Token Hash SHA-256 + ป้องกันการอ่าน/ลบข้อมูลข้าม `user_id` + ทดสอบ MCP Tools ทั้ง 13 ตัวรวมถึง `share_folder_link` ที่ต้องคืนลิงก์ `/invite/<token>` (B0–B13)
  - รัน `pytest` ให้ผ่าน 100% (`Exit Code 0`) แล้วสรุปตารางเช็คลิสต์ A1–A8 และ B0–B13 ว่า `[PASS]` ครบทุกข้อก่อนจบงาน

ตอนนี้ขอให้เริ่มทำเฉพาะ **Batch 1** ก่อนได้เลยครับ!
```
