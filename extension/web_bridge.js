(function () {
  "use strict";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    const isConnect = msg && (msg.type === "SHERLINK_EXTENSION_CONNECT" || msg.type === "SHARELY_EXTENSION_CONNECT");
    if (!isConnect || !msg.accessToken) return;
    try {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
      });
    } catch (_err) {
      // Ignore if extension context reloaded
    }
  });
})();
