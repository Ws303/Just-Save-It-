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
  const mediaItems = [];

  function addImage(rawUrl) {
    const clean = toHttpUrl(rawUrl);
    if (!clean || seenImages.has(clean) || mediaItems.length >= 5) return;
    seenImages.add(clean);
    mediaItems.push({ url: clean, type: "image" });
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

  for (const video of document.querySelectorAll("video[poster]")) {
    addImage(video.getAttribute("poster"));
  }

  for (const img of document.querySelectorAll("img")) {
    if (mediaItems.length >= 5) break;
    const rect = img.getBoundingClientRect();
    const width = Math.max(rect.width || 0, img.naturalWidth || 0);
    const height = Math.max(rect.height || 0, img.naturalHeight || 0);
    if (width >= 200 && height >= 120) {
      addImage(img.currentSrc || img.getAttribute("src"));
    }
  }

  const title =
    readMeta(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    (document.title || "").trim();

  const description = readMeta([
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

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
