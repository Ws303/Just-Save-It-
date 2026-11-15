import test from "node:test";
import assert from "node:assert/strict";

import { resolveMediaThumbUrl } from "../src/components/icons.js";
import {
  buildMonthCalendarDays,
  stepYearMonth,
  formatThaiMonthYear,
  isQaModeEnabled,
  resolveDefaultViewportMode,
  store,
} from "../src/state/store.js";
import { apiClient, buildAiHeadersAndConfig } from "../src/services/apiClient.js";
import { renderSaveAndReminderSheets } from "../src/screens/links.js";
import { renderWebView } from "../src/screens/webExtension.js";
import { renderInviteLandingScreen } from "../src/screens/auth.js";
import { renderAiPanelBody } from "../src/screens/ai.js";
import { renderTestbedPanel } from "../src/screens/testbed.js";

test("Dynamic calendar handles leap years, year rollover, leading weekdays, and Bangkok past dates", () => {
  assert.equal(stepYearMonth("2026-12", 1), "2027-01");
  assert.equal(stepYearMonth("2027-01", -1), "2026-12");
  assert.equal(formatThaiMonthYear("2026-11"), "พฤศจิกายน 2569");

  const leapFeb = buildMonthCalendarDays("2024-02", "2024-02-15");
  assert.equal(leapFeb.days.length, 29);
  assert.equal(leapFeb.leadingEmpty, 4); // 2024-02-01 is Thursday (4)
  assert.equal(leapFeb.days[13].isPast, true);
  assert.equal(leapFeb.days[14].isToday, true);
  assert.equal(leapFeb.days[14].isPast, false);
  assert.equal(leapFeb.days[15].isPast, false);

  const nonLeapFeb = buildMonthCalendarDays("2025-02", "2025-02-10");
  assert.equal(nonLeapFeb.days.length, 28);

  const remSheetHtml = renderSaveAndReminderSheets({
    data: store.state.data,
    ui: {
      activeSheet: {
        type: "reminder",
        linkId: "l-1",
        yearMonth: "2026-12",
        monthLabel: formatThaiMonthYear("2026-12"),
        day: 20,
        time: "18:00",
        scheduleType: "once",
      },
    },
  });
  assert.match(remSheetHtml, /ธันวาคม 2569/);
  assert.match(remSheetHtml, /figma-cal-day empty/);
});

test("rebuildNotificationsFromWorkspace handles reminderDate, shared folders, AI summaries, and read state", () => {
  store.resetSeed();
  const sampleLink = store.state.data.links[0];
  sampleLink.reminderDate = "2026-11-25";
  sampleLink.reminderTime = "19:30";
  sampleLink.reminder = "25 พ.ย. · 19:30";
  sampleLink.aiSummary = "สรุปสำคัญสำหรับทดสอบ";

  store.rebuildNotificationsFromWorkspace();
  const remNotif = store.state.data.notifications.find((n) => n.id.startsWith(`notif-rem-${sampleLink.id}`));
  const aiNotif = store.state.data.notifications.find((n) => n.id === `notif-ai-${sampleLink.id}`);
  assert.ok(remNotif, "Reminder notification must be generated from reminderDate");
  assert.ok(aiNotif, "AI summary notification must be generated");
  assert.equal(remNotif.unread, true);

  store.markNotificationRead(remNotif.id);
  const afterMark = store.state.data.notifications.find((n) => n.id === remNotif.id);
  assert.equal(afterMark.unread, false);
});

test("resolveMediaThumbUrl extracts safe URLs from all unfurl/item thumbnail shapes and blocks unsafe schemes", () => {
  assert.equal(resolveMediaThumbUrl({ thumbnail_url: "https://cdn.example.com/a.jpg" }), "https://cdn.example.com/a.jpg");
  assert.equal(
    resolveMediaThumbUrl({ media_items: [{ thumbnail_url: "https://cdn.example.com/thumb.webp" }] }),
    "https://cdn.example.com/thumb.webp"
  );
  assert.equal(
    resolveMediaThumbUrl({ media_items: ["https://cdn.example.com/direct.png"] }),
    "https://cdn.example.com/direct.png"
  );
  assert.equal(resolveMediaThumbUrl({ thumbnail_url: "javascript:alert(1)" }), "");
});

test("createLink preserves explicit folderId: null and patchLink removes from folder without deleting item", async () => {
  store.resetSeed();
  store.state.api.mode = "mock";
  const initialQuota = store.state.data.freeQuotaRemaining;

  const created = await apiClient.createLink({
    url: "https://example.com/uncat-post",
    title: "ลิงก์ไม่ใส่โฟลเดอร์",
    folderId: null,
  });
  assert.ok(created);
  assert.equal(created.folderId, null);
  assert.equal(store.state.data.freeQuotaRemaining, initialQuota);

  const firstFolderId = store.state.data.folders[0].id;
  await apiClient.patchLink(created.id, { folderId: firstFolderId });
  assert.equal(store.state.data.links.find((l) => l.id === created.id).folderId, firstFolderId);

  await apiClient.patchLink(created.id, { folderId: null });
  const stillExists = store.state.data.links.find((l) => l.id === created.id);
  assert.ok(stillExists, "Remove from folder must not delete link");
  assert.equal(stillExists.folderId, null);
});

test("clearSession({ clearWorkspace: true }) prevents seed leakage", () => {
  store.resetSeed();
  assert.ok(store.state.data.links.length > 0);
  store.clearSession({ redirectToLogin: true, clearWorkspace: true });
  assert.equal(store.state.data.links.length, 0);
  assert.equal(store.state.data.folders.length, 0);
  assert.equal(store.state.data.notifications.length, 0);
  assert.equal(store.state.data.user.isAuthenticated, false);
});

test("QA quarantine & responsive viewport detection behave deterministically", () => {
  assert.equal(isQaModeEnabled({ location: { search: "", hash: "" } }), false);
  assert.equal(isQaModeEnabled({ location: { search: "?foo=bar", hash: "#home" } }), false);
  assert.equal(isQaModeEnabled({ location: { search: "?qa=1", hash: "" } }), true);
  assert.equal(isQaModeEnabled({ location: { search: "", hash: "#qa" } }), true);

  assert.equal(resolveDefaultViewportMode({ innerWidth: 1440 }), "web");
  assert.equal(resolveDefaultViewportMode({ innerWidth: 1024 }), "web");
  assert.equal(resolveDefaultViewportMode({ innerWidth: 390 }), "mobile");
  assert.equal(resolveDefaultViewportMode(undefined), "mobile");

  // Without browser window.location?qa=1, renderTestbedPanel must return empty string
  store.resetSeed();
  assert.equal(renderTestbedPanel(store.state), "");
});

test("Desktop PC views (Cherry split auth, 2-col home, 2-card link detail) & invite preview invalid state render cleanly", () => {
  store.resetSeed();
  store.state.data.user.isAuthenticated = false;
  store.state.ui.screen = "login";
  store.state.ui.viewportMode = "web";
  const authHtml = renderWebView(store.state);
  assert.match(authHtml, /class="pc-auth-shell"/);
  assert.match(authHtml, /Sharely/);

  store.resetSeed();
  store.state.data.user.isAuthenticated = true;
  store.state.ui.screen = "home";
  store.state.ui.pcSection = "home";
  store.state.ui.viewportMode = "web";
  const pcHomeHtml = renderWebView(store.state);
  assert.match(pcHomeHtml, /class="pc-shell"/);
  assert.match(pcHomeHtml, /class="pc-sidebar"/);
  assert.match(pcHomeHtml, /class="pc-main"/);

  store.state.ui.screen = "linkDetail";
  store.state.ui.pcSection = "linkDetail";
  store.state.ui.activeLinkId = store.state.data.links[0].id;
  const pcDetailHtml = renderWebView(store.state);
  assert.match(pcDetailHtml, /class="pc-detail-stage"/);
  assert.match(pcDetailHtml, /data-link-nav="-1"/);
  assert.match(pcDetailHtml, /data-link-nav="1"/);

  const expiredInviteHtml = renderInviteLandingScreen({
    data: store.state.data,
    ui: {
      invitePreview: {
        valid: false,
        reason: "expired",
        folder_name: "คาเฟ่ลับอารีย์",
        inviter_name: "Fah",
        item_count: 5,
        role: "editor",
      },
    },
  });
  assert.match(expiredInviteHtml, /หมดอายุแล้ว/);
  assert.match(expiredInviteHtml, /disabled/);
});

test("BYOK AI panel never keeps API key disabled by stale keyless flag and sends X-AI-Key", () => {
  const prevConfig = { ...store.state.data.aiConfig };
  try {
    store.state.data.aiConfig = {
      provider: "OpenAI",
      model: "GPT-4o mini",
      endpointUrl: "",
      keyless: true, // simulate stale flag before provider reset
      apiKey: "sk-test-byok-1234",
      connected: false,
    };
    const panelHtml = renderAiPanelBody(store.state);
    assert.ok(!/data-bind-ai-key="1"[\s\S]{0,10}disabled/.test(panelHtml), "BYOK API key input must not be disabled");
    const built = buildAiHeadersAndConfig();
    assert.equal(built.headers["X-AI-Provider"], "byok");
    assert.equal(built.headers["X-AI-Key"], "sk-test-byok-1234");
    assert.equal(built.aiConfigBody.api_key, "sk-test-byok-1234");
  } finally {
    store.state.data.aiConfig = prevConfig;
  }
});


test("summarizeLink decrements freeQuotaRemaining only for Built-in Free provider", async () => {
  store.resetSeed();
  const prevMode = store.state.api.mode;
  store.state.api.mode = "mock";
  try {
    const target = store.state.data.links[0];
    target.aiSummary = "";
    store.state.data.freeQuotaRemaining = 12;
    store.state.data.aiConfig = {
      ...store.state.data.aiConfig,
      provider: "Built-in Free (Server)",
      model: "gemini-3.1-flash-lite",
      keyless: true,
      apiKey: "",
    };

    const builtinRes = await apiClient.summarizeLink(target.id, { forceRefresh: true });
    assert.equal(builtinRes.ok, true);
    assert.equal(store.state.data.freeQuotaRemaining, 11);

    store.state.data.aiConfig = {
      ...store.state.data.aiConfig,
      provider: "OpenAI",
      model: "gpt-4.1-mini",
      keyless: false,
      apiKey: "sk-test-byok",
    };
    const byokRes = await apiClient.summarizeLink(target.id, { forceRefresh: true });
    assert.equal(byokRes.ok, true);
    assert.equal(store.state.data.freeQuotaRemaining, 11);
  } finally {
    store.state.api.mode = prevMode;
  }
});
