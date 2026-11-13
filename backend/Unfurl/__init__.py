"""Rich Unfurl Engine package for Just-Save-It (0 AI tokens)."""

from .extractors import UnfurlResult, extract_unfurl_metadata, filter_and_cap_images, is_junk_image_url
from .router import preview_rate_limiter, refresh_rate_limiter, router
from .security import (
    EMBED_ALLOWED_HOSTS,
    SlidingWindowRateLimiter,
    require_internal_secret,
    validate_embed_url,
    verify_internal_secret,
)
from .service import enrich_item, find_recent_unfurl_cache, preview_url_readonly, retry_failed_enrichments
from .webp_storage import compress_image_to_webp, process_and_upload_cover

__all__ = [
    "EMBED_ALLOWED_HOSTS",
    "SlidingWindowRateLimiter",
    "UnfurlResult",
    "compress_image_to_webp",
    "enrich_item",
    "extract_unfurl_metadata",
    "filter_and_cap_images",
    "find_recent_unfurl_cache",
    "is_junk_image_url",
    "preview_rate_limiter",
    "preview_url_readonly",
    "process_and_upload_cover",
    "refresh_rate_limiter",
    "require_internal_secret",
    "retry_failed_enrichments",
    "router",
    "validate_embed_url",
    "verify_internal_secret",
]
