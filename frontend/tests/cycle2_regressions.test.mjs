import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { store } from "../src/state/store.js";
import { apiClient, loadWorkspaceCache, saveWorkspaceCache } from "../src/services/apiClient.js";
import { startRealtimeSync, stopRealtimeSync } from "../src/services/realtimeClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function mockResp(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function createMemoryLocalStorage() {
  const map = new Map();
  return {
    map,
    api: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

function loadExtensionApiWithMockChrome() {
  const storeMap = new Map();
  const chromeMock = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          for (const k of keyList) {
            if (storeMap.has(k)) out[k] = storeMap.get(k);
          }
          cb(out);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values || {})) {
            storeMap.set(k, structuredClone(v));
          }
          if (cb) cb();
        },
        remove(keys, cb) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) storeMap.delete(k);
          if (cb) cb();
        },
      },
    },
  };

  const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
  const sandbox = {
    globalThis: {},
    chrome: chromeMock,
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => mockResp(200, {}),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });
  return { extApi: sandbox.JustSaveItApi, storeMap };
}

test("Extension C4: cross-account cache & offline queue isolation + narrow CSS + popup state reset", async () => {
  const { extApi, storeMap } = loadExtensionApiWithMockChrome();

  // User A logs in, caches workspace, and queues offline item
  await extApi.saveAuthSession({
    access_token: "tok-a",
    refresh_token: "ref-a",
    user: { id: "user-a", email: "a@example.com" },
  });
  await extApi.setWorkspaceCache({
    folders: [{ id: "fa", name: "Folder A" }],
    recentItems: [{ id: "ia", title: "Secret A" }],
  });
  await extApi.enqueueOfflineSave({ url: "https://a.example.com/secret", title: "Offline Secret A" });

  const cachedA = await extApi.getWorkspaceCache("user-a");
  assert.equal(cachedA.recentItems[0].title, "Secret A");
  assert.equal(cachedA.userId, "user-a");
  assert.equal((await extApi.getOfflineQueue("user-a")).length, 1);

  // Switch account -> User B logs in: User A's cache & offline queue must be purged & unreadable
  await extApi.saveAuthSession({
    access_token: "tok-b",
    refresh_token: "ref-b",
    user: { id: "user-b", email: "b@example.com" },
  });
  const afterSwitchCache = await extApi.getWorkspaceCache("user-b");
  assert.equal(afterSwitchCache.recentItems.length, 0, "User A cache must be cleared on account switch");
  assert.equal(afterSwitchCache.folders.length, 0);
  assert.equal((await extApi.getOfflineQueue("user-b")).length, 0, "User A queue must not leak to User B");

  // Even if foreign cache/queue rows exist manually under storage keys, getters/flush reject foreign & legacy unstamped user_id
  storeMap.set(extApi.STORAGE_KEYS.WORKSPACE_CACHE, {
    userId: "user-a",
    recentItems: [{ id: "stale-a" }],
    updatedAt: Date.now(),
  });
  storeMap.set(extApi.STORAGE_KEYS.OFFLINE_QUEUE, [
    { id: "q-legacy-no-uid", payload: { url: "https://legacy.example.com/unknown" } },
    { id: "q-foreign", user_id: "user-a", payload: { url: "https://a.example.com/foreign" } },
    { id: "q-own", user_id: "user-b", payload: { url: "https://b.example.com/own" } },
  ]);
  assert.equal((await extApi.getWorkspaceCache("user-b")).recentItems.length, 0);
  storeMap.set(extApi.STORAGE_KEYS.WORKSPACE_CACHE, {
    recentItems: [{ id: "legacy-unstamped" }],
    updatedAt: Date.now(),
  });
  assert.equal((await extApi.getWorkspaceCache("user-b")).recentItems.length, 0, "Legacy unstamped cache must not leak");
  const flushedUrls = [];
  const flushRes = await extApi.flushOfflineQueue(async (payload) => {
    flushedUrls.push(payload.url);
    return true;
  });
  assert.deepEqual(flushedUrls, ["https://b.example.com/own"]);
  assert.equal(flushRes.remaining, 0);

  // Clear auth session purges cache & notified reminders, and default flush while signed out refuses foreign entries
  await extApi.setWorkspaceCache({ folders: [], recentItems: [{ id: "ib" }] });
  storeMap.set(extApi.STORAGE_KEYS.NOTIFIED_REMINDERS, { "r-1": Date.now() });
  await extApi.clearAuthSession();
  assert.equal(storeMap.has(extApi.STORAGE_KEYS.WORKSPACE_CACHE), false);
  assert.equal(storeMap.has(extApi.STORAGE_KEYS.OFFLINE_QUEUE), false);
  assert.equal(storeMap.has(extApi.STORAGE_KEYS.NOTIFIED_REMINDERS), false);

  storeMap.set(extApi.STORAGE_KEYS.OFFLINE_QUEUE, [{ id: "q-signedout", user_id: "user-a", payload: { url: "https://a.example.com" } }]);
  assert.equal((await extApi.getOfflineQueue()).length, 0);
  const signedOutFlush = await extApi.flushOfflineQueue();
  assert.equal(signedOutFlush.flushed, 0);
  assert.equal(signedOutFlush.remaining, 1);
  assert.equal(signedOutFlush.failed, 0);

  const popupCss = fs.readFileSync(path.join(repoRoot, "extension", "popup.css"), "utf8");
  assert.match(popupCss, /width:\s*min\(400px,\s*100vw\)/);
  const popupJs = fs.readFileSync(path.join(repoRoot, "extension", "popup.js"), "utf8");
  assert.match(popupJs, /resetSaverMemoryAndInputs/);
  assert.doesNotMatch(popupJs, /els\.folderChipWrap\.innerHTML\s*=\s*""/);
  assert.match(popupJs, /toggleNewFolderBtn\.parentNode\s*===\s*els\.folderChipWrap/);
});

test("Frontend H1: realtimeClient ignores stale socket callbacks after stop/restart", () => {
  const origWs = globalThis.WebSocket;
  const createdSockets = [];
  const syncEvents = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      this.closed = false;
      createdSockets.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.closed = true;
    }
    emit(type, payload = {}) {
      for (const fn of this.listeners.get(type) || []) {
        fn(payload);
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const opts = {
      getSupabaseConfig: () => ({ url: "https://demo.supabase.co", anonKey: "anon-key" }),
      getAccessToken: () => "jwt-token",
      isAuthenticated: () => true,
      onSync: async (reason) => {
        syncEvents.push(reason);
      },
    };

    startRealtimeSync(opts);
    const sock1 = createdSockets[0];
    assert.ok(sock1);

    // Replace active connection cleanly
    startRealtimeSync(opts);
    const sock2 = createdSockets[1];
    assert.ok(sock2 && sock2 !== sock1);

    // Stale sock1 emits message, error, and close -> none should trigger sync or corrupt sock2
    sock1.emit("open");
    sock1.emit("message", {
      data: JSON.stringify({ event: "INSERT", table: "items", record: { id: "stale" } }),
    });
    sock1.emit("close");
    assert.equal(syncEvents.length, 0);

    // Stopping clears sock2 and rejects late sock2 callbacks too
    stopRealtimeSync();
    sock2.emit("message", {
      data: JSON.stringify({ event: "INSERT", table: "items", record: { id: "after-stop" } }),
    });
    sock2.emit("close");
    assert.equal(syncEvents.length, 0);
  } finally {
    stopRealtimeSync();
    globalThis.WebSocket = origWs;
  }
});

test("Frontend C3: hydrateWorkspace & refreshSession abort when auth context changes mid-flight", async () => {
  const { api: ls, map: lsMap } = createMemoryLocalStorage();
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  globalThis.localStorage = ls;

  try {
    store.resetSeed();
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-a",
      refreshToken: "ref-a",
      user: { id: "user-a", email: "a@example.com", name: "User A" },
    });

    let resolveWorkspaceFetch;
    const delayedWorkspace = new Promise((resolve) => {
      resolveWorkspaceFetch = resolve;
    });

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/workspace")) {
        return delayedWorkspace;
      }
      if (u.includes("/api/auth/refresh")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "stale-new-jwt", user: { id: "user-a" } }) };
      }
      return mockResp(200, {});
    };

    const hydratePromise = apiClient.hydrateWorkspace();

    // Switch account mid-flight to User B before User A's /api/workspace returns
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-b",
      refreshToken: "ref-b",
      user: { id: "user-b", email: "b@example.com", name: "User B" },
    });
    store.state.data.links = [{ id: "b-own", title: "User B Item", url: "https://b.test", tags: [] }];

    resolveWorkspaceFetch(
      mockResp(200, {
        id: "user-a",
        email: "a@example.com",
        folders: [{ id: "fa", name: "Secret Folder A" }],
        tags: [],
        items: [{ id: "a-secret", url: "https://a.test", title: "Secret A" }],
        reminders: [],
      })
    );

    const hydrateRes = await hydratePromise;
    assert.equal(hydrateRes.ok, false);
    assert.equal(hydrateRes.stale, true);
    assert.equal(store.state.data.links.length, 1);
    assert.equal(store.state.data.links[0].id, "b-own", "User A response must not overwrite User B links");
    assert.equal(loadWorkspaceCache("user-b"), null, "User A payload must not poison User B cache");

    // Refresh session race when user logs out mid-flight
    let resolveRefreshFetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/auth/refresh")) {
        return new Promise((r) => {
          resolveRefreshFetch = r;
        });
      }
      return mockResp(200, {});
    };
    const refreshPromise = apiClient.refreshSession();
    store.clearSession({ redirectToLogin: true, clearWorkspace: true });
    resolveRefreshFetch(
      mockResp(200, { access_token: "revived-jwt-b", refresh_token: "revived-ref-b", user: { id: "user-b" } })
    );
    const refreshRes = await refreshPromise;
    assert.equal(refreshRes.stale, true);
    assert.equal(store.state.data.user.isAuthenticated, false, "Stale refresh must not re-authenticate logged-out user");
    assert.ok(lsMap instanceof Map);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("Frontend H2, M3 & M4: deduplicated createLink + activeLinkId reconciliation, saveFolder PATCH cache sync, cursor pagination >500 items", async () => {
  const { api: ls } = createMemoryLocalStorage();
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  globalThis.localStorage = ls;

  try {
    store.resetSeed();
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-a",
      refreshToken: "ref-a",
      user: { id: "user-h2", email: "h2@example.com", name: "Tester" },
    });
    store.state.data.folders = [{ id: "f1", name: "Inbox Folder", emoji: "📁", baseExternalCount: 1 }];
    store.state.data.links = [
      { id: "dup-1", folderId: "f1", url: "https://example.com/dup", title: "Existing Dup", tags: [] },
    ];

    // 1) H2 deduplicated createLink must not duplicate row or inflate baseExternalCount
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/api/items") && init.method === "POST") {
        return mockResp(201, {
          id: "dup-1",
          folder_id: "f1",
          url: "https://example.com/dup",
          title: "Existing Dup Updated",
          deduplicated: true,
          tags: [],
        });
      }
      if (u.endsWith("/api/folders/f1") && init.method === "PATCH") {
        return mockResp(200, { id: "f1", name: "Server Renamed", emoji: "🔥", cover_url: "./assets/covers/work.png" });
      }
      return mockResp(200, {});
    };

    const dupSaved = await apiClient.createLink({
      url: "https://example.com/dup",
      title: "Dup Try",
      folderId: "f1",
      skipPreview: true,
    });
    assert.equal(dupSaved.id, "dup-1");
    assert.equal(store.state.data.links.filter((l) => l.id === "dup-1").length, 1);
    assert.equal(store.state.data.folders[0].baseExternalCount, 1, "Deduplicated save must revert optimistic +1 count");

    // 2) H2 activeLinkId updates when user clicks optimistic row while POST /api/items is in flight
    let resolveCreate;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith("/api/items") && init.method === "POST") {
        return new Promise((r) => {
          resolveCreate = r;
        });
      }
      if (String(url).endsWith("/api/folders/f1") && init.method === "PATCH") {
        return mockResp(200, { id: "f1", name: "Server Renamed", emoji: "🔥", cover_url: "./assets/covers/work.png" });
      }
      return mockResp(200, {});
    };
    const createPromise = apiClient.createLink({
      url: "https://example.com/fresh",
      title: "Fresh",
      folderId: "f1",
      skipPreview: true,
    });
    const optimisticRow = store.state.data.links.find((l) => l._optimistic);
    assert.ok(optimisticRow);
    store.state.ui.activeLinkId = optimisticRow.id;
    resolveCreate(mockResp(201, { id: "srv-fresh-99", folder_id: "f1", url: "https://example.com/fresh", title: "Fresh Server" }));
    const createdFresh = await createPromise;
    assert.equal(createdFresh.id, "srv-fresh-99");
    assert.equal(store.state.ui.activeLinkId, "srv-fresh-99", "activeLinkId must reconcile from temp UUID to server ID");

    // 3) M3 saveFolder edit branch merges server response and persists SWR cache
    const updatedFolder = await apiClient.saveFolder({ folderId: "f1", name: "Renamed Local", emoji: "📁" });
    assert.equal(updatedFolder.name, "Server Renamed");
    assert.equal(updatedFolder.emoji, "🔥");
    const cachedAfterFolder = loadWorkspaceCache("user-h2");
    assert.equal(cachedAfterFolder.folders[0].name, "Server Renamed");

    // 4) M4 cursor pagination >500 items & deduplication
    const seenUrls = [];
    const makeBatch = (start, count, overlapFirst = null) => {
      const rows = [];
      if (overlapFirst) {
        rows.push({ id: overlapFirst, url: `https://ex.com/${overlapFirst}`, title: overlapFirst, tags: [] });
      }
      for (let i = start; i < start + count; i += 1) {
        rows.push({ id: `it-${i}`, url: `https://ex.com/${i}`, title: `Item ${i}`, tags: [] });
      }
      return rows;
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      seenUrls.push(u);
      if (u.includes("/api/workspace")) {
        return mockResp(200, {
          id: "user-h2",
          folders: [{ id: "f1", name: "Inbox" }],
          tags: [],
          reminders: [],
          items: makeBatch(0, 100),
          next_cursor: "cur-1",
        });
      }
      if (u.includes("cursor=cur-1")) return mockResp(200, { items: makeBatch(100, 100, "it-99"), next_cursor: "cur-2" });
      if (u.includes("cursor=cur-2")) return mockResp(200, { items: makeBatch(200, 100), next_cursor: "cur-3" });
      if (u.includes("cursor=cur-3")) return mockResp(200, { items: makeBatch(300, 100), next_cursor: "cur-4" });
      if (u.includes("cursor=cur-4")) return mockResp(200, { items: makeBatch(400, 100), next_cursor: "cur-5" });
      if (u.includes("cursor=cur-5")) return mockResp(200, { items: makeBatch(500, 100), next_cursor: null });
      return mockResp(200, { items: [], next_cursor: null });
    };

    const pageRes = await apiClient.hydrateWorkspace();
    assert.equal(pageRes.ok, true);
    assert.equal(store.state.data.links.length, 600, "Must hydrate >500 items and deduplicate overlap");
    assert.ok(seenUrls.some((u) => u.includes("cursor=cur-5")));
    assert.equal(seenUrls.some((u) => u.includes("offset=")), false, "Must use cursor instead of offset");
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
    saveWorkspaceCache("user-h2");
  }
});

test("Extension H-1: getWorkspaceCache fails closed when signed out, refresh aborts on account switch, and flush does not resurrect after 401/clobber concurrent enqueues", async () => {
  const { extApi, storeMap } = loadExtensionApiWithMockChrome();

  // 1) Signed-out getWorkspaceCache fails closed even if foreign cache exists
  storeMap.set(extApi.STORAGE_KEYS.WORKSPACE_CACHE, {
    userId: "user-secret",
    folders: [{ id: "fs", name: "Private Folder" }],
    recentItems: [{ id: "is", title: "Private Secret" }],
  });
  const guestCache = await extApi.getWorkspaceCache();
  assert.equal(guestCache.recentItems.length, 0);
  assert.equal(guestCache.folders.length, 0);

  // 2) Concurrent enqueueOfflineSave during slow flush is preserved, and 401 + clearAuthSession does not resurrect queue
  await extApi.saveAuthSession({
    access_token: "tok-a",
    refresh_token: "ref-a",
    user: { id: "user-a", email: "a@example.com" },
  });
  await extApi.enqueueOfflineSave({ url: "https://a.example.com/item-1", title: "Item 1" });

  let resolveFlushSend;
  const firstFlushPromise = extApi.flushOfflineQueue(async () => {
    await new Promise((r) => {
      resolveFlushSend = r;
    });
    return { id: "ok-1" };
  });
  // Wait microtasks so sender() is suspended
  await new Promise((r) => setTimeout(r, 15));
  await extApi.enqueueOfflineSave({ url: "https://a.example.com/item-2", title: "Concurrent Item 2" });
  resolveFlushSend();
  const res1 = await firstFlushPromise;
  assert.equal(res1.flushed, 1);
  const queueAfterConcurrent = await extApi.getOfflineQueue("user-a");
  assert.equal(queueAfterConcurrent.length, 1);
  assert.equal(queueAfterConcurrent[0].payload.url, "https://a.example.com/item-2");

  // 3) Default apiRequest hitting 401 wipes session & queue via clearAuthSession -> flushOfflineQueue must NOT resurrect item-2
  const origSandboxRes = await (async () => {
    const storeMap2 = new Map();
    const chromeMock = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
            for (const k of keyList) if (storeMap2.has(k)) out[k] = storeMap2.get(k);
            cb(out);
          },
          set(values, cb) {
            for (const [k, v] of Object.entries(values || {})) storeMap2.set(k, structuredClone(v));
            if (cb) cb();
          },
          remove(keys, cb) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) storeMap2.delete(k);
            if (cb) cb();
          },
        },
      },
    };
    const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
    const sandbox = {
      globalThis: {},
      chrome: chromeMock,
      URL,
      Date,
      Math,
      console,
      setTimeout,
      clearTimeout,
      fetch: async () => mockResp(401, { detail: "expired" }),
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });
    return { api: sandbox.JustSaveItApi, map: storeMap2 };
  })();
  await origSandboxRes.api.saveAuthSession({
    access_token: "tok-401",
    refresh_token: "ref-401",
    user: { id: "user-401", email: "401@example.com" },
  });
  await origSandboxRes.api.enqueueOfflineSave({ url: "https://a.example.com/401-item", title: "Should Stay Purged" });
  const flush401 = await origSandboxRes.api.flushOfflineQueue();
  assert.equal(flush401.flushed, 0);
  assert.equal(origSandboxRes.map.has(origSandboxRes.api.STORAGE_KEYS.OFFLINE_QUEUE), false, "401 wipe must not resurrect purged queue");

  // 4) Switch account mid-refresh does NOT overwrite User B's session
  const sandboxRefresh = (() => {
    const storeMap3 = new Map();
    const chromeMock = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
            for (const k of keyList) if (storeMap3.has(k)) out[k] = storeMap3.get(k);
            cb(out);
          },
          set(values, cb) {
            for (const [k, v] of Object.entries(values || {})) storeMap3.set(k, structuredClone(v));
            if (cb) cb();
          },
          remove(keys, cb) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) storeMap3.delete(k);
            if (cb) cb();
          },
        },
      },
    };
    let resolveRefreshFetch;
    const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
    const sandbox = {
      globalThis: {},
      chrome: chromeMock,
      URL,
      Date,
      Math,
      console,
      setTimeout,
      clearTimeout,
      fetch: async (url) => {
        if (String(url).includes("/api/auth/refresh")) {
          return new Promise((r) => {
            resolveRefreshFetch = r;
          });
        }
        return mockResp(401, { detail: "expired" });
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });
    return { api: sandbox.JustSaveItApi, resolveRefresh: () => resolveRefreshFetch };
  })();
  await sandboxRefresh.api.saveAuthSession({
    access_token: "tok-a",
    refresh_token: "ref-a",
    user: { id: "user-a" },
  });
  const reqPromise = sandboxRefresh.api.apiRequest("/api/items").catch((e) => e);
  await new Promise((r) => setTimeout(r, 20));
  await sandboxRefresh.api.saveAuthSession({
    access_token: "tok-b",
    refresh_token: "ref-b",
    user: { id: "user-b" },
  });
  sandboxRefresh.resolveRefresh()(
    mockResp(200, { access_token: "stale-tok-a2", refresh_token: "stale-ref-a2", user: { id: "user-a" } })
  );
  await reqPromise;
  const activeSession = await sandboxRefresh.api.getSessionState();
  assert.equal(activeSession.accessToken, "tok-b");
  assert.equal(activeSession.user.id, "user-b");
});

test("Frontend C-1 & H-3: dispatchRequest/mutations abort across account switch & signOut/deleteAccount stop realtime sync", async () => {
  const { api: ls, map: lsMap } = createMemoryLocalStorage();
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  const origWs = globalThis.WebSocket;
  globalThis.localStorage = ls;

  const sockets = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.closed = false;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {}
    close() {
      this.closed = true;
    }
    emit(type, payload = {}) {
      for (const fn of this.listeners.get(type) || []) fn(payload);
    }
  }
  globalThis.WebSocket = FakeWs;

  try {
    store.resetSeed();
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-a",
      refreshToken: "ref-a",
      user: { id: "user-a", email: "a@example.com", name: "User A" },
    });
    store.state.data.folders = [{ id: "fa", name: "Folder A", baseExternalCount: 0 }];
    store.state.data.links = [{ id: "la", folderId: "fa", url: "https://a.com", title: "A Link", tags: [] }];
    saveWorkspaceCache("user-a");

    let resolveUserAPost;
    let replayedWithB = false;
    let refreshCalledWithB = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const auth = init?.headers?.Authorization || init?.headers?.authorization || "";
      if (u.includes("/api/auth/refresh")) {
        if (String(init.body || "").includes("ref-b")) refreshCalledWithB = true;
        return mockResp(200, { access_token: "bad-replay", refresh_token: "bad-ref" });
      }
      if (u.endsWith("/api/items") && init.method === "POST") {
        if (auth.includes("jwt-b")) {
          replayedWithB = true;
          return mockResp(201, { id: "leaked", url: "https://a.com/new" });
        }
        return new Promise((r) => {
          resolveUserAPost = r;
        });
      }
      return mockResp(200, {});
    };

    const pCreate = apiClient.createLink({ url: "https://a.com/new", title: "From A", folderId: "fa", skipPreview: true });
    // User switches to User B before User A's POST responds with 401
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-b",
      refreshToken: "ref-b",
      user: { id: "user-b", email: "b@example.com", name: "User B" },
    });
    store.state.data.folders = [{ id: "fb", name: "Folder B", baseExternalCount: 0 }];
    store.state.data.links = [{ id: "lb", folderId: "fb", url: "https://b.com", title: "B Only", tags: [] }];
    saveWorkspaceCache("user-b");

    resolveUserAPost(mockResp(401, { detail: "A expired" }));
    const created = await pCreate;
    assert.equal(created, null);
    assert.equal(refreshCalledWithB, false, "Must not use User B refresh token for User A 401");
    assert.equal(replayedWithB, false, "Must not replay User A POST under User B bearer token");
    assert.equal(store.state.data.user.id, "user-b", "User B must remain logged in");
    assert.deepEqual(
      store.state.data.links.map((l) => l.id),
      ["lb"],
      "User B links must not be polluted by settling User A mutation"
    );
    const cacheB = JSON.parse(lsMap.get("sharely_workspace_cache_v1:user-b"));
    assert.deepEqual(
      cacheB.links.map((l) => l.id),
      ["lb"],
      "User B cache must not be poisoned"
    );

    // H-3: signOut stops realtime socket & applyRealtimeDelta refuses unauthenticated state
    let syncHits = 0;
    startRealtimeSync({
      getSupabaseConfig: () => ({ url: "https://demo.supabase.co", anonKey: "anon" }),
      getAccessToken: () => store.state.api.bearerToken,
      isAuthenticated: () => Boolean(store.state.data.user?.isAuthenticated),
      onSync: async () => {
        syncHits += 1;
      },
    });
    assert.equal(sockets.length, 1);
    globalThis.fetch = async () => mockResp(200, { logged_out: true });
    await apiClient.signOut();
    assert.equal(sockets[0].closed, true, "apiClient.signOut() must close active WebSocket");

    sockets[0].emit("message", {
      data: JSON.stringify({ event: "DELETE", table: "items", old_record: { id: "lb" } }),
    });
    const unauthDelta = await apiClient.applyRealtimeDelta({
      deltas: [{ table: "items", type: "DELETE", oldRecord: { id: "lb" } }],
      forceFullSync: false,
    });
    assert.equal(unauthDelta.ok, false);
    assert.equal(unauthDelta.stale, true);
    assert.equal(syncHits, 0);

    // H-3: deleteAccount also stops active WebSocket
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-c",
      refreshToken: "ref-c",
      user: { id: "user-c", email: "c@example.com", name: "User C" },
    });
    startRealtimeSync({
      getSupabaseConfig: () => ({ url: "https://demo.supabase.co", anonKey: "anon" }),
      getAccessToken: () => store.state.api.bearerToken,
      isAuthenticated: () => Boolean(store.state.data.user?.isAuthenticated),
      onSync: async () => {},
    });
    assert.equal(sockets.length, 2);
    globalThis.fetch = async () => mockResp(200, { deleted: true });
    await apiClient.deleteAccount();
    assert.equal(sockets[1].closed, true, "apiClient.deleteAccount() must close active WebSocket");
  } finally {
    stopRealtimeSync();
    globalThis.WebSocket = origWs;
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("Extension Cycle 4 [F-2/F-3]: guest 401 does not wipe subsequent sign-in & post-getStorage clearAuthSession aborts flush", async () => {
  // Part A (Finding 2): signed-out 401 settling after sign-in preserves new session
  const guestSandbox = (() => {
    const storeMap = new Map();
    const chromeMock = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
            for (const k of keyList) if (storeMap.has(k)) out[k] = storeMap.get(k);
            cb(out);
          },
          set(values, cb) {
            for (const [k, v] of Object.entries(values || {})) storeMap.set(k, structuredClone(v));
            if (cb) cb();
          },
          remove(keys, cb) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) storeMap.delete(k);
            if (cb) cb();
          },
        },
      },
    };
    let resolveGuestReq;
    const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
    const sandbox = {
      globalThis: {},
      chrome: chromeMock,
      URL,
      Date,
      Math,
      console,
      setTimeout,
      clearTimeout,
      fetch: async () =>
        new Promise((r) => {
          resolveGuestReq = r;
        }),
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });
    return { api: sandbox.JustSaveItApi, resolveGuestReq: () => resolveGuestReq };
  })();

  const guestPending = guestSandbox.api.apiRequest("/api/items", {
    method: "POST",
    body: { url: "https://guest.test/early" },
  }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 15));
  await guestSandbox.api.saveAuthSession({
    access_token: "tok-signed-in",
    refresh_token: "ref-signed-in",
    user: { id: "user-signed-in", email: "in@example.com" },
  });
  guestSandbox.resolveGuestReq()(mockResp(401, { detail: "Not authenticated" }));
  await guestPending;
  const preserved = await guestSandbox.api.getSessionState();
  assert.equal(preserved.accessToken, "tok-signed-in", "Guest 401 must not clear subsequent sign-in session");
  assert.equal(preserved.user?.id, "user-signed-in");

  // Part B (Finding 3): clearAuthSession during post-flush getStorage([OFFLINE_QUEUE]) aborts setStorage
  let pauseNextQueueGet = false;
  let pausedGetCallback = null;
  let pausedSnapshot = null;
  let queueWritesAfterClear = 0;
  let trackWritesAfterClear = false;
  let notifyGetPaused = null;
  const getPausedPromise = new Promise((r) => {
    notifyGetPaused = r;
  });

  const storeMapB = new Map();
  const chromeMockB = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          for (const k of keyList) if (storeMapB.has(k)) out[k] = structuredClone(storeMapB.get(k));
          if (pauseNextQueueGet && keyList.length === 1 && keyList[0] === "jsi_offline_queue") {
            pauseNextQueueGet = false;
            pausedGetCallback = cb;
            pausedSnapshot = out;
            notifyGetPaused();
            return;
          }
          cb(out);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values || {})) {
            if (trackWritesAfterClear && k === "jsi_offline_queue") queueWritesAfterClear += 1;
            storeMapB.set(k, structuredClone(v));
          }
          if (cb) cb();
        },
        remove(keys, cb) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) storeMapB.delete(k);
          if (cb) cb();
        },
      },
    },
  };
  const apiCodeB = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
  const sandboxB = {
    globalThis: {},
    chrome: chromeMockB,
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => mockResp(200, {}),
  };
  sandboxB.globalThis = sandboxB;
  sandboxB.self = sandboxB;
  vm.runInNewContext(apiCodeB, sandboxB, { filename: "extension/api.js" });

  await sandboxB.JustSaveItApi.saveAuthSession({
    access_token: "tok-ext-f3",
    refresh_token: "ref-ext-f3",
    user: { id: "user-ext-f3", email: "f3@example.com" },
  });
  await sandboxB.JustSaveItApi.enqueueOfflineSave({ url: "https://f3.test/one", title: "F3 One" });

  const flushPromise = sandboxB.JustSaveItApi.flushOfflineQueue(async () => {
    pauseNextQueueGet = true;
    return { ok: true };
  });
  await getPausedPromise;
  await sandboxB.JustSaveItApi.clearAuthSession();
  trackWritesAfterClear = true;
  pausedGetCallback(pausedSnapshot);
  await flushPromise;

  assert.equal(queueWritesAfterClear, 0, "Cleared queue must not be written back after post-getStorage logout");
  assert.equal(storeMapB.has(sandboxB.JustSaveItApi.STORAGE_KEYS.OFFLINE_QUEUE), false);
});

test("Frontend Cycle 4 [F-4]: summarizeLink, saveReminder, deleteReminder, and acceptInvite abort on account switch", async () => {
  const { api: ls, map: lsMap } = createMemoryLocalStorage();
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  globalThis.localStorage = ls;

  const seedA = () => {
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-a",
      refreshToken: "ref-a",
      user: { id: "user-a", email: "a@example.com", name: "User A" },
    });
    store.state.data.folders = [{ id: "fa", name: "Folder A", baseExternalCount: 0, inviteSlug: "inv-slug-a" }];
    store.state.data.links = [
      { id: "la", folderId: "fa", url: "https://a.com", title: "Link A", platform: "web", tags: [], aiSummary: null },
    ];
    store.state.data.freeQuotaRemaining = 5;
    saveWorkspaceCache("user-a");
  };

  const switchToB = () => {
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-b",
      refreshToken: "ref-b",
      user: { id: "user-b", email: "b@example.com", name: "User B" },
    });
    store.state.data.folders = [{ id: "fb", name: "Folder B", baseExternalCount: 0 }];
    store.state.data.links = [
      { id: "lb", folderId: "fb", url: "https://b.com", title: "Link B", platform: "web", tags: [] },
    ];
    store.state.data.freeQuotaRemaining = 9;
    store.rebuildNotificationsFromWorkspace();
    saveWorkspaceCache("user-b");
  };

  try {
    store.resetSeed();

    // 1) summarizeLink
    seedA();
    let resolveSum;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/ai/summarize")) {
        return new Promise((r) => {
          resolveSum = r;
        });
      }
      return mockResp(200, {});
    };
    const pSum = apiClient.summarizeLink("la");
    await new Promise((r) => setTimeout(r, 10));
    switchToB();
    store.state.api.isSummarizing = true; // Simulate User B starting their own summarize action
    resolveSum(mockResp(200, { summary_th: "User A AI Summary", suggested_tags: ["#leak"], ai_quota: { remaining: 1 } }));
    const sumOut = await pSum;
    assert.equal(sumOut.aborted, true);
    assert.equal(store.state.api.isSummarizing, true, "User A settle must not clear User B isSummarizing flag");
    assert.equal(store.state.data.freeQuotaRemaining, 9, "User A AI quota must not overwrite User B");

    // 2) saveReminder & deleteReminder
    seedA();
    let resolveSaveRem;
    let resolveDelRem;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/api/reminders/") && init.method === "PUT") {
        return new Promise((r) => {
          resolveSaveRem = r;
        });
      }
      if (u.includes("/api/reminders/") && init.method === "DELETE") {
        return new Promise((r) => {
          resolveDelRem = r;
        });
      }
      return mockResp(200, {});
    };

    const pSaveRem = apiClient.saveReminder("la", { reminderDate: "2026-12-01", reminderTime: "09:00" });
    await new Promise((r) => setTimeout(r, 10));
    switchToB();
    const cacheBBefore = lsMap.get("sharely_workspace_cache_v1:user-b");
    resolveSaveRem(mockResp(200, { item_id: "la", status: "pending" }));
    const saveRemOut = await pSaveRem;
    assert.equal(saveRemOut.aborted, true);
    assert.equal(lsMap.get("sharely_workspace_cache_v1:user-b"), cacheBBefore);

    seedA();
    const pDelRem = apiClient.deleteReminder("la");
    await new Promise((r) => setTimeout(r, 10));
    switchToB();
    const cacheBDelBefore = lsMap.get("sharely_workspace_cache_v1:user-b");
    resolveDelRem(mockResp(500, { detail: "err" }));
    const delRemOut = await pDelRem;
    assert.equal(delRemOut.aborted, true);
    assert.equal(lsMap.get("sharely_workspace_cache_v1:user-b"), cacheBDelBefore);

    // 3) acceptInvite aborts across account switch without hydrating User B
    seedA();
    let resolveInvite;
    let workspaceHits = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/invites/") && u.endsWith("/accept")) {
        return new Promise((r) => {
          resolveInvite = r;
        });
      }
      if (u.includes("/api/workspace")) workspaceHits += 1;
      return mockResp(200, {});
    };
    const pInv = apiClient.acceptInvite("inv-slug-a");
    await new Promise((r) => setTimeout(r, 10));
    switchToB();
    resolveInvite(mockResp(200, { folder_id: "fa", joined_folder: "fa" }));
    const invOut = await pInv;
    assert.equal(invOut, null);
    assert.equal(workspaceHits, 0, "Stale User A acceptInvite must not trigger User B workspace hydrate");
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("Cycle 5 [H-1, M-1, M-2]: post-refresh 401 clears extension session, store resets isSummarizing, and main.js guards aborted/stale calls", async () => {
  // 1. HIGH-1: extension apiRequest retry 401 after successful refresh clears session via attemptedToken
  const storeMap = new Map();
  const chromeMock = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          for (const k of keyList) if (storeMap.has(k)) out[k] = structuredClone(storeMap.get(k));
          cb(out);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values || {})) storeMap.set(k, structuredClone(v));
          if (cb) cb();
        },
        remove(keys, cb) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) storeMap.delete(k);
          if (cb) cb();
        },
      },
    },
  };
  const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
  const sandbox = {
    globalThis: {},
    chrome: chromeMock,
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      if (String(url).includes("/api/auth/refresh")) {
        return mockResp(200, {
          access_token: "tok-refreshed-revoked",
          refresh_token: "ref-new",
          user: { id: "u-revoked", email: "revoked@example.com" },
        });
      }
      return mockResp(401, { detail: "User deleted or revoked" });
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });

  await sandbox.JustSaveItApi.saveAuthSession({
    access_token: "tok-initial-expired",
    refresh_token: "ref-initial",
    user: { id: "u-revoked", email: "revoked@example.com" },
  });
  await sandbox.JustSaveItApi.setWorkspaceCache({
    user: { id: "u-revoked" },
    folders: [],
    tags: [],
    recentItems: [{ id: "stale-item", url: "https://stale.test" }],
  });

  const postRefreshErr = await sandbox.JustSaveItApi.apiRequest("/api/items").catch((e) => e);
  assert.equal(postRefreshErr?.status, 401);
  assert.match(String(postRefreshErr?.message || postRefreshErr), /User deleted|revoked|401/);
  const afterPostRefresh = await sandbox.JustSaveItApi.getSessionState();
  assert.equal(afterPostRefresh.accessToken, "", "Post-refresh 401 must clear session");
  assert.equal(afterPostRefresh.user, null, "Post-refresh 401 must clear stored user");
  assert.equal(storeMap.has(sandbox.JustSaveItApi.STORAGE_KEYS.WORKSPACE_CACHE), false);

  // 2. MEDIUM-1: store resets isSummarizing & AI sheet/modal flags on account switch and clearSession
  const origLocalStorage = globalThis.localStorage;
  const { api: ls } = createMemoryLocalStorage();
  globalThis.localStorage = ls;
  try {
    store.resetSeed();
    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-m1-a",
      refreshToken: "ref-m1-a",
      user: { id: "user-m1-a", email: "a@m1.test", name: "M1 A" },
    });
    store.state.api.isSummarizing = true;
    store.state.ui.aiConfirmModalOpen = true;
    store.state.ui.aiSummaryStatus = "loading";
    const reqIdBeforeSwitch = store.state.ui.aiRequestId;

    store.applyAuthenticatedSession({
      mode: "live",
      accessToken: "jwt-m1-b",
      refreshToken: "ref-m1-b",
      user: { id: "user-m1-b", email: "b@m1.test", name: "M1 B" },
    });
    assert.equal(store.state.api.isSummarizing, false, "Account switch must clear stuck isSummarizing");
    assert.equal(store.state.ui.aiConfirmModalOpen, false);
    assert.equal(store.state.ui.aiSummaryStatus, "idle");
    assert.ok(store.state.ui.aiRequestId > reqIdBeforeSwitch);

    store.state.api.isSummarizing = true;
    store.state.ui.aiSummaryStatus = "loading";
    store.clearSession({ clearWorkspace: true });
    assert.equal(store.state.api.isSummarizing, false, "clearSession must reset isSummarizing");
    assert.equal(store.state.ui.aiSummaryStatus, "idle");
  } finally {
    globalThis.localStorage = origLocalStorage;
  }

  // 3. MEDIUM-2: main.js handlers bail out cleanly on aborted responses & auth-generation switch
  const mainCode = fs.readFileSync(path.join(repoRoot, "frontend", "src", "main.js"), "utf8");
  assert.match(mainCode, /confirm-ai-summarize[\s\S]{0,400}if \(!res \|\| res\.aborted/);
  assert.match(mainCode, /d\.runAiSummarize[\s\S]{0,200}if \(!res \|\| res\.aborted\) return;/);
  assert.match(mainCode, /d\.clearReminder[\s\S]{0,200}if \(!res \|\| res\.aborted\) return;/);
  assert.match(mainCode, /d\.saveReminder[\s\S]{0,500}if \(!res \|\| res\.aborted\) return;/);
  assert.match(mainCode, /const joined = await apiClient\.acceptInvite\(tokenOrFolder\);[\s\S]{0,200}startAuthGen/);
});

test("Cycle 6 [H-1, L-3]: extension setWorkspaceCache rejects signed-out writes, apiRequest aborts 200 across switch, clearAuthSession post-bumps gen, popup guards bg sync", async () => {
  const storeMap = new Map();
  let pauseNextGet = false;
  let resumePausedGet = null;
  let notifyPausedGet = null;
  const pausedGetPromise = new Promise((r) => {
    notifyPausedGet = r;
  });

  const chromeMock = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          for (const k of keyList) if (storeMap.has(k)) out[k] = structuredClone(storeMap.get(k));
          if (pauseNextGet && keyList.includes("jsi_access_token") && keyList.includes("jsi_refresh_token")) {
            pauseNextGet = false;
            resumePausedGet = () => cb(out);
            notifyPausedGet();
            return;
          }
          cb(out);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values || {})) storeMap.set(k, structuredClone(v));
          if (cb) cb();
        },
        remove(keys, cb) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) storeMap.delete(k);
          if (cb) cb();
        },
      },
    },
  };

  let resolveSlowFetch;
  const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
  const sandbox = {
    globalThis: {},
    chrome: chromeMock,
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () =>
      new Promise((r) => {
        resolveSlowFetch = r;
      }),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(apiCode, sandbox, { filename: "extension/api.js" });

  // 1. Signed-out setWorkspaceCache with explicit user.id must be rejected
  await sandbox.JustSaveItApi.clearAuthSession();
  await sandbox.JustSaveItApi.setWorkspaceCache({
    user: { id: "user-leaked" },
    folders: [],
    tags: [],
    recentItems: [{ id: "bad", url: "https://bad.test" }],
  });
  assert.equal(storeMap.has(sandbox.JustSaveItApi.STORAGE_KEYS.WORKSPACE_CACHE), false);

  // 2. apiRequest resolves HTTP 200 after logout/account switch -> aborts instead of returning stale User A payload
  await sandbox.JustSaveItApi.saveAuthSession({
    access_token: "tok-a-200",
    refresh_token: "ref-a-200",
    user: { id: "user-a-200", email: "a@example.com" },
  });
  const pending200 = sandbox.JustSaveItApi.apiRequest("/api/workspace").catch((e) => e);
  await new Promise((r) => setTimeout(r, 15));
  await sandbox.JustSaveItApi.saveAuthSession({
    access_token: "tok-b-200",
    refresh_token: "ref-b-200",
    user: { id: "user-b-200", email: "b@example.com" },
  });
  resolveSlowFetch(mockResp(200, { items: [{ id: "stale-a" }] }));
  const staleRes = await pending200;
  assert.equal(staleRes?.aborted, true, "Stale 200 payload across account switch must abort");

  // 3. Concurrent setWorkspaceCache pausing during clearAuthSession cannot resurrect cleared cache
  const genBeforeClear = sandbox.JustSaveItApi.getSessionGeneration();
  pauseNextGet = true;
  const pendingCacheWrite = sandbox.JustSaveItApi.setWorkspaceCache({
    user: { id: "user-b-200" },
    folders: [],
    tags: [],
    recentItems: [{ id: "resurrected", url: "https://res.test" }],
  });
  await pausedGetPromise;
  await sandbox.JustSaveItApi.clearAuthSession();
  assert.ok(sandbox.JustSaveItApi.getSessionGeneration() >= genBeforeClear + 2, "clearAuthSession must bump gen before and after removal");
  resumePausedGet();
  await pendingCacheWrite;
  assert.equal(storeMap.has(sandbox.JustSaveItApi.STORAGE_KEYS.WORKSPACE_CACHE), false);

  // 4. extension/popup.js async fetchers guard against session generation change & aborted flag
  const popupCode = fs.readFileSync(path.join(repoRoot, "extension", "popup.js"), "utf8");
  assert.match(popupCode, /async function refreshRecentList[\s\S]{0,450}getSessionGeneration\(\) !== startGen/);
  assert.match(popupCode, /async function syncWorkspaceBackground[\s\S]{0,550}isSessionStale\(startGen\)/);
  assert.match(popupCode, /isSessionStale[\s\S]{0,120}err\.aborted/);
});

test("Cycle 7 [C-1, H-1, M-1, M-2, M-3, L-2]: real VM runtime tests for extension cross-context abort, background & popup anti-poisoning, 401 handling, and web-connect rollback safety", async () => {
  const storeMap = new Map();
  const sharedChromeStorage = {
    local: {
      get(keys, cb) {
        const out = {};
        const keyList = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
        for (const k of keyList) if (storeMap.has(k)) out[k] = structuredClone(storeMap.get(k));
        cb(out);
      },
      set(values, cb) {
        for (const [k, v] of Object.entries(values || {})) storeMap.set(k, structuredClone(v));
        if (cb) cb();
      },
      remove(keys, cb) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) storeMap.delete(k);
        if (cb) cb();
      },
    },
  };

  const apiCode = fs.readFileSync(path.join(repoRoot, "extension", "api.js"), "utf8");
  const bgCode = fs.readFileSync(path.join(repoRoot, "extension", "background.js"), "utf8");
  const popupCode = fs.readFileSync(path.join(repoRoot, "extension", "popup.js"), "utf8");

  const mkResp = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    headers: { get: () => "application/json" },
    text: async () => (body == null ? "" : JSON.stringify(body)),
  });

  // --- 1) Two separate JS contexts sharing chrome.storage.local (popup vs background) + loginWithAccessToken rollback ---
  let nextSlowAction = null;
  const makeApiSandbox = (fetchFn) => {
    const sb = {
      globalThis: null,
      chrome: { runtime: { lastError: null }, storage: sharedChromeStorage },
      URL,
      Date,
      Math,
      console,
      setTimeout,
      clearTimeout,
      btoa,
      atob,
      fetch: fetchFn,
    };
    sb.globalThis = sb;
    sb.self = sb;
    vm.runInNewContext(apiCode, sb, { filename: "extension/api.js" });
    return sb;
  };

  const popupApiSb = makeApiSandbox(async () => new Promise((resolve, reject) => { nextSlowAction = { resolve, reject }; }));
  const bgApiSb = makeApiSandbox(async (url) => {
    if (String(url).endsWith("/api/auth/me")) {
      if (storeMap.get("test_token_ok") === true) {
        return mkResp(200, { id: "user-valid-7", email: "valid@test.com" });
      }
      return mkResp(401, { detail: "bad token" });
    }
    return mkResp(200, {});
  });

  await bgApiSb.JustSaveItApi.saveAuthSession({
    access_token: "tok-a7",
    refresh_token: "",
    user: { id: "user-a7", email: "a7@test.com" },
  });

  // Network drop in popup context after background context swaps to User B -> MUST abort with err.aborted = true
  const slowNetDrop = popupApiSb.JustSaveItApi.apiRequest("/api/items", {
    method: "POST",
    body: { url: "https://a7.test/1" },
  }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 15));
  await bgApiSb.JustSaveItApi.saveAuthSession({
    access_token: "tok-b7",
    refresh_token: "",
    user: { id: "user-b7", email: "b7@test.com" },
  });
  nextSlowAction.reject(new TypeError("Failed to fetch"));
  const droppedRes = await slowNetDrop;
  assert.equal(droppedRes?.aborted, true, "Cross-context network failure must convert to aborted stale error");
  assert.equal((await bgApiSb.JustSaveItApi.getSessionState()).user.id, "user-b7");

  // loginWithAccessToken with failed /api/auth/me must NOT overwrite backendUrl
  await bgApiSb.JustSaveItApi.setBackendUrl("https://just-save-it-api.onrender.com");
  storeMap.set("test_token_ok", false);
  await assert.rejects(() => bgApiSb.JustSaveItApi.loginWithAccessToken("bad-tok", "", "http://127.0.0.1:8000"));
  assert.equal(
    (await bgApiSb.JustSaveItApi.getSessionState()).backendUrl,
    "https://just-save-it-api.onrender.com",
    "Failed loginWithAccessToken must not mutate stored backendUrl",
  );
  storeMap.set("test_token_ok", true);
  await bgApiSb.JustSaveItApi.loginWithAccessToken("good-tok", "ref-ok", "http://127.0.0.1:8000");
  assert.equal((await bgApiSb.JustSaveItApi.getSessionState()).backendUrl, "http://127.0.0.1:8000");

  // --- 2) Real background.js quickSaveUrl runtime test (aborted/switched save must not enqueue offline) ---
  storeMap.clear();
  const badges = [];
  let onCommandHandler = null;
  let resolveBgFetch = null;
  let rejectBgFetch = null;
  const bgRuntimeSb = {
    globalThis: null,
    chrome: {
      runtime: { lastError: null, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
      storage: sharedChromeStorage,
      action: {
        setBadgeBackgroundColor() {},
        setBadgeText({ text }) { badges.push(text); },
        async openPopup() {},
      },
      alarms: { create() {}, get(_n, cb) { cb(null); }, onAlarm: { addListener() {} } },
      contextMenus: { removeAll(cb) { if (cb) cb(); }, create() {}, onClicked: { addListener() {} } },
      commands: { onCommand: { addListener(fn) { onCommandHandler = fn; } } },
      notifications: { onClicked: { addListener() {} }, clear() {} },
      tabs: { async query() { return [{ id: 11, url: "https://bg-a.example/item", title: "A Item" }]; } },
    },
    importScripts: () => {},
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    fetch: async () => new Promise((resolve, reject) => { resolveBgFetch = resolve; rejectBgFetch = reject; }),
  };
  bgRuntimeSb.globalThis = bgRuntimeSb;
  bgRuntimeSb.self = bgRuntimeSb;
  vm.runInNewContext(apiCode, bgRuntimeSb, { filename: "extension/api.js" });
  vm.runInNewContext(bgCode, bgRuntimeSb, { filename: "extension/background.js" });

  await bgRuntimeSb.JustSaveItApi.saveAuthSession({
    access_token: "tok-bg-a",
    refresh_token: "",
    user: { id: "user-bg-a", email: "bga@test.com" },
  });
  const bgSavePromise = onCommandHandler("quick-save-tab");
  await new Promise((r) => setTimeout(r, 15));
  await bgRuntimeSb.JustSaveItApi.saveAuthSession({
    access_token: "tok-bg-b",
    refresh_token: "",
    user: { id: "user-bg-b", email: "bgb@test.com" },
  });
  rejectBgFetch(new TypeError("Connection reset"));
  await bgSavePromise;
  assert.equal((await bgRuntimeSb.JustSaveItApi.getOfflineQueue()).length, 0, "Aborted background save must not enqueue under User B");
  assert.equal(badges.includes("QUE"), false, "Aborted background save must not flash QUE badge");

  // --- 3) Real popup.js DOM runtime tests (handleSaveItem, syncWorkspaceBackground 401, handleCreateFolder, flushQueueBtn) ---
  const createPopupHost = (fetchHandler) => {
    const elMap = new Map();
    const docListeners = new Map();
    const makeEl = (id = "") => {
      const classes = new Set();
      const listeners = new Map();
      const attrs = new Map();
      const el = {
        id,
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        disabled: false,
        checked: false,
        src: "",
        title: "",
        dataset: {},
        style: {},
        children: [],
        classList: {
          add: (...cs) => cs.forEach((c) => classes.add(c)),
          remove: (...cs) => cs.forEach((c) => classes.delete(c)),
          toggle: (c, force) => {
            if (force === true) { classes.add(c); return true; }
            if (force === false) { classes.delete(c); return false; }
            if (classes.has(c)) { classes.delete(c); return false; }
            classes.add(c); return true;
          },
          contains: (c) => classes.has(c),
        },
        addEventListener: (evt, fn) => {
          if (!listeners.has(evt)) listeners.set(evt, []);
          listeners.get(evt).push(fn);
        },
        dispatch: async (type) => {
          const ev = { type, key: "Enter", preventDefault() {} };
          for (const fn of listeners.get(type) || []) await fn(ev);
        },
        appendChild: (c) => { el.children.push(c); return c; },
        replaceChildren: (...nodes) => { el.children = nodes; },
        focus() {},
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        removeAttribute: (k) => attrs.delete(k),
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
      };
      return el;
    };
    const getEl = (id) => {
      if (!elMap.has(id)) elMap.set(id, makeEl(id));
      return elMap.get(id);
    };
    const sb = {
      globalThis: null,
      window: null,
      chrome: {
        runtime: { lastError: null },
        storage: sharedChromeStorage,
        tabs: { async query() { return [{ id: 1, url: "https://popup-tab.test/article", title: "Popup Article" }]; }, async create() {} },
      },
      document: {
        getElementById: getEl,
        createElement: (tag) => makeEl(tag),
        createDocumentFragment: () => makeEl("#frag"),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: (evt, fn) => {
          if (!docListeners.has(evt)) docListeners.set(evt, []);
          docListeners.get(evt).push(fn);
        },
      },
      Intl,
      URL,
      Date,
      Math,
      console,
      setTimeout,
      clearTimeout,
      btoa,
      atob,
      navigator: {},
      fetch: fetchHandler,
    };
    sb.globalThis = sb;
    sb.self = sb;
    sb.window = sb;
    vm.runInNewContext(apiCode, sb, { filename: "extension/api.js" });
    vm.runInNewContext(popupCode, sb, { filename: "extension/popup.js" });
    return {
      sb,
      getEl,
      async init() {
        for (const fn of docListeners.get("DOMContentLoaded") || []) await fn();
      },
    };
  };

  // Case 3a: handleSaveItem slow POST fails after account switch -> zero offline queue pollution & no savedResultCard
  storeMap.clear();
  let popupSaveReject = null;
  const hostA = createPopupHost(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/health")) return mkResp(200, { status: "ok" });
    if (u.includes("/api/workspace")) return mkResp(200, { folders: [], tags: [], items: [], user: { id: "pop-a", email: "pa@t.com" } });
    if (u.endsWith("/api/preview")) return mkResp(200, { title: "Preview A", platform: "web" });
    if (u.endsWith("/api/items") && init?.method === "POST") {
      return new Promise((_res, rej) => { popupSaveReject = rej; });
    }
    return mkResp(200, {});
  });
  await hostA.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-pop-a",
    refresh_token: "",
    user: { id: "pop-a", email: "pa@t.com" },
  });
  await hostA.init();
  hostA.getEl("savedResultCard").classList.add("hidden");
  hostA.getEl("urlInput").value = "https://a.example/save-race";
  const saveTask = hostA.getEl("saveForm").dispatch("submit");
  await new Promise((r) => setTimeout(r, 15));
  await hostA.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-pop-b",
    refresh_token: "",
    user: { id: "pop-b", email: "pb@t.com" },
  });
  popupSaveReject(new TypeError("Offline during switch"));
  await saveTask;
  assert.equal((await hostA.sb.JustSaveItApi.getOfflineQueue()).length, 0, "handleSaveItem race must never queue into User B");
  assert.equal(hostA.getEl("savedResultCard").classList.contains("hidden"), true);

  // Case 3b: Genuine HTTP 401 on syncWorkspaceBackground -> shows authView + expired banner cleanly
  storeMap.clear();
  const host401 = createPopupHost(async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return mkResp(200, { status: "ok" });
    if (u.includes("/api/workspace")) return mkResp(401, { detail: "expired" });
    return mkResp(200, {});
  });
  await host401.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-exp",
    refresh_token: "",
    user: { id: "pop-exp", email: "exp@t.com" },
  });
  await host401.init();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host401.getEl("authView").classList.contains("hidden"), false, "Genuine 401 must transition to authView even after apiRequest clears session");
  assert.match(host401.getEl("feedbackBanner").textContent, /หมดอายุ/);

  // Case 3c: Cross-context User B login before A's /api/workspace 401 resolves -> must NOT wipe User B or show authView
  storeMap.clear();
  let resolveSlowWs = null;
  const hostCross401 = createPopupHost(async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return mkResp(200, { status: "ok" });
    if (u.includes("/api/workspace")) return new Promise((r) => { resolveSlowWs = r; });
    return mkResp(200, {});
  });
  await hostCross401.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-x-a",
    refresh_token: "",
    user: { id: "pop-x-a", email: "xa@t.com" },
  });
  await hostCross401.init();
  await new Promise((r) => setTimeout(r, 15));
  // External context replaces session in shared storeMap without touching hostCross401's local _sessionGeneration
  storeMap.set("jsi_access_token", "tok-x-b");
  storeMap.set("jsi_user", { id: "pop-x-b", email: "xb@t.com" });
  resolveSlowWs(mkResp(401, { detail: "old A expired" }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(storeMap.get("jsi_access_token"), "tok-x-b", "Cross-context User B token must stay intact after User A 401");
  assert.equal(hostCross401.getEl("authView").classList.contains("hidden"), true, "Popup must not boot User B out on User A stale 401");

  // Case 3d: handleCreateFolder + flushQueueBtn abort cleanly when session switches mid-flight
  storeMap.clear();
  let resolveFolderPost = null;
  const hostFld = createPopupHost(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/health")) return mkResp(200, { status: "ok" });
    if (u.includes("/api/workspace")) return mkResp(200, { folders: [], tags: [], items: [], user: { id: "fld-a", email: "fa@t.com" } });
    if (u.endsWith("/api/folders") && init?.method === "POST") return new Promise((r) => { resolveFolderPost = r; });
    return mkResp(200, {});
  });
  await hostFld.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-fa",
    refresh_token: "",
    user: { id: "fld-a", email: "fa@t.com" },
  });
  await hostFld.init();
  await new Promise((r) => setTimeout(r, 20));
  hostFld.getEl("newFolderName").value = "Stale Folder A";
  const createTask = hostFld.getEl("createFolderBtn").dispatch("click");
  await new Promise((r) => setTimeout(r, 15));
  await hostFld.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-fb",
    refresh_token: "",
    user: { id: "fld-b", email: "fb@t.com" },
  });
  resolveFolderPost(mkResp(201, { id: "fld-stale-a", name: "Stale Folder A", emoji: "📁" }));
  await createTask;
  const cacheAfterSwitch = await hostFld.sb.JustSaveItApi.getWorkspaceCache();
  assert.equal(cacheAfterSwitch.folders.length, 0, "Stale handleCreateFolder settling after switch must not write User A folder to cache");
  assert.equal(storeMap.has("jsi_workspace_cache"), false);

  // Case 3e: flushQueueBtn aborts cleanly when switched to User B mid-flush
  storeMap.clear();
  let resolveFlushPost = null;
  const hostFlush = createPopupHost(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/health")) return mkResp(200, { status: "ok" });
    if (u.includes("/api/workspace")) return mkResp(200, { folders: [], tags: [], items: [], user: { id: "fl-a", email: "fla@t.com" } });
    if (u.endsWith("/api/items") && init?.method === "POST") return new Promise((r) => { resolveFlushPost = r; });
    return mkResp(200, {});
  });
  await hostFlush.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-fl-a",
    refresh_token: "",
    user: { id: "fl-a", email: "fla@t.com" },
  });
  await hostFlush.sb.JustSaveItApi.enqueueOfflineSave({ url: "https://queued-a.test/1" }, "offline");
  await hostFlush.init();
  await new Promise((r) => setTimeout(r, 20));
  hostFlush.getEl("feedbackBanner").textContent = "";
  const flushTask = hostFlush.getEl("flushQueueBtn").dispatch("click");
  await new Promise((r) => setTimeout(r, 15));
  await hostFlush.sb.JustSaveItApi.saveAuthSession({
    access_token: "tok-fl-b",
    refresh_token: "",
    user: { id: "fl-b", email: "flb@t.com" },
  });
  resolveFlushPost(mkResp(201, { id: "fl-stale-item", url: "https://queued-a.test/1" }));
  await flushTask;
  assert.equal(hostFlush.getEl("feedbackBanner").textContent, "", "Stale flushQueueBtn completion after switch must not show User A flush banner");
});
