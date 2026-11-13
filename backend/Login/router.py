"""FastAPI Router for Authentication, OAuth, and API Tokens.

All endpoints under prefix `/api/auth`.
"""

from typing import List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from .dependencies import CurrentUser, get_current_user
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

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


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
    description="Exchange native id_token from Google Sign-In SDK or Apple Authentication for a Supabase session.",
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


@router.get(
    "/me",
    response_model=UserProfileResponse,
    summary="Get current user profile",
)
async def get_me_endpoint(
    current_user: CurrentUser = Depends(get_current_user),
) -> UserProfileResponse:
    """Fetch profile of currently authenticated user."""
    return await auth_service.get_profile(current_user.id)


@router.patch(
    "/me",
    response_model=UserProfileResponse,
    summary="Update current user profile",
)
async def update_me_endpoint(
    req: UpdateProfileRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> UserProfileResponse:
    """Update profile data for current user."""
    return await auth_service.update_profile(current_user.id, req)


@router.get(
    "/tokens",
    response_model=List[ApiTokenSummary],
    summary="List active MCP Personal Access Tokens",
)
async def list_tokens_endpoint(
    current_user: CurrentUser = Depends(get_current_user),
) -> List[ApiTokenSummary]:
    """List all active MCP Personal Access Tokens."""
    return await auth_service.list_api_tokens(current_user.id)


@router.post(
    "/tokens",
    response_model=CreateApiTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new Personal Access Token for MCP (Claude Desktop, Cursor)",
)
async def create_token_endpoint(
    req: CreateApiTokenRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> CreateApiTokenResponse:
    """Generate a new jsi_live_xxx Personal Access Token."""
    return await auth_service.create_api_token(current_user.id, req.name)


@router.delete(
    "/tokens/{token_id}",
    summary="Revoke an MCP Personal Access Token",
)
async def revoke_token_endpoint(
    token_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    """Revoke an active Personal Access Token."""
    return await auth_service.revoke_api_token(current_user.id, token_id)
