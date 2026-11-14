"""Supabase Client Management for Just-Save-It Backend.

Provides:
- get_supabase_anon_client(): For unauthenticated/public flows (OAuth, initial sign-up)
- get_supabase_service_client(): For backend service operations with elevated privileges
- get_user_scoped_client(access_token): For user-scoped operations with Supabase RLS enforced
"""

import logging
import os
from typing import Any, Optional

try:
    from supabase import Client, ClientOptions, create_client
except ImportError:
    Client = Any  # type: ignore
    ClientOptions = Any  # type: ignore
    create_client = None  # type: ignore

logger = logging.getLogger("just_save_it.database.supabase_client")

_anon_client_instance: Optional[Any] = None
_service_client_instance: Optional[Any] = None


def get_supabase_url() -> str:
    """Retrieve the configured Supabase Project URL."""
    return os.getenv("SUPABASE_URL", "").strip() or "https://placeholder.supabase.co"


def get_supabase_anon_key() -> str:
    """Retrieve the configured Supabase Anon/Public API Key."""
    return os.getenv("SUPABASE_ANON_KEY", "").strip() or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip() or "placeholder-key"


def get_supabase_service_role_key() -> str:
    """Retrieve the configured Supabase Service Role Key."""
    return os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.getenv("SUPABASE_ANON_KEY", "").strip() or "placeholder-key"


def is_supabase_configured() -> bool:
    """Check whether actual (non-placeholder) Supabase URL and Service Role key are configured."""
    url = os.getenv("SUPABASE_URL", "").strip()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not service_key:
        return False
    lowered_url = url.lower()
    lowered_key = service_key.lower()
    if "placeholder" in lowered_url or "placeholder" in lowered_key:
        return False
    if "your-project.supabase.co" in lowered_url or lowered_key.startswith("your_supabase_"):
        return False
    return True


def get_supabase_anon_client() -> Any:
    """Obtain singleton client with public anon key."""
    global _anon_client_instance
    if _anon_client_instance is not None:
        return _anon_client_instance

    if create_client is None:
        raise RuntimeError("Supabase SDK is not installed. Run 'pip install supabase'.")

    url = get_supabase_url()
    key = get_supabase_anon_key()
    _anon_client_instance = create_client(url, key)
    return _anon_client_instance


def get_supabase_service_client() -> Any:
    """Obtain singleton client with elevated service role key."""
    global _service_client_instance
    if _service_client_instance is not None:
        return _service_client_instance

    if create_client is None:
        raise RuntimeError("Supabase SDK is not installed. Run 'pip install supabase'.")

    url = get_supabase_url()
    key = get_supabase_service_role_key()
    _service_client_instance = create_client(url, key)
    return _service_client_instance


def get_user_scoped_client(access_token: str) -> Any:
    """Create a new client with the user's access token attached for RLS enforcement."""
    if create_client is None:
        raise RuntimeError("Supabase SDK is not installed. Run 'pip install supabase'.")

    url = get_supabase_url()
    key = get_supabase_anon_key()
    options = ClientOptions(headers={"Authorization": f"Bearer {access_token}"})
    return create_client(url, key, options=options)
