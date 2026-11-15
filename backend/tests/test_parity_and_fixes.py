"""Regression tests for Cloud API bugs, folder covers, invite preview, AI model ID mapping, and enrichment."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
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


def test_parse_cors_settings_supports_extension_regex_and_unhandled_500_keeps_cors(isolated_db, monkeypatch):
    import re
    from main import CHROME_EXTENSION_ORIGIN_REGEX, parse_cors_settings
    from Login.auth_dep import get_current_user_id

    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://just-save-it-web.onrender.com")
    monkeypatch.delenv("CORS_ALLOW_ORIGIN_REGEX", raising=False)
    origins, regex, allow_creds = parse_cors_settings()
    assert origins == ["https://just-save-it-web.onrender.com"]
    assert regex == CHROME_EXTENSION_ORIGIN_REGEX
    assert allow_creds is True
    assert re.match(regex, "chrome-extension://" + "a" * 32)
    assert not re.match(regex, "https://evil.example.com")

    app.dependency_overrides[get_current_user_id] = lambda: "11111111-1111-4111-8111-111111111111"
    try:
        client = TestClient(app, raise_server_exceptions=False)
        with patch("Database.router.list_folders_for_user", side_effect=RuntimeError("db connection leaked_key=abc")):
            resp = client.get(
                "/api/folders",
                headers={"Origin": "https://just-save-it-web.onrender.com"},
            )
        assert resp.status_code == 500
        assert resp.json() == {"detail": "Internal server error"}
        assert "access-control-allow-origin" in {k.lower() for k in resp.headers.keys()}
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)


def test_register_device_validates_web_push_endpoint_ssrf_and_accepts_valid_fcm(isolated_db, monkeypatch):
    from Login.auth_dep import get_current_user_id

    app.dependency_overrides[get_current_user_id] = lambda: "11111111-1111-4111-8111-111111111111"
    try:
        client = TestClient(app)
        # 1. Non-HTTPS metadata IP must be rejected with 422 before DB insert
        bad_meta = client.post(
            "/api/devices",
            json={
                "platform": "web",
                "delivery_mode": "remote",
                "web_push_sub": {
                    "endpoint": "http://169.254.169.254/latest/meta-data",
                    "keys": {"p256dh": "k", "auth": "a"},
                },
            },
        )
        assert bad_meta.status_code == 422

        # 2. Private IP or localhost HTTPS must be rejected with 422
        bad_local = client.post(
            "/api/devices",
            json={
                "platform": "web",
                "delivery_mode": "remote",
                "web_push_sub": {
                    "endpoint": "https://127.0.0.1/push",
                    "keys": {"p256dh": "k", "auth": "a"},
                },
            },
        )
        assert bad_local.status_code == 422
        assert len(isolated_db.tables["devices"]) == 0

        # 3. Valid Web Push FCM endpoint passes validation (mock getaddrinfo to keep test hermetic)
        with patch("Ai.content_extractor.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("142.250.190.10", 443))]):
            good = client.post(
                "/api/devices",
                json={
                    "platform": "web",
                    "delivery_mode": "remote",
                    "web_push_sub": {
                        "endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
                        "keys": {"p256dh": "k", "auth": "a"},
                    },
                },
            )
        assert good.status_code == 201
        assert good.json()["push_token"] == "https://fcm.googleapis.com/fcm/send/abc123"
    finally:
        app.dependency_overrides.pop(get_current_user_id, None)


def test_export_user_data_owner_only_and_over_100_items(isolated_db):
    """PDPA export includes >100 owned items (no 100 RPC cap) and excludes collaborator items/folders."""
    from Database.repository import export_user_data

    owner_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
    collab_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
    isolated_db.tables["profiles"].append({"id": owner_id, "display_name": "Owner"})
    isolated_db.tables["profiles"].append({"id": collab_id, "display_name": "Collab"})

    shared_folder = create_folder_for_user(isolated_db, collab_id, FolderCreateRequest(name="Collab Shared Folder"))
    isolated_db.tables["folder_members"].append({
        "folder_id": shared_folder["id"],
        "user_id": owner_id,
        "role": "editor",
    })
    collab_item = create_or_bump_item(
        isolated_db,
        collab_id,
        ItemCreateRequest(url="https://example.com/collab-only", title="Collab Item", folder_id=shared_folder["id"]),
    )

    for idx in range(520):
        isolated_db.tables["items"].append({
            "id": f"00000000-0000-4000-8000-{idx:012d}",
            "owner_id": owner_id,
            "url": f"https://example.com/owned/{idx}",
            "canonical_url": f"https://example.com/owned/{idx}",
            "url_hash": f"hash-{idx:04d}",
            "title": f"Owned Item {idx}",
            "status": "inbox",
            "saved_at": "2026-11-15T00:00:00+00:00",
        })

    exported = export_user_data(isolated_db, owner_id)
    exported_ids = {row["id"] for row in exported["items"]}
    exported_folder_ids = {row["id"] for row in exported["folders"]}

    assert len(exported["items"]) == 520
    assert collab_item["id"] not in exported_ids
    assert shared_folder["id"] not in exported_folder_ids


def test_delete_my_account_revokes_subsequent_token_use(isolated_db, monkeypatch):
    """DELETE /api/auth/me deletes auth user before profile and rejects subsequent requests with 401."""
    import jwt as pyjwt
    from Login import auth_dep

    test_secret = "parity-test-jwt-secret-key-at-least-32b"
    monkeypatch.setenv("SUPABASE_JWT_SECRET", test_secret)
    uid = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3"
    isolated_db.tables["profiles"].append({"id": uid, "display_name": "Delete User"})

    call_order = []
    orig_delete_user = getattr(getattr(getattr(isolated_db, "auth", None), "admin", None), "delete_user", None)

    class _MockAuthAdmin:
        def delete_user(self, target_uid):
            call_order.append(("auth_admin.delete_user", target_uid))
            assert any(p.get("id") == target_uid for p in isolated_db.tables["profiles"]), (
                "auth_admin.delete_user must run before profile row deletion"
            )

    class _MockAuth:
        admin = _MockAuthAdmin()

    isolated_db.auth = _MockAuth()
    token = pyjwt.encode(
        {
            "sub": uid,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int((datetime.now(timezone.utc) + timedelta(minutes=15)).timestamp()),
        },
        test_secret,
        algorithm="HS256",
    )

    try:
        client = TestClient(app)
        del_res = client.delete("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert del_res.status_code == 200
        assert del_res.json()["deleted"] is True
        assert ("auth_admin.delete_user", uid) in call_order

        me_after = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert me_after.status_code == 401
    finally:
        auth_dep._DELETED_USER_IDS.discard(uid)
        if orig_delete_user is None and hasattr(isolated_db, "auth"):
            delattr(isolated_db, "auth")


@pytest.mark.asyncio
async def test_ai_url_hash_cache_does_not_leak_donor_tags(isolated_db):
    """url_hash donor cache reuses summary without leaking another tenant's private ai_tags."""
    from Ai.schemas import AIConfig, SummarizeRequest
    from Ai.summarizer_service import summarize_item_once

    isolated_db.tables["items"].append({
        "id": "donor-item-1",
        "owner_id": "donor-owner",
        "url": "https://example.com/shared-article",
        "url_hash": "shared-url-hash-xyz",
        "ai_summary": "• สรุปข้อ 1\n• สรุปข้อ 2\n• สรุปข้อ 3",
        "ai_summary_language": "th",
        "ai_tags": ["confidential-project", "secret-client"],
    })
    isolated_db.tables["items"].append({
        "id": "recip-item-2",
        "owner_id": "recipient-owner",
        "url": "https://example.com/shared-article",
        "url_hash": "shared-url-hash-xyz",
        "ai_tags": ["my-tag"],
    })

    resp = await summarize_item_once(
        db=isolated_db,
        user_id="recipient-owner",
        req=SummarizeRequest(item_id="recip-item-2", ai_config=AIConfig(provider="built-in")),
    )
    assert resp.cached_from_db is True
    assert "confidential-project" not in resp.suggested_tags
    assert "secret-client" not in resp.suggested_tags
    assert resp.suggested_tags == ["my-tag"]


def test_mcp_create_item_rejects_ssrf_targets(isolated_db):
    """MCP create_item invokes SSRF guard so loopback/metadata IPs are rejected."""
    from Ai.mcp_server import create_item, set_authenticated_user_id, set_override_db

    set_override_db(isolated_db)
    set_authenticated_user_id("usr-mcp-ssrf")
    try:
        with pytest.raises(ValueError):
            create_item(url="http://127.0.0.1:8000/internal")
        with pytest.raises(ValueError):
            create_item(url="http://169.254.169.254/latest/meta-data")
        assert len(isolated_db.tables["items"]) == 0
    finally:
        set_authenticated_user_id(None)
        set_override_db(None)


@pytest.mark.asyncio
async def test_extract_youtube_and_x_fetch_real_html_description_and_images():
    """YouTube/TikTok skip slow HTML fetch on fast path when oEmbed has title+thumb+embed, fetch HTML on refresh; X fetches images."""
    from Unfurl.extractors import extract_unfurl_metadata

    yt_oembed = {
        "title": "Demo Video Title",
        "author_name": "CreatorChannel",
        "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "html": '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
    }
    yt_html_meta = {
        "title": "Demo Video Title",
        "description": "Full real video description extracted from YouTube meta tag.",
        "media_items": ["https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"],
    }
    with (
        patch("Unfurl.extractors._fetch_json_safely", new=AsyncMock(return_value=yt_oembed)),
        patch("Unfurl.extractors._fetch_generic_html_meta", new=AsyncMock(return_value=yt_html_meta)) as mock_html,
    ):
        res_fast = await extract_unfurl_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        mock_html.assert_not_awaited()
        assert res_fast.title == "Demo Video Title"
        assert res_fast.description == "By CreatorChannel"
        assert res_fast.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ"
        assert len(res_fast.media_items) >= 1

        res_yt_full = await extract_unfurl_metadata(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            fetch_full_description=True,
        )
        mock_html.assert_awaited_once()
        assert res_yt_full.description == "Full real video description extracted from YouTube meta tag."

    tt_oembed = {
        "title": "Coffee Pour Over",
        "author_name": "barista_th",
        "thumbnail_url": "https://p16-sign.tiktokcdn-us.com/cover_7123.jpg",
        "html": '<blockquote class="tiktok-embed" data-video-id="7123456789012345678"></blockquote>',
    }
    with (
        patch("Unfurl.extractors._fetch_json_safely", new=AsyncMock(return_value=tt_oembed)),
        patch("Unfurl.extractors._fetch_generic_html_meta", new=AsyncMock()) as mock_tt_html,
    ):
        res_tt = await extract_unfurl_metadata("https://www.tiktok.com/@barista_th/video/7123456789012345678")
        mock_tt_html.assert_not_awaited()
        assert res_tt.title == "Coffee Pour Over"
        assert res_tt.description == "@barista_th"
        assert res_tt.embed_url == "https://www.tiktok.com/embed/v2/7123456789012345678"

    x_oembed = {
        "author_name": "AliceDev",
        "html": "<blockquote><p>Check out this cool architecture diagram!</p></blockquote>",
    }
    x_html_meta = {
        "title": "AliceDev on X",
        "description": "Check out this cool architecture diagram!",
        "media_items": ["https://pbs.twimg.com/media/demo123.jpg"],
    }
    with (
        patch("Unfurl.extractors._fetch_json_safely", new=AsyncMock(return_value=x_oembed)),
        patch("Unfurl.extractors._fetch_generic_html_meta", new=AsyncMock(return_value=x_html_meta)) as mock_x_html,
    ):
        res_x = await extract_unfurl_metadata("https://x.com/AliceDev/status/1234567890")
        mock_x_html.assert_awaited_once()
        assert "https://pbs.twimg.com/media/demo123.jpg" in res_x.media_items


def test_duplicate_bump_missing_preview_triggers_re_enrichment_and_safe_default_cors(isolated_db, monkeypatch):
    """Bumping a deduplicated item lacking image/description/embed marks enrich_status='pending'; default CORS is non-wildcard."""
    from main import parse_cors_settings

    monkeypatch.delenv("CORS_ALLOW_ORIGINS", raising=False)
    monkeypatch.delenv("CORS_ALLOW_ORIGIN_REGEX", raising=False)
    origins, regex, allow_creds = parse_cors_settings()
    assert "*" not in origins
    assert "https://just-save-it-web.onrender.com" in origins
    assert allow_creds is True
    assert regex is not None

    user_id = "11111111-1111-4111-8111-111111111111"
    created = create_or_bump_item(
        isolated_db,
        user_id,
        ItemCreateRequest(url="https://www.youtube.com/watch?v=abcDEF12345", title="YT Raw"),
    )
    isolated_db.table("items").update(
        {"enrich_status": "unfurled", "platform": "youtube", "description": "By OldAuthor"}
    ).eq("id", created["id"]).execute()

    bumped = create_or_bump_item(
        isolated_db,
        user_id,
        ItemCreateRequest(
            url="https://www.youtube.com/watch?v=abcDEF12345",
            title="YT Raw",
            embed_type="youtube",
            platform="youtube",
            content_type="video",
        ),
    )
    assert bumped["deduplicated"] is True
    assert bumped["enrich_status"] == "pending"
    assert bumped["embed_type"] == "youtube"


@pytest.mark.asyncio
async def test_fetch_url_safely_strips_content_encoding_on_stream_bytes():
    """Streaming decompressed chunks must strip Content-Encoding/Length to prevent httpx.DecodingError."""
    import httpx
    from Ai.content_extractor import _fetch_url_safely

    class _FakeStreamResp:
        status_code = 200
        headers = httpx.Headers(
            {
                "Content-Encoding": "gzip",
                "Content-Length": "99",
                "Content-Type": "application/json",
            }
        )
        request = httpx.Request("GET", "https://www.youtube.com/oembed")

        async def aiter_bytes(self):
            yield b'{"title": "Me at the zoo", "author_name": "jawed"}'

    class _FakeStreamCtx:
        async def __aenter__(self):
            return _FakeStreamResp()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeAsyncClient:
        def stream(self, method, url, headers=None):
            return _FakeStreamCtx()

    with patch("Ai.content_extractor.validate_safe_url", side_effect=lambda u: u):
        resp = await _fetch_url_safely(_FakeAsyncClient(), "https://www.youtube.com/oembed?url=https://youtu.be/jNQXAC9IVRw")

    assert resp.status_code == 200
    assert resp.json()["title"] == "Me at the zoo"
    assert "content-encoding" not in resp.headers


@pytest.mark.asyncio
async def test_verify_live_user_exists_uses_ttl_cache_and_fails_closed_on_revocation():
    """Live check uses short-TTL cache to skip repeat queries, while mark_user_deleted and TTL expiry still fail closed."""
    from fastapi import HTTPException
    from Login import auth_dep

    uid = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4"
    profiles_calls = 0

    class _ProfilesTable:
        def select(self, *_args):
            return self

        def eq(self, *_args):
            return self

        def limit(self, *_args):
            return self

        def execute(self):
            nonlocal profiles_calls
            profiles_calls += 1
            if profiles_calls == 1:
                return SimpleNamespace(data=[{"id": uid}])
            return SimpleNamespace(data=[])

    class _FakeAuthAdmin:
        def get_user_by_id(self, target_uid):
            raise RuntimeError(f"AuthApiError: User not found (404) for {target_uid}")

    fake_db = SimpleNamespace(
        table=lambda _name: _ProfilesTable(),
        auth=SimpleNamespace(admin=_FakeAuthAdmin()),
    )

    auth_dep.clear_live_user_cache(uid)
    auth_dep._DELETED_USER_IDS.discard(uid)
    try:
        with patch("Login.auth_dep.is_supabase_configured", return_value=True), patch(
            "Login.auth_dep.get_supabase_client", return_value=fake_db
        ):
            # 1st check hits DB once and populates short-TTL cache
            auth_dep._verify_live_user_exists(uid)
            assert profiles_calls == 1

            # 2nd check within TTL serves from memory with 0 DB queries
            auth_dep._verify_live_user_exists(uid)
            assert profiles_calls == 1

            # After TTL expires (or cache clears), 404 from Supabase auth rejects immediately
            auth_dep.clear_live_user_cache(uid)
            with pytest.raises(HTTPException) as exc_info:
                auth_dep._verify_live_user_exists(uid)
            assert exc_info.value.status_code == 401
            assert auth_dep.is_user_deleted(uid) is True
            assert profiles_calls == 2

            # Direct mark_user_deleted also evicts an active positive cache entry immediately
            auth_dep._DELETED_USER_IDS.discard(uid)
            auth_dep._cache_live_user_verified(uid)
            assert auth_dep._is_cached_live_user(uid) is True
            auth_dep.mark_user_deleted(uid)
            assert auth_dep._is_cached_live_user(uid) is False
            with pytest.raises(HTTPException) as rev_exc:
                auth_dep._verify_live_user_exists(uid)
            assert rev_exc.value.status_code == 401
    finally:
        auth_dep.clear_live_user_cache(uid)
        auth_dep._DELETED_USER_IDS.discard(uid)


def test_attach_tags_batch_and_shared_folders_query_count(isolated_db):
    """_attach_tags_to_item runs in <=3 queries regardless of tag count, and list_folders_for_user batches shared folders."""
    from Database.repository import _attach_tags_to_item

    uid = "11111111-1111-4111-8111-111111111111"
    other_uid = "22222222-2222-4222-8222-222222222222"

    # Seed an item directly
    created = create_or_bump_item(
        isolated_db,
        uid,
        ItemCreateRequest(url="https://example.com/batch-tags-test", title="Batch Test"),
    )
    item_id = created["id"]

    # Seed 3 folders owned by other_uid where uid is collaborator
    for idx in range(3):
        fid = f"f-shared-{idx}"
        isolated_db.table("folders").insert(
            {"id": fid, "owner_id": other_uid, "name": f"Shared {idx}", "is_shared": True}
        ).execute()
        isolated_db.table("folder_members").insert(
            {"folder_id": fid, "user_id": uid, "role": "editor"}
        ).execute()

    table_calls = []
    orig_table = isolated_db.table

    def counting_table(name: str):
        table_calls.append(name)
        return orig_table(name)

    with patch.object(isolated_db, "table", side_effect=counting_table):
        attached = _attach_tags_to_item(
            isolated_db,
            uid,
            item_id,
            ["alpha", "beta", "gamma", "delta", "epsilon"],
            links_cleared=True,
        )
        assert attached == ["alpha", "beta", "gamma", "delta", "epsilon"]
        assert len(table_calls) <= 3

        table_calls.clear()
        attached_again = _attach_tags_to_item(
            isolated_db,
            uid,
            item_id,
            ["alpha", "beta", "zeta"],
            links_cleared=False,
        )
        assert attached_again == ["alpha", "beta", "zeta"]
        assert len(table_calls) <= 3

        table_calls.clear()
        folders = list_folders_for_user(isolated_db, uid)
        shared_found = [f for f in folders if f.get("role") == "editor"]
        assert len(shared_found) == 3
        # owned folders (1) + memberships (1) + shared folders batch (1) + member_counts batch (1)
        assert table_calls.count("folders") == 2


def test_workspace_endpoint_and_pooled_client_singleton(isolated_db, monkeypatch):
    """GET /api/workspace returns bundled profile, quota, folders, tags, items, reminders; pooled client reuses singleton."""
    from Database import client as db_client
    from Database import supabase_client as sc

    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    uid = "11111111-1111-4111-8111-111111111111"

    test_client = TestClient(app)
    assert test_client.get("/api/workspace").status_code == 401

    resp = test_client.get("/api/workspace?limit=50", headers={"X-User-Id": uid})
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == uid
    assert "profile" in body
    assert "ai_quota" in body
    assert isinstance(body["folders"], list)
    assert isinstance(body["tags"], list)
    assert isinstance(body["items"], list)
    assert isinstance(body["reminders"], list)
    assert "count" in body

    # Verify Database.client reuses singleton from Database.supabase_client
    set_override_supabase_client(None)
    monkeypatch.setenv("SUPABASE_URL", "https://demo-pool.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srv-secret-key")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-secret-key")
    fake_pool_calls = 0

    def _fake_create(url, key):
        nonlocal fake_pool_calls
        fake_pool_calls += 1
        return SimpleNamespace(url=url, key=key)

    sc._service_client_instance = None
    sc._service_client_key = None
    try:
        with patch("Database.supabase_client.create_client", side_effect=_fake_create):
            c1 = db_client.get_supabase_client()
            c2 = db_client.get_supabase_client()
            assert c1 is c2
            assert fake_pool_calls == 1
    finally:
        sc._service_client_instance = None
        sc._service_client_key = None
        set_override_supabase_client(isolated_db)
