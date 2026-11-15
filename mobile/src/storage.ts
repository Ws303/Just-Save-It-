export type AppThemeMode = "cream" | "white" | "dark";
export type WorkflowStatus = "inbox" | "todo" | "done" | "archived";

export interface StoredUser {
  id: string;
  email: string;
  display_name?: string;
  tier?: string;
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: StoredUser | null;
}

export interface MobileLinkItem {
  id: string;
  url: string;
  title?: string;
  description?: string;
  platform?: string;
  content_type?: string;
  thumbnail_url?: string | null;
  image_url?: string | null;
  status?: WorkflowStatus | string;
  is_favorite?: boolean;
  tags?: string[];
  tag_names?: string[];
  note?: string | null;
  user_note?: string | null;
  ai_summary?: string | null;
  folder_id?: string | null;
  saved_at?: string | null;
}

export interface MobileFolderItem {
  id: string;
  name: string;
  icon?: string | null;
  item_count?: number;
  owner_id?: string;
  role?: string;
}

export interface MobileReminderItem {
  id?: string;
  item_id: string;
  title?: string;
  url?: string;
  schedule_type?: string;
  remind_at?: string | null;
  next_remind_at?: string | null;
  scheduled_for?: string | null;
  next_run_at?: string | null;
  remind_time?: string | null;
  repeat_every_days?: number | null;
  is_enabled?: boolean;
  enabled?: boolean;
  status?: string;
}

export interface QueuedLinkPayload {
  client_id: string;
  url: string;
  title?: string;
  note?: string;
  tags?: string[];
  folder_id?: string | null;
  status?: WorkflowStatus;
  queued_at: string;
}

export interface CachedWorkspace {
  items: MobileLinkItem[];
  folders: MobileFolderItem[];
  reminders: MobileReminderItem[];
  updated_at: string;
}

interface StorageBackend {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

const KEYS = {
  session: "jsi_mobile_session",
  offlineQueue: "jsi_mobile_offline_queue",
  cache: "jsi_mobile_cache",
  theme: "jsi_mobile_theme",
};

const memoryStore = new Map<string, string>();
let asyncStoragePromise: Promise<StorageBackend | null> | null = null;
let secureStoragePromise: Promise<StorageBackend | null> | null = null;

interface SecureStoreModuleShape {
  getItemAsync?: (key: string) => Promise<string | null>;
  setItemAsync?: (key: string, value: string) => Promise<void>;
  deleteItemAsync?: (key: string) => Promise<void>;
}

function toSecureStorageBackend(mod: unknown): StorageBackend | null {
  if (!mod || typeof mod !== "object") return null;
  const candidate = ((mod as { default?: unknown })?.default ?? mod) as SecureStoreModuleShape;
  if (
    typeof candidate.getItemAsync === "function" &&
    typeof candidate.setItemAsync === "function" &&
    typeof candidate.deleteItemAsync === "function"
  ) {
    const getItemAsync = candidate.getItemAsync.bind(candidate);
    const setItemAsync = candidate.setItemAsync.bind(candidate);
    const deleteItemAsync = candidate.deleteItemAsync.bind(candidate);
    return {
      getItem: (key: string) => getItemAsync(key),
      setItem: (key: string, value: string) => setItemAsync(key, value),
      removeItem: (key: string) => deleteItemAsync(key),
    };
  }
  return null;
}

async function getSecureSessionBackend(): Promise<StorageBackend> {
  if (!secureStoragePromise) {
    secureStoragePromise = import("expo-secure-store")
      .then((mod) => toSecureStorageBackend(mod))
      .catch(() => null);
  }
  const secure = await secureStoragePromise;
  if (secure) return secure;
  return getStorageBackend();
}

function isStorageBackend(candidate: unknown): candidate is StorageBackend {
  if (!candidate || typeof candidate !== "object") return false;
  const rec = candidate as Record<string, unknown>;
  return (
    typeof rec.getItem === "function" &&
    typeof rec.setItem === "function" &&
    typeof rec.removeItem === "function"
  );
}

async function getStorageBackend(): Promise<StorageBackend> {
  if (!asyncStoragePromise) {
    asyncStoragePromise = import("@react-native-async-storage/async-storage")
      .then((mod) => {
        const candidate = (mod as { default?: unknown })?.default ?? mod;
        return isStorageBackend(candidate) ? candidate : null;
      })
      .catch(() => null);
  }
  const backend = await asyncStoragePromise;
  if (backend) return backend;
  return {
    async getItem(key: string) {
      return memoryStore.has(key) ? memoryStore.get(key) ?? null : null;
    },
    async setItem(key: string, value: string) {
      memoryStore.set(key, value);
    },
    async removeItem(key: string) {
      memoryStore.delete(key);
    },
  };
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const backend = await getStorageBackend();
  const raw = await backend.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const backend = await getStorageBackend();
  await backend.setItem(key, JSON.stringify(value));
}

export async function loadSession(): Promise<StoredSession | null> {
  const secureBackend = await getSecureSessionBackend();
  const raw = await secureBackend.getItem(KEYS.session);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }
  const fallbackBackend = await getStorageBackend();
  if (secureBackend !== fallbackBackend) {
    const legacyRaw = await fallbackBackend.getItem(KEYS.session);
    if (legacyRaw) {
      try {
        return JSON.parse(legacyRaw) as StoredSession;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function saveSession(session: StoredSession): Promise<void> {
  const secureBackend = await getSecureSessionBackend();
  await secureBackend.setItem(KEYS.session, JSON.stringify(session));
  const fallbackBackend = await getStorageBackend();
  if (secureBackend !== fallbackBackend) {
    await fallbackBackend.removeItem(KEYS.session);
  }
}

export async function clearSession(): Promise<void> {
  const secureBackend = await getSecureSessionBackend();
  await secureBackend.removeItem(KEYS.session);
  const fallbackBackend = await getStorageBackend();
  if (secureBackend !== fallbackBackend) {
    await fallbackBackend.removeItem(KEYS.session);
  }
}

export async function loadOfflineQueue(): Promise<QueuedLinkPayload[]> {
  const rows = await readJson<QueuedLinkPayload[]>(KEYS.offlineQueue, []);
  return Array.isArray(rows) ? rows : [];
}

export async function setOfflineQueue(queue: QueuedLinkPayload[]): Promise<void> {
  await writeJson(KEYS.offlineQueue, queue);
}

export async function enqueueOfflineItem(
  payload: Omit<QueuedLinkPayload, "client_id" | "queued_at"> & { client_id?: string; queued_at?: string },
): Promise<QueuedLinkPayload[]> {
  const current = await loadOfflineQueue();
  const entry: QueuedLinkPayload = {
    ...payload,
    client_id: payload.client_id || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queued_at: payload.queued_at || new Date().toISOString(),
  };
  const deduped = current.filter((item) => item.url !== entry.url);
  const next = [entry, ...deduped].slice(0, 100);
  await setOfflineQueue(next);
  return next;
}

export type OfflineFlushOutcome = boolean | "ok" | "retry" | "drop";

export function classifyQueueFlushStatus(httpStatus: number): "ok" | "retry" | "drop" {
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404 || httpStatus === 422) {
    return "drop";
  }
  return "retry";
}

export async function flushOfflineQueueWithSender(
  sender: (item: QueuedLinkPayload) => Promise<OfflineFlushOutcome>,
): Promise<{ flushed: number; remaining: number; dropped: number; failed: QueuedLinkPayload[] }> {
  const queue = await loadOfflineQueue();
  if (!queue.length) return { flushed: 0, remaining: 0, dropped: 0, failed: [] };
  const remaining: QueuedLinkPayload[] = [];
  let flushed = 0;
  let dropped = 0;
  for (const entry of queue) {
    try {
      const outcome = await sender(entry);
      if (outcome === true || outcome === "ok") {
        flushed += 1;
      } else if (outcome === "drop") {
        dropped += 1;
      } else {
        remaining.push(entry);
      }
    } catch {
      remaining.push(entry);
    }
  }
  await setOfflineQueue(remaining);
  return { flushed, remaining: remaining.length, dropped, failed: remaining };
}

export async function loadCachedWorkspace(): Promise<CachedWorkspace> {
  return readJson<CachedWorkspace>(KEYS.cache, {
    items: [],
    folders: [],
    reminders: [],
    updated_at: "",
  });
}

export async function saveCachedWorkspace(data: Omit<CachedWorkspace, "updated_at">): Promise<void> {
  await writeJson(KEYS.cache, {
    ...data,
    updated_at: new Date().toISOString(),
  });
}

export function getThemePageBg(mode: AppThemeMode): string {
  if (mode === "dark") return "#1C1917";
  if (mode === "white") return "#FFFFFF";
  return "#F6F3EC";
}

type ThemeListener = (mode: AppThemeMode) => void;
const _themeListeners = new Set<ThemeListener>();

export function subscribeThemeMode(listener: ThemeListener): () => void {
  _themeListeners.add(listener);
  return () => {
    _themeListeners.delete(listener);
  };
}

export async function loadThemeMode(): Promise<AppThemeMode> {
  const backend = await getStorageBackend();
  const raw = await backend.getItem(KEYS.theme);
  if (raw === "white" || raw === "dark" || raw === "cream") return raw;
  return "cream";
}

export async function saveThemeMode(mode: AppThemeMode): Promise<void> {
  const backend = await getStorageBackend();
  await backend.setItem(KEYS.theme, mode);
  for (const listener of _themeListeners) {
    listener(mode);
  }
}

export const DEFAULT_ANDROID_BINDER_MAX_CHARS = 250_000;

export function buildBoundedExportPayloadJson(
  exportData: Record<string, unknown>,
  maxChars: number = DEFAULT_ANDROID_BINDER_MAX_CHARS,
): { jsonString: string; truncated: boolean; totalItems: number; exportedItems: number } {
  const fullJson = JSON.stringify(exportData, null, 2);
  const rawItems = Array.isArray(exportData.items) ? exportData.items : [];
  if (fullJson.length <= maxChars) {
    return {
      jsonString: fullJson,
      truncated: false,
      totalItems: rawItems.length,
      exportedItems: rawItems.length,
    };
  }

  const makeCandidate = (count: number): string =>
    JSON.stringify(
      {
        ...exportData,
        _truncated_for_android_share: true,
        _total_items: rawItems.length,
        _exported_items: count,
        items: rawItems.slice(0, count),
      },
      null,
      2,
    );

  let lo = 0;
  let hi = rawItems.length;
  let bestCount = 0;
  let bestJson = makeCandidate(0);

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = makeCandidate(mid);
    if (candidate.length <= maxChars) {
      bestCount = mid;
      bestJson = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestJson.length > maxChars) {
    bestCount = 0;
    bestJson = JSON.stringify({
      _truncated_for_android_share: true,
      _total_items: rawItems.length,
      _exported_items: 0,
      items: [],
    });
  }

  return {
    jsonString: bestJson,
    truncated: true,
    totalItems: rawItems.length,
    exportedItems: bestCount,
  };
}
