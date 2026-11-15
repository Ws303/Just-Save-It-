import {
  classifyQueueFlushStatus,
  clearSession,
  enqueueOfflineItem,
  flushOfflineQueueWithSender,
  loadCachedWorkspace,
  loadOfflineQueue,
  loadSession,
  saveCachedWorkspace,
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

let _refreshInFlightPromise: Promise<boolean> | null = null;

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

export function getGoogleOAuthUrl(redirectUri: string): string {
  return `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;
}

export async function refreshSession(): Promise<boolean> {
  if (_refreshInFlightPromise) {
    return _refreshInFlightPromise;
  }
  _refreshInFlightPromise = (async () => {
    const current = await loadSession();
    if (!current?.refresh_token) return false;
    try {
      const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
      const data = await parseJsonSafe(resp);
      const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
      if (!resp.ok || !accessToken) return false;
      const rawUser = data?.user as JsonRecord | undefined;
      const rawMeta = rawUser?.user_metadata as JsonRecord | undefined;
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
  try {
    return await _refreshInFlightPromise;
  } finally {
    _refreshInFlightPromise = null;
  }
}

export async function apiFetch<T = JsonRecord>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; skipRetry?: boolean } = {},
): Promise<ApiResult<T>> {
  const method = options.method || "GET";
  const session = await loadSession();
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

    if (resp.status === 401 && !options.skipRetry && session?.refresh_token) {
      const okRefresh = await refreshSession();
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

export async function fetchWorkspace(): Promise<{
  me: JsonRecord | null;
  items: MobileLinkItem[];
  folders: MobileFolderItem[];
  reminders: MobileReminderItem[];
  offline: boolean;
}> {
  const [meRes, itemsRes, foldersRes, remRes] = await Promise.all([
    apiFetch<JsonRecord>("/api/auth/me"),
    apiFetch<{ items?: MobileLinkItem[] }>("/api/items?limit=100"),
    apiFetch<{ folders?: MobileFolderItem[] }>("/api/folders"),
    apiFetch<{ reminders?: MobileReminderItem[] }>("/api/reminders"),
  ]);

  if (!itemsRes.ok) {
    const cached = await loadCachedWorkspace();
    const session = await loadSession();
    return {
      me: meRes.ok ? meRes.data : session?.user ? { ...session.user } : null,
      items: cached.items,
      folders: cached.folders,
      reminders: cached.reminders,
      offline: itemsRes.status === 0,
    };
  }

  const firstBatch = Array.isArray(itemsRes.data?.items) ? itemsRes.data.items : [];
  const items: MobileLinkItem[] = [...firstBatch];
  let offset = firstBatch.length;
  while (firstBatch.length === 100 && offset < 500) {
    const nextRes = await apiFetch<{ items?: MobileLinkItem[] }>(`/api/items?limit=100&offset=${offset}`);
    const batch = nextRes.ok && Array.isArray(nextRes.data?.items) ? nextRes.data.items : [];
    items.push(...batch);
    if (batch.length < 100) break;
    offset += batch.length;
  }
  const folders = Array.isArray(foldersRes.data?.folders) ? foldersRes.data.folders : [];
  const reminders = Array.isArray(remRes.data?.reminders) ? remRes.data.reminders : [];

  await saveCachedWorkspace({ items, folders, reminders });
  return {
    me: meRes.ok ? meRes.data : null,
    items,
    folders,
    reminders,
    offline: false,
  };
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
  return apiFetch<JsonRecord>(`/api/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
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
