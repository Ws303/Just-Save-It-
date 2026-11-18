/**
 * Dual-mode API & MCP Client for Sharely Test Web App.
 * - Live Mode: executes real fetch() requests against FastAPI backend (backend/main.py).
 * - Mock Mode: simulates exact contracts for backend/Ai, backend/Login, backend/Database & 13 MCP tools.
 */
import { AI_PROVIDER_PRESETS, COVER_CHOICES } from "../data/seed.js";
import { safeHrefUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { store, generateUuid, inferPlatform, getFolderById, getLinkById, filterLinks, buildFolderInviteUrl } from "../state/store.js";
import { getAuthMode } from "./routeGuard.js";
import { buildAuthRedirectUrl, extractClaimsSummary, supabaseAuth } from "./supabaseAuth.js";
import { disableWebPush } from "./pushClient.js";
import { broadcastLocalChange, noteLocalMutation, stopRealtimeSync } from "./realtimeClient.js";

const WORKSPACE_CACHE_PREFIX = "sharely_workspace_cache_v1:";
const WORKSPACE_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
let _refreshInFlightPromise = null;
let _refreshInFlightContextKey = "";
let _hydrateInFlightPromise = null;
let _hydrateInFlightContextKey = "";

function getAuthContextKey() {
  const gen = Number(store.state.api?.authGeneration || 0);
  const uid = resolveCacheUserId();
  return `${gen}:${uid || "anon"}`;
}

function isAuthContextCurrent(expectedKey) {
  return getAuthContextKey() === expectedKey;
}

function staleAuthResult(status = 409) {
  return { ok: false, status, data: null, error: "Auth context changed", stale: true };
}

function mergeUniqueRowsById(targetRows, seenIds, batch) {
  let added = 0;
  for (const row of batch || []) {
    const id = row?.id ? String(row.id) : "";
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    targetRows.push(row);
    added += 1;
  }
  return added;
}

function resolveCacheUserId(userId) {
  return String(userId || store.state.data.user?.id || store.state.api?.jwtClaims?.sub || "").trim();
}

export function loadWorkspaceCache(userId) {
  const uid = resolveCacheUserId(userId);
  if (!uid || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${WORKSPACE_CACHE_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.userId !== uid) return null;
    if (parsed.savedAt && Date.now() - Number(parsed.savedAt) > WORKSPACE_CACHE_MAX_AGE_MS) {
      localStorage.removeItem(`${WORKSPACE_CACHE_PREFIX}${uid}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveWorkspaceCache(userId) {
  const uid = resolveCacheUserId(userId);
  if (!uid || store.state.api?.mode !== "live" || !store.state.data.user?.isAuthenticated) return;
  if (typeof localStorage === "undefined") return;
  try {
    const payload = {
      version: 1,
      userId: uid,
      savedAt: Date.now(),
      user: {
        displayName: store.state.data.user.displayName || "",
        email: store.state.data.user.email || "",
        tier: store.state.data.user.tier || "free",
        timezone: store.state.data.user.timezone || "Asia/Bangkok",
        aiLanguage: store.state.data.aiConfig?.language || "th",
        freeQuotaRemaining: store.state.data.freeQuotaRemaining,
        freeQuotaLimit: store.state.data.freeQuotaLimit,
        freeQuotaTotal: store.state.data.freeQuotaTotal,
        freeQuotaUsed: store.state.data.freeQuotaUsed,
      },
      folders: (store.state.data.folders || []).slice(0, 100),
      links: (store.state.data.links || []).filter((l) => !l?._optimistic).slice(0, 150),
      serverTags: (store.state.data.serverTags || []).slice(0, 200),
    };
    localStorage.setItem(`${WORKSPACE_CACHE_PREFIX}${uid}`, JSON.stringify(payload));
  } catch {
    // ignore storage quota errors
  }
}

export function clearWorkspaceCache(userId) {
  const uid = resolveCacheUserId(userId);
  if (!uid || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(`${WORKSPACE_CACHE_PREFIX}${uid}`);
  } catch {}
}

function mapBackendFolder(f, idx) {
  return {
    sharedUsers: [],
    inviteSlug: String(f.id || "").slice(0, 8),
    baseExternalCount: 0,
    ...f,
    cover: f.cover_url || f.cover || COVER_CHOICES[idx % COVER_CHOICES.length]?.src || "./assets/covers/coffee.png",
    sharedCount: f.member_count ?? f.sharedCount ?? (f.is_shared ? 2 : 0),
  };
}

function applyWorkspaceCacheSnapshot(cached) {
  if (!cached || !store.state.data.user?.isAuthenticated) return false;
  if ((store.state.data.links?.length || 0) > 0 || (store.state.data.folders?.length || 0) > 0) {
    return false;
  }
  const u = cached.user || {};
  if (u.displayName) store.state.data.user.displayName = u.displayName;
  if (u.email) store.state.data.user.email = u.email;
  if (u.tier) store.state.data.user.tier = u.tier;
  if (u.timezone) store.state.data.user.timezone = u.timezone;
  if (u.aiLanguage) store.state.data.aiConfig.language = u.aiLanguage;
  if (typeof u.freeQuotaRemaining === "number") {
    store.state.data.freeQuotaRemaining = u.freeQuotaRemaining;
    store.state.data.freeQuotaLimit = u.freeQuotaLimit ?? store.state.data.freeQuotaLimit;
    store.state.data.freeQuotaTotal = u.freeQuotaTotal ?? store.state.data.freeQuotaTotal;
    store.state.data.freeQuotaUsed = u.freeQuotaUsed ?? 0;
  }
  if (Array.isArray(cached.folders)) {
    store.state.data.folders = cached.folders;
    if (!store.state.ui.activeFolderId) {
      store.state.ui.activeFolderId = cached.folders[0]?.id || null;
    }
  }
  if (Array.isArray(cached.links)) {
    store.state.data.links = cached.links;
    if (!store.state.ui.activeLinkId) {
      store.state.ui.activeLinkId = cached.links[0]?.id || null;
    }
  }
  if (Array.isArray(cached.serverTags)) {
    store.state.data.serverTags = cached.serverTags;
  }
  store.rebuildNotificationsFromWorkspace();
  store.emit();
  return true;
}

function applyWorkspacePayload({ meData = null, folders = null, itemRows = null, tags = null, reminders = null }) {
  if (meData && typeof meData === "object") {
    const prof = meData.profile || {};
    if (meData.display_name || prof.display_name) {
      store.state.data.user.displayName = meData.display_name || prof.display_name;
    }
    if (meData.email || prof.email) {
      store.state.data.user.email = meData.email || prof.email;
    }
    store.state.data.user.tier = meData.tier || prof.tier || store.state.data.user.tier || "free";
    if (prof.preferred_summary_language) {
      store.state.data.aiConfig.language = prof.preferred_summary_language;
    }
    if (prof.default_timezone) {
      store.state.data.user.timezone = prof.default_timezone;
    }
    if (meData.ai_quota && typeof meData.ai_quota.remaining === "number") {
      const lim = meData.ai_quota.limit ?? store.state.data.freeQuotaTotal ?? 50;
      store.state.data.freeQuotaRemaining = meData.ai_quota.remaining;
      store.state.data.freeQuotaLimit = lim;
      store.state.data.freeQuotaTotal = lim;
      store.state.data.freeQuotaUsed = meData.ai_quota.used ?? 0;
    }
  }

  const remMap = {};
  for (const rem of reminders || []) {
    if (rem?.item_id) remMap[rem.item_id] = rem;
  }

  if (Array.isArray(folders)) {
    store.state.data.folders = folders.map(mapBackendFolder);
    if (!store.state.data.folders.some((f) => f.id === store.state.ui.activeFolderId)) {
      store.state.ui.activeFolderId = store.state.data.folders[0]?.id || null;
    }
  }

  if (Array.isArray(itemRows)) {
    store.state.data.links = itemRows.map((row) => mapBackendItemToUi(row, remMap));
    if (!store.state.data.links.some((l) => l.id === store.state.ui.activeLinkId)) {
      store.state.ui.activeLinkId = store.state.data.links[0]?.id || null;
    }
  }

  if (Array.isArray(tags)) {
    store.state.data.serverTags = tags;
  }

  store.rebuildNotificationsFromWorkspace();
  store.emit();
}

function formatRemindIsoInBangkok(remIso, fallbackTime = "18:00") {
  if (!remIso) return { date: null, time: fallbackTime };
  const dt = new Date(remIso);
  if (Number.isNaN(dt.getTime())) {
    const raw = String(remIso);
    return {
      date: raw.slice(0, 10) || null,
      time: raw.length >= 16 ? raw.slice(11, 16) : fallbackTime,
    };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dt);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}` || fallbackTime,
  };
}

export function normalizeWorkflowStatus(status) {
  const s = String(status || "inbox").toLowerCase();
  if (s === "done" || s === "read") return "done";
  if (s === "archived") return "archived";
  if (s === "todo") return "todo";
  return "inbox";
}

export function mapBackendStatusToUi(status) {
  const s = String(status || "inbox").toLowerCase();
  if (s === "done" || s === "read" || s === "archived") return "read";
  return "unread";
}

export function mapUiStatusToBackend(status) {
  const s = String(status || "unread").toLowerCase();
  if (s === "read" || s === "done") return "done";
  if (s === "archived") return "archived";
  if (s === "todo") return "todo";
  return "inbox";
}

export function inferContentType(item = {}) {
  const raw = String(item.content_type || item.contentType || "").trim().toLowerCase();
  const embedType = String(item.embed_type || "none").toLowerCase();
  const platform = String(item.platform || "").toLowerCase();
  const url = String(item.canonical_url || item.canonicalUrl || item.url || "").toLowerCase();
  const mediaItems = Array.isArray(item.media_items) ? item.media_items.filter(Boolean) : [];
  const hasYtVideoTarget =
    /[?&]v=[^&#]+/.test(url) ||
    /youtu\.be\/[^/?#]+/.test(url) ||
    /youtube\.com\/(?:watch(?:\/|\?|$)|embed\/[^/?#]+|shorts\/[^/?#]+|live\/[^/?#]+)/.test(url);
  const explicitNonVideoPost = raw === "post" || raw === "social";
  const isYtNonVideo =
    /youtube\.com\/(?:post\/|@|channel\/|c\/|user\/)/.test(url) && !hasYtVideoTarget;
  const isTtNonVideo =
    /tiktok\.com/.test(url) &&
    (/\/photo\//.test(url) || /tiktok\.com\/@[^/?#]+\/?(?:\?|$)/.test(url));
  const isYtVideoUrl = hasYtVideoTarget;
  const isTtVideoUrl = /tiktok\.com\/@[^/]+\/video\//.test(url) || /(?:vt|vm)\.tiktok\.com\//.test(url);
  if (
    raw === "video" ||
    (!explicitNonVideoPost &&
      !isYtNonVideo &&
      !isTtNonVideo &&
      (embedType === "youtube" ||
        embedType === "tiktok" ||
        embedType === "vimeo" ||
        isYtVideoUrl ||
        isTtVideoUrl ||
        /vimeo\.com|\.mp4\b/i.test(url)))
  ) {
    return "video";
  }
  if (
    raw === "image" ||
    (mediaItems.length > 0 &&
      embedType === "none" &&
      !["instagram", "facebook", "x", "reddit", "youtube", "tiktok"].includes(platform)) ||
    /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)
  ) {
    return "image";
  }
  if (
    raw === "social" ||
    raw === "post" ||
    isYtNonVideo ||
    isTtNonVideo ||
    ["instagram", "facebook", "x", "twitter", "reddit", "threads", "lemon8"].includes(platform) ||
    ["instagram", "facebook", "x", "reddit"].includes(embedType)
  ) {
    return "social";
  }
  return "article";
}

export function mapFeedbackCategory(rawCategory) {
  const s = String(rawCategory || "general").trim().toLowerCase();
  if (s === "bug" || s.includes("บั๊ก") || s.includes("ปัญหา") || s.includes("ผิดพลาด")) return "bug";
  if (s === "feature" || s.includes("ฟีเจอร์") || s.includes("แนะนำ")) return "feature";
  if (s === "waitlist" || s.includes("ทดสอบ")) return "waitlist";
  return "general";
}

export function mapBackendItemToUi(item, reminderMap = {}) {
  const rawTags = Array.isArray(item.tags) ? item.tags : Array.isArray(item.tag_names) ? item.tag_names : [];
  const tags = rawTags.map((t) => (String(t).startsWith("#") ? String(t) : `#${t}`));
  const mediaItems = Array.isArray(item.media_items) ? item.media_items.filter(Boolean) : [];
  const coverUrl = resolveMediaThumbUrl({
    thumbnail_url: item.thumbnail_url,
    image_url: item.image_url,
    coverUrl: item.coverUrl,
    media_items: mediaItems,
  }) || null;
  const { platform: inferredPlat, domain } = inferPlatform(item.url || "");
  const rem = reminderMap[item.id] || item.reminder || (Array.isArray(item.reminders) ? item.reminders[0] : null);
  const remIso = rem?.remind_at || rem?.next_remind_at || item.remind_at || null;
  const fallbackRemTime = rem?.remind_time ? String(rem.remind_time).slice(0, 5) : "18:00";
  const { date: remDate, time: remTime } = formatRemindIsoInBangkok(remIso, fallbackRemTime);
  const scheduleType = rem?.schedule_type || "once";
  const repeatEveryDays = rem?.repeat_every_days ?? null;

  return {
    id: item.id,
    folderId: item.folder_id ?? null,
    platform: item.platform || inferredPlat,
    url: item.url,
    canonicalUrl: item.canonical_url || null,
    domain,
    title: item.title || item.url,
    description: item.description || "",
    coverUrl,
    media_items: mediaItems,
    embed_url: item.embed_url || null,
    embed_type: item.embed_type || "none",
    enrichStatus: item.enrich_status || null,
    previewStatus:
      item.preview_status ||
      item.previewStatus ||
      (item.enrich_error === "private_or_restricted" ? "private_or_restricted" : "ok"),
    savedAgo: item.savedAgo || "เมื่อสักครู่",
    savedAt: item.saved_at || null,
    status: mapBackendStatusToUi(item.status),
    workflowStatus: normalizeWorkflowStatus(item.status),
    contentType: inferContentType({ ...item, platform: item.platform || inferredPlat, media_items: mediaItems }),
    favorite: Boolean(item.is_favorite ?? item.favorite),
    tags,
    note: item.note ?? item.user_note ?? "",
    aiSummary: item.ai_summary || item.aiSummary || "",
    aiCached: Boolean(item.ai_summary),
    reminder: remIso
      ? scheduleType === "every_n_days" && repeatEveryDays
        ? `ทุก ${repeatEveryDays} วัน · ${remTime}`
        : `${remDate} ${remTime}`
      : null,
    reminderDate: remDate,
    reminderTime: remTime,
    scheduleType,
    repeatEveryDays,
    sourceApp: item.source_app || item.platform || inferredPlat,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordLog({ method, path, mode, status, durationMs, headers, requestBody, responseBody, error }) {
  const entry = {
    id: generateUuid(),
    at: new Date().toLocaleTimeString("th-TH", { hour12: false }),
    method,
    path,
    mode,
    status,
    durationMs: Math.round(durationMs),
    headers: headers || {},
    requestBody,
    responseBody,
    error: error || null,
  };
  store.state.api.logs = [entry, ...store.state.api.logs.slice(0, 39)];
  if (store.state.ui?.inspectorVisible) {
    store.emit();
  }
  return entry;
}

export function buildAiHeadersAndConfig() {
  const cfg = store.state.data.aiConfig;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === cfg.provider) || AI_PROVIDER_PRESETS[0];
  const providerCode = preset.backendProvider; // "built-in" | "byok" | "custom"
  const isCustomKeyless = providerCode === "custom" && Boolean(cfg.keyless);

  const headers = {
    "Content-Type": "application/json",
  };
  if (store.state.api.bearerToken.trim()) {
    headers["Authorization"] = `Bearer ${store.state.api.bearerToken.trim()}`;
  } else if (store.state.api.useDevBypass && store.state.api.userId.trim()) {
    headers["X-User-Id"] = store.state.api.userId.trim();
  }

  headers["X-AI-Provider"] = providerCode;
  if (!isCustomKeyless && providerCode !== "built-in" && cfg.apiKey) headers["X-AI-Key"] = cfg.apiKey;
  if (cfg.endpointUrl && providerCode === "custom") headers["X-AI-Base-Url"] = cfg.endpointUrl;
  if (cfg.model) headers["X-AI-Model"] = cfg.model;

  const aiConfigBody = {
    provider: providerCode,
    api_key: !isCustomKeyless && providerCode !== "built-in" && cfg.apiKey ? cfg.apiKey : null,
    base_url: providerCode === "custom" ? cfg.endpointUrl || null : null,
    model: cfg.model || preset.models[0] || null,
  };

  return { headers, aiConfigBody, preset };
}

function buildAuthHeaders(customHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  const bearer = store.state.api.bearerToken?.trim();
  if (bearer) {
    headers["Authorization"] = `Bearer ${bearer}`;
  } else if (store.state.api.useDevBypass && store.state.api.userId?.trim()) {
    headers["X-User-Id"] = store.state.api.userId.trim();
  }
  return { ...headers, ...customHeaders };
}

function getSupabaseConfig() {
  return {
    supabaseUrl: store.state.api.supabaseUrl,
    supabaseAnonKey: store.state.api.supabaseAnonKey,
  };
}

function clearSessionAndSdk({ clearWorkspace = false, redirectToLogin = false, authError = null, awaitSdk = false } = {}) {
  const prevAuthMode = getAuthMode(store.state);
  const supaCfg = getSupabaseConfig();
  if (typeof store.clearSession === "function") {
    store.clearSession({
      ...(clearWorkspace ? { clearWorkspace: true } : {}),
      redirectToLogin: Boolean(redirectToLogin),
      ...(authError ? { authError } : {}),
    });
  }
  if (prevAuthMode === "supabase" && typeof supabaseAuth.clearLocalSession === "function") {
    const clearedGen = store.state.api?.authGeneration || 0;
    const task = supabaseAuth.clearLocalSession(
      supaCfg,
      () => !store.state.data.user?.isAuthenticated && (store.state.api?.authGeneration || 0) === clearedGen,
    );
    return awaitSdk ? task : undefined;
  }
  return undefined;
}

async function dispatchRequest({
  method = "GET",
  path,
  body = null,
  customHeaders = {},
  mockHandler,
  skipAuthRefresh = false,
  skipUnauthRedirect = false,
  keepalive = false,
}) {
  const { mode, baseUrl, latencyMs } = store.state.api;
  const started = performance.now();
  const base = baseUrl.replace(/\/+$/, "");
  const startKey = getAuthContextKey();

  const headers = buildAuthHeaders(customHeaders);

  if (mode === "mock") {
    await sleep(Math.max(40, Number(latencyMs) || 120));
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    try {
      const mockRes = await mockHandler();
      if (!isAuthContextCurrent(startKey)) {
        return staleAuthResult();
      }
      const durationMs = performance.now() - started;
      recordLog({
        method,
        path,
        mode: "mock",
        status: mockRes.status || 200,
        durationMs,
        headers,
        requestBody: body,
        responseBody: mockRes.data,
      });
      return { ok: true, status: mockRes.status || 200, data: mockRes.data, isMock: true };
    } catch (err) {
      const durationMs = performance.now() - started;
      recordLog({
        method,
        path,
        mode: "mock",
        status: 400,
        durationMs,
        headers,
        requestBody: body,
        responseBody: { detail: err.message },
        error: err.message,
      });
      return { ok: false, status: 400, data: { detail: err.message }, error: err.message, isMock: true };
    }
  }

  // Live HTTP Mode
  const performLiveFetch = async (reqHeaders) => {
    const fetchOpts = { method, headers: reqHeaders };
    if (keepalive) fetchOpts.keepalive = true;
    if (body !== null && method !== "GET" && method !== "HEAD") {
      fetchOpts.body = JSON.stringify(body);
    }
    const resp = await fetch(`${base}${path}`, fetchOpts);
    const text = await resp.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { resp, parsed };
  };

  try {
    let { resp, parsed } = await performLiveFetch(headers);
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }

    if (
      resp.status === 401 &&
      !skipAuthRefresh &&
      store.state.api.refreshToken &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/register") &&
      !path.startsWith("/api/auth/refresh")
    ) {
      const refreshed = await apiClient.refreshSession();
      if (!isAuthContextCurrent(startKey)) {
        return staleAuthResult();
      }
      if (refreshed.ok) {
        const retryHeaders = buildAuthHeaders(customHeaders);
        ({ resp, parsed } = await performLiveFetch(retryHeaders));
        if (!isAuthContextCurrent(startKey)) {
          return staleAuthResult();
        }
      }
    }

    const durationMs = performance.now() - started;
    recordLog({
      method,
      path,
      mode: "live",
      status: resp.status,
      durationMs,
      headers,
      requestBody: body,
      responseBody: parsed,
      error: resp.ok ? null : parsed?.detail || `HTTP ${resp.status}`,
    });

    if (isAuthContextCurrent(startKey) && resp.status === 401 && !skipUnauthRedirect && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/register")) {
      clearSessionAndSdk({
        redirectToLogin: store.state.ui.authGuardEnabled !== false,
        authError: parsed?.detail || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
      });
    }

    return { ok: resp.ok, status: resp.status, data: parsed, error: resp.ok ? null : parsed?.detail || `HTTP ${resp.status}`, isMock: false };
  } catch (err) {
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    const durationMs = performance.now() - started;
    const msg = `${err.message} (ตรวจสอบว่าเซิร์ฟเวอร์ FastAPI กำลังรันอยู่ที่ ${base})`;
    recordLog({
      method,
      path,
      mode: "live",
      status: 0,
      durationMs,
      headers,
      requestBody: body,
      responseBody: null,
      error: msg,
    });
    return { ok: false, status: 0, data: null, error: msg, isMock: false };
  }
}

export const apiClient = {
  async checkHealth() {
    const started = performance.now();
    const base = store.state.api.baseUrl.replace(/\/+$/, "");
    if (store.state.api.mode === "mock") {
      await sleep(80);
      const data = { status: "healthy (simulated)", service: "Just-Save-It Backend", mcp_enabled: true };
      store.state.api.healthStatus = "healthy";
      store.state.api.healthDetail = data;
      recordLog({
        method: "GET",
        path: "/health",
        mode: "mock",
        status: 200,
        durationMs: performance.now() - started,
        requestBody: null,
        responseBody: data,
      });
      return { ok: true, data };
    }

    const res = await dispatchRequest({
      method: "GET",
      path: "/health",
      mockHandler: () => ({ status: 200, data: {} }),
    });
    store.state.api.healthStatus = res.ok ? "healthy" : "offline";
    store.state.api.healthDetail = res.data || { error: res.error };
    store.emit();
    return res;
  },

  async summarizeLink(itemId, opts = {}) {
    const startKey = getAuthContextKey();
    const item = getLinkById(itemId);
    if (!item) return { ok: false, error: "ไม่พบ item_id ที่ต้องการ" };

    const forceRefresh = opts.forceRefresh ?? store.state.api.summarizeOptions.forceRefresh;
    const saveToNote = opts.saveToNote ?? store.state.api.summarizeOptions.saveToNote;
    const { headers, aiConfigBody, preset } = buildAiHeadersAndConfig();

    const body = {
      item_id: item.id,
      force_refresh: forceRefresh,
      save_to_note: saveToNote,
      ai_config: aiConfigBody,
    };

    store.state.api.isSummarizing = true;
    store.emit();

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/ai/summarize",
      body,
      customHeaders: headers,
      mockHandler: () => {
        if (item.aiSummary && !forceRefresh) {
          return {
            status: 200,
            data: {
              item_id: item.id,
              url: item.url,
              summary_th: item.aiSummary,
              suggested_tags: item.tags,
              cached_from_db: true,
              engine_used: `db-cache (${store.state.data.aiConfig.provider})`,
            },
          };
        }
        const modelName = store.state.data.aiConfig.model || preset.models[0] || "default";
        const engine = `${preset.backendProvider}:${store.state.data.aiConfig.provider} (${modelName})`;
        const generatedSummary =
          item.aiSummary && forceRefresh
            ? `${item.aiSummary} • [อัปเดตสรุปใหม่ด้วย ${modelName}]`
            : `สรุปใจความสำคัญของ "${item.title}" (${item.platform}): คอนเทนต์แนะนำไอเดีย จุดเด่นสำคัญ ขั้นตอน/รายละเอียดที่ควรลองทำตาม และข้อมูลประกอบการตัดสินใจ`;
        const suggested = item.tags.length ? item.tags : ["#สรุปAI", `#${item.platform}`];
        return {
          status: 200,
          data: {
            item_id: item.id,
            url: item.url,
            summary_th: generatedSummary,
            suggested_tags: suggested,
            cached_from_db: false,
            engine_used: engine,
          },
        };
      },
    });

    if (!isAuthContextCurrent(startKey)) {
      return {
        ...res,
        ok: false,
        aborted: true,
        error: "สลับบัญชีระหว่างประมวลผล AI",
      };
    }
    store.state.api.isSummarizing = false;

    if (res.ok && res.data) {
      item.aiSummary = res.data.summary_th || item.aiSummary;
      item.aiCached = Boolean(res.data.cached_from_db);
      item.aiEngine = res.data.engine_used || "";
      if (saveToNote && res.data.summary_th) {
        const prefix = item.note ? `${item.note}\n\n` : "";
        if (!item.note?.includes(res.data.summary_th)) {
          item.note = `${prefix}[AI Summary]\n${res.data.summary_th}`;
        }
      }
      if (Array.isArray(res.data.suggested_tags)) {
        for (const tag of res.data.suggested_tags) {
          const normalized = tag.startsWith("#") ? tag : `#${tag}`;
          if (!item.tags.includes(normalized)) item.tags.push(normalized);
        }
      }
      if (res.data.ai_quota && typeof res.data.ai_quota.remaining === "number") {
        store.state.data.freeQuotaRemaining = res.data.ai_quota.remaining;
        if (typeof res.data.ai_quota.limit === "number") {
          store.state.data.freeQuotaLimit = res.data.ai_quota.limit;
          store.state.data.freeQuotaTotal = res.data.ai_quota.limit;
        }
      } else if (
        !res.data.cached_from_db &&
        preset?.backendProvider === "built-in" &&
        typeof store.state.data.freeQuotaRemaining === "number" &&
        store.state.data.freeQuotaRemaining > 0
      ) {
        store.state.data.freeQuotaRemaining -= 1;
      }
      store.rebuildNotificationsFromWorkspace();
    }
    store.emit();
    return res;
  },

  async testAiConnection() {
    const { headers, aiConfigBody } = buildAiHeadersAndConfig();
    return dispatchRequest({
      method: "POST",
      path: "/api/ai/test",
      body: { ai_config: aiConfigBody },
      customHeaders: headers,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          ok: true,
          provider: aiConfigBody.provider,
          model: aiConfigBody.model,
          engine_used: "mock-ai-test",
        },
      }),
    });
  },

  async previewUrl(rawUrl) {
    const cleanUrl = (rawUrl || "").trim();
    const { platform, domain } = inferPlatform(cleanUrl);
    return dispatchRequest({
      method: "POST",
      path: "/api/preview",
      body: { url: cleanUrl },
      skipUnauthRedirect: true,
      mockHandler: () => {
        let inferredTitle = "ลิงก์ที่บันทึกใหม่";
        if (cleanUrl.toLowerCase().includes("cafe") || cleanUrl.toLowerCase().includes("coffee")) {
          inferredTitle = "คาเฟ่เปิดใหม่ย่านสุขุมวิท (Unfurl Preview)";
        } else if (cleanUrl.toLowerCase().includes("japan") || cleanUrl.toLowerCase().includes("kyoto")) {
          inferredTitle = "ไกด์เที่ยวญี่ปุ่นด้วยตัวเอง 2026";
        } else if (cleanUrl.toLowerCase().includes("recipe") || cleanUrl.toLowerCase().includes("food")) {
          inferredTitle = "สูตรอาหารจานเด็ดทำง่ายที่บ้าน";
        } else if (cleanUrl) {
          inferredTitle = `โพสต์น่าสนใจจาก ${platform} (${domain})`;
        }
        return {
          status: 200,
          data: {
            url: cleanUrl,
            platform,
            domain,
            title: inferredTitle,
            suggested_tags: platform === "TikTok" ? ["#คาเฟ่", "#วิดีโอสั้น"] : [`#${platform}`],
          },
        };
      },
    });
  },

  async createLink(payload) {
    const startKey = getAuthContextKey();
    const cleanUrl = (payload.url || "").trim();
    if (cleanUrl && safeHrefUrl(cleanUrl) === "#") {
      store.showToast("URL ไม่ถูกต้อง (รองรับเฉพาะ http:// และ https://)");
      return null;
    }
    const { platform, domain } = inferPlatform(cleanUrl);
    const isFav = Boolean(payload.favorite ?? payload.is_favorite ?? payload.pinned);
    const rawTags = payload.tag_names ?? payload.tags ?? [];
    const tags = rawTags.length ? [...rawTags] : ["#บันทึกใหม่"];
    const backendTags = tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);

    let previewData = {};
    if (cleanUrl && store.state.api.mode === "live" && payload.waitForPreview === true && !payload.skipPreview) {
      try {
        const pv = await this.previewUrl(cleanUrl);
        if (!isAuthContextCurrent(startKey)) return null;
        if (pv.ok && pv.data) previewData = pv.data;
      } catch {}
    }

    const mediaItems = Array.isArray(payload.media_items) && payload.media_items.length
      ? payload.media_items
      : Array.isArray(previewData.media_items)
        ? previewData.media_items
        : [];
    const coverUrl =
      resolveMediaThumbUrl({
        thumbnail_url: payload.thumbnail_url,
        coverUrl: payload.coverUrl,
        image_url: previewData.image_url,
        media_items: mediaItems,
      }) || null;
    const embedUrl = payload.embed_url || previewData.embed_url || null;
    const embedType = payload.embed_type || previewData.embed_type || "none";
    const resolvedTitle = payload.title || previewData.title || `โพสต์ใหม่จาก ${platform}`;
    const resolvedStatus = mapUiStatusToBackend(payload.status || "unread");
    const rawFolderId =
      payload.folderId !== undefined
        ? payload.folderId
        : payload.folder_id !== undefined
          ? payload.folder_id
          : store.state.data.folders[0]?.id || null;
    const isMockSeedFolder = String(rawFolderId || "").startsWith("f1a1000");
    const folderId = store.state.api.mode === "live" && isMockSeedFolder ? null : rawFolderId;

    let reminderConfig = null;
    if (payload.reminderDate) {
      const timeStr = (payload.reminderTime || "18:00").slice(0, 5);
      const remindAtIso = `${payload.reminderDate}T${timeStr}:00+07:00`;
      reminderConfig = {
        schedule_type: payload.scheduleType || "once",
        remind_at: remindAtIso,
        repeat_every_days: payload.scheduleType === "every_n_days" ? Number(payload.repeatEveryDays || 3) : null,
        remind_time: `${timeStr}:00`,
        timezone: "Asia/Bangkok",
      };
    }

    const reqBody = {
      url: cleanUrl || `https://${domain}/p/${Date.now()}`,
      title: resolvedTitle,
      description: payload.description ?? previewData.description ?? null,
      thumbnail_url: coverUrl,
      media_items: mediaItems,
      embed_url: embedUrl,
      embed_type: embedType,
      platform: previewData.platform || platform,
      note: payload.user_note ?? payload.note ?? "",
      user_note: payload.user_note ?? payload.note ?? "",
      folder_id: folderId,
      tags: backendTags,
      tag_names: backendTags,
      status: resolvedStatus,
      is_favorite: isFav,
      ...(reminderConfig ? { reminder: reminderConfig } : {}),
    };

    const localFallback = {
      id: generateUuid(),
      folderId,
      platform: reqBody.platform,
      url: reqBody.url,
      domain,
      title: reqBody.title,
      description: reqBody.description || "",
      coverUrl,
      media_items: mediaItems,
      embed_url: embedUrl,
      embed_type: embedType,
      previewStatus: payload.preview_status || previewData.preview_status || "ok",
      savedAgo: "เมื่อสักครู่",
      status: mapBackendStatusToUi(resolvedStatus),
      favorite: isFav,
      tags,
      note: reqBody.note,
      aiSummary: "",
      aiCached: false,
      reminder: payload.reminderDate ? `${payload.reminderDate} ${payload.reminderTime || "18:00"}` : null,
      reminderDate: payload.reminderDate || null,
      reminderTime: payload.reminderTime || "18:00",
      scheduleType: payload.scheduleType || "once",
      repeatEveryDays: payload.repeatEveryDays || null,
      sourceApp: payload.sourceApp || reqBody.platform,
    };

    const isLiveMode = store.state.api.mode === "live";
    const targetFolderId = localFallback.folderId;
    const folder = getFolderById(targetFolderId);
    let optimisticItem = null;
    let optimisticIncrementedCount = false;
    if (isLiveMode) {
      optimisticItem = { ...localFallback, pending: true, _optimistic: true };
      store.state.data.links.unshift(optimisticItem);
      if (folder) {
        folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;
        optimisticIncrementedCount = true;
      }
      store.state.ui.highlightLinkId = optimisticItem.id;
      noteLocalMutation();
      store.emit();
    }
    const optimisticId = optimisticItem?.id || null;

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/items",
      body: reqBody,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 201, data: localFallback }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return null;
    }

    if (isLiveMode && !res.ok) {
      if (optimisticItem) {
        const optIdx = store.state.data.links.indexOf(optimisticItem);
        if (optIdx !== -1) store.state.data.links.splice(optIdx, 1);
        if (optimisticIncrementedCount && getFolderById(targetFolderId) === folder && folder.baseExternalCount > 0) {
          folder.baseExternalCount -= 1;
        }
        if (optimisticId && store.state.ui.activeLinkId === optimisticId) {
          store.state.ui.activeLinkId = store.state.data.links[0]?.id || null;
        }
      }
      store.showToast(res.error || "บันทึกโพสต์ไม่สำเร็จ");
      store.emit();
      return null;
    }

    const newItem = res.ok && res.data?.id ? { ...localFallback, ...mapBackendItemToUi(res.data) } : localFallback;
    const wasDeduplicated = Boolean(res.data?.deduplicated);
    const existingIdx = store.state.data.links.findIndex((item) => item !== optimisticItem && item.id === newItem.id);
    const optIdx = optimisticItem ? store.state.data.links.indexOf(optimisticItem) : -1;

    if (optIdx !== -1 && existingIdx !== -1) {
      store.state.data.links.splice(optIdx, 1);
      const adjExistingIdx = optIdx < existingIdx ? existingIdx - 1 : existingIdx;
      store.state.data.links.splice(adjExistingIdx, 1, newItem);
      if (optimisticIncrementedCount && getFolderById(targetFolderId) === folder && folder.baseExternalCount > 0) {
        folder.baseExternalCount -= 1;
      }
    } else if (optIdx !== -1) {
      store.state.data.links.splice(optIdx, 1, newItem);
      if (wasDeduplicated && optimisticIncrementedCount && getFolderById(targetFolderId) === folder && folder.baseExternalCount > 0) {
        folder.baseExternalCount -= 1;
      }
    } else if (existingIdx !== -1) {
      store.state.data.links.splice(existingIdx, 1, newItem);
      if ((wasDeduplicated || optimisticIncrementedCount) && getFolderById(targetFolderId) === folder && folder.baseExternalCount > 0 && optimisticIncrementedCount) {
        folder.baseExternalCount -= 1;
      }
    } else {
      store.state.data.links.unshift(newItem);
      if (!optimisticIncrementedCount && !wasDeduplicated && folder) {
        folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;
      }
    }

    if (optimisticId && store.state.ui.activeLinkId === optimisticId) {
      store.state.ui.activeLinkId = newItem.id;
    }

    store.state.data.lastSharedEvent = {
      id: newItem.id,
      title: newItem.title,
      url: newItem.url,
      platform: newItem.platform,
      domain: newItem.domain,
      folderId: newItem.folderId,
      folderName: folder?.name || "ยังไม่จัดหมวด",
      pinned: isFav,
      tags: newItem.tags,
      at: new Date().toLocaleTimeString("th-TH", { hour12: false }),
      iso: new Date().toISOString(),
    };
    store.state.ui.highlightLinkId = newItem.id;
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("createLink");
    store.emit();

    const needsBackgroundEnrich =
      isLiveMode &&
      res.ok &&
      newItem.id &&
      cleanUrl &&
      !payload.skipPreview &&
      payload.waitForPreview !== true &&
      (!newItem.coverUrl ||
        !newItem.description ||
        newItem.title === newItem.url ||
        String(newItem.title || "").startsWith("โพสต์ใหม่จาก "));
    if (needsBackgroundEnrich) {
      Promise.resolve()
        .then(() => (isAuthContextCurrent(startKey) ? this.refreshItemPreview(newItem.id, { silent: true }) : null))
        .catch(() => {});
    }
    return newItem;
  },

  async patchLink(itemId, updates) {
    const startKey = getAuthContextKey();
    const item = getLinkById(itemId);
    if (!item) return null;
    const prevSnapshot = { ...item, tags: Array.isArray(item.tags) ? [...item.tags] : [] };
    Object.assign(item, updates);
    if ("status" in updates) {
      const nextWorkflow = normalizeWorkflowStatus(updates.status);
      item.status = mapBackendStatusToUi(nextWorkflow);
      item.workflowStatus = nextWorkflow;
    }
    store.emit();

    const body = {};
    if ("title" in updates) body.title = updates.title;
    if ("description" in updates) body.description = updates.description;
    if ("note" in updates || "user_note" in updates) {
      const noteVal = updates.user_note ?? updates.note;
      body.note = noteVal;
      body.user_note = noteVal;
    }
    if ("folderId" in updates || "folder_id" in updates) {
      body.folder_id = updates.folder_id !== undefined ? updates.folder_id : updates.folderId;
    }
    if ("status" in updates) {
      body.status = mapUiStatusToBackend(updates.status);
    }
    if ("favorite" in updates || "is_favorite" in updates) {
      body.is_favorite = Boolean(updates.is_favorite ?? updates.favorite);
    }
    if ("tags" in updates || "tag_names" in updates) {
      const cleanTags = (updates.tag_names ?? updates.tags ?? [])
        .map((t) => String(t).replace(/^#/, "").trim())
        .filter(Boolean);
      body.tags = cleanTags;
      body.tag_names = cleanTags;
    }

    const res = await dispatchRequest({
      method: "PATCH",
      path: `/api/items/${itemId}`,
      body,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: item }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return null;
    }
    if (store.state.api.mode === "live" && !res.ok) {
      Object.assign(item, prevSnapshot);
      store.showToast(res.error || "อัปเดตรายการไม่สำเร็จ");
      store.emit();
      return null;
    }
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("patchLink");
    store.emit();
    return item;
  },

  async refreshItemPreview(itemId, { silent = false } = {}) {
    const startKey = getAuthContextKey();
    const item = getLinkById(itemId);
    if (!item) return { ok: false, status: 404, error: "ไม่พบรายการ" };
    const res = await dispatchRequest({
      method: "POST",
      path: `/api/items/${itemId}/refresh-preview`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          status: "ok",
          item: {
            id: item.id,
            title: item.title,
            description: item.description,
            thumbnail_url: item.coverUrl,
            media_items: item.media_items || [],
            embed_url: item.embed_url || null,
            embed_type: item.embed_type || "none",
            platform: item.platform,
            url: item.url,
          },
        },
      }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    if (!res.ok) {
      if (!silent) store.showToast(res.error || "รีเฟรชพรีวิวลิงก์ไม่สำเร็จ");
      return res;
    }
    const rawUpdated = res.data?.item || res.data;
    if (rawUpdated && typeof rawUpdated === "object") {
      const mapped = mapBackendItemToUi({
        ...rawUpdated,
        id: item.id,
        url: rawUpdated.url || item.url,
        folder_id: rawUpdated.folder_id !== undefined ? rawUpdated.folder_id : item.folderId,
        tags: rawUpdated.tags || item.tags,
        note: rawUpdated.note ?? item.note,
        status: rawUpdated.status || item.workflowStatus || item.status,
      });
      Object.assign(item, mapped, { savedAgo: item.savedAgo });
      saveWorkspaceCache();
      broadcastLocalChange("refreshItemPreview");
      store.emit();
    }
    if (!silent) store.showToast("รีเฟรชพรีวิวลิงก์แล้ว");
    return res;
  },

  async resolveItemVideo(itemId) {
    if (!itemId) return { ok: false, data: { video_url: null } };
    const startKey = getAuthContextKey();
    const res = await dispatchRequest({
      method: "GET",
      path: `/api/items/${encodeURIComponent(itemId)}/video`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: { item_id: itemId, video_url: null },
      }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    return res;
  },

  async deleteLink(itemId) {
    const startKey = getAuthContextKey();
    const idx = store.state.data.links.findIndex((l) => l.id === itemId);
    if (idx === -1) return false;
    const [removed] = store.state.data.links.splice(idx, 1);
    const folder = getFolderById(removed.folderId);
    if (folder && folder.baseExternalCount > 0) folder.baseExternalCount -= 1;
    noteLocalMutation();
    store.emit();
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/items/${itemId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true, id: itemId } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return false;
    }
    if (store.state.api.mode === "live" && !res.ok) {
      store.state.data.links.splice(idx, 0, removed);
      if (folder) folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;
      store.showToast(res.error || "ลบโพสต์ไม่สำเร็จ");
      store.emit();
      return false;
    }
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("deleteLink");
    store.emit();
    return true;
  },

  async saveFolder({ folderId = null, name, emoji = "📁", cover }) {
    const startKey = getAuthContextKey();
    const cleanName = String(name || "").trim() || "โฟลเดอร์ใหม่";
    const cleanEmoji = emoji || "📁";
    if (folderId) {
      const folder = getFolderById(folderId);
      if (!folder) return null;
      const prev = { name: folder.name, emoji: folder.emoji, cover: folder.cover };
      folder.name = cleanName;
      folder.emoji = cleanEmoji;
      if (cover) folder.cover = cover;
      noteLocalMutation();
      store.emit();
      const res = await dispatchRequest({
        method: "PATCH",
        path: `/api/folders/${folderId}`,
        body: { name: cleanName, emoji: cleanEmoji, ...(cover ? { cover_url: cover } : {}) },
        skipUnauthRedirect: true,
        mockHandler: () => ({ status: 200, data: folder }),
      });
      if (!isAuthContextCurrent(startKey)) {
        return null;
      }
      if (store.state.api.mode === "live" && !res.ok) {
        Object.assign(folder, prev);
        store.showToast(res.error || "แก้ไขโฟลเดอร์ไม่สำเร็จ");
        store.emit();
        return null;
      }
      if (res.ok && res.data && typeof res.data === "object") {
        if (res.data.name) folder.name = res.data.name;
        if (res.data.emoji) folder.emoji = res.data.emoji;
        if (res.data.cover_url || res.data.cover) folder.cover = res.data.cover_url || res.data.cover;
      }
      store.rebuildNotificationsFromWorkspace();
      saveWorkspaceCache();
      broadcastLocalChange("saveFolder");
      store.emit();
      return folder;
    }

    const resolvedCover = cover || "./assets/covers/project.png";
    const fallbackFolder = {
      id: generateUuid(),
      name: cleanName,
      emoji: cleanEmoji,
      cover: resolvedCover,
      sharedCount: 0,
      sharedUsers: [],
      role: "owner",
      inviteSlug: `f-${Math.random().toString(36).slice(2, 7)}`,
      baseExternalCount: 0,
    };
    const res = await dispatchRequest({
      method: "POST",
      path: "/api/folders",
      body: { name: cleanName, emoji: cleanEmoji, cover_url: resolvedCover },
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 201, data: fallbackFolder }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return null;
    }
    if (store.state.api.mode === "live" && !res.ok) {
      store.showToast(res.error || "สร้างโฟลเดอร์ไม่สำเร็จ");
      return null;
    }
    const finalFolder = res.ok && res.data?.id ? { ...fallbackFolder, ...res.data, cover: res.data.cover_url || resolvedCover } : fallbackFolder;
    store.state.data.folders.push(finalFolder);
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("saveFolder");
    store.emit();
    return finalFolder;
  },

  async deleteFolder(folderId) {
    const startKey = getAuthContextKey();
    const idx = store.state.data.folders.findIndex((f) => f.id === folderId);
    if (idx === -1) return { ok: false, error: "ไม่พบโฟลเดอร์ที่ต้องการลบ" };
    const [removed] = store.state.data.folders.splice(idx, 1);
    const affectedLinkIds = [];
    store.state.data.links.forEach((l) => {
      if (l.folderId === folderId) {
        affectedLinkIds.push(l.id);
        l.folderId = null;
      }
    });
    if (store.state.ui.activeFolderId === folderId) {
      store.state.ui.activeFolderId = store.state.data.folders[0]?.id || null;
    }
    noteLocalMutation();
    store.emit();
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/folders/${folderId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true, id: folderId } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    if (store.state.api.mode === "live" && !res.ok) {
      store.state.data.folders.splice(idx, 0, removed);
      store.state.data.links.forEach((l) => {
        if (affectedLinkIds.includes(l.id)) l.folderId = folderId;
      });
      store.state.ui.activeFolderId = folderId;
      store.showToast(res.error || "ลบโฟลเดอร์ไม่สำเร็จ");
      store.emit();
      return res;
    }
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("deleteFolder");
    store.emit();
    return res;
  },

  async listFolderMembers(folderId) {
    return dispatchRequest({
      method: "GET",
      path: `/api/folders/${folderId}/members`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => {
        const folder = getFolderById(folderId);
        return {
          status: 200,
          data: {
            members: [
              {
                user_id: store.state.data.user.id,
                display_name: store.state.data.user.displayName || "คุณ",
                email: store.state.data.user.email || "",
                role: folder?.role || "owner",
              },
              ...(folder?.sharedUsers || []).map((name, i) => ({
                user_id: `mock-member-${i + 1}`,
                display_name: typeof name === "string" ? name : name?.display_name || "สมาชิก",
                role: "editor",
              })),
            ],
            active_invites: folder?.inviteSlug
              ? [{ token: folder.inviteSlug, role: "editor", expires_at: null }]
              : [],
          },
        };
      },
    });
  },

  async updateFolderMemberRole(folderId, memberUserId, role) {
    return dispatchRequest({
      method: "PATCH",
      path: `/api/folders/${folderId}/members/${memberUserId}`,
      body: { role },
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { user_id: memberUserId, role } }),
    });
  },

  async removeFolderMember(folderId, memberUserId) {
    return dispatchRequest({
      method: "DELETE",
      path: `/api/folders/${folderId}/members/${memberUserId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { removed: true, user_id: memberUserId } }),
    });
  },

  async revokeFolderInvite(folderId, token) {
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/folders/${folderId}/invites/${encodeURIComponent(token)}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { revoked: true, token } }),
    });
    if (res.ok) {
      const f = getFolderById(folderId);
      if (f && f.inviteSlug === token) {
        f.inviteUrl = "";
      }
      store.emit();
    }
    return res;
  },

  async listReminders() {
    return dispatchRequest({
      method: "GET",
      path: "/api/reminders",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          reminders: store.state.data.links
            .filter((l) => l.reminder)
            .map((l) => ({
              item_id: l.id,
              schedule_type: l.scheduleType || "once",
              remind_at: l.reminderDate ? `${l.reminderDate}T${l.reminderTime || "18:00"}:00+07:00` : null,
              repeat_every_days: l.repeatEveryDays ?? null,
              remind_time: `${l.reminderTime || "18:00"}:00`,
              timezone: "Asia/Bangkok",
            })),
        },
      }),
    });
  },

  async saveReminder(itemId, { scheduleType = "once", remindAt, reminderDate, reminderTime = "18:00", repeatEveryDays = null }) {
    const startKey = getAuthContextKey();
    const item = getLinkById(itemId);
    const prevRem = item
      ? {
          reminder: item.reminder,
          reminderDate: item.reminderDate,
          reminderTime: item.reminderTime,
          scheduleType: item.scheduleType,
          repeatEveryDays: item.repeatEveryDays,
        }
      : null;
    const timeShort = String(reminderTime || "18:00").slice(0, 5);
    const datePart = reminderDate || formatRemindIsoInBangkok(new Date().toISOString()).date;
    const isoAt = remindAt || `${datePart}T${timeShort}:00+07:00`;
    const body = {
      item_id: itemId,
      schedule_type: scheduleType,
      next_remind_at: isoAt,
      remind_at: isoAt,
      repeat_every_days: scheduleType === "every_n_days" ? Number(repeatEveryDays || 3) : null,
      remind_time: `${timeShort}:00`,
      timezone: "Asia/Bangkok",
      is_enabled: true,
    };

    if (item) {
      item.reminderDate = datePart;
      item.reminderTime = timeShort;
      item.scheduleType = scheduleType;
      item.repeatEveryDays = scheduleType === "every_n_days" ? Number(repeatEveryDays || 3) : null;
      item.reminder =
        scheduleType === "every_n_days"
          ? `ทุก ${item.repeatEveryDays} วัน · ${timeShort}`
          : `${datePart} ${timeShort}`;
      noteLocalMutation();
      store.emit();
    }

    const res = await dispatchRequest({
      method: "PUT",
      path: `/api/reminders/${itemId}`,
      body,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { ...body, status: "pending" } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return { ...res, ok: false, aborted: true };
    }
    if (store.state.api.mode === "live" && !res.ok && item && prevRem) {
      Object.assign(item, prevRem);
      store.emit();
      return res;
    }
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("saveReminder");
    store.emit();
    return res;
  },

  async deleteReminder(itemId) {
    const startKey = getAuthContextKey();
    const item = getLinkById(itemId);
    const prevRem = item
      ? {
          reminder: item.reminder,
          reminderDate: item.reminderDate,
          reminderTime: item.reminderTime,
          scheduleType: item.scheduleType,
          repeatEveryDays: item.repeatEveryDays,
        }
      : null;
    if (item) {
      item.reminder = null;
      item.reminderDate = null;
      item.scheduleType = "once";
      item.repeatEveryDays = null;
      noteLocalMutation();
      store.emit();
    }
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/reminders/${itemId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true, item_id: itemId } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return { ...res, ok: false, aborted: true };
    }
    if (store.state.api.mode === "live" && !res.ok && item && prevRem) {
      Object.assign(item, prevRem);
      store.emit();
      return res;
    }
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache();
    broadcastLocalChange("deleteReminder");
    store.emit();
    return res;
  },

  async createFolderInvite(folderId, role = "viewer") {
    const folder = getFolderById(folderId) || store.state.data.folders[0];
    const slug = folder?.inviteSlug || `f-${Math.random().toString(36).slice(2, 8)}`;
    const res = await dispatchRequest({
      method: "POST",
      path: `/api/folders/${folderId}/invites`,
      body: { role: role === "editor" ? "editor" : "viewer", expires_in_days: 7 },
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 201,
        data: {
          token: slug,
          folder_id: folderId,
          role,
          invite_url: buildFolderInviteUrl({ id: folderId, inviteSlug: slug }, role),
        },
      }),
    });
    if (res.ok && res.data?.invite_url && folder) {
      folder.inviteUrl = res.data.invite_url;
      folder.inviteSlug = res.data.token || slug;
      folder.sharedCount = Math.max(folder.sharedCount || 0, 1);
      store.emit();
    }
    return res;
  },

  async hydrateWorkspace() {
    if (store.state.api.mode !== "live") return { ok: true, hydrated: false };
    const isAuthenticatedLive = Boolean(store.state.api.bearerToken);
    if (!isAuthenticatedLive) {
      return { ok: false, hydrated: false };
    }

    const startKey = getAuthContextKey();
    const cached = loadWorkspaceCache(resolveCacheUserId());
    if (cached) {
      applyWorkspaceCacheSnapshot(cached);
    }

    if (_hydrateInFlightPromise && _hydrateInFlightContextKey === startKey) {
      return _hydrateInFlightPromise;
    }

    const task = (async () => {
      try {
        const wsRes = await dispatchRequest({
          method: "GET",
          path: "/api/workspace?limit=100",
          body: null,
          skipUnauthRedirect: true,
          mockHandler: () => ({ status: 404, data: null }),
        });

        if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
          return { ok: false, hydrated: false, stale: true };
        }

        if (wsRes?.status === 401) {
          clearSessionAndSdk({
            redirectToLogin: store.state.ui.authGuardEnabled !== false,
            authError: wsRes.error || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
          });
          return { ok: false, hydrated: false, status: 401 };
        }

        if (wsRes?.ok && wsRes.data && Array.isArray(wsRes.data.items)) {
          const d = wsRes.data;
          const allRows = [];
          const seenIds = new Set();
          mergeUniqueRowsById(allRows, seenIds, d.items);
          let nextCursor = d.next_cursor || null;
          let pageCount = 0;
          while (nextCursor && pageCount < 25) {
            pageCount += 1;
            const nextPage = await dispatchRequest({
              method: "GET",
              path: `/api/items?limit=100&cursor=${encodeURIComponent(nextCursor)}`,
              body: null,
              skipUnauthRedirect: true,
              mockHandler: () => ({ status: 200, data: { items: [], next_cursor: null } }),
            });
            if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
              return { ok: false, hydrated: false, stale: true };
            }
            if (nextPage?.status === 401) {
              clearSessionAndSdk({
                redirectToLogin: store.state.ui.authGuardEnabled !== false,
                authError: nextPage.error || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
              });
              return { ok: false, hydrated: false, status: 401 };
            }
            const batch = nextPage?.ok && Array.isArray(nextPage.data?.items) ? nextPage.data.items : [];
            const added = mergeUniqueRowsById(allRows, seenIds, batch);
            const candidateCursor = nextPage?.data?.next_cursor || null;
            if (batch.length === 0 || added === 0 || !candidateCursor || candidateCursor === nextCursor) break;
            nextCursor = candidateCursor;
          }
          if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
            return { ok: false, hydrated: false, stale: true };
          }
          applyWorkspacePayload({
            meData: d,
            folders: d.folders,
            itemRows: allRows,
            tags: d.tags,
            reminders: d.reminders,
          });
          saveWorkspaceCache(resolveCacheUserId());
          return {
            ok: true,
            folders: store.state.data.folders.length,
            links: store.state.data.links.length,
          };
        }

        // Legacy fallback when backend has not rolled /api/workspace yet
        const [meRes, foldersRes, itemsRes, tagsRes, remindersRes] = await Promise.all([
          dispatchRequest({
            method: "GET",
            path: "/api/auth/me",
            body: null,
            skipUnauthRedirect: true,
            mockHandler: () => ({ status: 200, data: { user: store.state.data.user } }),
          }),
          dispatchRequest({
            method: "GET",
            path: "/api/folders",
            body: null,
            skipUnauthRedirect: true,
            mockHandler: () => ({ status: 200, data: { folders: store.state.data.folders } }),
          }),
          dispatchRequest({
            method: "GET",
            path: "/api/items?limit=100",
            body: null,
            skipUnauthRedirect: true,
            mockHandler: () => ({ status: 200, data: { items: [] } }),
          }),
          dispatchRequest({
            method: "GET",
            path: "/api/tags",
            body: null,
            skipUnauthRedirect: true,
            mockHandler: () => ({ status: 200, data: { tags: [] } }),
          }),
          dispatchRequest({
            method: "GET",
            path: "/api/reminders",
            body: null,
            skipUnauthRedirect: true,
            mockHandler: () => ({ status: 200, data: { reminders: [] } }),
          }),
        ]);

        if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
          return { ok: false, hydrated: false, stale: true };
        }

        const first401 = [meRes, foldersRes, itemsRes, tagsRes, remindersRes].find((r) => r?.status === 401);
        if (first401) {
          clearSessionAndSdk({
            redirectToLogin: store.state.ui.authGuardEnabled !== false,
            authError: first401.error || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
          });
          return { ok: false, hydrated: false, status: 401 };
        }

        let itemRows = null;
        if (itemsRes?.ok && Array.isArray(itemsRes.data?.items)) {
          itemRows = [];
          const seenIds = new Set();
          mergeUniqueRowsById(itemRows, seenIds, itemsRes.data.items);
          let nextCursor = itemsRes.data?.next_cursor || null;
          let pageCount = 0;
          while (store.state.api.mode === "live" && nextCursor && pageCount < 25) {
            pageCount += 1;
            const nextPage = await dispatchRequest({
              method: "GET",
              path: `/api/items?limit=100&cursor=${encodeURIComponent(nextCursor)}`,
              body: null,
              skipUnauthRedirect: true,
              mockHandler: () => ({ status: 200, data: { items: [], next_cursor: null } }),
            });
            if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
              return { ok: false, hydrated: false, stale: true };
            }
            if (nextPage?.status === 401) {
              clearSessionAndSdk({
                redirectToLogin: store.state.ui.authGuardEnabled !== false,
                authError: nextPage.error || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
              });
              return { ok: false, hydrated: false, status: 401 };
            }
            const batch = nextPage?.ok && Array.isArray(nextPage.data?.items) ? nextPage.data.items : [];
            const added = mergeUniqueRowsById(itemRows, seenIds, batch);
            const candidateCursor = nextPage?.data?.next_cursor || null;
            if (batch.length === 0 || added === 0 || !candidateCursor || candidateCursor === nextCursor) break;
            nextCursor = candidateCursor;
          }
        }

        if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
          return { ok: false, hydrated: false, stale: true };
        }

        applyWorkspacePayload({
          meData: meRes?.ok ? meRes.data : null,
          folders: foldersRes?.ok ? foldersRes.data?.folders : null,
          itemRows,
          tags: tagsRes?.ok ? tagsRes.data?.tags : null,
          reminders: remindersRes?.ok ? remindersRes.data?.reminders : null,
        });
        saveWorkspaceCache(resolveCacheUserId());
        return {
          ok: Boolean(foldersRes?.ok || itemsRes?.ok),
          folders: store.state.data.folders.length,
          links: store.state.data.links.length,
        };
      } finally {
        if (_hydrateInFlightPromise === task) {
          _hydrateInFlightPromise = null;
          _hydrateInFlightContextKey = "";
        }
      }
    })();

    _hydrateInFlightPromise = task;
    _hydrateInFlightContextKey = startKey;
    return task;
  },

  async applyRealtimeDelta(syncMeta = {}) {
    if (!store.state.data.user?.isAuthenticated) {
      return staleAuthResult();
    }
    const startKey = getAuthContextKey();
    const deltas = Array.isArray(syncMeta?.deltas) ? syncMeta.deltas : [];
    const forceFullSync = Boolean(syncMeta?.forceFullSync) || deltas.length === 0;
    if (!forceFullSync) {
      let handledAll = true;
      let mutated = false;
      for (const delta of deltas) {
        if (delta.table === "items" && delta.type === "DELETE" && delta.oldRecord?.id) {
          const before = store.state.data.links.length;
          store.state.data.links = store.state.data.links.filter((l) => l.id !== delta.oldRecord.id);
          if (store.state.data.links.length !== before) mutated = true;
        } else if (delta.table === "items" && delta.type === "UPDATE" && delta.record?.id) {
          const existing = getLinkById(delta.record.id);
          if (existing) {
            const mapped = mapBackendItemToUi(delta.record);
            Object.assign(existing, {
              folderId: mapped.folderId,
              title: mapped.title,
              description: mapped.description,
              coverUrl: mapped.coverUrl || existing.coverUrl,
              media_items: mapped.media_items?.length ? mapped.media_items : existing.media_items,
              embed_url: mapped.embed_url ?? existing.embed_url,
              embed_type: mapped.embed_type || existing.embed_type,
              status: mapped.status,
              workflowStatus: mapped.workflowStatus,
              favorite: mapped.favorite,
              note: mapped.note,
              aiSummary: mapped.aiSummary,
              aiCached: mapped.aiCached,
            });
            mutated = true;
          } else {
            handledAll = false;
          }
        } else {
          handledAll = false;
        }
      }
      if (handledAll) {
        if (mutated) {
          store.rebuildNotificationsFromWorkspace();
          saveWorkspaceCache();
          store.emit();
        }
        return { ok: true, mode: "delta" };
      }
    }
    if (!store.state.data.user?.isAuthenticated || !isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    return this.hydrateWorkspace();
  },

  async previewInvite(token) {
    const cleanToken = String(token || "").trim();
    if (!cleanToken) return { ok: false, status: 400, error: "ไม่พบ Invite Token" };
    return dispatchRequest({
      method: "GET",
      path: `/api/invites/${encodeURIComponent(cleanToken)}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => {
        const matched = store.state.data.folders.find((f) => f.inviteSlug === cleanToken || f.id === cleanToken) || store.state.data.folders[0];
        if (!matched) return { status: 404, data: { detail: "Invite not found" } };
        return {
          status: 200,
          data: {
            token: cleanToken,
            valid: true,
            folder_id: matched.id,
            folder_name: matched.name,
            folder_emoji: matched.emoji,
            folder_cover_url: matched.cover,
            role: "editor",
            inviter_name: "เมย์",
            item_count: (store.state.data.links || []).filter((l) => l.folderId === matched.id).length,
          },
        };
      },
    });
  },

  async acceptInvite(tokenOrFolderId) {
    const startKey = getAuthContextKey();
    const folder = getFolderById(tokenOrFolderId) || (store.state.api.mode !== "live" ? store.state.data.folders[0] : null);
    const token = folder?.inviteSlug || String(tokenOrFolderId || "").trim();
    if (!token) return null;
    const res = await dispatchRequest({
      method: "POST",
      path: `/api/invites/${encodeURIComponent(token)}/accept`,
      body: { user_id: store.state.data.user.id },
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { joined_folder: folder?.id || token, role: "editor" } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return null;
    }
    if (!res.ok && (store.state.api.mode === "live" || res.stale)) {
      return null;
    }
    if (store.state.api.mode === "live" && store.state.api.bearerToken) {
      await this.hydrateWorkspace();
      if (!isAuthContextCurrent(startKey)) {
        return null;
      }
      const joinedId = res.data?.folder_id || res.data?.joined_folder || folder?.id;
      const hydratedFolder = getFolderById(joinedId) || store.state.data.folders[0] || { id: joinedId, name: "โฟลเดอร์ที่เข้าร่วม" };
      return hydratedFolder;
    }
    if (folder) {
      if (!folder.sharedUsers.includes(store.state.data.user.displayName)) {
        folder.sharedUsers.push(store.state.data.user.displayName);
        folder.sharedCount = Math.max((folder.sharedCount || 0) + 1, folder.sharedUsers.length);
      }
      store.state.data.user.isAuthenticated = true;
      store.rebuildNotificationsFromWorkspace();
      store.emit();
      return folder;
    }
    return res.data || null;
  },

  async signInEmail(email) {
    const clean = (email || "").trim() || (store.state.api.useDevBypass ? "may@example.com" : "");
    if (!clean) {
      return { ok: false, status: 400, error: "กรุณากรอกอีเมลก่อนดำเนินการต่อ" };
    }
    const authMode = getAuthMode(store.state);

    if (authMode === "supabase") {
      const started = performance.now();
      const res = await supabaseAuth.signInWithMagicLink(getSupabaseConfig(), { email: clean });
      recordLog({
        method: "POST",
        path: "/auth/v1/otp",
        mode: "supabase",
        status: res.status || (res.ok ? 200 : 400),
        durationMs: performance.now() - started,
        requestBody: { email: clean },
        responseBody: res.data || { error: res.error },
        error: res.ok ? null : res.error,
      });
      return res;
    }

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/magic-link",
      body: { email: clean },
      mockHandler: () => ({
        status: 200,
        data: { sent: true, email: clean, user_id: store.state.data.user.id },
      }),
    });
    if (res.ok && res.data) {
      if (res.isMock || res.data.access_token) {
        store.applyAuthenticatedSession({
          user: res.data.user || { id: store.state.data.user.id, email: clean },
          accessToken: res.data.access_token || "",
          refreshToken: res.data.refresh_token || "",
          claims: res.data.access_token ? extractClaimsSummary(res.data.access_token) : null,
          isMock: Boolean(res.isMock),
        });
      }
    }
    return res;
  },

  async signInPassword(email, password) {
    const clean = (email || "").trim() || (store.state.api.useDevBypass ? "may@example.com" : "");
    if (!clean || !password) {
      return { ok: false, status: 400, error: "กรุณากรอกอีเมลและรหัสผ่านก่อนเข้าสู่ระบบ" };
    }
    const authMode = getAuthMode(store.state);

    if (authMode === "supabase") {
      const startKey = getAuthContextKey();
      const started = performance.now();
      const res = await supabaseAuth.signInWithPassword(getSupabaseConfig(), { email: clean, password });
      if (!isAuthContextCurrent(startKey)) {
        return staleAuthResult();
      }
      recordLog({
        method: "POST",
        path: "/auth/v1/token?grant_type=password",
        mode: "supabase",
        status: res.status || (res.ok ? 200 : 401),
        durationMs: performance.now() - started,
        requestBody: { email: clean, password: "***" },
        responseBody: res.data
          ? { ...res.data, access_token: res.data.access_token ? `${res.data.access_token.slice(0, 18)}...` : "" }
          : { error: res.error },
        error: res.ok ? null : res.error,
      });
      if (res.ok && res.data?.access_token) {
        store.applyAuthenticatedSession({
          user: res.data.user,
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token || "",
          claims: res.data.claims || extractClaimsSummary(res.data.access_token),
        });
      } else {
        store.state.ui.authError = res.error || "เข้าสู่ระบบไม่สำเร็จ";
        store.emit();
      }
      return res;
    }

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/login",
      body: { email: clean, password },
      mockHandler: () => ({
        status: 200,
        data: {
          access_token: `mock_jwt_${Date.now()}`,
          refresh_token: `mock_ref_${Date.now()}`,
          token_type: "bearer",
          user: { ...store.state.data.user, email: clean },
        },
      }),
    });
    if (res.ok && res.data) {
      store.applyAuthenticatedSession({
        user: res.data.user || { id: store.state.data.user.id, email: clean },
        accessToken: res.data.access_token || "",
        refreshToken: res.data.refresh_token || "",
        claims: res.data.access_token && !res.isMock ? extractClaimsSummary(res.data.access_token) : null,
        isMock: Boolean(res.isMock),
      });
    } else if (!res.stale) {
      store.state.ui.authError = res.error || "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
      store.emit();
    }
    return res;
  },

  async registerUser(email, password, displayName) {
    const clean = (email || "").trim();
    const authMode = getAuthMode(store.state);

    if (authMode === "supabase") {
      const startKey = getAuthContextKey();
      const started = performance.now();
      const res = await supabaseAuth.signUpWithPassword(getSupabaseConfig(), {
        email: clean,
        password,
        displayName,
      });
      if (!isAuthContextCurrent(startKey)) {
        return staleAuthResult();
      }
      recordLog({
        method: "POST",
        path: "/auth/v1/signup",
        mode: "supabase",
        status: res.status || (res.ok ? 201 : 400),
        durationMs: performance.now() - started,
        requestBody: { email: clean, display_name: displayName },
        responseBody: res.data
          ? {
              ...res.data,
              access_token: res.data.access_token ? `${res.data.access_token.slice(0, 18)}...` : "",
            }
          : { error: res.error },
        error: res.ok ? null : res.error,
      });
      if (res.ok && res.data?.access_token) {
        store.applyAuthenticatedSession({
          user: res.data.user,
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token || "",
          claims: res.data.claims || extractClaimsSummary(res.data.access_token),
        });
      } else if (!res.ok && !res.stale) {
        store.state.ui.authError = res.error || "สมัครสมาชิกไม่สำเร็จ";
        store.emit();
      }
      return res;
    }

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/register",
      body: { email: clean, password, display_name: displayName || clean.split("@")[0] },
      mockHandler: () => ({
        status: 201,
        data: {
          access_token: `mock_jwt_${Date.now()}`,
          refresh_token: `mock_ref_${Date.now()}`,
          token_type: "bearer",
          user: { id: generateUuid(), email: clean, display_name: displayName || clean.split("@")[0], tier: "free" },
        },
      }),
    });
    if (res.ok && res.data) {
      store.applyAuthenticatedSession({
        user: res.data.user,
        accessToken: res.data.access_token || "",
        refreshToken: res.data.refresh_token || "",
        claims: res.data.access_token && !res.isMock ? extractClaimsSummary(res.data.access_token) : null,
        isMock: Boolean(res.isMock),
      });
    } else if (!res.stale) {
      store.state.ui.authError = res.error || "สมัครสมาชิกไม่สำเร็จ";
      store.emit();
    }
    return res;
  },

  async refreshSession() {
    const startKey = getAuthContextKey();
    if (_refreshInFlightPromise && _refreshInFlightContextKey === startKey) {
      return _refreshInFlightPromise;
    }
    const task = (async () => {
      const authMode = getAuthMode(store.state);
      const refreshToken = store.state.api.refreshToken;

      if (authMode === "supabase") {
        const started = performance.now();
        const res = await supabaseAuth.refreshSession(getSupabaseConfig(), refreshToken);
        recordLog({
          method: "POST",
          path: "/auth/v1/token?grant_type=refresh_token",
          mode: "supabase",
          status: res.status || (res.ok ? 200 : 401),
          durationMs: performance.now() - started,
          requestBody: { has_refresh_token: Boolean(refreshToken) },
          responseBody: res.ok ? { refreshed: true, claims: res.data?.claims } : { error: res.error },
          error: res.ok ? null : res.error,
        });
        if (!isAuthContextCurrent(startKey)) {
          return { ok: false, status: 409, error: "Auth context changed during refresh", stale: true };
        }
        if (res.ok && res.data?.access_token) {
          store.applyAuthenticatedSession({
            user: res.data.user,
            accessToken: res.data.access_token,
            refreshToken: res.data.refresh_token || refreshToken,
            claims: res.data.claims,
          });
        }
        return res;
      }

      if (!refreshToken) return { ok: false, status: 401, error: "ไม่มี Refresh Token" };
      const res = await dispatchRequest({
        method: "POST",
        path: "/api/auth/refresh",
        body: { refresh_token: refreshToken },
        skipAuthRefresh: true,
        skipUnauthRedirect: true,
        mockHandler: () => ({
          status: 200,
          data: {
            access_token: `mock_jwt_${Date.now()}`,
            refresh_token: `mock_ref_${Date.now()}`,
            user: store.state.data.user,
          },
        }),
      });
      if (!isAuthContextCurrent(startKey)) {
        return { ok: false, status: 409, error: "Auth context changed during refresh", stale: true };
      }
      if (res.ok && res.data?.access_token) {
        store.applyAuthenticatedSession({
          user: res.data.user,
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token || refreshToken,
          claims: !res.isMock ? extractClaimsSummary(res.data.access_token) : null,
          isMock: Boolean(res.isMock),
        });
      }
      return res;
    })();
    _refreshInFlightPromise = task;
    _refreshInFlightContextKey = startKey;
    try {
      return await task;
    } finally {
      if (_refreshInFlightPromise === task) {
        _refreshInFlightPromise = null;
        _refreshInFlightContextKey = "";
      }
    }
  },

  async checkSupabaseSession() {
    const startKey = getAuthContextKey();
    const res = await supabaseAuth.getClaimsOrSession(getSupabaseConfig());
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    if (res.ok && res.data?.access_token) {
      store.applyAuthenticatedSession({
        user: res.data.user,
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || "",
        claims: res.data.claims,
      });
    }
    return res;
  },

  async updateProfile({ displayName, preferredSummaryLanguage, defaultTimezone } = {}) {
    const body = {};
    if (displayName !== undefined) body.display_name = String(displayName).trim();
    if (preferredSummaryLanguage !== undefined) body.preferred_summary_language = preferredSummaryLanguage;
    if (defaultTimezone !== undefined) body.default_timezone = defaultTimezone;
    if (body.display_name) {
      store.state.data.user.displayName = body.display_name;
    }
    if (body.preferred_summary_language) {
      store.state.data.aiConfig.language = body.preferred_summary_language;
    }
    if (body.default_timezone) {
      store.state.data.user.timezone = body.default_timezone;
    }
    store.emit();
    return dispatchRequest({
      method: "PATCH",
      path: "/api/auth/profile",
      body,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          id: store.state.data.user.id,
          display_name: store.state.data.user.displayName,
          profile: {
            display_name: store.state.data.user.displayName,
            preferred_summary_language: store.state.data.aiConfig.language,
          },
        },
      }),
    });
  },

  async updateAccountEmail(email) {
    const clean = String(email || "").trim();
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const res = await supabaseAuth.updateEmail(getSupabaseConfig(), clean, store.state.api.bearerToken);
      if (res.ok) {
        store.state.data.user.email = clean;
        store.emit();
      }
      return res;
    }
    store.state.data.user.email = clean;
    store.emit();
    return { ok: true, status: 200, data: { email: clean } };
  },

  async sendPasswordReset(email) {
    const clean = String(email || store.state.data.user.email || "").trim();
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      return supabaseAuth.resetPasswordForEmail(getSupabaseConfig(), clean);
    }
    return this.signInEmail(clean);
  },

  async getMe() {
    return dispatchRequest({
      method: "GET",
      path: "/api/auth/me",
      body: null,
      mockHandler: () => ({
        status: 200,
        data: store.state.data.user,
      }),
    });
  },

  async probeProtectedRoute() {
    return dispatchRequest({
      method: "GET",
      path: "/api/items?limit=1",
      body: null,
      skipAuthRefresh: true,
      skipUnauthRedirect: true,
      mockHandler: () => {
        if (!store.state.data.user.isAuthenticated) {
          return { status: 401, data: { detail: "Unauthorized: Protected route requires authentication." } };
        }
        return { status: 200, data: { items: store.state.data.links.slice(0, 1), count: 1 } };
      },
    });
  },

  async createMcpToken(name) {
    const cleanName = String(name || "").trim() || "MCP Client";
    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/tokens",
      body: { name: cleanName },
      mockHandler: () => ({
        status: 201,
        data: {
          id: generateUuid(),
          name: cleanName,
          token: `jsi_live_mock_${generateUuid().replace(/-/g, "")}`,
          token_prefix: "jsi_live_mock",
          created_at: new Date().toISOString(),
        },
      }),
    });
    if (res.ok && res.data?.token) {
      store.state.api.mcpApiToken = res.data.token;
      store.state.ui.latestMcpRawToken = res.data.token;
      const existing = Array.isArray(store.state.ui.mcpTokens) ? store.state.ui.mcpTokens : [];
      store.state.ui.mcpTokens = [
        {
          id: res.data.id || generateUuid(),
          name: res.data.name || cleanName,
          token_prefix: res.data.token_prefix || res.data.token.slice(0, 16),
          created_at: res.data.created_at || new Date().toISOString(),
          revoked_at: null,
        },
        ...existing,
      ];
      store.emit();
    }
    return res;
  },

  async listMcpTokens() {
    const res = await dispatchRequest({
      method: "GET",
      path: "/api/auth/tokens",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          tokens: Array.isArray(store.state.ui.mcpTokens) ? store.state.ui.mcpTokens : [],
        },
      }),
    });
    if (res.ok) {
      const tokens = Array.isArray(res.data?.tokens)
        ? res.data.tokens
        : Array.isArray(res.data)
          ? res.data
          : [];
      store.state.ui.mcpTokens = tokens.filter((t) => !t?.revoked_at);
      store.emit();
    }
    return res;
  },

  async revokeMcpToken(tokenId) {
    if (!tokenId) return { ok: false, status: 400, error: "ไม่พบ Token ID" };
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/auth/tokens/${encodeURIComponent(tokenId)}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: { revoked: true, id: tokenId, revoked_at: new Date().toISOString() },
      }),
    });
    if (res.ok) {
      store.state.ui.mcpTokens = (store.state.ui.mcpTokens || []).filter((t) => t.id !== tokenId);
      store.emit();
    }
    return res;
  },

  async deleteAccount() {
    const startKey = getAuthContextKey();
    const res = await dispatchRequest({
      method: "DELETE",
      path: "/api/auth/me",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true } }),
    });
    if (res.ok && isAuthContextCurrent(startKey)) {
      stopRealtimeSync();
      await clearSessionAndSdk({ clearWorkspace: true, awaitSdk: true });
      store.showToast("ลบบัญชีและข้อมูลทั้งหมดเรียบร้อยแล้ว");
    }
    return res;
  },

  async exportWorkspaceJson() {
    const res = await dispatchRequest({
      method: "GET",
      path: "/api/export",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 200,
        data: {
          exported_at: new Date().toISOString(),
          user: {
            id: store.state.data.user?.id || null,
            email: store.state.data.user?.email || null,
            display_name: store.state.data.user?.nickname || null,
          },
          folders: store.state.data.folders || [],
          tags: store.state.data.tags || [],
          items: store.state.data.links || [],
          reminders: (store.state.data.links || [])
            .filter((l) => l.reminder)
            .map((l) => ({
              item_id: l.id,
              reminder: l.reminder,
              schedule_type: l.scheduleType,
              repeat_every_days: l.repeatEveryDays,
            })),
        },
      }),
    });
    return res;
  },

  async signInGoogle() {
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const started = performance.now();
      const res = await supabaseAuth.signInWithGoogle(getSupabaseConfig());
      recordLog({
        method: "GET",
        path: "/auth/v1/authorize?provider=google",
        mode: "supabase",
        status: res.status || (res.ok ? 200 : 400),
        durationMs: performance.now() - started,
        requestBody: null,
        responseBody: res.data || { error: res.error },
        error: res.ok ? null : res.error,
      });
      return res;
    }

    const redirectTo = buildAuthRedirectUrl();
    const res = await dispatchRequest({
      method: "GET",
      path: `/api/auth/oauth/google?redirect_to=${encodeURIComponent(redirectTo)}`,
      body: null,
      mockHandler: () => ({
        status: 200,
        data: { provider: "google", user: store.state.data.user },
      }),
    });
    if (res.isMock) {
      store.applyAuthenticatedSession({ user: res.data?.user || store.state.data.user, isMock: true });
    }
    return res;
  },

  async exchangeOAuthCode(code) {
    const cleanCode = String(code || "").trim();
    if (!cleanCode) return { ok: false, status: 400, error: "ไม่พบ Authorization Code" };
    const startKey = getAuthContextKey();
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const sbRes = await supabaseAuth.exchangeCodeForSession(getSupabaseConfig(), cleanCode);
      if (!isAuthContextCurrent(startKey)) {
        return staleAuthResult();
      }
      if (sbRes.ok && sbRes.data?.access_token) {
        store.applyAuthenticatedSession({
          user: sbRes.data.user,
          accessToken: sbRes.data.access_token,
          refreshToken: sbRes.data.refresh_token || "",
          claims: sbRes.data.claims,
        });
        return sbRes;
      }
    }
    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/oauth/callback",
      body: { code: cleanCode },
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 400, data: { detail: "OAuth code exchange not available in mock mode" } }),
    });
    if (!isAuthContextCurrent(startKey)) {
      return staleAuthResult();
    }
    if (res.ok && res.data?.access_token) {
      store.applyAuthenticatedSession({
        user: res.data.user,
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || "",
        claims: extractClaimsSummary(res.data.access_token),
      });
    }
    return res;
  },

  async signOut() {
    const authMode = getAuthMode(store.state);
    const supaCfg = getSupabaseConfig();
    const apiMode = store.state.api.mode;
    const capturedToken = store.state.api.bearerToken?.trim() || "";
    const authOverride = capturedToken ? { Authorization: `Bearer ${capturedToken}` } : {};

    // Clear UI session and stop realtime socket/channel immediately so logout never leaks stale syncs
    stopRealtimeSync();
    store.clearSession({ redirectToLogin: true });
    const clearedGen = store.state.api?.authGeneration || 0;
    const isSignOutStillCurrent = () =>
      !store.state.data.user?.isAuthenticated && (store.state.api?.authGeneration || 0) === clearedGen;

    const remoteTasks = [];
    if (apiMode === "live") {
      remoteTasks.push(
        dispatchRequest({
          method: "POST",
          path: "/api/auth/logout",
          body: null,
          customHeaders: authOverride,
          skipAuthRefresh: true,
          skipUnauthRedirect: true,
          keepalive: true,
          mockHandler: () => ({ status: 200, data: { logged_out: true } }),
        }).catch(() => ({ ok: false }))
      );
    } else {
      remoteTasks.push(
        dispatchRequest({
          method: "POST",
          path: "/api/auth/logout",
          body: null,
          customHeaders: authOverride,
          skipUnauthRedirect: true,
          keepalive: true,
          mockHandler: () => ({ status: 200, data: { logged_out: true } }),
        }).catch(() => ({ ok: false }))
      );
    }

    const supaTask = supabaseAuth.signOut(supaCfg, capturedToken, isSignOutStillCurrent).then((res) => {
      if (authMode === "supabase") {
        recordLog({
          method: "POST",
          path: "/auth/v1/logout",
          mode: "supabase",
          status: 200,
          durationMs: 0,
          requestBody: null,
          responseBody: res.data,
        });
      }
      return res;
    });
    remoteTasks.push(supaTask);
    remoteTasks.push(
      disableWebPush({
        unsubscribeBrowser: true,
        deactivateDevice: ({ endpoint, platform }) =>
          dispatchRequest({
            method: "POST",
            path: "/api/devices/deactivate",
            body: { endpoint, platform },
            customHeaders: authOverride,
            skipAuthRefresh: true,
            skipUnauthRedirect: true,
            keepalive: true,
            mockHandler: () => ({ status: 200, data: { deactivated: 0 } }),
          }),
      }).catch(() => ({ ok: false }))
    );

    await Promise.race([Promise.allSettled(remoteTasks), sleep(250)]);
    return { ok: true, status: 200, data: { logged_out: true } };
  },

  async getPushConfig() {
    const res = await dispatchRequest({
      method: "GET",
      path: "/api/reminders/push-config",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { enabled: false, vapid_public_key: null } }),
    });
    return res.ok && res.data ? res.data : { enabled: false, vapid_public_key: null };
  },

  async registerWebPushDevice(payload) {
    return dispatchRequest({
      method: "POST",
      path: "/api/devices",
      body: payload,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 201, data: { id: generateUuid(), ...payload } }),
    });
  },

  async deactivateWebPushDevice({ endpoint = null, platform = "web" } = {}) {
    return dispatchRequest({
      method: "POST",
      path: "/api/devices/deactivate",
      body: { endpoint, platform },
      skipUnauthRedirect: true,
      keepalive: true,
      mockHandler: () => ({ status: 200, data: { deactivated: 1 } }),
    });
  },

  async submitFeedback({ category = "general", topic, message, detail, pageContext = null, contactEmail = null, allowContact = false }) {
    const resolvedCategory = mapFeedbackCategory(category || topic);
    const resolvedMessage = String(message || detail || topic || "").trim();
    return dispatchRequest({
      method: "POST",
      path: "/api/feedback",
      body: {
        category: resolvedCategory,
        message: resolvedMessage.length >= 3 ? resolvedMessage : `${resolvedMessage} (feedback)`,
        page_context: pageContext || store.state.ui.screen || "web",
        contact_email: contactEmail,
        allow_contact: Boolean(allowContact),
      },
      skipUnauthRedirect: true,
      mockHandler: () => ({
        status: 201,
        data: {
          id: generateUuid(),
          category: resolvedCategory,
          message: resolvedMessage,
          page_context: pageContext || store.state.ui.screen,
          received: true,
        },
      }),
    });
  },

  async submitSupportReport({ topic, detail }) {
    return this.submitFeedback({
      category: topic,
      message: detail || topic,
      pageContext: store.state.ui.screen,
    });
  },

  async testMcpTool(toolName, params = {}) {
    const started = performance.now();
    if (!this.isMockMode()) {
      const baseUrl = store.state.api.baseUrl.replace(/\/+$/, "");
      const token = (store.state.api.mcpApiToken || store.state.api.bearerToken || "").trim();
      if (token) {
        const rpcPayload = {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: params || {} },
        };
        try {
          const resp = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(rpcPayload),
          });
          const rawText = await resp.text();
          let parsedBody = rawText;
          try {
            parsedBody = JSON.parse(rawText);
          } catch {}
          store.state.api.lastMcpResult = { toolName, params, result: parsedBody, liveHttpStatus: resp.status };
          recordLog({
            method: "POST",
            path: "/mcp",
            mode: "live",
            status: resp.status,
            durationMs: performance.now() - started,
            headers: { Authorization: "Bearer ***" },
            requestBody: rpcPayload,
            responseBody: parsedBody,
          });
          if (resp.ok) return parsedBody;
        } catch (err) {
          recordLog({
            method: "POST",
            path: "/mcp",
            mode: "live",
            status: 0,
            durationMs: performance.now() - started,
            headers: { Authorization: "Bearer ***" },
            requestBody: rpcPayload,
            error: err?.message || "MCP network error",
          });
        }
      }
    }
    await sleep(60);
    const { data } = store.state;
    let result;

    switch (toolName) {
      case "list_recent_links":
        result = data.links.slice(0, 5).map((l) => ({ id: l.id, title: l.title, platform: l.platform, status: l.status }));
        break;
      case "search_links":
        result = filterLinks(data.links, params.query || "คาเฟ่", "all").map((l) => ({
          id: l.id,
          title: l.title,
          tags: l.tags,
        }));
        break;
      case "get_link_detail":
        result = getLinkById(params.item_id || store.state.ui.activeLinkId) || data.links[0];
        break;
      case "list_unread_links":
        result = data.links.filter((l) => l.status === "unread").map((l) => ({ id: l.id, title: l.title }));
        break;
      case "list_folders":
        result = data.folders.map((f) => ({ id: f.id, name: f.name, sharedCount: f.sharedCount }));
        break;
      case "get_folder_links":
        result = data.links.filter((l) => l.folderId === (params.folder_id || store.state.ui.activeFolderId));
        break;
      case "list_tags": {
        const counts = {};
        for (const l of data.links) {
          for (const t of l.tags) counts[t] = (counts[t] || 0) + 1;
        }
        result = Object.entries(counts).map(([tag, count]) => ({ tag, count }));
        break;
      }
      case "get_links_by_tag":
        result = data.links.filter((l) => l.tags.includes(params.tag || "#คาเฟ่"));
        break;
      case "list_reminders":
        result = data.links.filter((l) => l.reminder).map((l) => ({ id: l.id, title: l.title, reminder: l.reminder }));
        break;
      case "save_link": {
        const saved = await this.createLink({
          url: params.url || "https://tiktok.com/@mcp/video/998877",
          title: params.title || "ลิงก์ทดสอบจาก MCP Tool",
        });
        result = { saved: true, item: saved };
        break;
      }
      case "mark_link_status": {
        const target = getLinkById(params.item_id || store.state.ui.activeLinkId) || data.links[0];
        const nextStatus = target.status === "read" ? "unread" : "read";
        await this.patchLink(target.id, { status: nextStatus });
        result = { item_id: target.id, status: nextStatus };
        break;
      }
      case "update_link_note": {
        const target = getLinkById(params.item_id || store.state.ui.activeLinkId) || data.links[0];
        await this.patchLink(target.id, { note: params.note || "อัปเดตโน้ตผ่าน MCP Server" });
        result = { item_id: target.id, note: target.note };
        break;
      }
      case "summarize_link": {
        const target = getLinkById(params.item_id || store.state.ui.activeLinkId) || data.links[0];
        const r = await this.summarizeLink(target.id);
        result = r.data || { error: r.error };
        break;
      }
      default:
        result = { ok: true, tool: toolName };
    }

    store.state.api.lastMcpResult = { toolName, params, result };
    recordLog({
      method: "MCP",
      path: `/mcp/tools/${toolName}`,
      mode: store.state.api.mode,
      status: 200,
      durationMs: performance.now() - started,
      headers: store.state.api.mcpApiToken ? { "X-API-Token": "***" } : {},
      requestBody: params,
      responseBody: result,
    });
    return result;
  },
};
