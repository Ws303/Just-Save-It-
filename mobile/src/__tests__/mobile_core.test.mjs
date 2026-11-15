import test from "node:test";
import assert from "node:assert/strict";

import { planIosLocalNotifications } from "../notifications.ts";
import { extractInviteTokenFromUrl, extractSharedUrlFromIntent } from "../shareIntent.ts";
import {
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  loadOfflineQueue,
  setOfflineQueue,
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
