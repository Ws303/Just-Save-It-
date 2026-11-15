"""Authentication and User Profile Service.

Handles:
- User Registration with Email and Password
- User Login (Email/Password, Magic Link, Native Google/Apple id_token)
- Web OAuth URL generation & code exchange
- Session Refresh & Logout
- User Profile management (GET/PATCH)
- MCP Personal Access Tokens (jsi_live_xxx) with SHA-256 hashing
"""

import hashlib
import hmac
import logging
import os
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import jwt
from fastapi import HTTPException, status

from Database.client import get_supabase_client
from Database.supabase_client import (
    get_supabase_anon_client,
    get_supabase_service_client,
    is_supabase_configured,
)
from .auth_dep import get_configured_hs256_secret
from .schemas import (
    ApiTokenSummary,
    AuthTokenResponse,
    CreateApiTokenResponse,
    LoginRequest,
    MagicLinkRequest,
    MagicLinkResponse,
    NativeAuthRequest,
    RegisterRequest,
    UpdateProfileRequest,
    UserProfileResponse,
)

logger = logging.getLogger("just_save_it.login.service")

# Default secret for local JWT signing if SUPABASE_JWT_SECRET is not configured
DEFAULT_LOCAL_JWT_SECRET = "just-save-it-development-jwt-secret-key-32chars"


class AuthService:
    """Service handling all authentication, profile, and API token workflows."""

    def __init__(self):
        # In-memory store for local testing/dev when Supabase is not connected
        self._local_users: Dict[str, Dict[str, Any]] = {}
        self._local_tokens: Dict[str, List[Dict[str, Any]]] = {}

        # Prepopulate demo user (May) matching frontend seed
        demo_user_id = "11111111-1111-4111-8111-111111111111"
        self._local_users["may@example.com"] = {
            "id": demo_user_id,
            "email": "may@example.com",
            "password_hash": self._hash_password("password123"),
            "display_name": "เมย์",
            "avatar_url": None,
            "tier": "free",
            "locale": "th",
            "timezone": "Asia/Bangkok",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

    def _get_jwt_secret(self) -> str:
        return get_configured_hs256_secret() or DEFAULT_LOCAL_JWT_SECRET

    def _get_local_dev_client(self) -> Optional[Any]:
        try:
            client = get_supabase_client()
            if getattr(client, "is_local_dev", False):
                return client
        except Exception:
            pass
        return None

    def _find_local_user(self, email: str) -> Optional[Dict[str, Any]]:
        clean = email.lower().strip()
        local_db = self._get_local_dev_client()
        if local_db is not None:
            found = local_db.get_local_user_by_email(clean)
            if found:
                return found
        return self._local_users.get(clean)

    def _find_local_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        local_db = self._get_local_dev_client()
        if local_db is not None:
            found = local_db.get_local_user_by_id(user_id)
            if found:
                return found
        for user in self._local_users.values():
            if user.get("id") == user_id:
                return user
        return None

    def _save_local_user(self, user_record: Dict[str, Any]) -> Dict[str, Any]:
        clean = str(user_record["email"]).lower().strip()
        self._local_users[clean] = user_record
        local_db = self._get_local_dev_client()
        if local_db is not None:
            return local_db.upsert_local_user(user_record)
        return user_record

    def _hash_password(self, password: str) -> str:
        salt = "jsi_salt_987"
        return hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()

    def _generate_jwt_token(self, user_id: str, email: str, display_name: Optional[str] = None, tier: str = "free") -> str:
        secret = self._get_jwt_secret()
        now = int(time.time())
        payload = {
            "sub": user_id,
            "aud": "authenticated",
            "email": email,
            "iat": now,
            "exp": now + 86400,  # 24 hours
            "user_metadata": {
                "display_name": display_name,
                "tier": tier,
            },
        }
        return jwt.encode(payload, secret, algorithm="HS256")

    def _generate_refresh_token(self) -> str:
        return "jsi_ref_" + secrets.token_urlsafe(32)

    def _validate_redirect_url(self, redirect_to: str) -> str:
        """Ensure OAuth redirect_to is http(s) without userinfo and points to an allowed host."""
        cleaned = (redirect_to or "").strip()
        try:
            parsed = urlparse(cleaned)
        except Exception as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid redirect_to URL.") from e

        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsafe redirect_to URL scheme or format.")

        allowed_hosts = {"localhost", "127.0.0.1"}
        raw_app_url = os.getenv("APP_URL", "").strip()
        if raw_app_url:
            for item in raw_app_url.split(","):
                candidate = item.strip()
                if not candidate:
                    continue
                parsed_app = urlparse(candidate if "://" in candidate else f"https://{candidate}")
                if parsed_app.hostname:
                    allowed_hosts.add(parsed_app.hostname.lower())
        raw_cors = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
        if raw_cors and raw_cors != "*":
            for origin in raw_cors.split(","):
                candidate = origin.strip()
                if not candidate:
                    continue
                cors_host = urlparse(candidate if "://" in candidate else f"https://{candidate}").hostname
                if cors_host:
                    allowed_hosts.add(cors_host.lower())

        if parsed.hostname.lower() not in allowed_hosts:
            logger.warning(
                "Rejected OAuth redirect_to host '%s'; allowed hosts=%s (configure APP_URL or CORS_ALLOW_ORIGINS).",
                parsed.hostname.lower(),
                sorted(allowed_hosts),
            )
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Disallowed redirect_to host.")

        return cleaned

    async def register_user(self, req: RegisterRequest) -> AuthTokenResponse:
        """Register a new user with email and password."""
        email_clean = req.email.lower().strip()
        display_name = (req.display_name or "").strip() or email_clean.split("@")[0]

        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                resp = client.auth.sign_up({
                    "email": email_clean,
                    "password": req.password,
                    "options": {
                        "data": {
                            "display_name": display_name,
                            "locale": "th",
                            "timezone": "Asia/Bangkok",
                        }
                    },
                })
                if resp.user and resp.session:
                    user_profile = UserProfileResponse(
                        id=str(resp.user.id),
                        email=email_clean,
                        display_name=display_name,
                        tier="free",
                        locale="th",
                        timezone="Asia/Bangkok",
                    )
                    return AuthTokenResponse(
                        access_token=resp.session.access_token,
                        refresh_token=resp.session.refresh_token,
                        user=user_profile,
                    )
                if resp.user:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Registration created. Please confirm your email before signing in.",
                    )
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Unable to complete registration.",
                )
            except HTTPException:
                raise
            except Exception as e:
                logger.error("Supabase sign_up error: %s", e)
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        # Local fallback store
        if self._find_local_user(email_clean):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="User with this email already exists.",
            )

        new_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        user_record = {
            "id": new_id,
            "email": email_clean,
            "password_hash": self._hash_password(req.password),
            "display_name": display_name,
            "avatar_url": None,
            "tier": "free",
            "locale": "th",
            "timezone": "Asia/Bangkok",
            "created_at": created_at,
        }
        self._save_local_user(user_record)

        access_token = self._generate_jwt_token(new_id, email_clean, display_name)
        refresh_token = self._generate_refresh_token()
        profile = UserProfileResponse(**{k: v for k, v in user_record.items() if k != "password_hash"})

        return AuthTokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user=profile,
        )

    async def login_user(self, req: LoginRequest) -> AuthTokenResponse:
        """Login with email and password."""
        email_clean = req.email.lower().strip()

        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                resp = client.auth.sign_in_with_password({
                    "email": email_clean,
                    "password": req.password,
                })
                if resp.user and resp.session:
                    meta = resp.user.user_metadata or {}
                    profile = UserProfileResponse(
                        id=str(resp.user.id),
                        email=email_clean,
                        display_name=meta.get("display_name") or email_clean.split("@")[0],
                        avatar_url=meta.get("avatar_url"),
                        tier=meta.get("tier", "free"),
                    )
                    return AuthTokenResponse(
                        access_token=resp.session.access_token,
                        refresh_token=resp.session.refresh_token,
                        user=profile,
                    )
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")
            except HTTPException:
                raise
            except Exception as e:
                logger.warning("Supabase password login failed: %s", e)
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

        # Local fallback store
        user_record = self._find_local_user(email_clean)
        if not user_record or user_record.get("password_hash") != self._hash_password(req.password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password.",
            )

        access_token = self._generate_jwt_token(
            user_record["id"],
            email_clean,
            user_record.get("display_name"),
            user_record.get("tier", "free"),
        )
        refresh_token = self._generate_refresh_token()
        profile = UserProfileResponse(**{k: v for k, v in user_record.items() if k != "password_hash"})

        return AuthTokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user=profile,
        )

    async def request_magic_link(self, req: MagicLinkRequest) -> MagicLinkResponse:
        """Generate magic link / passwordless session."""
        email_clean = req.email.lower().strip()

        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                client.auth.sign_in_with_otp({"email": email_clean})
                return MagicLinkResponse(
                    sent=True,
                    email=email_clean,
                    message="Magic link sent to your email address.",
                )
            except Exception as e:
                logger.warning("Supabase sign_in_with_otp warning: %s", e)
                err_code = status.HTTP_429_TOO_MANY_REQUESTS if "rate" in str(e).lower() else status.HTTP_400_BAD_REQUEST
                raise HTTPException(status_code=err_code, detail="Unable to send magic link right now.")

        # For dev/test mode & simulated app:
        # Create or find existing user record and issue token directly for instant testing
        user_record = self._find_local_user(email_clean)
        if not user_record:
            user_id = str(uuid.uuid4())
            display_name = email_clean.split("@")[0]
            user_record = {
                "id": user_id,
                "email": email_clean,
                "password_hash": None,
                "display_name": display_name,
                "avatar_url": None,
                "tier": "free",
                "locale": "th",
                "timezone": "Asia/Bangkok",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            self._save_local_user(user_record)

        access_token = self._generate_jwt_token(
            user_record["id"],
            email_clean,
            user_record.get("display_name"),
            user_record.get("tier", "free"),
        )
        refresh_token = self._generate_refresh_token()
        profile = UserProfileResponse(**{k: v for k, v in user_record.items() if k != "password_hash"})

        return MagicLinkResponse(
            sent=True,
            email=email_clean,
            message="Magic link generated successfully.",
            access_token=access_token,
            refresh_token=refresh_token,
            user=profile,
        )

    async def login_with_native_id_token(self, req: NativeAuthRequest) -> AuthTokenResponse:
        """Handle Native Google Sign-In or Apple Sign-In (Face ID / Touch ID) via ID token."""
        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                auth_payload = {
                    "provider": req.provider,
                    "token": req.id_token,
                }
                if req.raw_nonce:
                    auth_payload["nonce"] = req.raw_nonce

                resp = client.auth.sign_in_with_id_token(auth_payload)
                if resp.user and resp.session:
                    meta = resp.user.user_metadata or {}
                    display_name = req.full_name or meta.get("full_name") or meta.get("display_name")
                    profile = UserProfileResponse(
                        id=str(resp.user.id),
                        email=resp.user.email or f"{req.provider}-user@example.com",
                        display_name=display_name,
                        avatar_url=meta.get("avatar_url"),
                    )
                    return AuthTokenResponse(
                        access_token=resp.session.access_token,
                        refresh_token=resp.session.refresh_token,
                        user=profile,
                    )
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid native ID token.")
            except HTTPException:
                raise
            except Exception as e:
                logger.error("Supabase native id_token auth failed: %s", e)
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(e))

        # Local / dev simulated verification
        user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{req.provider}:{req.id_token[:30]}"))
        email = f"{req.provider}.user@example.com"
        display_name = req.full_name or f"{req.provider.capitalize()} User"

        user_record = {
            "id": user_id,
            "email": email,
            "password_hash": None,
            "display_name": display_name,
            "avatar_url": None,
            "tier": "free",
            "locale": "th",
            "timezone": "Asia/Bangkok",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._save_local_user(user_record)

        access_token = self._generate_jwt_token(user_id, email, display_name)
        refresh_token = self._generate_refresh_token()
        profile = UserProfileResponse(**{k: v for k, v in user_record.items() if k != "password_hash"})

        return AuthTokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user=profile,
        )

    def get_oauth_url(self, provider: str, redirect_to: str) -> Dict[str, str]:
        """Generate OAuth authorization URL for Web/Extension."""
        provider_clean = provider.lower().strip()
        if provider_clean not in ("google", "apple"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported OAuth provider: {provider}",
            )

        safe_redirect = self._validate_redirect_url(redirect_to)

        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                resp = client.auth.sign_in_with_oauth({
                    "provider": provider_clean,
                    "options": {"redirect_to": safe_redirect},
                })
                if resp and hasattr(resp, "url") and resp.url:
                    return {"url": resp.url, "provider": provider_clean}
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Unable to generate OAuth sign-in URL.",
                )
            except HTTPException:
                raise
            except Exception as e:
                logger.warning("Supabase sign_in_with_oauth error: %s", e)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Unable to generate OAuth sign-in URL.",
                )

        # Local / dev fallback URL
        sep = "&" if "?" in safe_redirect else "?"
        dummy_url = f"{safe_redirect}{sep}code=jsi_oauth_dev_code_{provider_clean}"
        return {"url": dummy_url, "provider": provider_clean}

    async def exchange_oauth_code(self, code: str) -> AuthTokenResponse:
        """Exchange OAuth authorization code for session."""
        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                resp = client.auth.exchange_code_for_session({"auth_code": code})
                if resp.user and resp.session:
                    meta = resp.user.user_metadata or {}
                    profile = UserProfileResponse(
                        id=str(resp.user.id),
                        email=resp.user.email or "oauth@example.com",
                        display_name=meta.get("full_name") or meta.get("display_name"),
                        avatar_url=meta.get("avatar_url"),
                    )
                    return AuthTokenResponse(
                        access_token=resp.session.access_token,
                        refresh_token=resp.session.refresh_token,
                        user=profile,
                    )
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth authorization code.")
            except HTTPException:
                raise
            except Exception as e:
                logger.error("Supabase exchange_code_for_session error: %s", e)
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        # Local fallback
        user_id = str(uuid.uuid4())
        email = "google.user@example.com"
        display_name = "Google User"
        access_token = self._generate_jwt_token(user_id, email, display_name)
        refresh_token = self._generate_refresh_token()
        profile = UserProfileResponse(
            id=user_id,
            email=email,
            display_name=display_name,
        )
        return AuthTokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user=profile,
        )

    async def refresh_session(self, refresh_token: str) -> AuthTokenResponse:
        """Renew session with refresh token."""
        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                resp = client.auth.refresh_session(refresh_token)
                if resp.user and resp.session:
                    meta = resp.user.user_metadata or {}
                    profile = UserProfileResponse(
                        id=str(resp.user.id),
                        email=resp.user.email or "user@example.com",
                        display_name=meta.get("display_name"),
                    )
                    return AuthTokenResponse(
                        access_token=resp.session.access_token,
                        refresh_token=resp.session.refresh_token,
                        user=profile,
                    )
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")
            except HTTPException:
                raise
            except Exception as e:
                logger.warning("Supabase refresh_session failed: %s", e)
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")

        # Local fallback renewal
        demo_user = self._find_local_user("may@example.com")
        user_id = demo_user["id"] if demo_user else str(uuid.uuid4())
        email = demo_user["email"] if demo_user else "user@example.com"
        name = demo_user.get("display_name") if demo_user else "User"

        new_access = self._generate_jwt_token(user_id, email, name)
        new_refresh = self._generate_refresh_token()
        profile = UserProfileResponse(
            id=user_id,
            email=email,
            display_name=name,
        )
        return AuthTokenResponse(
            access_token=new_access,
            refresh_token=new_refresh,
            user=profile,
        )

    async def logout_user(self, access_token: str) -> Dict[str, bool]:
        """Sign out user and invalidate session."""
        if is_supabase_configured():
            try:
                client = get_supabase_anon_client()
                client.auth.sign_out()
            except Exception as e:
                logger.debug("Supabase sign_out error: %s", e)
        return {"logged_out": True}

    async def get_profile(self, user_id: str) -> UserProfileResponse:
        """Fetch user profile by user_id."""
        if is_supabase_configured():
            try:
                service_client = get_supabase_service_client()
                resp = service_client.table("profiles").select("*").eq("id", user_id).execute()
                if resp.data and len(resp.data) > 0:
                    row = resp.data[0]
                    # Fetch user email from auth admin if needed
                    email = row.get("email") or "user@example.com"
                    return UserProfileResponse(
                        id=row["id"],
                        email=email,
                        display_name=row.get("display_name"),
                        avatar_url=row.get("avatar_url"),
                        tier=row.get("tier", "free"),
                        locale=row.get("locale", "th"),
                        timezone=row.get("timezone", "Asia/Bangkok"),
                        created_at=row.get("created_at"),
                    )
            except Exception as e:
                logger.warning("Supabase fetch profile error: %s", e)

        # Search local users
        local_user = self._find_local_user_by_id(user_id)
        if local_user:
            return UserProfileResponse(**{k: v for k, v in local_user.items() if k != "password_hash"})

        return UserProfileResponse(
            id=user_id,
            email=f"user-{user_id[:8]}@example.com",
            display_name="Just-Save-It User",
        )

    async def update_profile(self, user_id: str, req: UpdateProfileRequest) -> UserProfileResponse:
        """Update user profile."""
        updates: Dict[str, Any] = {}
        if req.display_name is not None:
            updates["display_name"] = req.display_name
        if req.avatar_url is not None:
            updates["avatar_url"] = req.avatar_url
        if req.locale is not None:
            updates["locale"] = req.locale
        if req.timezone is not None:
            updates["timezone"] = req.timezone

        if is_supabase_configured():
            try:
                service_client = get_supabase_service_client()
                resp = service_client.table("profiles").update(updates).eq("id", user_id).execute()
                if resp.data and len(resp.data) > 0:
                    row = resp.data[0]
                    return UserProfileResponse(
                        id=row["id"],
                        email=row.get("email", "user@example.com"),
                        display_name=row.get("display_name"),
                        avatar_url=row.get("avatar_url"),
                        tier=row.get("tier", "free"),
                        locale=row.get("locale", "th"),
                        timezone=row.get("timezone", "Asia/Bangkok"),
                    )
            except Exception as e:
                logger.error("Supabase update profile error: %s", e)

        # Update in local store
        local_user = self._find_local_user_by_id(user_id)
        if local_user:
            local_user.update(updates)
            saved = self._save_local_user(local_user)
            return UserProfileResponse(**{k: v for k, v in saved.items() if k != "password_hash"})

        return UserProfileResponse(
            id=user_id,
            email=f"user-{user_id[:8]}@example.com",
            display_name=req.display_name or "Just-Save-It User",
        )

    async def create_api_token(self, user_id: str, name: str) -> CreateApiTokenResponse:
        """Generate MCP Personal Access Token (jsi_live_xxx) with SHA-256 hash."""
        raw_secret = secrets.token_urlsafe(24)
        plaintext_token = f"jsi_live_{raw_secret}"
        token_prefix = f"jsi_live_{raw_secret[:6]}..."
        token_hash = hashlib.sha256(plaintext_token.encode("utf-8")).hexdigest()
        token_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat()

        if is_supabase_configured():
            try:
                service_client = get_supabase_service_client()
                service_client.table("api_tokens").insert({
                    "id": token_id,
                    "user_id": user_id,
                    "name": name,
                    "token_prefix": token_prefix,
                    "token_hash": token_hash,
                    "created_at": created_at,
                }).execute()
            except Exception as e:
                logger.error("Supabase insert api_token error: %s", e)

        # Also store in LocalDevDB or in-memory fallback
        token_record = {
            "id": token_id,
            "user_id": user_id,
            "name": name,
            "token_prefix": token_prefix,
            "token_hash": token_hash,
            "last_used_at": None,
            "revoked_at": None,
            "created_at": created_at,
        }
        local_db = self._get_local_dev_client()
        if local_db is not None and not is_supabase_configured():
            local_db.table("api_tokens").insert(token_record).execute()
        else:
            self._local_tokens.setdefault(user_id, []).append(token_record)

        return CreateApiTokenResponse(
            id=token_id,
            name=name,
            token=plaintext_token,
            token_prefix=token_prefix,
            created_at=created_at,
        )

    async def list_api_tokens(self, user_id: str) -> List[ApiTokenSummary]:
        """List active MCP API tokens for user."""
        if is_supabase_configured():
            try:
                service_client = get_supabase_service_client()
                resp = service_client.table("api_tokens").select("*").eq("user_id", user_id).is_("revoked_at", "null").order("created_at", desc=True).execute()
                if resp.data:
                    return [
                        ApiTokenSummary(
                            id=row["id"],
                            name=row["name"],
                            token_prefix=row["token_prefix"],
                            last_used_at=row.get("last_used_at"),
                            created_at=row["created_at"],
                            is_active=True,
                        )
                        for row in resp.data
                    ]
            except Exception as e:
                logger.warning("Supabase list api_tokens error: %s", e)

        # Local tokens (LocalDevDB or in-memory)
        local_db = self._get_local_dev_client()
        if local_db is not None:
            resp = (
                local_db.table("api_tokens")
                .select("*")
                .eq("user_id", user_id)
                .is_("revoked_at", "null")
                .order("created_at", desc=True)
                .execute()
            )
            tokens = resp.data or []
        else:
            tokens = self._local_tokens.get(user_id, [])

        return [
            ApiTokenSummary(
                id=t["id"],
                name=t["name"],
                token_prefix=t["token_prefix"],
                last_used_at=t.get("last_used_at"),
                created_at=t["created_at"],
                is_active=(t.get("revoked_at") is None),
            )
            for t in tokens
            if t.get("revoked_at") is None
        ]

    async def revoke_api_token(self, user_id: str, token_id: str) -> Dict[str, bool]:
        """Revoke a Personal Access Token."""
        revoked_at = datetime.now(timezone.utc).isoformat()

        if is_supabase_configured():
            try:
                service_client = get_supabase_service_client()
                service_client.table("api_tokens").update({"revoked_at": revoked_at}).eq("id", token_id).eq("user_id", user_id).execute()
            except Exception as e:
                logger.warning("Supabase revoke api_token error: %s", e)

        local_db = self._get_local_dev_client()
        if local_db is not None:
            local_db.table("api_tokens").update({"revoked_at": revoked_at}).eq("id", token_id).eq("user_id", user_id).execute()
            return {"revoked": True}

        tokens = self._local_tokens.get(user_id, [])
        for t in tokens:
            if t["id"] == token_id:
                t["revoked_at"] = revoked_at
                return {"revoked": True}

        return {"revoked": True}


# Global singleton service
auth_service = AuthService()
