"""Just-Save-It Database package (text hygiene, Supabase client, repository, router)."""

try:
    from .supabase_client import (
        get_supabase_anon_client,
        get_supabase_service_client,
        get_user_scoped_client,
    )
    __all__ = [
        "get_supabase_anon_client",
        "get_supabase_service_client",
        "get_user_scoped_client",
    ]
except ImportError:
    __all__ = []
