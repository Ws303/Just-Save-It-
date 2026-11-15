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

from dataclasses import dataclass, field
import html as html_lib
import ipaddress
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
_IG_CODE_RE = re.compile(r"/(p|reel|tv)/([A-Za-z0-9_-]+)")


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
        )
        self.media_items = cleaned_images
        self.image_url = cleaned_images[0] if cleaned_images else None
        self.title = clean_text_field(self.title, unescape_html=True)
        self.description = clean_text_field(self.description, unescape_html=True)
        self.site_name = clean_text_field(self.site_name, unescape_html=True)
        self.favicon_url = sanitize_external_url(self.favicon_url)
        if self.content_type not in _VALID_CONTENT_TYPES:
            self.content_type = "link"
        return self


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

    if _JUNK_SEGMENT_RE.search(path_lower):
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
) -> List[str]:
    """Filter junk/duplicate/unsafe image candidates and enforce hard cap <= max_images."""
    results: List[str] = []
    seen = set()

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
        if is_junk_image_url(resolved, width_hint=w_hint, height_hint=h_hint):
            continue

        dedup_key = resolved.split("#", 1)[0]
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        results.append(resolved)
        if len(results) >= max_images:
            break

    return results


async def _fetch_limited_response(
    url: str,
    max_bytes: int = MAX_HTML_BYTES,
) -> Tuple[int, str, bytes, str]:
    """Stream-fetch URL with SSRF redirect guard, 8s timeout, and <=3MB body cap."""
    return await stream_fetch_limited(
        url,
        max_bytes=max_bytes,
        reject_on_oversize=False,
        timeout_sec=DEFAULT_TIMEOUT_SEC,
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


def _parse_html_metadata(html_text: str, final_url: str) -> Dict[str, Any]:
    """Extract title, description, site_name, favicon, content_type, and <=5 images via selectolax."""
    title: Optional[str] = None
    description: Optional[str] = None
    site_name: Optional[str] = None
    favicon_url: Optional[str] = None
    content_type: str = "link"
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

        description = (
            _extract_meta_content(tree, "property", "og:description")
            or _extract_meta_content(tree, "name", "twitter:description")
            or _extract_meta_content(tree, "name", "description")
        )

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

        for meta_attr, meta_key in (
            ("property", "og:image:secure_url"),
            ("property", "og:image"),
            ("name", "twitter:image"),
            ("name", "twitter:image:src"),
        ):
            img_meta = _extract_meta_content(tree, meta_attr, meta_key)
            if img_meta:
                image_candidates.append((img_meta, None, None))

        # Collect content images from <article>/<main> first, then fallback <body>
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
            src = (
                attrs.get("src")
                or attrs.get("data-src")
                or attrs.get("data-original")
                or attrs.get("data-lazy-src")
            )
            if not src and attrs.get("srcset"):
                src = attrs["srcset"].split(",")[0].strip().split(" ")[0]
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
                    title = clean_text_field(meta.title, unescape_html=True)
                if not description and getattr(meta, "description", None):
                    description = clean_text_field(meta.description, unescape_html=True)
                if not site_name and getattr(meta, "sitename", None):
                    site_name = clean_text_field(meta.sitename, unescape_html=True)
        except Exception as exc:
            logger.debug("Trafilatura metadata fallback failed for %s: %s", final_url, exc)

    if not site_name:
        site_name = (urllib.parse.urlparse(final_url).hostname or "").lower() or None

    media_items = filter_and_cap_images(image_candidates, base_url=final_url, max_images=MAX_MEDIA_ITEMS)
    return {
        "title": title,
        "description": description,
        "site_name": site_name,
        "favicon_url": favicon_url,
        "content_type": content_type,
        "media_items": media_items,
    }


async def _fetch_generic_html_meta(url: str) -> Dict[str, Any]:
    status_code, content_type, raw_bytes, final_url = await _fetch_limited_response(url)
    if status_code >= 300:
        raise ValueError(f"HTTP {status_code} fetching '{url}'.")

    ct_lower = content_type.split(";")[0].strip().lower()
    if ct_lower.startswith("image/"):
        images = filter_and_cap_images([(final_url, None, None)], base_url=final_url)
        return {
            "title": urllib.parse.urlparse(final_url).path.rsplit("/", 1)[-1] or final_url,
            "description": None,
            "site_name": (urllib.parse.urlparse(final_url).hostname or "").lower() or None,
            "favicon_url": None,
            "content_type": "link",
            "media_items": images,
        }

    html_text = decode_html_bytes(raw_bytes, content_type=content_type)
    return _parse_html_metadata(html_text, final_url)


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


async def _extract_youtube(canon_url: str, url_hash: str) -> UnfurlResult:
    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://www.youtube.com/oembed?url={encoded}&format=json")
    match = _YOUTUBE_ID_RE.search(canon_url)
    video_id = match.group(1) if match else None

    embed_url = None
    if isinstance(oembed, dict):
        embed_url = extract_safe_iframe_src(oembed.get("html"), "youtube")
    if not embed_url and video_id:
        embed_url = validate_embed_url("youtube", f"https://www.youtube.com/embed/{video_id}")

    images: List[Any] = []
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

    needs_html_meta = (
        not title
        or not images
        or not description
        or (author and description == f"By {author}")
    )
    if needs_html_meta:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            html_desc = clean_text_field(html_meta.get("description"), unescape_html=True)
            if html_desc and html_desc != (clean_text_field(title, unescape_html=True) or ""):
                description = html_desc
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed and not video_id:
                raise

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


async def _extract_tiktok(canon_url: str, url_hash: str) -> UnfurlResult:
    encoded = urllib.parse.quote(canon_url, safe="")
    oembed = await _fetch_json_safely(f"https://www.tiktok.com/oembed?url={encoded}")
    id_match = _TIKTOK_ID_RE.search(canon_url)
    video_id = id_match.group(1) if id_match else None

    embed_url = None
    title = None
    description = None
    author = None
    images: List[Any] = []
    if isinstance(oembed, dict):
        title = oembed.get("title")
        author = clean_text_field(oembed.get("author_name"), unescape_html=True)
        description = f"@{author}" if author else None
        if oembed.get("thumbnail_url"):
            images.append(oembed["thumbnail_url"])
        embed_url = extract_safe_iframe_src(oembed.get("html"), "tiktok")
        if not video_id and isinstance(oembed.get("html"), str):
            vid_m = re.search(r'data-video-id="(\d+)"', oembed["html"])
            if vid_m:
                video_id = vid_m.group(1)

    if not embed_url and video_id:
        embed_url = validate_embed_url("tiktok", f"https://www.tiktok.com/embed/v2/{video_id}")

    needs_html_meta = (
        not title
        or not images
        or not description
        or (author and description == f"@{author}")
    )
    if needs_html_meta:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            html_desc = clean_text_field(html_meta.get("description"), unescape_html=True)
            if html_desc and html_desc != (clean_text_field(title, unescape_html=True) or ""):
                description = html_desc
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
        embed_type="tiktok" if embed_url else "none",
        embed_url=embed_url,
        site_name="TikTok",
        favicon_url="https://www.tiktok.com/favicon.ico",
        content_type="video",
        platform="tiktok",
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

    oembed_succeeded = False
    if platform == "instagram":
        ig_match = _IG_CODE_RE.search(urllib.parse.urlparse(canon_url).path or "")
        if ig_match:
            kind, code = ig_match.group(1), ig_match.group(2)
            if kind == "reel":
                content_type = "video"
            embed_url = validate_embed_url("instagram", f"https://www.instagram.com/{kind}/{code}/embed")
        if token:
            oembed_url = (
                f"https://graph.facebook.com/v18.0/instagram_oembed"
                f"?url={encoded}&access_token={urllib.parse.quote(token, safe='')}"
            )
            oembed = await _fetch_json_safely(oembed_url)
            if isinstance(oembed, dict):
                oembed_succeeded = True
                title = oembed.get("title") or oembed.get("author_name")
                if oembed.get("thumbnail_url"):
                    images.append(oembed["thumbnail_url"])
    else:
        embed_url = validate_embed_url(
            "facebook", f"https://www.facebook.com/plugins/post.php?href={encoded}"
        )
        if token:
            oembed_url = (
                f"https://graph.facebook.com/v18.0/oembed_post"
                f"?url={encoded}&access_token={urllib.parse.quote(token, safe='')}"
            )
            oembed = await _fetch_json_safely(oembed_url)
            if isinstance(oembed, dict):
                oembed_succeeded = True
                title = oembed.get("author_name") or oembed.get("title")
                if oembed.get("thumbnail_url"):
                    images.append(oembed["thumbnail_url"])

    if not title or not images:
        try:
            html_meta = await _fetch_generic_html_meta(canon_url)
            title = title or html_meta.get("title")
            description = description or html_meta.get("description")
            images.extend(html_meta.get("media_items") or [])
        except Exception:
            if not oembed_succeeded and not title:
                raise

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
    ).finalized()


async def extract_unfurl_metadata(raw_url: str) -> UnfurlResult:
    """Extract zero-token rich preview metadata from a public URL across supported platforms."""
    canon_url = canonicalize_url(raw_url)
    validate_safe_url(canon_url)
    url_hash = compute_url_hash(canon_url)

    hostname = (urllib.parse.urlparse(canon_url).hostname or "").lower()
    platform = _detect_platform(hostname)

    if platform == "youtube":
        return await _extract_youtube(canon_url, url_hash)
    if platform == "tiktok":
        return await _extract_tiktok(canon_url, url_hash)
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

    meta = await _fetch_generic_html_meta(canon_url)
    return UnfurlResult(
        url=raw_url.strip(),
        canonical_url=canon_url,
        url_hash=url_hash,
        title=meta.get("title") or canon_url,
        description=meta.get("description"),
        media_items=meta.get("media_items") or [],
        embed_type="none",
        embed_url=None,
        site_name=meta.get("site_name"),
        favicon_url=meta.get("favicon_url"),
        content_type=meta.get("content_type") or "link",
        platform="web",
    ).finalized()
