"""FastAPI Router for Just-Save-It AI module.

Endpoints:
- POST /api/ai/summarize : On-demand summarization endpoint with 3-tier support and Summarize-Once caching.
"""

import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status

from .schemas import AIConfig, SummarizeRequest, SummarizeResponse
from .summarizer_service import get_supabase_client, summarize_item_once

logger = logging.getLogger("just_save_it.router")

router = APIRouter(prefix="/api/ai", tags=["AI Summarization"])


async def get_current_user_id(
    authorization: Optional[str] = Header(None, description="Supabase JWT Bearer token"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id", description="Dev/test user id override"),
) -> str:
    """Extract authenticated user_id from Supabase JWT or developer test header."""
    # 1. Dev / test bypass if explicitly provided
    if x_user_id and x_user_id.strip():
        return x_user_id.strip()

    # 2. Check Bearer Authorization header
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header. Expected 'Bearer <token>'.",
        )

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token supplied.",
        )

    # 3. Simple JWT payload extraction for standard Supabase tokens
    try:
        parts = token.split(".")
        if len(parts) == 3:
            import base64

            padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            decoded_bytes = base64.urlsafe_b64decode(padded)
            payload = json.loads(decoded_bytes)
            sub = payload.get("sub")
            if sub:
                return str(sub)
    except Exception as e:
        logger.debug("Local JWT payload decoding error: %s", e)

    # 4. If direct token is a raw UUID / test string
    if len(token) >= 8 and "-" in token:
        return token

    # Fallback to Supabase auth client verification
    try:
        db = get_supabase_client()
        user_resp = db.auth.get_user(token)
        if user_resp and user_resp.user and user_resp.user.id:
            return str(user_resp.user.id)
    except Exception as e:
        logger.warning("Supabase auth verification failed: %s", e)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: Invalid or expired access token.",
    )


@router.post(
    "/summarize",
    response_model=SummarizeResponse,
    summary="Summarize a saved item on-demand",
    description="Summarizes an item using AI, persists result to DB, or returns existing cached summary without re-billing.",
)
async def summarize_endpoint(
    req: SummarizeRequest,
    user_id: str = Depends(get_current_user_id),
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
        user_id=user_id,
        req=req,
        ai_config=ai_config,
    )
