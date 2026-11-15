import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { planIosLocalNotifications } from "../notifications.ts";
import { extractInviteTokenFromUrl, extractSharedUrlFromIntent } from "../shareIntent.ts";
import {
  buildBoundedExportPayloadJson,
  classifyQueueFlushStatus,
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  getThemePageBg,
  loadOfflineQueue,
  saveThemeMode,
  setOfflineQueue,
  subscribeThemeMode,
} from "../storage.ts";

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
