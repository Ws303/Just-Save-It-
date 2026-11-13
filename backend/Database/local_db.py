"""Persistent local JSON database emulating the Supabase PostgREST & Storage SDK.

Used automatically when real Supabase credentials are not configured so the
FastAPI backend, Swagger UI (/docs), and Browser Extension can run end-to-end
out of the box with zero cloud setup.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple
import uuid

logger = logging.getLogger("just_save_it.local_db")

DEMO_USER_ID = "11111111-1111-4111-8111-111111111111"
DEMO_EMAIL = "may@example.com"
DEMO_PASSWORD_SALT = "jsi_salt_987"

ALL_TABLES: Tuple[str, ...] = (
    "profiles",
    "folders",
    "folder_members",
    "folder_invites",
    "items",
    "tags",
    "item_tags",
    "reminders",
    "devices",
    "daily_ai_usage",
    "api_tokens",
    "beta_feedback",
)

COMPOSITE_KEY_TABLES = {"folder_members", "item_tags", "daily_ai_usage", "folder_invites"}
TIMESTAMPED_TABLES = {
    "profiles",
    "folders",
    "reminders",
    "devices",
    "api_tokens",
    "beta_feedback",
}

_DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / ".local_dev_db.json"
_STORAGE_ROOT = Path(__file__).resolve().parent.parent / ".local_thumbnails"

_local_db_lock = threading.RLock()
_local_db_instance: Optional["LocalDevDatabase"] = None
_local_db_instance_path: Optional[str] = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_local_password(password: str) -> str:
    return hashlib.sha256(f"{DEMO_PASSWORD_SALT}:{password}".encode("utf-8")).hexdigest()


def _resolve_db_path() -> Optional[Path]:
    """Return persistence path, or None when running ephemeral pytest tests."""
    explicit = os.getenv("LOCAL_DEV_DB_PATH", "").strip()
    if explicit:
        if explicit == ":memory:":
            return None
        return Path(explicit).expanduser().resolve()
    if os.getenv("PYTEST_CURRENT_TEST"):
        return None
    return _DEFAULT_DB_PATH


def _ilike_to_regex(pattern: str) -> re.Pattern[str]:
    """Convert SQL ILIKE pattern (% and _) into a compiled case-insensitive regex."""
    parts: List[str] = ["^"]
    for ch in pattern:
        if ch == "%":
            parts.append(".*")
        elif ch == "_":
            parts.append(".")
        else:
            parts.append(re.escape(ch))
    parts.append("$")
    return re.compile("".join(parts), re.IGNORECASE | re.DOTALL)


def _normalize_null_sentinel(value: Any) -> Any:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "null":
            return None
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    return value


def _compare_values(left: Any, right: Any, op: str) -> bool:
    if left is None or right is None:
        return False
    try:
        if op == "lt":
            return left < right
        if op == "lte":
            return left <= right
        if op == "gt":
            return left > right
        if op == "gte":
            return left >= right
    except TypeError:
        l_str, r_str = str(left), str(right)
        if op == "lt":
            return l_str < r_str
        if op == "lte":
            return l_str <= r_str
        if op == "gt":
            return l_str > r_str
        if op == "gte":
            return l_str >= r_str
    return False


@dataclass
class LocalQueryResponse:
    """Minimal response shape matching postgrest-py APIResponse."""

    data: Any
    count: Optional[int] = None


class _NegatedFilterBuilder:
    """Proxy for `.not_` chain supporting `.is_`, `.eq`, `.neq`, `.in_`, `.ilike`."""

    def __init__(self, query: "LocalTableProxy") -> None:
        self._query = query

    def is_(self, column: str, value: Any) -> "LocalTableProxy":
        target = _normalize_null_sentinel(value)
        return self._query._add_predicate(lambda row: row.get(column) is not target)

    def eq(self, column: str, value: Any) -> "LocalTableProxy":
        return self._query._add_predicate(lambda row: row.get(column) != value)

    def neq(self, column: str, value: Any) -> "LocalTableProxy":
        return self._query._add_predicate(lambda row: row.get(column) == value)

    def in_(self, column: str, values: List[Any]) -> "LocalTableProxy":
        allowed = set(values)
        return self._query._add_predicate(lambda row: row.get(column) not in allowed)

    def ilike(self, column: str, pattern: str) -> "LocalTableProxy":
        regex = _ilike_to_regex(pattern)
        return self._query._add_predicate(
            lambda row: not (row.get(column) is not None and bool(regex.match(str(row.get(column)))))
        )


class LocalTableProxy:
    """Chainable PostgREST-compatible query builder operating on JSON-backed tables."""

    def __init__(self, db: "LocalDevDatabase", table_name: str) -> None:
        self._db = db
        self._table_name = table_name
        self._action: str = "select"
        self._count_mode: Optional[str] = None
        self._payload: Any = None
        self._on_conflict: Optional[str] = None
        self._predicates: List[Callable[[Dict[str, Any]], bool]] = []
        self._orders: List[Tuple[str, bool]] = []
        self._limit: Optional[int] = None
        self._range: Optional[Tuple[int, int]] = None
        self._single: bool = False
        self._maybe_single: bool = False

    def _add_predicate(self, fn: Callable[[Dict[str, Any]], bool]) -> "LocalTableProxy":
        self._predicates.append(fn)
        return self

    @property
    def not_(self) -> _NegatedFilterBuilder:
        return _NegatedFilterBuilder(self)

    def select(self, columns: str = "*", count: Optional[str] = None) -> "LocalTableProxy":
        if self._action not in ("insert", "upsert", "update", "delete"):
            self._action = "select"
        self._count_mode = count
        return self

    def insert(self, payload: Any) -> "LocalTableProxy":
        self._action = "insert"
        self._payload = deepcopy(payload)
        return self

    def upsert(self, payload: Any, on_conflict: Optional[str] = None) -> "LocalTableProxy":
        self._action = "upsert"
        self._payload = deepcopy(payload)
        self._on_conflict = on_conflict
        return self

    def update(self, updates: Dict[str, Any]) -> "LocalTableProxy":
        self._action = "update"
        self._payload = deepcopy(updates)
        return self

    def delete(self) -> "LocalTableProxy":
        self._action = "delete"
        return self

    def eq(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: row.get(column) == value)

    def neq(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: row.get(column) != value)

    def ilike(self, column: str, pattern: str) -> "LocalTableProxy":
        regex = _ilike_to_regex(pattern)
        return self._add_predicate(
            lambda row: row.get(column) is not None and bool(regex.match(str(row.get(column))))
        )

    def in_(self, column: str, values: List[Any]) -> "LocalTableProxy":
        allowed = list(values)
        return self._add_predicate(lambda row: row.get(column) in allowed)

    def is_(self, column: str, value: Any) -> "LocalTableProxy":
        target = _normalize_null_sentinel(value)
        if target is None:
            return self._add_predicate(lambda row: row.get(column) is None)
        return self._add_predicate(lambda row: row.get(column) is target)

    def lt(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: _compare_values(row.get(column), value, "lt"))

    def lte(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: _compare_values(row.get(column), value, "lte"))

    def gt(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: _compare_values(row.get(column), value, "gt"))

    def gte(self, column: str, value: Any) -> "LocalTableProxy":
        return self._add_predicate(lambda row: _compare_values(row.get(column), value, "gte"))

    def contains(self, column: str, value: Any) -> "LocalTableProxy":
        def _match(row: Dict[str, Any]) -> bool:
            cell = row.get(column)
            if isinstance(cell, list) and isinstance(value, list):
                return all(item in cell for item in value)
            if isinstance(cell, dict) and isinstance(value, dict):
                return all(cell.get(k) == v for k, v in value.items())
            return False

        return self._add_predicate(_match)

    def order(self, column: str, desc: bool = False) -> "LocalTableProxy":
        self._orders.append((column, bool(desc)))
        return self

    def limit(self, count: int) -> "LocalTableProxy":
        self._limit = max(0, int(count))
        return self

    def range(self, start: int, end: int) -> "LocalTableProxy":
        self._range = (max(0, int(start)), max(0, int(end)))
        return self

    def single(self) -> "LocalTableProxy":
        self._single = True
        return self

    def maybe_single(self) -> "LocalTableProxy":
        self._maybe_single = True
        return self

    def _matches(self, row: Dict[str, Any]) -> bool:
        return all(pred(row) for pred in self._predicates)

    def _prepare_row_for_insert(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        row = deepcopy(raw)
        now_iso = _utc_now_iso()
        if self._table_name not in COMPOSITE_KEY_TABLES and not row.get("id"):
            row["id"] = str(uuid.uuid4())
        if self._table_name in TIMESTAMPED_TABLES and "created_at" not in row:
            row["created_at"] = now_iso
        if self._table_name in {"profiles", "folders", "items", "reminders"} and "updated_at" not in row:
            row["updated_at"] = now_iso
        if self._table_name == "items":
            row.setdefault("saved_at", now_iso)
            row.setdefault("enrich_status", "pending")
            row.setdefault("enrich_attempts", 0)
            row.setdefault("is_pinned", False)
            row.setdefault("status", "inbox")
            row.setdefault("media_items", [])
            row.setdefault("embed_type", "none")
        if self._table_name == "tags":
            row.setdefault("usage_count", 1)
        return row

    def _execute_insert(self, rows: List[Dict[str, Any]]) -> LocalQueryResponse:
        items = self._payload if isinstance(self._payload, list) else [self._payload]
        inserted: List[Dict[str, Any]] = []
        for entry in items:
            prepared = self._prepare_row_for_insert(entry)
            rows.append(prepared)
            inserted.append(deepcopy(prepared))
        self._db.save()
        return self._format_response(inserted, len(inserted))

    def _execute_upsert(self, rows: List[Dict[str, Any]]) -> LocalQueryResponse:
        items = self._payload if isinstance(self._payload, list) else [self._payload]
        conflict_cols = (
            [col.strip() for col in self._on_conflict.split(",") if col.strip()]
            if self._on_conflict
            else ["id"]
        )
        affected: List[Dict[str, Any]] = []
        for entry in items:
            matched_row: Optional[Dict[str, Any]] = None
            if all(col in entry for col in conflict_cols):
                for existing in rows:
                    if all(existing.get(col) == entry.get(col) for col in conflict_cols):
                        matched_row = existing
                        break
            if matched_row is not None:
                matched_row.update(deepcopy(entry))
                if self._table_name in {"profiles", "folders", "items", "reminders"} and "updated_at" not in entry:
                    matched_row["updated_at"] = _utc_now_iso()
                affected.append(deepcopy(matched_row))
            else:
                prepared = self._prepare_row_for_insert(entry)
                rows.append(prepared)
                affected.append(deepcopy(prepared))
        self._db.save()
        return self._format_response(affected, len(affected))

    def _execute_update(self, rows: List[Dict[str, Any]]) -> LocalQueryResponse:
        updated: List[Dict[str, Any]] = []
        updates = deepcopy(self._payload or {})
        if self._table_name in {"profiles", "folders", "items", "reminders"} and "updated_at" not in updates:
            updates["updated_at"] = _utc_now_iso()
        for row in rows:
            if self._matches(row):
                row.update(updates)
                updated.append(deepcopy(row))
        if updated:
            self._db.save()
        return self._format_response(updated, len(updated))

    def _execute_delete(self, rows: List[Dict[str, Any]]) -> LocalQueryResponse:
        kept: List[Dict[str, Any]] = []
        deleted: List[Dict[str, Any]] = []
        for row in rows:
            if self._matches(row):
                deleted.append(deepcopy(row))
            else:
                kept.append(row)
        if deleted:
            self._db.tables[self._table_name] = kept
            self._db.save()
        return self._format_response(deleted, len(deleted))

    def _execute_select(self, rows: List[Dict[str, Any]]) -> LocalQueryResponse:
        matched = [deepcopy(row) for row in rows if self._matches(row)]
        total_count = len(matched)

        for col, is_desc in reversed(self._orders):
            matched.sort(
                key=lambda r: (r.get(col) is None, str(r.get(col)) if r.get(col) is not None else ""),
                reverse=is_desc,
            )

        if self._range is not None:
            start, end = self._range
            matched = matched[start : end + 1]
        elif self._limit is not None:
            matched = matched[: self._limit]

        return self._format_response(matched, total_count)

    def _format_response(self, rows: List[Dict[str, Any]], total_count: int) -> LocalQueryResponse:
        count_val = total_count if self._count_mode == "exact" else None
        if self._single:
            if len(rows) != 1:
                raise RuntimeError(f"Expected single row in '{self._table_name}', got {len(rows)}.")
            return LocalQueryResponse(data=rows[0], count=count_val)
        if self._maybe_single:
            return LocalQueryResponse(data=rows[0] if rows else None, count=count_val)
        return LocalQueryResponse(data=rows, count=count_val)

    def execute(self) -> LocalQueryResponse:
        with self._db.lock:
            rows = self._db.tables.setdefault(self._table_name, [])
            if self._action == "insert":
                return self._execute_insert(rows)
            if self._action == "upsert":
                return self._execute_upsert(rows)
            if self._action == "update":
                return self._execute_update(rows)
            if self._action == "delete":
                return self._execute_delete(rows)
            return self._execute_select(rows)


class LocalStorageBucket:
    """Local filesystem/memory emulation of Supabase Storage bucket."""

    def __init__(self, db: "LocalDevDatabase", bucket_name: str) -> None:
        self._db = db
        self._bucket = bucket_name

    def upload(self, path: str, file: bytes, file_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        del file_options
        clean_path = path.lstrip("/")
        if self._db.persist_path is not None:
            target = _STORAGE_ROOT / self._bucket / clean_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(file)
        else:
            self._db._memory_storage.setdefault(self._bucket, {})[clean_path] = file
        return {"path": clean_path}

    def get_public_url(self, path: str) -> str:
        clean_path = path.lstrip("/")
        base_url = os.getenv("BACKEND_BASE_URL", "http://localhost:8000").rstrip("/")
        return f"{base_url}/local-media/{self._bucket}/{clean_path}"


class LocalStorageClient:
    """Emulates `supabase.storage` namespace."""

    def __init__(self, db: "LocalDevDatabase") -> None:
        self._db = db

    def from_(self, bucket_name: str) -> LocalStorageBucket:
        return LocalStorageBucket(self._db, bucket_name)


class LocalDevDatabase:
    """Thread-safe JSON-backed database with seed data and PostgREST query emulation."""

    is_local_dev: bool = True

    def __init__(self, persist_path: Optional[Path] = None) -> None:
        self.lock = threading.RLock()
        self.persist_path = persist_path
        self.tables: Dict[str, List[Dict[str, Any]]] = {name: [] for name in ALL_TABLES}
        self._local_users: Dict[str, Dict[str, Any]] = {}
        self._local_tokens: Dict[str, List[Dict[str, Any]]] = {}
        self._memory_storage: Dict[str, Dict[str, bytes]] = {}
        self.storage = LocalStorageClient(self)
        self._load_or_seed()

    def _seed_defaults(self) -> None:
        now_iso = _utc_now_iso()
        demo_profile = {
            "id": DEMO_USER_ID,
            "email": DEMO_EMAIL,
            "display_name": "เมย์",
            "avatar_url": None,
            "tier": "free",
            "locale": "th",
            "timezone": "Asia/Bangkok",
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        self._local_users[DEMO_EMAIL] = {
            **demo_profile,
            "password_hash": _hash_local_password("password123"),
        }
        self.tables["profiles"] = [deepcopy(demo_profile)]
        self.tables["folders"] = [
            {
                "id": "22222222-2222-4222-8222-222222222201",
                "owner_id": DEMO_USER_ID,
                "name": "อ่านทีหลัง",
                "emoji": "📌",
                "is_shared": False,
                "created_at": now_iso,
                "updated_at": now_iso,
            },
            {
                "id": "22222222-2222-4222-8222-222222222202",
                "owner_id": DEMO_USER_ID,
                "name": "Tech & AI",
                "emoji": "🤖",
                "is_shared": False,
                "created_at": now_iso,
                "updated_at": now_iso,
            },
        ]

    def _load_or_seed(self) -> None:
        with self.lock:
            if self.persist_path is not None and self.persist_path.exists():
                try:
                    raw = json.loads(self.persist_path.read_text(encoding="utf-8"))
                    loaded_tables = raw.get("tables", {})
                    for name in ALL_TABLES:
                        rows = loaded_tables.get(name, [])
                        self.tables[name] = rows if isinstance(rows, list) else []
                    users = raw.get("local_users", {})
                    self._local_users = users if isinstance(users, dict) else {}
                    tokens = raw.get("local_tokens", {})
                    self._local_tokens = tokens if isinstance(tokens, dict) else {}
                    if DEMO_EMAIL not in self._local_users and not self.tables["profiles"]:
                        self._seed_defaults()
                        self.save()
                    return
                except Exception as exc:
                    logger.warning("Failed to load local dev DB '%s', re-seeding: %s", self.persist_path, exc)

            self._seed_defaults()
            self.save()

    def save(self) -> None:
        """Atomically persist database state when file backing is enabled."""
        if self.persist_path is None:
            return
        with self.lock:
            self.persist_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = self.persist_path.with_suffix(".tmp")
            payload = {
                "tables": self.tables,
                "local_users": self._local_users,
                "local_tokens": self._local_tokens,
            }
            tmp_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp_path, self.persist_path)

    def table(self, table_name: str) -> LocalTableProxy:
        return LocalTableProxy(self, table_name)

    def get_local_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            user = self._local_users.get(email.lower().strip())
            return deepcopy(user) if user else None

    def get_local_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            for user in self._local_users.values():
                if user.get("id") == user_id:
                    return deepcopy(user)
            return None

    def upsert_local_user(self, user_record: Dict[str, Any]) -> Dict[str, Any]:
        """Store auth user and keep `profiles` table synchronized."""
        with self.lock:
            clean_email = str(user_record["email"]).lower().strip()
            record = deepcopy(user_record)
            record["email"] = clean_email
            self._local_users[clean_email] = record

            profile_row = {
                k: v for k, v in record.items() if k != "password_hash"
            }
            profile_row["updated_at"] = _utc_now_iso()

            profiles = self.tables.setdefault("profiles", [])
            existing = next((p for p in profiles if p.get("id") == record["id"]), None)
            if existing is not None:
                existing.update(profile_row)
            else:
                profiles.append(profile_row)

            self.save()
            return deepcopy(record)

    def delete_local_user(self, user_id: str) -> None:
        """Delete user auth record and cascade-clean profile rows."""
        with self.lock:
            emails_to_delete = [
                email for email, u in self._local_users.items() if u.get("id") == user_id
            ]
            for email in emails_to_delete:
                self._local_users.pop(email, None)
            self._local_tokens.pop(user_id, None)
            self.tables["profiles"] = [
                p for p in self.tables.get("profiles", []) if p.get("id") != user_id
            ]
            self.save()


def get_local_dev_db() -> LocalDevDatabase:
    """Return singleton LocalDevDatabase aligned with current environment path."""
    global _local_db_instance, _local_db_instance_path
    resolved = _resolve_db_path()
    resolved_key = str(resolved) if resolved is not None else ":memory:"

    with _local_db_lock:
        if _local_db_instance is None or _local_db_instance_path != resolved_key:
            _local_db_instance = LocalDevDatabase(persist_path=resolved)
            _local_db_instance_path = resolved_key
        return _local_db_instance


def reset_local_dev_db() -> None:
    """Reset singleton instance (useful inside isolated tests)."""
    global _local_db_instance, _local_db_instance_path
    with _local_db_lock:
        _local_db_instance = None
        _local_db_instance_path = None
