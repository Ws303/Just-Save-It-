"""Shared Supabase service-role client dependency for FastAPI routes."""

import logging
from typing import Any, Optional

from Database.local_db import get_local_dev_db
from Database.supabase_client import get_supabase_service_client, is_supabase_configured

logger = logging.getLogger("just_save_it.database")

_override_client: Optional[Any] = None


def set_override_supabase_client(client: Optional[Any]) -> None:
    """Override Supabase client for hermetic testing."""
    global _override_client
    _override_client = client


def get_supabase_client() -> Any:
    """Return active Supabase client (test override, pooled singleton Supabase, or persistent LocalDevDB)."""
    if _override_client is not None:
        return _override_client

    if not is_supabase_configured():
        logger.debug("Supabase is not configured; using local development JSON database.")
        return get_local_dev_db()

    return get_supabase_service_client()


def get_db() -> Any:
    """FastAPI dependency returning active Supabase client."""
    return get_supabase_client()
