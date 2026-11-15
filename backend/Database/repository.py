"""Repository functions for Items, Folders, Invites, Tags, Devices, Reminders, and JSON Export."""

from datetime import datetime, timedelta, timezone
import logging
import os
import re
import secrets
from typing import Any, Dict, List, Optional, Tuple
import uuid
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status

from .schemas import (
    DeviceRegisterRequest,
    FeedbackCreateRequest,
    FolderCreateRequest,
    FolderUpdateRequest,
    InviteCreateRequest,
    ItemCreateRequest,
    ItemUpdateRequest,
    ReminderConfig,
    TagCreateRequest,
    TagUpdateRequest,
)
from .text_hygiene import canonicalize_url, clean_text_field, compute_url_hash, normalize_unicode_text

logger = logging.getLogger("just_save_it.repository")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def compute_next_occurrence_utc(remind_time_str: str, tz_name: str, now_utc: Optional[datetime] = None) -> datetime:
    """Compute next upcoming occurrence in UTC from local HH:MM:SS and IANA timezone."""
    now_ref = now_utc or datetime.now(timezone.utc)
    tz = ZoneInfo(tz_name)
    local_now = now_ref.astimezone(tz)
    hh, mm, ss = (int(part) for part in remind_time_str.split(":"))
    candidate_local = local_now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    if candidate_local <= local_now:
        candidate_local = candidate_local + timedelta(days=1)
    return candidate_local.astimezone(timezone.utc)


def get_folder_role(db: Any, user_id: str, folder_id: str) -> Optional[str]:
    """Return 'owner', 'editor', 'viewer', or None if user has no access to folder."""
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        return None
    if f_res.data[0].get("owner_id") == user_id:
        return "owner"

    m_res = (
        db.table("folder_members")
        .select("role")
        .eq("folder_id", folder_id)
        .eq("user_id", user_id)
        .execute()
    )
    if m_res.data:
        return str(m_res.data[0].get("role"))
    return None


def can_access_item(db: Any, user_id: str, item: Dict[str, Any], require_editor: bool = False) -> bool:
    """Check whether user owns item or holds sufficient shared-folder membership."""
    if item.get("owner_id") == user_id:
        return True
    folder_id = item.get("folder_id")
    if not folder_id:
        return False
    role = get_folder_role(db, user_id, folder_id)
    if role is None:
        return False
    if require_editor:
        return role in ("owner", "editor")
    return role in ("owner", "editor", "viewer")


def _get_accessible_folder_ids(db: Any, user_id: str) -> List[str]:
    folder_ids: List[str] = []
    owned = db.table("folders").select("id").eq("owner_id", user_id).execute()
    for row in owned.data or []:
        if row.get("id"):
            folder_ids.append(row["id"])
    shared = db.table("folder_members").select("folder_id").eq("user_id", user_id).execute()
    for row in shared.data or []:
        fid = row.get("folder_id")
        if fid and fid not in folder_ids:
            folder_ids.append(fid)
    return folder_ids


def _attach_tags_to_item(db: Any, user_id: str, item_id: str, tag_names: List[str]) -> List[str]:
    attached: List[str] = []
    for raw_name in tag_names:
        tag_name = clean_text_field(raw_name, unescape_html=False)
        if not tag_name:
            continue
        existing = db.table("tags").select("id, name").eq("owner_id", user_id).eq("name", tag_name).execute()
        if existing.data:
            tag_id = existing.data[0]["id"]
        else:
            created = db.table("tags").insert({"owner_id": user_id, "name": tag_name}).execute()
            tag_id = created.data[0]["id"] if created.data else None

        if tag_id:
            link_check = db.table("item_tags").select("item_id").eq("item_id", item_id).eq("tag_id", tag_id).execute()
            if not link_check.data:
                db.table("item_tags").insert({"item_id": item_id, "tag_id": tag_id}).execute()
            attached.append(tag_name)
    return attached


def _fetch_item_tags(db: Any, item_id: str) -> List[str]:
    links = db.table("item_tags").select("tag_id").eq("item_id", item_id).execute()
    tag_ids = [row["tag_id"] for row in (links.data or []) if row.get("tag_id")]
    if not tag_ids:
        return []
    tags_res = db.table("tags").select("id, name").in_("id", tag_ids).execute()
    return [row["name"] for row in (tags_res.data or []) if row.get("name")]


def _attach_tags_batch(db: Any, rows: List[Dict[str, Any]]) -> None:
    """Batch-load tags across a list of items in <=2 queries to prevent N+1 roundtrips."""
    target_ids = [str(r["id"]) for r in rows if r.get("id") and "tags" not in r]
    if not target_ids:
        return
    links_res = db.table("item_tags").select("item_id, tag_id").in_("item_id", target_ids).execute()
    link_rows = links_res.data or []
    tag_ids = list({row["tag_id"] for row in link_rows if row.get("tag_id")})
    tag_name_by_id: Dict[str, str] = {}
    if tag_ids:
        tags_res = db.table("tags").select("id, name").in_("id", tag_ids).execute()
        for t in tags_res.data or []:
            if t.get("id") and t.get("name"):
                tag_name_by_id[str(t["id"])] = str(t["name"])
    tags_by_item: Dict[str, List[str]] = {iid: [] for iid in target_ids}
    for lr in link_rows:
        iid = str(lr.get("item_id") or "")
        tid = str(lr.get("tag_id") or "")
        name = tag_name_by_id.get(tid)
        if iid in tags_by_item and name and name not in tags_by_item[iid]:
            tags_by_item[iid].append(name)
    for r in rows:
        iid = str(r.get("id") or "")
        if "tags" not in r and iid:
            r["tags"] = tags_by_item.get(iid, [])


def upsert_item_reminder(
    db: Any,
    user_id: str,
    item_id: str,
    title_snapshot: Optional[str],
    reminder: ReminderConfig,
) -> Dict[str, Any]:
    """Upsert a single reminder rule (once or every_n_days) for (item_id, user_id)."""
    if reminder.remind_at is not None:
        remind_at_dt = reminder.remind_at
        if remind_at_dt.tzinfo is None:
            remind_at_dt = remind_at_dt.replace(tzinfo=timezone.utc)
        else:
            remind_at_dt = remind_at_dt.astimezone(timezone.utc)
    else:
        assert reminder.remind_time is not None
        remind_at_dt = compute_next_occurrence_utc(reminder.remind_time, reminder.timezone)

    now_iso = _now_iso()
    payload: Dict[str, Any] = {
        "item_id": item_id,
        "user_id": user_id,
        "schedule_type": reminder.schedule_type,
        "remind_at": remind_at_dt.isoformat(),
        "repeat_every_days": reminder.repeat_every_days,
        "remind_time": reminder.remind_time,
        "timezone": reminder.timezone,
        "status": "cancelled" if reminder.is_enabled is False else "pending",
        "sent_at": None,
        "title_snapshot": clean_text_field(reminder.title_snapshot or title_snapshot, unescape_html=False),
        "updated_at": now_iso,
    }

    existing = db.table("reminders").select("id").eq("item_id", item_id).eq("user_id", user_id).execute()
    if existing.data:
        res = (
            db.table("reminders")
            .update(payload)
            .eq("id", existing.data[0]["id"])
            .execute()
        )
        return res.data[0] if res.data else payload

    payload["created_at"] = now_iso
    res = db.table("reminders").insert(payload).execute()
    return res.data[0] if res.data else payload


def _with_item_compat_fields(item: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure API compatibility aliases (thumbnail_url, user_note, tag_names, is_favorite) exist alongside SQL columns."""
    media = item.get("media_items") or []
    first_media = None
    if isinstance(media, list) and media:
        head = media[0]
        if isinstance(head, str):
            first_media = head
        elif isinstance(head, dict):
            first_media = head.get("thumbnail_url") or head.get("media_url") or head.get("url")
    item.setdefault("thumbnail_url", item.get("image_url") or first_media)
    item.setdefault("user_note", item.get("note"))
    if "tags" in item:
        item.setdefault("tag_names", item["tags"])
    item.setdefault("is_favorite", bool(item.get("is_favorite", False)))
    return item


def create_or_bump_item(db: Any, user_id: str, req: ItemCreateRequest) -> Dict[str, Any]:
    """Persist item immediately with enrich_status='pending' without waiting on live unfurling."""
    if req.folder_id:
        role = get_folder_role(db, user_id, req.folder_id)
        if role not in ("owner", "editor"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have editor permission in the target folder.",
            )

    canon_url = canonicalize_url(req.url)
    url_hash = compute_url_hash(req.url)
    clean_title = clean_text_field(req.title, unescape_html=True)
    clean_desc = clean_text_field(req.description, unescape_html=True)
    clean_note = clean_text_field(req.note, unescape_html=False)
    clean_image = req.image_url.strip() if isinstance(req.image_url, str) and req.image_url.strip() else None
    clean_embed_url = req.embed_url.strip() if isinstance(req.embed_url, str) and req.embed_url.strip() else None
    now_iso = _now_iso()

    existing_res = (
        db.table("items")
        .select("*")
        .eq("owner_id", user_id)
        .eq("url_hash", url_hash)
        .execute()
    )

    if existing_res.data:
        existing_item = existing_res.data[0]
        item_id = existing_item["id"]
        if existing_item.get("status") in ("done", "archived") and req.reminder is not None and req.status in ("done", "archived"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot set a reminder on a done or archived item.",
            )
        bump_updates: Dict[str, Any] = {"saved_at": now_iso, "updated_at": now_iso}
        if clean_title is not None:
            bump_updates["title"] = clean_title
        if clean_desc is not None:
            bump_updates["description"] = clean_desc
        if clean_note is not None:
            bump_updates["note"] = clean_note
        if req.folder_id is not None:
            bump_updates["folder_id"] = req.folder_id
        if clean_image is not None:
            bump_updates["image_url"] = clean_image
        if clean_embed_url is not None:
            bump_updates["embed_url"] = clean_embed_url
        if req.media_items:
            bump_updates["media_items"] = req.media_items
        if req.is_favorite is not None:
            bump_updates["is_favorite"] = bool(req.is_favorite)
        if existing_item.get("status") in ("done", "archived") and (
            req.reminder is not None or "status" in req.model_fields_set
        ):
            bump_updates["status"] = req.status
            if req.status != "done":
                bump_updates["done_at"] = None
        elif "status" in req.model_fields_set:
            bump_updates["status"] = req.status
            if req.status != "done":
                bump_updates["done_at"] = None
        try:
            upd_res = db.table("items").update(bump_updates).eq("id", item_id).execute()
        except Exception as exc:
            if "is_favorite" in bump_updates and ("is_favorite" in str(exc) or "PGRST204" in str(exc)):
                bump_updates.pop("is_favorite", None)
                upd_res = db.table("items").update(bump_updates).eq("id", item_id).execute()
            else:
                raise
        item = dict(upd_res.data[0]) if upd_res.data else {**existing_item, **bump_updates}
        deduplicated = True
    else:
        if req.reminder is not None and req.status in ("done", "archived"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot set a reminder on a done or archived item.",
            )
        payload: Dict[str, Any] = {
            "owner_id": user_id,
            "folder_id": req.folder_id,
            "url": req.url.strip(),
            "canonical_url": canon_url,
            "url_hash": url_hash,
            "title": clean_title if clean_title is not None else canon_url,
            "description": clean_desc,
            "image_url": clean_image,
            "media_items": req.media_items or [],
            "embed_type": req.embed_type or "none",
            "embed_url": clean_embed_url,
            "content_type": req.content_type,
            "platform": req.platform,
            "note": clean_note,
            "status": req.status,
            "enrich_status": "pending",
            "enrich_attempts": 0,
            "saved_at": now_iso,
            "updated_at": now_iso,
        }
        if req.is_favorite is not None:
            payload["is_favorite"] = bool(req.is_favorite)
        try:
            ins_res = db.table("items").insert(payload).execute()
        except Exception as exc:
            if "is_favorite" in payload and ("is_favorite" in str(exc) or "PGRST204" in str(exc)):
                payload.pop("is_favorite", None)
                ins_res = db.table("items").insert(payload).execute()
            else:
                raise
        item = dict(ins_res.data[0]) if ins_res.data else payload
        item_id = item.get("id", "")
        deduplicated = False

    if req.tags and item_id:
        _attach_tags_to_item(db, user_id, item_id, req.tags)

    if req.reminder and item_id:
        rem = upsert_item_reminder(db, user_id, item_id, item.get("title"), req.reminder)
        item["reminder"] = rem

    item["tags"] = _fetch_item_tags(db, item_id) if item_id else []
    item["deduplicated"] = deduplicated
    return _with_item_compat_fields(item)


_CURSOR_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_DECODED_TZ_PLUS_RE = re.compile(r"(\d) (\d{2}:?\d{2})$")


def _normalize_iso_timestamp(raw_ts: str) -> str:
    """Validate and normalize an ISO-8601 timestamp string to UTC ISO format."""
    cleaned = _DECODED_TZ_PLUS_RE.sub(r"\1+\2", raw_ts.strip())
    if "T" not in cleaned and " " not in cleaned:
        raise ValueError("Missing time component")
    dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _safe_sort_ts(raw_ts: Any) -> str:
    """Normalize saved_at timestamps to UTC ISO strings for consistent keyset sorting."""
    text = str(raw_ts or "").strip()
    if not text:
        return ""
    try:
        return _normalize_iso_timestamp(text)
    except ValueError:
        return text


def _is_valid_uuid(val: str) -> bool:
    """Return True if val is a syntactically valid UUID."""
    try:
        uuid.UUID(val)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _parse_keyset_cursor(cursor: Optional[str]) -> Optional[Tuple[str, str]]:
    """Parse and strictly validate keyset cursor encoded as '{saved_at}|{item_id}'."""
    if cursor is None or not cursor.strip():
        return None
    parts = cursor.strip().split("|", 1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid pagination cursor format.",
        )
    raw_ts, raw_id = parts[0].strip(), parts[1].strip()
    if not _CURSOR_ID_RE.match(raw_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid pagination cursor format.",
        )
    try:
        normalized_ts = _normalize_iso_timestamp(raw_ts)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid pagination cursor format.",
        ) from None
    return normalized_ts, raw_id


def list_and_search_items(
    db: Any,
    user_id: str,
    q: Optional[str] = None,
    status_filter: Optional[str] = None,
    folder_id: Optional[str] = None,
    tag: Optional[str] = None,
    platform: Optional[str] = None,
    content_type: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    cursor: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """List and search accessible items across all 4 text fields + url with optional keyset cursor."""
    cursor_tuple = _parse_keyset_cursor(cursor)

    if folder_id:
        accessible_folders = set(_get_accessible_folder_ids(db, user_id))
        if folder_id not in accessible_folders:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to folder.")
    else:
        accessible_folders = set(_get_accessible_folder_ids(db, user_id))

    if (
        hasattr(db, "rpc")
        and callable(getattr(db, "rpc", None))
        and (cursor_tuple is None or _is_valid_uuid(cursor_tuple[1]))
    ):
        try:
            rpc_res = db.rpc(
                "search_user_items_for_user",
                {
                    "p_user_id": user_id,
                    "p_query": q.strip() if q and q.strip() else None,
                    "p_folder_id": folder_id,
                    "p_tag_name": tag.strip() if tag and tag.strip() else None,
                    "p_status": status_filter,
                    "p_platform": platform,
                    "p_content_type": content_type,
                    "p_cursor_saved_at": cursor_tuple[0] if cursor_tuple else None,
                    "p_cursor_id": cursor_tuple[1] if cursor_tuple else None,
                    "p_limit": limit,
                    "p_offset": 0 if cursor_tuple else offset,
                },
            ).execute()
            rpc_rows = getattr(rpc_res, "data", None)
            if isinstance(rpc_rows, list):
                results: List[Dict[str, Any]] = [dict(row) for row in rpc_rows]
                _attach_tags_batch(db, results)
                for item_dict in results:
                    _with_item_compat_fields(item_dict)
                return results
        except Exception as rpc_exc:
            logger.debug("search_user_items_for_user RPC fallback to Python filter: %s", rpc_exc)

    owned_res = db.table("items").select("*").eq("owner_id", user_id).execute()
    seen_ids = set()
    candidates: List[Dict[str, Any]] = []
    for row in owned_res.data or []:
        if row.get("id") not in seen_ids:
            seen_ids.add(row.get("id"))
            candidates.append(dict(row))

    if accessible_folders:
        shared_res = db.table("items").select("*").in_("folder_id", list(accessible_folders)).execute()
        for row in shared_res.data or []:
            if row.get("id") not in seen_ids:
                seen_ids.add(row.get("id"))
                candidates.append(dict(row))

    if status_filter:
        candidates = [item for item in candidates if item.get("status") == status_filter]
    if folder_id:
        candidates = [item for item in candidates if item.get("folder_id") == folder_id]
    if platform:
        candidates = [item for item in candidates if item.get("platform") == platform]
    if content_type:
        candidates = [item for item in candidates if item.get("content_type") == content_type]

    if tag and tag.strip() and candidates:
        tag_norm = normalize_unicode_text(tag.strip()).lower()
        candidate_ids = [item["id"] for item in candidates if item.get("id")]
        links_res = db.table("item_tags").select("item_id, tag_id").in_("item_id", candidate_ids).execute()
        candidate_tag_ids = list({row["tag_id"] for row in (links_res.data or []) if row.get("tag_id")})
        if not candidate_tag_ids:
            return []
        tag_rows = db.table("tags").select("id, name").in_("id", candidate_tag_ids).execute()
        matching_tag_ids = {
            row["id"]
            for row in (tag_rows.data or [])
            if normalize_unicode_text(row.get("name", "")).lower() == tag_norm
        }
        if not matching_tag_ids:
            return []
        valid_ids = {row["item_id"] for row in (links_res.data or []) if row.get("tag_id") in matching_tag_ids}
        candidates = [item for item in candidates if item.get("id") in valid_ids]
    elif tag and tag.strip():
        return []

    if q and q.strip():
        needle = normalize_unicode_text(q.strip()).lower()
        filtered: List[Dict[str, Any]] = []
        for item in candidates:
            haystack = " ".join(
                normalize_unicode_text(item.get(field) or "")
                for field in ("title", "description", "note", "ai_summary", "url")
            ).lower()
            if needle in haystack:
                filtered.append(item)
        candidates = filtered

    candidates.sort(
        key=lambda row: (_safe_sort_ts(row.get("saved_at")), str(row.get("id") or "")),
        reverse=True,
    )
    if cursor_tuple is not None:
        candidates = [
            item
            for item in candidates
            if (_safe_sort_ts(item.get("saved_at")), str(item.get("id") or "")) < cursor_tuple
        ]
        sliced = candidates[:limit]
    else:
        sliced = candidates[offset : offset + limit]

    _attach_tags_batch(db, sliced)
    for row in sliced:
        _with_item_compat_fields(row)
    return sliced


def get_item_for_user(db: Any, user_id: str, item_id: str) -> Dict[str, Any]:
    res = db.table("items").select("*").eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    item = dict(res.data[0])
    if not can_access_item(db, user_id, item, require_editor=False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    item["tags"] = _fetch_item_tags(db, item_id)
    rem_res = db.table("reminders").select("*").eq("item_id", item_id).eq("user_id", user_id).execute()
    item["reminders"] = rem_res.data or []
    return _with_item_compat_fields(item)


def update_item_for_user(db: Any, user_id: str, item_id: str, req: ItemUpdateRequest) -> Dict[str, Any]:
    res = db.table("items").select("*").eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    item = dict(res.data[0])
    if not can_access_item(db, user_id, item, require_editor=True):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Editor permission required.")

    updates: Dict[str, Any] = {}
    fields_set = req.model_fields_set
    if "title" in fields_set:
        updates["title"] = clean_text_field(req.title, unescape_html=True)
    if "description" in fields_set:
        updates["description"] = clean_text_field(req.description, unescape_html=True)
    if "note" in fields_set:
        updates["note"] = clean_text_field(req.note, unescape_html=False)
    if "folder_id" in fields_set:
        if req.folder_id != item.get("folder_id"):
            if item.get("owner_id") != user_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only the item owner can move an item across folders.",
                )
            if req.folder_id is not None:
                role = get_folder_role(db, user_id, req.folder_id)
                if role not in ("owner", "editor"):
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Target folder access denied.")
        updates["folder_id"] = req.folder_id
    if "platform" in fields_set:
        updates["platform"] = req.platform
    if "content_type" in fields_set:
        updates["content_type"] = req.content_type
    if "image_url" in fields_set:
        updates["image_url"] = req.image_url
    if "embed_url" in fields_set:
        updates["embed_url"] = req.embed_url
    if "embed_type" in fields_set and req.embed_type is not None:
        updates["embed_type"] = req.embed_type
    if "media_items" in fields_set:
        updates["media_items"] = req.media_items or []
    if "is_favorite" in fields_set and req.is_favorite is not None:
        updates["is_favorite"] = bool(req.is_favorite)
    if "status" in fields_set and req.status is not None:
        updates["status"] = req.status
        if req.status == "done":
            updates["done_at"] = _now_iso()
        else:
            updates["done_at"] = None
        if req.status in ("done", "archived") and item.get("status") != req.status:
            db.table("reminders").update({"status": "cancelled", "updated_at": _now_iso()}).eq(
                "item_id", item_id
            ).eq("status", "pending").execute()

    if updates:
        updates["updated_at"] = _now_iso()
        try:
            upd_res = db.table("items").update(updates).eq("id", item_id).execute()
        except Exception as exc:
            if "is_favorite" in updates and ("is_favorite" in str(exc) or "PGRST204" in str(exc)):
                updates.pop("is_favorite", None)
                upd_res = db.table("items").update(updates).eq("id", item_id).execute()
            else:
                raise
        item = dict(upd_res.data[0]) if upd_res.data else {**item, **updates}

    if "tags" in fields_set and req.tags is not None:
        db.table("item_tags").delete().eq("item_id", item_id).execute()
        tag_owner_id = str(item.get("owner_id") or user_id)
        _attach_tags_to_item(db, tag_owner_id, item_id, req.tags)

    item["tags"] = _fetch_item_tags(db, item_id)
    return _with_item_compat_fields(item)


def delete_item_for_user(db: Any, user_id: str, item_id: str) -> Dict[str, Any]:
    res = db.table("items").select("id, owner_id").eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    if res.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owner can delete item.")
    db.table("items").delete().eq("id", item_id).execute()
    return {"deleted": True, "item_id": item_id}


def _attach_folder_member_counts(db: Any, folders: List[Dict[str, Any]]) -> None:
    """Attach accurate non-owner collaborator counts onto folder dicts without N+1 queries."""
    folder_ids = [f.get("id") for f in folders if f.get("id")]
    if not folder_ids:
        return
    try:
        mem_res = db.table("folder_members").select("folder_id, user_id, role").in_("folder_id", folder_ids).execute()
    except Exception:
        return
    counts: Dict[str, int] = {}
    for row in mem_res.data or []:
        fid = row.get("folder_id")
        if fid and row.get("role") != "owner":
            counts[fid] = counts.get(fid, 0) + 1
    for f in folders:
        fid = f.get("id")
        f["member_count"] = counts.get(fid, 0) if fid else 0


def list_folders_for_user(db: Any, user_id: str) -> List[Dict[str, Any]]:
    owned = db.table("folders").select("*").eq("owner_id", user_id).execute()
    folders: List[Dict[str, Any]] = []
    seen = set()
    for row in owned.data or []:
        f = dict(row)
        f["role"] = "owner"
        folders.append(f)
        seen.add(f["id"])

    memberships = db.table("folder_members").select("folder_id, role").eq("user_id", user_id).execute()
    for m in memberships.data or []:
        fid = m.get("folder_id")
        if not fid or fid in seen:
            continue
        f_res = db.table("folders").select("*").eq("id", fid).execute()
        if f_res.data:
            f = dict(f_res.data[0])
            f["role"] = m.get("role")
            folders.append(f)
            seen.add(fid)
    _attach_folder_member_counts(db, folders)
    return folders


def create_folder_for_user(db: Any, user_id: str, req: FolderCreateRequest) -> Dict[str, Any]:
    clean_name = clean_text_field(req.name, unescape_html=False)
    if not clean_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder name cannot be blank.")
    now_iso = _now_iso()
    payload: Dict[str, Any] = {
        "owner_id": user_id,
        "name": clean_name,
        "emoji": req.emoji,
        "is_shared": False,
        "created_at": now_iso,
        "updated_at": now_iso,
    }
    if req.cover_url:
        payload["cover_url"] = req.cover_url
    try:
        res = db.table("folders").insert(payload).execute()
    except Exception as exc:
        if "cover_url" in payload and ("cover_url" in str(exc) or "PGRST204" in str(exc)):
            payload.pop("cover_url", None)
            res = db.table("folders").insert(payload).execute()
        else:
            raise
    row = dict(res.data[0]) if res.data else payload
    row["role"] = "owner"
    row.setdefault("member_count", 0)
    return row


def update_folder_for_user(db: Any, user_id: str, folder_id: str, req: FolderUpdateRequest) -> Dict[str, Any]:
    f_res = db.table("folders").select("*").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    if f_res.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only folder owner can update folder.")

    updates: Dict[str, Any] = {}
    if req.name is not None:
        clean_name = clean_text_field(req.name, unescape_html=False)
        if not clean_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder name cannot be blank.")
        updates["name"] = clean_name
    if "emoji" in req.model_fields_set:
        updates["emoji"] = req.emoji
    if "cover_url" in req.model_fields_set:
        updates["cover_url"] = req.cover_url
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No folder fields to update.")

    updates["updated_at"] = _now_iso()
    try:
        res = db.table("folders").update(updates).eq("id", folder_id).execute()
    except Exception as exc:
        if "cover_url" in updates and ("cover_url" in str(exc) or "PGRST204" in str(exc)):
            updates.pop("cover_url", None)
            if len(updates) <= 1:
                return dict(f_res.data[0])
            res = db.table("folders").update(updates).eq("id", folder_id).execute()
        else:
            raise
    return dict(res.data[0]) if res.data else {**f_res.data[0], **updates}


def delete_folder_for_user(db: Any, user_id: str, folder_id: str) -> Dict[str, Any]:
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    if f_res.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only folder owner can delete folder.")
    db.table("folders").delete().eq("id", folder_id).execute()
    return {"deleted": True, "folder_id": folder_id}


def create_folder_invite(db: Any, user_id: str, folder_id: str, req: InviteCreateRequest) -> Dict[str, Any]:
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    if f_res.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only folder owner can create invites.")

    token = secrets.token_hex(16)
    expires_at = datetime.now(timezone.utc) + timedelta(days=req.expires_in_days)
    payload: Dict[str, Any] = {
        "token": token,
        "folder_id": folder_id,
        "role": req.role,
        "created_by": user_id,
        "max_uses": req.max_uses,
        "use_count": 0,
        "revoked_at": None,
        "expires_at": expires_at.isoformat(),
        "created_at": _now_iso(),
    }
    db.table("folder_invites").insert(payload).execute()
    db.table("folders").update({"is_shared": True, "updated_at": _now_iso()}).eq("id", folder_id).execute()

    app_url = os.getenv("APP_URL", "https://just-save-it-web.onrender.com").rstrip("/")
    return {
        "token": token,
        "folder_id": folder_id,
        "role": req.role,
        "max_uses": req.max_uses,
        "expires_at": expires_at.isoformat(),
        "invite_url": f"{app_url}/invite/{token}",
    }


def preview_folder_invite(db: Any, invite_token: str) -> Dict[str, Any]:
    """Return safe, non-PII folder metadata & validity status for an invite token landing page."""
    clean_tok = (invite_token or "").strip()
    if len(clean_tok) < 8 or len(clean_tok) > 128:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.")

    inv_res = db.table("folder_invites").select("*").eq("token", clean_tok).execute()
    if not inv_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.")

    inv = inv_res.data[0]
    valid = True
    reason: Optional[str] = None
    if inv.get("revoked_at") is not None:
        valid = False
        reason = "revoked"
    else:
        expires_dt = _parse_iso(inv.get("expires_at"))
        if expires_dt is not None and expires_dt <= datetime.now(timezone.utc):
            valid = False
            reason = "expired"
        else:
            max_uses = inv.get("max_uses")
            use_count = int(inv.get("use_count") or 0)
            if max_uses is not None and use_count >= int(max_uses):
                valid = False
                reason = "max_uses_reached"

    folder_id = inv.get("folder_id")
    f_res = db.table("folders").select("*").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target folder not found.")
    folder = f_res.data[0]

    owner_id = folder.get("owner_id")
    inviter_name = "สมาชิก Sharely"
    if owner_id:
        try:
            prof_res = db.table("profiles").select("display_name").eq("id", owner_id).execute()
            if prof_res.data and prof_res.data[0].get("display_name"):
                inviter_name = str(prof_res.data[0]["display_name"]).strip()
        except Exception:
            pass

    item_count = 0
    try:
        items_res = db.table("items").select("id").eq("folder_id", folder_id).execute()
        item_count = len(items_res.data or [])
    except Exception:
        item_count = 0

    return {
        "token": clean_tok,
        "valid": valid,
        "reason": reason,
        "folder_id": folder_id,
        "folder_name": folder.get("name") or "โฟลเดอร์ที่แชร์",
        "folder_emoji": folder.get("emoji") or "📁",
        "folder_cover_url": folder.get("cover_url"),
        "role": inv.get("role") or "viewer",
        "inviter_name": inviter_name,
        "item_count": item_count,
    }


def accept_folder_invite(db: Any, user_id: str, invite_token: str) -> Dict[str, Any]:
    """Validate expiry/revocation/max_uses and atomically add user to folder_members."""
    if hasattr(db, "rpc"):
        try:
            rpc_res = db.rpc(
                "accept_invite_for_user",
                {"p_user_id": user_id, "invite_token": invite_token},
            ).execute()
            if isinstance(rpc_res.data, dict):
                return rpc_res.data
            if isinstance(rpc_res.data, list) and rpc_res.data and isinstance(rpc_res.data[0], dict):
                return rpc_res.data[0]
        except Exception as exc:
            msg = str(exc).lower()
            if "not found" in msg:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.") from exc
            if "revoked" in msg or "expired" in msg or "max uses" in msg:
                raise HTTPException(status_code=status.HTTP_410_GONE, detail=str(exc)) from exc
            if "owner" in msg:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
            raise

    inv_res = db.table("folder_invites").select("*").eq("token", invite_token).execute()
    if not inv_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.")

    inv = inv_res.data[0]
    if inv.get("revoked_at") is not None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invite has been revoked.")

    expires_dt = _parse_iso(inv.get("expires_at"))
    if expires_dt is not None and expires_dt <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invite has expired.")

    max_uses = inv.get("max_uses")
    use_count = int(inv.get("use_count") or 0)
    if max_uses is not None and use_count >= int(max_uses):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Invite usage limit reached.")

    role = inv.get("role")
    if role == "owner":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Owner role cannot be granted via invite.")

    folder_id = inv["folder_id"]
    f_res = db.table("folders").select("owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target folder not found.")

    # Optimistic CAS increment on use_count to prevent concurrent max_uses bypass
    cas_res = (
        db.table("folder_invites")
        .update({"use_count": use_count + 1})
        .eq("token", invite_token)
        .eq("use_count", use_count)
        .execute()
    )
    if hasattr(cas_res, "data") and not cas_res.data:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Concurrent invite acceptance; retry.")

    if f_res.data[0].get("owner_id") != user_id:
        existing_mem = (
            db.table("folder_members")
            .select("role")
            .eq("folder_id", folder_id)
            .eq("user_id", user_id)
            .execute()
        )
        if existing_mem.data:
            if existing_mem.data[0].get("role") != "owner":
                db.table("folder_members").update({"role": role}).eq("folder_id", folder_id).eq(
                    "user_id", user_id
                ).execute()
        else:
            db.table("folder_members").insert(
                {"folder_id": folder_id, "user_id": user_id, "role": role, "joined_at": _now_iso()}
            ).execute()

    final_role = "owner" if f_res.data[0].get("owner_id") == user_id else role
    return {"status": "accepted", "folder_id": folder_id, "role": final_role}


def list_tags_for_user(db: Any, user_id: str) -> List[Dict[str, Any]]:
    res = db.table("tags").select("*").eq("owner_id", user_id).execute()
    return [dict(row) for row in (res.data or [])]


def create_tag_for_user(db: Any, user_id: str, req: TagCreateRequest) -> Dict[str, Any]:
    clean_name = clean_text_field(req.name, unescape_html=False)
    if not clean_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tag name cannot be blank.")
    existing = db.table("tags").select("*").eq("owner_id", user_id).eq("name", clean_name).execute()
    if existing.data:
        return dict(existing.data[0])
    payload = {"owner_id": user_id, "name": clean_name, "color": req.color, "created_at": _now_iso()}
    res = db.table("tags").insert(payload).execute()
    return dict(res.data[0]) if res.data else payload


def update_tag_for_user(db: Any, user_id: str, tag_id: str, req: TagUpdateRequest) -> Dict[str, Any]:
    existing = db.table("tags").select("*").eq("id", tag_id).execute()
    if not existing.data or existing.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found.")
    updates: Dict[str, Any] = {}
    if req.name is not None:
        clean_name = clean_text_field(req.name, unescape_html=False)
        if not clean_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tag name cannot be blank.")
        updates["name"] = clean_name
    if "color" in req.model_fields_set:
        updates["color"] = req.color
    if not updates:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No tag fields to update.")
    res = db.table("tags").update(updates).eq("id", tag_id).execute()
    return dict(res.data[0]) if res.data else {**existing.data[0], **updates}


def delete_tag_for_user(db: Any, user_id: str, tag_id: str) -> Dict[str, Any]:
    existing = db.table("tags").select("id, owner_id").eq("id", tag_id).execute()
    if not existing.data or existing.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found.")
    db.table("item_tags").delete().eq("tag_id", tag_id).execute()
    db.table("tags").delete().eq("id", tag_id).execute()
    return {"deleted": True, "tag_id": tag_id}


def register_device_for_user(db: Any, user_id: str, req: DeviceRegisterRequest) -> Dict[str, Any]:
    """Register or refresh a user device for remote push or iOS local_sync."""
    now_iso = _now_iso()
    web_endpoint = (
        str(req.web_push_sub.get("endpoint") or "").strip()
        if isinstance(req.web_push_sub, dict)
        else ""
    )
    effective_push_token = (req.push_token or "").strip() or (web_endpoint or None)

    if effective_push_token:
        existing = db.table("devices").select("*").eq("push_token", effective_push_token).execute()
        if existing.data:
            if existing.data[0].get("user_id") != user_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Push token is already bound to another account.",
                )
            dev_id = existing.data[0]["id"]
            updates = {
                "platform": req.platform,
                "delivery_mode": req.delivery_mode,
                "push_token": effective_push_token,
                "web_push_sub": req.web_push_sub,
                "is_active": req.is_active,
                "last_seen": now_iso,
            }
            res = db.table("devices").update(updates).eq("id", dev_id).eq("user_id", user_id).execute()
            return dict(res.data[0]) if res.data else {**existing.data[0], **updates}

    if req.delivery_mode == "local_sync":
        existing_local = (
            db.table("devices")
            .select("*")
            .eq("user_id", user_id)
            .eq("platform", req.platform)
            .eq("delivery_mode", "local_sync")
            .execute()
        )
        if existing_local.data:
            dev_id = existing_local.data[0]["id"]
            updates = {"is_active": req.is_active, "last_seen": now_iso}
            res = db.table("devices").update(updates).eq("id", dev_id).execute()
            return dict(res.data[0]) if res.data else {**existing_local.data[0], **updates}

    payload = {
        "user_id": user_id,
        "platform": req.platform,
        "delivery_mode": req.delivery_mode,
        "push_token": effective_push_token,
        "web_push_sub": req.web_push_sub,
        "is_active": req.is_active,
        "last_seen": now_iso,
        "created_at": now_iso,
    }
    res = db.table("devices").insert(payload).execute()
    return dict(res.data[0]) if res.data else payload


def deactivate_device_for_user(
    db: Any,
    user_id: str,
    *,
    push_token: Optional[str] = None,
    endpoint: Optional[str] = None,
    platform: Optional[str] = "web",
) -> Dict[str, Any]:
    """Deactivate matching active push device(s) scoped strictly to the caller user."""
    now_iso = _now_iso()
    target = (push_token or endpoint or "").strip()
    dev_res = db.table("devices").select("*").eq("user_id", user_id).eq("is_active", True).execute()
    deactivated = 0
    for row in dev_res.data or []:
        row_sub = row.get("web_push_sub") if isinstance(row.get("web_push_sub"), dict) else {}
        row_endpoint = str(row_sub.get("endpoint") or "").strip()
        row_token = str(row.get("push_token") or "").strip()
        if target:
            if row_token != target and row_endpoint != target:
                continue
        elif platform and str(row.get("platform") or "").lower() != platform:
            continue
        db.table("devices").update({"is_active": False, "last_seen": now_iso}).eq("id", row["id"]).eq("user_id", user_id).execute()
        deactivated += 1
    return {"deactivated": deactivated}


def export_user_data(db: Any, user_id: str) -> Dict[str, Any]:
    """Export all user-owned data cleanly as portable JSON (no secret hashes)."""
    prof_res = db.table("profiles").select("*").eq("id", user_id).execute()
    profile = dict(prof_res.data[0]) if prof_res.data else {"id": user_id}

    folders = list_folders_for_user(db, user_id)
    tags = list_tags_for_user(db, user_id)
    items: List[Dict[str, Any]] = []
    page_size = 500
    offset = 0
    while True:
        batch = list_and_search_items(db, user_id, limit=page_size, offset=offset)
        items.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    for item in items:
        item["tags"] = _fetch_item_tags(db, item["id"])

    reminders_res = db.table("reminders").select("*").eq("user_id", user_id).execute()
    devices_res = db.table("devices").select("*").eq("user_id", user_id).execute()
    tokens_res = (
        db.table("api_tokens")
        .select("id, name, token_prefix, last_used_at, revoked_at, created_at")
        .eq("user_id", user_id)
        .execute()
    )
    sanitized_tokens = [
        {
            "id": t.get("id"),
            "name": t.get("name"),
            "token_prefix": t.get("token_prefix"),
            "last_used_at": t.get("last_used_at"),
            "revoked_at": t.get("revoked_at"),
            "created_at": t.get("created_at"),
        }
        for t in (tokens_res.data or [])
    ]

    return {
        "schema_version": "1.0",
        "exported_at": _now_iso(),
        "user_id": user_id,
        "profile": profile,
        "folders": folders,
        "tags": tags,
        "items": items,
        "reminders": reminders_res.data or [],
        "devices": devices_res.data or [],
        "api_tokens": sanitized_tokens,
    }


def _sync_folder_is_shared(db: Any, folder_id: str, owner_id: str) -> bool:
    """Set folders.is_shared=True iff non-owner members or active invites remain."""
    members_res = db.table("folder_members").select("user_id").eq("folder_id", folder_id).execute()
    has_members = any(m.get("user_id") != owner_id for m in (members_res.data or []))

    invites_res = db.table("folder_invites").select("revoked_at, expires_at").eq("folder_id", folder_id).execute()
    now_utc = datetime.now(timezone.utc)
    has_active_invites = False
    for inv in invites_res.data or []:
        if inv.get("revoked_at") is not None:
            continue
        exp = _parse_iso(inv.get("expires_at"))
        if exp is not None and exp <= now_utc:
            continue
        has_active_invites = True
        break

    is_shared = bool(has_members or has_active_invites)
    db.table("folders").update({"is_shared": is_shared, "updated_at": _now_iso()}).eq("id", folder_id).execute()
    return is_shared


def list_folder_members(db: Any, user_id: str, folder_id: str) -> Dict[str, Any]:
    """List folder owner, members, and (for owners) invites."""
    role = get_folder_role(db, user_id, folder_id)
    if role is None:
        f_exists = db.table("folders").select("id").eq("id", folder_id).execute()
        if not f_exists.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to folder.")

    f_res = db.table("folders").select("*").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    folder = f_res.data[0]

    mem_res = db.table("folder_members").select("*").eq("folder_id", folder_id).execute()
    active_invites: List[Dict[str, Any]] = []
    if role == "owner":
        inv_res = db.table("folder_invites").select("*").eq("folder_id", folder_id).execute()
        active_invites = [dict(inv) for inv in (inv_res.data or []) if inv.get("revoked_at") is None]

    return {
        "folder_id": folder_id,
        "owner_id": folder.get("owner_id"),
        "caller_role": role,
        "is_shared": bool(folder.get("is_shared")),
        "members": [dict(m) for m in (mem_res.data or [])],
        "active_invites": active_invites,
    }


def update_folder_member_role(
    db: Any,
    user_id: str,
    folder_id: str,
    member_user_id: str,
    new_role: str,
) -> Dict[str, Any]:
    """Update an existing shared folder member's role (owner only)."""
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    if f_res.data[0].get("owner_id") != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only folder owner can update member roles.")
    if member_user_id == f_res.data[0].get("owner_id"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot change folder owner's role.")

    mem_res = (
        db.table("folder_members")
        .select("*")
        .eq("folder_id", folder_id)
        .eq("user_id", member_user_id)
        .execute()
    )
    if not mem_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder member not found.")

    upd = (
        db.table("folder_members")
        .update({"role": new_role})
        .eq("folder_id", folder_id)
        .eq("user_id", member_user_id)
        .execute()
    )
    return dict(upd.data[0]) if upd.data else {**mem_res.data[0], "role": new_role}


def remove_folder_member(db: Any, user_id: str, folder_id: str, member_user_id: str) -> Dict[str, Any]:
    """Remove a member from a shared folder (owner removes any member; member may leave)."""
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    owner_id = f_res.data[0].get("owner_id", "")

    if user_id != owner_id and user_id != member_user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the folder owner or the member themselves can remove this membership.",
        )
    if member_user_id == owner_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder owner cannot be removed.")

    mem_res = (
        db.table("folder_members")
        .select("*")
        .eq("folder_id", folder_id)
        .eq("user_id", member_user_id)
        .execute()
    )
    if not mem_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder member not found.")

    db.table("folder_members").delete().eq("folder_id", folder_id).eq("user_id", member_user_id).execute()
    is_shared = _sync_folder_is_shared(db, folder_id, owner_id)
    return {
        "removed": True,
        "folder_id": folder_id,
        "member_user_id": member_user_id,
        "is_shared": is_shared,
    }


def revoke_folder_invite(db: Any, user_id: str, folder_id: str, token: str) -> Dict[str, Any]:
    """Soft-revoke a folder invite token by setting revoked_at (owner only)."""
    f_res = db.table("folders").select("id, owner_id").eq("id", folder_id).execute()
    if not f_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
    owner_id = f_res.data[0].get("owner_id", "")
    if owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only folder owner can revoke invites.")

    inv_res = (
        db.table("folder_invites")
        .select("*")
        .eq("folder_id", folder_id)
        .eq("token", token)
        .execute()
    )
    if not inv_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.")

    revoked_at = _now_iso()
    db.table("folder_invites").update({"revoked_at": revoked_at}).eq("folder_id", folder_id).eq("token", token).execute()
    is_shared = _sync_folder_is_shared(db, folder_id, owner_id)
    return {"revoked": True, "folder_id": folder_id, "token": token, "revoked_at": revoked_at, "is_shared": is_shared}


def create_beta_feedback(db: Any, user_id: str, req: FeedbackCreateRequest) -> Dict[str, Any]:
    """Persist user waitlist/beta feedback submission for REQ-005."""
    payload: Dict[str, Any] = {
        "user_id": user_id,
        "category": req.category,
        "message": req.message,
        "contact_email": req.contact_email,
        "allow_contact": req.allow_contact,
        "created_at": _now_iso(),
    }
    if req.page_context and bool(getattr(db, "is_local_dev", False)):
        payload["page_context"] = req.page_context.strip()
    res = db.table("beta_feedback").insert(payload).execute()
    row = dict(res.data[0]) if res.data else payload
    if req.page_context:
        row.setdefault("page_context", req.page_context.strip())
    return row


def list_user_beta_feedback(db: Any, user_id: str) -> List[Dict[str, Any]]:
    """List authenticated user's own beta feedback submissions ordered newest-first."""
    res = db.table("beta_feedback").select("*").eq("user_id", user_id).execute()
    rows = [dict(r) for r in (res.data or [])]
    rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return rows
