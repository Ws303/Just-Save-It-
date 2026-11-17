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
    OFFLINE_QUEUE: "jsi_offline_queue",
    NOTIFIED_REMINDERS: "jsi_notified_reminders",
    WORKSPACE_CACHE: "jsi_workspace_cache",
  };
  const memoryStorage = {};
  let _refreshInFlightPromise = null;
  let _refreshInFlightToken = "";
  let _sessionGeneration = 0;

  const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function decodeBase64Pure(b64) {
    let out = "";
    const clean = String(b64 || "").replace(/=+$/, "");
    for (let i = 0; i < clean.length; i += 4) {
      const c1 = B64_CHARS.indexOf(clean[i]);
      const c2 = B64_CHARS.indexOf(clean[i + 1]);
      if (c1 < 0 || c2 < 0) break;
      const c3 = i + 2 < clean.length ? B64_CHARS.indexOf(clean[i + 2]) : -1;
      const c4 = i + 3 < clean.length ? B64_CHARS.indexOf(clean[i + 3]) : -1;
      const n = (c1 << 18) | (c2 << 12) | ((c3 >= 0 ? c3 : 0) << 6) | (c4 >= 0 ? c4 : 0);
      out += String.fromCharCode((n >> 16) & 255);
      if (c3 >= 0) out += String.fromCharCode((n >> 8) & 255);
      if (c4 >= 0) out += String.fromCharCode(n & 255);
    }
    return out;
  }

  function parseJwtSub(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length !== 3 || !parts[1]) return "";
      let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const raw = typeof atob === "function" ? atob(b64) : decodeBase64Pure(b64);
      const parsed = JSON.parse(raw);
      return String((parsed && parsed.sub) || "").trim();
    } catch (_err) {
      return "";
    }
  }

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
      : /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed)
        ? `http://${trimmed}`
        : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
      if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocal)) {
        return parsed.origin;
      }
    } catch (_err) {
      // Fallback safely to production cloud URL on malformed override
    }
    return DEFAULT_BACKEND_URL;
  }

  function getStorage(keys) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, (result) => resolve(result || {}));
      });
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of keyList) {
      if (k in memoryStorage) out[k] = memoryStorage[k];
    }
    return Promise.resolve(out);
  }

  function setStorage(values) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
      });
    }
    Object.assign(memoryStorage, values);
    return Promise.resolve();
  }

  function removeStorage(keys) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(keys, () => resolve());
      });
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) delete memoryStorage[k];
    return Promise.resolve();
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

  let _authMutationQueue = Promise.resolve();
  let _clearEpoch = 0;
  let _loginSeq = 0;

  function runSerializedAuthMutation(fn) {
    const next = _authMutationQueue.then(fn, fn);
    _authMutationQueue = next.catch(() => {});
    return next;
  }

  function beginAuthLogin() {
    _loginSeq += 1;
    return { expectedClearEpoch: _clearEpoch, expectedLoginSeq: _loginSeq };
  }

  function isAuthEpochStale(epoch) {
    if (!epoch) return false;
    if (epoch.expectedClearEpoch !== undefined && _clearEpoch !== epoch.expectedClearEpoch) return true;
    if (epoch.expectedLoginSeq !== undefined && _loginSeq !== epoch.expectedLoginSeq) return true;
    return false;
  }

  async function saveAuthSession(authPayload, options = {}) {
    let activeExpectedGen = options && options.expectedGen;
    const expectedRefreshToken = options && options.expectedRefreshToken;
    const expectedClearEpoch =
      options && options.expectedClearEpoch !== undefined ? options.expectedClearEpoch : _clearEpoch;
    const expectedLoginSeq =
      options && options.expectedLoginSeq !== undefined ? options.expectedLoginSeq : undefined;
    return runSerializedAuthMutation(async () => {
      const isStaleExpectedGen = () =>
        (activeExpectedGen !== undefined && _sessionGeneration !== activeExpectedGen) ||
        _clearEpoch !== expectedClearEpoch ||
        (expectedLoginSeq !== undefined && _loginSeq !== expectedLoginSeq);
      if (isStaleExpectedGen()) return false;

      const prev = await getStorage([STORAGE_KEYS.USER, STORAGE_KEYS.ACCESS_TOKEN, STORAGE_KEYS.REFRESH_TOKEN]);
      if (isStaleExpectedGen()) return false;
      if (expectedRefreshToken && prev[STORAGE_KEYS.REFRESH_TOKEN] !== expectedRefreshToken) {
        return false;
      }

      const prevUid = String(
        (prev[STORAGE_KEYS.USER] && prev[STORAGE_KEYS.USER].id) || parseJwtSub(prev[STORAGE_KEYS.ACCESS_TOKEN]) || ""
      ).trim();
      const prevHadSession = Boolean(prevUid || prev[STORAGE_KEYS.ACCESS_TOKEN] || prev[STORAGE_KEYS.REFRESH_TOKEN]);
      const nextUid = String(
        (authPayload && authPayload.user && authPayload.user.id) || parseJwtSub(authPayload && authPayload.access_token) || ""
      ).trim();
      const nextHasSession = Boolean(nextUid || (authPayload && authPayload.access_token));
      if (expectedRefreshToken && prevUid && nextUid && prevUid !== nextUid) {
        return false;
      }

      const shouldClearStorage = Boolean(prevHadSession && (!nextUid || !prevUid || prevUid !== nextUid));
      const shouldBumpGen = shouldClearStorage || (!prevHadSession && nextHasSession);
      if (shouldClearStorage) {
        _sessionGeneration += 1;
        if (activeExpectedGen !== undefined) activeExpectedGen = _sessionGeneration;
        await removeStorage([
          STORAGE_KEYS.WORKSPACE_CACHE,
          STORAGE_KEYS.OFFLINE_QUEUE,
          STORAGE_KEYS.NOTIFIED_REMINDERS,
        ]);
        if (isStaleExpectedGen()) return false;
      } else if (shouldBumpGen) {
        _sessionGeneration += 1;
        if (activeExpectedGen !== undefined) activeExpectedGen = _sessionGeneration;
      }
      const nextAccessToken = (authPayload && authPayload.access_token) || "";
      const nextRefreshToken = (authPayload && authPayload.refresh_token) || "";
      const nextUser = (authPayload && authPayload.user) || null;
      await setStorage({
        [STORAGE_KEYS.ACCESS_TOKEN]: nextAccessToken,
        [STORAGE_KEYS.REFRESH_TOKEN]: nextRefreshToken,
        [STORAGE_KEYS.USER]: nextUser,
      });
      if (isStaleExpectedGen()) {
        const onDisk = await getStorage([STORAGE_KEYS.ACCESS_TOKEN]).catch(() => ({}));
        if (onDisk[STORAGE_KEYS.ACCESS_TOKEN] === nextAccessToken) {
          await removeStorage([
            STORAGE_KEYS.ACCESS_TOKEN,
            STORAGE_KEYS.REFRESH_TOKEN,
            STORAGE_KEYS.USER,
          ]);
        }
        return false;
      }
      if (shouldBumpGen) {
        _sessionGeneration += 1;
      }
      return true;
    });
  }

  async function clearAuthSession() {
    _clearEpoch += 1;
    _sessionGeneration += 1;
    _refreshInFlightPromise = null;
    _refreshInFlightToken = "";
    await runSerializedAuthMutation(async () => {
      await removeStorage([
        STORAGE_KEYS.ACCESS_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.USER,
        STORAGE_KEYS.WORKSPACE_CACHE,
        STORAGE_KEYS.OFFLINE_QUEUE,
        STORAGE_KEYS.NOTIFIED_REMINDERS,
      ]);
      _sessionGeneration += 1;
    });
  }

  async function getWorkspaceCache(expectedUserId = "") {
    return runSerializedAuthMutation(async () => {
      const empty = { userId: "", folders: [], tags: [], recentItems: [], user: null };
      const res = await getStorage([STORAGE_KEYS.WORKSPACE_CACHE, STORAGE_KEYS.USER, STORAGE_KEYS.ACCESS_TOKEN]);
      const cache = res[STORAGE_KEYS.WORKSPACE_CACHE];
      const currentUser = res[STORAGE_KEYS.USER];
      const uid = String(
        expectedUserId || (currentUser && currentUser.id) || parseJwtSub(res[STORAGE_KEYS.ACCESS_TOKEN]) || ""
      ).trim();
      if (!uid || !cache || typeof cache !== "object") {
        return empty;
      }
      const cacheUid = String(cache.userId || (cache.user && cache.user.id) || "").trim();
      if (!cacheUid || cacheUid !== uid) {
        return empty;
      }
      return {
        userId: cacheUid,
        folders: Array.isArray(cache.folders) ? cache.folders : [],
        tags: Array.isArray(cache.tags) ? cache.tags : [],
        recentItems: Array.isArray(cache.recentItems) ? cache.recentItems : [],
        user: cache.user || null,
      };
    });
  }

  async function setWorkspaceCache(cache) {
    const startGen = _sessionGeneration;
    const startClearEpoch = _clearEpoch;
    return runSerializedAuthMutation(async () => {
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
      const res = await getStorage([
        STORAGE_KEYS.USER,
        STORAGE_KEYS.ACCESS_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
      ]);
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
      const currentUser = res[STORAGE_KEYS.USER];
      const liveUid = String(
        (currentUser && currentUser.id) || parseJwtSub(res[STORAGE_KEYS.ACCESS_TOKEN]) || ""
      ).trim();
      const hasLiveSession = Boolean(
        liveUid || res[STORAGE_KEYS.ACCESS_TOKEN] || res[STORAGE_KEYS.REFRESH_TOKEN]
      );
      const resolvedUser = (cache && cache.user) || currentUser || null;
      const cacheUid = String((resolvedUser && resolvedUser.id) || "").trim();
      const uid = cacheUid || liveUid;
      if (!hasLiveSession || !uid || (liveUid && cacheUid && cacheUid !== liveUid)) return;
      await setStorage({
        [STORAGE_KEYS.WORKSPACE_CACHE]: {
          userId: uid,
          folders: Array.isArray(cache && cache.folders) ? cache.folders : [],
          tags: Array.isArray(cache && cache.tags) ? cache.tags : [],
          recentItems: Array.isArray(cache && cache.recentItems) ? cache.recentItems : [],
          user: resolvedUser,
          cachedAt: Date.now(),
        },
      });
    });
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
    if (_refreshInFlightPromise && _refreshInFlightToken === refreshToken) {
      return _refreshInFlightPromise;
    }
    const startGen = _sessionGeneration;
    const startClearEpoch = _clearEpoch;
    const pending = (async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!resp.ok) return null;
        const data = await parseJsonSafe(resp);
        if (!data || !data.access_token) return null;
        const current = await getSessionState();
        if (
          _sessionGeneration !== startGen ||
          _clearEpoch !== startClearEpoch ||
          current.refreshToken !== refreshToken
        ) {
          return null;
        }
        const curUid = String(
          (current.user && current.user.id) || parseJwtSub(current.accessToken) || ""
        ).trim();
        const nextUid = String(
          (data.user && data.user.id) || parseJwtSub(data.access_token) || ""
        ).trim();
        if (curUid && nextUid && curUid !== nextUid) {
          return null;
        }
        const saved = await saveAuthSession(
          {
            ...data,
            user: data.user !== undefined ? data.user : current.user,
          },
          {
            expectedGen: startGen,
            expectedRefreshToken: refreshToken,
            expectedClearEpoch: startClearEpoch,
          },
        );
        return saved ? data.access_token : null;
      } catch (_err) {
        return null;
      }
    })();
    _refreshInFlightPromise = pending;
    _refreshInFlightToken = refreshToken;
    try {
      return await pending;
    } finally {
      if (_refreshInFlightPromise === pending) {
        _refreshInFlightPromise = null;
        _refreshInFlightToken = "";
      }
    }
  }

  function createStaleSessionError() {
    const staleErr = new Error("สลับบัญชีหรือออกจากระบบระหว่างดำเนินการ");
    staleErr.aborted = true;
    staleErr.status = 0;
    return staleErr;
  }

  function getSessionIdentity(sessionState) {
    const s = sessionState || {};
    const uid = String((s.user && s.user.id) || parseJwtSub(s.accessToken) || "").trim();
    const hasAuth = Boolean(uid || s.accessToken || s.refreshToken);
    return { uid, hasAuth };
  }

  function hasCrossContextSessionChange(startGen, startUid, startHadAuth, latestState) {
    if (_sessionGeneration !== startGen) return true;
    const latest = getSessionIdentity(latestState);
    if (startUid && latest.uid !== startUid) return true;
    if (!startUid && latest.uid) return true;
    if (startHadAuth !== latest.hasAuth) return true;
    return false;
  }

  async function apiRequest(path, options = {}) {
    const startGen = _sessionGeneration;
    const session = await getSessionState();
    if (options.auth !== false && _sessionGeneration !== startGen) {
      throw createStaleSessionError();
    }
    const { uid: startUid, hasAuth: startHadAuth } = getSessionIdentity(session);
    let attemptedToken = session.accessToken;
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

    let response;
    try {
      response = await fetch(`${backendUrl}${path}`, fetchOpts);
    } catch (networkErr) {
      if (requireAuth) {
        const latestOnNetErr = await getSessionState().catch(() => null);
        if (!latestOnNetErr || hasCrossContextSessionChange(startGen, startUid, startHadAuth, latestOnNetErr)) {
          throw createStaleSessionError();
        }
      }
      throw networkErr;
    }

    if (
      response.status === 401 &&
      requireAuth &&
      !options.skipRefresh &&
      session.refreshToken &&
      _sessionGeneration === startGen
    ) {
      const currentBeforeRefresh = await getSessionState();
      if (
        !hasCrossContextSessionChange(startGen, startUid, startHadAuth, currentBeforeRefresh) &&
        currentBeforeRefresh.refreshToken === session.refreshToken
      ) {
        const nextToken = await tryRefreshAccessToken(backendUrl, session.refreshToken);
        if (nextToken && _sessionGeneration === startGen) {
          const currentAfterRefresh = await getSessionState();
          if (
            !hasCrossContextSessionChange(startGen, startUid, startHadAuth, currentAfterRefresh) &&
            currentAfterRefresh.accessToken === nextToken
          ) {
            attemptedToken = nextToken;
            fetchOpts.headers = { ...headers, Authorization: `Bearer ${nextToken}` };
            try {
              response = await fetch(`${backendUrl}${path}`, fetchOpts);
            } catch (retryNetErr) {
              const latestOnRetryErr = await getSessionState().catch(() => null);
              if (
                !latestOnRetryErr ||
                hasCrossContextSessionChange(startGen, startUid, startHadAuth, latestOnRetryErr)
              ) {
                throw createStaleSessionError();
              }
              throw retryNetErr;
            }
          }
        }
      }
    }

    const payload = await parseJsonSafe(response);
    if (requireAuth) {
      const latestOnResp = await getSessionState();
      if (hasCrossContextSessionChange(startGen, startUid, startHadAuth, latestOnResp)) {
        throw createStaleSessionError();
      }
    }
    if (!response.ok) {
      if (
        response.status === 401 &&
        requireAuth &&
        !options.skipClearOn401 &&
        _sessionGeneration === startGen
      ) {
        const latestSession = await getSessionState();
        if (
          attemptedToken &&
          latestSession.accessToken === attemptedToken &&
          !hasCrossContextSessionChange(startGen, startUid, startHadAuth, latestSession)
        ) {
          await clearAuthSession();
        }
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

  async function loginWithAccessToken(rawToken, refreshToken = "", overrideBackendUrl = "") {
    const token = String(rawToken || "").trim().replace(/^Bearer\s+/i, "");
    if (!token) {
      throw new Error("กรุณาวาง Access Token ก่อนเข้าสู่ระบบ");
    }
    const authEpoch = beginAuthLogin();
    const session = await getSessionState();
    const targetBackendUrl = overrideBackendUrl
      ? normalizeBackendUrl(overrideBackendUrl)
      : session.backendUrl;
    const response = await fetch(`${targetBackendUrl}/api/auth/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await parseJsonSafe(response);
    if (!response.ok || !payload || !payload.id) {
      const msg = (payload && (payload.detail || payload.message)) || `HTTP ${response.status}`;
      throw new Error(`Token ไม่ถูกต้องหรือหมดอายุ (${msg})`);
    }
    if (isAuthEpochStale(authEpoch)) {
      throw createStaleSessionError();
    }
    const saved = await saveAuthSession(
      {
        access_token: token,
        refresh_token: String(refreshToken || "").trim(),
        user: payload,
      },
      authEpoch,
    );
    if (!saved) {
      throw createStaleSessionError();
    }
    if (overrideBackendUrl && !isAuthEpochStale(authEpoch)) {
      await runSerializedAuthMutation(async () => {
        if (!isAuthEpochStale(authEpoch)) {
          await setBackendUrl(targetBackendUrl);
        }
      });
    }
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

  function isGenericPlatformTitle(title, rawUrl = "") {
    const stripped = String(title || "").trim();
    if (!stripped) return true;
    const lowered = stripped.toLowerCase();
    if (/^https?:\/\//i.test(stripped)) return true;
    if (rawUrl) {
      const urlTrim = String(rawUrl).trim().toLowerCase();
      if (lowered === urlTrim) return true;
      try {
        const host = new URL(rawUrl).hostname.toLowerCase();
        if (host && (lowered === host || lowered === host.replace(/^www\./, ""))) return true;
      } catch (_err) {
        // Ignore invalid URL
      }
    }
    const noBadge = stripped.replace(/^\(\d+\+?\)\s+/, "").trim().toLowerCase();
    const genericSet = new Set([
      "instagram",
      "log in • instagram",
      "login • instagram",
      "เข้าสู่ระบบ • instagram",
      "เข้าสู่ระบบ instagram",
      "instagram photo",
      "instagram video",
      "instagram reel",
      "instagram reels",
      "facebook",
      "facebook - log in or sign up",
      "log into facebook",
      "log in to facebook",
      "เข้าสู่ระบบ facebook",
      "watch",
      "facebook watch",
      "reels",
      "tiktok",
      "tiktok - make your day",
      "watch trending videos for you",
      "watch trending videos for you | tiktok",
      "youtube",
      "- youtube",
      "home - youtube",
      "shorts - youtube",
      "x",
      "twitter",
      "home / x",
      "log in to x / x",
      "reddit",
      "reddit - dive into anything",
      "vimeo",
      "spotify",
      "threads",
    ]);
    if (genericSet.has(lowered) || genericSet.has(noBadge)) return true;
    if (/^@?[a-z0-9._]+\s+(?:on|บน)\s+instagram$/i.test(noBadge)) return true;
    if (/^(?:watch trending|discover|make your day|tiktok)\b.*\|\s*tiktok$/i.test(noBadge)) return true;
    return false;
  }

  function getSocialPostLinkWarning(rawUrl) {
    if (!isSaveableHttpUrl(rawUrl)) return null;
    try {
      const parsed = new URL(rawUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname || "/";
      const params = parsed.searchParams;

      if (host === "fb.watch" || host.endsWith(".fb.watch")) {
        if (path.replace(/^\/+|\/+$/g, "").length > 0) return null;
        return {
          platform: "Facebook",
          example: "https://www.facebook.com/share/p/...",
          message:
            "หน้านี้ไม่ใช่ลิงก์โพสต์ Facebook โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากโพสต์หรือคลิป แล้วนำมาวางในช่อง URL",
        };
      }
      if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
        const hasPostParam = Boolean(
          params.get("story_fbid") || params.get("fbid") || params.get("v") || params.get("multi_permalinks")
        );
        const isDirectPostPath =
          /^\/share\/(?:[pvr]\/)?[A-Za-z0-9_-]+/i.test(path) ||
          /\/(?:posts|videos|photos|permalink)\/[^/]+/i.test(path) ||
          /^\/(?:reel|reels)\/[^/]+/i.test(path) ||
          /^\/(?:permalink|story|photo)\.php/i.test(path) ||
          /^\/watch\/live\/?/i.test(path) ||
          /pfbid[A-Za-z0-9]+/i.test(path);
        if (hasPostParam || isDirectPostPath) {
          return null;
        }
        return {
          platform: "Facebook",
          example: "https://www.facebook.com/share/p/...",
          message:
            "หน้านี้เป็นหน้าฟีดหรือหน้าเพจของ Facebook ไม่ใช่ลิงก์โพสต์โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากโพสต์หรือคลิปที่ต้องการ แล้วนำมาวางในช่อง URL ด้านล่าง",
        };
      }

      if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
        const isIgPostPath =
          /^\/(?:[^/]+\/)?(?:p|reel|reels|tv|share)\/[A-Za-z0-9_-]+/i.test(path) ||
          /^\/stories\/[^/]+\/\d+/i.test(path);
        if (isIgPostPath) {
          return null;
        }
        return {
          platform: "Instagram",
          example: "https://www.instagram.com/p/... หรือ /reel/...",
          message:
            "หน้านี้เป็นหน้าฟีดหรือโปรไฟล์ของ Instagram ไม่ใช่ลิงก์โพสต์โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากโพสต์หรือ Reel ที่ต้องการ แล้วนำมาวางในช่อง URL ด้านล่าง",
        };
      }

      if (host === "vt.tiktok.com" || host === "vm.tiktok.com") {
        if (path.replace(/^\/+|\/+$/g, "").length > 0) return null;
        return {
          platform: "TikTok",
          example: "https://vt.tiktok.com/...",
          message:
            "หน้านี้ไม่ใช่ลิงก์คลิป TikTok โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากคลิปที่ต้องการ แล้วนำมาวางในช่อง URL ด้านล่าง",
        };
      }
      if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
        const hasTtParam = Boolean(params.get("item_id") || params.get("share_item_id"));
        const isTtPostPath =
          /^\/@[^/]+\/(?:video|photo)\/\d+/i.test(path) ||
          /^\/(?:t|v)\/[A-Za-z0-9_-]+/i.test(path) ||
          /^\/embed\//i.test(path);
        if (hasTtParam || isTtPostPath) {
          return null;
        }
        return {
          platform: "TikTok",
          example: "https://www.tiktok.com/@user/video/... หรือ https://vt.tiktok.com/...",
          message:
            "หน้านี้เป็นหน้าฟีดหรือโปรไฟล์ของ TikTok ไม่ใช่ลิงก์คลิปโดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากคลิปที่ต้องการ แล้วนำมาวางในช่อง URL ด้านล่าง",
        };
      }
    } catch (_err) {
      return null;
    }
    return null;
  }

  async function getOfflineQueue(expectedUserId = "") {
    return runSerializedAuthMutation(async () => {
      const res = await getStorage([STORAGE_KEYS.OFFLINE_QUEUE, STORAGE_KEYS.USER, STORAGE_KEYS.ACCESS_TOKEN]);
      const raw = Array.isArray(res[STORAGE_KEYS.OFFLINE_QUEUE]) ? res[STORAGE_KEYS.OFFLINE_QUEUE] : [];
      const uid = String(
        expectedUserId ||
          (res[STORAGE_KEYS.USER] && res[STORAGE_KEYS.USER].id) ||
          parseJwtSub(res[STORAGE_KEYS.ACCESS_TOKEN]) ||
          ""
      ).trim();
      if (!uid) {
        return raw.filter((entry) => !entry?.user_id);
      }
      return raw.filter((entry) => Boolean(entry?.user_id) && String(entry.user_id).trim() === uid);
    });
  }

  async function enqueueOfflineSave(payload, reason = "offline") {
    if (!payload || !isSaveableHttpUrl(payload.url)) return await getOfflineQueue();
    const startGen = _sessionGeneration;
    const startClearEpoch = _clearEpoch;
    return runSerializedAuthMutation(async () => {
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return [];
      const res = await getStorage([STORAGE_KEYS.OFFLINE_QUEUE, STORAGE_KEYS.USER, STORAGE_KEYS.ACCESS_TOKEN]);
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return [];
      const uid = String(
        (res[STORAGE_KEYS.USER] && res[STORAGE_KEYS.USER].id) || parseJwtSub(res[STORAGE_KEYS.ACCESS_TOKEN]) || ""
      ).trim();
      const allRaw = Array.isArray(res[STORAGE_KEYS.OFFLINE_QUEUE]) ? res[STORAGE_KEYS.OFFLINE_QUEUE] : [];
      const ownCurrent = allRaw.filter((entry) =>
        uid ? Boolean(entry?.user_id) && String(entry.user_id).trim() === uid : !entry?.user_id
      );
      const foreignEntries = allRaw.filter((entry) =>
        uid ? Boolean(entry?.user_id) && String(entry.user_id).trim() !== uid : Boolean(entry?.user_id)
      );
      const deduped = ownCurrent.filter((entry) => entry?.payload?.url !== payload.url);
      const nextOwn = [
        {
          id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          user_id: uid,
          payload,
          reason,
          queued_at: new Date().toISOString(),
        },
        ...deduped,
      ].slice(0, 50);
      await setStorage({ [STORAGE_KEYS.OFFLINE_QUEUE]: [...nextOwn, ...foreignEntries] });
      return nextOwn;
    });
  }

  async function flushOfflineQueue(saveFn) {
    const startGen = _sessionGeneration;
    const startClearEpoch = _clearEpoch;
    const prep = await runSerializedAuthMutation(async () => {
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        return { earlyResult: { flushed: 0, remaining: 0, failed: 0, aborted: true, unauthorized: false } };
      }
      const session = await getSessionState();
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        return { earlyResult: { flushed: 0, remaining: 0, failed: 0, aborted: true, unauthorized: false } };
      }
      const startAccessToken = session.accessToken || "";
      const currentUid = String(
        (session && session.user && session.user.id) || parseJwtSub(session && session.accessToken) || ""
      ).trim();
      const res = await getStorage([STORAGE_KEYS.OFFLINE_QUEUE]);
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        return { earlyResult: { flushed: 0, remaining: 0, failed: 0, aborted: true, unauthorized: false } };
      }
      const allQueue = Array.isArray(res[STORAGE_KEYS.OFFLINE_QUEUE]) ? res[STORAGE_KEYS.OFFLINE_QUEUE] : [];
      if (!currentUid && typeof saveFn !== "function") {
        return { earlyResult: { flushed: 0, remaining: allQueue.length, failed: 0, aborted: false, unauthorized: false } };
      }
      const foreignRemaining = [];
      const queue = [];
      const removedIds = new Set();
      for (const entry of allQueue) {
        const entryUid = String(entry?.user_id || "").trim();
        if (!currentUid) {
          if (!entryUid) queue.push(entry);
          else foreignRemaining.push(entry);
        } else if (!entryUid) {
          if (entry && entry.id) removedIds.add(String(entry.id));
          continue; // Drop legacy unstamped entries when authenticated to prevent cross-account attribution
        } else if (entryUid !== currentUid) {
          foreignRemaining.push(entry);
        } else {
          queue.push(entry);
        }
      }
      if (!queue.length) {
        if (foreignRemaining.length !== allQueue.length) {
          const pruned = allQueue.filter((entry) => {
            const entryUid = String(entry?.user_id || "").trim();
            if (currentUid && !entryUid) return false;
            return !entry?.id || !removedIds.has(String(entry.id));
          });
          await setStorage({ [STORAGE_KEYS.OFFLINE_QUEUE]: pruned });
        }
        return { earlyResult: { flushed: 0, remaining: 0, failed: 0, aborted: false, unauthorized: false } };
      }
      return { startAccessToken, currentUid, queue, removedIds };
    });

    if (prep.earlyResult) {
      return prep.earlyResult;
    }

    const { startAccessToken, currentUid, queue, removedIds } = prep;
    const sender =
      typeof saveFn === "function"
        ? saveFn
        : (itemPayload) => apiRequest("/api/items", { method: "POST", body: itemPayload });

    let flushed = 0;
    let failed = 0;
    let saw401 = false;
    let sawAborted = false;
    const remaining = [];
    for (let i = 0; i < queue.length; i += 1) {
      const entry = queue[i];
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        sawAborted = true;
        remaining.push(...queue.slice(i));
        break;
      }
      try {
        await sender(entry.payload);
        flushed += 1;
        if (entry && entry.id) removedIds.add(String(entry.id));
      } catch (err) {
        if (err && err.aborted) {
          sawAborted = true;
          remaining.push(...queue.slice(i));
          break;
        }
        if (err && err.status === 401) {
          saw401 = true;
          remaining.push(...queue.slice(i));
          break;
        }
        if (err && typeof err.status === "number" && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          failed += 1; // Permanent client validation error: drop instead of infinite retry
          if (entry && entry.id) removedIds.add(String(entry.id));
        } else {
          remaining.push(...queue.slice(i));
          break;
        }
      }
    }

    return runSerializedAuthMutation(async () => {
      const latestSession = await getSessionState();
      const latestUid = String(
        (latestSession && latestSession.user && latestSession.user.id) ||
          parseJwtSub(latestSession && latestSession.accessToken) ||
          ""
      ).trim();
      const crossUserActive =
        (Boolean(currentUid) && Boolean(latestUid) && latestUid !== currentUid) ||
        (!currentUid && Boolean(latestUid)) ||
        (Boolean(latestSession.accessToken) &&
          Boolean(startAccessToken) &&
          latestSession.accessToken !== startAccessToken);
      const authLostOrChanged =
        _sessionGeneration !== startGen ||
        _clearEpoch !== startClearEpoch ||
        latestUid !== currentUid ||
        (typeof saveFn !== "function" && currentUid && !latestSession.accessToken);
      const unauthorized = Boolean(saw401 && !sawAborted && !crossUserActive);
      const aborted = Boolean(sawAborted || (authLostOrChanged && !unauthorized));
      if (authLostOrChanged) {
        return { flushed, remaining: remaining.length, failed, aborted, unauthorized };
      }
      const latestStorage = await getStorage([STORAGE_KEYS.OFFLINE_QUEUE]);
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        return { flushed, remaining: remaining.length, failed, aborted: true, unauthorized: false };
      }
      const latestQueue = Array.isArray(latestStorage[STORAGE_KEYS.OFFLINE_QUEUE])
        ? latestStorage[STORAGE_KEYS.OFFLINE_QUEUE]
        : [];
      const nextQueue = latestQueue.filter((entry) => {
        const entryUid = String(entry?.user_id || "").trim();
        if (currentUid && !entryUid) return false;
        return !entry?.id || !removedIds.has(String(entry.id));
      });
      await setStorage({ [STORAGE_KEYS.OFFLINE_QUEUE]: nextQueue });
      return { flushed, remaining: remaining.length, failed, aborted: false, unauthorized };
    });
  }

  async function syncNotifiedReminders(reminders, options = {}) {
    const startGen = options.expectedGen !== undefined ? options.expectedGen : _sessionGeneration;
    const startClearEpoch = options.expectedClearEpoch !== undefined ? options.expectedClearEpoch : _clearEpoch;
    const onNotify = typeof options.onNotify === "function" ? options.onNotify : null;
    return runSerializedAuthMutation(async () => {
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return false;
      const session = await getSessionState();
      if (!session.accessToken || _sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) {
        return false;
      }
      const stored = await getStorage([STORAGE_KEYS.NOTIFIED_REMINDERS]);
      if (_sessionGeneration !== startGen || _clearEpoch !== startClearEpoch) return false;
      const notifiedMap = { ...(stored[STORAGE_KEYS.NOTIFIED_REMINDERS] || {}) };
      const nowMs = Date.now();
      const lookbackMs = 10 * 60 * 1000;
      let changed = false;

      for (const rem of Array.isArray(reminders) ? reminders : []) {
        if (!rem || rem.is_enabled === false || rem.is_completed) continue;
        const dueStr = rem.next_remind_at || rem.remind_at;
        if (!dueStr) continue;
        const dueMs = new Date(dueStr).getTime();
        if (Number.isNaN(dueMs)) continue;
        if (dueMs <= nowMs + 60000 && dueMs >= nowMs - lookbackMs) {
          const key = `${rem.id}:${dueStr}`;
          if (notifiedMap[key]) continue;
          notifiedMap[key] = nowMs;
          changed = true;
          if (onNotify) onNotify(rem);
        }
      }

      const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
      for (const [k, ts] of Object.entries(notifiedMap)) {
        if (typeof ts !== "number" || ts < cutoffMs) {
          delete notifiedMap[k];
          changed = true;
        }
      }

      if (changed) {
        await setStorage({ [STORAGE_KEYS.NOTIFIED_REMINDERS]: notifiedMap });
      }
      return changed;
    });
  }

  async function fetchRecentItems({ search = "", limit = 20 } = {}) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (String(search || "").trim()) {
      params.set("q", String(search).trim());
    }
    return apiRequest(`/api/items?${params.toString()}`);
  }

  async function updateItemStatus(itemId, status) {
    return apiRequest(`/api/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: { status },
    });
  }

  async function fetchReminders() {
    return apiRequest("/api/reminders");
  }

  async function fetchWorkspace({ limit = 50 } = {}) {
    try {
      return await apiRequest(`/api/workspace?limit=${encodeURIComponent(String(limit))}`);
    } catch (err) {
      if (err && err.status === 404) {
        const [me, foldersRes, tagsRes, itemsRes] = await Promise.all([
          apiRequest("/api/auth/me"),
          apiRequest("/api/folders"),
          apiRequest("/api/tags"),
          fetchRecentItems({ limit }),
        ]);
        return {
          ...me,
          folders: (foldersRes && foldersRes.folders) || [],
          tags: (tagsRes && tagsRes.tags) || [],
          items: (itemsRes && itemsRes.items) || [],
        };
      }
      throw err;
    }
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
    parseJwtSub,
    saveAuthSession,
    clearAuthSession,
    beginAuthLogin,
    isAuthEpochStale,
    getClearEpoch: () => _clearEpoch,
    getSessionGeneration: () => _sessionGeneration,
    getWorkspaceCache,
    setWorkspaceCache,
    setBackendUrl,
    getStorage,
    setStorage,
    removeStorage,
    apiRequest,
    checkHealth,
    loginWithAccessToken,
    formatAiSummaryResponse,
    runDomAssist,
    isSaveableHttpUrl,
    isGenericPlatformTitle,
    getSocialPostLinkWarning,
    getOfflineQueue,
    enqueueOfflineSave,
    flushOfflineQueue,
    syncNotifiedReminders,
    fetchRecentItems,
    fetchWorkspace,
    updateItemStatus,
    fetchReminders,
  };

  global.JustSaveItApi = exportedApi;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportedApi;
  }
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
