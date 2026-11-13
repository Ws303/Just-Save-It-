"""Summarizer Service for Just-Save-It AI module.

Enforces:
1. Summarize-Once & Persist: Checks DB first. If ai_summary exists, returns cached result.
2. Global URL Hash Reuse: Checks if another item with same url_hash has already been summarized.
3. 3-Tier Quota Rules:
   - Tier 1 (Built-in Free): Tracks and enforces monthly quota via daily_ai_usage.
   - Tier 2 (BYOK) & Tier 3 (Custom Endpoint): Quota check is bypassed completely.
4. Content Extraction & Structured LLM: Invokes extract_text_for_ai and generate_structured_summary.
5. Atomic Persistence: Updates ai_summary, ai_tags, enrich_status='done', and appends to note.
"""

from datetime import datetime, timezone
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from Database.client import get_supabase_client as _shared_get_supabase_client
from .content_extractor import extract_text_for_ai
from .llm_client import generate_structured_summary
from .schemas import AIConfig, SummarizeRequest, SummarizeResponse

logger = logging.getLogger("just_save_it.summarizer")

DEFAULT_FREE_MONTHLY_LIMIT = 50


def get_supabase_client() -> Any:
    """Create or retrieve shared Supabase service-role client."""
    return _shared_get_supabase_client()


def check_item_access_permission(db: Any, user_id: str, item: Dict[str, Any]) -> bool:
    """Check if the requesting user owns the item or belongs to its shared folder."""
    if item.get("owner_id") == user_id:
        return True

    folder_id = item.get("folder_id")
    if not folder_id:
        return False

    try:
        # Check folder ownership
        folder_res = db.table("folders").select("owner_id").eq("id", folder_id).execute()
        if folder_res.data and folder_res.data[0].get("owner_id") == user_id:
            return True

        # Check folder_members table
        member_res = (
            db.table("folder_members")
            .select("role")
            .eq("folder_id", folder_id)
            .eq("user_id", user_id)
            .execute()
        )
        if member_res.data:
            return True
    except Exception as e:
        logger.warning("Error checking folder membership permission: %s", e)

    return False


def _get_monthly_ai_limit() -> int:
    return int(os.getenv("FREE_TIER_MONTHLY_AI_LIMIT", str(DEFAULT_FREE_MONTHLY_LIMIT)))


def check_quota_available(db: Any, user_id: str) -> tuple[str, int, int, Optional[Dict[str, Any]]]:
    """Check built-in AI monthly quota without consuming a credit yet (fail-closed)."""
    monthly_limit = _get_monthly_ai_limit()
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")

    try:
        usage_res = (
            db.table("daily_ai_usage")
            .select("id, request_count")
            .eq("user_id", user_id)
            .eq("usage_month", current_month)
            .execute()
        )
        record = usage_res.data[0] if usage_res.data else None
        count = int(record.get("request_count", 0)) if record else 0
        if count >= monthly_limit:
            raise HTTPException(
                status_code=403,
                detail=f"Built-in AI quota exceeded ({count}/{monthly_limit} uses this month). Please supply your own API key (BYOK) or upgrade.",
            )
        return current_month, monthly_limit, count, record
    except HTTPException:
        raise
    except Exception as e:
        logger.error("daily_ai_usage query failed (%s); failing closed.", e)
        raise HTTPException(
            status_code=503,
            detail="AI quota tracking service temporarily unavailable. Please retry.",
        ) from e


def increment_quota_usage(
    db: Any,
    user_id: str,
    current_month: Optional[str] = None,
    monthly_limit: Optional[int] = None,
    existing_record: Optional[Dict[str, Any]] = None,
) -> int:
    """Atomically increment built-in AI monthly quota after successful LLM generation."""
    month = current_month or datetime.now(timezone.utc).strftime("%Y-%m")
    limit = monthly_limit if monthly_limit is not None else _get_monthly_ai_limit()
    now_iso = datetime.now(timezone.utc).isoformat()

    if hasattr(db, "rpc") and callable(getattr(db, "rpc", None)):
        try:
            rpc_res = db.rpc(
                "increment_monthly_ai_usage",
                {"p_user_id": user_id, "p_usage_month": month, "p_limit": limit},
            ).execute()
            rpc_data = getattr(rpc_res, "data", None)
            if isinstance(rpc_data, list):
                if not rpc_data:
                    raise HTTPException(
                        status_code=403,
                        detail=f"Built-in AI quota exceeded ({limit}/{limit} uses this month). Please supply your own API key (BYOK) or upgrade.",
                    )
                first = rpc_data[0]
                return int(first.get("request_count", first) if isinstance(first, dict) else first)
            if isinstance(rpc_data, int):
                return rpc_data
        except HTTPException:
            raise
        except Exception as rpc_exc:
            logger.debug("increment_monthly_ai_usage RPC fallback to table write: %s", rpc_exc)

    try:
        record = existing_record
        if record is None:
            usage_res = (
                db.table("daily_ai_usage")
                .select("id, request_count")
                .eq("user_id", user_id)
                .eq("usage_month", month)
                .execute()
            )
            record = usage_res.data[0] if usage_res.data else None

        if record:
            count = int(record.get("request_count", 0))
            if count >= limit:
                raise HTTPException(
                    status_code=403,
                    detail=f"Built-in AI quota exceeded ({count}/{limit} uses this month). Please supply your own API key (BYOK) or upgrade.",
                )
            new_count = count + 1
            db.table("daily_ai_usage").update(
                {"request_count": new_count, "last_used_at": now_iso}
            ).eq("id", record["id"]).execute()
            return new_count

        db.table("daily_ai_usage").insert(
            {
                "user_id": user_id,
                "usage_month": month,
                "request_count": 1,
                "last_used_at": now_iso,
            }
        ).execute()
        return 1
    except HTTPException:
        raise
    except Exception as e:
        logger.error("daily_ai_usage update failed (%s); failing closed.", e)
        raise HTTPException(
            status_code=503,
            detail="AI quota tracking service temporarily unavailable. Please retry.",
        ) from e


def check_and_increment_quota(db: Any, user_id: str) -> int:
    """Check and increment monthly AI summarization quota for Tier 1 (Built-in Free)."""
    current_month, monthly_limit, _, existing_record = check_quota_available(db, user_id)
    return increment_quota_usage(
        db,
        user_id,
        current_month=current_month,
        monthly_limit=monthly_limit,
        existing_record=existing_record,
    )


def _resolve_summary_language(db: Any, user_id: str, requested: Optional[str]) -> str:
    """Resolve target summary language from request, user profile preference, or 'th' default."""
    if requested in ("th", "en", "auto"):
        return requested
    try:
        prof_res = db.table("profiles").select("preferred_summary_language").eq("id", user_id).execute()
        if prof_res.data:
            pref = prof_res.data[0].get("preferred_summary_language")
            if pref in ("th", "en", "auto"):
                return pref
    except Exception as exc:
        logger.debug("Profile summary language lookup skipped: %s", exc)
    return "th"


async def summarize_item_once(
    db: Any,
    user_id: str,
    req: SummarizeRequest,
    ai_config: Optional[AIConfig] = None,
) -> SummarizeResponse:
    """Main summarization service workflow: Summarize-Once & Persist with 3-Tier support."""
    config = ai_config or req.ai_config or AIConfig(provider="built-in")
    resolved_lang = _resolve_summary_language(db, user_id, req.summary_language)

    # 1. Fetch item from database
    item_res = db.table("items").select("*").eq("id", req.item_id).execute()
    if not item_res.data:
        raise HTTPException(status_code=404, detail=f"Item with id '{req.item_id}' not found.")

    item: Dict[str, Any] = item_res.data[0]

    # Check authorization
    if not check_item_access_permission(db, user_id, item):
        raise HTTPException(
            status_code=403,
            detail="Access forbidden: You do not have permission to access or summarize this item.",
        )

    # 2. Check if already summarized (Summarize-Once Check)
    existing_summary = item.get("ai_summary")
    existing_lang = item.get("ai_summary_language") or resolved_lang
    language_matches = existing_lang == resolved_lang
    if existing_summary and not req.force_refresh and language_matches:
        logger.info("Item %s already has ai_summary. Returning cached result from DB.", req.item_id)
        return SummarizeResponse(
            item_id=req.item_id,
            url=item.get("url", ""),
            summary_th=existing_summary,
            summary_language=existing_lang,
            suggested_tags=item.get("ai_tags") or [],
            cached_from_db=True,
            engine_used="cache",
        )

    # Global cross-item deduplication: check if another item with same url_hash was already summarized in target language
    url_hash = item.get("url_hash")
    if url_hash and not req.force_refresh:
        try:
            cached_hash_res = (
                db.table("items")
                .select("ai_summary, ai_tags, ai_summary_language")
                .eq("url_hash", url_hash)
                .not_.is_("ai_summary", "null")
                .limit(1)
                .execute()
            )
            if cached_hash_res.data and cached_hash_res.data[0].get("ai_summary"):
                donor = cached_hash_res.data[0]
                donor_lang = donor.get("ai_summary_language") or "th"
                if donor_lang == resolved_lang:
                    summary_text = donor["ai_summary"]
                    tags_list = donor.get("ai_tags") or []

                    update_payload: Dict[str, Any] = {
                        "ai_summary": summary_text,
                        "ai_summary_language": donor_lang,
                        "ai_tags": tags_list,
                        "enrich_status": "done",
                    }
                    if req.save_to_note:
                        curr_note = item.get("note") or ""
                        if summary_text not in curr_note:
                            update_payload["note"] = f"{curr_note}\n\n[AI Summary]\n{summary_text}".strip()

                    db.table("items").update(update_payload).eq("id", req.item_id).execute()

                    return SummarizeResponse(
                        item_id=req.item_id,
                        url=item.get("url", ""),
                        summary_th=summary_text,
                        summary_language=donor_lang,
                        suggested_tags=tags_list,
                        cached_from_db=True,
                        engine_used="cache",
                    )
        except Exception as e:
            logger.debug("Cross-item hash lookup skipped: %s", e)

    # 3. Quota availability pre-check: Only check before LLM so failures never burn quota
    quota_ctx: Optional[tuple[str, int, int, Optional[Dict[str, Any]]]] = None
    if config.provider == "built-in":
        quota_ctx = check_quota_available(db, user_id)
    else:
        logger.info("User using tier '%s'; bypassing built-in quota check.", config.provider)

    # 4. Fetch user's existing tags for prioritization
    existing_tags: List[str] = []
    try:
        tags_res = db.table("tags").select("name").eq("owner_id", user_id).execute()
        if tags_res.data:
            existing_tags = [t["name"] for t in tags_res.data if t.get("name")]
    except Exception as e:
        logger.debug("Failed to fetch user tags: %s", e)

    # 5. Extract web content
    extracted_text = await extract_text_for_ai(
        url=item.get("url", ""),
        fallback_title=item.get("title") or "",
        fallback_desc=item.get("description") or "",
    )

    # 6. Call LLM across specified tier
    ai_output, engine_used = await generate_structured_summary(
        content_text=extracted_text,
        existing_user_tags=existing_tags,
        config=config,
        summary_language=resolved_lang,
    )

    # 6b. Deduct built-in quota ONLY after LLM succeeded
    if config.provider == "built-in":
        current_month, monthly_limit, _, existing_record = quota_ctx or (None, None, 0, None)
        increment_quota_usage(
            db,
            user_id,
            current_month=current_month,
            monthly_limit=monthly_limit,
            existing_record=existing_record,
        )

    # 7. Persist to Database permanently
    update_data: Dict[str, Any] = {
        "ai_summary": ai_output.summary_th,
        "ai_summary_language": resolved_lang,
        "ai_tags": ai_output.suggested_tags,
        "content_type": ai_output.content_type,
        "enrich_status": "done",
    }

    if req.save_to_note:
        existing_note = item.get("note") or ""
        if ai_output.summary_th not in existing_note:
            note_addition = f"[AI Summary]\n{ai_output.summary_th}"
            update_data["note"] = f"{existing_note}\n\n{note_addition}".strip()

    db.table("items").update(update_data).eq("id", req.item_id).execute()

    return SummarizeResponse(
        item_id=req.item_id,
        url=item.get("url", ""),
        summary_th=ai_output.summary_th,
        summary_language=resolved_lang,
        suggested_tags=ai_output.suggested_tags,
        cached_from_db=False,
        engine_used=engine_used,
    )
