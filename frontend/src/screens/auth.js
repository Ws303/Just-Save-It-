/**
 * Authentication & Folder Invitation Landing Screens:
 * - 10 Login · Cherry reference (62:178)
 * - 9 / 23.2 Email login (24:190, 154:450)
 * - 23.3 Check email magic link simulator (154:467)
 * - 23 Folder invitation landing (154:360)
 */
import { icons, escHtml } from "../components/icons.js";
import { getFolderById, getFolderCount } from "../state/store.js";

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
  const emailVal = state.ui.authEmail || state.data.user.email || "";
  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button class="icon-btn" data-go-screen="${isInvite ? "inviteLanding" : "login"}">${icons.back(22)}</button>
          <span style="font-size:19px;font-weight:700;">เข้าสู่ระบบ</span>
        </div>
      </div>
      <div class="app-pad" style="display:flex;flex-direction:column;gap:20px;padding-top:20px;">
        <div>
          <h2 style="margin:0 0 6px;font-size:24px;color:var(--ink-primary);">เข้าสู่ระบบด้วยอีเมล</h2>
          <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
            ซิงก์ลิงก์ โน้ต และโฟลเดอร์ร่วมกันข้ามอุปกรณ์
          </p>
        </div>

        <div class="field-group">
          <label class="field-label" for="emailLoginInput">อีเมล</label>
          <input id="emailLoginInput" class="field-input" type="email" value="${escHtml(emailVal)}" placeholder="may@example.com" data-bind-email-login="1" />
          <span class="tiny-hint">เราจะส่ง Magic Link ให้กดยืนยันเข้าสู่ระบบ</span>
        </div>

        <button class="btn-accent-pill full48" data-submit-email-login="1">
          ส่งลิงก์เข้าสู่ระบบ
        </button>
      </div>
    </div>
  `;
}

export function renderCheckEmailScreen(state) {
  const isInvite = state.ui.authContext === "invite";
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
        <button class="btn-accent-pill full48" data-simulate-magic-link="${isInvite ? "invite" : "app"}">
          จำลองการเปิดลิงก์จากอีเมล
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
