"""FastAPI routes for Hybrid Reminders CRUD, iOS Local Sync, and pg_cron Push Worker."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from Database.client import get_db
from Login.auth_dep import get_current_user_id
from Reminders.schemas import (
    CronRemindersRequest,
    CronRemindersResponse,
    LocalSyncResponse,
    ReminderListResponse,
    ReminderPatchRequest,
    ReminderRecordResponse,
    ReminderUpsertRequest,
    SnoozeReminderRequest,
)
from Reminders.service import (
    delete_reminder_for_user,
    get_ios_local_sync_payload,
    list_reminders_for_user,
    patch_reminder_for_user,
    process_due_reminders_cron,
    snooze_reminder_for_user,
    upsert_reminder_for_user,
)
from Reminders.unroller import DEFAULT_LOOKAHEAD_PER_RULE, MAX_IOS_LOCAL_SLOTS
from Unfurl.security import require_internal_secret

router = APIRouter(tags=["reminders"])


@router.get("/api/reminders", response_model=ReminderListResponse)
def list_reminders_endpoint(
    status: Optional[Literal["pending", "sent", "cancelled"]] = Query(default=None),
    include_cancelled: bool = Query(default=False),
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> ReminderListResponse:
    """List the authenticated user's personal reminders."""
    return list_reminders_for_user(
        db,
        user_id,
        status_filter=status,
        include_cancelled=include_cancelled,
    )


@router.get("/api/reminders/local-sync", response_model=LocalSyncResponse)
def ios_local_sync_endpoint(
    lookahead_per_rule: int = Query(default=DEFAULT_LOOKAHEAD_PER_RULE, ge=1, le=64),
    max_slots: int = Query(default=MAX_IOS_LOCAL_SLOTS, ge=1, le=64),
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> LocalSyncResponse:
    """Return unrolled DST-safe upcoming reminders (<= 64 slots) plus separated overdue items."""
    return get_ios_local_sync_payload(
        db,
        user_id,
        lookahead_per_rule=lookahead_per_rule,
        max_slots=max_slots,
    )


@router.post("/api/reminders", response_model=ReminderRecordResponse, status_code=status.HTTP_201_CREATED)
def create_reminder_endpoint(
    req: ReminderUpsertRequest,
    item_id: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> ReminderRecordResponse:
    """Create or upsert the authenticated user's reminder rule via POST /api/reminders."""
    body_item_id = (req.item_id or "").strip()
    query_item_id = (item_id or "").strip()
    if body_item_id and query_item_id and body_item_id != query_item_id:
        raise HTTPException(
            status_code=getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422),
            detail="Query item_id and body item_id must match when both are provided.",
        )
    target_item_id = body_item_id or query_item_id
    if not target_item_id:
        raise HTTPException(
            status_code=getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422),
            detail="item_id is required when creating a reminder via POST /api/reminders.",
        )
    return upsert_reminder_for_user(db, user_id, target_item_id, req)


@router.put("/api/reminders/{item_id}", response_model=ReminderRecordResponse)
def upsert_reminder_endpoint(
    item_id: str,
    req: ReminderUpsertRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> ReminderRecordResponse:
    """Create or update the authenticated user's reminder rule on an accessible item."""
    return upsert_reminder_for_user(db, user_id, item_id, req)


@router.patch("/api/reminders/{item_id}", response_model=ReminderRecordResponse)
def patch_reminder_endpoint(
    item_id: str,
    req: ReminderPatchRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> ReminderRecordResponse:
    """Partial/compat update for the authenticated user's reminder rule on an accessible item."""
    return patch_reminder_for_user(db, user_id, item_id, req)


@router.post("/api/reminders/{item_id}/snooze", response_model=ReminderRecordResponse)
def snooze_reminder_endpoint(
    item_id: str,
    req: Optional[SnoozeReminderRequest] = Body(default=None),
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> ReminderRecordResponse:
    """Snooze the authenticated user's active reminder forward."""
    return snooze_reminder_for_user(db, user_id, item_id, req or SnoozeReminderRequest())


@router.delete("/api/reminders/{item_id}")
def delete_reminder_endpoint(
    item_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Cancel the authenticated user's reminder on item_id without affecting other users."""
    return delete_reminder_for_user(db, user_id, item_id)


@router.post("/cron/reminders", response_model=CronRemindersResponse)
async def cron_reminders_endpoint(
    req: Optional[CronRemindersRequest] = Body(default=None),
    _: None = Depends(require_internal_secret),
    db: Any = Depends(get_db),
) -> CronRemindersResponse:
    """Secret-guarded pg_cron endpoint claiming due reminders and pushing to remote devices."""
    limit = req.batch_limit if req is not None else 100
    return await process_due_reminders_cron(db, batch_limit=limit)
