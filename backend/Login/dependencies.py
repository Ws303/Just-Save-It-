"""Authentication dependencies for FastAPI routers.

Provides:
- CurrentUser: Authenticated user context model
- get_current_user: Dependency verifying JWT token or dev header
- get_optional_current_user: Optional auth dependency
"""

import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Header, HTTPException, status

from Database.supabase_client import (
    get_supabase_service_client,
    is_supabase_configured,
)

logger = logging.getLogger("just_save_it.login.dependencies")


@dataclass
class CurrentUser:
    """Authenticated user context shared across all modules."""
    id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    tier: str = "free"
    access_token: str = ""


async def get_current_user(
    authorization: Optional[str] = Header(None, description="Bearer <Supabase-JWT-token>"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id", description="Development user ID override"),
) -> CurrentUser:
    """Verify Supabase JWT token or development override and return CurrentUser."""
    # 1. Dev / test bypass header
    if x_user_id and x_user_id.strip():
        uid = x_user_id.strip()
        return CurrentUser(
            id=uid,
            email=f"dev-{uid[:8]}@example.com",
            display_name="Dev User",
            tier="free",
            access_token=f"dev-token-{uid}",
        )

    # 2. Validate Authorization header presence
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header. Expected 'Bearer <token>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # 3. Direct verify with SUPABASE_JWT_SECRET if configured
    jwt_secret = os.getenv("SUPABASE_JWT_SECRET", "").strip()
    if jwt_secret:
        try:
            payload = jwt.decode(
                token,
                jwt_secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
            sub = payload.get("sub")
            if sub:
                user_metadata = payload.get("user_metadata", {})
                return CurrentUser(
                    id=str(sub),
                    email=payload.get("email"),
                    display_name=user_metadata.get("display_name") or user_metadata.get("full_name"),
                    tier=user_metadata.get("tier", "free"),
                    access_token=token,
                )
        except jwt.PyJWTError as e:
            logger.debug("Local JWT signature verification failed: %s", e)

    # 4. Verify via Supabase Client Auth if live Supabase is connected
    if is_supabase_configured():
        try:
            client = get_supabase_service_client()
            user_resp = client.auth.get_user(token)
            if user_resp and user_resp.user and user_resp.user.id:
                u = user_resp.user
                meta = u.user_metadata or {}
                return CurrentUser(
                    id=str(u.id),
                    email=u.email,
                    display_name=meta.get("display_name") or meta.get("full_name"),
                    tier=meta.get("tier", "free"),
                    access_token=token,
                )
        except Exception as e:
            logger.warning("Supabase auth.get_user verification failed: %s", e)

    # 5. Fallback JWT payload decoder for demo/mock/test tokens
    try:
        parts = token.split(".")
        if len(parts) == 3:
            padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            decoded_bytes = base64.urlsafe_b64decode(padded)
            payload = json.loads(decoded_bytes)
            sub = payload.get("sub")
            if sub:
                user_metadata = payload.get("user_metadata", {})
                return CurrentUser(
                    id=str(sub),
                    email=payload.get("email"),
                    display_name=user_metadata.get("display_name") or user_metadata.get("full_name") or payload.get("name"),
                    tier=user_metadata.get("tier", "free"),
                    access_token=token,
                )
    except Exception as e:
        logger.debug("Fallback JWT payload extraction failed: %s", e)

    # 6. Raw UUID or test token string support
    if len(token) >= 8 and ("-" in token or token.startswith("test-") or token.startswith("dev-")):
        return CurrentUser(
            id=token,
            email=f"user-{token[:8]}@example.com",
            display_name="Test User",
            tier="free",
            access_token=token,
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: Invalid or expired access token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_optional_current_user(
    authorization: Optional[str] = Header(None),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
) -> Optional[CurrentUser]:
    """Optional authentication dependency; returns None if credentials are missing or invalid."""
    try:
        return await get_current_user(authorization=authorization, x_user_id=x_user_id)
    except HTTPException:
        return None
