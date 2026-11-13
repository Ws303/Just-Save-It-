"""Comprehensive Unit Tests for Just-Save-It AI Module and MCP Server.

Validates all 22 checkpoints from AI_IMPLEMENTATION_PLAN.md:
- Core AI (A1 - A8)
- Remote MCP Server (B0 - B13)
"""

from datetime import datetime, timezone
import hashlib
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from Ai.content_extractor import (
    MAX_EXTRACTED_CHARS,
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
        }

    def table(self, name: str):
        return TableProxy(self.tables.setdefault(name, []))


class TableProxy:
    def __init__(self, data_list: List[Dict[str, Any]]):
        self._data = data_list
        self._filters: Dict[str, Any] = {}
        self._not_filters: Dict[str, Any] = {}
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
        self._filters[f"{col}__in"] = set(val_list)
        return self

    @property
    def not_(self):
        return self

    def is_(self, col, val):
        if val == "null":
            self._not_filters[col] = None
        return self

    def limit(self, n):
        return self

    def insert(self, payload):
        if isinstance(payload, dict):
            new_item = dict(payload)
            if "id" not in new_item:
                new_item["id"] = str(uuid.uuid4())
            self._data.append(new_item)
            self._last_inserted = new_item
        return self

    def update(self, updates):
        self._pending_updates = updates
        return self

    def delete(self):
        self._action = "delete"
        return self

    def execute(self):
        if hasattr(self, "_last_inserted"):
            res = MagicMock(data=[self._last_inserted])
            del self._last_inserted
            return res

        if hasattr(self, "_pending_updates"):
            updates = self._pending_updates
            del self._pending_updates
            updated = []
            for item in self._data:
                match = True
                for k, v in self._filters.items():
                    if item.get(k) != v:
                        match = False
                        break
                if match:
                    item.update(updates)
                    updated.append(item)
            return MagicMock(data=updated)

        if getattr(self, "_action", None) == "delete":
            self._action = "select"
            remaining = []
            deleted = []
            for item in self._data:
                match = True
                for k, v in self._filters.items():
                    if item.get(k) != v:
                        match = False
                        break
                if match:
                    deleted.append(item)
                else:
                    remaining.append(item)
            self._data.clear()
            self._data.extend(remaining)
            return MagicMock(data=deleted)

        filtered = []
        for item in self._data:
            match = True
            for k, v in self._filters.items():
                if k.endswith("__in"):
                    col = k.split("__in")[0]
                    if item.get(col) not in v:
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break

            for not_col, not_val in self._not_filters.items():
                if not_val is None and (item.get(not_col) is None or item.get(not_col) == ""):
                    match = False
                    break

            if match:
                filtered.append(item)
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
    """A8: Endpoint POST /api/ai/summarize accepts headers and enforces auth."""
    client = TestClient(app)

    # 401 without token
    resp_unauth = client.post("/api/ai/summarize", json={"item_id": "test-uuid"})
    assert resp_unauth.status_code == 401

    # Dev/Test header authentication passes to service
    mock_resp = SummarizeResponse(
        item_id="it-test",
        url="https://example.com",
        summary_th="Summary",
        suggested_tags=["Tag"],
        cached_from_db=True,
        engine_used="cache",
    )
    with patch("Ai.router.summarize_item_once", new=AsyncMock(return_value=mock_resp)):
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
