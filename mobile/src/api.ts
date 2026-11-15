import {
  classifyQueueFlushStatus,
  clearPkceVerifier,
  clearSession,
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  getAuthGeneration,
  loadCachedWorkspace,
  loadOfflineQueue,
  loadSession,
  peekPkceVerifier,
  recordAuthDebugEvent,
  removeCachedLinkItem,
  resolveSessionUserId,
  saveCachedWorkspace,
  savePkceVerifier,
  saveSession,
  type MobileFolderItem,
  type MobileLinkItem,
  type MobileReminderItem,
  type QueuedLinkPayload,
  type StoredSession,
  type WorkflowStatus,
} from "./storage";

export const API_BASE = "https://just-save-it-api.onrender.com";
export const SUPABASE_URL = "https://pnqjamwhgzqzvpiytcln.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBucWphbXdoZ3pxenZwaXl0Y2xuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NjAzMjIsImV4cCI6MjExMDIzNjMyMn0.4RfZtHD9-23dSQw2P6tWRz45mty5BumKWAKKBifbebw";

export type JsonRecord = Record<string, unknown>;

export interface McpTokenRecord {
  id: string;
  name?: string;
  prefix?: string;
  token_prefix?: string;
  token?: string;
  created_at?: string;
  last_used_at?: string | null;
}

type WorkspacePayload = {
  me: JsonRecord | null;
  items: MobileLinkItem[];
  folders: MobileFolderItem[];
  reminders: MobileReminderItem[];
  offline: boolean;
};

let _refreshInFlightPromise: Promise<boolean> | null = null;
let _refreshInFlightGen = -1;
let _workspaceInFlightPromise: Promise<WorkspacePayload> | null = null;
let _workspaceInFlightGen = -1;

const OAUTH_SETTLED_CACHE_MS = 60_000;
const _codeExchangePromises = new Map<string, Promise<ApiResult<StoredSession>>>();
const _codeExchangeResults = new Map<string, { res: ApiResult<StoredSession>; at: number }>();
const _tokenCompletionPromises = new Map<string, Promise<ApiResult<StoredSession>>>();
const _tokenCompletionResults = new Map<string, { res: ApiResult<StoredSession>; at: number }>();

export function isOAuthExchangeInFlight(): boolean {
  return _codeExchangePromises.size > 0 || _tokenCompletionPromises.size > 0;
}

// RFC 6234 SHA-256 + RFC 7636 PKCE helpers (pure TS for React Native Hermes + Node test parity)
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(val: number, shift: number): number {
  return (val >>> shift) | (val << (32 - shift));
}

function encodeUtf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let cp = input.charCodeAt(i);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      cp = 0x10000 + ((cp & 0x3ff) << 10) + (next & 0x3ff);
      i += 1;
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return bytes;
}

function bytesToBase64Url(bytes: number[]): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function sha256Base64Url(input: string): string {
  const msg = encodeUtf8Bytes(input);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while ((msg.length % 64) !== 56) msg.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  msg.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  msg.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let offset = 0; offset < msg.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        (msg[offset + i * 4] << 24) |
        (msg[offset + i * 4 + 1] << 16) |
        (msg[offset + i * 4 + 2] << 8) |
        msg[offset + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  const outBytes: number[] = [];
  for (const word of h) {
    outBytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return bytesToBase64Url(outBytes);
}

export function buildPkceChallengePair(fixedVerifier?: string): { verifier: string; challenge: string } {
  let verifier = String(fixedVerifier || "").trim();
  if (!verifier) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const rnd = new Uint8Array(64);
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(rnd);
    } else {
      let filled = false;
      try {
        // Lazy require avoids loading React Native native modules in Node tests while supporting Hermes
        const expoCrypto = require("expo-crypto") as { getRandomValues?: (arr: Uint8Array) => Uint8Array };
        if (typeof expoCrypto?.getRandomValues === "function") {
          expoCrypto.getRandomValues(rnd);
          filled = true;
        }
      } catch {
        filled = false;
      }
      if (!filled) {
        throw new Error("Secure random number generator unavailable for PKCE");
      }
    }
    verifier = Array.from(rnd, (b) => chars[b % chars.length]).join("");
  }
  return { verifier, challenge: sha256Base64Url(verifier) };
}

export interface ApiResult<T = JsonRecord> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

async function parseJsonSafe(resp: Response): Promise<JsonRecord | null> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    return { raw: text };
  }
}

export async function loginWithPassword(email: string, password: string): Promise<ApiResult<StoredSession>> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const data = await parseJsonSafe(resp);
    const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
    if (!resp.ok || !accessToken) {
      const errDesc =
        (typeof data?.error_description === "string" && data.error_description) ||
        (typeof data?.msg === "string" && data.msg) ||
        "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
      return { ok: false, status: resp.status, data: null, error: errDesc };
    }
    const rawUser = data?.user as JsonRecord | undefined;
    const rawMeta = rawUser?.user_metadata as JsonRecord | undefined;
    const session: StoredSession = {
      access_token: accessToken,
      refresh_token: typeof data?.refresh_token === "string" ? data.refresh_token : "",
      expires_at: typeof data?.expires_at === "number" ? data.expires_at : undefined,
      user: rawUser
        ? {
            id: String(rawUser.id || ""),
            email: String(rawUser.email || email.trim()),
            display_name: String(rawMeta?.display_name || email.split("@")[0]),
          }
        : null,
    };
    await saveSession(session);
    return { ok: true, status: resp.status, data: session };
  } catch (err: unknown) {
    return { ok: false, status: 0, data: null, error: getErrorMessage(err, "เชื่อมต่อไม่ได้") };
  }
}

export async function signupWithPassword(
  email: string,
  password: string,
  displayName?: string,
): Promise<ApiResult<JsonRecord>> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: email.trim(),
        password,
        data: { display_name: (displayName || email.split("@")[0]).trim() },
      }),
    });
    const data = await parseJsonSafe(resp);
    if (!resp.ok) {
      const errMsg =
        (typeof data?.msg === "string" && data.msg) ||
        (typeof data?.error_description === "string" && data.error_description) ||
        "สมัครสมาชิกไม่สำเร็จ";
      return { ok: false, status: resp.status, data, error: errMsg };
    }
    const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
    if (accessToken) {
      const rawUser = data?.user as JsonRecord | undefined;
      await saveSession({
        access_token: accessToken,
        refresh_token: typeof data?.refresh_token === "string" ? data.refresh_token : "",
        expires_at: typeof data?.expires_at === "number" ? data.expires_at : undefined,
        user: {
          id: String(rawUser?.id || ""),
          email: String(rawUser?.email || email.trim()),
          display_name: displayName || email.split("@")[0],
        },
      });
    }
    return { ok: true, status: resp.status, data };
  } catch (err: unknown) {
    return { ok: false, status: 0, data: null, error: getErrorMessage(err, "เชื่อมต่อไม่ได้") };
  }
}

export function getGoogleOAuthUrl(redirectUri: string, codeChallenge?: string): string {
  const base = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;
  if (!codeChallenge) return base;
  return `${base}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=s256`;
}

export async function prepareGoogleOAuthUrl(redirectUri: string): Promise<string> {
  const { verifier, challenge } = buildPkceChallengePair();
  await savePkceVerifier(verifier);
  return getGoogleOAuthUrl(redirectUri, challenge);
}

export async function completeOAuthWithTokens(
  accessToken: string,
  refreshToken = "",
): Promise<ApiResult<StoredSession>> {
  const cleanAccess = String(accessToken || "").trim();
  const cleanRefresh = String(refreshToken || "").trim();
  if (!cleanAccess) {
    return { ok: false, status: 400, data: null, error: "ไม่พบ Access Token จาก Google" };
  }

  const cached = _tokenCompletionResults.get(cleanAccess);
  if (cached && cached.res.ok && Date.now() - cached.at < OAUTH_SETTLED_CACHE_MS) {
    const cur = await loadSession().catch(() => null);
    if (cur?.access_token === cleanAccess) {
      return cached.res;
    }
  }

  const existingPromise = _tokenCompletionPromises.get(cleanAccess);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<ApiResult<StoredSession>> => {
    let userObj: StoredSession["user"] = null;
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "GET",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${cleanAccess}`,
        },
      });
      if (resp.ok) {
        const rawUser = await parseJsonSafe(resp);
        const rawMeta = rawUser?.user_metadata as JsonRecord | undefined;
        if (rawUser?.id || rawUser?.email) {
          userObj = {
            id: String(rawUser.id || ""),
            email: String(rawUser.email || ""),
            display_name: String(
              rawMeta?.display_name || rawMeta?.full_name || rawMeta?.name || String(rawUser.email || "").split("@")[0],
            ),
          };
        }
      }
    } catch {
      // Non-fatal: save token session and let /api/workspace hydrate profile
    }
    const session: StoredSession = {
      access_token: cleanAccess,
      refresh_token: cleanRefresh,
      user: userObj,
    };
    await saveSession(session);
    recordAuthDebugEvent("oauth_session_saved", userObj?.email || "token_ready");
    const res: ApiResult<StoredSession> = { ok: true, status: 200, data: session };
    _tokenCompletionResults.set(cleanAccess, { res, at: Date.now() });
    return res;
  })();

  _tokenCompletionPromises.set(cleanAccess, task);
  try {
    return await task;
  } finally {
    if (_tokenCompletionPromises.get(cleanAccess) === task) {
      _tokenCompletionPromises.delete(cleanAccess);
    }
  }
}

export async function exchangeOAuthCode(code: string): Promise<ApiResult<StoredSession>> {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) {
    return { ok: false, status: 400, data: null, error: "ไม่พบ Authorization Code จาก Google" };
  }

  const cached = _codeExchangeResults.get(cleanCode);
  if (cached && cached.res.ok && Date.now() - cached.at < OAUTH_SETTLED_CACHE_MS) {
    const cur = await loadSession().catch(() => null);
    if (cur?.access_token && cur.access_token === cached.res.data?.access_token) {
      return cached.res;
    }
  }

  const existingPromise = _codeExchangePromises.get(cleanCode);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<ApiResult<StoredSession>> => {
    const verifier = await peekPkceVerifier();
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_code: cleanCode,
          ...(verifier ? { code_verifier: verifier } : {}),
        }),
      });
      if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
        await clearPkceVerifier().catch(() => {});
      }
      const data = await parseJsonSafe(resp);
      const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
      if (!resp.ok || !accessToken) {
        const errMsg =
          (typeof data?.error_description === "string" && data.error_description) ||
          (typeof data?.msg === "string" && data.msg) ||
          (typeof data?.error === "string" && data.error) ||
          "แลกรหัสยืนยันตัวตน Google ไม่สำเร็จ";
        recordAuthDebugEvent("pkce_exchange_fail", `HTTP ${resp.status}: ${errMsg}`);
        return { ok: false, status: resp.status, data: null, error: errMsg };
      }
      const rawUser = data?.user as JsonRecord | undefined;
      const rawMeta = rawUser?.user_metadata as JsonRecord | undefined;
      const session: StoredSession = {
        access_token: accessToken,
        refresh_token: typeof data?.refresh_token === "string" ? data.refresh_token : "",
        expires_at: typeof data?.expires_at === "number" ? data.expires_at : undefined,
        user: rawUser
          ? {
              id: String(rawUser.id || ""),
              email: String(rawUser.email || ""),
              display_name: String(
                rawMeta?.display_name || rawMeta?.full_name || rawMeta?.name || String(rawUser.email || "").split("@")[0],
              ),
            }
          : null,
      };
      await saveSession(session);
      recordAuthDebugEvent("pkce_exchange_ok", session.user?.email || "authenticated");
      const res: ApiResult<StoredSession> = { ok: true, status: resp.status, data: session };
      _codeExchangeResults.set(cleanCode, { res, at: Date.now() });
      return res;
    } catch (err: unknown) {
      const msg = getErrorMessage(err, "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ยืนยันตัวตนได้");
      recordAuthDebugEvent("pkce_exchange_error", msg);
      return { ok: false, status: 0, data: null, error: msg };
    }
  })();

  _codeExchangePromises.set(cleanCode, task);
  try {
    return await task;
  } finally {
    if (_codeExchangePromises.get(cleanCode) === task) {
      _codeExchangePromises.delete(cleanCode);
    }
  }
}

export async function refreshSession(): Promise<boolean> {
  const startGen = getAuthGeneration();
  if (_refreshInFlightPromise && _refreshInFlightGen === startGen) {
    return _refreshInFlightPromise;
  }
  const task = (async (): Promise<boolean> => {
    const current = await loadSession();
    if (!current?.refresh_token || getAuthGeneration() !== startGen) return false;
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      if (getAuthGeneration() !== startGen) return false;
      const data = await parseJsonSafe(resp);
      const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
      if (!resp.ok || !accessToken) return false;
      const rawUser = data?.user as JsonRecord | undefined;
      const rawMeta = rawUser?.user_metadata as JsonRecord | undefined;
      if (getAuthGeneration() !== startGen) return false;
      await saveSession({
        access_token: accessToken,
        refresh_token: typeof data?.refresh_token === "string" ? data.refresh_token : current.refresh_token,
        expires_at: typeof data?.expires_at === "number" ? data.expires_at : current.expires_at,
        user: rawUser
          ? {
              id: String(rawUser.id || current.user?.id || ""),
              email: String(rawUser.email || current.user?.email || ""),
              display_name: String(rawMeta?.display_name || current.user?.display_name || ""),
            }
          : current.user,
      });
      return true;
    } catch {
      return false;
    }
  })();
  _refreshInFlightPromise = task;
  _refreshInFlightGen = startGen;
  try {
    return await task;
  } finally {
    if (_refreshInFlightPromise === task) {
      _refreshInFlightPromise = null;
      _refreshInFlightGen = -1;
    }
  }
}

export async function apiFetch<T = JsonRecord>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; skipRetry?: boolean } = {},
): Promise<ApiResult<T>> {
  const method = options.method || "GET";
  const startGen = getAuthGeneration();
  const session = await loadSession();
  if (getAuthGeneration() !== startGen) {
    return { ok: false, status: 401, data: null, error: "Session changed" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: options.body !== undefined && method !== "GET" ? JSON.stringify(options.body) : undefined,
    });
    if (getAuthGeneration() !== startGen) {
      return { ok: false, status: 401, data: null, error: "Session changed" };
    }

    if (resp.status === 401 && !options.skipRetry && session?.refresh_token) {
      const okRefresh = await refreshSession();
      if (getAuthGeneration() !== startGen) {
        return { ok: false, status: 401, data: null, error: "Session changed" };
      }
      if (okRefresh) {
        return apiFetch<T>(path, { ...options, skipRetry: true });
      }
    }

    const data = await parseJsonSafe(resp);
    if (!resp.ok) {
      const errDetail =
        (typeof data?.detail === "string" && data.detail) ||
        (typeof data?.message === "string" && data.message) ||
        `HTTP ${resp.status}`;
      return {
        ok: false,
        status: resp.status,
        data: (data as T) ?? null,
        error: errDetail,
      };
    }
    return { ok: true, status: resp.status, data: (data as T) ?? null };
  } catch (err: unknown) {
    return { ok: false, status: 0, data: null, error: getErrorMessage(err, "Network error") };
  }
}

function mergeUniqueMobileItems(
  target: MobileLinkItem[],
  seenIds: Set<string>,
  batch: MobileLinkItem[],
): number {
  let added = 0;
  for (const row of batch) {
    const id = row?.id ? String(row.id) : "";
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    target.push(row);
    added += 1;
  }
  return added;
}

async function fetchCursorPaginatedItems(
  firstBatch: MobileLinkItem[],
  initialCursor: string | null | undefined,
  startGen: number,
): Promise<{ aborted: boolean; items: MobileLinkItem[] }> {
  const items: MobileLinkItem[] = [];
  const seenIds = new Set<string>();
  mergeUniqueMobileItems(items, seenIds, firstBatch);
  let nextCursor = initialCursor || null;
  let pageCount = 0;
  while (nextCursor && pageCount < 25) {
    pageCount += 1;
    const nextRes = await apiFetch<{ items?: MobileLinkItem[]; next_cursor?: string | null }>(
      `/api/items?limit=100&cursor=${encodeURIComponent(nextCursor)}`,
    );
    if (getAuthGeneration() !== startGen) {
      return { aborted: true, items: [] };
    }
    const batch = nextRes.ok && Array.isArray(nextRes.data?.items) ? nextRes.data.items : [];
    const added = mergeUniqueMobileItems(items, seenIds, batch);
    const candidateCursor = nextRes.data?.next_cursor || null;
    if (batch.length === 0 || added === 0 || !candidateCursor || candidateCursor === nextCursor) {
      break;
    }
    nextCursor = candidateCursor;
  }
  return { aborted: false, items };
}

export async function fetchWorkspace(): Promise<WorkspacePayload> {
  const startGen = getAuthGeneration();
  if (_workspaceInFlightPromise && _workspaceInFlightGen === startGen) {
    return _workspaceInFlightPromise;
  }

  const emptyPayload: WorkspacePayload = {
    me: null,
    items: [],
    folders: [],
    reminders: [],
    offline: false,
  };

  const task = (async (): Promise<WorkspacePayload> => {
    const session = await loadSession();
    if (getAuthGeneration() !== startGen) {
      return emptyPayload;
    }
    if (!session?.access_token) {
      return emptyPayload;
    }

    const wsRes = await apiFetch<{
      items?: MobileLinkItem[];
      folders?: MobileFolderItem[];
      reminders?: MobileReminderItem[];
      next_cursor?: string | null;
    } & JsonRecord>("/api/workspace?limit=100");

    if (getAuthGeneration() !== startGen) {
      return emptyPayload;
    }

    if (wsRes.ok && wsRes.data && Array.isArray(wsRes.data.items)) {
      const paginated = await fetchCursorPaginatedItems(wsRes.data.items, wsRes.data.next_cursor, startGen);
      if (paginated.aborted || getAuthGeneration() !== startGen) {
        return emptyPayload;
      }
      const folders = Array.isArray(wsRes.data.folders) ? wsRes.data.folders : [];
      const reminders = Array.isArray(wsRes.data.reminders) ? wsRes.data.reminders : [];
      await saveCachedWorkspace({
        user_id:
          resolveSessionUserId(session) ||
          (typeof wsRes.data.id === "string" ? wsRes.data.id.trim() : "") ||
          undefined,
        items: paginated.items,
        folders,
        reminders,
      });
      return {
        me: wsRes.data,
        items: paginated.items,
        folders,
        reminders,
        offline: false,
      };
    }

    if (wsRes.status !== 404) {
      const cached = await loadCachedWorkspace();
      return {
        me: session.user ? { ...session.user } : null,
        items: cached.items,
        folders: cached.folders,
        reminders: cached.reminders,
        offline: wsRes.status === 0,
      };
    }

    // Legacy 4-endpoint fallback if backend does not have /api/workspace yet
    const [meRes, itemsRes, foldersRes, remRes] = await Promise.all([
      apiFetch<JsonRecord>("/api/auth/me"),
      apiFetch<{ items?: MobileLinkItem[]; next_cursor?: string | null }>("/api/items?limit=100"),
      apiFetch<{ folders?: MobileFolderItem[] }>("/api/folders"),
      apiFetch<{ reminders?: MobileReminderItem[] }>("/api/reminders"),
    ]);

    if (getAuthGeneration() !== startGen) {
      return emptyPayload;
    }

    if (!itemsRes.ok) {
      const cached = await loadCachedWorkspace();
      return {
        me: meRes.ok ? meRes.data : session.user ? { ...session.user } : null,
        items: cached.items,
        folders: cached.folders,
        reminders: cached.reminders,
        offline: itemsRes.status === 0,
      };
    }

    const firstBatch = Array.isArray(itemsRes.data?.items) ? itemsRes.data.items : [];
    const paginated = await fetchCursorPaginatedItems(firstBatch, itemsRes.data?.next_cursor, startGen);
    if (paginated.aborted || getAuthGeneration() !== startGen) {
      return emptyPayload;
    }
    const folders = Array.isArray(foldersRes.data?.folders) ? foldersRes.data.folders : [];
    const reminders = Array.isArray(remRes.data?.reminders) ? remRes.data.reminders : [];

    await saveCachedWorkspace({
      user_id:
        resolveSessionUserId(session) ||
        (meRes.ok && typeof meRes.data?.id === "string" ? meRes.data.id.trim() : "") ||
        undefined,
      items: paginated.items,
      folders,
      reminders,
    });
    return {
      me: meRes.ok ? meRes.data : null,
      items: paginated.items,
      folders,
      reminders,
      offline: false,
    };
  })();

  _workspaceInFlightPromise = task;
  _workspaceInFlightGen = startGen;
  try {
    return await task;
  } finally {
    if (_workspaceInFlightPromise === task) {
      _workspaceInFlightPromise = null;
      _workspaceInFlightGen = -1;
    }
  }
}

export async function saveLinkItem(payload: {
  url: string;
  title?: string;
  note?: string;
  tags?: string[];
  folder_id?: string | null;
  status?: WorkflowStatus;
}): Promise<ApiResult<JsonRecord> & { queued?: boolean }> {
  const res = await apiFetch<JsonRecord>("/api/items", { method: "POST", body: payload });
  if (!res.ok && res.status === 0) {
    await enqueueOfflineItem(payload);
    return {
      ok: true,
      status: 202,
      queued: true,
      data: { ...payload, queued: true },
    };
  }
  return res;
}

export async function flushOfflineQueue(
  customSender?: (item: QueuedLinkPayload) => Promise<boolean | "ok" | "retry" | "drop">,
): Promise<{ flushed: number; remaining: number }> {
  if (!customSender) {
    const session = await loadSession().catch(() => null);
    if (!session?.access_token) {
      return { flushed: 0, remaining: await getOfflineQueueCount() };
    }
  }
  const sender =
    customSender ||
    (async (entry: QueuedLinkPayload): Promise<"ok" | "retry" | "drop"> => {
      const res = await apiFetch("/api/items", {
        method: "POST",
        body: {
          url: entry.url,
          title: entry.title,
          note: entry.note,
          tags: entry.tags,
          folder_id: entry.folder_id ?? null,
          status: entry.status || "inbox",
        },
      });
      if (res.ok) return "ok";
      return classifyQueueFlushStatus(res.status);
    });

  const out = await flushOfflineQueueWithSender(sender);
  return { flushed: out.flushed, remaining: out.remaining };
}

export async function getOfflineQueueCount(): Promise<number> {
  const q = await loadOfflineQueue();
  return q.length;
}

export async function patchLinkItem(itemId: string, patch: Record<string, unknown>): Promise<ApiResult<MobileLinkItem>> {
  return apiFetch<MobileLinkItem>(`/api/items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: patch });
}

export async function deleteLinkItem(itemId: string): Promise<ApiResult<JsonRecord>> {
  const startGen = getAuthGeneration();
  const res = await apiFetch<JsonRecord>(`/api/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  if (res.ok && getAuthGeneration() === startGen) {
    await removeCachedLinkItem(itemId).catch(() => {});
  }
  return res;
}

export async function refreshLinkPreview(itemId: string): Promise<ApiResult<MobileLinkItem>> {
  return apiFetch<MobileLinkItem>(`/api/items/${encodeURIComponent(itemId)}/refresh-preview`, {
    method: "POST",
    body: {},
  });
}

export async function summarizeLinkItem(itemId: string, forceRefresh = false): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>("/api/ai/summarize", {
    method: "POST",
    body: {
      item_id: itemId,
      force_refresh: forceRefresh,
      save_to_note: false,
      ai_config: { provider: "built-in", api_key: null, base_url: null, model: null },
    },
  });
}

export async function createFolder(name: string, icon = "📁"): Promise<ApiResult<MobileFolderItem>> {
  return apiFetch<MobileFolderItem>("/api/folders", { method: "POST", body: { name: name.trim(), icon } });
}

export async function createFolderInvite(
  folderId: string,
  role: "viewer" | "editor" = "editor",
): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>(`/api/folders/${encodeURIComponent(folderId)}/invites`, {
    method: "POST",
    body: { role, expires_in_days: 7 },
  });
}

export async function acceptFolderInvite(token: string): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>(`/api/invites/${encodeURIComponent(token.trim())}/accept`, {
    method: "POST",
    body: {},
  });
}

export async function saveReminder(
  itemId: string,
  payload: {
    schedule_type?: "once" | "every_n_days";
    remind_at: string;
    remind_time?: string;
    repeat_every_days?: number | null;
  },
): Promise<ApiResult<MobileReminderItem>> {
  return apiFetch<MobileReminderItem>(`/api/reminders/${encodeURIComponent(itemId)}`, {
    method: "PUT",
    body: {
      item_id: itemId,
      schedule_type: payload.schedule_type || "once",
      next_remind_at: payload.remind_at,
      remind_at: payload.remind_at,
      repeat_every_days: payload.schedule_type === "every_n_days" ? payload.repeat_every_days || 3 : null,
      remind_time: payload.remind_time || "18:00:00",
      timezone: "Asia/Bangkok",
      is_enabled: true,
    },
  });
}

export async function deleteReminder(itemId: string): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>(`/api/reminders/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export async function registerPushDevice(payload: {
  platform: "android" | "ios";
  delivery_mode: "remote" | "local_sync";
  push_token?: string | null;
}): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>("/api/devices", {
    method: "POST",
    body: {
      platform: payload.platform,
      delivery_mode: payload.delivery_mode,
      push_token: payload.push_token ?? null,
      is_active: true,
    },
  });
}

export async function listMcpTokens(): Promise<ApiResult<{ tokens?: McpTokenRecord[] }>> {
  return apiFetch<{ tokens?: McpTokenRecord[] }>("/api/auth/tokens");
}

export async function createMcpToken(name: string): Promise<ApiResult<McpTokenRecord>> {
  return apiFetch<McpTokenRecord>("/api/auth/tokens", {
    method: "POST",
    body: { name: name.trim() || "Mobile Token" },
  });
}

export async function revokeMcpToken(tokenId: string): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>(`/api/auth/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
}

export async function exportWorkspaceJson(): Promise<ApiResult<JsonRecord>> {
  return apiFetch<JsonRecord>("/api/export");
}

export async function deleteMyAccount(): Promise<ApiResult<JsonRecord>> {
  const res = await apiFetch<JsonRecord>("/api/auth/me", { method: "DELETE" });
  if (res.ok) await clearSession();
  return res;
}

export async function logoutAccount(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST", body: {} });
  await clearSession();
}
