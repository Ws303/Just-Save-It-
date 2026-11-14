"""Tests for Supabase Asymmetric JWKS JWT verification and protected API routes."""

from datetime import datetime, timedelta, timezone
import json
import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
import jwt
from jwt.algorithms import ECAlgorithm
import pytest

from Database.client import set_override_supabase_client
from Login import auth_dep
from main import app
from tests.test_db_and_auth import InMemoryDB

client = TestClient(app)


@pytest.fixture(autouse=True)
def isolated_db():
    db = InMemoryDB()
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


def _generate_es256_jwk_pair():
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_jwk_dict = json.loads(ECAlgorithm.to_jwk(private_key.public_key()))
    public_jwk_dict["kid"] = "test-es256-kid-1"
    public_jwk_dict["alg"] = "ES256"
    public_jwk_dict["use"] = "sig"
    return private_key, jwt.PyJWK(public_jwk_dict)


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("GET", "/api/auth/me", None),
        ("PATCH", "/api/auth/me", {"display_name": "Hacker"}),
        ("POST", "/api/auth/logout", None),
        ("GET", "/api/auth/tokens", None),
        ("GET", "/api/items", None),
        ("POST", "/api/items", {"url": "https://example.com"}),
        ("GET", "/api/folders", None),
        ("POST", "/api/folders", {"name": "Blocked"}),
        ("GET", "/api/tags", None),
        ("GET", "/api/export", None),
        ("GET", "/api/reminders", None),
        ("POST", "/api/preview", {"url": "https://example.com"}),
        ("POST", "/api/ai/summarize", {"item_id": "22222222-2222-4222-8222-222222222001"}),
    ],
)
def test_all_protected_routes_require_auth(method: str, path: str, payload):
    """All protected endpoints must reject unauthenticated requests with 401."""
    resp = client.request(method, path, json=payload)
    assert resp.status_code == 401
    assert "www-authenticate" in {k.lower(): v for k, v in resp.headers.items()}


def test_asymmetric_es256_jwks_verification_and_me_claims(monkeypatch):
    """FastAPI must verify Supabase ES256 tokens via JWKS and expose JWT claims on /api/auth/me."""
    supabase_url = "https://qztscahszlgahsptycvc.supabase.co"
    monkeypatch.setenv("SUPABASE_URL", supabase_url)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "your_supabase_service_role_key_here")

    private_key, signing_jwk = _generate_es256_jwk_pair()

    class FakeJWKClient:
        def get_signing_key_from_jwt(self, _token: str):
            return signing_jwk

    monkeypatch.setattr(auth_dep, "_get_jwk_client", lambda url: FakeJWKClient())

    user_a_id = str(uuid.uuid4())
    user_b_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    def sign_supabase_jwt(sub: str, email: str, name: str, *, role="authenticated", iss=None, aud="authenticated", exp_delta_min=30):
        payload = {
            "iss": iss or f"{supabase_url}/auth/v1",
            "sub": sub,
            "aud": aud,
            "exp": int((now + timedelta(minutes=exp_delta_min)).timestamp()),
            "iat": int(now.timestamp()),
            "email": email,
            "role": role,
            "user_metadata": {"display_name": name},
        }
        return jwt.encode(
            payload,
            private_key,
            algorithm="ES256",
            headers={"kid": "test-es256-kid-1"},
        )

    token_a = sign_supabase_jwt(user_a_id, "alice@supabase.test", "Alice Cloud")
    token_b = sign_supabase_jwt(user_b_id, "bob@supabase.test", "Bob Cloud")

    # 1. User A accesses /api/auth/me and gets JWT email + metadata even if profile row absent
    me_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_a}"})
    assert me_resp.status_code == 200
    me_data = me_resp.json()
    assert me_data["id"] == user_a_id
    assert me_data["email"] == "alice@supabase.test"
    assert me_data["display_name"] == "Alice Cloud"
    assert me_data["role"] == "authenticated"

    # 2. User A saves an item; User B cannot see or access User A's item
    create_resp = client.post(
        "/api/items",
        json={"url": "https://supabase.com/docs/guides/auth", "title": "Supabase Auth Docs"},
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert create_resp.status_code == 201
    item_id = create_resp.json()["id"]

    list_a = client.get("/api/items", headers={"Authorization": f"Bearer {token_a}"})
    list_b = client.get("/api/items", headers={"Authorization": f"Bearer {token_b}"})
    assert len(list_a.json()["items"]) == 1
    assert list_b.json()["items"] == []

    get_b = client.get(f"/api/items/{item_id}", headers={"Authorization": f"Bearer {token_b}"})
    assert get_b.status_code in (403, 404)

    # 3. Security checks: reject expired token, wrong issuer, wrong audience, anon role, alg=none
    expired_token = sign_supabase_jwt(user_a_id, "alice@supabase.test", "Alice", exp_delta_min=-5)
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"}).status_code == 401

    wrong_iss_token = sign_supabase_jwt(user_a_id, "alice@supabase.test", "Alice", iss="https://evil.example.com/auth/v1")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {wrong_iss_token}"}).status_code == 401

    wrong_aud_token = sign_supabase_jwt(user_a_id, "alice@supabase.test", "Alice", aud="other-app")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {wrong_aud_token}"}).status_code == 401

    anon_role_token = sign_supabase_jwt(user_a_id, "alice@supabase.test", "Alice", role="anon")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {anon_role_token}"}).status_code == 401

    alg_none_token = jwt.encode(
        {"sub": user_a_id, "aud": "authenticated", "exp": int((now + timedelta(minutes=30)).timestamp())},
        "",
        algorithm="none",
    )
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {alg_none_token}"}).status_code == 401
