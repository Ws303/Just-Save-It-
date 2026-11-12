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
- **`SummarizeRequest`**:
  - `item_id: str` (UUID ของลิงก์ในตาราง `items`)
  - `force_refresh: bool = False` (ค่าเริ่มต้นคือ `False` = ถ้ามีสรุปใน DB แล้วให้ใช้ของเดิมทันที, ถ้าตั้ง `True` คือบังคับสรุปใหม่)
  - `save_to_note: bool = True` (บันทึกข้อความสรุปต่อท้ายลงช่อง `note` ด้วยหรือไม่)
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

---

### Step 2: `Ai/content_extractor.py` (ตัวดึงเนื้อหาหน้าเว็บมาป้อน AI)
- **ฟังก์ชันหลัก:** `async def extract_text_for_ai(url: str, fallback_title: str = "", fallback_desc: str = "") -> str`
- **ลำดับการทำงาน:**
  1. **SSRF Guard:** ตรวจสอบก่อนว่า `url` เป็น `http/https` ปกติ และไม่ได้ชี้ไปที่ `localhost`, `127.0.0.1`, หรือ Private IP (`10.x`, `192.168.x`, `169.254.x`)
  2. **ถ้าเป็น YouTube / TikTok / X:** ยิง `oEmbed` ดึง `title` + `author_name` มารวมกับ `fallback_desc`
  3. **ถ้าเป็นเว็บทั่วไป:** ใช้ `httpx.AsyncClient(timeout=8.0, follow_redirects=True)` ดึง HTML แล้วส่งเข้า `trafilatura.extract(html, include_comments=False, include_tables=True)` เพื่อเอาเฉพาะเนื้อหาบทความล้วนๆ
  4. **Token Trimming:** รวม `Title + Description + Extracted Body` แล้วตัดความยาวไม่ให้เกิน **`6,000 ตัวอักษร`** เพื่อคุมความเร็วและประหยัดโทเค็น

---

### Step 3: `Ai/llm_client.py` (ตัวเชื่อม Gemini Flash + Groq Fallback)
- **ฟังก์ชันหลัก:** `async def generate_structured_summary(content_text: str, existing_user_tags: list[str]) -> AISummaryOutput`
- **Prompt มาตรฐาน:**
  - บทบาท: ผู้ช่วยสรุปเนื้อหาอัจฉริยะของแอป Just-Save-It
  - กฎเหล็ก:
    1. สรุปเป็นภาษาไทย 3 ข้อสั้นๆ (`• ...`) อ่านจบใน 5 วินาที
    2. แนะนำแท็ก 3–5 คำ โดย **ต้องเลือกจาก `existing_user_tags` ก่อน** หากมีความหมายใกล้เคียง เพื่อไม่ให้แท็กซ้ำซ้อน
    3. ตอบกลับเป็น JSON ที่ตรงกับ `AISummaryOutput` เท่านั้น
- **ระบบสลับโมเดลอัตโนมัติ (Hybrid Failover):**
  1. ยิง **Google Gemini Flash** (อ่านชื่อรุ่นจาก `os.getenv("GEMINI_MODEL", "gemini-2.5-flash")`)
  2. ถ้าเกิด `429 Too Many Requests` หรือ Timeout $\rightarrow$ สลับไปยิง **Groq (`llama-3.3-70b-versatile`)** ทันทีโดยที่ผู้ใช้ไม่รู้สึกว่าล่ม

---

### Step 4: `Ai/summarizer_service.py` (หัวใจหลัก: สรุปแล้วสรุปเลย + เก็บลง DB)
- **ฟังก์ชันหลัก:** `async def summarize_item_once(db, user_id: str, req: SummarizeRequest) -> SummarizeResponse`
- **ลำดับการทำงาน (5 ขั้นตอน):**
  1. **ดึงข้อมูลลิงก์จาก DB:** Query ตาราง `items` ด้วย `id = req.item_id` (เช็กสิทธิ์ว่า `owner_id == user_id` หรืออยู่ใน Shared Folder ที่มีสิทธิ์อ่าน)
  2. **เช็กว่าเคยสรุปไว้หรือยัง (Summarize-Once Check):**
     - ถ้า `item.ai_summary` มีข้อความอยู่แล้ว และ `req.force_refresh == False`:
       - **ส่งค่าเดิมกลับทันที (`cached_from_db=True`)** ไม่ต้องดึงเว็บใหม่ ไม่ต้องเรียก AI ซ้ำ!
     - *(โบนัสประหยัดงบ)* ถ้าลิงก์นี้ยังไม่มี `ai_summary` แต่ในตาราง `items` มีคนอื่นเคยกดสรุปลิงก์ `url_hash` เดียวกันไว้แล้ว $\rightarrow$ ก๊อปปี้ `ai_summary` นั้นมาบันทึกให้เลยโดยไม่ต้องเสียโควต้าเรียก AI ใหม่!
  3. **เช็กโควต้าผู้ใช้:** ตรวจสอบตาราง `daily_ai_usage` (เช่น Free tier ไม่เกิน 50 ครั้ง/เดือน)
  4. **ดึงเนื้อหา + เรียก AI:**
     - ดึงรายชื่อแท็กเดิมของผู้ใช้จากตาราง `tags` (`SELECT name FROM tags WHERE owner_id = user_id`)
     - เรียก `extract_text_for_ai(item.url, item.title, item.description)`
     - เรียก `generate_structured_summary(text, existing_tags)`
  5. **บันทึกลง Database ถาวร (Persist Forever):**
     - `UPDATE items SET ai_summary = ..., ai_tags = ..., enrich_status = 'done'`
     - ถ้า `req.save_to_note == True` และใน `note` ยังไม่มีสรุปนี้ ให้บันทึกสรุปลงใน `note` ด้วย
     - บวกจำนวนการใช้โควต้าใน `daily_ai_usage` +1

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

## 3. 📋 บรีฟพร้อมก๊อปปี้ไปวางในแชทใหม่ (สำหรับ Gemini 3.8 Flash)

> 💡 **วิธีใช้:** เปิดแชทใหม่ เลือกโมเดล **Gemini 3.8 Flash** แล้วก๊อปปี้ข้อความในกล่องด้านล่างนี้ไปวางได้เลยครับ

```markdown
ช่วยเขียนโค้ดพาร์ท AI และ MCP Server ทั้งหมดของโปรเจกต์ Just-Save-It ในโฟลเดอร์ `C:\Projects\Just-Save-It-\backend\Ai\` ตามแผนที่วางไว้ในไฟล์ `C:\Projects\Just-Save-It-\AI_IMPLEMENTATION_PLAN.md` (และสเปกหลักใน `C:\Projects\Just-Save-It-\PRODUCT_SPEC.md`)

### กฎการทำงานสำหรับแชทนี้ (Flash 3.8 Exoskeleton):
1. รัน `python tools/nous_preflight.py --task "Implement Just-Save-It AI module (On-Demand Summarizer + Full-Featured MCP Server)"` ก่อนเริ่ม
2. อ่านไฟล์ `C:\Projects\Just-Save-It-\AI_IMPLEMENTATION_PLAN.md` ให้ครบ
3. **หลักการสำคัญของพาร์ท AI & MCP:**
   - **On-Demand AI Summary (สรุปแล้วสรุปเลย):** ตอนเซฟลิงก์จะไม่ใช้ AI (ดึงแค่พรีวิวธรรมดา) AI จะทำงานเฉพาะเมื่อกดปุ่มสรุป (`POST /api/ai/summarize`) หรือสั่งผ่าน MCP โดยต้องเช็ก Database ก่อนเสมอ ถ้ามี `ai_summary` อยู่แล้วให้คืนค่าเดิมจาก DB ทันที (ไม่เรียก AI ซ้ำ) ถ้ายังไม่มีค่อยดึงเนื้อหาด้วย `trafilatura` -> สรุปด้วย Gemini Flash (มี Groq เป็นตัวสำรองเมื่อติด 429) -> บันทึกลง `ai_summary` และ `note` ใน Database ถาวร
   - **Full-Featured Remote MCP Server (`mcp_server.py`):** ให้ AI ภายนอกเข้ามาทำได้ครบทุกฟังก์ชันของแอป (รวม 13 Tools) ทั้งดู/ค้นหาบันทึก, เพิ่มบันทึกใหม่, แก้ไขโน้ต/ชื่อ/สถานะ, จัดการเพิ่ม/ลบ/แก้ชื่อ Tag, สร้าง/แก้ไข/ลบ Folder, **กดสร้างลิงก์แชร์ Folder ให้เพื่อนเข้ามาดูหรือร่วมแก้ไขได้ (`share_folder_link`)**, และตั้งเวลาแจ้งเตือน โดยแยกสิทธิ์ตาม `user_id` จาก Token เท่านั้น
4. **ทำทีละ Step แบบ Micro-Batch (แก้ไขไม่เกิน 2 ไฟล์ต่อรอบ แล้วรัน `python tools/step_verify.py --files <path>` ทุกครั้ง)** ตามลำดับนี้:
   - **Batch 1:** สร้าง `C:\Projects\Just-Save-It-\backend\requirements.txt`, `.env.example`, และ `Ai/schemas.py`
   - **Batch 2:** สร้าง `Ai/content_extractor.py` (พร้อม SSRF guard + trafilatura + oEmbed) และ `Ai/llm_client.py` (Gemini Flash + Groq failover)
   - **Batch 3:** สร้าง `Ai/summarizer_service.py` (เช็ก DB ก่อน -> ถ้าไม่มีค่อยสรุป -> บันทึกถาวร) และ `Ai/router.py` (`POST /api/ai/summarize`)
   - **Batch 4:** สร้าง `Ai/mcp_server.py` (ครบทั้ง 13 MCP tools ครอบคลุม Items, Notes, Tags, Folders, Share Folder Link, Reminders) และเชื่อมทั้งหมดเข้า `C:\Projects\Just-Save-It-\backend\main.py`
   - **Batch 5:** เขียนและรัน Unit Tests ใน `C:\Projects\Just-Save-It-\backend\tests\test_ai_module.py` ด้วย `pytest` เพื่อพิสูจน์ว่าทั้ง (1) การสรุปแบบเช็ก DB ก่อน (Summarize-Once) และ (2) MCP Tools ทั้งการจัดการบันทึก/แท็ก/โฟลเดอร์/สร้างลิงก์แชร์ให้เพื่อน ทำงานถูกต้อง 100% (`Exit Code 0`)

ขอให้แสดงแผนสั้นๆ ก่อน แล้วเริ่มลุยตั้งแต่ Batch 1 จนจบครบทุก Batch ได้เลย
```
