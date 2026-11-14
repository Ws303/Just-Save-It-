/**
 * Dual-mode API & MCP Client for Sharely Test Web App.
 * - Live Mode: executes real fetch() requests against FastAPI backend (backend/main.py).
 * - Mock Mode: simulates exact contracts for backend/Ai, backend/Login, backend/Database & 13 MCP tools.
 */
import { AI_PROVIDER_PRESETS, COVER_CHOICES } from "../data/seed.js";
import { safeHrefUrl } from "../components/icons.js";
import { store, generateUuid, inferPlatform, getFolderById, getLinkById, filterLinks, buildFolderInviteUrl } from "../state/store.js";
import { getAuthMode } from "./routeGuard.js";
import { extractClaimsSummary, supabaseAuth } from "./supabaseAuth.js";

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

export function mapBackendStatusToUi(status) {
  const s = String(status || "inbox").toLowerCase();
  if (s === "done" || s === "read" || s === "archived") return "read";
  return "unread";
}

export function mapUiStatusToBackend(status) {
  const s = String(status || "unread").toLowerCase();
  if (s === "read" || s === "done") return "done";
  if (s === "archived") return "archived";
  return "inbox";
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
  const coverUrl = item.thumbnail_url || item.image_url || mediaItems[0] || null;
  const { platform: inferredPlat, domain } = inferPlatform(item.url || "");
  const rem = reminderMap[item.id] || item.reminder || (Array.isArray(item.reminders) ? item.reminders[0] : null);
  const remIso = rem?.remind_at || rem?.next_remind_at || item.remind_at || null;
  const fallbackRemTime = rem?.remind_time ? String(rem.remind_time).slice(0, 5) : "18:00";
  const { date: remDate, time: remTime } = formatRemindIsoInBangkok(remIso, fallbackRemTime);
  const scheduleType = rem?.schedule_type || "once";
  const repeatEveryDays = rem?.repeat_every_days ?? null;

  return {
    id: item.id,
    folderId: item.folder_id || store.state.data.folders[0]?.id,
    platform: item.platform || inferredPlat,
    url: item.url,
    domain,
    title: item.title || item.url,
    description: item.description || "",
    coverUrl,
    media_items: mediaItems,
    embed_url: item.embed_url || null,
    embed_type: item.embed_type || "none",
    savedAgo: item.savedAgo || "เมื่อสักครู่",
    savedAt: item.saved_at || null,
    status: mapBackendStatusToUi(item.status),
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
    sourceApp: item.platform || inferredPlat,
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
  store.emit();
  return entry;
}

export function buildAiHeadersAndConfig() {
  const cfg = store.state.data.aiConfig;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === cfg.provider) || AI_PROVIDER_PRESETS[3];
  const providerCode = preset.backendProvider; // "built-in" | "byok" | "custom"

  const headers = {
    "Content-Type": "application/json",
  };
  if (store.state.api.bearerToken.trim()) {
    headers["Authorization"] = `Bearer ${store.state.api.bearerToken.trim()}`;
  } else if (store.state.api.useDevBypass && store.state.api.userId.trim()) {
    headers["X-User-Id"] = store.state.api.userId.trim();
  }

  headers["X-AI-Provider"] = providerCode;
  if (!cfg.keyless && cfg.apiKey) headers["X-AI-Key"] = cfg.apiKey;
  if (cfg.endpointUrl && providerCode === "custom") headers["X-AI-Base-Url"] = cfg.endpointUrl;
  if (cfg.model) headers["X-AI-Model"] = cfg.model;

  const aiConfigBody = {
    provider: providerCode,
    api_key: !cfg.keyless && cfg.apiKey ? cfg.apiKey : null,
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

async function dispatchRequest({
  method = "GET",
  path,
  body = null,
  customHeaders = {},
  mockHandler,
  skipAuthRefresh = false,
  skipUnauthRedirect = false,
}) {
  const { mode, baseUrl, latencyMs } = store.state.api;
  const started = performance.now();
  const base = baseUrl.replace(/\/+$/, "");

  const headers = buildAuthHeaders(customHeaders);

  if (mode === "mock") {
    await sleep(Math.max(40, Number(latencyMs) || 120));
    try {
      const mockRes = await mockHandler();
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

    if (
      resp.status === 401 &&
      !skipAuthRefresh &&
      store.state.api.refreshToken &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/register") &&
      !path.startsWith("/api/auth/refresh")
    ) {
      const refreshed = await apiClient.refreshSession();
      if (refreshed.ok) {
        const retryHeaders = buildAuthHeaders(customHeaders);
        ({ resp, parsed } = await performLiveFetch(retryHeaders));
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

    if (resp.status === 401 && !skipUnauthRedirect && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/register")) {
      store.clearSession({
        redirectToLogin: store.state.ui.authGuardEnabled !== false,
        authError: parsed?.detail || "เซสชันหมดอายุหรือยังไม่ได้ยืนยันตัวตน (HTTP 401)",
      });
    }

    return { ok: resp.ok, status: resp.status, data: parsed, error: resp.ok ? null : parsed?.detail || `HTTP ${resp.status}`, isMock: false };
  } catch (err) {
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

    store.state.api.isSummarizing = false;

    if (res.ok && res.data) {
      item.aiSummary = res.data.summary_th || item.aiSummary;
      item.aiCached = Boolean(res.data.cached_from_db);
      item.aiEngine = res.data.engine_used || "";
      if (saveToNote && res.data.summary_th) {
        const prefix = item.note ? `${item.note}\n\n` : "";
        if (!item.note?.includes(res.data.summary_th)) {
          item.note = `${prefix}[AI สรุป]: ${res.data.summary_th}`;
        }
      }
      if (Array.isArray(res.data.suggested_tags)) {
        for (const tag of res.data.suggested_tags) {
          const normalized = tag.startsWith("#") ? tag : `#${tag}`;
          if (!item.tags.includes(normalized)) item.tags.push(normalized);
        }
      }
    }
    store.emit();
    return res;
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
    if (cleanUrl && store.state.api.mode === "live" && !payload.skipPreview) {
      try {
        const pv = await this.previewUrl(cleanUrl);
        if (pv.ok && pv.data) previewData = pv.data;
      } catch {}
    }

    const mediaItems = Array.isArray(payload.media_items) && payload.media_items.length
      ? payload.media_items
      : Array.isArray(previewData.media_items)
        ? previewData.media_items
        : [];
    const coverUrl = payload.thumbnail_url || payload.coverUrl || previewData.image_url || mediaItems[0] || null;
    const embedUrl = payload.embed_url || previewData.embed_url || null;
    const resolvedTitle = payload.title || previewData.title || `โพสต์ใหม่จาก ${platform}`;
    const resolvedStatus = mapUiStatusToBackend(payload.status || "unread");
    const rawFolderId = payload.folderId || payload.folder_id || store.state.data.folders[0]?.id || null;
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

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/items",
      body: reqBody,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 201, data: localFallback }),
    });

    if (store.state.api.mode === "live" && !res.ok) {
      store.showToast(res.error || "บันทึกโพสต์ไม่สำเร็จ");
      return null;
    }

    const newItem = res.ok && res.data?.id ? { ...localFallback, ...mapBackendItemToUi(res.data) } : localFallback;
    store.state.data.links.unshift(newItem);

    const folder = getFolderById(newItem.folderId);
    if (folder) folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;

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
    if (typeof store.state.data.freeQuotaRemaining === "number" && store.state.data.freeQuotaRemaining > 0) {
      store.state.data.freeQuotaRemaining -= 1;
    }

    store.emit();
    return newItem;
  },

  async patchLink(itemId, updates) {
    const item = getLinkById(itemId);
    if (!item) return null;
    const prevSnapshot = { ...item, tags: Array.isArray(item.tags) ? [...item.tags] : [] };
    Object.assign(item, updates);
    if (updates.status === "read" || updates.status === "done") {
      item.reminder = null;
      item.reminderDate = null;
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
      body.folder_id = updates.folder_id ?? updates.folderId;
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
    if (store.state.api.mode === "live" && !res.ok) {
      Object.assign(item, prevSnapshot);
      store.emit();
      return null;
    }
    return item;
  },

  async deleteLink(itemId) {
    const idx = store.state.data.links.findIndex((l) => l.id === itemId);
    if (idx === -1) return false;
    const [removed] = store.state.data.links.splice(idx, 1);
    const folder = getFolderById(removed.folderId);
    if (folder && folder.baseExternalCount > 0) folder.baseExternalCount -= 1;
    store.emit();
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/items/${itemId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true, id: itemId } }),
    });
    if (store.state.api.mode === "live" && !res.ok) {
      store.state.data.links.splice(idx, 0, removed);
      if (folder) folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;
      store.emit();
      return false;
    }
    return true;
  },

  async saveFolder({ folderId = null, name, emoji = "📁", cover }) {
    const cleanName = String(name || "").trim() || "โฟลเดอร์ใหม่";
    const cleanEmoji = emoji || "📁";
    if (folderId) {
      const folder = getFolderById(folderId);
      if (!folder) return null;
      folder.name = cleanName;
      folder.emoji = cleanEmoji;
      if (cover) folder.cover = cover;
      store.emit();
      await dispatchRequest({
        method: "PATCH",
        path: `/api/folders/${folderId}`,
        body: { name: cleanName, emoji: cleanEmoji },
        skipUnauthRedirect: true,
        mockHandler: () => ({ status: 200, data: folder }),
      });
      return folder;
    }

    const fallbackFolder = {
      id: generateUuid(),
      name: cleanName,
      emoji: cleanEmoji,
      cover: cover || "./assets/covers/project.png",
      sharedCount: 0,
      sharedUsers: [],
      inviteSlug: `f-${Math.random().toString(36).slice(2, 7)}`,
      baseExternalCount: 0,
    };
    const res = await dispatchRequest({
      method: "POST",
      path: "/api/folders",
      body: { name: cleanName, emoji: cleanEmoji },
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 201, data: fallbackFolder }),
    });
    const finalFolder = res.ok && res.data?.id ? { ...fallbackFolder, ...res.data } : fallbackFolder;
    store.state.data.folders.push(finalFolder);
    store.emit();
    return finalFolder;
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
      store.emit();
    }

    const res = await dispatchRequest({
      method: "PUT",
      path: `/api/reminders/${itemId}`,
      body,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { ...body, status: "pending" } }),
    });
    if (store.state.api.mode === "live" && !res.ok && item && prevRem) {
      Object.assign(item, prevRem);
      store.emit();
    }
    return res;
  },

  async deleteReminder(itemId) {
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
      store.emit();
    }
    const res = await dispatchRequest({
      method: "DELETE",
      path: `/api/reminders/${itemId}`,
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { deleted: true, item_id: itemId } }),
    });
    if (store.state.api.mode === "live" && !res.ok && item && prevRem) {
      Object.assign(item, prevRem);
      store.emit();
    }
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
    const [foldersRes, itemsRes, tagsRes, remindersRes] = await Promise.all([
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

    const remMap = {};
    for (const rem of remindersRes?.data?.reminders || []) {
      if (rem?.item_id) remMap[rem.item_id] = rem;
    }

    const isAuthenticatedLive = Boolean(store.state.api.bearerToken);
    if (isAuthenticatedLive && !store.state.data.user?.isAuthenticated) {
      return { ok: false, hydrated: false };
    }
    const hasBackendItems = itemsRes?.ok && Array.isArray(itemsRes.data?.items) && itemsRes.data.items.length > 0;
    const mapBackendFolder = (f, idx) => ({
      cover: COVER_CHOICES[idx % COVER_CHOICES.length]?.src || "./assets/covers/coffee.png",
      sharedCount: f.is_shared ? 2 : 0,
      sharedUsers: [],
      inviteSlug: f.id.slice(0, 8),
      baseExternalCount: 0,
      ...f,
    });

    if (hasBackendItems || isAuthenticatedLive) {
      if (foldersRes?.ok && Array.isArray(foldersRes.data?.folders) && (isAuthenticatedLive || foldersRes.data.folders.length > 0)) {
        store.state.data.folders = foldersRes.data.folders.map(mapBackendFolder);
      }
      if (itemsRes?.ok && Array.isArray(itemsRes.data?.items)) {
        store.state.data.links = itemsRes.data.items.map((row) => mapBackendItemToUi(row, remMap));
        if (!store.state.data.links.some((l) => l.id === store.state.ui.activeLinkId)) {
          store.state.ui.activeLinkId = store.state.data.links[0]?.id || null;
        }
      }
    } else if (foldersRes?.ok && Array.isArray(foldersRes.data?.folders) && foldersRes.data.folders.length > 0) {
      const existingIds = new Set(store.state.data.folders.map((f) => f.id));
      const defaultLocalNames = new Set(["อ่านทีหลัง", "Tech & AI"]);
      const extraFolders = foldersRes.data.folders
        .filter((f) => f && !existingIds.has(f.id) && !defaultLocalNames.has(f.name))
        .map((f, idx) => mapBackendFolder(f, store.state.data.folders.length + idx));
      if (extraFolders.length > 0) {
        store.state.data.folders = [...store.state.data.folders, ...extraFolders];
      }
    }

    if (tagsRes?.ok && Array.isArray(tagsRes.data?.tags)) {
      store.state.data.serverTags = tagsRes.data.tags;
    }

    store.emit();
    return {
      ok: Boolean(foldersRes?.ok || itemsRes?.ok),
      folders: store.state.data.folders.length,
      links: store.state.data.links.length,
    };
  },

  async acceptInvite(folderId) {
    const folder = getFolderById(folderId) || store.state.data.folders[0];
    if (!folder) return null;
    const res = await dispatchRequest({
      method: "POST",
      path: `/api/invites/${folder.inviteSlug}/accept`,
      body: { user_id: store.state.data.user.id },
      mockHandler: () => ({ status: 200, data: { joined_folder: folder.id, role: "editor" } }),
    });
    if (!res.ok && store.state.api.mode === "live") {
      return null;
    }
    if (!folder.sharedUsers.includes(store.state.data.user.displayName)) {
      folder.sharedUsers.push(store.state.data.user.displayName);
      folder.sharedCount = Math.max(folder.sharedCount + 1, folder.sharedUsers.length);
    }
    store.state.data.user.isAuthenticated = true;
    store.emit();
    return folder;
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
      const started = performance.now();
      const res = await supabaseAuth.signInWithPassword(getSupabaseConfig(), { email: clean, password });
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
    } else {
      store.state.ui.authError = res.error || "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
      store.emit();
    }
    return res;
  },

  async registerUser(email, password, displayName) {
    const clean = (email || "").trim();
    const authMode = getAuthMode(store.state);

    if (authMode === "supabase") {
      const started = performance.now();
      const res = await supabaseAuth.signUpWithPassword(getSupabaseConfig(), {
        email: clean,
        password,
        displayName,
      });
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
      } else if (!res.ok) {
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
    } else {
      store.state.ui.authError = res.error || "สมัครสมาชิกไม่สำเร็จ";
      store.emit();
    }
    return res;
  },

  async refreshSession() {
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
  },

  async checkSupabaseSession() {
    const res = await supabaseAuth.getClaimsOrSession(getSupabaseConfig());
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

  async updateAccountEmail(email) {
    const clean = String(email || "").trim();
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const res = await supabaseAuth.updateEmail(getSupabaseConfig(), clean);
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
    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/tokens",
      body: { name: name || "Testbed Client" },
      mockHandler: () => ({
        status: 201,
        data: {
          id: generateUuid(),
          name: name || "Testbed Client",
          token: `jsi_live_mock_${generateUuid().replace(/-/g, "")}`,
          token_prefix: "jsi_live_mock...",
          created_at: new Date().toISOString(),
        },
      }),
    });
    if (res.ok && res.data?.token) {
      store.state.api.mcpApiToken = res.data.token;
      store.emit();
    }
    return res;
  },

  async listMcpTokens() {
    return dispatchRequest({
      method: "GET",
      path: "/api/auth/tokens",
      body: null,
      mockHandler: () => ({
        status: 200,
        data: [
          {
            id: generateUuid(),
            name: "Claude Desktop",
            token_prefix: "jsi_live_abcd...",
            created_at: new Date().toISOString(),
            is_active: true,
          },
        ],
      }),
    });
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

    const res = await dispatchRequest({
      method: "GET",
      path: "/api/auth/oauth/google",
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

  async signOut() {
    const authMode = getAuthMode(store.state);
    if (authMode === "supabase") {
      const started = performance.now();
      const res = await supabaseAuth.signOut(getSupabaseConfig(), store.state.api.bearerToken);
      recordLog({
        method: "POST",
        path: "/auth/v1/logout",
        mode: "supabase",
        status: 200,
        durationMs: performance.now() - started,
        requestBody: null,
        responseBody: res.data,
      });
      store.clearSession({ redirectToLogin: true });
      return res;
    }

    const res = await dispatchRequest({
      method: "POST",
      path: "/api/auth/logout",
      body: null,
      skipUnauthRedirect: true,
      mockHandler: () => ({ status: 200, data: { logged_out: true } }),
    });
    store.clearSession({ redirectToLogin: true });
    return res;
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
