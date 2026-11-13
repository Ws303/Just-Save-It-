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

try:
    from supabase import Client, create_client
except ImportError:
    Client = Any  # type: ignore
    create_client = None  # type: ignore

from .content_extractor import extract_text_for_ai
from .llm_client import generate_structured_summary
from .schemas import AIConfig, SummarizeRequest, SummarizeResponse

logger = logging.getLogger("just_save_it.summarizer")

DEFAULT_FREE_MONTHLY_LIMIT = 50


def get_supabase_client() -> Any:
    """Create a Supabase service-role client from environment variables."""
    if create_client is None:
        raise RuntimeError("supabase package is not installed. Run 'pip install supabase'.")
    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not supabase_key:
        logger.warning("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured.")
    return create_client(supabase_url or "https://placeholder.supabase.co", supabase_key or "placeholder")


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


def check_and_increment_quota(db: Any, user_id: str) -> None:
    """Check and increment monthly AI summarization quota for Tier 1 (Built-in Free)."""
    monthly_limit = int(os.getenv("FREE_TIER_MONTHLY_AI_LIMIT", str(DEFAULT_FREE_MONTHLY_LIMIT)))
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")

    try:
        # Query monthly usage
        usage_res = (
            db.table("daily_ai_usage")
            .select("id, request_count")
            .eq("user_id", user_id)
            .eq("usage_month", current_month)
            .execute()
        )

        if usage_res.data:
            record = usage_res.data[0]
            count = record.get("request_count", 0)
            if count >= monthly_limit:
                raise HTTPException(
                    status_code=403,
                    detail=f"Built-in AI quota exceeded ({count}/{monthly_limit} uses this month). Please supply your own API key (BYOK) or upgrade.",
                )
            # Increment usage
            db.table("daily_ai_usage").update(
                {"request_count": count + 1, "last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", record["id"]).execute()
        else:
            # Create first record for the month
            db.table("daily_ai_usage").insert(
                {
                    "user_id": user_id,
                    "usage_month": current_month,
                    "request_count": 1,
                    "last_used_at": datetime.now(timezone.utc).isoformat(),
                }
            ).execute()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("daily_ai_usage query/update failed (%s); proceeding with graceful fallback.", e)


async def summarize_item_once(
    db: Any,
    user_id: str,
    req: SummarizeRequest,
    ai_config: Optional[AIConfig] = None,
) -> SummarizeResponse:
    """Main summarization service workflow: Summarize-Once & Persist with 3-Tier support."""
    config = ai_config or req.ai_config or AIConfig(provider="built-in")

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
    if existing_summary and not req.force_refresh:
        logger.info("Item %s already has ai_summary. Returning cached result from DB.", req.item_id)
        return SummarizeResponse(
            item_id=req.item_id,
            url=item.get("url", ""),
            summary_th=existing_summary,
            suggested_tags=item.get("ai_tags") or [],
            cached_from_db=True,
            engine_used="cache",
        )

    # Global cross-item deduplication: check if another item with same url_hash was already summarized
    url_hash = item.get("url_hash")
    if url_hash and not req.force_refresh:
        try:
            cached_hash_res = (
                db.table("items")
                .select("ai_summary, ai_tags")
                .eq("url_hash", url_hash)
                .not_.is_("ai_summary", "null")
                .limit(1)
                .execute()
            )
            if cached_hash_res.data and cached_hash_res.data[0].get("ai_summary"):
                donor = cached_hash_res.data[0]
                summary_text = donor["ai_summary"]
                tags_list = donor.get("ai_tags") or []

                # Copy cached summary to current item
                update_payload: Dict[str, Any] = {
                    "ai_summary": summary_text,
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
                    suggested_tags=tags_list,
                    cached_from_db=True,
                    engine_used="cache",
                )
        except Exception as e:
            logger.debug("Cross-item hash lookup skipped: %s", e)

    # 3. Quota enforcement: Only enforce for Tier 1 (Built-in Free)
    if config.provider == "built-in":
        check_and_increment_quota(db, user_id)
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
    )

    # 7. Persist to Database permanently
    update_data: Dict[str, Any] = {
        "ai_summary": ai_output.summary_th,
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
        suggested_tags=ai_output.suggested_tags,
        cached_from_db=False,
        engine_used=engine_used,
    )
