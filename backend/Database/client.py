"""Shared Supabase service-role client dependency for FastAPI routes."""

import logging
import os
from typing import Any, Optional

try:
    from supabase import create_client
except ImportError:
    create_client = None  # type: ignore

logger = logging.getLogger("just_save_it.database")

_override_client: Optional[Any] = None


def set_override_supabase_client(client: Optional[Any]) -> None:
    """Override Supabase client for hermetic testing."""
    global _override_client
    _override_client = client


def get_supabase_client() -> Any:
    """Return active Supabase client (or test override)."""
    if _override_client is not None:
        return _override_client

    if create_client is None:
        raise RuntimeError("supabase package is not installed. Run 'pip install supabase'.")

    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        logger.warning("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured.")

    return create_client(
        supabase_url or "https://placeholder.supabase.co",
        supabase_key or "placeholder",
    )


def get_db() -> Any:
    """FastAPI dependency returning active Supabase client."""
    return get_supabase_client()
