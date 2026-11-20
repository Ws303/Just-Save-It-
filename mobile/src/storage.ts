export type AppThemeMode = "cream" | "white" | "dark";
export type FigmaAccentThemeId = "sharely" | "christmas" | "collab";
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
  canonical_url?: string | null;
  title?: string;
  description?: string;
  platform?: string;
  content_type?: string;
  contentType?: string;
  thumbnail_url?: string | null;
  image_url?: string | null;
  coverUrl?: string | null;
  thumb_url?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_items?: Array<string | Record<string, unknown>> | null;
  embed_type?: string | null;
  embed_url?: string | null;
  preview_status?: string | null;
  enrich_status?: string | null;
  enrich_error?: string | null;
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
  emoji?: string | null;
  icon?: string | null;
  cover_url?: string | null;
  item_count?: number;
  owner_id?: string;
  role?: string;
}

export interface MobileAiConfig {
  provider: "built-in" | "byok" | "custom";
  vendor?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  keyless?: boolean;
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
  user_id?: string;
  url: string;
  title?: string;
  note?: string;
  tags?: string[];
  folder_id?: string | null;
  status?: WorkflowStatus;
  queued_at: string;
}

export interface CachedWorkspace {
  user_id?: string;
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

export interface RegisteredPushDevice {
  user_id?: string;
  platform: "android" | "ios";
  delivery_mode: "remote" | "local_sync";
  push_token: string | null;
}

const KEYS = {
  session: "jsi_mobile_session",
  offlineQueue: "jsi_mobile_offline_queue",
  cache: "jsi_mobile_cache",
  theme: "jsi_mobile_theme",
  pkceVerifier: "jsi_mobile_pkce_verifier",
  pushDevice: "jsi_mobile_push_device",
  aiConfig: "sherlink_mobile_ai_config",
  aiApiKey: "sherlink_mobile_ai_api_key",
  figmaTheme: "sherlink_mobile_figma_theme",
};

const memoryStore = new Map<string, string>();
const memoryStorageBackend: StorageBackend = {
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
let _memWorkspaceCache: CachedWorkspace | null = null;
let _memPkceVerifier = "";
let _authGeneration = 0;
let _activeUserId = "";

export function getAuthGeneration(): number {
  return _authGeneration;
}
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

let _testStandardBackend: StorageBackend | null = null;
let _testSecureBackend: StorageBackend | null = null;

export function __setStorageBackendsForTests(
  backends: { standard?: StorageBackend | null; secure?: StorageBackend | null } | null,
): void {
  _testStandardBackend = backends?.standard ?? null;
  _testSecureBackend = backends?.secure ?? null;
}

async function getSecureSessionBackend(): Promise<StorageBackend> {
  if (_testSecureBackend) return _testSecureBackend;
  if (_testStandardBackend) return _testStandardBackend;
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
  if (_testStandardBackend) return _testStandardBackend;
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
  return memoryStorageBackend;
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

async function _loadSessionUnlocked(): Promise<StoredSession | null> {
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

export async function loadSession(): Promise<StoredSession | null> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    const sess = await _loadSessionUnlocked();
    if (sess && _authGeneration === startGen && _clearEpoch === startClearEpoch && !_activeUserId) {
      _activeUserId = resolveSessionUserId(sess);
    }
    return sess;
  });
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Pure(b64: string): string {
  let out = "";
  const clean = String(b64 || "").replace(/=+$/, "");
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = B64_CHARS.indexOf(clean[i]);
    const c2 = B64_CHARS.indexOf(clean[i + 1]);
    if (c1 < 0 || c2 < 0) break;
    const c3 = i + 2 < clean.length ? B64_CHARS.indexOf(clean[i + 2]) : -1;
    const c4 = i + 3 < clean.length ? B64_CHARS.indexOf(clean[i + 3]) : -1;
    const n = (c1 << 18) | (c2 << 12) | ((c3 >= 0 ? c3 : 0) << 6) | (c4 >= 0 ? c4 : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (c3 >= 0) out += String.fromCharCode((n >> 8) & 255);
    if (c4 >= 0) out += String.fromCharCode(n & 255);
  }
  return out;
}

export function resolveSessionUserId(session: StoredSession | null | undefined): string {
  const direct = String(session?.user?.id || "").trim();
  if (direct) return direct;
  const token = String(session?.access_token || "").trim();
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return "";
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const raw = typeof globalThis.atob === "function" ? globalThis.atob(b64) : decodeBase64Pure(b64);
    const parsed = JSON.parse(raw) as { sub?: unknown };
    return String(parsed?.sub || "").trim();
  } catch {
    return "";
  }
}

let _authStorageQueue: Promise<unknown> = Promise.resolve();
let _clearEpoch = 0;
let _loginSeq = 0;

function runSerializedAuthStorage<T>(fn: () => Promise<T>): Promise<T> {
  const next = _authStorageQueue.then(fn, fn);
  _authStorageQueue = next.catch(() => {});
  return next;
}

export function getClearEpoch(): number {
  return _clearEpoch;
}

export function beginAuthLogin(): { expectedClearEpoch: number; expectedLoginSeq: number } {
  _loginSeq += 1;
  return { expectedClearEpoch: _clearEpoch, expectedLoginSeq: _loginSeq };
}

export function isAuthEpochStale(epoch?: { expectedClearEpoch?: number; expectedLoginSeq?: number }): boolean {
  if (!epoch) return false;
  if (epoch.expectedClearEpoch !== undefined && _clearEpoch !== epoch.expectedClearEpoch) return true;
  if (epoch.expectedLoginSeq !== undefined && _loginSeq !== epoch.expectedLoginSeq) return true;
  return false;
}

export async function saveSession(
  session: StoredSession,
  options?: {
    expectedGen?: number;
    expectedRefreshToken?: string;
    expectedClearEpoch?: number;
    expectedLoginSeq?: number;
  },
): Promise<boolean> {
  let activeExpectedGen = options?.expectedGen;
  const expectedRefreshToken = options?.expectedRefreshToken;
  const expectedClearEpoch =
    options?.expectedClearEpoch !== undefined ? options.expectedClearEpoch : _clearEpoch;
  const expectedLoginSeq = options?.expectedLoginSeq;
  return runSerializedAuthStorage(async () => {
    const isStaleExpectedGen = () =>
      (activeExpectedGen !== undefined && _authGeneration !== activeExpectedGen) ||
      _clearEpoch !== expectedClearEpoch ||
      (expectedLoginSeq !== undefined && _loginSeq !== expectedLoginSeq);
    if (isStaleExpectedGen()) return false;
    const prev = await _loadSessionUnlocked().catch(() => null);
    if (isStaleExpectedGen()) return false;
    if (expectedRefreshToken && prev?.refresh_token !== expectedRefreshToken) {
      return false;
    }
    const prevUid = resolveSessionUserId(prev) || _activeUserId;
    const prevHadSession = Boolean(prev?.access_token || prev?.refresh_token || prevUid);
    const nextUid = resolveSessionUserId(session);
    const nextHasSession = Boolean(nextUid || session?.access_token);
    if (expectedRefreshToken && prevUid && nextUid && prevUid !== nextUid) {
      return false;
    }
    const fallbackBackend = await getStorageBackend();
    if (isStaleExpectedGen()) return false;
    const secureBackend = await getSecureSessionBackend();
    if (isStaleExpectedGen()) return false;

    const shouldClearStorage =
      (prevHadSession && (!nextUid || nextUid !== prevUid)) ||
      (!prevUid && nextUid && _activeUserId !== nextUid);
    const shouldBumpGen = shouldClearStorage || (!prevHadSession && nextHasSession);
    if (shouldClearStorage) {
      _authGeneration += 1;
      if (activeExpectedGen !== undefined) activeExpectedGen = _authGeneration;
      _memWorkspaceCache = null;
      await fallbackBackend.removeItem(KEYS.cache);
      await fallbackBackend.removeItem(KEYS.offlineQueue);
      await fallbackBackend.removeItem(KEYS.pushDevice);
      await fallbackBackend.removeItem(KEYS.aiConfig);
      await secureBackend.removeItem(KEYS.aiApiKey);
      if (secureBackend !== fallbackBackend) {
        await fallbackBackend.removeItem(KEYS.aiApiKey);
      }
      if (isStaleExpectedGen()) return false;
    } else if (shouldBumpGen) {
      _authGeneration += 1;
      if (activeExpectedGen !== undefined) activeExpectedGen = _authGeneration;
    }
    _activeUserId = nextUid;
    await secureBackend.setItem(KEYS.session, JSON.stringify(session));
    if (secureBackend !== fallbackBackend) {
      await fallbackBackend.removeItem(KEYS.session);
    }
    if (isStaleExpectedGen()) {
      if (_activeUserId === nextUid) {
        _activeUserId = "";
      }
      const rawOnDisk = await secureBackend.getItem(KEYS.session).catch(() => null);
      if (rawOnDisk) {
        try {
          const parsed = JSON.parse(rawOnDisk) as { access_token?: string };
          if (parsed?.access_token === session.access_token) {
            await secureBackend.removeItem(KEYS.session);
          }
        } catch {
          // Ignore parse error on teardown
        }
      }
      return false;
    }
    if (shouldBumpGen) {
      // Re-bump after storage commit so any concurrent read during IPC fails its generation check.
      _authGeneration += 1;
    }
    return true;
  });
}

export async function clearSession(): Promise<void> {
  _clearEpoch += 1;
  _authGeneration += 1;
  _activeUserId = "";
  _memWorkspaceCache = null;
  _memPkceVerifier = "";
  await runSerializedAuthStorage(async () => {
    _activeUserId = "";
    _memWorkspaceCache = null;
    _memPkceVerifier = "";
    const secureBackend = await getSecureSessionBackend();
    await secureBackend.removeItem(KEYS.session);
    const fallbackBackend = await getStorageBackend();
    if (secureBackend !== fallbackBackend) {
      await fallbackBackend.removeItem(KEYS.session);
    }
    await fallbackBackend.removeItem(KEYS.cache);
    await fallbackBackend.removeItem(KEYS.offlineQueue);
    await fallbackBackend.removeItem(KEYS.pkceVerifier);
    await fallbackBackend.removeItem(KEYS.pushDevice);
    await fallbackBackend.removeItem(KEYS.aiConfig);
    await secureBackend.removeItem(KEYS.aiApiKey);
    if (secureBackend !== fallbackBackend) {
      await fallbackBackend.removeItem(KEYS.aiApiKey);
    }
    _authGeneration += 1;
  });
}

export async function savePkceVerifier(verifier: string): Promise<void> {
  const clean = String(verifier || "").trim();
  _memPkceVerifier = clean;
  const backend = await getStorageBackend();
  if (clean) {
    await backend.setItem(KEYS.pkceVerifier, clean);
  } else {
    await backend.removeItem(KEYS.pkceVerifier);
  }
}

export async function peekPkceVerifier(): Promise<string> {
  let value = _memPkceVerifier;
  if (!value) {
    const backend = await getStorageBackend();
    value = (await backend.getItem(KEYS.pkceVerifier)) || "";
    if (value) _memPkceVerifier = value.trim();
  }
  return value.trim();
}

export async function clearPkceVerifier(): Promise<void> {
  _memPkceVerifier = "";
  const backend = await getStorageBackend();
  await backend.removeItem(KEYS.pkceVerifier);
}

export async function consumePkceVerifier(): Promise<string> {
  const value = await peekPkceVerifier();
  await clearPkceVerifier();
  return value;
}

async function _setOfflineQueueUnlocked(queue: QueuedLinkPayload[]): Promise<void> {
  await writeJson(KEYS.offlineQueue, queue);
}

export async function loadOfflineQueue(expectedUserId?: string): Promise<QueuedLinkPayload[]> {
  return runSerializedAuthStorage(async () => {
    const rows = await readJson<QueuedLinkPayload[]>(KEYS.offlineQueue, []);
    if (!Array.isArray(rows)) return [];
    let uid = String(expectedUserId ?? "").trim();
    if (expectedUserId === undefined) {
      const session = await _loadSessionUnlocked().catch(() => null);
      uid = resolveSessionUserId(session) || _activeUserId;
    }
    if (!uid) {
      return rows.filter((item) => !item?.user_id);
    }
    return rows.filter((item) => Boolean(item?.user_id) && String(item.user_id).trim() === uid);
  });
}

export async function setOfflineQueue(queue: QueuedLinkPayload[]): Promise<void> {
  return runSerializedAuthStorage(() => _setOfflineQueueUnlocked(queue));
}

export async function enqueueOfflineItem(
  payload: Omit<QueuedLinkPayload, "client_id" | "queued_at"> & { client_id?: string; queued_at?: string },
): Promise<QueuedLinkPayload[]> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return [];
    }
    const session = await _loadSessionUnlocked().catch(() => null);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return [];
    }
    const uid = String(payload.user_id ?? (resolveSessionUserId(session) || _activeUserId)).trim();
    const allRows = await readJson<QueuedLinkPayload[]>(KEYS.offlineQueue, []);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return [];
    }
    const safeAll = Array.isArray(allRows) ? allRows : [];
    const foreignRows = uid
      ? safeAll.filter((item) => Boolean(item?.user_id) && String(item.user_id).trim() !== uid)
      : safeAll.filter((item) => Boolean(item?.user_id));
    const ownCurrent = uid
      ? safeAll.filter((item) => Boolean(item?.user_id) && String(item.user_id).trim() === uid)
      : safeAll.filter((item) => !item?.user_id);
    const entry: QueuedLinkPayload = {
      ...payload,
      user_id: uid || undefined,
      client_id: payload.client_id || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      queued_at: payload.queued_at || new Date().toISOString(),
    };
    const deduped = ownCurrent.filter((item) => item.url !== entry.url);
    const next = [entry, ...deduped, ...foreignRows].slice(0, 100);
    await _setOfflineQueueUnlocked(next);
    return [entry, ...deduped].slice(0, 100);
  });
}

export type OfflineFlushOutcome = boolean | "ok" | "retry" | "drop";

export function classifyQueueFlushStatus(httpStatus: number): "ok" | "retry" | "drop" {
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 404 || httpStatus === 422) {
    return "drop";
  }
  return "retry";
}

function getQueueEntryKey(entry: Partial<QueuedLinkPayload>): string {
  return String(entry?.client_id || `${entry?.user_id || ""}::${entry?.url || ""}::${entry?.queued_at || ""}`);
}

export async function flushOfflineQueueWithSender(
  sender: (item: QueuedLinkPayload) => Promise<OfflineFlushOutcome>,
): Promise<{ flushed: number; remaining: number; dropped: number; failed: QueuedLinkPayload[] }> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  const prep = await runSerializedAuthStorage<{
    earlyResult?: { flushed: number; remaining: number; dropped: number; failed: QueuedLinkPayload[] };
    currentUid?: string;
    queue?: QueuedLinkPayload[];
    removedKeys?: Set<string>;
  }>(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return { earlyResult: { flushed: 0, remaining: 0, dropped: 0, failed: [] } };
    }
    const session = await _loadSessionUnlocked().catch(() => null);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return { earlyResult: { flushed: 0, remaining: 0, dropped: 0, failed: [] } };
    }
    const currentUid = resolveSessionUserId(session) || _activeUserId;
    const allRows = await readJson<QueuedLinkPayload[]>(KEYS.offlineQueue, []);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return { earlyResult: { flushed: 0, remaining: 0, dropped: 0, failed: [] } };
    }
    const safeAll = Array.isArray(allRows) ? allRows : [];
    if (!safeAll.length) {
      return { earlyResult: { flushed: 0, remaining: 0, dropped: 0, failed: [] } };
    }

    const foreignRemaining: QueuedLinkPayload[] = [];
    const queue: QueuedLinkPayload[] = [];
    const removedKeys = new Set<string>();
    for (const entry of safeAll) {
      const entryUid = String(entry?.user_id || "").trim();
      if (!currentUid) {
        if (!entryUid) queue.push(entry);
        else foreignRemaining.push(entry);
      } else if (!entryUid) {
        removedKeys.add(getQueueEntryKey(entry));
        continue; // Drop legacy unstamped entries when authenticated
      } else if (entryUid !== currentUid) {
        foreignRemaining.push(entry);
      } else {
        queue.push(entry);
      }
    }

    if (!queue.length) {
      if (foreignRemaining.length !== safeAll.length) {
        await _setOfflineQueueUnlocked(safeAll.filter((item) => !removedKeys.has(getQueueEntryKey(item))));
      }
      return { earlyResult: { flushed: 0, remaining: 0, dropped: 0, failed: [] } };
    }
    return { currentUid, queue, removedKeys };
  });

  if (prep.earlyResult) {
    return prep.earlyResult;
  }

  const currentUid = prep.currentUid || "";
  const queue = prep.queue || [];
  const removedKeys = prep.removedKeys || new Set<string>();

  const remaining: QueuedLinkPayload[] = [];
  let flushed = 0;
  let dropped = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const entry = queue[i];
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      remaining.push(...queue.slice(i));
      break;
    }
    try {
      const outcome = await sender(entry);
      if (outcome === true || outcome === "ok") {
        flushed += 1;
        removedKeys.add(getQueueEntryKey(entry));
      } else if (outcome === "drop") {
        dropped += 1;
        removedKeys.add(getQueueEntryKey(entry));
      } else {
        remaining.push(entry);
      }
    } catch {
      remaining.push(entry);
    }
  }

  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return { flushed, remaining: remaining.length, dropped, failed: remaining };
    }
    const latestSession = await _loadSessionUnlocked().catch(() => null);
    const latestUid = resolveSessionUserId(latestSession) || _activeUserId;
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch || latestUid !== currentUid) {
      return { flushed, remaining: remaining.length, dropped, failed: remaining };
    }
    const latestRows = await readJson<QueuedLinkPayload[]>(KEYS.offlineQueue, []);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return { flushed, remaining: remaining.length, dropped, failed: remaining };
    }
    const safeLatest = Array.isArray(latestRows) ? latestRows : [];
    const nextQueue = safeLatest.filter((item) => {
      const itemUid = String(item?.user_id || "").trim();
      if (currentUid && !itemUid) return false;
      return !removedKeys.has(getQueueEntryKey(item));
    });
    await _setOfflineQueueUnlocked(nextQueue);
    return { flushed, remaining: remaining.length, dropped, failed: remaining };
  });
}

export function getMemoryCachedWorkspace(): CachedWorkspace | null {
  if (!_memWorkspaceCache) return null;
  const cacheUid = String(_memWorkspaceCache.user_id || "").trim();
  if (!cacheUid || !_activeUserId || cacheUid !== _activeUserId) {
    return null;
  }
  return _memWorkspaceCache;
}

export async function loadCachedWorkspace(): Promise<CachedWorkspace> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    const session = await _loadSessionUnlocked().catch(() => null);
    const currentUid = resolveSessionUserId(session) || _activeUserId;
    const empty: CachedWorkspace = {
      user_id: currentUid || undefined,
      items: [],
      folders: [],
      reminders: [],
      updated_at: "",
    };
    if (!currentUid || _authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      if (!currentUid) _memWorkspaceCache = null;
      return empty;
    }
    _activeUserId = currentUid;
    if (_memWorkspaceCache) {
      const cacheUid = String(_memWorkspaceCache.user_id || "").trim();
      if (!cacheUid || cacheUid !== currentUid) {
        _memWorkspaceCache = null;
      } else {
        return _memWorkspaceCache;
      }
    }
    const data = await readJson<CachedWorkspace>(KEYS.cache, empty);
    const dataUid = String(data.user_id || "").trim();
    if (!dataUid || dataUid !== currentUid || _authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return empty;
    }
    if (data.updated_at || data.items.length > 0 || data.folders.length > 0) {
      _memWorkspaceCache = data;
    }
    return data;
  });
}

export async function saveCachedWorkspace(data: Omit<CachedWorkspace, "updated_at">): Promise<void> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return;
    }
    const session = await _loadSessionUnlocked().catch(() => null);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return;
    }
    const liveUid = String(resolveSessionUserId(session) || _activeUserId).trim();
    if (!liveUid) {
      return;
    }
    const requestedUid = String(data.user_id ?? "").trim();
    if (requestedUid && requestedUid !== liveUid) {
      return;
    }
    const currentUid = requestedUid || liveUid;
    const stamped: CachedWorkspace = {
      ...data,
      user_id: currentUid,
      updated_at: new Date().toISOString(),
    };
    const backend = await getStorageBackend();
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return;
    }
    _activeUserId = currentUid;
    _memWorkspaceCache = stamped;
    await backend.setItem(KEYS.cache, JSON.stringify(stamped));
  });
}

async function mutateCachedWorkspace(
  mutator: (current: CachedWorkspace) => CachedWorkspace | null,
): Promise<void> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return;
    }
    const session = await _loadSessionUnlocked().catch(() => null);
    const currentUid = resolveSessionUserId(session) || _activeUserId;
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch || !currentUid) {
      return;
    }
    if (_memWorkspaceCache) {
      const memUid = String(_memWorkspaceCache.user_id || "").trim();
      if (memUid && memUid === currentUid) {
        const nextMem = mutator(_memWorkspaceCache);
        if (nextMem) {
          _memWorkspaceCache = { ...nextMem, user_id: currentUid, updated_at: new Date().toISOString() };
        }
      } else if (memUid && memUid !== currentUid) {
        _memWorkspaceCache = null;
      }
    }
    const existing = await readJson<CachedWorkspace | null>(KEYS.cache, null);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return;
    }
    const existingUid = String(existing?.user_id || "").trim();
    if (existing && existingUid === currentUid) {
      const nextDisk = mutator(existing);
      if (nextDisk) {
        await writeJson(KEYS.cache, { ...nextDisk, user_id: currentUid, updated_at: new Date().toISOString() });
      }
    }
  });
}

export async function removeCachedLinkItem(itemId: string): Promise<void> {
  const targetId = String(itemId || "").trim();
  if (!targetId) return;
  return mutateCachedWorkspace((ws) => {
    if (!Array.isArray(ws.items)) return null;
    return {
      ...ws,
      items: ws.items.filter((it) => it.id !== targetId),
    };
  });
}

export async function upsertCachedLinkItem(updatedItem: MobileLinkItem): Promise<void> {
  const targetId = String(updatedItem?.id || "").trim();
  if (!targetId) return;
  return mutateCachedWorkspace((ws) => {
    const items = Array.isArray(ws.items) ? ws.items : [];
    const idx = items.findIndex((it) => it.id === targetId);
    const nextItems =
      idx >= 0
        ? items.map((it, i) => (i === idx ? { ...it, ...updatedItem } : it))
        : [updatedItem, ...items];
    return { ...ws, items: nextItems };
  });
}

export async function updateCachedReminders(reminders: MobileReminderItem[]): Promise<void> {
  return mutateCachedWorkspace((ws) => ({
    ...ws,
    reminders: Array.isArray(reminders) ? reminders : [],
  }));
}

export async function upsertCachedReminder(reminder: MobileReminderItem): Promise<void> {
  const targetId = String(reminder?.item_id || "").trim();
  if (!targetId) return;
  return mutateCachedWorkspace((ws) => {
    const existing = Array.isArray(ws.reminders) ? ws.reminders : [];
    const idx = existing.findIndex((r) => r.item_id === targetId);
    const normalized: MobileReminderItem = { ...reminder, item_id: targetId };
    const nextReminders =
      idx >= 0
        ? existing.map((r, i) => (i === idx ? { ...r, ...normalized } : r))
        : [normalized, ...existing];
    return { ...ws, reminders: nextReminders };
  });
}

export async function removeCachedReminderByItemId(itemId: string): Promise<void> {
  const targetId = String(itemId || "").trim();
  if (!targetId) return;
  return mutateCachedWorkspace((ws) => {
    if (!Array.isArray(ws.reminders)) return null;
    return {
      ...ws,
      reminders: ws.reminders.filter((r) => r.item_id !== targetId),
    };
  });
}

export async function mergeCachedReminders(updates: MobileReminderItem[]): Promise<void> {
  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return;
  return mutateCachedWorkspace((ws) => {
    const existing = Array.isArray(ws.reminders) ? ws.reminders : [];
    const byItem = new Map<string, MobileReminderItem>();
    for (const rem of existing) {
      const id = String(rem?.item_id || "").trim();
      if (id) byItem.set(id, rem);
    }
    for (const rem of list) {
      const id = String(rem?.item_id || "").trim();
      if (!id) continue;
      const prev = byItem.get(id);
      byItem.set(id, prev ? { ...prev, ...rem, item_id: id } : { ...rem, item_id: id });
    }
    return { ...ws, reminders: Array.from(byItem.values()) };
  });
}

export async function saveRegisteredPushDevice(
  device: Omit<RegisteredPushDevice, "user_id">,
): Promise<void> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
    const session = await _loadSessionUnlocked().catch(() => null);
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
    const uid = resolveSessionUserId(session) || _activeUserId;
    if (!uid) return;
    const record: RegisteredPushDevice = { ...device, user_id: uid };
    await writeJson(KEYS.pushDevice, record);
  });
}

export async function loadRegisteredPushDevice(): Promise<RegisteredPushDevice | null> {
  return runSerializedAuthStorage(async () => {
    const session = await _loadSessionUnlocked().catch(() => null);
    const uid = resolveSessionUserId(session) || _activeUserId;
    if (!uid) return null;
    const data = await readJson<RegisteredPushDevice | null>(KEYS.pushDevice, null);
    if (!data || String(data.user_id || "").trim() !== uid) return null;
    return data;
  });
}

export async function clearRegisteredPushDevice(): Promise<void> {
  return runSerializedAuthStorage(async () => {
    const backend = await getStorageBackend();
    await backend.removeItem(KEYS.pushDevice);
  });
}

export interface AuthDebugEvent {
  at: string;
  stage: string;
  detail: string;
}

const MAX_DEBUG_EVENTS = 25;
let _authDebugEvents: AuthDebugEvent[] = [];
type DebugListener = (events: AuthDebugEvent[]) => void;
const _debugListeners = new Set<DebugListener>();

function redactAuthSensitive(text: string): string {
  return String(text || "")
    .replace(
      /(access_token|refresh_token|id_token|code|code_verifier|token|api_key|secret|password)=([^&#\s]+)/gi,
      (_m, key) => `${key}=***`,
    )
    .replace(/(\/invite\/)([A-Za-z0-9_-]+)/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}

export function recordAuthDebugEvent(stage: string, detail = ""): void {
  const entry: AuthDebugEvent = {
    at: new Date().toLocaleTimeString("th-TH", { hour12: false }),
    stage: String(stage || "event"),
    detail: redactAuthSensitive(detail).slice(0, 180),
  };
  _authDebugEvents = [entry, ..._authDebugEvents].slice(0, MAX_DEBUG_EVENTS);
  for (const listener of _debugListeners) {
    listener(_authDebugEvents);
  }
}

export function getAuthDebugEvents(): AuthDebugEvent[] {
  return _authDebugEvents;
}

export function clearAuthDebugEvents(): void {
  _authDebugEvents = [];
  for (const listener of _debugListeners) {
    listener(_authDebugEvents);
  }
}

export function subscribeAuthDebugEvents(listener: DebugListener): () => void {
  _debugListeners.add(listener);
  return () => {
    _debugListeners.delete(listener);
  };
}

let _debugBannerEnabled = false;
type BannerListener = (enabled: boolean) => void;
const _bannerListeners = new Set<BannerListener>();

export function getDebugBannerEnabled(): boolean {
  return _debugBannerEnabled;
}

export function setDebugBannerEnabled(enabled: boolean): void {
  _debugBannerEnabled = Boolean(enabled);
  for (const listener of _bannerListeners) {
    listener(_debugBannerEnabled);
  }
}

export function subscribeDebugBanner(listener: BannerListener): () => void {
  _bannerListeners.add(listener);
  return () => {
    _bannerListeners.delete(listener);
  };
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

type FigmaAccentListener = (id: FigmaAccentThemeId) => void;
const _figmaThemeListeners = new Set<FigmaAccentListener>();

export function subscribeFigmaAccentTheme(listener: FigmaAccentListener): () => void {
  _figmaThemeListeners.add(listener);
  return () => {
    _figmaThemeListeners.delete(listener);
  };
}

export async function loadFigmaAccentTheme(): Promise<FigmaAccentThemeId> {
  const backend = await getStorageBackend();
  const raw = await backend.getItem(KEYS.figmaTheme);
  if (raw === "christmas" || raw === "collab" || raw === "sharely") return raw;
  return "sharely";
}

export async function saveFigmaAccentTheme(id: FigmaAccentThemeId): Promise<void> {
  const backend = await getStorageBackend();
  await backend.setItem(KEYS.figmaTheme, id);
  for (const listener of _figmaThemeListeners) {
    listener(id);
  }
}

function defaultBuiltInAiConfig(): MobileAiConfig {
  return {
    provider: "built-in",
    vendor: "built-in",
    model: "gemini-3.1-flash-lite",
    base_url: "",
    api_key: "",
    keyless: false,
  };
}

export async function loadAiConfig(): Promise<MobileAiConfig> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return defaultBuiltInAiConfig();
    }
    const backend = await getStorageBackend();
    const secureBackend = await getSecureSessionBackend();
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return defaultBuiltInAiConfig();
    }
    let parsed: Partial<MobileAiConfig> = {};
    try {
      const raw = await backend.getItem(KEYS.aiConfig);
      if (raw) parsed = JSON.parse(raw) as Partial<MobileAiConfig>;
    } catch {}
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return defaultBuiltInAiConfig();
    }
    let apiKey = "";
    try {
      apiKey = (await secureBackend.getItem(KEYS.aiApiKey)) || "";
    } catch {}
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) {
      return defaultBuiltInAiConfig();
    }
    const prov = parsed.provider === "byok" || parsed.provider === "custom" ? parsed.provider : "built-in";
    return {
      provider: prov,
      vendor: parsed.vendor || (prov === "built-in" ? "built-in" : "openai"),
      model: parsed.model || (prov === "built-in" ? "gemini-3.1-flash-lite" : "gpt-4o-mini"),
      base_url: parsed.base_url || "",
      api_key: apiKey,
      keyless: Boolean(parsed.keyless),
    };
  });
}

export async function saveAiConfig(cfg: MobileAiConfig): Promise<void> {
  const startGen = _authGeneration;
  const startClearEpoch = _clearEpoch;
  return runSerializedAuthStorage(async () => {
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
    const backend = await getStorageBackend();
    const secureBackend = await getSecureSessionBackend();
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
    const isKeylessCustom = cfg.provider === "custom" && Boolean(cfg.keyless);
    const meta: Omit<MobileAiConfig, "api_key"> = {
      provider: cfg.provider,
      vendor: cfg.vendor || (cfg.provider === "built-in" ? "built-in" : "openai"),
      model: cfg.model || "",
      base_url: cfg.base_url || "",
      keyless: isKeylessCustom,
    };
    await backend.setItem(KEYS.aiConfig, JSON.stringify(meta));
    if (_authGeneration !== startGen || _clearEpoch !== startClearEpoch) return;
    const cleanKey = String(cfg.api_key || "").trim();
    if (cleanKey && cfg.provider !== "built-in" && !isKeylessCustom) {
      await secureBackend.setItem(KEYS.aiApiKey, cleanKey);
    } else {
      await secureBackend.removeItem(KEYS.aiApiKey);
    }
  });
}

export const DEFAULT_ANDROID_BINDER_MAX_CHARS = 250_000;

export function csvCell(val: unknown): string {
  const s = String(val ?? "");
  const neutralized = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function buildBoundedCsvExport(
  items: MobileLinkItem[],
  maxChars: number = DEFAULT_ANDROID_BINDER_MAX_CHARS,
): {
  csv: string;
  truncated: boolean;
  exportedCount: number;
  totalCount: number;
} {
  const bom = "\uFEFF";
  const header = "title,url,platform,status,favorite,note,tags,saved_at";
  const lines = [bom + header];
  let totalLen = lines[0].length;
  let exportedCount = 0;
  let truncated = false;

  for (const it of items) {
    const row = [
      csvCell(it.title || ""),
      csvCell(it.url || ""),
      csvCell(it.platform || ""),
      csvCell(it.status || "inbox"),
      csvCell(it.is_favorite ? "true" : "false"),
      csvCell(it.note || it.user_note || ""),
      csvCell((it.tags || it.tag_names || []).join(";")),
      csvCell(it.saved_at || ""),
    ].join(",");
    if (totalLen + 1 + row.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(row);
    totalLen += 1 + row.length;
    exportedCount += 1;
  }

  return {
    csv: lines.join("\n"),
    truncated,
    exportedCount,
    totalCount: items.length,
  };
}

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
