"""Security primitives for Just-Save-It Rich Unfurl & Internal Cron endpoints.

Provides:
1. Constant-time shared-secret guard (`X-Webhook-Secret` / `X-Cron-Secret`) with fail-closed 503/401.
2. Strict official-host allowlist validation for `embed_url` (XSS prevention).
3. Thread-safe in-memory sliding-window rate limiter (`collections.deque`) with injectable clock.
"""

import asyncio
from collections import deque
import hashlib
import hmac
import ipaddress
import logging
import os
import re
import threading
import time
from typing import Any, Callable, Deque, Dict, Optional, Tuple
import urllib.parse

from fastapi import Header, HTTPException, status
import httpx

from Ai.content_extractor import DEFAULT_TIMEOUT_SEC, USER_AGENT, _host_matches, validate_safe_url

try:
    from selectolax.lexbor import LexborHTMLParser as HTMLParser
except ImportError:
    try:
        from selectolax.parser import HTMLParser
    except ImportError:
        HTMLParser = None  # type: ignore

logger = logging.getLogger("just_save_it.unfurl.security")

_PLACEHOLDER_SECRETS = frozenset(
    {
        "",
        "your_internal_webhook_secret_here",
        "your_webhook_secret_here",
        "your_cron_shared_secret_here",
        "changeme",
    }
)

EMBED_ALLOWED_HOSTS: Dict[str, Tuple[str, ...]] = {
    "youtube": ("www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"),
    "tiktok": ("www.tiktok.com", "tiktok.com"),
    "instagram": ("www.instagram.com", "instagram.com"),
    "facebook": ("www.facebook.com", "facebook.com", "web.facebook.com"),
    "x": ("platform.twitter.com",),
    "reddit": ("www.redditmedia.com", "redditmedia.com", "embed.reddit.com"),
    "vimeo": ("player.vimeo.com",),
    "spotify": ("open.spotify.com",),
}
_EXACT_ONLY_EMBED_TYPES = frozenset({"x", "vimeo", "spotify"})

_IFRAME_SRC_RE = re.compile(r"""<iframe[^>]+src\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_SECRET_QUERY_RE = re.compile(r"([?&](?:access_token|api_key|token|secret)=)[^&\s'\"]+", re.IGNORECASE)
_BEARER_SECRET_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)


def redact_secrets_in_text(text: Any) -> str:
    """Scrub sensitive query tokens and Bearer credentials from logged URLs and exception messages."""
    scrubbed = _SECRET_QUERY_RE.sub(r"\1[REDACTED]", str(text or ""))
    return _BEARER_SECRET_RE.sub(r"\1[REDACTED]", scrubbed)


def _has_disallowed_url_chars(candidate: str) -> bool:
    return any(
        ord(ch) < 0x20 or ord(ch) == 0x7F or ch in (" ", "<", ">", '"', "'", "\\")
        for ch in candidate
    )


def _is_disallowed_ip_literal(hostname: str) -> bool:
    try:
        ip = ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        return False

    candidates = [ip]
    ipv4_mapped = getattr(ip, "ipv4_mapped", None)
    if ipv4_mapped is not None:
        candidates.append(ipv4_mapped)

    return any(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
        for addr in candidates
    )


def sanitize_external_url(raw_url: Optional[str]) -> Optional[str]:
    """Validate syntax & non-private network target for external http(s) URLs (images/favicons)."""
    if not raw_url or not isinstance(raw_url, str):
        return None
    candidate = raw_url.strip()
    if not candidate or _has_disallowed_url_chars(candidate):
        return None

    try:
        parsed = urllib.parse.urlparse(candidate)
    except Exception:
        return None

    if parsed.scheme.lower() not in ("http", "https"):
        return None
    if parsed.username or parsed.password:
        return None

    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        return None
    if hostname in ("localhost", "localhost.localdomain") or hostname.endswith(
        (".localhost", ".local", ".internal")
    ):
        return None
    if _is_disallowed_ip_literal(hostname):
        return None

    return candidate


def is_dev_webhook_bypass_enabled() -> bool:
    """Return True only when both ENV=development and ALLOW_DEV_WEBHOOK_BYPASS=true."""
    env = os.getenv("ENV", "production").strip().lower()
    bypass = os.getenv("ALLOW_DEV_WEBHOOK_BYPASS", "false").strip().lower()
    return env == "development" and bypass == "true"


def _configured_internal_secrets() -> Tuple[str, ...]:
    secrets_list = []
    for env_key in ("INTERNAL_WEBHOOK_SECRET", "WEBHOOK_SECRET", "CRON_SHARED_SECRET"):
        val = os.getenv(env_key, "").strip()
        if val and val not in _PLACEHOLDER_SECRETS and val not in secrets_list:
            secrets_list.append(val)
    return tuple(secrets_list)


def _constant_time_equal(candidate: str, expected: str) -> bool:
    """Compare secrets via SHA-256 digests so lengths never leak via timing."""
    a_digest = hashlib.sha256(candidate.encode("utf-8")).digest()
    b_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(a_digest, b_digest)


def verify_internal_secret(provided_secret: Optional[str]) -> None:
    """Validate internal webhook/cron secret with fail-closed semantics.

    - If no secret is configured and dev bypass is disabled -> HTTP 503.
    - If no secret is configured and dev bypass is enabled -> allow (dev-only).
    - If secret is configured -> require constant-time match, else HTTP 401.
    """
    configured = _configured_internal_secrets()
    if not configured:
        if is_dev_webhook_bypass_enabled():
            logger.warning("Internal webhook secret unconfigured; allowing request under explicit dev bypass.")
            return
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Internal webhook/cron secret is not configured.",
        )

    candidate = (provided_secret or "").strip()
    if not candidate:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing internal webhook/cron secret header.",
        )

    matched = False
    for secret in configured:
        if _constant_time_equal(candidate, secret):
            matched = True

    if not matched:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal webhook/cron secret.",
        )


async def require_internal_secret(
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
    x_cron_secret: Optional[str] = Header(None, alias="X-Cron-Secret"),
) -> None:
    """FastAPI dependency protecting /hooks/* and /cron/* routes."""
    provided = x_webhook_secret if (x_webhook_secret and x_webhook_secret.strip()) else x_cron_secret
    verify_internal_secret(provided)


def validate_embed_url(embed_type: Optional[str], embed_url: Optional[str]) -> Optional[str]:
    """Validate an embed URL against strict HTTPS and per-platform hostname allowlists.

    Returns sanitized HTTPS URL or None if disallowed (fail-closed against XSS).
    """
    if not embed_type or embed_type == "none" or not embed_url or not isinstance(embed_url, str):
        return None

    allowed_hosts = EMBED_ALLOWED_HOSTS.get(embed_type)
    if not allowed_hosts:
        return None

    candidate = embed_url.strip()
    if not candidate or _has_disallowed_url_chars(candidate):
        return None

    lowered = candidate.lower()
    if lowered.startswith(("javascript:", "data:", "vbscript:")):
        return None

    try:
        parsed = urllib.parse.urlparse(candidate)
    except Exception:
        return None

    if parsed.scheme.lower() != "https":
        return None
    if parsed.username or parsed.password:
        return None

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return None

    if embed_type in _EXACT_ONLY_EMBED_TYPES:
        host_ok = hostname in allowed_hosts
    else:
        host_ok = any(hostname == allowed or hostname.endswith(f".{allowed}") for allowed in allowed_hosts)
    if not host_ok:
        return None

    # Platform-specific embed path checks & traversal guard
    path = parsed.path or "/"
    if ".." in path.split("/"):
        return None
    if embed_type == "youtube" and not path.startswith("/embed/"):
        return None
    if embed_type == "tiktok" and not (path.startswith("/embed/") or path.startswith("/player/v1/")):
        return None
    if embed_type == "vimeo" and not path.startswith("/video/"):
        return None
    if embed_type == "spotify" and not path.startswith("/embed/"):
        return None
    if embed_type == "x" and not path.startswith("/embed/"):
        return None
    if embed_type == "facebook" and not path.startswith("/plugins/"):
        return None
    if embed_type == "instagram" and not re.match(r"^/(?:p|reel|tv)/[A-Za-z0-9_-]+/embed/?$", path):
        return None

    return candidate


META_CRAWLER_USER_AGENT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
_META_CRAWLER_DOMAINS = ("facebook.com", "fb.watch", "instagram.com", "fbsbx.com")
_FB_VIDEO_UA_PATH_RE = re.compile(r"(?:^|/)(?:watch|videos|reel|reels|share/[vr])(?:/|$)", re.IGNORECASE)


def is_meta_crawler_ua_enabled() -> bool:
    """Return True only when ALLOW_META_CRAWLER_UA is explicitly opted in via environment."""
    return os.getenv("ALLOW_META_CRAWLER_UA", "false").strip().lower() in ("1", "true", "yes", "on")


def _should_use_meta_crawler_ua(url: str, cur_host: str) -> bool:
    if not is_meta_crawler_ua_enabled() or not _host_matches(cur_host, _META_CRAWLER_DOMAINS):
        return False
    if _host_matches(cur_host, ("facebook.com",)) and cur_host not in ("l.facebook.com", "lm.facebook.com"):
        parsed = urllib.parse.urlparse(url)
        path = parsed.path or ""
        qs = urllib.parse.parse_qs(parsed.query or "")
        # Facebook post/group/share/p pages return all 5 full-res viewer_image URLs & full Comet caption
        # when fetched with standard browser navigation headers + USER_AGENT, whereas facebookexternalhit
        # strips the multi-photo Comet gallery down to a single og:image.
        if not _FB_VIDEO_UA_PATH_RE.search(path) and not qs.get("v"):
            return False
    return True


async def stream_fetch_limited(
    url: str,
    max_bytes: int,
    reject_on_oversize: bool = False,
    check_content_type: Optional[Callable[[str], None]] = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    max_redirects: int = 5,
    force_meta_crawler_ua: bool = False,
) -> Tuple[int, str, bytes, str]:
    """Stream HTTP GET with per-hop SSRF validation and bounded memory accumulation."""
    if not sanitize_external_url(url):
        raise ValueError(f"SSRF Alert: Unsafe external URL '{redact_secrets_in_text(url)}'.")
    current_url = await asyncio.to_thread(validate_safe_url, url)

    async with httpx.AsyncClient(timeout=timeout_sec, follow_redirects=False) as client:
        for _ in range(max_redirects + 1):
            cur_host = (urllib.parse.urlparse(current_url).hostname or "").lower()
            cur_path = urllib.parse.urlparse(current_url).path or ""
            use_meta_ua = (
                (force_meta_crawler_ua and is_meta_crawler_ua_enabled() and _host_matches(cur_host, _META_CRAWLER_DOMAINS))
                or _should_use_meta_crawler_ua(current_url, cur_host)
            )
            custom_meta_ua = os.getenv("META_CRAWLER_USER_AGENT", "").strip() or META_CRAWLER_USER_AGENT
            req_headers = {
                "User-Agent": custom_meta_ua if use_meta_ua else USER_AGENT,
                "Accept-Language": "th,en-US;q=0.9,en;q=0.8",
            }
            if _host_matches(cur_host, ("facebook.com",)) and cur_path.startswith("/plugins/"):
                req_headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                req_headers["Sec-Fetch-Dest"] = "iframe"
                req_headers["Sec-Fetch-Mode"] = "navigate"
                req_headers["Sec-Fetch-Site"] = "cross-site"
            elif _host_matches(cur_host, ("facebook.com",)) and check_content_type is None and not use_meta_ua:
                req_headers["Accept"] = (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                )
                req_headers["Sec-Fetch-Dest"] = "document"
                req_headers["Sec-Fetch-Mode"] = "navigate"
                req_headers["Sec-Fetch-Site"] = "none"
                req_headers["Sec-Fetch-User"] = "?1"
                req_headers["Upgrade-Insecure-Requests"] = "1"
            if _host_matches(cur_host, ("youtube.com", "youtu.be")):
                req_headers["Cookie"] = "CONSENT=YES+cb; SOCS=CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg"
            async with client.stream("GET", current_url, headers=req_headers) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location") or resp.headers.get("Location")
                    if not location:
                        ct = (resp.headers.get("content-type") or resp.headers.get("Content-Type") or "").strip()
                        return int(resp.status_code), ct, b"", current_url
                    next_url = urllib.parse.urljoin(current_url, location)
                    if not sanitize_external_url(next_url):
                        raise ValueError("SSRF Alert: Redirect target is unsafe.")
                    current_url = await asyncio.to_thread(validate_safe_url, next_url)
                    continue

                content_type = (
                    resp.headers.get("content-type") or resp.headers.get("Content-Type") or ""
                ).strip()
                if check_content_type is not None and resp.status_code == 200:
                    check_content_type(content_type)

                content_length = resp.headers.get("content-length") or resp.headers.get("Content-Length")
                if reject_on_oversize and content_length:
                    try:
                        if int(content_length) > max_bytes:
                            raise ValueError(
                                f"Response Content-Length {content_length} exceeds {max_bytes} byte limit."
                            )
                    except ValueError as exc:
                        if "exceeds" in str(exc):
                            raise

                buf = bytearray()
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    if not chunk:
                        continue
                    remaining = max_bytes - len(buf)
                    if len(chunk) > remaining:
                        if reject_on_oversize:
                            raise ValueError(f"Response body exceeds {max_bytes} byte limit.")
                        if remaining > 0:
                            buf.extend(chunk[:remaining])
                        break
                    buf.extend(chunk)

                final_url = str(getattr(resp, "url", "") or current_url)
                return int(resp.status_code), content_type, bytes(buf), final_url

    raise ValueError(f"Exceeded maximum redirects ({max_redirects}).")


def extract_safe_iframe_src(raw_html: Optional[str], embed_type: str) -> Optional[str]:
    """Extract an iframe src attribute safely from oEmbed HTML and validate against allowlist."""
    if not raw_html or not isinstance(raw_html, str):
        return None

    src_candidate: Optional[str] = None
    if HTMLParser is not None:
        try:
            tree = HTMLParser(raw_html)
            iframe = tree.css_first("iframe")
            if iframe is not None:
                src_candidate = iframe.attributes.get("src")
        except Exception:
            src_candidate = None

    if not src_candidate:
        match = _IFRAME_SRC_RE.search(raw_html)
        if match:
            src_candidate = match.group(1)

    return validate_embed_url(embed_type, src_candidate)


class SlidingWindowRateLimiter:
    """Thread-safe per-key sliding-window rate limiter backed by collections.deque."""

    def __init__(
        self,
        max_requests: int,
        window_seconds: int,
        clock: Optional[Callable[[], float]] = None,
        name: str = "rate_limiter",
    ) -> None:
        if max_requests < 1 or window_seconds < 1:
            raise ValueError("max_requests and window_seconds must be positive integers.")
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._clock = clock or time.monotonic
        self.name = name
        self._buckets: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def set_clock(self, clock: Optional[Callable[[], float]]) -> None:
        """Override monotonic clock (intended for deterministic tests)."""
        with self._lock:
            self._clock = clock or time.monotonic

    def reset(self) -> None:
        """Clear all rate-limit counters."""
        with self._lock:
            self._buckets.clear()

    def check(self, key: str) -> Tuple[bool, int]:
        """Attempt to consume 1 slot for `key`. Returns (allowed, retry_after_seconds)."""
        now = float(self._clock())
        cutoff = now - self.window_seconds
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = deque()
                self._buckets[key] = bucket

            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= self.max_requests:
                oldest = bucket[0]
                retry_after = max(1, int(self.window_seconds - (now - oldest)) + 1)
                return False, retry_after

            bucket.append(now)
            # Opportunistic cleanup for stale empty keys
            if len(self._buckets) > 4096:
                stale = [k for k, q in self._buckets.items() if not q or q[-1] <= cutoff]
                for k in stale:
                    self._buckets.pop(k, None)
            return True, 0

    def enforce(self, key: str) -> None:
        """Enforce rate limit or raise HTTP 429 Too Many Requests with Retry-After header."""
        allowed, retry_after = self.check(key)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({self.max_requests} requests per {self.window_seconds}s).",
                headers={"Retry-After": str(retry_after)},
            )
