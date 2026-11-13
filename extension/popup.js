(function () {
  "use strict";

  const api = window.JustSaveItApi;

  const state = {
    authMode: "login",
    domMeta: null,
    previewMeta: null,
    lastSavedItemId: null,
    activeTabId: null,
    userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
  };

  const els = {
    healthBadge: document.getElementById("healthBadge"),
    toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    backendUrlInput: document.getElementById("backendUrlInput"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    feedbackBanner: document.getElementById("feedbackBanner"),

    authView: document.getElementById("authView"),
    tabLoginBtn: document.getElementById("tabLoginBtn"),
    tabRegisterBtn: document.getElementById("tabRegisterBtn"),
    authForm: document.getElementById("authForm"),
    displayNameGroup: document.getElementById("displayNameGroup"),
    displayNameInput: document.getElementById("displayNameInput"),
    emailInput: document.getElementById("emailInput"),
    passwordInput: document.getElementById("passwordInput"),
    authSubmitBtn: document.getElementById("authSubmitBtn"),
    demoLoginBtn: document.getElementById("demoLoginBtn"),

    saverView: document.getElementById("saverView"),
    userLabel: document.getElementById("userLabel"),
    logoutBtn: document.getElementById("logoutBtn"),
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

    toggleRecentBtn: document.getElementById("toggleRecentBtn"),
    recentCount: document.getElementById("recentCount"),
    recentArrow: document.getElementById("recentArrow"),
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

  async function updateHealthStatus(overrideUrl) {
    els.healthBadge.textContent = "Checking...";
    els.healthBadge.className = "status-pill status-checking";
    try {
      const health = await api.checkHealth(overrideUrl);
      const modeLabel = health.storage_mode === "supabase" ? "Cloud Online" : "Local Dev";
      els.healthBadge.textContent = modeLabel;
      els.healthBadge.className = "status-pill status-online";
      return true;
    } catch (_err) {
      els.healthBadge.textContent = "Backend Offline";
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

  async function loadUserWorkspace() {
    const [foldersRes, tagsRes, itemsRes] = await Promise.all([
      api.apiRequest("/api/folders"),
      api.apiRequest("/api/tags"),
      api.apiRequest("/api/items?limit=5"),
    ]);

    const currentFolderId = els.folderSelect.value;
    els.folderSelect.innerHTML = '<option value="">-- กล่องขาเข้า (Inbox) --</option>';
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

  function renderRecentItems(items) {
    els.recentCount.textContent = String(items.length);
    els.recentList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "ยังไม่มีลิงก์ที่บันทึกไว้ — ลองกดบันทึกลิงก์แรกด้านบนได้เลย";
      els.recentList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const link = document.createElement("a");
      link.className = "recent-item";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener";

      const textWrap = document.createElement("div");
      textWrap.style.minWidth = "0";

      const titleDiv = document.createElement("div");
      titleDiv.className = "recent-item-title";
      titleDiv.textContent = item.title || item.url;

      const subDiv = document.createElement("div");
      subDiv.className = "recent-item-sub";
      subDiv.textContent = `${item.platform || "web"} · ${item.status || "inbox"} · enrich:${item.enrich_status || "pending"}`;

      textWrap.appendChild(titleDiv);
      textWrap.appendChild(subDiv);
      link.appendChild(textWrap);
      els.recentList.appendChild(link);
    }
  }

  async function fetchPreviewForUrl(url, forceRefresh = false) {
    if (!api.isSaveableHttpUrl(url)) {
      els.previewSourceBadge.textContent = "URL ไม่ใช่ http/https";
      return;
    }

    els.previewSourceBadge.textContent = "กำลังดึงข้อมูล...";
    try {
      const preview = await api.apiRequest("/api/preview", {
        method: "POST",
        body: { url, force_refresh: forceRefresh },
      });
      state.previewMeta = preview;

      els.platformBadge.textContent = preview.platform || "web";
      els.contentTypeBadge.textContent = preview.content_type || "link";
      els.siteNameLabel.textContent = preview.site_name || new URL(url).hostname;

      const domThumb =
        state.domMeta &&
        Array.isArray(state.domMeta.media_items) &&
        state.domMeta.media_items[0] &&
        state.domMeta.media_items[0].url;
      renderPreviewThumbnail(preview.image_url || domThumb || "");

      if (preview.title && (!els.titleInput.value.trim() || forceRefresh)) {
        els.titleInput.value = preview.title;
      }
      els.previewSourceBadge.textContent = preview.cached ? "Server Cache" : "Server Unfurl";
    } catch (_err) {
      els.previewSourceBadge.textContent = state.domMeta ? "DOM Assist" : "กรอกหัวข้อเองได้";
    }
  }

  async function populateActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab) return;

    state.activeTabId = tab.id || null;
    const rawUrl = tab.url || "";
    if (api.isSaveableHttpUrl(rawUrl)) {
      els.urlInput.value = rawUrl;
      try {
        els.siteNameLabel.textContent = new URL(rawUrl).hostname;
      } catch (_err) {
        els.siteNameLabel.textContent = rawUrl;
      }
    }
    if (tab.title) {
      els.titleInput.value = tab.title;
    }

    const domMeta = await api.runDomAssist(state.activeTabId);
    if (domMeta) {
      state.domMeta = domMeta;
      if (domMeta.title && !els.titleInput.value.trim()) {
        els.titleInput.value = domMeta.title;
      }
      if (domMeta.site_name) {
        els.siteNameLabel.textContent = domMeta.site_name;
      }
      if (domMeta.selected_text && !els.noteInput.value.trim()) {
        els.noteInput.value = domMeta.selected_text;
      }
      if (Array.isArray(domMeta.media_items) && domMeta.media_items[0]) {
        renderPreviewThumbnail(domMeta.media_items[0].url);
      }
    }

    if (api.isSaveableHttpUrl(rawUrl)) {
      await fetchPreviewForUrl(rawUrl, false);
    }
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

    const session = await api.getSessionState();
    const userDisplay =
      (session.user && (session.user.display_name || session.user.email)) || "กำลังตรวจสอบผู้ใช้...";
    els.userLabel.textContent = `👤 ${userDisplay}`;

    try {
      const me = await api.apiRequest("/api/auth/me");
      const profile = me.user || me.profile || {};
      const name = profile.display_name || profile.email || userDisplay;
      const quotaLeft = me.ai_quota && typeof me.ai_quota.remaining === "number" ? ` · AI เหลือ ${me.ai_quota.remaining}` : "";
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
      showBanner(`โหลดข้อมูลเริ่มต้นไม่สำเร็จ: ${err.message}`, "error");
    }
  }

  function enterAuthView() {
    els.saverView.classList.add("hidden");
    els.authView.classList.remove("hidden");
    els.savedResultCard.classList.add("hidden");
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

  async function handleDemoLogin() {
    clearBanner();
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

      const itemsRes = await api.apiRequest("/api/items?limit=5");
      renderRecentItems(itemsRes.items || []);
    } catch (err) {
      showBanner(`บันทึกลิงก์ไม่สำเร็จ: ${err.message}`, "error");
    } finally {
      els.saveItemBtn.disabled = false;
      els.saveItemBtn.textContent = "💾 บันทึกลิงก์ลง Backend";
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
      const tagsText = Array.isArray(resp.tags) && resp.tags.length ? `\n\nแท็กแนะนำ: ${resp.tags.join(", ")}` : "";
      els.aiResultBox.textContent = `${resp.summary || ""}${tagsText}`.trim();
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
    els.toggleSettingsBtn.addEventListener("click", () => {
      els.settingsPanel.classList.toggle("hidden");
    });

    els.saveSettingsBtn.addEventListener("click", async () => {
      const savedUrl = await api.setBackendUrl(els.backendUrlInput.value);
      els.backendUrlInput.value = savedUrl;
      await updateHealthStatus(savedUrl);
      showBanner(`อัปเดต Backend URL เป็น ${savedUrl} แล้ว`, "info");
    });

    els.tabLoginBtn.addEventListener("click", () => setAuthMode("login"));
    els.tabRegisterBtn.addEventListener("click", () => setAuthMode("register"));
    els.authForm.addEventListener("submit", handleAuthSubmit);
    els.demoLoginBtn.addEventListener("click", handleDemoLogin);

    els.logoutBtn.addEventListener("click", async () => {
      try {
        await api.apiRequest("/api/auth/logout", { method: "POST" });
      } catch (_err) {
        // Always clear local session even if backend logout fails
      }
      await api.clearAuthSession();
      enterAuthView();
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

    els.toggleRecentBtn.addEventListener("click", () => {
      const willOpen = els.recentList.classList.contains("hidden");
      els.recentList.classList.toggle("hidden", !willOpen);
      els.recentArrow.textContent = willOpen ? "▲" : "▼";
    });
  }

  async function init() {
    bindEvents();
    const session = await api.getSessionState();
    els.backendUrlInput.value = session.backendUrl;
    await updateHealthStatus(session.backendUrl);

    if (session.accessToken) {
      await enterSaverView();
    } else {
      enterAuthView();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
