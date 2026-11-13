importScripts("api.js");

const MENU_SAVE_PAGE = "jsi-save-page";
const MENU_SAVE_LINK = "jsi-save-link";

function setActionBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3500);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: "บันทึกหน้านี้ลง Just-Save-It",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_LINK,
      title: "บันทึกลิงก์นี้ลง Just-Save-It",
      contexts: ["link"],
    });
  });
});

async function quickSaveUrl({ url, tabId = null, fallbackTitle = "", selectionText = "" }) {
  if (!JustSaveItApi.isSaveableHttpUrl(url)) {
    setActionBadge("URL", "#61666b");
    return;
  }

  const session = await JustSaveItApi.getSessionState();
  if (!session.accessToken) {
    setActionBadge("AUTH", "#c72d2d");
    try {
      await chrome.action.openPopup();
    } catch (_err) {
      // openPopup may fail without direct user gesture on some browsers
    }
    return;
  }

  let domMeta = null;
  if (tabId) {
    domMeta = await JustSaveItApi.runDomAssist(tabId);
  }

  const payload = {
    url: url.trim(),
    title: (domMeta && domMeta.url === url && domMeta.title) || fallbackTitle || undefined,
    description: (domMeta && domMeta.url === url && domMeta.description) || undefined,
    note: (selectionText || (domMeta && domMeta.selected_text) || "").trim() || undefined,
    media_items:
      domMeta && domMeta.url === url && Array.isArray(domMeta.media_items) && domMeta.media_items.length
        ? domMeta.media_items
        : undefined,
    status: "inbox",
  };

  try {
    setActionBadge("...", "#07112f");
    await JustSaveItApi.apiRequest("/api/items", {
      method: "POST",
      body: payload,
    });
    setActionBadge("OK", "#16756a");
  } catch (err) {
    setActionBadge(err.status === 401 ? "AUTH" : "ERR", "#c72d2d");
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
