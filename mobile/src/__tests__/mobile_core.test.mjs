import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { planIosLocalNotifications } from "../notifications.ts";
import {
  buildBoundedExportPayloadJson,
  classifyQueueFlushStatus,
  clearAuthDebugEvents,
  clearSession,
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  getAuthDebugEvents,
  getAuthGeneration,
  getMemoryCachedWorkspace,
  getThemePageBg,
  loadCachedWorkspace,
  loadOfflineQueue,
  recordAuthDebugEvent,
  removeCachedLinkItem,
  resolveSessionUserId,
  saveCachedWorkspace,
  saveSession,
  saveThemeMode,
  setOfflineQueue,
  subscribeThemeMode,
} from "../storage.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // fallback to default resolution
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  extractInviteTokenFromUrl,
  extractSharedUrlFromIntent,
  parseOAuthCallbackUrl,
} = await import("../shareIntent.ts");

const {
  apiFetch,
  buildPkceChallengePair,
  completeOAuthWithTokens,
  deleteLinkItem,
  exchangeOAuthCode,
  fetchWorkspace,
  prepareGoogleOAuthUrl,
  refreshSession,
  sha256Base64Url,
} = await import("../api.ts");

const {
  isPostClearSafeToNavigate,
  runGuardedBusyAction,
  shouldNavigateAfterLogout,
} = await import("../actionGuards.ts");

test("planIosLocalNotifications enforces <= 64 cap and ascending sort", () => {
  const baseNow = Date.parse("2026-11-15T12:00:00Z");
  const reminders = [];

  for (let i = 100; i >= 1; i -= 1) {
    reminders.push({
      id: `rem-${i}`,
      item_id: `item-${i}`,
      title: `Item ${i}`,
      url: `https://example.com/${i}`,
      enabled: true,
      schedule_type: "once",
      remind_at: new Date(baseNow + i * 60_000).toISOString(),
    });
  }

  // Disabled & past one-shot reminders should be excluded
  reminders.push({
    id: "rem-disabled",
    item_id: "item-disabled",
    title: "Disabled",
    enabled: false,
    schedule_type: "once",
    remind_at: new Date(baseNow + 30_000).toISOString(),
  });
  reminders.push({
    id: "rem-past",
    item_id: "item-past",
    title: "Past",
    enabled: true,
    schedule_type: "once",
    remind_at: new Date(baseNow - 60_000).toISOString(),
  });
  // Recurring past trigger rolls forward automatically
  reminders.push({
    id: "rem-daily",
    item_id: "item-daily",
    title: "Daily",
    enabled: true,
    schedule_type: "daily",
    remind_at: new Date(baseNow - 24 * 3600_000 + 15_000).toISOString(),
  });

  const planned = planIosLocalNotifications(reminders, baseNow, 64);
  assert.equal(planned.length, 64);
  assert.equal(planned[0].itemId, "item-daily");
  assert.equal(planned[1].itemId, "item-1");

  for (let idx = 1; idx < planned.length; idx += 1) {
    assert.ok(planned[idx].triggerAtMs >= planned[idx - 1].triggerAtMs);
  }
});

test("extractSharedUrlFromIntent extracts URLs from Android ACTION_SEND text and deep links", () => {
  const androidText = extractSharedUrlFromIntent(
    "ดูคลิปนี้เลย https://vt.tiktok.com/ZS12345/ สนุกมาก",
  );
  assert.ok(androidText);
  assert.equal(androidText.url, "https://vt.tiktok.com/ZS12345/");
  assert.equal(androidText.title, "ดูคลิปนี้เลย สนุกมาก");

  const deepLink = extractSharedUrlFromIntent(
    "sharely://share?url=https%3A%2F%2Fexample.com%2Fguide&title=Bangkok+Guide",
  );
  assert.ok(deepLink);
  assert.equal(deepLink.url, "https://example.com/guide");
  assert.equal(deepLink.title, "Bangkok Guide");

  const empty = extractSharedUrlFromIntent("ข้อความธรรมดาไม่มีลิงก์");
  assert.equal(empty, null);

  assert.equal(extractInviteTokenFromUrl("sharely://invite/tok_abc123"), "tok_abc123");
  assert.equal(extractInviteTokenFromUrl("https://just-save-it-web.onrender.com/invite/f-9988"), "f-9988");
});

test("offline queue enqueue deduplicates and recovers failed items on flush", async () => {
  await setOfflineQueue([]);
  await enqueueOfflineItem({ url: "https://example.com/1", title: "One" });
  await enqueueOfflineItem({ url: "https://example.com/2", title: "Two" });
  await enqueueOfflineItem({ url: "https://example.com/1", title: "One Updated" });

  let queued = await loadOfflineQueue();
  assert.equal(queued.length, 2);

  const res = await flushOfflineQueueWithSender(async (item) => item.url.endsWith("/2"));
  assert.equal(res.flushed, 1);
  assert.equal(res.remaining, 1);

  queued = await loadOfflineQueue();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].url, "https://example.com/1");
});

test("offline queue drops permanent 4xx poison-pill entries while retaining retry items", async () => {
  await setOfflineQueue([]);
  await enqueueOfflineItem({ url: "https://example.com/bad-422", title: "Bad Payload" });
  await enqueueOfflineItem({ url: "https://example.com/transient-503", title: "Transient" });
  await enqueueOfflineItem({ url: "https://example.com/good-201", title: "Good" });

  const res = await flushOfflineQueueWithSender(async (item) => {
    if (item.url.includes("bad-422")) return "drop";
    if (item.url.includes("good-201")) return "ok";
    return "retry";
  });

  assert.equal(res.flushed, 1);
  assert.equal(res.dropped, 1);
  assert.equal(res.remaining, 1);

  const remaining = await loadOfflineQueue();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].url, "https://example.com/transient-503");

  assert.equal(classifyQueueFlushStatus(400), "drop");
  assert.equal(classifyQueueFlushStatus(403), "drop");
  assert.equal(classifyQueueFlushStatus(404), "drop");
  assert.equal(classifyQueueFlushStatus(422), "drop");
  assert.equal(classifyQueueFlushStatus(503), "retry");
  assert.equal(classifyQueueFlushStatus(201), "ok");
});

test("L-RES-2 / L-RES-3 / L-RES-1: theme subscription, valid bounded PDPA JSON, and expo-router query-string runtime requirement", async () => {
  assert.equal(getThemePageBg("cream"), "#F6F3EC");
  assert.equal(getThemePageBg("white"), "#FFFFFF");
  assert.equal(getThemePageBg("dark"), "#1C1917");

  const seenModes = [];
  const unsub = subscribeThemeMode((mode) => seenModes.push(mode));
  try {
    await saveThemeMode("dark");
    await saveThemeMode("white");
  } finally {
    unsub();
  }
  assert.deepEqual(seenModes, ["dark", "white"]);

  // Fewer than 10 huge items exceeding maxChars must STILL produce valid parseable JSON <= maxChars
  const hugeItems = Array.from({ length: 5 }, (_, idx) => ({
    id: `huge-${idx}`,
    url: `https://example.com/${idx}`,
    note: "x".repeat(400),
  }));
  const bounded = buildBoundedExportPayloadJson({ user: { id: "u1" }, items: hugeItems }, 900);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.jsonString.length <= 900, `Expected <= 900 chars, got ${bounded.jsonString.length}`);
  assert.ok(bounded.exportedItems < 5 && bounded.exportedItems >= 1, `Unexpected exported count: ${bounded.exportedItems}`);
  const parsed = JSON.parse(bounded.jsonString);
  assert.equal(parsed._truncated_for_android_share, true);
  assert.equal(parsed.items.length, bounded.exportedItems);

  // Document & assert L-RES-1: expo-router calls require("query-string") without listing it in its dependencies
  const testDir = dirname(fileURLToPath(import.meta.url));
  const routerPathFromState = resolve(testDir, "../../node_modules/expo-router/build/fork/getPathFromState.js");
  const routerPkgPath = resolve(testDir, "../../node_modules/expo-router/package.json");
  if (existsSync(routerPathFromState) && existsSync(routerPkgPath)) {
    const code = readFileSync(routerPathFromState, "utf8");
    const pkg = JSON.parse(readFileSync(routerPkgPath, "utf8"));
    assert.match(code, /require\(["']query-string["']\)/);
    assert.equal(Boolean(pkg.dependencies?.["query-string"]), false);
  }
});

test("parseOAuthCallbackUrl supports fragment tokens, PKCE code, and OAuth errors while extractSharedUrlFromIntent skips auth-callback", () => {
  const implicit = parseOAuthCallbackUrl(
    "sharely://auth-callback#access_token=acc-123&refresh_token=ref-456&token_type=bearer",
  );
  assert.equal(implicit.isAuthCallback, true);
  assert.equal(implicit.accessToken, "acc-123");
  assert.equal(implicit.refreshToken, "ref-456");
  assert.equal(implicit.code, "");
  assert.equal(extractSharedUrlFromIntent("sharely://auth-callback#access_token=acc-123"), null);

  const pkce = parseOAuthCallbackUrl("sharely://auth-callback?code=pkce_code_999");
  assert.equal(pkce.isAuthCallback, true);
  assert.equal(pkce.code, "pkce_code_999");
  assert.equal(pkce.accessToken, "");
  assert.equal(extractSharedUrlFromIntent("sharely://auth-callback?code=pkce_code_999"), null);

  const errCb = parseOAuthCallbackUrl(
    "justsaveit:///auth-callback?error=access_denied&error_description=User+cancelled+login",
  );
  assert.equal(errCb.isAuthCallback, true);
  assert.equal(errCb.error, "access_denied");
  assert.equal(errCb.errorDescription, "User cancelled login");

  const normalShare = parseOAuthCallbackUrl("sharely://share?url=https%3A%2F%2Fexample.com");
  assert.equal(normalShare.isAuthCallback, false);
});

test("sha256Base64Url matches RFC 7636 Appendix B test vector and PKCE flow exchanges verifier", async () => {
  assert.equal(
    sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );

  await clearSession();
  clearAuthDebugEvents();
  const oauthUrl = await prepareGoogleOAuthUrl("sharely://auth-callback");
  const parsed = new URL(oauthUrl);
  assert.equal(parsed.searchParams.get("provider"), "google");
  assert.equal(parsed.searchParams.get("redirect_to"), "sharely://auth-callback");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "s256");
  const challenge = parsed.searchParams.get("code_challenge") || "";
  assert.equal(challenge.length, 43);

  const origFetch = globalThis.fetch;
  let capturedBody = null;
  let capturedUrl = "";
  try {
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const payload = {
        access_token: "pkce-jwt-abc",
        refresh_token: "pkce-ref-xyz",
        user: {
          id: "u-pkce-1",
          email: "pkce@example.com",
          user_metadata: { full_name: "PKCE Tester" },
        },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    };

    const res = await exchangeOAuthCode("auth-code-777");
    assert.equal(res.ok, true);
    assert.match(capturedUrl, /\/auth\/v1\/token\?grant_type=pkce$/);
    assert.equal(capturedBody.auth_code, "auth-code-777");
    assert.ok(capturedBody.code_verifier);
    assert.equal(sha256Base64Url(capturedBody.code_verifier), challenge);
    assert.equal(res.data?.access_token, "pkce-jwt-abc");
    assert.equal(res.data?.user?.email, "pkce@example.com");
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("fetchWorkspace uses single /api/workspace call, supports 404 fallback, skips unauthenticated network calls, and isolates cache on logout", async () => {
  await clearSession();
  await saveCachedWorkspace({
    items: [{ id: "unsigned-1", title: "Unsigned", normalized_url: "https://unsigned.test", domain: "unsigned.test", is_favorite: false, created_at: "2026-11-16T00:00:00Z" }],
    folders: [],
    reminders: [],
  });
  assert.equal(getMemoryCachedWorkspace(), null, "Signed-out saveCachedWorkspace must not populate memory cache");

  await saveSession({ access_token: "tok-stale", refresh_token: "ref-stale", user: { id: "stale-user", email: "stale@example.com" } });
  await saveCachedWorkspace({
    items: [{ id: "stale-1", title: "Stale", normalized_url: "https://stale.test", domain: "stale.test", is_favorite: false, created_at: "2026-11-16T00:00:00Z" }],
    folders: [],
    reminders: [],
  });
  assert.equal(getMemoryCachedWorkspace()?.items.length, 1);
  await clearSession();
  assert.equal(getMemoryCachedWorkspace(), null);

  const origFetch = globalThis.fetch;
  let fetchCalls = [];
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      fetchCalls.push(target);
      if (target.includes("/api/workspace")) {
        const wsPayload = {
          id: "user-1",
          email: "user1@example.com",
          items: [
            { id: "it-1", title: "Fast Item", normalized_url: "https://fast.dev", domain: "fast.dev", is_favorite: false, created_at: "2026-11-16T01:00:00Z" },
          ],
          folders: [{ id: "f-1", name: "Work", icon: "📁" }],
          reminders: [],
          next_cursor: null,
        };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(wsPayload),
          json: async () => wsPayload,
        };
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    };

    // Unauthenticated: zero network calls!
    const guestWs = await fetchWorkspace();
    assert.equal(fetchCalls.length, 0);
    assert.equal(guestWs.me, null);

    // Authenticated: single /api/workspace call
    await saveSession({ access_token: "tok-1", refresh_token: "ref-1", user: { id: "user-1", email: "user1@example.com" } });
    const authedWs = await fetchWorkspace();
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /\/api\/workspace\?limit=100$/);
    assert.equal(authedWs.items.length, 1);
    assert.equal(authedWs.folders[0]?.name, "Work");
    assert.equal(getMemoryCachedWorkspace()?.items[0]?.id, "it-1");

    // 404 fallback to legacy 4 endpoints
    fetchCalls = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      fetchCalls.push(target);
      if (target.includes("/api/workspace")) {
        const errPayload = { detail: "Not Found" };
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify(errPayload),
          json: async () => errPayload,
        };
      }
      const mapPayload = target.includes("/api/auth/me")
        ? { id: "user-1", email: "user1@example.com" }
        : target.includes("/api/items")
          ? { items: [{ id: "it-legacy", title: "Legacy", normalized_url: "https://legacy.dev", domain: "legacy.dev", is_favorite: false, created_at: "2026-11-16T01:00:00Z" }] }
          : target.includes("/api/folders")
            ? { folders: [] }
            : { reminders: [] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mapPayload),
        json: async () => mapPayload,
      };
    };

    const legacyWs = await fetchWorkspace();
    assert.equal(fetchCalls.length, 5);
    assert.equal(legacyWs.items[0]?.id, "it-legacy");

    // Clear session clears memory workspace cache
    await clearSession();
    assert.equal(getMemoryCachedWorkspace(), null);
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("recordAuthDebugEvent redacts access_token, refresh_token, code, and code_verifier", () => {
  clearAuthDebugEvents();
  recordAuthDebugEvent(
    "oauth_cb",
    "sharely://auth-callback#access_token=secret_jwt&refresh_token=secret_ref&code=secret_code&code_verifier=secret_ver&ok=1",
  );
  const events = getAuthDebugEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, "oauth_cb");
  assert.doesNotMatch(events[0].detail, /secret_jwt|secret_ref|secret_code|secret_ver/);
  assert.match(events[0].detail, /access_token=\*\*\*/);
  assert.match(events[0].detail, /refresh_token=\*\*\*/);
  assert.match(events[0].detail, /code=\*\*\*/);
  assert.match(events[0].detail, /code_verifier=\*\*\*/);
  clearAuthDebugEvents();
});

test("Cycle 2 [C2]: coalesced OAuth PKCE/token callbacks, CSPRNG fail-closed, and redacted invite/Bearer logs", async () => {
  const origCrypto = globalThis.crypto;
  const origFetch = globalThis.fetch;

  // Fail closed when CSPRNG is absent (must never fall back to Math.random)
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    assert.throws(() => buildPkceChallengePair(), /Secure random number generator unavailable/);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: origCrypto, configurable: true });
  }

  await clearSession();
  await prepareGoogleOAuthUrl("sharely://auth-callback");
  let pkceCalls = 0;
  let userCalls = 0;
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/auth/v1/token?grant_type=pkce")) {
        pkceCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        const body = {
          access_token: "coalesced-jwt",
          refresh_token: "coalesced-ref",
          user: { id: "u-coalesced", email: "coalesced@example.com" },
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (target.includes("/auth/v1/user")) {
        userCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        const body = { id: "u-imp", email: "imp@example.com" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    };

    const [r1, r2] = await Promise.all([
      exchangeOAuthCode("dup-code-999"),
      exchangeOAuthCode("dup-code-999"),
    ]);
    const r3 = await exchangeOAuthCode("dup-code-999");
    assert.equal(pkceCalls, 1, "Duplicate PKCE callback must issue only 1 token request");
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);
    assert.equal(r1.data?.access_token, "coalesced-jwt");

    const [t1, t2] = await Promise.all([
      completeOAuthWithTokens("imp-tok-123", "imp-ref-123"),
      completeOAuthWithTokens("imp-tok-123", "imp-ref-123"),
    ]);
    assert.equal(userCalls, 1, "Duplicate implicit token callback must issue only 1 user check");
    assert.equal(t1.ok, true);
    assert.equal(t2.ok, true);
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }

  // L2: invite tokens, Bearer headers, token/password/secret params are redacted
  clearAuthDebugEvents();
  recordAuthDebugEvent(
    "deep_link",
    "https://just-save-it-web.onrender.com/invite/secretInvite99?token=tok123&password=pw1&secret=s1 Bearer eyJhbGci.payload.sig",
  );
  const dbg = getAuthDebugEvents()[0]?.detail || "";
  assert.doesNotMatch(dbg, /secretInvite99|tok123|pw1|eyJhbGci/);
  assert.match(dbg, /\/invite\/\*\*\*/);
  assert.match(dbg, /token=\*\*\*/);
  assert.match(dbg, /Bearer \*\*\*/);
  clearAuthDebugEvents();
});

test("Cycle 2 [C5, M4, L1]: account isolation on cache/offline queue, in-flight fetch abort, cursor pagination >500 items, delete cache prune, and http(s) URL guard", async () => {
  await clearSession();
  const origFetch = globalThis.fetch;

  try {
    // 1) User A stores cache & offline item, then User B logs in -> User A artifacts purged & isolated
    await saveSession({ access_token: "tok-a", refresh_token: "ref-a", user: { id: "user-a", email: "a@test.com" } });
    await saveCachedWorkspace({ items: [{ id: "a-item", url: "https://a.test", title: "Secret A" }], folders: [], reminders: [] });
    await enqueueOfflineItem({ url: "https://a.test/q", title: "Queue A" });
    assert.equal((await loadOfflineQueue()).length, 1);

    await saveSession({ access_token: "tok-b", refresh_token: "ref-b", user: { id: "user-b", email: "b@test.com" } });
    assert.equal((await loadCachedWorkspace()).items.length, 0, "User A cache must be cleared on account switch");
    assert.equal((await loadOfflineQueue()).length, 0, "User A offline queue must be cleared on account switch");

    // Even if User A's offline queue entry sits in storage alongside User B's, User B only sees/flushes User B's own
    await enqueueOfflineItem({ url: "https://a.test/foreign", title: "Foreign", user_id: "user-a" });
    await enqueueOfflineItem({ url: "https://b.test/own", title: "Own" });
    const ownQueue = await loadOfflineQueue();
    assert.equal(ownQueue.length, 1);
    assert.equal(ownQueue[0].url, "https://b.test/own");

    // 2) Mid-flight fetchWorkspace aborted cleanly on logout
    let resolveDelayed = null;
    const fetchStarted = new Promise((notify) => {
      globalThis.fetch = async (url) => {
        if (String(url).includes("/api/workspace")) {
          notify();
          return new Promise((r) => {
            resolveDelayed = r;
          });
        }
        return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
      };
    });
    const wsPromise = fetchWorkspace();
    await fetchStarted;
    await clearSession();
    assert.ok(typeof resolveDelayed === "function");
    resolveDelayed({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [{ id: "stale-b", url: "https://b.test", title: "Stale B" }], folders: [], reminders: [] }),
      json: async () => ({ items: [{ id: "stale-b", url: "https://b.test", title: "Stale B" }], folders: [], reminders: [] }),
    });
    const abortedWs = await wsPromise;
    assert.equal(abortedWs.items.length, 0, "Aborted fetch after logout must not leak state");
    assert.equal(getMemoryCachedWorkspace(), null, "Aborted fetch must not populate cache after clearSession");

    // 3) M4 cursor pagination >500 items with deduplication + L1 delete cache pruning
    await saveSession({ access_token: "tok-m4", refresh_token: "ref-m4", user: { id: "user-m4", email: "m4@test.com" } });
    const seenUrls = [];
    const makeBatch = (start, count, overlap = null) => {
      const list = [];
      if (overlap) list.push({ id: overlap, url: `https://m.test/${overlap}`, title: overlap });
      for (let i = start; i < start + count; i += 1) {
        list.push({ id: `m-${i}`, url: `https://m.test/${i}`, title: `Item ${i}` });
      }
      return list;
    };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      seenUrls.push(u);
      if (u.includes("/api/workspace")) {
        const body = { id: "user-m4", items: makeBatch(0, 100), folders: [], reminders: [], next_cursor: "mc-1" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.includes("cursor=mc-1")) {
        const body = { items: makeBatch(100, 100, "m-99"), next_cursor: "mc-2" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.includes("cursor=mc-2")) {
        const body = { items: makeBatch(200, 100), next_cursor: "mc-3" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.includes("cursor=mc-3")) {
        const body = { items: makeBatch(300, 100), next_cursor: "mc-4" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.includes("cursor=mc-4")) {
        const body = { items: makeBatch(400, 100), next_cursor: "mc-5" };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.includes("cursor=mc-5")) {
        const body = { items: makeBatch(500, 100), next_cursor: null };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (u.endsWith("/api/items/m-0") && init.method === "DELETE") {
        return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const m4Ws = await fetchWorkspace();
    assert.equal(m4Ws.items.length, 600, "Mobile fetchWorkspace must hydrate >500 items and deduplicate overlap");
    assert.equal(seenUrls.some((u) => u.includes("offset=")), false);

    // L1: deleteLinkItem prunes item immediately from memory & stored cache
    const delRes = await deleteLinkItem("m-0");
    assert.equal(delRes.ok, true);
    assert.equal(getMemoryCachedWorkspace()?.items.some((it) => it.id === "m-0"), false);
    assert.equal((await loadCachedWorkspace()).items.some((it) => it.id === "m-0"), false);

    // L1: item/[id].tsx Linking.openURL allows only http(s)
    const testDir = dirname(fileURLToPath(import.meta.url));
    const itemScreenCode = readFileSync(resolve(testDir, "../../app/item/[id].tsx"), "utf8");
    assert.match(itemScreenCode, /\^https\?:\\\/\\\//i);
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 3 [C-2, H-2]: user:null OAuth isolation, guest loadCachedWorkspace fail-closed, apiFetch 401 no-replay, and flush no-resurrect/concurrent-enqueue", async () => {
  await clearSession();
  const origFetch = globalThis.fetch;

  const makeFakeJwt = (sub) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub })).toString("base64url");
    return `${h}.${p}.sig`;
  };

  try {
    // 1) User A stores cache & offline item; User B signs in via OAuth fallback with user: null + JWT access_token
    await saveSession({
      access_token: makeFakeJwt("mob-user-a"),
      refresh_token: "ref-a",
      user: { id: "mob-user-a", email: "a@mob.test" },
    });
    await saveCachedWorkspace({
      items: [{ id: "mob-secret-a", url: "https://secret-a.test", title: "Secret A" }],
      folders: [],
      reminders: [],
    });
    await enqueueOfflineItem({ url: "https://secret-a.test/q", title: "Queue A" });

    assert.equal(resolveSessionUserId({ access_token: makeFakeJwt("mob-user-b"), refresh_token: "r", user: null }), "mob-user-b");
    await saveSession({
      access_token: makeFakeJwt("mob-user-b"),
      refresh_token: "ref-b",
      user: null,
    });
    assert.equal((await loadCachedWorkspace()).items.length, 0, "User A cache must be purged when switching to user:null JWT");
    assert.equal((await loadOfflineQueue()).length, 0, "User A offline queue must be purged on user:null switch");

    await enqueueOfflineItem({ url: "https://b.test/queued", title: "B Queue" });
    assert.equal((await loadOfflineQueue("mob-user-b")).length, 1, "B's queue must stamp JWT sub instead of A's stale _activeUserId");

    // Switching to user:null + opaque non-JWT token ALSO purges prior cache/queue & resets active owner
    await saveSession({
      access_token: "opaque-token-c",
      refresh_token: "ref-c",
      user: null,
    });
    assert.equal((await loadCachedWorkspace()).items.length, 0);
    assert.equal((await loadOfflineQueue()).length, 0);

    // 2) Signed-out loadCachedWorkspace fails closed even if memory or disk has stale items
    await clearSession();
    assert.equal((await loadCachedWorkspace()).items.length, 0);
    const guestWs = await fetchWorkspace();
    assert.equal(guestWs.items.length, 0);

    // 3) apiFetch 401 when switching accounts mid-flight MUST NOT refresh or replay under User B
    await saveSession({
      access_token: makeFakeJwt("mob-a-401"),
      refresh_token: "ref-a-401",
      user: { id: "mob-a-401", email: "a401@mob.test" },
    });
    let resolveDelayedReq;
    let calledRefreshWithB = false;
    let replayedWithB = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const auth = init?.headers?.Authorization || "";
      if (u.includes("grant_type=refresh_token")) {
        if (String(init.body || "").includes("ref-b-401")) calledRefreshWithB = true;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: "bad-new-tok", refresh_token: "bad-ref" }),
          json: async () => ({ access_token: "bad-new-tok", refresh_token: "bad-ref" }),
        };
      }
      if (auth.includes("mob-b-401-tok")) {
        replayedWithB = true;
        return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
      }
      return new Promise((r) => {
        resolveDelayedReq = r;
      });
    };
    const pendingReq = apiFetch("/api/items", { method: "POST", body: { url: "https://a.test" } });
    await new Promise((r) => setTimeout(r, 15));
    await saveSession({
      access_token: "mob-b-401-tok",
      refresh_token: "ref-b-401",
      user: { id: "mob-b-401", email: "b401@mob.test" },
    });
    resolveDelayedReq({ ok: false, status: 401, text: async () => '{"detail":"expired"}', json: async () => ({ detail: "expired" }) });
    const reqOut = await pendingReq;
    assert.equal(reqOut.ok, false);
    assert.equal(calledRefreshWithB, false, "Must not refresh User B session for User A 401");
    assert.equal(replayedWithB, false, "Must not replay User A request under User B token");

    // 4) flushOfflineQueueWithSender preserves concurrent enqueue & refuses to resurrect after clearSession()
    await setOfflineQueue([]);
    await enqueueOfflineItem({ url: "https://b401.test/one", title: "One" });
    let releaseFirst;
    const flushOne = flushOfflineQueueWithSender(async () => {
      await new Promise((r) => {
        releaseFirst = r;
      });
      return "ok";
    });
    await new Promise((r) => setTimeout(r, 15));
    await enqueueOfflineItem({ url: "https://b401.test/two", title: "Concurrent Two" });
    releaseFirst();
    const out1 = await flushOne;
    assert.equal(out1.flushed, 1);
    const remAfterConcurrent = await loadOfflineQueue();
    assert.equal(remAfterConcurrent.length, 1);
    assert.equal(remAfterConcurrent[0].url, "https://b401.test/two");

    // Now simulate logout during flush: purged queue must stay empty!
    let releaseLogoutFlush;
    const flushOnLogout = flushOfflineQueueWithSender(async () => {
      await new Promise((r) => {
        releaseLogoutFlush = r;
      });
      return "retry";
    });
    await new Promise((r) => setTimeout(r, 15));
    await clearSession();
    releaseLogoutFlush();
    await flushOnLogout;
    assert.equal((await loadOfflineQueue("mob-b-401")).length, 0, "Cleared offline queue must not resurrect after clearSession");
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 4 [F-3]: signed-out enqueueOfflineItem preserves foreign rows & mid-flush account switch never clobbers User B", async () => {
  const makeFakeJwt = (sub) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub })).toString("base64url");
    return `${h}.${p}.sig`;
  };
  await clearSession();
  try {
    // Seed a foreign user's stamped offline item alongside signed-out state
    const foreignEntry = {
      url: "https://foreign.test/kept",
      title: "Foreign User Item",
      user_id: "mob-foreign-user",
      client_id: "c-foreign-1",
      queued_at: new Date().toISOString(),
    };
    await setOfflineQueue([foreignEntry]);

    // While signed out (!uid), enqueueOfflineItem must retain mob-foreign-user's row
    await enqueueOfflineItem({ url: "https://guest.test/new", title: "Guest Item" });
    const foreignAfter = await loadOfflineQueue("mob-foreign-user");
    assert.equal(foreignAfter.length, 1);
    assert.equal(foreignAfter[0].url, "https://foreign.test/kept");
    const guestAfter = await loadOfflineQueue("");
    assert.equal(guestAfter.length, 1);
    assert.equal(guestAfter[0].url, "https://guest.test/new");

    // Account switch mid-flush must never resurrect User A remaining items or clobber User B queue
    await clearSession();
    await saveSession({
      access_token: makeFakeJwt("mob-a-f3"),
      refresh_token: "ref-a-f3",
      user: { id: "mob-a-f3", email: "af3@mob.test" },
    });
    await setOfflineQueue([]);
    await enqueueOfflineItem({ url: "https://a-f3.test/one", title: "A1" });
    await enqueueOfflineItem({ url: "https://a-f3.test/two", title: "A2" });

    let releaseSender;
    const flushA = flushOfflineQueueWithSender(async () => {
      await new Promise((r) => {
        releaseSender = r;
      });
      return "ok";
    });
    await new Promise((r) => setTimeout(r, 15));

    await saveSession({
      access_token: makeFakeJwt("mob-b-f3"),
      refresh_token: "ref-b-f3",
      user: { id: "mob-b-f3", email: "bf3@mob.test" },
    });
    await enqueueOfflineItem({ url: "https://b-f3.test/only", title: "B Only" });

    releaseSender();
    await flushA;

    const queueB = await loadOfflineQueue("mob-b-f3");
    assert.equal(queueB.length, 1);
    assert.equal(queueB[0].url, "https://b-f3.test/only");
    const queueA = await loadOfflineQueue("mob-a-f3");
    assert.equal(queueA.length, 0, "Switched-out User A queue must stay cleared");
  } finally {
    await clearSession();
  }
});

test("Cycle 5 [M-3, L-1]: deleteLinkItem/removeCachedLinkItem guards account switch & saveSession bumps gen on opaque token", async () => {
  const makeFakeJwt = (sub) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub })).toString("base64url");
    return `${h}.${p}.sig`;
  };
  await clearSession();
  const origFetch = globalThis.fetch;

  try {
    // 1. LOW-1: guest -> opaque token (non-JWT, user: null) still bumps authGeneration
    const genBeforeOpaque = getAuthGeneration();
    await saveSession({ access_token: "opaque-token-without-dots", refresh_token: "r-op", user: null });
    assert.ok(getAuthGeneration() > genBeforeOpaque, "Opaque session save must bump authGeneration");

    // 2. MEDIUM-3: mid-flight deleteLinkItem settling after account switch does NOT overwrite User B cache
    await clearSession();
    await saveSession({
      access_token: makeFakeJwt("mob-a-m3"),
      refresh_token: "ref-a-m3",
      user: { id: "mob-a-m3", email: "am3@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-a-m3",
      items: [{ id: "m-a-del", url: "https://a.test/del", title: "A Del" }],
      folders: [],
      reminders: [],
    });

    let resolveDel;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/api/items/") && init.method === "DELETE") {
        return new Promise((r) => {
          resolveDel = r;
        });
      }
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
    };

    const pDel = deleteLinkItem("m-a-del");
    await new Promise((r) => setTimeout(r, 15));

    // User switches to User B and caches User B items while User A's DELETE is still in flight
    await saveSession({
      access_token: makeFakeJwt("mob-b-m3"),
      refresh_token: "ref-b-m3",
      user: { id: "mob-b-m3", email: "bm3@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-b-m3",
      items: [{ id: "m-b-keep", url: "https://b.test/keep", title: "B Keep" }],
      folders: [],
      reminders: [],
    });

    resolveDel({ ok: true, status: 200, text: async () => '{"deleted":true}', json: async () => ({ deleted: true }) });
    await pDel;

    const cachedB = await loadCachedWorkspace();
    assert.deepEqual(cachedB.items.map((it) => it.id), ["m-b-keep"], "User B cache must stay intact after User A delete settles");

    // Signed-out removeCachedLinkItem is a safe no-op
    await clearSession();
    await removeCachedLinkItem("m-b-keep");
    assert.equal((await loadCachedWorkspace()).items.length, 0);

    // Cycle 6 [M-2, L-3]: saveCachedWorkspace rejects explicit user_id when signed out or mismatched
    await saveCachedWorkspace({
      user_id: "mob-explicit-leaked",
      items: [{ id: "bad-1", url: "https://bad.test/1", title: "Should Not Persist" }],
      folders: [],
      reminders: [],
    });
    assert.equal(getMemoryCachedWorkspace(), null, "Signed-out saveCachedWorkspace with explicit user_id must be ignored");

    await saveSession({
      access_token: makeFakeJwt("mob-owner-a"),
      refresh_token: "ref-oa",
      user: { id: "mob-owner-a", email: "oa@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-owner-b",
      items: [{ id: "bad-2", url: "https://bad.test/2", title: "Cross-Account Cache" }],
      folders: [],
      reminders: [],
    });
    assert.equal(getMemoryCachedWorkspace(), null, "Cross-account saveCachedWorkspace must be rejected");
    assert.equal((await loadCachedWorkspace()).items.length, 0);
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 7 [H-2, M-4]: apiFetch network-drop & saveLinkItem abort across switch without queue poisoning, clearSession double-bump, and index.tsx guard", async () => {
  const makeFakeJwtC7 = (sub) => {
    const body = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
  };
  const apiMod = await import("../api.ts");
  const storageMod = await import("../storage.ts");
  const { saveLinkItem } = apiMod;
  const origFetch = globalThis.fetch;

  try {
    // 1. clearSession bumps _authGeneration by >= 2 and blocks racing saveCachedWorkspace
    await saveSession({
      access_token: makeFakeJwtC7("mob-c7-race"),
      refresh_token: "r-c7",
      user: { id: "mob-c7-race", email: "race@mob.test" },
    });
    const genBeforeClear = getAuthGeneration();
    const pSaveRace = saveCachedWorkspace({
      user_id: "mob-c7-race",
      items: [{ id: "race-item", url: "https://race.test", title: "Race" }],
      folders: [],
      reminders: [],
    });
    await clearSession();
    const genAfterClear = getAuthGeneration();
    await pSaveRace;
    assert.ok(genAfterClear >= genBeforeClear + 2, `Expected double gen bump (>= +2), got +${genAfterClear - genBeforeClear}`);
    assert.equal(getMemoryCachedWorkspace(), null);
    assert.equal((await loadCachedWorkspace()).items.length, 0);

    // 2. apiFetch network error during account switch converts to status 401 (not status 0)
    await saveSession({
      access_token: makeFakeJwtC7("mob-c7-a"),
      refresh_token: "r-a",
      user: { id: "mob-c7-a", email: "a@mob.test" },
    });
    let rejectSlowNet = null;
    globalThis.fetch = () => new Promise((_res, rej) => { rejectSlowNet = rej; });

    const pendingApi = apiFetch("/api/items", { method: "POST", body: { url: "https://a.mob/1" } });
    await new Promise((r) => setTimeout(r, 10));
    await saveSession({
      access_token: makeFakeJwtC7("mob-c7-b"),
      refresh_token: "r-b",
      user: { id: "mob-c7-b", email: "b@mob.test" },
    });
    rejectSlowNet(new TypeError("Network request failed"));
    const apiRes = await pendingApi;
    assert.equal(apiRes.ok, false);
    assert.equal(apiRes.status, 401, "apiFetch network error after session switch must map to status 401 instead of status 0");

    // 3. saveLinkItem while User A is signed in -> network drops after switch to User C -> User C queue stays empty
    await saveSession({
      access_token: makeFakeJwtC7("mob-c7-c0"),
      refresh_token: "r-c0",
      user: { id: "mob-c7-c0", email: "c0@mob.test" },
    });
    let rejectSaveNet = null;
    globalThis.fetch = () => new Promise((_res, rej) => { rejectSaveNet = rej; });
    const pendingSave = saveLinkItem({ url: "https://a.mob/poison", title: "Should Not Poison" });
    await new Promise((r) => setTimeout(r, 10));
    await saveSession({
      access_token: makeFakeJwtC7("mob-c7-c1"),
      refresh_token: "r-c1",
      user: { id: "mob-c7-c1", email: "c1@mob.test" },
    });
    rejectSaveNet(new TypeError("Socket hangup"));
    const saveRes = await pendingSave;
    assert.equal(saveRes.ok, false);
    assert.equal(saveRes.status, 401);
    assert.equal(saveRes.queued, undefined);
    assert.equal((await loadOfflineQueue()).length, 0, "Stale saveLinkItem must not enqueue User A link into User C offline queue");

    // Verify storage identity still points cleanly to active user via exported getActiveUserScope or queue isolation
    assert.equal((await storageMod.loadOfflineQueue("mob-c7-c0")).length, 0);

    // 4. Verify (tabs)/index.tsx & all 5 sibling mobile screens guard async state setters on authGeneration
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appDir = path.resolve(here, "../../app");
    const screenChecks = [
      ["(tabs)/index.tsx", /const loadAll = useCallback[\s\S]{0,1400}getAuthGeneration\(\) !== startGen/],
      ["(tabs)/folders.tsx", /const loadData = useCallback[\s\S]{0,900}getAuthGeneration\(\) !== startGen/],
      ["(tabs)/favorites.tsx", /const loadData = useCallback[\s\S]{0,900}getAuthGeneration\(\) !== startGen/],
      ["(tabs)/profile.tsx", /const loadProfile = useCallback[\s\S]{0,1200}getAuthGeneration\(\) !== startGen/],
      ["folder/[id].tsx", /const loadFolder = useCallback[\s\S]{0,1200}getAuthGeneration\(\) !== startGen/],
      ["item/[id].tsx", /const loadItem = useCallback[\s\S]{0,600}getAuthGeneration\(\) !== startGen/],
    ];
    for (const [rel, pattern] of screenChecks) {
      const code = fs.readFileSync(path.join(appDir, rel), "utf8");
      assert.match(code, pattern, `Expected authGeneration guard in mobile/app/${rel}`);
    }
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 8 [MED-3, MED-4]: apiFetch mid-parseJsonSafe abort and fetchWorkspace 401 fail-closed without cached leak", async () => {
  const makeFakeJwtC8 = (sub) => {
    const body = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
  };
  const { fetchWorkspace } = await import("../api.ts");
  const origFetch = globalThis.fetch;

  try {
    // 1. Account switch while resp.text() (parseJsonSafe) is resolving must NOT return User A HTTP 200 payload
    await saveSession({
      access_token: makeFakeJwtC8("mob-c8-json-a"),
      refresh_token: "",
      user: { id: "mob-c8-json-a", email: "ja@mob.test" },
    });
    let resolveBodyText = null;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: () => new Promise((r) => { resolveBodyText = r; }),
    });
    const pendingParse = apiFetch("/api/items");
    await new Promise((r) => setTimeout(r, 10));
    await saveSession({
      access_token: makeFakeJwtC8("mob-c8-json-b"),
      refresh_token: "",
      user: { id: "mob-c8-json-b", email: "jb@mob.test" },
    });
    resolveBodyText('{"items":[{"id":"stale-a"}]}');
    const parsedRes = await pendingParse;
    assert.equal(parsedRes.ok, false);
    assert.equal(parsedRes.status, 401, "apiFetch switching accounts during resp.text() must abort with status 401");
    assert.equal(parsedRes.data, null);

    // 2. fetchWorkspace HTTP 401 on /api/workspace must fail closed (never leak cached items)
    await saveSession({
      access_token: makeFakeJwtC8("mob-c8-401"),
      refresh_token: "",
      user: { id: "mob-c8-401", email: "w401@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-c8-401",
      items: [{ id: "cached-secret", url: "https://cached.test", title: "Cached" }],
      folders: [{ id: "f-secret", name: "Secret Folder" }],
      reminders: [],
    });
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"detail":"expired"}',
    });
    const ws401 = await fetchWorkspace();
    assert.equal(ws401.items.length, 0, "fetchWorkspace 401 on /api/workspace must not return cached items");
    assert.equal(ws401.folders.length, 0);

    // 3. fetchWorkspace HTTP 401 on 404 legacy fallback itemsRes must also fail closed
    await saveSession({
      access_token: makeFakeJwtC8("mob-c8-fb401"),
      refresh_token: "",
      user: { id: "mob-c8-fb401", email: "fb401@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-c8-fb401",
      items: [{ id: "fb-cached", url: "https://fb.test", title: "Fallback Cached" }],
      folders: [],
      reminders: [],
    });
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/workspace")) {
        return { ok: false, status: 404, text: async () => '{"detail":"not found"}' };
      }
      return { ok: false, status: 401, text: async () => '{"detail":"expired"}' };
    };
    const wsFallback401 = await fetchWorkspace();
    assert.equal(wsFallback401.items.length, 0, "fetchWorkspace legacy 401 fallback must fail closed");
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 9 [HIGH-1, MED-1, MED-2, MED-3, MED-4]: partial 401 fallback, cursor page-2 401, logoutAccount race, saveSession expectedGen race, and action handler guards", async () => {
  const makeFakeJwtC9 = (sub) => {
    const body = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
  };
  const { fetchWorkspace, logoutAccount } = await import("../api.ts");
  const { loadSession } = await import("../storage.ts");
  const origFetch = globalThis.fetch;

  try {
    // 1. MED-1: legacy 404 fallback with itemsRes=200 but foldersRes=401 must fail closed without overwriting cache
    await saveSession({
      access_token: makeFakeJwtC9("mob-c9-part"),
      refresh_token: "",
      user: { id: "mob-c9-part", email: "part@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-c9-part",
      items: [{ id: "keep-c9", url: "https://keep.test", title: "Keep" }],
      folders: [{ id: "keep-f", name: "Keep Folder" }],
      reminders: [],
    });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/workspace")) return { ok: false, status: 404, text: async () => "{}" };
      if (u.includes("/api/folders")) return { ok: false, status: 401, text: async () => "{}" };
      if (u.includes("/api/items")) return { ok: true, status: 200, text: async () => '{"items":[{"id":"new-1"}]}' };
      return { ok: true, status: 200, text: async () => '{"reminders":[]}' };
    };
    const wsPartial401 = await fetchWorkspace();
    assert.equal(wsPartial401.items.length, 0, "Fallback 401 on foldersRes must fail closed");
    assert.equal(await loadSession(), null, "Unrecoverable fallback 401 must clear revoked session cleanly");
    assert.equal((await loadCachedWorkspace()).folders.length, 0, "Cleared session after fallback 401 must not expose cached folders");

    // 2. MED-1: cursor pagination page 2 returning 401 must fail closed instead of persisting truncated page 1
    await saveSession({
      access_token: makeFakeJwtC9("mob-c9-cur"),
      refresh_token: "",
      user: { id: "mob-c9-cur", email: "cur@mob.test" },
    });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/workspace")) {
        return {
          ok: true,
          status: 200,
          text: async () => '{"items":[{"id":"p1-only","url":"https://p1.test"}],"folders":[],"reminders":[],"next_cursor":"c2"}',
        };
      }
      if (u.includes("cursor=c2")) {
        return { ok: false, status: 401, text: async () => '{"detail":"expired"}' };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const wsCur401 = await fetchWorkspace();
    assert.equal(wsCur401.items.length, 0, "Page 2 cursor 401 must fail closed without persisting truncated page 1");
    assert.equal((await loadCachedWorkspace()).items.length, 0);

    // 3. MED-2: logoutAccount mid-flight OAuth switch to User B must NOT clear User B
    await saveSession({
      access_token: makeFakeJwtC9("mob-c9-log-a"),
      refresh_token: "",
      user: { id: "mob-c9-log-a", email: "la@mob.test" },
    });
    let resolveLogout = null;
    globalThis.fetch = () => new Promise((r) => { resolveLogout = r; });
    const logoutTask = logoutAccount();
    await new Promise((r) => setTimeout(r, 10));
    await saveSession({
      access_token: makeFakeJwtC9("mob-c9-log-b"),
      refresh_token: "",
      user: { id: "mob-c9-log-b", email: "lb@mob.test" },
    });
    resolveLogout({ ok: true, status: 200, text: async () => "{}" });
    await logoutTask;
    assert.equal((await loadSession())?.user?.id, "mob-c9-log-b", "logoutAccount must preserve User B signed in mid-flight");

    // 4. MED-3 / Cycle 10 [MED-1]: saveSession({ expectedGen }) handles !shouldBumpGen AND shouldBumpGen paths cleanly without self-aborting, while failing closed on clearSession()
    await saveSession({
      access_token: makeFakeJwtC9("mob-c9-res"),
      refresh_token: "r-res",
      user: { id: "mob-c9-res", email: "res@mob.test" },
    });
    const refreshGen = getAuthGeneration();
    const pendingRefreshSave = saveSession(
      {
        access_token: makeFakeJwtC9("mob-c9-res"),
        refresh_token: "r-res-2",
        user: { id: "mob-c9-res", email: "res@mob.test" },
      },
      { expectedGen: refreshGen },
    );
    await clearSession();
    const abortedSave = await pendingRefreshSave;
    assert.equal(abortedSave, false, "saveSession aborted by clearSession must return false");
    assert.equal(await loadSession(), null, "saveSession with stale expectedGen must never resurrect cleared session");

    // 4b. shouldBumpGen=true (opaque session upgrading to decoded UID) succeeds when expectedGen matches
    await saveSession({ access_token: "opaque-old", refresh_token: "r-opq", user: null });
    const opqGen = getAuthGeneration();
    const upgradedOk = await saveSession(
      {
        access_token: makeFakeJwtC9("mob-c10-upg"),
        refresh_token: "r-upg",
        user: { id: "mob-c10-upg", email: "upg@mob.test" },
      },
      { expectedGen: opqGen },
    );
    assert.equal(upgradedOk, true, "saveSession({ expectedGen }) with shouldBumpGen must commit cleanly instead of self-aborting");
    assert.equal((await loadSession())?.user?.id, "mob-c10-upg");

    // 4c. refreshSession returns false when saveSession aborts due to concurrent clearSession()
    await clearSession();
    await saveSession({
      access_token: makeFakeJwtC9("mob-c10-ref"),
      refresh_token: "r-ref-live",
      user: { id: "mob-c10-ref", email: "ref@mob.test" },
    });
    let resolveSlowRefresh = null;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/auth/v1/token?grant_type=refresh_token")) {
        return new Promise((r) => { resolveSlowRefresh = r; });
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const refreshTask = refreshSession();
    await new Promise((r) => setTimeout(r, 10));
    await clearSession();
    resolveSlowRefresh({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: makeFakeJwtC9("mob-c10-ref"),
        refresh_token: "r-ref-next",
        user: { id: "mob-c10-ref", email: "ref@mob.test" },
      }),
    });
    assert.equal(await refreshTask, false, "refreshSession invalidated by concurrent clearSession must return false");

    // 5. Cycle 10 [MED-2, MED-3, LOW-1]: Real runtime tests for runGuardedBusyAction & shouldNavigateAfterLogout
    await saveSession({
      access_token: makeFakeJwtC9("mob-guard-a"),
      refresh_token: "r-ga",
      user: { id: "mob-guard-a", email: "ga@mob.test" },
    });
    const seqRef = { current: 0 };
    let busyState = false;
    let mutatedStale = false;
    let resolveActionA = null;
    const actionATask = runGuardedBusyAction(
      seqRef,
      (b) => { busyState = b; },
      async (isStale) => {
        await new Promise((r) => { resolveActionA = r; });
        if (isStale()) return "ignored";
        mutatedStale = true;
        return "done";
      },
    );
    assert.equal(busyState, true);
    await saveSession({
      access_token: makeFakeJwtC9("mob-guard-b"),
      refresh_token: "r-gb",
      user: { id: "mob-guard-b", email: "gb@mob.test" },
    });
    resolveActionA();
    const actionARes = await actionATask;
    assert.equal(actionARes.aborted, true, "Auth switch mid-action must mark guarded action aborted");
    assert.equal(mutatedStale, false, "Stale guarded action must not mutate post-await state");
    assert.equal(busyState, false, "Stale guarded action must still release UI busy state in finally");

    // Overlapping action B keeps busy=true even when older stale action settles first
    let resolveOld = null;
    let resolveNew = null;
    const oldTask = runGuardedBusyAction(seqRef, (b) => { busyState = b; }, () => new Promise((r) => { resolveOld = r; }));
    const newTask = runGuardedBusyAction(seqRef, (b) => { busyState = b; }, () => new Promise((r) => { resolveNew = r; }));
    resolveOld();
    await oldTask;
    assert.equal(busyState, true, "Older settling action must not reset newer action's busy state");
    resolveNew();
    await newTask;
    assert.equal(busyState, false, "Latest action completion resets busy state cleanly");

    // Stale thrown error is suppressed cleanly and unlocks busy; active error rethrows and unlocks busy
    let rejectStale = null;
    const staleErrTask = runGuardedBusyAction(seqRef, (b) => { busyState = b; }, () => new Promise((_, rej) => { rejectStale = rej; }));
    await clearSession();
    rejectStale(new Error("stale err"));
    const staleErrRes = await staleErrTask;
    assert.equal(staleErrRes.aborted, true);
    assert.equal(busyState, false);
    await assert.rejects(
      runGuardedBusyAction(seqRef, (b) => { busyState = b; }, async () => { throw new Error("live err"); }),
      /live err/,
    );
    assert.equal(busyState, false);

    // shouldNavigateAfterLogout blocks /login navigation if new user signs in during async loadSession (LOW-1)
    let resolveDelayedRead = null;
    const blockedNav = shouldNavigateAfterLogout(
      async () => { await clearSession(); },
      getAuthGeneration,
      () => new Promise((r) => { resolveDelayedRead = r; }),
    );
    await new Promise((r) => setTimeout(r, 10));
    await saveSession({
      access_token: makeFakeJwtC9("mob-c10-late"),
      refresh_token: "r-late",
      user: { id: "mob-c10-late", email: "late@mob.test" },
    });
    resolveDelayedRead(null);
    assert.equal(await blockedNav, false, "Late sign-in during async loadSession must suppress /login navigation");
    assert.equal(
      await shouldNavigateAfterLogout(async () => { await clearSession(); }, getAuthGeneration, loadSession),
      true,
      "Normal logout with no concurrent login must allow /login navigation",
    );

    // 6. HIGH-1 wiring checks: all 5 mobile screens bind actionGuards / gen guards cleanly
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appDir = path.resolve(here, "../../app");
    const actionChecks = [
      ["(tabs)/profile.tsx", /async function handleEnablePush[\s\S]{0,200}runGuardedBusyAction/],
      ["(tabs)/profile.tsx", /async function handleFlushQueue[\s\S]{0,200}runGuardedBusyAction/],
      ["(tabs)/profile.tsx", /async function handleDeleteAccount[\s\S]{0,700}deleteInFlightRef\.current[\s\S]{0,700}isPostClearSafeToNavigate/],
      ["(tabs)/profile.tsx", /deleteConfirmBtn[\s\S]{0,160}disabled=\{busyAction === "delete"\}/],
      ["(tabs)/profile.tsx", /async function handleLogout[\s\S]{0,250}shouldNavigateAfterLogout/],
      ["item/[id].tsx", /async function handleToggleSeen[\s\S]{0,550}getAuthGeneration\(\) !== startGen/],
      ["item/[id].tsx", /async function handleAiSummarize[\s\S]{0,200}runGuardedBusyAction/],
      ["item/[id].tsx", /async function handleSaveEdits[\s\S]{0,200}runGuardedBusyAction/],
      ["item/[id].tsx", /async function handleQuickReminder[\s\S]{0,200}runGuardedBusyAction/],
      ["item/[id].tsx", /async function handleClearReminder[\s\S]{0,200}runGuardedBusyAction/],
      ["item/[id].tsx", /function confirmDelete[\s\S]{0,500}getAuthGeneration\(\) !== modalGen/],
      ["(tabs)/folders.tsx", /async function handleSaveFolder[\s\S]{0,450}runGuardedBusyAction/],
      ["folder/[id].tsx", /async function handleCreateInvite[\s\S]{0,650}runGuardedBusyAction/],
      ["(tabs)/index.tsx", /async function handleQuickSave[\s\S]{0,300}runGuardedBusyAction/],
      ["(tabs)/index.tsx", /async function toggleFavorite[\s\S]{0,400}getAuthGeneration\(\) !== startGen/],
      ["(tabs)/favorites.tsx", /async function removeFavorite[\s\S]{0,400}getAuthGeneration\(\) !== startGen[\s\S]{0,200}if \(!res\.ok\)/],
    ];
    for (const [rel, pattern] of actionChecks) {
      const code = fs.readFileSync(path.join(appDir, rel), "utf8");
      assert.match(code, pattern, `Expected guard in mobile/app/${rel} matching ${pattern}`);
    }
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
  }
});

test("Cycle 13: FIFO auth storage serialization, simulated IPC jitter, cache/queue isolation, login epoch fencing, expectedRefreshToken CAS, and logoutAccount skipRetry", async () => {
  const { loadSession, __setStorageBackendsForTests } = await import("../storage.ts");
  const { loginWithPassword, logoutAccount } = await import("../api.ts");
  const makeFakeJwtC13 = (sub) => {
    const body = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
  };
  const origFetch = globalThis.fetch;
  const stdMap = new Map();
  const secMap = new Map();
  let tick = 0;
  const jitter = () => new Promise((r) => setTimeout(r, ((tick++ % 3) + 1) * 4));
  const makeDelayedBackend = (map) => ({
    async getItem(k) {
      await jitter();
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      await jitter();
      map.set(k, v);
    },
    async removeItem(k) {
      await jitter();
      map.delete(k);
    },
  });

  try {
    __setStorageBackendsForTests({
      standard: makeDelayedBackend(stdMap),
      secure: makeDelayedBackend(secMap),
    });
    await clearSession();

    // 1. Concurrent saveSession(B) + stale saveSession(A, { expectedGen }) -> User B and cache/queue stay intact
    await saveSession({
      access_token: makeFakeJwtC13("mob-c13-a"),
      refresh_token: "ref-c13-a1",
      user: { id: "mob-c13-a", email: "c13a@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-c13-a",
      items: [{ id: "leak-a-1", url: "https://a.test/1", title: "Secret A" }],
      folders: [],
      reminders: [],
    });
    await enqueueOfflineItem({ url: "https://a.test/q1", title: "QA1" });
    const genA = getAuthGeneration();
    const [okB, okStaleA] = await Promise.all([
      saveSession({
        access_token: makeFakeJwtC13("mob-c13-b"),
        refresh_token: "ref-c13-b1",
        user: { id: "mob-c13-b", email: "c13b@mob.test" },
      }),
      saveSession(
        {
          access_token: makeFakeJwtC13("mob-c13-a"),
          refresh_token: "ref-c13-a2",
          user: { id: "mob-c13-a", email: "c13a@mob.test" },
        },
        { expectedGen: genA },
      ),
    ]);
    assert.equal(okB, true);
    assert.equal(okStaleA, false, "Serialized stale saveSession(A) behind User B must abort cleanly");
    assert.equal((await loadSession())?.user?.id, "mob-c13-b");
    assert.equal((await loadCachedWorkspace()).items.length, 0, "User A cache must be cleared cleanly");
    assert.equal((await loadOfflineQueue()).length, 0, "User A queue must be cleared cleanly");
    assert.equal(getMemoryCachedWorkspace(), null);

    // Seed B cache & queue then verify stale same-user/foreign expectedGen never wipes B cache/queue
    await saveCachedWorkspace({
      user_id: "mob-c13-b",
      items: [{ id: "keep-b-1", url: "https://b.test/1", title: "Keep B" }],
      folders: [],
      reminders: [],
    });
    await enqueueOfflineItem({ url: "https://b.test/q1", title: "QB1" });
    const okStaleB = await saveSession(
      {
        access_token: makeFakeJwtC13("mob-c13-a"),
        refresh_token: "ref-c13-a2x",
        user: { id: "mob-c13-a", email: "c13a@mob.test" },
      },
      { expectedGen: genA },
    );
    assert.equal(okStaleB, false);
    assert.equal((await loadCachedWorkspace()).items[0]?.id, "keep-b-1");
    assert.equal((await loadOfflineQueue()).length, 1);

    // 2. Concurrent saveSession(B) followed by clearSession() -> aborts save and wipes cache/queue cleanly
    const [okSaveBeforeClear] = await Promise.all([
      saveSession({
        access_token: makeFakeJwtC13("mob-c13-b"),
        refresh_token: "ref-c13-b2",
        user: { id: "mob-c13-b", email: "c13b@mob.test" },
      }),
      clearSession(),
    ]);
    assert.equal(okSaveBeforeClear, false, "saveSession raced by synchronous clearSession must abort cleanly");
    assert.equal(await loadSession(), null, "Concurrent saveSession + clearSession must end cleared");
    assert.equal(stdMap.get("jsi_mobile_cache"), undefined, "Cache key must be deleted after concurrent clearSession");
    assert.equal(stdMap.get("jsi_mobile_offline_queue"), undefined, "Queue key must be deleted after concurrent clearSession");
    assert.equal(getMemoryCachedWorkspace(), null);

    // 3. Concurrent clearSession() followed by saveSession(B) -> User B survives
    const [, okBAfterClear] = await Promise.all([
      clearSession(),
      saveSession({
        access_token: makeFakeJwtC13("mob-c13-b"),
        refresh_token: "ref-c13-b3",
        user: { id: "mob-c13-b", email: "c13b@mob.test" },
      }),
    ]);
    assert.equal(okBAfterClear, true);
    assert.equal((await loadSession())?.user?.id, "mob-c13-b", "Concurrent clearSession + saveSession(B) must keep User B");

    // 4. Stale User A submitted first under Promise.all followed immediately by User B -> User B finishes intact
    await clearSession();
    await saveSession({
      access_token: makeFakeJwtC13("mob-c13-a"),
      refresh_token: "ref-c13-a3",
      user: { id: "mob-c13-a", email: "c13a@mob.test" },
    });
    const genA2 = getAuthGeneration();
    const [okA2, okB2] = await Promise.all([
      saveSession(
        {
          access_token: makeFakeJwtC13("mob-c13-a"),
          refresh_token: "ref-c13-a4",
          user: { id: "mob-c13-a", email: "c13a@mob.test" },
        },
        { expectedGen: genA2 },
      ),
      saveSession({
        access_token: makeFakeJwtC13("mob-c13-b"),
        refresh_token: "ref-c13-b4",
        user: { id: "mob-c13-b", email: "c13b@mob.test" },
      }),
    ]);
    assert.equal(okA2, true);
    assert.equal(okB2, true);
    assert.equal((await loadSession())?.user?.id, "mob-c13-b");

    // 5. HIGH-1: concurrent enqueueOfflineItem RMW safety & saveCachedWorkspace vs clearSession / cross-user isolation
    await Promise.all([
      enqueueOfflineItem({ url: "https://rmw.mob/1", title: "R1" }),
      enqueueOfflineItem({ url: "https://rmw.mob/2", title: "R2" }),
    ]);
    assert.equal((await loadOfflineQueue("mob-c13-b")).length, 2, "Concurrent enqueueOfflineItem calls must not lose items");

    await Promise.all([
      saveCachedWorkspace({
        user_id: "mob-c13-b",
        items: [{ id: "resurrect-check", url: "https://rc.mob", title: "RC" }],
        folders: [],
        reminders: [],
      }),
      clearSession(),
    ]);
    assert.equal(stdMap.get("jsi_mobile_cache"), undefined, "Concurrent saveCachedWorkspace + clearSession must not resurrect cache");
    assert.equal(getMemoryCachedWorkspace(), null);

    // 6. HIGH-2: slow loginWithPassword & completeOAuthWithTokens aborted cleanly by clearSession / newer login
    let resolveSlowPwd = null;
    globalThis.fetch = (url) => {
      if (String(url).includes("/auth/v1/token?grant_type=password")) {
        return new Promise((r) => { resolveSlowPwd = r; });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => "{}" });
    };
    const pwdTask = loginWithPassword("slow@mob.test", "secret123");
    await new Promise((r) => setTimeout(r, 15));
    await clearSession();
    resolveSlowPwd({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: makeFakeJwtC13("mob-resurrect-pwd"),
        refresh_token: "r-res",
        user: { id: "mob-resurrect-pwd", email: "slow@mob.test" },
      }),
    });
    const pwdRes = await pwdTask;
    assert.equal(pwdRes.ok, false, "Slow loginWithPassword raced by clearSession must fail closed");
    assert.equal(await loadSession(), null);

    let resolveSlowOauthUser = null;
    globalThis.fetch = () => new Promise((r) => { resolveSlowOauthUser = r; });
    const oauthSlowTask = completeOAuthWithTokens(makeFakeJwtC13("mob-slow-oauth"), "ref-so");
    await new Promise((r) => setTimeout(r, 15));
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "{}" });
    await loginWithPassword("b@mob.test", "pw");
    resolveSlowOauthUser({ ok: true, status: 200, text: async () => '{"id":"mob-slow-oauth","email":"so@mob.test"}' });
    const oauthSlowRes = await oauthSlowTask;
    assert.equal(oauthSlowRes.ok, false, "Slow OAuth completion superseded by newer login must fail closed");

    // 7. MEDIUM-1: refreshSession passes expectedRefreshToken so same-user re-login token is never overwritten
    await clearSession();
    await saveSession({
      access_token: makeFakeJwtC13("mob-same-u"),
      refresh_token: "ref-same-old",
      user: { id: "mob-same-u", email: "same@mob.test" },
    });
    let resolveSlowRefSame = null;
    globalThis.fetch = (url) => {
      if (String(url).includes("grant_type=refresh_token")) {
        return new Promise((r) => { resolveSlowRefSame = r; });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => "{}" });
    };
    const sameRefTask = refreshSession();
    await new Promise((r) => setTimeout(r, 15));
    await saveSession({
      access_token: makeFakeJwtC13("mob-same-u"),
      refresh_token: "ref-same-new",
      user: { id: "mob-same-u", email: "same@mob.test" },
    });
    resolveSlowRefSame({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: makeFakeJwtC13("mob-same-u"),
        refresh_token: "ref-same-stale-rotated",
        user: { id: "mob-same-u", email: "same@mob.test" },
      }),
    });
    assert.equal(await sameRefTask, false, "Stale refreshSession must abort behind newer same-user refresh_token");
    assert.equal((await loadSession())?.refresh_token, "ref-same-new");

    // 8. LOW-1: logoutAccount on opaque session uses skipRetry (zero refresh attempt) and clears cleanly on 401
    await clearSession();
    await saveSession({
      access_token: "opaque-broken-token",
      refresh_token: "ref-opaque-live",
      user: null,
    });
    let refreshAttemptedDuringLogout = false;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("grant_type=refresh_token")) {
        refreshAttemptedDuringLogout = true;
      }
      if (u.includes("/api/auth/logout")) {
        return { ok: false, status: 401, text: async () => '{"detail":"expired"}' };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await logoutAccount();
    assert.equal(refreshAttemptedDuringLogout, false, "logoutAccount must pass skipRetry: true and never refresh during logout");
    assert.equal(await loadSession(), null, "logoutAccount must clear opaque session even after 401");

    // 9. Cycle 14 CHRIS HIGH-1: logoutAccount clears session after mid-flight same-user rotation,
    // while preserving cross-user (identified -> opaque user:null & signed-out -> opaque user:null) switches
    await clearSession();
    const makeJwtSeq = (sub, seq) => {
      const body = btoa(JSON.stringify({ sub, seq })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `eyJhbGciOiJIUzI1NiJ9.${body}.sig${seq}`;
    };
    const setupDeferredLogoutFetch = () => {
      let resolveResp = null;
      let notifyStarted = null;
      const started = new Promise((r) => { notifyStarted = r; });
      globalThis.fetch = (url) => {
        if (String(url).includes("/api/auth/logout")) {
          if (notifyStarted) notifyStarted();
          return new Promise((r) => { resolveResp = r; });
        }
        return Promise.resolve({ ok: true, status: 200, text: async () => "{}" });
      };
      return { started, resolve: (res) => resolveResp(res) };
    };

    await saveSession({
      access_token: makeJwtSeq("mob-rot-a", 1),
      refresh_token: "ref-rot-1",
      user: { id: "mob-rot-a", email: "rota@mob.test" },
    });
    const rotFetch = setupDeferredLogoutFetch();
    const rotLogoutTask = logoutAccount();
    await rotFetch.started;
    await saveSession({
      access_token: makeJwtSeq("mob-rot-a", 2),
      refresh_token: "ref-rot-2",
      user: { id: "mob-rot-a", email: "rota@mob.test" },
    });
    rotFetch.resolve({ ok: false, status: 401, text: async () => '{"detail":"old token rotated"}' });
    await rotLogoutTask;
    assert.equal(await loadSession(), null, "Same-user token rotation mid-logout must still clear session cleanly");

    // Identified user switching mid-logout to opaque user:null B must preserve B
    await saveSession({
      access_token: makeFakeJwtC13("mob-id-a"),
      refresh_token: "ref-ida",
      user: { id: "mob-id-a", email: "ida@mob.test" },
    });
    const opaqueFetch = setupDeferredLogoutFetch();
    const opaqueSwitchTask = logoutAccount();
    await opaqueFetch.started;
    await saveSession({ access_token: "opaque-switch-b", refresh_token: "ref-opb", user: null });
    opaqueFetch.resolve({ ok: true, status: 200, text: async () => "{}" });
    await opaqueSwitchTask;
    assert.equal((await loadSession())?.access_token, "opaque-switch-b", "Identified -> opaque B mid-logout must preserve opaque User B");

    // Signed-out logout racing opaque user:null B sign-in must preserve B
    await clearSession();
    const guestOpaqueFetch = setupDeferredLogoutFetch();
    const guestOpaqueTask = logoutAccount();
    await guestOpaqueFetch.started;
    await saveSession({ access_token: "opaque-guest-b", refresh_token: "ref-ogb", user: null });
    guestOpaqueFetch.resolve({ ok: false, status: 401, text: async () => "{}" });
    await guestOpaqueTask;
    assert.equal((await loadSession())?.access_token, "opaque-guest-b", "Signed-out -> opaque B mid-logout must preserve opaque User B");

    // 10. Cycle 17 CHRIS CRITICAL-1 & MEDIUM-1: unrecoverable 401 clears session + notifies session-expired listeners,
    // while createFolder sends `emoji` (matching backend schema) and screens fall back cleanly
    const { createFolder, subscribeSessionExpired } = await import("../api.ts");
    const fsMob = await import("node:fs");
    const pathMob = await import("node:path");
    const { fileURLToPath: f2p } = await import("node:url");
    let expiredEvents = 0;
    const unsubExp = subscribeSessionExpired(() => {
      expiredEvents += 1;
    });
    try {
      // Case A: refresh fails on 401 -> clears session + emits expired
      await clearSession();
      await saveSession({
        access_token: makeFakeJwtC13("mob-del-u1"),
        refresh_token: "ref-del-1",
        user: { id: "mob-del-u1", email: "del1@mob.test" },
      });
      await saveCachedWorkspace({
        user_id: "mob-del-u1",
        items: [{ id: "it-del-1", url: "https://del.mob/1", title: "Del" }],
        folders: [],
        reminders: [],
      });
      globalThis.fetch = async (url) => {
        if (String(url).includes("grant_type=refresh_token")) {
          return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
        }
        return { ok: false, status: 401, text: async () => '{"detail":"deleted"}' };
      };
      const deadWs = await fetchWorkspace();
      assert.equal(deadWs.items.length, 0);
      assert.equal(await loadSession(), null, "Failed refresh after 401 must clear session");
      assert.equal(getMemoryCachedWorkspace(), null);
      assert.ok(expiredEvents >= 1, "Unrecoverable 401 must notify subscribeSessionExpired listeners");

      // Case B: retry still returns 401 after refresh -> clears session + emits expired
      const countBeforeB = expiredEvents;
      await saveSession({
        access_token: makeFakeJwtC13("mob-del-u2"),
        refresh_token: "ref-del-2",
        user: { id: "mob-del-u2", email: "del2@mob.test" },
      });
      globalThis.fetch = async (url) => {
        if (String(url).includes("grant_type=refresh_token")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: makeFakeJwtC13("mob-del-u2"),
              refresh_token: "ref-del-2-next",
              user: { id: "mob-del-u2", email: "del2@mob.test" },
            }),
          };
        }
        return { ok: false, status: 401, text: async () => '{"detail":"deleted on backend"}' };
      };
      const deadApiRes = await apiFetch("/api/items");
      assert.equal(deadApiRes.status, 401);
      assert.equal(await loadSession(), null, "401 even after refresh retry must clear deleted user session");
      assert.ok(expiredEvents > countBeforeB);

      // Case C: createFolder sends `emoji` instead of `icon` and skipClearOn401 preserves session
      await saveSession({
        access_token: makeFakeJwtC13("mob-fld-ok"),
        refresh_token: "",
        user: { id: "mob-fld-ok", email: "fld@mob.test" },
      });
      let capturedFolderBody = null;
      globalThis.fetch = async (_url, init) => {
        capturedFolderBody = init?.body ? JSON.parse(String(init.body)) : null;
        return { ok: true, status: 201, text: async () => '{"id":"f-new","name":"Projects","emoji":"🚀"}' };
      };
      const fldRes = await createFolder("Projects", "🚀");
      assert.equal(fldRes.ok, true);
      assert.equal(capturedFolderBody?.emoji, "🚀");
      assert.equal("icon" in (capturedFolderBody || {}), false);

      globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "{}" });
      const skipClearRes = await apiFetch("/api/test", { skipClearOn401: true });
      assert.equal(skipClearRes.status, 401);
      assert.equal((await loadSession())?.user?.id, "mob-fld-ok", "skipClearOn401 must preserve active session");

      const appRootMob = pathMob.resolve(pathMob.dirname(f2p(import.meta.url)), "../../app");
      for (const rel of ["(tabs)/folders.tsx", "(tabs)/index.tsx", "folder/[id].tsx"]) {
        const src = fsMob.readFileSync(pathMob.join(appRootMob, rel), "utf8");
        assert.match(src, /\.emoji \|\| [^.\n]+\.icon \|\| "📁"/, `Expected emoji fallback in mobile/app/${rel}`);
      }
    } finally {
      unsubExp();
    }
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
    __setStorageBackendsForTests(null);
  }
});

test("19. Cycle 18 LOW-3: signupWithPassword email confirmation yields empty access_token and login.tsx requires non-empty token before tab redirect", async () => {
  const { signupWithPassword } = await import("../api.ts");
  const { clearSession, loadSession, __setStorageBackendsForTests } = await import("../storage.ts");
  const mem = new Map();
  const memBackend = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, String(v)); },
    removeItem: async (k) => { mem.delete(k); },
  };
  __setStorageBackendsForTests({ standard: memBackend, secure: memBackend });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ user: { id: "u-confirm-1", email: "confirm@mob.test" }, access_token: "" }),
  });
  try {
    await clearSession();
    const res = await signupWithPassword("confirm@mob.test", "Secret123!", "ConfirmUser");
    assert.equal(res.ok, true);
    assert.equal(res.data?.access_token, "");
    assert.equal(await loadSession(), null, "Empty access_token signup must not persist a session");
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
    __setStorageBackendsForTests(null);
  }

  const fsMob = await import("node:fs");
  const pathMob = await import("node:path");
  const { fileURLToPath: f2p } = await import("node:url");
  const loginSrc = fsMob.readFileSync(
    pathMob.resolve(pathMob.dirname(f2p(import.meta.url)), "../../app/login.tsx"),
    "utf8",
  );
  assert.match(
    loginSrc,
    /typeof res\.data\?\.access_token === "string" && res\.data\.access_token\.trim\(\)\.length > 0/,
    "mobile/app/login.tsx must require non-empty access_token before redirecting into /(tabs)",
  );
});

test("20. Set A fixes: thumb fallback, social/image/x filters, dynamic reminder time/local-sync, push deactivation, and iOS UI/entitlement guards", async () => {
  const {
    formatRemindTimeAndZone,
    inferMobileContentType,
    matchesItemSearch,
    matchesPlatformFilter,
    resolveMobileThumbUrl,
  } = await import("../itemHelpers.ts");
  const {
    logoutAccount,
    registerPushDevice,
    saveReminder,
    syncRemindersFromServer,
  } = await import("../api.ts");
  const {
    __setStorageBackendsForTests,
    clearSession,
    loadCachedWorkspace,
    loadRegisteredPushDevice,
    saveCachedWorkspace,
    saveSession,
    upsertCachedLinkItem,
  } = await import("../storage.ts");

  // 1. Thumbnail fallback: thumbnail_url -> image_url -> media_items[0], blocking unsafe URLs
  assert.equal(resolveMobileThumbUrl({ image_url: "https://cdn.test/cover.webp" }), "https://cdn.test/cover.webp");
  assert.equal(
    resolveMobileThumbUrl({ media_items: [{ media_url: "https://cdn.test/slide1.jpg" }] }),
    "https://cdn.test/slide1.jpg",
  );
  assert.equal(resolveMobileThumbUrl({ image_url: "javascript:alert(1)" }), "");

  // 2. Content type & platform filter parity with backend/web
  assert.equal(inferMobileContentType({ url: "https://instagram.com/p/abc", platform: "instagram", content_type: "post" }), "social");
  assert.equal(inferMobileContentType({ url: "https://x.com/user/status/1", platform: "twitter", content_type: "link" }), "social");
  assert.equal(
    inferMobileContentType({ url: "https://blog.example/post", platform: "web", embed_type: "none", media_items: ["https://cdn.test/pic.png"] }),
    "image",
  );
  assert.equal(inferMobileContentType({ url: "https://youtu.be/xyz", platform: "youtube", content_type: "link" }), "video");
  assert.equal(matchesPlatformFilter({ platform: "twitter", url: "https://twitter.com/a" }, "x"), true);
  assert.equal(matchesPlatformFilter({ platform: "medium.com", url: "https://medium.com/a" }, "web"), true);
  assert.equal(matchesPlatformFilter({ platform: "instagram", url: "https://instagram.com/a" }, "web"), false);
  assert.equal(
    matchesItemSearch(
      { url: "https://ex.com", title: "Alpha", description: "Bangkok coffee guide", tag_names: ["cafe"] },
      "coffee",
      "Travel",
    ),
    true,
  );
  assert.equal(matchesItemSearch({ url: "https://ex.com", title: "Alpha" }, "Travel", "Travel"), true);

  // 3. planIosLocalNotifications handles LocalSyncOccurrence (`occurrence_at`, `item_url`) and skips done items
  const futureOcc = new Date(Date.now() + 3600_000).toISOString();
  const plannedOcc = planIosLocalNotifications([
    {
      reminder_id: "r-occ-1",
      item_id: "it-occ-1",
      title: "Read later",
      item_url: "https://example.com/read",
      occurrence_at: futureOcc,
      schedule_type: "once",
    },
    {
      id: "r-done",
      item_id: "it-done",
      item_title: "Completed",
      item_status: "done",
      remind_at: futureOcc,
      schedule_type: "once",
    },
  ]);
  assert.equal(plannedOcc.length, 1);
  assert.equal(plannedOcc[0].itemId, "it-occ-1");
  assert.equal(plannedOcc[0].url, "https://example.com/read");

  // 4. Dynamic remind_time & timezone calculation (not hardcoded 18:00:00)
  const testDt = new Date("2026-11-18T02:15:30.000Z");
  const formattedTz = formatRemindTimeAndZone(testDt, "Asia/Bangkok");
  assert.equal(formattedTz.remind_time, "09:15:30");
  assert.equal(formattedTz.timezone, "Asia/Bangkok");

  // 5. Network behaviors: saveReminder dynamic time, syncRemindersFromServer, upsertCachedLinkItem, logout push deactivation
  const mem = new Map();
  const memBackend = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, String(v)); },
    removeItem: async (k) => { mem.delete(k); },
  };
  __setStorageBackendsForTests({ standard: memBackend, secure: memBackend });
  const origFetch = globalThis.fetch;
  const makeJwt = (sub) => {
    const body = btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
  };

  try {
    await clearSession();
    await saveSession({
      access_token: makeJwt("mob-seta-u1"),
      refresh_token: "",
      user: { id: "mob-seta-u1", email: "seta@mob.test" },
    });
    await saveCachedWorkspace({
      user_id: "mob-seta-u1",
      items: [{ id: "it-1", url: "https://example.com/1", title: "Old" }],
      folders: [],
      reminders: [],
    });
    await upsertCachedLinkItem({
      id: "it-1",
      url: "https://example.com/1",
      title: "Refreshed Title",
      image_url: "https://cdn.test/new-cover.webp",
    });
    const afterUpsert = await loadCachedWorkspace();
    assert.equal(afterUpsert.items[0].title, "Refreshed Title");
    assert.equal(afterUpsert.items[0].image_url, "https://cdn.test/new-cover.webp");

    let capturedReminderBody = null;
    const calledPaths = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      calledPaths.push(u);
      if (u.includes("/api/reminders/local-sync")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ios_remote_push_active: false,
            max_slots: 64,
            total_active_rules: 1,
            notifications: [
              {
                reminder_id: "rem-1",
                item_id: "it-1",
                occurrence_at: new Date(Date.now() + 7200_000).toISOString(),
                schedule_type: "once",
                timezone: "Asia/Bangkok",
                title: "Refreshed Title",
                item_url: "https://example.com/1",
              },
            ],
            overdue: [],
            truncated: false,
          }),
        };
      }
      if (u.includes("/api/reminders/it-1") && init?.method === "PUT") {
        capturedReminderBody = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "rem-1", item_id: "it-1" }) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const remSaveRes = await saveReminder("it-1", {
      schedule_type: "every_n_days",
      remind_at: "2026-11-18T02:15:30.000Z",
      timezone: "Asia/Bangkok",
      repeat_every_days: 3,
    });
    assert.equal(remSaveRes.ok, true);
    assert.equal(capturedReminderBody?.remind_time, "09:15:30");
    assert.equal(capturedReminderBody?.timezone, "Asia/Bangkok");

    const syncRes = await syncRemindersFromServer();
    assert.equal(syncRes.fromLocalSync, true);
    assert.equal(syncRes.occurrences.length, 1);

    await registerPushDevice({ platform: "ios", delivery_mode: "remote", push_token: "ExponentPushToken[abc]" });
    assert.equal((await loadRegisteredPushDevice())?.push_token, "ExponentPushToken[abc]");

    calledPaths.length = 0;
    await logoutAccount();
    assert.ok(calledPaths.some((p) => p.includes("/api/devices/deactivate")), "logoutAccount must deactivate registered push device");
    assert.ok(calledPaths.some((p) => p.includes("/api/auth/logout")), "logoutAccount must call /api/auth/logout");
    assert.equal(await loadRegisteredPushDevice(), null);
  } finally {
    globalThis.fetch = origFetch;
    await clearSession();
    __setStorageBackendsForTests(null);
  }

  // 6. Source checks for UI/iOS guards
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  const itemDetailSrc = fs.readFileSync(path.join(mobileRoot, "app/item/[id].tsx"), "utf8");
  assert.match(itemDetailSrc, /resolveMobileThumbUrl\(item\)/);
  assert.match(itemDetailSrc, /st !== "failed"/);
  assert.match(itemDetailSrc, /async function handleClearReminder[\s\S]{0,600}syncRemindersFromServer/);
  assert.match(itemDetailSrc, /KeyboardAvoidingView/);

  const homeSrc = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/index.tsx"), "utf8");
  assert.match(homeSrc, /resolveMobileThumbUrl\(item\)/);
  assert.match(homeSrc, /โฟลเดอร์ของฉัน/);
  assert.match(homeSrc, /ยังไม่ได้ดู/);
  assert.match(homeSrc, /KeyboardAvoidingView/);

  const tabsLayoutSrc = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/_layout.tsx"), "utf8");
  assert.match(tabsLayoutSrc, /useSafeAreaInsets/);

  const profileSrc = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/profile.tsx"), "utf8");
  assert.match(profileSrc, /Platform\.select\(\{\s*ios:\s*"Menlo"/);

  const rootLayoutSrc = fs.readFileSync(path.join(mobileRoot, "app/_layout.tsx"), "utf8");
  assert.match(rootLayoutSrc, /syncRemindersFromServer\(Array\.isArray\(ws\.reminders\)/);

  const entPath = path.join(mobileRoot, "ios/SharelyJustSaveIt/SharelyJustSaveIt.entitlements");
  if (fs.existsSync(entPath)) {
    const entSrc = fs.readFileSync(entPath, "utf8");
    assert.equal(entSrc.includes("aps-environment"), false, "SharelyJustSaveIt.entitlements must not include aps-environment for Free Apple ID builds");
  }
});

test("21. SHARE_AND_DISPLAY_ISSUES_SUMMARY parity: title/caption cleaning, feed link warning, album dedup, video resolver, and Android ACTION_SEND plugin", async () => {
  const {
    deriveVideoEmbedInfo,
    formatCardDisplayTitle,
    formatPostDetailTitleAndDesc,
    getPreviewMediaImages,
    getSocialPostLinkWarning,
    isGenericOrNoisyTitle,
    resolveAllowlistedDirectVideoUrl,
    resolveMobilePlayUrl,
    stripBalancedCaptionQuotes,
  } = await import("../itemHelpers.ts");
  const { previewLinkUrl, resolveItemVideo } = await import("../api.ts");

  // 1. (2.2 & 2.3) Clean generic/noisy titles, YouTube notification prefix, FB stats, and IG trailing `".`
  assert.equal(stripBalancedCaptionQuotes('"คาเฟ่เปิดใหม่ย่านอารีย์".'), "คาเฟ่เปิดใหม่ย่านอารีย์");
  assert.equal(isGenericOrNoisyTitle("Instagram", "instagram", "https://www.instagram.com/reel/ABC/"), true);
  assert.equal(isGenericOrNoisyTitle("Watch trending videos for you | TikTok", "tiktok", "https://www.tiktok.com/@a/video/1"), true);

  const ytFormatted = formatPostDetailTitleAndDesc({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    platform: "youtube",
    title: "(584) สรุปเทคนิคจัดโต๊ะทำงาน 2026 - YouTube",
    description: "คลิปสอนจัดโต๊ะทำงานสไตล์มินิมอล",
  });
  assert.equal(ytFormatted.displayTitle, "สรุปเทคนิคจัดโต๊ะทำงาน 2026");

  const igFormatted = formatPostDetailTitleAndDesc({
    url: "https://www.instagram.com/reel/DfzabQmDTBe/",
    platform: "instagram",
    title: "Instagram",
    description: '1,240 likes, 18 comments - bkkcafe on November 15, 2026: "ร้านกาแฟเปิดใหม่สุขุมวิท! มุมถ่ายรูปสวยมาก\nเปิดทุกวัน 08:00-17:00".',
  });
  assert.equal(igFormatted.displayTitle, "ร้านกาแฟเปิดใหม่สุขุมวิท!");
  assert.equal(igFormatted.displayDesc.endsWith('".'), false);

  const fbDupFormatted = formatPostDetailTitleAndDesc({
    url: "https://www.facebook.com/share/p/1CT7y7W7h3/",
    platform: "facebook",
    title: "1.2 หมื่น ยอดดู · 540 ความรู้สึก | แจกพิกัดที่เที่ยวหน้าหนาวเชียงใหม่ ครบจบในโพสต์เดียว | TravelTH | Facebook",
    description: "แจกพิกัดที่เที่ยวหน้าหนาวเชียงใหม่ ครบจบในโพสต์เดียว",
  });
  assert.equal(fbDupFormatted.displayTitle, "แจกพิกัดที่เที่ยวหน้าหนาวเชียงใหม่ ครบจบในโพสต์เดียว");
  assert.equal(formatCardDisplayTitle({ url: "https://x.com/u/status/1", title: "x.com", description: "อัปเดตข่าวเทคโนโลยีวันนี้!" }), "อัปเดตข่าวเทคโนโลยีวันนี้!");

  // 2. (1.2 & 1.4) Feed link warning & generic shared title scrubbing
  assert.ok(getSocialPostLinkWarning("https://www.instagram.com/"));
  assert.ok(getSocialPostLinkWarning("https://www.facebook.com/"));
  assert.ok(getSocialPostLinkWarning("https://www.tiktok.com/foryou"));
  assert.equal(getSocialPostLinkWarning("https://www.instagram.com/reel/DYowlO2v1ww/"), null);
  assert.equal(getSocialPostLinkWarning("https://www.facebook.com/share/p/1CT7y7W7h3/"), null);
  assert.equal(getSocialPostLinkWarning("https://vt.tiktok.com/ZS12345/"), null);

  const genericShared = extractSharedUrlFromIntent("Instagram https://www.instagram.com/reel/DYowlO2v1ww/");
  assert.equal(genericShared?.url, "https://www.instagram.com/reel/DYowlO2v1ww/");
  assert.equal(genericShared?.title, "", "Generic platform title in share text must be scrubbed to empty");

  // 3. (3.1, 3.3, 3.4) Multi-image album deduplication, uncropped replacement, and non-video FB post.php rejection
  const igSingleDedup = getPreviewMediaImages({
    media_items: [
      "https://scontent.cdninstagram.com/v/t51.29350-15/465001122_111_222_n.jpg?stp=c0.180.720.720a_dst-jpg_s640x640",
      "https://instagram.fbkk5-1.fna.fbcdn.net/v/t51.29350-15/465001122_111_222_n.jpg?stp=dst-jpg_e35_p1080x1080",
    ],
  });
  assert.equal(igSingleDedup.length, 1, "Same Meta asset across CDN hosts must deduplicate to 1 image");
  assert.equal(igSingleDedup[0].includes("stp=c0.180"), false, "Uncropped Meta image must replace cropped og:image");

  const legacyWebpDedup = getPreviewMediaImages({
    media_items: [
      "https://pnqjamwhgzqzvpiytcln.supabase.co/storage/v1/object/public/thumbnails/a1b2c3d4e5f600112233.webp",
      "https://scontent.cdninstagram.com/v/t51.2885-15/999_111_222_n.jpg?stp=c0.120.640.640_s640x640",
      "https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=123",
    ],
  });
  assert.equal(legacyWebpDedup.length, 1, "Legacy cropped s640x640 and lookaside duplicates behind .webp cover must be filtered");

  const fbAlbumVideoInfo = deriveVideoEmbedInfo({
    url: "https://www.facebook.com/share/p/1CT7y7W7h3/",
    platform: "facebook",
    content_type: "post",
    embed_url: "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fp%2F1CT7y7W7h3%2F",
  });
  assert.equal(fbAlbumVideoInfo.embedUrl, null, "Facebook plugins/post.php photo album must not be treated as playable video");

  // 4. (4.1 & 4.2) IG /reels/ & direct .mp4 video resolver
  const igReelsVideoInfo = deriveVideoEmbedInfo({
    url: "https://www.instagram.com/reels/DYowlO2v1ww/",
    platform: "instagram",
    content_type: "video",
  });
  assert.equal(igReelsVideoInfo.embedUrl, "https://www.instagram.com/reel/DYowlO2v1ww/embed");
  assert.equal(igReelsVideoInfo.isVertical, true);
  assert.equal(
    resolveAllowlistedDirectVideoUrl("https://scontent.cdninstagram.com/v/t66.30100-16/reel.mp4"),
    "https://scontent.cdninstagram.com/v/t66.30100-16/reel.mp4",
  );
  assert.equal(resolveAllowlistedDirectVideoUrl("https://evil.example.com/reel.mp4"), null);

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/items/it-reel-1/video")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            item_id: "it-reel-1",
            video_url: "https://scontent.cdninstagram.com/v/t66.30100-16/1000_n.mp4",
          }),
        };
      }
      if (u.includes("/api/preview")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            url: "https://www.instagram.com/p/DfwmFqjEuGf/",
            title: "อัลบั้มคาเฟ่เชียงใหม่",
            platform: "instagram",
            media_items: ["https://cdn.test/1.jpg", "https://cdn.test/2.jpg"],
          }),
        };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const vidRes = await resolveItemVideo("it-reel-1");
    assert.equal(vidRes.ok, true);
    assert.equal(vidRes.data?.video_url, "https://scontent.cdninstagram.com/v/t66.30100-16/1000_n.mp4");

    const pvRes = await previewLinkUrl("https://www.instagram.com/p/DfwmFqjEuGf/");
    assert.equal(pvRes.ok, true);
    assert.equal(pvRes.data?.media_items?.length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 5. Android Share Intent Config Plugin verification
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const pluginMod = req("../../plugins/withAndroidShareIntent.js");
  const sampleMainActivity = `package com.woraset.justsaveit
import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`;
  const injected = pluginMod.injectAndroidShareIntentIntoKotlin(sampleMainActivity);
  assert.ok(injected.includes("intent = rewriteShareSendIntent(intent)"));
  assert.ok(injected.includes("android.content.Intent.ACTION_SEND"));
  assert.ok(injected.includes('Uri.parse("sharely://share")'));
  assert.equal(
    pluginMod.injectAndroidShareIntentIntoKotlin(injected),
    injected,
    "Android share intent injection must be idempotent",
  );

  // 6. Mobile Error 153 fix (resolveMobilePlayUrl) & always-visible Folder selector + inline creation in Quick Save
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://youtu.be/oGllKRE1oFA" },
      "https://www.youtube.com/embed/oGllKRE1oFA?feature=oembed",
    ),
    "https://www.youtube.com/watch?v=oGllKRE1oFA",
    "YouTube embed URL must convert to watch?v= when opened in SFSafariViewController to prevent Error 153",
  );
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" },
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ),
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  );
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://vimeo.com/123456" },
      "https://player.vimeo.com/video/123456",
    ),
    "https://vimeo.com/123456",
  );
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://www.instagram.com/reels/DYowlO2v1ww/" },
      "https://www.instagram.com/reel/DYowlO2v1ww/embed",
      "https://scontent.cdninstagram.com/v/t66.30100-16/1000_n.mp4",
    ),
    "https://scontent.cdninstagram.com/v/t66.30100-16/1000_n.mp4",
  );
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://www.instagram.com/reels/DfzqfsjyQkb/" },
      "https://www.instagram.com/reel/DfzqfsjyQkb/embed",
      null,
    ),
    "https://www.instagram.com/reels/DfzqfsjyQkb/",
  );
  assert.equal(
    resolveMobilePlayUrl(
      { url: "https://www.tiktok.com/@creator/video/7703529186639547656" },
      "https://www.tiktok.com/embed/v2/7703529186639547656",
    ),
    "https://www.tiktok.com/player/v1/7703529186639547656?autoplay=1&music_info=0&description=0&rel=0",
  );

  const fs = await import("node:fs");
  const indexSrc = fs.readFileSync(new URL("../../app/(tabs)/index.tsx", import.meta.url), "utf8");
  assert.equal(indexSrc.includes("folders.length > 0 ?"), false, "Quick Save folder section must remain visible when 0 folders exist");
  assert.ok(indexSrc.includes("+ สร้างโฟลเดอร์ใหม่"));
  assert.ok(indexSrc.includes("handleInlineCreateFolder"));

  // 7. EXPO_PUBLIC_API_BASE_URL override (for local LAN backend testing) with safe Render fallback
  const prevEnvBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  try {
    process.env.EXPO_PUBLIC_API_BASE_URL = "http://10.44.163.236:8000/";
    const apiLocalMod = await import(`../api.ts?case=local_${Date.now()}`);
    assert.equal(apiLocalMod.API_BASE, "http://10.44.163.236:8000");

    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const apiDefaultMod = await import(`../api.ts?case=default_${Date.now()}`);
    assert.equal(apiDefaultMod.API_BASE, "https://just-save-it-api.onrender.com");
  } finally {
    if (prevEnvBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = prevEnvBase;
  }

  // 8. Profiles/pages saveable & non-video YT post / TT photo contentType classification
  const { inferMobileContentType, isPlayableVideoEmbed } = await import("../itemHelpers.ts");
  assert.equal(getSocialPostLinkWarning("https://www.facebook.com/Google"), null);
  assert.equal(getSocialPostLinkWarning("https://www.facebook.com/profile.php?id=1000123456"), null);
  assert.equal(getSocialPostLinkWarning("https://www.instagram.com/instagram/"), null);
  assert.equal(getSocialPostLinkWarning("https://www.tiktok.com/@tiktok"), null);
  assert.ok(getSocialPostLinkWarning("https://www.facebook.com/watch"));
  assert.ok(getSocialPostLinkWarning("https://www.instagram.com/explore/"));

  assert.equal(inferMobileContentType({ url: "https://www.youtube.com/post/Ugkx123", platform: "youtube" }), "social");
  assert.equal(inferMobileContentType({ url: "https://www.youtube.com/@Google", platform: "youtube" }), "social");
  assert.equal(inferMobileContentType({ url: "https://www.youtube.com/@Google/shorts", platform: "youtube" }), "social");
  assert.equal(inferMobileContentType({ url: "https://www.youtube.com/shorts/AbCdEf12345", platform: "youtube" }), "video");
  assert.equal(inferMobileContentType({ url: "https://www.tiktok.com/@creator/photo/738811", platform: "tiktok" }), "social");
  assert.equal(
    inferMobileContentType({
      url: "https://vt.tiktok.com/ZSr999/",
      canonical_url: "https://www.tiktok.com/@creator/photo/738811",
      content_type: "post",
      platform: "tiktok",
    }),
    "social",
  );
  assert.equal(
    isPlayableVideoEmbed("https://www.tiktok.com/embed/v2/738811", {
      url: "https://vt.tiktok.com/ZSr999/",
      canonical_url: "https://www.tiktok.com/@creator/photo/738811",
    }),
    false,
  );
  assert.equal(inferMobileContentType({ url: "https://www.tiktok.com/@creator", platform: "tiktok" }), "social");
  assert.equal(inferMobileContentType({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", platform: "youtube" }), "video");

  const mobFbProf = formatPostDetailTitleAndDesc({
    url: "https://www.facebook.com/Google",
    platform: "facebook",
    title: "Google",
    description: "Google. 29M likes · 100K talking about this. Organizing the world's information.",
  });
  assert.equal(mobFbProf.displayTitle, "Google");
  assert.equal(mobFbProf.displayDesc, "Organizing the world's information.");

  const mobIgProf = formatPostDetailTitleAndDesc({
    url: "https://www.instagram.com/travel_th/",
    platform: "instagram",
    title: "Travel TH (@travel_th) • รูปและวิดีโอ Instagram",
    description: "ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์ - ดูรูปภาพและวิดีโอบน Instagram จาก Travel TH (@travel_th)",
  });
  assert.equal(mobIgProf.displayTitle, "Travel TH (@travel_th)");
  assert.equal(mobIgProf.displayDesc, "ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์");

  assert.equal(
    formatCardDisplayTitle({
      url: "https://www.tiktok.com/@creator",
      platform: "tiktok",
      title: "Cafe Guide TH (@creator)",
      description: "Daily coffee & cafe reviews in Thailand for fellow coffee lovers",
    }),
    "Cafe Guide TH (@creator)",
  );
});

test("Sherlink Figma: saveAiConfig/loadAiConfig clearing on clearSession and Discord buildMobileInvitePayload", async () => {
  const {
    clearSession,
    loadAiConfig,
    saveAiConfig,
    saveSession,
    __setStorageBackendsForTests,
  } = await import("../storage.ts");
  const { API_BASE, buildMobileInvitePayload, resolveFolderCoverUrl } = await import("../api.ts");

  const stdMem = new Map();
  const secMem = new Map();
  __setStorageBackendsForTests({
    standard: {
      getItem: async (k) => (stdMem.has(k) ? stdMem.get(k) : null),
      setItem: async (k, v) => {
        stdMem.set(k, String(v));
      },
      removeItem: async (k) => {
        stdMem.delete(k);
      },
    },
    secure: {
      getItem: async (k) => (secMem.has(k) ? secMem.get(k) : null),
      setItem: async (k, v) => {
        secMem.set(k, String(v));
      },
      removeItem: async (k) => {
        secMem.delete(k);
      },
    },
  });

  try {
    await clearSession();
    await saveAiConfig({
      provider: "byok",
      vendor: "openai",
      model: "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test-mobile-secret",
    });

    const loaded = await loadAiConfig();
    assert.equal(loaded.provider, "byok");
    assert.equal(loaded.vendor, "openai");
    assert.equal(loaded.model, "gpt-4o-mini");
    assert.equal(loaded.base_url, "https://api.openai.com/v1");
    assert.equal(loaded.api_key, "sk-test-mobile-secret");

    await clearSession();
    const afterClear = await loadAiConfig();
    assert.equal(afterClear.provider, "built-in");
    assert.equal(afterClear.api_key, "");
    assert.equal(afterClear.base_url, "");

    // Direct cross-account switch via saveSession() must also wipe previous user's BYOK key (CHRIS H-2)
    await saveSession({
      access_token: "tok-a",
      refresh_token: "ref-a",
      user: { id: "uid-user-a", email: "a@sherlink.app" },
    });
    await saveAiConfig({
      provider: "byok",
      vendor: "openai",
      model: "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-user-a-secret",
    });
    await saveSession({
      access_token: "tok-b",
      refresh_token: "ref-b",
      user: { id: "uid-user-b", email: "b@sherlink.app" },
    });
    const afterSwitch = await loadAiConfig();
    assert.equal(afterSwitch.provider, "built-in");
    assert.equal(afterSwitch.api_key, "");
  } finally {
    await clearSession();
    __setStorageBackendsForTests(null);
  }

  assert.equal(resolveFolderCoverUrl("/local-media/thumbnails/abc.webp"), `${API_BASE}/local-media/thumbnails/abc.webp`);
  assert.equal(resolveFolderCoverUrl("./assets/covers/coffee.png"), "https://just-save-it-web.onrender.com/assets/covers/coffee.png");
  assert.equal(resolveFolderCoverUrl("javascript:alert(1)"), "");

  assert.deepEqual(buildMobileInvitePayload("viewer"), {
    role: "viewer",
    expires_in_days: 7,
  });
  assert.deepEqual(buildMobileInvitePayload("editor"), {
    role: "editor",
    expires_in_days: 7,
  });
  assert.deepEqual(
    buildMobileInvitePayload({
      role: "viewer",
      expires_in_minutes: 30,
      max_uses: 5,
    }),
    {
      role: "viewer",
      expires_in_minutes: 30,
      max_uses: 5,
    },
  );
  assert.deepEqual(
    buildMobileInvitePayload({
      role: "editor",
      never_expires: true,
    }),
    {
      role: "editor",
      never_expires: true,
    },
  );
  assert.deepEqual(
    buildMobileInvitePayload({
      role: "editor",
      never_expires: false,
      expires_in_days: 1,
      max_uses: null,
    }),
    {
      role: "editor",
      expires_in_days: 1,
    },
  );
});
