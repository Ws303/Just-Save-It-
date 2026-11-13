"""Comprehensive Unit Tests for Just-Save-It Database, RLS, Auth, Reminders, Multi-Language, and Export.

Validates all 8 checkpoints from Part 1 Specification (C1 - C8):
- C1: Schema + Lossless Text + Canonical Dedup + Accept Invite
- C2: RLS & Tenant Isolation (Static Audit + Permissions Matrix)
- C3: Auth Security Fix (RISK-001) & Auth Router
- C4: Multi-Language & Zero-Mojibake Byte Decoding
- C5: Fast Multi-Language Search across 4 Fields & Shared Folders
- C6: Configurable AI Language & Backward Compatibility
- C7: Cross-OS Hybrid Reminder Persistence
- C8: JSON Export & Sanitization
"""

import copy
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import re
from typing import Any, Dict, List, Optional
import unicodedata
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from Ai.content_extractor import extract_text_for_ai
from Ai.mcp_server import verify_mcp_token
from Ai.schemas import AISummaryOutput, SummarizeRequest, SummarizeResponse
from Ai.summarizer_service import summarize_item_once
from Database.client import set_override_supabase_client
from Database.repository import (
    accept_folder_invite,
    can_access_item,
    create_or_bump_item,
    delete_item_for_user,
    export_user_data,
    get_folder_role,
    get_item_for_user,
    list_and_search_items,
    update_item_for_user,
    upsert_item_reminder,
)
from Database.schemas import (
    DeviceRegisterRequest,
    FolderCreateRequest,
    FolderUpdateRequest,
    InviteCreateRequest,
    ItemCreateRequest,
    ItemUpdateRequest,
    ReminderConfig,
    TagCreateRequest,
    TagUpdateRequest,
)
from Database.text_hygiene import (
    canonicalize_url,
    clean_text_field,
    compute_url_hash,
    decode_html_bytes,
    normalize_unicode_text,
)
from Login.auth_dep import get_current_user_id, is_dev_bypass_enabled, verify_supabase_jwt
from main import app

JWT_TEST_SECRET = "super-secret-jwt-key-for-test-suite-0123456789"
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


# =====================================================================
# Hermetic In-Memory Database & Table Proxy for Isolated Testing
# =====================================================================

class InMemoryDB:
    def __init__(self):
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
            # Assign auto UUID unless compound key or already provided
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


# =====================================================================
# Auth & Client Helpers
# =====================================================================

def make_jwt(
    user_id: str,
    secret: str = JWT_TEST_SECRET,
    aud: str = "authenticated",
    exp_offset_sec: int = 3600,
    sub_key: str = "sub",
) -> str:
    """Generate deterministic signed HS256 JWT for hermetic testing."""
    now_ts = int(datetime.now(timezone.utc).timestamp())
    payload = {
        sub_key: user_id,
        "aud": aud,
        "exp": now_ts + exp_offset_sec,
        "iat": now_ts,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def make_auth_headers(user_id: str = "usr-test-1", secret: str = JWT_TEST_SECRET) -> Dict[str, str]:
    return {"Authorization": f"Bearer {make_jwt(user_id, secret=secret)}"}


@pytest.fixture
def mock_db():
    """Isolated hermetic in-memory database fixture with clean teardown."""
    db = InMemoryDB()
    set_override_supabase_client(db)
    yield db
    set_override_supabase_client(None)


@pytest.fixture
def test_client(mock_db):
    """FastAPI TestClient wired to the hermetic in-memory database and test JWT secret."""
    with patch.dict(
        "os.environ",
        {
            "SUPABASE_JWT_SECRET": JWT_TEST_SECRET,
            "ENV": "production",
            "ALLOW_DEV_AUTH_BYPASS": "false",
        },
    ):
        with TestClient(app) as client:
            yield client


# =====================================================================
# C1: Schema + Lossless Text + Canonical Dedup + Accept Invite
# =====================================================================

def test_c1_sql_static_contract_schema_and_types():
    """C1: SQL static contract: 11 tables, 7 enums, constraints, RPCs, and unbounded text."""
    sql_types = (MIGRATIONS_DIR / "0001_extensions_and_types.sql").read_text(encoding="utf-8")
    sql_tables = (MIGRATIONS_DIR / "0002_core_tables.sql").read_text(encoding="utf-8")
    sql_funcs = (MIGRATIONS_DIR / "0004_functions_and_triggers.sql").read_text(encoding="utf-8")

    # 1. Verify all 7 enums
    expected_enums = [
        "item_status",
        "enrich_status",
        "folder_role",
        "reminder_schedule_type",
        "reminder_status",
        "device_platform",
        "device_delivery_mode",
    ]
    for enum_name in expected_enums:
        assert f"type public.{enum_name} as enum" in sql_types

    # 2. Verify all 11 tables
    expected_tables = [
        "profiles",
        "folders",
        "folder_members",
        "folder_invites",
        "items",
        "tags",
        "item_tags",
        "reminders",
        "devices",
        "daily_ai_usage",
        "api_tokens",
    ]
    for table_name in expected_tables:
        assert f"table if not exists public.{table_name}" in sql_tables

    # 3. Verify core constraints
    assert "constraint uniq_owner_url unique (owner_id, url_hash)" in sql_tables
    assert "constraint chk_reminder_schedule_fields check" in sql_tables
    assert "jsonb_array_length(media_items) <= 5" in sql_tables

    # 4. Verify core functions
    assert "function public.accept_invite" in sql_funcs
    assert "function public.claim_due_reminders" in sql_funcs
    assert "function public.search_user_items" in sql_funcs

    # 5. Verify unbounded text for items text columns (NO varchar limits)
    items_block = sql_tables.split("create table if not exists public.items")[1].split(");")[0]
    for field in ("title", "description", "note", "ai_summary"):
        pattern = rf"{field}\s+text\b"
        assert re.search(pattern, items_block) is not None
        assert f"{field} varchar" not in items_block


def test_c1_item_creation_immediate_pending_status(test_client, mock_db):
    """C1: POST /api/items persists immediately with enrich_status='pending' without network delay."""
    headers = make_auth_headers("usr-c1-immediate")
    payload = {
        "url": "https://example.com/fast-save",
        "title": "Immediate Title",
        "description": "Immediate Description",
    }
    resp = test_client.post("/api/items", json=payload, headers=headers)
    assert resp.status_code == 201
    data = resp.json()
    assert data["enrich_status"] == "pending"
    assert data["enrich_attempts"] == 0
    assert data["url"] == "https://example.com/fast-save"
    assert data["owner_id"] == "usr-c1-immediate"
    assert data["deduplicated"] is False


def test_c1_lossless_text_preservation_long_content(test_client, mock_db):
    """C1: Item creation preserves long text verbatim (title > 500 chars, description > 3000 chars)."""
    headers = make_auth_headers("usr-c1-lossless")
    long_title = "หัวข้อขนาดยาวพิเศษ " * 35  # ~630 characters
    long_description = "เนื้อหารายละเอียดที่ยาวมากเพื่อทดสอบความสมบูรณ์แบบไม่ถูกตัดทอน " * 60  # ~3,800 characters
    assert len(long_title) > 500
    assert len(long_description) > 3000

    payload = {
        "url": "https://example.com/lossless-article",
        "title": long_title,
        "description": long_description,
        "note": "บันทึกช่วยจำ",
    }
    resp = test_client.post("/api/items", json=payload, headers=headers)
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == long_title.strip()
    assert data["description"] == long_description.strip()
    assert len(data["title"]) == len(long_title.strip())
    assert len(data["description"]) == len(long_description.strip())


def test_c1_canonical_url_deduplication_and_bump(test_client, mock_db):
    """C1: Canonical URL dedup matches tracking-param variant, bumps saved_at, and avoids duplicate row."""
    headers = make_auth_headers("usr-c1-dedup")

    # Step 1: Create base item
    clean_url = "https://example.com/news/tech-breakthrough"
    resp1 = test_client.post("/api/items", json={"url": clean_url, "title": "Base Title"}, headers=headers)
    assert resp1.status_code == 201
    item1 = resp1.json()
    assert item1["deduplicated"] is False
    assert len(mock_db.tables["items"]) == 1

    # Step 2: Post with noisy query parameters matching same canonical URL
    noisy_url = f"{clean_url}?utm_source=facebook&fbclid=AQD123xyz&ref=fb#section-comments"
    resp2 = test_client.post("/api/items", json={"url": noisy_url, "title": "Updated Title"}, headers=headers)
    assert resp2.status_code == 201
    item2 = resp2.json()

    assert item2["deduplicated"] is True
    assert item2["id"] == item1["id"]
    assert item2["title"] == "Updated Title"
    # Ensure no duplicate row was created in items table
    assert len(mock_db.tables["items"]) == 1


def test_c1_canonicalize_url_tracking_params_parity():
    """C1: canonicalize_url strips all SQL-tracked parameters, fragments, default ports, and sorts query."""
    tracking_keys = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "igshid",
        "igsh",
        "si",
        "ref",
        "ref_src",
        "ref_url",
        "yclid",
        "_ga",
        "_gl",
        "spm",
        "is_from_webapp",
        "sender_device",
    ]
    query_string = "&".join(f"{k}=val_{i}" for i, k in enumerate(tracking_keys))
    full_url = f"https://example.com:443/docs/guide/?{query_string}&b_param=2&a_param=1#intro"

    canonical = canonicalize_url(full_url)
    assert canonical == "https://example.com/docs/guide?a_param=1&b_param=2"

    http_url = "http://my-blog.org:80/posts/?utm_source=x#bottom"
    assert canonicalize_url(http_url) == "http://my-blog.org/posts"


# =====================================================================
# C2: RLS & Tenant Isolation (Static Audit + Permissions Matrix)
# =====================================================================

def test_c2_sql_static_audit_rls_and_initplan_optimization():
    """C2: Audit 0005_rls_policies.sql: RLS enabled on all 11 tables, 0 bare auth.uid(), security definer helper."""
    sql_rls = (MIGRATIONS_DIR / "0005_rls_policies.sql").read_text(encoding="utf-8")
    sql_funcs = (MIGRATIONS_DIR / "0004_functions_and_triggers.sql").read_text(encoding="utf-8")

    # 1. RLS enabled on all 11 tables
    expected_tables = [
        "profiles",
        "folders",
        "folder_members",
        "folder_invites",
        "items",
        "tags",
        "item_tags",
        "reminders",
        "devices",
        "daily_ai_usage",
        "api_tokens",
    ]
    for table_name in expected_tables:
        assert f"alter table public.{table_name} enable row level security;" in sql_rls

    # 2. Zero bare auth.uid() occurrences (every auth.uid() must be inside (select auth.uid()))
    bare_uid_pattern = re.compile(r"(?<!\(select\s)auth\.uid\(\)")
    bare_matches = bare_uid_pattern.findall(sql_rls)
    assert len(bare_matches) == 0, f"Found bare auth.uid() occurrences in RLS: {bare_matches}"
    assert sql_rls.count("auth.uid()") == sql_rls.count("(select auth.uid())")

    # 3. Verify private.can_access_folder and cancel_reminders_on_item_done use security definer
    assert "function private.can_access_folder" in sql_funcs
    func_block = sql_funcs.split("function private.can_access_folder")[1].split("$$;")[0]
    assert "security definer" in func_block.lower()

    assert "function private.cancel_reminders_on_item_done" in sql_funcs
    cancel_block = sql_funcs.split("function private.cancel_reminders_on_item_done")[1].split("$$;")[0]
    assert "security definer" in cancel_block.lower()

    # 4. Security guards & atomic invite RPC
    assert "function private.guard_profile_tier" in sql_funcs
    assert "trg_profiles_guard_tier" in sql_funcs
    assert "function private.guard_item_ownership" in sql_funcs
    assert "trg_items_guard_ownership" in sql_funcs
    assert "function public.accept_invite_for_user" in sql_funcs
    assert "for update" in sql_funcs.split("function public.accept_invite_for_user")[1].split("$$;")[0].lower()

    # 5. Tightened items_update RLS WITH CHECK prevents editor ownership/folder hijack
    items_update_block = sql_rls.split("create policy items_update on public.items")[1].split(";")[0].lower()
    assert "with check" in items_update_block
    assert "private.can_access_folder(folder_id, 'editor')" in items_update_block


def test_c2_tenant_isolation_private_items_access(test_client, mock_db):
    """C2: User B cannot GET, PATCH, or DELETE User A's private item (403 Forbidden)."""
    headers_user_a = make_auth_headers("usr-a")
    headers_user_b = make_auth_headers("usr-b")

    # User A creates a private item
    res_create = test_client.post(
        "/api/items",
        json={"url": "https://example.com/private-doc", "title": "User A Private"},
        headers=headers_user_a,
    )
    assert res_create.status_code == 201
    item_id = res_create.json()["id"]

    # User B attempts GET
    res_get = test_client.get(f"/api/items/{item_id}", headers=headers_user_b)
    assert res_get.status_code == 403

    # User B attempts PATCH
    res_patch = test_client.patch(
        f"/api/items/{item_id}",
        json={"title": "Hacked Title"},
        headers=headers_user_b,
    )
    assert res_patch.status_code == 403

    # Assert User B deletion attempt is rejected with 403 Forbidden
    res_delete = test_client.delete(f"/api/items/{item_id}", headers=headers_user_b)
    assert res_delete.status_code == 403


def test_c2_invite_acceptance_expired_revoked_overlimit(test_client, mock_db):
    """C2: Invite acceptance rejects expired, revoked, and over-max_uses invites with 410 Gone."""
    headers_owner = make_auth_headers("usr-folder-owner")
    headers_user_b = make_auth_headers("usr-joiner")

    # Create folder
    res_f = test_client.post("/api/folders", json={"name": "Shared Folder"}, headers=headers_owner)
    folder_id = res_f.json()["id"]

    # Case 1: Expired invite
    past_iso = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    mock_db.tables["folder_invites"].append({
        "token": "tok-expired",
        "folder_id": folder_id,
        "role": "viewer",
        "created_by": "usr-folder-owner",
        "max_uses": None,
        "use_count": 0,
        "revoked_at": None,
        "expires_at": past_iso,
    })
    res_exp = test_client.post("/api/invites/tok-expired/accept", headers=headers_user_b)
    assert res_exp.status_code == 410
    assert "expired" in res_exp.json()["detail"].lower()

    # Case 2: Revoked invite
    mock_db.tables["folder_invites"].append({
        "token": "tok-revoked",
        "folder_id": folder_id,
        "role": "editor",
        "created_by": "usr-folder-owner",
        "max_uses": None,
        "use_count": 0,
        "revoked_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=5)).isoformat(),
    })
    res_rev = test_client.post("/api/invites/tok-revoked/accept", headers=headers_user_b)
    assert res_rev.status_code == 410
    assert "revoked" in res_rev.json()["detail"].lower()

    # Case 3: Over max uses
    mock_db.tables["folder_invites"].append({
        "token": "tok-limit",
        "folder_id": folder_id,
        "role": "editor",
        "created_by": "usr-folder-owner",
        "max_uses": 2,
        "use_count": 2,
        "revoked_at": None,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=5)).isoformat(),
    })
    res_lim = test_client.post("/api/invites/tok-limit/accept", headers=headers_user_b)
    assert res_lim.status_code == 410
    assert "limit" in res_lim.json()["detail"].lower()

    # Case 4: Valid invite acceptance creates folder_members row & increments use_count
    mock_db.tables["folder_invites"].append({
        "token": "tok-valid-join",
        "folder_id": folder_id,
        "role": "editor",
        "created_by": "usr-folder-owner",
        "max_uses": 3,
        "use_count": 0,
        "revoked_at": None,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=5)).isoformat(),
    })
    res_ok = test_client.post("/api/invites/tok-valid-join/accept", headers=headers_user_b)
    assert res_ok.status_code == 200
    assert res_ok.json()["role"] == "editor"
    assert mock_db.tables["folder_invites"][-1]["use_count"] == 1
    assert any(
        m["folder_id"] == folder_id and m["user_id"] == "usr-joiner" and m["role"] == "editor"
        for m in mock_db.tables["folder_members"]
    )


def test_c2_shared_folder_role_permissions_matrix(test_client, mock_db):
    """C2: Shared folder permissions: viewer can GET but NOT PATCH/DELETE; editor can PATCH but NOT DELETE."""
    headers_owner = make_auth_headers("usr-owner")
    headers_viewer = make_auth_headers("usr-viewer")
    headers_editor = make_auth_headers("usr-editor")

    # Setup folder and memberships
    folder = {
        "id": "f-matrix",
        "owner_id": "usr-owner",
        "name": "Team Folder",
        "is_shared": True,
    }
    mock_db.tables["folders"].append(folder)
    mock_db.tables["folder_members"].extend([
        {"folder_id": "f-matrix", "user_id": "usr-viewer", "role": "viewer"},
        {"folder_id": "f-matrix", "user_id": "usr-editor", "role": "editor"},
    ])

    # Owner creates item inside the folder
    item = {
        "id": "it-matrix",
        "owner_id": "usr-owner",
        "folder_id": "f-matrix",
        "url": "https://example.com/team-doc",
        "title": "Team Document",
        "status": "inbox",
    }
    mock_db.tables["items"].append(item)

    # 1. Viewer tests
    # Viewer can GET
    res_v_get = test_client.get("/api/items/it-matrix", headers=headers_viewer)
    assert res_v_get.status_code == 200
    assert res_v_get.json()["title"] == "Team Document"

    # Viewer CANNOT PATCH (403)
    res_v_patch = test_client.patch("/api/items/it-matrix", json={"title": "Viewer Edit"}, headers=headers_viewer)
    assert res_v_patch.status_code == 403

    # Viewer CANNOT DELETE (403)
    res_v_del = test_client.delete("/api/items/it-matrix", headers=headers_viewer)
    assert res_v_del.status_code == 403

    # 2. Editor tests
    # Editor can PATCH (200)
    res_e_patch = test_client.patch("/api/items/it-matrix", json={"title": "Editor Edit"}, headers=headers_editor)
    assert res_e_patch.status_code == 200
    assert res_e_patch.json()["title"] == "Editor Edit"

    # Editor CANNOT move owner's item across folders (403)
    mock_db.tables["folders"].append({"id": "f-other-owned", "owner_id": "usr-editor", "name": "Editor Own", "is_shared": False})
    res_e_move = test_client.patch("/api/items/it-matrix", json={"folder_id": "f-other-owned"}, headers=headers_editor)
    assert res_e_move.status_code == 403

    # Editor CANNOT DELETE (403 - only owner can delete item)
    res_e_del = test_client.delete("/api/items/it-matrix", headers=headers_editor)
    assert res_e_del.status_code == 403


# =====================================================================
# C3: Auth Security Fix (RISK-001) & Auth Router
# =====================================================================

def test_c3_jwt_validation_tampered_expired_wrong_audience(test_client):
    """C3: Validate JWT security (RISK-001): tampered signature, expired, wrong audience, and UUID tokens fail (401)."""
    # 1. Tampered signature
    tampered_token = make_jwt("usr-hacker", secret="wrong-secret-key-12345678901234567890")
    resp_tampered = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {tampered_token}"})
    assert resp_tampered.status_code == 401

    # 2. Assert expired token returns 401
    expired_token = make_jwt("usr-expired", exp_offset_sec=-120)
    resp_expired = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
    assert resp_expired.status_code == 401

    # 3. Wrong audience
    wrong_aud_token = make_jwt("usr-wrong-aud", aud="anon")
    resp_aud = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {wrong_aud_token}"})
    assert resp_aud.status_code == 401

    # 4. Raw UUID bearer token (must NOT be accepted as a valid bearer token)
    raw_uuid = str(uuid.uuid4())
    resp_uuid = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {raw_uuid}"})
    assert resp_uuid.status_code == 401


def test_c3_x_user_id_dev_bypass_flag_matrix(test_client):
    """C3: X-User-Id accepted ONLY when BOTH ENV=development and ALLOW_DEV_AUTH_BYPASS=true."""
    # Assert production mode rejects dev header bypass
    with patch.dict("os.environ", {"ENV": "production", "ALLOW_DEV_AUTH_BYPASS": "false"}):
        res = test_client.get("/api/auth/me", headers={"X-User-Id": "usr-bypass"})
        assert res.status_code == 401

    # Production mode with bypass=true (ENV mismatch -> 401)
    with patch.dict("os.environ", {"ENV": "production", "ALLOW_DEV_AUTH_BYPASS": "true"}):
        res = test_client.get("/api/auth/me", headers={"X-User-Id": "usr-bypass"})
        assert res.status_code == 401

    # Development mode with bypass=false (Bypass mismatch -> 401)
    with patch.dict("os.environ", {"ENV": "development", "ALLOW_DEV_AUTH_BYPASS": "false"}):
        res = test_client.get("/api/auth/me", headers={"X-User-Id": "usr-bypass"})
        assert res.status_code == 401

    # Development mode AND bypass=true (Allowed -> 200)
    with patch.dict("os.environ", {"ENV": "development", "ALLOW_DEV_AUTH_BYPASS": "true"}):
        res = test_client.get("/api/auth/me", headers={"X-User-Id": "usr-bypass"})
        assert res.status_code == 200
        assert res.json()["user_id"] == "usr-bypass"


def test_c3_auth_router_me_quota_and_profile_timezone(test_client, mock_db):
    """C3: GET /api/auth/me returns profile + quota; PATCH /profile validates IANA timezone."""
    headers = make_auth_headers("usr-profile-test")

    # 1. GET /api/auth/me exposes quota
    mock_db.tables["profiles"].append({
        "id": "usr-profile-test",
        "display_name": "Initial Name",
        "tier": "free",
        "preferred_summary_language": "th",
        "default_timezone": "Asia/Bangkok",
    })
    mock_db.tables["daily_ai_usage"].append({
        "user_id": "usr-profile-test",
        "usage_month": datetime.now(timezone.utc).strftime("%Y-%m"),
        "request_count": 12,
    })

    res_me = test_client.get("/api/auth/me", headers=headers)
    assert res_me.status_code == 200
    data_me = res_me.json()
    assert data_me["user_id"] == "usr-profile-test"
    assert data_me["ai_quota"]["used"] == 12
    assert data_me["ai_quota"]["limit"] == 50
    assert data_me["ai_quota"]["remaining"] == 38

    # 2. PATCH /api/auth/profile with valid timezone
    res_patch = test_client.patch(
        "/api/auth/profile",
        json={"preferred_summary_language": "en", "default_timezone": "America/New_York"},
        headers=headers,
    )
    assert res_patch.status_code == 200
    assert res_patch.json()["profile"]["default_timezone"] == "America/New_York"
    assert res_patch.json()["profile"]["preferred_summary_language"] == "en"

    # 3. PATCH /api/auth/profile with invalid timezone (422)
    res_invalid_tz = test_client.patch(
        "/api/auth/profile",
        json={"default_timezone": "Mars/Olympus_Mons"},
        headers=headers,
    )
    assert res_invalid_tz.status_code == 422


def test_c3_api_tokens_hashing_and_revocation_lifecycle(test_client, mock_db):
    """C3: POST /tokens returns raw token once and stores SHA-256; DELETE revokes it."""
    headers = make_auth_headers("usr-token-lifecycle")

    # 1. Create token
    res_create = test_client.post("/api/auth/tokens", json={"name": "Cursor Integration"}, headers=headers)
    assert res_create.status_code == 201
    tok_data = res_create.json()
    raw_token = tok_data["token"]
    tok_id = tok_data["id"]
    assert raw_token.startswith("jsi_live_")

    # Verify DB stores ONLY SHA-256 hash, not raw token
    expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    assert len(mock_db.tables["api_tokens"]) == 1
    db_row = mock_db.tables["api_tokens"][0]
    assert db_row["token_hash"] == expected_hash
    assert "token" not in db_row

    # 2. GET /tokens omits token_hash
    res_list = test_client.get("/api/auth/tokens", headers=headers)
    assert res_list.status_code == 200
    tokens_list = res_list.json()["tokens"]
    assert len(tokens_list) == 1
    assert "token_hash" not in tokens_list[0]
    assert tokens_list[0]["token_prefix"] == raw_token[:16]

    # Verify token resolves successfully before revocation
    resolved_uid = verify_mcp_token(raw_token, db=mock_db)
    assert resolved_uid == "usr-token-lifecycle"

    # 3. DELETE /tokens/{id} revokes token
    res_del = test_client.delete(f"/api/auth/tokens/{tok_id}", headers=headers)
    assert res_del.status_code == 200
    assert res_del.json()["revoked"] is True

    # After revocation, verify_mcp_token must raise PermissionError
    with pytest.raises(PermissionError, match="revoked"):
        verify_mcp_token(raw_token, db=mock_db)


# =====================================================================
# C4: Multi-Language & Zero-Mojibake Byte Decoding
# =====================================================================

def test_c4_legacy_charset_byte_decoding_fixtures():
    """C4: Accurately decode raw bytes in TIS-620, Windows-874, Shift_JIS, GBK, UTF-8 ZWJ, and HTML entities."""
    # 1. Thai TIS-620 with tone marks
    thai_text = "การทดสอบภาษาไทย มอก. 620 พร้อมวรรณยุกต์ ่ ้ ๊ ๋ ั ิ"
    thai_bytes = thai_text.encode("cp874")
    decoded_thai = decode_html_bytes(thai_bytes, content_type="text/html; charset=tis-620")
    assert decoded_thai == thai_text

    # 2. Windows-874 smart quotes (0x93 = “, 0x94 = ”)
    cp874_smart_bytes = b"\x93\xa1\xd2\xc3\xb7\xb4\xca\xcd\xba\x94"
    decoded_cp874 = decode_html_bytes(cp874_smart_bytes, content_type="text/html; charset=windows-874")
    assert decoded_cp874 == "“การทดสอบ”"

    # 3. Japanese Shift_JIS
    jp_text = "日本語のコンテンツ文字化けなしテスト"
    jp_bytes = jp_text.encode("shift_jis")
    decoded_jp = decode_html_bytes(jp_bytes, content_type="text/html; charset=shift_jis")
    assert decoded_jp == jp_text

    # 4. Chinese GBK
    zh_text = "简体中文网页内容解析测试"
    zh_bytes = zh_text.encode("gbk")
    decoded_zh = decode_html_bytes(zh_bytes, content_type="text/html; charset=gbk")
    assert decoded_zh == zh_text

    # 5. UTF-8 Emoji ZWJ sequence & RTL Arabic
    complex_text = "👨‍👩‍👧‍👦 สรุปข่าวเทคโนโลยี 🚀 مرحبا بالعالم"
    complex_bytes = complex_text.encode("utf-8")
    decoded_complex = decode_html_bytes(complex_bytes, content_type="text/html; charset=utf-8")
    assert decoded_complex == complex_text

    # 6. HTML Entity normalization
    raw_html_entities = "&amp; &#3652;&#3607;&#3618; &lt;b&gt;bold&lt;/b&gt;"
    normalized = normalize_unicode_text(raw_html_entities, unescape_html=True)
    assert normalized == "& ไทย <b>bold</b>"


def test_c4_apache_iso_8859_1_header_override_via_meta_charset():
    """C4: Misconfigured Apache ISO-8859-1 Content-Type header overridden by 4KB <meta charset='tis-620'>."""
    thai_content = "ข่าวเด่นประจำวันภาษาไทย"
    html_markup = (
        f'<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=tis-620">'
        f"<title>ทดสอบ</title></head><body><p>{thai_content}</p></body></html>"
    )
    raw_bytes = html_markup.encode("cp874")

    # Pass the misleading Apache header
    decoded = decode_html_bytes(raw_bytes, content_type="text/html; charset=iso-8859-1")
    assert thai_content in decoded
    assert "ข่าวเด่นประจำวัน" in decoded


# =====================================================================
# C5: Fast Multi-Language Search across 4 Fields & Shared Folders
# =====================================================================

def test_c5_sql_static_audit_search_indexes():
    """C5: Audit 0003_indexes.sql for FTS 'simple' index, pg_trgm indexes, and foreign key indexes."""
    sql_indexes = (MIGRATIONS_DIR / "0003_indexes.sql").read_text(encoding="utf-8")

    # 1. Full-text search and pg_trgm indexes
    assert "create index if not exists items_tsv_idx\n  on public.items using gin (search_tsv);" in sql_indexes
    assert "create index if not exists items_title_trgm_idx\n  on public.items using gin (title gin_trgm_ops);" in sql_indexes
    assert "create index if not exists items_4field_trgm_idx" in sql_indexes
    assert "gin_trgm_ops" in sql_indexes

    # 2. FK indexes coverage
    fk_indexes = [
        "folders_owner_idx",
        "folder_members_user_idx",
        "folder_invites_folder_idx",
        "folder_invites_created_by_idx",
        "tags_owner_idx",
        "item_tags_tag_idx",
        "reminders_item_idx",
        "reminders_user_idx",
        "devices_user_idx",
        "api_tokens_user_idx",
    ]
    for idx_name in fk_indexes:
        assert f"create index if not exists {idx_name}" in sql_indexes


def test_c5_multi_language_4fields_search_and_filters(test_client, mock_db):
    """C5: Search finds unsegmented Thai, Japanese, and English across all 4 text fields with filters."""
    headers = make_auth_headers("usr-c5-search")

    # Seed items with distinct languages in distinct fields
    mock_db.tables["items"].extend([
        {
            "id": "it-thai-title",
            "owner_id": "usr-c5-search",
            "url": "https://example.com/item1",
            "title": "การเขียนโปรแกรมเชิงวัตถุ",
            "description": "General article",
            "note": "My note",
            "ai_summary": "สรุปสั้น",
            "status": "inbox",
            "platform": "medium",
            "content_type": "article",
            "saved_at": "2026-11-13T10:00:00Z",
        },
        {
            "id": "it-jp-desc",
            "owner_id": "usr-c5-search",
            "url": "https://example.com/item2",
            "title": "Japanese Technology",
            "description": "深層学習アルゴリズムの解説",
            "note": "Read later",
            "ai_summary": "AI summary",
            "status": "todo",
            "platform": "youtube",
            "content_type": "video",
            "saved_at": "2026-11-13T11:00:00Z",
        },
        {
            "id": "it-en-note",
            "owner_id": "usr-c5-search",
            "url": "https://example.com/item3",
            "title": "Database Optimization",
            "description": "Postgres indexing",
            "note": "Critical architectural considerations for production",
            "ai_summary": "DB summary",
            "status": "done",
            "platform": "github",
            "content_type": "link",
            "saved_at": "2026-11-13T12:00:00Z",
        },
        {
            "id": "it-summary-match",
            "owner_id": "usr-c5-search",
            "url": "https://example.com/item4",
            "title": "Microservices",
            "description": "Distributed systems",
            "note": "Docker notes",
            "ai_summary": "• คลัสเตอร์ระบบคลาวด์เนทีฟที่ปลอดภัย",
            "status": "inbox",
            "platform": "web",
            "content_type": "article",
            "saved_at": "2026-11-13T13:00:00Z",
        },
    ])

    # 1. Unsegmented Thai search
    res_thai = test_client.get("/api/items?q=เชิงวัตถุ", headers=headers)
    assert res_thai.status_code == 200
    assert len(res_thai.json()["items"]) == 1
    assert res_thai.json()["items"][0]["id"] == "it-thai-title"

    # 2. Japanese unsegmented search in description
    res_jp = test_client.get("/api/items?q=深層学習", headers=headers)
    assert res_jp.status_code == 200
    assert len(res_jp.json()["items"]) == 1
    assert res_jp.json()["items"][0]["id"] == "it-jp-desc"

    # 3. English substring search in note
    res_en = test_client.get("/api/items?q=architectural", headers=headers)
    assert res_en.status_code == 200
    assert len(res_en.json()["items"]) == 1
    assert res_en.json()["items"][0]["id"] == "it-en-note"

    # 4. Search in ai_summary
    res_sum = test_client.get("/api/items?q=คลัสเตอร์", headers=headers)
    assert res_sum.status_code == 200
    assert len(res_sum.json()["items"]) == 1
    assert res_sum.json()["items"][0]["id"] == "it-summary-match"

    # Verify multi-parameter query filtering on status and platform
    res_filt = test_client.get("/api/items?status=todo&platform=youtube", headers=headers)
    assert res_filt.status_code == 200
    assert len(res_filt.json()["items"]) == 1
    assert res_filt.json()["items"][0]["id"] == "it-jp-desc"


def test_c5_search_includes_shared_folder_items(test_client, mock_db):
    """C5: Search results include accessible items from shared folders where user has viewer or editor membership."""
    headers_user_b = make_auth_headers("usr-b-search")

    # Shared folder owned by User A
    mock_db.tables["folders"].append({
        "id": "f-collab-1",
        "owner_id": "usr-a",
        "name": "Collaborative Research",
        "is_shared": True,
    })
    mock_db.tables["folder_members"].append({
        "folder_id": "f-collab-1",
        "user_id": "usr-b-search",
        "role": "viewer",
    })

    # Item in shared folder
    mock_db.tables["items"].append({
        "id": "it-collab-item",
        "owner_id": "usr-a",
        "folder_id": "f-collab-1",
        "url": "https://example.com/quantum-paper",
        "title": "Quantum Computing Breakthrough",
        "description": "Qubit entanglement research",
        "note": "Shared with team",
        "ai_summary": "สรุปวิจัยควอนตัม",
        "status": "inbox",
        "saved_at": "2026-11-13T12:00:00Z",
    })

    res = test_client.get("/api/items?q=Quantum", headers=headers_user_b)
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == "it-collab-item"


# =====================================================================
# C6: Configurable AI Language & Backward Compatibility
# =====================================================================

@pytest.mark.asyncio
async def test_c6_ai_language_options_and_profile_fallback():
    """C6: Test summary_language ('en', 'auto', profile fallback) and summary_th backward compat."""
    db = InMemoryDB()

    # User profile with default language 'en'
    db.tables["profiles"].append({
        "id": "usr-c6",
        "preferred_summary_language": "en",
    })
    db.tables["items"].append({
        "id": "it-c6-1",
        "owner_id": "usr-c6",
        "url": "https://example.com/c6-doc",
        "title": "English Document",
        "description": "About distributed architectures",
        "ai_summary": None,
        "note": "",
    })

    mock_llm_out = AISummaryOutput(
        summary_th="• Distributed system overview\n• Consensus protocols\n• Fault tolerance",
        suggested_tags=["Architecture", "Backend"],
        content_type="article",
    )

    with patch("Ai.summarizer_service.extract_text_for_ai", new=AsyncMock(return_value="Extracted content")):
        with patch("Ai.summarizer_service.generate_structured_summary", new=AsyncMock(return_value=(mock_llm_out, "built-in:gemini-flash"))) as mock_gen:
            # 1. Profile fallback resolution
            req = SummarizeRequest(item_id="it-c6-1", summary_language=None)
            resp = await summarize_item_once(db=db, user_id="usr-c6", req=req)

            assert resp.summary_language == "en"
            # Verify backward compatibility field summary_th is populated with the summary text
            assert resp.summary_th == mock_llm_out.summary_th
            assert mock_gen.call_args[1].get("summary_language") == "en"

            # Verify persisted in DB
            saved_row = db.tables["items"][0]
            assert saved_row["ai_summary"] == mock_llm_out.summary_th
            assert saved_row["ai_summary_language"] == "en"


# =====================================================================
# C7: Cross-OS Hybrid Reminder Persistence Ready
# =====================================================================

def test_c7_sql_static_audit_reminders_and_devices():
    """C7: Audit 0002_core_tables.sql & 0004 for reminders schedule columns, triggers, claim RPC, and devices."""
    sql_tables = (MIGRATIONS_DIR / "0002_core_tables.sql").read_text(encoding="utf-8")
    sql_funcs = (MIGRATIONS_DIR / "0004_functions_and_triggers.sql").read_text(encoding="utf-8")

    # 1. Reminders table check constraint
    assert "constraint chk_reminder_schedule_fields check (" in sql_tables
    assert "(schedule_type = 'once' and repeat_every_days is null)" in sql_tables
    assert "(schedule_type = 'every_n_days' and repeat_every_days between 1 and 365 and remind_time is not null)" in sql_tables

    # 2. Trigger auto-cancelling reminders on item done
    assert "trigger trg_items_cancel_reminders" in sql_funcs
    assert "cancel_reminders_on_item_done" in sql_funcs

    # 3. claim_due_reminders permissions & for update skip locked
    assert "create or replace function public.claim_due_reminders" in sql_funcs
    assert "for update skip locked" in sql_funcs
    assert "revoke all on function public.claim_due_reminders(int) from PUBLIC, anon, authenticated;" in sql_funcs
    assert "grant execute on function public.claim_due_reminders(int) to service_role;" in sql_funcs

    # 4. Devices delivery mode & nullable unique push_token
    assert "delivery_mode public.device_delivery_mode not null default 'remote'" in sql_tables
    assert "push_token    text unique" in sql_tables


def test_c7_reminder_once_and_every_n_days_crud(test_client, mock_db):
    """C7: Save item with 'once' and recurring 'every_n_days' reminders and verify persistence."""
    headers = make_auth_headers("usr-c7-rem")

    # 1. Schedule once
    future_iso = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    payload_once = {
        "url": "https://example.com/reminder-once",
        "title": "Buy concert tickets",
        "reminder": {
            "schedule_type": "once",
            "remind_at": future_iso,
            "timezone": "Asia/Bangkok",
        },
    }
    res_once = test_client.post("/api/items", json=payload_once, headers=headers)
    assert res_once.status_code == 201
    item_once = res_once.json()
    assert "reminder" in item_once
    assert item_once["reminder"]["schedule_type"] == "once"
    assert item_once["reminder"]["status"] == "pending"

    # 2. Schedule recurring every_n_days
    payload_rec = {
        "url": "https://example.com/reminder-recurring",
        "title": "Review investment portfolio",
        "reminder": {
            "schedule_type": "every_n_days",
            "repeat_every_days": 3,
            "remind_time": "20:00",
            "timezone": "Asia/Bangkok",
        },
    }
    res_rec = test_client.post("/api/items", json=payload_rec, headers=headers)
    assert res_rec.status_code == 201
    item_rec = res_rec.json()
    assert item_rec["reminder"]["schedule_type"] == "every_n_days"
    assert item_rec["reminder"]["repeat_every_days"] == 3
    assert item_rec["reminder"]["remind_time"] == "20:00:00"


def test_c7_reminder_boundary_validation_rejections(test_client):
    """C7: Validate reminder constraints (repeat_every_days bounds, missing time, invalid timezone) return 422."""
    headers = make_auth_headers("usr-c7-boundary")

    # repeat_every_days = 0 (< 1) -> 422
    res_0 = test_client.post(
        "/api/items",
        json={
            "url": "https://example.com/b0",
            "reminder": {"schedule_type": "every_n_days", "repeat_every_days": 0, "remind_time": "10:00"},
        },
        headers=headers,
    )
    assert res_0.status_code == 422

    # repeat_every_days = 366 (> 365) -> 422
    res_366 = test_client.post(
        "/api/items",
        json={
            "url": "https://example.com/b366",
            "reminder": {"schedule_type": "every_n_days", "repeat_every_days": 366, "remind_time": "10:00"},
        },
        headers=headers,
    )
    assert res_366.status_code == 422

    # Missing remind_time for every_n_days -> 422
    res_no_time = test_client.post(
        "/api/items",
        json={
            "url": "https://example.com/b-notime",
            "reminder": {"schedule_type": "every_n_days", "repeat_every_days": 7},
        },
        headers=headers,
    )
    assert res_no_time.status_code == 422

    # Invalid IANA timezone -> 422
    res_bad_tz = test_client.post(
        "/api/items",
        json={
            "url": "https://example.com/b-badtz",
            "reminder": {
                "schedule_type": "once",
                "remind_at": "2026-11-30T10:00:00Z",
                "timezone": "Invalid/Fake_Zone",
            },
        },
        headers=headers,
    )
    assert res_bad_tz.status_code == 422


def test_c7_status_done_auto_cancels_pending_reminders(test_client, mock_db):
    """C7: Transitioning item status to 'done' auto-cancels pending reminders."""
    headers = make_auth_headers("usr-c7-cancel")

    res_item = test_client.post(
        "/api/items",
        json={
            "url": "https://example.com/task-with-reminder",
            "title": "Complete taxes",
            "reminder": {
                "schedule_type": "once",
                "remind_at": "2026-12-31T18:00:00Z",
            },
        },
        headers=headers,
    )
    assert res_item.status_code == 201
    item_id = res_item.json()["id"]

    # Verify reminder is pending in DB
    rem_before = [r for r in mock_db.tables["reminders"] if r["item_id"] == item_id][0]
    assert rem_before["status"] == "pending"

    # Update item status to done triggering reminder cancellation
    res_done = test_client.patch(f"/api/items/{item_id}", json={"status": "done"}, headers=headers)
    assert res_done.status_code == 200
    assert res_done.json()["status"] == "done"

    # Verify reminder status transitioned to cancelled
    rem_after = [r for r in mock_db.tables["reminders"] if r["item_id"] == item_id][0]
    assert rem_after["status"] == "cancelled"


def test_c7_device_registration_ios_local_sync_and_android_remote(test_client, mock_db):
    """C7: Register devices: iOS local_sync accepts null push_token; Android remote requires push_token."""
    headers = make_auth_headers("usr-c7-device")

    # 1. iOS with local_sync (pre-APNs, push_token is None) -> 201
    res_ios = test_client.post(
        "/api/devices",
        json={"platform": "ios", "delivery_mode": "local_sync", "push_token": None},
        headers=headers,
    )
    assert res_ios.status_code == 201
    assert res_ios.json()["delivery_mode"] == "local_sync"
    assert res_ios.json()["push_token"] is None

    # 2. Android remote without push_token -> 422
    res_android_fail = test_client.post(
        "/api/devices",
        json={"platform": "android", "delivery_mode": "remote", "push_token": None},
        headers=headers,
    )
    assert res_android_fail.status_code == 422

    # 3. Android remote with valid push_token -> 201
    res_android_ok = test_client.post(
        "/api/devices",
        json={
            "platform": "android",
            "delivery_mode": "remote",
            "push_token": "fcm_token_valid_1234567890",
        },
        headers=headers,
    )
    assert res_android_ok.status_code == 201
    assert res_android_ok.json()["push_token"] == "fcm_token_valid_1234567890"

    # Another user trying to hijack the same push_token gets 409 Conflict
    headers_thief = make_auth_headers("usr-thief")
    res_hijack = test_client.post(
        "/api/devices",
        json={
            "platform": "android",
            "delivery_mode": "remote",
            "push_token": "fcm_token_valid_1234567890",
        },
        headers=headers_thief,
    )
    assert res_hijack.status_code == 409


# =====================================================================
# C8: JSON Export & Sanitization
# =====================================================================

def test_c8_export_user_data_complete_and_sanitized(test_client, mock_db):
    """C8: GET /api/export returns complete user data bundle and strictly omits secret hashes."""
    headers = make_auth_headers("usr-c8-export")
    user_id = "usr-c8-export"

    # Seed comprehensive user-owned data
    mock_db.tables["profiles"].append({
        "id": user_id,
        "display_name": "Export User",
        "avatar_url": "https://example.com/avatar.png",
        "tier": "pro",
    })
    mock_db.tables["folders"].append({
        "id": "f-exp-1",
        "owner_id": user_id,
        "name": "Export Folder",
        "emoji": "📦",
    })
    mock_db.tables["tags"].append({
        "id": "tag-exp-1",
        "owner_id": user_id,
        "name": "Research",
        "color": "#3B82F6",
    })
    mock_db.tables["items"].append({
        "id": "it-exp-1",
        "owner_id": user_id,
        "folder_id": "f-exp-1",
        "url": "https://example.com/export-item",
        "title": "Exportable Article",
        "description": "Article details",
        "note": "Personal note",
        "status": "inbox",
        "saved_at": "2026-11-13T10:00:00Z",
    })
    mock_db.tables["item_tags"].append({
        "item_id": "it-exp-1",
        "tag_id": "tag-exp-1",
    })
    mock_db.tables["reminders"].append({
        "id": "rem-exp-1",
        "item_id": "it-exp-1",
        "user_id": user_id,
        "schedule_type": "once",
        "remind_at": "2026-12-01T12:00:00Z",
        "status": "pending",
    })
    mock_db.tables["devices"].append({
        "id": "dev-exp-1",
        "user_id": user_id,
        "platform": "ios",
        "delivery_mode": "local_sync",
        "push_token": None,
    })
    mock_db.tables["api_tokens"].append({
        "id": "tok-exp-1",
        "user_id": user_id,
        "token_hash": "sha256_super_sensitive_token_hash_do_not_leak",
        "token_prefix": "jsi_live_12345678",
        "name": "Work Laptop",
        "created_at": "2026-11-13T09:00:00Z",
    })

    # Call export endpoint
    res = test_client.get("/api/export", headers=headers)
    assert res.status_code == 200
    bundle = res.json()

    # Validate structure
    assert bundle["schema_version"] == "1.0"
    assert bundle["user_id"] == user_id
    assert bundle["profile"]["display_name"] == "Export User"
    assert len(bundle["folders"]) == 1
    assert len(bundle["tags"]) == 1
    assert len(bundle["items"]) == 1
    assert bundle["items"][0]["tags"] == ["Research"]
    assert len(bundle["reminders"]) == 1
    assert len(bundle["devices"]) == 1

    # Validate token sanitization (CRITICAL SECURITY INVARIANT)
    assert len(bundle["api_tokens"]) == 1
    exported_token = bundle["api_tokens"][0]
    assert exported_token["name"] == "Work Laptop"
    assert exported_token["token_prefix"] == "jsi_live_12345678"
    assert "token_hash" not in exported_token
    assert "token" not in exported_token


def test_c2_delete_my_account_cascades_all_user_data(mock_db, test_client):
    """C2: DELETE /api/auth/me deletes all user rows cleanly without touching other tenants."""
    victim = "usr-del-me"
    bystander = "usr-stay"
    headers = make_auth_headers(victim)

    mock_db.tables["profiles"].extend([{"id": victim}, {"id": bystander}])
    mock_db.tables["folders"].extend([
        {"id": "f-v", "owner_id": victim, "name": "Mine"},
        {"id": "f-b", "owner_id": bystander, "name": "Other"},
    ])
    mock_db.tables["items"].extend([
        {"id": "it-v", "owner_id": victim, "folder_id": "f-v", "url": "https://a.com", "title": "A"},
        {"id": "it-b", "owner_id": bystander, "folder_id": "f-b", "url": "https://b.com", "title": "B"},
    ])
    mock_db.tables["tags"].append({"id": "tag-v", "owner_id": victim, "name": "Temp"})
    mock_db.tables["item_tags"].append({"item_id": "it-v", "tag_id": "tag-v"})
    mock_db.tables["reminders"].append({"id": "rem-v", "item_id": "it-v", "user_id": victim, "status": "pending"})
    mock_db.tables["devices"].append({"id": "dev-v", "user_id": victim, "platform": "web", "delivery_mode": "remote"})
    mock_db.tables["daily_ai_usage"].append({"id": "du-v", "user_id": victim, "usage_month": "2026-11", "request_count": 3})
    mock_db.tables["api_tokens"].append({"id": "tok-v", "user_id": victim, "token_hash": "h", "token_prefix": "jsi_"})
    mock_db.tables.setdefault("beta_feedback", []).append({"id": "fb-v", "user_id": victim, "category": "general", "message": "Great"})

    res = test_client.delete("/api/auth/me", headers=headers)
    assert res.status_code == 200
    assert res.json()["deleted"] is True

    assert [r for r in mock_db.tables["profiles"] if r["id"] == victim] == []
    assert [r for r in mock_db.tables["items"] if r["owner_id"] == victim] == []
    assert [r for r in mock_db.tables["folders"] if r["owner_id"] == victim] == []
    assert mock_db.tables["item_tags"] == []
    assert mock_db.tables["reminders"] == []
    assert mock_db.tables["devices"] == []
    assert mock_db.tables["daily_ai_usage"] == []
    assert mock_db.tables["api_tokens"] == []
    assert mock_db.tables["beta_feedback"] == []
    assert len(mock_db.tables["items"]) == 1
    assert mock_db.tables["items"][0]["owner_id"] == bystander


def test_c2_keyset_cursor_pagination_and_shared_folder_tag_search(mock_db, test_client):
    """C2: GET /api/items supports deterministic keyset cursor pagination and shared-folder tag search."""
    owner = "usr-ks-owner"
    member = "usr-ks-mem"
    mock_db.tables["folders"].append({"id": "f-ks", "owner_id": owner, "name": "SharedKS", "is_shared": True})
    mock_db.tables["folder_members"].append({"folder_id": "f-ks", "user_id": member, "role": "viewer"})
    mock_db.tables["tags"].append({"id": "t-ks", "owner_id": owner, "name": "MustRead"})

    for idx in range(5):
        item_id = f"it-ks-{idx}"
        mock_db.tables["items"].append({
            "id": item_id,
            "owner_id": owner,
            "folder_id": "f-ks",
            "url": f"https://example.com/{idx}",
            "title": f"Item {idx}",
            "status": "inbox",
            "saved_at": f"2026-11-13T10:0{idx}:00+00:00",
        })
        if idx == 3:
            mock_db.tables["item_tags"].append({"item_id": item_id, "tag_id": "t-ks"})

    hdr_mem = make_auth_headers(member)
    p1 = test_client.get("/api/items?limit=2", headers=hdr_mem).json()
    assert len(p1["items"]) == 2
    assert p1["next_cursor"] is not None

    p2 = test_client.get(f"/api/items?limit=2&cursor={p1['next_cursor']}", headers=hdr_mem).json()
    p3 = test_client.get(f"/api/items?limit=2&cursor={p2['next_cursor']}", headers=hdr_mem).json()
    collected_ids = [i["id"] for i in p1["items"] + p2["items"] + p3["items"]]
    assert collected_ids == ["it-ks-4", "it-ks-3", "it-ks-2", "it-ks-1", "it-ks-0"]
    assert p3["next_cursor"] is None

    tagged = test_client.get("/api/items?tag=mustread", headers=hdr_mem).json()
    assert [i["id"] for i in tagged["items"]] == ["it-ks-3"]

    for bad_cursor in ("abc|xyz", "not-a-date|it-ks-1", "2026-11-13T10:00:00+00:00|bad id!", "missing-pipe"):
        bad_res = test_client.get(f"/api/items?cursor={bad_cursor}", headers=hdr_mem)
        assert bad_res.status_code == 400


def test_c3_shared_folder_members_and_invite_revoke_routes(mock_db, test_client):
    """C3: Shared folder member listing, role updates, removal, and invite revocation routes enforce permissions."""
    owner_hdr = make_auth_headers("usr-own-m")
    member_hdr = make_auth_headers("usr-mem-m")

    folder = test_client.post("/api/folders", json={"name": "SharedTrip"}, headers=owner_hdr).json()
    fid = folder["id"]
    inv = test_client.post(f"/api/folders/{fid}/invites", json={"role": "editor"}, headers=owner_hdr).json()
    assert test_client.post(f"/api/invites/{inv['token']}/accept", headers=member_hdr).status_code == 200

    listed = test_client.get(f"/api/folders/{fid}/members", headers=owner_hdr)
    assert listed.status_code == 200
    assert len(listed.json()["members"]) == 1
    assert len(listed.json()["active_invites"]) == 1

    # Member cannot inspect active invites or update roles
    mem_listed = test_client.get(f"/api/folders/{fid}/members", headers=member_hdr).json()
    assert mem_listed["active_invites"] == []
    assert (
        test_client.patch(
            f"/api/folders/{fid}/members/usr-mem-m",
            json={"role": "viewer"},
            headers=member_hdr,
        ).status_code
        == 403
    )

    patched = test_client.patch(f"/api/folders/{fid}/members/usr-mem-m", json={"role": "viewer"}, headers=owner_hdr)
    assert patched.status_code == 200
    assert patched.json()["role"] == "viewer"

    rev = test_client.delete(f"/api/folders/{fid}/invites/{inv['token']}", headers=owner_hdr)
    assert rev.status_code == 200
    assert rev.json()["revoked"] is True
    assert rev.json()["is_shared"] is True  # member still present

    removed = test_client.delete(f"/api/folders/{fid}/members/usr-mem-m", headers=owner_hdr)
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert removed.json()["is_shared"] is False


def test_c3_beta_feedback_submission_and_listing(mock_db, test_client):
    """C3: POST/GET /api/feedback validates payload, stores tenant feedback, and isolates by user."""
    hdr_a = make_auth_headers("usr-fb-a")
    hdr_b = make_auth_headers("usr-fb-b")

    bad = test_client.post("/api/feedback", json={"message": "hi"}, headers=hdr_a)
    assert bad.status_code == 422

    created = test_client.post(
        "/api/feedback",
        json={"category": "waitlist", "message": "Please add Safari share extension!", "contact_email": "me@example.com", "allow_contact": True},
        headers=hdr_a,
    )
    assert created.status_code == 201
    assert created.json()["category"] == "waitlist"

    assert len(test_client.get("/api/feedback", headers=hdr_a).json()["feedback"]) == 1
    assert len(test_client.get("/api/feedback", headers=hdr_b).json()["feedback"]) == 0
