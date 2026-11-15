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


def _validate_http_url_optional(value: Optional[str], field_name: str = "url") -> Optional[str]:
    """Validate optional URL inputs so only clean HTTP(S) URLs are accepted."""
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if not cleaned.lower().startswith(("http://", "https://")) or any(
        ord(ch) < 0x20 or ord(ch) == 0x7F or ch in (" ", "<", ">", '"', "'", "\\")
        for ch in cleaned
    ):
        raise ValueError(f"{field_name} must be a valid HTTP(S) URL.")
    return cleaned


def _validate_folder_cover_optional(value: Optional[str]) -> Optional[str]:
    """Allow safe relative preset cover paths (./assets/covers/*.png) or clean HTTP(S) URLs."""
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if cleaned.startswith(("./assets/covers/", "/assets/covers/")):
        if ".." in cleaned or any(ord(ch) < 0x20 or ch in (" ", "<", ">", '"', "'", "\\") for ch in cleaned):
            raise ValueError("cover_url contains invalid characters.")
        return cleaned
    return _validate_http_url_optional(cleaned, "cover_url")


def _normalize_media_items_input(raw_items: Optional[List[Any]]) -> Optional[List[str]]:
    """Normalize string or dict media items into <=5 trimmed HTTP(S) URLs."""
    if raw_items is None:
        return None
    urls: List[str] = []
    for entry in raw_items:
        raw_candidate = ""
        if isinstance(entry, str):
            raw_candidate = entry.strip()
        elif isinstance(entry, dict):
            raw_candidate = str(entry.get("media_url") or entry.get("url") or entry.get("thumbnail_url") or "").strip()
        candidate = _validate_http_url_optional(raw_candidate, "media_items")
        if candidate and candidate not in urls:
            urls.append(candidate)
        if len(urls) >= 5:
            break
    return urls


class ReminderConfig(BaseModel):
    """Reminder payload aligned with public.reminders chk_reminder_schedule_fields."""

    schedule_type: Literal["once", "every_n_days"] = "once"
    remind_at: Optional[datetime] = None
    next_remind_at: Optional[datetime] = None
    repeat_every_days: Optional[int] = Field(default=None, ge=1, le=365)
    repeat_interval_days: Optional[int] = Field(default=None, ge=1, le=365)
    remind_time: Optional[str] = None
    timezone: str = "Asia/Bangkok"
    title_snapshot: Optional[str] = None
    is_enabled: Optional[bool] = True

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
        if self.remind_at is None and self.next_remind_at is not None:
            self.remind_at = self.next_remind_at
        if self.repeat_every_days is None and self.repeat_interval_days is not None:
            self.repeat_every_days = self.repeat_interval_days

        if self.schedule_type == "once":
            if self.repeat_every_days is not None:
                raise ValueError("repeat_every_days must be null when schedule_type='once'.")
            if self.remind_at is None:
                raise ValueError("remind_at is required when schedule_type='once'.")
        elif self.schedule_type == "every_n_days":
            if self.repeat_every_days is None or not (1 <= self.repeat_every_days <= 365):
                raise ValueError("repeat_every_days must be between 1 and 365 for schedule_type='every_n_days'.")
            if not self.remind_time and self.remind_at is not None:
                ref_dt = self.remind_at
                if ref_dt.tzinfo is None:
                    ref_dt = ref_dt.replace(tzinfo=timezone.utc)
                self.remind_time = ref_dt.astimezone(ZoneInfo(self.timezone)).strftime("%H:%M:%S")
            if not self.remind_time:
                raise ValueError("remind_time is required when schedule_type='every_n_days'.")
        return self


class ItemCreateRequest(BaseModel):
    """Lossless item creation schema (no truncation on title/description/note)."""

    url: str = Field(..., min_length=1)
    title: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    user_note: Optional[str] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None
    tag_names: Optional[List[str]] = None
    status: Literal["inbox", "todo", "done", "archived"] = "inbox"
    platform: Optional[str] = None
    content_type: Optional[Literal["video", "article", "post", "product", "link", "other"]] = None
    media_items: Optional[List[Any]] = Field(default=None, max_length=5)
    thumbnail_url: Optional[str] = None
    image_url: Optional[str] = None
    embed_url: Optional[str] = None
    embed_type: Optional[
        Literal["none", "youtube", "tiktok", "instagram", "facebook", "x", "reddit", "vimeo", "spotify"]
    ] = None
    is_favorite: Optional[bool] = None
    reminder: Optional[ReminderConfig] = None

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        cleaned = _validate_http_url_optional(value, "url")
        if not cleaned:
            raise ValueError("url must start with http:// or https://")
        return cleaned

    @field_validator("image_url", "thumbnail_url", "embed_url")
    @classmethod
    def check_optional_urls(cls, value: Optional[str], info: Any) -> Optional[str]:
        return _validate_http_url_optional(value, str(info.field_name or "url"))

    @model_validator(mode="after")
    def normalize_create_aliases(self) -> "ItemCreateRequest":
        if self.note is None and self.user_note is not None:
            self.note = self.user_note
        if not self.tags and self.tag_names is not None:
            self.tags = self.tag_names
        if self.image_url is None and self.thumbnail_url:
            self.image_url = _validate_http_url_optional(self.thumbnail_url, "thumbnail_url")
        normalized_media = _normalize_media_items_input(self.media_items)
        if normalized_media is not None:
            self.media_items = normalized_media
        if (not self.media_items) and self.image_url:
            self.media_items = [self.image_url]
        return self


class ItemUpdateRequest(BaseModel):
    """Partial item update schema."""

    title: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None
    user_note: Optional[str] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None
    tag_names: Optional[List[str]] = None
    status: Optional[Literal["inbox", "todo", "done", "archived"]] = None
    platform: Optional[str] = None
    content_type: Optional[Literal["video", "article", "post", "product", "link", "other"]] = None
    media_items: Optional[List[Any]] = Field(default=None, max_length=5)
    thumbnail_url: Optional[str] = None
    image_url: Optional[str] = None
    embed_url: Optional[str] = None
    embed_type: Optional[
        Literal["none", "youtube", "tiktok", "instagram", "facebook", "x", "reddit", "vimeo", "spotify"]
    ] = None
    is_favorite: Optional[bool] = None

    @field_validator("image_url", "thumbnail_url", "embed_url")
    @classmethod
    def check_optional_urls(cls, value: Optional[str], info: Any) -> Optional[str]:
        return _validate_http_url_optional(value, str(info.field_name or "url"))

    @model_validator(mode="after")
    def normalize_update_aliases(self) -> "ItemUpdateRequest":
        if "user_note" in self.model_fields_set and "note" not in self.model_fields_set:
            self.note = self.user_note
            self.model_fields_set.add("note")
        if "tag_names" in self.model_fields_set and "tags" not in self.model_fields_set:
            self.tags = self.tag_names
            self.model_fields_set.add("tags")
        if "thumbnail_url" in self.model_fields_set and "image_url" not in self.model_fields_set:
            self.image_url = _validate_http_url_optional(self.thumbnail_url, "thumbnail_url")
            self.model_fields_set.add("image_url")
        if "media_items" in self.model_fields_set:
            self.media_items = _normalize_media_items_input(self.media_items)
        return self


class FolderCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    emoji: Optional[str] = Field(default=None, max_length=16)
    cover_url: Optional[str] = Field(default=None, max_length=512)
    cover: Optional[str] = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def normalize_cover(self) -> "FolderCreateRequest":
        raw = self.cover_url if self.cover_url is not None else self.cover
        self.cover_url = _validate_folder_cover_optional(raw)
        return self


class FolderUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    emoji: Optional[str] = Field(default=None, max_length=16)
    cover_url: Optional[str] = Field(default=None, max_length=512)
    cover: Optional[str] = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def normalize_cover_update(self) -> "FolderUpdateRequest":
        if "cover_url" in self.model_fields_set or "cover" in self.model_fields_set:
            raw = self.cover_url if "cover_url" in self.model_fields_set else self.cover
            self.cover_url = _validate_folder_cover_optional(raw)
            self.model_fields_set.add("cover_url")
        return self


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
    category: Literal["bug", "feature", "waitlist", "general", "other"] = "general"
    contact_email: Optional[str] = Field(default=None, max_length=255)
    allow_contact: bool = False
    page_context: Optional[str] = Field(default=None, max_length=255)

    @field_validator("category")
    @classmethod
    def normalize_category(cls, value: str) -> str:
        return "general" if value == "other" else value

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
