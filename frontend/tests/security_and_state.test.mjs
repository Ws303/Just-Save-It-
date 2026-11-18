import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { safeHrefUrl, safeImgUrl } from "../src/components/icons.js";
import {
  resolveAllowlistedEmbedUrl,
  resolveAllowlistedDirectVideoUrl,
  getPreviewMediaImages,
  formatCardDisplayTitle,
  formatPostDetailTitleAndDesc,
  isGenericOrNoisyTitle,
  renderRichPreviewBox,
} from "../src/screens/links.js";
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

  // Vertical video poster keeps is-vertical-video before play, and TikTok uses clean /player/v1/ iframe
  const { formatPostDetailTitleAndDesc } = await import("../src/screens/links.js");
  const ttPosterHtml = renderRichPreviewBox(
    {
      id: "tt-1",
      url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      platform: "tiktok",
      image_url: "https://cdn.example.com/tt-cover.jpg",
    },
    { videoPlaying: false }
  );
  assert.match(ttPosterHtml, /has-media is-vertical-video/);

  const ttPlayHtml = renderRichPreviewBox(
    {
      id: "tt-1",
      url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
      platform: "tiktok",
    },
    { videoPlaying: true }
  );
  assert.match(ttPlayHtml, /tiktok\.com\/player\/v1\/6718335390845095173\?autoplay=1&(?:amp;)?music_info=0&(?:amp;)?description=0/);

  // Social engagement noise stripped & title set to short 1-line opening sentence of caption
  const fbClean = formatPostDetailTitleAndDesc({
    url: "https://www.facebook.com/watch/?v=10155278547321729",
    platform: "facebook",
    title: "ยอดดู 75 ล้าน ครั้ง · แชร์ 1.4 แสน ครั้ง | Today, we remember what was on our minds in 2016. | Mark Zuckerberg | Facebook",
    description: "Today, we remember what was on our minds in 2016. Looking back at all the moments we shared together.",
  });
  assert.equal(fbClean.displayTitle, "Today, we remember what was on our minds in 2016.");
  assert.equal(fbClean.displayDesc, "Today, we remember what was on our minds in 2016. Looking back at all the moments we shared together.");

  const igClean = formatPostDetailTitleAndDesc({
    url: "https://www.instagram.com/p/BsOGulcndj-/",
    platform: "instagram",
    title: 'Just An Egg 🥚 บน Instagram: "Let’s set a world record together and get the most liked post"',
    description: '60M likes, 4M comments - world_record_egg บน January 4, 2019: "Let’s set a world record together and get the most liked post on Instagram!"',
  });
  assert.equal(igClean.displayTitle, "Let’s set a world record together and get the most liked…");
  assert.equal(igClean.displayDesc, "Let’s set a world record together and get the most liked post on Instagram!");

  // Photo post with plugins/post.php or instagram.com/p/.../embed must render Carousel/Image (NO Play button)
  const fbPhotoCarousel = renderRichPreviewBox(
    {
      id: "fb-photo-1",
      url: "https://www.facebook.com/page/posts/123",
      platform: "facebook",
      content_type: "post",
      embed_type: "facebook",
      embed_url: "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fpage%2Fposts%2F123",
      media_items: ["https://cdn.example.com/fb1.jpg", "https://cdn.example.com/fb2.jpg"],
    },
    { carouselIndex: 0 }
  );
  assert.doesNotMatch(fbPhotoCarousel, /play-embed-video/);
  assert.match(fbPhotoCarousel, /1\/2/);
  assert.doesNotMatch(fbPhotoCarousel, /ดูรูปทั้งหมดในโพสต์ต้นฉบับ/);

  // Last slide of carousel shows "ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗" link to original post
  const fbPhotoLastSlide = renderRichPreviewBox(
    {
      id: "fb-photo-1",
      url: "https://www.facebook.com/page/posts/123",
      platform: "facebook",
      content_type: "post",
      embed_url: "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fpage%2Fposts%2F123",
      media_items: ["https://cdn.example.com/fb1.jpg", "https://cdn.example.com/fb2.jpg"],
    },
    { carouselIndex: 1 }
  );
  assert.match(fbPhotoLastSlide, /2\/2/);
  assert.match(fbPhotoLastSlide, /ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗/);
  assert.match(fbPhotoLastSlide, /href="https:\/\/www\.facebook\.com\/page\/posts\/123"/);
  assert.match(fbPhotoLastSlide, /data-action="open-image-lightbox"/);

  // Fullscreen image lightbox modal renders when ui.imageLightboxOpen is true
  const { renderLinkDetailModals } = await import("../src/screens/links.js");
  const lightboxHtml = renderLinkDetailModals(
    { ui: { imageLightboxOpen: true, carouselIndex: 1 } },
    {
      id: "fb-photo-1",
      url: "https://www.facebook.com/page/posts/123",
      title: "Album",
      media_items: ["https://cdn.example.com/fb1.jpg", "https://cdn.example.com/fb2.jpg"],
    }
  );
  assert.match(lightboxHtml, /figma-lightbox-backdrop/);
  assert.match(lightboxHtml, /https:\/\/cdn\.example\.com\/fb2\.jpg/);
  assert.match(lightboxHtml, /ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗/);

  // Video playing preserves dynamically detected vertical aspect ratio (e.g. FB watch vertical video)
  const fbWatchVertPlaying = renderRichPreviewBox(
    {
      id: "fb-watch-v",
      url: "https://www.facebook.com/watch/?v=10155278547321729",
      platform: "facebook",
      content_type: "video",
    },
    { videoPlaying: true, playingVideoIsVertical: true, playingVideoAspect: "720 / 1280" },
    { desktop: true }
  );
  assert.match(fbWatchVertPlaying, /is-playing is-vertical-video/);
  assert.match(fbWatchVertPlaying, /aspect-ratio:\s*720\s*\/\s*1280/);
  assert.match(fbWatchVertPlaying, /data-action="stop-embed-video"/);
  assert.doesNotMatch(fbWatchVertPlaying, /figma-preview-player-bar/);

  // IG Reel with direct Meta CDN `.mp4` stream renders looping HTML5 <video controls loop> without extra UI buttons
  const validMp4 = "https://scontent-bkk1-1.cdninstagram.com/o1/v/t2/f2/m86/sample_reel.mp4?efg=1";
  assert.equal(resolveAllowlistedDirectVideoUrl(validMp4), validMp4);
  assert.equal(resolveAllowlistedDirectVideoUrl("https://evil.example.com/video.mp4"), null);
  assert.equal(resolveAllowlistedDirectVideoUrl("javascript:alert(1)"), null);

  const igDirectVideoHtml = renderRichPreviewBox(
    {
      id: "ig-reel-mp4",
      url: "https://www.instagram.com/reel/DYowlO2v1ww/",
      embed_url: "https://www.instagram.com/reel/DYowlO2v1ww/embed",
      platform: "instagram",
      content_type: "video",
    },
    { videoPlaying: true, playingVideoDirectUrl: validMp4, playingVideoIsVertical: true },
    { desktop: true }
  );
  assert.match(igDirectVideoHtml, /<video[^>]*class="figma-preview-video"[^>]*controls[^>]*loop/);
  assert.doesNotMatch(igDirectVideoHtml, /<iframe/);

  // Fallback to <iframe> when direct video URL is missing or untrusted
  const igFallbackIframeHtml = renderRichPreviewBox(
    {
      id: "ig-reel-fallback",
      url: "https://www.instagram.com/reel/DfzqfsjyQkb/",
      embed_url: "https://www.instagram.com/reel/DfzqfsjyQkb/embed",
      platform: "instagram",
      content_type: "video",
    },
    { videoPlaying: true, playingVideoDirectUrl: "https://evil.example.com/bad.mp4" },
    { desktop: true }
  );
  assert.doesNotMatch(igFallbackIframeHtml, /<video/);
  assert.match(igFallbackIframeHtml, /<iframe[^>]*src="https:\/\/www\.instagram\.com\/reel\/DfzqfsjyQkb\/embed"/);
});

test("Cross-platform generic title cleanup & single-photo IG asset dedup in Web UI and Extension", () => {
  // 1. Legacy 2-item IG single-photo array [uploaded.webp, cropped stp=c...s640x640] collapses to 1 slide
  const uploadedThumb = "http://localhost:8000/local-media/thumbnails/thumbnails/fe632666f614bba96ac01296c75ffc6b.webp";
  const igSingleLegacy = {
    id: "ig-1-dup",
    url: "https://www.instagram.com/p/DfzabQmDTBe/",
    platform: "instagram",
    content_type: "image",
    coverUrl: uploadedThumb,
    mediaItems: [
      uploadedThumb,
      "https://scontent.cdninstagram.com/v/t51.82787-15/675803457_18579207407021094_3857042213012979541_n.jpg?stp=c240.0.720.720a_dst-jpg_e35_s640x640_tt6",
      "https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=123",
    ],
  };
  assert.deepEqual(getPreviewMediaImages(igSingleLegacy), [uploadedThumb]);

  // 2. Real multi-photo carousel still preserves distinct photos
  const igMulti = {
    id: "ig-3",
    url: "https://www.instagram.com/p/Multi123/",
    platform: "instagram",
    content_type: "image",
    coverUrl: uploadedThumb,
    mediaItems: [
      uploadedThumb,
      "https://instagram.fbkk28-1.fna.fbcdn.net/v/t51/111_222_333_n.jpg?stp=dst-jpg_e15_tt6",
      "https://instagram.fbkk28-1.fna.fbcdn.net/v/t51/444_555_666_n.jpg?stp=dst-jpg_e15_tt6",
    ],
  };
  assert.equal(getPreviewMediaImages(igMulti).length, 3);

  // 3. Generic platform titles across IG / FB / TikTok / YouTube are replaced in both card & detail views
  assert.equal(isGenericOrNoisyTitle("Instagram", "instagram", "https://www.instagram.com/reel/DYowlO2v1ww/"), true);
  assert.equal(
    isGenericOrNoisyTitle("Watch trending videos for you | TikTok", "tiktok", "https://www.tiktok.com/@a/video/1"),
    true
  );

  const igReelItem = {
    url: "https://www.instagram.com/reel/DYowlO2v1ww/",
    platform: "instagram",
    content_type: "video",
    title: "Instagram",
    description: '13K likes, 120 comments - creator on June 10, 2026: "高難度招式 😎🔥\nFull breakdown". ',
  };
  assert.equal(formatCardDisplayTitle(igReelItem), "高難度招式 😎🔥");
  const igDetail = formatPostDetailTitleAndDesc(igReelItem);
  assert.equal(igDetail.displayTitle, "高難度招式 😎🔥");
  assert.equal(igDetail.displayDesc, "高難度招式 😎🔥\nFull breakdown");

  const ytNoisy = {
    url: "https://www.youtube.com/watch?v=abc",
    platform: "youtube",
    content_type: "video",
    title: "(584) Match Highlight 2026 - YouTube",
    description: "",
  };
  assert.equal(formatCardDisplayTitle(ytNoisy), "Match Highlight 2026");

  // 4. Extension api.js recognizes generic platform titles
  const require = createRequire(import.meta.url);
  const extApi = require("../../extension/api.js");
  assert.equal(extApi.isGenericPlatformTitle("Instagram"), true);
  assert.equal(extApi.isGenericPlatformTitle("Watch trending videos for you | TikTok"), true);
  assert.equal(extApi.isGenericPlatformTitle("Facebook"), true);
  assert.equal(extApi.isGenericPlatformTitle("เห็นได้ไง? | iHAVECPU"), false);

  // 5. Extension content_assist.js picks uncropped srcset over cropped stp=c, deduplicates cross-CDN Meta assets, and clears generic title
  const asset = "675803457_18579207407021094_3857042213012979541_n.jpg";
  const uncropped1080 = `https://instagram.fbkk28-1.fna.fbcdn.net/v/t51.82787-15/${asset}?stp=dst-jpg_e15_tt6`;
  const cropped1080 = `https://instagram.fbkk28-1.fna.fbcdn.net/v/t51.82787-15/${asset}?stp=c0.420.1080.1080a_dst-jpg_e35_tt6`;
  const croppedOg = `https://scontent.cdninstagram.com/v/t51.82787-15/${asset}?stp=c240.0.720.720a_dst-jpg_e35_s640x640_tt6`;

  const metaContents = {
    'meta[property="og:image"]': croppedOg,
    'meta[property="og:title"]': "Instagram",
    'meta[property="og:description"]': "เห็นได้ไง? | iHAVECPU",
    'link[rel="canonical"]': "https://www.instagram.com/p/DfzabQmDTBe/",
    'meta[property="og:site_name"]': "Instagram",
  };
  const fakeImg = {
    naturalWidth: 1080,
    naturalHeight: 1350,
    width: 500,
    height: 625,
    currentSrc: cropped1080,
    getBoundingClientRect() {
      return { width: 500, height: 625 };
    },
    getAttribute(attr) {
      if (attr === "srcset") return `${uncropped1080} 1080w, ${cropped1080} 1080w`;
      if (attr === "src") return cropped1080;
      return "";
    },
  };
  const assistSrc = readFileSync(new URL("../../extension/content_assist.js", import.meta.url), "utf8");
  const assistRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.instagram.com/p/DfzabQmDTBe/", hostname: "www.instagram.com" },
      getSelection: () => "",
    },
    document: {
      title: "Instagram",
      querySelector(sel) {
        if (metaContents[sel]) {
          return {
            getAttribute(attr) {
              return attr === "href" || attr === "content" ? metaContents[sel] : "";
            },
          };
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel.includes("article img")) {
          return [fakeImg];
        }
        return [];
      },
    },
    URL,
  });

  assert.equal(assistRes.title, "");
  assert.equal(assistRes.media_items.length, 1);
  assert.equal(assistRes.media_items[0].url, uncropped1080);
});

test("Social profiles/pages saving, TikTok photo DOM/title, YouTube community post media & contentType inference", async () => {
  const { inferContentType } = await import("../src/services/apiClient.js");
  const require = createRequire(import.meta.url);
  const extApi = require("../../extension/api.js");

  // 1. Extension allows FB pages, IG profiles, TikTok channels while blocking pure home/feed pages
  assert.equal(extApi.getSocialPostLinkWarning("https://www.facebook.com/Google"), null);
  assert.equal(extApi.getSocialPostLinkWarning("https://www.facebook.com/profile.php?id=1000123456"), null);
  assert.equal(extApi.getSocialPostLinkWarning("https://www.instagram.com/instagram/"), null);
  assert.equal(extApi.getSocialPostLinkWarning("https://www.tiktok.com/@tiktok"), null);
  assert.ok(extApi.getSocialPostLinkWarning("https://www.facebook.com/"));
  assert.ok(extApi.getSocialPostLinkWarning("https://www.facebook.com/watch"));
  assert.ok(extApi.getSocialPostLinkWarning("https://www.instagram.com/explore/"));
  assert.ok(extApi.getSocialPostLinkWarning("https://www.tiktok.com/foryou"));

  // 2. inferContentType & renderRichPreviewBox treat YT community posts & TikTok /photo/ as social/carousel, not video
  assert.equal(inferContentType({ url: "https://www.youtube.com/post/Ugkx123", platform: "YouTube" }), "social");
  assert.equal(inferContentType({ url: "https://www.youtube.com/@Google", platform: "YouTube" }), "social");
  assert.equal(inferContentType({ url: "https://www.youtube.com/@Google/shorts", platform: "YouTube" }), "social");
  assert.equal(inferContentType({ url: "https://www.youtube.com/shorts/AbCdEf12345", platform: "YouTube" }), "video");
  assert.equal(inferContentType({ url: "https://www.tiktok.com/@creator/photo/738811", platform: "TikTok" }), "social");
  assert.equal(
    inferContentType({
      url: "https://vt.tiktok.com/ZSr999/",
      canonical_url: "https://www.tiktok.com/@creator/photo/738811",
      content_type: "post",
      platform: "TikTok",
    }),
    "social"
  );
  assert.equal(inferContentType({ url: "https://www.tiktok.com/@creator", platform: "TikTok" }), "social");
  assert.equal(inferContentType({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", platform: "YouTube" }), "video");

  // 2b. Social profiles/pages preserve page/channel name instead of overwriting with bio/follower stats
  const fbProfDisp = formatPostDetailTitleAndDesc({
    url: "https://www.facebook.com/Google",
    platform: "facebook",
    title: "Google",
    description: "Google. 29M likes · 100K talking about this. Organizing the world's information.",
  });
  assert.equal(fbProfDisp.displayTitle, "Google");
  assert.equal(fbProfDisp.displayDesc, "Organizing the world's information.");

  const igProfDisp = formatPostDetailTitleAndDesc({
    url: "https://www.instagram.com/travel_th/",
    platform: "instagram",
    title: "Travel TH (@travel_th) • รูปและวิดีโอ Instagram",
    description: "ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์ - ดูรูปภาพและวิดีโอบน Instagram จาก Travel TH (@travel_th)",
  });
  assert.equal(igProfDisp.displayTitle, "Travel TH (@travel_th)");
  assert.equal(igProfDisp.displayDesc, "ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์");

  assert.equal(
    formatCardDisplayTitle({
      url: "https://www.tiktok.com/@creator",
      platform: "tiktok",
      title: "Cafe Guide TH (@creator)",
      description: "Daily coffee & cafe reviews in Thailand for fellow coffee lovers",
    }),
    "Cafe Guide TH (@creator)"
  );

  const ttPhotoHtml = renderRichPreviewBox(
    {
      id: "tt-photo-1",
      url: "https://www.tiktok.com/@creator/photo/738811",
      platform: "TikTok",
      content_type: "post",
      embed_url: "https://www.tiktok.com/embed/v2/738811",
      media_items: ["https://cdn.test/tt1.jpg", "https://cdn.test/tt2.jpg"],
    },
    {},
    { desktop: true }
  );
  assert.doesNotMatch(ttPhotoHtml, /figma-preview-play-btn/);
  assert.match(ttPhotoHtml, /1\/2/);

  // 3. Extension content_assist.js extracts TikTok /photo/ imagePost.title + desc + images
  const ttUniJson = JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: {
          itemStruct: {
            desc: "Photo caption details",
            author: { uniqueId: "creator", nickname: "CreatorTH" },
            imagePost: {
              title: "Photo Mode Title",
              images: [
                { imageURL: { urlList: ["https://p16-sign.tiktokcdn.com/tos-alisg/slide1.jpg"] } },
                { imageURL: { urlList: ["https://p16-sign.tiktokcdn.com/tos-alisg/slide2.jpg"] } },
              ],
            },
          },
        },
      },
    },
  });
  const assistSrc = readFileSync(new URL("../../extension/content_assist.js", import.meta.url), "utf8");
  const ttAssistRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.tiktok.com/@creator/photo/738811", pathname: "/@creator/photo/738811", hostname: "www.tiktok.com" },
      getSelection: () => "",
    },
    document: {
      title: "CreatorTH on TikTok",
      getElementById(id) {
        return id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" ? { textContent: ttUniJson } : null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    URL,
  });
  assert.equal(ttAssistRes.title, "Photo Mode Title");
  assert.match(ttAssistRes.description, /Photo caption details/);
  assert.equal(ttAssistRes.media_items.length, 2);

  // 4. Stale IG SPA og:url metadata & YT sidebar images are ignored cleanly by content_assist.js
  const staleIgRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.instagram.com/reel/NEW_REEL/", pathname: "/reel/NEW_REEL/", hostname: "www.instagram.com" },
      getSelection: () => "",
    },
    document: {
      title: "Instagram",
      getElementById() {
        return null;
      },
      querySelector(sel) {
        if (sel.includes('meta[property="og:url"]')) {
          return { getAttribute: () => "https://www.instagram.com/p/OLD_POST/" };
        }
        if (sel.includes('meta[property="og:image"]')) {
          return { getAttribute: () => "https://scontent.cdninstagram.com/v/t51/stale_old_post_1080.jpg" };
        }
        if (sel.includes('meta[property="og:description"]')) {
          return { getAttribute: () => "Stale caption from old post" };
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    URL,
  });
  assert.equal(staleIgRes.media_items.length, 0);
  assert.equal(staleIgRes.description, "");
  assert.equal(staleIgRes.canonical_url, "https://www.instagram.com/reel/NEW_REEL/");

  const ytVidAssistRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", pathname: "/watch", hostname: "www.youtube.com" },
      getSelection: () => "",
    },
    document: {
      title: "Video Title - YouTube",
      getElementById() {
        return null;
      },
      querySelector(sel) {
        if (sel.includes('meta[property="og:image"]')) {
          return { getAttribute: () => "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" };
        }
        return null;
      },
      querySelectorAll() {
        return [
          {
            naturalWidth: 480,
            naturalHeight: 360,
            currentSrc: "https://i.ytimg.com/vi/SIDEBAR999/hqdefault.jpg",
            getBoundingClientRect: () => ({ width: 480, height: 360 }),
            getAttribute: () => null,
          },
        ];
      },
    },
    URL,
  });
  assert.deepEqual(
    Array.from(ytVidAssistRes.media_items, (m) => m.url),
    ["https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"]
  );

  // 5. TikTok [data-e2e="user-avatar"] does NOT pollute /photo/ or /video/, nor suppress video og:image
  const ttAvatarEl = {
    naturalWidth: 120,
    naturalHeight: 120,
    currentSrc: "https://p16-sign.tiktokcdn.com/tos-alisg/header_creator_avatar_300.jpeg",
    getBoundingClientRect: () => ({ width: 120, height: 120 }),
    closest: (sel) => sel === '[data-e2e="user-avatar"]',
    getAttribute: () => null,
  };
  const ttPhotoWithAvatarRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.tiktok.com/@creator/photo/738811", pathname: "/@creator/photo/738811", hostname: "www.tiktok.com" },
      getSelection: () => "",
    },
    document: {
      title: "CreatorTH on TikTok",
      getElementById(id) {
        return id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" ? { textContent: ttUniJson } : null;
      },
      querySelector(sel) {
        if (sel.includes('meta[property="og:image"]')) {
          return { getAttribute: () => "https://p16-sign.tiktokcdn.com/tos-alisg/cropped_photo_og.jpg" };
        }
        return null;
      },
      querySelectorAll(sel) {
        return sel.includes("user-avatar") ? [ttAvatarEl] : [];
      },
    },
    URL,
  });
  assert.deepEqual(
    Array.from(ttPhotoWithAvatarRes.media_items, (m) => m.url),
    [
      "https://p16-sign.tiktokcdn.com/tos-alisg/slide1.jpg",
      "https://p16-sign.tiktokcdn.com/tos-alisg/slide2.jpg",
    ]
  );

  const ttVideoWithAvatarRes = vm.runInNewContext(assistSrc, {
    window: {
      location: { href: "https://www.tiktok.com/@creator/video/739900", pathname: "/@creator/video/739900", hostname: "www.tiktok.com" },
      getSelection: () => "",
    },
    document: {
      title: "CreatorTH on TikTok",
      getElementById: () => null,
      querySelector(sel) {
        if (sel.includes('meta[property="og:image"]')) {
          return { getAttribute: () => "https://p16-sign.tiktokcdn.com/tos-alisg/video_cover_og.jpg" };
        }
        return null;
      },
      querySelectorAll(sel) {
        return sel.includes("user-avatar") ? [ttAvatarEl] : [];
      },
    },
    URL,
  });
  assert.deepEqual(
    Array.from(ttVideoWithAvatarRes.media_items, (m) => m.url),
    ["https://p16-sign.tiktokcdn.com/tos-alisg/video_cover_og.jpg"]
  );

  // 6. Resolved vt.tiktok.com photo shortlink falls through to carousel when canonical_url contains /photo/
  const ttShortPhotoHtml = renderRichPreviewBox(
    {
      id: "tt-short-photo",
      url: "https://vt.tiktok.com/ZSr999/",
      canonical_url: "https://www.tiktok.com/@creator/photo/738811",
      platform: "TikTok",
      content_type: "post",
      embed_url: "https://www.tiktok.com/embed/v2/738811",
      media_items: ["https://cdn.test/tt1.jpg", "https://cdn.test/tt2.jpg"],
    },
    {},
    { desktop: true }
  );
  assert.doesNotMatch(ttShortPhotoHtml, /figma-preview-play-btn/);
  assert.match(ttShortPhotoHtml, /1\/2/);
});

