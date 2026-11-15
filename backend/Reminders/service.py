"""Service layer for Hybrid Reminders CRUD, iOS Pre-APNs local-sync, and cron push dispatch."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError

from Database.repository import can_access_item, deactivate_device_for_user, upsert_item_reminder
from Reminders.push_adapters import _load_vapid_keys, dispatch_push_to_device
from Reminders.schemas import (
    CronRemindersResponse,
    LocalSyncResponse,
    PushDeliverySummary,
    ReminderListResponse,
    ReminderPatchRequest,
    ReminderRecordResponse,
    ReminderUpsertRequest,
    SnoozeReminderRequest,
)
from Reminders.unroller import (
    DEFAULT_LOOKAHEAD_PER_RULE,
    MAX_IOS_LOCAL_SLOTS,
    advance_every_n_days_utc,
    ensure_utc_datetime,
    unroll_reminders_for_ios,
)

logger = logging.getLogger(__name__)


def _fetch_item_or_404(db: Any, item_id: str) -> Dict[str, Any]:
    res = db.table("items").select("*").eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    return dict(res.data[0])


def _require_item_read_access(db: Any, user_id: str, item_id: str) -> Dict[str, Any]:
    item = _fetch_item_or_404(db, item_id)
    if not can_access_item(db, user_id, item, require_editor=False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to access reminders for this item.",
        )
    return item


def _fetch_items_map(db: Any, item_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    unique_ids = [iid for iid in dict.fromkeys(item_ids) if iid]
    if not unique_ids:
        return {}
    res = db.table("items").select("*").in_("id", unique_ids).execute()
    return {str(row["id"]): dict(row) for row in (res.data or []) if row.get("id")}


def _serialize_reminder_record(
    rem: Dict[str, Any],
    item: Optional[Dict[str, Any]] = None,
) -> ReminderRecordResponse:
    remind_at_dt = ensure_utc_datetime(rem.get("remind_at")) or datetime.now(timezone.utc)
    return ReminderRecordResponse(
        id=str(rem["id"]) if rem.get("id") is not None else None,
        item_id=str(rem["item_id"]),
        user_id=str(rem["user_id"]),
        schedule_type=str(rem.get("schedule_type") or "once"),  # type: ignore[arg-type]
        remind_at=remind_at_dt,
        repeat_every_days=rem.get("repeat_every_days"),
        remind_time=str(rem["remind_time"]) if rem.get("remind_time") is not None else None,
        timezone=str(rem.get("timezone") or "Asia/Bangkok"),
        status=str(rem.get("status") or "pending"),  # type: ignore[arg-type]
        is_enabled=(str(rem.get("status") or "pending") != "cancelled"),
        title_snapshot=rem.get("title_snapshot"),
        last_triggered_at=ensure_utc_datetime(rem.get("last_triggered_at")),
        sent_at=ensure_utc_datetime(rem.get("sent_at")),
        updated_at=ensure_utc_datetime(rem.get("updated_at")),
        created_at=ensure_utc_datetime(rem.get("created_at")),
        item_status=str(item.get("status")) if item and item.get("status") is not None else None,
        item_url=str(item.get("url")) if item and item.get("url") is not None else None,
        item_title=str(item.get("title")) if item and item.get("title") is not None else None,
    )


def list_reminders_for_user(
    db: Any,
    user_id: str,
    *,
    status_filter: Optional[str] = None,
    include_cancelled: bool = False,
) -> ReminderListResponse:
    """List personal reminders owned by user_id (tenant-isolated even inside shared folders)."""
    query = db.table("reminders").select("*").eq("user_id", user_id)
    if status_filter:
        query = query.eq("status", status_filter)
    res = query.execute()
    rows = list(res.data or [])

    items_map = _fetch_items_map(db, [str(r.get("item_id") or "") for r in rows])
    visible: List[ReminderRecordResponse] = []
    for row in rows:
        row_status = str(row.get("status") or "pending")
        if not status_filter and not include_cancelled and row_status == "cancelled":
            continue
        item_id = str(row.get("item_id") or "")
        item = items_map.get(item_id)
        if item is None or not can_access_item(db, user_id, item, require_editor=False):
            continue
        visible.append(_serialize_reminder_record(row, item))

    visible.sort(key=lambda r: (r.remind_at, r.item_id))
    return ReminderListResponse(reminders=visible, total=len(visible))


def upsert_reminder_for_user(
    db: Any,
    user_id: str,
    item_id: str,
    req: ReminderUpsertRequest,
) -> ReminderRecordResponse:
    """Create or update caller's personal reminder rule on an accessible item."""
    item = _require_item_read_access(db, user_id, item_id)
    if item.get("status") in ("done", "archived"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot set a reminder on a done or archived item.",
        )

    saved = upsert_item_reminder(db, user_id, item_id, item.get("title"), req)
    return _serialize_reminder_record(saved, item)


def patch_reminder_for_user(
    db: Any,
    user_id: str,
    item_id: str,
    req: ReminderPatchRequest,
) -> ReminderRecordResponse:
    """Partially update caller's existing reminder rule on an accessible item."""
    item = _require_item_read_access(db, user_id, item_id)
    if item.get("status") in ("done", "archived"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot update a reminder on a done or archived item.",
        )

    existing_res = (
        db.table("reminders")
        .select("*")
        .eq("item_id", item_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not existing_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reminder not found.")

    cur = dict(existing_res.data[0])
    merged: Dict[str, Any] = {
        "schedule_type": cur.get("schedule_type") or "once",
        "remind_at": cur.get("remind_at"),
        "repeat_every_days": cur.get("repeat_every_days"),
        "remind_time": cur.get("remind_time"),
        "timezone": cur.get("timezone") or "Asia/Bangkok",
        "title_snapshot": cur.get("title_snapshot"),
        "is_enabled": str(cur.get("status") or "pending") != "cancelled",
    }
    fields_set = req.model_fields_set
    if "schedule_type" in fields_set and req.schedule_type is not None:
        merged["schedule_type"] = req.schedule_type
    if "remind_at" in fields_set:
        merged["remind_at"] = req.remind_at
    elif "next_remind_at" in fields_set:
        merged["remind_at"] = req.next_remind_at
    if "repeat_every_days" in fields_set:
        merged["repeat_every_days"] = req.repeat_every_days
    elif "repeat_interval_days" in fields_set:
        merged["repeat_every_days"] = req.repeat_interval_days
    if "remind_time" in fields_set:
        merged["remind_time"] = req.remind_time
    if "timezone" in fields_set and req.timezone is not None:
        merged["timezone"] = req.timezone
    if (
        "remind_time" in fields_set
        and req.remind_time
        and "remind_at" not in fields_set
        and "next_remind_at" not in fields_set
    ):
        base_utc = ensure_utc_datetime(merged.get("remind_at"))
        if base_utc is not None:
            try:
                tz = ZoneInfo(str(merged.get("timezone") or "Asia/Bangkok"))
                time_parts = [int(p) for p in str(req.remind_time).strip().split(":")]
                if len(time_parts) >= 2:
                    updated_local = base_utc.astimezone(tz).replace(
                        hour=time_parts[0],
                        minute=time_parts[1],
                        second=time_parts[2] if len(time_parts) > 2 else 0,
                        microsecond=0,
                    )
                    merged["remind_at"] = updated_local.astimezone(timezone.utc)
            except (ValueError, KeyError):
                # Invalid remind_time/timezone format is handled by ReminderUpsertRequest validation below.
                pass
    if "title_snapshot" in fields_set:
        merged["title_snapshot"] = req.title_snapshot
    if "is_enabled" in fields_set and req.is_enabled is not None:
        merged["is_enabled"] = req.is_enabled

    if (
        merged.get("schedule_type") == "once"
        and "repeat_every_days" not in fields_set
        and "repeat_interval_days" not in fields_set
    ):
        merged["repeat_every_days"] = None

    try:
        validated = ReminderUpsertRequest(**merged)
    except ValidationError as exc:
        raise HTTPException(
            status_code=getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422),
            detail=exc.errors(),
        ) from exc

    saved = upsert_item_reminder(db, user_id, item_id, item.get("title"), validated)
    return _serialize_reminder_record(saved, item)


def snooze_reminder_for_user(
    db: Any,
    user_id: str,
    item_id: str,
    req: SnoozeReminderRequest,
    *,
    now_utc: Optional[datetime] = None,
) -> ReminderRecordResponse:
    """Snooze caller's active reminder on an accessible item forward in UTC."""
    item = _require_item_read_access(db, user_id, item_id)
    if item.get("status") in ("done", "archived"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot snooze a reminder on a done or archived item.",
        )

    existing = (
        db.table("reminders")
        .select("*")
        .eq("item_id", item_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reminder not found.")

    rem = dict(existing.data[0])
    if rem.get("status") == "cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot snooze a cancelled reminder.",
        )

    now_ref = ensure_utc_datetime(now_utc) or datetime.now(timezone.utc)
    if req.remind_at is not None:
        target_dt = ensure_utc_datetime(req.remind_at)
        assert target_dt is not None
        if target_dt <= now_ref:
            raise HTTPException(
                status_code=getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422),
                detail="Snooze target remind_at must be in the future.",
            )
    else:
        delta = timedelta(minutes=req.minutes or 0, hours=req.hours or 0)
        target_dt = now_ref + delta

    updates = {
        "remind_at": target_dt.isoformat(),
        "status": "pending",
        "updated_at": now_ref.isoformat(),
    }
    res = (
        db.table("reminders")
        .update(updates)
        .eq("id", rem["id"])
        .eq("user_id", user_id)
        .execute()
    )
    merged = dict(res.data[0]) if res.data else {**rem, **updates}
    return _serialize_reminder_record(merged, item)


def delete_reminder_for_user(
    db: Any,
    user_id: str,
    item_id: str,
    *,
    now_utc: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Cancel/delete caller's own reminder for item_id without affecting other folder members."""
    _require_item_read_access(db, user_id, item_id)
    existing = (
        db.table("reminders")
        .select("*")
        .eq("item_id", item_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reminder not found.")

    rem = existing.data[0]
    now_iso = (ensure_utc_datetime(now_utc) or datetime.now(timezone.utc)).isoformat()
    db.table("reminders").update({"status": "cancelled", "updated_at": now_iso}).eq(
        "id", rem["id"]
    ).eq("user_id", user_id).execute()

    return {"deleted": True, "status": "cancelled", "item_id": item_id, "id": rem.get("id")}


def _is_ios_remote_push_active(db: Any, user_id: str) -> bool:
    """Return True only when IOS_REMOTE_PUSH_ENABLED=true AND user has an active iOS remote device."""
    env_flag = os.getenv("IOS_REMOTE_PUSH_ENABLED", "false").strip().lower() == "true"
    if not env_flag:
        return False

    res = (
        db.table("devices")
        .select("id, platform, delivery_mode, is_active")
        .eq("user_id", user_id)
        .eq("platform", "ios")
        .eq("delivery_mode", "remote")
        .eq("is_active", True)
        .execute()
    )
    return bool(res.data)


def get_ios_local_sync_payload(
    db: Any,
    user_id: str,
    *,
    now_utc: Optional[datetime] = None,
    lookahead_per_rule: int = DEFAULT_LOOKAHEAD_PER_RULE,
    max_slots: int = MAX_IOS_LOCAL_SLOTS,
) -> LocalSyncResponse:
    """Build iOS Pre-APNs local notification sync list capped cleanly at 64 triggers."""
    rem_res = db.table("reminders").select("*").eq("user_id", user_id).eq("status", "pending").execute()
    reminders = list(rem_res.data or [])
    items_map = _fetch_items_map(db, [str(r.get("item_id") or "") for r in reminders])

    accessible_reminders: List[Dict[str, Any]] = []
    for rem in reminders:
        item = items_map.get(str(rem.get("item_id") or ""))
        if item is None or not can_access_item(db, user_id, item, require_editor=False):
            continue
        accessible_reminders.append(rem)

    ios_remote_active = _is_ios_remote_push_active(db, user_id)
    return unroll_reminders_for_ios(
        accessible_reminders,
        items_map,
        ios_remote_push_active=ios_remote_active,
        now_utc=now_utc,
        max_slots=max_slots,
        lookahead_per_rule=lookahead_per_rule,
    )


def _claim_due_reminders_python_fallback(
    db: Any,
    *,
    batch_limit: int,
    now_ref: datetime,
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]], int]:
    """Atomic-equivalent fallback for InMemoryDB / environments without Postgres RPC."""
    pending_res = db.table("reminders").select("*").eq("status", "pending").execute()
    due_rows: List[Tuple[datetime, Dict[str, Any]]] = []
    for row in pending_res.data or []:
        remind_dt = ensure_utc_datetime(row.get("remind_at"))
        if remind_dt is not None and remind_dt <= now_ref:
            due_rows.append((remind_dt, dict(row)))

    due_rows.sort(key=lambda pair: (pair[0], str(pair[1].get("id") or "")))
    candidates = [pair[1] for pair in due_rows[:batch_limit]]
    items_map = _fetch_items_map(db, [str(r.get("item_id") or "") for r in candidates])

    claimed: List[Dict[str, Any]] = []
    skipped_completed = 0
    now_iso = now_ref.isoformat()

    for rem in candidates:
        rem_id = rem.get("id")
        item_id = str(rem.get("item_id") or "")
        user_id = str(rem.get("user_id") or "")
        item = items_map.get(item_id)

        if item is None or item.get("status") in ("done", "archived") or not can_access_item(db, user_id, item):
            db.table("reminders").update({"status": "cancelled", "updated_at": now_iso}).eq("id", rem_id).execute()
            skipped_completed += 1
            continue

        schedule_type = str(rem.get("schedule_type") or "once")
        repeat_days = rem.get("repeat_every_days")
        remind_time = rem.get("remind_time")
        tz_name = str(rem.get("timezone") or "Asia/Bangkok")

        if schedule_type == "every_n_days" and repeat_days is not None and remind_time is not None:
            base_dt = ensure_utc_datetime(rem.get("remind_at")) or now_ref
            next_ts = advance_every_n_days_utc(
                base_dt,
                int(repeat_days),
                remind_time,
                tz_name,
                now_utc=now_ref,
            )
            db.table("reminders").update(
                {
                    "remind_at": next_ts.isoformat(),
                    "status": "pending",
                    "last_triggered_at": now_iso,
                    "sent_at": now_iso,
                    "updated_at": now_iso,
                }
            ).eq("id", rem_id).execute()
        else:
            db.table("reminders").update(
                {
                    "status": "sent",
                    "last_triggered_at": now_iso,
                    "sent_at": now_iso,
                    "updated_at": now_iso,
                }
            ).eq("id", rem_id).execute()

        claimed.append(
            {
                "reminder_id": rem_id,
                "item_id": item_id,
                "user_id": user_id,
                "title_snapshot": rem.get("title_snapshot"),
                "schedule_type": schedule_type,
                "repeat_every_days": repeat_days,
                "fired_at": now_iso,
            }
        )

    return claimed, items_map, skipped_completed


async def process_due_reminders_cron(
    db: Any,
    *,
    batch_limit: int = 100,
    now_utc: Optional[datetime] = None,
    http_client: Optional[httpx.AsyncClient] = None,
) -> CronRemindersResponse:
    """Claim due reminders atomically and fan out remote notifications across active remote devices."""
    now_ref = ensure_utc_datetime(now_utc) or datetime.now(timezone.utc)
    now_iso = now_ref.isoformat()
    skipped_completed = 0

    rpc_fn = getattr(db, "rpc", None)
    if callable(rpc_fn):
        rpc_res = rpc_fn("claim_due_reminders", {"batch_limit": batch_limit}).execute()
        raw_claimed = [dict(r) for r in (rpc_res.data or [])]
        items_map = _fetch_items_map(db, [str(r.get("item_id") or "") for r in raw_claimed])
        claimed: List[Dict[str, Any]] = []
        for rem in raw_claimed:
            item = items_map.get(str(rem.get("item_id") or ""))
            uid = str(rem.get("user_id") or "")
            if item is None or item.get("status") in ("done", "archived") or not can_access_item(db, uid, item):
                db.table("reminders").update({"status": "cancelled", "updated_at": now_iso}).eq(
                    "id", rem.get("reminder_id")
                ).execute()
                skipped_completed += 1
                continue
            claimed.append(rem)
    else:
        claimed, items_map, skipped_completed = _claim_due_reminders_python_fallback(
            db,
            batch_limit=batch_limit,
            now_ref=now_ref,
        )

    summary = PushDeliverySummary()
    devices_cache: Dict[str, List[Dict[str, Any]]] = {}

    for rem in claimed:
        uid = str(rem.get("user_id") or "")
        item_id = str(rem.get("item_id") or "")
        item = items_map.get(item_id) or {}
        raw_title = str(rem.get("title_snapshot") or item.get("title") or item.get("url") or "Just-Save-It Reminder")
        raw_body = str(item.get("url") or "Time to revisit your saved item.")
        raw_url = str(item.get("url") or "")
        title = raw_title[:159] + "…" if len(raw_title) > 160 else raw_title
        body = raw_body[:399] + "…" if len(raw_body) > 400 else raw_body
        push_data = {
            "reminder_id": str(rem.get("reminder_id") or ""),
            "item_id": item_id,
            "url": raw_url[:500],
        }

        if uid not in devices_cache:
            dev_res = db.table("devices").select("*").eq("user_id", uid).execute()
            devices_cache[uid] = [dict(d) for d in (dev_res.data or [])]

        for dev in devices_cache[uid]:
            if not dev.get("is_active", False):
                summary.skipped_inactive += 1
                continue
            if dev.get("delivery_mode") != "remote":
                summary.skipped_local_sync += 1
                continue

            summary.attempted += 1
            result = await dispatch_push_to_device(
                dev,
                title=title,
                body=body,
                data=push_data,
                http_client=http_client,
            )
            if result.delivered:
                summary.delivered += 1
            else:
                summary.failed += 1
                if result.ssrf_blocked:
                    summary.ssrf_blocked += 1
                if result.deactivate_device and dev.get("id") is not None:
                    dev_id = str(dev["id"])
                    dev["is_active"] = False
                    db.table("devices").update({"is_active": False}).eq("id", dev["id"]).eq("user_id", uid).execute()
                    if dev_id not in summary.deactivated_devices:
                        summary.deactivated_devices.append(dev_id)

    return CronRemindersResponse(
        claimed=len(claimed) + skipped_completed,
        dispatched_reminders=len(claimed),
        skipped_completed_items=skipped_completed,
        push_summary=summary,
        ran_at=now_ref,
    )


def get_web_push_public_config() -> Dict[str, Any]:
    """Return Web Push availability and public VAPID key (never private key)."""
    try:
        _, pub_b64url, _ = _load_vapid_keys()
        return {"enabled": True, "vapid_public_key": pub_b64url}
    except Exception:
        return {"enabled": False, "vapid_public_key": None}


def deactivate_user_device_push(
    db: Any,
    user_id: str,
    *,
    push_token: Optional[str] = None,
    endpoint: Optional[str] = None,
    platform: Optional[str] = "web",
) -> Dict[str, Any]:
    """Deactivate caller's remote push device row (e.g. toggle off or logout)."""
    return deactivate_device_for_user(
        db,
        user_id,
        push_token=push_token,
        endpoint=endpoint,
        platform=platform,
    )
