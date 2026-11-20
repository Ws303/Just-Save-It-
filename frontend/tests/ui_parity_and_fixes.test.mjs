import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");

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
  assert.match(authHtml, /Sherlink/);

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
  assert.doesNotMatch(secHtml, /data-action="create-mcp-token"/);
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
  assert.match(menuHtml, /data-open-link="1"/);
  assert.match(menuHtml, /data-toggle-status-sheet="1"/);
  assert.match(menuHtml, /data-trigger-ai-sheet="1"/);
  assert.doesNotMatch(menuHtml, /data-refresh-preview-sheet="1"/);
  assert.doesNotMatch(menuHtml, /data-set-workflow-status=/);
});

test("v2 Polish: YouTube URL derives playable embed + thumbnail, Link Detail shows description, and AI summarize keeps Note isolated", async () => {
  const { deriveVideoEmbedInfo, renderRichPreviewBox, renderLinkDetailScreen } = await import("../src/screens/links.js");

  const derived = deriveVideoEmbedInfo({ url: "https://youtu.be/dQw4w9WgXcQ?t=10" });
  assert.equal(derived.embedUrl, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(derived.thumbUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

  const rawYtItem = {
    id: "yt-raw-1",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    description: "Official remastered 4K music video description.",
    platform: "YouTube",
    tags: [],
    note: "โน้ตส่วนตัวของฉัน",
  };
  const posterHtml = renderRichPreviewBox(rawYtItem, { videoPlaying: false });
  assert.match(posterHtml, /https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg/);
  assert.match(posterHtml, /data-action="play-embed-video"/);

  const iframeHtml = renderRichPreviewBox(rawYtItem, { videoPlaying: true });
  assert.match(iframeHtml, /<iframe[^>]+https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?autoplay=1&(?:amp;)?playsinline=1/);

  store.resetSeed();
  store.state.api.mode = "mock";
  store.state.data.links.unshift(rawYtItem);
  store.state.ui.activeLinkId = rawYtItem.id;
  store.state.ui.screen = "linkDetail";
  const mobileDetailHtml = renderLinkDetailScreen(store.state);
  assert.match(mobileDetailHtml, /class="figma-detail-post-desc"/);
  assert.match(mobileDetailHtml, /Official remastered 4K music video description\./);

  store.state.ui.viewportMode = "web";
  store.state.ui.pcSection = "linkDetail";
  const desktopDetailHtml = renderWebView(store.state);
  assert.match(desktopDetailHtml, /class="figma-detail-post-desc"/);
  assert.match(desktopDetailHtml, /Official remastered 4K music video description\./);

  assert.equal(store.state.api.summarizeOptions.saveToNote, false);
  await apiClient.summarizeLink(rawYtItem.id, { forceRefresh: true, saveToNote: false });
  assert.equal(rawYtItem.note, "โน้ตส่วนตัวของฉัน");
});

test("L-NEW-2 / H-NEW-1: SIGNED_OUT resets hydration without ReferenceError, rAF coalesces renders, and recordLog skips hidden emit", async () => {
  const { handleSupabaseAuthChange, createFrameCoalescer } = await import("../src/services/routeGuard.js");

  let hydratedUser = "uid-123";
  let realtimeStopped = 0;
  let clearedOpts = null;
  store.resetSeed();
  store.state.api.authProvider = "supabase";
  store.state.data.user.isAuthenticated = true;

  const out = handleSupabaseAuthChange(
    { event: "SIGNED_OUT" },
    {
      getState: () => store.state,
      resetHydratedUser: () => {
        hydratedUser = "";
      },
      stopRealtimeSync: () => {
        realtimeStopped += 1;
      },
      clearSession: (opts) => {
        clearedOpts = opts;
      },
      applyAuthenticatedSession: () => {},
      hydrateOnceIfNeeded: () => {},
      completePostAuthNavigation: () => {},
    }
  );
  assert.equal(out.handled, "signed_out");
  assert.equal(hydratedUser, "");
  assert.equal(realtimeStopped, 1);
  assert.deepEqual(clearedOpts, { redirectToLogin: true });

  // Verify rAF search coalescing only fires the latest frame once
  const queued = new Map();
  let nextId = 1;
  let renderCount = 0;
  const trigger = createFrameCoalescer(
    () => {
      renderCount += 1;
    },
    {
      raf: (cb) => {
        const id = nextId++;
        queued.set(id, cb);
        return id;
      },
      caf: (id) => queued.delete(id),
    }
  );
  trigger();
  trigger();
  trigger();
  assert.equal(queued.size, 1);
  for (const cb of queued.values()) cb();
  assert.equal(renderCount, 1);

  // Verify recordLog skips store.emit() when inspectorVisible=false and emits when inspectorVisible=true
  store.resetSeed();
  store.state.api.mode = "mock";
  let emitCount = 0;
  const unsub = store.subscribe(() => {
    emitCount += 1;
  });
  try {
    store.state.ui.inspectorVisible = false;
    emitCount = 0;
    await apiClient.checkHealth();
    assert.equal(emitCount, 0);

    store.state.ui.inspectorVisible = true;
    emitCount = 0;
    await apiClient.checkHealth();
    assert.equal(emitCount, 1);
  } finally {
    unsub();
  }
});

test("C2 Extension ShareSheet 319:541 structure & /api/workspace fetchWorkspace w/ 404 fallback", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const popupHtml = fs.readFileSync(path.resolve("..", "extension", "popup.html"), "utf8");
  for (const id of [
    "openWebBtn",
    "tabSaveBtn",
    "tabRecentBtn",
    "toggleSettingsBtn",
    "reminderTriggerBtn",
    "titleInput",
    "toggleUrlEditBtn",
    "folderChipWrap",
    "tagSuggestions",
    "noteInput",
    "saveItemBtn",
  ]) {
    assert.ok(popupHtml.includes(`id="${id}"`), `Missing ShareSheet 319:541 element #${id}`);
  }
  assert.match(popupHtml, /class="figma-ext-link-preview"/);

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const extApi = require("../../extension/api.js");
  assert.equal(typeof extApi.fetchWorkspace, "function");

  const mockJsonResponse = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });

  const calls = [];
  const origFetch = globalThis.fetch;
  try {
    await extApi.setBackendUrl("https://api.test.local");
    await extApi.saveAuthSession({ access_token: "tok-1", refresh_token: "", user: null });

    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/api/workspace")) {
        return mockJsonResponse(200, {
          id: "u1",
          email: "u1@example.com",
          folders: [{ id: "f1", name: "Reading" }],
          tags: [{ name: "news" }],
          items: [{ id: "i1", title: "Fast Workspace Item", url: "https://example.com" }],
          reminders: [],
        });
      }
      return mockJsonResponse(200, {});
    };
    const ws = await extApi.fetchWorkspace({ limit: 50 });
    assert.equal(ws.items.length, 1);
    assert.equal(ws.folders.length, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/workspace\?limit=50/);

    // 404 fallback to legacy parallel endpoints
    calls.length = 0;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/api/workspace")) {
        return mockJsonResponse(404, { detail: "Not found" });
      }
      if (String(url).includes("/api/auth/me")) return mockJsonResponse(200, { id: "u1" });
      if (String(url).includes("/api/folders")) return mockJsonResponse(200, { folders: [] });
      if (String(url).includes("/api/tags")) return mockJsonResponse(200, { tags: [] });
      if (String(url).includes("/api/items")) return mockJsonResponse(200, { items: [] });
      return mockJsonResponse(200, {});
    };
    const fallbackWs = await extApi.fetchWorkspace({ limit: 50 });
    assert.equal(fallbackWs.id, "u1");
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("C3 WebApp SWR user-scoped cache, /api/workspace hydration, optimistic createLink, search helpers & realtime delta", async () => {
  const { loadWorkspaceCache, saveWorkspaceCache } = await import("../src/services/apiClient.js");
  const {
    extractRealtimeDelta,
    noteLocalMutation,
    startRealtimeSync,
    stopRealtimeSync,
  } = await import("../src/services/realtimeClient.js");
  const { renderHomeLinksSectionInner } = await import("../src/screens/home.js");
  const { renderFoldersGridInner, renderFolderDetailLinksInner } = await import("../src/screens/folders.js");
  const {
    renderPcHomeLinksSectionInner,
    renderPcFoldersGridInner,
    renderPcFolderDetailLinksInner,
    renderPcFavoriteListInner,
  } = await import("../src/screens/webExtension.js");

  const mockResp = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });

  const memStore = new Map();
  const origLocalStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  globalThis.localStorage = {
    getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => memStore.set(k, String(v)),
    removeItem: (k) => memStore.delete(k),
  };

  try {
    store.resetSeed();
    store.state.api.mode = "live";
    store.state.api.bearerToken = "jwt-user-a";
    store.state.data.user.isAuthenticated = true;
    store.state.data.user.id = "user-a";
    store.state.data.links = [{ id: "cached-a1", url: "https://a.example.com", title: "Cached A1", tags: [] }];
    saveWorkspaceCache("user-a");

    assert.equal(loadWorkspaceCache("user-b"), null, "User A cache must not leak to User B");
    assert.equal(loadWorkspaceCache("user-a").links[0].id, "cached-a1");

    // hydrateWorkspace hits /api/workspace once and serves SWR cache first
    store.state.data.links = [];
    store.state.data.folders = [];
    const fetchPaths = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      fetchPaths.push(`${init.method || "GET"} ${u}`);
      if (u.includes("/api/workspace")) {
        return mockResp(200, {
          id: "user-a",
          email: "a@example.com",
          display_name: "User A",
          folders: [{ id: "f-live-1", name: "Cloud Folder" }],
          tags: [{ name: "fast" }],
          items: [
            {
              id: "item-live-1",
              folder_id: "f-live-1",
              url: "https://example.com/live-1",
              title: "Live 1",
              description: "Saved from server",
              thumbnail_url: "https://cdn.example.com/1.jpg",
              tags: ["fast"],
              status: "inbox",
              is_favorite: true,
            },
          ],
          reminders: [],
        });
      }
      if (u.endsWith("/api/items") && init.method === "POST") {
        assert.equal(store.state.data.links[0]?._optimistic, true);
        return mockResp(201, {
          id: "item-created-1",
          folder_id: "f-live-1",
          url: "https://example.com/fast-save",
          title: "Fast Optimistic Save",
          description: "Quick desc",
          thumbnail_url: "https://cdn.example.com/ok.jpg",
          tags: ["speed"],
          status: "inbox",
        });
      }
      if (u.includes("/refresh-preview")) {
        return mockResp(200, { status: "ok", item: { id: "item-created-1" } });
      }
      return mockResp(200, {});
    };

    const hyd = await apiClient.hydrateWorkspace();
    assert.equal(hyd.ok, true);
    assert.equal(fetchPaths.length, 1);
    assert.match(fetchPaths[0], /GET .*\/api\/workspace\?limit=100/);
    assert.equal(store.state.data.links[0].id, "item-live-1");

    // Verify extracted search section renderers
    store.state.ui.homeSearch = "Live";
    store.state.ui.folderSearch = "Cloud";
    store.state.ui.folderDetailSearch = "Live";
    store.state.ui.activeFolderId = "f-live-1";
    assert.match(renderHomeLinksSectionInner(store.state), /Live 1/);
    assert.match(renderFoldersGridInner(store.state), /Cloud Folder/);
    assert.match(renderFolderDetailLinksInner(store.state), /Live 1/);
    assert.match(renderPcHomeLinksSectionInner(store.state), /Live 1/);
    assert.match(renderPcFoldersGridInner(store.state), /Cloud Folder/);
    assert.match(renderPcFolderDetailLinksInner(store.state), /Live 1/);
    assert.match(renderPcFavoriteListInner(store.state), /Live 1/);

    // Optimistic createLink skips blocking /api/preview
    fetchPaths.length = 0;
    const saved = await apiClient.createLink({
      url: "https://example.com/fast-save",
      title: "Fast Optimistic Save",
      thumbnail_url: "https://cdn.example.com/ok.jpg",
      description: "Quick desc",
      tags: ["#speed"],
    });
    assert.equal(saved.id, "item-created-1");
    assert.ok(!fetchPaths.some((p) => p.includes("/api/preview")), "createLink must not block on /api/preview");

    // Delta update/delete via applyRealtimeDelta avoids redundant /api/workspace
    fetchPaths.length = 0;
    const delta = extractRealtimeDelta({
      event: "postgres_changes",
      payload: {
        data: {
          table: "items",
          type: "UPDATE",
          record: { id: "item-live-1", url: "https://example.com/live-1", title: "Live 1 Updated", status: "done" },
        },
      },
    });
    assert.equal(delta.table, "items");
    await apiClient.applyRealtimeDelta({ deltas: [delta], forceFullSync: false });
    assert.equal(fetchPaths.length, 0);
    assert.equal(store.state.data.links.find((l) => l.id === "item-live-1").title, "Live 1 Updated");

    // clearSession drops cached workspace for current user
    store.clearSession({ redirectToLogin: true, clearWorkspace: true });
    assert.equal(loadWorkspaceCache("user-a"), null);

    // realtime suppression after local mutation
    noteLocalMutation();
    let syncCalled = 0;
    startRealtimeSync({
      getSupabaseConfig: () => ({ url: "", anonKey: "" }),
      getAccessToken: () => "",
      isAuthenticated: () => false,
      onSync: () => {
        syncCalled += 1;
      },
    });
    stopRealtimeSync();
    assert.equal(syncCalled, 0);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test("Sherlink Batch 2: branding, iOS PWA shell, simultaneous Description + AI summary, Prev/Next CSS, custom cover reset & Discord invites", async () => {
  const { resolveRuntimeApiConfig } = await import("../src/state/store.js");
  const { renderLinkDetailScreen, resolveDetailNavIds } = await import("../src/screens/links.js");
  const { renderFolderSheets } = await import("../src/screens/folders.js");
  const { renderPcFoldersGridInner } = await import("../src/screens/webExtension.js");
  const { buildInviteCreatePayload } = await import("../src/services/apiClient.js");

  // 1) SHERLINK_CONFIG + legacy SHARELY_CONFIG fallback
  const cfgSherlink = resolveRuntimeApiConfig({
    location: { hostname: "sherlink.onrender.com", protocol: "https:", origin: "https://sherlink.onrender.com" },
    SHERLINK_CONFIG: { apiBaseUrl: "https://api.sherlink.example.com" },
  });
  assert.equal(cfgSherlink.baseUrl, "https://api.sherlink.example.com");

  const cfgFallback = resolveRuntimeApiConfig({
    location: { hostname: "sherlink.onrender.com", protocol: "https:", origin: "https://sherlink.onrender.com" },
    SHARELY_CONFIG: { apiBaseUrl: "https://legacy.sharely.example.com" },
  });
  assert.equal(cfgFallback.baseUrl, "https://legacy.sharely.example.com");

  // 2) iOS PWA meta tags & Sherlink manifest
  const indexHtml = fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8");
  assert.match(indexHtml, /viewport-fit=cover/);
  assert.match(indexHtml, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(indexHtml, /name="apple-mobile-web-app-title" content="Sherlink"/);
  assert.match(indexHtml, /apple-touch-icon\.png/);

  const manifest = JSON.parse(fs.readFileSync(path.join(frontendRoot, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "Sherlink");
  assert.equal(manifest.short_name, "Sherlink");
  assert.ok(manifest.icons.some((ic) => String(ic.src).includes("sherlink-icon-192.png")));

  // 3) Description + AI Summary coexist on Mobile & Desktop with Read More / Collapse toggle
  store.resetSeed();
  store.state.ui.descExpanded = false;
  const longDescItem = {
    id: "yt-desc-coexist",
    folderId: store.state.data.folders[0].id,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Long Description Video",
    description: "บทที่ 1 การเริ่มต้นชงกาแฟดริปอย่างละเอียด\n".repeat(12),
    aiSummary: "• สรุปจุดสำคัญจากคลิปโดย AI",
    platform: "YouTube",
    tags: [],
  };
  store.state.data.links.unshift(longDescItem);
  store.state.ui.activeLinkId = longDescItem.id;
  store.state.ui.detailNavIds = [longDescItem.id, store.state.data.links[1].id];
  store.state.ui.screen = "linkDetail";
  const mobileHtml = renderLinkDetailScreen(store.state);
  assert.match(mobileHtml, /คำอธิบายจากโพสต์ต้นฉบับ/);
  assert.match(mobileHtml, /อ่านเพิ่มเติม/);
  assert.match(mobileHtml, /สรุปจากต้นฉบับ/);
  assert.match(mobileHtml, /สรุปจุดสำคัญจากคลิปโดย AI/);
  assert.match(mobileHtml, /class="figma-detail-desc-block clamped"/);

  store.state.ui.descExpanded = true;
  store.state.ui.viewportMode = "web";
  store.state.ui.pcSection = "linkDetail";
  const desktopHtml = renderWebView(store.state);
  assert.match(desktopHtml, /คำอธิบายจากโพสต์ต้นฉบับ/);
  assert.match(desktopHtml, /ย่อข้อความ/);
  assert.match(desktopHtml, /สรุปจุดสำคัญจากคลิปโดย AI/);
  assert.deepEqual(resolveDetailNavIds(store.state).slice(0, 2), [longDescItem.id, store.state.data.links[1].id]);

  // 4) Desktop Prev/Next arrow NOT hidden at <=1279px
  const appCss = fs.readFileSync(path.join(frontendRoot, "styles", "app.css"), "utf8");
  const media1279 = appCss.slice(appCss.lastIndexOf("@media (max-width: 1279px)"), appCss.lastIndexOf("@media (max-width: 1023px)"));
  assert.doesNotMatch(media1279, /\.pc-detail-arrow\s*\{\s*display:\s*none;/);

  // 5) Discord invite options & custom cover reset payload
  assert.deepEqual(buildInviteCreatePayload({ role: "viewer", expiry: "30m", maxUses: "5" }), {
    role: "viewer",
    expires_in_minutes: 30,
    max_uses: 5,
  });
  assert.deepEqual(buildInviteCreatePayload({ role: "editor", expiry: "never" }), {
    role: "editor",
    never_expires: true,
  });

  store.state.ui.activeSheet = { type: "invite", folderId: store.state.data.folders[0].id };
  const shareHtml = renderFolderSheets(store.state);
  assert.match(shareHtml, /data-invite-expiry="1"/);
  assert.match(shareHtml, /data-invite-max-uses="1"/);
  assert.match(shareHtml, /value="never"/);

  store.state.ui.activeSheet = { type: "editFolder", folderId: store.state.data.folders[0].id, nameDraft: "Test", coverDraft: "./assets/covers/coffee.png" };
  const editFolderHtml = renderFolderSheets(store.state);
  assert.match(editFolderHtml, /data-folder-cover-input="1"/);
  assert.match(editFolderHtml, /data-action="reset-folder-cover"/);

  store.state.api.mode = "mock";
  const resetSaved = await apiClient.saveFolder({
    folderId: store.state.data.folders[0].id,
    name: "Test Reset",
    cover: null,
    resetCover: true,
  });
  assert.equal(resetSaved.cover, null);

  // Desktop custom cover takes priority over >=2 link collage (CHRIS H-1)
  store.state.ui.folderSearch = "";
  store.state.data.folders = [{ id: "f-cov", name: "My Custom Folder", cover: "https://cdn.example.com/custom-cover.webp" }];
  store.state.data.links = [
    { id: "l1", folderId: "f-cov", url: "https://example.com/1", thumbnail_url: "https://cdn.example.com/1.jpg" },
    { id: "l2", folderId: "f-cov", url: "https://example.com/2", thumbnail_url: "https://cdn.example.com/2.jpg" },
  ];
  const desktopGrid = renderPcFoldersGridInner(store.state);
  assert.match(desktopGrid, /https:\/\/cdn\.example\.com\/custom-cover\.webp/);
  assert.doesNotMatch(desktopGrid, /pc-folder-collage/);
});

test("Sherlink Web cleanup: off-Figma folder card badges removed, description moved above-the-fold, sw.js network-first v2, non-owner folder parity", async () => {
  const { renderLinkCard } = await import("../src/screens/common.js");
  const { renderLinkDetailScreen, renderSavedPreviewScreen } = await import("../src/screens/links.js");
  const { renderFoldersGridInner, renderFolderDetailScreen } = await import("../src/screens/folders.js");

  // 1) Folder link card emits zero off-Figma badges/glows and no platform stamp over images
  const cardHtml = renderLinkCard(
    {
      id: "l-clean-1",
      folderId: store.state.data.folders[0]?.id || "f1",
      platform: "Facebook",
      title: "AI Offline Thai Reader",
      status: "unread",
      favorite: true,
      pinned: true,
      savedAgo: "เมื่อสักครู่",
      coverUrl: "https://images.example.com/thumb.jpg",
      aiSummary: "สรุป AI",
    },
    { variant: "folder", folderContextId: "f1" },
  );
  assert.doesNotMatch(cardHtml, /recently-shared/);
  assert.doesNotMatch(cardHtml, /new-incoming-pill/);
  assert.doesNotMatch(cardHtml, /เพิ่งแชร์เข้ามา/);
  assert.doesNotMatch(cardHtml, /ปักหมุด/);
  assert.doesNotMatch(cardHtml, /ai-badge-pill/);
  const thumbBlock = cardHtml.slice(cardHtml.indexOf('class="link-thumb"'), cardHtml.indexOf('class="link-body"'));
  assert.doesNotMatch(thumbBlock, />Facebook</);

  // 2) Mobile Detail places Original Description BEFORE Note and Saved Preview uses renderOriginalDescriptionBlock
  store.resetSeed();
  const detailItem = {
    id: "itm-above-fold",
    folderId: store.state.data.folders[0].id,
    url: "https://www.youtube.com/watch?v=abc123def45",
    title: "Test Post",
    description: "คำอธิบายจากต้นฉบับแบบเต็มสำหรับทดสอบตำแหน่งบนหน้าจอ",
    note: "โน้ตสั้น",
    aiSummary: "สรุปทดสอบ",
    platform: "YouTube",
    tags: [],
  };
  store.state.data.links.unshift(detailItem);
  store.state.ui.activeLinkId = detailItem.id;
  store.state.ui.previewIndex = 0;
  store.state.ui.screen = "linkDetail";
  const detailHtml = renderLinkDetailScreen(store.state);
  const descIdx = detailHtml.indexOf("figma-detail-desc-block");
  const noteIdx = detailHtml.indexOf("figma-detail-note-block");
  assert.ok(descIdx > 0 && noteIdx > 0 && descIdx < noteIdx, "Description block must appear above Note block on Mobile Web");

  const previewHtml = renderSavedPreviewScreen(store.state);
  assert.match(previewHtml, /คำอธิบายจากโพสต์ต้นฉบับ/);
  assert.match(previewHtml, /figma-detail-desc-block/);

  // 3) sw.js v2 & Network-First app-shell
  const swSrc = fs.readFileSync(path.join(frontendRoot, "sw.js"), "utf8");
  assert.match(swSrc, /sherlink-shell-v2/);
  assert.match(swSrc, /isAppShellAsset/);

  // 4) Non-owner folder hides pencil + invite button and counts collaborator accurately
  store.state.data.folders = [
    { id: "fld-shared", name: "Shared Club", role: "editor", ownerId: "alice", sharedCount: 0 },
  ];
  store.state.ui.activeFolderId = "fld-shared";
  store.state.ui.folderMembers = {
    "fld-shared": {
      owner_id: "alice",
      caller_role: "editor",
      members: [{ user_id: "bob", role: "editor", display_name: "Bob" }],
    },
  };
  const foldersGridHtml = renderFoldersGridInner(store.state);
  assert.doesNotMatch(foldersGridHtml, /data-open-edit-folder="fld-shared"/);
  const folderDetailHtml = renderFolderDetailScreen(store.state);
  assert.doesNotMatch(folderDetailHtml, /data-open-invite-sheet="fld-shared"/);
  assert.match(folderDetailHtml, /แชร์กับ 1 คน/);

  // 5) AI custom model text input present in Custom Endpoint mode
  const prevAiProvider = store.state.data.aiConfig.provider;
  try {
    store.state.data.aiConfig.provider = "Custom Endpoint";
    const aiCustomHtml = renderAiPanelBody(store.state);
    assert.match(aiCustomHtml, /data-bind-ai-model="1"/);
  } finally {
    store.state.data.aiConfig.provider = prevAiProvider;
  }
});

test("Sherlink Round 6 fixes: Desktop non-owner folder gates, CWE-1236 CSV neutralization, and social description cleanup", async () => {
  const { computeWebFolderShareState } = await import("../src/screens/folders.js");
  const { renderOriginalDescriptionBlock } = await import("../src/screens/links.js");

  // 1) computeWebFolderShareState + Desktop renderWebView non-owner folder gates
  store.resetSeed();
  const prevScreen = store.state.ui.screen;
  const prevViewport = store.state.ui.viewportMode;
  const prevPcSection = store.state.ui.pcSection;
  try {
    store.state.ui.screen = "home";
    const shareState = computeWebFolderShareState(
      { id: "fld-peer", role: "viewer", ownerId: "owner-1", sharedCount: 0 },
      {
        owner_id: "owner-1",
        caller_role: "viewer",
        members: [
          { user_id: "owner-1", role: "owner", display_name: "Alice" },
          { user_id: "viewer-2", role: "viewer", display_name: "Bob" },
        ],
      },
    );
    assert.deepEqual(
      { isOwner: shareState.isOwner, shareCount: shareState.shareCount, hasExplicitOwnerRow: shareState.hasExplicitOwnerRow },
      { isOwner: false, shareCount: 1, hasExplicitOwnerRow: true },
    );

    store.state.data.folders = [
      { id: "fld-own", name: "My Own Folder", role: "owner", ownerId: "u-self", sharedCount: 0 },
      { id: "fld-shared-ro", name: "Team Read Only", role: "viewer", ownerId: "alice", sharedCount: 0 },
    ];
    store.state.ui.viewportMode = "web";
    store.state.ui.pcSection = "folders";
    store.state.ui.activeFolderId = "fld-shared-ro";
    store.state.ui.folderMembers = {
      "fld-shared-ro": {
        owner_id: "alice",
        caller_role: "viewer",
        members: [{ user_id: "bob", role: "viewer", display_name: "Bob" }],
      },
    };
    const desktopFoldersHtml = renderWebView(store.state);
    assert.match(desktopFoldersHtml, /data-open-edit-folder="fld-own"/);
    assert.doesNotMatch(desktopFoldersHtml, /data-open-edit-folder="fld-shared-ro"/);
    assert.doesNotMatch(desktopFoldersHtml, /data-open-invite-sheet="fld-shared-ro"/);
    assert.match(desktopFoldersHtml, /โฟลเดอร์ที่แชร์/);

    store.state.ui.pcSection = "folderDetail";
    const desktopDetailHtml = renderWebView(store.state);
    assert.doesNotMatch(desktopDetailHtml, /data-open-invite-sheet="fld-shared-ro"/);
    assert.match(desktopDetailHtml, /แชร์กับ 1 คน/);
  } finally {
    store.state.ui.screen = prevScreen;
    store.state.ui.viewportMode = prevViewport;
    store.state.ui.pcSection = prevPcSection;
  }

  // 2) Social stats noise stripped for IG while YouTube keeps fuller description
  const igDescHtml = renderOriginalDescriptionBlock({
    url: "https://www.instagram.com/p/C9xyz123/",
    platform: "Instagram",
    title: "Quiet Cafe",
    description: "120 likes, 4 comments - cafe_bkk on October 12, 2026: \"Drip coffee corner in Ari\".",
  });
  assert.doesNotMatch(igDescHtml, /120 likes, 4 comments/);
  assert.match(igDescHtml, /Drip coffee corner in Ari/);

  const ytDescHtml = renderOriginalDescriptionBlock({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    platform: "YouTube",
    title: "Pour Over 101",
    description: "00:00 Intro 01:30 Bloom 03:00 Final pour full walkthrough",
  });
  assert.match(ytDescHtml, /00:00 Intro 01:30 Bloom 03:00 Final pour full walkthrough/);

  // 3) main.js source guards: CWE-1236 formula prefix neutralization, isFolderOwnerRole + isSameAuthSnapshot fences, no listMcpTokens on nav
  const mainSrc = fs.readFileSync(path.join(frontendRoot, "src", "main.js"), "utf8");
  assert.ok(mainSrc.includes("/^[=+\\-@\\t\\r]/"), "downloadCsv must neutralize CWE-1236 formula prefixes");
  assert.doesNotMatch(mainSrc, /data\.session\?\.accessToken/);
  assert.match(mainSrc, /if \(d\.openEditFolder\)[\s\S]{0,180}isFolderOwnerRole/);
  assert.match(mainSrc, /if \(d\.openInviteSheet\)[\s\S]{0,200}isFolderOwnerRole/);
  assert.match(mainSrc, /el\.dataset\.folderCoverInput[\s\S]{0,650}isSameAuthSnapshot/);
  assert.match(mainSrc, /if \(d\.openFolder\)[\s\S]{0,360}isSameAuthSnapshot/);
  assert.match(mainSrc, /if \(d\.changeMemberRole[\s\S]{0,260}isFolderOwnerRole/);
  const pcSectionMatch = mainSrc.match(/if \(d\.pcSection\)[\s\S]{0,450}return;/);
  assert.ok(pcSectionMatch && !/listMcpTokens/.test(pcSectionMatch[0]), "d.pcSection must not call dead listMcpTokens");

  // 4) Round 7 & 8 fixes: iOS 16px !important, closeSheet + account switch + clearSession reset activeSheet/folderMembers/folderCoverUploading
  const appCss = fs.readFileSync(path.join(frontendRoot, "styles", "app.css"), "utf8");
  const mobileMediaIdx = appCss.indexOf("@media (max-width: 767px)");
  assert.ok(mobileMediaIdx > 0);
  const mobileMediaBlock = appCss.slice(mobileMediaIdx, mobileMediaIdx + 200);
  assert.match(mobileMediaBlock, /font-size:\s*16px\s*!important/);

  store.state.ui.folderCoverUploading = true;
  store.openSheet({ type: "editFolder", folderId: "f-tmp", nameDraft: "Tmp" });
  store.closeSheet();
  assert.equal(store.state.ui.folderCoverUploading, false, "closeSheet must reset folderCoverUploading");

  const { renderFolderSheets } = await import("../src/screens/folders.js");
  assert.equal(computeWebFolderShareState({ id: "fld-ro", role: "editor" }, null).isOwner, false);
  store.state.data.folders = [{ id: "fld-ro", name: "Collab", role: "editor", ownerId: "alice" }];
  store.state.ui.folderMembers = { "fld-ro": { members: [{ user_id: "bob", role: "viewer" }] } };
  store.state.ui.activeSheet = { type: "invite", folderId: "fld-ro" };
  const sheetHtml = renderFolderSheets(store.state);
  assert.doesNotMatch(sheetHtml, /data-remove-member="bob"/);

  // Account switch closes activeSheet & clears folderMembers/folderCoverUploading even in headless DOM
  store.state.data.user.id = "user-alpha";
  store.state.ui.folderCoverUploading = true;
  store.applyAuthenticatedSession({ user: { id: "user-beta", email: "b@test.local" } });
  assert.equal(store.state.ui.activeSheet, null);
  assert.equal(store.state.ui.folderCoverUploading, false);
  assert.deepEqual(store.state.ui.folderMembers, {});

  // clearSession with redirectToLogin: false also clears activeSheet, folderCoverUploading, folderMembers, aiTesting
  store.state.ui.activeSheet = { type: "editFolder", folderId: "fld-ro" };
  store.state.ui.folderCoverUploading = true;
  store.state.ui.aiTesting = true;
  store.state.ui.folderMembers = { "fld-ro": { caller_role: "owner", members: [] } };
  store.clearSession({ redirectToLogin: false, clearWorkspace: true });
  assert.equal(store.state.ui.activeSheet, null);
  assert.equal(store.state.ui.folderCoverUploading, false);
  assert.equal(store.state.ui.aiTesting, false);
  assert.deepEqual(store.state.ui.folderMembers, {});

  // 5) Round 9 fixes: createFolderInvite auth fence + no folders[0] bleed, non-owner generate-share-link hidden, pickCover lock, aiTesting reset
  store.state.data.folders = [{ id: "fld-ro", name: "Collab", role: "editor", ownerId: "alice" }];
  store.state.ui.activeSheet = { type: "invite", folderId: "fld-ro" };
  const nonOwnerInviteHtml = renderFolderSheets(store.state);
  assert.doesNotMatch(nonOwnerInviteHtml, /data-action="generate-share-link"/);

  store.state.ui.folderCoverUploading = true;
  store.state.ui.activeSheet = { type: "createFolder", nameDraft: "Busy", coverDraft: null };
  const busyCoverSheetHtml = renderFolderSheets(store.state);
  assert.match(busyCoverSheetHtml, /data-open-pick-cover="1"[\s\S]{0,40}disabled/);

  store.openSheet({ type: "editFolder", folderId: "fld-ro", nameDraft: "Next" });
  assert.equal(store.state.ui.folderCoverUploading, false, "openSheet must clear stale folderCoverUploading");

  store.state.ui.aiTesting = true;
  store.selectAiProvider("OpenAI");
  assert.equal(store.state.ui.aiTesting, false, "selectAiProvider must reset aiTesting");

  assert.match(mainSrc, /if \(act === "generate-share-link"[\s\S]{0,220}isFolderOwnerRole[\s\S]{0,450}isSameAuthSnapshot/);
  assert.match(mainSrc, /if \(d\.saveAiConfig\)[\s\S]{0,360}isSameAuthSnapshot[\s\S]{0,120}_aiTestSeq/);
  assert.match(mainSrc, /if \(d\.openPickCover[\s\S]{0,120}ui\.folderCoverUploading/);
  assert.match(mainSrc, /_folderCoverUploadSeq/);

  // createFolderInvite mid-flight account switch returns stale and never touches User B's folders[0]
  const origFetch = globalThis.fetch;
  const prevApiMode = store.state.api.mode;
  const prevBearer = store.state.api.bearerToken;
  try {
    store.state.api.mode = "live";
    store.state.api.bearerToken = "tok-user-a";
    store.state.data.user.id = "user-a-inv";
    store.state.data.folders = [{ id: "fld-user-a", name: "A Folder", role: "owner", inviteUrl: "" }];

    let releaseInviteFetch = null;
    globalThis.fetch = async () =>
      new Promise((resolve) => {
        releaseInviteFetch = () =>
          resolve({
            ok: true,
            status: 201,
            headers: { get: () => "application/json" },
            json: async () => ({ token: "inv-from-a", invite_url: "https://sherlink.app/invite/from-a" }),
          });
      });

    const pendingInvite = apiClient.createFolderInvite("fld-user-a", { role: "viewer" });
    await new Promise((r) => setTimeout(r, 15));
    store.applyAuthenticatedSession({ user: { id: "user-b-inv", email: "b@inv.test" }, accessToken: "tok-user-b" });
    store.state.data.folders = [{ id: "fld-user-b", name: "B Folder", role: "owner", inviteUrl: "" }];
    releaseInviteFetch();
    const invRes = await pendingInvite;
    assert.equal(invRes.ok, false);
    assert.equal(invRes.stale, true);
    assert.equal(store.state.data.folders[0].inviteUrl, "", "Stale createFolderInvite must never leak onto User B folders[0]");
  } finally {
    globalThis.fetch = origFetch;
    store.state.api.mode = prevApiMode;
    store.state.api.bearerToken = prevBearer;
  }
});
