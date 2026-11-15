(function () {
  "use strict";

  const api = window.JustSaveItApi;
  const CLOUD_WEB_URL = "https://just-save-it-web.onrender.com";

  const THAI_MONTH_NAMES = [
    "มกราคม",
    "กุมภาพันธ์",
    "มีนาคม",
    "เมษายน",
    "พฤษภาคม",
    "มิถุนายน",
    "กรกฎาคม",
    "สิงหาคม",
    "กันยายน",
    "ตุลาคม",
    "พฤศจิกายน",
    "ธันวาคม",
  ];
  const THAI_MONTH_SHORT = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];
  const STATUS_LABEL = {
    inbox: "กล่องเข้า",
    todo: "ต้องอ่าน",
    done: "อ่านแล้ว",
    archived: "เก็บถาวร",
  };

  function getBangkokTodayIso(now = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch (_err) {
      // Fallback below
    }
    return now.toISOString().slice(0, 10);
  }

  function addDaysToIso(baseIso, deltaDays) {
    const [y, m, d] = baseIso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
    return dt.toISOString().slice(0, 10);
  }

  function stepYearMonth(ym, deltaMonths) {
    const [yStr, mStr] = String(ym || getBangkokTodayIso().slice(0, 7)).split("-");
    const y = Number(yStr) || new Date().getFullYear();
    const m = (Number(mStr) || 1) - 1;
    const total = y * 12 + m + Number(deltaMonths || 0);
    const nextY = Math.floor(total / 12);
    const nextM = ((total % 12) + 12) % 12;
    return `${nextY}-${String(nextM + 1).padStart(2, "0")}`;
  }

  function formatThaiMonthYear(ym) {
    const [yStr, mStr] = String(ym || getBangkokTodayIso().slice(0, 7)).split("-");
    const y = Number(yStr) || new Date().getFullYear();
    const m = Math.max(1, Math.min(12, Number(mStr) || 1));
    return `${THAI_MONTH_NAMES[m - 1]} ${y + 543}`;
  }

  function formatThaiDateShort(isoDate) {
    const parts = String(isoDate || "").split("-").map(Number);
    if (parts.length !== 3 || !parts[1] || !parts[2]) return isoDate;
    return `${parts[2]} ${THAI_MONTH_SHORT[parts[1] - 1] || ""}`.trim();
  }

  function formatDomainDisplay(rawUrl, siteName = "") {
    if (siteName && !/^https?:\/\//i.test(siteName)) {
      return siteName;
    }
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/^www\./, "");
      const path = parsed.pathname && parsed.pathname !== "/" ? "/..." : "";
      return `${host}${path}`;
    } catch (_err) {
      return rawUrl || "ลิงก์เว็บ";
    }
  }

  function normalizeMediaUrlList(rawList, fallbackImageUrl = "") {
    const urls = [];
    const candidates = Array.isArray(rawList) ? rawList : [];
    for (const entry of candidates) {
      let u = "";
      if (typeof entry === "string") {
        u = entry.trim();
      } else if (entry && typeof entry === "object") {
        u = String(entry.media_url || entry.url || entry.thumbnail_url || "").trim();
      }
      if (u && api.isSaveableHttpUrl(u) && !urls.includes(u)) {
        urls.push(u);
      }
      if (urls.length >= 5) break;
    }
    if (!urls.length && fallbackImageUrl && api.isSaveableHttpUrl(fallbackImageUrl)) {
      urls.push(fallbackImageUrl.trim());
    }
    return urls;
  }

  const state = {
    authMode: "login",
    activeViewMode: "save",
    domMeta: null,
    domMetaUrl: "",
    previewMeta: null,
    previewUrl: "",
    lastSavedItemId: null,
    activeTabId: null,
    selectedFolderId: "",
    selectedTags: [],
    allRecentItems: [],
    cachedFolders: [],
    cachedTags: [],
    cachedUser: null,
    userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
    reminder: {
      pickerOpen: false,
      enabled: false,
      presetKey: "none",
      selectedDate: "",
      time: "18:00",
      scheduleType: "once",
      repeatEveryDays: 3,
      viewYearMonth: getBangkokTodayIso().slice(0, 7),
    },
  };

  const els = {
    healthBadge: document.getElementById("healthBadge"),
    openWebBtn: document.getElementById("openWebBtn"),
    toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    submenuAccountRow: document.getElementById("submenuAccountRow"),
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
    toggleUrlEditBtn: document.getElementById("toggleUrlEditBtn"),
    urlEditRow: document.getElementById("urlEditRow"),
    previewImage: document.getElementById("previewImage"),
    previewPlaceholder: document.getElementById("previewPlaceholder"),
    previewSourceBadge: document.getElementById("previewSourceBadge"),
    siteNameLabel: document.getElementById("siteNameLabel"),
    urlInput: document.getElementById("urlInput"),
    refreshPreviewBtn: document.getElementById("refreshPreviewBtn"),
    titleInput: document.getElementById("titleInput"),

    saveForm: document.getElementById("saveForm"),
    folderChipWrap: document.getElementById("folderChipWrap"),
    folderSelect: document.getElementById("folderSelect"),
    toggleNewFolderBtn: document.getElementById("toggleNewFolderBtn"),
    newFolderBox: document.getElementById("newFolderBox"),
    newFolderEmoji: document.getElementById("newFolderEmoji"),
    newFolderName: document.getElementById("newFolderName"),
    createFolderBtn: document.getElementById("createFolderBtn"),

    toggleTagInputBtn: document.getElementById("toggleTagInputBtn"),
    quickTagRow: document.getElementById("quickTagRow"),
    quickTagInput: document.getElementById("quickTagInput"),
    addQuickTagBtn: document.getElementById("addQuickTagBtn"),
    tagsInput: document.getElementById("tagsInput"),
    tagSuggestions: document.getElementById("tagSuggestions"),
    noteInput: document.getElementById("noteInput"),
    statusSelect: document.getElementById("statusSelect"),

    reminderTriggerBtn: document.getElementById("reminderTriggerBtn"),
    reminderSummaryChip: document.getElementById("reminderSummaryChip"),
    reminderSummaryLabel: document.getElementById("reminderSummaryLabel"),
    clearReminderInlineBtn: document.getElementById("clearReminderInlineBtn"),
    reminderPickerCard: document.getElementById("reminderPickerCard"),
    recurOnceBtn: document.getElementById("recurOnceBtn"),
    recurRepeatBtn: document.getElementById("recurRepeatBtn"),
    repeatStepperGroup: document.getElementById("repeatStepperGroup"),
    repeatDaysMinus: document.getElementById("repeatDaysMinus"),
    repeatDaysValue: document.getElementById("repeatDaysValue"),
    repeatDaysPlus: document.getElementById("repeatDaysPlus"),
    calPrevBtn: document.getElementById("calPrevBtn"),
    calMonthLabel: document.getElementById("calMonthLabel"),
    calNextBtn: document.getElementById("calNextBtn"),
    calDaysGrid: document.getElementById("calDaysGrid"),
    reminderTimeInput: document.getElementById("reminderTimeInput"),

    saveItemBtn: document.getElementById("saveItemBtn"),

    savedResultCard: document.getElementById("savedResultCard"),
    savedTitleLabel: document.getElementById("savedTitleLabel"),
    savedMetaText: document.getElementById("savedMetaText"),
    aiSummarizeBtn: document.getElementById("aiSummarizeBtn"),
    aiResultBox: document.getElementById("aiResultBox"),

    recentPane: document.getElementById("recentPane"),
    recentSearchInput: document.getElementById("recentSearchInput"),
    refreshRecentBtn: document.getElementById("refreshRecentBtn"),
    recentList: document.getElementById("recentList"),
  };

  function showBanner(message, type = "info") {
    const tone = type === "error" ? "error" : type === "success" ? "success" : "info";
    els.feedbackBanner.textContent = message;
    els.feedbackBanner.className = `banner ${tone}`;
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

  function renderOfflineQueueCount(queue) {
    if (!els.offlineQueueBar) return;
    const len = Array.isArray(queue) ? queue.length : 0;
    if (len > 0) {
      els.offlineQueueCount.textContent = String(len);
      els.offlineQueueBar.classList.remove("hidden");
    } else {
      els.offlineQueueCount.textContent = "0";
      els.offlineQueueBar.classList.add("hidden");
    }
  }

  async function refreshOfflineQueueBanner() {
    const queue = await api.getOfflineQueue();
    renderOfflineQueueCount(queue);
  }

  async function updateHealthStatus(overrideUrl) {
    els.healthBadge.textContent = "Sync";
    els.healthBadge.className = "status-pill status-checking";
    try {
      const health = await api.checkHealth(overrideUrl);
      els.healthBadge.textContent = health.storage_mode === "supabase" ? "Online" : "Local";
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

  function renderPreviewThumbnail(imageUrl, fallbackLetter = "") {
    if (imageUrl && api.isSaveableHttpUrl(imageUrl)) {
      els.previewImage.src = imageUrl;
      els.previewImage.classList.remove("hidden");
      els.previewPlaceholder.classList.add("hidden");
      return;
    }
    els.previewImage.classList.add("hidden");
    els.previewImage.removeAttribute("src");
    els.previewPlaceholder.textContent = (fallbackLetter || "L").charAt(0).toUpperCase();
    els.previewPlaceholder.classList.remove("hidden");
  }

  function syncTagsHiddenInput() {
    if (els.tagsInput) {
      els.tagsInput.value = state.selectedTags.join(", ");
    }
  }

  function parseTagList() {
    return state.selectedTags.slice();
  }

  function syncTagChipSelection() {
    const active = new Set(state.selectedTags.map((t) => t.toLowerCase()));
    for (const chip of els.tagSuggestions.querySelectorAll("[data-tag-name]")) {
      const name = String(chip.dataset.tagName || "").toLowerCase();
      chip.classList.toggle("selected", active.has(name));
    }
    syncTagsHiddenInput();
  }

  function toggleTagChip(tagName) {
    const clean = String(tagName || "").replace(/^#+/, "").trim();
    if (!clean) return;
    const idx = state.selectedTags.findIndex((t) => t.toLowerCase() === clean.toLowerCase());
    if (idx >= 0) {
      state.selectedTags.splice(idx, 1);
    } else {
      state.selectedTags.push(clean);
    }
    syncTagChipSelection();
  }

  function addQuickTagsFromInput() {
    const raw = els.quickTagInput ? els.quickTagInput.value : "";
    const parts = raw
      .split(",")
      .map((t) => t.replace(/^#+/, "").trim())
      .filter(Boolean);
    if (!parts.length) return;

    for (const name of parts) {
      if (!state.selectedTags.some((t) => t.toLowerCase() === name.toLowerCase())) {
        state.selectedTags.push(name);
      }
      if (!state.cachedTags.some((t) => String(t.name || "").toLowerCase() === name.toLowerCase())) {
        state.cachedTags.unshift({ name });
      }
    }
    els.quickTagInput.value = "";
    renderTagChips(state.cachedTags);
  }

  function selectFolder(folderId) {
    state.selectedFolderId = folderId || "";
    if (els.folderSelect) {
      els.folderSelect.value = state.selectedFolderId;
    }
    if (els.folderChipWrap) {
      for (const btn of els.folderChipWrap.querySelectorAll("[data-folder-choice]")) {
        const fid = btn.getAttribute("data-folder-choice") || "";
        btn.classList.toggle("selected", fid === state.selectedFolderId);
      }
    }
  }

  function renderFoldersDropdown(folders) {
    state.cachedFolders = Array.isArray(folders) ? folders : [];
    const currentId = state.selectedFolderId;
    const validCurrent = currentId && state.cachedFolders.some((f) => f.id === currentId) ? currentId : "";
    state.selectedFolderId = validCurrent;

    if (els.folderSelect) {
      els.folderSelect.innerHTML = '<option value="">-- ยังไม่เลือกโฟลเดอร์ --</option>';
      for (const folder of state.cachedFolders) {
        const opt = document.createElement("option");
        opt.value = folder.id;
        opt.textContent = `${folder.emoji ? folder.emoji + " " : ""}${folder.name}`;
        els.folderSelect.appendChild(opt);
      }
      els.folderSelect.value = validCurrent;
    }

    if (!els.folderChipWrap) return;
    for (const oldChip of els.folderChipWrap.querySelectorAll("[data-folder-choice]")) {
      oldChip.remove();
    }

    const createBtn = (label, fid) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `figma-pill-choice${fid === validCurrent ? " selected" : ""}`;
      btn.setAttribute("data-folder-choice", fid);
      btn.textContent = label;
      btn.addEventListener("click", () => selectFolder(fid));
      return btn;
    };

    els.folderChipWrap.insertBefore(createBtn("ไม่ใส่โฟลเดอร์", ""), els.toggleNewFolderBtn);
    for (const folder of state.cachedFolders) {
      const prefix = folder.emoji ? `${folder.emoji} ` : "";
      els.folderChipWrap.insertBefore(createBtn(`${prefix}${folder.name}`, folder.id), els.toggleNewFolderBtn);
    }
  }

  function renderTagChips(tags) {
    state.cachedTags = Array.isArray(tags) ? tags : [];
    const mergedNames = [];
    const seen = new Set();
    for (const tag of state.cachedTags) {
      const name = String(tag && tag.name ? tag.name : tag || "").replace(/^#+/, "").trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        mergedNames.push(name);
      }
    }
    for (const sel of state.selectedTags) {
      const clean = String(sel || "").replace(/^#+/, "").trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        mergedNames.push(clean);
      }
    }

    els.tagSuggestions.innerHTML = "";
    if (!mergedNames.length) {
      const hintChip = document.createElement("button");
      hintChip.type = "button";
      hintChip.className = "figma-pill-choice";
      hintChip.textContent = "+ สร้างแท็กแรกของคุณ";
      hintChip.addEventListener("click", () => {
        if (els.quickTagRow) {
          els.quickTagRow.classList.remove("hidden");
          els.quickTagInput?.focus();
        }
      });
      els.tagSuggestions.appendChild(hintChip);
      syncTagsHiddenInput();
      return;
    }

    for (const name of mergedNames.slice(0, 14)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "figma-pill-choice";
      btn.dataset.tagName = name;
      btn.textContent = `#${name}`;
      btn.addEventListener("click", () => toggleTagChip(name));
      els.tagSuggestions.appendChild(btn);
    }
    syncTagChipSelection();
  }

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

      const titleLink = document.createElement("a");
      titleLink.className = "recent-title";
      titleLink.textContent = item.title || item.url;
      titleLink.href = api.isSaveableHttpUrl(item.url) ? item.url : "#";
      titleLink.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (api.isSaveableHttpUrl(item.url)) {
          chrome.tabs.create({ url: item.url });
        }
      });

      const metaRow = document.createElement("div");
      metaRow.className = "recent-meta-row";

      const sub = document.createElement("span");
      sub.textContent = `${item.platform || "web"} · ${formatDomainDisplay(item.url, item.site_name || "")}`;

      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = "recent-status-btn";
      const curStatus = item.status || "inbox";
      statusBtn.textContent = STATUS_LABEL[curStatus] || curStatus;
      statusBtn.addEventListener("click", async () => {
        const next = nextWorkflowStatus(item.status || "inbox");
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

      metaRow.appendChild(sub);
      metaRow.appendChild(statusBtn);

      const actions = document.createElement("div");
      actions.className = "recent-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn-chip";
      copyBtn.textContent = "คัดลอกลิงก์";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.url || "");
          copyBtn.textContent = "คัดลอกแล้ว";
          setTimeout(() => {
            copyBtn.textContent = "คัดลอกลิงก์";
          }, 1500);
        } catch (_err) {
          showBanner("ไม่สามารถคัดลอก URL ได้", "error");
        }
      });

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn-chip";
      openBtn.textContent = "เปิดดู ↗";
      openBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: `${getWebAppOrigin()}/?item=${encodeURIComponent(item.id)}` });
      });

      actions.appendChild(copyBtn);
      actions.appendChild(openBtn);
      card.appendChild(titleLink);
      card.appendChild(metaRow);
      card.appendChild(actions);
      els.recentList.appendChild(card);
    }
  }

  function renderReminderPicker() {
    const r = state.reminder;
    const hasActive = Boolean(r.enabled && r.selectedDate);
    if (els.reminderPickerCard) {
      els.reminderPickerCard.classList.toggle("hidden", !r.pickerOpen);
    }
    if (els.reminderTriggerBtn) {
      els.reminderTriggerBtn.classList.toggle("active", hasActive || r.pickerOpen);
    }
    if (els.reminderSummaryChip) {
      els.reminderSummaryChip.classList.toggle("hidden", !hasActive);
    }
    if (els.reminderSummaryLabel) {
      if (!hasActive) {
        els.reminderSummaryLabel.textContent = "⏰ ไม่ตั้งเตือน";
      } else if (r.scheduleType === "every_n_days") {
        els.reminderSummaryLabel.textContent = `🔁 ซ้ำทุก ${r.repeatEveryDays} วัน · ${r.time}`;
      } else {
        els.reminderSummaryLabel.textContent = `📅 ${formatThaiDateShort(r.selectedDate)} · ${r.time}`;
      }
    }

    for (const chip of document.querySelectorAll("[data-rem-preset]")) {
      const key = chip.getAttribute("data-rem-preset");
      const active = r.enabled ? r.presetKey === key : key === "none";
      chip.classList.toggle("active", active);
    }

    if (els.recurOnceBtn && els.recurRepeatBtn && els.repeatStepperGroup) {
      const isRepeat = r.scheduleType === "every_n_days";
      els.recurOnceBtn.classList.toggle("active", !isRepeat);
      els.recurRepeatBtn.classList.toggle("active", isRepeat);
      els.repeatStepperGroup.classList.toggle("hidden", !isRepeat);
      if (els.repeatDaysValue) {
        els.repeatDaysValue.textContent = `${r.repeatEveryDays} วัน`;
      }
    }

    if (els.reminderTimeInput && els.reminderTimeInput.value !== r.time) {
      els.reminderTimeInput.value = r.time;
    }

    if (els.calMonthLabel) {
      els.calMonthLabel.textContent = formatThaiMonthYear(r.viewYearMonth);
    }
    if (!els.calDaysGrid) return;

    const todayIso = getBangkokTodayIso();
    const [yStr, mStr] = r.viewYearMonth.split("-");
    const year = Number(yStr) || new Date().getFullYear();
    const month = Math.max(1, Math.min(12, Number(mStr) || 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const leadingEmpty = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();

    els.calDaysGrid.innerHTML = "";
    for (let i = 0; i < leadingEmpty; i += 1) {
      const emptyEl = document.createElement("span");
      emptyEl.className = "cal-day empty";
      els.calDaysGrid.appendChild(emptyEl);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isPast = isoDate < todayIso;
      const isToday = isoDate === todayIso;
      const isSelected = r.enabled && r.selectedDate === isoDate;

      const dayBtn = document.createElement("button");
      dayBtn.type = "button";
      dayBtn.className = "cal-day";
      if (isToday) dayBtn.classList.add("is-today");
      if (isSelected) dayBtn.classList.add("selected");
      dayBtn.textContent = String(day);
      dayBtn.disabled = isPast;
      dayBtn.dataset.calDate = isoDate;
      dayBtn.addEventListener("click", () => {
        r.enabled = true;
        r.presetKey = "custom";
        r.selectedDate = isoDate;
        renderReminderPicker();
      });
      els.calDaysGrid.appendChild(dayBtn);
    }
  }

  function applyReminderPreset(presetKey) {
    const r = state.reminder;
    const todayIso = getBangkokTodayIso();
    if (presetKey === "none") {
      r.enabled = false;
      r.presetKey = "none";
      r.selectedDate = "";
    } else if (presetKey === "today_18") {
      r.enabled = true;
      r.presetKey = "today_18";
      r.selectedDate = todayIso;
      r.time = "18:00";
      r.viewYearMonth = todayIso.slice(0, 7);
    } else if (presetKey === "tomorrow_9") {
      const tmIso = addDaysToIso(todayIso, 1);
      r.enabled = true;
      r.presetKey = "tomorrow_9";
      r.selectedDate = tmIso;
      r.time = "09:00";
      r.viewYearMonth = tmIso.slice(0, 7);
    } else if (presetKey === "in_3_days") {
      const d3Iso = addDaysToIso(todayIso, 3);
      r.enabled = true;
      r.presetKey = "in_3_days";
      r.selectedDate = d3Iso;
      r.time = "20:00";
      r.viewYearMonth = d3Iso.slice(0, 7);
    }
    renderReminderPicker();
  }

  function getTimezoneOffsetIso(timeZone, refDate = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone || "Asia/Bangkok",
        timeZoneName: "shortOffset",
      }).formatToParts(refDate);
      const tzToken = parts.find((p) => p.type === "timeZoneName")?.value || "";
      if (tzToken === "GMT" || tzToken === "UTC") return "+00:00";
      const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tzToken);
      if (match) {
        return `${match[1]}${match[2].padStart(2, "0")}:${(match[3] || "00").padStart(2, "0")}`;
      }
    } catch (_err) {
      // Fall back to +07:00
    }
    return "+07:00";
  }

  function buildReminderPayload() {
    const r = state.reminder;
    if (!r.enabled || !r.selectedDate) return undefined;

    const [hhRaw, mmRaw] = String(r.time || "18:00").split(":");
    const parsedHh = Number.parseInt(hhRaw, 10);
    const parsedMm = Number.parseInt(mmRaw, 10);
    const hh = String(Math.max(0, Math.min(23, Number.isFinite(parsedHh) ? parsedHh : 18))).padStart(2, "0");
    const mm = String(Math.max(0, Math.min(59, Number.isFinite(parsedMm) ? parsedMm : 0))).padStart(2, "0");
    const offsetIso = getTimezoneOffsetIso(state.userTimezone);
    const isoWithOffset = `${r.selectedDate}T${hh}:${mm}:00${offsetIso}`;
    const remindAtDate = new Date(isoWithOffset);
    if (Number.isNaN(remindAtDate.getTime())) {
      throw new Error("รูปแบบวันเวลาที่ต้องการแจ้งเตือนไม่ถูกต้อง");
    }

    if (r.scheduleType === "every_n_days") {
      return {
        schedule_type: "every_n_days",
        repeat_every_days: Math.max(1, Math.min(365, Number(r.repeatEveryDays) || 3)),
        remind_time: `${hh}:${mm}:00`,
        remind_at: remindAtDate.toISOString(),
        timezone: state.userTimezone,
        title_snapshot: els.titleInput.value.trim() || undefined,
      };
    }

    return {
      schedule_type: "once",
      remind_at: remindAtDate.toISOString(),
      timezone: state.userTimezone,
      title_snapshot: els.titleInput.value.trim() || undefined,
    };
  }

  async function refreshRecentList(search = "") {
    try {
      const itemsRes = await api.fetchRecentItems({ search, limit: 30 });
      const items = itemsRes.items || [];
      renderRecentItems(items);
      if (!search) {
        api.setWorkspaceCache({
          folders: state.cachedFolders,
          tags: state.cachedTags,
          recentItems: items,
          user: state.cachedUser,
        }).catch(() => {});
      }
    } catch (err) {
      showBanner(`โหลดรายการล่าสุดไม่สำเร็จ: ${err.message}`, "error");
    }
  }

  function applyWorkspaceSnapshot(ws, fallbackDisplay = "บัญชี Sharely") {
    const folders = Array.isArray(ws && ws.folders) ? ws.folders : [];
    const tags = Array.isArray(ws && ws.tags) ? ws.tags : [];
    const items = Array.isArray(ws && ws.items) ? ws.items : [];
    const profile = (ws && (ws.user || ws.profile)) || ws || {};
    state.cachedUser = profile;

    renderFoldersDropdown(folders);
    renderTagChips(tags);
    renderRecentItems(items);

    const name = profile.display_name || profile.email || fallbackDisplay;
    const quotaLeft =
      ws && ws.ai_quota && typeof ws.ai_quota.remaining === "number" ? ` · AI เหลือ ${ws.ai_quota.remaining}` : "";
    if (els.userLabel) {
      els.userLabel.textContent = `👤 ${name}${quotaLeft}`;
    }

    void api.setWorkspaceCache({
      folders,
      tags,
      recentItems: items,
      user: profile,
    });
  }

  function resetPreviewMetadata() {
    state.previewMeta = null;
    state.previewUrl = "";
    state.domMeta = null;
    state.domMetaUrl = "";
    if (els.previewSourceBadge) els.previewSourceBadge.textContent = "";
    renderPreviewThumbnail("", els.siteNameLabel ? els.siteNameLabel.textContent : "L");
  }

  async function fetchPreviewForUrl(targetUrl, forceRefresh = false) {
    if (!api.isSaveableHttpUrl(targetUrl)) return;
    if (els.previewSourceBadge) els.previewSourceBadge.textContent = "กำลังพรีวิว...";
    try {
      const preview = await api.apiRequest("/api/preview", {
        method: "POST",
        body: { url: targetUrl, force_refresh: forceRefresh },
      });
      if (els.urlInput.value.trim() !== targetUrl) return;
      state.previewMeta = preview;
      state.previewUrl = targetUrl;
      if (els.previewSourceBadge) {
        els.previewSourceBadge.textContent = preview.cached ? "แคช" : "✓";
      }

      if (preview.title && (!els.titleInput.value.trim() || forceRefresh)) {
        els.titleInput.value = preview.title;
      }
      els.siteNameLabel.textContent = formatDomainDisplay(targetUrl, preview.site_name || "");

      const mediaUrls = normalizeMediaUrlList(
        preview.media_items,
        preview.image_url || preview.thumbnail_url || ""
      );
      const thumb = preview.image_url || preview.thumbnail_url || mediaUrls[0] || "";
      if (thumb) {
        renderPreviewThumbnail(thumb, preview.site_name || targetUrl);
      }
    } catch (_err) {
      if (els.urlInput.value.trim() === targetUrl && els.previewSourceBadge) {
        els.previewSourceBadge.textContent = "";
      }
    }
  }

  async function checkDomAssistPermissionPassive(url) {
    if (!chrome.permissions || typeof chrome.permissions.contains !== "function") return false;
    try {
      const originPattern = new URL(url).origin + "/*";
      return await chrome.permissions.contains({ origins: [originPattern] });
    } catch (_err) {
      return false;
    }
  }

  function populateFromTabSync(tab) {
    if (!tab || !tab.url) return null;
    const rawUrl = tab.url.trim();
    const saveable = api.isSaveableHttpUrl(rawUrl);
    els.blockedTabCard.classList.toggle("hidden", saveable);
    if (!saveable) {
      els.urlInput.value = "";
      els.titleInput.value = "";
      els.siteNameLabel.textContent = tab.title || "แท็บระบบเบราว์เซอร์";
      if (els.urlEditRow) els.urlEditRow.classList.remove("hidden");
      renderPreviewThumbnail("", "L");
      return null;
    }

    state.activeTabId = tab.id || null;
    els.urlInput.value = rawUrl;
    els.titleInput.value = (tab.title || "").trim();
    const domain = formatDomainDisplay(rawUrl);
    els.siteNameLabel.textContent = domain;
    renderPreviewThumbnail(tab.favIconUrl || "", domain);
    return rawUrl;
  }

  async function enrichActiveTabAsync(tab, rawUrl) {
    if (!rawUrl) return;
    if (tab && tab.id && (await checkDomAssistPermissionPassive(rawUrl))) {
      try {
        const domMeta = await api.runDomAssist(tab.id);
        if (els.urlInput.value.trim() !== rawUrl) return;
        state.domMeta = domMeta;
        state.domMetaUrl = rawUrl;
        if (domMeta) {
          if (domMeta.title && (!els.titleInput.value || domMeta.title.length > els.titleInput.value.length)) {
            els.titleInput.value = domMeta.title;
          }
          if (domMeta.site_name) {
            els.siteNameLabel.textContent = formatDomainDisplay(rawUrl, domMeta.site_name);
          }
          if (domMeta.selected_text && !els.noteInput.value) {
            els.noteInput.value = domMeta.selected_text;
          }
          const domThumbs = normalizeMediaUrlList(domMeta.media_items);
          if (domThumbs[0]) {
            renderPreviewThumbnail(domThumbs[0], els.siteNameLabel.textContent);
          }
        }
      } catch (_err) {
        // Best effort only
      }
    }
    await fetchPreviewForUrl(rawUrl, false);
  }

  async function populateActiveTab() {
    if (!chrome.tabs || typeof chrome.tabs.query !== "function") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const rawUrl = populateFromTabSync(tab);
    if (rawUrl) {
      void enrichActiveTabAsync(tab, rawUrl);
    }
  }

  async function syncWorkspaceBackground(fallbackDisplay) {
    try {
      const ws = await api.fetchWorkspace({ limit: 50 });
      applyWorkspaceSnapshot(ws, fallbackDisplay);
    } catch (err) {
      if (err && err.status === 401) {
        await api.clearAuthSession();
        enterAuthView();
        showBanner("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง", "error");
        return;
      }
      showBanner(`ซิงก์ข้อมูลพื้นหลังไม่สำเร็จ (${err.message}) — บันทึกลิงก์ได้ทันทีหรือเข้าคิวออฟไลน์`, "error");
    }
  }

  function enterSaverView(preloadedSession = null, preloadedCache = null, preloadedTab = null) {
    els.authView.classList.add("hidden");
    els.saverView.classList.remove("hidden");
    if (els.submenuAccountRow) els.submenuAccountRow.classList.remove("hidden");
    setSaverPaneMode("save");
    renderReminderPicker();

    const session = preloadedSession || { user: null };
    const rawCache = preloadedCache || { folders: [], tags: [], recentItems: [], user: null };
    const sessionUid = String((session.user && session.user.id) || "").trim();
    const cacheUid = String((rawCache.user && rawCache.user.id) || "").trim();
    const cache =
      sessionUid && cacheUid && cacheUid !== sessionUid
        ? { folders: [], tags: [], recentItems: [], user: null }
        : rawCache;
    const cachedUser = session.user || cache.user;
    state.cachedUser = cachedUser;
    const userDisplay = (cachedUser && (cachedUser.display_name || cachedUser.email)) || "บัญชี Sharely";
    if (els.userLabel) {
      els.userLabel.textContent = `👤 ${userDisplay}`;
    }

    renderFoldersDropdown(cache.folders || []);
    renderTagChips(cache.tags || []);
    renderRecentItems(cache.recentItems || []);

    if (preloadedTab && preloadedTab.url) {
      const rawUrl = populateFromTabSync(preloadedTab);
      if (rawUrl) {
        void enrichActiveTabAsync(preloadedTab, rawUrl);
      }
    } else {
      void populateActiveTab();
    }

    void refreshOfflineQueueBanner();
    void syncWorkspaceBackground(userDisplay);
  }

  function resetSaverMemoryAndInputs() {
    state.selectedFolderId = "";
    state.selectedTags = [];
    state.cachedFolders = [];
    state.cachedTags = [];
    state.allRecentItems = [];
    state.cachedUser = null;
    state.lastSavedItemId = null;
    state.previewMeta = null;
    state.previewUrl = "";
    state.reminder = {
      pickerOpen: false,
      enabled: false,
      presetKey: "none",
      selectedDate: "",
      time: "18:00",
      scheduleType: "once",
      repeatEveryDays: 3,
      viewYearMonth: getBangkokTodayIso().slice(0, 7),
    };
    if (els.noteInput) els.noteInput.value = "";
    if (els.tagsInput) els.tagsInput.value = "";
    if (els.quickTagInput) els.quickTagInput.value = "";
    if (els.recentSearchInput) els.recentSearchInput.value = "";
    if (els.userLabel) els.userLabel.textContent = "";
    if (els.folderChipWrap) els.folderChipWrap.innerHTML = "";
    if (els.tagSuggestions) els.tagSuggestions.innerHTML = "";
    if (els.recentList) els.recentList.innerHTML = "";
    if (els.recentCount) els.recentCount.textContent = "0";
    if (els.offlineQueueBar) els.offlineQueueBar.classList.add("hidden");
    if (els.reminderPickerCard) els.reminderPickerCard.classList.add("hidden");
  }

  function enterAuthView() {
    resetSaverMemoryAndInputs();
    els.saverView.classList.add("hidden");
    els.authView.classList.remove("hidden");
    els.savedResultCard.classList.add("hidden");
    if (els.submenuAccountRow) els.submenuAccountRow.classList.add("hidden");
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
          "http://localhost:3000/*",
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
              const sessionRaw = localStorage.getItem("sharely_auth_session_v1");
              if (sessionRaw) {
                try {
                  const sessionParsed = JSON.parse(sessionRaw);
                  if (sessionParsed?.accessToken) {
                    return {
                      accessToken: sessionParsed.accessToken,
                      refreshToken: sessionParsed.refreshToken || "",
                      apiBaseUrl: sessionParsed.apiBaseUrl || "",
                    };
                  }
                } catch (_err) {
                  // Continue
                }
              }
              const legacyRaw =
                localStorage.getItem("sharely_testbed_state_v1") ||
                localStorage.getItem("sharely_test_state_v1");
              if (!legacyRaw) return null;
              const parsed = JSON.parse(legacyRaw);
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
              els.backendUrlInput.value = await api.setBackendUrl(data.apiBaseUrl);
            }
            const profile = await api.loginWithAccessToken(data.accessToken, data.refreshToken || "");
            enterSaverView({ user: profile }, await api.getWorkspaceCache(), null);
            showBanner("เชื่อมต่อบัญชีจากหน้าเว็บ Sharely สำเร็จแล้ว!", "success");
            return;
          }
        } catch (_err) {
          // Next tab
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
      enterSaverView({ user: authResp.user }, await api.getWorkspaceCache(), null);
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
      enterSaverView({ user: authResp.user }, await api.getWorkspaceCache(), null);
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
      const profile = await api.loginWithAccessToken(rawToken);
      els.tokenLoginInput.value = "";
      enterSaverView({ user: profile }, await api.getWorkspaceCache(), null);
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
      state.selectedFolderId = folder.id;
      state.cachedFolders = [...state.cachedFolders, folder];
      renderFoldersDropdown(state.cachedFolders);
      els.newFolderName.value = "";
      els.newFolderBox.classList.add("hidden");
      void api.setWorkspaceCache({
        folders: state.cachedFolders,
        tags: state.cachedTags,
        recentItems: state.allRecentItems,
        user: state.cachedUser,
      });
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
      if (els.urlEditRow) els.urlEditRow.classList.remove("hidden");
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

    const activePreviewMeta = state.previewMeta && state.previewUrl === url ? state.previewMeta : null;
    const activeDomMeta = state.domMeta && state.domMetaUrl === url ? state.domMeta : null;
    const previewImage =
      (activePreviewMeta && (activePreviewMeta.image_url || activePreviewMeta.thumbnail_url)) || "";
    const previewMedia = normalizeMediaUrlList(activePreviewMeta && activePreviewMeta.media_items, previewImage);
    const domMedia = normalizeMediaUrlList(activeDomMeta && activeDomMeta.media_items);
    const mergedMedia = previewMedia.length ? previewMedia : domMedia;
    const coverImage = previewImage || mergedMedia[0] || undefined;
    const tags = parseTagList();

    const payload = {
      url,
      title: els.titleInput.value.trim() || undefined,
      description:
        (activePreviewMeta && activePreviewMeta.description) ||
        (activeDomMeta && activeDomMeta.description) ||
        undefined,
      note: els.noteInput.value.trim() || undefined,
      folder_id: state.selectedFolderId || els.folderSelect.value || undefined,
      tags: tags.length ? tags : undefined,
      status: (els.statusSelect && els.statusSelect.value) || "inbox",
      platform: (activePreviewMeta && activePreviewMeta.platform) || undefined,
      content_type: (activePreviewMeta && activePreviewMeta.content_type) || undefined,
      image_url: coverImage,
      embed_type: (activePreviewMeta && activePreviewMeta.embed_type) || undefined,
      embed_url: (activePreviewMeta && activePreviewMeta.embed_url) || undefined,
      media_items: mergedMedia.length ? mergedMedia : undefined,
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
      els.savedTitleLabel.textContent = saved.deduplicated ? "✓ อัปเดตลิงก์เดิมในคลังแล้ว" : "✓ บันทึกลิงก์แล้ว";
      els.savedMetaText.textContent = `${saved.platform || "web"} · ${formatDomainDisplay(saved.url || url)}`;
      els.savedResultCard.classList.remove("hidden");
      els.blockedTabCard.classList.add("hidden");

      // Optimistically update in-memory & cached recent items without blocking on a repeat GET
      const mergedRecent = [saved, ...state.allRecentItems.filter((item) => item && item.id !== saved.id)].slice(0, 50);
      renderRecentItems(mergedRecent);
      if (tags.length) {
        for (const tagName of tags) {
          if (!state.cachedTags.some((t) => String(t.name || "").toLowerCase() === tagName.toLowerCase())) {
            state.cachedTags.unshift({ name: tagName });
          }
        }
        renderTagChips(state.cachedTags);
      }
      void api.setWorkspaceCache({
        folders: state.cachedFolders,
        tags: state.cachedTags,
        recentItems: mergedRecent,
        user: state.cachedUser,
      });
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
      els.saveItemBtn.textContent = "บันทึก";
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
      const isHidden = els.settingsPanel.classList.toggle("hidden");
      els.toggleSettingsBtn.setAttribute("aria-expanded", String(!isHidden));
    });

    els.saveSettingsBtn.addEventListener("click", async () => {
      const savedUrl = await api.setBackendUrl(els.backendUrlInput.value);
      els.backendUrlInput.value = savedUrl;
      syncLocalDemoVisibility(savedUrl);
      void updateHealthStatus(savedUrl);
      showBanner(`อัปเดต Backend URL เป็น ${savedUrl} แล้ว`, "info");
    });

    if (els.presetCloudBtn) {
      els.presetCloudBtn.addEventListener("click", async () => {
        const savedUrl = await api.setBackendUrl(api.BACKEND_PRESETS.cloud);
        els.backendUrlInput.value = savedUrl;
        syncLocalDemoVisibility(savedUrl);
        void updateHealthStatus(savedUrl);
        showBanner("สลับไปยัง Render Production Cloud แล้ว", "info");
      });
    }

    if (els.presetLocalBtn) {
      els.presetLocalBtn.addEventListener("click", async () => {
        const savedUrl = await api.setBackendUrl(api.BACKEND_PRESETS.local);
        els.backendUrlInput.value = savedUrl;
        syncLocalDemoVisibility(savedUrl);
        void updateHealthStatus(savedUrl);
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
    els.tabRecentBtn.addEventListener("click", () => {
      setSaverPaneMode("recent");
      // Paint immediately from memory/cache, then refresh silently in background
      void refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
    });

    els.flushQueueBtn.addEventListener("click", async () => {
      els.flushQueueBtn.disabled = true;
      try {
        const res = await api.flushOfflineQueue();
        await refreshOfflineQueueBanner();
        void refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
        showBanner(`ซิงก์คิวออฟไลน์สำเร็จ ${res.flushed} รายการ (คงเหลือ ${res.remaining})`, "success");
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
          void refreshRecentList(els.recentSearchInput.value);
        }, 280);
      });
    }
    if (els.refreshRecentBtn) {
      els.refreshRecentBtn.addEventListener("click", () => {
        void refreshRecentList(els.recentSearchInput ? els.recentSearchInput.value : "");
      });
    }

    els.logoutBtn.addEventListener("click", async () => {
      els.settingsPanel.classList.add("hidden");
      try {
        await api.apiRequest("/api/auth/logout", { method: "POST" });
      } catch (_err) {
        // Always clear local session
      }
      await api.clearAuthSession();
      enterAuthView();
    });

    if (els.toggleUrlEditBtn && els.urlEditRow) {
      els.toggleUrlEditBtn.addEventListener("click", () => {
        const isHidden = els.urlEditRow.classList.toggle("hidden");
        if (!isHidden) els.urlInput.focus();
      });
    }

    els.urlInput.addEventListener("input", () => {
      const nextUrl = els.urlInput.value.trim();
      if (api.isSaveableHttpUrl(nextUrl)) {
        els.blockedTabCard.classList.add("hidden");
        els.siteNameLabel.textContent = formatDomainDisplay(nextUrl);
      }
      if ((state.previewUrl && state.previewUrl !== nextUrl) || (state.domMetaUrl && state.domMetaUrl !== nextUrl)) {
        resetPreviewMetadata();
      }
    });

    els.refreshPreviewBtn.addEventListener("click", () => {
      void fetchPreviewForUrl(els.urlInput.value.trim(), true);
    });

    els.toggleNewFolderBtn.addEventListener("click", () => {
      els.newFolderBox.classList.toggle("hidden");
      if (!els.newFolderBox.classList.contains("hidden")) {
        els.newFolderName.focus();
      }
    });

    els.createFolderBtn.addEventListener("click", handleCreateFolder);
    els.newFolderName.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void handleCreateFolder();
      }
    });

    if (els.toggleTagInputBtn && els.quickTagRow) {
      els.toggleTagInputBtn.addEventListener("click", () => {
        const isHidden = els.quickTagRow.classList.toggle("hidden");
        if (!isHidden && els.quickTagInput) {
          els.quickTagInput.focus();
        }
      });
    }
    if (els.addQuickTagBtn) {
      els.addQuickTagBtn.addEventListener("click", addQuickTagsFromInput);
    }
    if (els.quickTagInput) {
      els.quickTagInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          addQuickTagsFromInput();
        }
      });
    }

    if (els.reminderTriggerBtn) {
      els.reminderTriggerBtn.addEventListener("click", () => {
        state.reminder.pickerOpen = !state.reminder.pickerOpen;
        if (state.reminder.pickerOpen && !state.reminder.selectedDate) {
          state.reminder.viewYearMonth = getBangkokTodayIso().slice(0, 7);
        }
        renderReminderPicker();
      });
    }

    if (els.clearReminderInlineBtn) {
      els.clearReminderInlineBtn.addEventListener("click", () => {
        applyReminderPreset("none");
      });
    }

    for (const chip of document.querySelectorAll("[data-rem-preset]")) {
      chip.addEventListener("click", () => {
        applyReminderPreset(chip.getAttribute("data-rem-preset") || "none");
      });
    }

    if (els.recurOnceBtn && els.recurRepeatBtn) {
      els.recurOnceBtn.addEventListener("click", () => {
        state.reminder.scheduleType = "once";
        renderReminderPicker();
      });
      els.recurRepeatBtn.addEventListener("click", () => {
        state.reminder.scheduleType = "every_n_days";
        if (!state.reminder.selectedDate) {
          state.reminder.enabled = true;
          state.reminder.selectedDate = getBangkokTodayIso();
        }
        renderReminderPicker();
      });
    }

    if (els.repeatDaysMinus && els.repeatDaysPlus) {
      els.repeatDaysMinus.addEventListener("click", () => {
        state.reminder.repeatEveryDays = Math.max(1, Number(state.reminder.repeatEveryDays || 3) - 1);
        renderReminderPicker();
      });
      els.repeatDaysPlus.addEventListener("click", () => {
        state.reminder.repeatEveryDays = Math.min(365, Number(state.reminder.repeatEveryDays || 3) + 1);
        renderReminderPicker();
      });
    }

    if (els.calPrevBtn && els.calNextBtn) {
      els.calPrevBtn.addEventListener("click", () => {
        state.reminder.viewYearMonth = stepYearMonth(state.reminder.viewYearMonth, -1);
        renderReminderPicker();
      });
      els.calNextBtn.addEventListener("click", () => {
        state.reminder.viewYearMonth = stepYearMonth(state.reminder.viewYearMonth, 1);
        renderReminderPicker();
      });
    }

    if (els.reminderTimeInput) {
      els.reminderTimeInput.addEventListener("input", () => {
        state.reminder.time = els.reminderTimeInput.value || "18:00";
        if (state.reminder.enabled) {
          renderReminderPicker();
        }
      });
    }

    els.saveForm.addEventListener("submit", handleSaveItem);
    els.aiSummarizeBtn.addEventListener("click", handleAiSummarize);
  }

  async function init() {
    bindEvents();
    const [session, cachedWorkspace, activeTabs] = await Promise.all([
      api.getSessionState(),
      api.getWorkspaceCache(),
      chrome.tabs && typeof chrome.tabs.query === "function"
        ? chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
        : Promise.resolve([]),
    ]);

    els.backendUrlInput.value = session.backendUrl;
    syncLocalDemoVisibility(session.backendUrl);
    void updateHealthStatus(session.backendUrl);

    if (session.accessToken) {
      const tab = Array.isArray(activeTabs) ? activeTabs[0] : null;
      enterSaverView(session, cachedWorkspace, tab);
    } else {
      enterAuthView();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
