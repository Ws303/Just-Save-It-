import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { planIosLocalNotifications } from "../notifications.ts";
import {
  extractInviteTokenFromUrl,
  extractSharedUrlFromIntent,
  parseOAuthCallbackUrl,
} from "../shareIntent.ts";
import {
  buildBoundedExportPayloadJson,
  classifyQueueFlushStatus,
  clearAuthDebugEvents,
  clearSession,
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  getAuthDebugEvents,
  getMemoryCachedWorkspace,
  getThemePageBg,
  loadCachedWorkspace,
  loadOfflineQueue,
  recordAuthDebugEvent,
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
  apiFetch,
  buildPkceChallengePair,
  completeOAuthWithTokens,
  deleteLinkItem,
  exchangeOAuthCode,
  fetchWorkspace,
  prepareGoogleOAuthUrl,
  sha256Base64Url,
} = await import("../api.ts");

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
    items: [{ id: "stale-1", title: "Stale", normalized_url: "https://stale.test", domain: "stale.test", is_favorite: false, created_at: "2026-11-16T00:00:00Z" }],
    folders: [],
    reminders: [],
  });
  assert.equal(getMemoryCachedWorkspace()?.items.length, 1);

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
