"""LLM Client for Just-Save-It AI module.

Supports 3 Tiers:
- Tier 1 (Built-in Free): call_builtin_llm (Gemini Flash primary + Groq failover on 429/error).
- Tier 2 (BYOK): call_byok_or_custom_llm with user-supplied key (OpenAI, Gemini, Anthropic, OpenRouter, Groq).
- Tier 3 (Custom Endpoint): call_byok_or_custom_llm with keyless or bearer token for Ollama, vLLM, private GPU.
"""

from contextvars import ContextVar
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple
import urllib.parse

import httpx

from .content_extractor import validate_safe_url
from .schemas import AIConfig, AISummaryOutput

logger = logging.getLogger("just_save_it.ai")

_active_system_prompt_ctx: ContextVar[Optional[str]] = ContextVar("active_system_prompt", default=None)


class UpstreamLLMError(ValueError):
    """Raised when an upstream LLM provider returns malformed, empty, or invalid JSON/schema output."""
    pass

SYSTEM_PROMPT = """คุณคือผู้ช่วยสรุปเนื้อหาอัจฉริยะของแอป Just-Save-It
เป้าหมายของคุณคือสรุปเนื้อหาที่ได้รับให้เข้าใจง่ายและรวดเร็วที่สุดสำหรับผู้ใช้

กฎเหล็ก:
1. สรุปเป็นภาษาไทย 3 ข้อสั้นๆ ในฟิลด์ `summary_th` (ขึ้นต้นด้วย '• ') อ่านจบได้ภายใน 5 วินาที กระชับ ตรงประเด็น
2. แนะนำแท็กที่เกี่ยวข้อง 3-5 แท็ก (`suggested_tags`):
   - ต้องตรวจสอบ 'แท็กเดิมของผู้ใช้' (Existing Tags) ก่อนเสมอ หากมีความหมายใกล้เคียงให้เลือกใช้แท็กเดิมเพื่อไม่ให้แท็กซ้ำซ้อน
   - หากไม่มีแท็กเดิมที่ตรง ค่อยสร้างแท็กใหม่ที่สั้นกระชับ
3. ระบุประเภทเนื้อหา (`content_type`): 'article' | 'video' | 'post' | 'product' | 'other'
4. ตอบกลับเป็น JSON ที่มีคีย์ `summary_th`, `suggested_tags`, `content_type` เท่านั้น ห้ามมีคำเกริ่นหรือคำลงท้ายเด็ดขาด
"""


def _build_system_prompt(summary_language: str = "th") -> str:
    """Build system prompt matching target summary language ('th', 'en', or 'auto')."""
    if summary_language == "en":
        return """You are the intelligent content summarizer for Just-Save-It.
Your goal is to summarize the provided content clearly and concisely.

Rules:
1. Write 3 concise English bullet points (each starting with '• ') readable in under 5 seconds.
2. Suggest 3-5 relevant tags (`suggested_tags`):
   - Prioritize reusing the user's Existing Tags whenever semantically close to prevent duplicate tags.
   - Only invent short new tags if no existing tag fits.
3. Classify `content_type`: 'article' | 'video' | 'post' | 'product' | 'other'.
4. Respond strictly as JSON matching the schema (`summary_th` holds the 3-bullet summary text), with zero preamble.
"""
    if summary_language == "auto":
        return """You are the intelligent content summarizer for Just-Save-It.
Your goal is to summarize the provided content clearly in the primary language of the source content.

Rules:
1. Write 3 concise bullet points (each starting with '• ') in the same primary language as the source text (Thai if source is Thai, English if English, etc.).
2. Suggest 3-5 relevant tags (`suggested_tags`), prioritizing the user's Existing Tags first.
3. Classify `content_type`: 'article' | 'video' | 'post' | 'product' | 'other'.
4. Respond strictly as JSON matching the schema (`summary_th` holds the 3-bullet summary text), with zero preamble.
"""
    return SYSTEM_PROMPT


def _current_system_prompt() -> str:
    return _active_system_prompt_ctx.get() or SYSTEM_PROMPT


def _build_user_prompt(
    content_text: str,
    existing_user_tags: Optional[List[str]] = None,
    summary_language: str = "th",
) -> str:
    """Build standardized user prompt for summarization."""
    tags_str = ", ".join(existing_user_tags) if existing_user_tags else "(none)"
    if summary_language == "en":
        lang_hint = "Language: English (3 concise bullets starting with '• ')."
    elif summary_language == "auto":
        lang_hint = "Language: Match the primary language of the source content (3 concise bullets starting with '• ')."
    else:
        lang_hint = "Language: ภาษาไทย 3 ข้อสั้นๆ (ขึ้นต้นด้วย '• ')."

    return f"""Existing Tags: [{tags_str}]
{lang_hint}

Content to summarize:
{content_text}

Return strictly valid JSON in this exact schema:
{{
  "summary_th": "• Point 1\\n• Point 2\\n• Point 3",
  "suggested_tags": ["tag1", "tag2", "tag3"],
  "content_type": "article"
}}
"""


def _extract_llm_text(extractor, vendor: str) -> str:
    """Extract non-empty text from vendor JSON payloads, converting structure drift to UpstreamLLMError."""
    try:
        text = extractor()
    except (KeyError, IndexError, TypeError) as exc:
        raise UpstreamLLMError(f"{vendor} returned unexpected payload structure") from exc
    if not isinstance(text, str) or not text.strip():
        raise UpstreamLLMError(f"{vendor} returned empty response content")
    return text


def _parse_and_validate_json(raw_text: str) -> AISummaryOutput:
    """Clean markdown fences and parse LLM response into AISummaryOutput."""
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
        text = text.strip()

    try:
        return AISummaryOutput.model_validate_json(text)
    except Exception:
        # Fallback: search for first and last curly braces
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return AISummaryOutput.model_validate_json(match.group(0))
        raise UpstreamLLMError(f"Failed to parse LLM JSON output: {raw_text[:200]}")


async def _call_gemini_raw(prompt: str, api_key: str, model_name: str = "gemini-3.1-flash-lite") -> AISummaryOutput:
    """Call Google Gemini generateContent API."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    headers = {"x-goog-api-key": api_key}
    payload: Dict[str, Any] = {
        "system_instruction": {"parts": [{"text": _current_system_prompt()}]},
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
        },
    }

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise UpstreamLLMError("Gemini returned empty candidates")
        raw_text = _extract_llm_text(lambda: candidates[0]["content"]["parts"][0]["text"], "Gemini")
        return _parse_and_validate_json(raw_text)


async def _call_openai_compatible_raw(
    prompt: str,
    base_url: str,
    api_key: Optional[str] = None,
    model_name: str = "gpt-4o-mini",
) -> AISummaryOutput:
    """Call OpenAI-compatible completions endpoint."""
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if api_key and api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    messages = [
        {"role": "system", "content": _current_system_prompt()},
        {"role": "user", "content": prompt},
    ]

    payload: Dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=25.0, follow_redirects=False) as client:
        resp = await client.post(endpoint, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        raw_text = _extract_llm_text(lambda: data["choices"][0]["message"]["content"], "OpenAI-compatible")
        return _parse_and_validate_json(raw_text)


async def _call_anthropic_raw(
    prompt: str,
    api_key: str,
    model_name: str = "claude-3-5-haiku-20241022",
) -> AISummaryOutput:
    """Call Anthropic Claude messages API."""
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    payload = {
        "model": model_name,
        "max_tokens": 1024,
        "system": _current_system_prompt(),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }

    async with httpx.AsyncClient(timeout=25.0, follow_redirects=False) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        raw_text = _extract_llm_text(lambda: data["content"][0]["text"], "Anthropic")
        return _parse_and_validate_json(raw_text)


MODEL_DISPLAY_ALIASES: Dict[str, str] = {
    "gpt-4.1 mini": "gpt-4.1-mini",
    "gpt-4.1-mini": "gpt-4.1-mini",
    "gpt-4o mini": "gpt-4o-mini",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4o": "gpt-4o",
    "claude sonnet": "claude-sonnet-4-20250514",
    "claude haiku": "claude-3-5-haiku-20241022",
    "gemini flash": "gemini-2.5-flash",
    "gemini pro": "gemini-2.5-pro",
}


def resolve_upstream_model_id(model_name: Optional[str], default: str = "gpt-4o-mini") -> str:
    """Normalize human-friendly UI labels (e.g. 'GPT-4.1 mini') to upstream API model IDs."""
    cleaned = (model_name or "").strip()
    if not cleaned:
        return default
    alias = MODEL_DISPLAY_ALIASES.get(cleaned.lower())
    return alias if alias else cleaned


async def call_builtin_llm(prompt: str) -> Tuple[AISummaryOutput, str]:
    """Tier 1: Call Built-in Gemini Flash with automatic failover to Groq on 429 or error.

    Returns:
        tuple[AISummaryOutput, str]: (output, "built-in:gemini-flash" or "built-in:groq-llama3")
    """
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
    groq_key = os.getenv("GROQ_API_KEY", "")
    groq_model = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

    # 1. Try Gemini Flash
    if gemini_key:
        try:
            output = await _call_gemini_raw(prompt=prompt, api_key=gemini_key, model_name=gemini_model)
            return output, "built-in:gemini-flash"
        except Exception as e:
            logger.warning("Gemini API call failed (%s); triggering automatic failover to Groq...", type(e).__name__)

    # 2. Automatic Failover to Groq
    if groq_key:
        try:
            output = await _call_openai_compatible_raw(
                prompt=prompt,
                base_url="https://api.groq.com/openai/v1",
                api_key=groq_key,
                model_name=groq_model,
            )
            return output, "built-in:groq-llama3"
        except Exception as e:
            logger.error("Groq failover call also failed (%s).", type(e).__name__)
            raise e

    raise RuntimeError("No AI credentials available: GEMINI_API_KEY and GROQ_API_KEY are not configured on server.")


def validate_ai_base_url(
    base_url: Optional[str],
    *,
    allow_default_local: bool = False,
) -> Optional[str]:
    """Validate user-supplied AI endpoint URL against SSRF in production.

    Permits explicit loopback addresses (e.g. Ollama) only when ENV=development.
    """
    env = os.getenv("ENV", "production").strip().lower()
    raw = (base_url or "").strip()
    if not raw:
        if allow_default_local:
            if env == "development":
                return "http://localhost:11434/v1"
            raise ValueError("Custom AI endpoint requires an explicit public http(s) base_url in production.")
        return None

    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise ValueError("Invalid AI base_url scheme or hostname.")
    if parsed.username or parsed.password:
        raise ValueError("AI base_url must not contain embedded credentials.")

    host_lower = parsed.hostname.lower()
    if host_lower in ("169.254.169.254", "metadata.google.internal") or host_lower.startswith("169.254."):
        raise ValueError(f"SSRF Alert: Target hostname '{parsed.hostname}' is not permitted.")

    if env == "development" and host_lower in ("localhost", "127.0.0.1", "::1"):
        return raw.rstrip("/")

    return validate_safe_url(raw).rstrip("/")


async def call_byok_or_custom_llm(prompt: str, config: AIConfig) -> Tuple[AISummaryOutput, str]:
    """Tier 2 & Tier 3: Call LLM with user-provided API key or custom endpoint (Ollama/vLLM).

    - Tier 2 (BYOK): Stateless Header relay, supports OpenAI, Gemini, Anthropic, Groq, OpenRouter.
    - Tier 3 (Custom): Keyless or Bearer token to custom base_url.

    Returns:
        tuple[AISummaryOutput, str]: (output, engine_used)
    """
    # ===== Tier 3: Custom / Local Endpoint (Keyless or Bearer) =====
    if config.provider == "custom":
        base_url = validate_ai_base_url(config.base_url, allow_default_local=True) or "http://localhost:11434/v1"
        model = resolve_upstream_model_id(config.model, default="llama3.2")
        output = await _call_openai_compatible_raw(
            prompt=prompt,
            base_url=base_url,
            api_key=config.api_key,
            model_name=model,
        )
        return output, f"custom:{model}"

    # ===== Tier 2: BYOK (User Key) =====
    api_key = config.api_key
    if not api_key:
        raise ValueError("BYOK tier requires an API key in X-AI-Key header or config.")

    # Provider routing for BYOK
    # In BYOK, user can specify specific model or provider
    model = resolve_upstream_model_id(config.model, default="gpt-4o-mini")
    validated_base = validate_ai_base_url(config.base_url, allow_default_local=False) if config.base_url else None
    parsed_base = urllib.parse.urlparse(validated_base) if validated_base else None
    base_host = (parsed_base.hostname or "").lower() if parsed_base else ""
    base_path = (parsed_base.path or "").lower() if parsed_base else ""
    is_native_google = base_host == "generativelanguage.googleapis.com" and "/openai" not in base_path
    is_native_anthropic = base_host == "api.anthropic.com"

    # Explicit OpenAI-compatible proxy base_url (e.g. OpenRouter, Groq, LiteLLM) takes precedence
    # over model-name heuristics so `anthropic/claude-*` or `google/gemini-*` stay on the proxy.
    if validated_base and not (is_native_google or is_native_anthropic):
        output = await _call_openai_compatible_raw(
            prompt=prompt,
            base_url=validated_base,
            api_key=api_key,
            model_name=model,
        )
        return output, f"byok:{model}"

    if "gemini" in model.lower() or is_native_google:
        gemini_model = model if "gemini" in model.lower() else "gemini-2.5-flash"
        output = await _call_gemini_raw(prompt=prompt, api_key=api_key, model_name=gemini_model)
        return output, f"byok:gemini/{gemini_model}"

    if "claude" in model.lower() or "anthropic" in model.lower() or is_native_anthropic:
        claude_model = model if "claude" in model.lower() else "claude-3-5-haiku-20241022"
        output = await _call_anthropic_raw(prompt=prompt, api_key=api_key, model_name=claude_model)
        return output, f"byok:anthropic/{claude_model}"

    base_url = validated_base or "https://api.openai.com/v1"
    output = await _call_openai_compatible_raw(
        prompt=prompt,
        base_url=base_url,
        api_key=api_key,
        model_name=model,
    )
    return output, f"byok:{model}"


async def generate_structured_summary(
    content_text: str,
    existing_user_tags: List[str],
    config: Optional[AIConfig] = None,
    summary_language: str = "th",
) -> Tuple[AISummaryOutput, str]:
    """Central router for 3 Tiers: builds prompt with existing tags and delegates to corresponding tier.

    Returns:
        tuple[AISummaryOutput, str]: (output, engine_used)
    """
    cfg = config or AIConfig(provider="built-in")
    lang = summary_language if summary_language in ("th", "en", "auto") else "th"
    prompt = _build_user_prompt(content_text, existing_user_tags, summary_language=lang)
    token = _active_system_prompt_ctx.set(_build_system_prompt(lang))
    try:
        if cfg.provider == "built-in":
            return await call_builtin_llm(prompt)
        return await call_byok_or_custom_llm(prompt, cfg)
    finally:
        _active_system_prompt_ctx.reset(token)
