"""FastAPI router for user authentication profile, AI quota status, and MCP API tokens."""

from datetime import datetime, timezone
import hashlib
import logging
import os
import secrets
from typing import Any, Dict, List, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from Database.client import get_db
from Database.text_hygiene import clean_text_field
from .auth_dep import get_current_user_id
from .dependencies import CurrentUser, get_current_user
from .schemas import (
    AuthTokenResponse,
    LoginRequest,
    MagicLinkRequest,
    MagicLinkResponse,
    NativeAuthRequest,
    OAuthCallbackRequest,
    RefreshTokenRequest,
    RegisterRequest,
)
from .service import auth_service

logger = logging.getLogger("just_save_it.login")

router = APIRouter(prefix="/api/auth", tags=["Auth & Profile"])

DEFAULT_FREE_MONTHLY_AI_LIMIT = 50
DEFAULT_PRO_MONTHLY_AI_LIMIT = 1000


class ProfileUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=120)
    preferred_summary_language: Optional[Literal["th", "en", "auto"]] = None
    default_timezone: Optional[str] = Field(default=None, max_length=80)

    @field_validator("default_timezone")
    @classmethod
    def validate_timezone(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        tz_name = value.strip()
        if not tz_name:
            raise ValueError("Timezone cannot be empty.")
        try:
            ZoneInfo(tz_name)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"Unknown IANA timezone: '{tz_name}'") from exc
        return tz_name


class CreateTokenRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


def _default_profile(user_id: str) -> Dict[str, Any]:
    return {
        "id": user_id,
        "display_name": None,
        "avatar_url": None,
        "tier": "free",
        "locale": "th",
        "preferred_summary_language": "th",
        "default_timezone": "Asia/Bangkok",
    }


# ==================== Core Auth Endpoints (Register / Login / OAuth / Session) ====================

@router.post(
    "/register",
    response_model=AuthTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user account with Email and Password",
)
async def register_endpoint(req: RegisterRequest) -> AuthTokenResponse:
    """Create a new account with email and password."""
    return await auth_service.register_user(req)


@router.post(
    "/login",
    response_model=AuthTokenResponse,
    summary="Login with Email and Password",
)
async def login_endpoint(req: LoginRequest) -> AuthTokenResponse:
    """Authenticate existing user with email and password."""
    return await auth_service.login_user(req)


@router.post(
    "/magic-link",
    response_model=MagicLinkResponse,
    summary="Request a passwordless magic link for login",
)
async def magic_link_endpoint(req: MagicLinkRequest) -> MagicLinkResponse:
    """Send or generate a passwordless magic link."""
    return await auth_service.request_magic_link(req)


@router.post(
    "/native",
    response_model=AuthTokenResponse,
    summary="Native Mobile SDK Login (Google / Sign in with Apple Face ID)",
)
async def native_auth_endpoint(req: NativeAuthRequest) -> AuthTokenResponse:
    """Exchange native Google/Apple ID token for a JWT session."""
    return await auth_service.login_with_native_id_token(req)


@router.get(
    "/oauth/{provider}",
    summary="Get Web OAuth authorization URL for Google / Apple",
)
async def get_oauth_url_endpoint(
    provider: str,
    redirect_to: str = Query(default="http://localhost:5173", description="Post-login redirect URL"),
):
    """Retrieve the OAuth redirect URL for Web/Extension authentication."""
    return auth_service.get_oauth_url(provider=provider, redirect_to=redirect_to)


@router.post(
    "/oauth/callback",
    response_model=AuthTokenResponse,
    summary="Exchange OAuth code for session",
)
async def oauth_callback_endpoint(req: OAuthCallbackRequest) -> AuthTokenResponse:
    """Exchange OAuth authorization code for session."""
    return await auth_service.exchange_oauth_code(req.code)


@router.post(
    "/refresh",
    response_model=AuthTokenResponse,
    summary="Refresh an expired access token using refresh_token",
)
async def refresh_endpoint(req: RefreshTokenRequest) -> AuthTokenResponse:
    """Renew session access token."""
    return await auth_service.refresh_session(req.refresh_token)


@router.post(
    "/logout",
    summary="Sign out and invalidate session",
)
async def logout_endpoint(
    current_user: CurrentUser = Depends(get_current_user),
):
    """Revoke active session token."""
    return await auth_service.logout_user(current_user.access_token)


# ==================== Profile, Quota & Token Endpoints ====================

@router.get("/me")
def get_me(
    current_user: CurrentUser = Depends(get_current_user),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Return current user's profile and monthly built-in AI quota usage."""
    user_id = current_user.id
    prof_res = db.table("profiles").select("*").eq("id", user_id).execute()
    profile = dict(prof_res.data[0]) if prof_res.data else _default_profile(user_id)
    profile.setdefault("preferred_summary_language", "th")
    profile.setdefault("default_timezone", "Asia/Bangkok")
    profile.setdefault("tier", current_user.tier or "free")

    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    usage_res = (
        db.table("daily_ai_usage")
        .select("request_count")
        .eq("user_id", user_id)
        .eq("usage_month", current_month)
        .execute()
    )
    used = int(usage_res.data[0].get("request_count", 0)) if usage_res.data else 0

    free_limit = int(os.getenv("FREE_TIER_MONTHLY_AI_LIMIT", str(DEFAULT_FREE_MONTHLY_AI_LIMIT)))
    limit = DEFAULT_PRO_MONTHLY_AI_LIMIT if profile.get("tier") == "pro" else free_limit

    local_user = None
    if hasattr(auth_service, "_local_users"):
        for u in auth_service._local_users.values():
            if u.get("id") == user_id:
                local_user = u
                break

    email = (
        profile.get("email")
        or current_user.email
        or (local_user.get("email") if local_user else None)
        or f"{user_id}@example.com"
    )
    display_name = (
        profile.get("display_name")
        or current_user.display_name
        or (local_user.get("display_name") if local_user else None)
    )
    if display_name and not profile.get("display_name"):
        profile["display_name"] = display_name
    if email and not profile.get("email"):
        profile["email"] = email

    return {
        "user_id": user_id,
        "id": user_id,
        "email": email,
        "display_name": profile.get("display_name"),
        "tier": profile.get("tier", "free"),
        "role": getattr(current_user, "role", None) or "authenticated",
        "profile": profile,
        "ai_quota": {
            "usage_month": current_month,
            "used": used,
            "limit": limit,
            "remaining": max(0, limit - used),
        },
    }


@router.patch("/profile")
@router.patch("/me")
def update_profile(
    req: ProfileUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Update authenticated user's display name, summary language, or default timezone."""
    updates: Dict[str, Any] = {}
    if req.display_name is not None:
        updates["display_name"] = clean_text_field(req.display_name, unescape_html=False)
    if req.preferred_summary_language is not None:
        updates["preferred_summary_language"] = req.preferred_summary_language
    if req.default_timezone is not None:
        updates["default_timezone"] = req.default_timezone

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid profile fields provided for update.",
        )

    existing = db.table("profiles").select("*").eq("id", user_id).execute()
    if existing.data:
        res = db.table("profiles").update(updates).eq("id", user_id).execute()
        profile = res.data[0] if res.data else {**existing.data[0], **updates}
    else:
        payload = {**_default_profile(user_id), **updates}
        res = db.table("profiles").insert(payload).execute()
        profile = res.data[0] if res.data else payload

    if hasattr(auth_service, "_local_users"):
        for u in auth_service._local_users.values():
            if u.get("id") == user_id:
                if req.display_name:
                    u["display_name"] = profile.get("display_name")
                break

    return {
        "profile": profile,
        "display_name": profile.get("display_name"),
        "id": user_id,
    }


@router.get("/tokens")
def list_tokens(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    """List MCP API tokens belonging to the authenticated user (without hashes)."""
    res = (
        db.table("api_tokens")
        .select("id, name, token_prefix, last_used_at, revoked_at, created_at")
        .eq("user_id", user_id)
        .execute()
    )
    sanitized = [
        {
            "id": row.get("id"),
            "name": row.get("name"),
            "token_prefix": row.get("token_prefix"),
            "last_used_at": row.get("last_used_at"),
            "revoked_at": row.get("revoked_at"),
            "created_at": row.get("created_at"),
        }
        for row in (res.data or [])
    ]
    return {"tokens": sanitized}


@router.post("/tokens", status_code=status.HTTP_201_CREATED)
def create_token(
    req: CreateTokenRequest,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Issue a new Personal Access Token (raw secret returned once; SHA-256 hash stored)."""
    clean_name = clean_text_field(req.name, unescape_html=False)
    if not clean_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token name cannot be blank.")

    raw_token = f"jsi_live_{secrets.token_urlsafe(24)}"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    token_prefix = raw_token[:16]
    created_at = datetime.now(timezone.utc).isoformat()

    res = (
        db.table("api_tokens")
        .insert(
            {
                "user_id": user_id,
                "token_hash": token_hash,
                "token_prefix": token_prefix,
                "name": clean_name,
                "created_at": created_at,
            }
        )
        .execute()
    )
    row = res.data[0] if res.data else {}
    return {
        "id": row.get("id"),
        "name": clean_name,
        "token_prefix": token_prefix,
        "token": raw_token,
        "created_at": row.get("created_at", created_at),
    }


@router.delete("/tokens/{token_id}")
def revoke_token(
    token_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Revoke an existing MCP token owned by the authenticated user."""
    existing = db.table("api_tokens").select("id, user_id, revoked_at").eq("id", token_id).execute()
    if not existing.data or existing.data[0].get("user_id") != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API token not found.")

    revoked_at = datetime.now(timezone.utc).isoformat()
    db.table("api_tokens").update({"revoked_at": revoked_at}).eq("id", token_id).eq("user_id", user_id).execute()
    return {"revoked": True, "id": token_id, "revoked_at": revoked_at}


@router.delete("/me")
def delete_my_account(
    user_id: str = Depends(get_current_user_id),
    db: Any = Depends(get_db),
) -> Dict[str, Any]:
    """Delete the authenticated user's account and cascade-remove all owned data."""
    owned_items_res = db.table("items").select("id").eq("owner_id", user_id).execute()
    owned_item_ids = [row["id"] for row in (owned_items_res.data or []) if row.get("id")]

    owned_folders_res = db.table("folders").select("id").eq("owner_id", user_id).execute()
    owned_folder_ids = [row["id"] for row in (owned_folders_res.data or []) if row.get("id")]

    db.table("reminders").delete().eq("user_id", user_id).execute()
    if owned_item_ids:
        db.table("reminders").delete().in_("item_id", owned_item_ids).execute()
        db.table("item_tags").delete().in_("item_id", owned_item_ids).execute()

    db.table("items").delete().eq("owner_id", user_id).execute()
    db.table("tags").delete().eq("owner_id", user_id).execute()

    db.table("folder_invites").delete().eq("created_by", user_id).execute()
    db.table("folder_members").delete().eq("user_id", user_id).execute()
    if owned_folder_ids:
        db.table("folder_invites").delete().in_("folder_id", owned_folder_ids).execute()
        db.table("folder_members").delete().in_("folder_id", owned_folder_ids).execute()

    db.table("folders").delete().eq("owner_id", user_id).execute()
    db.table("devices").delete().eq("user_id", user_id).execute()
    db.table("daily_ai_usage").delete().eq("user_id", user_id).execute()
    db.table("api_tokens").delete().eq("user_id", user_id).execute()
    try:
        db.table("beta_feedback").delete().eq("user_id", user_id).execute()
    except Exception as exc:
        logger.debug("Optional beta_feedback cleanup skipped during account deletion: %s", exc)
    db.table("profiles").delete().eq("id", user_id).execute()

    auth_admin = getattr(getattr(db, "auth", None), "admin", None)
    if auth_admin is not None and callable(getattr(auth_admin, "delete_user", None)):
        auth_admin.delete_user(user_id)

    return {"deleted": True, "user_id": user_id}
