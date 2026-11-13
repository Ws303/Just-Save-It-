"""Just-Save-It Login & Auth package (Supabase JWT verification, dev-bypass guard, profile & MCP token endpoints)."""

from .auth_dep import get_current_user_id, is_dev_bypass_enabled, verify_supabase_jwt
from .router import router

__all__ = [
    "router",
    "get_current_user_id",
    "verify_supabase_jwt",
    "is_dev_bypass_enabled",
]
