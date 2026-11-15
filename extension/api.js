/**
 * Shared storage & API helper loaded by both background.js (importScripts)
 * and popup.html (<script src="api.js">). Zero build step required.
 */
(function (global) {
  "use strict";

  const CLOUD_BACKEND_URL = "https://just-save-it-api.onrender.com";
  const LOCAL_BACKEND_URL = "http://127.0.0.1:8000";
  const DEFAULT_BACKEND_URL = CLOUD_BACKEND_URL;
  const BACKEND_PRESETS = {
    cloud: CLOUD_BACKEND_URL,
    local: LOCAL_BACKEND_URL,
  };
  const STORAGE_KEYS = {
    BACKEND_URL: "jsi_backend_url",
    ACCESS_TOKEN: "jsi_access_token",
    REFRESH_TOKEN: "jsi_refresh_token",
    USER: "jsi_user",
  };

  function isLocalBackendUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ""));
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    } catch (_err) {
      return false;
    }
  }

  function normalizeBackendUrl(rawUrl) {
    const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) {
      return DEFAULT_BACKEND_URL;
    }
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(trimmed)
        ? `http://${trimmed}`
        : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocal)) {
        return parsed.origin;
      }
    } catch (_err) {
      // Fallback safely to production cloud URL on malformed override
    }
    return DEFAULT_BACKEND_URL;
  }

  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function setStorage(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, () => resolve());
    });
  }

  function removeStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  async function getSessionState() {
    const data = await getStorage([
      STORAGE_KEYS.BACKEND_URL,
      STORAGE_KEYS.ACCESS_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN,
      STORAGE_KEYS.USER,
    ]);
    return {
      backendUrl: normalizeBackendUrl(data[STORAGE_KEYS.BACKEND_URL]),
      accessToken: data[STORAGE_KEYS.ACCESS_TOKEN] || "",
      refreshToken: data[STORAGE_KEYS.REFRESH_TOKEN] || "",
      user: data[STORAGE_KEYS.USER] || null,
    };
  }

  async function saveAuthSession(authPayload) {
    await setStorage({
      [STORAGE_KEYS.ACCESS_TOKEN]: authPayload.access_token || "",
      [STORAGE_KEYS.REFRESH_TOKEN]: authPayload.refresh_token || "",
      [STORAGE_KEYS.USER]: authPayload.user || null,
    });
  }

  async function clearAuthSession() {
    await removeStorage([
      STORAGE_KEYS.ACCESS_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN,
      STORAGE_KEYS.USER,
    ]);
  }

  async function setBackendUrl(rawUrl) {
    const clean = normalizeBackendUrl(rawUrl);
    await setStorage({ [STORAGE_KEYS.BACKEND_URL]: clean });
    return clean;
  }

  async function parseJsonSafe(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_err) {
      return { detail: text };
    }
  }

  async function tryRefreshAccessToken(backendUrl, refreshToken) {
    if (!refreshToken) return null;
    try {
      const resp = await fetch(`${backendUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!resp.ok) return null;
      const data = await parseJsonSafe(resp);
      if (data && data.access_token) {
        await saveAuthSession(data);
        return data.access_token;
      }
    } catch (_err) {
      return null;
    }
    return null;
  }

  async function apiRequest(path, options = {}) {
    const session = await getSessionState();
    const backendUrl = normalizeBackendUrl(options.backendUrl || session.backendUrl);
    const headers = {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    };

    const requireAuth = options.auth !== false;
    if (requireAuth && session.accessToken) {
      headers.Authorization = `Bearer ${session.accessToken}`;
    }

    const fetchOpts = {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    };

    let response = await fetch(`${backendUrl}${path}`, fetchOpts);

    if (response.status === 401 && requireAuth && session.refreshToken) {
      const nextToken = await tryRefreshAccessToken(backendUrl, session.refreshToken);
      if (nextToken) {
        fetchOpts.headers = { ...headers, Authorization: `Bearer ${nextToken}` };
        response = await fetch(`${backendUrl}${path}`, fetchOpts);
      }
    }

    const payload = await parseJsonSafe(response);
    if (!response.ok) {
      if (response.status === 401 && requireAuth) {
        await clearAuthSession();
      }
      const message =
        (payload && (payload.detail || payload.message)) ||
        `HTTP ${response.status} ${response.statusText}`;
      const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function checkHealth(overrideUrl) {
    const session = await getSessionState();
    const baseUrl = normalizeBackendUrl(overrideUrl || session.backendUrl);
    const response = await fetch(`${baseUrl}/health`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Health check failed (${response.status})`);
    }
    return await response.json();
  }

  async function runDomAssist(tabId) {
    if (!tabId) return null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content_assist.js"],
      });
      if (Array.isArray(results) && results[0] && results[0].result) {
        return results[0].result;
      }
    } catch (_err) {
      // Restricted pages (chrome://, Chrome Web Store, etc.) disallow script injection.
      return null;
    }
    return null;
  }

  async function loginWithAccessToken(rawToken, refreshToken = "") {
    const token = String(rawToken || "").trim().replace(/^Bearer\s+/i, "");
    if (!token) {
      throw new Error("กรุณาวาง Access Token ก่อนเข้าสู่ระบบ");
    }
    const session = await getSessionState();
    const response = await fetch(`${session.backendUrl}/api/auth/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await parseJsonSafe(response);
    if (!response.ok || !payload || !payload.id) {
      const msg = (payload && (payload.detail || payload.message)) || `HTTP ${response.status}`;
      throw new Error(`Token ไม่ถูกต้องหรือหมดอายุ (${msg})`);
    }
    await saveAuthSession({
      access_token: token,
      refresh_token: String(refreshToken || "").trim(),
      user: payload,
    });
    return payload;
  }

  function formatAiSummaryResponse(resp) {
    const summary = String((resp && (resp.summary_th || resp.summary)) || "").trim();
    const tags = Array.isArray(resp && resp.suggested_tags)
      ? resp.suggested_tags
      : Array.isArray(resp && resp.tags)
        ? resp.tags
        : [];
    return { summary, tags };
  }

  function isSaveableHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url.trim());
  }

  const exportedApi = {
    CLOUD_BACKEND_URL,
    LOCAL_BACKEND_URL,
    DEFAULT_BACKEND_URL,
    BACKEND_PRESETS,
    STORAGE_KEYS,
    isLocalBackendUrl,
    normalizeBackendUrl,
    getSessionState,
    saveAuthSession,
    clearAuthSession,
    setBackendUrl,
    apiRequest,
    checkHealth,
    loginWithAccessToken,
    formatAiSummaryResponse,
    runDomAssist,
    isSaveableHttpUrl,
  };

  global.JustSaveItApi = exportedApi;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportedApi;
  }
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
