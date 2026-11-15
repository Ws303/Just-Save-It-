(function () {
  "use strict";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.type !== "SHARELY_EXTENSION_CONNECT" || !msg.accessToken) return;
    try {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
      });
    } catch (_err) {
      // Ignore if extension context reloaded
    }
  });
})();
