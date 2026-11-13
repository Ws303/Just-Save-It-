"""Authentication dependencies for FastAPI routers.

Provides:
- CurrentUser: Authenticated user context model
- get_current_user: Strict dependency delegating JWT / gated dev-bypass checks
- get_optional_current_user: Optional auth dependency
"""

from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials

from .auth_dep import bearer_scheme, extract_bearer_or_dev_payload


@dataclass
class CurrentUser:
    """Authenticated user context shared across all modules."""

    id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    tier: str = "free"
    access_token: str = ""


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    authorization: Optional[str] = Header(None, include_in_schema=False),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id", description="Dev-only user ID override"),
) -> CurrentUser:
    """Verify Bearer JWT token (or gated dev X-User-Id) and return CurrentUser."""
    payload = extract_bearer_or_dev_payload(
        credentials=credentials,
        authorization=authorization,
        x_user_id=x_user_id,
    )
    user_metadata = payload.get("user_metadata") or {}
    return CurrentUser(
        id=str(payload["sub"]),
        email=payload.get("email"),
        display_name=user_metadata.get("display_name") or user_metadata.get("full_name") or payload.get("name"),
        tier=user_metadata.get("tier", "free"),
        access_token=str(payload.get("_raw_token") or ""),
    )


async def get_optional_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    authorization: Optional[str] = Header(None, include_in_schema=False),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
) -> Optional[CurrentUser]:
    """Optional authentication dependency; returns None if credentials are missing or invalid."""
    try:
        return await get_current_user(
            credentials=credentials,
            authorization=authorization,
            x_user_id=x_user_id,
        )
    except HTTPException:
        return None
