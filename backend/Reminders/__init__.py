"""Just-Save-It Hybrid Reminders Engine (REST CRUD, iOS Local Sync Unroller, Remote Push Dispatch)."""

from Reminders.push_adapters import (
    PushSendResult,
    build_vapid_authorization,
    dispatch_push_to_device,
    encrypt_web_push_payload,
    send_expo_push,
    send_fcm_push,
    send_web_push,
    validate_web_push_endpoint,
)
from Reminders.router import router
from Reminders.schemas import (
    CronRemindersRequest,
    CronRemindersResponse,
    LocalSyncOccurrence,
    LocalSyncResponse,
    PushDeliverySummary,
    ReminderListResponse,
    ReminderRecordResponse,
    ReminderUpsertRequest,
    SnoozeReminderRequest,
)
from Reminders.service import (
    delete_reminder_for_user,
    get_ios_local_sync_payload,
    list_reminders_for_user,
    process_due_reminders_cron,
    snooze_reminder_for_user,
    upsert_reminder_for_user,
)
from Reminders.unroller import (
    advance_every_n_days_utc,
    ensure_utc_datetime,
    unroll_reminders_for_ios,
)

__all__ = [
    "CronRemindersRequest",
    "CronRemindersResponse",
    "LocalSyncOccurrence",
    "LocalSyncResponse",
    "PushDeliverySummary",
    "PushSendResult",
    "ReminderListResponse",
    "ReminderRecordResponse",
    "ReminderUpsertRequest",
    "SnoozeReminderRequest",
    "advance_every_n_days_utc",
    "build_vapid_authorization",
    "delete_reminder_for_user",
    "dispatch_push_to_device",
    "encrypt_web_push_payload",
    "ensure_utc_datetime",
    "get_ios_local_sync_payload",
    "list_reminders_for_user",
    "process_due_reminders_cron",
    "router",
    "send_expo_push",
    "send_fcm_push",
    "send_web_push",
    "snooze_reminder_for_user",
    "unroll_reminders_for_ios",
    "upsert_reminder_for_user",
    "validate_web_push_endpoint",
]
