"""Shared Supabase JWT verification and strict dev-bypass dependency.

Mitigates RISK-001:
- Enforces HS256 signature, expiration (`exp`), subject (`sub`), and audience (`authenticated`)
  verification via PyJWT using `SUPABASE_JWT_SECRET`.
- Rejects raw UUID bearer tokens and unverified JWT payloads.
- Allows `X-User-Id` bypass ONLY when BOTH `ENV=development` AND `ALLOW_DEV_AUTH_BYPASS=true`.
"""

import asyncio
import logging
import os
from typing import Any, Dict, Optional, Set

import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError
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


def get_configured_hs256_secret() -> Optional[str]:
    """Return configured SUPABASE_JWT_SECRET, ignoring empty or template placeholder values."""
    secret = os.getenv("SUPABASE_JWT_SECRET", "").strip()
    if not secret or secret == _PLACEHOLDER_SECRET or "placeholder" in secret.lower():
        return None
    return secret


_ASYMMETRIC_ALGS = {"ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "EdDSA"}
_jwk_clients: Dict[str, PyJWKClient] = {}


def get_configured_supabase_url() -> Optional[str]:
    """Return configured SUPABASE_URL, ignoring empty or template placeholder values."""
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    if not url or url == _PLACEHOLDER_URL or "placeholder" in url.lower():
        return None
    return url


def _get_jwk_client(supabase_url: str) -> PyJWKClient:
    """Return a cached PyJWKClient bound to Supabase Auth's /.well-known/jwks.json."""
    jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
    client = _jwk_clients.get(jwks_url)
    if client is None:
        client = PyJWKClient(jwks_url, cache_keys=True, lifespan=300)
        _jwk_clients[jwks_url] = client
    return client


_DELETED_USER_IDS: Set[str] = set()


def mark_user_deleted(user_id: str) -> None:
    """Record a deleted user ID in memory so remaining JWTs are rejected immediately."""
    clean_id = str(user_id or "").strip()
    if clean_id:
        _DELETED_USER_IDS.add(clean_id)


def is_user_deleted(user_id: str) -> bool:
    """Return True if the user ID has been revoked/deleted in this worker."""
    return str(user_id or "").strip() in _DELETED_USER_IDS


def _is_not_found_auth_error(exc: Exception) -> bool:
    status_code = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if status_code == 404:
        return True
    msg = str(exc).lower()
    return any(tok in msg for tok in ("not found", "not_found", "user_not_found", "does not exist", "404"))


def _raise_deleted_user_error() -> None:
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: user account has been deleted.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _verify_live_user_exists(sub: str) -> None:
    """Cross-worker revocation check against live Supabase without stale positive caching."""
    if not is_supabase_configured():
        return
    try:
        db = get_supabase_client()
        prof_res = db.table("profiles").select("id").eq("id", sub).limit(1).execute()
        if getattr(prof_res, "data", None):
            return
        auth_admin = getattr(getattr(db, "auth", None), "admin", None)
        get_user_by_id = getattr(auth_admin, "get_user_by_id", None) if auth_admin is not None else None
        if callable(get_user_by_id):
            try:
                user_resp = get_user_by_id(sub)
            except Exception as exc:
                if _is_not_found_auth_error(exc):
                    mark_user_deleted(sub)
                    _raise_deleted_user_error()
                raise
            if getattr(user_resp, "user", None) and getattr(user_resp.user, "id", None):
                return
            mark_user_deleted(sub)
            _raise_deleted_user_error()
    except HTTPException:
        raise
    except Exception as exc:
        logger.debug("Non-fatal live user existence check skipped for %s: %s", sub, exc)


def _ensure_authenticated_claims(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure decoded JWT contains a non-empty subject and is not an anonymous key token."""
    sub = str(payload.get("sub") or "").strip()
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing subject claim.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if is_user_deleted(sub):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: user account has been deleted.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if str(payload.get("role") or "").strip().lower() == "anon":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: anonymous API key cannot be used as user session.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    _verify_live_user_exists(sub)
    return payload


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

    configured_secret = get_configured_hs256_secret() or ""
    has_configured_secret = bool(configured_secret)
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

    if alg == "NONE":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: unsecured JWT algorithm is not allowed.",
            headers={"WWW-Authenticate": "Bearer"},
        )

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
            return _ensure_authenticated_claims(payload)
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

    # Verify asymmetric Supabase JWTs (ES256 / RS256 / etc.) locally against cached JWKS
    configured_url = get_configured_supabase_url()
    if alg in _ASYMMETRIC_ALGS and configured_url:
        try:
            signing_key = _get_jwk_client(configured_url).get_signing_key_from_jwt(clean_token)
            payload = jwt.decode(
                clean_token,
                signing_key.key,
                algorithms=[alg],
                audience="authenticated",
                issuer=f"{configured_url}/auth/v1",
                options={"require": ["exp", "sub"]},
            )
            return _ensure_authenticated_claims(payload)
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication token has expired.",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc
        except PyJWKClientError as exc:
            logger.warning("Supabase JWKS verification unavailable (%s): %s", alg, exc)
            if not live_supabase:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Unauthorized: could not verify signing key against Supabase JWKS.",
                    headers={"WWW-Authenticate": "Bearer"},
                ) from exc
        except jwt.InvalidTokenError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unauthorized: invalid authentication token.",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc

    # Live Supabase fallback when SUPABASE_JWT_SECRET is omitted or JWKS lookup temporarily failed
    if live_supabase:
        try:
            db = get_supabase_client()
            user_resp = db.auth.get_user(clean_token)
            if user_resp and getattr(user_resp, "user", None) and user_resp.user.id:
                u = user_resp.user
                return _ensure_authenticated_claims(
                    {
                        "sub": str(u.id),
                        "email": getattr(u, "email", None),
                        "role": getattr(u, "role", None) or "authenticated",
                        "user_metadata": getattr(u, "user_metadata", None) or {},
                    }
                )
        except HTTPException:
            raise
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
    payload = await asyncio.to_thread(
        extract_bearer_or_dev_payload,
        credentials=credentials,
        authorization=authorization,
        x_user_id=x_user_id,
    )
    return str(payload["sub"])
