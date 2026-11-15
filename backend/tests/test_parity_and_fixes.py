"""Regression tests for Cloud API bugs, folder covers, invite preview, AI model ID mapping, and enrichment."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from Ai.llm_client import resolve_upstream_model_id
from Database.client import set_override_supabase_client
from Database.local_db import LocalDevDatabase
from Database.repository import (
    create_folder_for_user,
    create_folder_invite,
    create_or_bump_item,
    list_folders_for_user,
    preview_folder_invite,
    update_folder_for_user,
    update_item_for_user,
)
from Database.router import _run_local_enrichment
from Database.schemas import (
    FolderCreateRequest,
    FolderUpdateRequest,
    InviteCreateRequest,
    ItemCreateRequest,
    ItemUpdateRequest,
)
from main import app


@pytest.fixture()
def isolated_db():
    db = LocalDevDatabase(persist_path=None)
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


def test_folder_cover_validation_and_persistence(isolated_db, monkeypatch):
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    user_id = "11111111-1111-4111-8111-111111111111"

    req = FolderCreateRequest(name="คาเฟ่โปรด", emoji="☕", cover="./assets/covers/coffee.png")
    created = create_folder_for_user(isolated_db, user_id, req)
    assert created["cover_url"] == "./assets/covers/coffee.png"

    upd = FolderUpdateRequest(cover_url="https://cdn.example.com/custom-cover.webp")
    updated = update_folder_for_user(isolated_db, user_id, created["id"], upd)
    assert updated["cover_url"] == "https://cdn.example.com/custom-cover.webp"

    with pytest.raises(ValidationError):
        FolderCreateRequest(name="Bad Cover", cover="javascript:alert(1)")
    with pytest.raises(ValidationError):
        FolderCreateRequest(name="Traversal", cover="./assets/covers/../secret.png")


def test_folder_pgrst204_cover_fallback_still_creates_and_updates(isolated_db):
    user_id = "11111111-1111-4111-8111-111111111111"
    orig_table = isolated_db.table

    class SchemaLagProxy:
        def __init__(self, inner):
            self._inner = inner
            self._fail_once = False

        def insert(self, payload):
            if isinstance(payload, dict) and "cover_url" in payload:
                self._fail_once = True
            return _FailCoverQuery(self._inner.insert(payload), self._fail_once)

        def update(self, payload):
            if isinstance(payload, dict) and "cover_url" in payload:
                return _FailCoverQuery(self._inner.update(payload), True)
            return self._inner.update(payload)

        def __getattr__(self, item):
            return getattr(self._inner, item)

    class _FailCoverQuery:
        def __init__(self, q, should_fail):
            self._q = q
            self._should_fail = should_fail

        def eq(self, *a, **kw):
            self._q = self._q.eq(*a, **kw)
            return self

        def execute(self):
            if self._should_fail:
                raise RuntimeError("PGRST204: Could not find the 'cover_url' column of 'folders'")
            return self._q.execute()

    class LagDB:
        def table(self, name):
            inner = orig_table(name)
            return SchemaLagProxy(inner) if name == "folders" else inner

    created = create_folder_for_user(
        LagDB(),
        user_id,
        FolderCreateRequest(name="Schema Lag", emoji="📁", cover_url="./assets/covers/study.png"),
    )
    assert created["name"] == "Schema Lag"


def test_remove_from_folder_clears_folder_id_without_deleting_item(isolated_db):
    user_id = "11111111-1111-4111-8111-111111111111"
    folder = create_folder_for_user(isolated_db, user_id, FolderCreateRequest(name="Trips"))
    item = create_or_bump_item(
        isolated_db,
        user_id,
        ItemCreateRequest(url="https://example.com/tokyo", title="Tokyo Guide", folder_id=folder["id"]),
    )
    assert item["folder_id"] == folder["id"]

    detached = update_item_for_user(isolated_db, user_id, item["id"], ItemUpdateRequest(folder_id=None))
    assert detached["id"] == item["id"]
    assert detached["folder_id"] is None

    still_exists = isolated_db.table("items").select("*").eq("id", item["id"]).execute().data
    assert len(still_exists) == 1


def test_invite_preview_returns_non_pii_metadata_and_checks_expiry(isolated_db, monkeypatch):
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    owner_id = "11111111-1111-4111-8111-111111111111"
    existing_prof = isolated_db.table("profiles").select("*").eq("id", owner_id).execute().data
    if existing_prof:
        isolated_db.table("profiles").update({"display_name": "เมย์", "email": "secret-owner@example.com"}).eq("id", owner_id).execute()
    else:
        isolated_db.table("profiles").insert({
            "id": owner_id,
            "display_name": "เมย์",
            "email": "secret-owner@example.com",
        }).execute()
    folder = create_folder_for_user(
        isolated_db,
        owner_id,
        FolderCreateRequest(name="ร้านกาแฟลับ", emoji="☕", cover="./assets/covers/coffee.png"),
    )
    create_or_bump_item(
        isolated_db,
        owner_id,
        ItemCreateRequest(url="https://example.com/cafe-1", title="Ari Cafe", folder_id=folder["id"]),
    )
    inv = create_folder_invite(isolated_db, owner_id, folder["id"], InviteCreateRequest(role="editor"))
    token = inv["token"]

    client = TestClient(app)
    res = client.get(f"/api/invites/{token}")
    assert res.status_code == 200
    body = res.json()
    assert body["valid"] is True
    assert body["folder_name"] == "ร้านกาแฟลับ"
    assert body["folder_cover_url"] == "./assets/covers/coffee.png"
    assert body["inviter_name"] == "เมย์"
    assert body["item_count"] == 1
    assert "email" not in body

    # Expire invite and verify preview reflects expired state
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    isolated_db.table("folder_invites").update({"expires_at": past}).eq("token", token).execute()
    expired = client.get(f"/api/invites/{token}").json()
    assert expired["valid"] is False
    assert expired["reason"] == "expired"

    # Unknown token returns 404
    assert client.get("/api/invites/nonexistenttokenvalue").status_code == 404


def test_ai_model_display_alias_mapping_and_test_endpoint(isolated_db, monkeypatch):
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-server-gemini-key")

    assert resolve_upstream_model_id("GPT-4.1 mini") == "gpt-4.1-mini"
    assert resolve_upstream_model_id("GPT-4o mini") == "gpt-4o-mini"
    assert resolve_upstream_model_id("Claude Sonnet") == "claude-sonnet-4-20250514"
    assert resolve_upstream_model_id("Claude Haiku") == "claude-3-5-haiku-20241022"
    assert resolve_upstream_model_id("Gemini Flash") == "gemini-2.5-flash"
    assert resolve_upstream_model_id("Gemini Pro") == "gemini-2.5-pro"
    assert resolve_upstream_model_id("custom-local-llama") == "custom-local-llama"

    usage_before = len(isolated_db.table("daily_ai_usage").select("*").execute().data)
    client = TestClient(app)
    res = client.post(
        "/api/ai/test",
        headers={"X-User-Id": "11111111-1111-4111-8111-111111111111", "X-AI-Provider": "built-in"},
    )
    assert res.status_code == 200
    assert res.json()["ok"] is True
    # Ensure connection ping did not consume monthly free quota
    assert len(isolated_db.table("daily_ai_usage").select("*").execute().data) == usage_before

    # Block SSRF internal/metadata endpoints on both /api/ai/test and /api/ai/summarize
    ssrf_res = client.post(
        "/api/ai/test",
        headers={
            "X-User-Id": "11111111-1111-4111-8111-111111111111",
            "X-AI-Provider": "custom",
            "X-AI-Base-Url": "http://169.254.169.254/latest/meta-data",
        },
    )
    assert ssrf_res.status_code == 400
    assert "SSRF" in ssrf_res.json()["detail"] or "permitted" in ssrf_res.json()["detail"]

    priv_res = client.post(
        "/api/ai/test",
        headers={"X-User-Id": "11111111-1111-4111-8111-111111111111"},
        json={"ai_config": {"provider": "custom", "base_url": "http://10.0.0.1:8080/v1", "model": ""}},
    )
    assert priv_res.status_code == 400

    # Localhost Ollama endpoint must also be rejected when ENV=production
    monkeypatch.setenv("ENV", "production")
    from Ai.llm_client import validate_ai_base_url

    with pytest.raises(ValueError):
        validate_ai_base_url("http://localhost:11434/v1", allow_default_local=True)
    with pytest.raises(ValueError):
        validate_ai_base_url(None, allow_default_local=True)


@pytest.mark.asyncio
async def test_background_enrichment_skips_already_unfurled_items(isolated_db):
    user_id = "11111111-1111-4111-8111-111111111111"
    item = create_or_bump_item(
        isolated_db,
        user_id,
        ItemCreateRequest(url="https://example.com/done", title="Done Item"),
    )
    isolated_db.table("items").update({"enrich_status": "unfurled"}).eq("id", item["id"]).execute()

    with patch("Unfurl.service.enrich_item", new=AsyncMock()) as mocked_enrich:
        await _run_local_enrichment(isolated_db, item["id"])
        mocked_enrich.assert_not_called()


def test_ai_empty_byok_or_custom_returns_400_not_builtin_or_500(isolated_db, monkeypatch):
    from Ai.schemas import AIConfig
    from Login.auth_dep import get_current_user_id

    parsed_builtin = AIConfig.from_headers(
        x_ai_provider="built-in",
        x_ai_base_url="http://169.254.169.254/latest",
    )
    assert parsed_builtin.provider == "built-in"
    assert parsed_builtin.base_url is None

    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    client = TestClient(app)

    # 1. X-AI-Provider: byok with empty key + JSON ai_config must NOT succeed as built-in (test & summarize)
    test_byok = client.post(
        "/api/ai/test",
        headers={"X-User-Id": "u-ai-test", "X-AI-Provider": "byok"},
        json={"ai_config": {"provider": "byok", "model": "gpt-4o-mini"}},
    )
    assert test_byok.status_code == 400

    sum_byok_headers = client.post(
        "/api/ai/summarize",
        headers={"X-User-Id": "u-ai-test", "X-AI-Provider": "byok"},
        json={"item_id": "it-missing"},
    )
    assert sum_byok_headers.status_code == 400

    sum_byok_body = client.post(
        "/api/ai/summarize",
        headers={"X-User-Id": "u-ai-test", "X-AI-Provider": "byok"},
        json={"item_id": "it-missing", "ai_config": {"provider": "byok", "api_key": None}},
    )
    assert sum_byok_body.status_code == 400

    # 2. ENV=production: X-AI-Provider: custom with empty URL must return 400 on /test and /summarize (never 200 or 500)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "false")
    app.dependency_overrides[get_current_user_id] = lambda: "u-ai-prod"
    try:
        test_custom_body = client.post(
            "/api/ai/test",
            headers={"X-AI-Provider": "custom"},
            json={"ai_config": {"provider": "custom"}},
        )
        assert test_custom_body.status_code == 400

        test_custom_headers = client.post(
            "/api/ai/test",
            headers={"X-AI-Provider": "custom"},
        )
        assert test_custom_headers.status_code == 400

        sum_custom_body = client.post(
            "/api/ai/summarize",
            headers={"X-AI-Provider": "custom"},
            json={"item_id": "it-missing", "ai_config": {"provider": "custom", "base_url": None}},
        )
        assert sum_custom_body.status_code == 400

        sum_custom_headers = client.post(
            "/api/ai/summarize",
            headers={"X-AI-Provider": "custom"},
            json={"item_id": "it-missing"},
        )
        assert sum_custom_headers.status_code == 400
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)
