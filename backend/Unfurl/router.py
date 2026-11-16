"""FastAPI router for Just-Save-It Rich Unfurl Engine (0 AI tokens)."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from Database.client import get_db
from Login.auth_dep import get_current_user_id
from .security import SlidingWindowRateLimiter, require_internal_secret
from .service import enrich_item, preview_url_readonly, refresh_item_preview_for_user, retry_failed_enrichments

router = APIRouter(tags=["Rich Unfurl Engine"])

preview_rate_limiter = SlidingWindowRateLimiter(max_requests=30, window_seconds=60, name="unfurl_preview")
refresh_rate_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=3600, name="unfurl_refresh")


class ItemCreatedWebhookPayload(BaseModel):
    type: Optional[str] = None
    table: Optional[str] = None
    record: Optional[Dict[str, Any]] = None
    item_id: Optional[str] = None
    id: Optional[str] = None

    def resolve_item_id(self) -> Optional[str]:
        if self.item_id and self.item_id.strip():
            return self.item_id.strip()
        if isinstance(self.record, dict) and self.record.get("id"):
            return str(self.record["id"]).strip()
        if self.id and self.id.strip():
            return self.id.strip()
        return None


class PreviewRequest(BaseModel):
    url: str = Field(..., min_length=1)
    force_refresh: bool = False

    @field_validator("url")
    @classmethod
    def check_http_scheme(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned or not (cleaned.lower().startswith("http://") or cleaned.lower().startswith("https://")):
            raise ValueError("url must start with http:// or https://")
        return cleaned


class PreviewResponse(BaseModel):
    url: str
    canonical_url: str
    url_hash: str
    title: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    media_items: List[str] = Field(default_factory=list)
    embed_type: str = "none"
    embed_url: Optional[str] = None
    site_name: Optional[str] = None
    favicon_url: Optional[str] = None
    content_type: Optional[str] = "link"
    platform: str = "web"
    preview_status: str = "ok"
    cached: bool = False


@router.post("/hooks/item-created")
async def item_created_webhook(
    payload: ItemCreatedWebhookPayload,
    _: None = Depends(require_internal_secret),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Supabase DB Webhook handler enriching newly inserted items with 0 AI tokens."""
    item_id = payload.resolve_item_id()
    if not item_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook payload must include item_id or record.id.",
        )
    return await enrich_item(db, item_id=item_id, force_refresh=False)


@router.post("/api/preview", response_model=PreviewResponse)
async def preview_url_endpoint(
    req: PreviewRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Read-only instant link preview (30 req/min/user, no DB or Storage writes)."""
    preview_rate_limiter.enforce(user_id)
    return await preview_url_readonly(db, raw_url=req.url, force_refresh=req.force_refresh)


@router.post("/api/items/{item_id}/refresh-preview")
async def refresh_preview_endpoint(
    item_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Force-refresh preview metadata & Cover #1 WebP (editor+ access, 10 req/hr/user)."""
    return await refresh_item_preview_for_user(
        db,
        user_id=user_id,
        item_id=item_id,
        rate_limiter=refresh_rate_limiter,
    )


@router.post("/cron/retry-enrich")
async def retry_enrich_cron(
    batch_limit: int = Query(default=20, ge=1, le=100),
    _: None = Depends(require_internal_secret),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Retry failed enrichments where enrich_attempts < 3 (protected by shared secret)."""
    return await retry_failed_enrichments(db, batch_limit=batch_limit)
