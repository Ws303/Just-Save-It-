/**
 * Browser Web Push (Service Worker + PushManager VAPID) client helpers.
 */

export function urlBase64ToUint8Array(base64Url) {
  const clean = String(base64Url || "").trim();
  const padding = "=".repeat((4 - (clean.length % 4)) % 4);
  const base64 = (clean + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function isWebPushSupported() {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getWebPushPermission() {
  if (!isWebPushSupported()) return "unsupported";
  return Notification.permission;
}

async function getRegisteredWorker() {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function enableWebPush({ fetchPushConfig, registerDevice }) {
  if (!isWebPushSupported()) {
    return { ok: false, reason: "unsupported", message: "เบราว์เซอร์นี้ไม่รองรับ Web Push" };
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return {
      ok: false,
      reason: "permission_denied",
      message: "กรุณาอนุญาตการแจ้งเตือนในเบราว์เซอร์ก่อนเปิดใช้งาน",
    };
  }

  const config = await fetchPushConfig();
  if (!config?.enabled || !config?.vapid_public_key) {
    return {
      ok: false,
      reason: "server_not_configured",
      message: "บันทึกการตั้งค่าแล้ว (เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า VAPID Key)",
    };
  }

  await getRegisteredWorker();
  const readyReg = await navigator.serviceWorker.ready;
  let sub = await readyReg.pushManager.getSubscription();
  if (!sub) {
    sub = await readyReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key),
    });
  }

  const subJson = typeof sub.toJSON === "function" ? sub.toJSON() : {};
  const payload = {
    platform: "web",
    delivery_mode: "remote",
    push_token: subJson.endpoint || sub.endpoint || null,
    web_push_sub: subJson,
    is_active: true,
  };
  const regRes = await registerDevice(payload);
  if (!regRes?.ok) {
    return {
      ok: false,
      reason: "register_failed",
      message: regRes?.error || "ลงทะเบียนอุปกรณ์ Web Push ไม่สำเร็จ",
    };
  }
  return { ok: true, endpoint: payload.push_token, subscription: subJson };
}

export async function getActiveWebPushEndpoint() {
  if (!isWebPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub?.endpoint || null;
  } catch {
    return null;
  }
}

export async function disableWebPush({ deactivateDevice, unsubscribeBrowser = false } = {}) {
  let endpoint = null;
  if (isWebPushSupported()) {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      endpoint = sub?.endpoint || null;
      if (sub && unsubscribeBrowser) {
        await sub.unsubscribe().catch(() => {});
      }
    } catch {
      endpoint = null;
    }
  }
  if (typeof deactivateDevice === "function") {
    await deactivateDevice({ endpoint, platform: "web" }).catch(() => ({ ok: false }));
  }
  return { ok: true, endpoint };
}
