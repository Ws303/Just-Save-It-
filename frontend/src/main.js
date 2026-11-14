/**
 * Application Entrypoint, Event Dispatcher & Focus-Preserving Renderer for Sharely Test Web App.
 */
import { AI_PROVIDER_PRESETS, COVER_CHOICES, FOLDER_NAME_SUGGESTIONS } from "./data/seed.js";
import { store, inferPlatform, getFolderById, getLinkById } from "./state/store.js";
import { apiClient } from "./services/apiClient.js";
import {
  getAuthMode,
  hasValidSession,
  isProtectedScreen,
  isProtectedViewport,
} from "./services/routeGuard.js";
import { supabaseAuth } from "./services/supabaseAuth.js";
import { icons, escHtml } from "./components/icons.js";
import { renderPostMenuAndDialog } from "./screens/common.js";
import {
  renderLoginScreen,
  renderEmailLoginScreen,
  renderCheckEmailScreen,
  renderInviteLandingScreen,
} from "./screens/auth.js";
import { renderHomeScreen } from "./screens/home.js";
import { renderFoldersScreen, renderFolderDetailScreen, renderFolderSheets } from "./screens/folders.js";
import { renderLinkDetailScreen, renderSavedPreviewScreen, renderSaveAndReminderSheets } from "./screens/links.js";
import { renderAiScreen } from "./screens/ai.js";
import {
  renderProfileScreen,
  renderDisplayScreen,
  renderSecurityScreen,
  renderHelpScreen,
  renderProfileSheets,
} from "./screens/profile.js";
import { renderWebView, renderExtensionPopup } from "./screens/webExtension.js";
import { renderTestbedPanel } from "./screens/testbed.js";

const appEl = document.getElementById("app");

function renderActiveMobileScreen(state) {
  switch (state.ui.screen) {
    case "login":
      return renderLoginScreen(state);
    case "emailLogin":
      return renderEmailLoginScreen(state);
    case "checkEmail":
      return renderCheckEmailScreen(state);
    case "inviteLanding":
      return renderInviteLandingScreen(state);
    case "home":
      return renderHomeScreen(state);
    case "folders":
      return renderFoldersScreen(state);
    case "folderDetail":
      return renderFolderDetailScreen(state);
    case "linkDetail":
      return renderLinkDetailScreen(state);
    case "savedPreview":
      return renderSavedPreviewScreen(state);
    case "ai":
      return renderAiScreen(state);
    case "profile":
      return renderProfileScreen(state);
    case "display":
      return renderDisplayScreen(state);
    case "security":
      return renderSecurityScreen(state);
    case "help":
      return renderHelpScreen(state);
    default:
      return renderHomeScreen(state);
  }
}

function renderSimulatedHostApp(appName) {
  const isTikTok = appName === "tiktok";
  const isIG = appName === "instagram";
  const isYT = appName === "youtube";
  const isTwitter = appName === "twitter";

  return `
    <div class="simulated-host-app">
      <div class="sim-host-topbar">
        <button style="background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:20px;padding:5px 12px;font-size:11.5px;cursor:pointer;" data-close-host-app="1">
          ✕ ปิดโหมดจำลองแอป
        </button>
        <span style="font-weight:700;">${isTikTok ? "🎵 TikTok (กำลังเล่นคลิป)" : isIG ? "📸 Instagram Reels" : isYT ? "▶️ YouTube" : "𝕏 X"}</span>
        <span style="font-size:11px;opacity:0.85;">Host App</span>
      </div>
      <div class="sim-host-content" style="background-image:url('./assets/covers/coffee.png');">
        <div class="sim-host-sidebar">
          <div class="sim-host-action-btn">
            <div class="sim-host-action-icon">${icons.profile(20)}</div>
            <span>+</span>
          </div>
          <div class="sim-host-action-btn">
            <div class="sim-host-action-icon" style="color:#ef4444;">${icons.cherry(18)}</div>
            <span>89.2K</span>
          </div>
          <div class="sim-host-action-btn">
            <div class="sim-host-action-icon" style="background:#fed053;color:#000;border:1.5px solid #000;">${icons.share(18)}</div>
            <span style="font-weight:800;color:#fed053;">แชร์</span>
          </div>
        </div>
        <div class="sim-host-meta">
          <strong style="font-size:15px;">${isTikTok ? "@minimal.lifestyle" : isIG ? "@cafe.hopping" : "@traveler.bkk"}</strong>
          <p style="margin:0;font-size:13px;line-height:1.4;opacity:0.95;">
            ${isTikTok ? "TikTok - Make Your Day ✨ แนะนำคลิปไวรัลยอดนิยม" : "รีวิวคาเฟ่มินิมอลย่านอารีย์ 2026"}
          </p>
        </div>
      </div>
    </div>
  `;
}

function renderViewportContent(state) {
  const isAuthScreen = ["login", "emailLogin", "checkEmail", "inviteLanding"].includes(state.ui.screen);
  if (state.ui.viewportMode === "web" && !isAuthScreen) {
    return `
      ${renderWebView(state)}
      ${state.ui.activeSheet ? `<div class="pc-modal-portal">${[renderPostMenuAndDialog(state.ui, state.data.links), renderFolderSheets(state), renderSaveAndReminderSheets(state), renderProfileSheets(state)].join("")}</div>` : ""}
      ${state.ui.toast ? `<div class="toast-banner">${escHtml(state.ui.toast)}</div>` : ""}
    `;
  }
  if (state.ui.viewportMode === "extension") {
    return renderExtensionPopup(state);
  }

  const sheetsHtml = [
    renderPostMenuAndDialog(state.ui, state.data.links),
    renderFolderSheets(state),
    renderSaveAndReminderSheets(state),
    renderProfileSheets(state),
  ].join("");

  const hostAppBackdrop = state.ui.simulatedSourceApp ? renderSimulatedHostApp(state.ui.simulatedSourceApp) : "";

  return `
    <div class="phone-bezel">
      <main class="phone-frame" aria-label="Just Save It App Preview">
        ${hostAppBackdrop}
        ${renderActiveMobileScreen(state)}
        ${sheetsHtml}
        ${state.ui.toast ? `<div class="toast-banner">${escHtml(state.ui.toast)}</div>` : ""}
      </main>
    </div>
  `;
}

function renderApp() {
  const state = store.state;
  const activeEl = document.activeElement;
  let focusInfo = null;
  if (activeEl && activeEl.tagName && ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName)) {
    const dataAttrs = Array.from(activeEl.attributes)
      .filter((a) => a.name.startsWith("data-") || a.name === "id")
      .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
      .join("");
    if (dataAttrs) {
      focusInfo = {
        selector: `${activeEl.tagName.toLowerCase()}${dataAttrs}`,
        start: activeEl.selectionStart,
        end: activeEl.selectionEnd,
      };
    }
  }

  const scrollPhone = appEl.querySelector(".screen-scroll")?.scrollTop || 0;
  const scrollInspector = appEl.querySelector(".tb-ins-body")?.scrollTop || 0;

  const healthDotClass =
    state.api.mode === "mock"
      ? "mock"
      : state.api.healthStatus === "healthy"
        ? "ok"
        : state.api.healthStatus === "offline"
          ? "err"
          : "";

  const isUnlocked = hasValidSession(state) || state.ui.authGuardEnabled === false;
  const quickButtons = [
    { id: "login", label: "10 Login", protected: false },
    { id: "home", label: "11 Home", protected: true },
    { id: "folders", label: "14 Folders", protected: true },
    { id: "folderDetail", label: "15 Folder Detail", protected: true },
    { id: "saveSheet", label: "1 Save Link", protected: true },
    { id: "linkDetail", label: "5 Link Detail", protected: true },
    { id: "reminderSheet", label: "6 Reminder", protected: true },
    { id: "savedPreview", label: "7 Preview", protected: true },
    { id: "ai", label: "18 AI Config", protected: true },
    { id: "profile", label: "19 Profile", protected: true },
    { id: "display", label: "20 Themes", protected: true },
    { id: "inviteLanding", label: "23 Invite", protected: false },
    { id: "inviteSheet", label: "24 Share", protected: true },
  ];

  const isCollapsed = state.ui.qaPanelCollapsed !== false;
  const showQaToggle =
    typeof window !== "undefined" &&
    (window.location.search.includes("qa=1") || window.location.hash.includes("qa"));

  appEl.innerHTML = isCollapsed
    ? `
      <div class="tb-clean-stage ${state.ui.viewportMode === "web" ? "is-pc-stage" : "is-mobile-stage"}">
        ${renderViewportContent(state)}
        ${
          showQaToggle
            ? `<button class="qa-floating-toggle" data-action="toggle-qa-panel" title="เปิด QA & API Testbed Panel">
          🛠️ QA &amp; API
        </button>`
            : ""
        }
      </div>
    `
    : `
      <div class="tb-root">
        <header class="tb-topbar">
          <div class="tb-brand">
            <span style="color:var(--theme-swatch);display:inline-flex;">${icons.cherry(22)}</span>
            <span class="tb-brand-logo">Sharely</span>
            <span class="tb-pill-badge">Interactive UI &amp; Backend Testbed</span>
          </div>

          <div class="tb-segmented" role="tablist" aria-label="Viewport Mode">
            <button class="tb-seg-btn ${state.ui.viewportMode === "mobile" ? "active" : ""}" data-viewport-switch="mobile">
              Mobile (390×844)
            </button>
            <button class="tb-seg-btn ${state.ui.viewportMode === "web" ? "active" : ""}" data-viewport-switch="web">
              W1 Web View
            </button>
            <button class="tb-seg-btn ${state.ui.viewportMode === "extension" ? "active" : ""}" data-viewport-switch="extension">
              E1 Extension
            </button>
          </div>

          <div class="tb-topbar-actions">
            <button class="tb-status-pill" data-ping-health="1" title="คลิกเพื่อตรวจสอบ Backend Health">
              <span class="tb-dot ${healthDotClass}"></span>
              <span>
                ${
                  state.api.mode === "mock"
                    ? "Mock Mode Active"
                    : state.api.healthStatus === "healthy"
                      ? "FastAPI Healthy"
                      : "FastAPI Live Mode"
                }
              </span>
            </button>
            <button class="tb-btn" data-toggle-inspector="1">
              ${state.ui.inspectorVisible ? "ซ่อน Inspector" : "แสดง Inspector"}
            </button>
            <button class="tb-btn" data-action="toggle-qa-panel">
              ย่อเป็นโหมด Figma 1:1
            </button>
          </div>
        </header>

        <div class="tb-workspace ${state.ui.inspectorVisible ? "" : "inspector-hidden"}">
          <div class="tb-stage-col">
            <div class="tb-quick-nav" aria-label="Screen quick switcher">
              ${quickButtons
                .map((b) => {
                  const isActive =
                    (b.id === "saveSheet" && state.ui.activeSheet?.type === "saveLink") ||
                    (b.id === "reminderSheet" && state.ui.activeSheet?.type === "reminder") ||
                    (b.id === "inviteSheet" && state.ui.activeSheet?.type === "invite") ||
                    (state.ui.viewportMode === "mobile" && !state.ui.activeSheet && state.ui.screen === b.id);
                  return `<button class="tb-qbtn ${isActive ? "active" : ""}" data-quick-jump="${b.id}">${b.protected && !isUnlocked ? "🔒 " : ""}${b.label}</button>`;
                })
                .join("")}
            </div>

            ${renderViewportContent(state)}
          </div>

          ${state.ui.inspectorVisible ? renderTestbedPanel(state) : ""}
        </div>
      </div>
    `;

  const phoneScrollEl = appEl.querySelector(".screen-scroll");
  if (phoneScrollEl) phoneScrollEl.scrollTop = scrollPhone;

  const insScrollEl = appEl.querySelector(".tb-ins-body");
  if (insScrollEl) insScrollEl.scrollTop = scrollInspector;

  if (focusInfo) {
    const target = appEl.querySelector(focusInfo.selector);
    if (target) {
      target.focus();
      if (typeof focusInfo.start === "number" && target.setSelectionRange) {
        try {
          target.setSelectionRange(focusInfo.start, focusInfo.end);
        } catch {
          // Non-text inputs ignore setSelectionRange
        }
      }
    }
  }
}

function openSaveSheet(prefill = {}) {
  const state = store.state;
  const folderId = prefill.folderId || state.ui.activeFolderId || state.data.folders[0]?.id;
  const url = prefill.url || "";
  const { platform, domain } = inferPlatform(url || "https://www.instagram.com/reel/SharelyDemo");

  const currentViewport = state.ui.viewportMode === "web" ? "web" : "mobile";
  const targetScreen = ["home", "folders", "folderDetail", "linkDetail"].includes(state.ui.screen)
    ? state.ui.screen
    : "home";
  const allowed = store.navigate(targetScreen, { viewportMode: currentViewport });
  if (!allowed) return;

  if (typeof prefill.simulatedSourceApp !== "undefined") {
    store.state.ui.simulatedSourceApp = prefill.simulatedSourceApp;
  }
  store.state.ui.addLinkExpanded = false;
  store.state.ui.folderPickerSheetOpen = false;
  store.state.ui.createFolderSheetOpen = false;
  store.openSheet({
    type: "saveLink",
    draft: {
      url,
      platform: prefill.platform || platform,
      domain: prefill.domain || domain,
      title: prefill.title || "",
      coverUrl: prefill.coverUrl || null,
      media_items: prefill.media_items || [],
      folderId,
      pinned: Boolean(prefill.pinned),
      showAdvanced: false,
      tags: prefill.tags || [],
      note: prefill.note || "",
      reminder: "",
      reminderDate: null,
      reminderTime: "18:00",
      scheduleType: "once",
      repeatEveryDays: null,
      sourceApp: prefill.sourceApp || platform,
    },
  });
}

function openReminderSheet(linkId) {
  const item = getLinkById(linkId) || store.state.data.links[0];
  if (!item) return;
  const ym = item.reminderDate ? item.reminderDate.slice(0, 7) : "2026-11";
  const monthLabels = {
    "2026-10": "ตุลาคม 2569",
    "2026-11": "พฤศจิกายน 2569",
    "2026-12": "ธันวาคม 2569",
  };
  store.state.ui.reminderScheduleType = item.scheduleType || "once";
  store.state.ui.reminderRepeatDays = item.repeatEveryDays || 3;
  store.openSheet({
    type: "reminder",
    linkId: item.id,
    day: Number(item.reminderDate?.slice(8, 10)) || 15,
    monthLabel: monthLabels[ym] || "พฤศจิกายน 2569",
    yearMonth: monthLabels[ym] ? ym : "2026-11",
    time: item.reminderTime || "18:00",
    scheduleType: item.scheduleType || "once",
    repeatEveryDays: item.repeatEveryDays || 3,
  });
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

// =========================================================
// DELEGATED INPUT / CHANGE HANDLERS
// =========================================================
appEl.addEventListener("input", (e) => {
  const el = e.target;
  const { ui, data, api } = store.state;

  if (el.dataset.searchInput === "home") {
    ui.homeSearch = el.value;
    store.emit();
  } else if (el.dataset.searchInput === "folders") {
    ui.folderSearch = el.value;
    store.emit();
  } else if (el.dataset.searchInput === "folderDetail") {
    ui.folderDetailSearch = el.value;
    store.emit();
  } else if (el.dataset.bindDisplaynameSignup) {
    ui.authDisplayName = el.value;
    ui.authError = null;
  } else if (el.dataset.bindEmailLogin) {
    ui.authEmail = el.value;
    ui.authError = null;
  } else if (el.dataset.bindPasswordLogin) {
    ui.authPassword = el.value;
    ui.authError = null;
  } else if (el.dataset.editNote) {
    const item = getLinkById(el.dataset.editNote);
    if (item) {
      item.note = el.value;
      store.save();
    }
  } else if (el.dataset.bindNoteDraft !== undefined) {
    ui.noteDraft = el.value;
  } else if (el.dataset.bindTagDraft !== undefined) {
    ui.tagDraft = el.value;
  } else if (el.dataset.bindInlineFolderName !== undefined) {
    ui.inlineFolderName = el.value;
  } else if (el.dataset.bindInlineFolderEmoji !== undefined) {
    ui.inlineFolderEmoji = el.value;
  } else if (el.dataset.bindPasswordConfirm !== undefined) {
    ui.authPasswordConfirm = el.value;
  } else if (el.dataset.bindSaveUrl && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.url = el.value;
    const { platform, domain } = inferPlatform(el.value);
    ui.activeSheet.draft.platform = platform;
    ui.activeSheet.draft.domain = domain;
  } else if (el.dataset.bindSaveTitle && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.title = el.value;
  } else if (el.dataset.bindSaveNote && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.note = el.value;
  } else if (el.dataset.bindFolderName && ui.activeSheet) {
    ui.activeSheet.nameDraft = el.value;
  } else if (el.dataset.bindCalTime && ui.activeSheet?.type === "reminder") {
    ui.activeSheet.time = el.value;
  } else if (el.dataset.bindAiEndpoint) {
    data.aiConfig.endpointUrl = el.value;
    store.save();
  } else if (el.dataset.bindAiKey) {
    data.aiConfig.apiKey = el.value;
    store.save();
  } else if (el.dataset.bindNickname && ui.activeSheet?.type === "editNickname") {
    ui.activeSheet.value = el.value;
  } else if (el.dataset.extUrl) {
    ui.extensionDraft = ui.extensionDraft || {};
    ui.extensionDraft.url = el.value;
    Object.assign(ui.extensionDraft, inferPlatform(el.value));
  } else if (el.dataset.extNote) {
    ui.extensionDraft = ui.extensionDraft || {};
    ui.extensionDraft.note = el.value;
  } else if (el.dataset.bindApiBase) {
    api.baseUrl = el.value;
  } else if (el.dataset.bindSupabaseUrl) {
    api.supabaseUrl = el.value;
  } else if (el.dataset.bindSupabaseKey) {
    api.supabaseAnonKey = el.value;
  } else if (el.dataset.bindUserId) {
    api.userId = el.value;
  } else if (el.dataset.bindLatency) {
    api.latencyMs = Number(el.value) || 0;
  }
});

appEl.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.selectTestItem) {
    store.state.ui.activeLinkId = el.value;
    store.emit();
  } else if (el.dataset.toggleForceRefresh) {
    store.state.api.summarizeOptions.forceRefresh = el.checked;
    store.emit();
  } else if (el.dataset.toggleSaveNote) {
    store.state.api.summarizeOptions.saveToNote = el.checked;
    store.emit();
  } else if (el.dataset.toggleAuthGuard) {
    store.state.ui.authGuardEnabled = el.checked;
    if (
      el.checked &&
      !hasValidSession(store.state) &&
      (isProtectedScreen(store.state.ui.screen) || isProtectedViewport(store.state.ui.viewportMode))
    ) {
      store.navigate(store.state.ui.screen, { viewportMode: store.state.ui.viewportMode });
    } else {
      store.emit();
    }
  } else if (el.dataset.toggleDevBypass) {
    store.state.api.useDevBypass = el.checked;
    store.emit();
  } else if (el.dataset.toggleSeen) {
    apiClient.patchLink(el.dataset.toggleSeen, { status: el.checked ? "read" : "unread" });
  }
});

function completePostAuthNavigation(fallbackScreen = "home") {
  if (store.state.api.mode === "live") {
    apiClient.hydrateWorkspace().catch(() => {});
  }
  const redirect = store.state.ui.postAuthRedirect;
  store.state.ui.postAuthRedirect = null;
  if (store.state.ui.authContext === "invite") {
    store.navigate("inviteLanding", { viewportMode: "mobile" });
    return;
  }
  if (redirect && redirect.screen) {
    store.navigate(redirect.screen, {
      viewportMode: redirect.viewportMode || "mobile",
      activeFolderId: redirect.activeFolderId ?? store.state.ui.activeFolderId,
      activeLinkId: redirect.activeLinkId ?? store.state.ui.activeLinkId,
    });
    return;
  }
  store.navigate(fallbackScreen, { viewportMode: "mobile" });
}

// =========================================================
// DELEGATED CLICK HANDLERS
// =========================================================
appEl.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-action],[data-viewport-switch],[data-toggle-inspector],[data-ins-tab],[data-quick-jump],[data-nav],[data-go-screen],[data-open-folder],[data-open-edit-folder],[data-open-link],[data-open-preview],[data-toggle-auth-mode],[data-oauth-google],[data-submit-email-login],[data-submit-signup],[data-submit-password-login],[data-simulate-magic-link],[data-check-supabase-session],[data-accept-invite],[data-toggle-notifs],[data-mark-notifs-read],[data-filter-chip],[data-toggle-fav],[data-open-post-menu],[data-close-sheet],[data-close-host-app],[data-toggle-pin-link],[data-toggle-save-advanced],[data-sim-share-preset],[data-sim-custom-share],[data-toggle-host-backdrop],[data-toggle-status-sheet],[data-trigger-ai-sheet],[data-confirm-delete-post],[data-execute-delete-post],[data-open-save-sheet],[data-run-unfurl],[data-select-save-folder],[data-toggle-save-tag],[data-toggle-draft-reminder],[data-submit-save-link],[data-toggle-video-play],[data-toggle-seen],[data-run-ai-summarize],[data-open-reminder],[data-cal-month],[data-select-cal-day],[data-clear-reminder],[data-save-reminder],[data-preview-mark-read],[data-preview-step],[data-open-create-folder],[data-suggest-folder-name],[data-open-pick-cover],[data-select-cover],[data-back-to-folder-edit],[data-save-folder-sheet],[data-open-invite-sheet],[data-copy-invite],[data-open-invite-apps],[data-open-invite-preview],[data-preview-recipient-invite],[data-toggle-ai-dropdown],[data-select-ai-provider],[data-select-ai-model],[data-toggle-ai-keyless],[data-save-ai-config],[data-open-edit-nickname],[data-save-nickname],[data-toggle-notif-setting],[data-set-text-size],[data-set-theme],[data-update-account-email],[data-send-password-reset],[data-submit-support],[data-open-export-csv],[data-download-csv],[data-open-logout-dialog],[data-confirm-logout],[data-web-scope],[data-web-folder],[data-select-web-link],[data-ext-unfurl],[data-ext-folder],[data-ext-tag],[data-ext-toggle-reminder],[data-ext-submit],[data-set-api-mode],[data-set-auth-provider],[data-ping-health],[data-tb-test-auth],[data-sim-share-intent],[data-sim-open-invite],[data-export-json-state],[data-reset-seed],[data-clear-logs],[data-run-mcp-tool]");
  if (!target) return;

  const d = target.dataset;
  const { ui, data, api } = store.state;

  // 0. Unified Figma data-action handlers
  if (d.action) {
    const act = d.action;
    if (act === "toggle-qa-panel") {
      ui.qaPanelCollapsed = !(ui.qaPanelCollapsed !== false);
      ui.inspectorVisible = !ui.qaPanelCollapsed;
      store.emit();
      return;
    }
    if (act === "toggle-home-all-links") {
      ui.showAllHomeLinks = !ui.showAllHomeLinks;
      store.emit();
      return;
    }
    if (act === "open-notifications") {
      ui.notificationScreenOpen = true;
      ui.showNotifications = true;
      store.emit();
      return;
    }
    if (act === "close-notifications") {
      ui.notificationScreenOpen = false;
      ui.showNotifications = false;
      store.emit();
      return;
    }
    if (act === "mark-all-notifications-read") {
      data.notifications.forEach((n) => (n.unread = false));
      store.showToast("อ่านแจ้งเตือนทั้งหมดแล้ว");
      return;
    }
    if (act === "open-notification-item") {
      const n = data.notifications.find((item) => item.id === d.id);
      if (n) n.unread = false;
      ui.notificationScreenOpen = false;
      ui.showNotifications = false;
      if (n?.linkId) {
        store.navigate("linkDetail", { activeLinkId: n.linkId });
      } else if (n?.folderId) {
        store.navigate("folderDetail", { activeFolderId: n.folderId });
      } else {
        store.emit();
      }
      return;
    }
    if (act === "set-auth-mode") {
      ui.authMode = d.mode || "login";
      ui.authError = null;
      if (d.mode === "checkEmail") {
        store.navigate("checkEmail", { allowGuestSwitch: true });
      } else {
        store.navigate("login", { allowGuestSwitch: true });
      }
      return;
    }
    if (act === "toggle-show-password") {
      ui.showPassword = !ui.showPassword;
      store.emit();
      return;
    }
    if (act === "send-reset-link") {
      const email = (ui.authEmail || data.user.email || "").trim();
      if (!email) {
        ui.authError = "กรุณากรอกอีเมลที่ใช้สมัคร";
        store.emit();
        return;
      }
      await apiClient.sendPasswordReset(email);
      ui.authMode = "login";
      store.showToast(`ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่ ${email} แล้ว`);
      store.navigate("checkEmail", { allowGuestSwitch: true });
      return;
    }
    if (act === "toggle-add-link-expand" && ui.activeSheet?.type === "saveLink") {
      ui.addLinkExpanded = !ui.addLinkExpanded;
      ui.activeSheet.draft.showAdvanced = ui.addLinkExpanded;
      store.emit();
      return;
    }
    if (act === "paste-clipboard-url" && ui.activeSheet?.type === "saveLink") {
      let clip = "";
      try {
        clip = await navigator.clipboard.readText();
      } catch {}
      const pastedUrl = clip && clip.startsWith("http") ? clip : "https://www.instagram.com/reel/CafeChiangMai2026";
      ui.activeSheet.draft.url = pastedUrl;
      const pv = await apiClient.previewUrl(pastedUrl);
      if (pv.ok && pv.data) {
        ui.activeSheet.draft.title = pv.data.title || ui.activeSheet.draft.title;
        ui.activeSheet.draft.platform = pv.data.platform || ui.activeSheet.draft.platform;
        ui.activeSheet.draft.coverUrl = pv.data.image_url || ui.activeSheet.draft.coverUrl;
        ui.activeSheet.draft.media_items = pv.data.media_items || [];
      }
      store.emit();
      return;
    }
    if (act === "open-folder-picker-sheet") {
      ui.folderPickerSheetOpen = true;
      store.emit();
      return;
    }
    if (act === "close-folder-picker-sheet") {
      ui.folderPickerSheetOpen = false;
      store.emit();
      return;
    }
    if (act === "open-create-folder-sheet") {
      ui.createFolderSheetOpen = true;
      ui.inlineFolderName = "";
      ui.inlineFolderEmoji = "☕";
      store.emit();
      return;
    }
    if (act === "close-create-folder-sheet") {
      ui.createFolderSheetOpen = false;
      store.emit();
      return;
    }
    if (act === "select-inline-emoji") {
      ui.inlineFolderEmoji = d.emoji || "📁";
      store.emit();
      return;
    }
    if (act === "create-folder-inline") {
      const name = (ui.inlineFolderName || "").trim() || "โฟลเดอร์ใหม่";
      const created = await apiClient.saveFolder({ name, emoji: ui.inlineFolderEmoji || "📁" });
      ui.createFolderSheetOpen = false;
      ui.folderPickerSheetOpen = false;
      if (ui.activeSheet?.type === "saveLink" && created) {
        ui.activeSheet.draft.folderId = created.id;
      }
      store.showToast(`สร้างโฟลเดอร์ "${name}" แล้ว`);
      return;
    }
    if (act === "open-ai-confirm") {
      ui.aiConfirmModalOpen = true;
      ui.aiSummaryStatus = "confirm";
      store.emit();
      return;
    }
    if (act === "close-ai-confirm") {
      ui.aiRequestId = (ui.aiRequestId || 0) + 1;
      ui.aiConfirmModalOpen = false;
      ui.aiSummaryStatus = "idle";
      store.emit();
      return;
    }
    if (act === "confirm-ai-summarize") {
      const targetId = d.id || ui.activeLinkId;
      const reqId = (ui.aiRequestId || 0) + 1;
      ui.aiRequestId = reqId;
      ui.aiConfirmModalOpen = false;
      ui.aiSummaryStatus = "loading";
      store.emit();
      const res = await apiClient.summarizeLink(targetId, { forceRefresh: Boolean(d.forceRefresh) });
      if (ui.aiRequestId !== reqId || ui.activeLinkId !== targetId) return;
      ui.aiSummaryStatus = res.ok ? "success" : "error";
      store.showToast(res.ok ? "สรุปเนื้อหาด้วย AI สำเร็จ" : `สรุปไม่สำเร็จ: ${res.error || "ลองใหม่"}`);
      return;
    }
    if (act === "toggle-note-edit") {
      const item = getLinkById(d.id || ui.activeLinkId);
      ui.noteEditing = !ui.noteEditing;
      ui.noteDraft = item?.note || "";
      store.emit();
      return;
    }
    if (act === "save-note-inline") {
      const targetId = d.id || ui.activeLinkId;
      const updated = await apiClient.patchLink(targetId, { note: ui.noteDraft ?? "" });
      if (!updated) {
        store.showToast("บันทึกโน้ตไม่สำเร็จ กรุณาลองอีกครั้ง");
        return;
      }
      ui.noteEditing = false;
      store.showToast("บันทึกโน้ตแล้ว");
      return;
    }
    if (act === "cancel-note-edit") {
      ui.noteEditing = false;
      store.emit();
      return;
    }
    if (act === "toggle-tag-popover") {
      ui.tagPopoverOpen = !ui.tagPopoverOpen;
      ui.tagDraft = "";
      store.emit();
      return;
    }
    if (act === "add-tag-inline") {
      const item = getLinkById(d.id || ui.activeLinkId);
      const raw = (d.tag || ui.tagDraft || "").trim();
      if (item && raw) {
        const formatted = raw.startsWith("#") ? raw : `#${raw}`;
        const nextTags = item.tags.includes(formatted) ? item.tags : [...item.tags, formatted];
        const updated = await apiClient.patchLink(item.id, { tags: nextTags });
        if (!updated) {
          store.showToast("เพิ่มแท็กไม่สำเร็จ กรุณาลองอีกครั้ง");
          return;
        }
        ui.tagDraft = "";
        ui.tagPopoverOpen = false;
        store.showToast(`เพิ่มแท็ก ${formatted} แล้ว`);
      }
      return;
    }
    if (act === "remove-tag-inline") {
      const item = getLinkById(d.id || ui.activeLinkId);
      if (item && d.tag) {
        await apiClient.patchLink(item.id, { tags: item.tags.filter((t) => t !== d.tag) });
      }
      return;
    }
    if (act === "carousel-prev" || act === "carousel-next" || act === "carousel-dot") {
      const item = getLinkById(d.id || ui.activeLinkId);
      const total = item?.media_items?.length || 1;
      if (act === "carousel-dot") ui.carouselIndex = Number(d.index || 0) % total;
      else if (act === "carousel-prev") ui.carouselIndex = (ui.carouselIndex - 1 + total) % total;
      else ui.carouselIndex = (ui.carouselIndex + 1) % total;
      store.emit();
      return;
    }
    if (act === "play-embed-video") {
      ui.videoPlaying = true;
      store.emit();
      return;
    }
    if (act === "stop-embed-video") {
      ui.videoPlaying = false;
      store.emit();
      return;
    }
    if (act === "set-reminder-schedule-type" && ui.activeSheet?.type === "reminder") {
      const nextType = d.scheduleType === "every_n_days" ? "every_n_days" : "once";
      ui.reminderScheduleType = nextType;
      ui.activeSheet.scheduleType = nextType;
      if (nextType === "every_n_days" && !ui.activeSheet.repeatEveryDays) {
        ui.activeSheet.repeatEveryDays = ui.reminderRepeatDays || 3;
      }
      store.emit();
      return;
    }
    if (act === "step-reminder-repeat-days" && ui.activeSheet?.type === "reminder") {
      const nextDays = Math.max(1, Math.min(365, (Number(ui.activeSheet.repeatEveryDays || 3)) + Number(d.delta || 1)));
      ui.reminderRepeatDays = nextDays;
      ui.activeSheet.repeatEveryDays = nextDays;
      store.emit();
      return;
    }
    if (act === "set-share-permission" && ui.activeSheet?.type === "invite") {
      ui.sharePermission = d.role === "editor" ? "editor" : "viewer";
      ui.shareSheetState = "loading";
      store.emit();
      const res = await apiClient.createFolderInvite(ui.activeSheet.folderId, ui.sharePermission);
      ui.shareSheetState = res.ok ? "idle" : "error";
      store.emit();
      return;
    }
    if (act === "generate-share-link" && ui.activeSheet?.type === "invite") {
      ui.shareSheetState = "loading";
      store.emit();
      const res = await apiClient.createFolderInvite(ui.activeSheet.folderId, ui.sharePermission || "viewer");
      ui.shareSheetState = res.ok ? "idle" : "error";
      store.emit();
      return;
    }
  }

  // 1. Viewport & Inspector controls
  if (d.viewportSwitch) {
    store.setViewport(d.viewportSwitch, d.goScreen ? { screen: d.goScreen } : {});
    return;
  }
  if (d.toggleInspector) {
    ui.inspectorVisible = !ui.inspectorVisible;
    store.emit();
    return;
  }
  if (d.insTab) {
    ui.inspectorTab = d.insTab;
    store.emit();
    return;
  }
  if (d.quickJump) {
    if (d.quickJump === "saveSheet") {
      openSaveSheet();
      return;
    }
    if (d.quickJump === "reminderSheet") {
      if (store.navigate("linkDetail", { viewportMode: "mobile" })) {
        openReminderSheet(ui.activeLinkId);
      }
      return;
    }
    if (d.quickJump === "inviteSheet") {
      if (store.navigate("folderDetail", { viewportMode: "mobile" })) {
        ui.shareSheetState = "idle";
        store.openSheet({ type: "invite", folderId: ui.activeFolderId });
      }
      return;
    }
    store.navigate(d.quickJump, {
      viewportMode: "mobile",
      allowGuestSwitch: ["login", "emailLogin", "checkEmail", "inviteLanding"].includes(d.quickJump),
    });
    return;
  }

  // 2. Navigation
  if (d.nav) {
    store.navigate(d.nav, { viewportMode: "mobile" });
    return;
  }
  if (d.goScreen) {
    if (d.authCtx) ui.authContext = d.authCtx;
    else ui.authContext = "app";
    store.navigate(d.goScreen, {
      allowGuestSwitch: ui.authContext === "invite" || ["login", "emailLogin", "checkEmail"].includes(d.goScreen),
    });
    return;
  }
  if (d.openEditFolder) {
    e.stopPropagation();
    const folder = getFolderById(d.openEditFolder);
    if (folder) {
      store.openSheet({
        type: "editFolder",
        folderId: folder.id,
        nameDraft: folder.name,
        coverDraft: folder.cover,
      });
    }
    return;
  }
  if (d.openFolder) {
    store.navigate("folderDetail", { activeFolderId: d.openFolder });
    return;
  }
  if (d.openLink) {
    store.navigate("linkDetail", { activeLinkId: d.openLink });
    return;
  }
  if (d.openPreview) {
    ui.viewportMode = "mobile";
    store.navigate("savedPreview", { previewIndex: 0 });
    return;
  }

  // 3. Auth flows
  if (d.toggleAuthMode) {
    ui.authMode = ui.authMode === "login" ? "signup" : "login";
    ui.authError = null;
    store.emit();
    return;
  }
  if (d.oauthGoogle) {
    const res = await apiClient.signInGoogle();
    if (!res.ok) {
      store.showToast(res.error || "ไม่รองรับ Google OAuth ในการตั้งค่านี้");
      return;
    }
    if (res.data?.url && !res.isMock) {
      store.showToast("กำลังเปิดหน้าต่าง Google OAuth...");
      window.open(res.data.url, "_blank", "noopener,noreferrer");
      return;
    }
    completePostAuthNavigation(d.oauthGoogle === "invite" ? "inviteLanding" : "home");
    store.showToast("เข้าสู่ระบบด้วย Google สำเร็จ");
    return;
  }
  if (d.submitEmailLogin) {
    const email = (ui.authEmail || (api.useDevBypass ? data.user.email || "may@example.com" : "")).trim();
    if (!email) {
      ui.authError = "กรุณากรอกอีเมลก่อนดำเนินการต่อ";
      store.emit();
      store.showToast(ui.authError);
      return;
    }
    ui.authEmail = email;
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const res = await apiClient.signInEmail(email);
      if (!res.ok) {
        ui.authError = res.error || "ส่ง Magic Link ไม่สำเร็จ";
        store.emit();
        store.showToast(ui.authError);
        return;
      }
      store.showToast("ส่ง Magic Link จริงไปทางอีเมลแล้ว");
    }
    store.navigate("checkEmail", { allowGuestSwitch: true });
    return;
  }
  if (d.submitSignup) {
    const email = (ui.authEmail || "").trim();
    const password = ui.authPassword || "";
    const displayName = (ui.authDisplayName || "").trim();
    if (!email || !password || password.length < 8) {
      ui.authError = "กรุณากรอกอีเมลและรหัสผ่านอย่างน้อย 8 ตัวอักษร";
      store.emit();
      store.showToast(ui.authError);
      return;
    }
    const res = await apiClient.registerUser(email, password, displayName);
    if (!res.ok) {
      store.showToast(res.error || "สมัครสมาชิกไม่สำเร็จ");
      return;
    }
    if (res.data?.needs_email_confirmation) {
      store.navigate("checkEmail", { allowGuestSwitch: true });
      store.showToast("สมัครสำเร็จ! กรุณายืนยันอีเมลในกล่องข้อความ");
      return;
    }
    completePostAuthNavigation("home");
    store.showToast("สมัครใช้งานและเข้าสู่ระบบสำเร็จ");
    return;
  }
  if (d.submitPasswordLogin) {
    const email = (ui.authEmail || (api.useDevBypass ? data.user.email || "may@example.com" : "")).trim();
    const password = ui.authPassword || (api.useDevBypass ? "password123" : "");
    if (!email || !password) {
      ui.authError = "กรุณากรอกอีเมลและรหัสผ่านก่อนเข้าสู่ระบบ";
      store.emit();
      store.showToast(ui.authError);
      return;
    }
    const res = await apiClient.signInPassword(email, password);
    if (res.ok && hasValidSession(store.state)) {
      completePostAuthNavigation("home");
      store.showToast("เข้าสู่ระบบด้วยรหัสผ่านสำเร็จ");
    } else {
      store.showToast(res.error || "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    }
    return;
  }
  if (d.checkSupabaseSession) {
    const res = await apiClient.checkSupabaseSession();
    if (res.ok && hasValidSession(store.state)) {
      completePostAuthNavigation("home");
      store.showToast("ยืนยันเซสชัน Supabase สำเร็จ");
    } else {
      store.showToast(res.error || "ยังไม่มีเซสชันที่ยืนยันแล้ว");
    }
    return;
  }
  if (d.simulateMagicLink) {
    const res = await apiClient.signInEmail(ui.authEmail);
    if (res.ok && hasValidSession(store.state)) {
      completePostAuthNavigation(d.simulateMagicLink === "invite" ? "inviteLanding" : "home");
      store.showToast("ยืนยัน Magic Link สำเร็จ");
    } else {
      store.showToast(res.error || "ยืนยันไม่สำเร็จ");
    }
    return;
  }
  if (d.acceptInvite) {
    const joined = await apiClient.acceptInvite(d.acceptInvite);
    if (!joined) {
      store.showToast("ไม่สามารถเข้าร่วมโฟลเดอร์ได้ กรุณาตรวจสอบสิทธิ์หรือลองอีกครั้ง");
      return;
    }
    store.navigate("folderDetail", { activeFolderId: joined.id || d.acceptInvite });
    store.showToast(`เข้าร่วมโฟลเดอร์ "${joined.name || ""}" สำเร็จ`);
    return;
  }

  // 4. Home & Filters
  if (d.toggleNotifs) {
    ui.showNotifications = !ui.showNotifications;
    store.emit();
    return;
  }
  if (d.markNotifsRead) {
    data.notifications.forEach((n) => (n.unread = false));
    ui.showNotifications = false;
    store.emit();
    return;
  }
  if (d.filterChip) {
    if (d.filterScope === "dark") ui.folderDetailFilter = d.filterChip;
    else ui.homeFilter = d.filterChip;
    store.emit();
    return;
  }
  if (d.toggleFav) {
    const item = getLinkById(d.toggleFav);
    if (item) {
      const updated = await apiClient.patchLink(item.id, { favorite: !item.favorite });
      if (!updated) {
        store.showToast("อัปเดตรายการชื่นชอบไม่สำเร็จ");
        return;
      }
      store.showToast(item.favorite ? "เพิ่มในรายการชื่นชอบแล้ว" : "นำออกจากรายการชื่นชอบ");
    }
    return;
  }

  // 5. Post Menu & Delete Dialog
  if (d.openPostMenu) {
    store.openSheet({
      type: "postMenu",
      linkId: d.openPostMenu,
      folderContextId: d.menuFolder || null,
    });
    return;
  }
  if (d.closeSheet) {
    if (target.classList.contains("modal-backdrop") && e.target !== target) {
      return;
    }
    ui.simulatedSourceApp = null;
    store.closeSheet();
    return;
  }
  if (d.closeHostApp) {
    ui.simulatedSourceApp = null;
    store.emit();
    return;
  }
  if (d.togglePinLink && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.pinned = !ui.activeSheet.draft.pinned;
    store.emit();
    return;
  }
  if (d.toggleSaveAdvanced && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.showAdvanced = !ui.activeSheet.draft.showAdvanced;
    store.emit();
    return;
  }
  if (d.toggleStatusSheet) {
    const item = getLinkById(d.toggleStatusSheet);
    if (item) {
      const updated = await apiClient.patchLink(item.id, { status: item.status === "read" ? "unread" : "read" });
      if (!updated) {
        store.showToast("อัปเดตสถานะไม่สำเร็จ");
        return;
      }
      store.closeSheet();
    }
    return;
  }
  if (d.triggerAiSheet) {
    store.navigate("linkDetail", { activeLinkId: d.triggerAiSheet });
    await apiClient.summarizeLink(d.triggerAiSheet);
    return;
  }
  if (d.confirmDeletePost) {
    store.openSheet({
      type: "deletePostDialog",
      linkId: d.confirmDeletePost,
      mode: d.deleteMode || "delete",
      folderId: d.folderId || null,
    });
    return;
  }
  if (d.executeDeletePost) {
    await apiClient.deleteLink(d.executeDeletePost);
    store.closeSheet();
    store.showToast(d.deleteMode === "removeFromFolder" ? "นำโพสต์ออกจากโฟลเดอร์แล้ว" : "ลบโพสต์เรียบร้อย");
    return;
  }

  // 6. Save Link Sheet & Unfurl
  if (d.openSaveSheet) {
    const folderId = d.openSaveSheet === "1" ? ui.activeFolderId : d.openSaveSheet;
    openSaveSheet({ folderId });
    return;
  }
  if (d.runUnfurl && ui.activeSheet?.type === "saveLink") {
    const res = await apiClient.previewUrl(ui.activeSheet.draft.url);
    if (res.ok && res.data) {
      ui.activeSheet.draft.title = res.data.title || ui.activeSheet.draft.title;
      ui.activeSheet.draft.platform = res.data.platform || ui.activeSheet.draft.platform;
      ui.activeSheet.draft.domain = res.data.domain || ui.activeSheet.draft.domain;
      if (res.data.suggested_tags?.length) ui.activeSheet.draft.tags = [...res.data.suggested_tags];
      store.showToast("ดึงข้อมูลตัวอย่างลิงก์แล้ว");
    } else {
      store.showToast("ไม่สามารถดึงข้อมูลจาก Live /api/preview ได้");
    }
    return;
  }
  if (d.selectSaveFolder && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.folderId = d.selectSaveFolder;
    ui.folderPickerSheetOpen = false;
    store.emit();
    return;
  }
  if (d.toggleSaveTag && ui.activeSheet?.type === "saveLink") {
    const tags = ui.activeSheet.draft.tags;
    const i = tags.indexOf(d.toggleSaveTag);
    if (i >= 0) tags.splice(i, 1);
    else tags.push(d.toggleSaveTag);
    store.emit();
    return;
  }
  if (d.toggleDraftReminder && ui.activeSheet?.type === "saveLink") {
    ui.activeSheet.draft.reminder = ui.activeSheet.draft.reminder ? "" : "พรุ่งนี้ 18:00";
    ui.activeSheet.draft.reminderDate = ui.activeSheet.draft.reminder ? "2026-11-15" : null;
    store.emit();
    return;
  }
  if (d.submitSaveLink && ui.activeSheet?.type === "saveLink") {
    const draft = ui.activeSheet.draft;
    const created = await apiClient.createLink(draft);
    if (!created) return;
    ui.activeLinkId = created.id;
    window.__lastSharedHighlightId = created.id;
    ui.simulatedSourceApp = null;
    ui.addLinkExpanded = false;
    store.closeSheet();
    store.navigate("home", { viewportMode: ui.viewportMode === "web" ? "web" : "mobile" });
    store.showToast(`บันทึกลิงก์เข้าคอลเลกชันสำเร็จ! (${created.platform})`);
    return;
  }

  // 7. Link Detail, Tags, AI, Reminder, Saved Preview
  if (d.toggleVideoPlay) {
    ui.videoPlaying = !ui.videoPlaying;
    store.emit();
    return;
  }
  if (d.toggleSeen && target.tagName !== "INPUT") {
    const item = getLinkById(d.toggleSeen);
    if (item) await apiClient.patchLink(item.id, { status: item.status === "read" ? "unread" : "read" });
    return;
  }
  if (d.runAiSummarize) {
    const res = await apiClient.summarizeLink(d.runAiSummarize);
    if (res.ok) store.showToast("สรุปเนื้อหาด้วย AI สำเร็จ");
    else store.showToast(`AI Error: ${res.error || "ไม่สำเร็จ"}`);
    return;
  }
  if (d.openReminder) {
    openReminderSheet(d.openReminder);
    return;
  }
  if (d.selectCalDay && ui.activeSheet?.type === "reminder") {
    ui.activeSheet.day = Number(d.selectCalDay);
    store.emit();
    return;
  }
  if (d.calMonth && ui.activeSheet?.type === "reminder") {
    const months = [
      { label: "ตุลาคม 2569", ym: "2026-10" },
      { label: "พฤศจิกายน 2569", ym: "2026-11" },
      { label: "ธันวาคม 2569", ym: "2026-12" },
    ];
    const cur = Math.max(0, months.findIndex((m) => m.label === ui.activeSheet.monthLabel));
    const next = Math.max(0, Math.min(months.length - 1, cur + Number(d.calMonth)));
    ui.activeSheet.monthLabel = months[next].label;
    ui.activeSheet.yearMonth = months[next].ym;
    store.emit();
    return;
  }
  if (d.clearReminder) {
    const res = await apiClient.deleteReminder(d.clearReminder);
    if (res && !res.ok && store.state.api.mode === "live") {
      store.showToast(res.error || "ลบการตั้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง");
      return;
    }
    store.closeSheet();
    store.showToast("ลบการตั้งเตือนแล้ว");
    return;
  }
  if (d.saveReminder && ui.activeSheet?.type === "reminder") {
    const scheduleType = ui.activeSheet.scheduleType || ui.reminderScheduleType || "once";
    const repeatEveryDays = scheduleType === "every_n_days" ? Number(ui.activeSheet.repeatEveryDays || ui.reminderRepeatDays || 3) : null;
    const ym = ui.activeSheet.yearMonth || "2026-11";
    const dateStr = `${ym}-${String(ui.activeSheet.day || 15).padStart(2, "0")}`;
    const res = await apiClient.saveReminder(d.saveReminder, {
      scheduleType,
      reminderDate: dateStr,
      reminderTime: ui.activeSheet.time || "18:00",
      repeatEveryDays,
    });
    if (res && !res.ok && store.state.api.mode === "live") {
      store.showToast(res.error || "ตั้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง");
      return;
    }
    const label = scheduleType === "every_n_days" ? `ทุก ${repeatEveryDays} วัน ${ui.activeSheet.time}` : `วันที่ ${ui.activeSheet.day} · ${ui.activeSheet.time}`;
    store.closeSheet();
    store.showToast(`ตั้งเตือน ${label} เรียบร้อย`);
    return;
  }
  if (d.previewMarkRead) {
    const updated = await apiClient.patchLink(d.previewMarkRead, { status: "read" });
    if (!updated) {
      store.showToast("อัปเดตสถานะไม่สำเร็จ");
      return;
    }
    store.showToast("ทำเครื่องหมายว่าดูแล้ว");
    return;
  }
  if (d.previewStep) {
    ui.previewIndex = Math.max(0, ui.previewIndex + Number(d.previewStep));
    store.emit();
    return;
  }

  // 8. Folders Edit, Cover Picker, Invite
  if (d.openCreateFolder) {
    store.openSheet({
      type: "createFolder",
      nameDraft: "",
      coverDraft: COVER_CHOICES[3].src,
    });
    return;
  }
  if (d.suggestFolderName && ui.activeSheet) {
    const pick = FOLDER_NAME_SUGGESTIONS[Math.floor(Math.random() * FOLDER_NAME_SUGGESTIONS.length)];
    ui.activeSheet.nameDraft = pick;
    store.emit();
    return;
  }
  if (d.openPickCover && ui.activeSheet) {
    store.openSheet({
      type: "pickCover",
      folderId: ui.activeSheet.folderId || null,
      returnSheet: { ...ui.activeSheet },
    });
    return;
  }
  if (d.selectCover && ui.activeSheet?.type === "pickCover") {
    ui.activeSheet.returnSheet.coverDraft = d.selectCover;
    store.openSheet(ui.activeSheet.returnSheet);
    return;
  }
  if (d.backToFolderEdit && ui.activeSheet?.type === "pickCover") {
    store.openSheet(ui.activeSheet.returnSheet);
    return;
  }
  if (d.saveFolderSheet && ui.activeSheet) {
    const cleanName = (ui.activeSheet.nameDraft || "").trim() || "โฟลเดอร์ใหม่";
    const saved = await apiClient.saveFolder({
      folderId: ui.activeSheet.folderId || null,
      name: cleanName,
      cover: ui.activeSheet.coverDraft,
    });
    if (saved) ui.activeFolderId = saved.id;
    store.closeSheet();
    store.showToast("บันทึกโฟลเดอร์เรียบร้อย");
    return;
  }
  if (d.openInviteSheet) {
    const folderId = d.openInviteSheet;
    ui.shareSheetState = "loading";
    store.openSheet({ type: "invite", folderId });
    const res = await apiClient.createFolderInvite(folderId, ui.sharePermission || "viewer").catch(() => ({ ok: false }));
    if (ui.activeSheet?.type === "invite" && ui.activeSheet?.folderId === folderId) {
      ui.shareSheetState = res.ok ? "idle" : "error";
      store.emit();
    }
    return;
  }
  if (d.copyInvite) {
    copyText(d.copyInvite);
    store.showToast("คัดลอกลิงก์คำเชิญแล้ว");
    return;
  }
  if (d.openInviteApps) {
    store.openSheet({ type: "inviteShareApp", folderId: d.openInviteApps });
    return;
  }
  if (d.openInvitePreview) {
    store.openSheet({
      type: "invitePreview",
      folderId: d.openInvitePreview,
      appName: d.shareApp || "LINE",
    });
    return;
  }
  if (d.previewRecipientInvite) {
    store.navigate("inviteLanding", { inviteFolderId: d.previewRecipientInvite });
    return;
  }

  // 9. AI Screen
  if (d.toggleAiDropdown) {
    ui.aiDropdown = ui.aiDropdown === d.toggleAiDropdown ? null : d.toggleAiDropdown;
    store.emit();
    return;
  }
  if (d.selectAiProvider) {
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === d.selectAiProvider);
    data.aiConfig.provider = d.selectAiProvider;
    data.aiConfig.model = preset?.models[0] || "";
    data.aiConfig.endpointUrl = preset?.baseUrl || "";
    ui.aiDropdown = null;
    store.emit();
    return;
  }
  if (d.selectAiModel) {
    data.aiConfig.model = d.selectAiModel;
    ui.aiDropdown = null;
    store.emit();
    return;
  }
  if (d.toggleAiKeyless) {
    data.aiConfig.keyless = !data.aiConfig.keyless;
    store.emit();
    return;
  }
  if (d.saveAiConfig) {
    data.aiConfig.connected = true;
    data.aiConfig.lastTestedAt = new Date().toISOString();
    store.emit();
    store.showToast(`บันทึกการเชื่อมต่อ ${data.aiConfig.provider} แล้ว`);
    return;
  }

  // 10. Profile, Appearance, Security, Help, Export, Logout
  if (d.openEditNickname) {
    store.openSheet({ type: "editNickname", value: data.user.displayName });
    return;
  }
  if (d.saveNickname && ui.activeSheet?.type === "editNickname") {
    const val = (ui.activeSheet.value || "").trim();
    if (val) data.user.displayName = val;
    store.closeSheet();
    store.showToast("อัปเดตชื่อเล่นเรียบร้อย");
    return;
  }
  if (d.toggleNotifSetting) {
    data.user.notificationsEnabled = !data.user.notificationsEnabled;
    store.emit();
    store.showToast(data.user.notificationsEnabled ? "เปิดการแจ้งเตือนแล้ว" : "ปิดการแจ้งเตือนแล้ว");
    return;
  }
  if (d.setTextSize) {
    data.appearance.textSize = d.setTextSize;
    store.emit();
    return;
  }
  if (d.setTheme) {
    data.appearance.theme = d.setTheme;
    store.emit();
    return;
  }
  if (d.updateAccountEmail) {
    const input = document.getElementById("newEmailInput");
    const val = input?.value?.trim();
    if (!val) {
      store.showToast("กรุณากรอกอีเมลใหม่");
      return;
    }
    const res = await apiClient.updateAccountEmail(val);
    store.showToast(res.ok ? "อัปเดตอีเมลบัญชีเรียบร้อย" : `❌ ${res.error}`);
    return;
  }
  if (d.sendPasswordReset) {
    const res = await apiClient.sendPasswordReset(data.user.email);
    store.showToast(
      res.ok ? `ส่งลิงก์ตั้งรหัสผ่านไปที่ ${data.user.email} แล้ว` : `❌ ${res.error}`
    );
    return;
  }
  if (d.submitSupport) {
    const topic = document.getElementById("supportTopicInput")?.value?.trim() || "รายงานจาก Web Testbed";
    const detail = document.getElementById("supportDetailInput")?.value?.trim() || "ทดสอบการส่งรายงาน";
    await apiClient.submitSupportReport({ topic, detail });
    store.showToast("ส่งรายงานปัญหาเรียบร้อย ขอบคุณครับ");
    store.navigate("profile");
    return;
  }
  if (d.openExportCsv) {
    store.openSheet({ type: "exportCsv" });
    return;
  }
  if (d.downloadCsv) {
    const headers = ["title", "url", "platform", "folder", "status", "favorite", "tags", "note", "reminder", "ai_summary"];
    const rows = data.links.map((item) => {
      const f = getFolderById(item.folderId)?.name || "";
      return [
        item.title,
        item.url,
        item.platform,
        f,
        item.status,
        item.favorite ? "yes" : "no",
        (item.tags || []).join(" "),
        item.note || "",
        item.reminder || "",
        item.aiSummary || "",
      ]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(",");
    });
    const csv = "\uFEFF" + [headers.join(","), ...rows].join("\n");
    downloadFile("sharely-links-export.csv", csv, "text/csv;charset=utf-8");
    store.closeSheet();
    store.showToast("ส่งออกไฟล์ CSV เรียบร้อย");
    return;
  }
  if (d.openLogoutDialog) {
    store.openSheet({ type: "logoutDialog" });
    return;
  }
  if (d.confirmLogout) {
    await apiClient.signOut();
    return;
  }

  // 11. W1 Web & E1 Extension
  if (d.webScope) {
    ui.webScope = d.webScope;
    ui.notificationScreenOpen = false;
    ui.showNotifications = false;
    store.emit();
    return;
  }
  if (d.webFolder) {
    ui.webScope = "folder";
    ui.activeFolderId = d.webFolder;
    ui.notificationScreenOpen = false;
    ui.showNotifications = false;
    store.emit();
    return;
  }
  if (d.selectWebLink) {
    ui.activeLinkId = d.selectWebLink;
    ui.carouselIndex = 0;
    ui.videoPlaying = false;
    ui.noteEditing = false;
    ui.tagPopoverOpen = false;
    store.emit();
    return;
  }
  if (d.extUnfurl) {
    ui.extensionDraft = ui.extensionDraft || { url: "https://www.tiktok.com/@minimal.ari/video/74009911", folderId: data.folders[0]?.id, tags: ["#คาเฟ่"], note: "" };
    const res = await apiClient.previewUrl(ui.extensionDraft.url);
    if (res.ok && res.data) {
      ui.extensionDraft.title = res.data.title;
      ui.extensionDraft.platform = res.data.platform;
      ui.extensionDraft.domain = res.data.domain;
    }
    store.emit();
    return;
  }
  if (d.extFolder) {
    ui.extensionDraft = ui.extensionDraft || { tags: ["#คาเฟ่"], note: "", url: "https://www.tiktok.com/@minimal.ari/video/74009911", title: "คาเฟ่สายมินิมอลอารีย์", domain: "tiktok.com" };
    ui.extensionDraft.folderId = d.extFolder;
    store.emit();
    return;
  }
  if (d.extTag) {
    ui.extensionDraft = ui.extensionDraft || { tags: ["#คาเฟ่"], note: "", folderId: data.folders[0]?.id, url: "https://www.tiktok.com/@minimal.ari/video/74009911", title: "คาเฟ่สายมินิมอลอารีย์", domain: "tiktok.com" };
    const i = ui.extensionDraft.tags.indexOf(d.extTag);
    if (i >= 0) ui.extensionDraft.tags.splice(i, 1);
    else ui.extensionDraft.tags.push(d.extTag);
    store.emit();
    return;
  }
  if (d.extToggleReminder) {
    ui.extensionDraft = ui.extensionDraft || { tags: ["#คาเฟ่"], note: "", folderId: data.folders[0]?.id, url: "https://www.tiktok.com/@minimal.ari/video/74009911", title: "คาเฟ่สายมินิมอลอารีย์", domain: "tiktok.com" };
    const enabled = !ui.extensionDraft.reminder;
    ui.extensionDraft.reminder = enabled ? "พรุ่งนี้ 18:00" : "";
    ui.extensionDraft.reminderDate = enabled ? "2026-11-15" : null;
    ui.extensionDraft.reminderTime = enabled ? "18:00" : null;
    store.emit();
    return;
  }
  if (d.extSubmit) {
    const ext = ui.extensionDraft || {
      url: "https://www.tiktok.com/@minimal.ari/video/74009911",
      title: "คาเฟ่สายมินิมอลอารีย์",
      folderId: data.folders[0]?.id,
      tags: ["#คาเฟ่"],
      note: "",
    };
    const created = await apiClient.createLink(ext);
    if (!created) return;
    ui.activeLinkId = created.id;
    ui.viewportMode = "mobile";
    store.navigate("home");
    store.showToast("บันทึกจาก Extension เรียบร้อย");
    return;
  }

  // 12. Testbed Controls & MCP
  if (d.setApiMode) {
    api.mode = d.setApiMode;
    if (d.setApiMode === "live" && api.authProvider === "mock") {
      api.authProvider = "backend";
    } else if (d.setApiMode === "mock" && api.authProvider === "backend") {
      api.authProvider = "mock";
    }
    if (
      ui.authGuardEnabled !== false &&
      !hasValidSession(store.state) &&
      (isProtectedScreen(ui.screen) || isProtectedViewport(ui.viewportMode))
    ) {
      store.navigate(ui.screen, { viewportMode: ui.viewportMode });
    } else {
      store.emit();
    }
    return;
  }
  if (d.setAuthProvider) {
    api.authProvider = d.setAuthProvider;
    if (d.setAuthProvider === "backend") {
      api.mode = "live";
    } else if (d.setAuthProvider === "mock") {
      api.mode = "mock";
    }
    if (
      ui.authGuardEnabled !== false &&
      !hasValidSession(store.state) &&
      (isProtectedScreen(ui.screen) || isProtectedViewport(ui.viewportMode))
    ) {
      store.navigate(ui.screen, { viewportMode: ui.viewportMode });
    } else {
      store.emit();
    }
    return;
  }
  if (d.pingHealth) {
    await apiClient.checkHealth();
    return;
  }
  if (d.tbTestAuth) {
    const act = d.tbTestAuth;
    if (act === "loginPassword") {
      const email = ui.authEmail || (api.useDevBypass ? data.user.email || "may@example.com" : "");
      const password = ui.authPassword || (api.useDevBypass ? "password123" : "");
      if (!email || !password) {
        store.showToast("❌ กรุณากรอกอีเมลและรหัสผ่านจริงในหน้า Cloud");
        return;
      }
      const res = await apiClient.signInPassword(email, password);
      if (res.ok && hasValidSession(store.state)) {
        completePostAuthNavigation("home");
      }
      store.showToast(res.ok ? "🔑 Login รหัสผ่านสำเร็จ" : `❌ ${res.error}`);
    } else if (act === "magicLink") {
      const email = ui.authEmail || (api.useDevBypass ? data.user.email || "may@example.com" : "");
      if (!email) {
        store.showToast("❌ กรุณากรอกอีเมลจริงในหน้า Cloud");
        return;
      }
      const res = await apiClient.signInEmail(email);
      if (res.ok && hasValidSession(store.state)) {
        completePostAuthNavigation("home");
      }
      store.showToast(res.ok ? "✉️ ส่ง Magic Link สำเร็จ" : `❌ ${res.error}`);
    } else if (act === "getMe") {
      const res = await apiClient.getMe();
      store.showToast(res.ok ? `👤 ${res.data.display_name || res.data.email} (${res.data.email})` : `❌ ${res.error}`);
    } else if (act === "testProtectedRoute") {
      const guardBlocked = !store.navigate("folders", { viewportMode: "mobile" });
      const res = await apiClient.probeProtectedRoute();
      if (guardBlocked || res.status === 401) {
        store.showToast(`🛡️ Protected Route ป้องกันสำเร็จ (HTTP ${res.status} / Guard Redirect)`);
      } else {
        store.showToast(`✅ Protected Route อนุญาต (HTTP ${res.status})`);
      }
    } else if (act === "refreshToken") {
      const res = await apiClient.refreshSession();
      store.showToast(res.ok ? "🔄 Refresh Session JWT สำเร็จ" : `❌ ${res.error}`);
    } else if (act === "googleOauth") {
      const res = await apiClient.signInGoogle();
      store.showToast(res.ok ? "🌐 ขอ Google OAuth URL สำเร็จ" : `❌ ${res.error}`);
    } else if (act === "createToken") {
      const res = await apiClient.createMcpToken("Claude Desktop Test");
      store.showToast(res.ok ? `🎟️ MCP Token: ${res.data.token_prefix}` : `❌ ${res.error}`);
    } else if (act === "logout") {
      await apiClient.signOut();
      store.showToast("🚪 ออกจากระบบและล็อก Protected Routes แล้ว");
    }
    return;
  }
  if (d.toggleHostBackdrop) {
    const isChecked = target.checked;
    if (isChecked) {
      ui.simulatedSourceApp = "tiktok";
    } else {
      ui.simulatedSourceApp = null;
    }
    store.emit();
    return;
  }
  if (d.simSharePreset) {
    const withBackdrop = document.getElementById("tbToggleHostBackdrop")?.checked ?? true;
    const folderId = data.folders[0]?.id; // 'ยังไม่จัดหมวด'

    if (d.simSharePreset === "tiktok") {
      openSaveSheet({
        url: "https://vt.tiktok.com/ZSjXample/",
        title: "TikTok - Make Your Day",
        domain: "vt.tiktok.com",
        platform: "TikTok",
        folderId,
        pinned: false,
        simulatedSourceApp: withBackdrop ? "tiktok" : null,
      });
    } else if (d.simSharePreset === "instagram") {
      openSaveSheet({
        url: "https://www.instagram.com/reel/C8cafeAri99",
        title: "คาเฟ่น่านั่งย่านอารีย์ 2026",
        domain: "instagram.com",
        platform: "Instagram",
        folderId: data.folders[1]?.id || folderId,
        pinned: true,
        simulatedSourceApp: withBackdrop ? "instagram" : null,
      });
    } else if (d.simSharePreset === "youtube") {
      openSaveSheet({
        url: "https://www.youtube.com/watch?v=japanGuide2026",
        title: "เที่ยวญี่ปุ่น 7 วัน โตเกียว-เกียวโต",
        domain: "youtube.com",
        platform: "YouTube",
        folderId: data.folders[2]?.id || folderId,
        pinned: false,
        simulatedSourceApp: withBackdrop ? "youtube" : null,
      });
    } else if (d.simSharePreset === "twitter") {
      openSaveSheet({
        url: "https://x.com/tech_trends/status/178000",
        title: "สรุปข่าวเทคโนโลยี & Generative AI",
        domain: "x.com",
        platform: "X",
        folderId,
        pinned: false,
        simulatedSourceApp: withBackdrop ? "twitter" : null,
      });
    }
    return;
  }
  if (d.simCustomShare) {
    const titleVal = document.getElementById("customShareTitle")?.value?.trim() || "โพสต์ที่แชร์เข้ามา";
    const urlVal = document.getElementById("customShareUrl")?.value?.trim() || "https://vt.tiktok.com/ZSjXample/";
    const withBackdrop = document.getElementById("tbToggleHostBackdrop")?.checked ?? false;
    const { platform, domain } = inferPlatform(urlVal);

    openSaveSheet({
      url: urlVal,
      title: titleVal,
      domain,
      platform,
      folderId: data.folders[0]?.id,
      pinned: false,
      simulatedSourceApp: withBackdrop ? (platform.toLowerCase() === "tiktok" ? "tiktok" : "instagram") : null,
    });
    return;
  }
  if (d.simShareIntent) {
    if (d.simShareIntent === "youtube") {
      openSaveSheet({
        url: "https://www.youtube.com/watch?v=japanGuide2026",
        title: "เที่ยวญี่ปุ่น 7 วัน โตเกียว-เกียวโต",
        tags: ["#ญี่ปุ่น", "#แพลนเที่ยว"],
      });
    } else {
      openSaveSheet({
        url: "https://vt.tiktok.com/ZSjXample/",
        title: "TikTok - Make Your Day",
        domain: "vt.tiktok.com",
        tags: ["#วิดีโอสั้น"],
      });
    }
    return;
  }
  if (d.simOpenInvite) {
    ui.viewportMode = "mobile";
    store.navigate("inviteLanding", { inviteFolderId: data.folders[0]?.id });
    return;
  }
  if (d.exportJsonState) {
    downloadFile("sharely-testbed-state.json", JSON.stringify(data, null, 2), "application/json");
    return;
  }
  if (d.resetSeed) {
    store.resetSeed();
    return;
  }
  if (d.clearLogs) {
    api.logs = [];
    store.emit();
    return;
  }
  if (d.runMcpTool) {
    await apiClient.testMcpTool(d.runMcpTool);
    return;
  }
});

// Initialize
store.applyAppearanceToDom();
if (
  store.state.ui.authGuardEnabled !== false &&
  !hasValidSession(store.state) &&
  (isProtectedScreen(store.state.ui.screen) || isProtectedViewport(store.state.ui.viewportMode))
) {
  store.state.ui.viewportMode = "mobile";
  store.state.ui.screen = "login";
}
store.subscribe(renderApp);
renderApp();

// Hydrate health and live backend workspace cleanly in background
apiClient
  .checkHealth()
  .then((res) => {
    if (res?.ok && store.state.data.user?.isAuthenticated) {
      return apiClient.hydrateWorkspace();
    }
    return null;
  })
  .catch(() => {});

// Hydrate & listen for live Supabase Auth session / OAuth / Magic-Link callbacks
supabaseAuth
  .init(
    {
      supabaseUrl: store.state.api.supabaseUrl,
      supabaseAnonKey: store.state.api.supabaseAnonKey,
    },
    ({ event, session, claims, user }) => {
      if (event === "SIGNED_OUT") {
        if (getAuthMode(store.state) === "supabase") {
          store.clearSession({ redirectToLogin: store.state.ui.authGuardEnabled !== false });
        }
        return;
      }
      if (session?.access_token) {
        store.state.api.authProvider = "supabase";
        store.applyAuthenticatedSession({
          user,
          accessToken: session.access_token,
          refreshToken: session.refresh_token || "",
          claims,
        });
        if (["login", "emailLogin", "checkEmail"].includes(store.state.ui.screen)) {
          completePostAuthNavigation("home");
        }
      }
    }
  )
  .then(({ session, claims, user }) => {
    if (session?.access_token) {
      store.state.api.authProvider = "supabase";
      store.applyAuthenticatedSession({
        user,
        accessToken: session.access_token,
        refreshToken: session.refresh_token || "",
        claims,
      });
      if (["login", "emailLogin", "checkEmail"].includes(store.state.ui.screen)) {
        completePostAuthNavigation("home");
      }
    }
  })
  .catch(() => {});
