(function () {
  "use strict";

  const api = window.JustSaveItApi;
  const CLOUD_WEB_URL = "https://just-save-it-web.onrender.com";

  const state = {
    authMode: "login",
    activeViewMode: "save", // "save" | "recent"
    domMeta: null,
    previewMeta: null,
    lastSavedItemId: null,
    activeTabId: null,
    allRecentItems: [],
    userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
  };

  const els = {
    healthBadge: document.getElementById("healthBadge"),
    openWebBtn: document.getElementById("openWebBtn"),
    toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    presetCloudBtn: document.getElementById("presetCloudBtn"),
    presetLocalBtn: document.getElementById("presetLocalBtn"),
    backendUrlInput: document.getElementById("backendUrlInput"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    feedbackBanner: document.getElementById("feedbackBanner"),

    authView: document.getElementById("authView"),
    webConnectBtn: document.getElementById("webConnectBtn"),
    tabLoginBtn: document.getElementById("tabLoginBtn"),
    tabRegisterBtn: document.getElementById("tabRegisterBtn"),
    authForm: document.getElementById("authForm"),
    displayNameGroup: document.getElementById("displayNameGroup"),
    displayNameInput: document.getElementById("displayNameInput"),
    emailInput: document.getElementById("emailInput"),
    passwordInput: document.getElementById("passwordInput"),
    authSubmitBtn: document.getElementById("authSubmitBtn"),
    tokenLoginInput: document.getElementById("tokenLoginInput"),
    tokenLoginBtn: document.getElementById("tokenLoginBtn"),
    localDemoSection: document.getElementById("localDemoSection"),
    demoLoginBtn: document.getElementById("demoLoginBtn"),

    saverView: document.getElementById("saverView"),
    userLabel: document.getElementById("userLabel"),
    logoutBtn: document.getElementById("logoutBtn"),
    tabSaveBtn: document.getElementById("tabSaveBtn"),
    tabRecentBtn: document.getElementById("tabRecentBtn"),
    recentCount: document.getElementById("recentCount"),
    offlineQueueBar: document.getElementById("offlineQueueBar"),
    offlineQueueCount: document.getElementById("offlineQueueCount"),
    flushQueueBtn: document.getElementById("flushQueueBtn"),

    savePane: document.getElementById("savePane"),
    blockedTabCard: document.getElementById("blockedTabCard"),
    openWebBlockedBtn: document.getElementById("openWebBlockedBtn"),
    previewImage: document.getElementById("previewImage"),
    previewPlaceholder: document.getElementById("previewPlaceholder"),
    platformBadge: document.getElementById("platformBadge"),
    contentTypeBadge: document.getElementById("contentTypeBadge"),
    previewSourceBadge: document.getElementById("previewSourceBadge"),
    siteNameLabel: document.getElementById("siteNameLabel"),
    urlInput: document.getElementById("urlInput"),
    refreshPreviewBtn: document.getElementById("refreshPreviewBtn"),
    titleInput: document.getElementById("titleInput"),

    saveForm: document.getElementById("saveForm"),
    folderSelect: document.getElementById("folderSelect"),
    toggleNewFolderBtn: document.getElementById("toggleNewFolderBtn"),
    newFolderBox: document.getElementById("newFolderBox"),
    newFolderEmoji: document.getElementById("newFolderEmoji"),
    newFolderName: document.getElementById("newFolderName"),
    createFolderBtn: document.getElementById("createFolderBtn"),
    tagsInput: document.getElementById("tagsInput"),
    tagSuggestions: document.getElementById("tagSuggestions"),
    noteInput: document.getElementById("noteInput"),
    statusSelect: document.getElementById("statusSelect"),
    reminderPreset: document.getElementById("reminderPreset"),
    customReminderGroup: document.getElementById("customReminderGroup"),
    customReminderInput: document.getElementById("customReminderInput"),
    saveItemBtn: document.getElementById("saveItemBtn"),

    savedResultCard: document.getElementById("savedResultCard"),
    savedMetaText: document.getElementById("savedMetaText"),
    aiSummarizeBtn: document.getElementById("aiSummarizeBtn"),
    aiResultBox: document.getElementById("aiResultBox"),

    recentPane: document.getElementById("recentPane"),
    recentSearchInput: document.getElementById("recentSearchInput"),
    refreshRecentBtn: document.getElementById("refreshRecentBtn"),
    recentList: document.getElementById("recentList"),
  };

  function showBanner(message, type = "info") {
    els.feedbackBanner.textContent = message;
    els.feedbackBanner.className = `banner ${type === "error" ? "banner-error" : "banner-info"}`;
    els.feedbackBanner.classList.remove("hidden");
  }

  function clearBanner() {
    els.feedbackBanner.classList.add("hidden");
    els.feedbackBanner.textContent = "";
  }

  function getWebAppOrigin() {
    return api.isLocalBackendUrl(els.backendUrlInput.value) ? "http://127.0.0.1:4173" : CLOUD_WEB_URL;
  }

  function openSharelyWeb() {
    chrome.tabs.create({ url: getWebAppOrigin() });
  }

  async function refreshOfflineQueueBanner() {
    if (!els.offlineQueueBar) return;
    const queue = await api.getOfflineQueue();
    if (queue.length > 0) {
      els.offlineQueueCount.textContent = String(queue.length);
      els.offlineQueueBar.classList.remove("hidden");
    } else {
      els.offlineQueueCount.textContent = "0";
      els.offlineQueueBar.classList.add("hidden");
    }
  }

  async function updateHealthStatus(overrideUrl) {
    els.healthBadge.textContent = "Checking...";
    els.healthBadge.className = "status-pill";
    try {
      const health = await api.checkHealth(overrideUrl);
      const modeLabel = health.storage_mode === "supabase" ? "Cloud Online" : "Local Dev";
      els.healthBadge.textContent = modeLabel;
      els.healthBadge.className = "status-pill status-online";
      return true;
    } catch (_err) {
      els.healthBadge.textContent = "Offline";
      els.healthBadge.className = "status-pill status-offline";
      return false;
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const isRegister = mode === "register";
    els.tabLoginBtn.classList.toggle("active", !isRegister);
    els.tabRegisterBtn.classList.toggle("active", isRegister);
    els.displayNameGroup.classList.toggle("hidden", !isRegister);
    els.authSubmitBtn.textContent = isRegister ? "สร้างบัญชีและเข้าสู่ระบบ" : "เข้าสู่ระบบ";
    clearBanner();
  }

  function setSaverPaneMode(mode) {
    state.activeViewMode = mode === "recent" ? "recent" : "save";
    const showRecent = state.activeViewMode === "recent";
    els.tabSaveBtn.classList.toggle("active", !showRecent);
    els.tabRecentBtn.classList.toggle("active", showRecent);
    els.savePane.classList.toggle("hidden", showRecent);
    els.recentPane.classList.toggle("hidden", !showRecent);
  }

  function renderPreviewThumbnail(imageUrl) {
    if (imageUrl && api.isSaveableHttpUrl(imageUrl)) {
      els.previewImage.src = imageUrl;
      els.previewImage.classList.remove("hidden");
      els.previewPlaceholder.classList.add("hidden");
      return;
    }
    els.previewImage.classList.add("hidden");
    els.previewImage.removeAttribute("src");
    els.previewPlaceholder.classList.remove("hidden");
  }

  function parseTagList() {
    return els.tagsInput.value
      .split(",")
      .map((t) => t.trim())
      .filter((t, idx, arr) => t && arr.indexOf(t) === idx);
  }

  function syncTagChipSelection() {
    const activeTags = new Set(parseTagList().map((t) => t.toLowerCase()));
    for (const chip of els.tagSuggestions.querySelectorAll(".tag-chip")) {
      const name = String(chip.dataset.tagName || "").toLowerCase();
      chip.classList.toggle("selected", activeTags.has(name));
    }
  }

  function toggleTagChip(tagName) {
    const current = parseTagList();
    const existsIdx = current.findIndex((t) => t.toLowerCase() === tagName.toLowerCase());
    if (existsIdx >= 0) {
      current.splice(existsIdx, 1);
    } else {
      current.push(tagName);
    }
    els.tagsInput.value = current.join(", ");
    syncTagChipSelection();
  }

  const STATUS_LABEL = {
    inbox: "กล่องเข้า",
    todo: "ต้องอ่าน",
    done: "อ่านแล้ว",
    archived: "เก็บถาวร",
  };

  function nextWorkflowStatus(current) {
    const order = ["inbox", "todo", "done"];
    const idx = order.indexOf(current);
    return order[(idx + 1) % order.length];
  }

  function renderRecentItems(items) {
    state.allRecentItems = Array.isArray(items) ? items : [];
    els.recentCount.textContent = String(state.allRecentItems.length);
    els.recentList.innerHTML = "";
    if (!state.allRecentItems.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "ยังไม่มีลิงก์ที่บันทึกไว้ — ลองกดบันทึกลิงก์แรกด้านบนได้เลย";
      els.recentList.appendChild(empty);
      return;
    }

    for (const item of state.allRecentItems) {
      const card = document.createElement("div");
      card.className = "recent-item";

      const head = document.createElement("div");
      head.className = "recent-item-head";

      const titleLink = document.createElement("a");
      titleLink.className = "recent-item-title";
      titleLink.textContent = item.title || item.url;
      titleLink.href = api.isSaveableHttpUrl(item.url) ? item.url : "#";
      titleLink.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (api.isSaveableHttpUrl(item.url)) {
          chrome.tabs.create({ url: item.url });
        }
      });

      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = "mini-action-btn";
      const curStatus = item.status || "inbox";
      statusBtn.textContent = STATUS_LABEL[curStatus] || curStatus;
      statusBtn.title = "คลิกเพื่อสลับสถานะ";
      statusBtn.addEventListener("click", async () => {
        const next = nextWorkflowStatus(curStatus);
        statusBtn.disabled = true;
        try {
          await api.updateItemStatus(item.id, next);
          item.status = next;
          statusBtn.textContent = STATUS_LABEL[next] || next;
        } catch (err) {
          showBanner(`เปลี่ยนสถานะไม่สำเร็จ: ${err.message}`, "error");
        } finally {
          statusBtn.disabled = false;
        }
      });

      head.appendChild(titleLink);
      head.appendChild(statusBtn);

      const foot = document.createElement("div");
      foot.className = "recent-item-foot";

      const sub = document.createElement("span");
      sub.className = "recent-item-sub";
      sub.textContent = `${item.platform || "web"} · ${item.enrich_status || "saved"}`;

      const actions = document.createElement("div");
      actions.className = "recent-item-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "mini-action-btn";
      copyBtn.textContent = "คัดลอก";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.url || "");
          copyBtn.textContent = "คัดลอกแล้ว";
          setTimeout(() => {
            copyBtn.textContent = "คัดลอก";
          }, 1500);
        } catch (_err) {
          showBanner("ไม่สามารถคัดลอก URL ได้", "error");
        }
      });

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "mini-action-btn";
      openBtn.textContent = "เปิดดู";
      openBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: `${getWebAppOrigin()}/?item=${encodeURIComponent(item.id)}` });
      });

      actions.appendChild(copyBtn);
      actions.appendChild(openBtn);
      foot.appendChild(sub);
      foot.appendChild(actions);

      card.appendChild(head);
      card.appendChild(foot);
      els.recentList.appendChild(card);
    }
  }

  async function refreshRecentList(search = "") {
    try {
      const itemsRes = await api.fetchRecentItems({ search, limit: 20 });
      renderRecentItems(itemsRes.items || []);
    } catch (err) {
      showBanner(`โหลดรายการล่าสุดไม่สำเร็จ: ${err.message}`, "error");
    }
  }

  async function loadUserWorkspace() {
    const [foldersRes, tagsRes, itemsRes] = await Promise.all([
      api.apiRequest("/api/folders"),
      api.apiRequest("/api/tags"),
      api.fetchRecentItems({ limit: 20 }),
    ]);

    const currentFolderId = els.folderSelect.value;
    els.folderSelect.innerHTML = '<option value="">-- ยังไม่เลือกโฟลเดอร์ --</option>';
    for (const folder of foldersRes.folders || []) {
      const opt = document.createElement("option");
      opt.value = folder.id;
      opt.textContent = `${folder.emoji || "📁"} ${folder.name}`;
      els.folderSelect.appendChild(opt);
    }
    if (currentFolderId) {
      els.folderSelect.value = currentFolderId;
    }

    els.tagSuggestions.innerHTML = "";
    for (const tag of (tagsRes.tags || []).slice(0, 12)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      btn.dataset.tagName = tag.name;
      btn.textContent = `#${tag.name}`;
      btn.addEventListener("click", () => toggleTagChip(tag.name));
      els.tagSuggestions.appendChild(btn);
    }
    syncTagChipSelection();

    renderRecentItems(itemsRes.items || []);
  }

  async function fetchPreviewForUrl(targetUrl, forceRefresh = false) {
    if (!api.isSaveableHttpUrl(targetUrl)) return;
    els.previewSourceBadge.textContent = "กำลังพรีวิว...";
    try {
      const preview = await api.apiRequest("/api/items/preview", {
        method: "POST",
        body: { url: targetUrl, force_refresh: forceRefresh },
      });
      state.previewMeta = preview;
      els.platformBadge.textContent = preview.platform || "web";
      els.contentTypeBadge.textContent = preview.content_type || "link";
      els.previewSourceBadge.textContent = preview.cached ? "จากแคช" : "ดึงสดสำเร็จ";

      if (preview.title && (!els.titleInput.value.trim() || forceRefresh)) {
        els.titleInput.value = preview.title;
      }
      if (preview.site_name) {
        els.siteNameLabel.textContent = preview.site_name;
      }

      const firstMedia =
        Array.isArray(preview.media_items) && preview.media_items[0] ? preview.media_items[0].url : null;
      const thumb = preview.thumbnail_url || firstMedia;
      if (thumb) {
        renderPreviewThumbnail(thumb);
      }
    } catch (_err) {
      els.previewSourceBadge.textContent = "ใช้ข้อมูลแท็บ";
    }
  }

  async function ensureDomAssistPermission(url) {
    if (!chrome.permissions || typeof chrome.permissions.contains !== "function") return true;
    try {
      const originPattern = new URL(url).origin + "/*";
      const has = await chrome.permissions.contains({ origins: [originPattern] });
      if (has) return true;
      return await chrome.permissions.request({ origins: [originPattern] });
    } catch (_err) {
      return false;
    }
  }

  async function populateActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const rawUrl = tab.url.trim();
    const saveable = api.isSaveableHttpUrl(rawUrl);
    els.blockedTabCard.classList.toggle("hidden", saveable);
    if (!saveable) {
      els.platformBadge.textContent = "browser";
      els.contentTypeBadge.textContent = "blocked";
      els.previewSourceBadge.textContent = "ไม่รองรับแท็บนี้";
      els.siteNameLabel.textContent = tab.title || "แท็บระบบเบราว์เซอร์";
      return;
    }

    state.activeTabId = tab.id || null;
    els.urlInput.value = rawUrl;
    els.titleInput.value = (tab.title || "").trim();
    els.siteNameLabel.textContent = rawUrl;

    let domMeta = null;
    if (tab.id && (await ensureDomAssistPermission(rawUrl))) {
      domMeta = await api.runDomAssist(tab.id);
    }
    state.domMeta = domMeta;
    if (domMeta) {
      if (domMeta.title && (!els.titleInput.value || domMeta.title.length > els.titleInput.value.length)) {
        els.titleInput.value = domMeta.title;
      }
      if (domMeta.site_name) {
        els.siteNameLabel.textContent = domMeta.site_name;
      }
      if (domMeta.selected_text && !els.noteInput.value) {
        els.noteInput.value = domMeta.selected_text;
      }
      if (Array.isArray(domMeta.media_items) && domMeta.media_items[0]) {
        renderPreviewThumbnail(domMeta.media_items[0].url);
      }
    }

    await fetchPreviewForUrl(rawUrl, false);
  }

  function buildReminderPayload() {
    const preset = els.reminderPreset.value;
    if (!preset) return undefined;

    let remindAtDate;
    if (preset === "tomorrow_9am") {
      remindAtDate = new Date();
      remindAtDate.setDate(remindAtDate.getDate() + 1);
      remindAtDate.setHours(9, 0, 0, 0);
    } else if (preset === "in_3_days") {
      remindAtDate = new Date();
      remindAtDate.setDate(remindAtDate.getDate() + 3);
      remindAtDate.setHours(20, 0, 0, 0);
    } else if (preset === "custom") {
      if (!els.customReminderInput.value) {
        throw new Error("กรุณาเลือกวันเวลาสำหรับแจ้งเตือนแบบกำหนดเอง");
      }
      remindAtDate = new Date(els.customReminderInput.value);
    }

    if (!remindAtDate || Number.isNaN(remindAtDate.getTime())) {
      throw new Error("รูปแบบวันเวลาที่ต้องการแจ้งเตือนไม่ถูกต้อง");
    }

    return {
      schedule_type: "once",
      remind_at: remindAtDate.toISOString(),
      timezone: state.userTimezone,
      title_snapshot: els.titleInput.value.trim() || undefined,
    };
  }

  async function enterSaverView() {
    els.authView.classList.add("hidden");
    els.saverView.classList.remove("hidden");
    setSaverPaneMode("save");
    await refreshOfflineQueueBanner();

    const session = await api.getSessionState();
    const userDisplay =
      (session.user && (session.user.display_name || session.user.email)) || "กำลังตรวจสอบผู้ใช้...";
    els.userLabel.textContent = `👤 ${userDisplay}`;

    try {
      const me = await api.apiRequest("/api/auth/me");
      const profile = me.user || me.profile || {};
      const name = profile.display_name || profile.email || userDisplay;
      const quotaLeft =
        me.ai_quota && typeof me.ai_quota.remaining === "number" ? ` · AI เหลือ ${me.ai_quota.remaining}` : "";
      els.userLabel.textContent = `👤 ${name}${quotaLeft}`;

      await loadUserWorkspace();
      await populateActiveTab();
    } catch (err) {
      if (err.status === 401) {
        await api.clearAuthSession();
        enterAuthView();
        showBanner("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง", "error");
        return;
      }
      await populateActiveTab();
      showBanner(`โหลดข้อมูลบางส่วนไม่สำเร็จ (${err.message}) — คุณยังสามารถบันทึกเข้าคิวออฟไลน์ได้`, "error");
    }
  }

  function enterAuthView() {
    els.saverView.classList.add("hidden");
    els.authView.classList.remove("hidden");
    els.savedResultCard.classList.add("hidden");
  }

  async function handleWebConnect() {
    clearBanner();
    els.webConnectBtn.disabled = true;
    try {
      const tabs = await chrome.tabs.query({
        url: [
          "https://just-save-it-web.onrender.com/*",
          "http://localhost:4173/*",
          "http://127.0.0.1:4173/*",
        ],
      });
      if (!tabs.length) {
        openSharelyWeb();
        showBanner("เปิดเว็บ Sharely แล้ว — กรุณาล็อกอินในเว็บแล้วกด 'เชื่อมต่อจากหน้าเว็บ Sharely' อีกครั้ง", "info");
        return;
      }
      for (const tab of tabs) {
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const raw = localStorage.getItem("sharely_test_state_v1");
              if (!raw) return null;
              const parsed = JSON.parse(raw);
              return {
                accessToken: parsed?.api?.bearerToken || "",
                refreshToken: parsed?.api?.refreshToken || "",
                apiBaseUrl: parsed?.api?.baseUrl || "",
              };
            },
          });
          const data = res && res[0] && res[0].result;
          if (data && data.accessToken) {
            if (data.apiBaseUrl) {
              await api.setBackendUrl(data.apiBaseUrl);
              els.backendUrlInput.value = await api.setBackendUrl(data.apiBaseUrl);
            }
            await api.loginWithAccessToken(data.accessToken, data.refreshToken || "");
            await enterSaverView();
            showBanner("เชื่อมต่อบัญชีจากหน้าเว็บ Sharely สำเร็จแล้ว!", "info");
            return;
          }
        } catch (_err) {
          // Try next matching tab
        }
      }
      showBanner("พบแท็บ Sharely แต่ยังไม่ได้เข้าสู่ระบบ — กรุณาล็อกอินในหน้าเว็บก่อน แล้วลองอีกครั้ง", "error");
    } finally {
      els.webConnectBtn.disabled = false;
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    clearBanner();
    const email = els.emailInput.value.trim();
    const password = els.passwordInput.value;
    const isRegister = state.authMode === "register";

    els.authSubmitBtn.disabled = true;
    try {
      const path = isRegister ? "/api/auth/register" : "/api/auth/login";
      const body = isRegister
        ? {
            email,
            password,
            display_name: els.displayNameInput.value.trim() || undefined,
          }
        : { email, password };

      const authResp = await api.apiRequest(path, {
        method: "POST",
        auth: false,
        body,
      });
      await api.saveAuthSession(authResp);
      await enterSaverView();
    } catch (err) {
      showBanner(err.message || "ไม่สามารถเข้าสู่ระบบได้", "error");
    } finally {
      els.authSubmitBtn.disabled = false;
    }
  }

  function syncLocalDemoVisibility(backendUrl) {
    if (!els.localDemoSection) return;
    els.localDemoSection.classList.toggle("hidden", !api.isLocalBackendUrl(backendUrl));
  }

  async function handleDemoLogin() {
    clearBanner();
    if (!api.isLocalBackendUrl(els.backendUrlInput.value)) {
      showBanner("บัญชีทดสอบใช้ได้เฉพาะโหมด Local Dev (localhost/127.0.0.1) เท่านั้น", "error");
      return;
    }
    els.demoLoginBtn.disabled = true;
    try {
      const authResp = await api.apiRequest("/api/auth/login", {
        method: "POST",
        auth: false,
        body: { email: "may@example.com", password: "password123" },
      });
      await api.saveAuthSession(authResp);
      await enterSaverView();
    } catch (err) {
      showBanner(
        `เข้าสู่ระบบบัญชีทดสอบไม่สำเร็จ (${err.message}) — ตรวจสอบว่า Backend รันอยู่ที่ ${els.backendUrlInput.value}`,
        "error"
      );
    } finally {
      els.demoLoginBtn.disabled = false;
    }
  }

  async function handleTokenLogin() {
    clearBanner();
    const rawToken = els.tokenLoginInput ? els.tokenLoginInput.value.trim() : "";
    if (!rawToken) {
      showBanner("กรุณาวาง Web Access Token จากหน้าโปรไฟล์", "error");
      return;
    }
    els.tokenLoginBtn.disabled = true;
    try {
      await api.loginWithAccessToken(rawToken);
      els.tokenLoginInput.value = "";
      await enterSaverView();
    } catch (err) {
      showBanner(err.message || "Token ไม่ถูกต้อง", "error");
    } finally {
      els.tokenLoginBtn.disabled = false;
    }
  }

  async function handleCreateFolder() {
    const name = els.newFolderName.value.trim();
    const emoji = els.newFolderEmoji.value.trim() || "📁";
    if (!name) return;

    els.createFolderBtn.disabled = true;
    try {
      const folder = await api.apiRequest("/api/folders", {
        method: "POST",
        body: { name, emoji },
      });
      const opt = document.createElement("option");
      opt.value = folder.id;
      opt.textContent = `${folder.emoji || "📁"} ${folder.name}`;
      els.folderSelect.appendChild(opt);
      els.folderSelect.value = folder.id;
      els.newFolderName.value = "";
      els.newFolderBox.classList.add("hidden");
    } catch (err) {
      showBanner(`สร้างโฟลเดอร์ไม่สำเร็จ: ${err.message}`, "error");
    } finally {
      els.createFolderBtn.disabled = false;
    }
  }

  async function handleSaveItem(event) {
    event.preventDefault();
    clearBanner();

    const url = els.urlInput.value.trim();
    if (!api.isSaveableHttpUrl(url)) {
      showBanner("กรุณากรอก URL ที่ขึ้นต้นด้วย http:// หรือ https://", "error");
      return;
    }

    let reminder;
    try {
      reminder = buildReminderPayload();
    } catch (err) {
      showBanner(err.message, "error");
      return;
    }

    const previewMedia =
      state.previewMeta && Array.isArray(state.previewMeta.media_items) && state.previewMeta.media_items.length
        ? state.previewMeta.media_items
        : null;
    const domMedia =
      state.domMeta && Array.isArray(state.domMeta.media_items) && state.domMeta.media_items.length
        ? state.domMeta.media_items
        : null;
    const tags = parseTagList();

    const payload = {
      url,
      title: els.titleInput.value.trim() || undefined,
      description:
        (state.previewMeta && state.previewMeta.description) ||
        (state.domMeta && state.domMeta.description) ||
        undefined,
      note: els.noteInput.value.trim() || undefined,
      folder_id: els.folderSelect.value || undefined,
      tags: tags.length ? tags : undefined,
      status: els.statusSelect.value || "inbox",
      platform: (state.previewMeta && state.previewMeta.platform) || undefined,
      content_type: (state.previewMeta && state.previewMeta.content_type) || undefined,
      media_items: previewMedia || domMedia || undefined,
      reminder,
    };

    els.saveItemBtn.disabled = true;
    els.saveItemBtn.textContent = "กำลังบันทึก...";
    try {
      const saved = await api.apiRequest("/api/items", {
        method: "POST",
        body: payload,
      });
      state.lastSavedItemId = saved.id;
      els.aiResultBox.classList.add("hidden");
      els.aiResultBox.textContent = "";
      els.savedMetaText.textContent = `ID: ${saved.id} · platform: ${saved.platform || "web"} · enrich: ${saved.enrich_status || "pending"}`;
      els.savedResultCard.classList.remove("hidden");
      els.blockedTabCard.classList.add("hidden");

      await refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
    } catch (err) {
      if (!err.status || err.status >= 500 || err.status === 429) {
        await api.enqueueOfflineSave(payload, err.message || "offline");
        await refreshOfflineQueueBanner();
        showBanner("ออฟไลน์ชั่วคราว — เก็บลิงก์เข้าคิวซิงก์อัตโนมัติเรียบร้อย", "info");
      } else {
        showBanner(`บันทึกลิงก์ไม่สำเร็จ: ${err.message}`, "error");
      }
    } finally {
      els.saveItemBtn.disabled = false;
      els.saveItemBtn.textContent = "บันทึกลิงก์";
    }
  }

  async function handleAiSummarize() {
    if (!state.lastSavedItemId) return;
    els.aiSummarizeBtn.disabled = true;
    els.aiSummarizeBtn.textContent = "กำลังสรุป...";
    try {
      const resp = await api.apiRequest("/api/ai/summarize", {
        method: "POST",
        body: {
          item_id: state.lastSavedItemId,
          summary_language: "th",
          save_to_note: false,
        },
      });
      const { summary, tags } = api.formatAiSummaryResponse(resp);
      const tagsText = tags.length ? `\n\nแท็กแนะนำ: ${tags.join(", ")}` : "";
      els.aiResultBox.textContent = `${summary}${tagsText}`.trim();
      els.aiResultBox.classList.remove("hidden");
    } catch (err) {
      els.aiResultBox.textContent = `ไม่สามารถสรุป AI ได้ในตอนนี้: ${err.message}`;
      els.aiResultBox.classList.remove("hidden");
    } finally {
      els.aiSummarizeBtn.disabled = false;
      els.aiSummarizeBtn.textContent = "✨ สรุปด้วย AI";
    }
  }

  function bindEvents() {
    els.openWebBtn.addEventListener("click", openSharelyWeb);
    els.openWebBlockedBtn.addEventListener("click", openSharelyWeb);
    els.toggleSettingsBtn.addEventListener("click", () => {
      els.settingsPanel.classList.toggle("hidden");
    });

    els.saveSettingsBtn.addEventListener("click", async () => {
      const savedUrl = await api.setBackendUrl(els.backendUrlInput.value);
      els.backendUrlInput.value = savedUrl;
      syncLocalDemoVisibility(savedUrl);
      await updateHealthStatus(savedUrl);
      showBanner(`อัปเดต Backend URL เป็น ${savedUrl} แล้ว`, "info");
    });

    if (els.presetCloudBtn) {
      els.presetCloudBtn.addEventListener("click", async () => {
        const savedUrl = await api.setBackendUrl(api.BACKEND_PRESETS.cloud);
        els.backendUrlInput.value = savedUrl;
        syncLocalDemoVisibility(savedUrl);
        await updateHealthStatus(savedUrl);
        showBanner("สลับไปยัง Render Production Cloud แล้ว", "info");
      });
    }

    if (els.presetLocalBtn) {
      els.presetLocalBtn.addEventListener("click", async () => {
        const savedUrl = await api.setBackendUrl(api.BACKEND_PRESETS.local);
        els.backendUrlInput.value = savedUrl;
        syncLocalDemoVisibility(savedUrl);
        await updateHealthStatus(savedUrl);
        showBanner("สลับไปยัง Local Dev (127.0.0.1:8000) แล้ว", "info");
      });
    }

    if (els.webConnectBtn) {
      els.webConnectBtn.addEventListener("click", handleWebConnect);
    }
    if (els.tokenLoginBtn) {
      els.tokenLoginBtn.addEventListener("click", handleTokenLogin);
    }

    els.tabLoginBtn.addEventListener("click", () => setAuthMode("login"));
    els.tabRegisterBtn.addEventListener("click", () => setAuthMode("register"));
    els.authForm.addEventListener("submit", handleAuthSubmit);
    els.demoLoginBtn.addEventListener("click", handleDemoLogin);

    els.tabSaveBtn.addEventListener("click", () => setSaverPaneMode("save"));
    els.tabRecentBtn.addEventListener("click", async () => {
      setSaverPaneMode("recent");
      await refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
    });

    els.flushQueueBtn.addEventListener("click", async () => {
      els.flushQueueBtn.disabled = true;
      try {
        const res = await api.flushOfflineQueue();
        await refreshOfflineQueueBanner();
        await refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
        showBanner(`ซิงก์คิวออฟไลน์สำเร็จ ${res.flushed} รายการ (คงเหลือ ${res.remaining})`, "info");
      } catch (err) {
        showBanner(`ซิงก์คิวไม่สำเร็จ: ${err.message}`, "error");
      } finally {
        els.flushQueueBtn.disabled = false;
      }
    });

    let searchTimer = null;
    if (els.recentSearchInput) {
      els.recentSearchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          refreshRecentList(els.recentSearchInput.value);
        }, 280);
      });
    }
    if (els.refreshRecentBtn) {
      els.refreshRecentBtn.addEventListener("click", () => {
        refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
      });
    }

    els.logoutBtn.addEventListener("click", async () => {
      try {
        await api.apiRequest("/api/auth/logout", { method: "POST" });
      } catch (_err) {
        // Always clear local session even if backend logout fails
      }
      await api.clearAuthSession();
      enterAuthView();
    });

    els.urlInput.addEventListener("input", () => {
      if (api.isSaveableHttpUrl(els.urlInput.value)) {
        els.blockedTabCard.classList.add("hidden");
      }
    });

    els.refreshPreviewBtn.addEventListener("click", () => {
      fetchPreviewForUrl(els.urlInput.value.trim(), true);
    });

    els.toggleNewFolderBtn.addEventListener("click", () => {
      els.newFolderBox.classList.toggle("hidden");
      if (!els.newFolderBox.classList.contains("hidden")) {
        els.newFolderName.focus();
      }
    });

    els.createFolderBtn.addEventListener("click", handleCreateFolder);
    els.tagsInput.addEventListener("input", syncTagChipSelection);

    els.reminderPreset.addEventListener("change", () => {
      const isCustom = els.reminderPreset.value === "custom";
      els.customReminderGroup.classList.toggle("hidden", !isCustom);
      if (isCustom && !els.customReminderInput.value) {
        const defaultDt = new Date(Date.now() + 2 * 60 * 60 * 1000);
        defaultDt.setMinutes(0, 0, 0);
        const offsetMs = defaultDt.getTimezoneOffset() * 60000;
        els.customReminderInput.value = new Date(defaultDt - offsetMs).toISOString().slice(0, 16);
      }
    });

    els.saveForm.addEventListener("submit", handleSaveItem);
    els.aiSummarizeBtn.addEventListener("click", handleAiSummarize);
  }

  async function init() {
    bindEvents();
    const session = await api.getSessionState();
    els.backendUrlInput.value = session.backendUrl;
    syncLocalDemoVisibility(session.backendUrl);
    await updateHealthStatus(session.backendUrl);

    if (session.accessToken) {
      await enterSaverView();
    } else {
      enterAuthView();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
