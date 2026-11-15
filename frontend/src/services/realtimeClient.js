/**
 * Lightweight zero-dependency Supabase Realtime (Phoenix V1) + BroadcastChannel sync client.
 * Subscribes to postgres_changes on items, folders, folder_members, and reminders,
 * debouncing workspace refreshes at 600ms so bursts coalesce into one reload.
 */

const CHANNEL_NAME = "sharely-workspace-sync";

let ws = null;
let bc = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let debounceTimer = null;
let reconnectAttempt = 0;
let refCounter = 1;
let running = false;
let currentOptions = null;

function nextRef() {
  refCounter += 1;
  return String(refCounter);
}

function clearTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleSync(reason = "realtime") {
  if (!running || !currentOptions?.onSync) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (running && currentOptions?.onSync) {
      Promise.resolve(currentOptions.onSync(reason)).catch(() => {});
    }
  }, 600);
}

function connectWebSocket() {
  if (!running || typeof WebSocket === "undefined" || !currentOptions) return;
  if (typeof currentOptions.isAuthenticated === "function" && !currentOptions.isAuthenticated()) {
    return;
  }
  const supa = typeof currentOptions.getSupabaseConfig === "function" ? currentOptions.getSupabaseConfig() : null;
  const baseUrl = String(supa?.url || "").trim();
  const anonKey = String(supa?.anonKey || "").trim();
  if (!baseUrl || !anonKey) return;

  const wsUrl =
    baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "") +
    `/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    const token =
      (typeof currentOptions?.getAccessToken === "function" ? currentOptions.getAccessToken() : "") || anonKey;
    try {
      ws.send(
        JSON.stringify({
          topic: "realtime:public",
          event: "phx_join",
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: "" },
              postgres_changes: [
                { event: "*", schema: "public", table: "items" },
                { event: "*", schema: "public", table: "folders" },
                { event: "*", schema: "public", table: "folder_members" },
                { event: "*", schema: "public", table: "reminders" },
              ],
            },
            access_token: token,
          },
          ref: nextRef(),
        })
      );
      if (token && token !== anonKey) {
        ws.send(
          JSON.stringify({
            topic: "realtime:public",
            event: "access_token",
            payload: { access_token: token },
            ref: nextRef(),
          })
        );
      }
    } catch {
      // ignore send race on closing socket
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }));
        } catch {
          // ignore
        }
      }
    }, 30000);
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (
        msg?.event === "postgres_changes" ||
        msg?.event === "INSERT" ||
        msg?.event === "UPDATE" ||
        msg?.event === "DELETE"
      ) {
        scheduleSync("realtime");
      }
    } catch {
      // ignore malformed frames
    }
  });

  const handleDisconnect = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    ws = null;
    if (!running) return;
    if (typeof currentOptions?.isAuthenticated === "function" && !currentOptions.isAuthenticated()) return;
    const delayMs = Math.min(30000, 1500 * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delayMs);
  };

  ws.addEventListener("close", handleDisconnect);
  ws.addEventListener("error", () => {
    try {
      ws?.close();
    } catch {
      handleDisconnect();
    }
  });
}

export function startRealtimeSync(options) {
  stopRealtimeSync();
  running = true;
  currentOptions = options || null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      bc = new BroadcastChannel(CHANNEL_NAME);
      bc.addEventListener("message", (ev) => {
        if (ev?.data?.type === "WORKSPACE_CHANGED") {
          scheduleSync("broadcast");
        }
      });
    } catch {
      bc = null;
    }
  }
  connectWebSocket();
}

export function refreshRealtimeAccessToken(token) {
  if (!ws || ws.readyState !== 1 || !token) return;
  try {
    ws.send(
      JSON.stringify({
        topic: "realtime:public",
        event: "access_token",
        payload: { access_token: token },
        ref: nextRef(),
      })
    );
  } catch {
    // ignore
  }
}

export function broadcastLocalChange(reason = "mutation") {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = bc || new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage({ type: "WORKSPACE_CHANGED", reason, ts: Date.now() });
    if (!bc) ch.close();
  } catch {
    // ignore
  }
}

export function stopRealtimeSync() {
  running = false;
  clearTimers();
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
  if (bc) {
    try {
      bc.close();
    } catch {
      // ignore
    }
    bc = null;
  }
  reconnectAttempt = 0;
}
