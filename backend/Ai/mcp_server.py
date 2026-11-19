"""Full-Featured Remote MCP Server for Just-Save-It.

Enforces:
1. Tenant Isolation Invariant: user_id is derived strictly from SHA-256 hash of API token (jsi_live_xxx)
   and never accepted as a parameter from AI clients.
2. 13 Production MCP Tools:
   - Items & Notes: search_and_list_items, get_item_detail, create_item, update_item, delete_item, summarize_item_to_note
   - Tags: list_tags, manage_item_tags, rename_or_delete_tag
   - Folders & Sharing: list_folders, manage_folder, share_folder_link
   - Reminders: set_or_cancel_reminder
"""

import asyncio
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import secrets
from typing import Any, Dict, List, Literal, Optional

dt_tz_utc = timezone.utc

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError:
        FastMCP = Any  # type: ignore

from Database.repository import (
    _attach_tags_to_item,
    _get_accessible_folder_ids,
    can_access_item,
    get_folder_role,
    upsert_item_reminder,
)
from Database.schemas import ReminderConfig
from Database.text_hygiene import (
    canonicalize_url,
    clean_text_field,
    compute_url_hash,
    normalize_unicode_text,
)
from .content_extractor import validate_safe_url
from .schemas import SummarizeRequest
from .summarizer_service import (
    check_item_access_permission,
    get_supabase_client,
    summarize_item_once,
)

logger = logging.getLogger("just_save_it.mcp")

# Context variable for storing the authenticated user_id during request lifecycle
_current_user_id_ctx: ContextVar[Optional[str]] = ContextVar("current_user_id", default=None)
_override_db_ctx: ContextVar[Optional[Any]] = ContextVar("override_db", default=None)


def set_authenticated_user_id(user_id: Optional[str]) -> None:
    """Manually set authenticated user_id in the current context (used by middleware & unit tests)."""
    _current_user_id_ctx.set(user_id)


def set_override_db(db: Optional[Any]) -> None:
    """Manually set mock database in context for testing."""
    _override_db_ctx.set(db)


def get_active_db() -> Any:
    """Get active database client (override if set, else Supabase client)."""
    override = _override_db_ctx.get()
    if override is not None:
        return override
    return get_supabase_client()


def get_authenticated_user_id() -> str:
    """Retrieve verified user_id from context. Enforces Tenant Isolation."""
    uid = _current_user_id_ctx.get()
    if not uid:
        raise PermissionError(
            "Tenant Isolation Error: Unauthorized request. A valid Personal Access Token (jsi_live_xxx) is required."
        )
    return uid


def verify_mcp_token(raw_token: str, db: Any = None) -> str:
    """Verify and hash Personal Access Token via SHA-256 and fetch corresponding user_id.

    Enforces Tenant Isolation Invariant (B0).
    """
    if not raw_token or not raw_token.strip():
        raise PermissionError("Missing API token.")

    clean_token = raw_token.strip()
    if clean_token.startswith("Bearer "):
        clean_token = clean_token.split("Bearer ", 1)[1].strip()

    token_hash = hashlib.sha256(clean_token.encode("utf-8")).hexdigest()
    client = db if db is not None else get_active_db()

    try:
        res = (
            client.table("api_tokens")
            .select("id, user_id, revoked_at")
            .eq("token_hash", token_hash)
            .execute()
        )
        if not res.data:
            raise PermissionError("Invalid API token: Token not recognized.")

        record = res.data[0]
        if record.get("revoked_at") is not None:
            raise PermissionError("API token has been revoked.")

        # Update last_used_at timestamp
        try:
            client.table("api_tokens").update(
                {"last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", record["id"]).execute()
        except Exception as e:
            logger.debug("Failed to update last_used_at for token: %s", e)

        return str(record["user_id"])
    except PermissionError:
        raise
    except Exception as e:
        logger.error("Token resolution error: %s", e)
        raise PermissionError(f"Authentication failed: {e}")


# Alias for backwards compatibility
resolve_user_id_from_token = verify_mcp_token


mcp = FastMCP("Sherlink MCP Server") if FastMCP is not Any else None


# =====================================================================
# 🗂️ หมวดที่ 1: จัดการลิงก์และบันทึก (Items & Notes CRUD)
# =====================================================================

def search_and_list_items(
    query: Optional[str] = None,
    folder_id: Optional[str] = None,
    tag_name: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """Search and list saved items (owned + shared folders) filtered by keyword, folder, tag, or status."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    owned_res = db.table("items").select("*").eq("owner_id", user_id).execute()
    seen_ids = set()
    items: List[Dict[str, Any]] = []
    for row in owned_res.data or []:
        if row.get("id") not in seen_ids:
            seen_ids.add(row.get("id"))
            items.append(row)

    try:
        accessible_fids = _get_accessible_folder_ids(db, user_id)
        if accessible_fids:
            shared_items_res = db.table("items").select("*").in_("folder_id", accessible_fids).execute()
            for row in shared_items_res.data or []:
                if row.get("id") not in seen_ids:
                    seen_ids.add(row.get("id"))
                    items.append(row)
    except Exception as exc:
        logger.debug("Shared folder lookup skipped: %s", exc)

    if status:
        items = [item for item in items if item.get("status") == status]
    if folder_id:
        items = [item for item in items if item.get("folder_id") == folder_id]

    if query and query.strip():
        q_lower = normalize_unicode_text(query.strip()).lower()
        items = [
            item
            for item in items
            if q_lower in normalize_unicode_text(item.get("title") or "").lower()
            or q_lower in normalize_unicode_text(item.get("description") or "").lower()
            or q_lower in normalize_unicode_text(item.get("note") or "").lower()
            or q_lower in normalize_unicode_text(item.get("ai_summary") or "").lower()
            or q_lower in (item.get("url") or "").lower()
        ]

    if tag_name and tag_name.strip():
        tag_lower = normalize_unicode_text(tag_name.strip()).lower()
        candidate_ids = [item["id"] for item in items if item.get("id")]
        if not candidate_ids:
            return []
        link_res = db.table("item_tags").select("item_id, tag_id").in_("item_id", candidate_ids).execute()
        link_rows = link_res.data or []
        candidate_tag_ids = list({r["tag_id"] for r in link_rows if r.get("tag_id")})
        if not candidate_tag_ids:
            return []
        tag_res = db.table("tags").select("id, name").in_("id", candidate_tag_ids).execute()
        matching_ids = {
            r["id"]
            for r in (tag_res.data or [])
            if normalize_unicode_text(r.get("name", "")).lower() == tag_lower
        }
        if matching_ids:
            valid_item_ids = {r["item_id"] for r in link_rows if r.get("tag_id") in matching_ids}
            items = [item for item in items if item.get("id") in valid_item_ids]
        else:
            return []

    return items[:limit]


def get_item_detail(item_id: str) -> Dict[str, Any]:
    """Retrieve full item details including metadata, notes, AI summary, tags, and reminders."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    res = db.table("items").select("*").eq("id", item_id).execute()
    if not res.data:
        raise ValueError(f"Item not found: {item_id}")

    item = res.data[0]
    if not check_item_access_permission(db, user_id, item):
        raise PermissionError("Access denied: You do not have permission to view this item.")

    # Fetch associated tags
    tags: List[str] = []
    try:
        links = db.table("item_tags").select("tag_id").eq("item_id", item_id).execute()
        if links.data:
            t_ids = [l["tag_id"] for l in links.data]
            t_res = db.table("tags").select("name").in_("id", t_ids).execute()
            tags = [t["name"] for t in (t_res.data or [])]
    except Exception as e:
        logger.debug("Failed to fetch tags for item %s: %s", item_id, e)

    # Fetch reminders strictly scoped to current user
    reminders: List[Dict[str, Any]] = []
    try:
        rem_res = db.table("reminders").select("*").eq("item_id", item_id).eq("user_id", user_id).execute()
        reminders = rem_res.data or []
    except Exception as e:
        logger.debug("Failed to fetch reminders for item %s: %s", item_id, e)

    item["tags"] = tags
    item["reminders"] = reminders
    return item


def create_item(
    url: str,
    title: Optional[str] = None,
    note: Optional[str] = None,
    folder_id: Optional[str] = None,
    tags: Optional[List[str]] = None,
    status: str = "inbox",
) -> Dict[str, Any]:
    """Create and save a new item into the library with canonical URL dedup, note, folder, tags, and status."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    raw_url = (url or "").strip()
    if not raw_url or not (raw_url.lower().startswith("http://") or raw_url.lower().startswith("https://")):
        raise ValueError("URL must start with http:// or https://")
    raw_url = validate_safe_url(raw_url)
    if status not in ("inbox", "todo", "done", "archived"):
        raise ValueError(f"Invalid status '{status}'. Must be one of inbox, todo, done, archived.")
    if folder_id is not None and folder_id.strip():
        role = get_folder_role(db, user_id, folder_id.strip())
        if role not in ("owner", "editor"):
            raise PermissionError("Access denied: You need owner or editor permission in the target folder.")
        folder_id = folder_id.strip()
    else:
        folder_id = None

    canon_url = canonicalize_url(raw_url)
    url_hash = compute_url_hash(raw_url)
    clean_title = clean_text_field(title, unescape_html=True)
    clean_note = clean_text_field(note, unescape_html=False)
    now_iso = datetime.now(timezone.utc).isoformat()

    existing = db.table("items").select("*").eq("owner_id", user_id).eq("url_hash", url_hash).execute()
    if existing.data:
        created_item = dict(existing.data[0])
        item_id = created_item.get("id")
        bump_updates: Dict[str, Any] = {"saved_at": now_iso, "updated_at": now_iso}
        if clean_title:
            bump_updates["title"] = clean_title
        if clean_note is not None:
            bump_updates["note"] = clean_note
        upd_res = db.table("items").update(bump_updates).eq("id", item_id).execute()
        if upd_res.data:
            created_item = upd_res.data[0]
    else:
        item_payload = {
            "owner_id": user_id,
            "url": raw_url,
            "canonical_url": canon_url,
            "url_hash": url_hash,
            "title": clean_title or canon_url,
            "note": clean_note,
            "folder_id": folder_id,
            "status": status,
            "enrich_status": "pending",
            "saved_at": now_iso,
            "updated_at": now_iso,
        }
        res = db.table("items").insert(item_payload).execute()
        created_item = res.data[0] if res.data else item_payload
        item_id = created_item.get("id")

    if tags and item_id:
        _attach_tags_to_item(db, user_id, str(item_id), tags)

    return created_item


def update_item(
    item_id: str,
    title: Optional[str] = None,
    note: Optional[str] = None,
    folder_id: Optional[str] = None,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    """Update item properties (title, note, folder, or status)."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    item_res = db.table("items").select("*").eq("id", item_id).execute()
    if not item_res.data:
        raise ValueError(f"Item not found: {item_id}")

    item = item_res.data[0]
    if not can_access_item(db, user_id, item, require_editor=True):
        raise PermissionError("Access denied: You do not have permission to edit this item.")

    updates: Dict[str, Any] = {}
    if title is not None:
        updates["title"] = clean_text_field(title, unescape_html=True)
    if note is not None:
        updates["note"] = clean_text_field(note, unescape_html=False)
    if folder_id is not None:
        target_fid = folder_id.strip() if folder_id.strip() else None
        if target_fid != item.get("folder_id"):
            if item.get("owner_id") != user_id:
                raise PermissionError("Access denied: Only the item owner can move an item across folders.")
            if target_fid is not None:
                role = get_folder_role(db, user_id, target_fid)
                if role not in ("owner", "editor"):
                    raise PermissionError("Access denied: You need owner or editor permission in the target folder.")
        updates["folder_id"] = target_fid
    if status is not None:
        if status not in ("inbox", "todo", "done", "archived"):
            raise ValueError(f"Invalid status '{status}'. Must be one of inbox, todo, done, archived.")
        updates["status"] = status
        if status == "done":
            updates["done_at"] = datetime.now(timezone.utc).isoformat()
        if status in ("done", "archived") and item.get("status") != status:
            db.table("reminders").update(
                {"status": "cancelled", "updated_at": datetime.now(timezone.utc).isoformat()}
            ).eq("item_id", item_id).eq("status", "pending").execute()

    if updates:
        res = db.table("items").update(updates).eq("id", item_id).execute()
        return res.data[0] if res.data else updates

    return item


def delete_item(item_id: str) -> Dict[str, Any]:
    """Delete an item permanently from the user library."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    item_res = db.table("items").select("owner_id").eq("id", item_id).execute()
    if not item_res.data:
        raise ValueError(f"Item not found: {item_id}")

    if item_res.data[0].get("owner_id") != user_id:
        raise PermissionError("Access denied: Only the owner can delete this item.")

    db.table("items").delete().eq("id", item_id).execute()
    return {"success": True, "deleted_item_id": item_id}


async def summarize_item_to_note(item_id: str, force_refresh: bool = False) -> Dict[str, Any]:
    """Summarize an item with AI and persist the 3-bullet summary to both ai_summary and note fields."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    req = SummarizeRequest(item_id=item_id, force_refresh=force_refresh, save_to_note=True)
    resp = await summarize_item_once(db=db, user_id=user_id, req=req)
    return resp.model_dump()


# =====================================================================
# 🏷️ หมวดที่ 2: จัดการแท็ก (Tags Management)
# =====================================================================

def list_tags() -> List[Dict[str, Any]]:
    """List all tags in the user account with item counts."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    tags_res = db.table("tags").select("*").eq("owner_id", user_id).execute()
    tags = tags_res.data or []
    tag_ids = [t["id"] for t in tags if t.get("id")]
    counts_by_tag: Dict[Any, int] = {}
    if tag_ids:
        try:
            links_res = db.table("item_tags").select("tag_id").in_("tag_id", tag_ids).execute()
            for row in links_res.data or []:
                tid = row.get("tag_id")
                if tid:
                    counts_by_tag[tid] = counts_by_tag.get(tid, 0) + 1
        except Exception:
            counts_by_tag = {}

    for t in tags:
        t["item_count"] = counts_by_tag.get(t.get("id"), 0)

    return tags


def manage_item_tags(
    item_id: str,
    add_tags: Optional[List[str]] = None,
    remove_tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Add or remove tags on an item."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    item_res = db.table("items").select("*").eq("id", item_id).execute()
    if not item_res.data:
        raise ValueError(f"Item not found: {item_id}")

    item = item_res.data[0]
    if not can_access_item(db, user_id, item, require_editor=True):
        raise PermissionError("Access denied: You do not have permission to manage tags on this item.")
    tag_owner_id = str(item.get("owner_id") or user_id)

    # Handle additions (batched + 23505 recovery, attributed to item owner)
    if add_tags:
        clean_add = [
            t
            for t in (
                (clean_text_field(t_name, unescape_html=False) or "")[:60].strip()
                for t_name in add_tags
            )
            if t
        ]
        if clean_add:
            _attach_tags_to_item(db, tag_owner_id, item_id, clean_add)

    # Handle removals (batched across all linked tags regardless of creator)
    if remove_tags:
        clean_rem_set = {
            t
            for t in (
                (clean_text_field(t_name, unescape_html=False) or "")[:60].strip()
                for t_name in remove_tags
            )
            if t
        }
        if clean_rem_set:
            linked_res = db.table("item_tags").select("tag_id").eq("item_id", item_id).execute()
            linked_ids = [row["tag_id"] for row in (getattr(linked_res, "data", None) or []) if row.get("tag_id")]
            if linked_ids:
                tags_meta = db.table("tags").select("id, name").in_("id", linked_ids).execute()
                rem_ids = [
                    row["id"]
                    for row in (getattr(tags_meta, "data", None) or [])
                    if row.get("id") and str(row.get("name") or "") in clean_rem_set
                ]
                if rem_ids:
                    db.table("item_tags").delete().eq("item_id", item_id).in_("tag_id", rem_ids).execute()

    return {"success": True, "item_id": item_id, "updated": True}


def rename_or_delete_tag(
    tag_name: str,
    new_name: Optional[str] = None,
    delete: bool = False,
) -> Dict[str, Any]:
    """Rename or delete an existing tag."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    clean_tag_name = (clean_text_field(tag_name, unescape_html=False) or "")[:60].strip()
    if not clean_tag_name:
        raise ValueError("Tag name cannot be empty.")

    tag_res = db.table("tags").select("id").eq("owner_id", user_id).eq("name", clean_tag_name).execute()
    if not tag_res.data:
        raise ValueError(f"Tag not found: {tag_name}")

    tag_id = tag_res.data[0]["id"]

    if delete:
        db.table("item_tags").delete().eq("tag_id", tag_id).execute()
        db.table("tags").delete().eq("id", tag_id).execute()
        return {"success": True, "action": "deleted", "tag_name": clean_tag_name}

    clean_new_name = (clean_text_field(new_name, unescape_html=False) or "")[:60].strip() if new_name else ""
    if not clean_new_name:
        raise ValueError("new_name is required when renaming a tag.")

    if clean_new_name != clean_tag_name:
        dup_res = db.table("tags").select("id").eq("owner_id", user_id).eq("name", clean_new_name).execute()
        if any(row.get("id") != tag_id for row in (dup_res.data or [])):
            raise ValueError(f"Tag '{clean_new_name}' already exists.")

    db.table("tags").update({"name": clean_new_name}).eq("id", tag_id).execute()
    return {"success": True, "action": "renamed", "old_name": clean_tag_name, "new_name": clean_new_name}


# =====================================================================
# 📁 หมวดที่ 3: จัดการโฟลเดอร์ และการแชร์ให้เพื่อน (Folders & Sharing)
# =====================================================================

def list_folders() -> List[Dict[str, Any]]:
    """List all folders owned by the user or shared with the user."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    owned_res = db.table("folders").select("*").eq("owner_id", user_id).execute()
    folders = [dict(f, role="owner") for f in (owned_res.data or [])]
    seen_ids = {f.get("id") for f in folders if f.get("id")}

    # Fetch shared folders (batched)
    try:
        shared_res = db.table("folder_members").select("folder_id, role").eq("user_id", user_id).execute()
        role_by_fid: Dict[str, Any] = {}
        shared_ids: List[str] = []
        for sm in shared_res.data or []:
            fid = sm.get("folder_id")
            if not fid or fid in seen_ids or fid in role_by_fid:
                continue
            role_by_fid[fid] = sm.get("role")
            shared_ids.append(fid)
        if shared_ids:
            f_res = db.table("folders").select("*").in_("id", shared_ids).execute()
            by_id = {row["id"]: row for row in (f_res.data or []) if row.get("id")}
            for fid in shared_ids:
                row = by_id.get(fid)
                if row:
                    sf = dict(row)
                    sf["role"] = role_by_fid[fid]
                    folders.append(sf)
    except Exception as e:
        logger.debug("Failed to list shared folders: %s", e)

    return folders


def manage_folder(
    action: Literal["create", "rename", "delete"],
    name: Optional[str] = None,
    folder_id: Optional[str] = None,
    emoji: Optional[str] = None,
) -> Dict[str, Any]:
    """Create, rename, or delete a folder."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    if action == "create":
        clean_name = clean_text_field(name, unescape_html=False)
        if not clean_name or len(clean_name) > 80:
            raise ValueError("Folder name must be between 1 and 80 characters.")
        payload = {
            "owner_id": user_id,
            "name": clean_name,
            "emoji": emoji,
            "is_shared": False,
        }
        res = db.table("folders").insert(payload).execute()
        return res.data[0] if res.data else payload

    if not folder_id:
        raise ValueError("folder_id is required for rename or delete.")

    folder_res = db.table("folders").select("*").eq("id", folder_id).execute()
    if not folder_res.data:
        raise ValueError(f"Folder not found: {folder_id}")

    if folder_res.data[0].get("owner_id") != user_id:
        raise PermissionError("Access denied: Only the folder owner can rename or delete it.")

    if action == "rename":
        updates: Dict[str, Any] = {}
        if name is not None:
            clean_name = clean_text_field(name, unescape_html=False)
            if not clean_name or len(clean_name) > 80:
                raise ValueError("Folder name must be between 1 and 80 characters.")
            updates["name"] = clean_name
        if emoji is not None:
            updates["emoji"] = emoji
        if not updates:
            raise ValueError("At least one of name or emoji is required for rename.")
        res = db.table("folders").update(updates).eq("id", folder_id).execute()
        return res.data[0] if res.data else updates

    if action == "delete":
        db.table("folders").delete().eq("id", folder_id).execute()
        return {"success": True, "action": "deleted", "folder_id": folder_id}

    raise ValueError(f"Invalid action: {action}")


def share_folder_link(
    folder_id: str,
    role: Literal["viewer", "editor"] = "editor",
    expires_in_days: int = 7,
    revoke_all: bool = False,
) -> Dict[str, Any]:
    """Generate or revoke shareable invite link for a folder.

    Enforces B12: role must be 'viewer' or 'editor' (role='owner' is strictly prohibited).
    """
    if role == "owner":
        raise ValueError("Role 'owner' is strictly forbidden for invite links. Only 'viewer' or 'editor' is allowed.")
    if role not in ("viewer", "editor"):
        raise ValueError(f"Invalid role '{role}'. Allowed roles are 'viewer' or 'editor'.")

    user_id = get_authenticated_user_id()
    db = get_active_db()

    folder_res = db.table("folders").select("*").eq("id", folder_id).execute()
    if not folder_res.data:
        raise ValueError(f"Folder not found: {folder_id}")

    if folder_res.data[0].get("owner_id") != user_id:
        raise PermissionError("Access denied: Only the folder owner can create or revoke share links.")

    if revoke_all:
        now_iso = datetime.now(timezone.utc).isoformat()
        invites_res = db.table("folder_invites").select("token, revoked_at").eq("folder_id", folder_id).execute()
        for inv in (invites_res.data or []):
            if inv.get("revoked_at") is None:
                tok = inv.get("token")
                if tok:
                    db.table("folder_invites").update({"revoked_at": now_iso}).eq("token", tok).execute()
                else:
                    db.table("folder_invites").update({"revoked_at": now_iso}).eq("folder_id", folder_id).execute()

        members_res = db.table("folder_members").select("user_id").eq("folder_id", folder_id).execute()
        remaining_members = [m for m in (members_res.data or []) if m.get("user_id") != user_id]
        if not remaining_members:
            db.table("folders").update({"is_shared": False}).eq("id", folder_id).execute()
        return {"success": True, "message": f"All invite links revoked for folder {folder_id}."}

    # Generate secure token
    token = secrets.token_hex(16)
    expires_at = datetime.now(timezone.utc) + timedelta(days=expires_in_days)

    db.table("folder_invites").insert(
        {
            "token": token,
            "folder_id": folder_id,
            "role": role,
            "created_by": user_id,
            "expires_at": expires_at.isoformat(),
        }
    ).execute()

    db.table("folders").update({"is_shared": True}).eq("id", folder_id).execute()

    app_url = os.getenv("APP_URL", "https://app.justsaveit.com").rstrip("/")
    invite_url = f"{app_url}/invite/{token}"

    return {
        "success": True,
        "invite_url": invite_url,
        "token": token,
        "role": role,
        "expires_at": expires_at.isoformat(),
    }


# =====================================================================
# ⏰ หมวดที่ 4: ตั้งเวลาแจ้งเตือน (Reminders)
# =====================================================================

def set_or_cancel_reminder(
    item_id: str,
    remind_at_iso: Optional[str] = None,
    cancel: bool = False,
    schedule_type: Optional[Literal["once", "every_n_days"]] = None,
    repeat_every_days: Optional[int] = None,
    remind_time: Optional[str] = None,
    timezone: str = "UTC",
) -> Dict[str, Any]:
    """Set (one-time or recurring every_n_days) or cancel a reminder for a saved item."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    item_res = db.table("items").select("*").eq("id", item_id).execute()
    if not item_res.data:
        raise ValueError(f"Item not found: {item_id}")

    item = item_res.data[0]
    if not check_item_access_permission(db, user_id, item):
        raise PermissionError("Access denied: You do not have permission to set reminders for this item.")

    if cancel:
        db.table("reminders").update(
            {"status": "cancelled", "updated_at": datetime.now(dt_tz_utc).isoformat()}
        ).eq("item_id", item_id).eq("user_id", user_id).execute()
        return {"success": True, "action": "cancelled", "item_id": item_id}

    if item.get("status") in ("done", "archived"):
        raise ValueError("Cannot set a reminder on a done or archived item.")

    resolved_schedule: Literal["once", "every_n_days"] = (
        schedule_type
        if schedule_type is not None
        else ("every_n_days" if repeat_every_days is not None else "once")
    )

    parsed_dt: Optional[datetime] = None
    if remind_at_iso and remind_at_iso.strip():
        raw_iso = remind_at_iso.strip()
        if raw_iso.endswith("Z"):
            raw_iso = raw_iso[:-1] + "+00:00"
        parsed_dt = datetime.fromisoformat(raw_iso)
    elif resolved_schedule == "once":
        raise ValueError("remind_at_iso is required when setting a one-time reminder.")

    cfg = ReminderConfig(
        schedule_type=resolved_schedule,
        remind_at=parsed_dt,
        repeat_every_days=repeat_every_days,
        remind_time=remind_time,
        timezone=timezone,
        title_snapshot=item.get("title"),
    )
    saved = upsert_item_reminder(db, user_id, item_id, item.get("title"), cfg)
    return {
        "success": True,
        "action": "set",
        "item_id": item_id,
        "remind_at": saved.get("remind_at"),
        "schedule_type": saved.get("schedule_type"),
        "repeat_every_days": saved.get("repeat_every_days"),
        "remind_time": saved.get("remind_time"),
        "timezone": saved.get("timezone"),
    }


# Register all 13 tools with FastMCP if available
if mcp is not None:
    mcp.tool()(search_and_list_items)
    mcp.tool()(get_item_detail)
    mcp.tool()(create_item)
    mcp.tool()(update_item)
    mcp.tool()(delete_item)
    mcp.tool()(summarize_item_to_note)
    mcp.tool()(list_tags)
    mcp.tool()(manage_item_tags)
    mcp.tool()(rename_or_delete_tag)
    mcp.tool()(list_folders)
    mcp.tool()(manage_folder)
    mcp.tool()(share_folder_link)
    mcp.tool()(set_or_cancel_reminder)


class MCPAuthMiddleware(BaseHTTPMiddleware):
    """Middleware enforcing Tenant Isolation for Remote MCP requests."""

    async def dispatch(self, request: Request, call_next):
        # Extract token from Header or Query Param
        auth_header = request.headers.get("Authorization") or request.headers.get("X-API-Token")
        token_param = request.query_params.get("token")
        raw_token = auth_header or token_param

        if not raw_token:
            return Response(content="Unauthorized: Missing API token.", status_code=401)

        try:
            user_id = await asyncio.to_thread(resolve_user_id_from_token, raw_token)
            token_reset = _current_user_id_ctx.set(user_id)
            try:
                return await call_next(request)
            finally:
                _current_user_id_ctx.reset(token_reset)
        except PermissionError as pe:
            return Response(content=str(pe), status_code=401)
