export interface ThumbSourceLike {
  url?: string | null;
  canonical_url?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  description?: string | null;
  note?: string | null;
  user_note?: string | null;
  ai_summary?: string | null;
  platform?: string | null;
  site_name?: string | null;
  content_type?: string | null;
  contentType?: string | null;
  embed_type?: string | null;
  embed_url?: string | null;
  embedUrl?: string | null;
  preview_status?: string | null;
  previewStatus?: string | null;
  enrich_status?: string | null;
  enrich_error?: string | null;
  thumbnail_url?: string | null;
  image_url?: string | null;
  coverUrl?: string | null;
  thumb_url?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_items?: Array<string | Record<string, unknown>> | null;
  mediaItems?: Array<string | Record<string, unknown>> | null;
  tags?: string[] | null;
  tag_names?: string[] | null;
}

export interface SocialPostLinkWarning {
  platform: string;
  example: string;
  message: string;
}

export interface DerivedVideoEmbedInfo {
  embedUrl: string | null;
  thumbUrl: string;
  platform: string;
  isVertical: boolean;
}

export function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return /^https?:\/\/[^\s"'<>]+$/i.test(trimmed);
}

export function resolveMobileThumbUrl(source: ThumbSourceLike | string | null | undefined): string {
  if (!source) return "";
  if (typeof source === "string") {
    return isSafeHttpUrl(source) ? source.trim() : "";
  }
  const mediaArr = Array.isArray(source.media_items)
    ? source.media_items
    : Array.isArray(source.mediaItems)
      ? source.mediaItems
      : [];
  const firstMedia = mediaArr[0];
  let nestedUrl = "";
  if (typeof firstMedia === "string") {
    nestedUrl = firstMedia;
  } else if (firstMedia && typeof firstMedia === "object") {
    nestedUrl = String(
      firstMedia.thumbnail_url || firstMedia.thumb_url || firstMedia.media_url || firstMedia.url || "",
    );
  }
  const candidates = [
    source.thumbnail_url,
    source.coverUrl,
    source.image_url,
    source.thumb_url,
    source.media_url,
    source.media_type === "image" ? source.url : "",
    nestedUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isSafeHttpUrl(candidate)) {
      return candidate.trim();
    }
  }
  return "";
}

const META_CROPPED_STP_RE = /[?&]stp=c\d+\.\d+\.\d+\.\d+/i;
const META_DOWNSCALED_RE = /(?:[?&]stp=[^&]*cmp\d+|_s(?:640|480|320|240|150)x(?:640|480|320|240|150))/i;
const META_ASSET_FILENAME_RE = /^\d+_\d+_\d+_[a-z]\.(?:jpg|jpeg|png|webp)$/i;
const TIKTOK_ASSET_ID_RE = /\/tos-[^/]+\/([A-Za-z0-9_-]{12,})(?:~|$)/;

function getPreviewAssetKey(url: string): string {
  const exact = url.split("#")[0];
  try {
    const parsed = new URL(exact);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "";
    const base = (path.split("/").pop() || "").toLowerCase();
    if (host.includes("fbcdn.net") || host.includes("cdninstagram.com") || path.includes("/v/t")) {
      if (META_ASSET_FILENAME_RE.test(base) || base.length >= 28) {
        return `meta:${base}`;
      }
    }
    if (host.includes("tiktokcdn") || host.includes("muscdn")) {
      const m = path.match(TIKTOK_ASSET_ID_RE);
      if (m) return `tt:${m[1]}`;
    }
    if (host === "pbs.twimg.com" && path.startsWith("/media/")) {
      const twId = base.split(".")[0];
      if (twId) return `twimg:${twId}`;
    }
    if (host === "preview.redd.it" || host === "i.redd.it") {
      return `reddit:${path.toLowerCase()}`;
    }
  } catch {
    // Fallback below
  }
  return `exact:${exact}`;
}

export function getPreviewMediaImages(item: ThumbSourceLike | null | undefined): string[] {
  if (!item) return [];
  const list = Array.isArray(item.mediaItems)
    ? item.mediaItems
    : Array.isArray(item.media_items)
      ? item.media_items
      : [];
  const rawUrls = list
    .map((m) => {
      if (typeof m === "string") return m.trim();
      if (m && typeof m === "object") {
        return String(m.media_url || m.url || m.thumbnail_url || m.thumb_url || "").trim();
      }
      return "";
    })
    .filter((u) => isSafeHttpUrl(u));

  const deduped: string[] = [];
  const posByAssetKey = new Map<string, number>();
  for (const url of rawUrls) {
    const key = getPreviewAssetKey(url);
    const isExact = key.startsWith("exact:");
    const isCropped = META_CROPPED_STP_RE.test(url) || META_DOWNSCALED_RE.test(url);
    const prevIdx = posByAssetKey.get(key);
    if (prevIdx !== undefined) {
      if (!isExact && !isCropped) {
        const prevUrl = deduped[prevIdx];
        if (META_CROPPED_STP_RE.test(prevUrl) || META_DOWNSCALED_RE.test(prevUrl)) {
          deduped[prevIdx] = url;
        }
      }
      continue;
    }
    posByAssetKey.set(key, deduped.length);
    deduped.push(url);
  }

  if (deduped.length >= 2 && /\/thumbnails\/[a-f0-9]{16,64}\.webp/i.test(deduped[0])) {
    return [
      deduped[0],
      ...deduped
        .slice(1)
        .filter(
          (u) =>
            !(
              (META_CROPPED_STP_RE.test(u) && /_s(?:640|480|320)x(?:640|480|320)/i.test(u)) ||
              u.toLowerCase().includes("lookaside.fbsbx.com")
            ),
        ),
    ].slice(0, 5);
  }

  if (deduped.length > 0) {
    return deduped.slice(0, 5);
  }

  const single = resolveMobileThumbUrl(item);
  return single ? [single] : [];
}

const EMBED_ALLOWLIST_RULES: Array<{
  hosts: string[];
  exact: boolean;
  check: (p: string) => boolean;
}> = [
  {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"],
    exact: false,
    check: (p) => p.startsWith("/embed/"),
  },
  {
    hosts: ["tiktok.com", "www.tiktok.com"],
    exact: false,
    check: (p) => p.startsWith("/embed/") || p.startsWith("/player/v1/"),
  },
  { hosts: ["player.vimeo.com"], exact: true, check: (p) => p.startsWith("/video/") },
  { hosts: ["open.spotify.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  { hosts: ["platform.twitter.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  {
    hosts: ["facebook.com", "www.facebook.com", "web.facebook.com"],
    exact: false,
    check: (p) => p.startsWith("/plugins/"),
  },
  {
    hosts: ["instagram.com", "www.instagram.com"],
    exact: false,
    check: (p) => /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/embed\/?$/.test(p),
  },
  {
    hosts: ["embed.reddit.com", "redditmedia.com", "www.redditmedia.com"],
    exact: false,
    check: (p) => p.startsWith("/r/") || p.startsWith("/mediaembed/"),
  },
];

export function resolveAllowlistedEmbedUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "/";
    if (path.split("/").includes("..")) return null;
    const matched = EMBED_ALLOWLIST_RULES.some((rule) => {
      const hostOk = rule.exact
        ? rule.hosts.includes(host)
        : rule.hosts.some((h) => host === h || host.endsWith(`.${h}`));
      return hostOk && rule.check(path);
    });
    return matched ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function resolveAllowlistedDirectVideoUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    const allowed =
      host === "cdninstagram.com" ||
      host.endsWith(".cdninstagram.com") ||
      host === "fbcdn.net" ||
      host.endsWith(".fbcdn.net");
    return allowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function isPlayableVideoEmbed(embedUrl: string | null | undefined, item?: ThumbSourceLike | null): boolean {
  if (!embedUrl) return false;
  const contentType = String(item?.contentType || item?.content_type || "").toLowerCase();
  const rawUrlLower = String(item?.canonical_url || item?.canonicalUrl || item?.url || "").toLowerCase();
  try {
    const parsed = new URL(embedUrl);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.includes("facebook.com") && path.includes("/plugins/post.php")) {
      return false;
    }
    if (host.includes("instagram.com") && path.startsWith("/p/") && contentType !== "video") {
      return false;
    }
    if (host.includes("tiktok.com") && /\/photo\//.test(rawUrlLower)) {
      return false;
    }
    if (
      host.includes("youtube.com") &&
      /youtube\.com\/(?:post\/|@|channel\/|c\/|user\/)/.test(rawUrlLower) &&
      !/[?&]v=|\/(?:watch|shorts|embed|live)\//.test(rawUrlLower) &&
      contentType !== "video"
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function deriveVideoEmbedInfo(item: ThumbSourceLike | null | undefined): DerivedVideoEmbedInfo {
  const rawUrl = String(item?.url || "").trim();
  const explicitEmbed = resolveAllowlistedEmbedUrl(item?.embedUrl || item?.embed_url);
  let embedUrl = isPlayableVideoEmbed(explicitEmbed, item) ? explicitEmbed : null;
  let thumbUrl = "";
  let platform = String(item?.platform || "");
  let isVertical = Boolean(
    embedUrl && (embedUrl.includes("tiktok.com/") || /instagram\.com\/(?:reel|tv)\//i.test(embedUrl)),
  );

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (host === "youtu.be" || host.endsWith(".youtu.be") || host.includes("youtube.com")) {
        let ytId = "";
        if (host === "youtu.be" || host.endsWith(".youtu.be")) {
          ytId = parsed.pathname.split("/").filter(Boolean)[0] || "";
        } else if (parsed.pathname === "/watch") {
          ytId = parsed.searchParams.get("v") || "";
        } else {
          const m = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
          if (m) ytId = m[1];
        }
        if (parsed.pathname.startsWith("/shorts/")) isVertical = true;
        if (/^[A-Za-z0-9_-]{6,}$/.test(ytId)) {
          embedUrl = embedUrl || `https://www.youtube.com/embed/${ytId}`;
          thumbUrl = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
          platform = platform || "YouTube";
        }
      } else if (host === "vimeo.com" || host === "www.vimeo.com") {
        const vm = parsed.pathname.match(/^\/(\d{5,})/);
        if (vm) {
          embedUrl = embedUrl || `https://player.vimeo.com/video/${vm[1]}`;
          platform = platform || "Vimeo";
        }
      } else if (host.includes("tiktok.com")) {
        isVertical = true;
        const tm = parsed.pathname.match(/\/video\/(\d+)/);
        if (tm) {
          embedUrl = embedUrl || `https://www.tiktok.com/embed/v2/${tm[1]}`;
          platform = platform || "TikTok";
        }
      } else if (host.includes("instagram.com")) {
        const igMatch = parsed.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
        if (igMatch) {
          const kind = igMatch[1].toLowerCase() === "reels" ? "reel" : igMatch[1].toLowerCase();
          if (kind === "reel" || kind === "tv") isVertical = true;
          if (!embedUrl && kind === "reel") {
            embedUrl = `https://www.instagram.com/reel/${igMatch[2]}/embed`;
          }
          platform = platform || "Instagram";
        }
      } else if (host.includes("facebook.com") || host === "fb.watch") {
        const pathLower = (parsed.pathname || "").toLowerCase();
        const isFbVideo =
          host === "fb.watch" ||
          /\/(?:watch|videos|reel|reels)\b/.test(pathLower) ||
          Boolean(parsed.searchParams.get("v"));
        if (/\/reel\b/.test(pathLower)) isVertical = true;
        if (isFbVideo && !embedUrl && host !== "fb.watch" && !pathLower.startsWith("/share/")) {
          embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(rawUrl)}&show_text=false`;
          platform = platform || "Facebook";
        }
      }
    } catch {
      // Ignore malformed URLs
    }
  }
  return { embedUrl: resolveAllowlistedEmbedUrl(embedUrl), thumbUrl, platform, isVertical };
}

export function withAutoplayParam(embedUrl: string): string {
  try {
    const u = new URL(embedUrl);
    if (u.hostname.includes("tiktok.com")) {
      const vidMatch = u.pathname.match(/\/(?:embed\/v2|player\/v1)\/(\d+)/);
      if (vidMatch) {
        return `https://www.tiktok.com/player/v1/${vidMatch[1]}?autoplay=1&music_info=0&description=0&rel=0`;
      }
    }
    if (
      u.hostname.includes("youtube.com") ||
      u.hostname.includes("youtube-nocookie.com") ||
      u.hostname.includes("vimeo.com") ||
      (u.hostname.includes("facebook.com") && u.pathname.includes("/plugins/video.php"))
    ) {
      u.searchParams.set("autoplay", "1");
      u.searchParams.set("playsinline", "1");
    }
    return u.toString();
  } catch {
    return embedUrl;
  }
}

/**
 * Resolve the safest playable URL for mobile in-app SFSafariViewController (`WebBrowser.openBrowserAsync`).
 * YouTube `/embed/*` rejects top-level browser loads lacking an iframe Referer with Error 153, so
 * YouTube and Vimeo are mapped to canonical watch pages while IG uses direct `.mp4` when available.
 */
export function resolveMobilePlayUrl(
  item: ThumbSourceLike | null | undefined,
  embedUrl: string | null | undefined,
  directMp4?: string | null,
): string | null {
  const safeDirect = resolveAllowlistedDirectVideoUrl(directMp4);
  if (safeDirect) return safeDirect;

  const safeEmbed = resolveAllowlistedEmbedUrl(embedUrl);
  if (!safeEmbed) {
    const rawUrl = String(item?.url || "").trim();
    return /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
  }

  try {
    const parsedEmbed = new URL(safeEmbed);
    const host = parsedEmbed.hostname.toLowerCase();
    const path = parsedEmbed.pathname || "/";
    const rawUrl = String(item?.url || "").trim();

    if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
      const m = path.match(/^\/embed\/([A-Za-z0-9_-]{6,})/);
      if (m) {
        const ytId = m[1];
        const isShorts = /youtube\.com\/shorts\//i.test(rawUrl);
        return isShorts ? `https://www.youtube.com/shorts/${ytId}` : `https://www.youtube.com/watch?v=${ytId}`;
      }
    }

    if (host === "player.vimeo.com") {
      const vm = path.match(/^\/video\/(\d{5,})/);
      if (vm) return `https://vimeo.com/${vm[1]}`;
    }

    if (host.includes("instagram.com") && /^https?:\/\/(?:www\.)?instagram\.com\//i.test(rawUrl)) {
      return rawUrl;
    }
  } catch {
    // Fallback below
  }

  return withAutoplayParam(safeEmbed);
}

export type InlinePlayerSource =
  | { kind: "uri"; uri: string }
  | { kind: "html"; html: string; baseUrl: string };

const INLINE_PLAYER_BASE_URL = "https://just-save-it-web.onrender.com";

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapInlineMediaHtml(bodyMarkup: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}iframe,video{width:100%;height:100%;border:0;display:block;object-fit:contain;background:#000}</style></head><body>${bodyMarkup}</body></html>`;
}

/**
 * Resolve an embedded WebView playback source so videos play inline inside the detail screen
 * without launching an external browser sheet.
 */
export function resolveInlinePlayerSource(
  embedUrl: string | null | undefined,
  directMp4?: string | null,
): InlinePlayerSource | null {
  const safeDirect = resolveAllowlistedDirectVideoUrl(directMp4);
  if (safeDirect) {
    const safeSrc = escapeHtmlAttr(safeDirect);
    return {
      kind: "html",
      baseUrl: INLINE_PLAYER_BASE_URL,
      html: wrapInlineMediaHtml(
        `<video src="${safeSrc}" autoplay controls playsinline webkit-playsinline preload="auto"></video>`,
      ),
    };
  }

  const safeEmbed = resolveAllowlistedEmbedUrl(embedUrl);
  if (!safeEmbed) return null;

  const autoplayUrl = withAutoplayParam(safeEmbed);
  try {
    const host = new URL(autoplayUrl).hostname.toLowerCase();
    if (
      host.includes("youtube.com") ||
      host.includes("youtube-nocookie.com") ||
      host === "player.vimeo.com"
    ) {
      const safeSrc = escapeHtmlAttr(autoplayUrl);
      return {
        kind: "html",
        baseUrl: INLINE_PLAYER_BASE_URL,
        html: wrapInlineMediaHtml(
          `<iframe src="${safeSrc}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
        ),
      };
    }
  } catch {
    return null;
  }

  return { kind: "uri", uri: autoplayUrl };
}

const FB_STATS_SEG_RE =
  /(?:\d|แสน|ล้าน|พัน|หมื่น).*(?:ยอดดู|รับชม|ความรู้สึก|ถูกใจ|ความคิดเห็น|คอมเมนต์|แชร์|ผู้ติดตาม|คนกำลังพูดถึง|views?|reactions?|likes?|comments?|shares?|followers?)|(?:ยอดดู|รับชม|ความรู้สึก|ถูกใจ|ความคิดเห็น|คอมเมนต์|แชร์|ผู้ติดตาม|views?|reactions?|likes?|comments?|shares?).*(?:\d|แสน|ล้าน|พัน|หมื่น)/i;
const FB_INLINE_STATS_TH_RE =
  /(?:(?<=\.\s)|^)(?:ผู้ติดตาม|ถูกใจ)\s*[\d,.]+\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*คน(?:\s*·\s*[\d,.]+\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*คน[^\s.]*)*\.?\s*/gi;
const FB_INLINE_STATS_EN_RE =
  /(?:(?<=\.\s)|^)[\d,.]+[KMBkmb]?\s+(?:likes?|followers?)(?:\s*·\s*[\d,.]+[KMBkmb]?\s+(?:talking about this|were here|followers?))*\.?\s*/gi;
const IG_OG_TITLE_RE = /^(.+?)\s+(?:on|บน)\s+Instagram:\s*["“”]?([\s\S]+?)["“”]?\s*$/i;
const IG_OG_DESC_RE =
  /^(?:[\d,.]+[KMBkmb]?\s*(?:likes?|comments?)|(?:ถูกใจ|ความคิดเห็น)\s*[^,-]+)(?:[\s,·•]+(?:[\d,.]+[KMBkmb]?\s*(?:likes?|comments?)|(?:ถูกใจ|ความคิดเห็น)\s*[^,-]+))*\s*-\s*([A-Za-z0-9._]+)(?:\s+(?:on|บน|เมื่อ)\s+[^:]+)?:\s*([\s\S]*?)\s*$/i;
const IG_PROFILE_STATS_RE =
  /^(?:ผู้ติดตาม\s*[^-]+|[\d,.]+[KMBkmb]?\s*Followers,\s*[\d,.]+[KMBkmb]?\s*Following,\s*[\d,.]+[KMBkmb]?\s*Posts)\s*-\s*/i;
const IG_PROFILE_TITLE_RE =
  /^(.+?)\s*\((@?[A-Za-z0-9._]+)\)\s*[•·]\s*(?:Instagram|รูปภาพและวิดีโอบน\s*Instagram|รูปและวิดีโอ\s*Instagram).*$/i;
const IG_PROFILE_SEE_RE =
  /^(?:ดูรูปภาพและวิดีโอบน\s*Instagram\s*จาก|See Instagram photos and videos from)\s+(.+?)(?:\s*\((@?[A-Za-z0-9._]+)\))?\s*(?::\s*([\s\S]*))?$/i;
const TT_META_DESC_RE =
  /^(?:[\d,.]+[KMBkmb]?\s*Likes?(?:,\s*[\d,.]+[KMBkmb]?\s*Comments?)?\.?\s*|ถูกใจ\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*ครั้ง(?:,\s*ความคิดเห็น\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*รายการ)?\.?\s*)(?:TikTok (?:video|photo) from\s+([^:]+):\s*["“”]?([\s\S]+?)["“”]?\s*$|(?:วิดีโอ|รูปภาพ|โพสต์)\s*TikTok\s*จาก\s+([^:]+):\s*["“”]?([\s\S]+?)["“”]?\s*$)?/i;
const NOTIFICATION_PREFIX_RE = /^\(\d+\+?\)\s+/;
const GENERIC_PLATFORM_TITLES = new Set([
  "instagram",
  "log in • instagram",
  "login • instagram",
  "เข้าสู่ระบบ • instagram",
  "เข้าสู่ระบบ instagram",
  "instagram photo",
  "instagram video",
  "instagram reel",
  "instagram reels",
  "facebook",
  "facebook - log in or sign up",
  "facebook - เข้าสู่ระบบหรือสมัครใช้งาน",
  "log into facebook",
  "log in to facebook",
  "เข้าสู่ระบบ facebook",
  "watch",
  "facebook watch",
  "reels",
  "facebook reels",
  "tiktok",
  "tiktok - make your day",
  "watch trending videos for you",
  "watch trending videos for you | tiktok",
  "explore - find your favourite videos on tiktok",
  "discover | tiktok",
  "เข้าสู่ระบบ | tiktok",
  "youtube",
  "- youtube",
  "home - youtube",
  "shorts - youtube",
  "x",
  "twitter",
  "home / x",
  "log in to x / x",
  "explore / x",
  "x (formerly twitter)",
  "reddit",
  "reddit - dive into anything",
  "reddit - the heart of the internet",
  "vimeo",
  "spotify",
  "spotify – web player",
  "threads",
  "pinterest",
]);

export function stripBalancedCaptionQuotes(rawCap: string | null | undefined): string {
  const cap = String(rawCap || "").trim();
  if ((cap.startsWith('"') && cap.endsWith('".')) || (cap.startsWith("“") && cap.endsWith("”."))) {
    return cap.slice(1, -2).trim();
  }
  if ((cap.startsWith('"') && cap.endsWith('"')) || (cap.startsWith("“") && cap.endsWith("”"))) {
    return cap.slice(1, -1).trim();
  }
  const dqCount = (cap.match(/"/g) || []).length;
  const cdqCount = (cap.match(/”/g) || []).length;
  if ((cap.endsWith('".') && dqCount % 2 === 1) || (cap.endsWith("”.") && cdqCount % 2 === 1)) {
    return cap.slice(0, -2).trim();
  }
  return cap;
}

export function isGenericOrNoisyTitle(
  title: string | null | undefined,
  platformLower = "",
  rawUrl = "",
): boolean {
  const stripped = String(title || "").trim();
  if (!stripped) return true;
  const lowered = stripped.toLowerCase();
  if (/^https?:\/\//i.test(stripped)) return true;
  if (rawUrl) {
    const rawTrim = String(rawUrl).trim().toLowerCase();
    if (lowered === rawTrim) return true;
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host && (lowered === host || lowered === host.replace(/^www\./, ""))) return true;
    } catch {
      // Ignore invalid URL
    }
  }
  const noBadge = stripped.replace(NOTIFICATION_PREFIX_RE, "").trim();
  const noBadgeLower = noBadge.toLowerCase();
  if (GENERIC_PLATFORM_TITLES.has(lowered) || GENERIC_PLATFORM_TITLES.has(noBadgeLower)) return true;
  if (
    NOTIFICATION_PREFIX_RE.test(stripped) &&
    (/\s*[-–|]\s*YouTube$/i.test(stripped) || GENERIC_PLATFORM_TITLES.has(noBadgeLower))
  ) {
    return true;
  }
  if (
    (platformLower.includes("instagram") || /instagram\.com/i.test(rawUrl)) &&
    /^@?[A-Za-z0-9._]+\s+(?:on|บน)\s+Instagram\s*$/i.test(noBadge)
  ) {
    return true;
  }
  if (
    (platformLower.includes("tiktok") || /tiktok\.com/i.test(rawUrl)) &&
    (/^(?:watch trending|discover|make your day|tiktok)\b.*\|\s*tiktok$/i.test(noBadgeLower) ||
      /^(?:[^|\n]+\s+(?:on|บน)\s+tiktok|tiktok's creator profile|photo on tiktok)$/i.test(noBadgeLower))
  ) {
    return true;
  }
  return false;
}

export function scrubGenericPlatformTitle(
  title: string | null | undefined,
  platformLower = "",
  rawUrl = "",
): string {
  const stripped = String(title || "").trim();
  if (!stripped) return "";
  if (!isGenericOrNoisyTitle(stripped, platformLower, rawUrl)) return stripped;
  let cleaned = stripped.replace(NOTIFICATION_PREFIX_RE, "").trim();
  if (platformLower.includes("youtube") || /youtube\.com|youtu\.be/i.test(rawUrl)) {
    cleaned = cleaned.replace(/\s*[-–|]\s*YouTube\s*$/i, "").trim();
  } else if (platformLower === "x" || /x\.com|twitter\.com/i.test(rawUrl)) {
    cleaned = cleaned.replace(/\s*\/\s*(?:X|Twitter)\s*$/i, "").trim();
  } else if (platformLower.includes("tiktok") || /tiktok\.com/i.test(rawUrl)) {
    cleaned = cleaned.replace(/\s*\|\s*TikTok\s*$/i, "").trim();
  } else if (platformLower.includes("facebook") || /facebook\.com|fb\.watch/i.test(rawUrl)) {
    cleaned = cleaned.replace(/\s*\|\s*Facebook\s*$/i, "").trim();
  }
  if (!cleaned || isGenericOrNoisyTitle(cleaned, platformLower, rawUrl)) return "";
  return cleaned;
}

function extractSocialUrlAuthor(rawUrl: string, platformLower: string): string {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const segs = (parsed.pathname || "").split("/").filter(Boolean);
    if (!segs.length) return "";
    const first = segs[0];
    if (platformLower.includes("tiktok") && first.startsWith("@")) return first;
    if (
      platformLower.includes("instagram") &&
      !["p", "reel", "reels", "tv", "stories", "explore", "share", "accounts"].includes(first.toLowerCase())
    ) {
      return first.startsWith("@") ? first : `@${first}`;
    }
    if (
      platformLower.includes("facebook") &&
      ![
        "watch",
        "reel",
        "reels",
        "share",
        "plugins",
        "photo",
        "photo.php",
        "permalink.php",
        "story.php",
        "videos",
        "groups",
        "events",
        "login",
      ].includes(first.toLowerCase())
    ) {
      return first;
    }
  } catch {
    // Ignore invalid URL
  }
  return "";
}

const IG_RESERVED_ROOT_PATHS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "share",
  "stories",
  "explore",
  "direct",
  "accounts",
  "about",
  "legal",
  "developer",
  "directory",
]);
const FB_FEED_PATHS = new Set([
  "",
  "/",
  "/home.php",
  "/watch",
  "/reel",
  "/reels",
  "/marketplace",
  "/gaming",
  "/groups/feed",
  "/bookmarks",
  "/notifications",
  "/messages",
  "/friends",
  "/saved",
  "/memories",
  "/settings",
  "/login",
  "/login.php",
]);

function isSocialProfileOrPageUrl(rawUrl: string, platformLower = ""): boolean {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "/";
    const normPath = path.replace(/\/+$/, "").toLowerCase() || "/";
    const params = parsed.searchParams;
    if (platformLower.includes("instagram") || host === "instagram.com" || host.endsWith(".instagram.com")) {
      if (/^\/(?:[^/]+\/)?(?:p|reel|reels|tv|share)\/[A-Za-z0-9_-]+/i.test(path)) return false;
      const m = path.match(/^\/([A-Za-z0-9._]+)\/?$/);
      return Boolean(m && !IG_RESERVED_ROOT_PATHS.has(m[1].toLowerCase()));
    }
    if (platformLower.includes("tiktok") || host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return /^\/@[A-Za-z0-9._-]+\/?$/i.test(path);
    }
    if (
      (platformLower.includes("facebook") || host === "facebook.com" || host.endsWith(".facebook.com")) &&
      host !== "fb.watch" &&
      !host.endsWith(".fb.watch")
    ) {
      if (
        /(?:^\/share\/(?:[pvr]\/)?[A-Za-z0-9_-]+|\/(?:posts|videos|photos|permalink)\/[^/]+|^\/(?:reel|reels)\/[^/]+|^\/(?:permalink|story|photo)\.php|^\/(?:watch|reel|reels|videos|video\.php)(?:\/|$)|pfbid[A-Za-z0-9]+)/i.test(
          path,
        )
      ) {
        return false;
      }
      if (params.get("story_fbid") || params.get("fbid") || params.get("v") || params.get("multi_permalinks")) {
        return false;
      }
      if (normPath === "/profile.php") return Boolean(params.get("id"));
      if (FB_FEED_PATHS.has(normPath)) return false;
      return normPath !== "/";
    }
  } catch {
    // Ignore invalid URL
  }
  return false;
}

function normalizeCompareCaption(str: string, collapseSpaces = false): string {
  const cleaned = String(str || "")
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’….\-]+$/g, "");
  return (collapseSpaces ? cleaned.replace(/\s+/g, "") : cleaned.replace(/\s+/g, " ")).toLowerCase();
}

function extractShortOpeningTitle(caption: string, maxChars = 58): string {
  const raw = String(caption || "");
  if (!raw.trim()) return "";
  let firstLine = "";
  for (const ln of raw.split(/\r?\n/)) {
    const cleaned = ln
      .replace(/\*\*|__/g, "")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
    if (cleaned) {
      firstLine = cleaned.replace(/\s+/g, " ");
      break;
    }
  }
  if (!firstLine) return "";

  const sentMatch = firstLine.match(/^(.{8,}?[!?.])(?:\s+|$)/);
  if (sentMatch && sentMatch[1].trim().length <= maxChars) {
    return sentMatch[1].trim();
  }
  if (firstLine.length <= maxChars) {
    return firstLine;
  }
  const windowStr = firstLine.slice(0, maxChars);
  const spaceIdx = windowStr.lastIndexOf(" ");
  if (spaceIdx >= 16) {
    return `${windowStr.slice(0, spaceIdx).replace(/[\s,;:\-—–·•.]+$/, "")}…`;
  }
  return `${windowStr.replace(/[\s,;:\-—–·•.]+$/, "")}…`;
}

function combineAuthorDisplay(displayAuthor: string, handleAuthor: string): string {
  const disp = String(displayAuthor || "").trim();
  const hnd = String(handleAuthor || "").trim();
  if (disp && hnd) {
    const normDisp = disp.replace(/^@/, "").toLowerCase();
    const normHnd = hnd.replace(/^@/, "").toLowerCase();
    if (normDisp === normHnd || normDisp.includes(normHnd)) return disp;
    return `${disp} (${hnd.startsWith("@") ? hnd : `@${hnd}`})`;
  }
  return disp || hnd || "";
}

export function formatPostDetailTitleAndDesc(item: ThumbSourceLike | null | undefined): {
  displayTitle: string;
  displayDesc: string;
} {
  const rawTitle = String(item?.title || "").trim();
  const rawDesc = String(item?.description || "").trim();
  const rawUrl = String(item?.url || "").trim();
  const effectiveUrl = String(item?.canonical_url || item?.canonicalUrl || rawUrl).trim();
  const platLower = String(item?.platform || "").toLowerCase();
  const isFb =
    platLower.includes("facebook") || effectiveUrl.includes("facebook.com") || effectiveUrl.includes("fb.watch");
  const isIg = platLower.includes("instagram") || effectiveUrl.includes("instagram.com");
  const isTt = platLower.includes("tiktok") || effectiveUrl.includes("tiktok.com");
  const isProfileOrPage = (isFb || isIg || isTt) && isSocialProfileOrPageUrl(effectiveUrl, platLower);

  if (!isFb && !isIg && !isTt) {
    const cleanedTitle = scrubGenericPlatformTitle(rawTitle, platLower, rawUrl);
    const nonGenericTitle =
      cleanedTitle ||
      (rawDesc && !rawDesc.startsWith("By ") ? extractShortOpeningTitle(rawDesc) : "") ||
      rawTitle ||
      rawUrl;
    const sameNonSocial =
      Boolean(rawDesc) && normalizeCompareCaption(rawDesc) === normalizeCompareCaption(nonGenericTitle);
    return {
      displayTitle: nonGenericTitle,
      displayDesc: sameNonSocial ? "" : rawDesc,
    };
  }

  let t = rawTitle;
  let d = rawDesc;
  let displayAuthor = "";
  let handleAuthor = "";

  if (isFb) {
    if (t.includes("|")) {
      const parts = t
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);
      while (parts.length > 1 && FB_STATS_SEG_RE.test(parts[0])) {
        parts.shift();
      }
      if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === "facebook") {
        parts.pop();
      }
      if (parts.length >= 2) {
        if (parts[0].length <= 45 && parts[1].length > parts[0].length) {
          displayAuthor = parts[0];
          t = parts.slice(1).join(" | ").trim() || displayAuthor;
        } else {
          displayAuthor = parts[parts.length - 1];
          t = parts.slice(0, -1).join(" | ").trim() || displayAuthor;
        }
      } else if (parts.length === 1) {
        t = parts[0];
      }
    } else if (FB_STATS_SEG_RE.test(t) && t.length < 80) {
      t = "";
    }
    if (d) {
      if (d.includes("|")) {
        const dParts = d
          .split("|")
          .map((p) => p.trim())
          .filter(Boolean);
        while (dParts.length > 1 && FB_STATS_SEG_RE.test(dParts[0])) {
          dParts.shift();
        }
        d = dParts.join(" | ").trim();
      }
      d = d.replace(FB_INLINE_STATS_TH_RE, "").replace(FB_INLINE_STATS_EN_RE, "").trim();
      if (t && d.startsWith(`${t}. `)) {
        d = d.slice(t.length + 2).trim();
      } else if (t && d.startsWith(`${t} `) && t.length <= 45) {
        d = d.slice(t.length).replace(/^[\s.\-·•]+/, "").trim();
      }
    }
  } else if (isIg) {
    const mProfT = t.match(IG_PROFILE_TITLE_RE);
    const mSeeT = !mProfT ? t.match(IG_PROFILE_SEE_RE) : null;
    const mTitle = !mProfT && !mSeeT ? t.match(IG_OG_TITLE_RE) : null;
    if (mProfT) {
      displayAuthor = mProfT[1].trim();
      handleAuthor = `@${mProfT[2].trim().replace(/^@/, "")}`;
      t = combineAuthorDisplay(displayAuthor, handleAuthor);
    } else if (mSeeT) {
      displayAuthor = mSeeT[1].trim();
      if (mSeeT[2]) handleAuthor = `@${mSeeT[2].trim().replace(/^@/, "")}`;
      t = combineAuthorDisplay(displayAuthor, handleAuthor);
    } else if (mTitle) {
      displayAuthor = mTitle[1].trim();
      const cap = mTitle[2].trim();
      t = cap ? `${displayAuthor}: ${cap}` : displayAuthor;
    }
    if (d) {
      const mDesc = d.match(IG_OG_DESC_RE);
      if (mDesc) {
        handleAuthor = `@${mDesc[1].trim().replace(/^@/, "")}`;
        d = stripBalancedCaptionQuotes(mDesc[2]);
      } else {
        const statsM = d.match(IG_PROFILE_STATS_RE);
        const statsPrefix = statsM ? statsM[0].replace(/\s*-\s*$/, "").trim() : "";
        const dAfterStats = d.replace(IG_PROFILE_STATS_RE, "").trim();
        const mSeeD = dAfterStats.match(IG_PROFILE_SEE_RE);
        if (mSeeD) {
          if (!displayAuthor) displayAuthor = mSeeD[1].trim();
          if (mSeeD[2] && !handleAuthor) handleAuthor = `@${mSeeD[2].trim().replace(/^@/, "")}`;
          const trailingBio = stripBalancedCaptionQuotes(mSeeD[3] || "");
          if (trailingBio && statsPrefix) {
            d = `${statsPrefix} — ${trailingBio}`;
          } else {
            d = trailingBio || statsPrefix;
          }
          if (isProfileOrPage && (!t || IG_PROFILE_SEE_RE.test(t))) {
            t = combineAuthorDisplay(displayAuthor, handleAuthor) || t;
          }
        } else {
          d = stripBalancedCaptionQuotes(dAfterStats);
        }
      }
    }
  } else if (isTt && d) {
    const mTt = d.match(TT_META_DESC_RE);
    if (mTt && (mTt[1] || mTt[3])) {
      displayAuthor = (mTt[1] || mTt[3] || "").trim();
      d = stripBalancedCaptionQuotes(mTt[2] || mTt[4] || "");
    } else {
      d = d
        .replace(
          /^(?:[\d,.]+[KMBkmb]?\s*Likes?(?:,\s*[\d,.]+[KMBkmb]?\s*Comments?)?\.?\s*|ถูกใจ\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*ครั้ง(?:,\s*ความคิดเห็น\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*รายการ)?\.?\s*)/i,
          "",
        )
        .trim();
    }
  }

  t = scrubGenericPlatformTitle(t, platLower, effectiveUrl);

  if (isProfileOrPage) {
    if (!t) {
      t =
        combineAuthorDisplay(displayAuthor, handleAuthor) ||
        extractSocialUrlAuthor(effectiveUrl, isFb ? "facebook" : isIg ? "instagram" : "tiktok") ||
        String(item?.site_name || "").trim() ||
        rawTitle ||
        rawUrl;
    }
    const sameProfileText = Boolean(t && d && normalizeCompareCaption(t) === normalizeCompareCaption(d));
    return {
      displayTitle: t,
      displayDesc: sameProfileText ? "" : d,
    };
  }

  let tCore = t;
  let dCore = d;
  const mTc = t.match(/^([^:\n|]{1,50}):\s+([\s\S]+)$/);
  if (mTc && !/^https?$/i.test(mTc[1].trim())) {
    if (!displayAuthor) displayAuthor = mTc[1].trim();
    tCore = mTc[2].trim();
  }
  tCore = scrubGenericPlatformTitle(tCore, platLower, rawUrl);
  dCore = stripBalancedCaptionQuotes(dCore);
  const mDc = dCore.match(/^(@[A-Za-z0-9._-]+)\s+[—–-]\s+([\s\S]+)$/);
  if (mDc) {
    if (!handleAuthor) handleAuthor = mDc[1].trim();
    dCore = mDc[2].trim();
  } else {
    const mDc2 = dCore.match(/^([^:\n|—]{1,50})\s+—\s+([\s\S]+)$/);
    if (mDc2) {
      if (!displayAuthor) displayAuthor = mDc2[1].trim();
      dCore = mDc2[2].trim();
    }
  }
  dCore = stripBalancedCaptionQuotes(dCore);

  const normT = normalizeCompareCaption(tCore);
  const normD = normalizeCompareCaption(dCore);
  const normTCompact = normalizeCompareCaption(tCore, true);
  const normDCompact = normalizeCompareCaption(dCore, true);
  const isDup =
    Boolean(normT && normD) &&
    (normT === normD ||
      Boolean(normTCompact && normTCompact === normDCompact) ||
      (normT.length >= 12 && (normD.startsWith(normT) || normT.startsWith(normD))) ||
      (normTCompact.length >= 12 &&
        (normDCompact.startsWith(normTCompact) || normTCompact.startsWith(normDCompact))));

  const isSyntheticDesc =
    Boolean(dCore) && ((dCore.startsWith("@") && !dCore.includes(" ")) || dCore.startsWith("โพสต์จาก "));
  const urlAuthor = extractSocialUrlAuthor(rawUrl, isFb ? "facebook" : isIg ? "instagram" : "tiktok");
  const tCoreLower = (tCore || "").trim().toLowerCase();
  const tIsAuthorOrGeneric =
    !tCore ||
    isGenericOrNoisyTitle(tCore, platLower, rawUrl) ||
    (Boolean(displayAuthor) && tCoreLower === displayAuthor.trim().toLowerCase()) ||
    (Boolean(handleAuthor) &&
      (tCoreLower === handleAuthor.trim().toLowerCase() ||
        tCoreLower === handleAuthor.trim().replace(/^@/, "").toLowerCase())) ||
    (Boolean(urlAuthor) &&
      (tCoreLower === urlAuthor.trim().toLowerCase() ||
        tCoreLower === urlAuthor.trim().replace(/^@/, "").toLowerCase()));
  const tIsMultilineOrLong = Boolean(tCore && (/[\r\n]/.test(tCore) || tCore.length > 65));
  const shouldUseOpeningSentence =
    Boolean(dCore) &&
    !isSyntheticDesc &&
    (isDup || tIsAuthorOrGeneric || tIsMultilineOrLong || (dCore.length >= 24 && dCore.length > tCore.length));

  if (shouldUseOpeningSentence) {
    const bestCaption = !isDup || dCore.length >= tCore.length ? dCore : tCore || dCore;
    const shortOpening = extractShortOpeningTitle(bestCaption);
    return {
      displayTitle: shortOpening || t || rawTitle || rawUrl,
      displayDesc: bestCaption,
    };
  }

  if (tCore && (isDup || tIsMultilineOrLong)) {
    const shortOpening = extractShortOpeningTitle(tCore);
    return {
      displayTitle: shortOpening || tCore,
      displayDesc: !d || isSyntheticDesc || tCore.length > d.length ? tCore : d,
    };
  }

  const fallbackOwner =
    combineAuthorDisplay(displayAuthor, handleAuthor) ||
    urlAuthor ||
    String(item?.site_name || "") ||
    rawTitle ||
    rawUrl;
  return {
    displayTitle: t || fallbackOwner,
    displayDesc: d && normalizeCompareCaption(d) !== normalizeCompareCaption(t) ? d : "",
  };
}

export function formatCardDisplayTitle(item: ThumbSourceLike | null | undefined): string {
  return formatPostDetailTitleAndDesc(item).displayTitle || String(item?.title || item?.url || "").trim();
}

export function getSocialPostLinkWarning(rawUrl: string | null | undefined): SocialPostLinkWarning | null {
  if (!isSafeHttpUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "/";
    const normPath = path.replace(/\/+$/, "").toLowerCase() || "/";
    const params = parsed.searchParams;

    if (host === "fb.watch" || host.endsWith(".fb.watch")) {
      if (path.replace(/^\/+|\/+$/g, "").length > 0) return null;
      return {
        platform: "Facebook",
        example: "https://www.facebook.com/share/p/...",
        message:
          "หน้านี้ไม่ใช่ลิงก์โพสต์ Facebook โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากโพสต์หรือคลิป แล้วนำมาวางในช่อง URL",
      };
    }

    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
      const hasPostParam = Boolean(
        params.get("story_fbid") || params.get("fbid") || params.get("v") || params.get("multi_permalinks"),
      );
      const isFeedShell =
        normPath === "/" ||
        /^\/(?:home\.php|watch|reel|reels|marketplace|gaming|groups\/feed|bookmarks|notifications|messages|friends|saved|memories|settings|login(?:\.php)?)$/.test(
          normPath,
        ) ||
        (normPath === "/profile.php" && !params.get("id"));
      if (hasPostParam || !isFeedShell) return null;
      return {
        platform: "Facebook",
        example: "https://www.facebook.com/share/p/... หรือ https://www.facebook.com/PageName",
        message:
          "หน้านี้เป็นหน้าฟีดหลักของ Facebook ไม่ใช่ลิงก์โพสต์หรือหน้าเพจ — กรุณาเปิดหน้าเพจหรือคัดลอกลิงก์จากโพสต์/คลิป แล้วนำมาวางในช่อง URL",
      };
    }

    if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
      const isIgPostPath =
        /^\/(?:[^/]+\/)?(?:p|reel|reels|tv|share)\/[A-Za-z0-9_-]+/i.test(path) ||
        /^\/stories\/[^/]+\/\d+/i.test(path);
      const isIgFeedShell =
        normPath === "/" ||
        (!isIgPostPath &&
          (/^\/(?:explore|reels|reel|p|tv|share|direct|accounts|your_activity)(?:\/|$)/.test(normPath) ||
            /^\/stories(?:\/[^/]+)?$/i.test(normPath)));
      if (!isIgFeedShell) return null;
      return {
        platform: "Instagram",
        example: "https://www.instagram.com/p/... หรือ https://www.instagram.com/username/",
        message:
          "หน้านี้เป็นหน้าฟีดหรือหน้าหลักของ Instagram — กรุณาเข้าหน้าโปรไฟล์หรือกด 'แชร์ > คัดลอกลิงก์' จากโพสต์/Reel แล้วนำมาวางในช่อง URL",
      };
    }

    if (host === "vt.tiktok.com" || host === "vm.tiktok.com") {
      if (path.replace(/^\/+|\/+$/g, "").length > 0) return null;
      return {
        platform: "TikTok",
        example: "https://vt.tiktok.com/...",
        message:
          "หน้านี้ไม่ใช่ลิงก์คลิป TikTok โดยตรง — กรุณากดปุ่ม 'แชร์ (Share) > คัดลอกลิงก์' จากคลิปที่ต้องการ แล้วนำมาวางในช่อง URL",
      };
    }

    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      const hasTtParam = Boolean(params.get("item_id") || params.get("share_item_id"));
      const isTtSaveablePath =
        /^\/@[^/]+(?:\/(?:video|photo)\/\d+)?\/?$/i.test(path) ||
        /^\/(?:t|v)\/[A-Za-z0-9_-]+/i.test(path) ||
        /^\/embed\//i.test(path);
      if (hasTtParam || isTtSaveablePath) return null;
      return {
        platform: "TikTok",
        example: "https://www.tiktok.com/@user/video/... หรือ https://www.tiktok.com/@user",
        message:
          "หน้านี้เป็นหน้าฟีดหรือหน้าหลักของ TikTok — กรุณาเปิดหน้าช่อง (@user) หรือคัดลอกลิงก์จากคลิป/รูปที่ต้องการ แล้วนำมาวางในช่อง URL",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function inferMobileDomain(url: string | null | undefined): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    const match = raw.match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].replace(/^www\./i, "") : raw;
  }
}

export function inferMobilePlatform(item: Pick<ThumbSourceLike, "platform" | "url">): string {
  const rawPlat = String(item.platform || "").trim().toLowerCase();
  if (rawPlat) return rawPlat === "twitter" ? "x" : rawPlat === "website" ? "web" : rawPlat;

  const urlLower = String(item.url || "").toLowerCase();
  if (/youtube\.com|youtu\.be/.test(urlLower)) return "youtube";
  if (/tiktok\.com/.test(urlLower)) return "tiktok";
  if (/instagram\.com/.test(urlLower)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.com/.test(urlLower)) return "facebook";
  if (/twitter\.com|x\.com/.test(urlLower)) return "x";
  if (/reddit\.com|redd\.it/.test(urlLower)) return "reddit";
  if (/vimeo\.com/.test(urlLower)) return "vimeo";
  if (/spotify\.com/.test(urlLower)) return "spotify";
  return "web";
}

export function inferMobileContentType(item: ThumbSourceLike): "video" | "image" | "social" | "article" {
  const raw = String(item.content_type || item.contentType || "").trim().toLowerCase();
  const embedType = String(item.embed_type || "none").trim().toLowerCase();
  const platform = inferMobilePlatform(item);
  const url = String(item.canonical_url || item.canonicalUrl || item.url || "").toLowerCase();
  const mediaItems = Array.isArray(item.media_items) ? item.media_items.filter(Boolean) : [];
  const hasYtVideoTarget =
    /[?&]v=[^&#]+/.test(url) ||
    /youtu\.be\/[^/?#]+/.test(url) ||
    /youtube\.com\/(?:watch(?:\/|\?|$)|embed\/[^/?#]+|shorts\/[^/?#]+|live\/[^/?#]+)/.test(url);
  const explicitNonVideoPost = raw === "post" || raw === "social";
  const isYtNonVideo =
    /youtube\.com\/(?:post\/|@|channel\/|c\/|user\/)/.test(url) && !hasYtVideoTarget;
  const isTtNonVideo =
    /tiktok\.com/.test(url) &&
    (/\/photo\//.test(url) || /tiktok\.com\/@[^/?#]+\/?(?:\?|$)/.test(url));
  const isYtVideoUrl = hasYtVideoTarget;
  const isTtVideoUrl = /tiktok\.com\/@[^/]+\/video\//.test(url) || /(?:vt|vm)\.tiktok\.com\//.test(url);

  if (
    raw === "video" ||
    (!explicitNonVideoPost &&
      !isYtNonVideo &&
      !isTtNonVideo &&
      (embedType === "youtube" ||
        embedType === "tiktok" ||
        embedType === "vimeo" ||
        isYtVideoUrl ||
        isTtVideoUrl ||
        /vimeo\.com|\.mp4\b/i.test(url)))
  ) {
    return "video";
  }

  if (
    raw === "image" ||
    (mediaItems.length > 0 &&
      embedType === "none" &&
      !["instagram", "facebook", "x", "reddit", "youtube", "tiktok"].includes(platform)) ||
    /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)
  ) {
    return "image";
  }

  if (
    raw === "social" ||
    raw === "post" ||
    isYtNonVideo ||
    isTtNonVideo ||
    ["instagram", "facebook", "x", "twitter", "reddit", "threads", "lemon8"].includes(platform) ||
    ["instagram", "facebook", "x", "reddit"].includes(embedType)
  ) {
    return "social";
  }

  return "article";
}

const MAJOR_PLATFORMS = new Set(["youtube", "tiktok", "instagram", "facebook", "x", "twitter", "reddit"]);

export function matchesPlatformFilter(
  item: Pick<ThumbSourceLike, "platform" | "url">,
  platformFilter: string,
): boolean {
  const target = String(platformFilter || "all").trim().toLowerCase();
  if (!target || target === "all") return true;

  const rawPlat = String(item.platform || "").trim().toLowerCase();
  const itemPlat = rawPlat || inferMobilePlatform(item);

  if (target === "web" || target === "website") {
    return !MAJOR_PLATFORMS.has(itemPlat);
  }
  if (target === "x" || target === "twitter") {
    return itemPlat === "x" || itemPlat === "twitter";
  }
  return itemPlat === target;
}

export function matchesItemSearch(
  item: ThumbSourceLike,
  query: string,
  folderName = "",
): boolean {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;

  const tags = Array.isArray(item.tags)
    ? item.tags
    : Array.isArray(item.tag_names)
      ? item.tag_names
      : [];

  const haystack = [
    item.title || "",
    formatCardDisplayTitle(item),
    item.url || "",
    item.description || "",
    item.note || item.user_note || "",
    item.ai_summary || "",
    item.platform || inferMobilePlatform(item),
    folderName || "",
    ...tags,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(q);
}

export function isPrivateOrRestrictedItem(item: ThumbSourceLike | null | undefined): boolean {
  if (!item) return false;
  return (
    item.preview_status === "private_or_restricted" ||
    item.previewStatus === "private_or_restricted" ||
    item.enrich_error === "private_or_restricted"
  );
}

export function getDeviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === "string" && tz.trim()) return tz.trim();
  } catch {
    // Fallback below
  }
  return "Asia/Bangkok";
}

export function formatRemindTimeAndZone(
  date: Date,
  explicitTimezone?: string,
): { remind_time: string; timezone: string } {
  const tz = (explicitTimezone || "").trim() || getDeviceTimezone();
  const pad = (n: number) => String(n).padStart(2, "0");

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const hh = get("hour");
    const mm = get("minute");
    const ss = get("second");
    if (/^\d{2}$/.test(hh) && /^\d{2}$/.test(mm) && /^\d{2}$/.test(ss)) {
      const safeHour = hh === "24" ? "00" : hh;
      return { remind_time: `${safeHour}:${mm}:${ss}`, timezone: tz };
    }
  } catch {
    // Fallback to device local clock below
  }

  return {
    remind_time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    timezone: tz,
  };
}

export function resolveOriginalDescription(item: ThumbSourceLike | null | undefined): string {
  const rawDesc = String(item?.description || "").trim();
  const { displayDesc } = formatPostDetailTitleAndDesc(item);
  const cleanedDesc = String(displayDesc || "").trim();
  const effUrl = String(item?.canonical_url || item?.canonicalUrl || item?.url || "").toLowerCase();
  const platLower = String(item?.platform || "").toLowerCase();
  const isSocial =
    platLower.includes("facebook") ||
    platLower.includes("instagram") ||
    platLower.includes("tiktok") ||
    effUrl.includes("facebook.com") ||
    effUrl.includes("fb.watch") ||
    effUrl.includes("instagram.com") ||
    effUrl.includes("tiktok.com");
  if (isSocial) {
    return cleanedDesc || (displayDesc === "" ? "" : rawDesc);
  }
  return rawDesc.length >= cleanedDesc.length ? rawDesc : cleanedDesc;
}

const THAI_MONTH_NAMES = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

export interface MobileCalendarDay {
  day: number;
  isPast: boolean;
  isToday: boolean;
}

export interface MobileMonthCalendar {
  yearMonth: string;
  monthLabel: string;
  leadingEmpty: number;
  days: MobileCalendarDay[];
}

export function shiftYearMonth(yearMonth: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || "").trim());
  const now = new Date();
  const baseYear = m ? Number(m[1]) : now.getFullYear();
  const baseMonthIdx = m ? Number(m[2]) - 1 : now.getMonth();
  const d = new Date(baseYear, baseMonthIdx + Math.trunc(delta), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function buildMobileMonthCalendar(yearMonth: string, nowInput?: Date): MobileMonthCalendar {
  const now = nowInput || new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || "").trim());
  const year = m ? Number(m[1]) : now.getFullYear();
  const monthNum = m ? Math.min(12, Math.max(1, Number(m[2]))) : now.getMonth() + 1;
  const normalizedYm = `${year}-${String(monthNum).padStart(2, "0")}`;
  const firstDay = new Date(year, monthNum - 1, 1);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const leadingEmpty = firstDay.getDay();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  const days: MobileCalendarDay[] = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const isBeforeMonth = year < todayYear || (year === todayYear && monthNum < todayMonth);
    const isSameMonth = year === todayYear && monthNum === todayMonth;
    const isPast = isBeforeMonth || (isSameMonth && day < todayDay);
    const isToday = isSameMonth && day === todayDay;
    days.push({ day, isPast, isToday });
  }
  const monthName = THAI_MONTH_NAMES[monthNum - 1] || String(monthNum);
  return {
    yearMonth: normalizedYm,
    monthLabel: `${monthName} ${year + 543}`,
    leadingEmpty,
    days,
  };
}

export function buildCustomReminderDate(
  yearMonth: string,
  day: number,
  hour: number,
  minute: number,
): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const dt = new Date(year, monthNum - 1, day, hour, minute, 0, 0);
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getFullYear() !== year ||
    dt.getMonth() !== monthNum - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute
  ) {
    return null;
  }
  return dt;
}
