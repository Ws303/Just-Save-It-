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
  loadOfflineQueue,
  recordAuthDebugEvent,
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
