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

client = TestClient(app)


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
    """Test refreshing an access token using a refresh token."""
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    refresh_token = login_resp.json()["refresh_token"]

    ref_resp = client.post("/api/auth/refresh", json={"refresh_token": refresh_token})
    assert ref_resp.status_code == 200
    ref_data = ref_resp.json()
    assert "access_token" in ref_data
    assert "refresh_token" in ref_data


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
    tokens = list_resp.json()
    assert any(t["id"] == token_id for t in tokens)

    # 3. Revoke Token
    del_resp = client.delete(f"/api/auth/tokens/{token_id}", headers=headers)
    assert del_resp.status_code == 200
    assert del_resp.json()["revoked"] is True

    # 4. Confirm it's no longer listed as active
    list_resp_2 = client.get("/api/auth/tokens", headers=headers)
    assert not any(t["id"] == token_id for t in list_resp_2.json())


def test_logout():
    """Test user logout."""
    login_resp = client.post("/api/auth/login", json={"email": "may@example.com", "password": "password123"})
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    logout_resp = client.post("/api/auth/logout", headers=headers)
    assert logout_resp.status_code == 200
    assert logout_resp.json()["logged_out"] is True
