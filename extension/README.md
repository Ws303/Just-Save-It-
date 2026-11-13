# Just-Save-It Browser Extension (Chrome / Edge / Arc / Brave)

ส่วนขยายเบราว์เซอร์ Manifest V3 (ไม่ต้อง Build) สำหรับดึง URL แท็บปัจจุบัน พร้อมรูปปก โฟลเดอร์ แท็ก เตือนอ่าน และสรุป AI เพื่อยิงตรงเข้า FastAPI Backend

## วิธีติดตั้งและทดสอบกับ Backend

1. เปิด Backend ในเครื่อง:
   ```bash
   cd backend
   ../.venv/bin/uvicorn main:app --reload
   ```
   (ตรวจสอบได้ที่ `http://localhost:8000/docs` และ `http://localhost:8000/health`)

2. โหลด Extension ใน Chrome / Arc / Brave / Edge:
   - เปิด `chrome://extensions`
   - เปิดสวิตช์ **Developer mode** (มุมขวาบน)
   - กด **Load unpacked** แล้วเลือกโฟลเดอร์ `extension/` ของโปรเจกต์นี้

3. ทดสอบใช้งาน:
   - กดไอคอน **Just-Save-It** ที่แถบส่วนขยาย -> กดปุ่ม **"ใช้บัญชีทดสอบ May (may@example.com)"** (หรือสมัครสมาชิกใหม่)
   - เปิดหน้าเว็บใดก็ได้ แล้วกดไอคอนส่วนขยายอีกครั้ง -> URL, Title, ภาพปก และข้อความที่ไฮไลต์จะถูกดึงมาให้อัตโนมัติ
   - กด **บันทึกลิงก์ลง Backend** แล้วลองดูใน **"รายการที่บันทึกล่าสุด"** หรือเช็กผ่าน `GET /api/items` บน Swagger UI (`http://localhost:8000/docs`)
   - **ทางลัดเพิ่มเติม**:
     - คลิกขวาบนหน้าเว็บหรือบนลิงก์ใดๆ -> เลือก **บันทึกหน้านี้ลง Just-Save-It**
     - กดคีย์ลัด `Cmd + Shift + S` (Mac) หรือ `Alt + Shift + S` (Windows/Linux) เพื่อบันทึกทันทีพร้อมขึ้นป้าย `OK`
