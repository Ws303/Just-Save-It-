/**
 * Reactive state store for the Sharely Test Web Application.
 * Persists user workspace data in localStorage while exposing runtime QA controls.
 */
import { createInitialSeed } from "../data/seed.js";
import { guardNavigation } from "../services/routeGuard.js";
import { DEFAULT_SUPABASE_KEY, DEFAULT_SUPABASE_URL } from "../services/supabaseAuth.js";

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
const LOGOUT_FLAG_KEY = "sharely_logged_out";

function buildDefaultNotifications() {
  return [
    {
      id: "n-357-1",
      type: "reminder",
      badgeLabel: "เตือนความจำ",
      badgeSecondary: "เชียงใหม่",
      title: "ถึงเวลากลับมาดูลิงก์ที่ตั้งเตือนไว้",
      body: "5 คาเฟ่ที่อยากลองในเชียงใหม่ · ตั้งเตือนวันนี้ 18:00",
      time: "5 นาทีที่แล้ว",
      section: "recent",
      unread: true,
      linkId: "22222222-2222-4222-8222-222222222002",
    },
    {
      id: "n-357-2",
      type: "shared_folder",
      badgeLabel: "โฟลเดอร์แชร์",
      title: "มีคนเพิ่มลิงก์ใหม่ในโฟลเดอร์ที่แชร์",
      body: 'มิน เพิ่ม "รวมร้านบรันช์ย่านอารีย์" ลงใน คาเฟ่ที่อยากไป',
      time: "32 นาทีที่แล้ว",
      section: "recent",
      unread: true,
      folderId: "f1a10001-0000-4000-8000-000000000001",
    },
    {
      id: "n-357-3",
      type: "ai_summary",
      title: "สรุปด้วย AI พร้อมอ่านแล้ว",
      body: 'โน้ตย่อของ "เทคนิคจัดโต๊ะทำงานให้นั่งได้นาน" พร้อมใช้งาน',
      time: "เมื่อวาน",
      section: "earlier",
      unread: false,
      linkId: "22222222-2222-4222-8222-222222222012",
    },
    {
      id: "n-357-4",
      type: "invite",
      title: "ลิงก์แชร์โฟลเดอร์ถูกเปิดใช้งาน",
      body: "โฟลเดอร์ ทริปญี่ปุ่น มีผู้เข้าร่วมผ่านลิงก์แล้ว 2 คน",
      time: "2 วันที่แล้ว",
      section: "earlier",
      unread: false,
      folderId: "f1a10002-0000-4000-8000-000000000002",
    },
  ];
}

if (!seed.folders.some((f) => f.name === "ยังไม่จัดหมวด")) {
  seed.folders.unshift({
    id: "f1a10000-0000-4000-8000-000000000000",
    name: "ยังไม่จัดหมวด",
    emoji: "🗂️",
    cover: "./assets/covers/project.png",
    sharedCount: 0,
    sharedUsers: [],
    inviteSlug: "uncategorized",
    baseExternalCount: 0,
  });
}

for (const link of seed.links) {
  if (link.id === "22222222-2222-4222-8222-222222222001" && !link.media_items) {
    link.coverUrl = "./assets/covers/coffee.png";
    link.media_items = ["./assets/covers/coffee.png", "./assets/covers/food.png", "./assets/covers/project.png"];
  }
  if (link.id === "22222222-2222-4222-8222-222222222007" && !link.embed_url) {
    link.coverUrl = "./assets/covers/coffee.png";
    link.embed_url = "https://www.youtube.com/embed/dQw4w9WgXcQ";
    link.embed_type = "youtube";
  }
  if (typeof link.scheduleType === "undefined") {
    link.scheduleType = "once";
    link.repeatEveryDays = null;
  }
}

if (!Array.isArray(seed.notifications) || !seed.notifications.some((n) => n.section)) {
  seed.notifications = buildDefaultNotifications();
}

const DEFAULT_LOCAL_API_URL = "http://localhost:8000";

export function resolveRuntimeApiConfig(runtimeWindow = typeof window !== "undefined" ? window : undefined) {
  const hostname = String(runtimeWindow?.location?.hostname || "").trim().toLowerCase();
  const isLocalHost = !hostname || hostname === "localhost" || hostname === "127.0.0.1";
  const isHttpsPage = String(runtimeWindow?.location?.protocol || "").trim().toLowerCase() === "https:";

  const rawOverride = String(runtimeWindow?.SHARELY_CONFIG?.apiBaseUrl || "").trim();
  let validatedOverride = "";
  if (rawOverride) {
    try {
      const parsed = new URL(rawOverride);
      const targetIsLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      const schemeOk =
        parsed.protocol === "https:" || (parsed.protocol === "http:" && (!isHttpsPage || targetIsLocal));
      if (schemeOk && !parsed.username && !parsed.password) {
        validatedOverride = parsed.origin + parsed.pathname.replace(/\/+$/, "");
      }
    } catch {
      validatedOverride = "";
    }
  }

  let baseUrl = DEFAULT_LOCAL_API_URL;
  if (validatedOverride) {
    baseUrl = validatedOverride;
  } else if (!isLocalHost && runtimeWindow?.location?.origin && /^https?:\/\//i.test(runtimeWindow.location.origin)) {
    baseUrl = runtimeWindow.location.origin.replace(/\/+$/, "");
  }

  let supabaseUrl = DEFAULT_SUPABASE_URL;
  const rawSupabaseOverride = String(runtimeWindow?.SHARELY_CONFIG?.supabaseUrl || "").trim();
  if (rawSupabaseOverride) {
    try {
      const parsedSb = new URL(rawSupabaseOverride);
      if (parsedSb.protocol === "https:" && !parsedSb.username && !parsedSb.password) {
        supabaseUrl = parsedSb.origin;
      }
    } catch {
      // Keep default project URL
    }
  }
  const supabaseAnonKey =
    String(runtimeWindow?.SHARELY_CONFIG?.supabaseAnonKey || "").trim() || DEFAULT_SUPABASE_KEY;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    isLocalHost,
    supabaseUrl,
    supabaseAnonKey,
  };
}

const runtimeApiConfig = resolveRuntimeApiConfig();

let explicitLoggedOut = false;
try {
  explicitLoggedOut = localStorage.getItem(LOGOUT_FLAG_KEY) === "1";
} catch {
  explicitLoggedOut = false;
}
if (!explicitLoggedOut && seed.user && runtimeApiConfig.isLocalHost) {
  seed.user.isAuthenticated = true;
} else if (!runtimeApiConfig.isLocalHost && seed.user) {
  seed.user.isAuthenticated = false;
  seed.user.email = "";
  seed.user.displayName = "";
}

if (typeof seed.freeQuotaRemaining === "undefined") {
  seed.freeQuotaRemaining = 4;
  seed.freeQuotaTotal = 4;
}

const initialDesktopViewport =
  typeof window !== "undefined" && window.innerWidth >= 1024 ? "web" : "mobile";

export const store = {
  state: {
    data: seed,
    ui: {
      viewportMode: initialDesktopViewport, // "mobile" | "web" | "extension"
      qaPanelCollapsed: true,
      inspectorVisible: false,
      inspectorTab: "controls", // "controls" | "logs" | "mcp" | "matrix"
      screen: seed.user?.isAuthenticated ? "home" : "login",
      prevScreen: "home",
      activeFolderId: seed.folders[0]?.id || null,
      activeLinkId: seed.links[1]?.id || seed.links[0]?.id || null,
      highlightLinkId: null,
      simulatedSourceApp: null, // null | "tiktok" | "instagram" | "youtube"
      previewIndex: 0,
      carouselIndex: 0,
      homeSearch: "",
      homeFilter: "all", // all | unread | read | favorite
      folderSearch: "",
      folderDetailSearch: "",
      folderDetailFilter: "all",
      showNotifications: false,
      notificationScreenOpen: false,
      addLinkExpanded: false,
      folderPickerSheetOpen: false,
      createFolderSheetOpen: false,
      aiConfirmModalOpen: false,
      aiSummaryStatus: "idle", // "idle" | "confirm" | "loading" | "success" | "error"
      shareSheetState: "idle", // "idle" | "loading" | "error"
      sharePermission: "viewer", // "viewer" | "editor"
      tagPopoverOpen: false,
      noteEditing: false,
      noteDraft: "",
      reminderScheduleType: "once", // "once" | "every_n_days"
      reminderRepeatDays: 3,
      showPassword: false,
      activeSheet: null,
      activeDialog: null,
      aiDropdown: null, // "provider" | "model" | null
      inviteLoginEmail: "",
      authEmail: "",
      authPassword: "",
      authDisplayName: "",
      authMode: "login", // "login" | "signup" | "forgot"
      authGuardEnabled: true,
      postAuthRedirect: null,
      authError: null,
      toast: null,
      videoPlaying: false,
    },
    api: {
      mode: "live", // "live" | "mock"
      authProvider: runtimeApiConfig.isLocalHost ? "backend" : "supabase", // "backend" | "supabase" | "mock"
      baseUrl: runtimeApiConfig.baseUrl,
      supabaseUrl: runtimeApiConfig.supabaseUrl,
      supabaseAnonKey: runtimeApiConfig.supabaseAnonKey,
      userId: seed.user?.id || "11111111-1111-4111-8111-111111111111",
      bearerToken: "",
      refreshToken: "",
      jwtClaims: null,
      useDevBypass: runtimeApiConfig.isLocalHost,
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
    if (this.state.data.user && !this.state.data.user.isAuthenticated) return;
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
    const {
      allowGuestSwitch = false,
      viewportMode = this.state.ui.viewportMode,
      ...restExtras
    } = extras;

    const decision = guardNavigation({
      targetScreen: screen,
      targetViewport: viewportMode,
      state: this.state,
      allowGuestSwitch,
    });

    if (!decision.allowed && decision.reason === "authentication_required") {
      this.state.ui.postAuthRedirect = {
        screen: decision.intendedRoute?.screen || "home",
        viewportMode: decision.intendedRoute?.viewportMode || "mobile",
        activeFolderId: restExtras.activeFolderId ?? this.state.ui.activeFolderId,
        activeLinkId: restExtras.activeLinkId ?? this.state.ui.activeLinkId,
      };
      this.state.ui.viewportMode = "mobile";
      this.state.ui.screen = decision.redirectScreen;
      this.state.ui.activeSheet = null;
      this.state.ui.activeDialog = null;
      this.state.ui.aiDropdown = null;
      this.state.ui.showNotifications = false;
      this.showToast("🔒 กรุณาเข้าสู่ระบบก่อนเข้าถึงหน้านี้ (Protected Route)");
      return false;
    }

    const finalScreen = decision.allowed ? decision.screen : decision.redirectScreen;
    const finalViewport = decision.allowed ? decision.viewportMode : decision.redirectViewport;
    const prev = this.state.ui.screen;
    Object.assign(this.state.ui, {
      prevScreen: prev !== finalScreen ? prev : this.state.ui.prevScreen,
      screen: finalScreen,
      viewportMode: finalViewport,
      activeSheet: null,
      activeDialog: null,
      aiDropdown: null,
      showNotifications: false,
      videoPlaying: false,
      carouselIndex: 0,
      noteEditing: false,
      tagPopoverOpen: false,
      aiConfirmModalOpen: false,
      aiSummaryStatus: "idle",
      aiRequestId: (this.state.ui.aiRequestId || 0) + 1,
      ...restExtras,
    });
    this.emit();
    return true;
  },

  setViewport(viewportMode, extras = {}) {
    const targetScreen = extras.screen || this.state.ui.screen;
    return this.navigate(targetScreen, { ...extras, viewportMode });
  },

  applyAuthenticatedSession({ user, accessToken = "", refreshToken = "", claims = null, isMock = false } = {}) {
    if (user) {
      this.state.data.user.id = user.id || this.state.data.user.id;
      this.state.data.user.email = user.email || this.state.data.user.email;
      this.state.data.user.displayName =
        user.display_name || user.displayName || (user.email ? user.email.split("@")[0] : this.state.data.user.displayName);
      this.state.data.user.avatarInitial = (this.state.data.user.displayName || "S").charAt(0).toUpperCase();
      this.state.api.userId = this.state.data.user.id;
    }
    this.state.data.user.isAuthenticated = true;
    if (accessToken) this.state.api.bearerToken = accessToken;
    if (refreshToken) this.state.api.refreshToken = refreshToken;
    if (claims) this.state.api.jwtClaims = claims;
    this.state.ui.authError = null;
    try {
      localStorage.removeItem(LOGOUT_FLAG_KEY);
    } catch {}
    if (isMock && !accessToken) {
      this.state.api.jwtClaims = { sub: this.state.data.user.id, email: this.state.data.user.email, alg: "mock" };
    }
    this.emit();
  },

  clearSession({ redirectToLogin = true, authError = null } = {}) {
    this.state.data.user.isAuthenticated = false;
    this.state.api.bearerToken = "";
    this.state.api.refreshToken = "";
    this.state.api.jwtClaims = null;
    this.state.ui.authError = authError;
    try {
      localStorage.setItem(LOGOUT_FLAG_KEY, "1");
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    if (redirectToLogin) {
      this.state.ui.viewportMode = "mobile";
      this.state.ui.screen = "login";
      this.state.ui.notificationScreenOpen = false;
      this.state.ui.activeSheet = null;
      this.state.ui.activeDialog = null;
    }
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
    this.state.api.bearerToken = "";
    this.state.api.refreshToken = "";
    this.state.api.jwtClaims = null;
    this.state.api.logs = [];
    this.state.ui.viewportMode = "mobile";
    this.state.ui.activeFolderId = fresh.folders[0].id;
    this.state.ui.activeLinkId = fresh.links[2].id;
    this.state.ui.screen = fresh.user.isAuthenticated ? "home" : "login";
    this.state.ui.postAuthRedirect = null;
    this.state.ui.authError = null;
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

export function buildFolderInviteUrl(folder, role = "viewer", overrideUrl = "") {
  const cleanOverride = String(overrideUrl || "").trim();
  if (cleanOverride) return cleanOverride;
  const slug = folder?.inviteSlug || folder?.id || "share";
  const safeRole = role === "editor" ? "editor" : "viewer";
  return `https://sharely.app/invite/${slug}?role=${safeRole}`;
}
