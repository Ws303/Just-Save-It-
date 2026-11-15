export interface ExtractedSharePayload {
  url: string;
  title: string;
  sourceText: string;
}

export interface ParsedOAuthCallback {
  isAuthCallback: boolean;
  accessToken: string;
  refreshToken: string;
  code: string;
  error: string;
  errorDescription: string;
}

const URL_REGEX = /https?:\/\/[^\s"'<>]+/i;

function cleanTrailingPunctuation(rawUrl: string): string {
  return rawUrl.replace(/[),.;!?\]}>]+$/g, "");
}

function parseParamsBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = block.replace(/^[?#]/, "");
  if (!clean) return out;
  for (const part of clean.split("&")) {
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : "";
    try {
      const k = decodeURIComponent(rawKey.replace(/\+/g, " "));
      const v = decodeURIComponent(rawVal.replace(/\+/g, " "));
      if (k) out[k] = v;
    } catch {
      if (rawKey) out[rawKey] = rawVal;
    }
  }
  return out;
}

export function parseOAuthCallbackUrl(rawInput: string | null | undefined): ParsedOAuthCallback {
  const empty: ParsedOAuthCallback = {
    isAuthCallback: false,
    accessToken: "",
    refreshToken: "",
    code: "",
    error: "",
    errorDescription: "",
  };
  if (!rawInput || typeof rawInput !== "string") return empty;
  const trimmed = rawInput.trim();
  if (!trimmed) return empty;

  const qIdx = trimmed.indexOf("?");
  const hIdx = trimmed.indexOf("#");
  const queryPart =
    qIdx >= 0 ? trimmed.slice(qIdx + 1, hIdx > qIdx ? hIdx : trimmed.length) : "";
  const hashPart = hIdx >= 0 ? trimmed.slice(hIdx + 1) : "";
  const qMap = parseParamsBlock(queryPart);
  const hMap = parseParamsBlock(hashPart);

  const accessToken = hMap.access_token || qMap.access_token || "";
  const refreshToken = hMap.refresh_token || qMap.refresh_token || "";
  const code = qMap.code || hMap.code || "";
  const error = hMap.error || qMap.error || "";
  const errorDescription = hMap.error_description || qMap.error_description || "";
  const looksLikeAuthRoute = /(?:sharely|justsaveit):\/\/\/*auth-callback|\/auth-callback(?:[/?#]|$)/i.test(
    trimmed,
  );
  const hasAuthParams = Boolean(accessToken || code || error || errorDescription);

  if (!looksLikeAuthRoute && !hasAuthParams) {
    return empty;
  }

  return {
    isAuthCallback: true,
    accessToken,
    refreshToken,
    code,
    error,
    errorDescription,
  };
}

function parseQueryParam(query: string, key: string): string {
  const map = parseParamsBlock(query);
  return map[key] || "";
}

export function extractSharedUrlFromIntent(rawInput: string | null | undefined): ExtractedSharePayload | null {
  if (!rawInput || typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  if (/(?:sharely|justsaveit):\/\/\/*auth-callback|\/auth-callback(?:[/?#]|$)/i.test(trimmed)) {
    return null;
  }

  // 1. Handle custom scheme or web share_target URLs first, e.g.:
  // sharely://share?url=https%3A%2F%2Fexample.com&title=Test
  // justsaveit://share?text=Check+https%3A%2F%2Fexample.com
  const qIdx = trimmed.indexOf("?");
  if (
    qIdx >= 0 &&
    (/^(?:sharely|justsaveit):\/\//i.test(trimmed) || trimmed.includes("share_target=1"))
  ) {
    const query = trimmed.slice(qIdx + 1);
    const paramUrl = cleanTrailingPunctuation(parseQueryParam(query, "url").trim());
    const paramTitle = parseQueryParam(query, "title").trim();
    const paramText = parseQueryParam(query, "text").trim();

    if (/^https?:\/\//i.test(paramUrl)) {
      return {
        url: paramUrl,
        title: paramTitle,
        sourceText: trimmed,
      };
    }

    if (paramText) {
      const matchInText = paramText.match(URL_REGEX);
      if (matchInText) {
        const extractedUrl = cleanTrailingPunctuation(matchInText[0]);
        const remainderTitle = paramTitle || paramText.replace(matchInText[0], "").trim();
        return {
          url: extractedUrl,
          title: remainderTitle,
          sourceText: trimmed,
        };
      }
    }
  }

  // 2. Fallback: raw shared text containing an https?:// URL (Android ACTION_SEND)
  const match = trimmed.match(URL_REGEX);
  if (!match) return null;
  const url = cleanTrailingPunctuation(match[0]);
  if (!/^https?:\/\/[^/]+/i.test(url)) return null;

  const titleCandidate = trimmed
    .replace(match[0], "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    url,
    title: titleCandidate,
    sourceText: trimmed,
  };
}

export function extractInviteTokenFromUrl(rawInput: string | null | undefined): string | null {
  if (!rawInput || typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim();
  const match = trimmed.match(/(?:sharely:\/\/invite\/|\/invite\/|\?invite=)([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}
