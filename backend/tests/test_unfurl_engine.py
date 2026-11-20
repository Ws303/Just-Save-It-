"""Comprehensive hermetic unit and API tests for Just-Save-It Rich Unfurl Engine (Part 2).

Validates Acceptance Criteria C1 - C4:
- C1: Zero-token Platform Matrix (YouTube, TikTok, Vimeo, Spotify, Reddit, X, Instagram, Facebook)
      & Generic Web (TIS-620/CP874/UTF-8 decoding, <=3MB guard, SSRF redirect guard, 0 LLM calls)
- C2: Image Junk Filter, <=5 Hard Cap, Cover #1 WebP resize/compression (<=800px, <120KB), & Graceful Degrade
- C3: Embed Security Allowlist (XSS prevention) & Cross-User 7-Day Cache
- C4: Endpoints, Constant-Time Shared Secret, Retry Cron (max 3 attempts), & Sliding-Window Rate Limits
"""

import ast
import copy
from datetime import datetime, timedelta, timezone
from io import BytesIO
import ipaddress
from pathlib import Path
import socket
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import httpx
import jwt
from PIL import Image, ImageDraw
import pytest
from fastapi.testclient import TestClient

import Ai.llm_client as ai_llm_client
from Database.client import set_override_supabase_client
from Database.text_hygiene import compute_url_hash
from Unfurl.extractors import (
    MAX_HTML_BYTES,
    UnfurlResult,
    _fetch_limited_response,
    extract_unfurl_metadata,
    filter_and_cap_images,
    is_junk_image_url,
)
from Unfurl.router import preview_rate_limiter, refresh_rate_limiter
from Unfurl.security import extract_safe_iframe_src, validate_embed_url
from Unfurl.service import _sanitize_cached_payload, enrich_item
from Unfurl.webp_storage import MAX_WEBP_BYTES, compress_image_to_webp, process_and_upload_cover
from main import app

JWT_TEST_SECRET = "super-secret-jwt-key-for-unfurl-tests-0123456789"
UNFURL_SRC_DIR = Path(__file__).resolve().parents[1] / "Unfurl"
_REAL_HTTPX_ASYNC_CLIENT = httpx.AsyncClient


# =====================================================================
# Hermetic In-Memory DB, Storage & Auth Helpers (Local to this module)
# =====================================================================


class MockStorageBucket:
    def __init__(self, storage: "MockStorage", bucket_name: str):
        self._storage = storage
        self._bucket_name = bucket_name

    def upload(self, path: str, file_bytes: bytes, file_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self._storage.fail_on_upload is not None:
            raise self._storage.fail_on_upload
        self._storage.uploads.append(
            {
                "bucket": self._bucket_name,
                "path": path,
                "data": bytes(file_bytes),
                "options": dict(file_options or {}),
            }
        )
        return {"path": path}

    def get_public_url(self, path: str) -> str:
        return f"https://storage.example.com/storage/v1/object/public/{self._bucket_name}/{path}"


class MockStorage:
    def __init__(self) -> None:
        self.uploads: List[Dict[str, Any]] = []
        self.fail_on_upload: Optional[Exception] = None

    def from_(self, bucket_name: str) -> MockStorageBucket:
        return MockStorageBucket(self, bucket_name)


class TableProxy:
    def __init__(self, data_list: List[Dict[str, Any]]):
        self._data = data_list
        self._filters: Dict[str, Any] = {}
        self._lt_filters: Dict[str, Any] = {}
        self._in_filters: Dict[str, set] = {}
        self._not_null_filters: set = set()
        self._limit: Optional[int] = None
        self._action = "select"

    def select(self, cols="*"):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def lt(self, col, val):
        self._lt_filters[col] = val
        return self

    def ilike(self, col, val):
        self._filters[col] = val
        return self

    def in_(self, col, val_list):
        self._in_filters[col] = set(val_list)
        return self

    @property
    def not_(self):
        return self

    def is_(self, col, val):
        if val == "null":
            self._not_null_filters.add(col)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, payload):
        if isinstance(payload, dict):
            new_item = dict(payload)
            is_compound = ("item_id" in new_item and "tag_id" in new_item) or (
                "folder_id" in new_item and "user_id" in new_item
            )
            if "id" not in new_item and "token" not in new_item and not is_compound:
                new_item["id"] = str(uuid.uuid4())
            self._data.append(new_item)
            self._last_inserted = new_item
        return self

    def update(self, updates):
        self._pending_updates = dict(updates)
        return self

    def delete(self):
        self._action = "delete"
        return self

    def _matches(self, item: Dict[str, Any]) -> bool:
        for k, v in self._filters.items():
            if item.get(k) != v:
                return False
        for k, v in self._lt_filters.items():
            cur = item.get(k)
            if cur is None or not (cur < v):
                return False
        for k, v_set in self._in_filters.items():
            if item.get(k) not in v_set:
                return False
        for k in self._not_null_filters:
            v = item.get(k)
            if v is None or v == "":
                return False
        return True

    def execute(self):
        if hasattr(self, "_last_inserted"):
            res = MagicMock(data=[dict(self._last_inserted)])
            del self._last_inserted
            return res

        if hasattr(self, "_pending_updates"):
            updates = self._pending_updates
            del self._pending_updates
            updated = []
            for item in self._data:
                if self._matches(item):
                    item.update(updates)
                    updated.append(dict(item))
            return MagicMock(data=updated)

        if getattr(self, "_action", None) == "delete":
            self._action = "select"
            remaining = []
            deleted = []
            for item in self._data:
                if self._matches(item):
                    deleted.append(dict(item))
                else:
                    remaining.append(item)
            self._data.clear()
            self._data.extend(remaining)
            return MagicMock(data=deleted)

        filtered = [dict(item) for item in self._data if self._matches(item)]
        if self._limit is not None:
            filtered = filtered[: self._limit]
        return MagicMock(data=filtered)


class InMemoryDB:
    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {
            "profiles": [],
            "folders": [],
            "folder_members": [],
            "folder_invites": [],
            "items": [],
            "tags": [],
            "item_tags": [],
            "reminders": [],
            "devices": [],
            "daily_ai_usage": [],
            "api_tokens": [],
        }
        self.storage = MockStorage()

    def table(self, name: str) -> TableProxy:
        return TableProxy(self.tables.setdefault(name, []))


class MockHttpRecorder:
    """Deterministic MockTransport controller recording every outbound AsyncClient request."""

    def __init__(self) -> None:
        self.requests: List[str] = []
        self._handler: Callable[[httpx.Request], httpx.Response] = self._default_handler

    @staticmethod
    def _default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="Not mocked", request=request)

    def set_handler(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self._handler = handler

    def clear_requests(self) -> None:
        self.requests.clear()

    def dispatch(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(str(request.url))
        return self._handler(request)


def make_jwt(
    user_id: str,
    secret: str = JWT_TEST_SECRET,
    aud: str = "authenticated",
    exp_offset_sec: int = 3600,
) -> str:
    now_ts = int(datetime.now(timezone.utc).timestamp())
    payload = {
        "sub": user_id,
        "aud": aud,
        "exp": now_ts + exp_offset_sec,
        "iat": now_ts,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def make_auth_headers(user_id: str = "usr-unfurl-1", secret: str = JWT_TEST_SECRET) -> Dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt(user_id, secret=secret)}"}


def make_gradient_noise_jpeg_bytes(width: int = 2400, height: int = 1600) -> bytes:
    """Generate a deterministic 2400x1600 gradient + subtle noise JPEG image in memory."""
    base_w, base_h = 300, 200
    base = Image.new("RGB", (base_w, base_h))
    draw = ImageDraw.Draw(base)
    for y in range(base_h):
        r = int(255 * y / max(1, base_h - 1))
        g = int(180 * (1 - y / max(1, base_h - 1)))
        b = 140
        draw.line([(0, y), (base_w - 1, y)], fill=(r, g, b))
    draw.rectangle([40, 30, 140, 110], fill=(30, 90, 200))
    draw.ellipse([160, 70, 260, 170], fill=(240, 200, 40))

    noise_small = Image.effect_noise((base_w, base_h), 18).convert("RGB")
    blended_small = Image.blend(base, noise_small, alpha=0.18)
    full_img = blended_small.resize((width, height), Image.Resampling.BICUBIC)

    buf = BytesIO()
    full_img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _hermetic_getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> List[Any]:
    """Return public IP for non-local hostnames while preserving IP literals and localhost checks."""
    host_str = str(host).strip("[]")
    try:
        ip_obj: Optional[ipaddress._BaseAddress] = ipaddress.ip_address(host_str)
    except ValueError:
        ip_obj = None

    if ip_obj is not None:
        family = socket.AF_INET6 if ip_obj.version == 6 else socket.AF_INET
        sockaddr = (str(ip_obj), 0, 0, 0) if ip_obj.version == 6 else (str(ip_obj), 0)
        return [(family, socket.SOCK_STREAM, 6, "", sockaddr)]

    lowered = host_str.lower()
    if lowered in ("localhost", "localhost.localdomain") or lowered.endswith((".local", ".internal")):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    return [(2, 1, 6, "", ("93.184.216.34", 0))]


@pytest.fixture(autouse=True)
def hermetic_isolation(monkeypatch):
    """Enforce zero network access, clean env vars, rate-limiter reset, and DB override reset."""
    preview_rate_limiter.reset()
    preview_rate_limiter.set_clock(None)
    refresh_rate_limiter.reset()
    refresh_rate_limiter.set_clock(None)
    set_override_supabase_client(None)

    for env_key in (
        "INTERNAL_WEBHOOK_SECRET",
        "WEBHOOK_SECRET",
        "CRON_SHARED_SECRET",
        "ENV",
        "ALLOW_DEV_WEBHOOK_BYPASS",
        "ALLOW_DEV_AUTH_BYPASS",
        "ALLOW_META_CRAWLER_UA",
        "META_CRAWLER_USER_AGENT",
        "META_OEMBED_ACCESS_TOKEN",
        "SUPABASE_JWT_SECRET",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_STORAGE_BUCKET",
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
    ):
        monkeypatch.delenv(env_key, raising=False)

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "false")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "false")
    monkeypatch.setattr(socket, "getaddrinfo", _hermetic_getaddrinfo)

    recorder = MockHttpRecorder()
    transport = httpx.MockTransport(recorder.dispatch)

    class _PatchedAsyncClient(_REAL_HTTPX_ASYNC_CLIENT):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _PatchedAsyncClient)

    yield recorder

    preview_rate_limiter.reset()
    preview_rate_limiter.set_clock(None)
    refresh_rate_limiter.reset()
    refresh_rate_limiter.set_clock(None)
    set_override_supabase_client(None)


@pytest.fixture
def mock_db():
    db = InMemoryDB()
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


@pytest.fixture
def test_client(mock_db, monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", JWT_TEST_SECRET)
    with TestClient(app) as client:
        yield client


# =====================================================================
# C1: 0-Token Platform & Generic Unfurl
# =====================================================================


@pytest.mark.asyncio
async def test_c1_youtube_canonical_oembed_and_embed_fallback(hermetic_isolation):
    """C1: YouTube strips tracking params, extracts oEmbed title/thumb, and validates embed URL."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.youtube.com" and request.url.path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "title": "Rick Astley - Never Gonna Give You Up",
                    "author_name": "Rick Astley",
                    "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
                    "html": '<iframe width="200" height="113" src="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"></iframe>',
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x")
    assert res.canonical_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert res.url_hash == compute_url_hash("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert res.platform == "youtube"
    assert res.content_type == "video"
    assert res.site_name == "YouTube"
    assert res.title == "Rick Astley - Never Gonna Give You Up"
    assert res.description == "By Rick Astley"
    assert res.embed_type == "youtube"
    assert res.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"
    assert "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" in res.media_items

    # Verify fallback to deterministic https://www.youtube.com/embed/{id} if oEmbed omits/spoofs iframe
    def spoofed_oembed_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.youtube.com" and request.url.path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "title": "Video With Spoofed Embed",
                    "author_name": "Channel",
                    "html": '<iframe src="https://evil.com/youtube.com/embed/dQw4w9WgXcQ"></iframe>',
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(spoofed_oembed_handler)
    fallback_res = await extract_unfurl_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x")
    assert fallback_res.embed_type == "youtube"
    assert fallback_res.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ"


@pytest.mark.asyncio
async def test_c1_tiktok_vimeo_spotify_oembed_unfurl(hermetic_isolation):
    """C1: TikTok, Vimeo, and Spotify zero-token oEmbed extraction and embed URL resolution."""
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        path = request.url.path
        if host == "www.tiktok.com" and path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "title": "Morning Coffee Routine",
                    "author_name": "barista_th",
                    "thumbnail_url": "https://p16-sign.tiktokcdn-us.com/cover_7123.jpg",
                    "html": '<blockquote class="tiktok-embed" data-video-id="7123456789012345678"></blockquote>',
                },
                request=request,
            )
        if host == "vimeo.com" and path == "/api/oembed.json":
            return httpx.Response(
                200,
                json={
                    "title": "Mountain Timelapse 4K",
                    "description": "Shot across the Alps",
                    "video_id": 76979871,
                    "thumbnail_url": "https://i.vimeocdn.com/video/76979871-640x360.jpg",
                    "html": '<iframe src="https://player.vimeo.com/video/76979871?h=abc123"></iframe>',
                },
                request=request,
            )
        if host == "open.spotify.com" and path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "title": "Midnight City - M83",
                    "thumbnail_url": "https://i.scdn.co/image/ab67616d0000b273a1b2c3d4",
                    "iframe_url": "https://open.spotify.com/embed/track/6GyFP1nfCDB8lbD2bG0Hq9?utm_source=oembed",
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    tt = await extract_unfurl_metadata(
        "https://www.tiktok.com/@barista_th/video/7123456789012345678?is_from_webapp=1&sender_device=pc"
    )
    assert tt.canonical_url == "https://www.tiktok.com/@barista_th/video/7123456789012345678"
    assert tt.platform == "tiktok"
    assert tt.content_type == "video"
    assert tt.title == "Morning Coffee Routine"
    assert tt.description == "@barista_th"
    assert tt.embed_type == "tiktok"
    assert tt.embed_url == "https://www.tiktok.com/embed/v2/7123456789012345678"
    assert tt.image_url == "https://p16-sign.tiktokcdn-us.com/cover_7123.jpg"

    vm = await extract_unfurl_metadata("https://vimeo.com/76979871")
    assert vm.platform == "vimeo"
    assert vm.content_type == "video"
    assert vm.title == "Mountain Timelapse 4K"
    assert vm.description == "Shot across the Alps"
    assert vm.embed_type == "vimeo"
    assert vm.embed_url == "https://player.vimeo.com/video/76979871?h=abc123"

    sp = await extract_unfurl_metadata("https://open.spotify.com/track/6GyFP1nfCDB8lbD2bG0Hq9?si=share123")
    assert sp.canonical_url == "https://open.spotify.com/track/6GyFP1nfCDB8lbD2bG0Hq9"
    assert sp.platform == "spotify"
    assert sp.title == "Midnight City - M83"
    assert sp.embed_type == "spotify"
    assert sp.embed_url == "https://open.spotify.com/embed/track/6GyFP1nfCDB8lbD2bG0Hq9?utm_source=oembed"


@pytest.mark.asyncio
async def test_c1_reddit_json_gallery_cap_and_html_unescape(hermetic_isolation):
    """C1: Reddit .json gallery extracts <=5 images and unescapes &amp; entities in URLs & text."""
    gallery_items = [{"media_id": f"img{i}"} for i in range(1, 8)]
    media_metadata = {
        f"img{i}": {
            "s": {
                "u": f"https://preview.redd.it/gallery_{i}.jpg?width=1080&amp;format=pjpg&amp;auto=webp&amp;s=abc{i}"
            }
        }
        for i in range(1, 8)
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.reddit.com" and request.url.path.endswith(".json"):
            return httpx.Response(
                200,
                json=[
                    {
                        "data": {
                            "children": [
                                {
                                    "data": {
                                        "title": "Chiang Mai Sunrise &amp; Doi Suthep",
                                        "selftext": "Captured at dawn &amp; graded in Lightroom",
                                        "subreddit_name_prefixed": "r/Thailand",
                                        "permalink": "/r/Thailand/comments/xyz999/chiang_mai_sunrise/",
                                        "is_video": False,
                                        "gallery_data": {"items": gallery_items},
                                        "media_metadata": media_metadata,
                                    }
                                }
                            ]
                        }
                    }
                ],
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://www.reddit.com/r/Thailand/comments/xyz999/chiang_mai_sunrise/")
    assert res.platform == "reddit"
    assert res.content_type == "post"
    assert res.title == "Chiang Mai Sunrise & Doi Suthep"
    assert res.description == "Captured at dawn & graded in Lightroom"
    assert len(res.media_items) == 5
    for idx, img_url in enumerate(res.media_items, start=1):
        assert "&amp;" not in img_url
        assert f"gallery_{idx}.jpg?width=1080&format=pjpg&auto=webp&s=abc{idx}" in img_url
    assert res.embed_type == "reddit"
    assert res.embed_url == (
        "https://www.redditmedia.com/r/Thailand/comments/xyz999/chiang_mai_sunrise/?ref_source=embed&ref=share&embed=true"
    )


@pytest.mark.asyncio
async def test_c1_x_oembed_extracts_text_no_raw_html_and_embed_url(hermetic_isolation):
    """C1: X extractor pulls tweet text via selectolax, stores zero raw HTML, and builds platform.twitter.com embed."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "publish.twitter.com" and request.url.path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "author_name": "Ada Lovelace",
                    "html": (
                        '<blockquote class="twitter-tweet">'
                        '<p lang="en" dir="ltr">Zero-token unfurl engine &amp; deterministic tests shipped!</p>'
                        "&mdash; Ada (@ada)</blockquote>"
                        '<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>'
                    ),
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://x.com/ada/status/1800000000000000001?utm_source=share")
    assert res.platform == "x"
    assert res.content_type == "post"
    assert res.site_name == "X"
    assert res.description == "Zero-token unfurl engine & deterministic tests shipped!"
    assert res.title == "Ada Lovelace: Zero-token unfurl engine & deterministic tests shipped!"
    assert "<blockquote" not in (res.title or "")
    assert "<blockquote" not in (res.description or "")
    assert "<script" not in (res.description or "")
    assert not hasattr(res, "html")
    assert not hasattr(res, "raw_html")
    assert res.embed_type == "x"
    assert res.embed_url == "https://platform.twitter.com/embed/Tweet.html?id=1800000000000000001"


@pytest.mark.asyncio
async def test_c1_instagram_and_facebook_meta_token_and_og_fallback(hermetic_isolation, monkeypatch):
    """C1: Instagram & Facebook support META_OEMBED_ACCESS_TOKEN and gracefully fall back to og:* without token."""
    def token_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.facebook.com" and request.url.path == "/v18.0/instagram_oembed":
            assert request.url.params.get("access_token") == "meta-live-token-xyz"
            return httpx.Response(
                200,
                json={
                    "title": "IG Reel From Meta Graph",
                    "thumbnail_url": "https://scontent.cdninstagram.com/reel_cover_1080.jpg",
                },
                request=request,
            )
        if request.url.host == "graph.facebook.com" and request.url.path == "/v18.0/oembed_post":
            assert request.url.params.get("access_token") == "meta-live-token-xyz"
            return httpx.Response(
                200,
                json={
                    "author_name": "Engineering Blog FB",
                    "thumbnail_url": "https://scontent.xx.fbcdn.net/fb_post_cover.jpg",
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(token_handler)
    monkeypatch.setenv("META_OEMBED_ACCESS_TOKEN", "meta-live-token-xyz")

    ig_token = await extract_unfurl_metadata("https://www.instagram.com/reel/CxYz12345/?igsh=tracking")
    assert ig_token.platform == "instagram"
    assert ig_token.content_type == "video"
    assert ig_token.title == "IG Reel From Meta Graph"
    assert ig_token.image_url == "https://scontent.cdninstagram.com/reel_cover_1080.jpg"
    assert ig_token.embed_type == "instagram"
    assert ig_token.embed_url == "https://www.instagram.com/reel/CxYz12345/embed"

    fb_token = await extract_unfurl_metadata("https://www.facebook.com/page/posts/987654321?fbclid=track")
    assert fb_token.platform == "facebook"
    assert fb_token.content_type == "post"
    assert fb_token.title == "Engineering Blog FB"
    assert fb_token.image_url == "https://scontent.xx.fbcdn.net/fb_post_cover.jpg"
    assert fb_token.embed_type == "facebook"
    assert fb_token.embed_url.startswith("https://www.facebook.com/plugins/post.php?href=")

    # Now clear token -> must NOT call graph.facebook.com, and must fall back to og:* HTML meta
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    hermetic_isolation.clear_requests()

    def og_fallback_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.instagram.com":
            html = (
                "<html><head>"
                '<meta property="og:title" content="IG Post via OG Fallback">'
                '<meta property="og:description" content="Fallback caption text">'
                '<meta property="og:image" content="https://scontent.cdninstagram.com/ig_og_fallback.jpg">'
                "</head></html>"
            )
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        if request.url.host == "www.facebook.com":
            html = (
                "<html><head>"
                '<meta property="og:title" content="FB Post via OG Fallback">'
                '<meta property="og:description" content="FB fallback summary">'
                '<meta property="og:image" content="https://scontent.xx.fbcdn.net/fb_og_fallback.jpg">'
                "</head></html>"
            )
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(og_fallback_handler)

    ig_og = await extract_unfurl_metadata("https://www.instagram.com/p/AbCdEf123/")
    assert ig_og.title == "IG Post via OG Fallback"
    assert ig_og.description == "Fallback caption text"
    assert ig_og.image_url == "https://scontent.cdninstagram.com/ig_og_fallback.jpg"
    assert ig_og.embed_url == "https://www.instagram.com/p/AbCdEf123/embed"

    fb_og = await extract_unfurl_metadata("https://www.facebook.com/page/posts/555666777")
    assert fb_og.title == "FB Post via OG Fallback"
    assert fb_og.description == "FB fallback summary"
    assert fb_og.image_url == "https://scontent.xx.fbcdn.net/fb_og_fallback.jpg"
    assert all("graph.facebook.com" not in url for url in hermetic_isolation.requests)


@pytest.mark.asyncio
async def test_c1_generic_web_tis620_cp874_and_utf8_zero_mojibake(hermetic_isolation):
    """C1: Generic HTML via selectolax decodes TIS-620/CP874 and UTF-8 Thai bytes with zero mojibake."""
    thai_title = "ข่าวเทคโนโลยีไทยประจำวัน มอก. 620"
    thai_desc = "สรุปข่าวภาษาไทยพร้อมวรรณยุกต์ครบถ้วน ่ ้ ๊ ๋ ั ิ"
    tis620_html = (
        "<!DOCTYPE html><html><head>"
        '<meta http-equiv="Content-Type" content="text/html; charset=tis-620">'
        f'<meta property="og:title" content="{thai_title}">'
        f'<meta property="og:description" content="{thai_desc}">'
        '<meta property="og:image" content="https://news.example.th/images/lead.jpg">'
        "</head><body><article><p>เนื้อหาข่าวภาษาไทย</p></article></body></html>"
    )
    tis620_bytes = tis620_html.encode("cp874")

    utf8_title = "คู่มือ Python สำหรับนักพัฒนา 🚀"
    utf8_desc = "บทความภาษาไทยผสมอิโมจิ 👨‍👩‍👧‍👦 และโค้ด"
    utf8_html = (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8">'
        f"<title>{utf8_title}</title>"
        f'<meta name="description" content="{utf8_desc}">'
        "</head><body></body></html>"
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/tis620":
            # Intentionally simulate legacy server claiming iso-8859-1 while body is cp874 + <meta charset=tis-620>
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html; charset=iso-8859-1"},
                content=tis620_bytes,
                request=request,
            )
        if request.url.path == "/cp874-header":
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html; charset=windows-874"},
                content=tis620_bytes,
                request=request,
            )
        if request.url.path == "/utf8":
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html; charset=utf-8"},
                content=utf8_html,
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res_tis = await extract_unfurl_metadata("https://news.example.th/tis620")
    assert res_tis.title == thai_title
    assert res_tis.description == thai_desc
    assert "\ufffd" not in res_tis.title
    assert "\ufffd" not in (res_tis.description or "")

    res_cp874 = await extract_unfurl_metadata("https://news.example.th/cp874-header")
    assert res_cp874.title == thai_title
    assert res_cp874.description == thai_desc

    res_utf8 = await extract_unfurl_metadata("https://blog.example.th/utf8")
    assert res_utf8.title == utf8_title
    assert res_utf8.description == utf8_desc


@pytest.mark.asyncio
async def test_c1_generic_web_3mb_body_guard_extracts_head(hermetic_isolation):
    """C1: Payloads >3.2MB are sliced safely to <=3MB and still extract <head> metadata."""
    head_html = (
        "<!DOCTYPE html><html><head>"
        '<meta property="og:title" content="Oversized Page Title">'
        '<meta property="og:description" content="Extracted cleanly from head before 3MB cutoff.">'
        '<meta property="og:image" content="https://cdn.example.com/oversized-cover.jpg">'
        "</head><body>"
    ).encode("utf-8")
    padding = b"<p>Padding payload block.</p>" * 130_000  # > 3.5 MB
    tail_html = b"</body></html>"
    full_payload = head_html + padding + tail_html
    assert len(full_payload) > MAX_HTML_BYTES + 200_000

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            content=full_payload,
            request=request,
        )

    hermetic_isolation.set_handler(handler)

    status_code, _, body_bytes, _ = await _fetch_limited_response("https://heavy.example.com/huge-article")
    assert status_code == 200
    assert len(body_bytes) == MAX_HTML_BYTES

    res = await extract_unfurl_metadata("https://heavy.example.com/huge-article")
    assert res.title == "Oversized Page Title"
    assert res.description == "Extracted cleanly from head before 3MB cutoff."
    assert res.image_url == "https://cdn.example.com/oversized-cover.jpg"


@pytest.mark.asyncio
async def test_c1_ssrf_redirect_and_private_dns_blocked(hermetic_isolation, monkeypatch):
    """C1: SSRF guard rejects 302 -> AWS metadata IP 169.254.169.254, IP literals, and private DNS."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "redirector.example.com":
            return httpx.Response(
                302,
                headers={"Location": "http://169.254.169.254/latest/meta-data"},
                request=request,
            )
        return httpx.Response(200, text="<html><title>Should Not Reach</title></html>", request=request)

    hermetic_isolation.set_handler(handler)

    with pytest.raises(ValueError, match="SSRF Alert"):
        await extract_unfurl_metadata("https://redirector.example.com/go")

    # Confirm no HTTP request was ever sent to 169.254.169.254
    assert all("169.254.169.254" not in req_url for req_url in hermetic_isolation.requests)

    # Real private/loopback IP literal checks
    for unsafe_url in (
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/internal",
        "http://192.168.1.1/router",
        "file:///etc/passwd",
    ):
        with pytest.raises(ValueError):
            await extract_unfurl_metadata(unsafe_url)

    # Mocked private DNS resolution check
    def private_dns_getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> List[Any]:
        if str(host).lower() == "rebind.evil.example":
            return [(2, 1, 6, "", ("10.20.30.40", 0))]
        return _hermetic_getaddrinfo(host, port, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", private_dns_getaddrinfo)
    with pytest.raises(ValueError, match="SSRF Alert"):
        await extract_unfurl_metadata("https://rebind.evil.example/article")


@pytest.mark.asyncio
async def test_c1_zero_llm_calls_and_no_llm_imports_in_unfurl(hermetic_isolation):
    """C1: Unfurl module neither imports Ai.llm_client nor invokes any LLM APIs."""
    # Static AST audit across Unfurl/*.py
    for py_file in sorted(UNFURL_SRC_DIR.glob("*.py")):
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert "llm_client" not in alias.name
                    assert alias.name not in ("google.genai", "groq", "openai")
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                assert "llm_client" not in mod
                assert not mod.startswith(("google.genai", "groq", "openai"))

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.youtube.com":
            return httpx.Response(
                200,
                json={"title": "YT No LLM", "author_name": "Author", "thumbnail_url": "https://i.ytimg.com/vi/1/hq.jpg"},
                request=request,
            )
        return httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text="<html><head><title>Generic Zero Token</title></head><body><p>Plain article body.</p></body></html>",
            request=request,
        )

    hermetic_isolation.set_handler(handler)

    with (
        patch.object(ai_llm_client, "call_builtin_llm", new=AsyncMock(side_effect=AssertionError("LLM called"))) as spy_builtin,
        patch.object(ai_llm_client, "call_byok_or_custom_llm", new=AsyncMock(side_effect=AssertionError("LLM called"))) as spy_byok,
        patch.object(ai_llm_client, "generate_structured_summary", new=AsyncMock(side_effect=AssertionError("LLM called"))) as spy_summary,
        patch.object(ai_llm_client, "_call_gemini_raw", new=AsyncMock(side_effect=AssertionError("LLM called"))) as spy_gemini,
        patch.object(ai_llm_client, "_call_openai_compatible_raw", new=AsyncMock(side_effect=AssertionError("LLM called"))) as spy_openai,
    ):
        yt = await extract_unfurl_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        web = await extract_unfurl_metadata("https://blog.example.com/post-1")
        assert yt.title == "YT No LLM"
        assert web.title == "Generic Zero Token"
        assert spy_builtin.call_count == 0
        assert spy_byok.call_count == 0
        assert spy_summary.call_count == 0
        assert spy_gemini.call_count == 0
        assert spy_openai.call_count == 0


# =====================================================================
# C2: Image Junk Filter, <=5 Hard Cap & Cover WebP
# =====================================================================


@pytest.mark.asyncio
async def test_c2_image_junk_filter_dedup_and_hard_cap_5(hermetic_isolation):
    """C2: Strip .svg, 1x1 pixels, avatar/icon/logo/banner/ads/emoji, <200px, duplicates, and cap at <=5."""
    junk_urls = [
        "https://cdn.example.com/vector.svg",
        "https://cdn.example.com/graphic?format=svg",
        "https://track.example.com/1x1.png",
        "https://track.example.com/pixel.gif",
        "https://cdn.example.com/avatar/profile.jpg",
        "https://cdn.example.com/icon/menu.png",
        "https://cdn.example.com/brand-logo.png",
        "https://cdn.example.com/top-banner.jpg",
        "https://cdn.example.com/ads/promo.jpg",
        "https://cdn.example.com/emoji/rocket.png",
        "https://cdn.example.com/small.jpg?w=100",
        "https://cdn.example.com/small-h.jpg?height=199",
    ]
    for bad in junk_urls:
        assert is_junk_image_url(bad) is True, f"Expected junk image rejected: {bad}"

    assert is_junk_image_url("https://cdn.example.com/photo.jpg", width_hint=120, height_hint=300) is True
    assert is_junk_image_url("https://cdn.example.com/photo.jpg", width_hint=800, height_hint=600) is False

    # HTML page with junk, nav/footer chrome, duplicates, and >10 valid photos
    valid_imgs = [f'<img src="https://cdn.example.com/gallery/photo_{i}.jpg?w=1200" width="1200" height="800">' for i in range(1, 13)]
    dup_imgs = [
        '<img src="https://cdn.example.com/gallery/photo_1.jpg?w=1200">',
        '<img src="https://cdn.example.com/gallery/photo_2.jpg?w=1200#section">',
    ]
    junk_html_imgs = [
        '<img src="https://cdn.example.com/diagram.svg">',
        '<img src="https://track.example.com/pixel.gif">',
        '<img src="https://cdn.example.com/avatar/user.jpg">',
        '<img src="https://cdn.example.com/icon/star.png">',
        '<img src="https://cdn.example.com/logo.png">',
        '<img src="https://cdn.example.com/banner.jpg">',
        '<img src="https://cdn.example.com/ads/box.jpg">',
        '<img src="https://cdn.example.com/emoji/wave.png">',
        '<img src="https://cdn.example.com/thumb.jpg" width="120" height="120">',
        '<img src="https://cdn.example.com/tiny.jpg?w=100">',
    ]
    html = (
        "<html><head><title>Gallery Test</title></head><body>"
        '<header><img src="https://cdn.example.com/header-hero.jpg" width="1200" height="600"></header>'
        "<article>"
        + "".join(junk_html_imgs)
        + "".join(valid_imgs)
        + "".join(dup_imgs)
        + "</article>"
        '<footer><img src="https://cdn.example.com/footer-badge.jpg" width="600" height="400"></footer>'
        "</body></html>"
    )

    hermetic_isolation.set_handler(
        lambda req: httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=req)
    )

    res = await extract_unfurl_metadata("https://gallery.example.com/album")
    assert len(res.media_items) == 5
    assert res.media_items == [
        f"https://cdn.example.com/gallery/photo_{i}.jpg?w=1200" for i in range(1, 6)
    ]
    assert res.image_url == res.media_items[0]

    # Direct filter_and_cap_images deduplication & cap test
    candidates = [
        ("https://cdn.example.com/a.jpg", 800, 600),
        ("https://cdn.example.com/a.jpg#frag", 800, 600),
        ("https://cdn.example.com/too-small.jpg", 120, 400),
        *[(f"https://cdn.example.com/p{i}.jpg", 1000, 750) for i in range(10)],
    ]
    capped = filter_and_cap_images(candidates)
    assert len(capped) == 5
    assert capped[0] == "https://cdn.example.com/a.jpg"
    assert "https://cdn.example.com/too-small.jpg" not in capped


@pytest.mark.asyncio
async def test_c2_pillow_2400x1600_webp_resize_compression_and_storage_paths(hermetic_isolation, mock_db):
    """C2: 2400x1600 JPEG compresses via Pillow to WebP <=800px, <120KB, and uploads to thumbnails/{hash}.webp."""
    raw_jpeg = make_gradient_noise_jpeg_bytes(2400, 1600)
    webp_bytes = compress_image_to_webp(raw_jpeg)

    assert webp_bytes[:4] == b"RIFF"
    assert webp_bytes[8:12] == b"WEBP"
    assert len(webp_bytes) < MAX_WEBP_BYTES

    with Image.open(BytesIO(webp_bytes)) as img:
        assert img.format == "WEBP"
        assert img.width <= 800
        assert img.width == 800
        assert img.height == 533

    # Mock HTTP download returning the 2400x1600 JPEG
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.example.com" and request.url.path == "/cover-2400.jpg":
            return httpx.Response(
                200,
                headers={"Content-Type": "image/jpeg", "Content-Length": str(len(raw_jpeg))},
                content=raw_jpeg,
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    url_hash = compute_url_hash("https://example.com/article-with-cover")
    captured_uploads: List[Dict[str, Any]] = []

    def mock_storage_uploader(path: str, data: bytes, content_type: str) -> str:
        captured_uploads.append({"path": path, "data": data, "content_type": content_type})
        return f"https://cdn.supabase.test/storage/v1/object/public/{path}"

    # 1. Explicit storage_uploader callback path
    final_url, stored = await process_and_upload_cover(
        "https://cdn.example.com/cover-2400.jpg",
        url_hash=url_hash,
        storage_uploader=mock_storage_uploader,
    )
    assert stored is True
    assert final_url == f"https://cdn.supabase.test/storage/v1/object/public/thumbnails/{url_hash}.webp"
    assert len(captured_uploads) == 1
    up = captured_uploads[0]
    assert up["path"] == f"thumbnails/{url_hash}.webp"
    assert up["content_type"] == "image/webp"
    assert up["data"][:4] == b"RIFF"
    assert up["data"][8:12] == b"WEBP"
    assert len(up["data"]) < 120 * 1024
    with Image.open(BytesIO(up["data"])) as out_img:
        assert out_img.width <= 800
        assert out_img.height == 533

    # 2. db.storage Supabase bucket path
    final_db_url, stored_db = await process_and_upload_cover(
        "https://cdn.example.com/cover-2400.jpg",
        url_hash=url_hash,
        db=mock_db,
    )
    assert stored_db is True
    assert final_db_url.endswith(f"/thumbnails/thumbnails/{url_hash}.webp")
    assert len(mock_db.storage.uploads) == 1
    db_up = mock_db.storage.uploads[0]
    assert db_up["bucket"] == "thumbnails"
    assert db_up["path"] == f"thumbnails/{url_hash}.webp"
    assert db_up["data"][:4] == b"RIFF"
    assert db_up["data"][8:12] == b"WEBP"
    assert len(db_up["data"]) < 120 * 1024


@pytest.mark.asyncio
async def test_c2_cover_webp_graceful_degrade_on_http_500_and_storage_failure(hermetic_isolation, mock_db):
    """C2: Image download 500 or Storage uploader RuntimeError gracefully degrades to external_image_url."""
    external_cover = "https://cdn.example.com/fallback-cover.jpg"
    valid_jpeg = make_gradient_noise_jpeg_bytes(1200, 800)

    # Case 1: Image download returns 500 -> process_and_upload_cover & enrich_item still succeed
    def failing_img_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "blog.example.com":
            html = (
                "<html><head>"
                '<meta property="og:title" content="Resilient Article">'
                f'<meta property="og:image" content="{external_cover}">'
                "</head></html>"
            )
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        if request.url.host == "cdn.example.com":
            return httpx.Response(500, text="Upstream image error", request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(failing_img_handler)
    url_hash = compute_url_hash("https://blog.example.com/post-500-img")

    degraded_url, stored = await process_and_upload_cover(external_cover, url_hash=url_hash, db=mock_db)
    assert stored is False
    assert degraded_url == external_cover

    item_1 = {
        "id": "item-degrade-500",
        "owner_id": "usr-1",
        "url": "https://blog.example.com/post-500-img",
        "canonical_url": "https://blog.example.com/post-500-img",
        "url_hash": url_hash,
        "title": "https://blog.example.com/post-500-img",
        "enrich_status": "pending",
        "enrich_attempts": 0,
    }
    mock_db.tables["items"].append(item_1)

    res_1 = await enrich_item(mock_db, "item-degrade-500")
    assert res_1["status"] == "ok"
    assert res_1["storage_uploaded"] is False
    assert res_1["item"]["enrich_status"] == "unfurled"
    assert res_1["item"]["title"] == "Resilient Article"
    assert res_1["item"]["image_url"] == external_cover

    # Case 2: Image download succeeds, but storage_uploader / db.storage raises RuntimeError
    def ok_img_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "blog.example.com":
            html = (
                "<html><head>"
                '<meta property="og:title" content="Storage Error Resilient">'
                f'<meta property="og:image" content="{external_cover}">'
                "</head></html>"
            )
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        if request.url.host == "cdn.example.com":
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=valid_jpeg, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(ok_img_handler)

    def broken_uploader(path: str, data: bytes, ct: str) -> str:
        raise RuntimeError("Storage bucket quota or network failure")

    degraded_storage_url, stored_2 = await process_and_upload_cover(
        external_cover,
        url_hash=url_hash,
        storage_uploader=broken_uploader,
    )
    assert stored_2 is False
    assert degraded_storage_url == external_cover

    mock_db.storage.fail_on_upload = RuntimeError("Supabase storage unavailable")
    item_2 = {
        "id": "item-degrade-storage",
        "owner_id": "usr-1",
        "url": "https://blog.example.com/post-storage-fail",
        "canonical_url": "https://blog.example.com/post-storage-fail",
        "url_hash": compute_url_hash("https://blog.example.com/post-storage-fail"),
        "title": "https://blog.example.com/post-storage-fail",
        "enrich_status": "pending",
        "enrich_attempts": 0,
    }
    mock_db.tables["items"].append(item_2)

    res_2 = await enrich_item(mock_db, "item-degrade-storage")
    assert res_2["status"] == "ok"
    assert res_2["storage_uploaded"] is False
    assert res_2["item"]["enrich_status"] == "unfurled"
    assert res_2["item"]["image_url"] == external_cover


# =====================================================================
# C3: Embed Security Allowlist (XSS Prevention) & 7-Day Cache
# =====================================================================


def test_c3_embed_allowlist_and_iframe_xss_rejection():
    """C3: Strict embed allowlist rejects XSS payloads, non-HTTPS, spoofed hosts, credentials, and non-embed paths."""
    malicious_cases = [
        ("youtube", "javascript:alert(1)"),
        ("youtube", "data:text/html,<script>alert(1)</script>"),
        ("youtube", "http://www.youtube.com/embed/dQw4w9WgXcQ"),
        ("youtube", "https://www.youtube.com/embed/dQw4w9WgXcQ<script>alert(1)</script>"),
        ("youtube", "https://evil.com/youtube.com/embed/123"),
        ("youtube", "https://youtube.com.evil.com/embed/123"),
        ("youtube", "https://youtube.com/watch?v=123"),
        ("youtube", "https://user:pass@www.youtube.com/embed/123"),
        ("tiktok", "https://www.tiktok.com/@creator/video/123456"),
        ("vimeo", "https://player.vimeo.com/76979871"),
        ("spotify", "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
        ("x", "https://evil.com/platform.twitter.com/embed/Tweet.html?id=1"),
        ("reddit", "http://www.redditmedia.com/r/python/comments/1/test/"),
        ("unknown_platform", "https://www.youtube.com/embed/dQw4w9WgXcQ"),
    ]
    for platform, bad_url in malicious_cases:
        assert validate_embed_url(platform, bad_url) is None, f"Should reject {platform}: {bad_url}"
        iframe_html = f'<iframe src="{bad_url}" width="400" height="300"></iframe>'
        assert extract_safe_iframe_src(iframe_html, platform) is None

    valid_cases = [
        ("youtube", "https://www.youtube.com/embed/dQw4w9WgXcQ"),
        ("youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
        ("tiktok", "https://www.tiktok.com/embed/v2/7123456789012345678"),
        ("vimeo", "https://player.vimeo.com/video/76979871"),
        ("spotify", "https://open.spotify.com/embed/track/6GyFP1nfCDB8lbD2bG0Hq9"),
        ("x", "https://platform.twitter.com/embed/Tweet.html?id=1800000000000000001"),
        ("reddit", "https://www.redditmedia.com/r/Thailand/comments/xyz999/test/?embed=true"),
        ("instagram", "https://www.instagram.com/reel/CxYz12345/embed"),
        ("facebook", "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Ffacebook.com%2Fpost"),
    ]
    for platform, good_url in valid_cases:
        assert validate_embed_url(platform, good_url) == good_url
        iframe_html = f'<iframe src="{good_url}"></iframe>'
        assert extract_safe_iframe_src(iframe_html, platform) == good_url


def test_c3_sanitize_cached_payload_and_finalized_strip_malicious_embeds():
    """C3: _sanitize_cached_payload and UnfurlResult.finalized() strip unsafe embed URLs to embed_type='none'."""
    for bad_embed in (
        "javascript:alert(1)",
        "http://www.youtube.com/embed/123",
        "https://evil.com/youtube.com/embed/123",
        "https://youtube.com/watch?v=123",
        "https://user:pass@www.youtube.com/embed/123",
        "https://www.youtube.com/embed/123<script>",
    ):
        sanitized = _sanitize_cached_payload(
            {
                "title": "Tampered Donor &amp; Co",
                "embed_type": "youtube",
                "embed_url": bad_embed,
                "media_items": [
                    "https://cdn.example.com/1x1.png",
                    "https://cdn.example.com/bad.svg",
                    "https://cdn.example.com/good1.jpg",
                    "https://cdn.example.com/good2.jpg",
                ],
            },
            base_url="https://example.com/post",
        )
        assert sanitized["embed_url"] is None
        assert sanitized["embed_type"] == "none"
        assert sanitized["title"] == "Tampered Donor & Co"
        assert sanitized["media_items"] == [
            "https://cdn.example.com/good1.jpg",
            "https://cdn.example.com/good2.jpg",
        ]

        res = UnfurlResult(
            url="https://example.com/post",
            canonical_url="https://example.com/post",
            url_hash=compute_url_hash("https://example.com/post"),
            embed_type="youtube",
            embed_url=bad_embed,
        ).finalized()
        assert res.embed_url is None
        assert res.embed_type == "none"


def test_c3_cross_user_7_day_cache_hit_expiry_and_force_refresh_bypass(
    test_client, mock_db, hermetic_isolation, monkeypatch
):
    """C3: Cross-user 7-day cache hits with 0 HTTP & 0 Storage writes; 8-day expired cache & force_refresh re-fetch."""
    monkeypatch.setenv("INTERNAL_WEBHOOK_SECRET", "hook-secret-c3")
    now = datetime.now(timezone.utc)
    base_url = "https://article.example.com/deep-dive?id=42"
    url_hash = compute_url_hash(base_url)
    cached_cover = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{url_hash}.webp"

    # Donor from User A unfurled 2 days ago
    donor_item = {
        "id": "item-user-a",
        "owner_id": "usr-a",
        "url": base_url,
        "canonical_url": base_url,
        "url_hash": url_hash,
        "title": "Cached Deep Dive Title",
        "description": "Cached summary from User A",
        "image_url": cached_cover,
        "media_items": [cached_cover, "https://cdn.example.com/extra.jpg"],
        "embed_type": "none",
        "embed_url": None,
        "site_name": "Article Example",
        "favicon_url": "https://article.example.com/favicon.ico",
        "content_type": "article",
        "platform": "web",
        "enrich_status": "unfurled",
        "unfurled_at": (now - timedelta(days=2)).isoformat(),
    }
    mock_db.tables["items"].append(donor_item)

    # User B saves the same URL with ?fbclid=abc tracking parameter
    user_b_url = f"{base_url}&fbclid=abc"
    item_b = {
        "id": "item-user-b",
        "owner_id": "usr-b",
        "url": user_b_url,
        "canonical_url": base_url,
        "url_hash": url_hash,
        "title": user_b_url,
        "enrich_status": "pending",
        "enrich_attempts": 0,
    }
    mock_db.tables["items"].append(item_b)

    # 1. Valid 2-day cache hit -> 0 external HTTP fetches & 0 Storage writes
    hermetic_isolation.clear_requests()
    mock_db.storage.uploads.clear()

    resp_hit = test_client.post(
        "/hooks/item-created",
        json={"item_id": "item-user-b"},
        headers={"X-Webhook-Secret": "hook-secret-c3"},
    )
    assert resp_hit.status_code == 200
    body_hit = resp_hit.json()
    assert body_hit["cached"] is True
    assert body_hit["storage_uploaded"] is False
    assert body_hit["item"]["title"] == "Cached Deep Dive Title"
    assert body_hit["item"]["image_url"] == cached_cover
    assert body_hit["item"]["enrich_status"] == "unfurled"
    assert len(hermetic_isolation.requests) == 0
    assert len(mock_db.storage.uploads) == 0

    # Prepare live HTTP mock for preview force_refresh, expired cache, and refresh-preview tests
    fresh_jpeg = make_gradient_noise_jpeg_bytes(1000, 700)

    def live_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "article.example.com":
            html = (
                "<html><head>"
                '<meta property="og:title" content="Freshly Refetched Title">'
                '<meta property="og:description" content="Updated live description">'
                '<meta property="og:image" content="https://cdn.example.com/fresh-cover.jpg">'
                "</head></html>"
            )
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        if request.url.host == "cdn.example.com":
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=fresh_jpeg, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(live_handler)

    # 1b. /api/preview hits 2-day cache with 0 HTTP when force_refresh=False, and bypasses when force_refresh=True
    hermetic_isolation.clear_requests()
    preview_hit = test_client.post(
        "/api/preview",
        json={"url": user_b_url, "force_refresh": False},
        headers=make_auth_headers("usr-b"),
    )
    assert preview_hit.status_code == 200
    assert preview_hit.json()["cached"] is True
    assert preview_hit.json()["title"] == "Cached Deep Dive Title"
    assert len(hermetic_isolation.requests) == 0

    preview_bypass = test_client.post(
        "/api/preview",
        json={"url": user_b_url, "force_refresh": True},
        headers=make_auth_headers("usr-b"),
    )
    assert preview_bypass.status_code == 200
    assert preview_bypass.json()["cached"] is False
    assert preview_bypass.json()["title"] == "Freshly Refetched Title"
    assert len(hermetic_isolation.requests) == 1

    # 2. refresh-preview (force_refresh=True) bypasses valid 2-day cache!
    hermetic_isolation.clear_requests()
    mock_db.storage.uploads.clear()
    resp_refresh = test_client.post(
        "/api/items/item-user-b/refresh-preview",
        headers=make_auth_headers("usr-b"),
    )
    assert resp_refresh.status_code == 200
    body_refresh = resp_refresh.json()
    assert body_refresh["cached"] is False
    assert body_refresh["storage_uploaded"] is True
    assert body_refresh["item"]["title"] == "Freshly Refetched Title"
    assert len(hermetic_isolation.requests) >= 2
    assert len(mock_db.storage.uploads) == 1

    # 3. Expired cache (all donors > 7 days old, e.g. 8 days ago) triggers fresh HTTP fetch
    for row in mock_db.tables["items"]:
        row["unfurled_at"] = (now - timedelta(days=8)).isoformat()

    item_c = {
        "id": "item-user-c",
        "owner_id": "usr-c",
        "url": f"{base_url}&utm_medium=social",
        "canonical_url": base_url,
        "url_hash": url_hash,
        "title": base_url,
        "enrich_status": "pending",
        "enrich_attempts": 0,
    }
    mock_db.tables["items"].append(item_c)

    hermetic_isolation.clear_requests()
    mock_db.storage.uploads.clear()

    resp_expired = test_client.post(
        "/hooks/item-created",
        json={"item_id": "item-user-c"},
        headers={"X-Webhook-Secret": "hook-secret-c3"},
    )
    assert resp_expired.status_code == 200
    body_exp = resp_expired.json()
    assert body_exp["cached"] is False
    assert body_exp["storage_uploaded"] is True
    assert body_exp["item"]["title"] == "Freshly Refetched Title"
    assert len(hermetic_isolation.requests) >= 2
    assert len(mock_db.storage.uploads) == 1


# =====================================================================
# C4: Endpoints, Shared Secret, Retry & Rate Limits
# =====================================================================


def test_c4_internal_endpoints_shared_secret_and_dev_bypass_matrix(
    test_client, mock_db, hermetic_isolation, monkeypatch
):
    """C4: /hooks/item-created & /cron/retry-enrich enforce fail-closed 503, 401, 200, and dual-flag dev bypass."""
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text="<html><head><title>Hook Article</title></head></html>",
            request=req,
        )
    )

    target_url = "https://example.com/hook-target"
    mock_db.tables["items"].append(
        {
            "id": "item-hook-1",
            "owner_id": "usr-1",
            "url": target_url,
            "canonical_url": target_url,
            "url_hash": compute_url_hash(target_url),
            "title": target_url,
            "enrich_status": "pending",
            "enrich_attempts": 0,
        }
    )

    # 1. Unconfigured secret in ENV=production -> 503
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "false")
    assert test_client.post("/hooks/item-created", json={"item_id": "item-hook-1"}).status_code == 503
    assert test_client.post("/cron/retry-enrich").status_code == 503

    # Placeholder secret is also treated as unconfigured -> 503
    monkeypatch.setenv("INTERNAL_WEBHOOK_SECRET", "your_internal_webhook_secret_here")
    assert test_client.post("/hooks/item-created", json={"item_id": "item-hook-1"}).status_code == 503
    assert test_client.post("/cron/retry-enrich").status_code == 503

    # 2. Single-flag dev bypass attempts MUST still fail closed with 503
    monkeypatch.delenv("INTERNAL_WEBHOOK_SECRET", raising=False)
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "false")
    assert test_client.post("/hooks/item-created", json={"item_id": "item-hook-1"}).status_code == 503
    assert test_client.post("/cron/retry-enrich").status_code == 503

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "true")
    assert test_client.post("/hooks/item-created", json={"item_id": "item-hook-1"}).status_code == 503
    assert test_client.post("/cron/retry-enrich").status_code == 503

    # 3. Dual-flag dev bypass (ENV=development AND ALLOW_DEV_WEBHOOK_BYPASS=true) -> 200
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "true")
    assert test_client.post("/cron/retry-enrich").status_code == 200
    hook_bypass_res = test_client.post("/hooks/item-created", json={"record": {"id": "item-hook-1"}})
    assert hook_bypass_res.status_code == 200
    assert hook_bypass_res.json()["item"]["title"] == "Hook Article"

    # 4. Configured INTERNAL_WEBHOOK_SECRET -> missing/wrong gives 401, valid X-Webhook-Secret or X-Cron-Secret gives 200
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "false")
    monkeypatch.setenv("INTERNAL_WEBHOOK_SECRET", "prod-shared-secret-999")

    assert test_client.post("/hooks/item-created", json={"item_id": "item-hook-1"}).status_code == 401
    assert test_client.post("/cron/retry-enrich").status_code == 401

    assert (
        test_client.post(
            "/hooks/item-created",
            json={"item_id": "item-hook-1"},
            headers={"X-Webhook-Secret": "wrong-secret"},
        ).status_code
        == 401
    )
    assert (
        test_client.post(
            "/cron/retry-enrich",
            headers={"X-Cron-Secret": "wrong-secret"},
        ).status_code
        == 401
    )

    ok_webhook = test_client.post(
        "/hooks/item-created",
        json={"item_id": "item-hook-1"},
        headers={"X-Webhook-Secret": "prod-shared-secret-999"},
    )
    assert ok_webhook.status_code == 200
    assert ok_webhook.json()["status"] == "ok"

    ok_cron = test_client.post(
        "/cron/retry-enrich",
        headers={"X-Cron-Secret": "prod-shared-secret-999"},
    )
    assert ok_cron.status_code == 200
    assert ok_cron.json()["processed"] == 0


def test_c4_preview_endpoint_jwt_no_db_storage_writes_and_rate_limit(test_client, mock_db, hermetic_isolation):
    """C4: POST /api/preview requires JWT, leaves DB & Storage untouched, and enforces 30/min/user limit."""
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text=(
                "<html><head>"
                '<meta property="og:title" content="Preview Only Title">'
                '<meta property="og:description" content="Read-only preview">'
                '<meta property="og:image" content="https://cdn.example.com/preview-cover.jpg">'
                "</head></html>"
            ),
            request=req,
        )
    )

    # 1. Missing JWT -> 401
    res_no_auth = test_client.post("/api/preview", json={"url": "https://example.com/preview-me"})
    assert res_no_auth.status_code == 401

    # Seed an unrelated item in DB to verify zero mutations
    mock_db.tables["items"].append({"id": "existing-1", "owner_id": "usr-other", "url": "https://other.example.com"})
    items_snapshot = copy.deepcopy(mock_db.tables["items"])

    # 2. Valid JWT + 30/min/user sliding-window rate limit with deterministic clock
    fake_clock = [1000.0]
    preview_rate_limiter.set_clock(lambda: fake_clock[0])

    headers_u1 = make_auth_headers("usr-preview-1")
    for idx in range(30):
        resp = test_client.post(
            "/api/preview",
            json={"url": f"https://example.com/page-{idx}?utm_source=test"},
            headers=headers_u1,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Preview Only Title"
        assert data["canonical_url"] == f"https://example.com/page-{idx}"
        assert data["cached"] is False

    # DB items & Storage must remain completely untouched
    assert mock_db.tables["items"] == items_snapshot
    assert len(mock_db.storage.uploads) == 0

    # 31st request -> 429 with Retry-After header
    resp_31 = test_client.post(
        "/api/preview",
        json={"url": "https://example.com/page-31"},
        headers=headers_u1,
    )
    assert resp_31.status_code == 429
    assert int(resp_31.headers["Retry-After"]) >= 1

    # Another user still has their own quota
    resp_u2 = test_client.post(
        "/api/preview",
        json={"url": "https://example.com/page-u2"},
        headers=make_auth_headers("usr-preview-2"),
    )
    assert resp_u2.status_code == 200

    # Advance clock > 60s -> User 1 rate limit resets
    fake_clock[0] += 61.0
    resp_after_wait = test_client.post(
        "/api/preview",
        json={"url": "https://example.com/page-after-reset"},
        headers=headers_u1,
    )
    assert resp_after_wait.status_code == 200


def test_c4_refresh_preview_permissions_and_hourly_rate_limit(test_client, mock_db, hermetic_isolation):
    """C4: POST /api/items/{id}/refresh-preview blocks Viewer (403), allows Editor/Owner (200), limits 10/hr/user."""
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text="<html><head><title>Refreshed Shared Item</title></head></html>",
            request=req,
        )
    )

    folder_id = "fld-shared-1"
    item_id = "item-shared-1"
    mock_db.tables["folders"].append({"id": folder_id, "owner_id": "usr-owner", "name": "Shared"})
    mock_db.tables["folder_members"].extend(
        [
            {"folder_id": folder_id, "user_id": "usr-viewer", "role": "viewer"},
            {"folder_id": folder_id, "user_id": "usr-editor", "role": "editor"},
        ]
    )
    mock_db.tables["items"].append(
        {
            "id": item_id,
            "owner_id": "usr-owner",
            "folder_id": folder_id,
            "url": "https://shared.example.com/doc",
            "canonical_url": "https://shared.example.com/doc",
            "url_hash": compute_url_hash("https://shared.example.com/doc"),
            "title": "Old Title",
            "enrich_status": "unfurled",
        }
    )

    # Unauthenticated -> 401
    assert test_client.post(f"/api/items/{item_id}/refresh-preview").status_code == 401

    # Viewer and non-member -> 403
    assert (
        test_client.post(
            f"/api/items/{item_id}/refresh-preview",
            headers=make_auth_headers("usr-viewer"),
        ).status_code
        == 403
    )
    assert (
        test_client.post(
            f"/api/items/{item_id}/refresh-preview",
            headers=make_auth_headers("usr-outsider"),
        ).status_code
        == 403
    )

    # Editor -> 200
    res_editor = test_client.post(
        f"/api/items/{item_id}/refresh-preview",
        headers=make_auth_headers("usr-editor"),
    )
    assert res_editor.status_code == 200
    assert res_editor.json()["item"]["title"] == "Refreshed Shared Item"

    # Owner -> 10 requests/hour allowed, 11th -> 429, >3600s resets
    fake_clock = [5000.0]
    refresh_rate_limiter.set_clock(lambda: fake_clock[0])
    owner_headers = make_auth_headers("usr-owner")

    for _ in range(10):
        ok_resp = test_client.post(f"/api/items/{item_id}/refresh-preview", headers=owner_headers)
        assert ok_resp.status_code == 200

    blocked_resp = test_client.post(f"/api/items/{item_id}/refresh-preview", headers=owner_headers)
    assert blocked_resp.status_code == 429
    assert int(blocked_resp.headers["Retry-After"]) >= 1

    fake_clock[0] += 3601.0
    after_hr_resp = test_client.post(f"/api/items/{item_id}/refresh-preview", headers=owner_headers)
    assert after_hr_resp.status_code == 200


def test_c4_cron_retry_enrich_increments_attempts_and_caps_at_3(
    test_client, mock_db, hermetic_isolation, monkeypatch
):
    """C4: /cron/retry-enrich increments enrich_attempts 1 -> 2 -> 3 with enrich_error and skips once attempts==3."""
    monkeypatch.setenv("INTERNAL_WEBHOOK_SECRET", "cron-secret-c4")
    cron_headers = {"X-Cron-Secret": "cron-secret-c4"}
    hook_headers = {"X-Webhook-Secret": "cron-secret-c4"}

    fail_url = "https://flaky.example.com/down"
    mock_db.tables["items"].append(
        {
            "id": "item-retry-1",
            "owner_id": "usr-1",
            "url": fail_url,
            "canonical_url": fail_url,
            "url_hash": compute_url_hash(fail_url),
            "title": fail_url,
            "enrich_status": "pending",
            "enrich_attempts": 0,
        }
    )

    hermetic_isolation.set_handler(
        lambda req: httpx.Response(502, text="Bad Gateway", request=req)
    )

    # Attempt 1 via webhook fails -> enrich_attempts=1, enrich_status='failed', enrich_error set
    hook_res = test_client.post("/hooks/item-created", json={"item_id": "item-retry-1"}, headers=hook_headers)
    assert hook_res.status_code == 200
    assert hook_res.json()["status"] == "failed"
    row = mock_db.tables["items"][0]
    assert row["enrich_status"] == "failed"
    assert row["enrich_attempts"] == 1
    assert "HTTP 502" in (row.get("enrich_error") or "")

    # Attempt 2 via /cron/retry-enrich fails -> enrich_attempts=2
    cron_1 = test_client.post("/cron/retry-enrich", headers=cron_headers)
    assert cron_1.status_code == 200
    c1 = cron_1.json()
    assert c1["processed"] == 1
    assert c1["succeeded"] == 0
    assert c1["failed"] == 1
    assert c1["results"][0]["enrich_attempts"] == 2
    assert mock_db.tables["items"][0]["enrich_attempts"] == 2
    assert mock_db.tables["items"][0]["enrich_status"] == "failed"
    assert "HTTP 502" in (mock_db.tables["items"][0].get("enrich_error") or "")

    # Attempt 3 via /cron/retry-enrich fails -> enrich_attempts=3
    cron_2 = test_client.post("/cron/retry-enrich", headers=cron_headers)
    assert cron_2.status_code == 200
    c2 = cron_2.json()
    assert c2["processed"] == 1
    assert c2["succeeded"] == 0
    assert c2["failed"] == 1
    assert c2["results"][0]["enrich_attempts"] == 3
    assert mock_db.tables["items"][0]["enrich_attempts"] == 3
    assert mock_db.tables["items"][0]["enrich_status"] == "failed"

    # Once enrich_attempts == 3, subsequent /cron/retry-enrich skips it (processed == 0)
    cron_3 = test_client.post("/cron/retry-enrich", headers=cron_headers)
    assert cron_3.status_code == 200
    c3 = cron_3.json()
    assert c3["processed"] == 0
    assert c3["succeeded"] == 0
    assert c3["failed"] == 0
    assert c3["results"] == []

    # Verify a separate retryable item recovers cleanly when upstream returns 200
    recover_url = "https://flaky.example.com/recover"
    mock_db.tables["items"].append(
        {
            "id": "item-retry-recover",
            "owner_id": "usr-1",
            "url": recover_url,
            "canonical_url": recover_url,
            "url_hash": compute_url_hash(recover_url),
            "title": recover_url,
            "enrich_status": "failed",
            "enrich_attempts": 1,
            "enrich_error": "Transient timeout",
        }
    )
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8"},
            text="<html><head><title>Recovered Page</title></head></html>",
            request=req,
        )
    )
    cron_recover = test_client.post("/cron/retry-enrich", headers=cron_headers)
    assert cron_recover.status_code == 200
    cr = cron_recover.json()
    assert cr["processed"] == 1
    assert cr["succeeded"] == 1
    assert cr["failed"] == 0
    recovered_row = next(r for r in mock_db.tables["items"] if r["id"] == "item-retry-recover")
    assert recovered_row["enrich_status"] == "unfurled"
    assert recovered_row["enrich_error"] is None
    assert recovered_row["title"] == "Recovered Page"


# =====================================================================
# CHRIS Audit Regression Suite (B1..B3 & Hardening Coverage)
# =====================================================================


def test_b1_malicious_cached_donor_sanitization_and_ssrf_url_syntax():
    """B1: Cached donors cannot inject XSS favicons, SSRF/SVG covers, traversal embeds, or bad enums."""
    donor = {
        "title": "Poisoned <b>Title</b>",
        "description": "Desc",
        "favicon_url": "javascript:alert(document.domain)",
        "image_url": "http://127.0.0.1/evil.svg",
        "media_items": [
            "http://[::ffff:127.0.0.1]/internal.jpg",
            "https://evil.example.com/a\"onerror=\"alert(1).jpg",
            "https://cdn.example.com/valid-slide.jpg",
        ],
        "embed_type": "youtube",
        "embed_url": "https://www.youtube.com/embed/../watch?v=1",
        "content_type": "malicious_enum",
        "platform": "web",
        "unfurled_at": datetime.now(timezone.utc).isoformat(),
    }
    sanitized = _sanitize_cached_payload(donor, base_url="https://news.example.com/post")
    assert sanitized["favicon_url"] is None
    assert sanitized["image_url"] == "https://cdn.example.com/valid-slide.jpg"
    assert sanitized["media_items"] == ["https://cdn.example.com/valid-slide.jpg"]
    assert sanitized["embed_type"] == "none"
    assert sanitized["embed_url"] is None
    assert sanitized["content_type"] is None

    # Valid Storage WebP URL and valid https favicon are preserved cleanly
    valid_hash = compute_url_hash("https://news.example.com/post")
    valid_webp = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{valid_hash}.webp"
    donor_ok = {
        "title": "Clean",
        "favicon_url": "https://news.example.com/favicon.ico",
        "image_url": valid_webp,
        "media_items": [valid_webp, "https://cdn.example.com/pic2.jpg"],
        "embed_type": "instagram",
        "embed_url": "https://www.instagram.com/p/AbCd123/embed",
        "content_type": "post",
        "platform": "instagram",
    }
    sanitized_ok = _sanitize_cached_payload(donor_ok, base_url="https://news.example.com/post")
    assert sanitized_ok["favicon_url"] == "https://news.example.com/favicon.ico"
    assert sanitized_ok["image_url"] == valid_webp
    assert sanitized_ok["media_items"] == [valid_webp, "https://cdn.example.com/pic2.jpg"]
    assert sanitized_ok["embed_url"] == "https://www.instagram.com/p/AbCd123/embed"
    assert sanitized_ok["content_type"] == "post"


@pytest.mark.asyncio
async def test_b2_enrich_item_5_images_no_duplicate_cover_and_preserves_done(hermetic_isolation, mock_db):
    """B2: Storage Cover #1 replaces raw external Cover #1 without duplicating it or dropping #5."""
    url = "https://gallery.example.com/album-5"
    url_hash = compute_url_hash(url)
    mock_db.tables["items"].append(
        {
            "id": "item-gallery-5",
            "owner_id": "usr-1",
            "url": url,
            "canonical_url": url,
            "url_hash": url_hash,
            "title": url,
            "ai_summary": "Existing summary preserved",
            "enrich_status": "pending",
            "enrich_attempts": 0,
        }
    )

    jpeg_bytes = make_gradient_noise_jpeg_bytes(1200, 800)
    imgs = [f"https://cdn.example.com/photo-{i}.jpg" for i in range(1, 6)]
    html = (
        "<html><head><title>Five Photo Album</title></head><body><article>"
        + "".join(f'<img src="{u}" width="800" height="600">' for u in imgs)
        + "</article></body></html>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == url:
            return httpx.Response(200, headers={"Content-Type": "text/html; charset=utf-8"}, text=html, request=request)
        if str(request.url) == imgs[0]:
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=jpeg_bytes, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    out = await enrich_item(mock_db, "item-gallery-5")
    assert out["status"] == "ok"
    assert out["storage_uploaded"] is True
    expected_webp = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{url_hash}.webp"
    item = out["item"]
    assert item["image_url"] == expected_webp
    assert item["media_items"] == [expected_webp, imgs[1], imgs[2], imgs[3], imgs[4]]
    assert imgs[0] not in item["media_items"]
    assert item["enrich_status"] == "done"

    # Single-image article must produce length-1 media_items (no duplicate external cover)
    single_url = "https://gallery.example.com/single-1"
    single_hash = compute_url_hash(single_url)
    mock_db.tables["items"].append(
        {
            "id": "item-single-1",
            "owner_id": "usr-1",
            "url": single_url,
            "canonical_url": single_url,
            "url_hash": single_hash,
            "title": single_url,
            "enrich_status": "pending",
            "enrich_attempts": 0,
        }
    )

    def single_handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == single_url:
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html; charset=utf-8"},
                text=f'<html><head><meta property="og:image" content="{imgs[0]}"><title>Single</title></head></html>',
                request=request,
            )
        if str(request.url) == imgs[0]:
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=jpeg_bytes, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(single_handler)
    single_out = await enrich_item(mock_db, "item-single-1")
    expected_single_webp = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{single_hash}.webp"
    assert single_out["item"]["media_items"] == [expected_single_webp]


@pytest.mark.asyncio
async def test_b3_streaming_limits_image_bomb_and_redirect_ssrf(hermetic_isolation):
    """B3: Streaming stops at 3MB HTML / rejects >5MB images, SVGs, redirect SSRF, and >25MP bombs."""
    from Unfurl.webp_storage import MAX_RAW_IMAGE_BYTES, download_image_safely

    class ChunkedStream(httpx.AsyncByteStream):
        def __init__(self, chunk: bytes, total_chunks: int) -> None:
            self._chunk = chunk
            self._total_chunks = total_chunks
            self.chunks_yielded = 0

        async def __aiter__(self):
            for _ in range(self._total_chunks):
                self.chunks_yielded += 1
                yield self._chunk

    html_head = b"<html><head><title>Streamed Head</title></head><body>"
    html_stream = ChunkedStream(b"A" * 65536, 80)  # > 5MB total if unguarded

    class ImgStreamHolder:
        stream_ref: Optional[ChunkedStream] = None

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/huge.html":
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html; charset=utf-8"},
                stream=ChunkedStream(html_head + b"B" * (65536 - len(html_head)), 80),
                request=request,
            )
        if request.url.path == "/huge.jpg":
            s = ChunkedStream(b"\xff\xd8\xff" + b"X" * 65533, 120)  # ~7.8 MB
            ImgStreamHolder.stream_ref = s
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, stream=s, request=request)
        if request.url.path == "/vector.svg":
            return httpx.Response(200, headers={"Content-Type": "image/svg+xml"}, content=b"<svg/>", request=request)
        if request.url.path == "/redir-ssrf":
            return httpx.Response(
                302,
                headers={"Location": "http://169.254.169.254/latest/meta-data"},
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    # 1. Chunked >5MB HTML caps strictly at MAX_HTML_BYTES (3MB) without full buffering
    status_code, _, body, _ = await _fetch_limited_response("https://stream.example.com/huge.html")
    assert status_code == 200
    assert len(body) == MAX_HTML_BYTES
    assert b"Streamed Head" in body

    # 2. Chunked >5MB image aborts before reading entire 7.8MB stream
    with pytest.raises(ValueError, match="exceeds"):
        await download_image_safely("https://stream.example.com/huge.jpg")
    assert ImgStreamHolder.stream_ref is not None
    assert ImgStreamHolder.stream_ref.chunks_yielded * 65536 <= MAX_RAW_IMAGE_BYTES + 65536

    # 3. SVG Content-Type and SSRF redirect on cover download are rejected
    with pytest.raises(ValueError, match="Content-Type"):
        await download_image_safely("https://stream.example.com/vector.svg")
    with pytest.raises(ValueError, match="SSRF Alert"):
        await download_image_safely("https://stream.example.com/redir-ssrf")

    # 4. Decompression bomb (>25MP) is blocked before exif_transpose / convert
    fake_bomb = MagicMock()
    fake_bomb.size = (6000, 6000)  # 36 MP > 25 MP
    fake_ctx = MagicMock()
    fake_ctx.__enter__.return_value = fake_bomb
    fake_ctx.__exit__.return_value = False
    with patch("Unfurl.webp_storage.Image.open", return_value=fake_ctx):
        with pytest.raises(ValueError, match="25000000"):
            compress_image_to_webp(b"fake-header-bytes")

    # Ensure uncompressible / error case gracefully falls back in process_and_upload_cover
    ext_url = "https://stream.example.com/vector.svg"
    cover_out, stored = await process_and_upload_cover(ext_url, url_hash="abcdef1234567890")
    assert cover_out == ext_url
    assert stored is False


def test_c4_endpoint_error_codes_and_mcp_create_folder_hygiene(hermetic_isolation, mock_db, test_client, monkeypatch):
    """C4 + Part 1 parity: /api/preview 400/502, /hooks/item-created 400/404, refresh 404, MCP folder create."""
    from Ai.mcp_server import manage_folder, set_authenticated_user_id, set_override_db

    monkeypatch.setenv("INTERNAL_WEBHOOK_SECRET", "test-hook-secret")
    user_headers = make_auth_headers("usr-edge-1")
    hook_headers = {"X-Webhook-Secret": "test-hook-secret"}

    ssrf_prev = test_client.post("/api/preview", json={"url": "http://127.0.0.1/admin"}, headers=user_headers)
    assert ssrf_prev.status_code == 400

    hermetic_isolation.set_handler(lambda req: httpx.Response(500, text="Server error", request=req))
    bad_prev = test_client.post("/api/preview", json={"url": "https://down.example.com/page"}, headers=user_headers)
    assert bad_prev.status_code == 502

    bad_hook = test_client.post("/hooks/item-created", json={"type": "INSERT"}, headers=hook_headers)
    assert bad_hook.status_code == 400
    missing_hook = test_client.post("/hooks/item-created", json={"item_id": "nonexistent"}, headers=hook_headers)
    assert missing_hook.status_code == 404

    missing_refresh = test_client.post("/api/items/nonexistent/refresh-preview", headers=user_headers)
    assert missing_refresh.status_code == 404

    set_authenticated_user_id("usr-edge-1")
    set_override_db(mock_db)
    try:
        with pytest.raises(ValueError, match="1 and 80"):
            manage_folder("create", name="   ")
        with pytest.raises(ValueError, match="1 and 80"):
            manage_folder("create", name="a" * 81)
        created = manage_folder("create", name="  Trip Cafe\u0301  ")
        assert created["name"] == "Trip Caf\u00e9"
    finally:
        set_authenticated_user_id(None)
        set_override_db(None)


def test_c4_preview_url_redacts_secrets_in_error(hermetic_isolation, mock_db, test_client, monkeypatch):
    """C4: preview_url_readonly scrubs tokens and Authorization headers from unexpected error details."""
    monkeypatch.setattr(
        "Unfurl.service.extract_unfurl_metadata",
        AsyncMock(side_effect=RuntimeError("Failed calling https://api.example.com?access_token=topsecret123 Authorization: Bearer secret_jwt_token_999")),
    )
    res = test_client.post(
        "/api/preview",
        json={"url": "https://example.com/some-page"},
        headers=make_auth_headers("usr-red-1"),
    )
    assert res.status_code == 502
    detail = res.json()["detail"]
    assert "topsecret123" not in detail
    assert "secret_jwt_token_999" not in detail
    assert "[REDACTED]" in detail


@pytest.mark.asyncio
async def test_facebook_video_embed_redirect_and_private_detection(hermetic_isolation, monkeypatch):
    """Facebook video/reel URLs use plugins/video.php, short URLs resolve redirects, and private posts report private_or_restricted."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "fb.watch":
            return httpx.Response(
                302,
                headers={"location": "https://www.facebook.com/myPage/videos/987654321/"},
                request=request,
            )
        if request.url.host == "www.facebook.com" and "/videos/987654321" in request.url.path:
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text=(
                    "<html><head>"
                    '<meta property="og:title" content="Public FB Video" />'
                    '<meta property="og:description" content="Full video caption here" />'
                    '<meta property="og:image" content="https://scontent.xx.fbcdn.net/cover_fb.jpg" />'
                    "</head></html>"
                ),
                request=request,
            )
        if request.url.host == "www.facebook.com" and "/private-post" in request.url.path:
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text=(
                    "<html><head>"
                    "<title>This content isn't available right now</title>"
                    "</head></html>"
                ),
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    fb_vid = await extract_unfurl_metadata("https://fb.watch/abc123/")
    assert fb_vid.platform == "facebook"
    assert fb_vid.content_type == "video"
    assert fb_vid.preview_status == "ok"
    assert fb_vid.embed_url is not None
    assert fb_vid.embed_url.startswith("https://www.facebook.com/plugins/video.php?href=")
    assert fb_vid.description == "Full video caption here"
    assert fb_vid.image_url == "https://scontent.xx.fbcdn.net/cover_fb.jpg"

    fb_priv = await extract_unfurl_metadata("https://www.facebook.com/someone/posts/private-post")
    assert fb_priv.platform == "facebook"
    assert fb_priv.preview_status == "private_or_restricted"
    assert fb_priv.embed_url is None


@pytest.mark.asyncio
async def test_meta_crawler_ua_ig_embed_fallback_and_fb_400_restricted(hermetic_isolation, monkeypatch):
    """Fixes #2 & #5: Meta crawler UA applies per-hop to Meta domains only; IG falls back to /embed/captioned/; FB 400 & empty shell become private_or_restricted."""
    from Ai.content_extractor import USER_AGENT
    from Unfurl.security import META_CRAWLER_USER_AGENT

    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    seen_uas: List[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_uas.append((request.url.host, request.headers.get("User-Agent", "")))
        host = request.url.host
        path = request.url.path
        if host == "www.instagram.com" and path == "/reels/ReelLogin123/":
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<html><head><title>Instagram</title></head></html>",
                request=request,
            )
        if host == "www.instagram.com" and path == "/reel/ReelLogin123/embed/captioned/":
            embed_html = (
                "<html><body><div class='Embed'>"
                "<div class='Header'>"
                "<a class='Avatar'><img src='https://scontent.cdninstagram.com/profile_pic.jpg'></a>"
                "<span class='UsernameText'>chef_bkk</span>"
                "</div>"
                "<div class='Content'>"
                "<img class='EmbeddedMediaImage' src='https://scontent.cdninstagram.com/reel_cover_real.jpg'>"
                "</div>"
                "<div class='Caption'>"
                "<a class='CaptionUsername'>chef_bkk</a><br><br>Pad Kra Pao recipe 101"
                "<div class='CaptionComments'><a>View all 99 comments</a></div>"
                "</div>"
                "<div class='HoverCard'><div class='HoverCardPhotos'>"
                "<img src='https://scontent.cdninstagram.com/other_profile_photo.jpg'>"
                "</div></div>"
                "</div></body></html>"
            )
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=embed_html, request=request)
        if host == "www.instagram.com" and path == "/reel/DeletedThai1/":
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<html><head><title>Instagram</title></head></html>",
                request=request,
            )
        if host == "www.instagram.com" and path == "/reel/DeletedThai1/embed/captioned/":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body><div>ลิงก์ไปยังรูปภาพหรือวิดีโอนี้อาจเสียหายหรือโพสต์อาจถูกลบออกไปแล้ว</div></body></html>",
                request=request,
            )
        if host == "www.facebook.com" and path == "/blocked/posts/400":
            return httpx.Response(400, text="Bad Request", request=request)
        if host == "www.facebook.com" and path == "/reel/999000111222":
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<html><head><title>Facebook</title></head><body></body></html>",
                request=request,
            )
        if host == "l.facebook.com":
            return httpx.Response(
                302,
                headers={"location": "https://blog.example.com/post"},
                request=request,
            )
        if host == "blog.example.com":
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<html><head><title>External Blog</title></head></html>",
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    # 1. IG /reels/CODE/ bare shell falls back to /reel/CODE/embed/captioned/, ignores Avatar/HoverCardPhotos, & sets title to opening sentence of caption
    ig_res = await extract_unfurl_metadata("https://www.instagram.com/reels/ReelLogin123/")
    assert ig_res.platform == "instagram"
    assert ig_res.content_type == "video"
    assert ig_res.preview_status == "ok"
    assert ig_res.embed_url == "https://www.instagram.com/reel/ReelLogin123/embed"
    assert ig_res.title == "Pad Kra Pao recipe 101"
    assert ig_res.description == "Pad Kra Pao recipe 101"
    assert "View all 99 comments" not in (ig_res.description or "")
    assert ig_res.media_items == ["https://scontent.cdninstagram.com/reel_cover_real.jpg"]

    # 2. Broken IG embed in Thai -> private_or_restricted + embed cleared
    ig_del = await extract_unfurl_metadata("https://www.instagram.com/reel/DeletedThai1/")
    assert ig_del.preview_status == "private_or_restricted"
    assert ig_del.embed_url is None

    # 3. Facebook HTTP 400 and bare Facebook shell -> private_or_restricted + embed cleared
    fb_400 = await extract_unfurl_metadata("https://www.facebook.com/blocked/posts/400")
    assert fb_400.platform == "facebook"
    assert fb_400.preview_status == "private_or_restricted"
    assert fb_400.embed_url is None

    fb_shell = await extract_unfurl_metadata("https://www.facebook.com/reel/999000111222")
    assert fb_shell.platform == "facebook"
    assert fb_shell.preview_status == "private_or_restricted"
    assert fb_shell.embed_url is None

    # 4. Default (ALLOW_META_CRAWLER_UA=false) sends standard USER_AGENT; opt-in (ALLOW_META_CRAWLER_UA=true) sends META_CRAWLER_USER_AGENT on Meta hops only
    seen_uas.clear()
    ext_default = await extract_unfurl_metadata("https://l.facebook.com/l.php?u=https%3A%2F%2Fblog.example.com%2Fpost")
    assert ext_default.title == "External Blog"
    assert ("l.facebook.com", USER_AGENT) in seen_uas
    assert ("blog.example.com", USER_AGENT) in seen_uas

    monkeypatch.setenv("ALLOW_META_CRAWLER_UA", "true")
    seen_uas.clear()
    ext_opt_in = await extract_unfurl_metadata("https://l.facebook.com/l.php?u=https%3A%2F%2Fblog.example.com%2Fpost")
    assert ext_opt_in.title == "External Blog"
    assert ("l.facebook.com", META_CRAWLER_USER_AGENT) in seen_uas
    assert ("blog.example.com", USER_AGENT) in seen_uas


@pytest.mark.asyncio
async def test_enrich_item_preserves_existing_extension_media_on_empty_or_single_unfurl(
    hermetic_isolation, mock_db, monkeypatch
):
    """Fix #1: enrich_item preserves Extension DOM Assist media when server unfurl returns 0 images or fewer Meta images."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    jpeg_bytes = make_gradient_noise_jpeg_bytes(900, 600)

    # Case A: IG post saved with 3 DOM Assist images; server gets HTTP 403 -> images kept & Cover #1 uploaded to WebP
    ig_url = "https://www.instagram.com/p/ExtAlbum3/"
    ig_hash = compute_url_hash(ig_url)
    dom_imgs_a = [
        "https://scontent.cdninstagram.com/slide1.jpg",
        "https://scontent.cdninstagram.com/slide2.jpg",
        "https://scontent.cdninstagram.com/slide3.jpg",
    ]
    mock_db.tables["items"].append(
        {
            "id": "item-ext-ig-a",
            "owner_id": "usr-ext",
            "url": ig_url,
            "canonical_url": ig_url,
            "url_hash": ig_hash,
            "title": "Saved Carousel from Extension",
            "description": "DOM caption",
            "image_url": dom_imgs_a[0],
            "media_items": list(dom_imgs_a),
            "platform": "instagram",
            "enrich_status": "pending",
        }
    )

    def handler_a(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.instagram.com":
            return httpx.Response(403, text="Forbidden", request=request)
        if str(request.url) == dom_imgs_a[0]:
            return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=jpeg_bytes, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler_a)
    out_a = await enrich_item(mock_db, "item-ext-ig-a")
    expected_webp_a = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{ig_hash}.webp"
    assert out_a["item"]["image_url"] == expected_webp_a
    assert out_a["item"]["media_items"] == [expected_webp_a, dom_imgs_a[1], dom_imgs_a[2]]
    assert out_a["item"]["enrich_error"] is None

    # Case B: FB post saved with 4 DOM Assist images; server returns only 1 og:image -> all 4 preserved
    fb_url = "https://www.facebook.com/page/posts/album4"
    fb_hash = compute_url_hash(fb_url)
    dom_imgs_b = [f"https://scontent.xx.fbcdn.net/p{i}.jpg" for i in range(1, 5)]
    og_fb_cover = "https://scontent.xx.fbcdn.net/og_cover.jpg"
    mock_db.tables["items"].append(
        {
            "id": "item-ext-fb-b",
            "owner_id": "usr-ext",
            "url": fb_url,
            "canonical_url": fb_url,
            "url_hash": fb_hash,
            "title": fb_url,
            "image_url": None,
            "media_items": list(dom_imgs_b),
            "platform": "facebook",
            "enrich_status": "pending",
        }
    )

    def handler_b(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.facebook.com":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    "<html><head>"
                    '<meta property="og:title" content="FB Page Album">'
                    '<meta property="og:description" content="Four photos">'
                    f'<meta property="og:image" content="{og_fb_cover}">'
                    "</head></html>"
                ),
                request=request,
            )
        if str(request.url) == og_fb_cover:
            return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=jpeg_bytes, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler_b)
    out_b = await enrich_item(mock_db, "item-ext-fb-b")
    expected_webp_b = f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{fb_hash}.webp"
    assert out_b["item"]["title"] == "FB Page Album"
    assert out_b["item"]["image_url"] == expected_webp_b
    assert out_b["item"]["media_items"] == [expected_webp_b, dom_imgs_b[1], dom_imgs_b[2], dom_imgs_b[3]]

    # Case C: Same-user cached donor with 0 images must not wipe Extension DOM Assist images on new item,
    # while Cross-user social donor (usr-a) must NEVER leak to usr-b!
    cache_url = "https://www.instagram.com/p/EmptyDonorCase/"
    cache_hash = compute_url_hash(cache_url)
    mock_db.tables["items"].extend(
        [
            {
                "id": "item-donor-private-usr-a",
                "owner_id": "usr-a",
                "url": cache_url,
                "canonical_url": cache_url,
                "url_hash": cache_hash,
                "title": "Private DOM Title from User A",
                "description": "Secret friends-only caption from User A",
                "image_url": "https://scontent.cdninstagram.com/secret_a.jpg",
                "media_items": ["https://scontent.cdninstagram.com/secret_a.jpg"],
                "platform": "instagram",
                "enrich_status": "unfurled",
                "unfurled_at": datetime.now(timezone.utc).isoformat(),
            },
            {
                "id": "item-donor-empty-usr-b",
                "owner_id": "usr-b",
                "url": cache_url,
                "canonical_url": cache_url,
                "url_hash": cache_hash,
                "title": "User B Earlier Title",
                "image_url": None,
                "media_items": [],
                "platform": "instagram",
                "enrich_status": "unfurled",
                "unfurled_at": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
            },
            {
                "id": "item-target-ext",
                "owner_id": "usr-b",
                "url": cache_url,
                "canonical_url": cache_url,
                "url_hash": cache_hash,
                "title": "Target Ext",
                "image_url": "https://scontent.cdninstagram.com/kept1.jpg",
                "media_items": [
                    "https://scontent.cdninstagram.com/kept1.jpg",
                    "https://scontent.cdninstagram.com/kept2.jpg",
                ],
                "platform": "instagram",
                "enrich_status": "pending",
            },
        ]
    )
    out_c = await enrich_item(mock_db, "item-target-ext", force_refresh=False)
    assert out_c["cached"] is True
    # Must NOT have leaked User A's secret caption or image!
    assert out_c["item"].get("description") != "Secret friends-only caption from User A"
    assert out_c["item"]["image_url"] == "https://scontent.cdninstagram.com/kept1.jpg"
    assert out_c["item"]["media_items"] == [
        "https://scontent.cdninstagram.com/kept1.jpg",
        "https://scontent.cdninstagram.com/kept2.jpg",
    ]


def test_social_engagement_stripping_and_duplicate_title_collapse():
    """Part 1: Strips view/reaction/like/comment counts on FB/IG/TikTok and sets title to short 1-line opening sentence of caption."""
    # 1. Facebook video with view/share counts and multi-sentence caption -> opening sentence as title
    fb_res = UnfurlResult(
        url="https://www.facebook.com/watch/?v=10155278547321729",
        canonical_url="https://www.facebook.com/watch/?v=10155278547321729",
        url_hash=compute_url_hash("https://www.facebook.com/watch/?v=10155278547321729"),
        title="ยอดดู 75 ล้าน ครั้ง · แชร์ 1.4 แสน ครั้ง | Today, we remember what was on our minds in 2016. | Mark Zuckerberg | Facebook",
        description="Today, we remember what was on our minds in 2016. Looking back at all the moments we shared together.",
        platform="facebook",
        content_type="video",
    ).finalized()
    assert fb_res.title == "Today, we remember what was on our minds in 2016."
    assert fb_res.description == "Today, we remember what was on our minds in 2016. Looking back at all the moments we shared together."
    assert "ยอดดู" not in (fb_res.title or "")

    # 2. Instagram post with 60M likes/4M comments prefix and long caption -> short opening sentence as title
    ig_res = UnfurlResult(
        url="https://www.instagram.com/p/BsOGulcndj-/",
        canonical_url="https://www.instagram.com/p/BsOGulcndj-/",
        url_hash=compute_url_hash("https://www.instagram.com/p/BsOGulcndj-/"),
        title='Just An Egg 🥚 บน Instagram: "Let’s set a world record together and get the most liked post"',
        description='60M likes, 4M comments - world_record_egg บน January 4, 2019: "Let’s set a world record together and get the most liked post on Instagram!"',
        platform="instagram",
        content_type="post",
    ).finalized()
    assert ig_res.title == "Let’s set a world record together and get the most liked…"
    assert ig_res.description == "Let’s set a world record together and get the most liked post on Instagram!"
    assert "60M likes" not in (ig_res.description or "")

    # 3. TikTok video with truncated title caption duplicating full description caption
    tt_res = UnfurlResult(
        url="https://www.tiktok.com/@scout2015/video/6718335390845095173",
        canonical_url="https://www.tiktok.com/@scout2015/video/6718335390845095173",
        url_hash=compute_url_hash("https://www.tiktok.com/@scout2015/video/6718335390845095173"),
        title="Scout, Suki & Stella: Scramble up ur name & I’ll try to guess it",
        description="@scout2015 — Scramble up ur name & I’ll try to guess it! #foryoupage #petsoftiktok",
        platform="tiktok",
        content_type="video",
    ).finalized()
    assert tt_res.title == "Scramble up ur name & I’ll try to guess it!"
    assert tt_res.description == "Scramble up ur name & I’ll try to guess it! #foryoupage #petsoftiktok"


@pytest.mark.asyncio
async def test_facebook_plugin_post_extracts_full_caption_and_multi_photos(hermetic_isolation, monkeypatch):
    """Facebook plugins/post.php and Comet JSON expand truncated og:description (...) and collect up to 5 post photos."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    seen_plugin_headers: Dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.facebook.com" and request.url.path == "/page/posts/12345":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    "<html><head>"
                    '<meta property="og:title" content="Cafe Hopping BKK">'
                    '<meta property="og:description" content="First paragraph is truncated here...">'
                    '<meta property="og:image" content="https://scontent.xx.fbcdn.net/cover1.jpg">'
                    "</head></html>"
                ),
                request=request,
            )
        if request.url.host == "www.facebook.com" and request.url.path == "/plugins/post.php":
            seen_plugin_headers["sec_fetch_dest"] = request.headers.get("Sec-Fetch-Dest", "")
            plugin_html = (
                "<html><body>"
                '<div data-testid="post_message">'
                "<p>First paragraph is understan<span class='text_exposed_hide'>...</span>"
                "<span class='text_exposed_show'>dable and completely expanded.</span></p>"
                "<p>Second paragraph with full details!</p>"
                "</div>"
                '<div class="mtm">'
                '<img src="https://scontent.xx.fbcdn.net/p50x50/avatar.jpg" width="40" height="40">'
                '<img src="https://scontent.xx.fbcdn.net/photo2.jpg" width="800" height="600">'
                '<img src="https://scontent.xx.fbcdn.net/photo3.jpg" width="800" height="600">'
                "</div>"
                "</body></html>"
            )
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=plugin_html, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://www.facebook.com/page/posts/12345")
    assert seen_plugin_headers.get("sec_fetch_dest") == "iframe"
    assert res.title == "First paragraph is understandable and completely expanded."
    assert res.description == "First paragraph is understandable and completely expanded.\n\nSecond paragraph with full details!"
    assert res.media_items == [
        "https://scontent.xx.fbcdn.net/cover1.jpg",
        "https://scontent.xx.fbcdn.net/photo2.jpg",
        "https://scontent.xx.fbcdn.net/photo3.jpg",
    ]


@pytest.mark.asyncio
async def test_ig_single_photo_dedups_cropped_og_and_srcset_and_strips_trailing_quote_dot(
    hermetic_isolation, monkeypatch
):
    """Single-photo IG posts pick uncropped srcset over trailing cropped variants, drop cross-CDN duplicates, and clean trailing quote-dot."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)

    asset_name = "675803457_18579207407021094_3857042213012979541_n.jpg"
    cropped_og = f"https://scontent.cdninstagram.com/v/t51.82787-15/{asset_name}?stp=c240.0.720.720a_dst-jpg_e35_s640x640_tt6&_nc_ht=scontent.cdninstagram.com"
    uncropped_1080 = f"https://instagram.fbkk28-1.fna.fbcdn.net/v/t51.82787-15/{asset_name}?stp=dst-jpg_e15_tt6&_nc_ht=instagram.fbkk28-1.fna.fbcdn.net"
    cropped_1080 = f"https://instagram.fbkk28-1.fna.fbcdn.net/v/t51.82787-15/{asset_name}?stp=c0.420.1080.1080a_dst-jpg_e35_tt6&_nc_ht=instagram.fbkk28-1.fna.fbcdn.net"

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://www.instagram.com/p/DfzabQmDTBe/embed/captioned"):
            embed_html = (
                "<html><body>"
                '<div class="Header"><a class="UsernameText">ihavecpu</a></div>'
                '<div class="Content">'
                '<img class="EmbeddedMediaImage" '
                f'src="{cropped_1080}" '
                f'srcset="{uncropped_1080} 1080w, {cropped_1080} 1080w">'
                "</div>"
                '<div class="HoverCard"><img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/avatar.jpg"></div>'
                '<div class="Caption"><a class="CaptionUsername">ihavecpu</a> เห็นได้ไง? | iHAVECPU</div>'
                "</body></html>"
            )
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=embed_html, request=request)
        if url.startswith("https://www.instagram.com/p/DfzabQmDTBe"):
            main_html = (
                "<html><head>"
                "<title>Instagram</title>"
                '<meta property="og:title" content="Instagram">'
                '<meta property="og:description" content=\'13K likes, 120 comments - ihavecpu on June 10, 2026: "เห็นได้ไง? | iHAVECPU". \'>'
                f'<meta property="og:image" content="{cropped_og}">'
                "</head><body></body></html>"
            )
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=main_html, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://www.instagram.com/p/DfzabQmDTBe/")
    assert res.title == "เห็นได้ไง?"
    assert res.description == "เห็นได้ไง? | iHAVECPU"
    assert res.media_items == [uncropped_1080]


@pytest.mark.asyncio
async def test_enrich_item_overwrites_generic_platform_titles_and_dedups_cropped_existing_media(
    hermetic_isolation, mock_db, monkeypatch
):
    """enrich_item replaces generic Instagram/Facebook/TikTok/YouTube titles and avoids 2nd cropped slide from extension DOM."""
    from Database.repository import create_or_bump_item

    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("ALLOW_META_CRAWLER_UA", "true")

    asset_name = "712345678_987654321012345_111222333444_n.jpg"
    cropped_ext_thumb = f"https://scontent.cdninstagram.com/v/t51.82787-15/{asset_name}?stp=c240.0.720.720a_dst-jpg_e35_s640x640_tt6"
    uncropped_embed = f"https://instagram.fbkk28-1.fna.fbcdn.net/v/t51.82787-15/{asset_name}?stp=dst-jpg_e15_tt6"
    tt_cover_p16 = "https://p16-sign-sg.tiktokcdn.com/tos-alisg-p-0037/abc123~tplv-photomode-zoomcover:720:720.jpeg?x-expires=999"

    img_bytes = make_gradient_noise_jpeg_bytes(900, 1200)
    ig_url = "https://www.instagram.com/reel/DYowlO2v1ww/"
    tt_url = "https://www.tiktok.com/@creator/video/7703529186639547656"
    fb_url = "https://www.facebook.com/reel/1EM5Hpu45Y"
    yt_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    fb_thumb = "https://scontent.xx.fbcdn.net/fb-reel-cover.jpg"
    yt_thumb = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"

    # Seed IG reel item with generic title "Instagram" and cropped duplicate extension media
    mock_db.tables["items"].append(
        {
            "id": "item-ig-generic",
            "user_id": "user-1",
            "folder_id": None,
            "url": ig_url,
            "url_hash": compute_url_hash(ig_url),
            "platform": "instagram",
            "content_type": "video",
            "title": "Instagram",
            "description": None,
            "image_url": cropped_ext_thumb,
            "media_items": [cropped_ext_thumb],
            "status": "todo",
            "enrich_status": "done",
        }
    )
    # Seed TikTok item with generic shell title
    mock_db.tables["items"].append(
        {
            "id": "item-tt-generic",
            "user_id": "user-1",
            "folder_id": None,
            "url": tt_url,
            "url_hash": compute_url_hash(tt_url),
            "platform": "tiktok",
            "content_type": "video",
            "title": "Watch trending videos for you | TikTok",
            "description": None,
            "image_url": None,
            "media_items": [],
            "status": "todo",
            "enrich_status": "done",
        }
    )
    # Seed Facebook & YouTube items with generic/noisy titles
    mock_db.tables["items"].append(
        {
            "id": "item-fb-generic",
            "user_id": "user-1",
            "folder_id": None,
            "url": fb_url,
            "url_hash": compute_url_hash(fb_url),
            "platform": "facebook",
            "content_type": "video",
            "title": "Facebook",
            "description": None,
            "image_url": None,
            "media_items": [],
            "status": "todo",
            "enrich_status": "done",
        }
    )
    mock_db.tables["items"].append(
        {
            "id": "item-yt-noisy",
            "user_id": "user-1",
            "folder_id": None,
            "url": yt_url,
            "url_hash": compute_url_hash(yt_url),
            "platform": "youtube",
            "content_type": "video",
            "title": "(584) Match Highlight - YouTube",
            "description": None,
            "image_url": None,
            "media_items": [],
            "status": "todo",
            "enrich_status": "done",
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://www.instagram.com/reel/DYowlO2v1ww/embed/captioned"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><body><div class="Header"><a class="UsernameText">creator</a></div>'
                    f'<div class="Content"><img class="EmbeddedMediaImage" src="{uncropped_embed}"></div>'
                    '<div class="Caption"><a class="CaptionUsername">creator</a> 高難度招式 😎🔥</div></body></html>'
                ),
                request=request,
            )
        if url.startswith("https://www.instagram.com/reel/DYowlO2v1ww"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><title>Instagram</title>'
                    '<meta property="og:title" content="Instagram">'
                    '<meta property="og:description" content=\'9K likes, 40 comments - creator on May 1, 2026: "高難度招式 😎🔥\nFull trick breakdown". \'>'
                    f'<meta property="og:image" content="{cropped_ext_thumb}">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        if url.startswith("https://www.tiktok.com/oembed"):
            return httpx.Response(
                200,
                json={
                    "title": "Trick shot compilation 2026\nSubscribe for more!",
                    "author_name": "creator",
                    "thumbnail_url": tt_cover_p16,
                },
                request=request,
            )
        if url.startswith("https://www.facebook.com/reel/1EM5Hpu45Y"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><title>Facebook</title>'
                    '<meta property="og:title" content="Facebook">'
                    '<meta property="og:description" content="เน้นเข้ารอบ ไม่เน้นเข้าร่วม&#10;ต่อท้ายแคปชั่นเต็ม">'
                    f'<meta property="og:image" content="{fb_thumb}">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        if url.startswith("https://www.youtube.com/oembed"):
            return httpx.Response(
                200,
                json={
                    "title": "Match Highlight",
                    "author_name": "SportsChannel",
                    "thumbnail_url": yt_thumb,
                    "html": '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
                },
                request=request,
            )
        if (
            url.startswith(uncropped_embed)
            or url.startswith(tt_cover_p16)
            or url.startswith(fb_thumb)
            or url.startswith(yt_thumb)
        ):
            return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=img_bytes, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    ig_out = await enrich_item(mock_db, "item-ig-generic")
    assert ig_out["status"] == "ok"
    assert ig_out["item"]["title"] == "高難度招式 😎🔥"
    assert ig_out["item"]["description"] == "高難度招式 😎🔥\nFull trick breakdown"
    expected_ig_webp = (
        f"https://storage.example.com/storage/v1/object/public/thumbnails/thumbnails/{compute_url_hash(ig_url)}.webp"
    )
    # Single asset must stay 1 image (never [uploaded_webp, cropped_ext_thumb])
    assert ig_out["item"]["media_items"] == [expected_ig_webp]

    tt_out = await enrich_item(mock_db, "item-tt-generic")
    assert tt_out["status"] == "ok"
    assert tt_out["item"]["title"] == "Trick shot compilation 2026"

    fb_out = await enrich_item(mock_db, "item-fb-generic")
    assert fb_out["status"] == "ok"
    assert fb_out["item"]["title"] == "เน้นเข้ารอบ ไม่เน้นเข้าร่วม"

    yt_out = await enrich_item(mock_db, "item-yt-noisy")
    assert yt_out["status"] == "ok"
    assert yt_out["item"]["title"] == "Match Highlight"

    # Re-saving / bumping an item whose title remained generic schedules re-enrichment
    from Database.schemas import ItemCreateRequest

    created_ig = create_or_bump_item(
        mock_db,
        "user-1",
        ItemCreateRequest(
            url="https://www.instagram.com/reel/NEW_BUMP_123/",
            title="Instagram",
            platform="instagram",
            content_type="video",
        ),
    )
    mock_db.table("items").update({"enrich_status": "done"}).eq("id", created_ig["id"]).execute()
    bumped_again = create_or_bump_item(
        mock_db,
        "user-1",
        ItemCreateRequest(
            url="https://www.instagram.com/reel/NEW_BUMP_123/",
            title="Instagram",
            platform="instagram",
            content_type="video",
        ),
    )
    assert bumped_again["enrich_status"] == "pending"


@pytest.mark.asyncio
async def test_fb_multiline_title_shortened_and_space_around_emoji_preserved(hermetic_isolation, monkeypatch):
    """Facebook multiline og:title collapses to 1st line and keeps description whole even when spacing around emoji differs."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://www.facebook.com/reel/1HBywf5BXx"):
            html = (
                "<html><head>"
                '<meta property="og:title" content="BotTeam 🤖 ทีมพนักงาน AI ที่ทำงานอยู่ในคอมพิวเตอร์ของคุณเอง&#10;ไม่ใช่แค่แชท แต่ทำงานแทนได้จริง">'
                '<meta property="og:description" content="BotTeam🤖 ทีมพนักงาน AI ที่ทำงานอยู่ในคอมพิวเตอร์ของคุณเอง&#10;ไม่ใช่แค่แชท แต่ทำงานแทนได้จริง&#10;รายละเอียดเพิ่มเติมที่ลิงก์">'
                '<meta property="og:image" content="https://scontent.xx.fbcdn.net/botteam-thumb.jpg">'
                "</head><body></body></html>"
            )
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=html, request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    res = await extract_unfurl_metadata("https://www.facebook.com/reel/1HBywf5BXx")
    assert "\n" not in res.title
    assert res.title == "BotTeam🤖 ทีมพนักงาน AI ที่ทำงานอยู่ในคอมพิวเตอร์ของคุณเอง"
    assert "รายละเอียดเพิ่มเติมที่ลิงก์" in res.description
    assert res.description.endswith("รายละเอียดเพิ่มเติมที่ลิงก์")



def test_ig_embed_sidecar_extracts_all_carousel_slides():
    """IG carousel embeds render only slide #1 as <img>; remaining slides come from escaped JSON display_url."""
    from Unfurl.extractors import _parse_instagram_embed_captioned

    def esc(u: str) -> str:
        return u.replace("/", "\\\\\\/").replace("&", "\\\\u0026")

    slides = [
        f"https://scontent-bkk1-2.cdninstagram.com/v/t51.82787-15/90758025{i}_18640174489025585_210324011829699057{i}_n.heic?stp=dst-jpg_e35_tt6&oh=abc{i}"
        for i in range(6)
    ]
    blob = '\\"edge_sidecar_to_children\\":{' + ",".join(
        f'\\"display_url\\":\\"{esc(u)}\\"' for u in [slides[0], *slides]
    ) + "}"
    html = (
        "<html><body>"
        f'<div class="Content"><img class="EmbeddedMediaImage" src="{slides[0]}"></div>'
        f"<script>{blob}</script></body></html>"
    )
    res = _parse_instagram_embed_captioned(html, "https://www.instagram.com/p/X/embed/captioned/")
    assert res["media_items"] == slides[:5]


@pytest.mark.asyncio
async def test_ig_reels_plural_fetches_singular_reel_meta_while_keeping_canonical_url_and_fb_intact(
    hermetic_isolation, monkeypatch
):
    """IG /reels/<code> fetches meta from /reel/<code>/ while keeping original canonical_url/url_hash and leaving Facebook /reels/ untouched."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    seen_urls: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        if url.startswith("https://www.instagram.com/reels/"):
            # Simulate IG bouncing /reels/ to login wall while /reel/ serves metadata
            return httpx.Response(
                302,
                headers={"location": "https://www.instagram.com/accounts/login/"},
                request=request,
            )
        if url.startswith("https://www.instagram.com/reel/Dfz09kGyug0/embed/captioned"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>The link to this photo or video may be broken</body></html>",
                request=request,
            )
        if url.startswith("https://www.instagram.com/reel/Dfz09kGyug0/"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="user บน Instagram: &quot;แคปชั่นจริงจากรีล&quot;">'
                    '<meta property="og:description" content=\'100 likes, 5 comments - user on May 1, 2026: "แคปชั่นจริงจากรีล". \'>'
                    '<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51/cover_reel.jpg">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        if url.startswith("https://www.facebook.com/reels/999888777"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="Facebook Reel Caption">'
                    '<meta property="og:description" content="Facebook Reel Caption Full">'
                    '<meta property="og:image" content="https://scontent.xx.fbcdn.net/fb_reel.jpg">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    ig_input = "https://www.instagram.com/reels/Dfz09kGyug0/"
    ig_res = await extract_unfurl_metadata(ig_input)
    assert ig_res.url == "https://www.instagram.com/reels/Dfz09kGyug0"
    assert ig_res.canonical_url == "https://www.instagram.com/reels/Dfz09kGyug0"
    assert ig_res.url_hash == compute_url_hash(ig_input)
    assert ig_res.title == "แคปชั่นจริงจากรีล"
    assert ig_res.embed_url == "https://www.instagram.com/reel/Dfz09kGyug0/embed"
    assert any(u.startswith("https://www.instagram.com/reel/Dfz09kGyug0/") for u in seen_urls)
    assert not any(u.startswith("https://www.instagram.com/reels/Dfz09kGyug0") for u in seen_urls)

    seen_urls.clear()
    fb_res = await extract_unfurl_metadata("https://www.facebook.com/reels/999888777")
    assert fb_res.title == "Facebook Reel Caption"
    assert any(u.startswith("https://www.facebook.com/reels/999888777") for u in seen_urls)


@pytest.mark.asyncio
async def test_ig_playable_video_resolver_extracts_mp4_and_enforces_access(
    hermetic_isolation, mock_db, monkeypatch
):
    """extract_instagram_playable_video_url & resolve_item_playable_video extract validated Meta CDN .mp4 or return None cleanly."""
    from fastapi import HTTPException
    from Unfurl.extractors import extract_instagram_playable_video_url
    from Unfurl.service import resolve_item_playable_video

    mp4_url = "https://scontent-bkk1-1.cdninstagram.com/o1/v/t2/f2/m86/sample_reel.mp4?oh=123&oe=456"
    escaped_mp4 = mp4_url.replace("/", "\\\\\\/").replace("&", "\\\\u0026")
    bad_mp4 = "https://evil.example.com/bad.mp4".replace("/", "\\\\\\/")

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://www.instagram.com/reel/DYowlO2v1ww/embed/captioned"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=f'<script>"video_url":"{bad_mp4}","other":{{"video_url":"{escaped_mp4}"}}</script>',
                request=request,
            )
        if url.startswith("https://www.instagram.com/reel/DfzqfsjyQkb/embed"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>Watch on Instagram</body></html>",
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    # Validates host allowlist (skips evil.example.com, keeps scontent-bkk1-1.cdninstagram.com)
    assert await extract_instagram_playable_video_url("https://www.instagram.com/reels/DYowlO2v1ww/") == mp4_url
    # Gracefully returns None when IG omits video_url
    assert await extract_instagram_playable_video_url("https://www.instagram.com/reel/DfzqfsjyQkb/") is None

    mock_db.tables["items"].append(
        {
            "id": "item-ig-mp4",
            "owner_id": "user-1",
            "user_id": "user-1",
            "folder_id": None,
            "url": "https://www.instagram.com/reels/DYowlO2v1ww/",
            "embed_type": "instagram",
            "embed_url": "https://www.instagram.com/reel/DYowlO2v1ww/embed",
            "platform": "instagram",
            "content_type": "video",
        }
    )
    resolved = await resolve_item_playable_video(mock_db, user_id="user-1", item_id="item-ig-mp4")
    assert resolved["video_url"] == mp4_url
    assert resolved["embed_url"] == "https://www.instagram.com/reel/DYowlO2v1ww/embed"

    with pytest.raises(HTTPException) as exc_info:
        await resolve_item_playable_video(mock_db, user_id="stranger-2", item_id="item-ig-mp4")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_profile_pages_youtube_community_post_and_tiktok_photo_extraction(hermetic_isolation, mock_db):
    """Verify FB Page, IG Profile, TikTok Channel/Photo, YouTube Community Post multi-image, and YouTube full shortDescription."""
    import json

    yt_post_url = "https://www.youtube.com/post/UgkxMultiPhotoPost123"
    yt_video_url = "https://www.youtube.com/watch?v=AbCdEf12345"
    tt_photo_url = "https://www.tiktok.com/@creator/photo/7388112233445566778"
    tt_profile_url = "https://www.tiktok.com/@creator"
    ig_profile_url = "https://www.instagram.com/travel_th/"
    fb_page_url = "https://www.facebook.com/TravelTHPage"

    yt_post_json = {
        "contents": {
            "twoColumnBrowseResultsRenderer": {
                "tabs": [
                    {
                        "tabRenderer": {
                            "content": {
                                "sectionListRenderer": {
                                    "contents": [
                                        {
                                            "itemSectionRenderer": {
                                                "contents": [
                                                    {
                                                        "backstagePostThreadRenderer": {
                                                            "post": {
                                                                "backstagePostRenderer": {
                                                                    "authorText": {"runs": [{"text": "Google"}]},
                                                                    "contentText": {
                                                                        "runs": [
                                                                            {"text": "First line of YT post!\n\nSecond paragraph with link "},
                                                                            {"text": "https://example.com/guide"},
                                                                        ]
                                                                    },
                                                                    "backstageAttachment": {
                                                                        "postMultiImageRenderer": {
                                                                            "images": [
                                                                                {
                                                                                    "backstageImageRenderer": {
                                                                                        "image": {
                                                                                            "thumbnails": [
                                                                                                {"url": "https://yt3.ggpht.com/imgA1111111111=s400-nd", "width": 400, "height": 400},
                                                                                                {"url": "https://yt3.ggpht.com/imgA1111111111=s1080-nd", "width": 1080, "height": 1080},
                                                                                            ]
                                                                                        }
                                                                                    }
                                                                                },
                                                                                {
                                                                                    "backstageImageRenderer": {
                                                                                        "image": {
                                                                                            "thumbnails": [
                                                                                                {"url": "https://yt3.ggpht.com/imgB2222222222=s1080-nd", "width": 1080, "height": 1080},
                                                                                            ]
                                                                                        }
                                                                                    }
                                                                                },
                                                                                {
                                                                                    "backstageImageRenderer": {
                                                                                        "image": {
                                                                                            "thumbnails": [
                                                                                                {"url": "https://yt3.ggpht.com/imgC3333333333=s1080-nd", "width": 1080, "height": 1080},
                                                                                            ]
                                                                                        }
                                                                                    }
                                                                                },
                                                                            ]
                                                                        }
                                                                    },
                                                                }
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        }
    }
    tt_photo_uni = {
        "__DEFAULT_SCOPE__": {
            "webapp.video-detail": {
                "itemInfo": {
                    "itemStruct": {
                        "desc": "Full photo slideshow caption #travel",
                        "author": {"uniqueId": "creator", "nickname": "CreatorTH"},
                        "imagePost": {
                            "title": "Top 3 Cafes in Chiang Mai",
                            "images": [
                                {"imageURL": {"urlList": ["https://p16-sign.tiktokcdn.com/tos-alisg/photo1~tplv.jpeg"]}},
                                {"imageURL": {"urlList": ["https://p16-sign.tiktokcdn.com/tos-alisg/photo2~tplv.jpeg"]}},
                            ],
                        },
                    }
                }
            }
        }
    }
    tt_profile_uni = {
        "__DEFAULT_SCOPE__": {
            "webapp.user-detail": {
                "userInfo": {
                    "user": {
                        "uniqueId": "creator",
                        "nickname": "Cafe Guide TH",
                        "signature": "Daily coffee & cafe reviews in Thailand",
                        "avatarLarger": "https://p16-sign.tiktokcdn.com/tos-alisg/avatar/creator_1080.jpeg",
                    }
                }
            }
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith(yt_post_url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="First line...">'
                    '<meta property="og:image" content="https://yt3.ggpht.com/channelAvatar999=s900-c">'
                    f'</head><body><img src="https://i.ytimg.com/vi/sidebar999/hqdefault.jpg" width="400" height="300">'
                    f"<script>var ytInitialData = {json.dumps(yt_post_json)};</script></body></html>"
                ),
                request=request,
            )
        if url.startswith("https://www.youtube.com/oembed") and "AbCdEf12345" in url:
            return httpx.Response(
                200,
                json={
                    "title": "YT Full Desc Video",
                    "author_name": "DevChannel",
                    "thumbnail_url": "https://i.ytimg.com/vi/AbCdEf12345/hqdefault.jpg",
                    "html": '<iframe src="https://www.youtube.com/embed/AbCdEf12345"></iframe>',
                },
                request=request,
            )
        if url.startswith(yt_video_url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="YT Full Desc Video">'
                    '<meta property="og:description" content="Short truncated og desc...">'
                    '<meta property="og:image" content="https://i.ytimg.com/vi/AbCdEf12345/maxresdefault.jpg">'
                    '</head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Complete multi-line YouTube description with chapters and links."}};</script></body></html>'
                ),
                request=request,
            )
        if url.startswith(tt_photo_url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    "<html><head><title>CreatorTH on TikTok</title>"
                    '<meta name="description" content="210 Likes, 5 Comments. TikTok photo from CreatorTH (@creator)">'
                    f'</head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{json.dumps(tt_photo_uni)}</script></body></html>'
                ),
                request=request,
            )
        if url.startswith("https://www.tiktok.com/oembed") and "creator" in url:
            return httpx.Response(
                200,
                json={"embed_type": "profile", "author_name": "CreatorTH", "title": "TikTok's Creator Profile"},
                request=request,
            )
        if url.startswith(tt_profile_url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=f'<html><head></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{json.dumps(tt_profile_uni)}</script></body></html>',
                request=request,
            )
        if url.startswith(ig_profile_url.rstrip("/")):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="Travel TH (@travel_th) • รูปและวิดีโอ Instagram">'
                    '<meta property="og:description" content="ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์ - ดูรูปภาพและวิดีโอบน Instagram จาก Travel TH (@travel_th)">'
                    '<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.82787-19/profile_pic_1080.jpg">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        if url.startswith(fb_page_url):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="TravelTH Official">'
                    '<meta property="og:description" content="TravelTH Official. 500K likes · 20K talking about this. Best travel spots in Thailand.">'
                    '<meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/page_cover_1200.jpg">'
                    '</head><body><img src="https://scontent.xx.fbcdn.net/v/t39/feed_extra_888.jpg" width="500" height="500">'
                    '<script>{"message":{"text":"Very long timeline feed post that must not replace the official page bio description."},"viewer_image":{"uri":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t39\\/timeline_post_999.jpg"}}</script></body></html>'
                ),
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    # 1. YouTube Community Post: full text + all 3 deduped HD images + post content_type
    yt_post = await extract_unfurl_metadata(yt_post_url, fetch_full_description=True)
    assert yt_post.content_type == "post"
    assert yt_post.embed_url is None
    assert yt_post.title == "First line of YT post!"
    assert "Second paragraph with link https://example.com/guide" in (yt_post.description or "")
    assert len(yt_post.media_items) == 3
    assert yt_post.media_items[0].endswith("=s1080-nd")

    # 2. Brand-new YouTube Video via enrich_item (empty old_desc) fetches full shortDescription & HD cover
    mock_db.tables["items"].append(
        {
            "id": "item-yt-new",
            "user_id": "user-1",
            "folder_id": None,
            "url": yt_video_url,
            "url_hash": compute_url_hash(yt_video_url),
            "platform": "youtube",
            "title": yt_video_url,
            "description": "",
            "status": "inbox",
            "enrich_status": "pending",
        }
    )
    yt_enriched = await enrich_item(mock_db, "item-yt-new")
    assert yt_enriched["item"]["description"] == "Complete multi-line YouTube description with chapters and links."
    assert yt_enriched["item"]["media_items"] == ["https://i.ytimg.com/vi/AbCdEf12345/maxresdefault.jpg"]

    # 3. TikTok Photo Post: extracts imagePost.title + desc + 2 photos, no video embed
    tt_photo = await extract_unfurl_metadata(tt_photo_url, fetch_full_description=True)
    assert tt_photo.content_type == "post"
    assert tt_photo.embed_url is None
    assert tt_photo.title == "Top 3 Cafes in Chiang Mai"
    assert "Full photo slideshow caption #travel" in (tt_photo.description or "")
    assert len(tt_photo.media_items) == 2

    # 4. TikTok Channel / Profile: extracts nickname, signature bio, avatar, no video embed
    tt_prof = await extract_unfurl_metadata(tt_profile_url, fetch_full_description=True)
    assert tt_prof.content_type == "link"
    assert tt_prof.embed_url is None
    assert tt_prof.title == "Cafe Guide TH (@creator)"
    assert tt_prof.description == "Daily coffee & cafe reviews in Thailand"
    assert tt_prof.media_items == ["https://p16-sign.tiktokcdn.com/tos-alisg/avatar/creator_1080.jpeg"]

    # 5. IG Profile & FB Page: clean titles/descriptions, profile avatar retained, no post.php embed
    ig_prof = await extract_unfurl_metadata(ig_profile_url, fetch_full_description=True)
    assert ig_prof.content_type == "link"
    assert ig_prof.embed_url is None
    assert ig_prof.title == "Travel TH (@travel_th)"
    assert ig_prof.description == "ผู้ติดตาม 120K คน, กำลังติดตาม 50 คน, 310 โพสต์"
    assert len(ig_prof.media_items) == 1

    fb_page = await extract_unfurl_metadata(fb_page_url, fetch_full_description=True)
    assert fb_page.content_type == "link"
    assert fb_page.embed_url is None
    assert fb_page.title == "TravelTH Official"
    assert fb_page.description == "Best travel spots in Thailand."
    assert fb_page.media_items == ["https://scontent.xx.fbcdn.net/v/t39.30808-6/page_cover_1200.jpg"]

    # 6. Cache payload preserves /avatar/ URLs on profile pages
    from Unfurl.service import _sanitize_cached_payload, resolve_item_playable_video
    from Database.repository import create_or_bump_item
    from Database.schemas import ItemCreateRequest

    cached_tt = _sanitize_cached_payload(
        {
            "title": tt_prof.title,
            "description": tt_prof.description,
            "image_url": tt_prof.image_url,
            "media_items": tt_prof.media_items,
            "platform": "tiktok",
            "content_type": "link",
        },
        base_url=tt_profile_url,
    )
    assert cached_tt["image_url"] == "https://p16-sign.tiktokcdn.com/tos-alisg/avatar/creator_1080.jpeg"

    # 7. resolve_item_playable_video fails closed on non-allowlisted embed_url
    mock_db.tables["items"].append(
        {
            "id": "item-bad-embed",
            "owner_id": "user-1",
            "user_id": "user-1",
            "url": "https://example.com/page",
            "embed_type": "youtube",
            "embed_url": "https://evil.example.com/embed/123",
        }
    )
    bad_video_res = await resolve_item_playable_video(mock_db, user_id="user-1", item_id="item-bad-embed")
    assert bad_video_res["embed_url"] is None

    # 8. create_or_bump_item does NOT re-trigger pending enrich on already-enriched YT /post/ or TikTok @user?lang=en
    mock_db.tables["items"].extend(
        [
            {
                "id": "item-yt-post-done",
                "owner_id": "user-1",
                "user_id": "user-1",
                "url": yt_post_url,
                "url_hash": compute_url_hash(yt_post_url),
                "platform": "youtube",
                "content_type": "post",
                "title": "First line of YT post!",
                "description": "Full post description",
                "image_url": "https://yt3.ggpht.com/imgA1111111111=s1080-nd",
                "enrich_status": "done",
                "status": "inbox",
            },
            {
                "id": "item-tt-prof-done",
                "owner_id": "user-1",
                "user_id": "user-1",
                "url": f"{tt_profile_url}?lang=en",
                "url_hash": compute_url_hash(f"{tt_profile_url}?lang=en"),
                "platform": "tiktok",
                "content_type": "link",
                "title": "Cafe Guide TH (@creator)",
                "description": "Daily coffee reviews",
                "image_url": "https://p16-sign.tiktokcdn.com/tos-alisg/avatar/creator_1080.jpeg",
                "enrich_status": "unfurled",
                "status": "inbox",
            },
        ]
    )
    bumped_yt = create_or_bump_item(mock_db, "user-1", ItemCreateRequest(url=yt_post_url))
    assert bumped_yt["enrich_status"] == "done"
    bumped_tt = create_or_bump_item(mock_db, "user-1", ItemCreateRequest(url=f"{tt_profile_url}?lang=en"))
    assert bumped_tt["enrich_status"] == "unfurled"


@pytest.mark.asyncio
async def test_youtube_default_full_description_and_ig_no_generic_title_regression(hermetic_isolation, monkeypatch):
    """Verify extract_unfurl_metadata(..., fetch_full_description=True) pulls YT attributedDescriptionBodyText and IG never returns raw URL / generic 'Instagram' when author/JSON caption exists."""
    monkeypatch.delenv("META_OEMBED_ACCESS_TOKEN", raising=False)
    yt_url = "https://www.youtube.com/watch?v=AttrDesc1234"
    ig_user_post = "https://www.instagram.com/cafe.tester/p/NoCap999/"

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u.startswith("https://www.youtube.com/oembed"):
            return httpx.Response(
                200,
                json={
                    "title": "YT Attributed Desc Test",
                    "author_name": "TechLab",
                    "thumbnail_url": "https://i.ytimg.com/vi/AttrDesc1234/hqdefault.jpg",
                    "html": '<iframe src="https://www.youtube.com/embed/AttrDesc1234"></iframe>',
                },
                request=request,
            )
        if u == yt_url:
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text='<html><head><title>YT Attributed Desc Test - YouTube</title></head><body><script>var ytInitialData={"attributedDescriptionBodyText":{"content":"Full YT chapters and detailed description line 1.\\nLine 2 resources"}};</script></body></html>',
                request=request,
            )
        if u == "https://www.instagram.com/p/NoCap999/embed/captioned/":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text='<html><body><script>window.__d={"owner":{"username":"cafe.tester"},"edge_media_to_caption":{"edges":[{"node":{"text":"Secret coffee recipe from JSON!"}}]}};</script></body></html>',
                request=request,
            )
        if u.startswith("https://www.instagram.com/cafe.tester/p/NoCap999"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text='<html><head><title>Instagram</title><meta property="og:title" content="Instagram"></head><body></body></html>',
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    yt_res = await extract_unfurl_metadata(yt_url, fetch_full_description=True)
    assert yt_res.title == "YT Attributed Desc Test"
    assert "Full YT chapters and detailed description line 1." in (yt_res.description or "")

    ig_res = await extract_unfurl_metadata(ig_user_post)
    assert ig_res.title is not None
    assert ig_res.title != "Instagram"
    assert "Secret coffee recipe from JSON!" in ig_res.title


@pytest.mark.asyncio
async def test_cover_preserve_original_keeps_full_resolution_bytes(hermetic_isolation, monkeypatch):
    """When COVER_PRESERVE_ORIGINAL=true, process_and_upload_cover uploads original bytes without downscaling."""
    monkeypatch.setenv("COVER_PRESERVE_ORIGINAL", "true")
    raw_jpeg = make_gradient_noise_jpeg_bytes(1600, 1200)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.example.com" and request.url.path == "/hd-1600.jpg":
            return httpx.Response(
                200,
                headers={"Content-Type": "image/jpeg", "Content-Length": str(len(raw_jpeg))},
                content=raw_jpeg,
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)
    url_hash = compute_url_hash("https://example.com/hd-fb-album")
    captured: List[Dict[str, Any]] = []

    def mock_uploader(path: str, data: bytes, content_type: str) -> str:
        captured.append({"path": path, "data": data, "content_type": content_type})
        return f"https://cdn.supabase.test/storage/v1/object/public/{path}"

    final_url, stored = await process_and_upload_cover(
        "https://cdn.example.com/hd-1600.jpg",
        url_hash=url_hash,
        storage_uploader=mock_uploader,
    )
    assert stored is True
    assert final_url == f"https://cdn.supabase.test/storage/v1/object/public/thumbnails/{url_hash}.webp"
    assert len(captured) == 1
    assert captured[0]["content_type"] == "image/jpeg"
    assert captured[0]["data"] == raw_jpeg
    with Image.open(BytesIO(captured[0]["data"])) as img:
        assert img.size == (1600, 1200)


@pytest.mark.asyncio
async def test_facebook_share_crawler_fallback_and_tiktok_player_v1_extraction(hermetic_isolation, monkeypatch):
    """Facebook /share/p/ falls back to facebookexternalhit/1.1 when browser UA lacks images; TikTok player/v1 oEmbed resolves embed_url."""
    monkeypatch.setenv("ALLOW_META_CRAWLER_UA", "true")
    from Unfurl.extractors import _is_short_or_share_url

    assert _is_short_or_share_url("https://www.tiktok.com/t/ZTNabc123/") is True

    fb_share = "https://www.facebook.com/share/p/1FCTT8VFWu/?mibextid=wwXIfr"
    fb_resolved = "https://www.facebook.com/droidsans/posts/pfbid0BpjuxTest"
    fb_lookaside = "https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=1467294488863132"
    tt_short = "https://vt.tiktok.com/ZSmabcd99/"
    tt_resolved = "https://www.tiktok.com/@creator/video/7481234567890123456"
    seen_fb_uas: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        ua = request.headers.get("user-agent", "")
        if u.startswith("https://www.facebook.com/share/p/1FCTT8VFWu"):
            return httpx.Response(302, headers={"Location": fb_resolved}, request=request)
        if u.startswith(fb_resolved):
            seen_fb_uas.append(ua)
            if "facebookexternalhit" in ua.lower():
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html; charset=utf-8"},
                    text=(
                        "<html><head>"
                        '<meta property="og:title" content="Chrome น่าจะทำแบบนี้บ้างนะครับ.Stanislav Vishnevskiy...">'
                        '<meta property="og:description" content="Chrome น่าจะทำแบบนี้บ้างนะครับ.Stanislav Vishnevskiy เผยโฉมแอป Discord Phoenix">'
                        f'<meta property="og:image" content="{fb_lookaside}">'
                        "</head><body></body></html>"
                    ),
                    request=request,
                )
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    "<html><head>"
                    '<meta property="og:title" content="Chrome น่าจะทำแบบนี้บ้างนะครับ.Stanislav Vishnevskiy...">'
                    '<meta property="og:description" content="Chrome น่าจะทำแบบนี้บ้างนะครับ...ด้วยภา...">'
                    "</head><body></body></html>"
                ),
                request=request,
            )
        if u.startswith("https://www.facebook.com/plugins/post.php"):
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<html></html>", request=request)
        if u.startswith("https://vt.tiktok.com/ZSmabcd99"):
            return httpx.Response(302, headers={"Location": tt_resolved}, request=request)
        if u.startswith("https://www.tiktok.com/oembed"):
            return httpx.Response(
                200,
                json={
                    "title": "Cool TikTok clip",
                    "author_name": "creator",
                    "thumbnail_url": "https://p16-sign.tiktokcdn.com/tos-alisg/tt-cover.jpeg",
                    "html": '<blockquote class="tiktok-embed"><iframe src="https://www.tiktok.com/player/v1/7481234567890123456?embed_from=oembed"></iframe></blockquote>',
                },
                request=request,
            )
        if u == tt_resolved:
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text='<html><head><meta property="og:title" content="Cool TikTok clip"></head><body></body></html>',
                request=request,
            )
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    fb_res = await extract_unfurl_metadata(fb_share)
    assert any("facebookexternalhit" in ua.lower() for ua in seen_fb_uas)
    assert fb_res.media_items == [fb_lookaside]
    assert fb_res.preview_status == "ok"
    assert "Discord Phoenix" in (fb_res.description or "")

    tt_res = await extract_unfurl_metadata(tt_short)
    assert tt_res.canonical_url == tt_resolved
    assert tt_res.embed_url is not None
    assert tt_res.embed_url.startswith("https://www.tiktok.com/player/v1/7481234567890123456")


@pytest.mark.asyncio
async def test_cover_webp_fallback_cache_skip_and_ig_embed_rescue(hermetic_isolation, mock_db, monkeypatch):
    """Cover upload falls back to WebP on original failure, cache skips 0-image/lookaside Meta rows, and IG 403 rescues via embed/captioned."""
    monkeypatch.setenv("COVER_PRESERVE_ORIGINAL", "true")
    monkeypatch.setenv("ALLOW_META_CRAWLER_UA", "true")
    raw_jpeg = make_gradient_noise_jpeg_bytes(900, 600)
    ig_url = "https://www.instagram.com/p/Ig403Rescue1/"
    ig_cover = "https://scontent.cdninstagram.com/v/t51.2885-15/ig_rescue_cover.jpg"

    def handler(request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if u == "https://cdn.example.com/fb-raw.jpg":
            return httpx.Response(
                200,
                headers={"Content-Type": "image/jpeg", "Content-Length": str(len(raw_jpeg))},
                content=raw_jpeg,
                request=request,
            )
        if u.startswith("https://www.instagram.com/p/Ig403Rescue1/embed/captioned/"):
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    "<html><body>"
                    '<div class="Header"><span class="UsernameText">foodie_th</span></div>'
                    f'<img class="EmbeddedMediaImage" src="{ig_cover}" />'
                    '<div class="Caption">Rescued IG caption text</div>'
                    "</body></html>"
                ),
                request=request,
            )
        if u.startswith("https://www.instagram.com/p/Ig403Rescue1"):
            return httpx.Response(403, text="Forbidden", request=request)
        return httpx.Response(404, request=request)

    hermetic_isolation.set_handler(handler)

    attempts: List[str] = []

    def uploader_rejects_jpeg(path: str, data: bytes, content_type: str) -> str:
        attempts.append(content_type)
        if content_type != "image/webp":
            raise RuntimeError("Bucket MIME rejected")
        return f"https://cdn.supabase.test/storage/v1/object/public/{path}"

    fb_hash = compute_url_hash("https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=1")
    final_url, stored = await process_and_upload_cover(
        "https://cdn.example.com/fb-raw.jpg",
        url_hash=fb_hash,
        storage_uploader=uploader_rejects_jpeg,
    )
    assert stored is True
    assert attempts == ["image/jpeg", "image/webp"]
    assert final_url == f"https://cdn.supabase.test/storage/v1/object/public/thumbnails/{fb_hash}.webp"

    from Unfurl.service import find_recent_unfurl_cache

    now_iso = datetime.now(timezone.utc).isoformat()
    stale_hash = compute_url_hash("https://www.facebook.com/share/p/StaleZero1")
    mock_db.tables["items"].extend(
        [
            {
                "id": "fb-lookaside-img",
                "owner_id": "usr-cache",
                "url": "https://www.facebook.com/share/p/StaleZero1",
                "canonical_url": "https://www.facebook.com/share/p/StaleZero1",
                "url_hash": stale_hash,
                "platform": "facebook",
                "title": "Valid Post Title",
                "image_url": "https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=99",
                "media_items": ["https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=99"],
                "enrich_status": "unfurled",
                "enrich_error": None,
                "unfurled_at": now_iso,
            },
            {
                "id": "fb-zero-img",
                "owner_id": "usr-cache",
                "url": "https://www.facebook.com/share/p/StaleZero1",
                "canonical_url": "https://www.facebook.com/share/p/StaleZero1",
                "url_hash": stale_hash,
                "platform": "facebook",
                "title": "Valid Post Title",
                "image_url": None,
                "media_items": [],
                "enrich_status": "unfurled",
                "enrich_error": None,
                "unfurled_at": (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(),
            },
            {
                "id": "fb-target-empty",
                "owner_id": "usr-cache",
                "url": "https://www.facebook.com/share/p/StaleZero1",
                "canonical_url": "https://www.facebook.com/share/p/StaleZero1",
                "url_hash": stale_hash,
                "platform": "facebook",
                "title": "Valid Post Title",
                "image_url": None,
                "media_items": [],
                "enrich_status": "pending",
            },
        ]
    )
    donor_hit = find_recent_unfurl_cache(mock_db, stale_hash, user_id="usr-cache")
    assert donor_hit is not None
    assert donor_hit["id"] == "fb-zero-img"
    res_empty_target = await enrich_item(mock_db, "fb-target-empty", force_refresh=False)
    assert res_empty_target["cached"] is False

    ig_res = await extract_unfurl_metadata(ig_url)
    assert ig_res.preview_status == "ok"
    assert ig_res.media_items == [ig_cover]
    assert ig_res.embed_url == "https://www.instagram.com/p/Ig403Rescue1/embed"
