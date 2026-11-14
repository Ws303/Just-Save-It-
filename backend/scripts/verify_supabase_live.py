"""Live Supabase Cloud verification script (Step 5: Schema, Storage, RPC, and User A vs User B RLS).

Usage:
    1. Fill real credentials in `backend/.env`:
       SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
    2. Run SQL schema (`backend/Database/schema.sql` or `supabase/migrations/0001..0006`) in Supabase.
    3. Execute from `backend/`:
       ../.venv/bin/python scripts/verify_supabase_live.py
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import uuid

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

load_dotenv(dotenv_path=BACKEND_DIR / ".env", override=False)

from supabase import create_client  # noqa: E402
from Database.supabase_client import (  # noqa: E402
    get_supabase_anon_key,
    get_supabase_service_client,
    get_supabase_url,
    get_user_scoped_client,
    is_supabase_configured,
)

EXPECTED_TABLES = (
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
    "beta_feedback",
)


def _assert(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"  [PASS] {label}")


def _verify_schema_and_bucket(service_client: object) -> None:
    print("\n1. Verifying 12 tables, Storage bucket, and RPCs...")
    for table in EXPECTED_TABLES:
        service_client.table(table).select("*").limit(1).execute()
    _assert(True, f"All {len(EXPECTED_TABLES)} tables reachable")

    buckets = service_client.storage.list_buckets() or []
    bucket_names = {getattr(b, "name", None) or getattr(b, "id", None) for b in buckets}
    _assert("thumbnails" in bucket_names, "Storage bucket 'thumbnails' exists")


def _create_confirmed_test_user(service_client: object, url: str, anon_key: str, label: str) -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:10]
    email = f"rls-check-{label}-{suffix}@rls-test.justsaveit.app"
    password = f"RlsPass!{suffix}99"
    created = service_client.auth.admin.create_user(
        {
            "email": email,
            "password": password,
            "email_confirm": True,
            "user_metadata": {"display_name": f"RLS User {label.upper()}"},
        }
    )
    user_id = str(created.user.id)
    fresh_anon = create_client(url, anon_key)
    session_resp = fresh_anon.auth.sign_in_with_password({"email": email, "password": password})
    if not session_resp.session or not session_resp.session.access_token:
        raise RuntimeError(f"Could not obtain JWT access token for test user {email}.")
    return user_id, session_resp.session.access_token


def _verify_rls_isolation(service_client: object, url: str, anon_key: str) -> None:
    print("\n2. Verifying User A vs User B Row-Level Security (RLS) isolation...")
    user_a_id: str | None = None
    user_b_id: str | None = None

    try:
        user_a_id, token_a = _create_confirmed_test_user(service_client, url, anon_key, "a")
        user_b_id, token_b = _create_confirmed_test_user(service_client, url, anon_key, "b")

        client_a = get_user_scoped_client(token_a)
        client_b = get_user_scoped_client(token_b)

        # Auto-created profile trigger check & isolation
        prof_a = client_a.table("profiles").select("id").eq("id", user_a_id).execute()
        _assert(len(prof_a.data or []) == 1, "Profile auto-created for User A via auth trigger")
        prof_b_reads_a = client_b.table("profiles").select("id").eq("id", user_a_id).execute()
        _assert(len(prof_b_reads_a.data or []) == 0, "User B cannot read User A profile")

        # User A creates private folder, private unfoldered item, shared-candidate item, tag, reminder, api_token
        folder_res = (
            client_a.table("folders")
            .insert({"owner_id": user_a_id, "name": f"RLS Folder {uuid.uuid4().hex[:6]}", "emoji": "🔒"})
            .execute()
        )
        folder_id = folder_res.data[0]["id"]

        private_item_res = (
            client_a.table("items")
            .insert({
                "owner_id": user_a_id,
                "url": f"https://example.com/private-{uuid.uuid4().hex[:8]}",
                "title": "User A Secret Link",
            })
            .execute()
        )
        private_item_id = private_item_res.data[0]["id"]

        foldered_item_res = (
            client_a.table("items")
            .insert({
                "owner_id": user_a_id,
                "folder_id": folder_id,
                "url": f"https://example.com/folder-{uuid.uuid4().hex[:8]}",
                "title": "User A Folder Link",
            })
            .execute()
        )
        foldered_item_id = foldered_item_res.data[0]["id"]

        tag_res = (
            client_a.table("tags")
            .insert({"owner_id": user_a_id, "name": f"rls-tag-{uuid.uuid4().hex[:6]}"})
            .execute()
        )
        tag_id = tag_res.data[0]["id"]

        remind_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        rem_res = (
            client_a.table("reminders")
            .insert({
                "item_id": foldered_item_id,
                "user_id": user_a_id,
                "schedule_type": "once",
                "remind_at": remind_at,
                "title_snapshot": "Secret Reminder",
            })
            .execute()
        )
        rem_id = rem_res.data[0]["id"]

        tok_res = (
            client_a.table("api_tokens")
            .insert({
                "user_id": user_a_id,
                "token_hash": uuid.uuid4().hex * 2,
                "token_prefix": "jsi_live_rls...",
                "name": "RLS Token",
            })
            .execute()
        )
        tok_id = tok_res.data[0]["id"]

        # Verify User B is blocked from reading/updating/deleting User A's private data
        _assert(len(client_b.table("folders").select("*").eq("id", folder_id).execute().data or []) == 0,
                "User B cannot SELECT User A private folder")
        _assert(len(client_b.table("items").select("*").eq("id", private_item_id).execute().data or []) == 0,
                "User B cannot SELECT User A private item")
        _assert(len(client_b.table("tags").select("*").eq("id", tag_id).execute().data or []) == 0,
                "User B cannot SELECT User A private tag")
        _assert(len(client_b.table("reminders").select("*").eq("id", rem_id).execute().data or []) == 0,
                "User B cannot SELECT User A personal reminder")
        _assert(len(client_b.table("api_tokens").select("*").eq("id", tok_id).execute().data or []) == 0,
                "User B cannot SELECT User A API tokens")

        upd_b = client_b.table("items").update({"title": "Hacked"}).eq("id", private_item_id).execute()
        _assert(len(upd_b.data or []) == 0, "User B cannot UPDATE User A private item")
        del_b = client_b.table("items").delete().eq("id", private_item_id).execute()
        _assert(len(del_b.data or []) == 0, "User B cannot DELETE User A private item")

        # Test Shared Folder Collaboration via accept_invite RPC + Tenant-Isolated Reminders
        print("\n3. Verifying Shared Folder invite acceptance & reminder tenant isolation...")
        inv_res = (
            client_a.table("folder_invites")
            .insert({"folder_id": folder_id, "role": "editor", "created_by": user_a_id})
            .execute()
        )
        invite_token = inv_res.data[0]["token"]

        acc_res = client_b.rpc("accept_invite", {"invite_token": invite_token}).execute()
        _assert(acc_res.data is not None, "User B accepted shared folder invite via RPC")

        b_shared_items = client_b.table("items").select("*").eq("id", foldered_item_id).execute()
        _assert(len(b_shared_items.data or []) == 1, "User B can now view item inside shared folder")

        b_still_blocked_private = client_b.table("items").select("*").eq("id", private_item_id).execute()
        _assert(len(b_still_blocked_private.data or []) == 0, "User B STILL cannot see User A unshared items")

        b_still_blocked_rem = client_b.table("reminders").select("*").eq("id", rem_id).execute()
        _assert(len(b_still_blocked_rem.data or []) == 0, "User B STILL cannot see User A reminder even in shared folder")

    finally:
        print("\n4. Cleaning up temporary RLS test users and rows...")
        for uid in (user_a_id, user_b_id):
            if uid:
                try:
                    service_client.auth.admin.delete_user(uid)
                except Exception as exc:
                    print(f"  [WARN] Cleanup delete_user({uid}) failed: {exc}")


def main() -> int:
    if not is_supabase_configured():
        print(
            "[ERROR] Supabase credentials are not configured yet.\n"
            "Copy `backend/.env.example` to `backend/.env` and fill real values for:\n"
            "  - SUPABASE_URL\n"
            "  - SUPABASE_ANON_KEY\n"
            "  - SUPABASE_SERVICE_ROLE_KEY\n"
            "  - SUPABASE_JWT_SECRET\n"
            "Then paste `backend/Database/schema.sql` into Supabase SQL Editor and re-run this script.",
            file=sys.stderr,
        )
        return 1

    url = get_supabase_url()
    anon_key = get_supabase_anon_key()
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not service_role_key or service_role_key.startswith("your_supabase_"):
        print("[ERROR] SUPABASE_SERVICE_ROLE_KEY is required for creating/cleaning temp test users.", file=sys.stderr)
        return 1

    service_client = get_supabase_service_client()
    try:
        _verify_schema_and_bucket(service_client)
        _verify_rls_isolation(service_client, url, anon_key)
    except Exception as exc:
        print(f"\n[FAIL] Live Supabase verification failed: {exc}", file=sys.stderr)
        return 1

    print("\nALL LIVE SUPABASE CHECKS PASSED (Schema + Storage + User A/B RLS + Shared Invite)!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
