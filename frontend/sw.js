/**
 * Sharely / Just-Save-It Service Worker for RFC 8291 Web Push notifications.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_err) {
      payload = { body: event.data.text() };
    }
  }

  const title = String(payload.title || "Just-Save-It เตือนอ่านลิงก์").slice(0, 160);
  const body = String(payload.body || "ถึงเวลาทบทวนลิงก์ที่คุณบันทึกไว้แล้ว").slice(0, 400);
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const tag = String(data.reminder_id || data.item_id || "sharely-reminder");

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      data,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notifData = event.notification?.data || {};
  const itemId = typeof notifData.item_id === "string" ? notifData.item_id : "";
  const targetPath = itemId ? `/?item=${encodeURIComponent(itemId)}` : "/";
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && client.url.startsWith(self.location.origin) && "focus" in client) {
          if (itemId && "postMessage" in client) {
            client.postMessage({ type: "OPEN_ITEM", itemId });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
