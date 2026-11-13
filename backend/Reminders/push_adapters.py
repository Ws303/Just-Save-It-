"""Lightweight remote push adapters (Expo, FCM HTTP v1, Web Push VAPID RFC 8291) without heavy SDKs."""

from __future__ import annotations

import base64
import json
import logging
import os
import struct
import threading
import time as pytime
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

import httpx
import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from Ai.content_extractor import USER_AGENT, validate_safe_url
from Unfurl.security import redact_secrets_in_text, sanitize_external_url

logger = logging.getLogger(__name__)

EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"
DEFAULT_FCM_TOKEN_URI = "https://oauth2.googleapis.com/token"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
DEFAULT_PUSH_TIMEOUT_SEC = 8.0
WEB_PUSH_RECORD_SIZE = 4096


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    cleaned = (data or "").strip()
    padding = "=" * ((4 - len(cleaned) % 4) % 4)
    return base64.urlsafe_b64decode(cleaned + padding)


@dataclass
class PushSendResult:
    """Normalized outcome of sending a remote notification to one device."""

    channel: str
    delivered: bool
    deactivate_device: bool = False
    ssrf_blocked: bool = False
    status_code: Optional[int] = None
    error: Optional[str] = None


class _OAuthTokenCache:
    """Thread-safe in-memory cache for FCM HTTP v1 OAuth2 bearer tokens."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: Dict[Tuple[str, str], Tuple[str, float]] = {}

    def get(self, client_email: str, token_uri: str, now_ts: Optional[float] = None) -> Optional[str]:
        current = pytime.time() if now_ts is None else now_ts
        with self._lock:
            entry = self._tokens.get((client_email, token_uri))
            if entry and entry[1] > current + 60.0:
                return entry[0]
            return None

    def set(self, client_email: str, token_uri: str, access_token: str, expires_in: int, now_ts: Optional[float] = None) -> None:
        current = pytime.time() if now_ts is None else now_ts
        with self._lock:
            self._tokens[(client_email, token_uri)] = (access_token, current + max(60, int(expires_in)))

    def clear(self) -> None:
        with self._lock:
            self._tokens.clear()


FCM_TOKEN_CACHE = _OAuthTokenCache()


def _redact_push_error(exc: Any) -> str:
    """Scrub secrets (VAPID, FCM JSON, Expo token, URL tokens) from push error strings."""
    text = redact_secrets_in_text(exc)
    for env_key in ("EXPO_ACCESS_TOKEN", "VAPID_PRIVATE_KEY", "FCM_SERVICE_ACCOUNT_JSON"):
        secret = os.getenv(env_key, "").strip()
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text[:240]


async def _post_outbound(
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Optional[Dict[str, Any]] = None,
    data_body: Optional[Dict[str, str]] = None,
    content_bytes: Optional[bytes] = None,
    http_client: Optional[httpx.AsyncClient] = None,
) -> httpx.Response:
    """Execute a single POST with redirects disabled so SSRF-validated endpoints cannot pivot."""
    req_kwargs: Dict[str, Any] = {"headers": headers, "follow_redirects": False}
    if json_body is not None:
        req_kwargs["json"] = json_body
    elif data_body is not None:
        req_kwargs["data"] = data_body
    elif content_bytes is not None:
        req_kwargs["content"] = content_bytes

    if http_client is not None:
        return await http_client.post(url, **req_kwargs)

    async with httpx.AsyncClient(timeout=DEFAULT_PUSH_TIMEOUT_SEC, follow_redirects=False) as client:
        return await client.post(url, **req_kwargs)


def validate_web_push_endpoint(endpoint: str) -> str:
    """Validate that a Web Push subscription endpoint is safe HTTPS and non-private (SSRF guard)."""
    cleaned = sanitize_external_url(endpoint)
    if not cleaned:
        raise ValueError("Invalid or disallowed Web Push endpoint URL.")
    parsed = urlparse(cleaned)
    if parsed.scheme.lower() != "https":
        raise ValueError("Web Push endpoint must use https scheme.")
    return validate_safe_url(cleaned)


def _load_vapid_keys() -> Tuple[ec.EllipticCurvePrivateKey, str, str]:
    """Load VAPID EC P-256 private key (PEM or raw base64url), uncompressed pub b64url, and sub."""
    raw_priv = os.getenv("VAPID_PRIVATE_KEY", "").strip().replace("\\n", "\n")
    if not raw_priv:
        raise RuntimeError("VAPID_PRIVATE_KEY is not configured.")

    if raw_priv.startswith("-----BEGIN"):
        loaded = serialization.load_pem_private_key(raw_priv.encode("utf-8"), password=None)
        if not isinstance(loaded, ec.EllipticCurvePrivateKey):
            raise ValueError("VAPID_PRIVATE_KEY PEM must be an EC private key.")
        priv_key = loaded
    else:
        priv_bytes = _b64url_decode(raw_priv)
        if len(priv_bytes) != 32:
            raise ValueError("Raw base64url VAPID_PRIVATE_KEY must decode to 32 bytes.")
        priv_key = ec.derive_private_key(int.from_bytes(priv_bytes, "big"), ec.SECP256R1())

    derived_pub = priv_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_env = os.getenv("VAPID_PUBLIC_KEY", "").strip()
    pub_b64url = _b64url_encode(_b64url_decode(pub_env)) if pub_env else _b64url_encode(derived_pub)
    subject = os.getenv("VAPID_SUBJECT", "mailto:support@justsaveit.app").strip() or "mailto:support@justsaveit.app"
    return priv_key, pub_b64url, subject


def build_vapid_authorization(endpoint: str, now_ts: Optional[int] = None) -> Dict[str, str]:
    """Build RFC 8292 VAPID Authorization header using PyJWT ES256 and cryptography."""
    parsed = urlparse(endpoint)
    audience = f"{parsed.scheme}://{parsed.netloc}"
    priv_key, pub_b64url, subject = _load_vapid_keys()
    issued_at = int(pytime.time()) if now_ts is None else int(now_ts)
    claims = {
        "aud": audience,
        "exp": issued_at + 12 * 3600,
        "sub": subject,
    }
    token = jwt.encode(claims, priv_key, algorithm="ES256", headers={"typ": "JWT", "alg": "ES256"})
    return {"Authorization": f"vapid t={token}, k={pub_b64url}"}


def encrypt_web_push_payload(
    plaintext: bytes,
    subscription: Dict[str, Any],
    *,
    salt: Optional[bytes] = None,
    as_private_key: Optional[ec.EllipticCurvePrivateKey] = None,
) -> bytes:
    """Encrypt Web Push payload per RFC 8291 + RFC 8188 (aes128gcm content encoding)."""
    keys = subscription.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("Web Push subscription missing 'keys' object.")

    ua_pub_raw = _b64url_decode(str(keys.get("p256dh") or ""))
    auth_secret = _b64url_decode(str(keys.get("auth") or ""))
    if len(ua_pub_raw) != 65 or ua_pub_raw[0] != 0x04:
        raise ValueError("Web Push p256dh key must be an uncompressed 65-byte P-256 public key.")
    if len(auth_secret) != 16:
        raise ValueError("Web Push auth secret must decode to 16 bytes.")

    ua_pub_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub_raw)
    ephemeral_priv = as_private_key or ec.generate_private_key(ec.SECP256R1())
    as_pub_raw = ephemeral_priv.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )

    shared_secret = ephemeral_priv.exchange(ec.ECDH(), ua_pub_key)
    prk_info = b"WebPush: info\x00" + ua_pub_raw + as_pub_raw
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=auth_secret,
        info=prk_info,
    ).derive(shared_secret)

    msg_salt = salt if salt is not None else os.urandom(16)
    if len(msg_salt) != 16:
        raise ValueError("Web Push salt must be 16 bytes.")

    cek = HKDF(
        algorithm=hashes.SHA256(),
        length=16,
        salt=msg_salt,
        info=b"Content-Encoding: aes128gcm\x00",
    ).derive(ikm)
    nonce = HKDF(
        algorithm=hashes.SHA256(),
        length=12,
        salt=msg_salt,
        info=b"Content-Encoding: nonce\x00",
    ).derive(ikm)

    padded_plaintext = plaintext + b"\x02"
    ciphertext = AESGCM(cek).encrypt(nonce, padded_plaintext, None)
    header = msg_salt + struct.pack("!IB", WEB_PUSH_RECORD_SIZE, len(as_pub_raw)) + as_pub_raw
    return header + ciphertext


async def send_expo_push(
    push_token: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    *,
    http_client: Optional[httpx.AsyncClient] = None,
) -> PushSendResult:
    """Send a push notification via Expo Push HTTP API and detect DeviceNotRegistered."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    expo_token = os.getenv("EXPO_ACCESS_TOKEN", "").strip()
    if expo_token:
        headers["Authorization"] = f"Bearer {expo_token}"

    payload = {
        "to": push_token,
        "title": title,
        "body": body,
        "data": data or {},
        "sound": "default",
    }
    try:
        resp = await _post_outbound(EXPO_PUSH_ENDPOINT, headers=headers, json_body=payload, http_client=http_client)
    except Exception as exc:
        return PushSendResult(channel="expo", delivered=False, error=_redact_push_error(exc))

    if resp.status_code in (404, 410):
        return PushSendResult(
            channel="expo",
            delivered=False,
            deactivate_device=True,
            status_code=resp.status_code,
            error=f"Expo returned HTTP {resp.status_code}",
        )

    try:
        body_json = resp.json()
    except Exception:
        body_json = {}

    ticket = None
    data_field = body_json.get("data") if isinstance(body_json, dict) else None
    if isinstance(data_field, dict):
        ticket = data_field
    elif isinstance(data_field, list) and data_field and isinstance(data_field[0], dict):
        ticket = data_field[0]

    if ticket and ticket.get("status") == "error":
        details = ticket.get("details") if isinstance(ticket.get("details"), dict) else {}
        err_code = str(details.get("error") or ticket.get("message") or "expo_error")
        return PushSendResult(
            channel="expo",
            delivered=False,
            deactivate_device=(err_code == "DeviceNotRegistered"),
            status_code=resp.status_code,
            error=_redact_push_error(err_code),
        )

    if 200 <= resp.status_code < 300:
        return PushSendResult(channel="expo", delivered=True, status_code=resp.status_code)

    return PushSendResult(
        channel="expo",
        delivered=False,
        status_code=resp.status_code,
        error=f"Expo HTTP {resp.status_code}",
    )


def _load_fcm_service_account() -> Dict[str, str]:
    """Load FCM Service Account credentials from JSON string or file path."""
    raw = os.getenv("FCM_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        raise RuntimeError("FCM_SERVICE_ACCOUNT_JSON is not configured.")

    if raw.startswith("{"):
        parsed = json.loads(raw)
    elif os.path.isfile(raw):
        with open(raw, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
    else:
        raise ValueError("FCM_SERVICE_ACCOUNT_JSON must be valid JSON or an existing JSON file path.")

    project_id = os.getenv("FCM_PROJECT_ID", "").strip() or str(parsed.get("project_id") or "").strip()
    client_email = str(parsed.get("client_email") or "").strip()
    private_key = str(parsed.get("private_key") or "").strip()
    token_uri = str(parsed.get("token_uri") or DEFAULT_FCM_TOKEN_URI).strip()
    if not project_id or not client_email or not private_key:
        raise ValueError("FCM service account missing project_id, client_email, or private_key.")

    return {
        "project_id": project_id,
        "client_email": client_email,
        "private_key": private_key,
        "token_uri": token_uri,
    }


async def _get_fcm_access_token(
    sa: Dict[str, str],
    *,
    http_client: Optional[httpx.AsyncClient] = None,
) -> str:
    """Exchange a signed RS256 service-account JWT for an OAuth2 access token."""
    cached = FCM_TOKEN_CACHE.get(sa["client_email"], sa["token_uri"])
    if cached:
        return cached

    now_ts = int(pytime.time())
    assertion = jwt.encode(
        {
            "iss": sa["client_email"],
            "scope": FCM_SCOPE,
            "aud": sa["token_uri"],
            "iat": now_ts,
            "exp": now_ts + 3600,
        },
        sa["private_key"],
        algorithm="RS256",
    )
    resp = await _post_outbound(
        sa["token_uri"],
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT},
        data_body={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        http_client=http_client,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"FCM OAuth2 token exchange failed with HTTP {resp.status_code}")
    payload = resp.json()
    access_token = str(payload.get("access_token") or "").strip()
    if not access_token:
        raise RuntimeError("FCM OAuth2 response did not contain access_token.")
    expires_in = int(payload.get("expires_in") or 3600)
    FCM_TOKEN_CACHE.set(sa["client_email"], sa["token_uri"], access_token, expires_in)
    return access_token


def _is_fcm_unregistered(resp: httpx.Response) -> bool:
    if resp.status_code in (404, 410):
        return True
    try:
        err_obj = resp.json().get("error") or {}
    except Exception:
        return False
    if str(err_obj.get("status") or "").upper() == "NOT_FOUND":
        return True
    for detail in err_obj.get("details") or []:
        if isinstance(detail, dict) and str(detail.get("errorCode") or "").upper() == "UNREGISTERED":
            return True
    return "UNREGISTERED" in str(err_obj.get("message") or "").upper()


async def send_fcm_push(
    push_token: str,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    *,
    http_client: Optional[httpx.AsyncClient] = None,
) -> PushSendResult:
    """Send a push notification directly via FCM HTTP v1 using PyJWT RS256 OAuth2."""
    try:
        sa = _load_fcm_service_account()
        access_token = await _get_fcm_access_token(sa, http_client=http_client)
    except Exception as exc:
        return PushSendResult(channel="fcm", delivered=False, error=_redact_push_error(exc))

    url = f"https://fcm.googleapis.com/v1/projects/{sa['project_id']}/messages:send"
    str_data = {str(k): str(v) for k, v in (data or {}).items() if v is not None}
    payload = {
        "message": {
            "token": push_token,
            "notification": {"title": title, "body": body},
            "data": str_data,
        }
    }
    try:
        resp = await _post_outbound(
            url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            json_body=payload,
            http_client=http_client,
        )
    except Exception as exc:
        return PushSendResult(channel="fcm", delivered=False, error=_redact_push_error(exc))

    if 200 <= resp.status_code < 300:
        return PushSendResult(channel="fcm", delivered=True, status_code=resp.status_code)

    unregistered = _is_fcm_unregistered(resp)
    return PushSendResult(
        channel="fcm",
        delivered=False,
        deactivate_device=unregistered,
        status_code=resp.status_code,
        error="UNREGISTERED" if unregistered else f"FCM HTTP {resp.status_code}",
    )


async def send_web_push(
    subscription: Dict[str, Any],
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    *,
    http_client: Optional[httpx.AsyncClient] = None,
) -> PushSendResult:
    """Send an encrypted RFC 8291 + VAPID Web Push notification after SSRF endpoint verification."""
    raw_endpoint = str((subscription or {}).get("endpoint") or "").strip()
    if not raw_endpoint:
        return PushSendResult(channel="web_push", delivered=False, error="Missing Web Push endpoint.")

    try:
        safe_endpoint = validate_web_push_endpoint(raw_endpoint)
    except Exception as exc:
        return PushSendResult(
            channel="web_push",
            delivered=False,
            ssrf_blocked=True,
            error=_redact_push_error(exc),
        )

    safe_title = title[:160]
    safe_body = body[:400]
    safe_data = dict(data or {})
    payload_bytes = json.dumps({"title": safe_title, "body": safe_body, "data": safe_data}, ensure_ascii=False).encode("utf-8")
    max_web_push_plaintext = 3800
    if len(payload_bytes) > max_web_push_plaintext:
        safe_data.pop("url", None)
        safe_body = safe_body[:120]
        safe_title = safe_title[:100]
        payload_bytes = json.dumps({"title": safe_title, "body": safe_body, "data": safe_data}, ensure_ascii=False).encode("utf-8")
        while len(payload_bytes) > max_web_push_plaintext and safe_body:
            safe_body = safe_body[: len(safe_body) // 2]
            payload_bytes = json.dumps({"title": safe_title, "body": safe_body, "data": safe_data}, ensure_ascii=False).encode("utf-8")
    try:
        encrypted_body = encrypt_web_push_payload(payload_bytes, subscription)
        vapid_headers = build_vapid_authorization(safe_endpoint)
    except Exception as exc:
        return PushSendResult(channel="web_push", delivered=False, error=_redact_push_error(exc))

    headers = {
        **vapid_headers,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL": "86400",
        "Urgency": "normal",
        "User-Agent": USER_AGENT,
    }
    try:
        resp = await _post_outbound(
            safe_endpoint,
            headers=headers,
            content_bytes=encrypted_body,
            http_client=http_client,
        )
    except Exception as exc:
        return PushSendResult(channel="web_push", delivered=False, error=_redact_push_error(exc))

    if 200 <= resp.status_code < 300:
        return PushSendResult(channel="web_push", delivered=True, status_code=resp.status_code)

    stale = resp.status_code in (404, 410)
    return PushSendResult(
        channel="web_push",
        delivered=False,
        deactivate_device=stale,
        status_code=resp.status_code,
        error=f"Web Push HTTP {resp.status_code}",
    )


def _is_expo_token(push_token: str) -> bool:
    return push_token.startswith("ExponentPushToken[") or push_token.startswith("ExpoPushToken[")


async def dispatch_push_to_device(
    device: Dict[str, Any],
    *,
    title: str,
    body: str,
    data: Optional[Dict[str, Any]] = None,
    http_client: Optional[httpx.AsyncClient] = None,
) -> PushSendResult:
    """Route a remote device row to Expo, FCM HTTP v1, or Web Push VAPID safely."""
    platform = str(device.get("platform") or "").lower()
    push_token = str(device.get("push_token") or "").strip()
    web_push_sub = device.get("web_push_sub")

    if isinstance(web_push_sub, dict) and web_push_sub.get("endpoint") and platform in ("web", "extension", ""):
        return await send_web_push(web_push_sub, title, body, data=data, http_client=http_client)

    if isinstance(web_push_sub, dict) and web_push_sub.get("endpoint") and not push_token:
        return await send_web_push(web_push_sub, title, body, data=data, http_client=http_client)

    if push_token and _is_expo_token(push_token):
        return await send_expo_push(push_token, title, body, data=data, http_client=http_client)

    if push_token and platform in ("android", "ios"):
        return await send_fcm_push(push_token, title, body, data=data, http_client=http_client)

    return PushSendResult(channel="unsupported", delivered=False, error=f"No remote credential for platform '{platform}'.")
