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

from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import hashlib
import logging
import os
import secrets
from typing import Any, Dict, List, Literal, Optional

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


mcp = FastMCP("Just-Save-It MCP Server") if FastMCP is not Any else None


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
    """Search and list saved items filtered by search keyword, folder, tag, or status."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    query_builder = db.table("items").select("*").eq("owner_id", user_id)

    if status:
        query_builder = query_builder.eq("status", status)
    if folder_id:
        query_builder = query_builder.eq("folder_id", folder_id)

    res = query_builder.limit(limit).execute()
    items: List[Dict[str, Any]] = res.data or []

    # Filter by search query if provided
    if query and query.strip():
        q_lower = query.strip().lower()
        items = [
            item
            for item in items
            if q_lower in (item.get("title") or "").lower()
            or q_lower in (item.get("description") or "").lower()
            or q_lower in (item.get("note") or "").lower()
            or q_lower in (item.get("ai_summary") or "").lower()
            or q_lower in (item.get("url") or "").lower()
        ]

    # Filter by tag_name if provided
    if tag_name and tag_name.strip():
        tag_lower = tag_name.strip().lower()
        tag_res = db.table("tags").select("id").eq("owner_id", user_id).ilike("name", tag_lower).execute()
        if tag_res.data:
            tag_id = tag_res.data[0]["id"]
            link_res = db.table("item_tags").select("item_id").eq("tag_id", tag_id).execute()
            valid_item_ids = {r["item_id"] for r in (link_res.data or [])}
            items = [item for item in items if item.get("id") in valid_item_ids]
        else:
            return []

    return items


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

    # Fetch reminders
    reminders: List[Dict[str, Any]] = []
    try:
        rem_res = db.table("reminders").select("*").eq("item_id", item_id).execute()
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
    """Create and save a new item into the library with optional note, folder, tags, and status."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    clean_url = url.strip()
    url_hash = hashlib.md5(clean_url.lower().encode("utf-8")).hexdigest()

    item_payload = {
        "owner_id": user_id,
        "url": clean_url,
        "url_hash": url_hash,
        "title": title or clean_url,
        "note": note,
        "folder_id": folder_id,
        "status": status,
        "enrich_status": "pending",
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }

    res = db.table("items").insert(item_payload).execute()
    created_item = res.data[0] if res.data else item_payload
    item_id = created_item.get("id")

    # Handle tags if provided
    if tags and item_id:
        for t_name in tags:
            tag_str = t_name.strip()
            if not tag_str:
                continue
            # Find or create tag
            existing_t = db.table("tags").select("id").eq("owner_id", user_id).eq("name", tag_str).execute()
            if existing_t.data:
                tag_id = existing_t.data[0]["id"]
            else:
                new_t = db.table("tags").insert({"owner_id": user_id, "name": tag_str}).execute()
                tag_id = new_t.data[0]["id"] if new_t.data else None

            if tag_id:
                try:
                    db.table("item_tags").insert({"item_id": item_id, "tag_id": tag_id}).execute()
                except Exception as e:
                    logger.debug("Failed to link tag %s to item %s: %s", tag_id, item_id, e)

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
    if not check_item_access_permission(db, user_id, item):
        raise PermissionError("Access denied: You do not have permission to edit this item.")

    updates: Dict[str, Any] = {}
    if title is not None:
        updates["title"] = title
    if note is not None:
        updates["note"] = note
    if folder_id is not None:
        updates["folder_id"] = folder_id if folder_id.strip() else None
    if status is not None:
        updates["status"] = status
        if status == "done":
            updates["done_at"] = datetime.now(timezone.utc).isoformat()

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

    for t in tags:
        try:
            count_res = db.table("item_tags").select("item_id").eq("tag_id", t["id"]).execute()
            t["item_count"] = len(count_res.data or [])
        except Exception:
            t["item_count"] = 0

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
    if not check_item_access_permission(db, user_id, item):
        raise PermissionError("Access denied: You do not have permission to manage tags on this item.")

    # Handle additions
    if add_tags:
        for t_name in add_tags:
            tag_str = t_name.strip()
            if not tag_str:
                continue
            existing = db.table("tags").select("id").eq("owner_id", user_id).eq("name", tag_str).execute()
            if existing.data:
                tag_id = existing.data[0]["id"]
            else:
                new_t = db.table("tags").insert({"owner_id": user_id, "name": tag_str}).execute()
                tag_id = new_t.data[0]["id"] if new_t.data else None

            if tag_id:
                try:
                    db.table("item_tags").insert({"item_id": item_id, "tag_id": tag_id}).execute()
                except Exception as e:
                    logger.debug("Failed to link tag %s: %s", tag_id, e)

    # Handle removals
    if remove_tags:
        for t_name in remove_tags:
            tag_str = t_name.strip()
            existing = db.table("tags").select("id").eq("owner_id", user_id).eq("name", tag_str).execute()
            if existing.data:
                tag_id = existing.data[0]["id"]
                db.table("item_tags").delete().eq("item_id", item_id).eq("tag_id", tag_id).execute()

    return {"success": True, "item_id": item_id, "updated": True}


def rename_or_delete_tag(
    tag_name: str,
    new_name: Optional[str] = None,
    delete: bool = False,
) -> Dict[str, Any]:
    """Rename or delete an existing tag."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    tag_res = db.table("tags").select("id").eq("owner_id", user_id).eq("name", tag_name.strip()).execute()
    if not tag_res.data:
        raise ValueError(f"Tag not found: {tag_name}")

    tag_id = tag_res.data[0]["id"]

    if delete:
        db.table("tags").delete().eq("id", tag_id).execute()
        return {"success": True, "action": "deleted", "tag_name": tag_name}

    if not new_name or not new_name.strip():
        raise ValueError("new_name is required when renaming a tag.")

    db.table("tags").update({"name": new_name.strip()}).eq("id", tag_id).execute()
    return {"success": True, "action": "renamed", "old_name": tag_name, "new_name": new_name.strip()}


# =====================================================================
# 📁 หมวดที่ 3: จัดการโฟลเดอร์ และการแชร์ให้เพื่อน (Folders & Sharing)
# =====================================================================

def list_folders() -> List[Dict[str, Any]]:
    """List all folders owned by the user or shared with the user."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    owned_res = db.table("folders").select("*").eq("owner_id", user_id).execute()
    folders = owned_res.data or []
    for f in folders:
        f["role"] = "owner"

    # Fetch shared folders
    try:
        shared_res = db.table("folder_members").select("folder_id, role").eq("user_id", user_id).execute()
        if shared_res.data:
            for sm in shared_res.data:
                f_id = sm["folder_id"]
                f_res = db.table("folders").select("*").eq("id", f_id).execute()
                if f_res.data:
                    sf = f_res.data[0]
                    sf["role"] = sm["role"]
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
        if not name or not name.strip():
            raise ValueError("name is required to create a folder.")
        payload = {
            "owner_id": user_id,
            "name": name.strip(),
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
        if name and name.strip():
            updates["name"] = name.strip()
        if emoji is not None:
            updates["emoji"] = emoji
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
        db.table("folder_invites").delete().eq("folder_id", folder_id).execute()
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
) -> Dict[str, Any]:
    """Set or cancel a reminder for a saved item."""
    user_id = get_authenticated_user_id()
    db = get_active_db()

    item_res = db.table("items").select("*").eq("id", item_id).execute()
    if not item_res.data:
        raise ValueError(f"Item not found: {item_id}")

    item = item_res.data[0]
    if not check_item_access_permission(db, user_id, item):
        raise PermissionError("Access denied: You do not have permission to set reminders for this item.")

    if cancel:
        db.table("reminders").delete().eq("item_id", item_id).eq("user_id", user_id).execute()
        return {"success": True, "action": "cancelled", "item_id": item_id}

    if not remind_at_iso or not remind_at_iso.strip():
        raise ValueError("remind_at_iso is required when setting a reminder.")

    # Remove existing reminder and insert updated one
    db.table("reminders").delete().eq("item_id", item_id).eq("user_id", user_id).execute()
    payload = {
        "item_id": item_id,
        "user_id": user_id,
        "remind_at": remind_at_iso.strip(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    db.table("reminders").insert(payload).execute()

    return {"success": True, "action": "set", "item_id": item_id, "remind_at": remind_at_iso.strip()}


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

        if raw_token:
            try:
                user_id = resolve_user_id_from_token(raw_token)
                token_reset = _current_user_id_ctx.set(user_id)
                try:
                    return await call_next(request)
                finally:
                    _current_user_id_ctx.reset(token_reset)
            except PermissionError as pe:
                return Response(content=str(pe), status_code=401)

        return await call_next(request)
