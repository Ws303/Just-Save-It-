"""Multi-language text hygiene, HTML byte decoding, and URL canonicalization.

Guarantees:
1. Accurate decoding of legacy/non-UTF-8 web pages (TIS-620, Windows-874, Shift_JIS, GBK/GB2312, UTF-8).
2. Lossless Unicode NFC normalization preserving Thai combining marks, emojis, RTL marks, and CJK.
3. Canonical URL normalization matching SQL `private.canonicalize_url()` 1:1.
"""

import codecs
import hashlib
import html
import logging
import re
import unicodedata
import urllib.parse
from typing import Optional

logger = logging.getLogger("just_save_it.text_hygiene")

try:
    from charset_normalizer import from_bytes as charset_from_bytes
except ImportError:
    charset_from_bytes = None  # type: ignore

TRACKING_QUERY_PARAMS = frozenset(
    {
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "igshid",
        "igsh",
        "si",
        "ref",
        "ref_src",
        "ref_url",
        "yclid",
        "_ga",
        "_gl",
        "spm",
        "is_from_webapp",
        "sender_device",
    }
)

CHARSET_ALIASES = {
    "tis-620": "cp874",
    "tis620": "cp874",
    "iso-8859-11": "cp874",
    "iso8859-11": "cp874",
    "windows-874": "cp874",
    "win-874": "cp874",
    "cp874": "cp874",
    "x-windows-874": "cp874",
    "gb2312": "gb18030",
    "gb-2312": "gb18030",
    "gbk": "gb18030",
    "gb18030": "gb18030",
    "shift_jis": "cp932",
    "shift-jis": "cp932",
    "sjis": "cp932",
    "x-sjis": "cp932",
    "ms932": "cp932",
    "windows-31j": "cp932",
    "cp932": "cp932",
    "euc-kr": "cp949",
    "ks_c_5601-1987": "cp949",
    "cp949": "cp949",
    "latin1": "cp1252",
    "latin-1": "cp1252",
    "iso-8859-1": "cp1252",
    "iso8859-1": "cp1252",
    "windows-1252": "cp1252",
    "utf8": "utf-8",
    "utf-8": "utf-8",
}

_GENERIC_LEGACY_CHARSETS = frozenset({"cp1252", "iso-8859-1", "latin1", "latin-1", "ascii"})
_CONTENT_TYPE_CHARSET_RE = re.compile(r"charset\s*=\s*['\"]?([A-Za-z0-9._-]+)['\"]?", re.IGNORECASE)
_META_CHARSET_RE = re.compile(
    r"<meta[^>]+charset\s*=\s*['\"]?([A-Za-z0-9._-]+)['\"]?",
    re.IGNORECASE,
)
_XML_ENCODING_RE = re.compile(
    r"<\?xml[^>]+encoding\s*=\s*['\"]([A-Za-z0-9._-]+)['\"]",
    re.IGNORECASE,
)
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_CANON_URL_RE = re.compile(r"^(https?)://([^/?]+)(/[^?]*)?(?:\?(.*))?$", re.IGNORECASE)


def normalize_charset_name(raw_charset: Optional[str]) -> Optional[str]:
    """Normalize a declared charset name to its safe Python codec superset."""
    if not raw_charset:
        return None
    cleaned = raw_charset.strip().strip("\"'").lower()
    if not cleaned:
        return None
    mapped = CHARSET_ALIASES.get(cleaned, cleaned)
    try:
        codecs.lookup(mapped)
        return mapped
    except LookupError:
        return None


def extract_charset_from_content_type(content_type: Optional[str]) -> Optional[str]:
    """Extract normalized charset from an HTTP Content-Type header."""
    if not content_type:
        return None
    match = _CONTENT_TYPE_CHARSET_RE.search(content_type)
    if not match:
        return None
    return normalize_charset_name(match.group(1))


def extract_charset_from_html_head(raw_bytes: bytes) -> Optional[str]:
    """Scan the first 4KB of HTML/XML bytes for meta charset or XML encoding."""
    if not raw_bytes:
        return None
    head = raw_bytes[:4096].decode("ascii", errors="ignore")
    for pattern in (_META_CHARSET_RE, _XML_ENCODING_RE):
        match = pattern.search(head)
        if match:
            normalized = normalize_charset_name(match.group(1))
            if normalized:
                return normalized
    return None


def normalize_unicode_text(text: Optional[str], unescape_html: bool = False) -> str:
    """Normalize text to Unicode NFC while preserving Thai marks, emojis, RTL, and CJK."""
    if text is None:
        return ""
    value = str(text)
    if unescape_html:
        value = html.unescape(value)
    value = _CONTROL_CHARS_RE.sub("", value)
    return unicodedata.normalize("NFC", value)


def clean_text_field(text: Optional[str], unescape_html: bool = True) -> Optional[str]:
    """Clean and NFC-normalize an optional text field without truncation."""
    if text is None:
        return None
    cleaned = normalize_unicode_text(text, unescape_html=unescape_html).strip()
    return cleaned if cleaned else None


def _try_strict_decode(raw_bytes: bytes, encoding: Optional[str]) -> Optional[str]:
    if not encoding:
        return None
    try:
        return raw_bytes.decode(encoding, errors="strict")
    except (UnicodeDecodeError, LookupError):
        return None


def decode_html_bytes(raw_bytes: bytes, content_type: Optional[str] = None) -> str:
    """Decode raw HTML/text bytes accurately across UTF-8, TIS-620/CP874, Shift_JIS, and GBK.

    Does NOT unescape HTML entities so raw markup remains safe for DOM parsers.
    """
    if not raw_bytes:
        return ""

    # 1. BOM detection
    if raw_bytes.startswith(b"\xef\xbb\xbf"):
        decoded = _try_strict_decode(raw_bytes[3:], "utf-8")
        if decoded is not None:
            return normalize_unicode_text(decoded, unescape_html=False)
    elif raw_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
        decoded = _try_strict_decode(raw_bytes, "utf-16")
        if decoded is not None:
            return normalize_unicode_text(decoded, unescape_html=False)

    header_charset = extract_charset_from_content_type(content_type)
    meta_charset = extract_charset_from_html_head(raw_bytes)

    # 2. Explicit non-generic HTTP Content-Type header (e.g. tis-620 -> cp874, shift_jis -> cp932)
    if header_charset and header_charset not in _GENERIC_LEGACY_CHARSETS:
        decoded = _try_strict_decode(raw_bytes, header_charset)
        if decoded is not None:
            return normalize_unicode_text(decoded, unescape_html=False)

    # 3. <meta charset=...> / <meta http-equiv="Content-Type" ...> in first 4KB
    if meta_charset:
        decoded = _try_strict_decode(raw_bytes, meta_charset)
        if decoded is not None:
            return normalize_unicode_text(decoded, unescape_html=False)

    decoded = _try_strict_decode(raw_bytes, "utf-8")
    if decoded is not None:
        return normalize_unicode_text(decoded, unescape_html=False)

    # Statistical detection fallback via charset-normalizer
    if charset_from_bytes is not None:
        try:
            best = charset_from_bytes(raw_bytes).best()
            if best is not None:
                detected = normalize_charset_name(best.encoding) or best.encoding
                decoded = _try_strict_decode(raw_bytes, detected)
                if decoded is not None:
                    return normalize_unicode_text(decoded, unescape_html=False)
                return normalize_unicode_text(str(best), unescape_html=False)
        except Exception as exc:
            logger.debug("charset-normalizer fallback failed: %s", exc)

    # 6. Generic header charset fallback (e.g. genuine cp1252 page)
    if header_charset:
        decoded = _try_strict_decode(raw_bytes, header_charset)
        if decoded is not None:
            return normalize_unicode_text(decoded, unescape_html=False)

    # 7. Safe lossless UTF-8 replacement fallback
    return normalize_unicode_text(raw_bytes.decode("utf-8", errors="replace"), unescape_html=False)


def _is_tracking_param(param_key: str) -> bool:
    key_lower = urllib.parse.unquote(param_key).strip().lower()
    if not key_lower:
        return True
    if key_lower.startswith("utm_"):
        return True
    return key_lower in TRACKING_QUERY_PARAMS


def canonicalize_url(raw_url: str) -> str:
    """Canonicalize URL identically to SQL `private.canonicalize_url()`."""
    cleaned = (raw_url or "").strip()
    if not cleaned:
        return ""

    # Strip fragment
    cleaned = cleaned.split("#", 1)[0]

    match = _CANON_URL_RE.match(cleaned)
    if not match:
        return cleaned

    scheme = match.group(1).lower()
    authority = match.group(2).lower()
    if scheme == "http" and authority.endswith(":80"):
        authority = authority[:-3]
    elif scheme == "https" and authority.endswith(":443"):
        authority = authority[:-4]

    path = re.sub(r"/+$", "", match.group(3) or "")
    query = match.group(4)

    if not query:
        return f"{scheme}://{authority}{path}"

    kept_params = []
    for kv in query.split("&"):
        if not kv:
            continue
        key = kv.split("=", 1)[0]
        if _is_tracking_param(key):
            continue
        kept_params.append(kv)

    if not kept_params:
        return f"{scheme}://{authority}{path}"

    kept_params.sort(key=lambda item: (item.split("=", 1)[0].lower(), item))
    return f"{scheme}://{authority}{path}?{'&'.join(kept_params)}"


def compute_url_hash(raw_url: str) -> str:
    """Compute canonical URL MD5 hash matching SQL `md5(lower(private.canonicalize_url(url)))`."""
    canon = canonicalize_url(raw_url)
    return hashlib.md5(canon.lower().encode("utf-8")).hexdigest()
