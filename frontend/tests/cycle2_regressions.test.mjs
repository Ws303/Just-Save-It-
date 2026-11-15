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
