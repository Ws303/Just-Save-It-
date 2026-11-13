/**
 * Reactive state store for the Sharely Test Web Application.
 * Persists user workspace data in localStorage while exposing runtime QA controls.
 */
import { createInitialSeed } from "../data/seed.js";

const STORAGE_KEY = "sharely_testbed_state_v1";

function loadPersistedData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialSeed();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.folders) || !Array.isArray(parsed.links)) {
      return createInitialSeed();
    }
    return parsed;
  } catch {
    return createInitialSeed();
  }
}

export function generateUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function inferPlatform(urlStr) {
  const low = (urlStr || "").toLowerCase();
  if (low.includes("tiktok.com")) return { platform: "TikTok", domain: "tiktok.com" };
  if (low.includes("instagram.com")) return { platform: "Instagram", domain: "instagram.com" };
  if (low.includes("facebook.com") || low.includes("fb.watch")) {
    return { platform: "Facebook", domain: "facebook.com" };
  }
  if (low.includes("youtube.com") || low.includes("youtu.be")) {
    return { platform: "YouTube", domain: "youtube.com" };
  }
  if (low.includes("x.com") || low.includes("twitter.com")) {
    return { platform: "X", domain: "x.com" };
  }
  try {
    const u = new URL(urlStr.startsWith("http") ? urlStr : `https://${urlStr}`);
    return { platform: "Web", domain: u.hostname.replace(/^www\./, "") };
  } catch {
    return { platform: "Web", domain: "sharely.link" };
  }
}

const seed = loadPersistedData();
if (!seed.folders.some(f => f.name === "ยังไม่จัดหมวด")) {
  seed.folders.unshift({
    id: "f1a10000-0000-4000-8000-000000000000",
    name: "ยังไม่จัดหมวด",
    cover: "./assets/covers/project.png",
    sharedCount: 0,
    sharedUsers: [],
    inviteSlug: "uncategorized",
    baseExternalCount: 0,
  });
}
if (typeof seed.freeQuotaRemaining === "undefined") {
  seed.freeQuotaRemaining = 4;
  seed.freeQuotaTotal = 4;
}

export const store = {
  state: {
    data: seed,
    ui: {
      viewportMode: "mobile", // "mobile" | "web" | "extension"
      inspectorVisible: true,
      inspectorTab: "controls", // "controls" | "logs" | "mcp" | "matrix"
      screen: seed.user?.isAuthenticated ? "home" : "login",
      prevScreen: "home",
      activeFolderId: seed.folders[0]?.id || null,
      activeLinkId: seed.links[2]?.id || seed.links[0]?.id || null,
      highlightLinkId: null,
      simulatedSourceApp: null, // null | "tiktok" | "instagram" | "youtube"
      previewIndex: 0,
      homeSearch: "",
      homeFilter: "all", // all | unread | read | favorite
      folderSearch: "",
      folderDetailSearch: "",
      folderDetailFilter: "all",
      showNotifications: false,
      activeSheet: null,
      // Sheet examples:
      // { type: "saveLink", draft: {...} }
      // { type: "reminder", linkId }
      // { type: "createFolder" }
      // { type: "editFolder", folderId, nameDraft, coverDraft }
      // { type: "pickCover", folderId, returnSheet }
      // { type: "invite", folderId }
      // { type: "inviteShareApp", folderId }
      // { type: "invitePreview", folderId, appName }
      // { type: "editNickname" }
      // { type: "exportCsv" }
      // { type: "postMenu", linkId, folderContextId }
      // { type: "deletePostDialog", linkId, mode: "delete" | "removeFromFolder", folderId }
      // { type: "logoutDialog" }
      // { type: "addTag", linkId }
      activeDialog: null,
      aiDropdown: null, // "provider" | "model" | null
      inviteLoginEmail: "",
      authEmail: "",
      authMode: "login", // "login" | "signup"
      toast: null,
      videoPlaying: false,
    },
    api: {
      mode: "mock", // "mock" | "live"
      baseUrl: "http://localhost:8000",
      userId: seed.user?.id || "11111111-1111-4111-8111-111111111111",
      bearerToken: "",
      mcpApiToken: "",
      latencyMs: 180,
      healthStatus: "unknown", // "unknown" | "healthy" | "offline"
      healthDetail: null,
      isSummarizing: false,
      summarizeOptions: {
        forceRefresh: false,
        saveToNote: true,
      },
      logs: [],
      lastMcpResult: null,
    },
  },

  listeners: new Set(),

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state.data));
    } catch {
      // Ignore quota errors in sandboxed iframes
    }
  },

  applyAppearanceToDom() {
    const { theme, textSize } = this.state.data.appearance;
    document.documentElement.setAttribute("data-sharely-theme", theme || "sharely");
    document.documentElement.setAttribute("data-text-size", textSize || "normal");
  },

  emit() {
    this.applyAppearanceToDom();
    this.save();
    for (const fn of this.listeners) fn(this.state);
  },

  showToast(message, durationMs = 2400) {
    this.state.ui.toast = message;
    this.emit();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.state.ui.toast = null;
      this.emit();
    }, durationMs);
  },

  navigate(screen, extras = {}) {
    const prev = this.state.ui.screen;
    Object.assign(this.state.ui, {
      prevScreen: prev !== screen ? prev : this.state.ui.prevScreen,
      screen,
      activeSheet: null,
      activeDialog: null,
      aiDropdown: null,
      showNotifications: false,
      videoPlaying: false,
      ...extras,
    });
    this.emit();
  },

  openSheet(sheet) {
    this.state.ui.activeSheet = sheet;
    this.state.ui.aiDropdown = null;
    this.emit();
  },

  closeSheet() {
    this.state.ui.activeSheet = null;
    this.emit();
  },

  openDialog(dialog) {
    this.state.ui.activeDialog = dialog;
    this.emit();
  },

  closeDialog() {
    this.state.ui.activeDialog = null;
    this.emit();
  },

  resetSeed() {
    const fresh = createInitialSeed();
    this.state.data = fresh;
    this.state.api.userId = fresh.user.id;
    this.state.api.logs = [];
    this.state.ui.activeFolderId = fresh.folders[0].id;
    this.state.ui.activeLinkId = fresh.links[2].id;
    this.state.ui.screen = "home";
    this.state.ui.activeSheet = null;
    this.state.ui.activeDialog = null;
    this.showToast("รีเซ็ตข้อมูลทดสอบทั้งหมดกลับเป็นค่าเริ่มต้นแล้ว");
  },
};

export function getFolderById(folderId) {
  return store.state.data.folders.find((f) => f.id === folderId) || null;
}

export function getLinkById(linkId) {
  return store.state.data.links.find((l) => l.id === linkId) || null;
}

export function getFolderCount(folder) {
  const actual = store.state.data.links.filter((l) => l.folderId === folder.id).length;
  // Seed maintains Figma count appearance cleanly when folder matches initial items or grows dynamically
  if (folder.id === "f1a10001-0000-4000-8000-000000000001") return actual;
  return Math.max(actual, folder.baseExternalCount || actual);
}

export function filterLinks(links, search, filterMode) {
  const q = (search || "").trim().toLowerCase();
  return links.filter((item) => {
    if (filterMode === "unread" && item.status !== "unread") return false;
    if (filterMode === "read" && item.status !== "read") return false;
    if (filterMode === "favorite" && !item.favorite) return false;
    if (!q) return true;
    const folder = getFolderById(item.folderId);
    const haystack = [
      item.title,
      item.note,
      item.platform,
      item.domain,
      folder?.name || "",
      ...(item.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
