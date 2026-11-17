/**
 * Link Flows & Sheets (Figma 1:1 Fidelity):
 * - Add Link Bottom Sheets: 319:4332, 319:4791 (Expanded), 319:4779 (Folder Picker), 319:4659 (Create Folder), 319:541 (Share from External App)
 * - Link Detail & AI Flow: 319:6090, 372:821, 319:5253 (AI Confirm), 319:5264 (AI Loading), 319:5271 (AI Success), 319:5279 (AI Error), 319:5120 (Note Modal), 319:5131 (Tag Modal)
 * - Spec 1A Rich Preview inside fixed 358x186px (border-radius: 15px): fallback, single cover, multi-image carousel, allowlisted video iframe
 * - Spec 2B Reminder Bottom Sheet: 319:5142 + compact recurrence row (once / every_n_days)
 */
import { icons, escHtml, safeHrefUrl, safeImgUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { getFolderById, getLinkById, buildMonthCalendarDays } from "../state/store.js";

const EMBED_ALLOWLIST_RULES = [
  { hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"], exact: false, check: (p) => p.startsWith("/embed/") },
  { hosts: ["tiktok.com", "www.tiktok.com"], exact: false, check: (p) => p.startsWith("/embed/") || p.startsWith("/player/v1/") },
  { hosts: ["player.vimeo.com"], exact: true, check: (p) => p.startsWith("/video/") },
  { hosts: ["open.spotify.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  { hosts: ["platform.twitter.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  { hosts: ["facebook.com", "www.facebook.com", "web.facebook.com"], exact: false, check: (p) => p.startsWith("/plugins/") },
  { hosts: ["instagram.com", "www.instagram.com"], exact: false, check: (p) => /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/embed\/?$/.test(p) },
  { hosts: ["embed.reddit.com", "redditmedia.com", "www.redditmedia.com"], exact: false, check: (p) => p.startsWith("/r/") || p.startsWith("/mediaembed/") },
];

/**
 * Resolve a safe HTTPS iframe embed URL strictly within per-platform allowlist and embed path rules.
 * Returns null if missing, invalid, non-HTTPS, containing userinfo/traversal, or outside allowlist.
 */
export function resolveAllowlistedEmbedUrl(rawUrl) {
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

/**
 * Validate a direct HTTPS video stream URL strictly against Meta CDN media hosts.
 */
export function resolveAllowlistedDirectVideoUrl(rawUrl) {
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

const META_CROPPED_STP_RE = /[?&]stp=c\d+\.\d+\.\d+\.\d+/i;
const META_DOWNSCALED_RE = /(?:[?&]stp=[^&]*cmp\d+|_s(?:640|480|320|240|150)x(?:640|480|320|240|150))/i;
const META_ASSET_FILENAME_RE = /^\d+_\d+_\d+_[a-z]\.(?:jpg|jpeg|png|webp)$/i;
const TIKTOK_ASSET_ID_RE = /\/tos-[^/]+\/([A-Za-z0-9_-]{12,})(?:~|$)/;

function getPreviewAssetKey(url) {
  const exact = url.split("#")[0];
  try {
    const parsed = new URL(exact);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "";
    const base = (path.split("/").pop() || "").toLowerCase();
    if (
      host.includes("fbcdn.net") ||
      host.includes("cdninstagram.com") ||
      path.includes("/v/t")
    ) {
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
  } catch {}
  return `exact:${exact}`;
}

export function getPreviewMediaImages(item) {
  const list = Array.isArray(item?.mediaItems)
    ? item.mediaItems
    : Array.isArray(item?.media_items)
      ? item.media_items
      : [];
  const rawUrls = list
    .map((m) => (typeof m === "string" ? m : m?.media_url || m?.url || m?.thumbnail_url || ""))
    .map((u) => safeImgUrl(u))
    .filter(Boolean);

  const deduped = [];
  const posByAssetKey = new Map();
  for (const url of rawUrls) {
    const key = getPreviewAssetKey(url);
    const isExact = key.startsWith("exact:");
    const isCropped = META_CROPPED_STP_RE.test(url) || META_DOWNSCALED_RE.test(url);
    if (posByAssetKey.has(key)) {
      if (!isExact && !isCropped) {
        const prevIdx = posByAssetKey.get(key);
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

  // Legacy already-saved items may hold [uploaded_cover.webp, og_cropped_s640x640 / lookaside.fbsbx]
  if (deduped.length >= 2 && /\/thumbnails\/[a-f0-9]{16,64}\.webp/i.test(deduped[0])) {
    const filtered = [
      deduped[0],
      ...deduped
        .slice(1)
        .filter(
          (u) =>
            !(
              (META_CROPPED_STP_RE.test(u) && /_s(?:640|480|320)x(?:640|480|320)/i.test(u)) ||
              u.toLowerCase().includes("lookaside.fbsbx.com")
            )
        ),
    ];
    return filtered;
  }
  return deduped;
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
const TT_META_DESC_RE =
  /^(?:[\d,.]+[KMBkmb]?\s*Likes?(?:,\s*[\d,.]+[KMBkmb]?\s*Comments?)?\.?\s*|ถูกใจ\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*ครั้ง(?:,\s*ความคิดเห็น\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*รายการ)?\.?\s*)(?:TikTok video from\s+([^:]+):\s*["“”]?([\s\S]+?)["“”]?\s*$|วิดีโอ\s*TikTok\s*จาก\s+([^:]+):\s*["“”]?([\s\S]+?)["“”]?\s*$)?/i;
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

function stripBalancedCaptionQuotes(rawCap) {
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

export function isGenericOrNoisyTitle(title, platformLower = "", rawUrl = "") {
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
    } catch {}
  }
  const noBadge = stripped.replace(NOTIFICATION_PREFIX_RE, "").trim();
  const noBadgeLower = noBadge.toLowerCase();
  if (GENERIC_PLATFORM_TITLES.has(lowered) || GENERIC_PLATFORM_TITLES.has(noBadgeLower)) return true;
  if (NOTIFICATION_PREFIX_RE.test(stripped) && (/\s*[-–|]\s*YouTube$/i.test(stripped) || GENERIC_PLATFORM_TITLES.has(noBadgeLower))) {
    return true;
  }
  if ((platformLower.includes("instagram") || /instagram\.com/i.test(rawUrl)) && /^@?[A-Za-z0-9._]+\s+(?:on|บน)\s+Instagram\s*$/i.test(noBadge)) {
    return true;
  }
  if ((platformLower.includes("tiktok") || /tiktok\.com/i.test(rawUrl)) && /^(?:watch trending|discover|make your day|tiktok)\b.*\|\s*tiktok$/i.test(noBadgeLower)) {
    return true;
  }
  return false;
}

function scrubGenericPlatformTitle(title, platformLower = "", rawUrl = "") {
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

function extractSocialUrlAuthor(rawUrl, platformLower) {
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
  } catch {}
  return "";
}

function normalizeCompareCaption(str, collapseSpaces = false) {
  const cleaned = String(str || "")
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’….\-]+$/g, "");
  return (collapseSpaces ? cleaned.replace(/\s+/g, "") : cleaned.replace(/\s+/g, " ")).toLowerCase();
}

function extractShortOpeningTitle(caption, maxChars = 58) {
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

function combineAuthorDisplay(displayAuthor, handleAuthor) {
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

export function formatCardDisplayTitle(item) {
  return formatPostDetailTitleAndDesc(item).displayTitle || String(item?.title || item?.url || "").trim();
}

/**
 * Strip view/reaction/comment counts from FB/IG/TikTok metadata and extract concise 1-line caption title across platforms.
 */
export function formatPostDetailTitleAndDesc(item) {
  const rawTitle = String(item?.title || "").trim();
  const rawDesc = String(item?.description || "").trim();
  const rawUrl = String(item?.url || "").trim();
  const platLower = String(item?.platform || "").toLowerCase();
  const isFb = platLower.includes("facebook") || rawUrl.includes("facebook.com") || rawUrl.includes("fb.watch");
  const isIg = platLower.includes("instagram") || rawUrl.includes("instagram.com");
  const isTt = platLower.includes("tiktok") || rawUrl.includes("tiktok.com");

  if (!isFb && !isIg && !isTt) {
    const cleanedTitle = scrubGenericPlatformTitle(rawTitle, platLower, rawUrl);
    const nonGenericTitle =
      cleanedTitle ||
      (rawDesc && !rawDesc.startsWith("By ") ? extractShortOpeningTitle(rawDesc) : "") ||
      rawTitle ||
      rawUrl;
    const sameNonSocial =
      rawDesc && normalizeCompareCaption(rawDesc) === normalizeCompareCaption(nonGenericTitle);
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
    const mTitle = t.match(IG_OG_TITLE_RE);
    if (mTitle) {
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
        d = stripBalancedCaptionQuotes(d.replace(IG_PROFILE_STATS_RE, "").trim());
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
          ""
        )
        .trim();
    }
  }

  t = scrubGenericPlatformTitle(t, platLower, rawUrl);

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
      (normTCompact && normTCompact === normDCompact) ||
      (normT.length >= 12 && (normD.startsWith(normT) || normT.startsWith(normD))) ||
      (normTCompact.length >= 12 && (normDCompact.startsWith(normTCompact) || normTCompact.startsWith(normDCompact))));

  const isSyntheticDesc =
    Boolean(dCore) && ((dCore.startsWith("@") && !dCore.includes(" ")) || dCore.startsWith("โพสต์จาก "));
  const urlAuthor = extractSocialUrlAuthor(rawUrl, isFb ? "facebook" : isIg ? "instagram" : "tiktok");
  const tCoreLower = (tCore || "").trim().toLowerCase();
  const tIsAuthorOrGeneric =
    !tCore ||
    isGenericOrNoisyTitle(tCore, platLower, rawUrl) ||
    (Boolean(displayAuthor) && tCoreLower === displayAuthor.trim().toLowerCase()) ||
    (Boolean(handleAuthor) &&
      (tCoreLower === handleAuthor.trim().toLowerCase() || tCoreLower === handleAuthor.trim().replace(/^@/, "").toLowerCase())) ||
    (Boolean(urlAuthor) &&
      (tCoreLower === urlAuthor.trim().toLowerCase() || tCoreLower === urlAuthor.trim().replace(/^@/, "").toLowerCase()));
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
    item?.site_name ||
    rawTitle ||
    rawUrl;
  return {
    displayTitle: t || fallbackOwner,
    displayDesc: d && normalizeCompareCaption(d) !== normalizeCompareCaption(t) ? d : "",
  };
}

function isPlayableVideoEmbed(embedUrl, item) {
  if (!embedUrl) return false;
  const contentType = String(item?.contentType || item?.content_type || "").toLowerCase();
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
  } catch {
    return false;
  }
  return true;
}

/**
 * Derive fallback video embed URL and thumbnail locally when raw URL is a supported video platform
 * (e.g., before backend unfurl enrichment completes).
 */
export function deriveVideoEmbedInfo(item) {
  const rawUrl = String(item?.url || "").trim();
  const explicitEmbed = resolveAllowlistedEmbedUrl(item?.embedUrl || item?.embed_url);
  let embedUrl = isPlayableVideoEmbed(explicitEmbed, item) ? explicitEmbed : null;
  let thumbUrl = "";
  let platform = item?.platform || "";
  let isVertical = Boolean(
    embedUrl &&
      (embedUrl.includes("tiktok.com/") || /instagram\.com\/(?:reel|tv)\//i.test(embedUrl))
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
    } catch {}
  }
  return { embedUrl: resolveAllowlistedEmbedUrl(embedUrl), thumbUrl, platform, isVertical };
}

function withAutoplayParam(embedUrl) {
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
 * Spec 1A: Rich Preview rendered inside the preview container, adapting aspect ratio to video/post dimensions.
 */
export function renderRichPreviewBox(item, uiState = {}, options = {}) {
  const baseBoxClass = options.desktop ? "figma-rich-preview-box is-desktop" : "figma-rich-preview-box";
  const derivedVideo = deriveVideoEmbedInfo(item);
  const safeEmbedUrl = derivedVideo.embedUrl;
  const mediaImages = getPreviewMediaImages(item);
  const singleCover = resolveMediaThumbUrl(item) || mediaImages[0] || derivedVideo.thumbUrl || "";
  const isPrivate =
    item?.previewStatus === "private_or_restricted" ||
    item?.preview_status === "private_or_restricted" ||
    item?.enrich_error === "private_or_restricted";

  // Case 1: Interactive video iframe on allowlisted domain
  if (safeEmbedUrl) {
    const isVert = Boolean(derivedVideo.isVertical || uiState.playingVideoIsVertical);
    const customAspectAttr =
      uiState.playingVideoAspect && /^\d+\s*\/\s*\d+$/.test(String(uiState.playingVideoAspect))
        ? ` style="aspect-ratio: ${escHtml(String(uiState.playingVideoAspect))};"`
        : "";
    if (uiState.videoPlaying) {
      const directVideoUrl = resolveAllowlistedDirectVideoUrl(uiState.playingVideoDirectUrl);
      const activeSrc = withAutoplayParam(safeEmbedUrl);
      const playingClass = isVert
        ? `${baseBoxClass} is-playing is-vertical-video`
        : `${baseBoxClass} is-playing`;
      const mediaEl = directVideoUrl
        ? `<video
            class="figma-preview-video"
            src="${escHtml(directVideoUrl)}"
            ${singleCover ? `poster="${escHtml(singleCover)}"` : ""}
            controls
            loop
            autoplay
            playsinline
          ></video>`
        : `<iframe
            class="figma-preview-iframe"
            src="${escHtml(activeSrc)}"
            title="${escHtml(item?.title || "ตัวอย่างวิดีโอ")}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>`;
      return `
        <div class="${playingClass}"${customAspectAttr} data-node-id="319:6103">
          ${mediaEl}
          <button
            type="button"
            class="figma-preview-close-btn"
            data-action="stop-embed-video"
            title="ปิดตัวเล่นวิดีโอ"
            aria-label="ปิดตัวเล่นวิดีโอ"
          >
            ${icons.close(14)}
          </button>
        </div>
      `;
    }
    const posterBoxClass = isVert
      ? `${baseBoxClass} has-media is-vertical-video`
      : `${baseBoxClass} has-media`;
    const playLoading = Boolean(uiState.playingVideoLoading);
    return `
      <div class="${posterBoxClass}" data-node-id="319:6103">
        ${
          singleCover
            ? `<img class="figma-preview-img" src="${escHtml(singleCover)}" alt="${escHtml(item?.title || "")}" />`
            : `<div class="figma-preview-video-poster"></div>`
        }
        <button
          type="button"
          class="figma-preview-play-btn${playLoading ? " is-loading" : ""}"
          data-action="play-embed-video"
          aria-label="เล่นวิดีโอตัวอย่าง"
          ${playLoading ? "disabled" : ""}
        >
          ${icons.play(22)}
        </button>
        <span class="figma-preview-badge">${escHtml(derivedVideo.platform || item?.platform || "Video")} · ${playLoading ? "กำลังเตรียมคลิป..." : "แตะเพื่อเล่น"}</span>
      </div>
    `;
  }

  // Case 2: Multi-image carousel (2–5 images inside adaptive preview container)
  if (mediaImages.length >= 2) {
    const total = mediaImages.length;
    const rawIdx = Number(uiState.carouselIndex || 0);
    const activeIdx = ((rawIdx % total) + total) % total;
    const currentSrc = mediaImages[activeIdx];
    const safeOrigUrl = safeHrefUrl(item?.url);
    const isLastSlide = activeIdx === total - 1;
    return `
      <div class="${baseBoxClass} has-media" data-node-id="319:6103">
        <img
          class="figma-preview-img is-zoomable"
          src="${escHtml(currentSrc)}"
          alt="${escHtml(item?.title || "")}"
          data-action="open-image-lightbox"
          title="แตะเพื่อขยายเต็มจอ"
        />
        <button
          type="button"
          class="figma-carousel-arrow prev"
          data-action="carousel-prev"
          data-id="${escHtml(item.id)}"
          aria-label="รูปก่อนหน้า"
        >‹</button>
        <button
          type="button"
          class="figma-carousel-arrow next"
          data-action="carousel-next"
          data-id="${escHtml(item.id)}"
          aria-label="รูปถัดไป"
        >›</button>
        <span class="figma-preview-badge">${activeIdx + 1}/${total}</span>
        ${
          isLastSlide && safeOrigUrl
            ? `<a
                class="figma-preview-more-link"
                href="${escHtml(safeOrigUrl)}"
                target="_blank"
                rel="noopener noreferrer"
              >ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗</a>`
            : ""
        }
        <button
          type="button"
          class="figma-preview-zoom-btn"
          data-action="open-image-lightbox"
          title="ขยายรูปเต็มจอ"
          aria-label="ขยายรูปเต็มจอ"
        >⤢ ขยาย</button>
        <div class="figma-carousel-dots">
          ${mediaImages
            .map(
              (_, i) => `
            <button
              type="button"
              class="figma-carousel-dot ${i === activeIdx ? "active" : ""}"
              data-action="carousel-dot"
              data-id="${escHtml(item.id)}"
              data-index="${i}"
              aria-label="รูปที่ ${i + 1}"
            ></button>`
            )
            .join("")}
        </div>
      </div>
    `;
  }

  // Case 3: Single cover image
  if (singleCover) {
    return `
      <div class="${baseBoxClass} has-media" data-node-id="319:6103">
        <img
          class="figma-preview-img is-zoomable"
          src="${escHtml(singleCover)}"
          alt="${escHtml(item?.title || "")}"
          data-action="open-image-lightbox"
          title="แตะเพื่อขยายเต็มจอ"
        />
        <button
          type="button"
          class="figma-preview-zoom-btn"
          data-action="open-image-lightbox"
          title="ขยายรูปเต็มจอ"
          aria-label="ขยายรูปเต็มจอ"
        >⤢ ขยาย</button>
      </div>
    `;
  }

  // Case 4: Private/restricted post or exact Figma fallback card (#f0ecfa) when no cover/media
  if (isPrivate) {
    return `
      <div class="${baseBoxClass} is-fallback is-private" data-node-id="319:6103">
        <p class="figma-preview-fallback-title">ไม่สามารถแสดงตัวอย่างได้</p>
        <p class="figma-preview-fallback-sub">โพสต์นี้เป็นแบบส่วนตัว (Private) หรือถูกจำกัดสิทธิ์การเข้าถึง กรุณากดเปิดลิงก์ต้นฉบับเพื่อดูเนื้อหา</p>
      </div>
    `;
  }

  return `
    <div class="${baseBoxClass} is-fallback" data-node-id="319:6103">
      <p class="figma-preview-fallback-title">ไม่มีตัวอย่างลิงก์</p>
      <p class="figma-preview-fallback-sub">เปิดลิงก์ต้นฉบับเพื่อดูเนื้อหา</p>
    </div>
  `;
}

/**
 * Shared modals for Link Detail & Desktop PC Right Inspector:
 * - 319:5253 AI Confirm
 * - 319:5264 AI Loading
 * - 319:5271 AI Success
 * - 319:5279 AI Error
 * - 319:5120 Note Multiline Edit Modal
 * - 319:5131 Add Tag Modal
 */
export function renderLinkDetailModals(state, item) {
  if (!item) return "";
  const ui = state.ui;

  if (ui.imageLightboxOpen) {
    const mediaImages = getPreviewMediaImages(item);
    const derivedVideo = deriveVideoEmbedInfo(item);
    const singleCover = resolveMediaThumbUrl(item) || mediaImages[0] || derivedVideo.thumbUrl || "";
    const list = mediaImages.length >= 2 ? mediaImages : singleCover ? [singleCover] : [];
    if (list.length) {
      const total = list.length;
      const rawIdx = Number(ui.carouselIndex || 0);
      const activeIdx = ((rawIdx % total) + total) % total;
      const currentSrc = list[activeIdx];
      const safeOrigUrl = safeHrefUrl(item?.url);
      const isLastSlide = total >= 2 && activeIdx === total - 1;
      return `
        <div class="modal-backdrop center figma-lightbox-backdrop" data-action="close-image-lightbox">
          <div class="figma-lightbox-stage">
            <button
              type="button"
              class="figma-lightbox-close-btn"
              data-action="close-image-lightbox"
              title="ปิดภาพขยาย"
              aria-label="ปิดภาพขยาย"
            >
              ${icons.close(18)}
            </button>
            ${
              total >= 2
                ? `<span class="figma-lightbox-counter">${activeIdx + 1}/${total}</span>`
                : ""
            }
            <img
              class="figma-lightbox-img"
              src="${escHtml(currentSrc)}"
              alt="${escHtml(item?.title || "")}"
            />
            ${
              total >= 2
                ? `
              <button
                type="button"
                class="figma-carousel-arrow prev figma-lightbox-arrow"
                data-action="carousel-prev"
                data-id="${escHtml(item.id)}"
                aria-label="รูปก่อนหน้า"
              >‹</button>
              <button
                type="button"
                class="figma-carousel-arrow next figma-lightbox-arrow"
                data-action="carousel-next"
                data-id="${escHtml(item.id)}"
                aria-label="รูปถัดไป"
              >›</button>`
                : ""
            }
            ${
              isLastSlide && safeOrigUrl
                ? `<a
                    class="figma-lightbox-more-link"
                    href="${escHtml(safeOrigUrl)}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗</a>`
                : ""
            }
          </div>
        </div>
      `;
    }
  }

  if (ui.aiConfirmModalOpen || ui.aiSummaryStatus === "confirm") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" data-node-id="319:5253">
          <h3 class="figma-dialog-title">ยืนยันการสรุปด้วย AI</h3>
          <div class="figma-ai-token-notice">
            ผู้ให้บริการ AI ที่คุณเชื่อมต่อจะประมวลผลเนื้อหาต้นฉบับ โดยใช้ Token ของคุณ และอาจมีค่าใช้จ่าย
          </div>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="close-ai-confirm">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="confirm-ai-summarize" data-id="${escHtml(item.id)}" data-force-refresh="1">ยืนยัน</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "loading") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop">
        <div class="figma-dialog-card" data-node-id="319:5264">
          <h3 class="figma-dialog-title">กำลังสรุปเนื้อหา…</h3>
          <p class="figma-dialog-sub">กำลังตรวจว่าเปิดอ่านต้นฉบับได้</p>
          <button type="button" class="figma-btn-outline-44 full" data-action="close-ai-confirm">ยกเลิก</button>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "success") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" data-node-id="319:5271">
          <h3 class="figma-dialog-title">สรุปจากต้นฉบับ</h3>
          <div class="figma-ai-result-box">
            ${escHtml(item.aiSummary || "สรุปเนื้อหาเรียบร้อยแล้ว")}
          </div>
          <button type="button" class="figma-btn-outline-44 full" data-action="close-ai-confirm">ปิด</button>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "error") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" data-node-id="319:5279">
          <h3 class="figma-dialog-title">สรุปไม่สำเร็จ</h3>
          <p class="figma-dialog-sub">เข้าถึงเนื้อหาต้นฉบับไม่ได้ จึงยังไม่มีสรุปให้แสดง</p>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="close-ai-confirm">ปิด</button>
            <button type="button" class="figma-btn-red-44" data-action="confirm-ai-summarize" data-id="${escHtml(item.id)}" data-force-refresh="1">ลองอีกครั้ง</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.noteEditing) {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="cancel-note-edit">
        <div class="figma-dialog-card" data-node-id="319:5120">
          <h3 class="figma-dialog-title">แก้ไขโน้ต</h3>
          <textarea
            class="figma-modal-textarea"
            placeholder="กลับมาเปิดลิงก์นี้ช่วงวันหยุด..."
            data-bind-note-draft="1"
          >${escHtml(ui.noteDraft ?? item.note ?? "")}</textarea>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="cancel-note-edit">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="save-note-inline" data-id="${escHtml(item.id)}">บันทึก</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.tagPopoverOpen) {
    const quickTags = ["#อ่านทีหลัง", "#คาเฟ่", "#เที่ยว", "#ไอเดีย", "#อาหาร"];
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="toggle-tag-popover">
        <div class="figma-dialog-card" data-node-id="319:5131">
          <h3 class="figma-dialog-title">เพิ่มแท็ก</h3>
          <input
            type="text"
            class="figma-modal-input"
            placeholder="อ่านทีหลัง"
            value="${escHtml(ui.tagDraft || "")}"
            data-bind-tag-draft="1"
          />
          <div class="figma-quick-tag-row">
            ${quickTags
              .map(
                (tag) => `
              <button type="button" class="figma-tag-suggest-btn" data-action="add-tag-inline" data-id="${escHtml(item.id)}" data-tag="${escHtml(tag)}">
                ${escHtml(tag)}
              </button>`
              )
              .join("")}
          </div>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="toggle-tag-popover">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="add-tag-inline" data-id="${escHtml(item.id)}">เพิ่มแท็ก</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

export function renderLinkDetailScreen(state) {
  const links = state.data.links || [];
  const item = getLinkById(state.ui.activeLinkId) || links[0];
  if (!item) {
    return `<div class="app-pad"><button class="btn-outline-pill" data-nav="home">กลับหน้าหลัก</button></div>`;
  }
  const folder = getFolderById(item.folderId);
  const idx = Math.max(0, links.findIndex((l) => l.id === item.id));
  const isSeen = item.status === "read";
  const backTarget = state.ui.prevScreen === "folderDetail" ? "folderDetail" : "home";
  const sourceLabel = folder?.name ? folder.name : "บันทึกล่าสุด";
  const { displayTitle, displayDesc } = formatPostDetailTitleAndDesc(item);

  return `
    <div class="figma-detail-page" data-node-id="319:6090">
      <div class="figma-detail-topbar" data-node-id="319:6091">
        <button type="button" class="figma-back-btn" data-nav="${backTarget}" aria-label="ย้อนกลับ">
          ${icons.back(22)}
        </button>
        <div class="figma-detail-top-titles">
          <h1 class="figma-detail-top-heading">รายละเอียด</h1>
          <p class="figma-detail-top-sub">${idx + 1}/${Math.max(1, links.length)} · ${escHtml(sourceLabel)}</p>
        </div>
        <button type="button" class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${escHtml(item.id)}" title="ชื่นชอบ">
          ${icons.cherry(20)}
        </button>
      </div>

      <div class="figma-detail-scroll">
        <div class="figma-detail-edge-hint">
          <span class="figma-edge-chevron">⌄</span>
          <span>ลากลงเพื่อดูโพสต์ก่อนหน้า</span>
        </div>

        ${renderRichPreviewBox(item, state.ui)}

        <div class="figma-detail-post-info">
          <a
            class="figma-detail-post-title-link"
            href="${escHtml(safeHrefUrl(item.url))}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>${escHtml(displayTitle)}</span>
            <span class="figma-detail-ext-icon">${icons.externalLink(18)}</span>
          </a>
          <p class="figma-detail-post-meta">
            ${escHtml(item.platform || "Web")} · ${escHtml(item.savedAgo || "เมื่อสักครู่")} · ${escHtml(folder?.name || "ทั่วไป")}
          </p>
          ${
            displayDesc
              ? `<p class="figma-detail-post-desc">${escHtml(displayDesc)}</p>`
              : ""
          }
        </div>

        <button type="button" class="figma-detail-reminder-pill" data-open-reminder="${escHtml(item.id)}">
          ${icons.clock(17)}
          <span>${escHtml(item.reminder || "ยังไม่ได้ตั้งเตือน")}</span>
        </button>

        <div class="figma-detail-status-block">
          <div class="figma-detail-status-row">
            <span class="figma-detail-sec-label">สถานะการรับชม</span>
            <button
              type="button"
              class="figma-detail-status-toggle ${isSeen ? "seen" : "unseen"}"
              data-toggle-seen="${escHtml(item.id)}"
            >
              ${
                isSeen
                  ? `<span class="seen-check">✓</span><span>ดูแล้ว</span><span class="swap-arrows">⇄</span>`
                  : `<span>ยังไม่ดู</span><span class="swap-arrows">⇄</span>`
              }
            </button>
          </div>

          <div class="figma-detail-tags-row">
            ${(item.tags || [])
              .map(
                (tag) => `
              <button
                type="button"
                class="figma-detail-tag-pill"
                data-action="remove-tag-inline"
                data-id="${escHtml(item.id)}"
                data-tag="${escHtml(tag)}"
                title="แตะเพื่อลบแท็ก"
              >
                ${escHtml(tag.startsWith("#") ? tag : `#${tag}`)} ×
              </button>`
              )
              .join("")}
            <button type="button" class="figma-detail-add-tag-btn" data-action="toggle-tag-popover">
              + เพิ่มแท็ก
            </button>
          </div>
        </div>

        <div class="figma-detail-note-block">
          <div class="figma-detail-note-head">
            <span class="figma-detail-sec-label">โน้ตของฉัน</span>
            <button type="button" class="figma-detail-edit-pill" data-action="toggle-note-edit" data-id="${escHtml(item.id)}">
              แก้ไข
            </button>
          </div>
          <div
            class="figma-detail-note-box ${item.note ? "has-note" : ""}"
            role="button"
            tabindex="0"
            data-action="toggle-note-edit"
            data-id="${escHtml(item.id)}"
          >
            ${item.note ? escHtml(item.note) : `<span class="placeholder">เพิ่มโน้ต…</span>`}
          </div>
        </div>

        <div class="figma-detail-ai-block" data-node-id="372:873">
          ${
            item.aiSummary
              ? `
            <div class="figma-detail-ai-card">
              <div class="figma-detail-ai-card-head">
                <span class="ai-ico">${icons.bot(18)}</span>
                <strong>สรุปจากต้นฉบับ</strong>
                <button type="button" class="figma-detail-ai-rerun" data-action="open-ai-confirm">สรุปใหม่</button>
              </div>
              <p class="figma-detail-ai-card-body">${escHtml(item.aiSummary)}</p>
            </div>`
              : `
            <button type="button" class="figma-detail-ai-trigger" data-action="open-ai-confirm">
              <span class="ai-ico">${icons.bot(18)}</span>
              <span>สรุปด้วย AI</span>
            </button>`
          }
        </div>

        <div class="figma-detail-edge-hint bottom">
          <span class="figma-edge-chevron">⌃</span>
          <span>ลากขึ้นเพื่อดูโพสต์ถัดไป</span>
        </div>
      </div>

      <div class="figma-detail-sticky-cta">
        <a
          class="figma-detail-open-btn"
          href="${escHtml(safeHrefUrl(item.url))}"
          target="_blank"
          rel="noopener noreferrer"
        >
          เปิดลิงก์ต้นฉบับ
        </a>
      </div>

      ${renderLinkDetailModals(state, item)}
    </div>
  `;
}

export function renderSavedPreviewScreen(state) {
  const unread = state.data.links.filter((l) => l.status === "unread");
  const pool = unread.length ? unread : state.data.links;
  const idx = Math.max(0, Math.min(state.ui.previewIndex || 0, pool.length - 1));
  const item = pool[idx];
  const folder = item ? getFolderById(item.folderId) : null;
  const { displayTitle, displayDesc } = item ? formatPostDetailTitleAndDesc(item) : { displayTitle: "", displayDesc: "" };

  return `
    <div class="figma-detail-page">
      <div class="figma-detail-topbar">
        <button type="button" class="figma-back-btn" data-nav="home">${icons.back(22)}</button>
        <div class="figma-detail-top-titles">
          <h1 class="figma-detail-top-heading">ดูรายการที่บันทึกไว้</h1>
          <p class="figma-detail-top-sub">${idx + 1} จาก ${Math.max(1, pool.length)} · ${item?.status === "unread" ? "ยังไม่ได้ดู" : "ดูแล้ว"}</p>
        </div>
      </div>

      ${
        !item
          ? `<div class="app-pad"><p>ไม่มีรายการที่ยังไม่ได้ดู</p></div>`
          : `
        <div class="figma-detail-scroll">
          ${renderRichPreviewBox(item, state.ui)}
          <div class="figma-detail-post-info">
            <h2 class="figma-detail-post-title-link" style="text-decoration:none;cursor:pointer;" data-open-link="${escHtml(item.id)}">
              ${escHtml(displayTitle)}
            </h2>
            ${
              displayDesc
                ? `<p class="figma-detail-post-desc">${escHtml(displayDesc)}</p>`
                : ""
            }
            <p class="figma-detail-post-meta">${escHtml(item.platform)} · โฟลเดอร์${escHtml(folder?.name || "ทั่วไป")}</p>
          </div>

          <div class="figma-detail-ai-card">
            <div class="figma-detail-ai-card-head">
              <span class="ai-ico">${icons.bot(18)}</span>
              <strong>สรุปเนื้อหา</strong>
            </div>
            <p class="figma-detail-ai-card-body">
              ${escHtml(item.aiSummary || `สรุปเนื้อหาจาก ${item.platform} — แตะเพื่อเปิดหน้าเต็มหรือสรุปด้วย AI`)}
            </p>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            <a class="figma-detail-open-btn" href="${escHtml(safeHrefUrl(item.url))}" target="_blank" rel="noopener noreferrer">
              เปิดลิงก์ต้นฉบับ
            </a>
            <button type="button" class="figma-btn-outline-44 full" style="height:48px;border-radius:24px;" data-preview-mark-read="${escHtml(item.id)}">
              ทำเครื่องหมายว่าดูแล้ว
            </button>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;">
            <button type="button" class="tb-btn" data-preview-step="-1" ${idx === 0 ? "disabled" : ""}>↑ รายการก่อนหน้า</button>
            <span class="tiny-hint">ปัดขึ้นเพื่อดูรายการถัดไป</span>
            <button type="button" class="tb-btn" data-preview-step="1" ${idx >= pool.length - 1 ? "disabled" : ""}>↓ รายการถัดไป</button>
          </div>
        </div>`
      }
    </div>
  `;
}

function renderExternalShareSheet(state, sheet) {
  const d = sheet.draft;
  const folders = state.data.folders || [];
  const selectedFolderId = d.folderId === undefined ? folders[0]?.id || null : d.folderId;
  const quickTags = ["#คาเฟ่", "#อารีย์", "#ญี่ปุ่น", "#อาหาร"];
  const previewThumb = resolveMediaThumbUrl(d);

  return `
    <div class="modal-backdrop share-sheet-backdrop" data-close-sheet="1">
      <div class="bottom-sheet figma-white-sheet" data-node-id="319:541">
        <div class="figma-sheet-handle"></div>
        <div class="figma-ext-sheet-top">
          <h3 class="figma-sheet-h3">บันทึกลิงก์</h3>
          <button
            type="button"
            class="figma-ext-reminder-icon ${d.reminder ? "active" : ""}"
            data-toggle-draft-reminder="1"
            title="${escHtml(d.reminder || "ตั้งเตือน")}"
          >
            ${icons.clock(20)}
          </button>
        </div>

        <div class="figma-ext-link-preview">
          <div class="figma-ext-link-thumb">
            ${previewThumb ? `<img src="${escHtml(previewThumb)}" alt="" />` : `<span>${escHtml((d.platform || "L").charAt(0))}</span>`}
          </div>
          <div class="figma-ext-link-info">
            <input
              type="text"
              class="figma-ext-title-input"
              value="${escHtml(d.title || "คาเฟ่สายมินิมอลอารีย์")}"
              placeholder="ชื่อโพสต์"
              data-bind-save-title="1"
            />
            <span class="figma-ext-domain">${escHtml(d.domain || "tiktok.com/...")}</span>
          </div>
        </div>

        <div class="figma-sheet-field">
          <span class="figma-sheet-label">โฟลเดอร์</span>
          <div class="figma-chip-wrap">
            <button
              type="button"
              class="figma-pill-choice ${!selectedFolderId ? "selected" : ""}"
              data-select-save-folder="__none__"
            >ไม่ใส่โฟลเดอร์</button>
            ${folders
              .map((f) => {
                const selected = selectedFolderId === f.id;
                return `
                  <button
                    type="button"
                    class="figma-pill-choice ${selected ? "selected" : ""}"
                    data-select-save-folder="${escHtml(f.id)}"
                  >${escHtml(f.name)}</button>`;
              })
              .join("")}
            <button type="button" class="figma-pill-choice" data-action="open-create-folder-sheet">+ ใหม่</button>
          </div>
        </div>

        <div class="figma-sheet-field">
          <span class="figma-sheet-label">แท็ก</span>
          <div class="figma-chip-wrap">
            ${quickTags
              .map((tag) => {
                const active = (d.tags || []).includes(tag);
                return `
                  <button
                    type="button"
                    class="figma-pill-choice ${active ? "selected" : ""}"
                    data-toggle-save-tag="${escHtml(tag)}"
                  >${escHtml(tag)}</button>`;
              })
              .join("")}
          </div>
        </div>

        <input
          type="text"
          class="figma-sheet-input"
          value="${escHtml(d.note || "")}"
          placeholder="เพิ่มโน้ต (ไม่บังคับ)"
          data-bind-save-note="1"
        />

        <button type="button" class="figma-sheet-submit-btn" data-submit-save-link="1">
          บันทึก
        </button>
      </div>
    </div>
  `;
}

export function renderSaveAndReminderSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // Add Link Bottom Sheets: 319:541 (external share) OR 319:4332 / 319:4791 (in-app Add Link)
  if (sheet.type === "saveLink") {
    if (state.ui.simulatedSourceApp) {
      return renderExternalShareSheet(state, sheet);
    }

    const d = sheet.draft;
    const folders = state.data.folders || [];
    const selectedFolder = folders.find((f) => f.id === d.folderId) || null;
    const isExpanded = Boolean(state.ui.addLinkExpanded || d.showAdvanced);
    const quickTags = ["#คาเฟ่", "#ไอเดีย", "#เที่ยว", "#อาหาร", "#อ่านทีหลัง"];

    const nestedPicker = state.ui.folderPickerSheetOpen
      ? `
      <div class="modal-backdrop figma-nested-backdrop" data-action="close-folder-picker-sheet">
        <div class="bottom-sheet figma-white-sheet" data-node-id="319:4779">
          <div class="figma-sheet-handle" data-action="close-folder-picker-sheet"></div>
          <h3 class="figma-picker-title">เลือกโฟลเดอร์</h3>
          <div class="figma-picker-list">
            <button
              type="button"
              class="figma-picker-option ${!d.folderId ? "selected" : ""}"
              data-select-save-folder="__none__"
            >ไม่ใส่โฟลเดอร์ (ยังไม่จัดหมวด)</button>
            ${folders
              .map((f) => {
                const active = d.folderId === f.id;
                return `
                  <button
                    type="button"
                    class="figma-picker-option ${active ? "selected" : ""}"
                    data-select-save-folder="${escHtml(f.id)}"
                  >${escHtml(f.name)}</button>`;
              })
              .join("")}
            <button type="button" class="figma-sheet-inline-link" data-action="open-create-folder-sheet">
              + สร้างโฟลเดอร์ใหม่
            </button>
          </div>
        </div>
      </div>`
      : "";

    const nestedCreateFolder = state.ui.createFolderSheetOpen
      ? `
      <div class="modal-backdrop figma-nested-backdrop" data-action="close-create-folder-sheet">
        <div class="bottom-sheet figma-white-sheet" data-node-id="319:4659">
          <div class="figma-sheet-handle" data-action="close-create-folder-sheet"></div>
          <h2 class="figma-add-sheet-title">สร้างโฟลเดอร์</h2>

          <div class="figma-sheet-field">
            <label class="figma-sheet-label">ชื่อโฟลเดอร์</label>
            <input
              type="text"
              class="figma-sheet-input"
              value="${escHtml(state.ui.inlineFolderName || "")}"
              placeholder="ตั้งชื่อโฟลเดอร์ของคุณ"
              data-bind-inline-folder-name="1"
            />
          </div>

          <div class="figma-sheet-field">
            <label class="figma-sheet-label">ไอคอน / ปก (ไม่บังคับ)</label>
            <div class="figma-emoji-row">
              ${["☕", "✈️", "🍜", "💡", "📚", "🎵"]
                .map(
                  (em) => `
                <button
                  type="button"
                  class="figma-emoji-pill ${state.ui.inlineFolderEmoji === em ? "selected" : ""}"
                  data-action="select-inline-emoji"
                  data-emoji="${em}"
                >${em}</button>`
                )
                .join("")}
            </div>
          </div>

          <div class="figma-privacy-info-card">
            <strong>มองเห็นได้เฉพาะคุณ</strong>
            <p>แชร์ให้เพื่อนได้ภายหลังจากหน้าโฟลเดอร์</p>
          </div>

          <button type="button" class="figma-sheet-submit-btn" data-action="create-folder-inline">
            สร้างโฟลเดอร์
          </button>
        </div>
      </div>`
      : "";

    return `
      <div class="modal-backdrop share-sheet-backdrop" data-close-sheet="1">
        <div
          class="bottom-sheet figma-white-sheet ${isExpanded ? "is-expanded" : ""}"
          data-node-id="${isExpanded ? "319:4791" : "319:4332"}"
        >
          <div
            class="figma-sheet-handle"
            role="button"
            tabindex="0"
            data-action="toggle-add-link-expand"
            title="${isExpanded ? "ย่อแผง" : "ขยายแผง"}"
          ></div>

          <div class="figma-add-sheet-scroll">
            <div class="figma-add-sheet-head">
              <h2 class="figma-add-sheet-title">เพิ่มลิงก์</h2>
              <div style="display:flex;align-items:center;gap:8px;">
                <button type="button" class="figma-add-expand-btn" data-action="toggle-add-link-expand">
                  ${isExpanded ? "ย่อแผง" : "ขยายแผง"}
                </button>
                <button type="button" class="figma-share-close-btn" data-close-sheet="1" aria-label="ปิด">×</button>
              </div>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">ลิงก์ที่ต้องการบันทึก</label>
              <div class="figma-url-control">
                <input
                  type="url"
                  class="figma-url-input"
                  value="${escHtml(d.url || "")}"
                  placeholder="https://…"
                  data-bind-save-url="1"
                />
                <button type="button" class="figma-red-inline-action" data-action="paste-clipboard-url">
                  วางลิงก์
                </button>
              </div>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">บันทึกในโฟลเดอร์</label>
              <button
                type="button"
                class="figma-select-control"
                data-action="open-folder-picker-sheet"
              >
                <span class="${selectedFolder ? "has-value" : "placeholder"}">
                  ${selectedFolder ? escHtml(selectedFolder.name) : "ยังไม่เลือกโฟลเดอร์"}
                </span>
                <span class="caret">⌄</span>
              </button>
              <button type="button" class="figma-sheet-inline-link" data-action="open-create-folder-sheet">
                + สร้างโฟลเดอร์ใหม่
              </button>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">แท็ก (ไม่บังคับ)</label>
              <div class="figma-tag-selector-box">
                ${quickTags
                  .map((tag) => {
                    const active = (d.tags || []).includes(tag);
                    return `
                      <button
                        type="button"
                        class="figma-pill-choice ${active ? "selected" : ""}"
                        data-toggle-save-tag="${escHtml(tag)}"
                      >${escHtml(tag)}</button>`;
                  })
                  .join("")}
              </div>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">โน้ต (ไม่บังคับ)</label>
              <textarea
                class="figma-note-control"
                placeholder="จดสิ่งที่อยากกลับมาดู…"
                data-bind-save-note="1"
              >${escHtml(d.note || "")}</textarea>
            </div>

            ${
              isExpanded
                ? `
              <div class="figma-sheet-field">
                <label class="figma-sheet-label">ชื่อโพสต์ (ไม่บังคับ · ดึงอัตโนมัติได้)</label>
                <div class="figma-url-control">
                  <input
                    type="text"
                    class="figma-url-input"
                    value="${escHtml(d.title || "")}"
                    placeholder="ชื่อเรื่องหรือคำอธิบายโพสต์"
                    data-bind-save-title="1"
                  />
                  <button type="button" class="figma-red-inline-action" data-run-unfurl="1">
                    ดึงตัวอย่าง
                  </button>
                </div>
              </div>
              <div class="figma-sheet-field">
                <label class="figma-sheet-label">ตั้งเตือนด่วน</label>
                <button
                  type="button"
                  class="figma-pill-choice ${d.reminder ? "selected" : ""}"
                  data-toggle-draft-reminder="1"
                >
                  ${icons.clock(14)} ${escHtml(d.reminder || "เตือนพรุ่งนี้ 18:00")}
                </button>
              </div>`
                : ""
            }
          </div>

          <div class="figma-sheet-sticky-footer">
            <button type="button" class="figma-sheet-submit-btn" data-submit-save-link="1">
              บันทึกลิงก์
            </button>
          </div>
        </div>
      </div>
      ${nestedPicker}
      ${nestedCreateFolder}
    `;
  }

  // Reminder Bottom Sheet (Figma 319:5142 + Spec 2B Recurring Reminder Selector)
  if (sheet.type === "reminder") {
    const cal = buildMonthCalendarDays(sheet.yearMonth);
    const daySelected = Math.min(Number(sheet.day || 1), cal.days.length);
    const dows = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
    const scheduleType = sheet.scheduleType || state.ui.reminderScheduleType || "once";
    const repeatDays = Number(sheet.repeatEveryDays || state.ui.reminderRepeatDays || 3);

    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-reminder-sheet" data-node-id="319:5142">
          <div class="figma-sheet-handle"></div>
          <h3 class="figma-reminder-title">ตั้งเตือน</h3>

          <div class="figma-cal-month-row">
            <button type="button" class="figma-cal-nav-btn" data-cal-month="-1" aria-label="เดือนก่อนหน้า">${icons.back(18)}</button>
            <strong class="figma-cal-month-label">${escHtml(sheet.monthLabel || cal.monthLabel)}</strong>
            <button type="button" class="figma-cal-nav-btn" data-cal-month="1" aria-label="เดือนถัดไป">${icons.chevronRight(18)}</button>
          </div>

          <div class="figma-cal-grid">
            ${dows.map((d) => `<div class="figma-cal-dow">${d}</div>`).join("")}
            ${Array.from({ length: cal.leadingEmpty }, () => `<span class="figma-cal-day empty" aria-hidden="true"></span>`).join("")}
            ${cal.days
              .map(
                (cell) => `
              <button
                type="button"
                class="figma-cal-day ${cell.isPast ? "muted is-past" : ""} ${cell.isToday ? "is-today" : ""} ${cell.day === daySelected ? "selected" : ""}"
                data-select-cal-day="${cell.day}"
                ${cell.isPast ? `disabled aria-disabled="true"` : ""}
              >${cell.day}</button>`
              )
              .join("")}
          </div>

          <div class="figma-time-field">
            <span class="figma-time-label">เวลา</span>
            <input
              type="time"
              class="figma-time-input"
              value="${escHtml(sheet.time || "18:00")}"
              data-bind-cal-time="1"
            />
          </div>

          <!-- Spec 2B: Compact Recurring Schedule Row directly below Time -->
          <div class="figma-recurrence-row">
            <div class="figma-recurrence-tabs">
              <button
                type="button"
                class="figma-recur-pill ${scheduleType === "once" ? "active" : ""}"
                data-action="set-reminder-schedule-type"
                data-schedule-type="once"
              >เตือนครั้งเดียว</button>
              <button
                type="button"
                class="figma-recur-pill ${scheduleType === "every_n_days" ? "active" : ""}"
                data-action="set-reminder-schedule-type"
                data-schedule-type="every_n_days"
              >เตือนซ้ำทุก N วัน</button>
            </div>
            ${
              scheduleType === "every_n_days"
                ? `
              <div class="figma-recur-stepper">
                <button type="button" class="figma-step-btn" data-action="step-reminder-repeat-days" data-delta="-1">−</button>
                <span>${repeatDays} วัน</span>
                <button type="button" class="figma-step-btn" data-action="step-reminder-repeat-days" data-delta="1">+</button>
              </div>`
                : ""
            }
          </div>

          <div class="figma-reminder-actions">
            <button type="button" class="figma-btn-outline-48" data-clear-reminder="${escHtml(sheet.linkId)}">
              ลบเตือน
            </button>
            <button type="button" class="figma-btn-red-48" data-save-reminder="${escHtml(sheet.linkId)}">
              ตั้งเตือน
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
