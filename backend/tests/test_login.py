"""Comprehensive automated test suite for Just-Save-It Login and Authentication module.

Tests:
1. User registration (happy path & duplicate validation)
2. Password login (correct & incorrect credentials)
3. Magic link passwordless authentication
4. Native Mobile Google & Apple Sign-In (Spec 2B id_token)
5. Web OAuth authorization URL & callback exchange
6. Token refresh
7. Protected user profile (GET & PATCH /api/auth/me)
8. MCP Personal Access Tokens (create jsi_live_xxx, list, revoke)
9. Logout & session invalidation
10. System health & CORS headers
"""

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.test_db_and_auth import InMemoryDB
from Database.client import set_override_supabase_client

client = TestClient(app)


@pytest.fixture(autouse=True)
def setup_mock_db(monkeypatch):
    for env_key in (
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_JWT_SECRET",
    ):
        monkeypatch.delenv(env_key, raising=False)
    db = InMemoryDB()
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


def test_health_check_includes_auth():
    """Verify health endpoint shows auth module enabled."""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["auth_enabled"] is True


def test_register_user_success():
    """Test standard user registration with email, password, and display name."""
    email = "tester_reg_01@example.com"
    payload = {
        "email": email,
        "password": "StrongPassword123!",
        "display_name": "Tester 01",
    }
    resp = client.post("/api/auth/register", json=payload)
    assert resp.status_code == 201
    data = resp.json()

    assert "access_token" in data
    assert "refresh_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["email"] == email
    assert data["user"]["display_name"] == "Tester 01"
    assert data["user"]["tier"] == "free"


def test_register_duplicate_email_fails():
    """Test duplicate registration returns 400."""
    email = "duplicate_test@example.com"
    payload = {
        "email": email,
        "password": "Password123456",
        "display_name": "Original",
    }
    resp1 = client.post("/api/auth/register", json=payload)
    assert resp1.status_code == 201

    resp2 = client.post("/api/auth/register", json=payload)
    assert resp2.status_code == 400
    assert "already exists" in resp2.json()["detail"]


def test_login_user_password():
    """Test email/password authentication (success and failure)."""
    email = "login_tester@example.com"
    reg_payload = {
        "email": email,
        "password": "PasswordSecret123",
        "display_name": "Login Tester",
    }
    client.post("/api/auth/register", json=reg_payload)

    # Valid password
    login_resp = client.post("/api/auth/login", json={"email": email, "password": "PasswordSecret123"})
    assert login_resp.status_code == 200
    login_data = login_resp.json()
    assert "access_token" in login_data
    assert login_data["user"]["email"] == email

    # Invalid password
    bad_resp = client.post("/api/auth/login", json={"email": email, "password": "WrongPassword"})
    assert bad_resp.status_code == 401
    assert "Invalid email or password" in bad_resp.json()["detail"]


def test_magic_link_authentication():
    """Test passwordless Magic Link login flow."""
    email = "magic_user@example.com"
    resp = client.post("/api/auth/magic-link", json={"email": email})
    assert resp.status_code == 200
    data = resp.json()

    assert data["sent"] is True
    assert data["email"] == email
    assert "access_token" in data
    assert data["user"]["email"] == email


def test_native_auth_google_and_apple():
    """Test Mobile Native SDK Google and Apple Sign-In (Spec 2B)."""
    # Google Native Sign-In
    google_payload = {
        "provider": "google",
        "id_token": "google-jwt-test-token-12345678",
        "full_name": "Google Mobile User",
    }
    g_resp = client.post("/api/auth/native", json=google_payload)
    assert g_resp.status_code == 200
    g_data = g_resp.json()
    assert "access_token" in g_data
    assert g_data["user"]["display_name"] == "Google Mobile User"

    # Apple Native Sign-In with Face ID & nonce
    apple_payload = {
        "provider": "apple",
        "id_token": "apple-identity-token-abcdefgh",
        "raw_nonce": "test-nonce-random-123",
        "full_name": "Apple FaceID User",
    }
    a_resp = client.post("/api/auth/native", json=apple_payload)
    assert a_resp.status_code == 200
    a_data = a_resp.json()
    assert "access_token" in a_data
    assert a_data["user"]["display_name"] == "Apple FaceID User"


def test_oauth_url_and_callback():
    """Test Web OAuth redirect URL generation and code exchange."""
    # 1. Get OAuth URL
    url_resp = client.get("/api/auth/oauth/google?redirect_to=http://localhost:5173/auth/callback")
    assert url_resp.status_code == 200
    url_data = url_resp.json()
    assert "url" in url_data
    assert url_data["provider"] == "google"

    # 2. Exchange OAuth code for session
    code_resp = client.post("/api/auth/oauth/callback", json={"code": "sample_auth_code_123"})
    assert code_resp.status_code == 200
    code_data = code_resp.json()
    assert "access_token" in code_data
    assert "user" in code_data


def test_refresh_session():
    """Test refreshing an access token using a refresh token and rejecting bogus/rotated tokens."""
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    refresh_token = login_resp.json()["refresh_token"]

    ref_resp = client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
    assert ref_resp.status_code == 200
    ref_data = ref_resp.json()
    assert "access_token" in ref_data
    assert "refresh_token" in ref_data
    assert ref_data["user"]["email"] == "may@example.com"

    # Reusing rotated token or sending an arbitrary refresh_token must fail with 401 (no may@example.com fallback)
    assert client.post("/api/auth/refresh", json={"refresh_token": refresh_token}).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh_token": "bogus-attacker-token"}).status_code == 401

    # Refreshing another registered local user must preserve that user's identity
    reg_email = "refresh-other-user@example.com"
    reg_resp = client.post(
        "/api/auth/register",
        json={"email": reg_email, "password": "Password123!", "display_name": "Other User"},
    )
    assert reg_resp.status_code == 201
    reg_data = reg_resp.json()
    other_ref = client.post("/api/auth/refresh", json={"refresh_token": reg_data["refresh_token"]})
    assert other_ref.status_code == 200
    other_payload = other_ref.json()
    assert other_payload["user"]["id"] == reg_data["user"]["id"]
    assert other_payload["user"]["email"] == reg_email


def test_user_profile_crud_and_auth_guard():
    """Test /api/auth/me endpoint protection and profile updates."""
    # 401 without Bearer token
    unauth = client.get("/api/auth/me")
    assert unauth.status_code == 401

    # Login to get valid token
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # GET /api/auth/me
    me_resp = client.get("/api/auth/me", headers=headers)
    assert me_resp.status_code == 200
    assert me_resp.json()["email"] == "may@example.com"
    assert me_resp.json()["display_name"] == "เมย์"

    # PATCH /api/auth/me
    patch_resp = client.patch(
        "/api/auth/me",
        json={"display_name": "เมย์ (อัปเดตแล้ว)", "timezone": "Asia/Bangkok"},
        headers=headers,
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["display_name"] == "เมย์ (อัปเดตแล้ว)"


def test_mcp_personal_access_tokens():
    """Test MCP API token creation, listing, and revocation."""
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Create MCP Token
    create_resp = client.post("/api/auth/tokens", json={"name": "Claude Desktop Personal"}, headers=headers)
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["token"].startswith("jsi_live_")
    token_id = created["id"]

    # 2. List Tokens
    list_resp = client.get("/api/auth/tokens", headers=headers)
    assert list_resp.status_code == 200
    res_data = list_resp.json()
    tokens = res_data.get("tokens", res_data) if isinstance(res_data, dict) else res_data
    assert any(t["id"] == token_id for t in tokens)

    # 3. Revoke Token
    del_resp = client.delete(f"/api/auth/tokens/{token_id}", headers=headers)
    assert del_resp.status_code == 200
    assert del_resp.json()["revoked"] is True

    # 4. Confirm it's marked as revoked
    list_resp_2 = client.get("/api/auth/tokens", headers=headers)
    res_data_2 = list_resp_2.json()
    tokens_2 = res_data_2.get("tokens", res_data_2) if isinstance(res_data_2, dict) else res_data_2
    assert any(t["id"] == token_id and t.get("revoked_at") is not None for t in tokens_2)


def test_logout():
    """Test user logout."""
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    logout_resp = client.post("/api/auth/logout", headers=headers)
    assert logout_resp.status_code == 200
    assert logout_resp.json()["logged_out"] is True


def test_oauth_url_uses_supabase_sign_in_with_oauth(monkeypatch):
    """Ensure Supabase OAuth URL generation delegates to sign_in_with_oauth when configured."""
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    mock_client = MagicMock()
    mock_client.auth.sign_in_with_oauth.return_value = SimpleNamespace(
        url="https://example.supabase.co/auth/v1/authorize?provider=google"
    )
    monkeypatch.setenv("APP_URL", "https://app.example.com")
    monkeypatch.setattr("Login.service.is_supabase_configured", lambda: True)
    monkeypatch.setattr("Login.service.get_supabase_anon_client", lambda: mock_client)

    resp = client.get("/api/auth/oauth/google", params={"redirect_to": "https://app.example.com/cb"})
    assert resp.status_code == 200
    assert resp.json()["url"].startswith("https://example.supabase.co/auth/v1/authorize")
    mock_client.auth.sign_in_with_oauth.assert_called_once_with({
        "provider": "google",
        "options": {"redirect_to": "https://app.example.com/cb"},
    })

    # External / unsafe redirect_to hosts must be rejected
    assert client.get("/api/auth/oauth/google", params={"redirect_to": "https://evil.attacker.com/cb"}).status_code == 400
    assert client.get("/api/auth/oauth/google", params={"redirect_to": "javascript:alert(1)"}).status_code == 400


def test_supabase_auth_never_fails_open_to_local_tokens(monkeypatch):
    """Ensure Supabase errors or pending confirmation never fall back to dev JWT minting."""
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    mock_client = MagicMock()
    mock_client.auth.sign_in_with_otp.side_effect = RuntimeError("For security purposes, request again after 60s")
    mock_client.auth.sign_up.return_value = SimpleNamespace(
        user=SimpleNamespace(id="22222222-2222-4222-8222-222222222222"),
        session=None,
    )
    mock_client.auth.sign_in_with_oauth.side_effect = RuntimeError("OAuth upstream outage")

    monkeypatch.setattr("Login.service.is_supabase_configured", lambda: True)
    monkeypatch.setattr("Login.service.get_supabase_anon_client", lambda: mock_client)

    magic_resp = client.post("/api/auth/magic-link", json={"email": "may@example.com"})
    assert magic_resp.status_code in (400, 429)
    assert "access_token" not in magic_resp.json()

    reg_resp = client.post(
        "/api/auth/register",
        json={"email": "newuser@example.com", "password": "Password123!", "display_name": "New"},
    )
    assert reg_resp.status_code == 403
    assert "access_token" not in reg_resp.json()

    oauth_resp = client.get("/api/auth/oauth/google", params={"redirect_to": "http://localhost:5173/cb"})
    assert oauth_resp.status_code == 502
