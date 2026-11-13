"""DST-safe occurrence calculation and iOS 64-slot reminder unrolling via ZoneInfo."""

from __future__ import annotations

import datetime as _dt_mod
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from Database.repository import _parse_iso
from Database.schemas import parse_remind_time
from Reminders.schemas import LocalSyncOccurrence, LocalSyncResponse, MAX_IOS_LOCAL_SLOTS

DEFAULT_LOOKAHEAD_PER_RULE = 5


def ensure_utc_datetime(value: Any) -> Optional[datetime]:
    """Parse an ISO string or datetime into a timezone-aware UTC datetime."""
    if value is None:
        return None
    if isinstance(value, _dt_mod.datetime):
        dt = value
    elif isinstance(value, str):
        dt = _parse_iso(value)
        if dt is None:
            return None
    else:
        return None

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def resolve_zoneinfo(tz_name: Optional[str]) -> ZoneInfo:
    """Resolve an IANA timezone safely, defaulting invalid/empty values to UTC."""
    candidate = (tz_name or "").strip() or "UTC"
    try:
        return ZoneInfo(candidate)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def parse_time_of_day(value: Any) -> Optional[time]:
    """Convert HH:MM[:SS] string or datetime.time into a naive wall-clock time object."""
    if value is None:
        return None
    if isinstance(value, time):
        return value.replace(tzinfo=None, microsecond=0)
    normalized = parse_remind_time(str(value))
    if not normalized:
        return None
    return datetime.strptime(normalized, "%H:%M:%S").time()


def _local_wall_time_to_utc(local_day: date, wall_time: time, tz: ZoneInfo) -> datetime:
    """Combine local calendar date and wall-clock time in ZoneInfo and convert to UTC."""
    naive_local = datetime.combine(local_day, wall_time)
    aware_local = naive_local.replace(tzinfo=tz, fold=0)
    return aware_local.astimezone(timezone.utc)


def advance_every_n_days_utc(
    current_remind_at_utc: datetime,
    repeat_every_days: int,
    remind_time_value: Any,
    tz_name: str,
    now_utc: Optional[datetime] = None,
) -> datetime:
    """Advance an every_n_days reminder strictly past now_utc preserving local wall-clock HH:MM.

    Mirrors SQL public.claim_due_reminders() arithmetic so DST spring-forward/fall-back transitions
    keep the intended local wall-clock time rather than shifting by +/- 1 hour.
    """
    if repeat_every_days < 1:
        raise ValueError("repeat_every_days must be >= 1.")

    now_ref = ensure_utc_datetime(now_utc) or datetime.now(timezone.utc)
    base_utc = ensure_utc_datetime(current_remind_at_utc) or now_ref
    tz = resolve_zoneinfo(tz_name)
    wall_time = parse_time_of_day(remind_time_value)
    if wall_time is None:
        local_base = base_utc.astimezone(tz)
        wall_time = local_base.timetz().replace(tzinfo=None, microsecond=0)

    base_local_date = base_utc.astimezone(tz).date()
    now_local_date = now_ref.astimezone(tz).date()

    # Jump multi-day outages in O(1) before fine-stepping to match SQL loop boundaries cleanly.
    days_behind = (now_local_date - base_local_date).days
    steps = max(1, days_behind // repeat_every_days) if days_behind >= repeat_every_days else 1
    next_local_date = base_local_date + timedelta(days=steps * repeat_every_days)
    next_utc = _local_wall_time_to_utc(next_local_date, wall_time, tz)

    while next_utc <= now_ref:
        next_local_date = next_local_date + timedelta(days=repeat_every_days)
        next_utc = _local_wall_time_to_utc(next_local_date, wall_time, tz)

    return next_utc


def _resolve_reminder_title(reminder: Mapping[str, Any], item: Optional[Mapping[str, Any]]) -> str:
    title = reminder.get("title_snapshot") or (item or {}).get("title") or (item or {}).get("url") or "Saved link"
    return str(title).strip() or "Saved link"


def unroll_reminders_for_ios(
    reminders: Sequence[Mapping[str, Any]],
    items_by_id: Mapping[str, Mapping[str, Any]],
    *,
    ios_remote_push_active: bool = False,
    now_utc: Optional[datetime] = None,
    max_slots: int = MAX_IOS_LOCAL_SLOTS,
    lookahead_per_rule: int = DEFAULT_LOOKAHEAD_PER_RULE,
) -> LocalSyncResponse:
    """Unroll pending reminders for iOS Pre-APNs expo-notifications sync.

    - Skips non-pending rules and rules whose items are done/archived.
    - Separates overdue entries (remind_at <= now) so they do not consume future UNNotification slots.
    - Unrolls each every_n_days rule K future occurrences DST-safely via ZoneInfo.
    - Orders all upcoming occurrences ASC by occurrence_at and enforces LIMIT max_slots (64).
    - Emits empty notifications list when ios_remote_push_active=True to avoid double alerts.
    """
    now_ref = ensure_utc_datetime(now_utc) or datetime.now(timezone.utc)
    capped_slots = max(1, min(max_slots, MAX_IOS_LOCAL_SLOTS))
    per_rule_limit = max(1, min(lookahead_per_rule, MAX_IOS_LOCAL_SLOTS))

    overdue_list: List[LocalSyncOccurrence] = []
    upcoming_pool: List[LocalSyncOccurrence] = []
    active_rule_count = 0

    for rem in reminders:
        if rem.get("status") != "pending":
            continue

        item_id = str(rem.get("item_id") or "")
        item = items_by_id.get(item_id)
        if item is not None and item.get("status") in ("done", "archived"):
            continue

        remind_at_utc = ensure_utc_datetime(rem.get("remind_at"))
        if remind_at_utc is None:
            continue

        active_rule_count += 1
        schedule_type = str(rem.get("schedule_type") or "once")
        if schedule_type not in ("once", "every_n_days"):
            continue

        tz_name = str(rem.get("timezone") or "Asia/Bangkok")
        repeat_days = rem.get("repeat_every_days")
        title = _resolve_reminder_title(rem, item)
        item_url = str(item.get("url")) if item and item.get("url") else None
        rem_id = str(rem.get("id")) if rem.get("id") is not None else None

        if remind_at_utc <= now_ref:
            overdue_list.append(
                LocalSyncOccurrence(
                    reminder_id=rem_id,
                    item_id=item_id,
                    schedule_type=schedule_type,  # type: ignore[arg-type]
                    occurrence_at=remind_at_utc,
                    repeat_every_days=repeat_days,
                    timezone=tz_name,
                    title=title,
                    item_url=item_url,
                    is_overdue=True,
                )
            )
            if schedule_type == "once":
                continue

        if schedule_type == "once":
            upcoming_pool.append(
                LocalSyncOccurrence(
                    reminder_id=rem_id,
                    item_id=item_id,
                    schedule_type="once",
                    occurrence_at=remind_at_utc,
                    repeat_every_days=None,
                    timezone=tz_name,
                    title=title,
                    item_url=item_url,
                    is_overdue=False,
                )
            )
            continue

        # every_n_days: emit next future occurrences (starting after now_ref).
        try:
            repeat_n = int(repeat_days) if repeat_days is not None else 0
        except (TypeError, ValueError):
            repeat_n = 0
        if repeat_n < 1:
            continue

        tz = resolve_zoneinfo(tz_name)
        wall_time = parse_time_of_day(rem.get("remind_time"))
        if wall_time is None:
            wall_time = remind_at_utc.astimezone(tz).timetz().replace(tzinfo=None, microsecond=0)

        first_future = (
            remind_at_utc
            if remind_at_utc > now_ref
            else advance_every_n_days_utc(remind_at_utc, repeat_n, wall_time, tz_name, now_utc=now_ref)
        )

        cursor_local_date = first_future.astimezone(tz).date()
        for step_idx in range(per_rule_limit):
            occ_local_date = cursor_local_date + timedelta(days=step_idx * repeat_n)
            occ_utc = (
                first_future
                if step_idx == 0
                else _local_wall_time_to_utc(occ_local_date, wall_time, tz)
            )
            upcoming_pool.append(
                LocalSyncOccurrence(
                    reminder_id=rem_id,
                    item_id=item_id,
                    schedule_type="every_n_days",
                    occurrence_at=occ_utc,
                    repeat_every_days=repeat_n,
                    timezone=tz_name,
                    title=title,
                    item_url=item_url,
                    is_overdue=False,
                )
            )

    overdue_list.sort(key=lambda occ: (occ.occurrence_at, occ.item_id))

    if ios_remote_push_active:
        return LocalSyncResponse(
            ios_remote_push_active=True,
            max_slots=capped_slots,
            total_active_rules=active_rule_count,
            notifications=[],
            overdue=overdue_list,
            truncated=False,
            generated_at=now_ref,
        )

    upcoming_pool.sort(key=lambda occ: (occ.occurrence_at, occ.item_id))
    truncated = len(upcoming_pool) > capped_slots
    selected = upcoming_pool[:capped_slots]

    return LocalSyncResponse(
        ios_remote_push_active=False,
        max_slots=capped_slots,
        total_active_rules=active_rule_count,
        notifications=selected,
        overdue=overdue_list,
        truncated=truncated,
        generated_at=now_ref,
    )
