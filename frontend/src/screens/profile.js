/**
 * Profile, Settings, Appearance Themes & Account Flows:
 * - 19 Profile · โปรไฟล์ (124:360)
 * - 20 Profile · การแสดงผล (128:360 — normal/large text + 3 live themes + preview)
 * - 21 Profile · บัญชีและความปลอดภัย (128:407)
 * - 22 Profile · ศูนย์ช่วยเหลือและแจ้งปัญหา (128:429)
 * - Sheet · แก้ไขชื่อเล่น (128:451) + Sheet · ส่งออกข้อมูล CSV (128:465) + Dialog · ออกจากระบบ (124:433)
 */
import { icons, escHtml } from "../components/icons.js";
import { THEME_OPTIONS } from "../data/seed.js";
import { getAuthMode } from "../services/routeGuard.js";
import { getWebPushPermission } from "../services/pushClient.js";
import { isQaModeEnabled } from "../state/store.js";
import { renderBottomNav } from "./common.js";

export function renderProfileBody(state) {
  const { user } = state.data;
  const displayName = user.displayName || user.email?.split("@")[0] || "ผู้ใช้งาน";
  const initial = displayName.trim().charAt(0).toUpperCase() || "U";
  const isWeb = state.ui.viewportMode === "web";
  const pushPerm = getWebPushPermission();
  const pushHint =
    pushPerm === "denied"
      ? "เบราว์เซอร์บล็อกสิทธิ์แจ้งเตือน (โปรดเปิดในการตั้งค่าเว็บไซต์)"
      : user.notificationsEnabled && pushPerm === "granted"
        ? "เปิดรับแจ้งเตือน Web Push บนเบราว์เซอร์แล้ว"
        : "รับการแจ้งเตือนลิงก์ที่ตั้งเวลาไว้ผ่านเบราว์เซอร์";

  return `
        <div class="settings-card">
          <button type="button" class="settings-row" data-open-edit-nickname="1" style="padding:16px;">
            <div class="inline-flex-row" style="gap:14px;">
              <div class="profile-avatar-lg">${escHtml(initial)}</div>
              <div>
                <div style="font-size:20px;font-weight:700;color:var(--ink-primary);">${escHtml(displayName)}</div>
                <div style="font-size:13.5px;color:var(--ink-secondary);">${escHtml(user.email)}</div>
              </div>
            </div>
            ${icons.chevronRight(17)}
          </button>
        </div>

        <div>
          <h2 class="section-title" style="margin-bottom:8px;">การตั้งค่า</h2>
          <div class="settings-card">
            <div class="settings-row">
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.bell(20)}</span>
                <div>
                  <div style="font-size:15px;font-weight:700;">การแจ้งเตือน</div>
                  <div class="tiny-hint">${pushPerm === "denied" ? escHtml(pushHint) : "รับการแจ้งเตือนเมื่อถึงเวลาที่ตั้งไว้"}</div>
                </div>
              </div>
              <button type="button" class="toggle-switch ${user.notificationsEnabled ? "on" : ""}" data-toggle-notif-setting="1" aria-label="เปิดปิดแจ้งเตือน">
                <span class="toggle-knob"></span>
              </button>
            </div>

            <button type="button" class="settings-row" ${isWeb ? `data-pc-section="ai"` : `data-nav="ai"`}>
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.bot(20)}</span>
                <div>
                  <div style="font-size:15px;font-weight:700;">การเชื่อมต่อ AI</div>
                  <div class="tiny-hint">จัดการผู้ให้บริการ โมเดล และ API Key</div>
                </div>
              </div>
              ${icons.chevronRight(17)}
            </button>

            <button type="button" class="settings-row" ${isWeb ? `data-pc-section="display"` : `data-go-screen="display"`}>
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.palette(20)}</span>
                <div>
                  <div style="font-size:15px;font-weight:700;">การแสดงผล</div>
                  <div class="tiny-hint">เลือกธีมสี</div>
                </div>
              </div>
              ${icons.chevronRight(17)}
            </button>

            <button type="button" class="settings-row" ${isWeb ? `data-pc-section="security"` : `data-go-screen="security"`}>
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.shield(20)}</span>
                <div>
                  <div style="font-size:15px;font-weight:700;">บัญชีและความปลอดภัย</div>
                  <div class="tiny-hint">รหัสผ่านและการจัดการบัญชี</div>
                </div>
              </div>
              ${icons.chevronRight(17)}
            </button>
          </div>
        </div>

        <div>
          <h2 class="section-title" style="margin-bottom:8px;">${isWeb ? "ข้อมูลและความช่วยเหลือ" : "อื่น ๆ"}</h2>
          <div class="settings-card">
            <button type="button" class="settings-row" ${isWeb ? `data-pc-section="help"` : `data-go-screen="help"`}>
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.help(20)}</span>
                <div style="font-size:15px;font-weight:700;">ศูนย์ช่วยเหลือและแจ้งปัญหา</div>
              </div>
              ${icons.chevronRight(17)}
            </button>

            <button type="button" class="settings-row" data-open-export-csv="1">
              <div class="inline-flex-row" style="gap:12px;">
                <span style="color:var(--ink-secondary);display:inline-flex;">${icons.download(20)}</span>
                <div>
                  <div style="font-size:15px;font-weight:700;">ส่งออกข้อมูลที่บันทึกไว้</div>
                  <div class="tiny-hint">รายการลิงก์ทั้งหมดเป็นไฟล์ CSV</div>
                </div>
              </div>
              ${icons.chevronRight(17)}
            </button>
          </div>
        </div>

        <button type="button" class="btn-logout" data-open-logout-dialog="1">
          ${icons.signout(18)}
          <span>ออกจากระบบ</span>
        </button>
  `;
}

export function renderProfileScreen(state) {
  return `
    <div class="screen-scroll with-nav-pad">
      <div class="home-topbar">
        <h1 class="brand-heading">โปรไฟล์</h1>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:16px;padding-top:4px;">
        ${renderProfileBody(state)}
      </div>

      ${renderBottomNav("profile")}
    </div>
  `;
}

export function renderDisplayBody(state) {
  const { theme } = state.data.appearance;
  const activeThemeMeta = THEME_OPTIONS.find((t) => t.id === theme) || THEME_OPTIONS[0];
  const doneAttr = state.ui.viewportMode === "web" ? `data-pc-section="profile"` : `data-nav="profile"`;

  return `
        <div style="display:flex;flex-direction:column;gap:10px;">
          <h2 class="section-title" style="margin-bottom:2px;">ธีมสี</h2>
          ${THEME_OPTIONS.map(
            (opt) => `
            <button type="button" class="theme-option-card ${theme === opt.id ? "active" : ""}" data-set-theme="${opt.id}">
              <div class="theme-swatch-badge" style="background:${opt.softBg};">
                <span class="theme-swatch-dot" style="background:${opt.swatch};"></span>
              </div>
              <div>
                <div style="font-size:15px;font-weight:700;color:var(--ink-primary);">${escHtml(opt.name)}</div>
                <div class="tiny-hint">${escHtml(opt.subtitle)}</div>
              </div>
            </button>`
          ).join("")}
        </div>

        <div class="theme-preview-box">
          <div style="font-size:14.5px;font-weight:700;color:var(--ink-primary);">ตัวอย่างการแสดงผล</div>
          <div style="font-size:13px;color:var(--ink-secondary);margin-top:4px;">${escHtml(activeThemeMeta.name)}</div>
          <div style="font-size:14px;font-weight:700;color:var(--theme-swatch);margin-top:8px;">กลับมาดูลิงก์ที่บันทึกไว้</div>
        </div>

        <button type="button" class="btn-accent-pill full48" ${doneAttr}>เสร็จแล้ว</button>
  `;
}

export function renderDisplayScreen(state) {
  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button type="button" class="icon-btn" data-nav="profile">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:21px;font-weight:700;">การแสดงผล</h1>
        </div>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:18px;">
        ${renderDisplayBody(state)}
      </div>
    </div>
  `;
}

export function renderSecurityBody(state) {
  const authMode = getAuthMode(state);
  const claims = state.api.jwtClaims;
  return `
        ${
          isQaModeEnabled()
            ? `<div style="background:var(--bg-muted);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:4px;">
                 <strong style="font-size:13.5px;">สถานะเซสชัน (${escHtml(authMode.toUpperCase())})</strong>
                 <span class="tiny-hint">User ID (sub): ${escHtml(claims?.sub || state.data.user.id || "-")}</span>
                 <span class="tiny-hint">JWT Alg: ${escHtml(claims?.alg || (state.api.bearerToken ? "JWT" : "none"))}</span>
               </div>`
            : `<div style="background:var(--bg-muted);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:4px;">
                 <strong style="font-size:13.5px;">สถานะความปลอดภัย</strong>
                 <span class="tiny-hint">${state.data.user?.isAuthenticated ? "เข้าสู่ระบบและเชื่อมต่ออย่างปลอดภัยแล้ว" : "ยังไม่ได้เข้าสู่ระบบ"}</span>
               </div>`
        }

        <div>
          <strong style="font-size:15px;">อีเมลบัญชี</strong>
          <p style="margin:6px 0 10px;font-size:14px;color:var(--ink-secondary);">${escHtml(state.data.user.email)}</p>
          <div class="field-group">
            <label class="field-label">อีเมลใหม่</label>
            <input class="field-input" type="email" placeholder="name@example.com" id="newEmailInput" />
          </div>
          <button type="button" class="btn-outline-pill" style="width:100%;margin-top:10px;" data-update-account-email="1">
            บันทึกอีเมลใหม่
          </button>
        </div>

        <hr style="border:none;border-top:1px solid var(--border-divider);width:100%;" />

        <div style="display:flex;flex-direction:column;gap:10px;">
          <strong style="font-size:15px;">รหัสผ่าน</strong>
          <p class="tiny-hint" style="margin:0;">รับลิงก์ทางอีเมลเพื่อตั้งหรือเปลี่ยนรหัสผ่าน</p>
          <button type="button" class="btn-accent-pill full48" data-send-password-reset="1">
            ส่งลิงก์ตั้งรหัสผ่าน
          </button>
        </div>

        <hr style="border:none;border-top:1px solid var(--border-divider);width:100%;" />

        <div style="display:flex;flex-direction:column;gap:8px;">
          <strong style="font-size:15px;">เชื่อมต่อ Chrome Extension</strong>
          <p class="tiny-hint" style="margin:0;">ส่ง Session ปัจจุบันให้ Extension อัตโนมัติ หรือคัดลอก Token ไปวาง (รองรับ Google OAuth) — ห้ามส่งต่อ Token นี้ให้ผู้อื่น</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button type="button" class="btn-accent-pill" data-action="connect-extension">
              เชื่อมต่ออัตโนมัติ
            </button>
            <button type="button" class="btn-outline-pill" data-copy-extension-token="1">
              คัดลอก Token
            </button>
          </div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border-divider);width:100%;" />

        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <strong style="font-size:15px;">MCP API Tokens</strong>
            <button type="button" class="chip-pill" data-action="refresh-mcp-tokens">รีเฟรช</button>
          </div>
          <p class="tiny-hint" style="margin:0;">สร้าง Token สำหรับเชื่อมต่อ Claude Desktop, Cursor หรือ AI Agent ผ่าน <code>/mcp</code></p>
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="field-input" type="text" placeholder="ชื่อ Client เช่น Claude Desktop" id="mcpTokenNameInput" style="flex:1;" />
            <button type="button" class="btn-outline-pill" data-action="create-mcp-token">สร้าง Token</button>
          </div>
          ${
            state.ui.latestMcpRawToken
              ? `<div style="background:var(--bg-muted);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;">
                   <span class="tiny-hint" style="font-weight:700;color:var(--theme-accent-text);">Token ใหม่ (แสดงครั้งเดียว กรุณาคัดลอกเก็บไว้):</span>
                   <code style="font-size:12px;word-break:break-all;background:var(--bg-surface);padding:6px 8px;border-radius:8px;border:1px solid var(--border-light);">${escHtml(state.ui.latestMcpRawToken)}</code>
                   <button type="button" class="btn-outline-pill" style="width:100%;" data-action="copy-mcp-raw-token">คัดลอก MCP Token</button>
                 </div>`
              : ""
          }
          <div class="settings-card">
            ${
              (state.ui.mcpTokens || []).length === 0
                ? `<div class="settings-row"><span class="tiny-hint">ยังไม่มี MCP Token ที่ใช้งานอยู่</span></div>`
                : (state.ui.mcpTokens || [])
                    .map(
                      (tok) => `
                <div class="settings-row">
                  <div class="settings-row-left" style="flex-direction:column;align-items:flex-start;gap:2px;">
                    <span class="settings-row-label" style="font-size:13.5px;font-weight:600;">${escHtml(tok.name || "MCP Client")}</span>
                    <span class="tiny-hint">${escHtml(tok.token_prefix || "jsi_live_...")}</span>
                  </div>
                  <button type="button" class="chip-pill" style="color:var(--theme-accent-text);border-color:var(--theme-accent);" data-revoke-mcp-token="${escHtml(tok.id)}">เพิกถอน</button>
                </div>`
                    )
                    .join("")
            }
          </div>
        </div>

        <hr style="border:none;border-top:1px solid var(--border-divider);width:100%;" />

        <div class="settings-card">
          <button type="button" class="settings-row" data-action="open-pdpa-policy">
            <span>นโยบายความเป็นส่วนตัว (PDPA)</span>
            ${icons.chevronRight(16)}
          </button>
          <button type="button" class="settings-row" style="color:var(--theme-accent-text);font-weight:700;" data-action="open-delete-account">
            <span>ลบบัญชีผู้ใช้และข้อมูลทั้งหมด</span>
            ${icons.close(16)}
          </button>
        </div>
  `;
}

export function renderSecurityScreen(state) {
  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button type="button" class="icon-btn" data-nav="profile">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:21px;font-weight:700;">บัญชีและความปลอดภัย</h1>
        </div>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:16px;">
        ${renderSecurityBody(state)}
      </div>
    </div>
  `;
}

export function renderHelpBody() {
  return `
        <div style="background:var(--bg-muted);border-radius:14px;padding:14px;">
          <strong style="font-size:14.5px;display:block;margin-bottom:4px;">เปิดโพสต์ต้นฉบับไม่ได้ทำอย่างไร?</strong>
          <p class="tiny-hint" style="margin:0;line-height:1.55;">
            ลองเปิดจากลิงก์ต้นฉบับอีกครั้ง<br />
            หากโพสต์ถูกลบหรือเปลี่ยนเป็นส่วนตัว อาจเปิดดูไม่ได้
          </p>
        </div>

        <h2 class="section-title">แจ้งปัญหา</h2>

        <div class="field-group">
          <label class="field-label">หัวข้อ</label>
          <input class="field-input" type="text" placeholder="สรุปปัญหาสั้น ๆ" id="supportTopicInput" />
        </div>

        <div class="field-group">
          <label class="field-label">รายละเอียด</label>
          <textarea class="note-textarea" placeholder="เล่าว่าเกิดอะไรขึ้น และเกิดในหน้าไหน" id="supportDetailInput"></textarea>
        </div>

        <button type="button" class="btn-accent-pill full48" data-submit-support="1">ส่งรายงาน</button>

        <div class="settings-card">
          <button type="button" class="settings-row" data-action="open-pdpa-policy">
            <span>นโยบายความเป็นส่วนตัวและ PDPA</span>
            ${icons.chevronRight(16)}
          </button>
        </div>
  `;
}

export function renderHelpScreen() {
  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button type="button" class="icon-btn" data-nav="profile">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:21px;font-weight:700;">ศูนย์ช่วยเหลือและแจ้งปัญหา</h1>
        </div>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:16px;">
        ${renderHelpBody()}
      </div>
    </div>
  `;
}

export function renderProfileSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // Sheet · แก้ชื่อเล่น (128:451)
  if (sheet.type === "editNickname") {
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet">
          <h3 style="margin:0;font-size:20px;">แก้ไขชื่อเล่น</h3>
          <div class="field-group">
            <label class="field-label">ชื่อเล่น</label>
            <input class="field-input" type="text" value="${escHtml(sheet.value)}" data-bind-nickname="1" />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-save-nickname="1">บันทึก</button>
          </div>
        </div>
      </div>
    `;
  }

  // Sheet · ส่งออกข้อมูล CSV (128:465)
  if (sheet.type === "exportCsv") {
    const selectedFolderId = state.ui.csvExportFolderId || "all";
    const unreadOnly = Boolean(state.ui.csvExportUnreadOnly);
    const matchingLinks = (state.data.links || []).filter((l) => {
      if (selectedFolderId !== "all" && l.folderId !== selectedFolderId) return false;
      if (unreadOnly && l.status === "read") return false;
      return true;
    });

    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet">
          <h3 style="margin:0;font-size:20px;">ส่งออกข้อมูลที่บันทึกไว้</h3>
          <div class="field-group">
            <label class="field-label">เลือกโฟลเดอร์</label>
            <select class="field-input" data-csv-folder="1">
              <option value="all" ${selectedFolderId === "all" ? "selected" : ""}>ทุกโฟลเดอร์</option>
              ${(state.data.folders || [])
                .map(
                  (f) => `<option value="${escHtml(f.id)}" ${selectedFolderId === f.id ? "selected" : ""}>${escHtml(f.name)}</option>`
                )
                .join("")}
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--ink-primary);cursor:pointer;">
            <input type="checkbox" data-csv-unread-only="1" ${unreadOnly ? "checked" : ""} />
            <span>เฉพาะรายการที่ยังไม่ได้ดู</span>
          </label>
          <div>
            <strong style="font-size:15px;">จำนวนที่จะส่งออก (${matchingLinks.length} รายการ)</strong>
            <p class="tiny-hint" style="margin:4px 0 0;">ไฟล์ CSV รวมชื่อโพสต์ URL โฟลเดอร์ แท็ก และโน้ต · หรือดาวน์โหลด JSON ครบทุกข้อมูลตามสิทธิ์ PDPA</p>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-download-csv="1">ส่งออก CSV</button>
          </div>
          <button type="button" class="btn-outline-pill" style="width:100%;" data-download-json="1">ส่งออกเป็น JSON (ข้อมูลครบถ้วน)</button>
        </div>
      </div>
    `;
  }

  if (sheet.type === "pdpaPolicy") {
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" style="max-height:82vh;overflow-y:auto;">
          <h3 style="margin:0;font-size:20px;">นโยบายความเป็นส่วนตัว (PDPA)</h3>
          <p class="tiny-hint" style="margin:6px 0 0;line-height:1.6;">
            Sharely / Just Save It เก็บเฉพาะลิงก์ โน้ต แท็ก การตั้งเตือน และข้อมูลโปรไฟล์ที่คุณบันทึกไว้เท่านั้น โดยแยกสิทธิ์การเข้าถึงตาม User ID ผ่าน Row-Level Security (RLS)
          </p>
          <ul style="margin:8px 0;padding-left:18px;font-size:13px;color:var(--ink-secondary);line-height:1.6;">
            <li>BYOK AI Keys ถูกใช้ส่งต่อจากเบราว์เซอร์เพื่อสรุปเนื้อหาตามคำขอของคุณโดยตรง</li>
            <li>คุณสามารถส่งออกข้อมูลทั้งหมดเป็น CSV หรือ JSON ได้ตลอดเวลาจากเมนูส่งออกข้อมูล</li>
            <li>คุณสามารถลบบัญชีและข้อมูลทั้งหมดอย่างถาวรได้ในหน้าบัญชีและความปลอดภัย</li>
          </ul>
          <button type="button" class="btn-accent-pill full48" data-close-sheet="1">รับทราบ</button>
        </div>
      </div>
    `;
  }

  if (sheet.type === "deleteAccount") {
    return `
      <div class="modal-backdrop center" data-close-sheet="1">
        <div class="center-dialog">
          <h3 style="margin:0;font-size:20px;color:var(--theme-accent-text);">ลบบัญชีผู้ใช้ถาวร?</h3>
          <p style="margin:0;font-size:13.5px;color:var(--ink-secondary);line-height:1.5;">
            ข้อมูลลิงก์ โฟลเดอร์ แท็ก การเตือน และ MCP Token ทั้งหมดของคุณจะถูกลบถาวรและกู้คืนไม่ได้ พิมพ์ <strong>DELETE</strong> เพื่อยืนยัน
          </p>
          <input class="field-input" type="text" placeholder="พิมพ์ DELETE" id="deleteAccountConfirmInput" autocomplete="off" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
            <button type="button" class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button type="button" class="btn-accent-pill lg" data-action="confirm-delete-account">ยืนยันลบบัญชี</button>
          </div>
        </div>
      </div>
    `;
  }

  // Dialog · ออกจากระบบ (124:433)
  if (sheet.type === "logoutDialog") {
    return `
      <div class="modal-backdrop center" data-close-sheet="1">
        <div class="center-dialog">
          <h3 style="margin:0;font-size:20px;">ออกจากระบบใช่ไหม?</h3>
          <p style="margin:0;font-size:13.5px;color:var(--ink-secondary);">
            คุณสามารถเข้าสู่ระบบใหม่ด้วย ${escHtml(state.data.user.email)} ได้ทุกเมื่อ
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-confirm-logout="1">ออกจากระบบ</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
