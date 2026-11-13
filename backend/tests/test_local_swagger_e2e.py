"""Tests for zero-config LocalDevDatabase persistence, Swagger HTTPBearer schema, and hardened JWT auth."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
import uuid

from fastapi.testclient import TestClient
import pytest

from Database.client import set_override_supabase_client
from Database.local_db import get_local_dev_db, reset_local_dev_db
from Database.supabase_client import is_supabase_configured
from main import app


@pytest.fixture
def isolated_local_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Force LocalDevDatabase to use a clean temporary JSON file without test overrides."""
    db_file = tmp_path / "local_dev_db.json"
    monkeypatch.setenv("LOCAL_DEV_DB_PATH", str(db_file))
    monkeypatch.setenv("DISABLE_LOCAL_BG_ENRICH", "true")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    set_override_supabase_client(None)
    reset_local_dev_db()
    yield db_file
    set_override_supabase_client(None)
    reset_local_dev_db()


def test_env_example_placeholders_rejected_by_is_supabase_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_URL", "https://your-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "your_supabase_service_role_key_here")
    assert is_supabase_configured() is False


def test_swagger_docs_openapi_security_and_health(isolated_local_db: Path):
    client = TestClient(app)

    docs_resp = client.get("/docs")
    assert docs_resp.status_code == 200
    assert "SwaggerUIBundle" in docs_resp.text

    openapi_resp = client.get("/openapi.json")
    assert openapi_resp.status_code == 200
    security_schemes = openapi_resp.json().get("components", {}).get("securitySchemes", {})
    assert "HTTPBearer" in security_schemes

    health_resp = client.get("/health")
    assert health_resp.status_code == 200
    assert health_resp.json()["storage_mode"] == "local_dev"


def test_hardened_dependencies_rejects_unverified_jwt_and_ungated_dev_header(
    isolated_local_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    client = TestClient(app)

    # Raw string containing '-' must be rejected on routes using get_current_user (/api/auth/logout)
    resp_raw = client.post(
        "/api/auth/logout",
        headers={"Authorization": "Bearer 11111111-1111-4111-8111-111111111111"},
    )
    assert resp_raw.status_code == 401

    # X-User-Id must be rejected unless ENV=development AND ALLOW_DEV_AUTH_BYPASS=true
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "false")
    resp_bypass_blocked = client.post(
        "/api/auth/logout",
        headers={"X-User-Id": "11111111-1111-4111-8111-111111111111"},
    )
    assert resp_bypass_blocked.status_code == 401

    # Unsigned tampered JWT must fail signature verification
    tampered_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.invalid_sig"
    resp_tampered = client.post(
        "/api/auth/logout",
        headers={"Authorization": f"Bearer {tampered_jwt}"},
    )
    assert resp_tampered.status_code == 401

    # Allowed only when both dev bypass flags are active
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "true")
    resp_dev_ok = client.post(
        "/api/auth/logout",
        headers={"X-User-Id": "11111111-1111-4111-8111-111111111111"},
    )
    assert resp_dev_ok.status_code == 200


def test_local_dev_full_flow_persistence_and_tenant_isolation(isolated_local_db: Path):
    client = TestClient(app)

    # 1. Pre-seeded demo user login works immediately out-of-the-box
    demo_login = client.post(
        "/api/auth/login",
        json={"email": "may@example.com", "password": "password123"},
    )
    assert demo_login.status_code == 200
    demo_token = demo_login.json()["access_token"]
    demo_folders = client.get(
        "/api/folders",
        headers={"Authorization": f"Bearer {demo_token}"},
    )
    assert demo_folders.status_code == 200
    assert len(demo_folders.json()["folders"]) >= 2

    # 2. Register User A, create Folder, save Link with Tags + Reminder
    reg_a = client.post(
        "/api/auth/register",
        json={
            "email": "alice.local@example.com",
            "password": "Password123!",
            "display_name": "Alice",
        },
    )
    assert reg_a.status_code == 201
    token_a = reg_a.json()["access_token"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    folder_a = client.post(
        "/api/folders",
        headers=headers_a,
        json={"name": "Work Links", "emoji": "💼"},
    )
    assert folder_a.status_code == 201
    folder_a_id = folder_a.json()["id"]

    remind_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    item_a = client.post(
        "/api/items",
        headers=headers_a,
        json={
            "url": "https://fastapi.tiangolo.com/tutorial/?utm_source=test",
            "title": "FastAPI Tutorial",
            "folder_id": folder_a_id,
            "tags": ["fastapi", "backend"],
            "note": "Read first",
            "reminder": {
                "schedule_type": "once",
                "remind_at": remind_at,
                "timezone": "Asia/Bangkok",
            },
        },
    )
    assert item_a.status_code == 201
    item_a_id = item_a.json()["id"]
    assert item_a.json()["enrich_status"] == "pending"

    # Verify /api/auth/me, /api/tags, /api/reminders
    me_a = client.get("/api/auth/me", headers=headers_a)
    assert me_a.status_code == 200
    assert me_a.json()["profile"]["display_name"] == "Alice"

    tags_a = client.get("/api/tags", headers=headers_a)
    assert tags_a.status_code == 200
    assert {t["name"] for t in tags_a.json()["tags"]} == {"fastapi", "backend"}

    rems_a = client.get("/api/reminders", headers=headers_a)
    assert rems_a.status_code == 200
    assert len(rems_a.json()["reminders"]) == 1

    # 3. Simulate server reload (reset singleton while keeping same JSON file)
    reset_local_dev_db()
    assert isolated_local_db.exists()

    login_a_after_reload = client.post(
        "/api/auth/login",
        json={"email": "alice.local@example.com", "password": "Password123!"},
    )
    assert login_a_after_reload.status_code == 200
    items_after_reload = client.get(
        "/api/items",
        headers={"Authorization": f"Bearer {login_a_after_reload.json()['access_token']}"},
    )
    assert items_after_reload.status_code == 200
    assert len(items_after_reload.json()["items"]) == 1
    assert items_after_reload.json()["items"][0]["id"] == item_a_id

    # 4. Register User B and assert private isolation + shared invite collaboration
    reg_b = client.post(
        "/api/auth/register",
        json={"email": f"bob-{uuid.uuid4().hex[:6]}@example.com", "password": "Password123!"},
    )
    assert reg_b.status_code == 201
    headers_b = {"Authorization": f"Bearer {reg_b.json()['access_token']}"}

    assert client.get("/api/items", headers=headers_b).json()["items"] == []
    assert client.get(f"/api/items/{item_a_id}", headers=headers_b).status_code == 403
    assert client.get("/api/folders", headers=headers_b).json()["folders"] == []

    # Invite User B into Folder A
    invite_res = client.post(
        f"/api/folders/{folder_a_id}/invites",
        headers=headers_a,
        json={"role": "editor"},
    )
    assert invite_res.status_code == 201
    invite_token = invite_res.json()["token"]

    accept_res = client.post(f"/api/invites/{invite_token}/accept", headers=headers_b)
    assert accept_res.status_code == 200
    assert accept_res.json()["folder_id"] == folder_a_id

    assert client.get(f"/api/items/{item_a_id}", headers=headers_b).status_code == 200
    # Reminders stay private even inside a shared folder
    assert client.get("/api/reminders", headers=headers_b).json()["reminders"] == []


def test_local_dev_schedules_background_enrichment(
    isolated_local_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("DISABLE_LOCAL_BG_ENRICH", "false")
    client = TestClient(app)

    login = client.post(
        "/api/auth/login",
        json={"email": "may@example.com", "password": "password123"},
    )
    token = login.json()["access_token"]

    with patch("Unfurl.service.enrich_item", new=AsyncMock(return_value={"enrich_status": "done"})) as mock_enrich:
        res = client.post(
            "/api/items",
            headers={"Authorization": f"Bearer {token}"},
            json={"url": "https://example.org/bg-enrich-check"},
        )
        assert res.status_code == 201
        assert res.json()["enrich_status"] == "pending"
        mock_enrich.assert_awaited_once_with(get_local_dev_db(), res.json()["id"])
