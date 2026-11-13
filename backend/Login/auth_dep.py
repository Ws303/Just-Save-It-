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
from fastapi import Header, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from Database.client import get_supabase_client
from Database.supabase_client import is_supabase_configured

logger = logging.getLogger("just_save_it.auth")

_PLACEHOLDER_SECRET = "your_supabase_jwt_secret_here"
_PLACEHOLDER_URL = "https://your-project.supabase.co"
_LOCAL_DEV_JWT_SECRET = "just-save-it-development-jwt-secret-key-32chars"

bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Paste your access_token JWT from /api/auth/login or /api/auth/register",
)


def is_dev_bypass_enabled() -> bool:
    """Return True only when explicit development bypass flags are both active."""
    env = os.getenv("ENV", "production").strip().lower()
    bypass = os.getenv("ALLOW_DEV_AUTH_BYPASS", "false").strip().lower()
    return env == "development" and bypass == "true"


def verify_supabase_jwt(token: str) -> Dict[str, Any]:
    """Verify a Supabase or local-dev JWT signature, expiry, audience, and subject."""
    clean_token = (token or "").strip()
    if not clean_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token supplied.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    configured_secret = os.getenv("SUPABASE_JWT_SECRET", "").strip()
    has_configured_secret = bool(configured_secret and configured_secret != _PLACEHOLDER_SECRET)
    live_supabase = is_supabase_configured()

    try:
        header = jwt.get_unverified_header(clean_token)
        alg = str(header.get("alg") or "HS256").upper()
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: invalid authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    # Verify HS256 JWTs locally when using local dev auth or when SUPABASE_JWT_SECRET is configured
    if alg == "HS256" and (has_configured_secret or not live_supabase):
        jwt_secret = configured_secret if has_configured_secret else _LOCAL_DEV_JWT_SECRET
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
                    headers={"WWW-Authenticate": "Bearer"},
                )
            return payload
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication token has expired.",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc
        except jwt.InvalidTokenError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unauthorized: invalid authentication token.",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc

    # Live Supabase fallback for asymmetric (RS256/ES256) keys or when SUPABASE_JWT_SECRET is omitted
    if live_supabase:
        try:
            db = get_supabase_client()
            user_resp = db.auth.get_user(clean_token)
            if user_resp and getattr(user_resp, "user", None) and user_resp.user.id:
                u = user_resp.user
                return {
                    "sub": str(u.id),
                    "email": getattr(u, "email", None),
                    "user_metadata": getattr(u, "user_metadata", None) or {},
                }
        except Exception as exc:
            logger.warning("Supabase auth.get_user verification failed: %s", exc)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: invalid or unverifiable authentication token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def extract_bearer_or_dev_payload(
    credentials: Optional[HTTPAuthorizationCredentials] = None,
    authorization: Optional[str] = None,
    x_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Shared strict auth parser returning JWT payload or dev-bypass subject dict."""
    if isinstance(credentials, HTTPAuthorizationCredentials):
        if credentials.scheme.lower() != "bearer":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Authorization header. Expected 'Bearer <token>'.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        payload = verify_supabase_jwt(credentials.credentials)
        payload.setdefault("_raw_token", credentials.credentials.strip())
        return payload

    if authorization is not None and authorization.strip():
        if not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Authorization header. Expected 'Bearer <token>'.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        token = authorization.split("Bearer ", 1)[1].strip()
        payload = verify_supabase_jwt(token)
        payload.setdefault("_raw_token", token)
        return payload

    if x_user_id and x_user_id.strip():
        if is_dev_bypass_enabled():
            uid = x_user_id.strip()
            return {
                "sub": uid,
                "email": f"dev-{uid[:8]}@example.com",
                "user_metadata": {"display_name": "Dev User", "tier": "free"},
                "_raw_token": f"dev-token-{uid}",
            }
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: X-User-Id header bypass is disabled outside development.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing Authorization header. Expected 'Bearer <token>'.",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    authorization: Optional[str] = Header(None, include_in_schema=False),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id", description="Dev-only user id override"),
) -> str:
    """Extract verified user_id from Bearer JWT, or X-User-Id only in dev bypass mode."""
    payload = extract_bearer_or_dev_payload(
        credentials=credentials,
        authorization=authorization,
        x_user_id=x_user_id,
    )
    return str(payload["sub"])
