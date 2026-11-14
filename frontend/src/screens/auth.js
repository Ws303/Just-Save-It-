/**
 * Authentication & Folder Invitation Landing Screens:
 * - 10 Login · Cherry reference (62:178)
 * - 9 / 23.2 Email login (24:190, 154:450)
 * - 23.3 Check email magic link simulator (154:467)
 * - 23 Folder invitation landing (154:360)
 */
import { icons, escHtml, safeImgUrl } from "../components/icons.js";
import { getAuthMode } from "../services/routeGuard.js";
import { getFolderById, getFolderCount } from "../state/store.js";

function renderAuthBanner(state) {
  const { authError, postAuthRedirect } = state.ui;
  const authMode = getAuthMode(state);
  const modeLabel =
    authMode === "supabase"
      ? "Supabase Cloud Auth"
      : authMode === "backend"
        ? "FastAPI Backend Auth"
        : "Mock Simulator";

  const redirectNote = postAuthRedirect?.screen
    ? `<div style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;">
        🔒 หน้า "${escHtml(postAuthRedirect.screen)}" เป็น Protected Route — เข้าสู่ระบบเพื่อดำเนินการต่อ
      </div>`
    : "";

  const errNote = authError
    ? `<div style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;">
        ⚠️ ${escHtml(authError)}
      </div>`
    : "";

  const modeBadge = `<div style="font-size:11.5px;color:var(--ink-secondary);display:flex;align-items:center;gap:6px;">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${authMode === "supabase" ? "#10b981" : authMode === "backend" ? "#3b82f6" : "#f59e0b"};"></span>
    <span>Auth Provider: <strong>${escHtml(modeLabel)}</strong></span>
  </div>`;

  return `${modeBadge}${redirectNote}${errNote}`;
}

export function renderLoginScreen(state) {
  const isInviteAuth = state.ui.authContext === "invite";
  const authMode = state.ui.authMode || "login"; // "login" | "signup" | "forgot"
  const fallbackEmail = state.api.useDevBypass ? state.data.user.email || "" : "";
  const emailVal = state.ui.authEmail || (authMode === "signup" ? "" : fallbackEmail);
  const nameVal = state.ui.authDisplayName || "";
  const showPw = Boolean(state.ui.showPassword);

  if (authMode === "forgot") {
    return `
      <div class="screen-scroll figma-auth-page">
        <div class="figma-auth-topbar">
          <button class="figma-back-btn" data-action="set-auth-mode" data-mode="login">
            ${icons.back(18)}
            <span>ย้อนกลับ</span>
          </button>
          <span class="figma-auth-top-title">ลืมรหัสผ่าน</span>
          <span style="width:68px;"></span>
        </div>

        <div class="figma-auth-body">
          <div class="figma-auth-hero compact">
            <div class="figma-brand-badge">${icons.bookmarkSolid(20)}</div>
            <h1 class="figma-auth-title">ลืมรหัสผ่านใช่ไหม?</h1>
            <p class="figma-auth-sub">กรอกอีเมลที่ใช้สมัคร แล้วเราจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ให้</p>
          </div>

          ${renderAuthBanner(state)}

          <div class="figma-field">
            <label class="figma-label" for="forgotEmailInput">อีเมล</label>
            <input
              id="forgotEmailInput"
              class="figma-input"
              type="email"
              value="${escHtml(emailVal)}"
              placeholder="name@email.com"
              data-bind-email-login="1"
            />
          </div>

          <div class="figma-info-box">
            <strong>หมายเหตุ:</strong> ระบบจะส่งลิงก์รีเซ็ตรหัสผ่านไปยังอีเมลของคุณ ลิงก์มีอายุใช้งาน 15 นาที
          </div>

          <button class="figma-primary-btn" data-action="send-reset-link">
            ส่งลิงก์รีเซ็ตรหัสผ่าน
          </button>

          <button class="figma-text-link center" data-action="set-auth-mode" data-mode="login">
            กลับไปหน้าเข้าสู่ระบบ
          </button>
        </div>
      </div>
    `;
  }

  const isSignup = authMode === "signup";
  return `
    <div class="screen-scroll figma-auth-page">
      <div class="figma-auth-body">
        <div class="figma-auth-hero">
          <div class="figma-brand-badge">${icons.bookmarkSolid(22)}</div>
          <h1 class="figma-brand-name">Sharely</h1>
          <p class="figma-brand-tagline">เซฟไว้ก่อน ค่อยกลับมาดู</p>

          <div class="figma-auth-tabs" role="tablist">
            <button class="figma-auth-tab ${!isSignup ? "active" : ""}" data-action="set-auth-mode" data-mode="login">
              เข้าสู่ระบบ
            </button>
            <button class="figma-auth-tab ${isSignup ? "active" : ""}" data-action="set-auth-mode" data-mode="signup">
              สมัครใช้งาน
            </button>
          </div>
        </div>

        ${renderAuthBanner(state)}

        ${
          isSignup
            ? `<div class="figma-field">
                <label class="figma-label" for="displayNameSignupInput">ชื่อที่แสดง</label>
                <input
                  id="displayNameSignupInput"
                  class="figma-input"
                  type="text"
                  value="${escHtml(nameVal)}"
                  placeholder="เช่น Fah"
                  data-bind-displayname-signup="1"
                />
              </div>`
            : ""
        }

        <div class="figma-field">
          <label class="figma-label" for="emailLoginInput">อีเมล</label>
          <input
            id="emailLoginInput"
            class="figma-input"
            type="email"
            value="${escHtml(emailVal)}"
            placeholder="name@email.com"
            data-bind-email-login="1"
          />
        </div>

        <div class="figma-field">
          <div class="figma-label-row">
            <label class="figma-label" for="passwordLoginInput">
              ${isSignup ? "รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)" : "รหัสผ่าน"}
            </label>
            ${
              !isSignup
                ? `<button class="figma-inline-link" data-action="set-auth-mode" data-mode="forgot">ลืมรหัสผ่าน?</button>`
                : ""
            }
          </div>
          <div class="figma-password-wrap">
            <input
              id="passwordLoginInput"
              class="figma-input"
              type="${showPw ? "text" : "password"}"
              value="${escHtml(state.ui.authPassword || "")}"
              placeholder="••••••••"
              data-bind-password-login="1"
            />
            <button class="figma-pw-toggle" type="button" data-action="toggle-show-password">
              ${showPw ? "ซ่อน" : "แสดง"}
            </button>
          </div>
        </div>

        ${
          isSignup
            ? `<div class="figma-field">
                <label class="figma-label" for="passwordConfirmInput">ยืนยันรหัสผ่าน</label>
                <input
                  id="passwordConfirmInput"
                  class="figma-input"
                  type="${showPw ? "text" : "password"}"
                  value="${escHtml(state.ui.authPasswordConfirm || "")}"
                  placeholder="กรอกรหัสผ่านอีกครั้ง"
                  data-bind-password-confirm="1"
                />
              </div>
              <p class="figma-terms-note">
                เมื่อสร้างบัญชี ถือว่าคุณยอมรับ <span>ข้อกำหนดการใช้งาน</span> และ <span>นโยบายความเป็นส่วนตัว</span>
              </p>
              <button class="figma-primary-btn" data-submit-signup="1">
                สร้างบัญชีด้วยอีเมล
              </button>`
            : `<button class="figma-primary-btn" data-submit-password-login="1">
                เข้าสู่ระบบด้วยอีเมล
              </button>`
        }

        <div class="figma-divider"><span>หรือเข้าใช้งานต่อด้วย</span></div>

        <button class="figma-oauth-btn google" data-oauth-google="${isInviteAuth ? "invite" : "app"}">
          <img src="./assets/icons/google-logo.svg" alt="" style="width:20px;height:20px;" />
          <span>${isSignup ? "สมัครด้วย Google" : "ดำเนินการต่อด้วย Google"}</span>
        </button>

        <button class="figma-oauth-btn apple" data-oauth-google="${isInviteAuth ? "invite" : "app"}">
          <span style="font-size:17px;line-height:1;"></span>
          <span>${isSignup ? "สมัครด้วย Apple" : "ดำเนินการต่อด้วย Apple"}</span>
        </button>

        <div class="figma-auth-footer">
          <span>${isSignup ? "มีบัญชีอยู่แล้ว?" : "ยังไม่มีบัญชี?"}</span>
          <button class="figma-inline-link" data-action="set-auth-mode" data-mode="${isSignup ? "login" : "signup"}">
            ${isSignup ? "เข้าสู่ระบบ" : "สมัครใช้งาน"}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderEmailLoginScreen(state) {
  return renderLoginScreen(state);
}

export function renderCheckEmailScreen(state) {
  const isInvite = state.ui.authContext === "invite";
  const authMode = getAuthMode(state);
  const targetEmail = state.ui.authEmail || state.data.user.email || "name@email.com";
  return `
    <div class="screen-scroll figma-auth-page">
      <div class="figma-auth-topbar">
        <button class="figma-back-btn" data-go-screen="login">
          ${icons.back(18)}
          <span>ย้อนกลับ</span>
        </button>
        <span class="figma-auth-top-title">ยืนยันอีเมล</span>
        <span style="width:68px;"></span>
      </div>

      <div class="figma-auth-body">
        <div class="figma-verify-hero">
          <div class="figma-verify-icon">${icons.mail(26)}</div>
          <h2 class="figma-auth-title">เช็กอีเมลของคุณ</h2>
          <p class="figma-auth-sub">
            เราส่งลิงก์ยืนยันตัวตนไปที่ <strong>${escHtml(targetEmail)}</strong><br />
            กดลิงก์ในอีเมลเพื่อเปิดใช้งานบัญชี
          </p>
        </div>

        <div class="figma-steps-card">
          <div class="figma-step-row"><span>1</span><p>เปิดแอปอีเมลในเครื่องของคุณ</p></div>
          <div class="figma-step-row"><span>2</span><p>กดปุ่ม "ยืนยันอีเมลของฉัน"</p></div>
          <div class="figma-step-row"><span>3</span><p>กลับมาที่แอป Sharely เพื่อเข้าใช้งาน</p></div>
        </div>

        ${
          authMode === "supabase"
            ? `<button class="figma-primary-btn" data-check-supabase-session="1">
                ยืนยันแล้ว เข้าใช้งานเลย
              </button>`
            : `<button class="figma-primary-btn" data-simulate-magic-link="${isInvite ? "invite" : "app"}">
                ยืนยันแล้ว เข้าใช้งานเลย
              </button>`
        }

        <button class="figma-oauth-btn google" data-submit-email-login="1">
          <span>ส่งอีเมลอีกครั้ง</span>
        </button>
      </div>
    </div>
  `;
}

export function renderInviteLandingScreen(state) {
  const folder = getFolderById(state.ui.inviteFolderId || state.ui.activeFolderId) || state.data.folders[0];
  const count = getFolderCount(folder);
  const isLoggedIn = state.data.user.isAuthenticated;

  return `
    <div class="screen-scroll">
      <div class="app-pad" style="display:flex;flex-direction:column;gap:18px;min-height:844px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="brand-heading" style="font-size:25px;">Sharely</span>
          <span class="tb-pill-badge" style="border:none;">
            ${icons.folder(14)} คำเชิญ
          </span>
        </div>

        <div>
          <h2 style="margin:0 0 5px;font-size:24px;">คำเชิญเข้าโฟลเดอร์</h2>
          <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
            ${escHtml(state.data.user.displayName)}ชวนคุณเข้าร่วมโฟลเดอร์${escHtml(folder.name)}
          </p>
        </div>

        <div class="settings-card" style="border-color:var(--border-divider);">
          <div style="height:148px;overflow:hidden;background:var(--bg-thumb);">
            <img src="${escHtml(safeImgUrl(folder.cover))}" alt="" style="width:100%;height:100%;object-fit:cover;" />
          </div>
          <div style="padding:13px;">
            <h3 style="margin:0 0 6px;font-size:20px;">${escHtml(folder.name)}</h3>
            <p style="margin:0;font-size:13px;color:var(--ink-secondary);display:flex;align-items:center;gap:7px;">
              ${icons.people(17)}
              <span>${count} ลิงก์ · แชร์กับ ${Math.max(folder.sharedCount, 2)} คน</span>
            </p>
          </div>
        </div>

        <div style="background:var(--bg-muted);border-radius:13px;padding:13px;display:flex;flex-direction:column;gap:8px;">
          <strong style="font-size:15px;">เมื่อเข้าร่วม คุณจะทำอะไรได้บ้าง</strong>
          <div class="inline-flex-row" style="font-size:13px;">
            <span style="color:var(--theme-accent-text);display:inline-flex;">${icons.check(17)}</span>
            <span>เปิดดูโพสต์ที่เก็บไว้ในโฟลเดอร์</span>
          </div>
          <div class="inline-flex-row" style="font-size:13px;">
            <span style="color:var(--theme-accent-text);display:inline-flex;">${icons.check(17)}</span>
            <span>เพิ่มลิงก์ให้เพื่อนในโฟลเดอร์ดูได้</span>
          </div>
        </div>

        <div style="margin-top:auto;display:flex;flex-direction:column;gap:8px;">
          <button class="btn-accent-pill full48" data-accept-invite="${escHtml(folder.id)}">
            เข้าร่วมโฟลเดอร์
          </button>
          <button class="link-more-btn" style="text-decoration:none;color:var(--ink-secondary);font-weight:400;" data-go-screen="login" data-auth-ctx="invite">
            ${isLoggedIn ? "สลับบัญชีก่อนเข้าร่วมโฟลเดอร์" : "เข้าสู่ระบบเพื่อเข้าร่วมโฟลเดอร์นี้"}
          </button>
        </div>
      </div>
    </div>
  `;
}
