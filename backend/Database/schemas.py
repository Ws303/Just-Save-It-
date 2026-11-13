"""Pydantic v2 schemas for Just-Save-It Database CRUD, Sharing, Devices, and Reminders."""

from datetime import datetime, time, timezone
from typing import Any, Dict, List, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

from .text_hygiene import clean_text_field


def parse_remind_time(value: Optional[str]) -> Optional[str]:
    """Validate and normalize HH:MM or HH:MM:SS string."""
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(raw, fmt).time()
            return parsed.strftime("%H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"Invalid remind_time '{value}'. Expected HH:MM or HH:MM:SS.")


def validate_iana_timezone(value: str) -> str:
    tz_name = (value or "").strip()
    if not tz_name:
        raise ValueError("Timezone cannot be empty.")
    try:
        ZoneInfo(tz_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Invalid IANA timezone: '{tz_name}'") from exc
    return tz_name


class ReminderConfig(BaseModel):
    """Reminder payload aligned with public.reminders chk_reminder_schedule_fields."""

    schedule_type: Literal["once", "every_n_days"] = "once"
    remind_at: Optional[datetime] = None
    repeat_every_days: Optional[int] = Field(default=None, ge=1, le=365)
    remind_time: Optional[str] = None
    timezone: str = "Asia/Bangkok"
    title_snapshot: Optional[str] = None

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: str) -> str:
        return validate_iana_timezone(value)

    @field_validator("remind_time")
    @classmethod
    def check_remind_time(cls, value: Optional[str]) -> Optional[str]:
        return parse_remind_time(value)

    @model_validator(mode="after")
    def validate_schedule_constraints(self) -> "ReminderConfig":
        if self.schedule_type == "once":
            if self.repeat_every_days is not None:
                raise ValueError("repeat_every_days must be null when schedule_type='once'.")
            if self.remind_at is None:
                raise ValueError("remind_at is required when schedule_type='once'.")
        elif self.schedule_type == "every_n_days":
            if self.repeat_every_days is None or not (1 <= self.repeat_every_days <= 365):
                raise ValueError("repeat_every_days must be between 1 and 365 for schedule_type='every_n_days'.")
            if not self.remind_time:
                raise ValueError("remind_time is required when schedule_type='every_n_days'.")
        return self


class ItemCreateRequest(BaseModel):
    """Lossless item creation schema (no truncation on title/description/note)."""

    url: str = Field(..., min_length=1)
    title: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Literal["inbox", "todo", "done", "archived"] = "inbox"
    platform: Optional[str] = None
    content_type: Optional[Literal["video", "article", "post", "product", "link", "other"]] = None
    media_items: Optional[List[str]] = Field(default=None, max_length=5)
    reminder: Optional[ReminderConfig] = None

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or not (cleaned.lower().startswith("http://") or cleaned.lower().startswith("https://")):
            raise ValueError("url must start with http:// or https://")
        return cleaned


class ItemUpdateRequest(BaseModel):
    """Partial item update schema."""

    title: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None
    status: Optional[Literal["inbox", "todo", "done", "archived"]] = None
    platform: Optional[str] = None
    content_type: Optional[Literal["video", "article", "post", "product", "link", "other"]] = None
    media_items: Optional[List[str]] = Field(default=None, max_length=5)


class FolderCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    emoji: Optional[str] = Field(default=None, max_length=16)


class FolderUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    emoji: Optional[str] = Field(default=None, max_length=16)


class InviteCreateRequest(BaseModel):
    role: Literal["viewer", "editor"] = "editor"
    expires_in_days: int = Field(default=7, ge=1, le=90)
    max_uses: Optional[int] = Field(default=None, ge=1, le=1000)


class TagCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    color: Optional[str] = Field(default=None, max_length=32)


class TagUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = Field(default=None, max_length=32)


class DeviceRegisterRequest(BaseModel):
    platform: Literal["android", "ios", "web", "extension"]
    delivery_mode: Literal["remote", "local_sync"] = "remote"
    push_token: Optional[str] = None
    web_push_sub: Optional[Dict[str, Any]] = None
    is_active: bool = True

    @model_validator(mode="after")
    def validate_delivery_fields(self) -> "DeviceRegisterRequest":
        if self.delivery_mode == "remote" and self.platform in ("android", "ios"):
            if not self.push_token or not self.push_token.strip():
                raise ValueError("push_token is required for mobile remote push delivery.")
        if self.delivery_mode == "local_sync" and self.push_token is not None:
            cleaned = self.push_token.strip()
            self.push_token = cleaned if cleaned else None
        return self


class FolderMemberRoleUpdateRequest(BaseModel):
    role: Literal["editor", "viewer"] = "viewer"


class FeedbackCreateRequest(BaseModel):
    """Beta waitlist / bug / feature feedback intake aligned with REQ-005."""

    message: str = Field(..., min_length=3, max_length=2000)
    category: Literal["bug", "feature", "waitlist", "general"] = "general"
    contact_email: Optional[str] = Field(default=None, max_length=255)
    allow_contact: bool = False

    @field_validator("message")
    @classmethod
    def sanitize_message(cls, value: str) -> str:
        cleaned = clean_text_field(value, unescape_html=False)
        if not cleaned or len(cleaned) < 3:
            raise ValueError("Feedback message must be at least 3 characters.")
        return cleaned[:2000]

    @field_validator("contact_email")
    @classmethod
    def sanitize_contact_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None
