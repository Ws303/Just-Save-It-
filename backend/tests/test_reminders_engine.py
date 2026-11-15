"""Comprehensive hermetic unit and API tests for Just-Save-It Hybrid Reminders Engine (Part 3).

Validates Acceptance Criteria C6 - C9:
- C6: Reminders REST CRUD, Snooze & Shared-Folder Tenant Isolation
- C7: GET /api/reminders/local-sync DST-Safe Unrolling, <=64 Limit, Overdue Separation & ios_remote_push_active
- C8: POST /cron/reminders Auth, Claim RPC & Fallback, 10-Day Overdue Advance & Completed Item Skip
- C9: Lightweight Push Adapters (Expo, FCM HTTP v1 RS256, Web Push VAPID + RFC 8291 Decrypt),
      local_sync Skip, SSRF Guard & Stale Device Deactivation
"""

import base64
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
import socket
import struct
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import MagicMock
from urllib.parse import parse_qs
import uuid
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi.testclient import TestClient
import httpx
import jwt
import pytest

from Database.client import set_override_supabase_client
from Database.text_hygiene import canonicalize_url, compute_url_hash
import Reminders.unroller as reminders_unroller
from Reminders.push_adapters import (
    FCM_SCOPE,
    FCM_TOKEN_CACHE,
    send_expo_push,
    send_fcm_push,
    send_web_push,
    validate_web_push_endpoint,
)
from Reminders.service import (
    get_ios_local_sync_payload,
    process_due_reminders_cron,
)
from Reminders.unroller import advance_every_n_days_utc, unroll_reminders_for_ios
from main import app

JWT_TEST_SECRET = "super-secret-jwt-key-for-reminders-tests-0123456789"
_REAL_HTTPX_ASYNC_CLIENT = httpx.AsyncClient
_REAL_DATETIME = datetime


# =====================================================================
# Hermetic In-Memory DB, Storage, RPC & Network Helpers
# =====================================================================


class MockStorageBucket:
    def __init__(self, storage: "MockStorage", bucket_name: str):
        self._storage = storage
        self._bucket_name = bucket_name

    def upload(self, path: str, file_bytes: bytes, file_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self._storage.fail_on_upload is not None:
            raise self._storage.fail_on_upload
        self._storage.uploads.append(
            {
                "bucket": self._bucket_name,
                "path": path,
                "data": bytes(file_bytes),
                "options": dict(file_options or {}),
            }
        )
        return {"path": path}

    def get_public_url(self, path: str) -> str:
        return f"https://storage.example.com/storage/v1/object/public/{self._bucket_name}/{path}"


class MockStorage:
    def __init__(self) -> None:
        self.uploads: List[Dict[str, Any]] = []
        self.fail_on_upload: Optional[Exception] = None

    def from_(self, bucket_name: str) -> MockStorageBucket:
        return MockStorageBucket(self, bucket_name)


class TableProxy:
    def __init__(self, data_list: List[Dict[str, Any]]):
        self._data = data_list
        self._filters: Dict[str, Any] = {}
        self._lt_filters: Dict[str, Any] = {}
        self._in_filters: Dict[str, set] = {}
        self._not_null_filters: set = set()
        self._limit: Optional[int] = None
        self._action = "select"

    def select(self, cols="*"):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def lt(self, col, val):
        self._lt_filters[col] = val
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
            is_compound = ("item_id" in new_item and "tag_id" in new_item) or (
                "folder_id" in new_item and "user_id" in new_item
            )
            if "id" not in new_item and "token" not in new_item and not is_compound:
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
        for k, v in self._lt_filters.items():
            cur = item.get(k)
            if cur is None or not (cur < v):
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
            filtered = filtered[: self._limit]
        return MagicMock(data=filtered)


class InMemoryDB:
    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {
            "profiles": [],
            "folders": [],
            "folder_members": [],
            "folder_invites": [],
            "items": [],
            "tags": [],
            "item_tags": [],
            "reminders": [],
            "devices": [],
            "daily_ai_usage": [],
            "api_tokens": [],
        }
        self.storage = MockStorage()

    def table(self, name: str) -> TableProxy:
        return TableProxy(self.tables.setdefault(name, []))


class RpcCapableInMemoryDB(InMemoryDB):
    def __init__(self, rpc_handlers: Optional[Dict[str, Callable[..., List[Dict[str, Any]]]]] = None) -> None:
        super().__init__()
        self._rpc_handlers = dict(rpc_handlers or {})
        self.rpc_calls: List[tuple[str, Dict[str, Any]]] = []

    def rpc(self, fn_name: str, params: Optional[Dict[str, Any]] = None) -> Any:
        call_params = dict(params or {})
        self.rpc_calls.append((fn_name, call_params))
        handler = self._rpc_handlers.get(fn_name)

        class _RpcQuery:
            @staticmethod
            def execute() -> MagicMock:
                data = handler(call_params) if handler is not None else []
                return MagicMock(data=data)

        return _RpcQuery()


class MockHttpRecorder:
    """Deterministic MockTransport controller capturing every outbound AsyncClient request."""

    def __init__(self) -> None:
        self.requests: List[httpx.Request] = []
        self._handler: Callable[[httpx.Request], httpx.Response] = self._default_handler

    @staticmethod
    def _default_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="Not mocked", request=request)

    def set_handler(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self._handler = handler

    def clear_requests(self) -> None:
        self.requests.clear()

    def dispatch(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


def make_jwt(
    user_id: str,
    secret: str = JWT_TEST_SECRET,
    aud: str = "authenticated",
    exp_offset_sec: int = 3600,
) -> str:
    now_ts = int(datetime.now(timezone.utc).timestamp())
    payload = {
        "sub": user_id,
        "aud": aud,
        "exp": now_ts + exp_offset_sec,
        "iat": now_ts,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def make_auth_headers(user_id: str = "usr-rem-1", secret: str = JWT_TEST_SECRET) -> Dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt(user_id, secret=secret)}"}


def _hermetic_getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> List[Any]:
    """Return public IP for non-local hostnames while preserving IP literals and localhost checks."""
    host_str = str(host).strip("[]")
    try:
        ip_obj: Optional[ipaddress._BaseAddress] = ipaddress.ip_address(host_str)
    except ValueError:
        ip_obj = None

    if ip_obj is not None:
        family = socket.AF_INET6 if ip_obj.version == 6 else socket.AF_INET
        sockaddr = (str(ip_obj), 0, 0, 0) if ip_obj.version == 6 else (str(ip_obj), 0)
        return [(family, socket.SOCK_STREAM, 6, "", sockaddr)]

    lowered = host_str.lower()
    if lowered in ("localhost", "localhost.localdomain") or lowered.endswith((".local", ".internal")):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]

    return [(2, 1, 6, "", ("93.184.216.34", 0))]


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _decrypt_rfc8291_aes128gcm(
    encrypted_body: bytes,
    ua_private_key: ec.EllipticCurvePrivateKey,
    auth_secret: bytes,
) -> bytes:
    """Decrypt RFC 8291 + RFC 8188 aes128gcm content-encoded Web Push payload."""
    assert len(encrypted_body) > 21 + 65
    msg_salt = encrypted_body[:16]
    record_size, keyid_len = struct.unpack("!IB", encrypted_body[16:21])
    assert record_size == 4096
    assert keyid_len == 65
    as_pub_raw = encrypted_body[21 : 21 + keyid_len]
    ciphertext = encrypted_body[21 + keyid_len :]

    as_pub_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub_raw)
    ua_pub_raw = ua_private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    shared_secret = ua_private_key.exchange(ec.ECDH(), as_pub_key)

    prk_info = b"WebPush: info\x00" + ua_pub_raw + as_pub_raw
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=auth_secret,
        info=prk_info,
    ).derive(shared_secret)
    cek = HKDF(
        algorithm=hashes.SHA256(),
        length=16,
        salt=msg_salt,
        info=b"Content-Encoding: aes128gcm\x00",
    ).derive(ikm)
    nonce = HKDF(
        algorithm=hashes.SHA256(),
        length=12,
        salt=msg_salt,
        info=b"Content-Encoding: nonce\x00",
    ).derive(ikm)

    padded = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert padded.endswith(b"\x02")
    return padded[:-1]


def _generate_ephemeral_rsa_pem_and_pub() -> tuple[str, Any]:
    priv_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = priv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    return pem, priv_key.public_key()


def _generate_ephemeral_ec_p256() -> tuple[ec.EllipticCurvePrivateKey, str, str]:
    priv_key = ec.generate_private_key(ec.SECP256R1())
    pem = priv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    pub_raw = priv_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return priv_key, pem, _b64url_encode(pub_raw)


def _seed_item(
    db: InMemoryDB,
    *,
    item_id: Optional[str] = None,
    owner_id: str = "usr-rem-1",
    folder_id: Optional[str] = None,
    url: str = "https://example.com/article",
    title: str = "Saved Article",
    status: str = "inbox",
) -> Dict[str, Any]:
    iid = item_id or str(uuid.uuid4())
    row = {
        "id": iid,
        "owner_id": owner_id,
        "folder_id": folder_id,
        "url": url,
        "canonical_url": canonicalize_url(url),
        "url_hash": compute_url_hash(url),
        "title": title,
        "status": status,
        "media_items": [],
        "embed_type": "none",
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    db.tables["items"].append(row)
    return row


def _seed_reminder(
    db: InMemoryDB,
    *,
    rem_id: Optional[str] = None,
    item_id: str,
    user_id: str,
    schedule_type: str = "once",
    remind_at: datetime,
    repeat_every_days: Optional[int] = None,
    remind_time: Optional[str] = None,
    timezone_name: str = "Asia/Bangkok",
    status: str = "pending",
    title_snapshot: Optional[str] = "Saved Article",
) -> Dict[str, Any]:
    rid = rem_id or str(uuid.uuid4())
    row = {
        "id": rid,
        "item_id": item_id,
        "user_id": user_id,
        "schedule_type": schedule_type,
        "remind_at": remind_at.astimezone(timezone.utc).isoformat(),
        "repeat_every_days": repeat_every_days,
        "remind_time": remind_time,
        "timezone": timezone_name,
        "status": status,
        "title_snapshot": title_snapshot,
        "last_triggered_at": None,
        "sent_at": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    db.tables["reminders"].append(row)
    return row


def _seed_device(
    db: InMemoryDB,
    *,
    device_id: Optional[str] = None,
    user_id: str,
    platform: str,
    delivery_mode: str = "remote",
    push_token: Optional[str] = None,
    web_push_sub: Optional[Dict[str, Any]] = None,
    is_active: bool = True,
) -> Dict[str, Any]:
    did = device_id or str(uuid.uuid4())
    row = {
        "id": did,
        "user_id": user_id,
        "platform": platform,
        "delivery_mode": delivery_mode,
        "push_token": push_token,
        "web_push_sub": web_push_sub,
        "is_active": is_active,
        "last_seen": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    db.tables["devices"].append(row)
    return row


@pytest.fixture(autouse=True)
def hermetic_isolation(monkeypatch):
    """Enforce zero network access, clean env vars, FCM cache clear, and DB override reset."""
    FCM_TOKEN_CACHE.clear()
    set_override_supabase_client(None)

    for env_key in (
        "INTERNAL_WEBHOOK_SECRET",
        "WEBHOOK_SECRET",
        "CRON_SHARED_SECRET",
        "ENV",
        "ALLOW_DEV_WEBHOOK_BYPASS",
        "ALLOW_DEV_AUTH_BYPASS",
        "SUPABASE_JWT_SECRET",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "IOS_REMOTE_PUSH_ENABLED",
        "EXPO_ACCESS_TOKEN",
        "FCM_SERVICE_ACCOUNT_JSON",
        "FCM_PROJECT_ID",
        "VAPID_PRIVATE_KEY",
        "VAPID_PUBLIC_KEY",
        "VAPID_SUBJECT",
    ):
        monkeypatch.delenv(env_key, raising=False)

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("ALLOW_DEV_WEBHOOK_BYPASS", "false")
    monkeypatch.setenv("ALLOW_DEV_AUTH_BYPASS", "false")
    monkeypatch.setattr(socket, "getaddrinfo", _hermetic_getaddrinfo)

    recorder = MockHttpRecorder()
    transport = httpx.MockTransport(recorder.dispatch)

    class _PatchedAsyncClient(_REAL_HTTPX_ASYNC_CLIENT):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _PatchedAsyncClient)

    yield recorder

    FCM_TOKEN_CACHE.clear()
    set_override_supabase_client(None)


@pytest.fixture
def mock_db():
    db = InMemoryDB()
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


@pytest.fixture
def test_client(mock_db, monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", JWT_TEST_SECRET)
    with TestClient(app) as client:
        yield client


# =====================================================================
# C6: Reminders REST CRUD, Snooze & Shared-Folder Tenant Isolation
# =====================================================================


def test_c6_upsert_validation_and_status_guards(mock_db, test_client):
    """C6: PUT /api/reminders/{item_id} handles once/every_n_days, 422, 409, 403, and 404."""
    owner_headers = make_auth_headers("usr-owner")
    other_headers = make_auth_headers("usr-other")

    active_item = _seed_item(mock_db, item_id="item-active", owner_id="usr-owner", title="Read FastAPI Docs")
    done_item = _seed_item(mock_db, item_id="item-done", owner_id="usr-owner", status="done")
    archived_item = _seed_item(mock_db, item_id="item-arch", owner_id="usr-owner", status="archived")
    private_item = _seed_item(mock_db, item_id="item-priv", owner_id="usr-owner", title="Secret Link")

    # Unauthenticated calls fail closed with 401
    assert test_client.get("/api/reminders").status_code == 401
    assert (
        test_client.put(
            f"/api/reminders/{active_item['id']}",
            json={"schedule_type": "once", "remind_at": "2030-01-01T10:00:00Z"},
        ).status_code
        == 401
    )

    # Valid 'once' reminder
    once_target = "2030-06-15T09:30:00Z"
    res_once = test_client.put(
        f"/api/reminders/{active_item['id']}",
        json={
            "schedule_type": "once",
            "remind_at": once_target,
            "timezone": "Asia/Bangkok",
            "title_snapshot": "Custom Snapshot",
        },
        headers=owner_headers,
    )
    assert res_once.status_code == 200
    body_once = res_once.json()
    assert body_once["item_id"] == "item-active"
    assert body_once["user_id"] == "usr-owner"
    assert body_once["schedule_type"] == "once"
    assert body_once["repeat_every_days"] is None
    assert body_once["status"] == "pending"
    assert body_once["timezone"] == "Asia/Bangkok"
    assert body_once["title_snapshot"] == "Custom Snapshot"
    assert body_once["item_status"] == "inbox"
    assert body_once["item_url"] == active_item["url"]
    assert body_once["item_title"] == "Read FastAPI Docs"
    assert datetime.fromisoformat(body_once["remind_at"]) == datetime(2030, 6, 15, 9, 30, tzinfo=timezone.utc)

    # Upsert same (item_id, user_id) to 'every_n_days' updates existing row cleanly
    res_rec = test_client.put(
        f"/api/reminders/{active_item['id']}",
        json={
            "schedule_type": "every_n_days",
            "repeat_every_days": 5,
            "remind_time": "09:00",
            "timezone": "America/New_York",
        },
        headers=owner_headers,
    )
    assert res_rec.status_code == 200
    body_rec = res_rec.json()
    assert body_rec["schedule_type"] == "every_n_days"
    assert body_rec["repeat_every_days"] == 5
    assert body_rec["remind_time"] == "09:00:00"
    assert body_rec["timezone"] == "America/New_York"
    assert body_rec["status"] == "pending"
    assert len(mock_db.tables["reminders"]) == 1

    # Invalid IANA timezone -> 422
    bad_tz = test_client.put(
        f"/api/reminders/{active_item['id']}",
        json={
            "schedule_type": "once",
            "remind_at": once_target,
            "timezone": "Mars/Olympus_Mons",
        },
        headers=owner_headers,
    )
    assert bad_tz.status_code == 422

    # Invalid repeat_every_days (0 and 366) and missing required fields -> 422
    for invalid_payload in (
        {"schedule_type": "every_n_days", "repeat_every_days": 0, "remind_time": "09:00"},
        {"schedule_type": "every_n_days", "repeat_every_days": 366, "remind_time": "09:00"},
        {"schedule_type": "every_n_days", "repeat_every_days": 3},
        {"schedule_type": "once", "repeat_every_days": 2, "remind_at": once_target},
        {"schedule_type": "once"},
    ):
        resp_invalid = test_client.put(
            f"/api/reminders/{active_item['id']}",
            json=invalid_payload,
            headers=owner_headers,
        )
        assert resp_invalid.status_code == 422

    # Done & archived items -> 409 Conflict
    assert (
        test_client.put(
            f"/api/reminders/{done_item['id']}",
            json={"schedule_type": "once", "remind_at": once_target},
            headers=owner_headers,
        ).status_code
        == 409
    )
    assert (
        test_client.put(
            f"/api/reminders/{archived_item['id']}",
            json={"schedule_type": "once", "remind_at": once_target},
            headers=owner_headers,
        ).status_code
        == 409
    )

    # Inaccessible item -> 403 Forbidden
    assert (
        test_client.put(
            f"/api/reminders/{private_item['id']}",
            json={"schedule_type": "once", "remind_at": once_target},
            headers=other_headers,
        ).status_code
        == 403
    )

    # Nonexistent item -> 404 Not Found
    assert (
        test_client.put(
            "/api/reminders/nonexistent-item-id",
            json={"schedule_type": "once", "remind_at": once_target},
            headers=owner_headers,
        ).status_code
        == 404
    )


def test_c6_shared_folder_tenant_isolation_list_delete_and_reactivate(mock_db, test_client):
    """C6: Shared-folder reminders are strictly tenant-isolated per user_id."""
    folder_id = "fld-shared-1"
    mock_db.tables["folders"].append(
        {"id": folder_id, "owner_id": "usr-a", "name": "Team Reading", "is_shared": True}
    )
    mock_db.tables["folder_members"].extend(
        [
            {"folder_id": folder_id, "user_id": "usr-b", "role": "editor"},
            {"folder_id": folder_id, "user_id": "usr-c", "role": "viewer"},
            {"folder_id": folder_id, "user_id": "usr-e", "role": "viewer"},
        ]
    )
    shared_item = _seed_item(
        mock_db,
        item_id="item-shared-1",
        owner_id="usr-a",
        folder_id=folder_id,
        title="Shared Architecture Spec",
    )

    headers_a = make_auth_headers("usr-a")
    headers_b = make_auth_headers("usr-b")
    headers_c = make_auth_headers("usr-c")
    headers_d = make_auth_headers("usr-outsider")
    headers_e = make_auth_headers("usr-e")

    # Owner (A), editor (B), and viewer (C) each create independent reminders on the same shared item
    r_a = test_client.put(
        f"/api/reminders/{shared_item['id']}",
        json={"schedule_type": "once", "remind_at": "2030-02-01T10:00:00Z", "title_snapshot": "A reminder"},
        headers=headers_a,
    )
    r_b = test_client.put(
        f"/api/reminders/{shared_item['id']}",
        json={"schedule_type": "every_n_days", "repeat_every_days": 2, "remind_time": "08:30", "title_snapshot": "B reminder"},
        headers=headers_b,
    )
    r_c = test_client.put(
        f"/api/reminders/{shared_item['id']}",
        json={"schedule_type": "once", "remind_at": "2030-02-03T12:00:00Z", "title_snapshot": "C reminder"},
        headers=headers_c,
    )
    assert r_a.status_code == 200
    assert r_b.status_code == 200
    assert r_c.status_code == 200
    assert len(mock_db.tables["reminders"]) == 3

    # Outsider without folder access -> 403
    assert (
        test_client.put(
            f"/api/reminders/{shared_item['id']}",
            json={"schedule_type": "once", "remind_at": "2030-02-04T12:00:00Z"},
            headers=headers_d,
        ).status_code
        == 403
    )

    # GET /api/reminders scopes strictly by user_id
    list_a = test_client.get("/api/reminders", headers=headers_a).json()
    list_b = test_client.get("/api/reminders", headers=headers_b).json()
    list_c = test_client.get("/api/reminders", headers=headers_c).json()
    list_d = test_client.get("/api/reminders", headers=headers_d).json()

    assert list_a["total"] == 1 and [r["user_id"] for r in list_a["reminders"]] == ["usr-a"]
    assert list_b["total"] == 1 and [r["user_id"] for r in list_b["reminders"]] == ["usr-b"]
    assert list_c["total"] == 1 and [r["user_id"] for r in list_c["reminders"]] == ["usr-c"]
    assert list_d["total"] == 0 and list_d["reminders"] == []

    # User E has folder access but no reminder row -> DELETE returns 404
    assert test_client.delete(f"/api/reminders/{shared_item['id']}", headers=headers_e).status_code == 404

    # User B deletes -> cancels ONLY User B's reminder; A and C remain pending
    del_b = test_client.delete(f"/api/reminders/{shared_item['id']}", headers=headers_b)
    assert del_b.status_code == 200
    assert del_b.json()["deleted"] is True
    assert del_b.json()["status"] == "cancelled"

    assert test_client.get("/api/reminders", headers=headers_b).json()["total"] == 0
    b_cancelled = test_client.get("/api/reminders?include_cancelled=true", headers=headers_b).json()
    assert b_cancelled["total"] == 1
    assert b_cancelled["reminders"][0]["status"] == "cancelled"

    list_a_after = test_client.get("/api/reminders", headers=headers_a).json()
    list_c_after = test_client.get("/api/reminders", headers=headers_c).json()
    assert list_a_after["total"] == 1 and list_a_after["reminders"][0]["status"] == "pending"
    assert list_c_after["total"] == 1 and list_c_after["reminders"][0]["status"] == "pending"

    # Re-activating User B's reminder via PUT after DELETE restores status='pending' on the same rule
    reactivate_b = test_client.put(
        f"/api/reminders/{shared_item['id']}",
        json={"schedule_type": "once", "remind_at": "2030-03-01T09:00:00Z", "title_snapshot": "B reactivated"},
        headers=headers_b,
    )
    assert reactivate_b.status_code == 200
    assert reactivate_b.json()["status"] == "pending"
    assert reactivate_b.json()["schedule_type"] == "once"
    assert reactivate_b.json()["title_snapshot"] == "B reactivated"
    assert test_client.get("/api/reminders", headers=headers_b).json()["total"] == 1
    assert len(mock_db.tables["reminders"]) == 3


def test_c6_snooze_variants_and_rejections(mock_db, test_client):
    """C6: POST /api/reminders/{item_id}/snooze supports empty body, minutes, hours, explicit remind_at, 422, 409, 404, 403."""
    headers = make_auth_headers("usr-snooze")
    other_headers = make_auth_headers("usr-intruder")

    item = _seed_item(mock_db, item_id="item-snz-1", owner_id="usr-snooze")
    _seed_reminder(
        mock_db,
        rem_id="rem-snz-1",
        item_id=item["id"],
        user_id="usr-snooze",
        remind_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    # 1. Default empty body (no payload) -> +60 minutes
    before_empty = datetime.now(timezone.utc)
    res_no_body = test_client.post(f"/api/reminders/{item['id']}/snooze", headers=headers)
    after_empty = datetime.now(timezone.utc)
    assert res_no_body.status_code == 200
    dt_no_body = datetime.fromisoformat(res_no_body.json()["remind_at"])
    assert (
        before_empty + timedelta(minutes=60) - timedelta(seconds=2)
        <= dt_no_body
        <= after_empty + timedelta(minutes=60) + timedelta(seconds=2)
    )

    # 2. Explicit empty JSON {} -> +60 minutes
    before_json_empty = datetime.now(timezone.utc)
    res_json_empty = test_client.post(f"/api/reminders/{item['id']}/snooze", json={}, headers=headers)
    after_json_empty = datetime.now(timezone.utc)
    assert res_json_empty.status_code == 200
    dt_json_empty = datetime.fromisoformat(res_json_empty.json()["remind_at"])
    assert (
        before_json_empty + timedelta(minutes=60) - timedelta(seconds=2)
        <= dt_json_empty
        <= after_json_empty + timedelta(minutes=60) + timedelta(seconds=2)
    )

    # 3. Relative minutes
    before_min = datetime.now(timezone.utc)
    res_min = test_client.post(f"/api/reminders/{item['id']}/snooze", json={"minutes": 25}, headers=headers)
    after_min = datetime.now(timezone.utc)
    assert res_min.status_code == 200
    dt_min = datetime.fromisoformat(res_min.json()["remind_at"])
    assert (
        before_min + timedelta(minutes=25) - timedelta(seconds=2)
        <= dt_min
        <= after_min + timedelta(minutes=25) + timedelta(seconds=2)
    )

    # 4. Relative hours
    before_hr = datetime.now(timezone.utc)
    res_hr = test_client.post(f"/api/reminders/{item['id']}/snooze", json={"hours": 3}, headers=headers)
    after_hr = datetime.now(timezone.utc)
    assert res_hr.status_code == 200
    dt_hr = datetime.fromisoformat(res_hr.json()["remind_at"])
    assert (
        before_hr + timedelta(hours=3) - timedelta(seconds=2)
        <= dt_hr
        <= after_hr + timedelta(hours=3) + timedelta(seconds=2)
    )

    # 5. Explicit future remind_at
    explicit_target = "2035-08-15T14:00:00Z"
    res_exp = test_client.post(
        f"/api/reminders/{item['id']}/snooze",
        json={"remind_at": explicit_target},
        headers=headers,
    )
    assert res_exp.status_code == 200
    assert datetime.fromisoformat(res_exp.json()["remind_at"]) == datetime(2035, 8, 15, 14, 0, tzinfo=timezone.utc)

    # 6. Past remind_at -> 422; mixing remind_at with minutes -> 422
    assert (
        test_client.post(
            f"/api/reminders/{item['id']}/snooze",
            json={"remind_at": "2020-01-01T00:00:00Z"},
            headers=headers,
        ).status_code
        == 422
    )
    assert (
        test_client.post(
            f"/api/reminders/{item['id']}/snooze",
            json={"minutes": 10, "remind_at": explicit_target},
            headers=headers,
        ).status_code
        == 422
    )

    # 7. Access / missing checks
    assert test_client.post(f"/api/reminders/{item['id']}/snooze", json={"minutes": 10}, headers=other_headers).status_code == 403
    assert test_client.post("/api/reminders/missing-item/snooze", json={"minutes": 10}, headers=headers).status_code == 404

    no_rem_item = _seed_item(mock_db, item_id="item-no-rem", owner_id="usr-snooze")
    assert test_client.post(f"/api/reminders/{no_rem_item['id']}/snooze", json={"minutes": 10}, headers=headers).status_code == 404

    # 8. Cancelled reminder -> 409
    assert test_client.delete(f"/api/reminders/{item['id']}", headers=headers).status_code == 200
    assert (
        test_client.post(f"/api/reminders/{item['id']}/snooze", json={"minutes": 10}, headers=headers).status_code
        == 409
    )

    # 9. Done & archived items -> 409
    done_item = _seed_item(mock_db, item_id="item-snz-done", owner_id="usr-snooze", status="done")
    _seed_reminder(
        mock_db,
        item_id=done_item["id"],
        user_id="usr-snooze",
        remind_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert (
        test_client.post(f"/api/reminders/{done_item['id']}/snooze", json={"minutes": 15}, headers=headers).status_code
        == 409
    )

    arch_item = _seed_item(mock_db, item_id="item-snz-arch", owner_id="usr-snooze", status="archived")
    _seed_reminder(
        mock_db,
        item_id=arch_item["id"],
        user_id="usr-snooze",
        remind_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert (
        test_client.post(f"/api/reminders/{arch_item['id']}/snooze", json={"minutes": 15}, headers=headers).status_code
        == 409
    )


# =====================================================================
# C7: GET /api/reminders/local-sync (Unrolling, DST, 64 Limit, Overdue, Flag)
# =====================================================================


def test_c7_local_sync_64_cap_sorted_overdue_separation_and_skips(mock_db, test_client):
    """C7: >64 active reminders cap strictly at 64, preserve sort order, separate overdue, and skip done/archived/cancelled."""
    user_id = "usr-sync-1"
    headers = make_auth_headers(user_id)
    now_ref = datetime.now(timezone.utc)

    # 65 future 'once' reminders + 10 future 'every_n_days' reminders (75 future rules)
    for idx in range(65):
        item = _seed_item(mock_db, item_id=f"item-fut-once-{idx:03d}", owner_id=user_id, title=f"Future Once {idx}")
        _seed_reminder(
            mock_db,
            rem_id=f"rem-fut-once-{idx:03d}",
            item_id=item["id"],
            user_id=user_id,
            schedule_type="once",
            remind_at=now_ref + timedelta(hours=65 - idx),  # deliberately inserted out of chronological order
            title_snapshot=f"Future Once {idx}",
        )

    for idx in range(10):
        item = _seed_item(mock_db, item_id=f"item-fut-rec-{idx:03d}", owner_id=user_id, title=f"Future Rec {idx}")
        _seed_reminder(
            mock_db,
            rem_id=f"rem-fut-rec-{idx:03d}",
            item_id=item["id"],
            user_id=user_id,
            schedule_type="every_n_days",
            remind_at=now_ref + timedelta(days=2, hours=idx),
            repeat_every_days=3,
            remind_time="09:00:00",
            timezone_name="Asia/Bangkok",
            title_snapshot=f"Future Rec {idx}",
        )

    # 3 overdue 'once' reminders + 1 overdue 'every_n_days' reminder
    for idx in range(3):
        item = _seed_item(mock_db, item_id=f"item-ovd-once-{idx}", owner_id=user_id, title=f"Overdue Once {idx}")
        _seed_reminder(
            mock_db,
            rem_id=f"rem-ovd-once-{idx}",
            item_id=item["id"],
            user_id=user_id,
            schedule_type="once",
            remind_at=now_ref - timedelta(hours=idx + 1),
            title_snapshot=f"Overdue Once {idx}",
        )

    ovd_rec_item = _seed_item(mock_db, item_id="item-ovd-rec", owner_id=user_id, title="Overdue Recurring")
    _seed_reminder(
        mock_db,
        rem_id="rem-ovd-rec",
        item_id=ovd_rec_item["id"],
        user_id=user_id,
        schedule_type="every_n_days",
        remind_at=now_ref - timedelta(hours=5),
        repeat_every_days=2,
        remind_time="10:00:00",
        timezone_name="Asia/Bangkok",
        title_snapshot="Overdue Recurring",
    )

    # Items/reminders that MUST be skipped completely
    done_item = _seed_item(mock_db, item_id="item-skip-done", owner_id=user_id, status="done")
    _seed_reminder(mock_db, item_id=done_item["id"], user_id=user_id, remind_at=now_ref + timedelta(minutes=10))

    arch_item = _seed_item(mock_db, item_id="item-skip-arch", owner_id=user_id, status="archived")
    _seed_reminder(mock_db, item_id=arch_item["id"], user_id=user_id, remind_at=now_ref + timedelta(minutes=11))

    canc_item = _seed_item(mock_db, item_id="item-skip-canc", owner_id=user_id)
    _seed_reminder(
        mock_db, item_id=canc_item["id"], user_id=user_id, status="cancelled", remind_at=now_ref + timedelta(minutes=12)
    )

    sent_item = _seed_item(mock_db, item_id="item-skip-sent", owner_id=user_id)
    _seed_reminder(
        mock_db, item_id=sent_item["id"], user_id=user_id, status="sent", remind_at=now_ref + timedelta(minutes=13)
    )

    resp = test_client.get("/api/reminders/local-sync", headers=headers)
    assert resp.status_code == 200
    payload = resp.json()

    assert payload["ios_remote_push_active"] is False
    assert payload["max_slots"] == 64
    assert payload["total_active_rules"] == 79
    assert payload["truncated"] is True
    assert len(payload["notifications"]) == 64

    # Verify strict ascending chronological sort and zero overdue leakage into notifications
    occ_times = [datetime.fromisoformat(n["occurrence_at"]) for n in payload["notifications"]]
    assert occ_times == sorted(occ_times)
    assert all(n["is_overdue"] is False for n in payload["notifications"])
    assert all(t > now_ref for t in occ_times)

    # Verify overdue items are separated without consuming the 64 future slots
    overdue = payload["overdue"]
    assert len(overdue) == 4
    assert all(o["is_overdue"] is True for o in overdue)
    ovd_times = [datetime.fromisoformat(o["occurrence_at"]) for o in overdue]
    assert ovd_times == sorted(ovd_times)
    overdue_once_ids = {f"item-ovd-once-{i}" for i in range(3)}
    notif_item_ids = {n["item_id"] for n in payload["notifications"]}
    assert overdue_once_ids.isdisjoint(notif_item_ids)

    # Verify done / archived / cancelled / sent items are absent everywhere
    skipped_ids = {"item-skip-done", "item-skip-arch", "item-skip-canc", "item-skip-sent"}
    all_returned_ids = notif_item_ids | {o["item_id"] for o in overdue}
    assert skipped_ids.isdisjoint(all_returned_ids)


def test_c7_dst_transitions_new_york_and_bangkok(mock_db, test_client, monkeypatch):
    """C7: America/New_York spring-forward (2026-03-08) & fall-back (2026-11-01) plus Asia/Bangkok preserve local HH:MM."""
    user_id = "usr-dst"
    headers = make_auth_headers(user_id)
    ny_tz = ZoneInfo("America/New_York")
    bkk_tz = ZoneInfo("Asia/Bangkok")

    # --- 1. Spring-forward: 2026-03-08 (EST UTC-5 -> EDT UTC-4) ---
    spring_item = _seed_item(mock_db, item_id="item-dst-spring", owner_id=user_id, title="NY Spring")
    spring_rem = _seed_reminder(
        mock_db,
        rem_id="rem-dst-spring",
        item_id=spring_item["id"],
        user_id=user_id,
        schedule_type="every_n_days",
        remind_at=datetime(2026, 3, 7, 14, 0, tzinfo=timezone.utc),  # 2026-03-07 09:00 EST
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="America/New_York",
        title_snapshot="NY Spring",
    )
    bkk_spring_item = _seed_item(mock_db, item_id="item-bkk-spring", owner_id=user_id, title="BKK Spring")
    _seed_reminder(
        mock_db,
        rem_id="rem-bkk-spring",
        item_id=bkk_spring_item["id"],
        user_id=user_id,
        schedule_type="every_n_days",
        remind_at=datetime(2026, 3, 7, 2, 0, tzinfo=timezone.utc),  # 2026-03-07 09:00 +07:00
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="Asia/Bangkok",
        title_snapshot="BKK Spring",
    )

    spring_now = datetime(2026, 3, 7, 1, 0, tzinfo=timezone.utc)

    class _SpringDateTime(_REAL_DATETIME):
        @classmethod
        def now(cls, tz=None):
            return spring_now if tz is None else spring_now.astimezone(tz)

    monkeypatch.setattr(reminders_unroller, "datetime", _SpringDateTime)
    spring_http = test_client.get("/api/reminders/local-sync?lookahead_per_rule=4", headers=headers)
    assert spring_http.status_code == 200
    spring_data = spring_http.json()

    ny_spring_occs = [
        datetime.fromisoformat(n["occurrence_at"])
        for n in spring_data["notifications"]
        if n["item_id"] == "item-dst-spring"
    ]
    assert ny_spring_occs == [
        datetime(2026, 3, 7, 14, 0, tzinfo=timezone.utc),  # 09:00 EST (-05:00)
        datetime(2026, 3, 8, 13, 0, tzinfo=timezone.utc),  # 09:00 EDT (-04:00)
        datetime(2026, 3, 9, 13, 0, tzinfo=timezone.utc),  # 09:00 EDT (-04:00)
        datetime(2026, 3, 10, 13, 0, tzinfo=timezone.utc),  # 09:00 EDT (-04:00)
    ]
    assert all((dt.astimezone(ny_tz).hour, dt.astimezone(ny_tz).minute) == (9, 0) for dt in ny_spring_occs)

    bkk_spring_occs = [
        datetime.fromisoformat(n["occurrence_at"])
        for n in spring_data["notifications"]
        if n["item_id"] == "item-bkk-spring"
    ]
    assert bkk_spring_occs == [
        datetime(2026, 3, 7, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 3, 8, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 3, 9, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 3, 10, 2, 0, tzinfo=timezone.utc),
    ]
    assert all((dt.astimezone(bkk_tz).hour, dt.astimezone(bkk_tz).minute) == (9, 0) for dt in bkk_spring_occs)

    # Also verify advance_every_n_days_utc across spring-forward directly
    advanced_spring = advance_every_n_days_utc(
        datetime(2026, 3, 7, 14, 0, tzinfo=timezone.utc),
        1,
        "09:00",
        "America/New_York",
        now_utc=datetime(2026, 3, 7, 14, 1, tzinfo=timezone.utc),
    )
    assert advanced_spring == datetime(2026, 3, 8, 13, 0, tzinfo=timezone.utc)

    # --- 2. Fall-back: 2026-11-01 (EDT UTC-4 -> EST UTC-5) ---
    mock_db.tables["reminders"].clear()
    mock_db.tables["items"].clear()

    fall_item = _seed_item(mock_db, item_id="item-dst-fall", owner_id=user_id, title="NY Fall")
    fall_rem = _seed_reminder(
        mock_db,
        rem_id="rem-dst-fall",
        item_id=fall_item["id"],
        user_id=user_id,
        schedule_type="every_n_days",
        remind_at=datetime(2026, 10, 31, 13, 0, tzinfo=timezone.utc),  # 2026-10-31 09:00 EDT
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="America/New_York",
        title_snapshot="NY Fall",
    )
    bkk_fall_item = _seed_item(mock_db, item_id="item-bkk-fall", owner_id=user_id, title="BKK Fall")
    _seed_reminder(
        mock_db,
        rem_id="rem-bkk-fall",
        item_id=bkk_fall_item["id"],
        user_id=user_id,
        schedule_type="every_n_days",
        remind_at=datetime(2026, 10, 31, 2, 0, tzinfo=timezone.utc),  # 2026-10-31 09:00 +07:00
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="Asia/Bangkok",
        title_snapshot="BKK Fall",
    )

    fall_now = datetime(2026, 10, 31, 1, 0, tzinfo=timezone.utc)
    fall_sync = get_ios_local_sync_payload(mock_db, user_id, now_utc=fall_now, lookahead_per_rule=4)
    ny_fall_occs = [n.occurrence_at for n in fall_sync.notifications if n.item_id == "item-dst-fall"]
    assert ny_fall_occs == [
        datetime(2026, 10, 31, 13, 0, tzinfo=timezone.utc),  # 09:00 EDT (-04:00)
        datetime(2026, 11, 1, 14, 0, tzinfo=timezone.utc),   # 09:00 EST (-05:00)
        datetime(2026, 11, 2, 14, 0, tzinfo=timezone.utc),   # 09:00 EST (-05:00)
        datetime(2026, 11, 3, 14, 0, tzinfo=timezone.utc),   # 09:00 EST (-05:00)
    ]
    assert all((dt.astimezone(ny_tz).hour, dt.astimezone(ny_tz).minute) == (9, 0) for dt in ny_fall_occs)

    bkk_fall_occs = [n.occurrence_at for n in fall_sync.notifications if n.item_id == "item-bkk-fall"]
    assert bkk_fall_occs == [
        datetime(2026, 10, 31, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 11, 1, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 11, 2, 2, 0, tzinfo=timezone.utc),
        datetime(2026, 11, 3, 2, 0, tzinfo=timezone.utc),
    ]
    assert all((dt.astimezone(bkk_tz).hour, dt.astimezone(bkk_tz).minute) == (9, 0) for dt in bkk_fall_occs)

    # Confirm unroll_reminders_for_ios direct helper matches fall-back and spring-forward identically
    direct = unroll_reminders_for_ios(
        [spring_rem],
        {spring_item["id"]: spring_item},
        now_utc=spring_now,
        lookahead_per_rule=2,
    )
    assert [occ.occurrence_at for occ in direct.notifications] == [
        datetime(2026, 3, 7, 14, 0, tzinfo=timezone.utc),
        datetime(2026, 3, 8, 13, 0, tzinfo=timezone.utc),
    ]
    assert fall_rem["id"] == "rem-dst-fall"


def test_c7_ios_remote_push_active_matrix(mock_db, test_client, monkeypatch):
    """C7: ios_remote_push_active=True & notifications=[] ONLY when IOS_REMOTE_PUSH_ENABLED=true AND active ios+remote device exists."""
    user_id = "usr-ios-flag"
    headers = make_auth_headers(user_id)
    now_ref = datetime.now(timezone.utc)

    for idx in range(2):
        it = _seed_item(mock_db, item_id=f"item-ios-fut-{idx}", owner_id=user_id)
        _seed_reminder(mock_db, item_id=it["id"], user_id=user_id, remind_at=now_ref + timedelta(hours=idx + 1))
    ovd_it = _seed_item(mock_db, item_id="item-ios-ovd", owner_id=user_id)
    _seed_reminder(mock_db, item_id=ovd_it["id"], user_id=user_id, remind_at=now_ref - timedelta(minutes=30))

    # Case 1: Flag true, but user only has ios local_sync, android remote, and inactive ios remote -> False
    monkeypatch.setenv("IOS_REMOTE_PUSH_ENABLED", "true")
    _seed_device(mock_db, user_id=user_id, platform="ios", delivery_mode="local_sync", is_active=True)
    _seed_device(
        mock_db,
        user_id=user_id,
        platform="android",
        delivery_mode="remote",
        push_token="ExponentPushToken[android-1]",
        is_active=True,
    )
    _seed_device(
        mock_db,
        user_id=user_id,
        platform="ios",
        delivery_mode="remote",
        push_token="ExponentPushToken[ios-inactive]",
        is_active=False,
    )
    r1 = test_client.get("/api/reminders/local-sync", headers=headers).json()
    assert r1["ios_remote_push_active"] is False
    assert len(r1["notifications"]) == 2
    assert len(r1["overdue"]) == 1

    # Case 2: Active ios+remote device exists, but IOS_REMOTE_PUSH_ENABLED="false" -> False
    ios_remote_dev = _seed_device(
        mock_db,
        user_id=user_id,
        platform="ios",
        delivery_mode="remote",
        push_token="ExponentPushToken[ios-active]",
        is_active=True,
    )
    monkeypatch.setenv("IOS_REMOTE_PUSH_ENABLED", "false")
    r2 = test_client.get("/api/reminders/local-sync", headers=headers).json()
    assert r2["ios_remote_push_active"] is False
    assert len(r2["notifications"]) == 2
    assert len(r2["overdue"]) == 1

    # Case 3: Both IOS_REMOTE_PUSH_ENABLED="true" AND active ios+remote device exists -> True, notifications=[], overdue preserved
    monkeypatch.setenv("IOS_REMOTE_PUSH_ENABLED", "true")
    r3 = test_client.get("/api/reminders/local-sync", headers=headers).json()
    assert ios_remote_dev["is_active"] is True
    assert r3["ios_remote_push_active"] is True
    assert r3["notifications"] == []
    assert r3["truncated"] is False
    assert r3["total_active_rules"] == 3
    assert len(r3["overdue"]) == 1
    assert r3["overdue"][0]["item_id"] == "item-ios-ovd"
    assert r3["overdue"][0]["is_overdue"] is True


# =====================================================================
# C8: POST /cron/reminders Auth, Claim RPC & Fallback, 10-Day Advance, Skip Completed
# =====================================================================


def test_c8_cron_reminders_secret_guard_and_empty_body(mock_db, test_client, monkeypatch):
    """C8: POST /cron/reminders enforces 503 unconfigured, 401 missing/invalid, and 200 with empty/no body."""
    # 503 fail-closed when no secret configured
    assert test_client.post("/cron/reminders").status_code == 503

    monkeypatch.setenv("CRON_SHARED_SECRET", "cron-secret-c8-xyz")

    # 401 missing or invalid secret
    assert test_client.post("/cron/reminders").status_code == 401
    assert test_client.post("/cron/reminders", headers={"X-Cron-Secret": "wrong-secret"}).status_code == 401

    res_no_body = test_client.post("/cron/reminders", headers={"X-Cron-Secret": "cron-secret-c8-xyz"})
    assert res_no_body.status_code == 200
    assert res_no_body.json()["claimed"] == 0

    res_empty_json = test_client.post("/cron/reminders", json={}, headers={"X-Cron-Secret": "cron-secret-c8-xyz"})
    assert res_empty_json.status_code == 200
    assert res_empty_json.json()["claimed"] == 0


@pytest.mark.asyncio
async def test_c8_once_sent_10day_overdue_advance_and_completed_skip(hermetic_isolation, mock_db, test_client, monkeypatch):
    """C8: once->sent, 10-day overdue every_n_days claimed once & advances past now preserving ZoneInfo wall time, done/archived skipped."""
    now_ref = datetime(2026, 11, 4, 15, 0, 0, tzinfo=timezone.utc)  # 2026-11-04 10:00 EST (after Nov 1 fall-back)

    it_once = _seed_item(mock_db, item_id="item-c8-once", owner_id="usr-c8", title="Due Once")
    rem_once = _seed_reminder(
        mock_db,
        rem_id="rem-c8-once",
        item_id=it_once["id"],
        user_id="usr-c8",
        schedule_type="once",
        remind_at=now_ref - timedelta(minutes=10),
        title_snapshot="Due Once",
    )

    # 2. 10-day overdue 'every_n_days' crossing 2026-11-01 DST fall-back in America/New_York
    it_rec = _seed_item(mock_db, item_id="item-c8-rec", owner_id="usr-c8", title="10d Overdue Recurring")
    rem_rec = _seed_reminder(
        mock_db,
        rem_id="rem-c8-rec",
        item_id=it_rec["id"],
        user_id="usr-c8",
        schedule_type="every_n_days",
        remind_at=datetime(2026, 10, 25, 13, 0, tzinfo=timezone.utc),  # 2026-10-25 09:00 EDT (-04:00)
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="America/New_York",
        title_snapshot="10d Overdue Recurring",
    )

    # 3. Future 'once' reminder (must remain untouched)
    it_fut = _seed_item(mock_db, item_id="item-c8-fut", owner_id="usr-c8", title="Future Once")
    rem_fut = _seed_reminder(
        mock_db,
        rem_id="rem-c8-fut",
        item_id=it_fut["id"],
        user_id="usr-c8",
        schedule_type="once",
        remind_at=now_ref + timedelta(hours=3),
    )

    # 4 & 5. Due reminders attached to done and archived items (must be skipped & cancelled, 0 pushes)
    it_done = _seed_item(mock_db, item_id="item-c8-done", owner_id="usr-c8", status="done")
    rem_done = _seed_reminder(
        mock_db,
        rem_id="rem-c8-done",
        item_id=it_done["id"],
        user_id="usr-c8",
        schedule_type="once",
        remind_at=now_ref - timedelta(minutes=20),
    )
    it_arch = _seed_item(mock_db, item_id="item-c8-arch", owner_id="usr-c8", status="archived")
    rem_arch = _seed_reminder(
        mock_db,
        rem_id="rem-c8-arch",
        item_id=it_arch["id"],
        user_id="usr-c8",
        schedule_type="once",
        remind_at=now_ref - timedelta(minutes=15),
    )

    # Active remote Expo device to count outbound dispatches
    _seed_device(
        mock_db,
        user_id="usr-c8",
        platform="android",
        delivery_mode="remote",
        push_token="ExponentPushToken[c8-dev]",
        is_active=True,
    )
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(200, json={"data": {"status": "ok", "id": "t-1"}}, request=req)
    )

    summary = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert summary.claimed == 4
    assert summary.dispatched_reminders == 2
    assert summary.skipped_completed_items == 2
    assert summary.push_summary.attempted == 2
    assert summary.push_summary.delivered == 2
    assert len(hermetic_isolation.requests) == 2  # skipped done/archived generated 0 pushes

    rows_by_id = {r["id"]: r for r in mock_db.tables["reminders"]}
    # 'once' -> sent with sent_at and last_triggered_at
    assert rows_by_id[rem_once["id"]]["status"] == "sent"
    assert rows_by_id[rem_once["id"]]["sent_at"] == now_ref.isoformat()
    assert rows_by_id[rem_once["id"]]["last_triggered_at"] == now_ref.isoformat()

    # 10-day overdue 'every_n_days' -> claimed ONCE, keeps status='pending', advances to 2026-11-05 09:00 EST (14:00Z)
    rec_row = rows_by_id[rem_rec["id"]]
    assert rec_row["status"] == "pending"
    assert rec_row["sent_at"] == now_ref.isoformat()
    assert rec_row["last_triggered_at"] == now_ref.isoformat()
    next_remind_dt = datetime.fromisoformat(rec_row["remind_at"])
    assert next_remind_dt > now_ref
    assert next_remind_dt == datetime(2026, 11, 5, 14, 0, tzinfo=timezone.utc)
    ny_local = next_remind_dt.astimezone(ZoneInfo("America/New_York"))
    assert (ny_local.hour, ny_local.minute) == (9, 0)

    # Also verify advance_every_n_days_utc before 09:00 local on day 10 lands on same day 09:00 EST
    same_day_next = advance_every_n_days_utc(
        datetime(2026, 10, 25, 13, 0, tzinfo=timezone.utc),
        1,
        "09:00",
        "America/New_York",
        now_utc=datetime(2026, 11, 4, 13, 0, tzinfo=timezone.utc),  # 08:00 EST on Nov 4
    )
    assert same_day_next == datetime(2026, 11, 4, 14, 0, tzinfo=timezone.utc)

    # Future untouched; done/archived cancelled
    assert rows_by_id[rem_fut["id"]]["status"] == "pending"
    assert rows_by_id[rem_done["id"]]["status"] == "cancelled"
    assert rows_by_id[rem_arch["id"]]["status"] == "cancelled"

    # Verify HTTP POST /cron/reminders executes end-to-end against wall-clock now without historical fixtures interfering
    hermetic_isolation.clear_requests()
    mock_db.tables["reminders"].clear()
    due_http_item = _seed_item(mock_db, item_id="item-c8-http", owner_id="usr-c8", title="HTTP Cron Item")
    due_http_rem = _seed_reminder(
        mock_db,
        rem_id="rem-c8-http",
        item_id=due_http_item["id"],
        user_id="usr-c8",
        schedule_type="once",
        remind_at=datetime.now(timezone.utc) - timedelta(seconds=30),
    )
    monkeypatch.setenv("CRON_SHARED_SECRET", "http-cron-secret")
    http_res = test_client.post(
        "/cron/reminders",
        json={"batch_limit": 25},
        headers={"X-Cron-Secret": "http-cron-secret"},
    )
    assert http_res.status_code == 200
    http_json = http_res.json()
    assert http_json["claimed"] == 1
    assert http_json["dispatched_reminders"] == 1
    assert http_json["push_summary"]["delivered"] == 1
    refreshed_http_row = [r for r in mock_db.tables["reminders"] if r["id"] == due_http_rem["id"]][0]
    assert refreshed_http_row["status"] == "sent"


@pytest.mark.asyncio
async def test_c8_claim_due_reminders_rpc_path_and_concurrent_done_filter(hermetic_isolation):
    """C8: db.rpc('claim_due_reminders', ...) path claims rows and filters out concurrently completed items."""
    now_ref = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)

    active_item_id = "item-rpc-active"
    done_item_id = "item-rpc-done"

    def claim_rpc_handler(params: Dict[str, Any]) -> List[Dict[str, Any]]:
        assert params == {"batch_limit": 42}
        # Simulate SQL RPC marking rows as claimed/sent before returning
        for row in rpc_db.tables["reminders"]:
            if row["id"] == "rem-rpc-1":
                row["status"] = "sent"
                row["sent_at"] = now_ref.isoformat()
        return [
            {
                "reminder_id": "rem-rpc-1",
                "item_id": active_item_id,
                "user_id": "usr-rpc",
                "title_snapshot": "Active RPC Reminder",
                "schedule_type": "once",
                "repeat_every_days": None,
                "fired_at": now_ref.isoformat(),
            },
            {
                "reminder_id": "rem-rpc-2",
                "item_id": done_item_id,
                "user_id": "usr-rpc",
                "title_snapshot": "Concurrently Done Reminder",
                "schedule_type": "once",
                "repeat_every_days": None,
                "fired_at": now_ref.isoformat(),
            },
        ]

    rpc_db = RpcCapableInMemoryDB(rpc_handlers={"claim_due_reminders": claim_rpc_handler})
    _seed_item(rpc_db, item_id=active_item_id, owner_id="usr-rpc", title="Active RPC Item", status="inbox")
    _seed_item(rpc_db, item_id=done_item_id, owner_id="usr-rpc", title="Done RPC Item", status="done")
    _seed_reminder(
        rpc_db,
        rem_id="rem-rpc-1",
        item_id=active_item_id,
        user_id="usr-rpc",
        remind_at=now_ref - timedelta(minutes=1),
    )
    _seed_reminder(
        rpc_db,
        rem_id="rem-rpc-2",
        item_id=done_item_id,
        user_id="usr-rpc",
        remind_at=now_ref - timedelta(minutes=1),
    )
    _seed_device(
        rpc_db,
        user_id="usr-rpc",
        platform="android",
        delivery_mode="remote",
        push_token="ExponentPushToken[rpc-user]",
        is_active=True,
    )

    hermetic_isolation.set_handler(
        lambda req: httpx.Response(200, json={"data": {"status": "ok", "id": "rpc-ticket"}}, request=req)
    )

    res = await process_due_reminders_cron(rpc_db, batch_limit=42, now_utc=now_ref)
    assert rpc_db.rpc_calls == [("claim_due_reminders", {"batch_limit": 42})]
    assert res.claimed == 2
    assert res.dispatched_reminders == 1
    assert res.skipped_completed_items == 1
    assert res.push_summary.attempted == 1
    assert res.push_summary.delivered == 1
    assert len(hermetic_isolation.requests) == 1

    by_id = {r["id"]: r for r in rpc_db.tables["reminders"]}
    assert by_id["rem-rpc-1"]["status"] == "sent"
    assert by_id["rem-rpc-2"]["status"] == "cancelled"


# =====================================================================
# C9: Push Adapters (Expo, FCM HTTP v1, Web Push VAPID + RFC 8291 Decrypt) & SSRF
# =====================================================================


@pytest.mark.asyncio
async def test_c9_expo_push_payload_and_device_not_registered_same_batch_dedup(
    hermetic_isolation, mock_db, monkeypatch
):
    """C9: Expo Push checks URL/headers/payload, sets is_active=False on DeviceNotRegistered, and skips re-dispatch in same batch."""
    monkeypatch.setenv("EXPO_ACCESS_TOKEN", "expo-test-bearer-token")
    now_ref = datetime(2026, 11, 12, 10, 0, tzinfo=timezone.utc)

    # Direct send_expo_push success check
    hermetic_isolation.set_handler(
        lambda req: httpx.Response(200, json={"data": {"status": "ok", "id": "exp-ticket-1"}}, request=req)
    )
    ok_res = await send_expo_push(
        "ExponentPushToken[ok-device]",
        "Reminder Title",
        "https://example.com/ok",
        data={"item_id": "item-1"},
    )
    assert ok_res.delivered is True
    assert ok_res.deactivate_device is False
    req_ok = hermetic_isolation.requests[-1]
    assert str(req_ok.url) == "https://exp.host/--/api/v2/push/send"
    assert req_ok.headers["authorization"] == "Bearer expo-test-bearer-token"
    assert req_ok.headers["content-type"] == "application/json"
    assert req_ok.headers["accept"] == "application/json"
    assert json.loads(req_ok.content.decode("utf-8")) == {
        "to": "ExponentPushToken[ok-device]",
        "title": "Reminder Title",
        "body": "https://example.com/ok",
        "data": {"item_id": "item-1"},
        "sound": "default",
    }

    # Same-batch deactivation test: 2 due reminders for 1 user with 1 Expo device returning DeviceNotRegistered
    hermetic_isolation.clear_requests()
    it1 = _seed_item(mock_db, item_id="item-exp-1", owner_id="usr-exp", title="First Due")
    it2 = _seed_item(mock_db, item_id="item-exp-2", owner_id="usr-exp", title="Second Due")
    _seed_reminder(
        mock_db,
        rem_id="rem-exp-1",
        item_id=it1["id"],
        user_id="usr-exp",
        remind_at=now_ref - timedelta(minutes=2),
        title_snapshot="First Due",
    )
    _seed_reminder(
        mock_db,
        rem_id="rem-exp-2",
        item_id=it2["id"],
        user_id="usr-exp",
        remind_at=now_ref - timedelta(minutes=1),
        title_snapshot="Second Due",
    )
    dev = _seed_device(
        mock_db,
        device_id="dev-exp-stale",
        user_id="usr-exp",
        platform="ios",
        delivery_mode="remote",
        push_token="ExponentPushToken[stale-token]",
        is_active=True,
    )

    hermetic_isolation.set_handler(
        lambda req: httpx.Response(
            200,
            json={
                "data": {
                    "status": "error",
                    "message": "Device not registered",
                    "details": {"error": "DeviceNotRegistered"},
                }
            },
            request=req,
        )
    )

    cron_res = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert cron_res.dispatched_reminders == 2
    assert cron_res.push_summary.attempted == 1
    assert cron_res.push_summary.delivered == 0
    assert cron_res.push_summary.failed == 1
    assert cron_res.push_summary.skipped_inactive == 1
    assert cron_res.push_summary.deactivated_devices == ["dev-exp-stale"]
    assert len(hermetic_isolation.requests) == 1  # No re-dispatch in same batch after deactivation
    assert mock_db.tables["devices"][0]["id"] == dev["id"]
    assert mock_db.tables["devices"][0]["is_active"] is False


@pytest.mark.asyncio
async def test_c9_fcm_http_v1_rs256_jwt_verification_and_unregistered_deactivation(
    hermetic_isolation, mock_db, monkeypatch
):
    """C9: FCM HTTP v1 signs verifiable RS256 OAuth2 JWT, caches bearer token, and deactivates on UNREGISTERED/404."""
    rsa_pem, rsa_pub_key = _generate_ephemeral_rsa_pem_and_pub()
    client_email = "firebase-adminsdk-test@just-save-it-hermetic.iam.gserviceaccount.com"
    project_id = "just-save-it-hermetic"
    token_uri = "https://oauth2.googleapis.com/token"
    sa_json = json.dumps(
        {
            "type": "service_account",
            "project_id": project_id,
            "client_email": client_email,
            "private_key": rsa_pem,
            "token_uri": token_uri,
        }
    )
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", sa_json)

    oauth_calls = 0
    send_calls = 0
    send_mode = {"status": 200, "json": {"name": f"projects/{project_id}/messages/msg-1"}}

    def fcm_handler(req: httpx.Request) -> httpx.Response:
        nonlocal oauth_calls, send_calls
        url = str(req.url)
        if url == token_uri:
            oauth_calls += 1
            form = parse_qs(req.content.decode("utf-8"))
            assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
            assertion = form["assertion"][0]
            decoded_claims = jwt.decode(
                assertion,
                rsa_pub_key,
                algorithms=["RS256"],
                audience=token_uri,
                issuer=client_email,
                options={"require": ["iss", "scope", "aud", "iat", "exp"]},
            )
            assert decoded_claims["scope"] == FCM_SCOPE
            return httpx.Response(
                200,
                json={"access_token": "mock-fcm-bearer-xyz", "expires_in": 3600, "token_type": "Bearer"},
                request=req,
            )

        if url == f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send":
            send_calls += 1
            assert req.headers["authorization"] == "Bearer mock-fcm-bearer-xyz"
            body = json.loads(req.content.decode("utf-8"))
            assert "token" in body["message"]
            assert "notification" in body["message"]
            return httpx.Response(send_mode["status"], json=send_mode["json"], request=req)

        return httpx.Response(404, request=req)

    hermetic_isolation.set_handler(fcm_handler)

    # 1. Two successful sends reuse cached OAuth2 bearer token
    res1 = await send_fcm_push("fcm-device-token-1", "Title 1", "Body 1", data={"item_id": "it-1", "count": 2})
    res2 = await send_fcm_push("fcm-device-token-2", "Title 2", "Body 2", data={"item_id": "it-2"})
    assert res1.delivered is True and res1.deactivate_device is False
    assert res2.delivered is True and res2.deactivate_device is False
    assert oauth_calls == 1
    assert send_calls == 2

    # 2. HTTP 400 UNREGISTERED error payload also triggers deactivate_device=True
    send_mode["status"] = 400
    send_mode["json"] = {
        "error": {
            "code": 400,
            "message": "Requested entity was not found.",
            "status": "INVALID_ARGUMENT",
            "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "UNREGISTERED"}],
        }
    }
    res_unreg = await send_fcm_push("fcm-device-token-unreg", "Title", "Body")
    assert res_unreg.delivered is False
    assert res_unreg.deactivate_device is True

    # 3. End-to-end cron run with HTTP 404 UNREGISTERED sets devices.is_active = False in DB
    FCM_TOKEN_CACHE.clear()
    oauth_calls = 0
    send_calls = 0
    send_mode["status"] = 404
    send_mode["json"] = {
        "error": {
            "code": 404,
            "message": "Requested entity was not found.",
            "status": "NOT_FOUND",
            "details": [{"errorCode": "UNREGISTERED"}],
        }
    }
    now_ref = datetime(2026, 11, 12, 11, 0, tzinfo=timezone.utc)
    item = _seed_item(mock_db, item_id="item-fcm-stale", owner_id="usr-fcm", title="FCM Stale")
    _seed_reminder(
        mock_db,
        rem_id="rem-fcm-stale",
        item_id=item["id"],
        user_id="usr-fcm",
        remind_at=now_ref - timedelta(minutes=1),
        title_snapshot="FCM Stale",
    )
    _seed_device(
        mock_db,
        device_id="dev-fcm-stale",
        user_id="usr-fcm",
        platform="android",
        delivery_mode="remote",
        push_token="fcm-registration-token-stale",
        is_active=True,
    )

    cron_res = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert oauth_calls == 1
    assert send_calls == 1
    assert cron_res.push_summary.attempted == 1
    assert cron_res.push_summary.failed == 1
    assert cron_res.push_summary.deactivated_devices == ["dev-fcm-stale"]
    assert mock_db.tables["devices"][0]["is_active"] is False


@pytest.mark.asyncio
async def test_c9_web_push_vapid_es256_rfc8291_decrypt_and_410_deactivation(
    hermetic_isolation, mock_db, monkeypatch
):
    """C9: Web Push signs ES256 VAPID JWT, encrypts aes128gcm (RFC 8291 decrypted back to JSON), and deactivates on 410."""
    vapid_priv, vapid_pem, vapid_pub_b64 = _generate_ephemeral_ec_p256()
    ua_priv, _, ua_pub_b64 = _generate_ephemeral_ec_p256()
    auth_secret = os.urandom(16)
    auth_b64 = _b64url_encode(auth_secret)

    monkeypatch.setenv("VAPID_PRIVATE_KEY", vapid_pem)
    monkeypatch.setenv("VAPID_PUBLIC_KEY", vapid_pub_b64)
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:push@justsaveit.test")

    endpoint_ok = "https://push.example.com/sub/browser-1"
    endpoint_gone = "https://push.example.com/sub/browser-gone"

    captured: Dict[str, Any] = {}

    def web_push_handler(req: httpx.Request) -> httpx.Response:
        if str(req.url) == endpoint_ok:
            captured["headers"] = dict(req.headers)
            captured["body"] = bytes(req.content)
            return httpx.Response(201, request=req)
        if str(req.url) == endpoint_gone:
            return httpx.Response(410, text="Gone", request=req)
        return httpx.Response(404, request=req)

    hermetic_isolation.set_handler(web_push_handler)

    now_ref = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
    item = _seed_item(
        mock_db,
        item_id="item-wp-1",
        owner_id="usr-wp",
        url="https://docs.python.org/3/library/zoneinfo.html",
        title="ZoneInfo Docs",
    )
    rem = _seed_reminder(
        mock_db,
        rem_id="rem-wp-1",
        item_id=item["id"],
        user_id="usr-wp",
        remind_at=now_ref - timedelta(minutes=1),
        title_snapshot="Review ZoneInfo",
    )
    _seed_device(
        mock_db,
        device_id="dev-wp-ok",
        user_id="usr-wp",
        platform="web",
        delivery_mode="remote",
        web_push_sub={
            "endpoint": endpoint_ok,
            "keys": {"p256dh": ua_pub_b64, "auth": auth_b64},
        },
        is_active=True,
    )

    cron_ok = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert cron_ok.push_summary.attempted == 1
    assert cron_ok.push_summary.delivered == 1
    assert cron_ok.push_summary.failed == 0

    # Verify RFC 8292 VAPID ES256 JWT header
    headers_sent = captured["headers"]
    assert headers_sent["content-encoding"] == "aes128gcm"
    assert headers_sent["content-type"] == "application/octet-stream"
    assert headers_sent["ttl"] == "86400"
    assert headers_sent["urgency"] == "normal"

    auth_header = headers_sent["authorization"]
    assert auth_header.startswith("vapid ")
    parts = dict(part.strip().split("=", 1) for part in auth_header[6:].split(","))
    assert parts["k"] == vapid_pub_b64
    vapid_claims = jwt.decode(
        parts["t"],
        vapid_priv.public_key(),
        algorithms=["ES256"],
        audience="https://push.example.com",
        options={"require": ["aud", "exp", "sub"]},
    )
    assert vapid_claims["sub"] == "mailto:push@justsaveit.test"

    # Decrypt real aes128gcm HTTP body with UA private key + auth secret -> exact notification JSON
    plaintext_bytes = _decrypt_rfc8291_aes128gcm(captured["body"], ua_priv, auth_secret)
    decrypted_payload = json.loads(plaintext_bytes.decode("utf-8"))
    assert decrypted_payload == {
        "title": "Review ZoneInfo",
        "body": "https://docs.python.org/3/library/zoneinfo.html",
        "data": {
            "reminder_id": rem["id"],
            "item_id": item["id"],
            "url": "https://docs.python.org/3/library/zoneinfo.html",
        },
    }

    # Verify HTTP 410 Gone marks web device is_active=False in DB
    _seed_reminder(
        mock_db,
        rem_id="rem-wp-2",
        item_id=item["id"],
        user_id="usr-wp",
        remind_at=now_ref - timedelta(seconds=30),
        title_snapshot="Expired Subscription",
    )
    mock_db.tables["devices"].clear()
    _seed_device(
        mock_db,
        device_id="dev-wp-gone",
        user_id="usr-wp",
        platform="extension",
        delivery_mode="remote",
        web_push_sub={
            "endpoint": endpoint_gone,
            "keys": {"p256dh": ua_pub_b64, "auth": auth_b64},
        },
        is_active=True,
    )

    cron_gone = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert cron_gone.push_summary.attempted == 1
    assert cron_gone.push_summary.failed == 1
    assert cron_gone.push_summary.deactivated_devices == ["dev-wp-gone"]
    assert mock_db.tables["devices"][0]["is_active"] is False


@pytest.mark.asyncio
async def test_c9_local_sync_inactive_skip_and_web_push_ssrf_guard(
    hermetic_isolation, mock_db, monkeypatch
):
    """C9: local_sync & inactive devices skipped; loopback/localhost/169.254.169.254 & private DNS SSRF blocked with 0 HTTP calls."""
    _, vapid_pem, vapid_pub_b64 = _generate_ephemeral_ec_p256()
    _, _, ua_pub_b64 = _generate_ephemeral_ec_p256()
    auth_b64 = _b64url_encode(os.urandom(16))

    monkeypatch.setenv("VAPID_PRIVATE_KEY", vapid_pem)
    monkeypatch.setenv("VAPID_PUBLIC_KEY", vapid_pub_b64)

    now_ref = datetime(2026, 11, 12, 13, 0, tzinfo=timezone.utc)
    item = _seed_item(mock_db, item_id="item-ssrf-1", owner_id="usr-ssrf", title="SSRF Check")
    _seed_reminder(
        mock_db,
        rem_id="rem-ssrf-1",
        item_id=item["id"],
        user_id="usr-ssrf",
        remind_at=now_ref - timedelta(minutes=1),
        title_snapshot="SSRF Check",
    )

    # Skipped devices
    _seed_device(mock_db, user_id="usr-ssrf", platform="ios", delivery_mode="local_sync", is_active=True)
    _seed_device(
        mock_db,
        user_id="usr-ssrf",
        platform="android",
        delivery_mode="remote",
        push_token="ExponentPushToken[inactive-dev]",
        is_active=False,
    )

    # 3 SSRF Web Push endpoints
    ssrf_endpoints = [
        "http://127.0.0.1/push",
        "https://localhost/push",
        "https://169.254.169.254/push",
    ]
    for idx, endpoint in enumerate(ssrf_endpoints):
        with pytest.raises(ValueError):
            validate_web_push_endpoint(endpoint)
        _seed_device(
            mock_db,
            device_id=f"dev-ssrf-{idx}",
            user_id="usr-ssrf",
            platform="web",
            delivery_mode="remote",
            web_push_sub={"endpoint": endpoint, "keys": {"p256dh": ua_pub_b64, "auth": auth_b64}},
            is_active=True,
        )

    cron_res = await process_due_reminders_cron(mock_db, now_utc=now_ref)
    assert cron_res.dispatched_reminders == 1
    assert cron_res.push_summary.skipped_local_sync == 1
    assert cron_res.push_summary.skipped_inactive == 1
    assert cron_res.push_summary.attempted == 3
    assert cron_res.push_summary.delivered == 0
    assert cron_res.push_summary.failed == 3
    assert cron_res.push_summary.ssrf_blocked == 3
    assert len(hermetic_isolation.requests) == 0

    # Also test DNS-rebinding SSRF via getaddrinfo returning RFC1918 private IP
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0))],
    )
    rebind_res = await send_web_push(
        {"endpoint": "https://rebind.attacker.example/push", "keys": {"p256dh": ua_pub_b64, "auth": auth_b64}},
        "Alert",
        "Body",
    )
    assert rebind_res.delivered is False
    assert rebind_res.ssrf_blocked is True
    assert len(hermetic_isolation.requests) == 0


def test_c6_c7_snooze_sent_and_recurring_local_sync_plus_revoked_folder_isolation(mock_db, test_client):
    """C6/C7: Snoozing 'sent' resets to 'pending'; snoozed every_n_days keeps first slot; removed folder members lose visibility."""
    now_ref = datetime.now(timezone.utc).replace(microsecond=0)

    # 1. Snoozing a 'sent' once reminder reactivates it as 'pending'
    sent_item = _seed_item(mock_db, item_id="item-snz-sent", owner_id="usr-snz2")
    _seed_reminder(
        mock_db,
        rem_id="rem-snz-sent",
        item_id=sent_item["id"],
        user_id="usr-snz2",
        schedule_type="once",
        remind_at=now_ref - timedelta(hours=2),
        status="sent",
    )
    hdr_snz = make_auth_headers("usr-snz2")
    snz_res = test_client.post(f"/api/reminders/{sent_item['id']}/snooze", json={"minutes": 45}, headers=hdr_snz)
    assert snz_res.status_code == 200
    assert snz_res.json()["status"] == "pending"
    assert datetime.fromisoformat(snz_res.json()["remind_at"]) > now_ref

    # 2. Snoozing an every_n_days rule emits the snoozed timestamp first and wall_time thereafter
    tz_bkk = ZoneInfo("Asia/Bangkok")
    rec_now = datetime(2026, 11, 13, 2, 10, 0, tzinfo=timezone.utc)  # 09:10 +07:00
    snoozed_target = datetime(2026, 11, 13, 4, 30, 0, tzinfo=timezone.utc)  # 11:30 +07:00
    rec_item = _seed_item(mock_db, item_id="item-snz-rec", owner_id="usr-snz-rec")
    rec_rem = _seed_reminder(
        mock_db,
        rem_id="rem-snz-rec",
        item_id=rec_item["id"],
        user_id="usr-snz-rec",
        schedule_type="every_n_days",
        remind_at=snoozed_target,
        repeat_every_days=1,
        remind_time="09:00:00",
        timezone_name="Asia/Bangkok",
    )
    unrolled = unroll_reminders_for_ios(
        [rec_rem],
        {rec_item["id"]: rec_item},
        now_utc=rec_now,
        lookahead_per_rule=3,
    )
    assert [occ.occurrence_at for occ in unrolled.notifications] == [
        snoozed_target,
        datetime(2026, 11, 14, 2, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 11, 15, 2, 0, 0, tzinfo=timezone.utc),
    ]
    assert all(occ.occurrence_at > rec_now for occ in unrolled.notifications)
    assert (unrolled.notifications[1].occurrence_at.astimezone(tz_bkk).hour, 0) == (9, 0)

    # 3. Removing shared-folder membership hides existing reminders in list and local-sync immediately
    mock_db.tables["folders"].append({"id": "fld-rev", "owner_id": "usr-own-rev", "name": "Revoked", "is_shared": True})
    mock_db.tables["folder_members"].append({"folder_id": "fld-rev", "user_id": "usr-mem-rev", "role": "viewer"})
    shared_rev = _seed_item(mock_db, item_id="item-rev-1", owner_id="usr-own-rev", folder_id="fld-rev")
    _seed_reminder(
        mock_db,
        rem_id="rem-rev-1",
        item_id=shared_rev["id"],
        user_id="usr-mem-rev",
        remind_at=now_ref + timedelta(hours=3),
    )
    hdr_mem = make_auth_headers("usr-mem-rev")
    assert test_client.get("/api/reminders", headers=hdr_mem).json()["total"] == 1
    assert len(test_client.get("/api/reminders/local-sync", headers=hdr_mem).json()["notifications"]) == 1

    mock_db.tables["folder_members"].clear()
    assert test_client.get("/api/reminders", headers=hdr_mem).json()["total"] == 0
    assert test_client.get("/api/reminders/local-sync", headers=hdr_mem).json()["notifications"] == []


@pytest.mark.asyncio
async def test_c4_web_push_4kb_payload_cap_and_vapid_newline_normalization(hermetic_isolation, monkeypatch):
    """C4: Web Push caps oversized multi-byte payloads below 4KB and normalizes escaped newlines in VAPID_PRIVATE_KEY."""
    from Reminders.push_adapters import _load_vapid_keys, send_web_push

    _, vapid_pem, vapid_pub_b64 = _generate_ephemeral_ec_p256()
    _, _, ua_pub_b64 = _generate_ephemeral_ec_p256()
    escaped_pem = vapid_pem.strip().replace("\n", "\\n")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", escaped_pem)
    monkeypatch.setenv("VAPID_PUBLIC_KEY", vapid_pub_b64)
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:push@justsaveit.test")

    priv_key, pub_b64, subj = _load_vapid_keys()
    assert priv_key is not None
    assert pub_b64 == vapid_pub_b64
    assert subj == "mailto:push@justsaveit.test"

    captured_len = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal captured_len
        captured_len = len(bytes(req.content))
        return httpx.Response(201, request=req)

    hermetic_isolation.set_handler(handler)

    sub = {
        "endpoint": "https://push.example.com/sub/huge-thai",
        "keys": {"p256dh": ua_pub_b64, "auth": _b64url_encode(os.urandom(16))},
    }
    res = await send_web_push(
        sub,
        title="ก" * 800,
        body="ข" * 2000,
        data={"url": "https://example.com/" + ("z" * 1500)},
    )
    assert res.delivered is True
    assert 0 < captured_len < 4079


def test_remediation_post_and_patch_reminders_contract(mock_db, test_client):
    """Remediation: POST /api/reminders validates item_id mismatch (422), PATCH supports partial updates & is_enabled=False."""
    owner_headers = make_auth_headers("usr-rem-patch")
    item = _seed_item(mock_db, item_id="item-rem-patch", owner_id="usr-rem-patch", title="Check PATCH")

    res_mismatch = test_client.post(
        "/api/reminders?item_id=other-item-id",
        json={
            "item_id": item["id"],
            "schedule_type": "once",
            "remind_at": "2030-07-01T10:00:00Z",
            "timezone": "Asia/Bangkok",
        },
        headers=owner_headers,
    )
    assert res_mismatch.status_code == 422

    res_post = test_client.post(
        "/api/reminders",
        json={
            "item_id": item["id"],
            "schedule_type": "once",
            "remind_at": "2030-07-01T10:00:00Z",
            "remind_time": "17:00:00",
            "timezone": "Asia/Bangkok",
        },
        headers=owner_headers,
    )
    assert res_post.status_code == 201
    post_body = res_post.json()
    assert post_body["is_enabled"] is True
    assert post_body["status"] == "pending"

    res_patch_time = test_client.patch(
        f"/api/reminders/{item['id']}",
        json={"remind_time": "19:30:00"},
        headers=owner_headers,
    )
    assert res_patch_time.status_code == 200
    assert res_patch_time.json()["remind_time"] == "19:30:00"
    assert res_patch_time.json()["is_enabled"] is True
    assert datetime.fromisoformat(res_patch_time.json()["remind_at"]) == datetime(2030, 7, 1, 12, 30, tzinfo=timezone.utc)

    res_disable = test_client.patch(
        f"/api/reminders/{item['id']}",
        json={"is_enabled": False},
        headers=owner_headers,
    )
    assert res_disable.status_code == 200
    disable_body = res_disable.json()
    assert disable_body["is_enabled"] is False
    assert disable_body["status"] == "cancelled"


def test_remediation_item_schemas_reject_unsafe_urls():
    """Remediation: ItemCreateRequest & ItemUpdateRequest reject javascript:/data: URLs on media/thumbnail/embed fields."""
    from pydantic import ValidationError
    from Database.schemas import ItemCreateRequest, ItemUpdateRequest

    with pytest.raises(ValidationError):
        ItemCreateRequest(url="https://example.com/ok", thumbnail_url="javascript:alert(1)")
    with pytest.raises(ValidationError):
        ItemCreateRequest(url="https://example.com/ok", embed_url="data:text/html,<script>alert(1)</script>")
    with pytest.raises(ValidationError):
        ItemCreateRequest(url="https://example.com/ok", media_items=[{"media_url": "javascript:alert(2)"}])
    with pytest.raises(ValidationError):
        ItemUpdateRequest(thumbnail_url="vbscript:msgbox(1)")
    with pytest.raises(ValidationError):
        ItemUpdateRequest(embed_url="javascript:void(0)")


def test_remediation_favorite_done_at_and_dedupe_reopen(mock_db):
    """Remediation: is_favorite persists across list/update, done_at resets on reopen, and dedupe re-opens done items with reminder."""
    from fastapi import HTTPException
    from Database.repository import create_or_bump_item, list_and_search_items, update_item_for_user
    from Database.schemas import ItemCreateRequest, ItemUpdateRequest, ReminderConfig

    created = create_or_bump_item(
        mock_db,
        "usr-fav-1",
        ItemCreateRequest(url="https://example.com/fav-cafe", title="Fav Cafe", is_favorite=True),
    )
    assert created["is_favorite"] is True

    listed = list_and_search_items(mock_db, "usr-fav-1")
    assert len(listed) == 1
    assert listed[0]["is_favorite"] is True

    done_row = update_item_for_user(mock_db, "usr-fav-1", created["id"], ItemUpdateRequest(status="done"))
    assert done_row["status"] == "done"
    assert done_row["done_at"] is not None

    reopened = update_item_for_user(mock_db, "usr-fav-1", created["id"], ItemUpdateRequest(status="inbox"))
    assert reopened["status"] == "inbox"
    assert reopened["done_at"] is None

    update_item_for_user(mock_db, "usr-fav-1", created["id"], ItemUpdateRequest(status="done"))

    rem_cfg = ReminderConfig(schedule_type="once", remind_at=datetime(2030, 8, 1, 11, 0, tzinfo=timezone.utc))
    with pytest.raises(HTTPException) as exc_409:
        create_or_bump_item(
            mock_db,
            "usr-fav-1",
            ItemCreateRequest(url="https://example.com/fav-cafe", status="done", reminder=rem_cfg),
        )
    assert exc_409.value.status_code == 409

    bumped = create_or_bump_item(
        mock_db,
        "usr-fav-1",
        ItemCreateRequest(url="https://example.com/fav-cafe", reminder=rem_cfg),
    )
    assert bumped["deduplicated"] is True
    assert bumped["status"] == "inbox"
    assert bumped["done_at"] is None
    assert bumped["reminder"]["status"] == "pending"


def test_web_push_public_config_and_device_deactivate(mock_db, test_client, monkeypatch):
    """Verify GET /api/reminders/push-config exposes public key only & POST /api/devices/deactivate isolates users."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    from Reminders.push_adapters import _b64url_encode

    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("VAPID_PUBLIC_KEY", raising=False)
    headers_a = make_auth_headers("usr-push-a")
    headers_b = make_auth_headers("usr-push-b")

    res_disabled = test_client.get("/api/reminders/push-config", headers=headers_a)
    assert res_disabled.status_code == 200
    assert res_disabled.json() == {"enabled": False, "vapid_public_key": None}

    priv = ec.generate_private_key(ec.SECP256R1())
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    expected_pub = _b64url_encode(
        priv.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
    )
    monkeypatch.setenv("VAPID_PRIVATE_KEY", priv_pem)
    res_enabled = test_client.get("/api/reminders/push-config", headers=headers_a)
    assert res_enabled.status_code == 200
    assert res_enabled.json()["enabled"] is True
    assert res_enabled.json()["vapid_public_key"] == expected_pub
    assert "BEGIN PRIVATE KEY" not in res_enabled.text

    ep_a = "https://fcm.googleapis.com/fcm/send/device-a"
    reg_a = test_client.post(
        "/api/devices",
        json={
            "platform": "web",
            "delivery_mode": "remote",
            "web_push_sub": {"endpoint": ep_a, "keys": {"p256dh": "k", "auth": "a"}},
        },
        headers=headers_a,
    )
    assert reg_a.status_code == 201
    # Re-registering same endpoint updates row without duplicating
    reg_a2 = test_client.post(
        "/api/devices",
        json={
            "platform": "web",
            "delivery_mode": "remote",
            "web_push_sub": {"endpoint": ep_a, "keys": {"p256dh": "k", "auth": "a"}},
        },
        headers=headers_a,
    )
    assert reg_a2.status_code == 201
    assert len(mock_db.tables["devices"]) == 1

    # Another user cannot deactivate user A's device
    deact_b = test_client.post("/api/devices/deactivate", json={"endpoint": ep_a}, headers=headers_b)
    assert deact_b.status_code == 200
    assert deact_b.json()["deactivated"] == 0
    assert mock_db.tables["devices"][0]["is_active"] is True

    deact_a = test_client.post("/api/devices/deactivate", json={"endpoint": ep_a}, headers=headers_a)
    assert deact_a.status_code == 200
    assert deact_a.json()["deactivated"] == 1
    assert mock_db.tables["devices"][0]["is_active"] is False

