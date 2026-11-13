"""Pydantic schemas for Login and Authentication module.

Covers:
- Email/Password Register & Login
- Passwordless / Magic Link Authentication
- Native Google / Apple SDK Sign-In (Spec 2B: id_token exchange)
- Web OAuth Callback
- Session Refresh & User Profile
- MCP Personal Access Tokens (jsi_live_xxx)
"""

from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    """User registration request."""
    email: EmailStr
    password: str = Field(..., min_length=8, description="Password (at least 8 characters)")
    display_name: Optional[str] = Field(None, max_length=80, description="Display name / nickname")


class LoginRequest(BaseModel):
    """User login request with email and password."""
    email: EmailStr
    password: str = Field(..., description="User password")


class MagicLinkRequest(BaseModel):
    """Magic link login request."""
    email: EmailStr


class NativeAuthRequest(BaseModel):
    """Native Google or Sign in with Apple (Face ID / Touch ID) token exchange."""
    provider: Literal["google", "apple"]
    id_token: str = Field(..., description="JWT ID token from Google Sign-In SDK or Apple Authentication")
    raw_nonce: Optional[str] = Field(None, description="Raw nonce for Apple Sign-In verification")
    full_name: Optional[str] = Field(None, description="Name provided during initial Apple sign-in")


class OAuthCallbackRequest(BaseModel):
    """OAuth callback authorization code."""
    code: str = Field(..., description="Authorization code from OAuth provider redirect")


class RefreshTokenRequest(BaseModel):
    """Session renewal request."""
    refresh_token: str = Field(..., description="Valid refresh token")


class UserProfileResponse(BaseModel):
    """Public user profile data."""
    id: str
    email: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    tier: str = "free"
    locale: str = "th"
    timezone: str = "Asia/Bangkok"
    created_at: Optional[str] = None


class AuthTokenResponse(BaseModel):
    """Authentication token and session response."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = 3600
    user: UserProfileResponse


class MagicLinkResponse(BaseModel):
    """Magic link generation response."""
    sent: bool = True
    email: str
    message: str = "Magic link generated successfully"
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    expires_in: int = 3600
    user: Optional[UserProfileResponse] = None


class UpdateProfileRequest(BaseModel):
    """User profile update request."""
    display_name: Optional[str] = Field(None, max_length=80)
    avatar_url: Optional[str] = None
    locale: Optional[str] = Field(None, max_length=10)
    timezone: Optional[str] = Field(None, max_length=50)


class CreateApiTokenRequest(BaseModel):
    """Request to generate a new MCP Personal Access Token."""
    name: str = Field(..., min_length=1, max_length=60, description="Token descriptive label (e.g., 'Claude Desktop', 'Cursor')")


class CreateApiTokenResponse(BaseModel):
    """One-time response containing full plaintext Personal Access Token."""
    id: str
    name: str
    token: str = Field(..., description="Plaintext token: jsi_live_... (Shown only once upon creation)")
    token_prefix: str
    created_at: str


class ApiTokenSummary(BaseModel):
    """Summary of active or revoked MCP API token."""
    id: str
    name: str
    token_prefix: str
    last_used_at: Optional[str] = None
    created_at: str
    is_active: bool = True
