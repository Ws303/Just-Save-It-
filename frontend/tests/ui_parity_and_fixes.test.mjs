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

test("Login CSS avoids overlapping password input/toggle and enforces >=28px touch targets", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const pwToggleBlock = css.match(/\.figma-pw-toggle\s*\{[^}]*\}/)?.[0] || "";
  assert.ok(!/position:\s*absolute/.test(pwToggleBlock), "figma-pw-toggle must sit as flex sibling, not absolute overlap");
  assert.match(pwToggleBlock, /min-height:\s*(?:3[2-9]|[4-9]\d)px/);
  const inlineBlock = css.match(/\.figma-inline-link,\s*\.figma-text-link\s*\{[^}]*\}/)?.[0] || "";
  assert.match(inlineBlock, /min-height:\s*(?:3[0-9]|[4-9]\d)px/);
});

test("[L-NEW-1 & L-NEW-2] selectAiProvider clears apiKey/lastTestedAt and dismissAiSummaryModal bumps aiRequestId", async () => {
  const { readFileSync } = await import("node:fs");
  const prevConfig = { ...store.state.data.aiConfig };
  const prevReqId = store.state.ui.aiRequestId || 0;
  try {
    store.state.data.aiConfig = {
      ...store.state.data.aiConfig,
      provider: "OpenAI",
      apiKey: "sk-old-openai-key",
      lastTestedAt: "2026-11-15T10:00:00Z",
      lastTestError: "Old error",
      connected: true,
    };
    store.selectAiProvider("Anthropic");
    assert.equal(store.state.data.aiConfig.provider, "Anthropic");
    assert.equal(store.state.data.aiConfig.apiKey, "");
    assert.equal(store.state.data.aiConfig.lastTestedAt, null);
    assert.equal(store.state.data.aiConfig.lastTestError, null);
    assert.equal(store.state.data.aiConfig.connected, false);

    store.state.ui.aiConfirmModalOpen = true;
    store.state.ui.aiSummaryStatus = "loading";
    store.dismissAiSummaryModal();
    assert.equal(store.state.ui.aiConfirmModalOpen, false);
    assert.equal(store.state.ui.aiSummaryStatus, "idle");
    assert.equal(store.state.ui.aiRequestId, prevReqId + 1);

    const mainSrc = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    assert.match(mainSrc, /if \(e\.key !== "Escape"\)[\s\S]{0,400}store\.dismissAiSummaryModal\(\)/);
    assert.match(mainSrc, /if \(d\.selectAiProvider\)[\s\S]{0,120}store\.selectAiProvider\(d\.selectAiProvider\)/);
  } finally {
    store.state.data.aiConfig = prevConfig;
  }
});

test("Extension API defaults to Render Cloud, supports localhost preset, fixes status & summary_th fields", async () => {
  const { createRequire } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const extApi = require("../../extension/api.js");

  assert.equal(extApi.DEFAULT_BACKEND_URL, "https://just-save-it-api.onrender.com");
  assert.equal(extApi.BACKEND_PRESETS.cloud, "https://just-save-it-api.onrender.com");
  assert.equal(extApi.BACKEND_PRESETS.local, "http://127.0.0.1:8000");
  assert.equal(extApi.isLocalBackendUrl("http://127.0.0.1:8000"), true);
  assert.equal(extApi.isLocalBackendUrl("http://localhost:8000"), true);
  assert.equal(extApi.isLocalBackendUrl("https://just-save-it-api.onrender.com"), false);
  assert.equal(extApi.normalizeBackendUrl("localhost:8000"), "http://localhost:8000");
  assert.equal(extApi.normalizeBackendUrl(""), "https://just-save-it-api.onrender.com");

  const parsed = extApi.formatAiSummaryResponse({
    summary_th: "• สรุปไทย",
    suggested_tags: ["dev", "ai"],
  });
  assert.deepEqual(parsed, { summary: "• สรุปไทย", tags: ["dev", "ai"] });

  const popupHtml = readFileSync(new URL("../../extension/popup.html", import.meta.url), "utf8");
  assert.ok(!/value="reading"/.test(popupHtml), "Extension statusSelect must not use invalid 'reading' status");
  assert.match(popupHtml, /value="todo"/);
  assert.match(popupHtml, /id="tokenLoginInput"/);
  assert.match(popupHtml, /id="webConnectBtn"/);
  assert.match(popupHtml, /id="tabRecentBtn"/);

  assert.equal(extApi.isSaveableHttpUrl("https://example.com"), true);
  assert.equal(extApi.isSaveableHttpUrl("chrome://extensions"), false);
  await extApi.enqueueOfflineSave({ url: "https://example.com/offline-1", title: "Offline Item" });
  const q1 = await extApi.getOfflineQueue();
  assert.equal(q1.length, 1);
  const flushed = await extApi.flushOfflineQueue(async () => ({ id: "ok" }));
  assert.equal(flushed.flushed, 1);
  assert.equal(flushed.remaining, 0);
});

test("Web Push helper decodes VAPID key, deactivates safely, and Profile renders Extension token copy", async () => {
  const { urlBase64ToUint8Array, disableWebPush } = await import("../src/services/pushClient.js");
  const { renderProfileBody, renderSecurityBody } = await import("../src/screens/profile.js");

  const raw65 = new Uint8Array(65);
  raw65[0] = 0x04;
  raw65[64] = 0x7f;
  const b64url = Buffer.from(raw65).toString("base64url");
  const decoded = urlBase64ToUint8Array(b64url);
  assert.equal(decoded.length, 65);
  assert.equal(decoded[0], 0x04);
  assert.equal(decoded[64], 0x7f);

  let capturedDeact = null;
  await disableWebPush({
    deactivateDevice: async (payload) => {
      capturedDeact = payload;
      return { ok: true };
    },
  });
  assert.deepEqual(capturedDeact, { endpoint: null, platform: "web" });

  const secHtml = renderSecurityBody(store.state);
  assert.match(secHtml, /data-copy-extension-token="1"/);
  assert.match(secHtml, /data-action="connect-extension"/);
  assert.match(secHtml, /data-action="create-mcp-token"/);
  assert.match(secHtml, /data-action="open-delete-account"/);
  const profHtml = renderProfileBody(store.state);
  assert.match(profHtml, /data-toggle-notif-setting="1"/);
});

test("Phase C: 4-state workflow status mapping, platform/contentType filtering, and postMenu actions", async () => {
  const { mapUiStatusToBackend, normalizeWorkflowStatus, inferContentType } = await import("../src/services/apiClient.js");
  const { filterLinks } = await import("../src/state/store.js");
  const { renderPostMenuAndDialog } = await import("../src/screens/common.js");

  assert.equal(mapUiStatusToBackend("todo"), "todo");
  assert.equal(mapUiStatusToBackend("archived"), "archived");
  assert.equal(normalizeWorkflowStatus("todo"), "todo");
  assert.equal(inferContentType({ platform: "youtube", embed_type: "youtube" }), "video");
  assert.equal(inferContentType({ platform: "instagram" }), "social");

  const sampleLinks = [
    { id: "1", title: "YT Video", platform: "YouTube", contentType: "video", status: "unread", workflowStatus: "todo", favorite: false, tags: [] },
    { id: "2", title: "Blog Post", platform: "Website", contentType: "article", status: "read", workflowStatus: "archived", favorite: false, tags: [] },
  ];
  assert.equal(filterLinks(sampleLinks, "", "all", { platform: "youtube" }).length, 1);
  assert.equal(filterLinks(sampleLinks, "", "all", { contentType: "article" }).length, 1);
  assert.equal(filterLinks(sampleLinks, "", "todo").length, 1);

  const menuHtml = renderPostMenuAndDialog({ activeSheet: { type: "postMenu", linkId: "1" } }, sampleLinks);
  assert.match(menuHtml, /data-refresh-preview-sheet="1"/);
  assert.match(menuHtml, /data-set-workflow-status="todo"/);
});
