export interface ExtractedSharePayload {
  url: string;
  title: string;
  sourceText: string;
}

const URL_REGEX = /https?:\/\/[^\s"'<>]+/i;

function cleanTrailingPunctuation(rawUrl: string): string {
  return rawUrl.replace(/[),.;!?\]}>]+$/g, "");
}

function parseQueryParam(query: string, key: string): string {
  const clean = query.startsWith("?") ? query.slice(1) : query;
  if (!clean) return "";
  for (const part of clean.split("&")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const k = decodeURIComponent(part.slice(0, eqIdx).replace(/\+/g, " "));
    if (k === key) {
      return decodeURIComponent(part.slice(eqIdx + 1).replace(/\+/g, " "));
    }
  }
  return "";
}

export function extractSharedUrlFromIntent(rawInput: string | null | undefined): ExtractedSharePayload | null {
  if (!rawInput || typeof rawInput !== "string") return null;
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

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
