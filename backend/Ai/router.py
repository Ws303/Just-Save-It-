"""FastAPI Router for Just-Save-It AI module.

Endpoints:
- POST /api/ai/summarize : On-demand summarization endpoint with 3-tier support and Summarize-Once caching.
"""

import json
import logging
import os
from typing import Any, Dict, NoReturn, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
import httpx
from pydantic import ValidationError

from Login.auth_dep import get_current_user_id
from .llm_client import UpstreamLLMError, call_byok_or_custom_llm, resolve_upstream_model_id, validate_ai_base_url
from .schemas import AIConfig, SummarizeRequest, SummarizeResponse
from .summarizer_service import get_supabase_client, summarize_item_once

logger = logging.getLogger("just_save_it.router")

router = APIRouter(prefix="/api/ai", tags=["AI Summarization"])


def _validate_request_ai_config(ai_config: AIConfig) -> AIConfig:
    """Validate BYOK credentials and Custom/BYOK endpoint URLs before DB or LLM calls."""
    if ai_config.provider == "byok":
        if not (ai_config.api_key and ai_config.api_key.strip()):
            raise HTTPException(
                status_code=400,
                detail="BYOK tier requires an API key in X-AI-Key header or config.",
            )
        if ai_config.base_url:
            try:
                ai_config.base_url = validate_ai_base_url(
                    ai_config.base_url,
                    allow_default_local=False,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
    elif ai_config.provider == "custom":
        try:
            validated_base = validate_ai_base_url(
                ai_config.base_url,
                allow_default_local=True,
            )
            if validated_base:
                ai_config.base_url = validated_base
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ai_config


def _raise_mapped_ai_error(exc: Exception, *, context: str, fallback_to_502: bool = False) -> NoReturn:
    """Normalize upstream AI errors consistently across /summarize and /test."""
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, RuntimeError):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, json.JSONDecodeError):
        raise HTTPException(status_code=502, detail=f"{context}: invalid JSON from upstream AI") from exc
    # Check Pydantic v2 ValidationError & UpstreamLLMError BEFORE ValueError because both subclass ValueError.
    if isinstance(exc, (httpx.HTTPError, ValidationError, UpstreamLLMError)) or fallback_to_502:
        raise HTTPException(status_code=502, detail=f"{context}: {type(exc).__name__}") from exc
    if isinstance(exc, ValueError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


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
    ai_config = _validate_request_ai_config(
        req.ai_config
        or AIConfig.from_headers(
            x_ai_key=x_ai_key,
            x_ai_provider=x_ai_provider,
            x_ai_base_url=x_ai_base_url,
            x_ai_model=x_ai_model,
        )
    )

    db = get_supabase_client()
    try:
        return await summarize_item_once(
            db=db,
            user_id=user_id,
            req=req,
            ai_config=ai_config,
        )
    except Exception as exc:
        _raise_mapped_ai_error(exc, context="AI summarization failed", fallback_to_502=False)


@router.post(
    "/test",
    summary="Validate AI provider credentials without modifying items or consuming built-in quota",
)
async def test_ai_connection_endpoint(
    payload: Optional[Dict[str, Any]] = Body(None),
    user_id: str = Depends(get_current_user_id),
    x_ai_key: Optional[str] = Header(None, alias="X-AI-Key"),
    x_ai_provider: Optional[str] = Header(None, alias="X-AI-Provider"),
    x_ai_base_url: Optional[str] = Header(None, alias="X-AI-Base-Url"),
    x_ai_model: Optional[str] = Header(None, alias="X-AI-Model"),
) -> Dict[str, Any]:
    """Verify Built-in configuration or test BYOK/Custom credentials safely without persisting state."""
    if isinstance(payload, dict) and isinstance(payload.get("ai_config"), dict):
        try:
            ai_config = AIConfig.model_validate(payload["ai_config"])
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Invalid ai_config payload: {exc}") from exc
    else:
        ai_config = AIConfig.from_headers(
            x_ai_key=x_ai_key,
            x_ai_provider=x_ai_provider,
            x_ai_base_url=x_ai_base_url,
            x_ai_model=x_ai_model,
        )
    ai_config = _validate_request_ai_config(ai_config)

    if ai_config.provider == "built-in":
        has_gemini = bool(os.getenv("GEMINI_API_KEY", "").strip())
        has_groq = bool(os.getenv("GROQ_API_KEY", "").strip())
        if not (has_gemini or has_groq):
            raise HTTPException(
                status_code=503,
                detail="Built-in server AI credentials are not configured.",
            )
        return {
            "ok": True,
            "provider": "built-in",
            "model": os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite") if has_gemini else os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
            "engine_used": "built-in:gemini-flash" if has_gemini else "built-in:groq-llama3",
        }


    try:
        _, engine_used = await call_byok_or_custom_llm(
            'Existing Tags: [general]\nLanguage: ภาษาไทย 1 ข้อ\nContent to summarize:\nConnection test ping.\nReturn JSON {"summary_th":"• พร้อมใช้งาน","suggested_tags":["general"],"content_type":"other"}',
            ai_config,
        )
        default_model = "llama3.2" if ai_config.provider == "custom" else "gpt-4o-mini"
        return {
            "ok": True,
            "provider": ai_config.provider,
            "model": resolve_upstream_model_id(ai_config.model, default=default_model),
            "engine_used": engine_used,
        }
    except Exception as exc:
        _raise_mapped_ai_error(exc, context="AI connection check failed", fallback_to_502=True)
