"""FastAPI Router for Just-Save-It AI module.

Endpoints:
- POST /api/ai/summarize : On-demand summarization endpoint with 3-tier support and Summarize-Once caching.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header

from Login.dependencies import CurrentUser, get_current_user
from .schemas import AIConfig, SummarizeRequest, SummarizeResponse
from .summarizer_service import get_supabase_client, summarize_item_once

logger = logging.getLogger("just_save_it.router")

router = APIRouter(prefix="/api/ai", tags=["AI Summarization"])


async def get_current_user_id(
    current_user: CurrentUser = Depends(get_current_user),
) -> str:
    """Extract authenticated user_id from unified authentication dependency."""
    return current_user.id


@router.post(
    "/summarize",
    response_model=SummarizeResponse,
    summary="Summarize a saved item on-demand",
    description="Summarizes an item using AI, persists result to DB, or returns existing cached summary without re-billing.",
)
async def summarize_endpoint(
    req: SummarizeRequest,
    current_user: CurrentUser = Depends(get_current_user),
    x_ai_key: Optional[str] = Header(None, alias="X-AI-Key"),
    x_ai_provider: Optional[str] = Header(None, alias="X-AI-Provider"),
    x_ai_base_url: Optional[str] = Header(None, alias="X-AI-Base-Url"),
    x_ai_model: Optional[str] = Header(None, alias="X-AI-Model"),
) -> SummarizeResponse:
    """Execute on-demand summarization for an item."""
    # Resolve AIConfig from request body if explicitly provided, else from request headers
    ai_config = req.ai_config or AIConfig.from_headers(
        x_ai_key=x_ai_key,
        x_ai_provider=x_ai_provider,
        x_ai_base_url=x_ai_base_url,
        x_ai_model=x_ai_model,
    )

    db = get_supabase_client()
    return await summarize_item_once(
        db=db,
        user_id=current_user.id,
        req=req,
        ai_config=ai_config,
    )
