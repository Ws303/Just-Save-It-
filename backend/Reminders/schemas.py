"""Pydantic v2 request and response schemas for the Just-Save-It Hybrid Reminders Engine."""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from Database.schemas import ReminderConfig, parse_remind_time, validate_iana_timezone

DEFAULT_SNOOZE_MINUTES = 60
MAX_IOS_LOCAL_SLOTS = 64


class ReminderUpsertRequest(ReminderConfig):
    """PUT /api/reminders/{item_id} & POST /api/reminders payload reusing ReminderConfig."""

    item_id: Optional[str] = None


class ReminderPatchRequest(BaseModel):
    """Partial PATCH /api/reminders/{item_id} payload allowing field-level updates."""

    schedule_type: Optional[Literal["once", "every_n_days"]] = None
    remind_at: Optional[datetime] = None
    next_remind_at: Optional[datetime] = None
    repeat_every_days: Optional[int] = Field(default=None, ge=1, le=365)
    repeat_interval_days: Optional[int] = Field(default=None, ge=1, le=365)
    remind_time: Optional[str] = None
    timezone: Optional[str] = None
    title_snapshot: Optional[str] = None
    is_enabled: Optional[bool] = None

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return validate_iana_timezone(value)

    @field_validator("remind_time")
    @classmethod
    def check_remind_time(cls, value: Optional[str]) -> Optional[str]:
        return parse_remind_time(value)


class SnoozeReminderRequest(BaseModel):
    """POST /api/reminders/{item_id}/snooze payload accepting duration or explicit target UTC time."""

    minutes: Optional[int] = Field(default=None, ge=1, le=43200)
    hours: Optional[int] = Field(default=None, ge=1, le=720)
    remind_at: Optional[datetime] = None

    @model_validator(mode="after")
    def validate_snooze_target(self) -> "SnoozeReminderRequest":
        has_relative = self.minutes is not None or self.hours is not None
        if self.remind_at is not None and has_relative:
            raise ValueError("Provide either 'remind_at' or relative 'minutes'/'hours', not both.")
        if self.remind_at is None and not has_relative:
            self.minutes = DEFAULT_SNOOZE_MINUTES
        return self


class ReminderRecordResponse(BaseModel):
    """Serialized reminder rule paired with basic item metadata for list/CRUD responses."""

    id: Optional[str] = None
    item_id: str
    user_id: str
    schedule_type: Literal["once", "every_n_days"]
    remind_at: datetime
    repeat_every_days: Optional[int] = None
    remind_time: Optional[str] = None
    timezone: str = "Asia/Bangkok"
    status: Literal["pending", "sent", "cancelled"] = "pending"
    is_enabled: bool = True
    title_snapshot: Optional[str] = None
    last_triggered_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    item_status: Optional[str] = None
    item_url: Optional[str] = None
    item_title: Optional[str] = None


class ReminderListResponse(BaseModel):
    """GET /api/reminders response."""

    reminders: List[ReminderRecordResponse] = Field(default_factory=list)
    total: int = 0


class LocalSyncOccurrence(BaseModel):
    """Single concrete notification occurrence unrolled for iOS Pre-APNs local sync."""

    reminder_id: Optional[str] = None
    item_id: str
    schedule_type: Literal["once", "every_n_days"]
    occurrence_at: datetime
    repeat_every_days: Optional[int] = None
    timezone: str
    title: str
    item_url: Optional[str] = None
    is_overdue: bool = False


class LocalSyncResponse(BaseModel):
    """GET /api/reminders/local-sync response adhering to iOS 64-trigger budget."""

    ios_remote_push_active: bool = False
    max_slots: int = MAX_IOS_LOCAL_SLOTS
    total_active_rules: int = 0
    notifications: List[LocalSyncOccurrence] = Field(default_factory=list)
    overdue: List[LocalSyncOccurrence] = Field(default_factory=list)
    truncated: bool = False
    generated_at: datetime


class CronRemindersRequest(BaseModel):
    """Optional POST /cron/reminders request body overriding batch limit."""

    batch_limit: int = Field(default=100, ge=1, le=500)


class PushDeliverySummary(BaseModel):
    """Aggregated remote push dispatch telemetry per cron run."""

    attempted: int = 0
    delivered: int = 0
    failed: int = 0
    skipped_local_sync: int = 0
    skipped_inactive: int = 0
    ssrf_blocked: int = 0
    deactivated_devices: List[str] = Field(default_factory=list)


class CronRemindersResponse(BaseModel):
    """POST /cron/reminders response summary."""

    claimed: int = 0
    dispatched_reminders: int = 0
    skipped_completed_items: int = 0
    push_summary: PushDeliverySummary = Field(default_factory=PushDeliverySummary)
    ran_at: datetime
