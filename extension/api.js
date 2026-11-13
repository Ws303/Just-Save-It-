/**
 * Shared storage & API helper loaded by both background.js (importScripts)
 * and popup.html (<script src="api.js">). Zero build step required.
 */
(function (global) {
  "use strict";

  const DEFAULT_BACKEND_URL = "http://localhost:8000";
  const STORAGE_KEYS = {
    BACKEND_URL: "jsi_backend_url",
    ACCESS_TOKEN: "jsi_access_token",
    REFRESH_TOKEN: "jsi_refresh_token",
    USER: "jsi_user",
  };

  function normalizeBackendUrl(rawUrl) {
    const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) {
      return DEFAULT_BACKEND_URL;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      return "http://" + trimmed;
    }
    return trimmed;
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

  function isSaveableHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url.trim());
  }

  global.JustSaveItApi = {
    DEFAULT_BACKEND_URL,
    STORAGE_KEYS,
    normalizeBackendUrl,
    getSessionState,
    saveAuthSession,
    clearAuthSession,
    setBackendUrl,
    apiRequest,
    checkHealth,
    runDomAssist,
    isSaveableHttpUrl,
  };
})(typeof self !== "undefined" ? self : window);
