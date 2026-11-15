"""FastAPI router for Just-Save-It Database CRUD, Sharing, Devices, and JSON Export."""

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status

_logger = logging.getLogger("just_save_it.database.router")

from Login.auth_dep import get_current_user_id
from Login.dependencies import CurrentUser, get_current_user
from Login.router import build_user_me_payload
from Reminders.service import list_reminders_for_user
from .client import get_db
from .repository import (
    accept_folder_invite,
    create_beta_feedback,
    create_folder_for_user,
    create_folder_invite,
    create_or_bump_item,
    create_tag_for_user,
    delete_folder_for_user,
    delete_item_for_user,
    delete_tag_for_user,
    export_user_data,
    get_item_for_user,
    list_and_search_items,
    list_folder_members,
    list_folders_for_user,
    list_tags_for_user,
    list_user_beta_feedback,
    preview_folder_invite,
    register_device_for_user,
    remove_folder_member,
    revoke_folder_invite,
    update_folder_for_user,
    update_folder_member_role,
    update_item_for_user,
    update_tag_for_user,
)
from .schemas import (
    DeviceRegisterRequest,
    FeedbackCreateRequest,
    FolderCreateRequest,
    FolderMemberRoleUpdateRequest,
    FolderUpdateRequest,
    InviteCreateRequest,
    ItemCreateRequest,
    ItemUpdateRequest,
    TagCreateRequest,
    TagUpdateRequest,
)

router = APIRouter(prefix="/api", tags=["Database CRUD & Export"])


async def _run_local_enrichment(db: Any, item_id: str) -> None:
    """Trigger Unfurl enrichment asynchronously unless webhook/another worker already enriched it."""
    try:
        existing = db.table("items").select("enrich_status").eq("id", item_id).execute()
        if existing.data and existing.data[0].get("enrich_status") in ("unfurled", "done"):
            return
        from Unfurl.service import enrich_item

        await enrich_item(db, item_id)
    except Exception as exc:
        _logger.warning("Background enrichment failed for %s: %s", item_id, exc)


@router.post("/items", status_code=status.HTTP_201_CREATED)
def create_item_endpoint(
    req: ItemCreateRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Save or deduplicate a link immediately with enrich_status='pending'."""
    item = create_or_bump_item(db, user_id, req)
    is_local_dev = getattr(db, "is_local_dev", False)
    auto_cloud_enrich = (
        os.getenv("AUTO_ENRICH_ON_CREATE", "true").strip().lower() != "false"
        and not os.getenv("PYTEST_CURRENT_TEST")
    )
    if (
        (is_local_dev or auto_cloud_enrich)
        and item.get("enrich_status") == "pending"
        and item.get("id")
        and os.getenv("DISABLE_LOCAL_BG_ENRICH", "").strip().lower() != "true"
    ):
        background_tasks.add_task(_run_local_enrichment, db, str(item["id"]))
    return item


@router.get("/workspace")
def get_workspace_endpoint(
    limit: int = Query(default=100, ge=1, le=100),
    current_user: CurrentUser = Depends(get_current_user),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Return profile/quota, folders, tags, latest items, and reminders in 1 roundtrip."""
    user_id = current_user.id
    me_payload = build_user_me_payload(db, current_user)
    folders = list_folders_for_user(db, user_id)
    accessible_ids = {str(f["id"]) for f in folders if f.get("id")}
    tags = list_tags_for_user(db, user_id)
    items = list_and_search_items(
        db=db,
        user_id=user_id,
        limit=limit,
        accessible_folders=accessible_ids,
    )
    next_cursor: Optional[str] = None
    if len(items) == limit and items and items[-1].get("saved_at") and items[-1].get("id"):
        next_cursor = f"{items[-1]['saved_at']}|{items[-1]['id']}"
    reminders_resp = list_reminders_for_user(db, user_id)
    reminders = [r.model_dump() for r in reminders_resp.reminders]
    return {
        **me_payload,
        "folders": folders,
        "tags": tags,
        "items": items,
        "count": len(items),
        "next_cursor": next_cursor,
        "reminders": reminders,
        "reminders_total": len(reminders),
    }


@router.get("/items")
def list_items_endpoint(
    q: Optional[str] = Query(default=None, description="Multi-language search across title, description, note, ai_summary"),
    item_status: Optional[str] = Query(default=None, alias="status"),
    folder_id: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    platform: Optional[str] = Query(default=None),
    content_type: Optional[str] = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    cursor: Optional[str] = Query(default=None, description="Keyset cursor formatted as saved_at|id"),
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """List and search user-owned and shared-folder items."""
    items = list_and_search_items(
        db=db,
        user_id=user_id,
        q=q,
        status_filter=item_status,
        folder_id=folder_id,
        tag=tag,
        platform=platform,
        content_type=content_type,
        limit=limit,
        offset=offset,
        cursor=cursor,
    )
    next_cursor: Optional[str] = None
    if len(items) == limit and items and items[-1].get("saved_at") and items[-1].get("id"):
        next_cursor = f"{items[-1]['saved_at']}|{items[-1]['id']}"
    return {"items": items, "count": len(items), "next_cursor": next_cursor}


@router.get("/items/{item_id}")
def get_item_endpoint(
    item_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return get_item_for_user(db, user_id, item_id)


@router.patch("/items/{item_id}")
def update_item_endpoint(
    item_id: str,
    req: ItemUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return update_item_for_user(db, user_id, item_id, req)


@router.delete("/items/{item_id}")
def delete_item_endpoint(
    item_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return delete_item_for_user(db, user_id, item_id)


@router.get("/folders")
def list_folders_endpoint(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    return {"folders": list_folders_for_user(db, user_id)}


@router.post("/folders", status_code=status.HTTP_201_CREATED)
def create_folder_endpoint(
    req: FolderCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return create_folder_for_user(db, user_id, req)


@router.patch("/folders/{folder_id}")
def update_folder_endpoint(
    folder_id: str,
    req: FolderUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return update_folder_for_user(db, user_id, folder_id, req)


@router.delete("/folders/{folder_id}")
def delete_folder_endpoint(
    folder_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return delete_folder_for_user(db, user_id, folder_id)


@router.post("/folders/{folder_id}/invites", status_code=status.HTTP_201_CREATED)
def create_invite_endpoint(
    folder_id: str,
    req: InviteCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return create_folder_invite(db, user_id, folder_id, req)


@router.get("/invites/{token}")
def preview_invite_endpoint(
    token: str,
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return preview_folder_invite(db, token)


@router.post("/invites/{token}/accept")
def accept_invite_endpoint(
    token: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return accept_folder_invite(db, user_id, token)


@router.get("/folders/{folder_id}/members")
def list_folder_members_endpoint(
    folder_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return list_folder_members(db, user_id, folder_id)


@router.patch("/folders/{folder_id}/members/{member_user_id}")
def update_folder_member_endpoint(
    folder_id: str,
    member_user_id: str,
    req: FolderMemberRoleUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return update_folder_member_role(db, user_id, folder_id, member_user_id, req.role)


@router.delete("/folders/{folder_id}/members/{member_user_id}")
def remove_folder_member_endpoint(
    folder_id: str,
    member_user_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return remove_folder_member(db, user_id, folder_id, member_user_id)


@router.delete("/folders/{folder_id}/invites/{token}")
def revoke_folder_invite_endpoint(
    folder_id: str,
    token: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return revoke_folder_invite(db, user_id, folder_id, token)


@router.get("/tags")
def list_tags_endpoint(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    return {"tags": list_tags_for_user(db, user_id)}


@router.post("/tags", status_code=status.HTTP_201_CREATED)
def create_tag_endpoint(
    req: TagCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return create_tag_for_user(db, user_id, req)


@router.patch("/tags/{tag_id}")
def update_tag_endpoint(
    tag_id: str,
    req: TagUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return update_tag_for_user(db, user_id, tag_id, req)


@router.delete("/tags/{tag_id}")
def delete_tag_endpoint(
    tag_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return delete_tag_for_user(db, user_id, tag_id)


@router.post("/devices", status_code=status.HTTP_201_CREATED)
def register_device_endpoint(
    req: DeviceRegisterRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    return register_device_for_user(db, user_id, req)


@router.get("/export")
def export_data_endpoint(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Export all user-owned folders, tags, items, reminders, and device metadata as JSON."""
    return export_user_data(db, user_id)


@router.post("/feedback", status_code=status.HTTP_201_CREATED)
def submit_feedback_endpoint(
    req: FeedbackCreateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Submit beta feedback or waitlist entry (REQ-005)."""
    return create_beta_feedback(db, user_id, req)


@router.get("/feedback")
def list_feedback_endpoint(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    """List current user's submitted beta feedback entries."""
    return {"feedback": list_user_beta_feedback(db, user_id)}
