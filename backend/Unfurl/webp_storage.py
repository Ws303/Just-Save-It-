"""Cover #1 WebP resize/compression & Supabase Storage upload with graceful fallback.

Enforces PRODUCT_SPEC.md §8.1 storage policy:
- Download ONLY Cover #1 (`image_url`) safely via SSRF-guarded `_fetch_url_safely`.
- Limit raw download size <= 5 MB.
- Resize proportionally to width <= 800 px and encode as WebP (< 120 KB) via Pillow.
- Upload to Supabase Storage bucket `thumbnails` at `thumbnails/{url_hash}.webp`.
- Graceful Degrade: if download, decode, encode, or storage upload fails, return the
  validated `external_image_url` without failing the item save/unfurl pipeline.
"""

from io import BytesIO
import logging
import os
from typing import Any, Callable, Optional, Tuple
import urllib.parse

from PIL import Image, ImageOps

from Ai.content_extractor import DEFAULT_TIMEOUT_SEC
from .security import sanitize_external_url, stream_fetch_limited

logger = logging.getLogger("just_save_it.unfurl.webp_storage")

MAX_RAW_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_IMAGE_PIXELS = 25_000_000  # 25 MP decompression-bomb guard
MAX_COVER_WIDTH_PX = 800
MAX_WEBP_BYTES = 120 * 1024  # 120 KB
DEFAULT_STORAGE_BUCKET = "thumbnails"

StorageUploaderFn = Callable[[str, bytes, str], str]


def build_cover_storage_path(url_hash: str) -> str:
    """Return canonical storage object path `thumbnails/{url_hash}.webp`."""
    safe_hash = "".join(ch for ch in (url_hash or "").strip().lower() if ch in "0123456789abcdef")
    if not safe_hash:
        raise ValueError("Invalid url_hash for thumbnail storage path.")
    return f"thumbnails/{safe_hash}.webp"


def compress_image_to_webp(
    raw_bytes: bytes,
    max_width: int = MAX_COVER_WIDTH_PX,
    max_bytes: int = MAX_WEBP_BYTES,
) -> bytes:
    """Decode raster image bytes, resize to width <= max_width, and encode WebP < max_bytes."""
    if not raw_bytes:
        raise ValueError("Empty image payload.")
    if len(raw_bytes) > MAX_RAW_IMAGE_BYTES:
        raise ValueError(f"Raw image exceeds {MAX_RAW_IMAGE_BYTES} byte limit.")

    with Image.open(BytesIO(raw_bytes)) as img:
        raw_w, raw_h = img.size
        if raw_w <= 0 or raw_h <= 0:
            raise ValueError("Invalid image dimensions.")
        if (raw_w * raw_h) > MAX_IMAGE_PIXELS:
            raise ValueError(f"Image pixel count {raw_w * raw_h} exceeds {MAX_IMAGE_PIXELS} safety cap.")

        img = ImageOps.exif_transpose(img)
        if img.mode in ("P", "LA"):
            img = img.convert("RGBA")
        elif img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")

        width, height = img.size

        if width > max_width:
            new_height = max(1, round(height * (max_width / width)))
            img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)

        current_img = img
        for scale_attempt in range(3):
            for quality in (80, 70, 60, 50, 40, 30, 20):
                out = BytesIO()
                current_img.save(out, format="WEBP", quality=quality, method=4)
                encoded = out.getvalue()
                if len(encoded) < max_bytes:
                    return encoded

            # Downscale 20% and retry if image still exceeds budget at quality=20
            cur_w, cur_h = current_img.size
            if cur_w <= 240 or scale_attempt == 2:
                break
            next_w = max(240, int(cur_w * 0.8))
            next_h = max(1, round(cur_h * (next_w / cur_w)))
            current_img = current_img.resize((next_w, next_h), Image.Resampling.LANCZOS)

    raise ValueError(f"Unable to compress cover image below {max_bytes} bytes.")


def _validate_image_content_type(raw_ct: str) -> None:
    ct = (raw_ct or "").split(";")[0].strip().lower()
    if ct == "image/svg+xml" or ct.startswith("text/"):
        raise ValueError(f"Unsupported cover image Content-Type '{ct}'.")


async def download_image_safely(
    image_url: str,
    max_bytes: int = MAX_RAW_IMAGE_BYTES,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
) -> Tuple[bytes, str]:
    """Stream-download an image with per-hop SSRF redirect validation and 5MB cap."""
    status_code, raw_ct, raw_bytes, _ = await stream_fetch_limited(
        image_url,
        max_bytes=max_bytes,
        reject_on_oversize=True,
        check_content_type=_validate_image_content_type,
        timeout_sec=timeout_sec,
    )
    if status_code != 200:
        raise ValueError(f"Image fetch failed with HTTP {status_code}.")

    content_type = raw_ct.split(";")[0].strip().lower()
    _validate_image_content_type(content_type)
    if not raw_bytes:
        raise ValueError("Image response body is empty.")

    return raw_bytes, content_type


def upload_webp_to_supabase_storage(
    db: Any,
    storage_path: str,
    webp_bytes: bytes,
    bucket: Optional[str] = None,
) -> Optional[str]:
    """Upload compressed WebP bytes to Supabase Storage and return public URL if available."""
    if db is None or not hasattr(db, "storage"):
        return None

    bucket_name = (bucket or os.getenv("SUPABASE_STORAGE_BUCKET", DEFAULT_STORAGE_BUCKET)).strip() or DEFAULT_STORAGE_BUCKET
    storage_bucket = db.storage.from_(bucket_name)

    try:
        storage_bucket.upload(
            storage_path,
            webp_bytes,
            {"content-type": "image/webp", "upsert": "true"},
        )
    except TypeError:
        storage_bucket.upload(storage_path, webp_bytes)

    public_url_res = storage_bucket.get_public_url(storage_path)
    if isinstance(public_url_res, str) and public_url_res.strip():
        return public_url_res.strip()
    if isinstance(public_url_res, dict):
        data = public_url_res.get("data")
        if isinstance(data, dict) and data.get("publicUrl"):
            return str(data["publicUrl"])
        for key in ("publicUrl", "public_url", "signedURL"):
            if public_url_res.get(key):
                return str(public_url_res[key])

    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    if supabase_url and "placeholder.supabase.co" not in supabase_url:
        encoded_path = urllib.parse.quote(storage_path, safe="/")
        return f"{supabase_url}/storage/v1/object/public/{bucket_name}/{encoded_path}"
    return None


async def process_and_upload_cover(
    external_image_url: Optional[str],
    url_hash: str,
    db: Any = None,
    storage_uploader: Optional[StorageUploaderFn] = None,
) -> Tuple[Optional[str], bool]:
    """Download, WebP-compress, and upload Cover #1; gracefully degrade to external URL on failure.

    Returns (final_image_url, stored_in_bucket).
    """
    if not external_image_url:
        return None, False

    try:
        raw_bytes, _ = await download_image_safely(external_image_url)
        webp_bytes = compress_image_to_webp(raw_bytes)
        storage_path = build_cover_storage_path(url_hash)

        if storage_uploader is not None:
            uploaded_url = storage_uploader(storage_path, webp_bytes, "image/webp")
            if uploaded_url:
                return uploaded_url, True
        else:
            uploaded_url = upload_webp_to_supabase_storage(db, storage_path, webp_bytes)
            if uploaded_url:
                return uploaded_url, True
    except Exception as exc:
        logger.warning(
            "Cover WebP processing/upload degraded to external URL for hash=%s: %s",
            url_hash,
            exc,
        )

    return sanitize_external_url(external_image_url), False
