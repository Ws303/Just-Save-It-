import assert from "node:assert/strict";
import test from "node:test";

import { safeHrefUrl, safeImgUrl } from "../src/components/icons.js";
import { resolveAllowlistedEmbedUrl } from "../src/screens/links.js";
import { store, buildFolderInviteUrl, resolveRuntimeApiConfig } from "../src/state/store.js";
import { renderLinkCard } from "../src/screens/common.js";
import { renderFolderSheets } from "../src/screens/folders.js";
import { apiClient } from "../src/services/apiClient.js";

test("safeHrefUrl allows only http(s) URLs and blocks unsafe schemes", () => {
  assert.equal(safeHrefUrl("https://sharely.app/invite/abc?role=viewer"), "https://sharely.app/invite/abc?role=viewer");
  assert.equal(safeHrefUrl("http://localhost:8000/docs"), "http://localhost:8000/docs");
  assert.equal(safeHrefUrl("javascript:alert(1)"), "#");
  assert.equal(safeHrefUrl("JAVASCRIPT:alert(1)"), "#");
  assert.equal(safeHrefUrl("data:text/html,<script>alert(1)</script>"), "#");
  assert.equal(safeHrefUrl("vbscript:msgbox(1)"), "#");
  assert.equal(safeHrefUrl("/relative/path"), "#");
  assert.equal(safeHrefUrl(""), "#");
  assert.equal(safeHrefUrl(null), "#");
});

test("safeImgUrl allows local assets and http(s) URLs while blocking active schemes", () => {
  assert.equal(safeImgUrl("./assets/covers/coffee.png"), "./assets/covers/coffee.png");
  assert.equal(safeImgUrl("/assets/covers/food.png"), "/assets/covers/food.png");
  assert.equal(safeImgUrl("https://cdn.example.com/thumb.jpg"), "https://cdn.example.com/thumb.jpg");
  assert.equal(safeImgUrl("javascript:alert(1)"), "");
  assert.equal(safeImgUrl("data:image/svg+xml,<svg onload=alert(1)>"), "");
  assert.equal(safeImgUrl("file:///etc/passwd"), "");
  assert.equal(safeImgUrl(""), "");
});

test("resolveAllowlistedEmbedUrl enforces HTTPS, allowlisted hosts, and embed paths", () => {
  assert.equal(
    resolveAllowlistedEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ"
  );
  assert.equal(
    resolveAllowlistedEmbedUrl("https://www.tiktok.com/embed/v2/74009911"),
    "https://www.tiktok.com/embed/v2/74009911"
  );
  assert.equal(
    resolveAllowlistedEmbedUrl("https://www.instagram.com/reel/CxYz123/embed/"),
    "https://www.instagram.com/reel/CxYz123/embed/"
  );
  assert.equal(
    resolveAllowlistedEmbedUrl("https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Ffb.watch%2Fabc"),
    "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Ffb.watch%2Fabc"
  );
  assert.equal(
    resolveAllowlistedEmbedUrl("https://platform.twitter.com/embed/Tweet.html?id=123"),
    "https://platform.twitter.com/embed/Tweet.html?id=123"
  );
  assert.equal(
    resolveAllowlistedEmbedUrl("https://www.redditmedia.com/r/Coffee/comments/abc/test/"),
    "https://www.redditmedia.com/r/Coffee/comments/abc/test/"
  );

  // Blocked: arbitrary non-embed path on allowlisted domain
  assert.equal(resolveAllowlistedEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  // Blocked: credentials / userinfo in URL
  assert.equal(resolveAllowlistedEmbedUrl("https://evil@www.youtube.com/embed/dQw4w9WgXcQ"), null);
  // Blocked: non-HTTPS scheme
  assert.equal(resolveAllowlistedEmbedUrl("http://www.youtube.com/embed/dQw4w9WgXcQ"), null);
  // Blocked: untrusted domain
  assert.equal(resolveAllowlistedEmbedUrl("https://evil.example.com/embed/123"), null);
  // Blocked: traversal segment (Note: URL normalizes /../ before check, check raw '..')
  assert.equal(resolveAllowlistedEmbedUrl("javascript:alert(1)"), null);
});

test("createLink rejects unsafe URLs with null without mutating store, and acceptInvite/clearSession honor live failure & mobile logout reset", async () => {
  globalThis.document ??= { documentElement: { setAttribute() {} } };

  const initialCount = store.state.data.links.length;
  const rejected = await apiClient.createLink({ url: "javascript:alert(1)" });
  assert.equal(rejected, null);
  assert.equal(store.state.data.links.length, initialCount);

  const prevMode = store.state.api.mode;
  const prevFetch = globalThis.fetch;
  try {
    store.state.api.mode = "live";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Invite expired" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const failedJoin = await apiClient.acceptInvite(store.state.data.folders[0]?.id || "f1");
    assert.equal(failedJoin, null);
  } finally {
    store.state.api.mode = prevMode;
    globalThis.fetch = prevFetch;
  }

  store.state.ui.viewportMode = "web";
  store.state.data.user.isAuthenticated = true;
  store.clearSession({ redirectToLogin: true });
  assert.equal(store.state.ui.viewportMode, "mobile");
  assert.equal(store.state.data.user.isAuthenticated, false);
});

test("buildFolderInviteUrl unifies share URL format across mock API and folder views", async () => {
  assert.equal(
    buildFolderInviteUrl({ id: "f-cafe", inviteSlug: "cafe-abc" }, "editor"),
    "https://sharely.app/invite/cafe-abc?role=editor"
  );
  assert.equal(
    buildFolderInviteUrl({ id: "f-cafe" }, "admin"),
    "https://sharely.app/invite/f-cafe?role=viewer"
  );
  assert.equal(
    buildFolderInviteUrl({ id: "f-cafe" }, "viewer", "https://custom.example/inv/1"),
    "https://custom.example/inv/1"
  );

  const prevMode = store.state.api.mode;
  try {
    store.state.api.mode = "mock";
    const folder = store.state.data.folders[0];
    const res = await apiClient.createFolderInvite(folder.id, "editor");
    assert.equal(res.ok, true);
    assert.match(res.data.invite_url, /^https:\/\/sharely\.app\/invite\/.+\?role=editor$/);
  } finally {
    store.state.api.mode = prevMode;
  }
});

test("renderLinkCard unifies folder, figma-home, and pc-row variants safely in Node and browser", () => {
  const folderId = store.state.data.folders[0]?.id || "f1";
  const sampleItem = {
    id: "l-test-1",
    folderId,
    platform: "Instagram",
    title: '5 คาเฟ่ <script>alert("xss")</script>',
    status: "unread",
    favorite: true,
    pinned: true,
    coverUrl: "https://images.example.com/cafe.jpg",
    aiSummary: "สรุปทดสอบ",
  };

  const figmaHtml = renderLinkCard(sampleItem, { variant: "figma-home" });
  assert.match(figmaHtml, /class="figma-link-card"/);
  assert.doesNotMatch(figmaHtml, /<script>/);
  assert.match(figmaHtml, /&lt;script&gt;alert/);

  const pcHtml = renderLinkCard(sampleItem, { variant: "pc-row", selected: true });
  assert.match(pcHtml, /class="pc-link-row\s+selected"/);
  assert.match(pcHtml, /data-select-web-link="l-test-1"/);

  const folderHtml = renderLinkCard(sampleItem, { variant: "folder", folderContextId: folderId });
  assert.match(folderHtml, /class="link-card\s*"/);
  assert.match(folderHtml, /data-menu-folder="/);
});

test("folder invite URL resolution trims blank overrides, avoids cross-folder leaks, and guards empty folders", async () => {
  assert.equal(
    buildFolderInviteUrl({ id: "f-blank", inviteSlug: "blank-slug" }, "viewer", "   "),
    "https://sharely.app/invite/blank-slug?role=viewer"
  );

  const origFolders = store.state.data.folders;
  const origSheet = store.state.ui.activeSheet;
  const origMode = store.state.api.mode;
  const origSharePerm = store.state.ui.sharePermission;
  const origShareUrl = store.state.ui.shareInviteUrl;

  try {
    store.state.api.mode = "mock";
    store.state.ui.sharePermission = "viewer";
    const folderA = { id: "fa", name: "Folder A", inviteSlug: "slug-a", linkCount: 1, sharedCount: 0, memberIds: [] };
    const folderB = { id: "fb", name: "Folder B", inviteSlug: "slug-b", linkCount: 1, sharedCount: 0, memberIds: [] };
    store.state.data.folders = [folderA, folderB];

    const resA = await apiClient.createFolderInvite("fa", "editor");
    assert.equal(resA.ok, true);
    assert.equal(resA.data.invite_url, "https://sharely.app/invite/slug-a?role=editor");
    assert.equal(store.state.ui.shareInviteUrl, undefined);

    store.state.ui.shareInviteUrl = resA.data.invite_url;
    store.state.ui.activeSheet = { type: "invite", folderId: "fb" };
    const inviteHtmlB = renderFolderSheets(store.state);
    assert.match(inviteHtmlB, /https:\/\/sharely\.app\/invite\/slug-b\?role=viewer/);
    assert.doesNotMatch(inviteHtmlB, /slug-a/);

    store.state.ui.activeSheet = { type: "invitePreview", folderId: "fb", appName: "LINE" };
    const previewHtmlB = renderFolderSheets(store.state);
    assert.match(previewHtmlB, /https:\/\/sharely\.app\/invite\/slug-b\?role=viewer/);
    assert.doesNotMatch(previewHtmlB, /slug-a/);

    store.state.data.folders = [];
    store.state.ui.activeSheet = { type: "inviteShareApp", folderId: "missing" };
    assert.equal(renderFolderSheets(store.state), "");
    store.state.ui.activeSheet = { type: "invitePreview", folderId: "missing" };
    assert.equal(renderFolderSheets(store.state), "");
  } finally {
    store.state.data.folders = origFolders;
    store.state.ui.activeSheet = origSheet;
    store.state.api.mode = origMode;
    store.state.ui.sharePermission = origSharePerm;
    if (origShareUrl === undefined) {
      delete store.state.ui.shareInviteUrl;
    } else {
      store.state.ui.shareInviteUrl = origShareUrl;
    }
  }
});

test("resolveRuntimeApiConfig defaults safely on localhost vs cloud and rejects unsafe overrides", () => {
  // Node / missing window -> local defaults
  const nodeCfg = resolveRuntimeApiConfig(undefined);
  assert.equal(nodeCfg.baseUrl, "http://localhost:8000");
  assert.equal(nodeCfg.isLocalHost, true);
  assert.match(nodeCfg.supabaseUrl, /^https:\/\//);

  // Explicit localhost browser
  const localCfg = resolveRuntimeApiConfig({
    location: { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" },
    SHARELY_CONFIG: {},
  });
  assert.equal(localCfg.baseUrl, "http://localhost:8000");
  assert.equal(localCfg.isLocalHost, true);

  // Cloud deployment with injected SHARELY_CONFIG.apiBaseUrl disables dev bypass
  const cloudCfg = resolveRuntimeApiConfig({
    location: {
      protocol: "https:",
      hostname: "just-save-it-web.onrender.com",
      origin: "https://just-save-it-web.onrender.com",
    },
    SHARELY_CONFIG: {
      apiBaseUrl: "https://just-save-it-api.onrender.com/",
      supabaseUrl: "https://custom.supabase.co/ignored-path",
      supabaseAnonKey: "sb_anon_override",
    },
  });
  assert.equal(cloudCfg.baseUrl, "https://just-save-it-api.onrender.com");
  assert.equal(cloudCfg.isLocalHost, false);
  assert.equal(cloudCfg.supabaseUrl, "https://custom.supabase.co");
  assert.equal(cloudCfg.supabaseAnonKey, "sb_anon_override");

  // Cloud deployment rejecting unsafe javascript: URI & mixed-content http: override falls back to origin
  const unsafeJsCfg = resolveRuntimeApiConfig({
    location: { protocol: "https:", hostname: "app.sharely.io", origin: "https://app.sharely.io" },
    SHARELY_CONFIG: { apiBaseUrl: "javascript:alert(1)" },
  });
  assert.equal(unsafeJsCfg.baseUrl, "https://app.sharely.io");
  assert.equal(unsafeJsCfg.isLocalHost, false);

  const mixedContentCfg = resolveRuntimeApiConfig({
    location: { protocol: "https:", hostname: "app.sharely.io", origin: "https://app.sharely.io" },
    SHARELY_CONFIG: { apiBaseUrl: "http://insecure-api.example.com" },
  });
  assert.equal(mixedContentCfg.baseUrl, "https://app.sharely.io");
  assert.equal(mixedContentCfg.isLocalHost, false);
});

test("Facebook video embed, 5-image carousel, and private post fallback render properly", async () => {
  const { deriveVideoEmbedInfo, renderRichPreviewBox } = await import("../src/screens/links.js");

  const fbReel = deriveVideoEmbedInfo({
    url: "https://www.facebook.com/reel/1234567890",
    platform: "facebook",
  });
  assert.match(fbReel.embedUrl || "", /^https:\/\/www\.facebook\.com\/plugins\/video\.php\?href=/);
  assert.equal(fbReel.isVertical, true);

  const playingHtml = renderRichPreviewBox(
    { id: "fb-1", url: "https://www.facebook.com/reel/1234567890", platform: "facebook", title: "FB Reel" },
    { videoPlaying: true }
  );
  assert.match(playingHtml, /is-playing is-vertical-video/);
  assert.match(playingHtml, /plugins\/video\.php/);

  const privateHtml = renderRichPreviewBox({
    id: "fb-priv",
    url: "https://www.facebook.com/user/posts/999",
    platform: "facebook",
    previewStatus: "private_or_restricted",
  });
  assert.match(privateHtml, /is-private/);
  assert.match(privateHtml, /ไม่สามารถแสดงตัวอย่างได้/);
  assert.match(privateHtml, /Private/);

  const carouselHtml = renderRichPreviewBox({
    id: "ig-5",
    url: "https://www.instagram.com/p/abc/",
    media_items: [
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
      "https://cdn.example.com/4.jpg",
      "https://cdn.example.com/5.jpg",
    ],
  });
  assert.match(carouselHtml, /1\/5/);
});
