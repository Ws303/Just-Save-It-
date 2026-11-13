/**
 * Application Entrypoint, Event Dispatcher & Focus-Preserving Renderer for Sharely Test Web App.
 */
import { AI_PROVIDER_PRESETS, COVER_CHOICES, FOLDER_NAME_SUGGESTIONS } from "./data/seed.js";
import { store, inferPlatform, getFolderById, getLinkById } from "./state/store.js";
import { apiClient } from "./services/apiClient.js";
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

function renderViewportContent(state) {
  if (state.ui.viewportMode === "web") {
    return renderWebView(state);
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

  return `
    <div class="phone-bezel">
      <main class="phone-frame" aria-label="Sharely App Preview">
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

  const quickButtons = [
    { id: "login", label: "10 Login" },
    { id: "home", label: "11 Home" },
    { id: "folders", label: "14 Folders" },
    { id: "folderDetail", label: "15 Folder Detail" },
    { id: "saveSheet", label: "1 Save Link" },
    { id: "linkDetail", label: "5 Link Detail" },
    { id: "reminderSheet", label: "6 Reminder" },
    { id: "savedPreview", label: "7 Preview" },
    { id: "ai", label: "18 AI Config" },
    { id: "profile", label: "19 Profile" },
    { id: "display", label: "20 Themes" },
    { id: "inviteLanding", label: "23 Invite" },
    { id: "inviteSheet", label: "24 Share" },
  ];

  appEl.innerHTML = `
    <div class="tb-root">
      <header class="tb-topbar">
        <div class="tb-brand">
          <span style="color:var(--theme-swatch);display:inline-flex;">${icons.cherry(22)}</span>
          <span class="tb-brand-logo">Sharely</span>
          <span class="tb-pill-badge">Interactive UI & Backend Testbed</span>
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
            ${state.ui.inspectorVisible ? "ซ่อน Testbed Panel" : "แสดง Testbed Panel"}
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
                return `<button class="tb-qbtn ${isActive ? "active" : ""}" data-quick-jump="${b.id}">${b.label}</button>`;
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
  const url = prefill.url || "https://www.tiktok.com/@minimal.ari/video/74009911";
  const { platform, domain } = inferPlatform(url);

  store.state.ui.viewportMode = "mobile";
  if (!["home", "folders", "folderDetail", "linkDetail"].includes(state.ui.screen)) {
    state.ui.screen = "home";
  }
  store.openSheet({
    type: "saveLink",
    draft: {
      url,
      platform,
      domain,
      title: prefill.title || "คาเฟ่สายมินิมอลอารีย์",
      folderId,
      tags: prefill.tags || ["#คาเฟ่"],
      note: prefill.note || "",
      reminder: "",
      reminderDate: null,
      reminderTime: "18:00",
    },
  });
}

function openReminderSheet(linkId) {
  const item = getLinkById(linkId) || store.state.data.links[0];
  store.openSheet({
    type: "reminder",
    linkId: item.id,
    day: 12,
    monthLabel: "พฤศจิกายน 2569",
    time: item.reminderTime || "18:00",
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
  } else if (el.dataset.bindEmailLogin) {
    ui.authEmail = el.value;
  } else if (el.dataset.editNote) {
    const item = getLinkById(el.dataset.editNote);
    if (item) {
      item.note = el.value;
      store.save();
    }
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
  } else if (el.dataset.bindNewTag && ui.activeSheet?.type === "addTag") {
    ui.activeSheet.value = el.value;
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
  } else if (el.dataset.toggleSeen) {
    apiClient.patchLink(el.dataset.toggleSeen, { status: el.checked ? "read" : "unread" });
  }
});

// =========================================================
// DELEGATED CLICK HANDLERS
// =========================================================
appEl.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-viewport-switch],[data-toggle-inspector],[data-ins-tab],[data-quick-jump],[data-nav],[data-go-screen],[data-open-folder],[data-open-edit-folder],[data-open-link],[data-open-preview],[data-toggle-auth-mode],[data-oauth-google],[data-submit-email-login],[data-simulate-magic-link],[data-accept-invite],[data-toggle-notifs],[data-mark-notifs-read],[data-filter-chip],[data-toggle-fav],[data-open-post-menu],[data-close-sheet],[data-toggle-status-sheet],[data-trigger-ai-sheet],[data-confirm-delete-post],[data-execute-delete-post],[data-open-save-sheet],[data-run-unfurl],[data-select-save-folder],[data-toggle-save-tag],[data-toggle-draft-reminder],[data-submit-save-link],[data-toggle-video-play],[data-toggle-seen],[data-run-ai-summarize],[data-remove-tag],[data-open-add-tag],[data-save-new-tag],[data-open-reminder],[data-cal-month],[data-select-cal-day],[data-clear-reminder],[data-save-reminder],[data-preview-mark-read],[data-preview-step],[data-open-create-folder],[data-suggest-folder-name],[data-open-pick-cover],[data-select-cover],[data-back-to-folder-edit],[data-save-folder-sheet],[data-open-invite-sheet],[data-copy-invite],[data-open-invite-apps],[data-open-invite-preview],[data-preview-recipient-invite],[data-toggle-ai-dropdown],[data-select-ai-provider],[data-select-ai-model],[data-toggle-ai-keyless],[data-save-ai-config],[data-open-edit-nickname],[data-save-nickname],[data-toggle-notif-setting],[data-set-text-size],[data-set-theme],[data-update-account-email],[data-send-password-reset],[data-submit-support],[data-open-export-csv],[data-download-csv],[data-open-logout-dialog],[data-confirm-logout],[data-web-scope],[data-web-folder],[data-select-web-link],[data-ext-unfurl],[data-ext-folder],[data-ext-tag],[data-ext-toggle-reminder],[data-ext-submit],[data-set-api-mode],[data-ping-health],[data-sim-share-intent],[data-sim-open-invite],[data-export-json-state],[data-reset-seed],[data-clear-logs],[data-run-mcp-tool]");
  if (!target) return;

  const d = target.dataset;
  const { ui, data, api } = store.state;

  // 1. Viewport & Inspector controls
  if (d.viewportSwitch) {
    ui.viewportMode = d.viewportSwitch;
    if (d.goScreen) ui.screen = d.goScreen;
    store.emit();
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
    ui.viewportMode = "mobile";
    if (d.quickJump === "saveSheet") {
      openSaveSheet();
      return;
    }
    if (d.quickJump === "reminderSheet") {
      ui.screen = "linkDetail";
      openReminderSheet(ui.activeLinkId);
      return;
    }
    if (d.quickJump === "inviteSheet") {
      ui.screen = "folderDetail";
      store.openSheet({ type: "invite", folderId: ui.activeFolderId });
      return;
    }
    store.navigate(d.quickJump);
    return;
  }

  // 2. Navigation
  if (d.nav) {
    store.navigate(d.nav);
    return;
  }
  if (d.goScreen) {
    if (d.authCtx) ui.authContext = d.authCtx;
    else ui.authContext = "app";
    store.navigate(d.goScreen);
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
    store.emit();
    return;
  }
  if (d.oauthGoogle) {
    await apiClient.signInGoogle();
    if (d.oauthGoogle === "invite") {
      store.navigate("inviteLanding");
    } else {
      store.navigate("home");
    }
    store.showToast("เข้าสู่ระบบด้วย Google สำเร็จ");
    return;
  }
  if (d.submitEmailLogin) {
    if (!ui.authEmail) ui.authEmail = data.user.email || "may@example.com";
    store.navigate("checkEmail");
    return;
  }
  if (d.simulateMagicLink) {
    await apiClient.signInEmail(ui.authEmail);
    store.navigate(d.simulateMagicLink === "invite" ? "inviteLanding" : "home");
    store.showToast("ยืนยัน Magic Link สำเร็จ");
    return;
  }
  if (d.acceptInvite) {
    const joined = await apiClient.acceptInvite(d.acceptInvite);
    store.navigate("folderDetail", { activeFolderId: joined?.id || d.acceptInvite });
    store.showToast(`เข้าร่วมโฟลเดอร์ "${joined?.name || ""}" สำเร็จ`);
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
      await apiClient.patchLink(item.id, { favorite: !item.favorite });
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
    store.closeSheet();
    return;
  }
  if (d.toggleStatusSheet) {
    const item = getLinkById(d.toggleStatusSheet);
    if (item) {
      await apiClient.patchLink(item.id, { status: item.status === "read" ? "unread" : "read" });
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
    ui.activeSheet.draft.reminderDate = ui.activeSheet.draft.reminder ? "2026-11-12" : null;
    store.emit();
    return;
  }
  if (d.submitSaveLink && ui.activeSheet?.type === "saveLink") {
    const created = await apiClient.createLink(ui.activeSheet.draft);
    ui.activeLinkId = created.id;
    store.closeSheet();
    store.showToast("บันทึกลิงก์เข้าคลังแล้ว");
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
  if (d.removeTag) {
    const item = getLinkById(d.linkId);
    if (item) {
      item.tags = item.tags.filter((t) => t !== d.removeTag);
      store.emit();
    }
    return;
  }
  if (d.openAddTag) {
    store.openSheet({ type: "addTag", linkId: d.openAddTag, value: "" });
    return;
  }
  if (d.saveNewTag && ui.activeSheet?.type === "addTag") {
    const raw = (ui.activeSheet.value || "").trim();
    const item = getLinkById(d.saveNewTag);
    if (raw && item) {
      const formatted = raw.startsWith("#") ? raw : `#${raw}`;
      if (!item.tags.includes(formatted)) item.tags.push(formatted);
    }
    store.closeSheet();
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
    const months = ["ตุลาคม 2569", "พฤศจิกายน 2569", "ธันวาคม 2569"];
    const cur = Math.max(0, months.indexOf(ui.activeSheet.monthLabel));
    const next = Math.max(0, Math.min(months.length - 1, cur + Number(d.calMonth)));
    ui.activeSheet.monthLabel = months[next];
    store.emit();
    return;
  }
  if (d.clearReminder) {
    await apiClient.patchLink(d.clearReminder, { reminder: null, reminderDate: null });
    store.closeSheet();
    store.showToast("ลบการตั้งเตือนแล้ว");
    return;
  }
  if (d.saveReminder && ui.activeSheet?.type === "reminder") {
    const label = `${ui.activeSheet.day === 12 ? "พรุ่งนี้" : `วันที่ ${ui.activeSheet.day}`} ${ui.activeSheet.time}`;
    await apiClient.patchLink(d.saveReminder, {
      reminder: label,
      reminderDate: `2026-11-${String(ui.activeSheet.day).padStart(2, "0")}`,
      reminderTime: ui.activeSheet.time,
    });
    store.closeSheet();
    store.showToast(`ตั้งเตือน ${label} เรียบร้อย`);
    return;
  }
  if (d.previewMarkRead) {
    await apiClient.patchLink(d.previewMarkRead, { status: "read" });
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
    store.openSheet({ type: "invite", folderId: d.openInviteSheet });
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
    data.user.email = val;
    store.emit();
    store.showToast("อัปเดตอีเมลบัญชีเรียบร้อย");
    return;
  }
  if (d.sendPasswordReset) {
    await apiClient.signInEmail(data.user.email);
    store.showToast(`ส่งลิงก์ตั้งรหัสผ่านไปที่ ${data.user.email} แล้ว`);
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
    store.navigate("login");
    return;
  }

  // 11. W1 Web & E1 Extension
  if (d.webScope) {
    ui.webScope = d.webScope;
    store.emit();
    return;
  }
  if (d.webFolder) {
    ui.webScope = "folder";
    ui.activeFolderId = d.webFolder;
    store.emit();
    return;
  }
  if (d.selectWebLink) {
    ui.activeLinkId = d.selectWebLink;
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
    ui.extensionDraft.reminder = ui.extensionDraft.reminder ? "" : "พรุ่งนี้ 18:00";
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
    ui.activeLinkId = created.id;
    ui.viewportMode = "mobile";
    store.navigate("home");
    store.showToast("บันทึกจาก Extension เรียบร้อย");
    return;
  }

  // 12. Testbed Controls & MCP
  if (d.setApiMode) {
    api.mode = d.setApiMode;
    store.emit();
    return;
  }
  if (d.pingHealth) {
    await apiClient.checkHealth();
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
        url: "https://www.tiktok.com/@cafe.bkk/video/74100233",
        title: "คาเฟ่เปิดใหม่ย่านบรรทัดทอง",
        tags: ["#คาเฟ่"],
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
store.subscribe(renderApp);
renderApp();
