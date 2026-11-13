"""Shared Supabase service-role client dependency for FastAPI routes."""

import logging
import os
from typing import Any, Optional

try:
    from supabase import create_client
except ImportError:
    create_client = None  # type: ignore

from Database.local_db import get_local_dev_db
from Database.supabase_client import is_supabase_configured

logger = logging.getLogger("just_save_it.database")

_override_client: Optional[Any] = None


def set_override_supabase_client(client: Optional[Any]) -> None:
    """Override Supabase client for hermetic testing."""
    global _override_client
    _override_client = client


def get_supabase_client() -> Any:
    """Return active Supabase client (test override, real Supabase, or persistent LocalDevDB)."""
    if _override_client is not None:
        return _override_client

    if not is_supabase_configured():
        logger.debug("Supabase is not configured; using local development JSON database.")
        return get_local_dev_db()

    if create_client is None:
        raise RuntimeError("supabase package is not installed. Run 'pip install supabase'.")

    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.getenv("SUPABASE_ANON_KEY", "").strip()
    )
    return create_client(supabase_url, supabase_key)


def get_db() -> Any:
    """FastAPI dependency returning active Supabase client."""
    return get_supabase_client()
