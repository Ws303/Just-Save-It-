/**
 * Reactive state store for the Sharely Test Web Application.
 * Persists user workspace data in localStorage while exposing runtime QA controls.
 */
import { AI_PROVIDER_PRESETS, createInitialSeed } from "../data/seed.js";
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
const SESSION_STORAGE_KEY = "sharely_auth_session_v1";
const APPEARANCE_STORAGE_KEY = "sharely_appearance_v1";
const NOTIF_READ_STORAGE_KEY = "sharely_notif_read_v1";

export function isQaModeEnabled(runtimeWindow = typeof window !== "undefined" ? window : undefined) {
  if (!runtimeWindow?.location) return false;
  const search = String(runtimeWindow.location.search || "");
  const hash = String(runtimeWindow.location.hash || "");
  return /(?:[?&]|^)qa=1(?:&|$)/.test(search) || /(?:^#|[?&])qa(?:=1)?(?:&|$)/.test(hash);
}

export function resolveDefaultViewportMode(runtimeWindow = typeof window !== "undefined" ? window : undefined) {
  return runtimeWindow && typeof runtimeWindow.innerWidth === "number" && runtimeWindow.innerWidth >= 1024
    ? "web"
    : "mobile";
}

function loadAppearancePrefs() {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          theme: parsed.theme || "sharely",
          textSize: parsed.textSize || "normal",
          notificationsEnabled: parsed.notificationsEnabled !== false,
        };
      }
    }
  } catch {}
  return { theme: "sharely", textSize: "normal", notificationsEnabled: true };
}

export function createEmptyWorkspace(userPatch = {}) {
  const prefs = loadAppearancePrefs();
  return {
    user: {
      id: "",
      displayName: "",
      email: "",
      avatarInitial: "S",
      notificationsEnabled: prefs.notificationsEnabled !== false,
      isAuthenticated: false,
      ...userPatch,
    },
    appearance: { theme: prefs.theme, textSize: prefs.textSize },
    aiConfig: {
      provider: "Built-in Free (Server)",
      model: "gemini-3.1-flash-lite",
      endpointUrl: "",
      keyless: true,
      apiKey: "",
      connected: true,
      lastTestedAt: null,
    },
    folders: [],
    links: [],
    notifications: [],
    lastSharedEvent: null,
    freeQuotaRemaining: 50,
    freeQuotaTotal: 50,
  };
}

export const THAI_MONTH_NAMES = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

export function getBangkokTodayIso(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {}
  return now.toISOString().slice(0, 10);
}

export function getCurrentBangkokMonthKey() {
  return getBangkokTodayIso().slice(0, 7);
}

export function formatThaiMonthYear(ym) {
  const [yStr, mStr] = String(ym || getCurrentBangkokMonthKey()).split("-");
  const y = Number(yStr) || new Date().getFullYear();
  const m = Math.max(1, Math.min(12, Number(mStr) || 1));
  return `${THAI_MONTH_NAMES[m - 1]} ${y + 543}`;
}

export function getDaysInMonth(ym) {
  const [yStr, mStr] = String(ym || getCurrentBangkokMonthKey()).split("-");
  const y = Number(yStr) || new Date().getFullYear();
  const m = Math.max(1, Math.min(12, Number(mStr) || 1));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function stepYearMonth(ym, deltaMonths = 0) {
  const [yStr, mStr] = String(ym || getCurrentBangkokMonthKey()).split("-");
  const y = Number(yStr) || new Date().getFullYear();
  const m = (Number(mStr) || 1) - 1;
  const total = y * 12 + m + Number(deltaMonths || 0);
  const nextY = Math.floor(total / 12);
  const nextM = ((total % 12) + 12) % 12;
  return `${nextY}-${String(nextM + 1).padStart(2, "0")}`;
}

export function getFirstWeekdayOfMonth(ym) {
  const [yStr, mStr] = String(ym || getCurrentBangkokMonthKey()).split("-");
  const y = Number(yStr) || new Date().getFullYear();
  const m = Math.max(1, Math.min(12, Number(mStr) || 1));
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

export function buildMonthCalendarDays(ym, todayIso = getBangkokTodayIso()) {
  const yearMonth = /^\d{4}-\d{2}$/.test(String(ym || "")) ? String(ym) : getCurrentBangkokMonthKey();
  const daysInMonth = getDaysInMonth(yearMonth);
  const leadingEmpty = getFirstWeekdayOfMonth(yearMonth);
  const days = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateIso = `${yearMonth}-${String(d).padStart(2, "0")}`;
    days.push({
      day: d,
      dateIso,
      isToday: dateIso === todayIso,
      isPast: dateIso < todayIso,
    });
  }
  const remainder = (leadingEmpty + daysInMonth) % 7;
  const trailingEmpty = remainder === 0 ? 0 : 7 - remainder;
  return {
    yearMonth,
    monthLabel: formatThaiMonthYear(yearMonth),
    leadingEmpty,
    days,
    trailingEmpty,
  };
}

export function resolveRuntimeApiConfig(runtimeWindow = typeof window !== "undefined" ? window : undefined) {
  const hostname = String(runtimeWindow?.location?.hostname || "").trim().toLowerCase();
  const isLocalHost = !hostname || hostname === "localhost" || hostname === "127.0.0.1";
  const isHttpsPage = String(runtimeWindow?.location?.protocol || "").trim().toLowerCase() === "https:";
  const isOnRenderHost = hostname.endsWith(".onrender.com");

  const rawOverride = String(runtimeWindow?.SHARELY_CONFIG?.apiBaseUrl || "").trim();
  let validatedOverride = "";
  if (rawOverride) {
    try {
      const parsed = new URL(rawOverride);
      const targetIsLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      // Render fromService `property: host` returns dotless service slug (e.g. `just-save-it-api`).
      if (!parsed.hostname.includes(".") && !targetIsLocal && isOnRenderHost) {
        parsed.hostname = `${parsed.hostname}.onrender.com`;
      }
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
const qaModeActive = isQaModeEnabled();

let explicitLoggedOut = false;
try {
  explicitLoggedOut = localStorage.getItem(LOGOUT_FLAG_KEY) === "1";
} catch {
  explicitLoggedOut = false;
}

let savedSession = null;
try {
  const rawSess = localStorage.getItem(SESSION_STORAGE_KEY);
  if (rawSess) savedSession = JSON.parse(rawSess);
} catch {
  savedSession = null;
}

const initialWorkspace = runtimeApiConfig.isLocalHost ? seed : createEmptyWorkspace();
if (!explicitLoggedOut && initialWorkspace.user && runtimeApiConfig.isLocalHost) {
  initialWorkspace.user.isAuthenticated = true;
} else if (!runtimeApiConfig.isLocalHost && savedSession?.accessToken && savedSession?.user) {
  initialWorkspace.user = {
    ...initialWorkspace.user,
    id: savedSession.user.id || "",
    email: savedSession.user.email || "",
    displayName: savedSession.user.displayName || savedSession.user.display_name || "สมาชิก Sharely",
    avatarInitial: (savedSession.user.displayName || savedSession.user.email || "S").charAt(0).toUpperCase(),
    isAuthenticated: true,
  };
} else if (!runtimeApiConfig.isLocalHost && initialWorkspace.user) {
  initialWorkspace.user.isAuthenticated = false;
}

if (typeof initialWorkspace.freeQuotaRemaining === "undefined") {
  initialWorkspace.freeQuotaRemaining = 50;
  initialWorkspace.freeQuotaTotal = 50;
}

const initialDesktopViewport = resolveDefaultViewportMode();

export const store = {
  state: {
    data: initialWorkspace,
    ui: {
      viewportMode: initialDesktopViewport, // "mobile" | "web" | "extension"
      qaMode: qaModeActive,
      qaViewportLocked: false,
      qaPanelCollapsed: true,
      inspectorVisible: false,
      inspectorTab: "controls", // "controls" | "logs" | "mcp" | "matrix"
      screen: initialWorkspace.user?.isAuthenticated ? "home" : "login",
      pcSection: "home", // "home" | "folders" | "folderDetail" | "favorite" | "linkDetail" | "ai" | "profile" | "display" | "security" | "help" | "notifications"
      prevScreen: "home",
      activeFolderId: initialWorkspace.folders[0]?.id || null,
      activeLinkId: initialWorkspace.links[1]?.id || initialWorkspace.links[0]?.id || null,
      highlightLinkId: null,
      simulatedSourceApp: null, // null | "tiktok" | "instagram" | "youtube"
      previewIndex: 0,
      carouselIndex: 0,
      homeSearch: "",
      homeFilter: "all", // all | unread | read | favorite
      pcSearch: "",
      pcFilter: "all", // all | unread | read | favorite
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
      calendarMonth: getCurrentBangkokMonthKey(),
      reminderScheduleType: "once", // "once" | "every_n_days"
      reminderRepeatDays: 3,
      showPassword: false,
      activeSheet: null,
      activeDialog: null,
      aiDropdown: null, // "provider" | "model" | null
      inviteLoginEmail: "",
      invitePreview: null,
      pendingInviteToken: "",
      authEmail: "",
      authPassword: "",
      authPasswordConfirm: "",
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
      authProvider: savedSession?.authProvider || (runtimeApiConfig.isLocalHost ? "backend" : "supabase"), // "backend" | "supabase" | "mock"
      baseUrl: runtimeApiConfig.baseUrl,
      supabaseUrl: runtimeApiConfig.supabaseUrl,
      supabaseAnonKey: runtimeApiConfig.supabaseAnonKey,
      userId: initialWorkspace.user?.id || "11111111-1111-4111-8111-111111111111",
      bearerToken: savedSession?.accessToken || "",
      refreshToken: savedSession?.refreshToken || "",
      jwtClaims: savedSession?.claims || null,
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
    try {
      const app = this.state.data.appearance || { theme: "sharely", textSize: "normal" };
      localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify({
          theme: app.theme || "sharely",
          textSize: app.textSize || "normal",
          notificationsEnabled: this.state.data.user?.notificationsEnabled !== false,
        })
      );
    } catch {}
    if (this.state.data.user && !this.state.data.user.isAuthenticated) return;
    try {
      if (runtimeApiConfig.isLocalHost || this.state.api.mode === "mock") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state.data));
      }
      if (this.state.api.bearerToken) {
        localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({
            accessToken: this.state.api.bearerToken,
            refreshToken: this.state.api.refreshToken || "",
            claims: this.state.api.jwtClaims || null,
            authProvider: this.state.api.authProvider,
            user: {
              id: this.state.data.user?.id || "",
              email: this.state.data.user?.email || "",
              displayName: this.state.data.user?.displayName || "",
            },
          })
        );
      }
    } catch {
      // Ignore quota errors in sandboxed iframes
    }
  },

  applyAppearanceToDom() {
    if (typeof document === "undefined" || !document?.documentElement) return;
    const { theme, textSize } = this.state.data.appearance;
    document.documentElement.setAttribute("data-sharely-theme", theme || "sharely");
    document.documentElement.setAttribute("data-text-size", textSize || "normal");
  },

  emit() {
    this.applyAppearanceToDom();
    this.save();
    for (const fn of this.listeners) fn(this.state);
  },

  initResponsiveViewport() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const syncViewport = (matches) => {
      if (this.state.ui.qaViewportLocked) return;
      const target = matches ? "web" : "mobile";
      if (this.state.ui.viewportMode !== target) {
        this.state.ui.viewportMode = target;
        this.emit();
      }
    };
    syncViewport(mq.matches);
    mq.addEventListener("change", (ev) => syncViewport(ev.matches));
  },

  showToast(message, durationMs = 2400) {
    this.state.ui.toast = message;
    this.emit();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null;
      if (this.state.ui.toast !== message) return;
      this.state.ui.toast = null;
      if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
        document.querySelectorAll(".toast-banner").forEach((el) => el.remove());
      } else if (typeof window !== "undefined") {
        this.emit();
      }
    }, durationMs);
    if (typeof this._toastTimer?.unref === "function") {
      this._toastTimer.unref();
    }
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
        viewportMode: decision.intendedRoute?.viewportMode || resolveDefaultViewportMode(),
        activeFolderId: restExtras.activeFolderId ?? this.state.ui.activeFolderId,
        activeLinkId: restExtras.activeLinkId ?? this.state.ui.activeLinkId,
      };
      this.state.ui.viewportMode = decision.redirectViewport || resolveDefaultViewportMode();
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
    const pcSectionMap = {
      home: "home",
      folders: "folders",
      folderDetail: "folderDetail",
      linkDetail: "linkDetail",
      ai: "ai",
      profile: "profile",
      display: "display",
      security: "security",
      help: "help",
    };
    const nextPcSection = restExtras.pcSection || pcSectionMap[finalScreen];
    Object.assign(this.state.ui, {
      prevScreen: prev !== finalScreen ? prev : this.state.ui.prevScreen,
      screen: finalScreen,
      viewportMode: finalViewport,
      ...(nextPcSection ? { pcSection: nextPcSection } : {}),
      activeSheet: null,
      activeDialog: null,
      aiDropdown: null,
      showNotifications: false,
      notificationScreenOpen: false,
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
    if (this.state.ui.qaMode && typeof extras.lockQa === "boolean") {
      this.state.ui.qaViewportLocked = extras.lockQa;
    } else if (this.state.ui.qaMode && viewportMode) {
      this.state.ui.qaViewportLocked = true;
    }
    return this.navigate(targetScreen, { ...extras, viewportMode });
  },

  applyAuthenticatedSession({ user, accessToken = "", refreshToken = "", claims = null, isMock = false } = {}) {
    const prevUserId = this.state.data.user?.id || "";
    const nextUserId = user?.id || prevUserId;
    const isAccountSwitch = Boolean(prevUserId && nextUserId && prevUserId !== nextUserId);
    if (isAccountSwitch && typeof window !== "undefined") {
      this.state.data.folders = [];
      this.state.data.links = [];
      this.state.data.notifications = [];
      this.state.data.aiConfig = {
        ...this.state.data.aiConfig,
        apiKey: "",
        connected: this.state.data.aiConfig?.provider === "Built-in Free (Server)",
      };
      this.state.ui.activeFolderId = null;
      this.state.ui.activeLinkId = null;
    }
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

  clearSession({ redirectToLogin = true, authError = null, clearWorkspace } = {}) {
    const hasBrowserDom = typeof window !== "undefined";
    const hadRealAuth = Boolean(this.state.api.bearerToken) || !runtimeApiConfig.isLocalHost || hasBrowserDom;
    const shouldClearWorkspace = typeof clearWorkspace === "boolean" ? clearWorkspace : hadRealAuth && this.state.api.mode !== "mock";
    this.state.data.user.isAuthenticated = false;
    this.state.api.bearerToken = "";
    this.state.api.refreshToken = "";
    this.state.api.jwtClaims = null;
    this.state.ui.authError = authError;
    if (shouldClearWorkspace) {
      this.state.data.user.id = "";
      this.state.data.user.displayName = "";
      this.state.data.user.email = "";
      this.state.data.user.avatarInitial = "S";
      if (clearWorkspace === true || hasBrowserDom) {
        this.state.data.folders = [];
        this.state.data.links = [];
        this.state.data.notifications = [];
      }
      this.state.data.aiConfig = {
        provider: "Built-in Free (Server)",
        model: "gemini-3.1-flash-lite",
        endpointUrl: "",
        keyless: true,
        apiKey: "",
        connected: true,
        lastTestedAt: null,
      };
      this.state.ui.activeFolderId = null;
      this.state.ui.activeLinkId = null;
    }
    try {
      localStorage.setItem(LOGOUT_FLAG_KEY, "1");
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
    if (redirectToLogin) {
      this.state.ui.viewportMode = resolveDefaultViewportMode();
      this.state.ui.screen = "login";
      this.state.ui.pcSection = "home";
      this.state.ui.notificationScreenOpen = false;
      this.state.ui.showNotifications = false;
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

  loadReadNotificationIds() {
    try {
      if (typeof localStorage === "undefined") return new Set();
      const raw = localStorage.getItem(NOTIF_READ_STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
    } catch {
      return new Set();
    }
  },
  saveReadNotificationIds(idSet) {
    try {
      if (typeof localStorage === "undefined") return;
      const list = Array.from(idSet || []).slice(-250);
      localStorage.setItem(NOTIF_READ_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Ignore storage errors
    }
  },
  markNotificationRead(notifId) {
    const id = String(notifId || "").trim();
    if (!id) return;
    const item = (this.state.data.notifications || []).find((n) => n.id === id);
    if (item) item.unread = false;
    const readSet = this.loadReadNotificationIds();
    readSet.add(id);
    this.saveReadNotificationIds(readSet);
    this.emit();
  },
  markAllNotificationsRead() {
    const readSet = this.loadReadNotificationIds();
    (this.state.data.notifications || []).forEach((n) => {
      n.unread = false;
      if (n.id) readSet.add(String(n.id));
    });
    this.saveReadNotificationIds(readSet);
  },
  rebuildNotificationsFromWorkspace() {
    const data = this.state.data;
    const folders = Array.isArray(data.folders) ? data.folders : [];
    const links = Array.isArray(data.links) ? data.links : [];
    const readSet = this.loadReadNotificationIds();
    const items = [];

    links.forEach((link) => {
      const remDate = link?.reminderDate || link?.reminder?.date || "";
      const remTime = link?.reminderTime || link?.reminder?.time || "";
      const remNote = typeof link?.reminder === "string" ? link.reminder : link?.reminder?.note || "";
      if (!remDate && !remNote) return;
      const folder = folders.find((f) => f.id === link.folderId);
      const id = `notif-rem-${link.id}-${remDate || "active"}`;
      items.push({
        id,
        type: "reminder",
        title: `เตือนความจำ: ${link.title || link.domain || "ลิงก์ที่บันทึก"}`,
        body: remTime ? `นัดอ่านเวลา ${remTime}` : remNote || "ถึงกำหนดอ่านลิงก์นี้แล้ว",
        time: remDate ? `${remDate}${remTime ? ` · ${remTime}` : ""}` : remNote,
        badgeLabel: folder ? folder.name : "",
        badgeSecondary: link.domain || link.platform || "",
        linkId: link.id,
        section: "recent",
        unread: !readSet.has(id),
      });
    });

    folders.forEach((f) => {
      const mCount = Number(f.memberCount ?? f.sharedCount) || 0;
      const isShared = Boolean(f.shared || f.isShared || mCount > 1 || (f.role && f.role !== "owner"));
      if (!isShared) return;
      const id = `notif-folder-${f.id}`;
      const roleLabel = f.role === "editor" ? "แก้ไขได้" : f.role === "viewer" ? "ดูได้อย่างเดียว" : "เจ้าของ";
      items.push({
        id,
        type: "shared_folder",
        title: f.role && f.role !== "owner" ? `คุณอยู่ในโฟลเดอร์ "${f.name}"` : `โฟลเดอร์ "${f.name}" แชร์ร่วมกัน`,
        body: mCount > 0 ? `สมาชิก ${mCount} คน` : "แตะเพื่อเปิดดูลิงก์ภายในโฟลเดอร์",
        time: "โฟลเดอร์ร่วม",
        badgeLabel: roleLabel,
        badgeSecondary: `${Number(f.itemCount ?? f.count) || 0} ลิงก์`,
        folderId: f.id,
        section: "earlier",
        unread: !readSet.has(id),
      });
    });

    links
      .filter((l) => Boolean(l.aiSummary || l.summary_text))
      .slice(0, 3)
      .forEach((link) => {
        const id = `notif-ai-${link.id}`;
        items.push({
          id,
          type: "ai_summary",
          title: `AI สรุปเนื้อหาพร้อมแล้ว`,
          body: link.title || link.domain || link.url,
          time: link.date || "AI Summary",
          badgeLabel: "AI Summary",
          linkId: link.id,
          section: "earlier",
          unread: !readSet.has(id),
        });
      });

    data.notifications = items;
  },
  resetSeed() {
    const fresh = createInitialSeed();
    this.state.data = fresh;
    this.state.api.userId = fresh.user.id;
    this.state.api.bearerToken = "";
    this.state.api.refreshToken = "";
    this.state.api.jwtClaims = null;
    this.state.api.logs = [];
    this.state.ui.viewportMode = this.state.ui.qaViewportLocked
      ? this.state.ui.viewportMode
      : resolveDefaultViewportMode();
    this.state.ui.pcSection = "home";
    this.state.ui.activeFolderId = fresh.folders[0].id;
    this.state.ui.activeLinkId = fresh.links[2].id;
    this.state.ui.screen = fresh.user.isAuthenticated ? "home" : "login";
    this.state.ui.postAuthRedirect = null;
    this.state.ui.authError = null;
    this.state.ui.activeSheet = null;
    this.state.ui.activeDialog = null;
    this.state.ui.notificationScreenOpen = false;
    this.state.ui.showNotifications = false;
    this.showToast("รีเซ็ตข้อมูลทดสอบทั้งหมดกลับเป็นค่าเริ่มต้นแล้ว");
  },

  selectAiProvider(providerId) {
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === providerId);
    const isBuiltin = preset?.backendProvider === "built-in";
    Object.assign(this.state.data.aiConfig, {
      provider: providerId,
      model: preset?.models[0] || "",
      endpointUrl: preset?.baseUrl || "",
      apiKey: "",
      keyless: isBuiltin,
      connected: isBuiltin,
      lastTestedAt: null,
      lastTestError: null,
    });
    this.state.ui.aiDropdown = null;
    this.emit();
  },

  dismissAiSummaryModal() {
    this.state.ui.aiRequestId = (this.state.ui.aiRequestId || 0) + 1;
    this.state.ui.aiConfirmModalOpen = false;
    this.state.ui.aiSummaryStatus = "idle";
    this.emit();
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
