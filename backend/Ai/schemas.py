"""Pydantic v2 schemas for Just-Save-It AI module.

Supports 3-tier architecture:
- Tier 1: Built-in Free (provider="built-in", Gemini Flash + Groq failover, server quota)
- Tier 2: BYOK (provider="byok", User-supplied API Key via X-AI-Key / X-AI-Provider)
- Tier 3: Custom / Local Endpoint (provider="custom", User-supplied X-AI-Base-Url e.g. Ollama/vLLM)
"""

from typing import Any, List, Literal, Optional
from pydantic import BaseModel, Field, model_validator


class AIConfig(BaseModel):
    """Configuration for LLM execution supporting 3 tiers."""

    provider: Literal["built-in", "byok", "custom"] = Field(
        default="built-in",
        description="Active AI execution provider tier: 'built-in' (server quota), 'byok' (user key), 'custom' (local/private endpoint)",
    )
    api_key: Optional[str] = Field(
        default=None,
        description="User-provided API key for BYOK or Bearer token for custom endpoint. NEVER stored in DB.",
    )
    base_url: Optional[str] = Field(
        default=None,
        description="Custom endpoint URL (e.g. http://localhost:11434/v1 for Ollama, or private vLLM server)",
    )
    model: Optional[str] = Field(
        default=None,
        description="Specific model identifier to use (e.g. 'gpt-4o-mini', 'llama3.2', 'claude-3-5-haiku', 'gemini-3.1-flash-lite')",
    )

    @property
    def model_name(self) -> Optional[str]:
        return self.model

    @property
    def tier(self) -> str:
        """Backwards compatibility alias for provider."""
        return "builtin" if self.provider == "built-in" else self.provider

    @model_validator(mode="before")
    @classmethod
    def normalize_fields(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # Normalize 'builtin' -> 'built-in'
            p = data.get("provider") or data.get("tier")
            if p in ("builtin", "built-in"):
                data["provider"] = "built-in"
            elif p in ("byok", "custom"):
                data["provider"] = p
            if "model_name" in data and "model" not in data:
                data["model"] = data["model_name"]
        return data

    @classmethod
    def from_headers(
        cls,
        x_ai_provider: Optional[str] = None,
        x_ai_key: Optional[str] = None,
        x_ai_base_url: Optional[str] = None,
        x_ai_model: Optional[str] = None,
    ) -> "AIConfig":
        """Resolve AIConfig tier from incoming HTTP request headers."""
        if x_ai_base_url and x_ai_base_url.strip():
            return cls(
                provider="custom",
                base_url=x_ai_base_url.strip().rstrip("/"),
                api_key=x_ai_key.strip() if x_ai_key else None,
                model=x_ai_model.strip() if x_ai_model else "llama3.2",
            )
        if x_ai_key and x_ai_key.strip():
            return cls(
                provider="byok",
                api_key=x_ai_key.strip(),
                model=x_ai_model.strip() if x_ai_model else None,
            )
        return cls(provider="built-in")


class SummarizeRequest(BaseModel):
    """Request payload for summarizing a saved item."""

    item_id: str = Field(
        ...,
        description="UUID of the item in the items table",
        examples=["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    )
    force_refresh: bool = Field(
        default=False,
        description="If False, returns existing ai_summary from DB. If True, forces re-summarization via LLM.",
    )
    save_to_note: bool = Field(
        default=True,
        description="Whether to also append the AI summary into the item's note field.",
    )
    summary_language: Optional[Literal["th", "en", "auto"]] = Field(
        default=None,
        description="Target summary language ('th', 'en', or 'auto'). Falls back to user profile preference or 'th'.",
    )
    ai_config: Optional[AIConfig] = Field(
        default=None,
        description="Optional explicit AI configuration (Tier 1/2/3). If omitted, request headers or server defaults apply.",
    )


class AISummaryOutput(BaseModel):
    """Structured JSON schema that the LLM must strictly output."""

    summary_th: str = Field(
        ...,
        min_length=1,
        description="3-bullet Thai summary reading in under 5 seconds (e.g. '• ...\\n• ...\\n• ...')",
    )
    suggested_tags: List[str] = Field(
        default_factory=list,
        max_length=5,
        description="Recommended tags (up to 5), prioritized from user's existing tags.",
    )
    content_type: Literal["article", "video", "post", "product", "other"] = Field(
        default="article",
        description="Classified content category of the URL/body.",
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_llm_output(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        if "summary_th" not in normalized or not normalized.get("summary_th"):
            for alt_key in ("summary", "summary_en", "bullets", "points"):
                if normalized.get(alt_key):
                    normalized["summary_th"] = normalized[alt_key]
                    break
        raw_summary = normalized.get("summary_th")
        if isinstance(raw_summary, list):
            normalized["summary_th"] = "\n".join(str(x).strip() for x in raw_summary if str(x).strip())
        if isinstance(normalized.get("summary_th"), str):
            normalized["summary_th"] = normalized["summary_th"].strip()
        raw_tags = normalized.get("suggested_tags")
        if isinstance(raw_tags, list):
            normalized["suggested_tags"] = [str(t).strip() for t in raw_tags if str(t).strip()]
        if "content_type" in normalized and isinstance(normalized["content_type"], str):
            stripped_type = normalized["content_type"].strip().lower()
            if not stripped_type:
                normalized["content_type"] = "article"
            elif stripped_type in ("article", "video", "post", "product", "other"):
                normalized["content_type"] = stripped_type
        return normalized


class SummarizeResponse(BaseModel):
    """Response returned to client after on-demand summarization."""

    item_id: str = Field(..., description="UUID of the item")
    url: str = Field(..., description="Target URL that was summarized")
    summary_th: str = Field(..., description="Canonical summary text (Thai by default, or requested language)")
    summary_language: str = Field(
        default="th",
        description="Resolved summary language used ('th', 'en', or 'auto')",
    )
    suggested_tags: List[str] = Field(
        default_factory=list,
        description="List of suggested tags",
    )
    cached_from_db: bool = Field(
        ...,
        description="True if returned from existing DB cache without calling LLM; False if freshly generated.",
    )
    engine_used: str = Field(
        ...,
        description="Engine used e.g. 'built-in:gemini-flash', 'built-in:groq-llama3', 'byok:openai/gpt-4o-mini', 'custom:ollama/llama3.2', 'cache'",
    )

    @property
    def tier_used(self) -> str:
        """Backwards compatibility alias for engine_used."""
        return self.engine_used
