"""Shared Supabase JWT verification and strict dev-bypass dependency.

Mitigates RISK-001:
- Enforces HS256 signature, expiration (`exp`), subject (`sub`), and audience (`authenticated`)
  verification via PyJWT using `SUPABASE_JWT_SECRET`.
- Rejects raw UUID bearer tokens and unverified JWT payloads.
- Allows `X-User-Id` bypass ONLY when BOTH `ENV=development` AND `ALLOW_DEV_AUTH_BYPASS=true`.
"""

import logging
import os
from typing import Any, Dict, Optional

import jwt
from fastapi import Header, HTTPException, status

from Database.client import get_supabase_client

logger = logging.getLogger("just_save_it.auth")

_PLACEHOLDER_SECRET = "your_supabase_jwt_secret_here"
_PLACEHOLDER_URL = "https://your-project.supabase.co"


def is_dev_bypass_enabled() -> bool:
    """Return True only when explicit development bypass flags are both active."""
    env = os.getenv("ENV", "production").strip().lower()
    bypass = os.getenv("ALLOW_DEV_AUTH_BYPASS", "false").strip().lower()
    return env == "development" and bypass == "true"


def verify_supabase_jwt(token: str) -> Dict[str, Any]:
    """Verify a Supabase JWT signature, expiry, audience, and subject."""
    clean_token = (token or "").strip()
    if not clean_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token supplied.",
        )

    jwt_secret = os.getenv("SUPABASE_JWT_SECRET", "").strip()
    if jwt_secret and jwt_secret != _PLACEHOLDER_SECRET:
        try:
            payload = jwt.decode(
                clean_token,
                jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
                options={"require": ["exp", "sub"]},
            )
            sub = str(payload.get("sub") or "").strip()
            if not sub:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid token: missing subject claim.",
                )
            return payload
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication token has expired.",
            ) from exc
        except jwt.InvalidTokenError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unauthorized: invalid authentication token.",
            ) from exc

    # Fallback ONLY to live Supabase Auth API if configured with non-placeholder URL & key
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if (
        supabase_url
        and supabase_key
        and supabase_url != _PLACEHOLDER_URL
        and "placeholder.supabase.co" not in supabase_url
    ):
        try:
            db = get_supabase_client()
            user_resp = db.auth.get_user(clean_token)
            if user_resp and getattr(user_resp, "user", None) and user_resp.user.id:
                return {"sub": str(user_resp.user.id)}
        except Exception as exc:
            logger.warning("Supabase auth.get_user verification failed: %s", exc)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: invalid or unverifiable authentication token.",
    )


async def get_current_user_id(
    authorization: Optional[str] = Header(None, description="Supabase JWT Bearer token"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id", description="Dev-only user id override"),
) -> str:
    """Extract verified user_id from Bearer JWT, or X-User-Id only in dev bypass mode."""
    if authorization is not None and authorization.strip():
        if not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Authorization header. Expected 'Bearer <token>'.",
            )
        token = authorization.split("Bearer ", 1)[1].strip()
        payload = verify_supabase_jwt(token)
        return str(payload["sub"])

    if x_user_id and x_user_id.strip():
        if is_dev_bypass_enabled():
            return x_user_id.strip()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: X-User-Id header bypass is disabled outside development.",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing Authorization header. Expected 'Bearer <token>'.",
    )
