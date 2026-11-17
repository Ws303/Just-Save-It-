/**
 * On-demand DOM Assist extractor (F16.1).
 * Injected via chrome.scripting.executeScript only when saving or opening popup.
 * The trailing expression returns extracted metadata cleanly to the caller.
 */
(function extractPageDomAssist() {
  function readMeta(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const value = el.getAttribute("content") || el.getAttribute("href") || "";
      if (value && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  function toHttpUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const resolved = new URL(rawUrl, window.location.href).href;
      return /^https?:\/\//i.test(resolved) ? resolved : "";
    } catch (_err) {
      return "";
    }
  }

  const seenImages = new Set();
  const seenAssetKeys = new Map();
  const mediaItems = [];

  function isCroppedMetaUrl(rawUrl) {
    return /[?&]stp=c\d+\.\d+\.\d+\.\d+/i.test(rawUrl) || /[?&]stp=[^&]*cmp\d+/i.test(rawUrl) || /_s(?:640|480|320)x(?:640|480|320)/i.test(rawUrl);
  }

  function getImageAssetKey(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      const base = (parsed.pathname.split("/").pop() || "").toLowerCase();
      if ((host.includes("fbcdn.net") || host.includes("cdninstagram.com") || parsed.pathname.includes("/v/t")) && base.length >= 20) {
        return `meta:${base}`;
      }
      if (host.includes("tiktokcdn") || host.includes("muscdn")) {
        const m = parsed.pathname.match(/\/tos-[^/]+\/([A-Za-z0-9_-]{12,})(?:~|$)/);
        if (m) return `tt:${m[1]}`;
      }
    } catch (_err) {
      // Ignore parse failure
    }
    return "";
  }

  function addImage(rawUrl) {
    const clean = toHttpUrl(rawUrl);
    if (!clean || seenImages.has(clean)) return;
    if (/emoji\.php|rsrc\.php|safe_image\.php.*&w=50|p50x50|s50x50|s40x40|p32x32/i.test(clean)) return;
    const assetKey = getImageAssetKey(clean);
    if (assetKey && seenAssetKeys.has(assetKey)) {
      const prevIdx = seenAssetKeys.get(assetKey);
      const prevUrl = mediaItems[prevIdx] && mediaItems[prevIdx].url;
      if (prevUrl && isCroppedMetaUrl(prevUrl) && !isCroppedMetaUrl(clean)) {
        seenImages.delete(prevUrl);
        seenImages.add(clean);
        mediaItems[prevIdx] = { url: clean, type: "image" };
      }
      return;
    }
    if (mediaItems.length >= 5) return;
    seenImages.add(clean);
    if (assetKey) seenAssetKeys.set(assetKey, mediaItems.length);
    mediaItems.push({ url: clean, type: "image" });
  }

  function pickBestSrcsetUrl(rawSrcset) {
    if (!rawSrcset || typeof rawSrcset !== "string") return "";
    let bestUrl = "";
    let bestUncropped = -1;
    let bestScore = -1;
    const parts = rawSrcset.trim().split(/,\s*(?=(?:https?:|\/\/|\/))/);
    for (let i = 0; i < parts.length; i += 1) {
      const tokens = parts[i].trim().split(/\s+/);
      if (!tokens.length || !tokens[0]) continue;
      const cand = tokens[0].replace(/,+$/, "");
      let score = i;
      if (tokens.length > 1) {
        const desc = tokens[tokens.length - 1].toLowerCase().replace(/,+$/, "");
        if (desc.endsWith("w") && /^\d+$/.test(desc.slice(0, -1))) {
          score = Number(desc.slice(0, -1));
        } else if (desc.endsWith("x") && !Number.isNaN(Number(desc.slice(0, -1)))) {
          score = Number(desc.slice(0, -1)) * 1000;
        }
      }
      const uncropped = isCroppedMetaUrl(cand) ? 0 : 1;
      if (uncropped > bestUncropped || (uncropped === bestUncropped && score > bestScore)) {
        bestUncropped = uncropped;
        bestScore = score;
        bestUrl = cand;
      }
    }
    return bestUrl;
  }

  const hostLower = (window.location.hostname || "").toLowerCase();
  const isSocialDom = /instagram\.com|facebook\.com|tiktok\.com|x\.com|twitter\.com/.test(hostLower);

  const imageContainers = document.querySelectorAll(
    isSocialDom
      ? '[role="article"] img, [role="main"] img, main article img, [role="dialog"] img, article img'
      : '[role="main"] img, [role="article"] img, img'
  );
  for (const img of imageContainers) {
    if (mediaItems.length >= 5) break;
    const rect = img.getBoundingClientRect();
    const width = Math.max(rect.width || 0, img.naturalWidth || 0);
    const height = Math.max(rect.height || 0, img.naturalHeight || 0);
    if (width >= 200 && height >= 120) {
      addImage(pickBestSrcsetUrl(img.getAttribute("srcset")) || img.currentSrc || img.getAttribute("src"));
    }
  }

  for (const video of document.querySelectorAll("video[poster]")) {
    addImage(video.getAttribute("poster"));
  }

  const metaImageSelectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  ];
  for (const selector of metaImageSelectors) {
    const el = document.querySelector(selector);
    if (el) addImage(el.getAttribute("content"));
  }

  let title =
    readMeta(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    (document.title || "").trim();
  if (/^(?:instagram|facebook|tiktok|tiktok - make your day|watch trending videos for you \| tiktok|youtube|- youtube|x|twitter|home \/ x|reddit)$/i.test(title.trim())) {
    title = "";
  }

  let description = readMeta([
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  if (!description || /log in|เข้าสู่ระบบ (?:facebook|instagram)|ยินดีต้อนรับสู่ instagram/i.test(description)) {
    const domMsgEl =
      document.querySelector('[data-ad-preview="message"]') ||
      document.querySelector('[data-ad-comet-preview="message"]') ||
      document.querySelector('[data-e2e="browse-video-desc"]') ||
      document.querySelector('[data-e2e="video-desc"]') ||
      document.querySelector('[role="article"] div[dir="auto"]') ||
      document.querySelector("article h1");
    if (domMsgEl) {
      const msgText = String(domMsgEl.innerText || domMsgEl.textContent || "").trim();
      if (msgText.length >= 4) {
        description = msgText.slice(0, 1000);
      }
    }
  }

  const canonicalUrl =
    toHttpUrl(readMeta(['link[rel="canonical"]', 'meta[property="og:url"]'])) ||
    window.location.href;

  const siteName =
    readMeta(['meta[property="og:site_name"]']) || window.location.hostname;

  const selection =
    typeof window.getSelection === "function"
      ? String(window.getSelection() || "").trim()
      : "";

  return {
    url: window.location.href,
    canonical_url: canonicalUrl,
    title,
    description,
    site_name: siteName,
    media_items: mediaItems,
    selected_text: selection.slice(0, 600),
  };
})();
