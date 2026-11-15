/**
 * Authentication & Folder Invitation Landing Screens:
 * - Mobile 10 Login Landing (319:818)
 * - Mobile 10A Email Login (319:2944)
 * - Mobile 10B Forgot Password (319:2974)
 * - Mobile Check Email (319:2988)
 * - Mobile 25 Sign Up (319:3029)
 * - Desktop PC Auth Cream Cherry Canvas + Floating White Card (390:572 / 383:9076 / 383:11530 / 383:11560 / 383:11574)
 */
import { icons, escHtml, safeImgUrl } from "../components/icons.js";
import { getAuthMode } from "../services/routeGuard.js";
import { getFolderById, getFolderCount, isQaModeEnabled } from "../state/store.js";

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
        หน้า "${escHtml(postAuthRedirect.screen)}" ต้องเข้าสู่ระบบก่อนใช้งาน
      </div>`
    : "";

  const errNote = authError
    ? `<div style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;">
        ${escHtml(authError)}
      </div>`
    : "";

  const modeBadge = isQaModeEnabled()
    ? `<div style="font-size:11.5px;color:var(--ink-secondary);display:flex;align-items:center;gap:6px;">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${authMode === "supabase" ? "#10b981" : authMode === "backend" ? "#3b82f6" : "#f59e0b"};"></span>
    <span>Auth Provider: <strong>${escHtml(modeLabel)}</strong></span>
  </div>`
    : "";

  return `${modeBadge}${redirectNote}${errNote}`;
}

function renderSharelyCherryWordmark({ size = "md", withCherry = false } = {}) {
  return `
    <div class="figma-brand-wordmark ${size}">
      ${withCherry ? `<span class="figma-wordmark-cherry">${icons.cherry(28)}</span>` : ""}
      <div class="figma-wordmark-row">
        <span class="figma-wordmark-text">Sharely</span>
        ${size === "hero" ? `<img class="figma-wordmark-rays" src="./assets/icons/login-wordmark-accent.svg" alt="" />` : ""}
      </div>
    </div>
  `;
}

function renderAuthCardFormContent(state, { desktop = false } = {}) {
  const isInviteAuth = state.ui.authContext === "invite";
  const screen = state.ui.screen;
  const rawMode = state.ui.authMode || "login";
  const viewMode = screen === "emailLogin" && rawMode === "login" ? "email" : rawMode;
  const fallbackEmail = state.api.useDevBypass ? state.data.user.email || "" : "";
  const emailVal = state.ui.authEmail || (viewMode === "signup" ? "" : fallbackEmail);
  const nameVal = state.ui.authDisplayName || "";
  const showPw = Boolean(state.ui.showPassword);

  if (viewMode === "forgot") {
    return `
      <div class="figma-auth-subpage">
        <div class="figma-auth-topbar clean">
          <button type="button" class="figma-back-link" data-action="set-auth-mode" data-mode="email">
            ${icons.back(18)}
            <span>กลับ</span>
          </button>
        </div>

        <div class="figma-auth-subhead">
          ${renderSharelyCherryWordmark({ size: "sm" })}
          <h1 class="figma-auth-title">ลืมรหัสผ่าน?</h1>
          <p class="figma-auth-sub">กรอกอีเมลที่ใช้สมัคร ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้คุณ</p>
        </div>

        ${renderAuthBanner(state)}

        <div class="figma-field">
          <label class="figma-label" for="forgotEmailInput">อีเมล</label>
          <input
            id="forgotEmailInput"
            class="figma-input figma-input-soft"
            type="email"
            value="${escHtml(emailVal)}"
            placeholder="name@email.com"
            data-bind-email-login="1"
          />
        </div>

        <button type="button" class="figma-primary-btn figma-red-pill" data-action="send-reset-link">
          ส่งลิงก์รีเซ็ตรหัสผ่าน
        </button>

        <p class="figma-forgot-hint">หากไม่พบอีเมล ลองตรวจสอบในโฟลเดอร์สแปม หรือ อีเมลขยะ</p>

        <div class="figma-auth-footer">
          <button type="button" class="figma-inline-link" data-action="set-auth-mode" data-mode="email">
            กลับไปหน้าเข้าสู่ระบบ
          </button>
        </div>
      </div>
    `;
  }

  if (viewMode === "signup") {
    return `
      <div class="figma-auth-subpage">
        <div class="figma-auth-topbar clean">
          <button type="button" class="figma-back-link" data-action="set-auth-mode" data-mode="login">
            ${icons.back(18)}
            <span>กลับ</span>
          </button>
        </div>

        <div class="figma-auth-subhead">
          ${renderSharelyCherryWordmark({ size: "sm", withCherry: true })}
          <h1 class="figma-auth-title">สมัครใช้งาน</h1>
          <p class="figma-auth-sub">สร้างบัญชีเพื่อเริ่มบันทึกลิงก์และแชร์กับเพื่อน</p>
        </div>

        ${renderAuthBanner(state)}

        <div class="figma-field">
          <label class="figma-label" for="displayNameSignupInput">ชื่อเล่น</label>
          <input
            id="displayNameSignupInput"
            class="figma-input figma-input-soft"
            type="text"
            value="${escHtml(nameVal)}"
            placeholder="เช่น มิน, แพรว"
            data-bind-displayname-signup="1"
          />
        </div>

        <div class="figma-field">
          <label class="figma-label" for="emailLoginInput">อีเมล</label>
          <input
            id="emailLoginInput"
            class="figma-input figma-input-soft"
            type="email"
            value="${escHtml(emailVal)}"
            placeholder="name@email.com"
            data-bind-email-login="1"
          />
        </div>

        <div class="figma-field">
          <label class="figma-label" for="passwordLoginInput">รหัสผ่าน</label>
          <div class="figma-password-wrap figma-input-soft">
            <input
              id="passwordLoginInput"
              class="figma-input"
              type="${showPw ? "text" : "password"}"
              value="${escHtml(state.ui.authPassword || "")}"
              placeholder="อย่างน้อย 8 ตัวอักษร"
              data-bind-password-login="1"
            />
            <button class="figma-pw-toggle" type="button" data-action="toggle-show-password">
              ${showPw ? "ซ่อน" : "แสดง"}
            </button>
          </div>
        </div>

        <div class="figma-field">
          <label class="figma-label" for="passwordConfirmInput">ยืนยันรหัสผ่าน</label>
          <div class="figma-password-wrap figma-input-soft">
            <input
              id="passwordConfirmInput"
              class="figma-input"
              type="${showPw ? "text" : "password"}"
              value="${escHtml(state.ui.authPasswordConfirm || "")}"
              placeholder="กรอกรหัสผ่านอีกครั้ง"
              data-bind-password-confirm="1"
            />
          </div>
        </div>

        <button type="button" class="figma-primary-btn figma-red-pill" data-submit-signup="1">
          สร้างบัญชี
        </button>

        <div class="figma-auth-footer">
          <span>มีบัญชีอยู่แล้ว?</span>
          <button type="button" class="figma-inline-link" data-action="set-auth-mode" data-mode="email">
            เข้าสู่ระบบ
          </button>
        </div>
      </div>
    `;
  }

  if (viewMode === "email") {
    return `
      <div class="figma-auth-subpage">
        <div class="figma-auth-topbar clean">
          <button type="button" class="figma-back-link" data-action="set-auth-mode" data-mode="login">
            ${icons.back(18)}
            <span>กลับ</span>
          </button>
        </div>

        <div class="figma-auth-subhead">
          ${renderSharelyCherryWordmark({ size: "sm" })}
          <h1 class="figma-auth-title">เข้าสู่ระบบด้วยอีเมล</h1>
          <p class="figma-auth-sub">ยินดีต้อนรับกลับมา กรอกข้อมูลเพื่อเข้าสู่ระบบ</p>
        </div>

        ${renderAuthBanner(state)}

        <div class="figma-field">
          <label class="figma-label" for="emailLoginInput">อีเมล</label>
          <input
            id="emailLoginInput"
            class="figma-input figma-input-soft"
            type="email"
            value="${escHtml(emailVal)}"
            placeholder="name@email.com"
            data-bind-email-login="1"
          />
        </div>

        <div class="figma-field">
          <div class="figma-label-row">
            <label class="figma-label" for="passwordLoginInput">รหัสผ่าน</label>
          </div>
          <div class="figma-password-wrap figma-input-soft">
            <input
              id="passwordLoginInput"
              class="figma-input"
              type="${showPw ? "text" : "password"}"
              value="${escHtml(state.ui.authPassword || "")}"
              placeholder="กรอกรหัสผ่าน"
              data-bind-password-login="1"
            />
            <button class="figma-pw-toggle" type="button" data-action="toggle-show-password">
              ${showPw ? "ซ่อน" : "แสดง"}
            </button>
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button type="button" class="figma-inline-link" data-action="set-auth-mode" data-mode="forgot">
              ลืมรหัสผ่าน?
            </button>
          </div>
        </div>

        <button type="button" class="figma-primary-btn figma-red-pill" data-submit-password-login="1">
          เข้าสู่ระบบ
        </button>

        <div class="figma-auth-footer">
          <span>ยังไม่มีบัญชีใช่ไหม?</span>
          <button type="button" class="figma-inline-link" data-action="set-auth-mode" data-mode="signup">
            สมัครใช้งาน
          </button>
        </div>
      </div>
    `;
  }

  // Landing mode (Figma 319:818 Mobile / 383:9076 Desktop right card)
  return `
    <div class="figma-landing-card-body">
      ${
        desktop
          ? `<div class="figma-pc-card-header">
               <h1 class="figma-auth-title" style="font-size:28px;">เข้าสู่ระบบ</h1>
               <p class="figma-auth-sub">เลือกวิธีเข้าสู่ระบบเพื่อใช้งานต่อ</p>
             </div>`
          : ""
      }

      ${renderAuthBanner(state)}

      <div class="figma-landing-actions">
        <button type="button" class="figma-primary-btn figma-red-pill tall" data-action="set-auth-mode" data-mode="email">
          <img src="./assets/icons/email-white.svg" alt="" style="width:20px;height:20px;" />
          <span>เข้าสู่ระบบด้วยอีเมล</span>
        </button>

        <button type="button" class="figma-oauth-btn figma-google-pill tall" data-oauth-google="${isInviteAuth ? "invite" : "app"}">
          <img src="./assets/icons/google-logo.svg" alt="" style="width:20px;height:20px;" />
          <span>ดำเนินการต่อด้วย Google</span>
        </button>
      </div>

      <div class="figma-auth-footer landing">
        <span>ยังไม่มีบัญชีใช่ไหม?</span>
        <button type="button" class="figma-inline-link" data-action="set-auth-mode" data-mode="signup">
          สมัครใช้งาน
        </button>
      </div>
    </div>
  `;
}

export function renderLoginScreen(state) {
  const screen = state.ui.screen;
  const rawMode = state.ui.authMode || "login";
  const viewMode = screen === "emailLogin" && rawMode === "login" ? "email" : rawMode;

  if (viewMode !== "login") {
    return `
      <div class="screen-scroll figma-auth-page clean-white" data-node-id="319:2944">
        <div class="figma-auth-body compact-form">
          ${renderAuthCardFormContent(state, { desktop: false })}
        </div>
      </div>
    `;
  }

  return `
    <div class="screen-scroll figma-login-landing" data-node-id="319:818">
      <img class="figma-wave-red-corner" src="./assets/icons/login-red-corner.svg" alt="" />
      <img class="figma-wave-lavender-bottom" src="./assets/icons/login-lavender-wave.svg" alt="" />

      <div class="figma-landing-stage">
        <div class="figma-landing-hero">
          <img
            class="figma-landing-cherries"
            src="./assets/icons/login-cherry-illustration.svg"
            alt="Sharely cherries"
          />
          <div class="figma-landing-brand">
            ${renderSharelyCherryWordmark({ size: "hero" })}
            <p class="figma-landing-subtitle">Save, organize, and share what you love.</p>
          </div>
        </div>

        <div class="figma-landing-bottom">
          ${renderAuthCardFormContent(state, { desktop: false })}
        </div>
      </div>
    </div>
  `;
}

export function renderEmailLoginScreen(state) {
  return `
    <div class="screen-scroll figma-auth-page clean-white" data-node-id="319:2944">
      <div class="figma-auth-body compact-form">
        ${renderAuthCardFormContent({ ...state, ui: { ...state.ui, authMode: state.ui.authMode === "login" ? "email" : state.ui.authMode } }, { desktop: false })}
      </div>
    </div>
  `;
}

export function renderCheckEmailScreen(state) {
  const isInvite = state.ui.authContext === "invite";
  const authMode = getAuthMode(state);
  const targetEmail = state.ui.authEmail || state.data.user.email || "name@email.com";
  return `
    <div class="screen-scroll figma-auth-page clean-white" data-node-id="319:2988">
      <div class="figma-auth-topbar clean">
        <button type="button" class="figma-back-link" data-action="set-auth-mode" data-mode="email">
          ${icons.back(18)}
          <span>กลับ</span>
        </button>
      </div>

      <div class="figma-auth-body center-verify">
        <div class="figma-verify-check-circle">${icons.check(28)}</div>
        <h2 class="figma-auth-title">ตรวจสอบอีเมลของคุณ</h2>
        <p class="figma-auth-sub" style="text-align:center;">
          เราได้ส่งลิงก์ยืนยันและลิงก์เข้าสู่ระบบไปที่<br />
          <span class="figma-verify-email-badge">${escHtml(targetEmail)}</span>
        </p>

        ${
          authMode === "supabase"
            ? `<button type="button" class="figma-primary-btn figma-red-pill" data-check-supabase-session="1">
                ยืนยันแล้ว เข้าใช้งานเลย
              </button>`
            : `<button type="button" class="figma-primary-btn figma-red-pill" data-simulate-magic-link="${isInvite ? "invite" : "app"}">
                ยืนยันแล้ว เข้าใช้งานเลย
              </button>`
        }

        <div class="figma-auth-footer" style="margin-top:8px;">
          <span>ไม่ได้รับอีเมลใช่ไหม?</span>
          <button type="button" class="figma-inline-link" data-submit-email-login="1">ส่งอีกครั้ง</button>
        </div>

        <button type="button" class="figma-text-link center" data-action="set-auth-mode" data-mode="email">
          กลับไปหน้าเข้าสู่ระบบ
        </button>
      </div>
    </div>
  `;
}

export function renderInviteLandingScreen(state) {
  const preview = state.ui.invitePreview || null;
  const folder = getFolderById(state.ui.inviteFolderId || state.ui.activeFolderId) || state.data.folders[0] || null;
  const folderId = preview?.folder_id || folder?.id || state.ui.inviteFolderId || "";
  const folderName = preview?.folder_name || folder?.name || "โฟลเดอร์ที่แชร์";
  const folderCover = preview?.folder_cover_url || folder?.cover || "";
  const folderEmoji = preview?.folder_emoji || folder?.emoji || "📁";
  const count = preview ? Number(preview.item_count || 0) : folder ? getFolderCount(folder) : 0;
  const inviterName = preview?.inviter_name || (folder && state.data.user?.isAuthenticated ? state.data.user.displayName : "เพื่อนของคุณ");
  const isInvalidInvite = Boolean(preview && preview.valid === false);
  const invalidReasonMap = {
    revoked: "ลิงก์คำเชิญนี้ถูกยกเลิกโดยเจ้าของโฟลเดอร์แล้ว",
    expired: "ลิงก์คำเชิญนี้หมดอายุแล้ว",
    max_uses_reached: "ลิงก์คำเชิญนี้ถูกใช้งานครบตามจำนวนที่กำหนดแล้ว",
  };
  const invalidMessage = invalidReasonMap[preview?.reason] || "ลิงก์คำเชิญไม่ถูกต้องหรือหมดอายุแล้ว";
  const roleLabel = preview?.role === "editor" ? "เพิ่มและแก้ไขลิงก์ได้" : "เปิดดูลิงก์ในโฟลเดอร์ได้";
  const isLoggedIn = Boolean(state.data.user?.isAuthenticated);
  const safeCover = safeImgUrl(folderCover);

  return `
    <div class="screen-scroll">
      <div class="app-pad" style="display:flex;flex-direction:column;gap:18px;min-height:100%;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="brand-heading" style="font-size:25px;">Sharely</span>
          <span class="tb-pill-badge" style="border:none;">
            ${icons.folder(14)} คำเชิญ
          </span>
        </div>

        <div>
          <h2 style="margin:0 0 5px;font-size:24px;">คำเชิญเข้าโฟลเดอร์</h2>
          <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
            ${escHtml(inviterName)} ชวนคุณเข้าร่วมโฟลเดอร์ "${escHtml(folderName)}"
          </p>
        </div>

        ${
          isInvalidInvite
            ? `<div style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:12px;padding:12px;font-size:13px;font-weight:600;">
                 ${escHtml(invalidMessage)}
               </div>`
            : ""
        }

        <div class="settings-card" style="border-color:var(--border-divider);">
          <div style="height:148px;overflow:hidden;background:var(--bg-thumb);display:flex;align-items:center;justify-content:center;">
            ${
              safeCover
                ? `<img src="${escHtml(safeCover)}" alt="" style="width:100%;height:100%;object-fit:cover;" />`
                : `<span style="font-size:44px;">${escHtml(folderEmoji)}</span>`
            }
          </div>
          <div style="padding:13px;">
            <h3 style="margin:0 0 6px;font-size:20px;">${escHtml(folderName)}</h3>
            <p style="margin:0;font-size:13px;color:var(--ink-secondary);display:flex;align-items:center;gap:7px;">
              ${icons.people(17)}
              <span>${count} ลิงก์ · สิทธิ์: ${escHtml(roleLabel)}</span>
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
            <span>${preview?.role === "viewer" ? "ติดตามการอัปเดตลิงก์ใหม่ร่วมกับเพื่อน" : "เพิ่มลิงก์ให้เพื่อนในโฟลเดอร์ดูได้"}</span>
          </div>
        </div>

        <div style="margin-top:auto;display:flex;flex-direction:column;gap:8px;">
          <button
            type="button"
            class="btn-accent-pill full48"
            data-accept-invite="${escHtml(folderId)}"
            ${isInvalidInvite ? "disabled" : ""}
          >
            ${isLoggedIn ? "เข้าร่วมโฟลเดอร์" : "เข้าสู่ระบบเพื่อเข้าร่วมโฟลเดอร์นี้"}
          </button>
          ${
            isLoggedIn
              ? `<button type="button" class="link-more-btn" style="text-decoration:none;color:var(--ink-secondary);font-weight:400;" data-go-screen="login" data-auth-ctx="invite">
                   สลับบัญชีก่อนเข้าร่วมโฟลเดอร์
                 </button>`
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

export function renderWebAuthView(state) {
  const screen = state.ui.screen;
  const preview = state.ui.invitePreview || null;
  const invFolder = preview || getFolderById(state.ui.inviteFolderId || state.ui.activeFolderId) || null;
  const invCover = safeImgUrl(preview?.folder_cover_url || invFolder?.cover || "");
  const isInvite = screen === "inviteLanding" || state.ui.authContext === "invite";

  const rightBody =
    screen === "inviteLanding"
      ? renderInviteLandingScreen(state)
      : screen === "checkEmail"
        ? renderCheckEmailScreen(state)
        : renderAuthCardFormContent(state, { desktop: true });

  return `
    <div class="pc-auth-shell" data-pc-cream="1" data-node-id="390:572">
      <img class="pc-auth-wave-red" src="./assets/icons/login-red-corner.svg" alt="" />
      <img class="pc-auth-wave-lavender" src="./assets/icons/login-lavender-wave.svg" alt="" />

      <div class="pc-auth-inner">
        <section class="pc-auth-brand-stage">
          <div class="pc-auth-brand-copy">
            <div class="figma-wordmark-row desktop-hero">
              <span class="pc-auth-wordmark">Sharely</span>
              <img class="figma-wordmark-rays pc" src="./assets/icons/login-wordmark-accent.svg" alt="" />
            </div>
            <p class="pc-auth-tagline">เซฟลิงก์ที่ชอบ กลับมาดูได้ทุกเมื่อ</p>
          </div>

          <img
            class="pc-auth-cherries-art"
            src="./assets/icons/login-cherry-illustration.svg"
            alt="Sharely cherries illustration"
          />
        </section>

        <section class="pc-auth-form-col">
          <div class="pc-auth-card">
            ${
              isInvite && preview && screen !== "inviteLanding"
                ? `
              <div class="pc-invite-preview-banner">
                <div class="pc-invite-preview-thumb">
                  ${
                    invCover
                      ? `<img src="${escHtml(invCover)}" alt="" />`
                      : `<span>${escHtml(preview.folder_emoji || "📁")}</span>`
                  }
                </div>
                <div style="min-width:0;">
                  <strong style="display:block;font-size:14px;color:var(--ink-primary);">เข้าร่วม "${escHtml(preview.folder_name || "โฟลเดอร์ที่แชร์")}"</strong>
                  <span style="font-size:12.5px;color:var(--ink-secondary);">คำเชิญจาก ${escHtml(preview.inviter_name || "เพื่อนของคุณ")}</span>
                </div>
              </div>`
                : ""
            }
            ${rightBody}
          </div>
        </section>
      </div>
    </div>
  `;
}
