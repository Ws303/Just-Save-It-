"""Rich Unfurl service orchestration: 7-day cross-user cache, DB update, preview, and retry cron."""

from datetime import datetime, timedelta, timezone
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status

from Ai.content_extractor import validate_safe_url
from Database.repository import _parse_iso, can_access_item
from Database.text_hygiene import canonicalize_url, clean_text_field, compute_url_hash
from .extractors import (
    MAX_MEDIA_ITEMS,
    _VALID_CONTENT_TYPES,
    extract_unfurl_metadata,
    filter_and_cap_images,
    is_junk_image_url,
)
from .security import (
    SlidingWindowRateLimiter,
    redact_secrets_in_text,
    sanitize_external_url,
    validate_embed_url,
)
from .webp_storage import StorageUploaderFn, process_and_upload_cover

logger = logging.getLogger("just_save_it.unfurl.service")

UNFURL_CACHE_TTL_DAYS = 7
MAX_ENRICH_RETRY_ATTEMPTS = 3


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def find_recent_unfurl_cache(
    db: Any,
    url_hash: str,
    exclude_item_id: Optional[str] = None,
    ttl_days: int = UNFURL_CACHE_TTL_DAYS,
    now_utc: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Return freshest unfurled item with matching url_hash within ttl_days (cross-user)."""
    query = db.table("items").select("*").eq("url_hash", url_hash)
    if callable(getattr(query, "in_", None)):
        query = query.in_("enrich_status", ["unfurled", "done"])
    if callable(getattr(query, "order", None)):
        query = query.order("unfurled_at", desc=True)
        if callable(getattr(query, "limit", None)):
            query = query.limit(5)
    res = query.execute()
    rows = res.data or []
    if not rows:
        return None

    now_ref = now_utc or _now_utc()
    cutoff = now_ref - timedelta(days=ttl_days)
    best_row: Optional[Dict[str, Any]] = None
    best_ts: Optional[datetime] = None

    for row in rows:
        if exclude_item_id and row.get("id") == exclude_item_id:
            continue
        if row.get("enrich_status") not in ("unfurled", "done"):
            continue
        unfurled_dt = _parse_iso(row.get("unfurled_at"))
        if unfurled_dt is None or unfurled_dt < cutoff:
            continue
        if best_ts is None or unfurled_dt > best_ts:
            best_ts = unfurled_dt
            best_row = dict(row)

    return best_row


def _sanitize_cached_payload(donor: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    raw_media = donor.get("media_items") or []
    if not isinstance(raw_media, list):
        raw_media = []

    capped_media = filter_and_cap_images(raw_media, base_url=base_url, max_images=MAX_MEDIA_ITEMS)
    raw_cover = donor.get("image_url")
    cover_candidate = sanitize_external_url(raw_cover) if isinstance(raw_cover, str) else None
    if cover_candidate and not is_junk_image_url(cover_candidate):
        cover_clean: Optional[str] = cover_candidate
        if not capped_media or capped_media[0] != cover_clean:
            capped_media = [cover_clean, *[u for u in capped_media if u != cover_clean]][:MAX_MEDIA_ITEMS]
    else:
        cover_clean = capped_media[0] if capped_media else None

    embed_type = str(donor.get("embed_type") or "none")
    embed_url = validate_embed_url(embed_type, donor.get("embed_url"))
    if not embed_url:
        embed_type = "none"

    raw_favicon = donor.get("favicon_url")
    safe_favicon = sanitize_external_url(raw_favicon) if isinstance(raw_favicon, str) else None
    raw_content_type = donor.get("content_type")
    safe_content_type = raw_content_type if raw_content_type in _VALID_CONTENT_TYPES else None

    return {
        "title": clean_text_field(donor.get("title"), unescape_html=True),
        "description": clean_text_field(donor.get("description"), unescape_html=True),
        "image_url": cover_clean,
        "media_items": capped_media,
        "embed_type": embed_type,
        "embed_url": embed_url,
        "site_name": clean_text_field(donor.get("site_name"), unescape_html=True),
        "favicon_url": safe_favicon,
        "content_type": safe_content_type,
        "platform": clean_text_field(donor.get("platform"), unescape_html=False),
        "unfurled_at": donor.get("unfurled_at"),
    }


async def preview_url_readonly(
    db: Any,
    raw_url: str,
    force_refresh: bool = False,
) -> Dict[str, Any]:
    """Return read-only preview for a URL (30/min rate-limited at router) with 0 DB/Storage writes."""
    canon_url = canonicalize_url(raw_url)
    try:
        validate_safe_url(canon_url)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    url_hash = compute_url_hash(canon_url)

    if not force_refresh and db is not None:
        donor = find_recent_unfurl_cache(db, url_hash)
        if donor is not None:
            cached_data = _sanitize_cached_payload(donor, base_url=canon_url)
            return {
                "url": raw_url.strip(),
                "canonical_url": canon_url,
                "url_hash": url_hash,
                "title": cached_data["title"] or canon_url,
                "description": cached_data["description"],
                "image_url": cached_data["image_url"],
                "media_items": cached_data["media_items"],
                "embed_type": cached_data["embed_type"],
                "embed_url": cached_data["embed_url"],
                "site_name": cached_data["site_name"],
                "favicon_url": cached_data["favicon_url"],
                "content_type": cached_data["content_type"] or "link",
                "platform": cached_data["platform"] or "web",
                "cached": True,
            }

    try:
        result = await extract_unfurl_metadata(canon_url)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=redact_secrets_in_text(str(exc)),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to extract preview: {redact_secrets_in_text(str(exc))}",
        ) from exc

    return {
        "url": raw_url.strip(),
        "canonical_url": result.canonical_url,
        "url_hash": result.url_hash,
        "title": result.title or result.canonical_url,
        "description": result.description,
        "image_url": result.image_url,
        "media_items": result.media_items,
        "embed_type": result.embed_type,
        "embed_url": result.embed_url,
        "site_name": result.site_name,
        "favicon_url": result.favicon_url,
        "content_type": result.content_type or "link",
        "platform": result.platform,
        "cached": False,
    }


def _should_replace_title(item: Dict[str, Any], force_refresh: bool) -> bool:
    if force_refresh:
        return True
    current_title = (item.get("title") or "").strip()
    if not current_title:
        return True
    return current_title in (
        (item.get("url") or "").strip(),
        (item.get("canonical_url") or "").strip(),
        canonicalize_url(item.get("url") or ""),
    )


async def enrich_item(
    db: Any,
    item_id: str,
    force_refresh: bool = False,
    storage_uploader: Optional[StorageUploaderFn] = None,
    preloaded_item: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Enrich an item row with 0-token metadata, 7-day cross-user cache, and Cover #1 WebP."""
    if preloaded_item is not None:
        item = dict(preloaded_item)
    else:
        res = db.table("items").select("*").eq("id", item_id).execute()
        if not res.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
        item = dict(res.data[0])
    raw_url = item.get("canonical_url") or item.get("url") or ""
    canon_url = canonicalize_url(raw_url)
    url_hash = compute_url_hash(canon_url)
    now_iso = _now_utc().isoformat()
    next_enrich_status = "done" if item.get("ai_summary") else "unfurled"

    # 1. Cross-user 7-day cache check
    if not force_refresh:
        donor = find_recent_unfurl_cache(db, url_hash, exclude_item_id=item_id)
        if donor is not None:
            cached_data = _sanitize_cached_payload(donor, base_url=canon_url)
            updates: Dict[str, Any] = {
                "canonical_url": canon_url,
                "url_hash": url_hash,
                "image_url": cached_data["image_url"],
                "media_items": cached_data["media_items"],
                "embed_type": cached_data["embed_type"],
                "embed_url": cached_data["embed_url"],
                "site_name": cached_data["site_name"],
                "favicon_url": cached_data["favicon_url"],
                "content_type": cached_data["content_type"] or item.get("content_type"),
                "platform": cached_data["platform"] or item.get("platform"),
                "enrich_status": next_enrich_status,
                "enrich_error": None,
                "unfurled_at": cached_data["unfurled_at"] or now_iso,
                "updated_at": now_iso,
            }
            if _should_replace_title(item, force_refresh=False) and cached_data["title"]:
                updates["title"] = cached_data["title"]
            if not item.get("description") and cached_data["description"]:
                updates["description"] = cached_data["description"]

            upd_res = db.table("items").update(updates).eq("id", item_id).execute()
            updated_item = dict(upd_res.data[0]) if upd_res.data else {**item, **updates}
            return {
                "status": "ok",
                "cached": True,
                "storage_uploaded": False,
                "item": updated_item,
            }

    # 2. Live 0-token extraction + Cover #1 WebP upload
    try:
        result = await extract_unfurl_metadata(canon_url)
        final_cover, uploaded_to_storage = await process_and_upload_cover(
            result.image_url,
            url_hash=url_hash,
            db=db,
            storage_uploader=storage_uploader,
        )

        final_media = list(result.media_items)
        if final_cover:
            exclude_urls = {final_cover}
            if uploaded_to_storage and result.image_url:
                exclude_urls.add(result.image_url)
            final_media = [final_cover, *[u for u in final_media if u not in exclude_urls]][:MAX_MEDIA_ITEMS]

        safe_embed_url = validate_embed_url(result.embed_type, result.embed_url)
        safe_embed_type = result.embed_type if safe_embed_url else "none"

        updates = {
            "canonical_url": result.canonical_url,
            "url_hash": result.url_hash,
            "image_url": final_cover,
            "media_items": final_media,
            "embed_type": safe_embed_type,
            "embed_url": safe_embed_url,
            "site_name": result.site_name,
            "favicon_url": result.favicon_url,
            "content_type": result.content_type or item.get("content_type"),
            "platform": result.platform or item.get("platform"),
            "enrich_status": next_enrich_status,
            "enrich_error": None,
            "unfurled_at": now_iso,
            "updated_at": now_iso,
        }
        if _should_replace_title(item, force_refresh=force_refresh) and result.title:
            updates["title"] = result.title
        if (force_refresh or not item.get("description")) and result.description:
            updates["description"] = result.description

        upd_res = db.table("items").update(updates).eq("id", item_id).execute()
        updated_item = dict(upd_res.data[0]) if upd_res.data else {**item, **updates}
        return {
            "status": "ok",
            "cached": False,
            "storage_uploaded": uploaded_to_storage,
            "item": updated_item,
        }
    except Exception as exc:
        attempts = int(item.get("enrich_attempts") or 0) + 1
        safe_err = redact_secrets_in_text(exc)[:500]
        fail_updates = {
            "canonical_url": canon_url,
            "url_hash": url_hash,
            "enrich_status": "failed",
            "enrich_attempts": attempts,
            "enrich_error": safe_err,
            "updated_at": now_iso,
        }
        upd_res = db.table("items").update(fail_updates).eq("id", item_id).execute()
        updated_item = dict(upd_res.data[0]) if upd_res.data else {**item, **fail_updates}
        logger.warning("Enrich failed for item %s (attempt %d): %s", item_id, attempts, safe_err)
        return {
            "status": "failed",
            "cached": False,
            "storage_uploaded": False,
            "error": safe_err,
            "item": updated_item,
        }


async def refresh_item_preview_for_user(
    db: Any,
    user_id: str,
    item_id: str,
    storage_uploader: Optional[StorageUploaderFn] = None,
    rate_limiter: Optional[SlidingWindowRateLimiter] = None,
) -> Dict[str, Any]:
    """Verify editor access, optionally enforce rate limit, and force-refresh item preview."""
    res = db.table("items").select("*").eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    item = dict(res.data[0])
    if not can_access_item(db, user_id, item, require_editor=True):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Editor permission required.")
    if rate_limiter is not None:
        rate_limiter.enforce(user_id)
    return await enrich_item(
        db,
        item_id,
        force_refresh=True,
        storage_uploader=storage_uploader,
        preloaded_item=item,
    )


def _fetch_retryable_failed_items(db: Any, batch_limit: int, max_attempts: int) -> List[Dict[str, Any]]:
    query = db.table("items").select("*").eq("enrich_status", "failed")
    if callable(getattr(query, "lt", None)):
        query = query.lt("enrich_attempts", max_attempts)
    if callable(getattr(query, "order", None)):
        query = query.order("enrich_attempts", desc=False)
        if callable(getattr(query, "limit", None)):
            query = query.limit(batch_limit)
    res = query.execute()
    rows = [
        dict(row)
        for row in (res.data or [])
        if int(row.get("enrich_attempts") or 0) < max_attempts
    ]
    rows.sort(key=lambda r: (int(r.get("enrich_attempts") or 0), str(r.get("updated_at") or "")))
    return rows[:batch_limit]


async def retry_failed_enrichments(
    db: Any,
    batch_limit: int = 20,
    max_attempts: int = MAX_ENRICH_RETRY_ATTEMPTS,
    storage_uploader: Optional[StorageUploaderFn] = None,
) -> Dict[str, Any]:
    """Retry items with enrich_status='failed' and enrich_attempts < max_attempts."""
    candidates = _fetch_retryable_failed_items(db, batch_limit=batch_limit, max_attempts=max_attempts)
    succeeded = 0
    failed = 0
    results: List[Dict[str, Any]] = []

    for row in candidates:
        outcome = await enrich_item(
            db,
            row["id"],
            force_refresh=False,
            storage_uploader=storage_uploader,
        )
        if outcome.get("status") == "ok":
            succeeded += 1
        else:
            failed += 1
        results.append(
            {
                "item_id": row["id"],
                "status": outcome.get("status"),
                "enrich_attempts": outcome.get("item", {}).get("enrich_attempts"),
                "enrich_error": outcome.get("item", {}).get("enrich_error"),
            }
        )

    return {
        "processed": len(candidates),
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
    }
