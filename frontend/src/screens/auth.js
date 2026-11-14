/**
 * Authentication & Folder Invitation Landing Screens:
 * - 10 Login · Cherry reference (62:178)
 * - 9 / 23.2 Email login (24:190, 154:450)
 * - 23.3 Check email magic link simulator (154:467)
 * - 23 Folder invitation landing (154:360)
 */
import { icons, escHtml } from "../components/icons.js";
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
  const isSignup = state.ui.authMode === "signup";
  return `
    <div class="login-screen">
      <img class="login-red-corner" src="./assets/icons/login-red-corner.svg" alt="" />
      <img class="login-lavender-wave" src="./assets/icons/login-lavender-wave.svg" alt="" />
      <img class="login-cherries" src="./assets/icons/login-cherry-illustration.svg" alt="Sharely Cherries" />

      <div class="login-statusbar">
        <span class="login-time">9:41</span>
        <div class="login-status-icons">
          <img src="./assets/icons/statusbar-signal-wifi.svg" alt="" style="height:12px;" />
          <img src="./assets/icons/statusbar-battery.svg" alt="" style="height:12px;" />
        </div>
      </div>

      <div class="login-brand-wrap">
        <div class="login-wordmark-row">
          <h1 class="login-wordmark">Sharely</h1>
          <img class="login-wordmark-accent" src="./assets/icons/login-wordmark-accent.svg" alt="" />
        </div>
        <p class="login-tagline">Save, organize, and<br />share what you love.</p>
      </div>

      <div class="login-actions">
        ${
          state.ui.postAuthRedirect?.screen
            ? `<div style="background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:12px;padding:8px 12px;font-size:12px;font-weight:600;text-align:center;">
                🔒 เข้าสู่ระบบเพื่อเปิดหน้า "${escHtml(state.ui.postAuthRedirect.screen)}"
              </div>`
            : ""
        }
        ${
          state.ui.authError
            ? `<div style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:12px;padding:8px 12px;font-size:12px;font-weight:600;text-align:center;">
                ⚠️ ${escHtml(state.ui.authError)}
              </div>`
            : ""
        }
        <button class="btn-login-primary" data-go-screen="emailLogin">
          <img src="./assets/icons/email-white.svg" alt="" style="width:22px;height:18px;" />
          <span>${isSignup ? "สมัครด้วยอีเมล" : "เข้าสู่ระบบด้วยอีเมล"}</span>
        </button>

        <button class="btn-login-google" data-oauth-google="${isInviteAuth ? "invite" : "app"}">
          <img src="./assets/icons/google-logo.svg" alt="" style="width:22px;height:22px;" />
          <span>ดำเนินการต่อด้วย Google</span>
        </button>

        <div class="login-signup-row">
          <span>${isSignup ? "มีบัญชีอยู่แล้วใช่ไหม?" : "ยังไม่มีบัญชีใช่ไหม?"}</span>
          <button class="login-signup-link" data-toggle-auth-mode="1">
            ${isSignup ? "เข้าสู่ระบบ" : "สมัครใช้งาน"}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderEmailLoginScreen(state) {
  const isInvite = state.ui.authContext === "invite";
  const isSignup = state.ui.authMode === "signup";
  const emailVal = state.ui.authEmail || (isSignup ? "" : state.data.user.email || "");
  const nameVal = state.ui.authDisplayName || "";

  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button class="icon-btn" data-go-screen="${isInvite ? "inviteLanding" : "login"}">${icons.back(22)}</button>
          <span style="font-size:19px;font-weight:700;">${isSignup ? "สมัครใช้งาน" : "เข้าสู่ระบบ"}</span>
        </div>
      </div>
      <div class="app-pad" style="display:flex;flex-direction:column;gap:16px;padding-top:16px;">
        <div>
          <h2 style="margin:0 0 6px;font-size:24px;color:var(--ink-primary);">
            ${isSignup ? "สร้างบัญชีด้วยอีเมล" : "เข้าสู่ระบบด้วยอีเมล"}
          </h2>
          <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
            ซิงก์ลิงก์ โน้ต และโฟลเดอร์ร่วมกันข้ามอุปกรณ์
          </p>
        </div>

        ${renderAuthBanner(state)}

        ${
          isSignup
            ? `<div class="field-group">
                <label class="field-label" for="displayNameSignupInput">ชื่อที่แสดง (Display Name)</label>
                <input id="displayNameSignupInput" class="field-input" type="text" value="${escHtml(nameVal)}" placeholder="เช่น เมย์" data-bind-displayname-signup="1" />
              </div>`
            : ""
        }

        <div class="field-group">
          <label class="field-label" for="emailLoginInput">อีเมล</label>
          <input id="emailLoginInput" class="field-input" type="email" value="${escHtml(emailVal)}" placeholder="may@example.com" data-bind-email-login="1" />
          ${
            isSignup
              ? ""
              : `<span class="tiny-hint">เลือกเข้าด้วย Magic Link หรือใส่รหัสผ่าน</span>`
          }
        </div>

        <div class="field-group">
          <label class="field-label" for="passwordLoginInput">
            ${isSignup ? "รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)" : "รหัสผ่าน (กรณีเข้าสู่ระบบด้วยรหัสผ่าน)"}
          </label>
          <input id="passwordLoginInput" class="field-input" type="password" value="${escHtml(state.ui.authPassword || "")}" placeholder="••••••••" data-bind-password-login="1" />
          ${
            isSignup
              ? ""
              : `<span class="tiny-hint">บัญชีทดสอบ Mock/Dev: password123</span>`
          }
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;">
          ${
            isSignup
              ? `<button class="btn-accent-pill full48" data-submit-signup="1">
                  สมัครสมาชิกด้วยอีเมล
                </button>`
              : `<button class="btn-accent-pill full48" data-submit-password-login="1">
                  เข้าสู่ระบบด้วยรหัสผ่าน
                </button>
                <button class="btn-outline-pill full48" data-submit-email-login="1" style="background:#fff;">
                  ขอรับ Magic Link ทางอีเมล
                </button>`
          }
          <button class="link-more-btn" style="text-decoration:none;color:var(--ink-secondary);margin-top:4px;" data-toggle-auth-mode="1">
            ${isSignup ? "มีบัญชีอยู่แล้ว? กลับไปเข้าสู่ระบบ" : "ยังไม่มีบัญชี? สมัครใช้งานใหม่"}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderCheckEmailScreen(state) {
  const isInvite = state.ui.authContext === "invite";
  const authMode = getAuthMode(state);
  const targetEmail = state.ui.authEmail || state.data.user.email;
  return `
    <div class="screen-scroll">
      <div class="app-pad" style="display:flex;flex-direction:column;gap:16px;padding-top:20px;">
        <button class="icon-btn" data-go-screen="emailLogin">${icons.back(22)}</button>
        <div class="ai-icon-tile" style="width:52px;height:52px;border-radius:16px;">
          ${icons.mail(24)}
        </div>
        <h2 style="margin:0;font-size:24px;color:var(--ink-primary);">ตรวจเช็กอีเมลของคุณ</h2>
        <p style="margin:0;font-size:14px;color:var(--ink-secondary);line-height:1.6;">
          ส่งลิงก์ยืนยันตัวตนไปที่ <strong>${escHtml(targetEmail)}</strong> เรียบร้อยแล้ว
        </p>
        ${
          authMode === "supabase"
            ? `<button class="btn-accent-pill full48" data-check-supabase-session="1">
                ตรวจสอบสถานะการยืนยัน (Supabase Auth)
              </button>`
            : `<button class="btn-accent-pill full48" data-simulate-magic-link="${isInvite ? "invite" : "app"}">
                จำลองการเปิดลิงก์จากอีเมล
              </button>`
        }
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
            <img src="${escHtml(folder.cover)}" alt="" style="width:100%;height:100%;object-fit:cover;" />
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
          <button class="btn-accent-pill full48" data-accept-invite="${folder.id}">
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
