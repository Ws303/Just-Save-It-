"""Login and Authentication module for Just-Save-It Backend."""

from .dependencies import CurrentUser, get_current_user, get_optional_current_user
from .router import router
from .schemas import (
    ApiTokenSummary,
    AuthTokenResponse,
    CreateApiTokenRequest,
    CreateApiTokenResponse,
    LoginRequest,
    MagicLinkRequest,
    MagicLinkResponse,
    NativeAuthRequest,
    OAuthCallbackRequest,
    RefreshTokenRequest,
    RegisterRequest,
    UpdateProfileRequest,
    UserProfileResponse,
)
from .service import auth_service

__all__ = [
    "router",
    "CurrentUser",
    "get_current_user",
    "get_optional_current_user",
    "auth_service",
    "RegisterRequest",
    "LoginRequest",
    "MagicLinkRequest",
    "MagicLinkResponse",
    "NativeAuthRequest",
    "OAuthCallbackRequest",
    "RefreshTokenRequest",
    "UserProfileResponse",
    "AuthTokenResponse",
    "UpdateProfileRequest",
    "CreateApiTokenRequest",
    "CreateApiTokenResponse",
    "ApiTokenSummary",
]
