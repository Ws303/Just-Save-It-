"""Comprehensive Unit Tests for Just-Save-It AI Module and MCP Server.

Validates all 22 checkpoints from AI_IMPLEMENTATION_PLAN.md:
- Core AI (A1 - A8)
- Remote MCP Server (B0 - B13)
"""

from datetime import datetime, timedelta, timezone
import hashlib
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from Ai.content_extractor import (
    MAX_EXTRACTED_CHARS,
    MAX_HTML_BYTES,
    _detect_oembed_endpoint,
    _fetch_url_safely,
    extract_text_for_ai,
    validate_safe_url,
)
from Ai.llm_client import (
    _parse_and_validate_json,
    call_builtin_llm,
    call_byok_or_custom_llm,
    generate_structured_summary,
)
from Ai.mcp_server import (
    MCPAuthMiddleware,
    create_item,
    delete_item,
    get_item_detail,
    list_folders,
    list_tags,
    manage_folder,
    manage_item_tags,
    rename_or_delete_tag,
    search_and_list_items,
    set_authenticated_user_id,
    set_or_cancel_reminder,
    set_override_db,
    share_folder_link,
    summarize_item_to_note,
    update_item,
    verify_mcp_token,
)
from Ai.schemas import (
    AIConfig,
    AISummaryOutput,
    SummarizeRequest,
    SummarizeResponse,
)
from Ai.summarizer_service import (
    check_and_increment_quota,
    summarize_item_once,
)
from main import app


# =====================================================================
# In-Memory Database for Hermetic Testing
# =====================================================================

class InMemoryDB:
    def __init__(self):
        self.tables: Dict[str, List[Dict[str, Any]]] = {
            "api_tokens": [],
            "items": [],
            "tags": [],
            "item_tags": [],
            "folders": [],
            "folder_members": [],
            "folder_invites": [],
            "reminders": [],
            "daily_ai_usage": [],
            "profiles": [],
            "devices": [],
        }

    def table(self, name: str):
        return TableProxy(self.tables.setdefault(name, []))


class TableProxy:
    def __init__(self, data_list: List[Dict[str, Any]]):
        self._data = data_list
        self._filters: Dict[str, Any] = {}
        self._in_filters: Dict[str, set] = {}
        self._not_null_filters: set = set()
        self._limit: Optional[int] = None
        self._action = "select"

    def select(self, cols="*"):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def ilike(self, col, val):
        self._filters[col] = val
        return self

    def in_(self, col, val_list):
        self._in_filters[col] = set(val_list)
        return self

    @property
    def not_(self):
        return self

    def is_(self, col, val):
        if val == "null":
            self._not_null_filters.add(col)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, payload):
        if isinstance(payload, dict):
            new_item = dict(payload)
            if "id" not in new_item and "token" not in new_item and not ("item_id" in new_item and "tag_id" in new_item) and not ("folder_id" in new_item and "user_id" in new_item):
                new_item["id"] = str(uuid.uuid4())
            self._data.append(new_item)
            self._last_inserted = new_item
        return self

    def update(self, updates):
        self._pending_updates = dict(updates)
        return self

    def delete(self):
        self._action = "delete"
        return self

    def _matches(self, item: Dict[str, Any]) -> bool:
        for k, v in self._filters.items():
            if item.get(k) != v:
                return False
        for k, v_set in self._in_filters.items():
            if item.get(k) not in v_set:
                return False
        for k in self._not_null_filters:
            v = item.get(k)
            if v is None or v == "":
                return False
        return True

    def execute(self):
        if hasattr(self, "_last_inserted"):
            res = MagicMock(data=[dict(self._last_inserted)])
            del self._last_inserted
            return res

        if hasattr(self, "_pending_updates"):
            updates = self._pending_updates
            del self._pending_updates
            updated = []
            for item in self._data:
                if self._matches(item):
                    item.update(updates)
                    updated.append(dict(item))
            return MagicMock(data=updated)

        if getattr(self, "_action", None) == "delete":
            self._action = "select"
            remaining = []
            deleted = []
            for item in self._data:
                if self._matches(item):
                    deleted.append(dict(item))
                else:
                    remaining.append(item)
            self._data.clear()
            self._data.extend(remaining)
            return MagicMock(data=deleted)

        filtered = [dict(item) for item in self._data if self._matches(item)]
        if self._limit is not None:
            filtered = filtered[:self._limit]
        return MagicMock(data=filtered)


# =====================================================================
# 1. Tests for Core AI & Extraction (A1 - A8)
# =====================================================================

def test_a1_schemas_validation():
    """A1: Validate Pydantic Schemas and tier normalization."""
    cfg_default = AIConfig()
    assert cfg_default.provider == "built-in"

    cfg_byok = AIConfig(provider="byok", api_key="sk-test", model="gpt-4o-mini")
    assert cfg_byok.provider == "byok"
    assert cfg_byok.api_key == "sk-test"

    output = AISummaryOutput(
        summary_th="• ข้อ 1\n• ข้อ 2\n• ข้อ 3",
        suggested_tags=["AI", "Tech"],
        content_type="article",
    )
    assert len(output.suggested_tags) <= 5

    with pytest.raises(Exception):
        AISummaryOutput(
            summary_th="Test",
            suggested_tags=["1", "2", "3", "4", "5", "6"],  # Exceeds max 5
            content_type="article",
        )

    resp = SummarizeResponse(
        item_id="item-1",
        url="https://example.com",
        summary_th="Summary",
        suggested_tags=["tag"],
        cached_from_db=True,
        engine_used="cache",
    )
    assert resp.cached_from_db is True
    assert resp.engine_used == "cache"


def test_a1b_ai_summary_output_normalizes_aliases_but_stays_strict():
    """Verify LLM alias/list summary normalization without masking invalid schemas."""
    parsed = AISummaryOutput.model_validate({
        "summary": ["• ข้อ 1", "• ข้อ 2", "• ข้อ 3"],
        "suggested_tags": ["AI", " ", "Tech"],
        "content_type": "Article",
    })
    assert parsed.summary_th == "• ข้อ 1\n• ข้อ 2\n• ข้อ 3"
    assert parsed.suggested_tags == ["AI", "Tech"]
    assert parsed.content_type == "article"

    with pytest.raises(Exception):
        AISummaryOutput.model_validate({
            "summary_th": "Valid summary",
            "suggested_tags": ["a", "b"],
            "content_type": "bogus_type",
        })

    for empty_payload in (
        {"summary": ["  ", ""], "suggested_tags": ["a"], "content_type": "article"},
        {"summary_th": "   ", "suggested_tags": ["a"], "content_type": "article"},
    ):
        with pytest.raises(Exception):
            AISummaryOutput.model_validate(empty_payload)


def test_a2_validate_safe_url_ssrf_guard():
    """A2: SSRF Guard blocks localhost, loopback, private IPs, and non-http(s)."""
    with pytest.raises(ValueError, match="SSRF Alert"):
        validate_safe_url("http://127.0.0.1:8000")
    with pytest.raises(ValueError, match="SSRF Alert"):
        validate_safe_url("http://localhost/admin")
    with pytest.raises(ValueError, match="SSRF Alert"):
        validate_safe_url("http://169.254.169.254/metadata")
    with pytest.raises(ValueError, match="SSRF Alert"):
        validate_safe_url("http://10.0.0.1")
    with pytest.raises(ValueError, match="SSRF Alert"):
        validate_safe_url("http://192.168.1.1/router")
    with pytest.raises(ValueError, match="Invalid URL scheme"):
        validate_safe_url("file:///etc/passwd")

    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]):
        safe = validate_safe_url("https://example.com/safe-article")
    assert safe == "https://example.com/safe-article"


@pytest.mark.asyncio
async def test_a3_extract_text_for_ai_and_trimming():
    """A3: Extract web text with fallback and maximum 6,000 characters limit."""
    fallback_result = await extract_text_for_ai(
        url="http://127.0.0.1/evil",
        fallback_title="Safe Fallback Title",
        fallback_desc="Safe Fallback Desc",
    )
    assert "Safe Fallback Title" in fallback_result
    assert "Safe Fallback Desc" in fallback_result
    assert len(fallback_result) <= MAX_EXTRACTED_CHARS


@pytest.mark.asyncio
async def test_a4_call_builtin_llm_gemini_with_groq_failover():
    """A4: Built-in Gemini Flash calls with automatic Groq failover on error/429."""
    mock_out = AISummaryOutput(
        summary_th="• สรุปฉุกเฉินจาก Groq",
        suggested_tags=["Groq", "Backup"],
        content_type="article",
    )

    with patch.dict("os.environ", {"GEMINI_API_KEY": "fake-gemini", "GROQ_API_KEY": "fake-groq"}):
        with patch("Ai.llm_client._call_gemini_raw", side_effect=Exception("Gemini HTTP 429 Rate Limit")):
            with patch("Ai.llm_client._call_openai_compatible_raw", new=AsyncMock(return_value=mock_out)):
                output, engine = await call_builtin_llm(prompt="Test prompt")
                assert engine == "built-in:groq-llama3"
                assert output.summary_th == "• สรุปฉุกเฉินจาก Groq"


@pytest.mark.asyncio
async def test_a5_call_byok_and_custom_llm_keyless():
    """A5: BYOK with user API key & Custom keyless Ollama endpoint."""
    mock_out = AISummaryOutput(
        summary_th="• สรุปจาก Ollama",
        suggested_tags=["LocalAI"],
        content_type="article",
    )

    custom_cfg = AIConfig(provider="custom", base_url="http://localhost:11434/v1", model="llama3.2")
    with patch("Ai.llm_client._call_openai_compatible_raw", new=AsyncMock(return_value=mock_out)) as mock_call:
        output, engine = await call_byok_or_custom_llm(prompt="Prompt", config=custom_cfg)
        assert engine == "custom:llama3.2"
        assert output.summary_th == "• สรุปจาก Ollama"
        # Verify keyless call (api_key=None)
        mock_call.assert_awaited_once_with(
            prompt="Prompt",
            base_url="http://localhost:11434/v1",
            api_key=None,
            model_name="llama3.2",
        )


@pytest.mark.asyncio
async def test_a6_generate_structured_summary_routing_and_tags():
    """A6: Router includes existing_user_tags in prompt and delegates cleanly."""
    existing_tags = ["AI", "Tech", "Product"]
    mock_out = AISummaryOutput(
        summary_th="• ข้อ 1\n• ข้อ 2\n• ข้อ 3",
        suggested_tags=["Tech"],
        content_type="article",
    )

    with patch("Ai.llm_client.call_builtin_llm", new=AsyncMock(return_value=(mock_out, "built-in:gemini-flash"))) as mock_builtin:
        output, engine = await generate_structured_summary(
            content_text="Sample text",
            existing_user_tags=existing_tags,
            config=AIConfig(provider="built-in"),
        )
        assert engine == "built-in:gemini-flash"
        called_prompt = mock_builtin.call_args[0][0]
        assert "AI, Tech, Product" in called_prompt


@pytest.mark.asyncio
async def test_a7_summarize_item_once_cache_and_quota_rules():
    """A7: Summarize-Once: cache hit skips LLM vs fresh call persists & deducts quota."""
    db = InMemoryDB()

    # Case A: Cache Hit
    db.tables["items"].append(
        {
            "id": "it-cache",
            "owner_id": "usr-1",
            "url": "https://example.com/cached",
            "ai_summary": "• สรุปเดิมจาก DB",
            "ai_tags": ["Tech"],
            "note": "Old note",
        }
    )
    req_cached = SummarizeRequest(item_id="it-cache", force_refresh=False)
    resp_cached = await summarize_item_once(db=db, user_id="usr-1", req=req_cached)
    assert resp_cached.cached_from_db is True
    assert resp_cached.engine_used == "cache"
    assert resp_cached.summary_th == "• สรุปเดิมจาก DB"

    # Case B: Fresh call with BYOK (must not deduct built-in quota)
    db.tables["items"].append(
        {
            "id": "it-fresh",
            "owner_id": "usr-1",
            "url": "https://example.com/fresh",
            "ai_summary": None,
            "note": "",
        }
    )
    req_fresh = SummarizeRequest(item_id="it-fresh")
    byok_cfg = AIConfig(provider="byok", api_key="sk-user-key", model="gpt-4o-mini")
    mock_out = AISummaryOutput(
        summary_th="• สรุปใหม่ถาวร",
        suggested_tags=["NewTag"],
        content_type="article",
    )

    with patch("Ai.summarizer_service.extract_text_for_ai", new=AsyncMock(return_value="Content")):
        with patch("Ai.summarizer_service.generate_structured_summary", new=AsyncMock(return_value=(mock_out, "byok:gpt-4o-mini"))):
            resp_fresh = await summarize_item_once(db=db, user_id="usr-1", req=req_fresh, ai_config=byok_cfg)
            assert resp_fresh.cached_from_db is False
            assert resp_fresh.engine_used == "byok:gpt-4o-mini"
            # Verify persisted into DB
            saved = db.tables["items"][1]
            assert saved["ai_summary"] == "• สรุปใหม่ถาวร"
            # Daily AI usage should NOT be touched for BYOK
            assert len(db.tables["daily_ai_usage"]) == 0


def test_a8_router_summarize_endpoint_headers_and_auth():
    """A8: Endpoint POST /api/ai/summarize accepts headers and enforces auth (Blast Radius fix)."""
    client = TestClient(app)

    # 1. 401 without token
    resp_unauth = client.post("/api/ai/summarize", json={"item_id": "test-uuid"})
    assert resp_unauth.status_code == 401

    # 2. Assert X-User-Id WITHOUT dev bypass (ENV=production / default) returns 401
    with patch.dict("os.environ", {"ENV": "production", "ALLOW_DEV_AUTH_BYPASS": "false"}):
        resp_dev_blocked = client.post(
            "/api/ai/summarize",
            json={"item_id": "it-test"},
            headers={"X-User-Id": "usr-dev"},
        )
        assert resp_dev_blocked.status_code == 401

    # 3. Assert X-User-Id WITH ENV=development and ALLOW_DEV_AUTH_BYPASS=true returns 200 and passes AIConfig headers cleanly
    mock_resp = SummarizeResponse(
        item_id="it-test",
        url="https://example.com",
        summary_th="Summary",
        suggested_tags=["Tag"],
        cached_from_db=True,
        engine_used="cache",
    )
    with patch.dict("os.environ", {"ENV": "development", "ALLOW_DEV_AUTH_BYPASS": "true"}):
        with patch("Ai.router.summarize_item_once", new=AsyncMock(return_value=mock_resp)) as mock_svc:
            resp = client.post(
                "/api/ai/summarize",
                json={"item_id": "it-test"},
                headers={
                    "X-User-Id": "usr-dev",
                    "X-AI-Provider": "custom",
                    "X-AI-Base-Url": "http://localhost:11434/v1",
                    "X-AI-Model": "llama3.2",
                },
            )
            assert resp.status_code == 200
            assert resp.json()["engine_used"] == "cache"
            # Verify AIConfig passed cleanly
            call_kwargs = mock_svc.call_args[1]
            cfg = call_kwargs.get("ai_config")
            assert cfg is not None
            assert cfg.provider == "custom"
            assert cfg.base_url == "http://localhost:11434/v1"
            assert cfg.model == "llama3.2"
            assert call_kwargs.get("user_id") == "usr-dev"

    # 4. Assert valid signed HS256 JWT (aud="authenticated", future exp) returns 200 even in production mode
    jwt_secret = "test-secret-summarize-endpoint-key-987654321"
    now_ts = int(datetime.now(timezone.utc).timestamp())
    valid_jwt = jwt.encode(
        {"sub": "usr-prod-jwt", "aud": "authenticated", "exp": now_ts + 3600, "iat": now_ts},
        jwt_secret,
        algorithm="HS256",
    )
    with patch.dict(
        "os.environ",
        {
            "SUPABASE_JWT_SECRET": jwt_secret,
            "ENV": "production",
            "ALLOW_DEV_AUTH_BYPASS": "false",
        },
    ):
        with patch("Ai.router.summarize_item_once", new=AsyncMock(return_value=mock_resp)) as mock_jwt_svc:
            resp_jwt = client.post(
                "/api/ai/summarize",
                json={"item_id": "it-test"},
                headers={"Authorization": f"Bearer {valid_jwt}"},
            )
            assert resp_jwt.status_code == 200
            assert resp_jwt.json()["engine_used"] == "cache"
            assert mock_jwt_svc.call_args[1].get("user_id") == "usr-prod-jwt"


@pytest.mark.asyncio
async def test_a9_summary_language_options_and_backward_compatibility():
    """A9: Verify summary_language ('en', 'auto', profile fallback) preserves summary_th compat (C6)."""
    db = InMemoryDB()

    # 1. Profile fallback: user profile has preferred_summary_language="en"
    db.tables["profiles"].append({
        "id": "usr-lang-1",
        "preferred_summary_language": "en",
    })
    db.tables["items"].append({
        "id": "it-lang-1",
        "owner_id": "usr-lang-1",
        "url": "https://example.com/lang1",
        "title": "Title 1",
        "description": "Desc 1",
        "ai_summary": None,
        "note": "",
    })

    mock_out_en = AISummaryOutput(
        summary_th="• Point 1 in English\n• Point 2 in English\n• Point 3 in English",
        suggested_tags=["AI", "English"],
        content_type="article",
    )

    with patch("Ai.summarizer_service.extract_text_for_ai", new=AsyncMock(return_value="Extracted text")):
        with patch("Ai.summarizer_service.generate_structured_summary", new=AsyncMock(return_value=(mock_out_en, "built-in:gemini-flash"))) as mock_gen:
            req_fallback = SummarizeRequest(item_id="it-lang-1", summary_language=None)
            resp = await summarize_item_once(db=db, user_id="usr-lang-1", req=req_fallback)
            assert resp.summary_language == "en"
            assert resp.summary_th == mock_out_en.summary_th  # backward compatibility alias
            assert resp.tier_used == "built-in:gemini-flash"
            assert mock_gen.call_args[1].get("summary_language") == "en"
            saved_item = [it for it in db.tables["items"] if it["id"] == "it-lang-1"][0]
            assert saved_item["ai_summary"] == mock_out_en.summary_th
            assert saved_item["ai_summary_language"] == "en"

    # 2. Explicit summary_language="auto"
    db.tables["items"].append({
        "id": "it-lang-2",
        "owner_id": "usr-lang-1",
        "url": "https://example.com/lang2",
        "ai_summary": None,
        "note": "",
    })
    mock_out_auto = AISummaryOutput(
        summary_th="• Auto bullet 1\n• Auto bullet 2\n• Auto bullet 3",
        suggested_tags=["Auto"],
        content_type="article",
    )
    with patch("Ai.summarizer_service.extract_text_for_ai", new=AsyncMock(return_value="Extracted text")):
        with patch("Ai.summarizer_service.generate_structured_summary", new=AsyncMock(return_value=(mock_out_auto, "built-in:gemini-flash"))) as mock_gen_auto:
            req_auto = SummarizeRequest(item_id="it-lang-2", summary_language="auto")
            resp_auto = await summarize_item_once(db=db, user_id="usr-lang-1", req=req_auto)
            assert resp_auto.summary_language == "auto"
            assert resp_auto.summary_th == mock_out_auto.summary_th
            assert mock_gen_auto.call_args[1].get("summary_language") == "auto"
            saved_auto = [it for it in db.tables["items"] if it["id"] == "it-lang-2"][0]
            assert saved_auto["ai_summary_language"] == "auto"


@pytest.mark.asyncio
async def test_a10_extract_text_for_ai_charset_decoding_without_mojibake():
    """A10: extract_text_for_ai decodes raw .content bytes in TIS-620 and Shift_JIS without mojibake (C4)."""
    # 1. TIS-620 with Thai tone marks and smart quotes
    thai_text = "การทดสอบภาษาไทย มอก.620 พร้อมวรรณยุกต์ ่ ้ ๊ ๋ ั ิ และเครื่องหมาย “คำพูด”"
    thai_html = f"<html><head><title>หน้าหลัก</title></head><body><article><p>{thai_text}</p></article></body></html>"
    thai_bytes = thai_html.encode("cp874")

    mock_resp_thai = MagicMock()
    mock_resp_thai.status_code = 200
    mock_resp_thai.content = thai_bytes
    mock_resp_thai.headers = {"Content-Type": "text/html; charset=tis-620"}

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_resp_thai)):
        result = await extract_text_for_ai(url="https://example.com/thai")
        assert "การทดสอบภาษาไทย" in result
        assert "พร้อมวรรณยุกต์" in result

    # 2. Shift_JIS Japanese bytes
    jp_text = "日本語のコンテンツです。文字化けなしテスト。"
    jp_html = f"<html><head><title>Japanese</title></head><body><article><p>{jp_text}</p></article></body></html>"
    jp_bytes = jp_html.encode("shift_jis")

    mock_resp_jp = MagicMock()
    mock_resp_jp.status_code = 200
    mock_resp_jp.content = jp_bytes
    mock_resp_jp.headers = {"Content-Type": "text/html; charset=shift_jis"}

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_resp_jp)):
        result_jp = await extract_text_for_ai(url="https://example.com/japan")
        assert "日本語のコンテンツ" in result_jp

    # 3. Apache generic ISO-8859-1 override: header has latin1 but HTML body has <meta charset="tis-620">
    apache_html = f'<html><head><meta charset="tis-620"><title>Apache Override</title></head><body><p>{thai_text}</p></body></html>'
    apache_bytes = apache_html.encode("cp874")
    mock_resp_apache = MagicMock()
    mock_resp_apache.status_code = 200
    mock_resp_apache.content = apache_bytes
    mock_resp_apache.headers = {"Content-Type": "text/html; charset=iso-8859-1"}

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=mock_resp_apache)):
        result_apache = await extract_text_for_ai(url="https://example.com/apache")
        assert "การทดสอบภาษาไทย" in result_apache


# =====================================================================
# 2. Tests for Remote MCP Server & 13 Tools (B0 - B13)
# =====================================================================

def test_b0_verify_mcp_token_tenant_isolation():
    """B0: Verify token via SHA-256 hash in api_tokens and prevent user_id leakage."""
    db = InMemoryDB()
    raw_token = "jsi_live_secret_456"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    db.tables["api_tokens"].append(
        {
            "id": "tok-1",
            "user_id": "usr-isolated",
            "token_hash": token_hash,
            "revoked_at": None,
        }
    )

    resolved_user = verify_mcp_token(raw_token, db=db)
    assert resolved_user == "usr-isolated"

    # Reject revoked token
    db.tables["api_tokens"][0]["revoked_at"] = datetime.now(timezone.utc).isoformat()
    with pytest.raises(PermissionError, match="revoked"):
        verify_mcp_token(raw_token, db=db)


def test_b1_b13_mcp_tools_suite():
    """B1 - B13: Full suite test covering all 13 Remote MCP Tools."""
    db = InMemoryDB()
    set_override_db(db)
    set_authenticated_user_id("usr-mcp")

    # Item creation and properties
    item = create_item(
        url="https://justsaveit.com/b3",
        title="MCP Item",
        note="Initial Note",
        tags=["Work", "Tech"],
        status="inbox",
    )
    assert item["owner_id"] == "usr-mcp"
    item_id = item["id"]

    # Search and inspection
    items = search_and_list_items(query="MCP Item")
    assert len(items) == 1
    assert items[0]["id"] == item_id

    detail = get_item_detail(item_id)
    assert detail["id"] == item_id
    assert "tags" in detail

    updated = update_item(item_id=item_id, status="done", note="Updated note")
    assert updated["status"] == "done"
    assert "done_at" in updated
    assert updated["note"] == "Updated note"

    # Summarize to note
    mock_resp = SummarizeResponse(
        item_id=item_id,
        url=item["url"],
        summary_th="• บทสรุปเพื่อบันทึก",
        suggested_tags=["Work"],
        cached_from_db=True,
        engine_used="cache",
    )
    with patch("Ai.mcp_server.summarize_item_once", new=AsyncMock(return_value=mock_resp)):
        import asyncio
        sum_note = asyncio.run(summarize_item_to_note(item_id=item_id))
        assert sum_note["summary_th"] == "• บทสรุปเพื่อบันทึก"

    # Tag listing, modification, and deletion
    tags = list_tags()
    assert any(t["name"] == "Work" for t in tags)

    manage_item_tags(item_id=item_id, add_tags=["Urgent"], remove_tags=["Tech"])
    tags_after = list_tags()
    assert any(t["name"] == "Urgent" for t in tags_after)

    renamed = rename_or_delete_tag(tag_name="Urgent", new_name="Critical")
    assert renamed["action"] == "renamed"
    deleted_tag = rename_or_delete_tag(tag_name="Critical", delete=True)
    assert deleted_tag["action"] == "deleted"

    # Folder creation and listing
    folder = manage_folder(action="create", name="Project Alpha", emoji="📁")
    f_id = folder["id"]
    folders = list_folders()
    assert any(f["id"] == f_id for f in folders)

    # Share link generation and revocation
    with pytest.raises(ValueError, match="forbidden"):
        share_folder_link(folder_id=f_id, role="owner")  # Must reject owner role

    invite = share_folder_link(folder_id=f_id, role="editor", expires_in_days=7)
    assert invite["success"] is True
    assert "/invite/" in invite["invite_url"]
    assert invite["role"] == "editor"

    revoked = share_folder_link(folder_id=f_id, revoke_all=True)
    assert revoked["success"] is True

    # Reminder scheduling and cancellation
    rem_set = set_or_cancel_reminder(item_id=item_id, remind_at_iso="2026-11-30T12:00:00Z")
    assert rem_set["action"] == "set"
    rem_cancel = set_or_cancel_reminder(item_id=item_id, cancel=True)
    assert rem_cancel["action"] == "cancelled"

    # Final item deletion
    del_res = delete_item(item_id=item_id)
    assert del_res["success"] is True


def test_b14_mcp_create_item_canonical_dedup_and_hash():
    """B14: MCP create_item normalizes canonical URL, strips tracking, computes url_hash, and dedups (C1, C5)."""
    db = InMemoryDB()
    set_override_db(db)
    set_authenticated_user_id("usr-mcp-1")

    raw_url = "https://Example.COM:443/article/?utm_source=twitter&fbclid=xyz123&topic=ai#top"
    created = create_item(url=raw_url, title="Original Title", note="Original Note")

    assert created["owner_id"] == "usr-mcp-1"
    assert created["canonical_url"] == "https://example.com/article?topic=ai"
    assert created["url_hash"] == hashlib.md5(b"https://example.com/article?topic=ai").hexdigest()
    assert len(db.tables["items"]) == 1

    # Bump dedup with another URL having same canonical form
    bump_url = "https://example.com/article?topic=ai&utm_campaign=winter"
    bumped = create_item(url=bump_url, title="Updated Title", note="Updated Note")

    assert len(db.tables["items"]) == 1
    assert bumped["id"] == created["id"]
    assert bumped["title"] == "Updated Title"
    assert bumped["note"] == "Updated Note"


def test_b15_mcp_search_shared_folders_4fields_and_nfc():
    """B15: MCP search_and_list_items searches across shared folders, 4 fields, and Unicode NFC (C5)."""
    import unicodedata

    db = InMemoryDB()
    set_override_db(db)
    set_authenticated_user_id("usr-mcp-search")

    # Item 1: Owned by current user
    item_owned = {
        "id": "it-search-1",
        "owner_id": "usr-mcp-search",
        "folder_id": None,
        "url": "https://example.com/owned",
        "title": "Docker Containerization Guide",
        "description": "DevOps workflows",
        "note": "Important note on deployment",
        "ai_summary": "สรุปสั้นๆ เกี่ยวกับ Docker",
        "status": "inbox",
    }
    db.tables["items"].append(item_owned)

    # Item 2: In a shared folder owned by another user
    item_shared = {
        "id": "it-search-2",
        "owner_id": "usr-other",
        "folder_id": "folder-shared-abc",
        "url": "https://example.com/k8s",
        "title": "Kubernetes Architecture",
        "description": "Deep dive into cluster orchestration",
        "note": "Shared cluster notes",
        "ai_summary": "สรุปความรู้เกี่ยวกับคลัสเตอร์ระบบ K8s",
        "status": "todo",
    }
    db.tables["items"].append(item_shared)
    db.tables["folder_members"].append({
        "folder_id": "folder-shared-abc",
        "user_id": "usr-mcp-search",
        "role": "viewer",
    })

    # 1. Search shared folder item
    res_shared = search_and_list_items(query="Kubernetes")
    assert len(res_shared) == 1
    assert res_shared[0]["id"] == "it-search-2"

    # 2. Search across each of the 4 fields
    assert len(search_and_list_items(query="Containerization")) == 1   # title
    assert len(search_and_list_items(query="orchestration")) == 1      # description
    assert len(search_and_list_items(query="deployment")) == 1         # note
    assert len(search_and_list_items(query="คลัสเตอร์")) == 1          # ai_summary

    # 3. Unicode NFC: query with NFD decomposed Thai characters matches NFC stored
    nfd_query = unicodedata.normalize("NFD", "คลัสเตอร์")
    res_nfc = search_and_list_items(query=nfd_query)
    assert len(res_nfc) == 1
    assert res_nfc[0]["id"] == "it-search-2"


def test_b16_mcp_set_or_cancel_reminder_every_n_days():
    """B16: MCP set_or_cancel_reminder with recurring every_n_days and cancel (C7)."""
    db = InMemoryDB()
    set_override_db(db)
    set_authenticated_user_id("usr-mcp-rem")

    item = {
        "id": "it-rem-1",
        "owner_id": "usr-mcp-rem",
        "title": "Read Architecture Paper",
    }
    db.tables["items"].append(item)

    # 1. Set every_n_days reminder
    res_set = set_or_cancel_reminder(
        item_id="it-rem-1",
        schedule_type="every_n_days",
        repeat_every_days=3,
        remind_time="20:00:00",
        timezone="Asia/Bangkok",
    )
    assert res_set["success"] is True
    assert res_set["action"] == "set"
    assert res_set["schedule_type"] == "every_n_days"
    assert res_set["repeat_every_days"] == 3
    assert res_set["remind_time"] == "20:00:00"
    assert res_set["timezone"] == "Asia/Bangkok"

    assert len(db.tables["reminders"]) == 1
    rem_row = db.tables["reminders"][0]
    assert rem_row["status"] == "pending"
    assert rem_row["title_snapshot"] == "Read Architecture Paper"

    # Verify cancellation transitions pending reminder to cancelled
    res_cancel = set_or_cancel_reminder(item_id="it-rem-1", cancel=True)
    assert res_cancel["success"] is True
    assert res_cancel["action"] == "cancelled"
    assert rem_row["status"] == "cancelled"


# =====================================================================
# Part 1 CHRIS Security & Contract Regressions (Ai / Extractor / MCP)
# =====================================================================

@pytest.mark.asyncio
async def test_a11_oembed_hostname_and_redirect_ssrf_guard():
    """Verify exact hostname matching for oEmbed and per-hop SSRF validation on HTTP redirects."""
    assert _detect_oembed_endpoint("https://dropbox.com/s/file") is None
    assert _detect_oembed_endpoint("https://netflix.com/watch/123") is None
    assert _detect_oembed_endpoint("https://x.com/user/status/123").startswith("https://publish.twitter.com/oembed")

    redirect_resp = MagicMock()
    redirect_resp.status_code = 302
    redirect_resp.headers = {"location": "http://127.0.0.1/internal"}

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=redirect_resp)

    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]):
        with pytest.raises(ValueError, match="SSRF Alert"):
            await _fetch_url_safely(mock_client, "https://example.com/start")


@pytest.mark.asyncio
async def test_a12_quota_fail_closed_and_language_cache_mismatch():
    """Verify quota fails closed (503) on DB errors and cached summary language respects profile preference."""
    broken_db = MagicMock()
    broken_db.table.side_effect = RuntimeError("DB connection dropped")
    with pytest.raises(HTTPException) as exc:
        check_and_increment_quota(broken_db, "usr-1")
    assert exc.value.status_code == 503

    db = InMemoryDB()
    db.tables["profiles"].append({"id": "usr-lang", "preferred_summary_language": "en"})
    db.tables["items"].append({
        "id": "it-lang",
        "owner_id": "usr-lang",
        "url": "https://example.com/bilingual",
        "url_hash": "hash-bilingual",
        "title": "Bilingual Article",
        "ai_summary": "• สรุปภาษาไทย",
        "ai_summary_language": "th",
        "ai_tags": ["tech"],
    })
    with patch(
        "Ai.summarizer_service.extract_text_for_ai",
        AsyncMock(return_value="English article content for summarization."),
    ), patch(
        "Ai.summarizer_service.generate_structured_summary",
        AsyncMock(
            return_value=(
                AISummaryOutput(
                    summary_th="• Bullet 1\n• Bullet 2\n• Bullet 3",
                    suggested_tags=["ai", "python"],
                    content_type="article",
                ),
                "built-in:gemini-flash",
            )
        ),
    ) as mock_gen:
        resp = await summarize_item_once(
            db=db,
            user_id="usr-lang",
            req=SummarizeRequest(item_id="it-lang", ai_config=AIConfig(provider="built-in")),
        )
    assert resp.cached_from_db is False
    assert resp.summary_language == "en"
    assert mock_gen.await_args.kwargs["summary_language"] == "en"


def test_b14_mcp_auth_middleware_and_tenant_scoping():
    """Verify MCPAuthMiddleware rejects missing token (401) and MCP tools enforce folder/reminder isolation."""
    from fastapi import FastAPI

    mini = FastAPI()
    mini.add_middleware(MCPAuthMiddleware)

    @mini.get("/mcp/ping")
    def _ping():
        return {"ok": True}

    mini_client = TestClient(mini)
    assert mini_client.get("/mcp/ping").status_code == 401

    db = InMemoryDB()
    raw_tok = "jsi_live_test_mcp_middleware_123"
    tok_hash = hashlib.sha256(raw_tok.encode("utf-8")).hexdigest()
    db.tables["api_tokens"].append({"id": "t-mw", "user_id": "usr-owner", "token_hash": tok_hash})
    set_override_db(db)
    try:
        ok_res = mini_client.get("/mcp/ping", headers={"Authorization": f"Bearer {raw_tok}"})
        assert ok_res.status_code == 200
    finally:
        set_override_db(None)

    # Setup folder owned by usr-owner, collaborator usr-collab creates an item in it, and private reminder for usr-owner
    db.tables["folders"].append({"id": "f-shared", "owner_id": "usr-owner", "name": "Shared"})
    db.tables["folders"].append({"id": "f-other", "owner_id": "usr-other", "name": "Other"})
    db.tables["folder_members"].append({"folder_id": "f-shared", "user_id": "usr-editor", "role": "editor"})
    db.tables["items"].append({
        "id": "it-collab",
        "owner_id": "usr-collab",
        "folder_id": "f-shared",
        "url": "https://example.com/collab",
        "title": "Collab Link",
        "status": "inbox",
    })
    db.tables["reminders"].append({
        "id": "r-secret",
        "item_id": "it-collab",
        "user_id": "usr-owner",
        "status": "pending",
        "title_snapshot": "Owner Secret Reminder",
    })

    set_override_db(db)
    set_authenticated_user_id("usr-owner")
    try:
        found = search_and_list_items()
        assert any(i["id"] == "it-collab" for i in found)

        with pytest.raises(ValueError, match="http:// or https://"):
            create_item(url="javascript:alert(1)")
        with pytest.raises(ValueError, match="Invalid status"):
            create_item(url="https://example.com/ok", status="bogus")
        with pytest.raises(PermissionError, match="folder"):
            create_item(url="https://example.com/ok", folder_id="f-other")

        # Editor can access item detail but does NOT see usr-owner's reminder, nor move folder
        set_authenticated_user_id("usr-editor")
        detail = get_item_detail("it-collab")
        assert detail["reminders"] == []
        with pytest.raises(PermissionError, match="owner"):
            update_item(item_id="it-collab", folder_id="f-other")
        with pytest.raises(ValueError, match="Invalid status"):
            update_item(item_id="it-collab", status="invalid_status")

        # Owner rename with whitespace-only / empty update fails cleanly
        set_authenticated_user_id("usr-owner")
        with pytest.raises(ValueError, match="1 and 80"):
            manage_folder(action="rename", folder_id="f-shared", name="   ")
    finally:
        set_authenticated_user_id(None)
        set_override_db(None)


@pytest.mark.asyncio
async def test_c1_html_3mb_cap_and_quota_not_burned_on_llm_failure():
    """C1: Oversized HTML >3MB is bounded to MAX_HTML_BYTES and built-in quota is NOT burned if LLM fails."""
    assert MAX_HTML_BYTES == 3 * 1024 * 1024

    oversized = MagicMock(status_code=200, content=b"A" * (MAX_HTML_BYTES + 250_000), headers={"content-type": "text/html"})
    mock_client = MagicMock()
    mock_client.get = AsyncMock(return_value=oversized)
    with patch("Ai.content_extractor.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
        capped_resp = await _fetch_url_safely(mock_client, "https://example.com/giant")
    assert len(capped_resp.content) == MAX_HTML_BYTES

    db = InMemoryDB()
    db.tables["items"].append({
        "id": "it-fail-llm",
        "owner_id": "usr-q1",
        "url": "https://example.com/article",
        "title": "Test Fail",
        "status": "inbox",
    })
    req = SummarizeRequest(item_id="it-fail-llm")
    with (
        patch("Ai.summarizer_service.extract_text_for_ai", new=AsyncMock(return_value="Body text")),
        patch("Ai.summarizer_service.generate_structured_summary", new=AsyncMock(side_effect=HTTPException(status_code=504, detail="LLM timeout"))),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await summarize_item_once(db=db, user_id="usr-q1", req=req)
        assert exc_info.value.status_code == 504
    assert db.tables["daily_ai_usage"] == []


def test_c1_mcp_tag_sanitization_non_destructive_revoke_and_dual_transport():
    """C1: MCP tags sanitize control chars, revoke_all soft-revokes invites, and /mcp serves SSE + Streamable HTTP."""
    from main import app as main_app

    db = InMemoryDB()
    raw_tok = "jsi_live_c1_dual_transport_tok"
    tok_hash = hashlib.sha256(raw_tok.encode("utf-8")).hexdigest()
    db.tables["api_tokens"].append({"id": "t-c1", "user_id": "usr-c1", "token_hash": tok_hash})
    db.tables["folders"].append({"id": "f-c1", "owner_id": "usr-c1", "name": "Team", "is_shared": True})
    db.tables["folder_members"].append({"folder_id": "f-c1", "user_id": "usr-collab-c1", "role": "editor"})
    db.tables["items"].append({"id": "it-c1", "owner_id": "usr-c1", "url": "https://example.com/1", "title": "One", "status": "inbox"})

    set_override_db(db)
    set_authenticated_user_id("usr-c1")
    try:
        manage_item_tags("it-c1", add_tags=["  \x00AI\x07-News  ", "   "])
        tag_names = [t["name"] for t in db.tables["tags"]]
        assert tag_names == ["AI-News"]

        renamed = rename_or_delete_tag("\x00AI-News", new_name="  AI\x0bSummary  ")
        assert renamed["new_name"] == "AISummary"

        inv = share_folder_link("f-c1", role="viewer")
        assert len(db.tables["folder_invites"]) == 1

        revoked = share_folder_link("f-c1", revoke_all=True)
        assert revoked["success"] is True
        assert len(db.tables["folder_invites"]) == 1
        assert db.tables["folder_invites"][0].get("revoked_at") is not None
        # Existing collaborator remains -> folder stays is_shared=True
        assert db.tables["folders"][0]["is_shared"] is True

        db.tables["folder_members"].clear()
        share_folder_link("f-c1", revoke_all=True)
        assert db.tables["folders"][0]["is_shared"] is False

        with TestClient(main_app) as client:
            unauth = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
            assert unauth.status_code == 401
            init_resp = client.post(
                "/mcp",
                headers={
                    "Authorization": f"Bearer {raw_tok}",
                    "Accept": "application/json, text/event-stream",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "pytest", "version": "1.0"},
                    },
                },
            )
            assert init_resp.status_code == 200
            assert "just-save-it" in init_resp.text.lower() or "serverinfo" in init_resp.text.lower()
    finally:
        set_authenticated_user_id(None)
        set_override_db(None)

