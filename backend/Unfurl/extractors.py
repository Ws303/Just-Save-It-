"""Zero-token Rich Unfurl Platform & Generic HTML extractors.

Reuses Part 1 SSRF & hygiene modules (`Ai.content_extractor` and `Database.text_hygiene`):
- Platform Matrix: YouTube, TikTok, Vimeo, Spotify, Reddit (.json + gallery + oEmbed),
  X (publish.twitter.com/oembed), Instagram/Facebook (Meta oEmbed or og:* fallback),
  and Generic Web (httpx 8s timeout / <= 3MB body limit + selectolax).
- Image Junk Filter & Hard Cap <= 5: strips .svg, 1x1 pixels, avatars/icons/logos/banners/ads/emojis,
  < 200px dimensions, duplicates, and unsafe URLs.
- Strict Embed Allowlist sanitation via `Unfurl.security.validate_embed_url`.
- Strictly 0 LLM calls.
"""

import asyncio
from dataclasses import dataclass, field
import html as html_lib
import ipaddress
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple
import urllib.parse

import httpx

from Ai.content_extractor import (
    DEFAULT_TIMEOUT_SEC,
    USER_AGENT,
    _fetch_url_safely,
    _host_matches,
    validate_safe_url,
)
from Database.text_hygiene import (
    canonicalize_url,
    clean_text_field,
    compute_url_hash,
    decode_html_bytes,
    normalize_unicode_text,
)
from .security import (
    extract_safe_iframe_src,
    is_meta_crawler_ua_enabled,
    redact_secrets_in_text,
    sanitize_external_url,
    stream_fetch_limited,
    validate_embed_url,
)

try:
    from selectolax.lexbor import LexborHTMLParser as HTMLParser
except ImportError:
    try:
        from selectolax.parser import HTMLParser
    except ImportError:
        HTMLParser = None  # type: ignore

try:
    import trafilatura
except ImportError:
    trafilatura = None  # type: ignore

logger = logging.getLogger("just_save_it.unfurl.extractors")

MAX_HTML_BYTES = 3 * 1024 * 1024  # 3 MB
MAX_MEDIA_ITEMS = 5
MIN_IMAGE_DIM_PX = 200

_VALID_CONTENT_TYPES = frozenset({"video", "article", "post", "product", "link", "other"})

_JUNK_SUBSTRINGS = (
    "1x1",
    "pixel.gif",
    "spacer.gif",
    "blank.gif",
    "clear.gif",
    "doubleclick",
    "googlesyndication",
    "adservice",
    "adsystem",
    "default_profile",
    "profile_images",
)

_JUNK_SEGMENT_RE = re.compile(
    r"(?:^|[/._-])(avatar|avatars|icon|icons|favicon|logo|logos|badge|badges|emoji|emojis|twemoji|smilies|sprite|sprites|ads|adserver|banner|banners|spinner|loader|loading|placeholder|beacon|tracking)(?:$|[/._-])",
    re.IGNORECASE,
)

_YOUTUBE_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/(?:shorts|embed|live)/)([A-Za-z0-9_-]{11})"
)
_TIKTOK_ID_RE = re.compile(r"/(?:video|photo)/(\d+)")
_VIMEO_ID_RE = re.compile(r"vimeo\.com/(?:video/|channels/[^/]+/)?(\d+)")
_SPOTIFY_RE = re.compile(r"/(?:intl-[a-z-]+/)?(track|album|playlist|episode|show|artist)/([A-Za-z0-9]+)")
_X_STATUS_RE = re.compile(r"/(?:status|statuses)/(\d+)")
_IG_CODE_RE = re.compile(r"/(p|reels?|tv)/([A-Za-z0-9_-]+)")
_FB_VIDEO_PATH_RE = re.compile(r"(?:^|/)(?:watch|videos|reel|reels|share/[vr])(?:/|$)", re.IGNORECASE)
_SHORT_SHARE_HOSTS = ("fb.watch", "vt.tiktok.com", "vm.tiktok.com", "l.facebook.com", "lm.facebook.com")

_LOGIN_WALL_MARKERS = (
    "log into facebook",
    "log in to facebook",
    "log in or sign up to view",
    "login • instagram",
    "เข้าสู่ระบบ facebook",
    "เข้าสู่ระบบ instagram",
    "เข้าสู่ระบบเพื่อดู",
    "you must log in to continue",
)

_PRIVATE_UNAVAILABLE_MARKERS = (
    "this content isn't available right now",
    "this page isn't available",
    "this video is private",
    "private video",
    "this account is private",
    "sorry, this content isn't available",
    "the link to this photo or video may be broken",
    "the post may have been removed",
    "เนื้อหานี้ไม่พร้อมใช้งาน",
    "ไม่สามารถใช้งานเนื้อหานี้ได้",
    "ลิงก์ไปยังรูปภาพหรือวิดีโอนี้อาจเสียหาย",
    "โพสต์อาจถูกลบออกไปแล้ว",
    "บัญชีนี้เป็นส่วนตัว",
    "หน้านี้ไม่พร้อมใช้งาน",
)


@dataclass
class UnfurlResult:
    url: str
    canonical_url: str
    url_hash: str
    title: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    media_items: List[str] = field(default_factory=list)
    embed_type: str = "none"
    embed_url: Optional[str] = None
    site_name: Optional[str] = None
    favicon_url: Optional[str] = None
    content_type: Optional[str] = "link"
    platform: str = "web"
    preview_status: str = "ok"
    allow_profile_avatars: bool = field(default=False, repr=False, compare=False)

    def finalized(self) -> "UnfurlResult":
        """Enforce final embed allowlist, <=5 image cap, and Unicode hygiene invariants."""
        safe_embed_url = validate_embed_url(self.embed_type, self.embed_url)
        self.embed_url = safe_embed_url
        if not safe_embed_url:
            self.embed_type = "none"

        cleaned_images = filter_and_cap_images(
            [(u, None, None) for u in self.media_items],
            base_url=self.canonical_url or self.url,
            max_images=MAX_MEDIA_ITEMS,
            allow_profile_avatars=self.allow_profile_avatars,
        )
        self.media_items = cleaned_images
        self.image_url = cleaned_images[0] if cleaned_images else None
        self.title = clean_text_field(self.title, unescape_html=True)
        self.description = clean_text_field(self.description, unescape_html=True)
        self.site_name = clean_text_field(self.site_name, unescape_html=True)
        if self.platform in ("facebook", "instagram", "tiktok"):
            self.title, self.description = _sanitize_social_title_and_description(
                self.title,
                self.description,
                self.platform,
                self.canonical_url or self.url,
                is_profile_or_page=self.allow_profile_avatars,
            )
        else:
            scrubbed = _scrub_generic_platform_title(
                self.title,
                self.canonical_url or self.url,
                platform=self.platform,
            )
            if not scrubbed and self.description and not self.description.startswith("By "):
                scrubbed = _extract_short_opening_title(self.description)
            self.title = scrubbed or self.canonical_url or self.url
        self.favicon_url = sanitize_external_url(self.favicon_url)
        if self.content_type not in _VALID_CONTENT_TYPES:
            self.content_type = "link"
        if self.preview_status not in ("ok", "private_or_restricted", "no_media"):
            self.preview_status = "ok"
        return self


_FB_STATS_SEGMENT_RE = re.compile(
    r"(?:\d|แสน|ล้าน|พัน|หมื่น).*(?:ยอดดู|รับชม|ความรู้สึก|ถูกใจ|ความคิดเห็น|คอมเมนต์|แชร์|ผู้ติดตาม|คนกำลังพูดถึง|views?|reactions?|likes?|comments?|shares?|followers?)"
    r"|(?:ยอดดู|รับชม|ความรู้สึก|ถูกใจ|ความคิดเห็น|คอมเมนต์|แชร์|ผู้ติดตาม|views?|reactions?|likes?|comments?|shares?).*(?:\d|แสน|ล้าน|พัน|หมื่น)",
    re.IGNORECASE,
)
_FB_INLINE_PAGE_STATS_TH_RE = re.compile(
    r"(?:(?<=\.\s)|^)(?:ผู้ติดตาม|ถูกใจ)\s*[\d,.]+\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*คน(?:\s*·\s*[\d,.]+\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*คน[^\s.]*)*\.?\s*",
    re.IGNORECASE,
)
_FB_INLINE_PAGE_STATS_EN_RE = re.compile(
    r"(?:(?<=\.\s)|^)[\d,.]+[KMBkmb]?\s+(?:likes?|followers?)(?:\s*·\s*[\d,.]+[KMBkmb]?\s+(?:talking about this|were here|followers?))*\.?\s*",
    re.IGNORECASE,
)
_IG_OG_TITLE_RE = re.compile(
    r"^(.+?)\s+(?:on|บน)\s+Instagram:\s*[\"“”]?([\s\S]+?)[\"“”]?\s*$",
    re.IGNORECASE,
)
_IG_OG_DESC_RE = re.compile(
    r"^(?:[\d,.]+[KMBkmb]?\s*(?:likes?|comments?)|(?:ถูกใจ|ความคิดเห็น)\s*[^,-]+)"
    r"(?:[\s,·•]+(?:[\d,.]+[KMBkmb]?\s*(?:likes?|comments?)|(?:ถูกใจ|ความคิดเห็น)\s*[^,-]+))*"
    r"\s*-\s*([A-Za-z0-9._]+)(?:\s+(?:on|บน|เมื่อ)\s+[^:]+)?:\s*([\s\S]*?)\s*$",
    re.IGNORECASE,
)
_NOTIFICATION_PREFIX_RE = re.compile(r"^\(\d+\+?\)\s+")
_META_CROPPED_STP_RE = re.compile(r"(?:^|[?&])stp=c\d+\.\d+\.\d+\.\d+", re.I)
_META_DOWNSCALED_RE = re.compile(r"(?:[?&]stp=[^&]*cmp\d+|_s(?:640|480|320|240|150)x(?:640|480|320|240|150))", re.I)
_META_ASSET_FILENAME_RE = re.compile(r"^\d+_\d+_\d+_[a-z]\.(?:jpg|jpeg|png|webp)$", re.I)
_TIKTOK_ASSET_ID_RE = re.compile(r"/tos-[^/]+/([A-Za-z0-9_-]{12,})(?:~|$)")
_GENERIC_PLATFORM_TITLES = frozenset(
    {
        "instagram",
        "log in • instagram",
        "login • instagram",
        "เข้าสู่ระบบ • instagram",
        "เข้าสู่ระบบ instagram",
        "create an account or log in to instagram",
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
    }
)


def is_generic_or_noisy_title(title: Optional[str], platform: str = "", url: str = "") -> bool:
    """Return True if title is missing, raw URL/hostname, generic platform shell, or notification-prefixed."""
    if not title or not isinstance(title, str):
        return True
    stripped = title.strip()
    if not stripped:
        return True
    lowered = stripped.lower()
    if lowered.startswith(("http://", "https://")):
        return True
    if url:
        canon = canonicalize_url(url)
        if lowered in (url.strip().lower(), canon.strip().lower()):
            return True
        host = (urllib.parse.urlparse(canon).hostname or "").lower()
        if host and lowered in (host, host.removeprefix("www.")):
            return True

    no_badge = _NOTIFICATION_PREFIX_RE.sub("", stripped).strip()
    no_badge_lower = no_badge.lower()
    if lowered in _GENERIC_PLATFORM_TITLES or no_badge_lower in _GENERIC_PLATFORM_TITLES:
        return True
    if _NOTIFICATION_PREFIX_RE.match(stripped) and (
        re.search(r"\s*[-–|]\s*YouTube$", stripped, re.I) or no_badge_lower in _GENERIC_PLATFORM_TITLES
    ):
        return True

    plat_lower = (platform or "").lower()
    if plat_lower == "instagram" or (not plat_lower and "instagram.com" in url.lower()):
        if re.match(r"^@?[A-Za-z0-9._]+\s+(?:on|บน)\s+Instagram\s*$", no_badge, re.I):
            return True
        if re.match(r"^(?:Instagram photos and videos|ดูรูปภาพและวิดีโอบน Instagram)\s*$", no_badge, re.I):
            return True
    if plat_lower == "tiktok" or (not plat_lower and "tiktok.com" in url.lower()):
        if re.match(r"^(?:watch\s+trending|discover|make your day|tiktok)\b.*\|\s*tiktok$", no_badge_lower, re.I):
            return True
        if re.match(r"^[^|\n]+\s+(?:on|บน)\s+TikTok\s*$", no_badge, re.I):
            return True
        if re.match(r"^(?:TikTok\s*[·|]\s*|TikTok's Creator Profile$|photo on tiktok$)", no_badge, re.I):
            return True
    if plat_lower == "youtube" or (not plat_lower and ("youtube.com" in url.lower() or "youtu.be" in url.lower())):
        if re.match(r"^(?:home|shorts)?\s*[-–|]?\s*youtube$", no_badge_lower, re.I):
            return True
    if plat_lower == "x" or (not plat_lower and ("x.com" in url.lower() or "twitter.com" in url.lower())):
        if re.match(r"^(?:home|explore|post|log in to x)\s*/\s*(?:x|twitter)$", no_badge_lower, re.I):
            return True
    return False
_IG_PROFILE_STATS_DESC_RE = re.compile(
    r"^(?:ผู้ติดตาม\s*[^-]+|[\d,.]+[KMBkmb]?\s*Followers,\s*[\d,.]+[KMBkmb]?\s*Following,\s*[\d,.]+[KMBkmb]?\s*Posts)\s*-\s*",
    re.IGNORECASE,
)
_IG_PROFILE_TITLE_RE = re.compile(
    r"^(.+?)\s*\((@?[A-Za-z0-9._]+)\)\s*[•·]\s*(?:Instagram|รูปภาพและวิดีโอบน\s*Instagram|รูปและวิดีโอ\s*Instagram).*$",
    re.IGNORECASE,
)
_IG_PROFILE_SEE_RE = re.compile(
    r"^(?:ดูรูปภาพและวิดีโอบน\s*Instagram\s*จาก|See Instagram photos and videos from)\s+(.+?)(?:\s*\((@?[A-Za-z0-9._]+)\))?\s*(?::\s*([\s\S]*))?$",
    re.IGNORECASE,
)
_TT_META_DESC_RE = re.compile(
    r"^(?:[\d,.]+[KMBkmb]?\s*Likes?(?:,\s*[\d,.]+[KMBkmb]?\s*Comments?)?\.?\s*"
    r"|ถูกใจ\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*ครั้ง(?:,\s*ความคิดเห็น\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*รายการ)?\.?\s*)"
    r"(?:TikTok (?:video|photo) from\s+([^:]+):\s*[\"“”]?([\s\S]+?)[\"“”]?\s*$"
    r"|(?:วิดีโอ|รูปภาพ|โพสต์)\s*TikTok\s*จาก\s+([^:]+):\s*[\"“”]?([\s\S]+?)[\"“”]?\s*$)?",
    re.IGNORECASE,
)


def _extract_author_from_social_url(url: str, platform: str) -> Optional[str]:
    try:
        parsed = urllib.parse.urlparse(url)
        segments = [seg for seg in (parsed.path or "").split("/") if seg]
    except Exception:
        return None
    if not segments:
        return None
    first = segments[0]
    if platform == "tiktok" and first.startswith("@"):
        return first
    if platform == "instagram" and first.lower() not in ("p", "reel", "reels", "tv", "stories", "explore", "share", "accounts"):
        return first if first.startswith("@") else f"@{first}"
    if platform == "facebook" and first.lower() not in (
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
    ):
        return first
    return None


def _normalize_compare_text(val: Optional[str], *, collapse_spaces: bool = False) -> str:
    if not val:
        return ""
    cleaned = re.sub(r"^[\s\"'“”‘’]+|[\s\"'“”‘’….\-]+$", "", val.strip())
    if collapse_spaces:
        return re.sub(r"\s+", "", cleaned).lower()
    return re.sub(r"\s+", " ", cleaned).lower()


def _strip_balanced_caption_quotes(raw_cap: str) -> str:
    cap = raw_cap.strip()
    if (cap.startswith('"') and cap.endswith('".')) or (cap.startswith("“") and cap.endswith("”.")):
        return cap[1:-2].strip()
    if (cap.startswith('"') and cap.endswith('"')) or (cap.startswith("“") and cap.endswith("”")):
        return cap[1:-1].strip()
    if (cap.endswith('".') and cap.count('"') % 2 == 1) or (cap.endswith("”.") and cap.count("”") % 2 == 1):
        return cap[:-2].strip()
    return cap


def _combine_author_labels(display_author: Optional[str], handle_author: Optional[str]) -> Optional[str]:
    disp = (display_author or "").strip()
    hnd = (handle_author or "").strip()
    if disp and hnd:
        norm_disp = disp.lstrip("@").lower()
        norm_hnd = hnd.lstrip("@").lower()
        if norm_disp == norm_hnd or norm_hnd in norm_disp:
            return disp
        hnd_fmt = hnd if hnd.startswith("@") else f"@{hnd}"
        return f"{disp} ({hnd_fmt})"
    return disp or hnd or None


def _extract_short_opening_title(caption: Optional[str], max_chars: int = 58) -> Optional[str]:
    """Extract a concise 1-line opening sentence/clause from a social post caption."""
    if not caption:
        return None
    first_line = ""
    for raw_ln in caption.splitlines():
        cleaned_ln = re.sub(r"\*\*|__", "", raw_ln).strip().strip("\"'“”‘’")
        if cleaned_ln:
            first_line = re.sub(r"\s+", " ", cleaned_ln)
            break
    if not first_line:
        return None

    # Split at the first sentence terminator (!, ?, .) if it yields a concise opening sentence
    sent_match = re.match(r"^(.{8,}?[!?.])(?:\s+|$)", first_line)
    if sent_match and len(sent_match.group(1).strip()) <= max_chars:
        return sent_match.group(1).strip()

    if len(first_line) <= max_chars:
        return first_line

    # Otherwise cut at a natural clause/word space boundary within max_chars
    window = first_line[:max_chars]
    space_idx = window.rfind(" ")
    if space_idx >= 16:
        cut = window[:space_idx].rstrip(" ,;:-—–·•.")
        return f"{cut}…"
    return f"{window.rstrip(' ,;:-—–·•.')}…"


def _sanitize_social_title_and_description(
    title: Optional[str],
    description: Optional[str],
    platform: str,
    canon_url: str,
    *,
    is_profile_or_page: bool = False,
) -> Tuple[Optional[str], Optional[str]]:
    """Strip view/reaction/comment counts and set title to the short 1-line opening sentence of the caption."""
    t = (title or "").strip() or None
    d = (description or "").strip() or None
    display_author: Optional[str] = None
    handle_author: Optional[str] = None

    if platform == "facebook":
        if t and "|" in t:
            parts = [p.strip() for p in t.split("|") if p.strip()]
            while len(parts) > 1 and _FB_STATS_SEGMENT_RE.search(parts[0]):
                parts.pop(0)
            if len(parts) > 1 and parts[-1].lower() == "facebook":
                parts.pop()
            if len(parts) >= 2:
                # For FB group/page posts: "Group Name | Caption snippet" or "Caption | Author"
                if len(parts[0]) <= 45 and len(parts[1]) > len(parts[0]):
                    display_author = parts[0]
                    t = " | ".join(parts[1:]).strip() or display_author
                else:
                    display_author = parts[-1]
                    t = " | ".join(parts[:-1]).strip() or display_author
            elif len(parts) == 1:
                t = parts[0]
        elif t and _FB_STATS_SEGMENT_RE.search(t) and len(t) < 80:
            t = None

        if d:
            if "|" in d:
                d_parts = [p.strip() for p in d.split("|") if p.strip()]
                while len(d_parts) > 1 and _FB_STATS_SEGMENT_RE.search(d_parts[0]):
                    d_parts.pop(0)
                d = " | ".join(d_parts).strip()
            d = _FB_INLINE_PAGE_STATS_TH_RE.sub("", d)
            d = _FB_INLINE_PAGE_STATS_EN_RE.sub("", d)
            if t and d.startswith(f"{t}. "):
                d = d[len(t) + 2 :].strip()
            elif t and d.startswith(f"{t} ") and len(t) <= 45:
                d = d[len(t) :].lstrip(" .-·•").strip()

    elif platform == "instagram":
        if t:
            m_prof_t = _IG_PROFILE_TITLE_RE.match(t)
            m_see_t = _IG_PROFILE_SEE_RE.match(t) if not m_prof_t else None
            m_title = _IG_OG_TITLE_RE.match(t) if not (m_prof_t or m_see_t) else None
            if m_prof_t:
                display_author = m_prof_t.group(1).strip()
                handle_author = f"@{m_prof_t.group(2).strip().lstrip('@')}"
                t = _combine_author_labels(display_author, handle_author)
            elif m_see_t:
                display_author = m_see_t.group(1).strip()
                if m_see_t.group(2):
                    handle_author = f"@{m_see_t.group(2).strip().lstrip('@')}"
                t = _combine_author_labels(display_author, handle_author)
            elif m_title:
                display_author = m_title.group(1).strip()
                t_cap = m_title.group(2).strip()
                t = f"{display_author}: {t_cap}" if t_cap else display_author
        if d:
            m_desc = _IG_OG_DESC_RE.match(d)
            if m_desc:
                ig_user = m_desc.group(1).strip()
                handle_author = f"@{ig_user.lstrip('@')}"
                d_cap = _strip_balanced_caption_quotes(m_desc.group(2))
                d = d_cap if d_cap else None
            else:
                stats_m = _IG_PROFILE_STATS_DESC_RE.match(d)
                stats_prefix = stats_m.group(0).rstrip(" -") if stats_m else None
                d_after_stats = _IG_PROFILE_STATS_DESC_RE.sub("", d).strip()
                m_see_d = _IG_PROFILE_SEE_RE.match(d_after_stats)
                if m_see_d:
                    if not display_author:
                        display_author = m_see_d.group(1).strip()
                    if m_see_d.group(2) and not handle_author:
                        handle_author = f"@{m_see_d.group(2).strip().lstrip('@')}"
                    trailing_bio = _strip_balanced_caption_quotes(m_see_d.group(3) or "")
                    if trailing_bio and stats_prefix:
                        d = f"{stats_prefix} — {trailing_bio}"
                    else:
                        d = trailing_bio or stats_prefix or None
                    if is_profile_or_page and (not t or _IG_PROFILE_SEE_RE.match(t)):
                        t = _combine_author_labels(display_author, handle_author) or t
                else:
                    d = _strip_balanced_caption_quotes(d_after_stats) or None

    elif platform == "tiktok":
        if d:
            m_tt = _TT_META_DESC_RE.match(d)
            if m_tt and (m_tt.group(1) or m_tt.group(3)):
                tt_author = (m_tt.group(1) or m_tt.group(3) or "").strip()
                tt_cap = _strip_balanced_caption_quotes(m_tt.group(2) or m_tt.group(4) or "")
                if tt_author and not display_author:
                    display_author = tt_author
                if tt_cap:
                    d = tt_cap
            else:
                d = re.sub(
                    r"^(?:[\d,.]+[KMBkmb]?\s*Likes?(?:,\s*[\d,.]+[KMBkmb]?\s*Comments?)?\.?\s*"
                    r"|ถูกใจ\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*ครั้ง(?:,\s*ความคิดเห็น\s*[\d,.]+[KMBkmb]?\s*(?:แสน|ล้าน|พัน|หมื่น)?\s*รายการ)?\.?\s*)",
                    "",
                    d,
                    flags=re.IGNORECASE,
                ).strip() or None

    if t:
        t = _scrub_generic_platform_title(t, canon_url, platform=platform)

    if is_profile_or_page:
        if not t:
            t = _combine_author_labels(display_author, handle_author) or _extract_author_from_social_url(canon_url, platform)
        if t and d and _normalize_compare_text(t) == _normalize_compare_text(d):
            d = None
        return (clean_text_field(t, unescape_html=True) if t else None), (
            clean_text_field(d, unescape_html=True) if d else None
        )

    # Extract embedded author prefixes such as "Author: caption" or "@user — caption"
    t_core = t
    d_core = d
    if t:
        m_tc = re.match(r"^([^:\n|]{1,50}):\s+([\s\S]+)$", t)
        if m_tc and not m_tc.group(1).strip().lower().startswith(("http", "https")):
            if not display_author:
                display_author = m_tc.group(1).strip()
            t_core = m_tc.group(2).strip()
        if t_core:
            t_core = _scrub_generic_platform_title(t_core, canon_url, platform=platform)
    if d:
        d_core = _strip_balanced_caption_quotes(d_core) if d_core else None
        m_dc = re.match(r"^(@[A-Za-z0-9._-]+)\s+[—–-]\s+([\s\S]+)$", d_core or "")
        if m_dc:
            if not handle_author:
                handle_author = m_dc.group(1).strip()
            d_core = m_dc.group(2).strip()
        else:
            m_dc2 = re.match(r"^([^:\n|—]{1,50})\s+—\s+([\s\S]+)$", d_core or "")
            if m_dc2:
                if not display_author:
                    display_author = m_dc2.group(1).strip()
                d_core = m_dc2.group(2).strip()
        if d_core:
            d_core = _strip_balanced_caption_quotes(d_core)

    norm_t = _normalize_compare_text(t_core)
    norm_d = _normalize_compare_text(d_core)
    norm_t_compact = _normalize_compare_text(t_core, collapse_spaces=True)
    norm_d_compact = _normalize_compare_text(d_core, collapse_spaces=True)
    is_dup = False
    if norm_t and norm_d:
        if norm_t == norm_d or (norm_t_compact and norm_t_compact == norm_d_compact):
            is_dup = True
        elif len(norm_t) >= 12 and (norm_d.startswith(norm_t) or norm_t.startswith(norm_d)):
            is_dup = True
        elif len(norm_t_compact) >= 12 and (
            norm_d_compact.startswith(norm_t_compact) or norm_t_compact.startswith(norm_d_compact)
        ):
            is_dup = True

    is_synthetic_desc = bool(
        d_core
        and (
            (d_core.startswith("@") and " " not in d_core)
            or d_core.startswith("โพสต์จาก ")
        )
    )
    url_author = _extract_author_from_social_url(canon_url, platform)
    t_core_lower = (t_core or "").strip().lower()
    t_is_author_or_generic = bool(
        not t_core
        or is_generic_or_noisy_title(t_core, platform, canon_url)
        or (display_author and t_core_lower == display_author.strip().lower())
        or (handle_author and t_core_lower in (handle_author.strip().lower(), handle_author.strip().lstrip("@").lower()))
        or (url_author and t_core_lower in (url_author.strip().lower(), url_author.strip().lstrip("@").lower()))
    )
    t_is_multiline_or_long = bool(t_core and ("\n" in t_core or "\r" in t_core or len(t_core) > 65))
    should_use_opening_sentence = bool(
        d_core
        and not is_synthetic_desc
        and (
            is_dup
            or t_is_author_or_generic
            or t_is_multiline_or_long
            or (len(d_core) >= 24 and len(d_core) > len(t_core or ""))
        )
    )

    if should_use_opening_sentence and d_core:
        best_caption = d_core if (not is_dup or len(d_core) >= len(t_core or "")) else (t_core or d_core)
        d = best_caption
        short_opening = _extract_short_opening_title(best_caption)
        if short_opening:
            t = short_opening
    elif t_core and (is_dup or t_is_multiline_or_long):
        if not d or is_synthetic_desc or len(t_core) > len(d):
            d = t_core
        t = _extract_short_opening_title(t_core) or t_core

    return (clean_text_field(t, unescape_html=True) if t else None), (
        clean_text_field(d, unescape_html=True) if d else None
    )


def _has_marker(text: Optional[str], markers: Tuple[str, ...]) -> bool:
    if not text:
        return False
    lowered = text.strip().lower()
    return any(m in lowered for m in markers)


def _is_facebook_video_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if _host_matches(host, ("fb.watch",)):
        return True
    path = parsed.path or ""
    if _FB_VIDEO_PATH_RE.search(path):
        return True
    qs = urllib.parse.parse_qs(parsed.query or "")
    return bool(qs.get("v"))


_FB_FEED_PATHS = frozenset(
    {
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
    }
)
_FB_POST_PATH_RE = re.compile(
    r"(?:^/share/(?:[pvr]/)?[A-Za-z0-9_-]+|/(?:posts|videos|photos|permalink)/[^/]+|^/(?:reel|reels)/[^/]+|^/(?:permalink|story|photo)\.php|^/watch/live/?|pfbid[A-Za-z0-9]+)",
    re.IGNORECASE,
)
_IG_RESERVED_ROOT_PATHS = frozenset(
    {
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
    }
)


def _is_youtube_post_url(url: str) -> bool:
    """Return True if URL points to a YouTube Community post (/post/Ugkx... or /community?lb=...)."""
    parsed = urllib.parse.urlparse(url)
    if not _host_matches((parsed.hostname or "").lower(), ("youtube.com",)):
        return False
    path = parsed.path or "/"
    if re.match(r"^/post/[A-Za-z0-9_-]+/?$", path, re.IGNORECASE):
        return True
    qs = urllib.parse.parse_qs(parsed.query or "")
    return bool(qs.get("lb")) and bool(re.search(r"/(?:community|posts)/?$", path, re.IGNORECASE))


def _is_youtube_channel_url(url: str) -> bool:
    """Return True if URL points to a YouTube channel home/tab page (not a video or post)."""
    if _YOUTUBE_ID_RE.search(url) or _is_youtube_post_url(url):
        return False
    parsed = urllib.parse.urlparse(url)
    if not _host_matches((parsed.hostname or "").lower(), ("youtube.com",)):
        return False
    path = (parsed.path or "/").rstrip("/")
    return bool(
        re.match(
            r"^/(?:@[^/]+|channel/[^/]+|c/[^/]+|user/[^/]+)(?:/(?:featured|videos|shorts|streams|playlists|community|posts|about))?$",
            path,
            re.IGNORECASE,
        )
    )


def _is_tiktok_profile_url(url: str) -> bool:
    """Return True if URL points to a TikTok creator channel/profile (/@handle)."""
    parsed = urllib.parse.urlparse(url)
    if not _host_matches((parsed.hostname or "").lower(), ("tiktok.com",)):
        return False
    return bool(re.match(r"^/@[A-Za-z0-9._-]+/?$", parsed.path or ""))


def _is_instagram_profile_url(url: str) -> bool:
    """Return True if URL points to an Instagram profile (/username/)."""
    parsed = urllib.parse.urlparse(url)
    if not _host_matches((parsed.hostname or "").lower(), ("instagram.com",)):
        return False
    path = parsed.path or "/"
    if _IG_CODE_RE.search(path):
        return False
    m = re.match(r"^/([A-Za-z0-9._]+)/?$", path)
    if not m:
        return False
    return m.group(1).lower() not in _IG_RESERVED_ROOT_PATHS


def _is_facebook_page_or_profile_url(url: str) -> bool:
    """Return True if URL points to a Facebook Page, Profile, or Group home (not a single post/video)."""
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    if not _host_matches(host, ("facebook.com",)) or host == "fb.watch":
        return False
    if _is_facebook_video_url(url):
        return False
    path = parsed.path or "/"
    qs = urllib.parse.parse_qs(parsed.query or "")
    if any(qs.get(k) for k in ("story_fbid", "fbid", "v", "multi_permalinks")):
        return False
    if _FB_POST_PATH_RE.search(path):
        return False
    norm_path = path.rstrip("/").lower() or "/"
    if norm_path == "/profile.php":
        return bool(qs.get("id"))
    if norm_path in _FB_FEED_PATHS:
        return False
    return norm_path != "/"


def is_profile_or_page_url(url: str) -> bool:
    """Return True if URL points to a social profile, channel, or Facebook page/group home."""
    if not url:
        return False
    return (
        _is_youtube_channel_url(url)
        or _is_tiktok_profile_url(url)
        or _is_instagram_profile_url(url)
        or _is_facebook_page_or_profile_url(url)
    )


def _is_short_or_share_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    path = (parsed.path or "").lower()
    if _host_matches(host, _SHORT_SHARE_HOSTS):
        return True
    if _host_matches(host, ("facebook.com", "instagram.com")) and path.startswith("/share/"):
        return True
    if _host_matches(host, ("tiktok.com",)) and path.startswith("/t/"):
        return True
    return False


async def _resolve_short_share_url(
    canon_url: str,
    *,
    force_meta_crawler_ua: bool = False,
) -> str:
    """Resolve short/share redirects (e.g., vt.tiktok.com, fb.watch, facebook.com/share/*) safely."""
    if not _is_short_or_share_url(canon_url):
        return canon_url
    try:
        _, _, _, final_url = await _fetch_limited_response(
            canon_url,
            max_bytes=32768,
            force_meta_crawler_ua=force_meta_crawler_ua,
        )
        if final_url and _is_safe_http_literal(final_url):
            resolved_canon = canonicalize_url(final_url)
            parsed_res = urllib.parse.urlparse(resolved_canon)
            resolved_host = (parsed_res.hostname or "").lower()
            resolved_path = (parsed_res.path or "").lower()
            # If Facebook bounced to /login/?next=<real_url>, extract the underlying post/reel URL
            if "/login" in resolved_path:
                next_vals = urllib.parse.parse_qs(parsed_res.query or "").get("next") or []
                if next_vals:
                    next_candidate = urllib.parse.unquote(next_vals[0]).strip()
                    if _is_safe_http_literal(next_candidate):
                        next_canon = canonicalize_url(next_candidate)
                        next_parsed = urllib.parse.urlparse(next_canon)
                        if "/login" not in (next_parsed.path or "").lower() and next_parsed.hostname:
                            return next_canon
            elif resolved_host:
                return resolved_canon
    except Exception as exc:
        logger.debug("Short/share redirect resolve skipped for %s: %s", redact_secrets_in_text(canon_url), redact_secrets_in_text(exc))
    return canon_url


def _is_safe_http_literal(url: str) -> bool:
    """Fast non-blocking URL safety check rejecting non-http(s), localhost, userinfo, and private IP literals."""
    return sanitize_external_url(url) is not None


def _parse_dim_int(raw_val: Optional[str]) -> Optional[int]:
    if not raw_val:
        return None
    cleaned = raw_val.strip().lower()
    if not cleaned or cleaned.endswith("%") or cleaned == "auto":
        return None
    if cleaned.endswith("px"):
        cleaned = cleaned[:-2].strip()
    try:
        return int(float(cleaned))
    except ValueError:
        return None


def _is_cropped_meta_image_url(url: str) -> bool:
    return bool(url and (_META_CROPPED_STP_RE.search(url) or _META_DOWNSCALED_RE.search(url)))


def _image_asset_dedup_key(url: str) -> Tuple[str, str]:
    """Build an asset-level identity key collapsing same-photo CDN edge/crop URLs while preserving distinct photos."""
    base_exact = url.split("#", 1)[0]
    try:
        parsed = urllib.parse.urlparse(base_exact)
    except Exception:
        return ("exact", base_exact)

    host = (parsed.hostname or "").lower()
    path = parsed.path or ""
    basename = path.rsplit("/", 1)[-1]

    if _host_matches(host, ("fbcdn.net", "cdninstagram.com")) or "/v/t" in path:
        if _META_ASSET_FILENAME_RE.match(basename) or len(basename) >= 28:
            return ("meta_asset", basename.lower())

    if _host_matches(host, ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "muscdn.com")):
        m_tt = _TIKTOK_ASSET_ID_RE.search(path)
        if m_tt:
            return ("tiktok_asset", m_tt.group(1))

    if host == "pbs.twimg.com" and path.startswith("/media/"):
        tw_id = basename.split(".", 1)[0]
        if tw_id:
            return ("twimg_asset", tw_id.lower())

    if host in ("preview.redd.it", "i.redd.it"):
        return ("reddit_asset", path.lower())

    if host in ("i.ytimg.com", "img.youtube.com", "i9.ytimg.com"):
        m_yt = re.match(r"^/vi(?:_webp)?/([A-Za-z0-9_-]{11})/", path)
        if m_yt:
            return ("yt_thumb", m_yt.group(1))

    if host in ("yt3.ggpht.com", "yt3.googleusercontent.com", "yt4.ggpht.com"):
        base_asset = path.split("=", 1)[0]
        if base_asset and len(base_asset) > 8:
            return ("yt_ggpht", base_asset)

    return ("exact", base_exact)


def _image_quality_rank(
    url: str,
    w_hint: Optional[int] = None,
    h_hint: Optional[int] = None,
) -> Tuple[int, int]:
    """Rank higher when image is uncropped and higher resolution."""
    uncropped_tier = 2
    if _META_CROPPED_STP_RE.search(url):
        uncropped_tier = 0
    elif _META_DOWNSCALED_RE.search(url) or "lookaside.fbsbx.com" in url.lower():
        uncropped_tier = 1

    res_score = (w_hint or 0) + (h_hint or 0)
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
        path_lower = (parsed.path or "").lower()
        if host in ("i.ytimg.com", "img.youtube.com", "i9.ytimg.com"):
            for yt_tok, yt_score in (
                ("maxresdefault", 2560),
                ("hq720", 1440),
                ("sddefault", 1280),
                ("hqdefault", 960),
                ("mqdefault", 640),
            ):
                if yt_tok in path_lower:
                    res_score = max(res_score, yt_score)
                    break
        q_w, q_h = _extract_query_dim_hints(parsed)
        if q_w or q_h:
            res_score = max(res_score, (q_w or 0) + (q_h or 0))
        q_lower = (parsed.query or "").lower()
        if "name=orig" in q_lower:
            res_score = max(res_score, 4096)
        elif "name=large" in q_lower:
            res_score = max(res_score, 2048)
        m_s = re.search(r"_[sp](\d{3,4})x(\d{3,4})", url, re.I)
        if m_s:
            res_score = max(res_score, int(m_s.group(1)) + int(m_s.group(2)))
        elif host in ("yt3.ggpht.com", "yt3.googleusercontent.com", "yt4.ggpht.com"):
            m_yt_s = re.search(r"=s(\d{3,4})\b", url)
            if m_yt_s:
                res_score = max(res_score, int(m_yt_s.group(1)) * 2)
        elif uncropped_tier == 2 and res_score == 0:
            res_score = 1200
    except Exception:
        pass
    return (uncropped_tier, res_score)


def _pick_best_srcset_url(raw_srcset: Optional[str]) -> Optional[str]:
    """Return highest-resolution uncropped candidate URL from an HTML srcset attribute."""
    if not raw_srcset or not isinstance(raw_srcset, str):
        return None
    best_url: Optional[str] = None
    best_rank: Tuple[int, float] = (-1, -1.0)
    for idx, part in enumerate(re.split(r",\s*(?=(?:https?:|//|/))", raw_srcset.strip())):
        tokens = part.strip().split()
        if not tokens:
            continue
        url_cand = tokens[0].rstrip(",")
        if not url_cand:
            continue
        score = float(idx)
        if len(tokens) > 1:
            desc = tokens[-1].lower().rstrip(",")
            if desc.endswith("w") and desc[:-1].isdigit():
                score = float(desc[:-1])
            elif desc.endswith("x"):
                try:
                    score = float(desc[:-1]) * 1000.0
                except ValueError:
                    pass
        uncropped = 0 if _META_CROPPED_STP_RE.search(url_cand) else 1
        cand_rank = (uncropped, score)
        if cand_rank > best_rank:
            best_rank = cand_rank
            best_url = url_cand
    if not best_url:
        parts = [p.strip() for p in raw_srcset.split(",") if p.strip()]
        if parts:
            best_url = parts[-1].split()[0]
    return best_url


def _extract_query_dim_hints(parsed: urllib.parse.ParseResult) -> Tuple[Optional[int], Optional[int]]:
    params = urllib.parse.parse_qs(parsed.query)
    width = None
    height = None
    for w_key in ("w", "width"):
        if w_key in params and params[w_key]:
            width = _parse_dim_int(params[w_key][0])
            if width is not None:
                break
    for h_key in ("h", "height"):
        if h_key in params and params[h_key]:
            height = _parse_dim_int(params[h_key][0])
            if height is not None:
                break
    return width, height


def is_junk_image_url(
    candidate_url: str,
    width_hint: Optional[int] = None,
    height_hint: Optional[int] = None,
    *,
    allow_profile_avatars: bool = False,
) -> bool:
    """Return True if candidate image is SVG, tracker pixel, icon/avatar/logo/banner/ads/emoji, or <200px."""
    if not candidate_url or not _is_safe_http_literal(candidate_url):
        return True

    parsed = urllib.parse.urlparse(candidate_url)
    path_lower = (parsed.path or "").lower()
    query_lower = (parsed.query or "").lower()
    full_lower = f"{path_lower}?{query_lower}"

    if path_lower.endswith((".svg", ".svgz")) or "format=svg" in query_lower or "fm=svg" in query_lower:
        return True

    if any(tok in full_lower for tok in _JUNK_SUBSTRINGS):
        return True

    seg_match = _JUNK_SEGMENT_RE.search(path_lower)
    if seg_match and not (allow_profile_avatars and seg_match.group(1).lower() in ("avatar", "avatars")):
        return True

    q_w, q_h = _extract_query_dim_hints(parsed)
    eff_w = width_hint if width_hint is not None else q_w
    eff_h = height_hint if height_hint is not None else q_h

    if eff_w is not None and eff_w < MIN_IMAGE_DIM_PX:
        return True
    if eff_h is not None and eff_h < MIN_IMAGE_DIM_PX:
        return True

    return False


def filter_and_cap_images(
    candidates: List[Any],
    base_url: str = "",
    max_images: int = MAX_MEDIA_ITEMS,
    *,
    allow_profile_avatars: bool = False,
) -> List[str]:
    """Filter junk/duplicate/unsafe image candidates, upgrade same-asset variants to uncropped HD, and enforce <= max_images."""
    results: List[str] = []
    seen_pos_by_key: Dict[Tuple[str, str], Tuple[int, Tuple[int, int]]] = {}

    for entry in candidates:
        if isinstance(entry, tuple):
            raw_url = entry[0]
            w_hint = entry[1] if len(entry) > 1 else None
            h_hint = entry[2] if len(entry) > 2 else None
        else:
            raw_url = entry
            w_hint = None
            h_hint = None

        if not raw_url or not isinstance(raw_url, str):
            continue

        cleaned = html_lib.unescape(raw_url).strip()
        if not cleaned or cleaned.lower().startswith(("data:", "javascript:", "vbscript:", "blob:")):
            continue

        resolved = urllib.parse.urljoin(base_url, cleaned) if base_url else cleaned
        if is_junk_image_url(
            resolved,
            width_hint=w_hint,
            height_hint=h_hint,
            allow_profile_avatars=allow_profile_avatars,
        ):
            continue

        dedup_key = _image_asset_dedup_key(resolved)
        qual_rank = _image_quality_rank(resolved, w_hint=w_hint, h_hint=h_hint)
        existing = seen_pos_by_key.get(dedup_key)
        if existing is not None:
            pos, prev_rank = existing
            if dedup_key[0] != "exact" and qual_rank > prev_rank:
                results[pos] = resolved
                seen_pos_by_key[dedup_key] = (pos, qual_rank)
            continue

        if len(results) >= max_images:
            continue

        pos = len(results)
        results.append(resolved)
        seen_pos_by_key[dedup_key] = (pos, qual_rank)

    return results


async def _fetch_limited_response(
    url: str,
    max_bytes: int = MAX_HTML_BYTES,
    *,
    force_meta_crawler_ua: bool = False,
) -> Tuple[int, str, bytes, str]:
    """Stream-fetch URL with SSRF redirect guard, 8s timeout, and <=3MB body cap."""
    return await stream_fetch_limited(
        url,
        max_bytes=max_bytes,
        reject_on_oversize=False,
        timeout_sec=DEFAULT_TIMEOUT_SEC,
        force_meta_crawler_ua=force_meta_crawler_ua,
    )


async def _fetch_json_safely(url: str) -> Optional[Any]:
    """Fetch JSON from an allowlisted/SSRF-checked public API endpoint."""
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC, follow_redirects=False) as client:
            resp = await _fetch_url_safely(client, url)
            if resp.status_code == 200:
                return resp.json()
    except Exception as exc:
        logger.debug(
            "JSON fetch failed for %s: %s",
            redact_secrets_in_text(url),
            redact_secrets_in_text(exc),
        )
    return None


def _extract_meta_content(tree: Any, attr_name: str, attr_val: str) -> Optional[str]:
    node = tree.css_first(f'meta[{attr_name}="{attr_val}"]')
    if node is None:
        node = tree.css_first(f'meta[{attr_name}="{attr_val.lower()}"]')
    if node is None:
        return None
    val = node.attributes.get("content")
    return clean_text_field(val, unescape_html=True) if val else None


def _scrub_generic_platform_title(
    title: Optional[str],
    final_url: str,
    platform: str = "",
) -> Optional[str]:
    if not title:
        return None
    stripped = title.strip()
    if is_generic_or_noisy_title(stripped, platform, final_url):
        plat_lower = (platform or "").lower()
        parsed_final_host = (urllib.parse.urlparse(final_url).hostname or "").lower()
        # Strip notification count prefix & platform suffix if a real title remains (e.g. "(584) Match - YouTube")
        cleaned = _NOTIFICATION_PREFIX_RE.sub("", stripped).strip()
        if plat_lower == "youtube" or _host_matches(parsed_final_host, ("youtube.com", "youtu.be")) or _YOUTUBE_ID_RE.search(final_url):
            cleaned = re.sub(r"\s*[-–|]\s*YouTube\s*$", "", cleaned, flags=re.I).strip()
        elif plat_lower == "x" or _host_matches(parsed_final_host, ("x.com", "twitter.com")):
            cleaned = re.sub(r"\s*/\s*(?:X|Twitter)\s*$", "", cleaned, flags=re.I).strip()
        elif plat_lower == "tiktok" or _host_matches(parsed_final_host, ("tiktok.com",)):
            cleaned = re.sub(r"\s*\|\s*TikTok\s*$", "", cleaned, flags=re.I).strip()
        elif plat_lower == "facebook" or _host_matches(parsed_final_host, ("facebook.com", "fb.watch")):
            cleaned = re.sub(r"\s*\|\s*Facebook\s*$", "", cleaned, flags=re.I).strip()
        if not cleaned or is_generic_or_noisy_title(cleaned, platform, final_url):
            return None
        return cleaned
    return stripped


def _find_json_key(obj: Any, target: str) -> Any:
    """Recursively locate the first matching dictionary key in parsed JSON."""
    if isinstance(obj, dict):
        if target in obj:
            return obj[target]
        for val in obj.values():
            found = _find_json_key(val, target)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_json_key(item, target)
            if found is not None:
                return found
    return None


def _pick_largest_yt_thumbnail(thumbs: Any) -> Optional[str]:
    if not isinstance(thumbs, list) or not thumbs:
        return None
    best_url: Optional[str] = None
    best_area = -1
    for entry in thumbs:
        if not isinstance(entry, dict):
            continue
        u = entry.get("url")
        if not isinstance(u, str) or not u.strip():
            continue
        area = int(entry.get("width") or 0) * int(entry.get("height") or 0)
        if area >= best_area:
            best_area = area
            best_url = u.strip()
    return best_url


def _extract_youtube_backstage_post(html_text: str) -> Dict[str, Any]:
    """Extract author, full post text, all attached images, and optional videoId from YouTube ytInitialData."""
    m = re.search(r'(?:var\s+ytInitialData|window\[["\']ytInitialData["\']\])\s*=\s*\{', html_text or "")
    if not m:
        return {}
    try:
        data, _ = json.JSONDecoder().raw_decode(html_text, m.end() - 1)
    except Exception as exc:
        logger.debug("YouTube ytInitialData JSON decode skipped: %s", exc)
        return {}

    bpr = _find_json_key(data, "backstagePostRenderer")
    if not isinstance(bpr, dict):
        return {}

    author_runs = (bpr.get("authorText") or {}).get("runs") or []
    author = clean_text_field("".join(str(r.get("text") or "") for r in author_runs if isinstance(r, dict)), unescape_html=True)

    content_runs = (bpr.get("contentText") or {}).get("runs") or []
    content_text = clean_text_field("".join(str(r.get("text") or "") for r in content_runs if isinstance(r, dict)), unescape_html=True)

    images: List[str] = []
    attached_video_id: Optional[str] = None
    att = bpr.get("backstageAttachment") or {}
    if isinstance(att, dict):
        pmi = att.get("postMultiImageRenderer") or {}
        for img_entry in pmi.get("images") or []:
            thumbs = ((img_entry.get("backstageImageRenderer") or {}).get("image") or {}).get("thumbnails")
            best = _pick_largest_yt_thumbnail(thumbs)
            if best:
                images.append(best)
        if not images and isinstance(att.get("backstageImageRenderer"), dict):
            thumbs = ((att["backstageImageRenderer"].get("image") or {}).get("thumbnails"))
            best = _pick_largest_yt_thumbnail(thumbs)
            if best:
                images.append(best)
        vid_ren = att.get("videoRenderer") or {}
        if isinstance(vid_ren, dict) and isinstance(vid_ren.get("videoId"), str):
            attached_video_id = vid_ren["videoId"].strip() or None
            if not images:
                best = _pick_largest_yt_thumbnail((vid_ren.get("thumbnail") or {}).get("thumbnails"))
                if best:
                    images.append(best)
        shared = att.get("sharedPostRenderer") or {}
        if isinstance(shared, dict) and not content_text:
            shared_runs = (shared.get("content") or {}).get("runs") or []
            content_text = clean_text_field("".join(str(r.get("text") or "") for r in shared_runs if isinstance(r, dict)), unescape_html=True)

    return {
        "author": author,
        "text": content_text,
        "images": images,
        "attached_video_id": attached_video_id,
    }


def _parse_html_metadata(
    html_text: str,
    final_url: str,
    *,
    allow_profile_avatars: bool = False,
) -> Dict[str, Any]:
    """Extract title, description, site_name, favicon, content_type, and <=5 images via selectolax."""
    title: Optional[str] = None
    description: Optional[str] = None
    site_name: Optional[str] = None
    favicon_url: Optional[str] = None
    og_url: Optional[str] = None
    content_type: str = "link"
    attached_video_id: Optional[str] = None
    has_structured_media: bool = False
    image_candidates: List[Tuple[str, Optional[int], Optional[int]]] = []

    if HTMLParser is not None and html_text:
        tree = HTMLParser(html_text)

        title = (
            _extract_meta_content(tree, "property", "og:title")
            or _extract_meta_content(tree, "name", "twitter:title")
        )
        if not title:
            title_node = tree.css_first("title")
            if title_node is not None:
                title = clean_text_field(title_node.text(strip=True), unescape_html=True)
        if not title:
            h1_node = tree.css_first("h1")
            if h1_node is not None:
                title = clean_text_field(h1_node.text(strip=True), unescape_html=True)

        parsed_final_host = (urllib.parse.urlparse(final_url).hostname or "").lower()
        title = _scrub_generic_platform_title(title, final_url)
        og_url = sanitize_external_url(_extract_meta_content(tree, "property", "og:url"))

        description = (
            _extract_meta_content(tree, "property", "og:description")
            or _extract_meta_content(tree, "name", "twitter:description")
            or _extract_meta_content(tree, "name", "description")
        )
        if html_text and _YOUTUBE_ID_RE.search(final_url):
            yt_desc_candidates: List[str] = []
            for yt_pat in (
                r'"shortDescription"\s*:\s*"((?:\\.|[^"\\])+)"',
                r'"attributedDescriptionBodyText"\s*:\s*\{\s*"content"\s*:\s*"((?:\\.|[^"\\])+)"',
                r'"attributedDescription"\s*:\s*\{\s*"content"\s*:\s*"((?:\\.|[^"\\])+)"',
                r'"playerMicroformatRenderer"\s*:\s*\{[^{}]{0,600}"description"\s*:\s*\{\s*"simpleText"\s*:\s*"((?:\\.|[^"\\])+)"',
            ):
                sd_match = re.search(yt_pat, html_text)
                if sd_match:
                    try:
                        decoded_sd = json.loads(f'"{sd_match.group(1)}"')
                        cleaned_sd = clean_text_field(decoded_sd, unescape_html=True)
                        if cleaned_sd and not cleaned_sd.lower().startswith("enjoy the videos and music you love"):
                            yt_desc_candidates.append(cleaned_sd)
                    except Exception as exc:
                        logger.debug("YouTube description JSON decode skipped: %s", exc)
            if yt_desc_candidates:
                best_yt_desc = max(yt_desc_candidates, key=len)
                if not description or description.lower().startswith("enjoy the videos and music you love") or len(best_yt_desc) > len(description):
                    description = best_yt_desc[:4000]

        if html_text and _is_youtube_post_url(final_url):
            yt_post = _extract_youtube_backstage_post(html_text)
            post_text = yt_post.get("text")
            post_author = yt_post.get("author")
            post_images = yt_post.get("images") or []
            attached_video_id = yt_post.get("attached_video_id")
            if post_text:
                description = post_text
                short_post_title = _extract_short_opening_title(post_text)
                if short_post_title:
                    title = short_post_title
            elif post_author and not title:
                title = post_author
            for p_img in post_images[:MAX_MEDIA_ITEMS]:
                image_candidates.append((p_img, None, None))
            if post_images:
                has_structured_media = True
            content_type = "video" if attached_video_id else "post"

        if html_text and _host_matches(parsed_final_host, ("tiktok.com",)):
            uni_match = re.search(
                r'<script[^>]+id=["\']__UNIVERSAL_DATA_FOR_REHYDRATION__["\'][^>]*>(.*?)</script>',
                html_text,
                re.S | re.I,
            )
            if uni_match:
                try:
                    uni_data = json.loads(uni_match.group(1))
                    scope = uni_data.get("__DEFAULT_SCOPE__", {})
                    detail = (
                        scope.get("webapp.video-detail", {}).get("itemInfo", {}).get("itemStruct")
                        or scope.get("webapp.photo-detail", {}).get("itemInfo", {}).get("itemStruct")
                        or {}
                    )
                    if isinstance(detail, dict) and detail:
                        img_post = detail.get("imagePost") or {}
                        tt_photo_title = clean_text_field(img_post.get("title"), unescape_html=True)
                        tt_desc = clean_text_field(detail.get("desc"), unescape_html=True)
                        if tt_photo_title and tt_desc and tt_photo_title not in tt_desc:
                            tt_caption = f"{tt_photo_title}\n{tt_desc}"
                        else:
                            tt_caption = tt_photo_title or tt_desc
                        author_obj = detail.get("author") or {}
                        tt_uid = clean_text_field(author_obj.get("uniqueId"), unescape_html=True)
                        tt_nick = clean_text_field(author_obj.get("nickname"), unescape_html=True)
                        author_label = tt_nick or (f"@{tt_uid}" if tt_uid else None)

                        title_is_weak = bool(
                            not title
                            or is_generic_or_noisy_title(title, "tiktok", final_url)
                            or (author_label and title.strip().lower() == author_label.strip().lower())
                        )
                        if title_is_weak:
                            if tt_photo_title:
                                title = tt_photo_title
                            elif author_label and tt_desc:
                                title = f"{author_label}: {tt_desc[:90]}"
                            else:
                                title = tt_desc or author_label

                        desc_is_weak = bool(
                            not description
                            or _TT_META_DESC_RE.match(description)
                            or (tt_caption and len(tt_caption) > len(description))
                        )
                        if desc_is_weak and (tt_caption or tt_uid):
                            if tt_uid and tt_caption:
                                description = f"@{tt_uid} — {tt_caption}"
                            else:
                                description = tt_caption or (f"@{tt_uid}" if tt_uid else None)

                        img_entries = img_post.get("images") or []
                        if img_entries:
                            for img_entry in img_entries[:MAX_MEDIA_ITEMS]:
                                url_list = (img_entry.get("imageURL") or {}).get("urlList") or []
                                if url_list and isinstance(url_list[0], str):
                                    image_candidates.append((url_list[0].strip(), None, None))
                            has_structured_media = True
                        else:
                            video_obj = detail.get("video") or {}
                            for cov_key in ("originCover", "cover", "dynamicCover"):
                                cov_url = video_obj.get(cov_key)
                                if isinstance(cov_url, str) and cov_url.strip():
                                    image_candidates.append((cov_url.strip(), None, None))
                                    break
                    else:
                        user_obj = (scope.get("webapp.user-detail") or {}).get("userInfo", {}).get("user") or {}
                        if isinstance(user_obj, dict) and user_obj:
                            u_uid = clean_text_field(user_obj.get("uniqueId"), unescape_html=True)
                            u_nick = clean_text_field(user_obj.get("nickname"), unescape_html=True)
                            u_sig = clean_text_field(user_obj.get("signature"), unescape_html=True)
                            u_avatar = user_obj.get("avatarLarger") or user_obj.get("avatarMedium")
                            combined_user = _combine_author_labels(u_nick, f"@{u_uid}" if u_uid else None)
                            if combined_user:
                                title = combined_user
                            if u_sig:
                                description = u_sig
                            elif combined_user:
                                description = f"ช่อง TikTok {combined_user}"
                            if isinstance(u_avatar, str) and u_avatar.strip():
                                image_candidates.append((u_avatar.strip(), None, None))
                                has_structured_media = True
                except Exception as exc:
                    logger.debug("TikTok universal data parse skipped: %s", exc)

        if html_text and _host_matches(parsed_final_host, ("facebook.com",)) and not allow_profile_avatars:
            fb_comet_msgs: List[str] = []
            for m_msg in re.finditer(r'"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])+)"', html_text):
                try:
                    decoded_msg = json.loads(f'"{m_msg.group(1)}"')
                    cleaned_msg = clean_text_field(decoded_msg, unescape_html=True)
                    if cleaned_msg:
                        fb_comet_msgs.append(cleaned_msg)
                except Exception:
                    pass
            if fb_comet_msgs:
                best_fb_msg = max(fb_comet_msgs, key=len)
                if (
                    not description
                    or description.rstrip().endswith(("...", "…"))
                    or len(best_fb_msg) > len(description)
                ):
                    description = best_fb_msg

            fb_comet_paths = set()
            for fb_img_pat in (
                r'"viewer_image"\s*:\s*\{[^}]*"uri"\s*:\s*"(https:\\/\\/scontent[^"]+)"',
                r'"photo_image"\s*:\s*\{[^}]*"uri"\s*:\s*"(https:\\/\\/scontent[^"]+)"',
            ):
                for m_img in re.finditer(fb_img_pat, html_text):
                    try:
                        decoded_img = json.loads(f'"{m_img.group(1)}"').strip()
                        if decoded_img and not _FB_PROFILE_THUMB_RE.search(decoded_img):
                            img_path = urllib.parse.urlparse(decoded_img).path
                            if img_path not in fb_comet_paths:
                                fb_comet_paths.add(img_path)
                                image_candidates.append((decoded_img, None, None))
                    except Exception:
                        pass

        site_name = _extract_meta_content(tree, "property", "og:site_name")
        og_type = (_extract_meta_content(tree, "property", "og:type") or "").lower()
        if og_type.startswith("video"):
            content_type = "video"
        elif "product" in og_type:
            content_type = "product"
        elif "article" in og_type or tree.css_first("article") is not None:
            content_type = "article"

        for link_sel in ('link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]', 'link[rel~="icon"]'):
            icon_node = tree.css_first(link_sel)
            if icon_node is not None and icon_node.attributes.get("href"):
                resolved_icon = urllib.parse.urljoin(final_url, icon_node.attributes["href"].strip())
                if _is_safe_http_literal(resolved_icon):
                    favicon_url = resolved_icon
                    break

        if not has_structured_media:
            existing_scontent_paths = {
                urllib.parse.urlparse(u).path
                for u, _, _ in image_candidates
                if "scontent" in u
            }
            for meta_attr, meta_key in (
                ("property", "og:image:secure_url"),
                ("property", "og:image"),
                ("name", "twitter:image"),
                ("name", "twitter:image:src"),
            ):
                for meta_node in tree.css(f'meta[{meta_attr}="{meta_key}"], meta[{meta_attr}="{meta_key.lower()}"]'):
                    raw_val = meta_node.attributes.get("content")
                    img_meta = clean_text_field(raw_val, unescape_html=True) if raw_val else None
                    if img_meta:
                        if "scontent" in img_meta and urllib.parse.urlparse(img_meta).path in existing_scontent_paths:
                            continue
                        image_candidates.append((img_meta, None, None))

        # Collect content images from <article>/<main> first, then fallback <body>
        # Skip for social profiles/channels & YT community posts/structured carousels to avoid feed/sidebar pollution.
        if not allow_profile_avatars and not has_structured_media and not _is_youtube_post_url(final_url):
            seen_nodes = set()
            img_nodes = list(tree.css("article img, main img, [role='main'] img"))
            for node in tree.css("body img"):
                if node not in img_nodes:
                    img_nodes.append(node)

            for img_node in img_nodes:
                node_key = getattr(img_node, "mem_id", id(img_node))
                if node_key in seen_nodes:
                    continue
                seen_nodes.add(node_key)

                # Skip images inside nav/header/footer chrome
                parent = img_node.parent
                in_chrome = False
                while parent is not None:
                    if parent.tag in ("nav", "footer", "header"):
                        in_chrome = True
                        break
                    parent = parent.parent
                if in_chrome:
                    continue

                attrs = img_node.attributes
                best_srcset = _pick_best_srcset_url(attrs.get("srcset") or attrs.get("data-srcset"))
                src = (
                    best_srcset
                    or attrs.get("data-original")
                    or attrs.get("data-src")
                    or attrs.get("data-lazy-src")
                    or attrs.get("src")
                )
                if not src:
                    continue

                w_hint = _parse_dim_int(attrs.get("width"))
                h_hint = _parse_dim_int(attrs.get("height"))
                image_candidates.append((src, w_hint, h_hint))

        if not description:
            for p_node in tree.css("article p, main p, p"):
                txt = clean_text_field(p_node.text(strip=True), unescape_html=True)
                if txt and len(txt) >= 24:
                    description = txt[:500]
                    break

    if (not title or not description) and trafilatura is not None and html_text:
        try:
            meta = trafilatura.extract_metadata(html_text)
            if meta is not None:
                if not title and getattr(meta, "title", None):
                    title = _scrub_generic_platform_title(
                        clean_text_field(meta.title, unescape_html=True),
                        final_url,
                    )
                if not description and getattr(meta, "description", None):
                    description = clean_text_field(meta.description, unescape_html=True)
                if not site_name and getattr(meta, "sitename", None):
                    site_name = clean_text_field(meta.sitename, unescape_html=True)
        except Exception as exc:
            logger.debug("Trafilatura metadata fallback failed for %s: %s", final_url, exc)

    if not site_name:
        site_name = (urllib.parse.urlparse(final_url).hostname or "").lower() or None

    media_items = filter_and_cap_images(
        image_candidates,
        base_url=final_url,
        max_images=MAX_MEDIA_ITEMS,
        allow_profile_avatars=allow_profile_avatars,
    )
    return {
        "title": title,
        "description": description,
        "site_name": site_name,
        "favicon_url": favicon_url,
        "og_url": og_url,
        "content_type": content_type,
        "media_items": media_items,
        "attached_video_id": attached_video_id,
    }


async def _fetch_generic_html_meta(
    url: str,
    *,
    allow_profile_avatars: bool = False,
    force_meta_crawler_ua: bool = False,
) -> Dict[str, Any]:
    status_code, content_type, raw_bytes, final_url = await _fetch_limited_response(
        url,
        force_meta_crawler_ua=force_meta_crawler_ua,
    )
    if status_code >= 300:
        raise ValueError(f"HTTP {status_code} fetching '{url}'.")

    ct_lower = content_type.split(";")[0].strip().lower()
    if ct_lower.startswith("image/"):
        images = filter_and_cap_images(
            [(final_url, None, None)],
            base_url=final_url,
            allow_profile_avatars=allow_profile_avatars,
        )
        return {
            "title": urllib.parse.urlparse(final_url).path.rsplit("/", 1)[-1] or final_url,
            "description": None,
            "site_name": (urllib.parse.urlparse(final_url).hostname or "").lower() or None,
            "favicon_url": None,
            "content_type": "link",
            "media_items": images,
            "final_url": final_url,
        }

    html_text = decode_html_bytes(raw_bytes, content_type=content_type)
    parsed = _parse_html_metadata(
        html_text,
        final_url,
        allow_profile_avatars=allow_profile_avatars,
    )
    parsed["final_url"] = final_url
    return parsed


def _detect_platform(hostname: str) -> str:
    if _host_matches(hostname, ("youtube.com", "youtu.be")):
        return "youtube"
    if _host_matches(hostname, ("tiktok.com",)):
        return "tiktok"
    if _host_matches(hostname, ("vimeo.com",)):
        return "vimeo"
    if _host_matches(hostname, ("spotify.com",)):
        return "spotify"
    if _host_matches(hostname, ("reddit.com", "redd.it")):
        return "reddit"
    if _host_matches(hostname, ("x.com", "twitter.com")):
        return "x"
    if _host_matches(hostname, ("instagram.com",)):
        return "instagram"
    if _host_matches(hostname, ("facebook.com", "fb.watch")):
        return "facebook"
    return "web"


async def _extract_youtube(
    canon_url: str,
    url_hash: str,
    *,
    fetch_full_description: bool = False,
) -> UnfurlResult:
    is_community_post = _is_youtube_post_url(canon_url)
    is_channel = _is_youtube_channel_url(canon_url)
    if is_community_post or is_channel:
        html_meta = await _fetch_generic_html_meta(
            canon_url,
            allow_profile_avatars=is_channel,
        )
        title = html_meta.get("title")
        description = clean_text_field(html_meta.get("description"), unescape_html=True)
        images: List[Any] = list(html_meta.get("media_items") or [])
        attached_video_id = html_meta.get("attached_video_id") if is_community_post else None
        embed_url = (
            validate_embed_url("youtube", f"https://www.youtube.com/embed/{attached_video_id}")
            if attached_video_id
            else None
        )
        content_type = "video" if attached_video_id else ("post" if is_community_post else "link")
        return UnfurlResult(
            url=canon_url,
            canonical_url=canon_url,
            url_hash=url_hash,
            title=title or canon_url,
            description=description,
            media_items=images,
            embed_type="youtube" if embed_url else "none",
            embed_url=embed_url,
            site_name="YouTube",
            favicon_url="https://www.youtube.com/favicon.ico",
            content_type=content_type,
            platform="youtube",
            allow_profile_avatars=is_channel,
        ).finalized()

    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://www.youtube.com/oembed?url={encoded}&format=json")
    if not isinstance(oembed, dict):
        oembed = await _fetch_json_safely(f"https://noembed.com/embed?url={encoded}")
    match = _YOUTUBE_ID_RE.search(canon_url)
    video_id = match.group(1) if match else None

    embed_url = None
    if isinstance(oembed, dict):
        embed_url = extract_safe_iframe_src(oembed.get("html"), "youtube")
    if not embed_url and video_id:
        embed_url = validate_embed_url("youtube", f"https://www.youtube.com/embed/{video_id}")

    images = []
    title = None
    description = None
    author = None
    if isinstance(oembed, dict):
        title = oembed.get("title")
        author = clean_text_field(oembed.get("author_name"), unescape_html=True)
        description = f"By {author}" if author else None
        if oembed.get("thumbnail_url"):
            images.append(oembed["thumbnail_url"])

    if video_id:
        images.append(f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")

    has_core_oembed = bool(title and images and embed_url)
    needs_html_meta = (
        not has_core_oembed
        or (
            fetch_full_description
            and (not description or (author and description == f"By {author}"))
        )
    )
    if needs_html_meta:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            html_desc = clean_text_field(html_meta.get("description"), unescape_html=True)
            if (
                html_desc
                and not html_desc.lower().startswith("enjoy the videos and music you love")
                and html_desc != (clean_text_field(title, unescape_html=True) or "")
            ):
                description = html_desc
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed and not video_id:
                raise

    if not description:
        if author and title:
            description = f"วิดีโอ YouTube จากช่อง {author} — {title}"
        elif author:
            description = f"วิดีโอ YouTube จากช่อง {author}"
        elif title:
            description = f"วิดีโอ YouTube — {title}"

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type="youtube" if embed_url else "none",
        embed_url=embed_url,
        site_name="YouTube",
        favicon_url="https://www.youtube.com/favicon.ico",
        content_type="video",
        platform="youtube",
    ).finalized()


async def _extract_tiktok(
    canon_url: str,
    url_hash: str,
    *,
    fetch_full_description: bool = False,
) -> UnfurlResult:
    is_photo_post = "/photo/" in canon_url.lower()
    is_profile = _is_tiktok_profile_url(canon_url)
    encoded = urllib.parse.quote(canon_url, safe="")
    # TikTok's /oembed endpoint returns HTTP 400 on /photo/ carousel URLs, so skip it there.
    oembed = None if is_photo_post else await _fetch_json_safely(f"https://www.tiktok.com/oembed?url={encoded}")
    id_match = _TIKTOK_ID_RE.search(canon_url)
    video_id = id_match.group(1) if id_match else None

    embed_url = None
    title = None
    description = None
    author = None
    images: List[Any] = []
    if isinstance(oembed, dict):
        is_oembed_profile = str(oembed.get("embed_type") or "").lower() == "profile"
        if is_profile or is_oembed_profile:
            is_profile = True
            author = clean_text_field(oembed.get("author_name"), unescape_html=True)
            handle = _extract_author_from_social_url(canon_url, "tiktok")
            title = _combine_author_labels(author, handle) or author or handle
            description = f"ช่อง TikTok {handle}" if handle else None
            if oembed.get("thumbnail_url"):
                images.append(oembed["thumbnail_url"])
        else:
            title = _scrub_generic_platform_title(oembed.get("title"), canon_url, platform="tiktok")
            author = clean_text_field(oembed.get("author_name"), unescape_html=True)
            description = f"@{author}" if author else None
            if oembed.get("thumbnail_url"):
                images.append(oembed["thumbnail_url"])
            embed_url = extract_safe_iframe_src(oembed.get("html"), "tiktok")
            if not video_id and isinstance(oembed.get("html"), str):
                vid_m = re.search(
                    r'(?:data-video-id="|/(?:player/v1|embed/v2|video)/)(\d+)',
                    oembed["html"],
                )
                if vid_m:
                    video_id = vid_m.group(1)

    if not is_photo_post and not is_profile and not embed_url and video_id:
        embed_url = validate_embed_url("tiktok", f"https://www.tiktok.com/embed/v2/{video_id}")
    if is_photo_post or is_profile:
        embed_url = None

    has_core_oembed = bool(title and images and embed_url)
    needs_html_meta = (
        not has_core_oembed
        or is_photo_post
        or is_profile
        or (
            fetch_full_description
            and (not description or (author and description == f"@{author}"))
        )
    )
    if needs_html_meta:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url, allow_profile_avatars=is_profile)
            html_title = html_meta.get("title")
            if html_title and (not title or is_profile or is_generic_or_noisy_title(title, "tiktok", canon_url)):
                title = html_title
            html_desc = clean_text_field(html_meta.get("description"), unescape_html=True)
            if html_desc and html_desc != (clean_text_field(title, unescape_html=True) or ""):
                if not description or is_profile or description.startswith(("@", "ช่อง TikTok ")):
                    description = html_desc
            html_imgs = html_meta.get("media_items") or []
            if (is_photo_post or is_profile) and html_imgs:
                images = list(html_imgs)
            elif not images and html_imgs:
                images = [html_imgs[0]]
        except Exception:
            if not oembed:
                raise

    content_type = "post" if is_photo_post else ("link" if is_profile else "video")
    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type="tiktok" if embed_url else "none",
        embed_url=embed_url,
        site_name="TikTok",
        favicon_url="https://www.tiktok.com/favicon.ico",
        content_type=content_type,
        platform="tiktok",
        allow_profile_avatars=is_profile,
    ).finalized()


async def _extract_vimeo(canon_url: str, url_hash: str) -> UnfurlResult:
    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://vimeo.com/api/oembed.json?url={encoded}")
    id_match = _VIMEO_ID_RE.search(canon_url)
    video_id = id_match.group(1) if id_match else None

    embed_url = None
    title = None
    description = None
    images: List[Any] = []
    if isinstance(oembed, dict):
        title = oembed.get("title")
        description = oembed.get("description")
        if oembed.get("video_id"):
            video_id = str(oembed["video_id"])
        if oembed.get("thumbnail_url"):
            images.append(oembed["thumbnail_url"])
        embed_url = extract_safe_iframe_src(oembed.get("html"), "vimeo")

    if not embed_url and video_id:
        embed_url = validate_embed_url("vimeo", f"https://player.vimeo.com/video/{video_id}")

    if not title or not images:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            description = description or html_meta.get("description")
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed:
                raise

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type="vimeo" if embed_url else "none",
        embed_url=embed_url,
        site_name="Vimeo",
        favicon_url="https://vimeo.com/favicon.ico",
        content_type="video",
        platform="vimeo",
    ).finalized()


async def _extract_spotify(canon_url: str, url_hash: str) -> UnfurlResult:
    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://open.spotify.com/oembed?url={encoded}")
    sp_match = _SPOTIFY_RE.search(urllib.parse.urlparse(canon_url).path or "")

    embed_url = None
    title = None
    images: List[Any] = []
    if isinstance(oembed, dict):
        title = oembed.get("title")
        if oembed.get("thumbnail_url"):
            images.append(oembed["thumbnail_url"])
        embed_url = validate_embed_url("spotify", oembed.get("iframe_url")) or extract_safe_iframe_src(
            oembed.get("html"), "spotify"
        )

    if not embed_url and sp_match:
        embed_url = validate_embed_url(
            "spotify", f"https://open.spotify.com/embed/{sp_match.group(1)}/{sp_match.group(2)}"
        )

    if not title or not images:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed:
                raise

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=None,
        media_items=images,
        embed_type="spotify" if embed_url else "none",
        embed_url=embed_url,
        site_name="Spotify",
        favicon_url="https://open.spotify.com/favicon.ico",
        content_type="link",
        platform="spotify",
    ).finalized()


def _parse_reddit_post_images(post: Dict[str, Any]) -> List[str]:
    images: List[str] = []
    media_meta = post.get("media_metadata")
    gallery_data = post.get("gallery_data")

    if isinstance(media_meta, dict):
        ordered_ids: List[str] = []
        if isinstance(gallery_data, dict) and isinstance(gallery_data.get("items"), list):
            for entry in gallery_data["items"]:
                if isinstance(entry, dict) and entry.get("media_id"):
                    ordered_ids.append(str(entry["media_id"]))
        for key in media_meta.keys():
            if key not in ordered_ids:
                ordered_ids.append(key)

        for mid in ordered_ids:
            meta = media_meta.get(mid)
            if not isinstance(meta, dict):
                continue
            s_obj = meta.get("s")
            if isinstance(s_obj, dict) and s_obj.get("u"):
                images.append(html_lib.unescape(str(s_obj["u"])))
                continue
            p_list = meta.get("p")
            if isinstance(p_list, list) and p_list and isinstance(p_list[-1], dict) and p_list[-1].get("u"):
                images.append(html_lib.unescape(str(p_list[-1]["u"])))

    preview = post.get("preview")
    if isinstance(preview, dict) and isinstance(preview.get("images"), list):
        for img_item in preview["images"]:
            if isinstance(img_item, dict):
                src_u = (img_item.get("source") or {}).get("url")
                if src_u:
                    images.append(html_lib.unescape(str(src_u)))

    dest_url = post.get("url_overridden_by_dest") or post.get("url")
    if isinstance(dest_url, str) and (
        dest_url.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif"))
        or "i.redd.it/" in dest_url
        or "i.imgur.com/" in dest_url
    ):
        images.append(html_lib.unescape(dest_url))

    thumb = post.get("thumbnail")
    if isinstance(thumb, str) and thumb.startswith(("http://", "https://")):
        images.append(thumb)

    return images


async def _extract_reddit(canon_url: str, url_hash: str) -> UnfurlResult:
    parsed = urllib.parse.urlparse(canon_url)
    path = (parsed.path or "").rstrip("/")
    json_url = f"{parsed.scheme}://{parsed.netloc}{path}.json?raw_json=1" if not path.endswith(".json") else canon_url

    reddit_json = await _fetch_json_safely(json_url)
    post_data: Optional[Dict[str, Any]] = None
    if isinstance(reddit_json, list) and reddit_json:
        children = (((reddit_json[0] or {}).get("data") or {}).get("children") or [])
        if children and isinstance(children[0], dict):
            post_data = children[0].get("data")
    elif isinstance(reddit_json, dict):
        children = ((reddit_json.get("data") or {}).get("children") or [])
        if children and isinstance(children[0], dict):
            post_data = children[0].get("data")

    title = None
    description = None
    images: List[str] = []
    embed_url = None
    is_video = False

    if isinstance(post_data, dict):
        title = post_data.get("title")
        selftext = clean_text_field(post_data.get("selftext"), unescape_html=True)
        sub_prefix = clean_text_field(post_data.get("subreddit_name_prefixed"), unescape_html=True)
        description = selftext[:500] if selftext else sub_prefix
        images = _parse_reddit_post_images(post_data)
        is_video = bool(post_data.get("is_video"))
        permalink = post_data.get("permalink")
        if permalink and isinstance(permalink, str):
            embed_url = validate_embed_url(
                "reddit",
                f"https://www.redditmedia.com{permalink}?ref_source=embed&ref=share&embed=true",
            )

    if not post_data:
        encoded = urllib.parse.quote(canon_url, safe="")
        oembed = await _fetch_json_safely(f"https://www.reddit.com/oembed?url={encoded}")
        if isinstance(oembed, dict):
            title = oembed.get("title")
            embed_url = extract_safe_iframe_src(oembed.get("html"), "reddit")
        if not title:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = html_meta.get("title")
            description = html_meta.get("description")
            images = html_meta.get("media_items") or []

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type="reddit" if embed_url else "none",
        embed_url=embed_url,
        site_name="Reddit",
        favicon_url="https://www.reddit.com/favicon.ico",
        content_type="video" if is_video else "post",
        platform="reddit",
    ).finalized()


async def _extract_x(canon_url: str, url_hash: str) -> UnfurlResult:
    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://publish.twitter.com/oembed?url={encoded}&omit_script=1")
    tweet_match = _X_STATUS_RE.search(canon_url)
    tweet_id = tweet_match.group(1) if tweet_match else None

    title = None
    description = None
    images: List[str] = []
    if isinstance(oembed, dict):
        author = clean_text_field(oembed.get("author_name"), unescape_html=True)
        raw_html = oembed.get("html") or ""
        tweet_text = None
        if HTMLParser is not None and raw_html:
            tree = HTMLParser(raw_html)
            p_node = tree.css_first("blockquote p") or tree.css_first("p")
            if p_node is not None:
                tweet_text = clean_text_field(p_node.text(strip=True), unescape_html=True)
        description = tweet_text
        if author and tweet_text:
            title = f"{author}: {tweet_text[:100]}"
        elif author:
            title = author
        elif tweet_text:
            title = tweet_text[:100]

    embed_url = (
        validate_embed_url("x", f"https://platform.twitter.com/embed/Tweet.html?id={tweet_id}")
        if tweet_id
        else None
    )

    if not title or not images:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            description = description or html_meta.get("description")
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed:
                raise

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type="x" if embed_url else "none",
        embed_url=embed_url,
        site_name="X",
        favicon_url="https://abs.twimg.com/favicons/twitter.3.ico",
        content_type="post",
        platform="x",
    ).finalized()


def _has_ancestor_class(node: Any, blocked_tokens: Tuple[str, ...]) -> bool:
    parent = getattr(node, "parent", None)
    while parent is not None:
        cls_attr = (parent.attributes.get("class") or "").lower()
        if any(tok in cls_attr for tok in blocked_tokens):
            return True
        parent = parent.parent
    return False


_IG_EMBED_EDGE_CAPTION_RE = re.compile(
    r'edge_media_to_caption\\*"\s*:\s*\{\s*\\*"edges\\*"\s*:\s*\[\s*\{\s*\\*"node\\*"\s*:\s*\{\s*\\*"text\\*"\s*:\s*\\*"((?:\\.|[^"\\])+?)\\*"',
    re.DOTALL,
)
_IG_EMBED_OWNER_USER_RE = re.compile(
    r'owner\\*"\s*:\s*\{[^{}]{0,400}?\\*"username\\*"\s*:\s*\\*"([A-Za-z0-9._]{2,64})\\*"',
    re.DOTALL,
)


def _decode_escaped_ig_json_str(raw: str) -> Optional[str]:
    if not raw:
        return None
    candidate = raw.replace('\\\\"', '\\"').replace("\\/", "/")
    try:
        decoded = json.loads(f'"{candidate}"')
    except Exception:
        decoded = re.sub(r"\\+u([0-9a-fA-F]{4})", lambda mm: chr(int(mm.group(1), 16)), candidate).replace("\\n", "\n")
    return clean_text_field(decoded, unescape_html=True)


def _parse_instagram_embed_captioned(html_text: str, base_url: str) -> Dict[str, Any]:
    """Extract author, caption, media, and unavailable state from Instagram /embed/captioned/ HTML."""
    author: Optional[str] = None
    caption: Optional[str] = None
    media_items: List[str] = []
    is_private = False

    if HTMLParser is None or not html_text:
        return {"author": None, "caption": None, "media_items": [], "is_private": False}

    tree = HTMLParser(html_text)
    user_node = tree.css_first(".Header .UsernameText") or tree.css_first(".UsernameText")
    if user_node is not None:
        author = clean_text_field(user_node.text(strip=True), unescape_html=True)
    if not author:
        owner_m = _IG_EMBED_OWNER_USER_RE.search(html_text)
        if owner_m:
            author = clean_text_field(owner_m.group(1), unescape_html=True)

    cap_node = tree.css_first(".Caption")
    if cap_node is not None:
        for rm_node in cap_node.css(".CaptionUsername, .CaptionComments"):
            rm_node.decompose()
        caption = clean_text_field(cap_node.text(separator=" ", strip=True), unescape_html=True)
    if not caption:
        edge_cap_m = _IG_EMBED_EDGE_CAPTION_RE.search(html_text)
        if edge_cap_m:
            caption = _decode_escaped_ig_json_str(edge_cap_m.group(1))

    candidates: List[Tuple[str, Optional[int], Optional[int]]] = []
    for img_node in tree.css("img.EmbeddedMediaImage, .Content video[poster], .EmbeddedMedia video[poster]"):
        if _has_ancestor_class(img_node, ("hovercard", "header", "avatar")):
            continue
        attrs = img_node.attributes
        src = (
            attrs.get("poster")
            or _pick_best_srcset_url(attrs.get("srcset"))
            or attrs.get("src")
            or attrs.get("data-src")
        )
        if src:
            candidates.append((src, _parse_dim_int(attrs.get("width")), _parse_dim_int(attrs.get("height"))))

    # Carousel (Sidecar) posts only render slide #1 as <img>; remaining slides live in escaped JSON `display_url`.
    if "edge_sidecar_to_children" in html_text:
        for sc_url in _extract_ig_sidecar_display_urls(html_text):
            candidates.append((sc_url, None, None))

    media_items = filter_and_cap_images(candidates, base_url=base_url, max_images=MAX_MEDIA_ITEMS)

    if not author and not caption and not media_items:
        for junk_node in tree.css("script, style"):
            junk_node.decompose()
        root_node = tree.body or tree.root
        vis_text = clean_text_field(root_node.text(separator=" ", strip=True), unescape_html=True) if root_node else None
        if _has_marker(vis_text, _PRIVATE_UNAVAILABLE_MARKERS):
            is_private = True

    return {
        "author": author,
        "caption": caption,
        "media_items": media_items,
        "is_private": is_private,
    }


_IG_DISPLAY_URL_RE = re.compile(r'display_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"')
_IG_VIDEO_URL_RE = re.compile(r'video_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"')


def _unescape_meta_json_url(raw: str) -> Optional[str]:
    """Unescape backslash-escaped Meta JSON URL literals safely."""
    url = re.sub(r"\\+/", "/", raw or "")
    url = re.sub(r"\\+u([0-9a-fA-F]{4})", lambda mm: chr(int(mm.group(1), 16)), url)
    url = url.rstrip("\\")
    if "\\" in url or not url.startswith(("https://", "http://")):
        return None
    return url


def _is_meta_cdn_media_host(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    if parsed.scheme.lower() != "https":
        return False
    host = (parsed.hostname or "").lower()
    return (
        host == "cdninstagram.com"
        or host.endswith(".cdninstagram.com")
        or host == "fbcdn.net"
        or host.endswith(".fbcdn.net")
    )


def _extract_ig_sidecar_display_urls(html_text: str) -> List[str]:
    """Extract unique, unescaped `display_url` values (carousel slides) from Instagram embed JSON blobs."""
    out: List[str] = []
    seen: set = set()
    for m in _IG_DISPLAY_URL_RE.finditer(html_text or ""):
        url = _unescape_meta_json_url(m.group(1))
        if not url:
            continue
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _extract_ig_video_url(html_text: str) -> Optional[str]:
    """Extract validated HTTPS Meta CDN `.mp4` `video_url` from an Instagram embed HTML document."""
    for m in _IG_VIDEO_URL_RE.finditer(html_text or ""):
        url = _unescape_meta_json_url(m.group(1))
        safe = sanitize_external_url(url) if url else None
        if safe and _is_meta_cdn_media_host(safe):
            return safe
    return None


async def extract_instagram_playable_video_url(raw_url: str) -> Optional[str]:
    """Fetch fresh playable `.mp4` video_url from Instagram's public embed page when allowed by IG."""
    safe_in = sanitize_external_url(raw_url)
    if not safe_in:
        return None
    parsed = urllib.parse.urlparse(safe_in)
    if not _host_matches((parsed.hostname or "").lower(), ("instagram.com",)):
        return None
    ig_match = _IG_CODE_RE.search(parsed.path or "")
    if not ig_match:
        return None
    raw_kind, ig_code = ig_match.group(1), ig_match.group(2)
    ig_kind = "reel" if raw_kind.lower() == "reels" else raw_kind.lower()

    for suffix in ("embed/captioned/", "embed/"):
        embed_url = f"https://www.instagram.com/{ig_kind}/{ig_code}/{suffix}"
        try:
            status_code, content_type, raw_bytes, final_url = await _fetch_limited_response(embed_url)
            if status_code >= 300 or "/login" in (urllib.parse.urlparse(final_url).path or "").lower():
                continue
            html_text = decode_html_bytes(raw_bytes, content_type=content_type)
            video_url = _extract_ig_video_url(html_text)
            if video_url:
                return video_url
        except Exception as exc:
            logger.debug("Instagram direct video lookup failed for %s: %s", embed_url, redact_secrets_in_text(exc))
    return None


async def _fetch_instagram_embed_captioned(kind: str, code: str) -> Dict[str, Any]:
    embed_captioned_url = f"https://www.instagram.com/{kind}/{code}/embed/captioned/"
    try:
        status_code, content_type, raw_bytes, final_url = await _fetch_limited_response(embed_captioned_url)
        if status_code >= 300:
            return {"is_private": status_code in (401, 403)}
        if "/login" in (urllib.parse.urlparse(final_url).path or "").lower():
            return {}
        html_text = decode_html_bytes(raw_bytes, content_type=content_type)
        return _parse_instagram_embed_captioned(html_text, final_url or embed_captioned_url)
    except Exception as exc:
        logger.debug("Instagram embed/captioned fallback failed for %s/%s: %s", kind, code, redact_secrets_in_text(exc))
        return {}


_FB_PROFILE_THUMB_RE = re.compile(r"(?:p50x50|s50x50|p40x40|s40x40|p32x32|s32x32|c0\.0\.50\.50|/cp0/)", re.I)


def _parse_facebook_plugin_post(html_text: str, base_url: str) -> Dict[str, Any]:
    """Extract full post caption (including expanded text) and media images from Facebook plugins/post.php HTML."""
    caption: Optional[str] = None
    author: Optional[str] = None
    media_items: List[str] = []

    if HTMLParser is None or not html_text:
        return {"author": None, "caption": None, "media_items": []}

    tree = HTMLParser(html_text)
    msg_node = tree.css_first('[data-testid="post_message"]') or tree.css_first(".userContent")
    if msg_node is not None:
        for hide_node in msg_node.css(".text_exposed_hide"):
            hide_node.decompose()
        paras = [
            clean_text_field(p.text(strip=True), unescape_html=True)
            for p in msg_node.css("p")
        ]
        paras_clean = [p for p in paras if p]
        if paras_clean:
            caption = "\n\n".join(paras_clean)
        else:
            caption = clean_text_field(msg_node.text(strip=True), unescape_html=True)

    author_node = tree.css_first("span.fwb a, h5 a, a.profileLink")
    if author_node is not None:
        author = clean_text_field(author_node.text(strip=True), unescape_html=True)

    candidates: List[Tuple[str, Optional[int], Optional[int]]] = []
    for ploi_node in tree.css('a[data-ploi], [data-ploi]'):
        ploi_src = (ploi_node.attributes.get("data-ploi") or "").strip()
        if ploi_src and not _FB_PROFILE_THUMB_RE.search(ploi_src):
            candidates.append((ploi_src, None, None))

    for img_node in tree.css('.mtm img, .uiScaledImageContainer img, a[rel="theater"] img'):
        attrs = img_node.attributes
        src = _pick_best_srcset_url(attrs.get("srcset")) or attrs.get("src") or attrs.get("data-src")
        if not src or _FB_PROFILE_THUMB_RE.search(src):
            continue
        w_hint = _parse_dim_int(attrs.get("width"))
        h_hint = _parse_dim_int(attrs.get("height"))
        if (w_hint is not None and w_hint < 100) or (h_hint is not None and h_hint < 100):
            continue
        candidates.append((src, w_hint, h_hint))

    media_items = filter_and_cap_images(candidates, base_url=base_url, max_images=MAX_MEDIA_ITEMS)
    return {"author": author, "caption": caption, "media_items": media_items}


async def _fetch_facebook_plugin_post(post_url: str) -> Dict[str, Any]:
    encoded = urllib.parse.quote(post_url, safe="")
    plugin_url = f"https://www.facebook.com/plugins/post.php?href={encoded}&show_text=true&width=500"
    try:
        status_code, content_type, raw_bytes, final_url = await _fetch_limited_response(plugin_url)
        if status_code >= 300:
            return {}
        html_text = decode_html_bytes(raw_bytes, content_type=content_type)
        return _parse_facebook_plugin_post(html_text, final_url or plugin_url)
    except Exception as exc:
        logger.debug("Facebook plugin post fetch skipped for %s: %s", redact_secrets_in_text(post_url), redact_secrets_in_text(exc))
        return {}


async def _extract_meta_social(canon_url: str, url_hash: str, platform: str) -> UnfurlResult:
    token = os.getenv("META_OEMBED_ACCESS_TOKEN", "").strip()
    if token and "your_meta" in token.lower():
        token = ""

    encoded = urllib.parse.quote(canon_url, safe="")
    title = None
    description = None
    images: List[str] = []
    embed_url = None
    content_type = "post"
    preview_status = "ok"

    oembed_succeeded = False
    ig_kind: Optional[str] = None
    ig_code: Optional[str] = None
    fetch_meta_url = canon_url
    is_fb_video = False
    is_unresolved_share = False
    is_profile_or_page = False
    if platform == "instagram":
        ig_match = _IG_CODE_RE.search(urllib.parse.urlparse(canon_url).path or "")
        if ig_match:
            raw_kind, ig_code = ig_match.group(1), ig_match.group(2)
            ig_kind = "reel" if raw_kind.lower() == "reels" else raw_kind.lower()
            if ig_kind == "reel":
                content_type = "video"
            if raw_kind.lower() == "reels" and ig_code:
                # IG's /reels/<code>/ web route frequently bounces crawlers to /accounts/login/,
                # whereas /reel/<code>/ serves full OG title, caption, and cover metadata.
                fetch_meta_url = f"https://www.instagram.com/reel/{ig_code}/"
            embed_url = validate_embed_url("instagram", f"https://www.instagram.com/{ig_kind}/{ig_code}/embed")
        elif _is_instagram_profile_url(canon_url):
            is_profile_or_page = True
            content_type = "link"
        if token and not is_profile_or_page:
            oembed_url = (
                f"https://graph.facebook.com/v18.0/instagram_oembed"
                f"?url={encoded}&access_token={urllib.parse.quote(token, safe='')}"
            )
            oembed = await _fetch_json_safely(oembed_url)
            if isinstance(oembed, dict):
                oembed_succeeded = True
                title = oembed.get("title") or oembed.get("author_name")
                if oembed.get("title") and oembed.get("author_name"):
                    description = f"{oembed['author_name']} — {oembed['title']}"
                if oembed.get("thumbnail_url"):
                    images.append(oembed["thumbnail_url"])
    else:
        is_fb_video = _is_facebook_video_url(canon_url)
        fb_path_lower = (urllib.parse.urlparse(canon_url).path or "").lower()
        is_unresolved_share = fb_path_lower.startswith("/share/")
        is_profile_or_page = _is_facebook_page_or_profile_url(canon_url)
        if is_fb_video:
            content_type = "video"
        elif is_profile_or_page:
            content_type = "link"
        if not is_unresolved_share and not is_profile_or_page:
            if is_fb_video:
                embed_url = validate_embed_url(
                    "facebook",
                    f"https://www.facebook.com/plugins/video.php?href={encoded}&show_text=false",
                )
            else:
                embed_url = validate_embed_url(
                    "facebook",
                    f"https://www.facebook.com/plugins/post.php?href={encoded}",
                )
        if token and not is_profile_or_page:
            oembed_endpoint = "oembed_video" if is_fb_video else "oembed_post"
            oembed_url = (
                f"https://graph.facebook.com/v18.0/{oembed_endpoint}"
                f"?url={encoded}&access_token={urllib.parse.quote(token, safe='')}"
            )
            oembed = await _fetch_json_safely(oembed_url)
            if isinstance(oembed, dict):
                oembed_succeeded = True
                title = oembed.get("author_name") or oembed.get("title")
                if oembed.get("title") and oembed.get("title") != title:
                    description = oembed.get("title")
                elif oembed.get("author_name"):
                    description = f"โพสต์จาก {oembed['author_name']}"
                if oembed.get("thumbnail_url"):
                    images.append(oembed["thumbnail_url"])

    is_strict_private_meta = False
    if not title or not images or not description:
        try:
            html_meta = await _fetch_generic_html_meta(
                fetch_meta_url,
                allow_profile_avatars=is_profile_or_page,
            )
            meta_title = html_meta.get("title")
            meta_desc = html_meta.get("description")
            meta_images = html_meta.get("media_items") or []
            meta_final_url = str(html_meta.get("final_url") or "")
            meta_og_url = html_meta.get("og_url")
            is_strict_private = _has_marker(meta_title, _PRIVATE_UNAVAILABLE_MARKERS) or _has_marker(
                meta_desc, _PRIVATE_UNAVAILABLE_MARKERS
            )
            is_login_wall = (
                "/login" in (urllib.parse.urlparse(meta_final_url).path or "").lower()
                or _has_marker(meta_title, _LOGIN_WALL_MARKERS)
                or _has_marker(meta_desc, _LOGIN_WALL_MARKERS)
            )
            is_empty_fb_shell = (
                platform == "facebook"
                and not oembed_succeeded
                and not is_strict_private
                and not is_login_wall
                and (meta_title or "").strip().lower() in ("facebook", "facebook - log in or sign up", "")
                and not meta_desc
                and not meta_images
                and (urllib.parse.urlparse(canon_url).path or "/") not in ("", "/")
            )
            if is_strict_private or is_empty_fb_shell:
                if is_strict_private:
                    is_strict_private_meta = True
                if not oembed_succeeded:
                    preview_status = "private_or_restricted"
                    embed_url = None
            elif is_login_wall:
                # Meta bounced server scraper to login wall; scrub junk text.
                if not embed_url:
                    preview_status = "private_or_restricted"
            else:
                if meta_title and (not title or is_generic_or_noisy_title(title, platform, canon_url)):
                    title = meta_title
                description = description or meta_desc
                images.extend(meta_images)
                if platform == "facebook" and is_unresolved_share and not embed_url and meta_og_url:
                    og_parsed = urllib.parse.urlparse(meta_og_url)
                    og_host = (og_parsed.hostname or "").lower()
                    og_path = (og_parsed.path or "").lower()
                    if _host_matches(og_host, ("facebook.com",)) and "/login" not in og_path and not og_path.startswith("/share/"):
                        resolved_is_video = is_fb_video or _is_facebook_video_url(meta_og_url)
                        if resolved_is_video:
                            content_type = "video"
                        og_encoded = urllib.parse.quote(meta_og_url, safe="")
                        plugin_ep = "video.php?href=" if resolved_is_video else "post.php?href="
                        suffix = "&show_text=false" if resolved_is_video else ""
                        embed_url = validate_embed_url(
                            "facebook",
                            f"https://www.facebook.com/plugins/{plugin_ep}{og_encoded}{suffix}",
                        )
        except Exception as exc:
            err_msg = str(exc)
            if any(code in err_msg for code in ("HTTP 401", "HTTP 403")) or (
                platform == "facebook" and "HTTP 400" in err_msg
            ):
                if not oembed_succeeded:
                    preview_status = "private_or_restricted"
                    embed_url = None
            elif not oembed_succeeded and not title and not embed_url:
                raise

    has_cropped_ig_cover = bool(images and len(images) == 1 and _is_cropped_meta_image_url(images[0]))
    ig_title_missing = platform == "instagram" and (
        not title or is_generic_or_noisy_title(title, "instagram", canon_url)
    )
    if (
        platform == "instagram"
        and ig_kind
        and ig_code
        and not is_strict_private_meta
        and (ig_title_missing or not images or not description or has_cropped_ig_cover or (ig_kind == "p" and len(images) < 2))
    ):
        embed_meta = await _fetch_instagram_embed_captioned(ig_kind, ig_code)
        if embed_meta.get("is_private") and not oembed_succeeded and (ig_title_missing or not title) and not description and not images:
            preview_status = "private_or_restricted"
            embed_url = None
        else:
            eb_author = embed_meta.get("author")
            eb_caption = embed_meta.get("caption")
            eb_images = embed_meta.get("media_items") or []
            if not embed_meta.get("is_private") and (eb_images or eb_caption):
                preview_status = "ok"
                if not embed_url:
                    embed_url = validate_embed_url("instagram", f"https://www.instagram.com/{ig_kind}/{ig_code}/embed")
            if ig_title_missing or not title:
                if eb_author and eb_caption:
                    title = f"@{eb_author}: {eb_caption[:90]}"
                elif eb_caption:
                    title = eb_caption[:100]
                elif eb_author:
                    title = f"โพสต์จาก @{eb_author}"
            if not description:
                if eb_author and eb_caption:
                    description = f"@{eb_author} — {eb_caption}"
                elif eb_caption:
                    description = eb_caption
                elif eb_author:
                    description = f"โพสต์จาก @{eb_author}"
            if eb_images:
                if has_cropped_ig_cover:
                    images = list(eb_images)
                else:
                    images.extend(eb_images)

    if platform == "instagram" and (not title or is_generic_or_noisy_title(title, "instagram", canon_url)) and not description:
        ig_url_author = _extract_author_from_social_url(canon_url, "instagram")
        if ig_url_author and preview_status != "private_or_restricted":
            title = f"โพสต์จาก {ig_url_author}"

    if (
        platform == "facebook"
        and not is_profile_or_page
        and preview_status != "private_or_restricted"
        and (
            not description
            or description.rstrip().endswith(("...", "…"))
            or len(images) < 2
        )
    ):
        plugin_target = canon_url
        if is_unresolved_share and embed_url:
            qs_href = urllib.parse.parse_qs(urllib.parse.urlparse(embed_url).query or "").get("href") or []
            if qs_href:
                plugin_target = qs_href[0]
        if not (urllib.parse.urlparse(plugin_target).path or "").lower().startswith("/share/"):
            fb_plugin = await _fetch_facebook_plugin_post(plugin_target)
            fb_caption = fb_plugin.get("caption")
            fb_author = fb_plugin.get("author")
            fb_images = fb_plugin.get("media_items") or []
            if fb_caption and (
                not description
                or description.rstrip().endswith(("...", "…"))
                or len(fb_caption) > len(description)
            ):
                description = fb_caption
            if fb_author and not title:
                title = fb_author
            if fb_images:
                images.extend(fb_images)

    if (
        platform == "facebook"
        and not is_profile_or_page
        and is_meta_crawler_ua_enabled()
        and (not images or preview_status == "private_or_restricted")
    ):
        try:
            crawler_target = fetch_meta_url
            if is_unresolved_share:
                resolved_crawler_url = await _resolve_short_share_url(
                    fetch_meta_url,
                    force_meta_crawler_ua=True,
                )
                if resolved_crawler_url and resolved_crawler_url != fetch_meta_url:
                    crawler_target = resolved_crawler_url
                    canon_url = resolved_crawler_url
                    is_unresolved_share = (
                        urllib.parse.urlparse(canon_url).path or ""
                    ).lower().startswith("/share/")
            crawler_meta = await _fetch_generic_html_meta(
                crawler_target,
                allow_profile_avatars=is_profile_or_page,
                force_meta_crawler_ua=True,
            )
            c_title = crawler_meta.get("title")
            c_desc = crawler_meta.get("description")
            c_images = crawler_meta.get("media_items") or []
            c_final = str(crawler_meta.get("final_url") or "")
            c_og_url = crawler_meta.get("og_url")
            c_private = _has_marker(c_title, _PRIVATE_UNAVAILABLE_MARKERS) or _has_marker(
                c_desc, _PRIVATE_UNAVAILABLE_MARKERS
            )
            c_login = (
                "/login" in (urllib.parse.urlparse(c_final).path or "").lower()
                or _has_marker(c_title, _LOGIN_WALL_MARKERS)
                or _has_marker(c_desc, _LOGIN_WALL_MARKERS)
            )
            if not c_private and not c_login and (c_images or c_desc or c_title):
                preview_status = "ok"
                if c_title and (not title or is_generic_or_noisy_title(title, platform, canon_url)):
                    title = c_title
                if c_desc and (
                    not description
                    or description.rstrip().endswith(("...", "…"))
                    and len(c_desc) > len(description)
                ):
                    description = c_desc
                if c_images:
                    images.extend(c_images)
                if not embed_url:
                    embed_candidate = c_og_url or (
                        crawler_target
                        if not (urllib.parse.urlparse(crawler_target).path or "").lower().startswith("/share/")
                        else None
                    )
                    if embed_candidate:
                        ec_parsed = urllib.parse.urlparse(embed_candidate)
                        ec_host = (ec_parsed.hostname or "").lower()
                        ec_path = (ec_parsed.path or "").lower()
                        if _host_matches(ec_host, ("facebook.com",)) and "/login" not in ec_path and not ec_path.startswith("/share/"):
                            resolved_is_video = is_fb_video or _is_facebook_video_url(embed_candidate)
                            if resolved_is_video:
                                content_type = "video"
                            ec_encoded = urllib.parse.quote(embed_candidate, safe="")
                            plugin_ep = "video.php?href=" if resolved_is_video else "post.php?href="
                            suffix = "&show_text=false" if resolved_is_video else ""
                            embed_url = validate_embed_url(
                                "facebook",
                                f"https://www.facebook.com/plugins/{plugin_ep}{ec_encoded}{suffix}",
                            )
            if (
                crawler_target != fetch_meta_url
                and not (urllib.parse.urlparse(crawler_target).path or "").lower().startswith("/share/")
                and (
                    not images
                    or not description
                    or description.rstrip().endswith(("...", "…"))
                )
            ):
                fb_plugin_res = await _fetch_facebook_plugin_post(crawler_target)
                fb_p_caption = fb_plugin_res.get("caption")
                fb_p_author = fb_plugin_res.get("author")
                fb_p_images = fb_plugin_res.get("media_items") or []
                if fb_p_caption and (
                    not description
                    or description.rstrip().endswith(("...", "…"))
                    or len(fb_p_caption) > len(description)
                ):
                    description = fb_p_caption
                if fb_p_author and (not title or is_generic_or_noisy_title(title, platform, canon_url)):
                    title = fb_p_author
                if fb_p_images:
                    images.extend(fb_p_images)
                    preview_status = "ok"
        except Exception as exc:
            logger.debug(
                "Facebook crawler UA fallback skipped for %s: %s",
                redact_secrets_in_text(canon_url),
                redact_secrets_in_text(exc),
            )

    return UnfurlResult(
        url=canon_url,
        canonical_url=canon_url,
        url_hash=url_hash,
        title=title or canon_url,
        description=description,
        media_items=images,
        embed_type=platform if embed_url else "none",
        embed_url=embed_url,
        site_name="Instagram" if platform == "instagram" else "Facebook",
        favicon_url=(
            "https://www.instagram.com/favicon.ico"
            if platform == "instagram"
            else "https://www.facebook.com/favicon.ico"
        ),
        content_type=content_type,
        platform=platform,
        preview_status=preview_status,
        allow_profile_avatars=is_profile_or_page,
    ).finalized()


async def extract_unfurl_metadata(
    raw_url: str,
    *,
    fetch_full_description: bool = False,
) -> UnfurlResult:
    """Extract zero-token rich preview metadata from a public URL across supported platforms."""
    canon_url = canonicalize_url(raw_url)
    await asyncio.to_thread(validate_safe_url, canon_url)
    canon_url = await _resolve_short_share_url(canon_url)
    url_hash = compute_url_hash(canon_url)

    hostname = (urllib.parse.urlparse(canon_url).hostname or "").lower()
    platform = _detect_platform(hostname)

    if platform == "youtube":
        return await _extract_youtube(
            canon_url,
            url_hash,
            fetch_full_description=fetch_full_description,
        )
    if platform == "tiktok":
        return await _extract_tiktok(
            canon_url,
            url_hash,
            fetch_full_description=fetch_full_description,
        )
    if platform == "vimeo":
        return await _extract_vimeo(canon_url, url_hash)
    if platform == "spotify":
        return await _extract_spotify(canon_url, url_hash)
    if platform == "reddit":
        return await _extract_reddit(canon_url, url_hash)
    if platform == "x":
        return await _extract_x(canon_url, url_hash)
    if platform in ("instagram", "facebook"):
        return await _extract_meta_social(canon_url, url_hash, platform)

    try:
        meta = await _fetch_generic_html_meta(canon_url)
    except Exception as exc:
        if any(code in str(exc) for code in ("HTTP 401", "HTTP 403")):
            return UnfurlResult(
                url=raw_url.strip(),
                canonical_url=canon_url,
                url_hash=url_hash,
                title=canon_url,
                preview_status="private_or_restricted",
                platform="web",
            ).finalized()
        raise

    meta_title = meta.get("title")
    meta_desc = meta.get("description")
    is_private = _has_marker(meta_title, _PRIVATE_UNAVAILABLE_MARKERS) or _has_marker(
        meta_desc, _PRIVATE_UNAVAILABLE_MARKERS
    )
    return UnfurlResult(
        url=raw_url.strip(),
        canonical_url=canon_url,
        url_hash=url_hash,
        title=canon_url if is_private else (meta_title or canon_url),
        description=None if is_private else meta_desc,
        media_items=[] if is_private else (meta.get("media_items") or []),
        embed_type="none",
        embed_url=None,
        site_name=meta.get("site_name"),
        favicon_url=meta.get("favicon_url"),
        content_type=meta.get("content_type") or "link",
        platform="web",
        preview_status="private_or_restricted" if is_private else "ok",
    ).finalized()
