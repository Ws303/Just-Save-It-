importScripts("api.js");

const MENU_SAVE_PAGE = "jsi-save-page";
const MENU_SAVE_LINK = "jsi-save-link";
const SYNC_ALARM_NAME = "jsi-sync-alarm";
const WEB_APP_URL = "https://just-save-it-web.onrender.com";

function setActionBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3500);
}

function ensureSyncAlarm() {
  if (chrome.alarms && typeof chrome.alarms.create === "function") {
    if (typeof chrome.alarms.get === "function") {
      chrome.alarms.get(SYNC_ALARM_NAME, (existing) => {
        if (!existing) {
          chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 5 });
        }
      });
    } else {
      chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 5 });
    }
  }
}

ensureSyncAlarm();

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: "บันทึกหน้านี้ลง Sherlink",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_LINK,
      title: "บันทึกลิงก์นี้ลง Sherlink",
      contexts: ["link"],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  ensureSyncAlarm();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    ensureSyncAlarm();
  });
}

async function runBackgroundSync() {
  const startGen = JustSaveItApi.getSessionGeneration();
  const startClearEpoch = JustSaveItApi.getClearEpoch ? JustSaveItApi.getClearEpoch() : 0;
  const session = await JustSaveItApi.getSessionState();
  if (!session.accessToken) return;

  try {
    const flushRes = await JustSaveItApi.flushOfflineQueue();
    if (flushRes.flushed > 0) {
      setActionBadge(`+${flushRes.flushed}`, "#16756a");
    }
  } catch (_err) {
    // Offline or temporarily unreachable; keep queued
  }

  if (
    JustSaveItApi.getSessionGeneration() !== startGen ||
    (JustSaveItApi.getClearEpoch && JustSaveItApi.getClearEpoch() !== startClearEpoch)
  ) {
    return;
  }

  try {
    const remRes = await JustSaveItApi.fetchReminders();
    if (
      JustSaveItApi.getSessionGeneration() !== startGen ||
      (JustSaveItApi.getClearEpoch && JustSaveItApi.getClearEpoch() !== startClearEpoch)
    ) {
      return;
    }
    const reminders = Array.isArray(remRes && remRes.reminders) ? remRes.reminders : Array.isArray(remRes) ? remRes : [];
    await JustSaveItApi.syncNotifiedReminders(reminders, {
      expectedGen: startGen,
      expectedClearEpoch: startClearEpoch,
      onNotify(rem) {
        if (chrome.notifications && typeof chrome.notifications.create === "function") {
          const itemId = rem.item_id || "";
          chrome.notifications.create(`jsi_rem::${itemId}::${rem.id}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "เตือนความจำจาก Sherlink",
            message: rem.title_snapshot || "ถึงเวลาดูลิงก์ที่บันทึกไว้แล้ว",
            priority: 1,
          });
        }
      },
    });
  } catch (_err) {
    // Ignore transient network errors during background alarm
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === SYNC_ALARM_NAME) {
      return runBackgroundSync();
    }
  });
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((notifId) => {
    chrome.notifications.clear(notifId);
    const parts = String(notifId || "").split("::");
    const itemId = parts[0] === "jsi_rem" && parts[1] ? parts[1] : "";
    const targetUrl = itemId ? `${WEB_APP_URL}/?item=${encodeURIComponent(itemId)}` : WEB_APP_URL;
    chrome.tabs.create({ url: targetUrl });
  });
}

function isConnectMsg(message) {
  return Boolean(
    message &&
      (message.type === "SHERLINK_EXTENSION_CONNECT" || message.type === "SHARELY_EXTENSION_CONNECT")
  );
}

async function handleConnectMessage(message) {
  if (!isConnectMsg(message) || !message.accessToken) {
    return { ok: false, error: "Invalid message" };
  }
  const user = await JustSaveItApi.loginWithAccessToken(
    message.accessToken,
    message.refreshToken || "",
    message.apiBaseUrl || ""
  );
  setActionBadge("SYNC", "#16756a");
  return { ok: true, user };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isConnectMsg(message)) {
    handleConnectMessage(message)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message && message.type === "JSI_FLUSH_QUEUE") {
    JustSaveItApi.flushOfflineQueue()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
    if (isConnectMsg(message)) {
      handleConnectMessage(message)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });
}

async function quickSaveUrl({ url, tabId = null, fallbackTitle = "", selectionText = "" }) {
  if (!JustSaveItApi.isSaveableHttpUrl(url)) {
    setActionBadge("URL", "#61666b");
    return;
  }
  if (
    typeof JustSaveItApi.getSocialPostLinkWarning === "function" &&
    JustSaveItApi.getSocialPostLinkWarning(url)
  ) {
    setActionBadge("LINK", "#d97706");
    try {
      await chrome.action.openPopup();
    } catch (_err) {
      // openPopup may require direct user gesture
    }
    return;
  }

  const startGen = typeof JustSaveItApi.getSessionGeneration === "function" ? JustSaveItApi.getSessionGeneration() : 0;
  const session = await JustSaveItApi.getSessionState();
  if (!session.accessToken) {
    setActionBadge("AUTH", "#ba0e1a");
    try {
      await chrome.action.openPopup();
    } catch (_err) {
      // openPopup may require direct user gesture on some browsers
    }
    return;
  }
  const startUid = String((session.user && session.user.id) || "").trim();

  let domMeta = null;
  if (tabId) {
    try {
      domMeta = await JustSaveItApi.runDomAssist(tabId);
    } catch (_err) {
      domMeta = null;
    }
  }

  const sessionBeforeSave = await JustSaveItApi.getSessionState();
  const uidBeforeSave = String((sessionBeforeSave.user && sessionBeforeSave.user.id) || "").trim();
  if (
    (typeof JustSaveItApi.getSessionGeneration === "function" && JustSaveItApi.getSessionGeneration() !== startGen) ||
    !sessionBeforeSave.accessToken ||
    (startUid && uidBeforeSave !== startUid)
  ) {
    return;
  }

  const cleanFallbackTitle =
    fallbackTitle &&
    (typeof JustSaveItApi.isGenericPlatformTitle !== "function" ||
      !JustSaveItApi.isGenericPlatformTitle(fallbackTitle, url))
      ? fallbackTitle
      : undefined;

  const payload = {
    url: url.trim(),
    title: (domMeta && domMeta.url === url && domMeta.title) || cleanFallbackTitle,
    description: (domMeta && domMeta.url === url && domMeta.description) || undefined,
    note: (selectionText || (domMeta && domMeta.selected_text) || "").trim() || undefined,
    media_items:
      domMeta && domMeta.url === url && Array.isArray(domMeta.media_items) && domMeta.media_items.length
        ? domMeta.media_items
        : undefined,
    status: "inbox",
  };

  try {
    setActionBadge("...", "#1e1e1e");
    await JustSaveItApi.apiRequest("/api/items", {
      method: "POST",
      body: payload,
    });
    setActionBadge("OK", "#16756a");
  } catch (err) {
    if (err && err.aborted) {
      return;
    }
    if (err && err.status === 401) {
      const latestOn401 = await JustSaveItApi.getSessionState();
      const latestUidOn401 = String((latestOn401.user && latestOn401.user.id) || "").trim();
      if (
        !latestOn401.accessToken ||
        (startUid && latestUidOn401 === startUid) ||
        latestOn401.accessToken === session.accessToken
      ) {
        setActionBadge("AUTH", "#ba0e1a");
      }
      return;
    }
    const latestAfterErr = await JustSaveItApi.getSessionState();
    const latestUidAfterErr = String((latestAfterErr.user && latestAfterErr.user.id) || "").trim();
    if (
      (typeof JustSaveItApi.getSessionGeneration === "function" && JustSaveItApi.getSessionGeneration() !== startGen) ||
      !latestAfterErr.accessToken ||
      (startUid && latestUidAfterErr !== startUid)
    ) {
      return;
    }
    if (!err.status || err.status >= 500 || err.status === 429) {
      await JustSaveItApi.enqueueOfflineSave(payload, err.message || "network");
      setActionBadge("QUE", "#6f42c1");
    } else {
      setActionBadge("ERR", "#ba0e1a");
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.menuItemId === MENU_SAVE_LINK ? info.linkUrl : info.pageUrl || (tab && tab.url);
  await quickSaveUrl({
    url: targetUrl,
    tabId: info.menuItemId === MENU_SAVE_PAGE && tab ? tab.id : null,
    fallbackTitle: tab ? tab.title || "" : "",
    selectionText: info.selectionText || "",
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quick-save-tab") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  await quickSaveUrl({
    url: tab.url,
    tabId: tab.id || null,
    fallbackTitle: tab.title || "",
  });
});
