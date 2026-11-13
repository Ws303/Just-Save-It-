"""Content extraction pipeline for Just-Save-It AI module.

Enforces:
1. SSRF Guard (validate_safe_url): Blocks localhost, loopback, private IP subnets, and non-http(s) schemes.
2. oEmbed support: Rich public metadata for YouTube, TikTok, X, and Reddit.
3. Trafilatura article extraction: Clean body text without nav/ads.
4. Token safety: Trims combined text to at most 6,000 characters.
"""

import ipaddress
import logging
import re
import socket
import urllib.parse
from typing import Optional

import httpx

try:
    import trafilatura
except ImportError:
    trafilatura = None

try:
    from selectolax.parser import HTMLParser
except ImportError:
    HTMLParser = None

logger = logging.getLogger("just_save_it.extractor")

MAX_EXTRACTED_CHARS = 6000
DEFAULT_TIMEOUT_SEC = 8.0
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 JustSaveItBot/1.0"


def validate_safe_url(url: str) -> str:
    """Validate that a URL uses http/https and does not resolve to private or loopback IP ranges.

    Raises:
        ValueError: If scheme is not http/https or if URL targets private/internal network.
    """
    if not url or not isinstance(url, str):
        raise ValueError("URL must be a non-empty string.")

    parsed = urllib.parse.urlparse(url.strip())
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"Invalid URL scheme '{scheme}'. Only 'http' and 'https' are allowed.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL does not contain a valid hostname.")

    hostname_lower = hostname.lower()
    if hostname_lower in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise ValueError(f"SSRF Alert: Target hostname '{hostname}' is not permitted.")

    try:
        addr_info = socket.getaddrinfo(hostname, None)
        for _, _, _, _, sockaddr in addr_info:
            ip_str = sockaddr[0]
            ip = ipaddress.ip_address(ip_str)
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                raise ValueError(f"SSRF Alert: Hostname '{hostname}' resolves to private IP '{ip_str}'.")
    except socket.gaierror:
        # If DNS resolution fails, raise ValueError to block unsafe connection
        raise ValueError(f"Could not resolve hostname '{hostname}'.")

    return url.strip()


def is_safe_url(url: str) -> bool:
    """Helper returning boolean for URL safety check."""
    try:
        validate_safe_url(url)
        return True
    except Exception:
        return False


def _detect_oembed_endpoint(url: str) -> Optional[str]:
    """Return corresponding oEmbed API endpoint if URL matches supported platforms."""
    lower_url = url.lower()
    encoded = urllib.parse.quote(url, safe="")

    if "youtube.com" in lower_url or "youtu.be" in lower_url:
        return f"https://www.youtube.com/oembed?url={encoded}&format=json"
    if "tiktok.com" in lower_url:
        return f"https://www.tiktok.com/oembed?url={encoded}"
    if "twitter.com" in lower_url or "x.com" in lower_url:
        return f"https://publish.twitter.com/oembed?url={encoded}"
    if "reddit.com" in lower_url:
        return f"https://www.reddit.com/oembed?url={encoded}"
    return None


async def _fetch_oembed_data(oembed_url: str) -> Optional[str]:
    """Fetch and format title and author from public oEmbed endpoint."""
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC, follow_redirects=True) as client:
            resp = await client.get(oembed_url, headers={"User-Agent": USER_AGENT})
            if resp.status_code == 200:
                data = resp.json()
                title = data.get("title", "").strip()
                author = data.get("author_name", "").strip()
                provider = data.get("provider_name", "").strip()
                parts = []
                if title:
                    parts.append(f"Title: {title}")
                if author:
                    parts.append(f"Author / Creator: {author}")
                if provider:
                    parts.append(f"Platform: {provider}")
                return "\n".join(parts) if parts else None
    except Exception as e:
        logger.debug("Failed to fetch oEmbed data from %s: %s", oembed_url, e)
    return None


def _fallback_html_extract(html: str) -> str:
    """Fallback text extractor using selectolax or regular expressions."""
    if HTMLParser:
        try:
            tree = HTMLParser(html)
            # Remove scripts and styles
            for tag in tree.css("script, style, nav, footer, header, noscript"):
                tag.decompose()
            paragraphs = [p.text(strip=True) for p in tree.css("p, h1, h2, h3, article")]
            text = " ".join([p for p in paragraphs if p])
            if text:
                return text
        except Exception as e:
            logger.debug("Selectolax parse error: %s", e)

    # Regex fallback if selectolax fails or is absent
    clean_html = re.sub(r"<(script|style).*?</\1>", "", html, flags=re.DOTALL | re.IGNORECASE)
    clean_text = re.sub(r"<[^>]+>", " ", clean_html)
    return " ".join(clean_text.split())


async def extract_text_for_ai(
    url: str,
    fallback_title: str = "",
    fallback_desc: str = "",
) -> str:
    """Extract clean, consolidated text content from a given URL for AI summarization.

    1. Checks SSRF safety via validate_safe_url.
    2. Uses oEmbed for video/social platforms.
    3. Uses trafilatura for generic web articles.
    4. Trims result to at most 6,000 characters.
    """
    fallback_content = f"Title: {fallback_title}\nDescription: {fallback_desc}".strip()

    # 1. SSRF Safety Check
    try:
        validate_safe_url(url)
    except ValueError as ve:
        logger.warning("SSRF Guard blocked URL '%s': %s", url, ve)
        return fallback_content[:MAX_EXTRACTED_CHARS]

    extracted_body = ""

    # 2. Check oEmbed for social / video platforms
    oembed_endpoint = _detect_oembed_endpoint(url)
    if oembed_endpoint:
        oembed_text = await _fetch_oembed_data(oembed_endpoint)
        if oembed_text:
            combined = f"{oembed_text}\nDescription: {fallback_desc}".strip()
            return combined[:MAX_EXTRACTED_CHARS]

    # 3. Web article fetch via httpx and trafilatura
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status_code == 200:
                html = resp.text
                if trafilatura:
                    extracted = trafilatura.extract(
                        html,
                        include_comments=False,
                        include_tables=True,
                        no_fallback=False,
                    )
                    if extracted and extracted.strip():
                        extracted_body = extracted.strip()

                if not extracted_body:
                    extracted_body = _fallback_html_extract(html)
    except Exception as e:
        logger.debug("Failed to extract web content from %s: %s", url, e)

    # 4. Token Trimming & Consolidation
    components = []
    if fallback_title:
        components.append(f"Title: {fallback_title}")
    if fallback_desc:
        components.append(f"Description: {fallback_desc}")
    if extracted_body:
        components.append(f"Content:\n{extracted_body}")

    final_text = "\n\n".join(components).strip()
    if not final_text:
        final_text = f"URL: {url}"

    return final_text[:MAX_EXTRACTED_CHARS]
