/**
 * Dual-mode API & MCP Client for Sharely Test Web App.
 * - Live Mode: executes real fetch() requests against FastAPI backend (backend/main.py).
 * - Mock Mode: simulates exact contracts for backend/Ai, backend/Login, backend/Database & 13 MCP tools.
 */
import { AI_PROVIDER_PRESETS } from "../data/seed.js";
import { store, generateUuid, inferPlatform, getFolderById, getLinkById, filterLinks } from "../state/store.js";
import { getAuthMode } from "./routeGuard.js";
import { extractClaimsSummary, supabaseAuth } from "./supabaseAuth.js";

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
    const { platform, domain } = inferPlatform(payload.url);
    const isPinned = Boolean(payload.pinned);
    const tags = payload.tags?.length ? [...payload.tags] : ["#บันทึกใหม่"];
    if (isPinned && !tags.includes("#ปักหมุด")) {
      tags.unshift("#ปักหมุด");
    }

    const newItem = {
      id: generateUuid(),
      folderId: payload.folderId || store.state.data.folders[0]?.id,
      platform,
      url: payload.url || `https://${domain}/p/${Date.now()}`,
      domain,
      title: payload.title || `โพสต์ใหม่จาก ${platform}`,
      savedAgo: "เมื่อสักครู่",
      status: "unread",
      favorite: isPinned,
      pinned: isPinned,
      tags,
      note: payload.note || "",
      aiSummary: "",
      aiCached: false,
      reminder: payload.reminder || null,
      reminderDate: payload.reminderDate || null,
      reminderTime: payload.reminderTime || "18:00",
      sourceApp: payload.sourceApp || platform,
    };

    await dispatchRequest({
      method: "POST",
      path: "/api/items",
      body: {
        url: newItem.url,
        title: newItem.title,
        folder_id: newItem.folderId,
        tags: newItem.tags,
        note: newItem.note,
        pinned: isPinned,
        remind_at: newItem.reminderDate ? `${newItem.reminderDate}T${newItem.reminderTime}:00` : null,
      },
      mockHandler: () => ({ status: 201, data: newItem }),
    });

    // If pinned, insert at very top; otherwise insert after pinned items
    if (isPinned) {
      store.state.data.links.unshift(newItem);
    } else {
      const firstUnpinnedIdx = store.state.data.links.findIndex((l) => !l.pinned);
      if (firstUnpinnedIdx === -1) store.state.data.links.unshift(newItem);
      else store.state.data.links.splice(firstUnpinnedIdx, 0, newItem);
    }

    const folder = getFolderById(newItem.folderId);
    if (folder) folder.baseExternalCount = (folder.baseExternalCount || 0) + 1;

    // Track last shared event for QA & UI verification
    store.state.data.lastSharedEvent = {
      id: newItem.id,
      title: newItem.title,
      url: newItem.url,
      platform: newItem.platform,
      domain: newItem.domain,
      folderId: newItem.folderId,
      folderName: folder?.name || "ยังไม่จัดหมวด",
      pinned: isPinned,
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
    Object.assign(item, updates);
    store.emit();
    await dispatchRequest({
      method: "PATCH",
      path: `/api/items/${itemId}`,
      body: updates,
      mockHandler: () => ({ status: 200, data: item }),
    });
    return item;
  },

  async deleteLink(itemId) {
    const idx = store.state.data.links.findIndex((l) => l.id === itemId);
    if (idx === -1) return false;
    const [removed] = store.state.data.links.splice(idx, 1);
    const folder = getFolderById(removed.folderId);
    if (folder && folder.baseExternalCount > 0) folder.baseExternalCount -= 1;
    store.emit();
    await dispatchRequest({
      method: "DELETE",
      path: `/api/items/${itemId}`,
      body: null,
      mockHandler: () => ({ status: 200, data: { deleted: true, id: itemId } }),
    });
    return true;
  },

  async saveFolder({ folderId = null, name, cover }) {
    if (folderId) {
      const folder = getFolderById(folderId);
      if (!folder) return null;
      folder.name = name;
      folder.cover = cover;
      store.emit();
      await dispatchRequest({
        method: "PATCH",
        path: `/api/folders/${folderId}`,
        body: { name, cover_url: cover },
        mockHandler: () => ({ status: 200, data: folder }),
      });
      return folder;
    }

    const newFolder = {
      id: generateUuid(),
      name,
      cover: cover || "./assets/covers/project.png",
      sharedCount: 0,
      sharedUsers: [],
      inviteSlug: `f-${Math.random().toString(36).slice(2, 7)}`,
      baseExternalCount: 0,
    };
    store.state.data.folders.push(newFolder);
    store.emit();
    await dispatchRequest({
      method: "POST",
      path: "/api/folders",
      body: { name, cover_url: newFolder.cover },
      mockHandler: () => ({ status: 201, data: newFolder }),
    });
    return newFolder;
  },

  async acceptInvite(folderId) {
    const folder = getFolderById(folderId) || store.state.data.folders[0];
    if (!folder) return null;
    if (!folder.sharedUsers.includes(store.state.data.user.displayName)) {
      folder.sharedUsers.push(store.state.data.user.displayName);
      folder.sharedCount = Math.max(folder.sharedCount + 1, folder.sharedUsers.length);
    }
    store.state.data.user.isAuthenticated = true;
    store.emit();
    await dispatchRequest({
      method: "POST",
      path: `/api/invites/${folder.inviteSlug}/accept`,
      body: { user_id: store.state.data.user.id },
      mockHandler: () => ({ status: 200, data: { joined_folder: folder.id, role: "editor" } }),
    });
    return folder;
  },

  async signInEmail(email) {
    const clean = (email || "").trim() || "may@example.com";
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
    const clean = (email || "").trim() || "may@example.com";
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

  async submitSupportReport({ topic, detail }) {
    return dispatchRequest({
      method: "POST",
      path: "/api/support/report",
      body: { topic, detail, user_id: store.state.data.user.id },
      mockHandler: () => ({ status: 201, data: { ticket_id: `SH-${Date.now().toString().slice(-5)}`, received: true } }),
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
