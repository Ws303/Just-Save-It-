# สรุปปัญหาเกี่ยวกับการแชร์และการแสดงผลพรีวิว (Share & Display Issues Summary)

เอกสารนี้รวบรวมปัญหาที่พบทั้งหมดเกี่ยวกับ **การแชร์ลิงก์ผ่าน Chrome Extension** และ **การดึงข้อมูล/แสดงผลพรีวิว (Title, แคปชั่น, รูปภาพ, วิดีโอ Reels)** พร้อมสาเหตุ วิธีแก้ไข ไฟล์ที่เกี่ยวข้อง และ Checklist สำหรับนำไปรีเช็คซ้ำ

---

## 1. การแชร์ลิงก์และ UX ฝั่ง Chrome Extension

### 1.1 ตัวเลือก User-Agent สำหรับดึงข้อมูลฝั่ง Meta (Facebook / Instagram)
- **ปัญหา:** การใช้ User-Agent ของเบราว์เซอร์ทั่วไปทำให้ฝั่ง Meta ดีดไปหน้า Login หรือได้แคปชั่น/รูปภาพไม่ครบ แต่การบังคับใช้ `facebookexternalhit/1.1` ตลอดเวลาก็อาจไม่เหมาะกับทุกสภาพแวดล้อม
- **การแก้ไข:**
  - คง `User-Agent` ปกติเป็นค่าเริ่มต้น และเพิ่มตัวเลือก `ALLOW_META_CRAWLER_UA=true` ใน `backend/.env` เพื่ออนุญาตให้ใช้ `facebookexternalhit/1.1` เฉพาะโดเมนของ Meta (`is_meta_crawler_ua_enabled()` ใน `backend/Unfurl/security.py`)
  - ต้องรีสตาร์ต Backend (เช่น `uvicorn`) หลังแก้ค่า `.env` (แต่ `uvicorn --reload` จะโหลดโค้ด Python ที่แก้ใหม่ให้อัตโนมัติ)
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/security.py`, `backend/.env`

### 1.2 กดบันทึกจากหน้าฟีดรวม (ไม่ใช่ลิงก์แชร์โพสต์จริง)
- **ปัญหา:** ผู้ใช้เปิดหน้าฟีด/หน้าหลักของ Facebook, TikTok หรือ Instagram แล้วกดบันทึกจาก Extension ทันที ทำให้ได้ลิงก์กลาง (เช่น หน้า Feed หรือโปรไฟล์) แทนลิงก์ของโพสต์/คลิปเฉพาะเจาะจง
- **การแก้ไข:**
  - เพิ่มฟังก์ชัน `getSocialPostLinkWarning` ใน `extension/api.js` และเชื่อมกับ `extension/popup.js` เพื่อตรวจจับหน้าฟีด/หน้าหลักของ Facebook, TikTok, Instagram ที่ยังไม่ใช่ลิงก์โพสต์จริง พร้อมแสดงคำแนะนำให้ผู้ใช้คัดลอก/วางลิงก์แชร์ของโพสต์นั้นก่อนกดบันทึก
- **ไฟล์ที่เกี่ยวข้อง:** `extension/api.js`, `extension/popup.js`

### 1.3 สถานะ "บันทึกแล้ว" มองไม่เห็นโดยไม่ต้องเลื่อนจอ
- **ปัญหา:** การ์ดแสดงผลหลังบันทึกอยู่ด้านล่างของ Popup ทำให้ผู้ใช้ไม่เห็นทันทีว่าบันทึกแล้วต้องเลื่อนลงไปดู
- **การแก้ไข:**
  - แทรก `<section id="savedResultCard">` ไว้ก่อนปุ่มบันทึกใน `extension/popup.html` และสั่งแสดง/ซ่อนจาก `extension/popup.js`
- **ไฟล์ที่เกี่ยวข้อง:** `extension/popup.html`, `extension/popup.js`

### 1.4 Extension ส่งชื่อแท็บที่เป็นชื่อแพลตฟอร์มทั่วไปเป็น Title
- **ปัญหา:** `popup.js` นำ `tab.title` (เช่น `"Instagram"`, `"Facebook"`, `"TikTok"`) มากรอกในช่อง Title และไม่ยอมให้ข้อมูลพรีวิวจาก Backend มาเขียนทับ
- **การแก้ไข:**
  - เพิ่ม `isGenericPlatformTitle`, `shouldOverwritePopupTitle` และติดตาม `tabDefaultTitle` ใน `extension/api.js` / `extension/popup.js` รวมถึงล้างชื่อแท็บที่เป็นชื่อแพลตฟอร์มเปล่าใน `extension/content_assist.js` เพื่อไม่ให้ชื่อทั่วไปถูกส่งทับแคปชั่นจริง
- **ไฟล์ที่เกี่ยวข้อง:** `extension/api.js`, `extension/popup.js`, `extension/content_assist.js`

---

## 2. Title และแคปชั่น (Caption)

### 2.1 แคปชั่นจาก Facebook แสดงไม่ครบ (ตัดท้ายด้วย `...`)
- **ปัญหา:** `og:description` จากหน้าโพสต์ Facebook มักถูกตัดทอนและลงท้ายด้วย `...`
- **การแก้ไข:**
  - เพิ่ม `_parse_facebook_plugin_post` / `_fetch_facebook_plugin_post` ใน `backend/Unfurl/extractors.py` ดึงแคปชั่นเต็มจาก `plugins/post.php` และข้อมูล JSON บนหน้าโพสต์เพื่อมาแทนที่ข้อความที่ถูกตัดสั้น
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`

### 2.2 Title ขึ้นเป็นชื่อแพลตฟอร์มทั่วไป หรือยาวเต็มแคปชั่น
- **ปัญหา:**
  - ลิงก์ IG Reels / Facebook / TikTok / YouTube บางรายการแสดง Title เป็น `"Instagram"`, `"Facebook"`, `"Watch trending videos for you | TikTok"`, หรือมีตัวเลขแจ้งเตือนนำหน้าอย่าง `"(584) ... - YouTube"` ทั้งที่โพสต์มีแคปชั่น
  - บางโพสต์นำแคปชั่นยาวหลายบรรทัดมาแสดงเป็น Title ทั้งก้อนแทนประโยคเปิดสั้นๆ
- **การแก้ไข:**
  - **Backend Unfurl:** เพิ่ม `is_generic_or_noisy_title`, `_scrub_generic_platform_title` และปรับ `_sanitize_social_title_and_description` ใน `backend/Unfurl/extractors.py` เพื่อคัดเฉพาะประโยค/บรรทัดเปิดแรกสั้นๆ ไม่เกิน 1 บรรทัดจากแคปชั่น, ตัดชื่อแพลตฟอร์ม/ยอดวิว/ตัวเลขแจ้งเตือน `(N) `, และเทียบข้อความซ้ำแบบละเว้นช่องว่างรอบอีโมจิ
  - **Backend DB & Re-enrich:** ปรับ `_should_replace_title`, `_should_replace_description` และ `find_recent_unfurl_cache` ใน `backend/Unfurl/service.py` รวมถึง `needs_re_enrich` ใน `create_or_bump_item` (`backend/Database/repository.py`) เพื่อให้เขียนทับชื่อแพลตฟอร์มทั่วไปได้ทันทีเมื่อ enrich หรือเมื่อบันทึกซ้ำ
  - **Frontend UI:** เพิ่ม `isGenericOrNoisyTitle`, `formatCardDisplayTitle` และ `formatPostDetailTitleAndDesc` ใน `frontend/src/screens/links.js` เชื่อมกับการ์ดใน `frontend/src/screens/common.js` (`renderLinkCard`) และเพิ่มการตรวจ `hasGenericTitle` ใน `maybeAutoEnrichItem` (`frontend/src/main.js`) สำหรับรีเฟรชรายการเก่าอัตโนมัติในโหมด Live
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`, `backend/Unfurl/service.py`, `backend/Database/repository.py`, `frontend/src/screens/links.js`, `frontend/src/screens/common.js`, `frontend/src/main.js`

### 2.3 แคปชั่น IG เหลือ `".` ต่อท้าย
- **ปัญหา:** ข้อความ `og:description` ของ IG ในรูปแบบ `... - author on date: "caption". ` ถอดเครื่องหมายคำพูดไม่หมดจนเหลือ `".` ต่อท้ายแคปชั่น
- **การแก้ไข:**
  - ปรับ `_IG_OG_DESC_RE` และเพิ่ม `_strip_balanced_caption_quotes` / `stripBalancedCaptionQuotes` ทั้งฝั่ง Backend และ Frontend
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`, `frontend/src/screens/links.js`

---

## 3. รูปภาพ, อัลบั้มหลายรูป และการขยายดูเต็มจอ

### 3.1 โพสต์รูปหลายรูป Facebook ได้แค่รูปเดียว และกด Play แล้วขึ้นกรอบโปรไฟล์ทั้งโพสต์
- **ปัญหา:**
  - ระบบสร้าง `embed_url` เป็น `plugins/post.php` แล้ว UI แยกไม่ออกว่าเป็นโพสต์รูปภาพหรือวิดีโอ พอกด Play จึงเปิด iframe โปรไฟล์โพสต์ขึ้นมาโดยไม่มีรูปและกรอบไม่ปรับขนาด
  - การดึงรูปอ่านเพียง `og:image` รูปแรก
- **การแก้ไข:**
  - แยกโพสต์รูปภาพออกจากปุ่ม Play วิดีโอด้วย `isPlayableVideoEmbed` ใน `frontend/src/screens/links.js` (ปฏิเสธ `plugins/post.php` และ IG `/p/` ที่ไม่ใช่ `video`)
  - ดึงรูปจากอัลบั้มได้สูงสุด **5 รูปแรก** (`MAX_MEDIA_ITEMS = 5`) โดยเมื่อเลื่อนถึงสไลด์สุดท้าย (กรณีอาจมีมากกว่า 5 รูป) ให้แสดงป้าย/ปุ่ม `"ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗"`
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`, `frontend/src/screens/links.js`

### 3.2 ขยายรูปเต็มจอ ภาพชัดขึ้น และกรอบปรับตามรูป/วิดีโอ
- **ปัญหา:**
  - กดขยายรูปเต็มจอยังไม่ได้
  - ตอนเลื่อนดูรูปถัดไปกรอบหน้าต่างไม่ปรับตามสัดส่วนรูป และตอนกดเล่นวิดีโอแนวตั้งกรอบเด้งกลับเป็นแนวนอน
- **การแก้ไข:**
  - เพิ่ม Lightbox เต็มจอ (`figma-lightbox-backdrop`, ปุ่มขยาย, เลื่อนซ้าย/ขวา และปิดด้วย `Escape`)
  - ปรับ CSS `.figma-rich-preview-box.has-media` ให้ขนาดกรอบยืดหยุ่นตามสัดส่วนรูปจริง และตอนกด Play วิดีโอให้บันทึก `playingVideoIsVertical` กับ `playingVideoAspect` จาก `naturalWidth / naturalHeight` ของภาพปก
- **ไฟล์ที่เกี่ยวข้อง:** `frontend/src/screens/links.js`, `frontend/src/main.js`, `frontend/styles/app.css`

### 3.3 โพสต์รูปเดียวจาก Instagram แสดง 2 รูป โดยรูปที่สองซูมครอปเข้า
- **ปัญหา:**
  - IG ส่ง `srcset` ที่มีทั้งภาพเต็มและภาพครอปสี่เหลี่ยม (`stp=c...`) ด้วยความละเอียด `w` เท่ากันโดยวางภาพครอปไว้ท้ายรายการ ทำให้ตัวเลือกเดิม (`>=`) หยิบภาพครอปมาแทนภาพเต็ม
  - `og:image` (ที่ถูกครอป `s640x640`) กับภาพเต็มจาก `/embed/captioned/` ใช้คนละ CDN host (`scontent.cdninstagram.com` vs `instagram.fbkk*.fna.fbcdn.net`) ทำให้ระบบรวมเป็น 2 สไลด์แทนที่จะเป็น 1 รูป
- **การแก้ไข:**
  - ปรับ `_pick_best_srcset_url` (`backend/Unfurl/extractors.py`) และ `pickBestSrcsetUrl` (`extension/content_assist.js`) ให้จัดอันดับภาพไม่ครอปเหนือกว่าภาพครอปเสมอ
  - เมื่อ `/embed/captioned/` ได้ภาพเต็มมาให้แทนที่ภาพครอปจาก `og:image` ใน `_extract_meta_social`
  - รวมภาพซ้ำข้าม CDN ด้วยรหัสไฟล์ asset เดียวกันใน `filter_and_cap_images`, `_resolve_media_with_existing` (`backend/Unfurl/service.py`), `content_assist.js` และ `getPreviewMediaImages` (`frontend/src/screens/links.js`) รวมถึงกรองภาพครอปขนาดเล็กที่ค้างอยู่ในรายการเก่าคู่กับ `.webp` ออกตอนแสดงผล
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`, `backend/Unfurl/service.py`, `extension/content_assist.js`, `frontend/src/screens/links.js`

### 3.4 โพสต์อัลบั้มหลายรูปจาก Instagram (`edge_sidecar_to_children`) แสดงแค่รูปเดียว
- **ปัญหา:** หน้า `/embed/captioned/` ของโพสต์อัลบั้ม IG (`DfwmFqjEuGf`) ใส่แท็ก `<img class="EmbeddedMediaImage">` ไว้เฉพาะรูปแรก ส่วนรูปที่ 2 เป็นต้นไปอยู่ใน JSON ที่ escape ซ้อนหลายชั้น (`edge_sidecar_to_children` → `display_url`)
- **การแก้ไข:**
  - เพิ่ม `_extract_ig_sidecar_display_urls` และ `_unescape_meta_json_url` อ่าน URL ของทุกรูปในอัลบั้มจาก JSON ในหน้า embed (สูงสุด 5 รูป) และปรับเงื่อนไขให้โพสต์ `/p/` ที่ยังได้รูปไม่ถึง 2 รูปเปิดหน้า embed เพิ่มทุกครั้ง
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`

### 3.5 ข้อพิจารณาเรื่องการดึงรูปครบทุกใบ vs จำกัด 5 รูป
- **Reels / คลิป:** ควรมีเพียง **1 รูปปก** เสมอ ไม่ควรดึงรูปทั้งหมดในหน้าเพราะอาจติดภาพคลิปแนะนำหรือทำให้วิดีโอกลายเป็นแกลเลอรี
- **โพสต์อัลบั้ม:** คงเพดาน **5 รูปแรก** + ปุ่ม `"ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗"` เพราะระบบบีบอัดเก็บถาวรเฉพาะรูปปกใบแรก ส่วนรูปที่ 2 เป็นต้นไปเป็นลิงก์ CDN ที่มีวันหมดอายุ อีกทั้งช่วยลดขนาดข้อมูลในฐานข้อมูล/Cache และลดโอกาสโดนแพลตฟอร์มบล็อก

---

## 4. การเล่นคลิปวิดีโอ & Instagram Reels

### 4.1 ลิงก์ IG Reels แบบ `/reels/<code>/` (มี `s`) เปิดดูไม่ได้และขึ้น "ไม่สามารถแสดงตัวอย่างได้"
- **ปัญหา:** ลิงก์ที่ก๊อปมาจากแถบ URL บนเว็บ IG มักเป็น `/reels/<code>/` ซึ่งฝั่ง IG ดีดตัวดึงข้อมูลไป `/accounts/login/` บ่อยกว่า `/reel/<code>/` และเมื่อรวมกับ `/embed/captioned/` ที่ไม่พบข้อมูล ระบบจึงตีเป็น `private_or_restricted` พร้อมล้าง `embed_url` เป็น `null`
- **การแก้ไข:**
  - ปรับเฉพาะตัวแปร `fetch_meta_url` ภายในบล็อก `if platform == "instagram":` ของ `_extract_meta_social` ให้ยิง `_fetch_generic_html_meta` ไปที่ `https://www.instagram.com/reel/{ig_code}/` เมื่อ path เป็น `/reels/` โดยไม่แก้ `url`, `canonical_url` หรือ `url_hash` จริงของรายการ และไม่กระทบฝั่ง Facebook
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`

### 4.2 ดูคลิป IG Reels จบ 1 รอบแล้วขึ้น "รับชมอีกครั้งบน Instagram" กดเล่นซ้ำในแอปไม่ได้
- **ปัญหา:** ภายใน `<iframe src="https://www.instagram.com/reel/.../embed">` ตัวเล่นของ Instagram เองหยุดหลังจบ 1 รอบและขึ้นป้ายชวนออกไปดูบนเว็บ IG เนื่องจากเป็น cross-origin iframe แอปเราจึงเข้าไปแก้ปุ่มข้างใน iframe โดยตรงไม่ได้
- **การแก้ไข:**
  - **Backend:** เพิ่ม `extract_instagram_playable_video_url` (`backend/Unfurl/extractors.py`), `resolve_item_playable_video` (`backend/Unfurl/service.py`) และ endpoint `GET /api/items/{item_id}/video` (`backend/Unfurl/router.py`) เพื่อดึงลิงก์ `.mp4` สดจาก `video_url` บน Meta CDN เมื่อคลิปนั้นอนุญาต (ตรวจสิทธิ์ `can_access_item` และ rate limit โดยไม่ต้องแก้ schema ฐานข้อมูล)
  - **Frontend:** เพิ่ม `apiClient.resolveItemVideo` (`frontend/src/services/apiClient.js`), `resolveAllowlistedDirectVideoUrl` และให้ `renderRichPreviewBox` (`frontend/src/screens/links.js`) เล่นด้วยแท็ก `<video class="figma-preview-video" controls loop autoplay playsinline>` เมื่อได้ `.mp4` (วนลูป/กดเล่นซ้ำได้ไม่จำกัดโดยไม่ขึ้นหน้า Instagram) พร้อมตัวจับ `error` ใน `frontend/src/main.js` เพื่อ fallback กลับไปใช้ `<iframe>` ทันทีเมื่อคลิปไม่มี `.mp4` หรือสตรีมเล่นไม่ได้
- **ไฟล์ที่เกี่ยวข้อง:** `backend/Unfurl/extractors.py`, `backend/Unfurl/service.py`, `backend/Unfurl/router.py`, `frontend/src/services/apiClient.js`, `frontend/src/state/store.js`, `frontend/src/screens/links.js`, `frontend/src/main.js`, `frontend/styles/app.css`

### 4.3 ข้อจำกัดจากฝั่ง Instagram ที่ยังหลีกเลี่ยงไม่ได้
- คลิปที่เจ้าของปิดการฝัง (Embed), ใช้เพลงลิขสิทธิ์ (เช่น `DfzqfsjyQkb` ที่ไม่มี `video_url` และขึ้น `"Watch on Instagram"`) หรือติดจำกัดอายุ/แท็ก `#19` (เช่น `Dfz09kGyug0` ที่ `/embed` คืน `"The link to this photo or video may be broken"`) จะไม่สามารถเล่นตรงในกรอบได้ ต้องกดปุ่ม **"เปิดลิงก์ต้นฉบับ"** ออกไปดูที่ Instagram โดยตรง

---

## 5. Checklist สำหรับนำไปรีเช็คซ้ำ

- [ ] **เตรียมทดสอบ:** กด **Reload** Extension ที่ `chrome://extensions` และกด **Hard Refresh (`Cmd + Shift + R`)** บน `http://localhost:3000/` (ตรวจสอบว่า Backend รันพร้อม `ALLOW_META_CRAWLER_UA=true` ใน `backend/.env` หากต้องการดึง Meta แบบ crawler UA)
- [ ] **Extension เตือนลิงก์หน้าฟีด:** เปิดหน้าฟีดหลัก IG / Facebook / TikTok (ไม่ใช่ลิงก์โพสต์) แล้วเปิด Extension → ต้องขึ้นเตือนให้วางลิงก์แชร์โพสต์จริงแทนการบันทึกหน้าฟีด
- [ ] **Extension ตำแหน่งผลลัพธ์ & Title:** บันทึกโพสต์จริงจาก Extension → การ์ด `บันทึกแล้ว` ต้องเห็นก่อนปุ่มบันทึกโดยไม่ต้องเลื่อนลง และชื่อ Title ต้องไม่ค้างเป็น `"Instagram"` / `"Facebook"` / `"TikTok"`
- [ ] **Title & แคปชั่นบนเว็บ:** ตรวจโพสต์ IG, Facebook, TikTok, YouTube → Title ต้องเป็นประโยคเริ่มต้นสั้นๆ 1 บรรทัดจากแคปชั่น (ไม่มี `(N) ` นำหน้า), แคปชั่น Facebook แสดงครบไม่ตัด `...`, แคปชั่น IG ไม่มี `".` ติดท้าย
- [ ] **IG รูปเดียว vs หลายรูป:**
  - โพสต์ IG รูปเดียว (เช่น `DfzabQmDTBe`) → แสดง 1 รูป ไม่เบิ้ลเป็น 2 รูปซูมครอป และไม่มีปุ่ม Play
  - โพสต์ IG อัลบั้ม (เช่น `DfwmFqjEuGf`) และ Facebook อัลบั้ม (เช่น `1CT7y7W7h3`) → เลื่อนได้สูงสุด 5 รูป, รูปสุดท้ายมีป้าย `"ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗"`, กดขยายเต็มจอ (Lightbox) ได้ และกรอบปรับขนาดตามสัดส่วนภาพ
- [ ] **การเล่น Reels & วิดีโอแนวตั้ง:**
  - บันทึกลิงก์ IG ทั้งแบบ `/reel/<code>/` และ `/reels/<code>/` → ดึงภาพปกและแคปชั่นได้ทั้งคู่ (ไม่ขึ้น `"ไม่สามารถแสดงตัวอย่างได้"` จากแค่การมีตัว `s`)
  - กด Play คลิป IG Reels ที่มี `.mp4` (เช่น `DYowlO2v1ww`, `DeY8F4bSTWx`) → เล่นด้วย `<video controls loop>` ในกรอบแนวตั้งและวนซ้ำได้เรื่อยๆ โดยไม่เด้งหน้า `"รับชมอีกครั้งบน Instagram"`
  - กด Play คลิปที่ไม่มี `.mp4` (เช่น `DfzqfsjyQkb`) หรือ Facebook Reels → Fallback กลับไปใช้ `<iframe>` ได้ปกติและคงสัดส่วนแนวตั้ง/แนวนอนถูกต้อง
  - *(หมายเหตุ: รายการเก่าที่บันทึกไว้ก่อนแก้ไขบางรายการ เช่น อัลบั้ม IG ที่เคยได้ 1 รูป หรือ `/reels/` ที่เคยค้าง `private_or_restricted` ให้กดรีเฟรชพรีวิวหรือบันทึกซ้ำเพื่ออัปเดตข้อมูลในฐานข้อมูล)*
