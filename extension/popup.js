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
    activeViewMode: "save", // "save" | "recent"
    domMeta: null,
    previewMeta: null,
    lastSavedItemId: null,
    activeTabId: null,
    allRecentItems: [],
    cachedFolders: [],
    cachedTags: [],
    userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
    reminder: {
      pickerOpen: false,
      enabled: false,
      presetKey: "none",
      selectedDate: "",
      time: "18:00",
      scheduleType: "once", // "once" | "every_n_days"
      repeatEveryDays: 3,
      viewYearMonth: getBangkokTodayIso().slice(0, 7),
    },
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

    reminderTriggerBtn: document.getElementById("reminderTriggerBtn"),
    reminderSummaryLabel: document.getElementById("reminderSummaryLabel"),
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

  function renderFoldersDropdown(folders) {
    state.cachedFolders = Array.isArray(folders) ? folders : [];
    const currentFolderId = els.folderSelect.value;
    els.folderSelect.innerHTML = '<option value="">-- ยังไม่เลือกโฟลเดอร์ --</option>';
    for (const folder of state.cachedFolders) {
      const opt = document.createElement("option");
      opt.value = folder.id;
      opt.textContent = `${folder.emoji || "📁"} ${folder.name}`;
      els.folderSelect.appendChild(opt);
    }
    if (currentFolderId && state.cachedFolders.some((f) => f.id === currentFolderId)) {
      els.folderSelect.value = currentFolderId;
    }
  }

  function renderTagChips(tags) {
    state.cachedTags = Array.isArray(tags) ? tags : [];
    els.tagSuggestions.innerHTML = "";
    for (const tag of state.cachedTags.slice(0, 12)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      btn.dataset.tagName = tag.name;
      btn.textContent = `#${tag.name}`;
      btn.addEventListener("click", () => toggleTagChip(tag.name));
      els.tagSuggestions.appendChild(btn);
    }
    syncTagChipSelection();
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

  function renderReminderPicker() {
    const r = state.reminder;
    if (els.reminderPickerCard) {
      els.reminderPickerCard.classList.toggle("hidden", !r.pickerOpen);
    }
    if (els.reminderTriggerBtn) {
      els.reminderTriggerBtn.classList.toggle("has-reminder", Boolean(r.enabled && r.selectedDate));
    }
    if (els.reminderSummaryLabel) {
      if (!r.enabled || !r.selectedDate) {
        els.reminderSummaryLabel.textContent = "⏰ ไม่ตั้งเตือน";
      } else if (r.scheduleType === "every_n_days") {
        els.reminderSummaryLabel.textContent = `🔁 ทุก ${r.repeatEveryDays} วัน · ${r.time}`;
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

  function buildReminderPayload() {
    const r = state.reminder;
    if (!r.enabled || !r.selectedDate) return undefined;

    const [hhRaw, mmRaw] = String(r.time || "18:00").split(":");
    const hh = String(Math.max(0, Math.min(23, Number(hhRaw) || 18))).padStart(2, "0");
    const mm = String(Math.max(0, Math.min(59, Number(mmRaw) || 0))).padStart(2, "0");
    const isoLocalBangkok = `${r.selectedDate}T${hh}:${mm}:00+07:00`;
    const remindAtDate = new Date(isoLocalBangkok);
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
      const itemsRes = await api.fetchRecentItems({ search, limit: 20 });
      const items = itemsRes.items || [];
      renderRecentItems(items);
      if (!search) {
        api.setWorkspaceCache({
          folders: state.cachedFolders,
          tags: state.cachedTags,
          recentItems: items,
        }).catch(() => {});
      }
    } catch (err) {
      showBanner(`โหลดรายการล่าสุดไม่สำเร็จ: ${err.message}`, "error");
    }
  }

  async function loadUserWorkspace(profileUser = null) {
    const [foldersRes, tagsRes, itemsRes] = await Promise.all([
      api.apiRequest("/api/folders"),
      api.apiRequest("/api/tags"),
      api.fetchRecentItems({ limit: 20 }),
    ]);

    const folders = foldersRes.folders || [];
    const tags = tagsRes.tags || [];
    const items = itemsRes.items || [];
    renderFoldersDropdown(folders);
    renderTagChips(tags);
    renderRecentItems(items);

    await api.setWorkspaceCache({
      folders,
      tags,
      recentItems: items,
      user: profileUser,
    });
  }

  async function fetchPreviewForUrl(targetUrl, forceRefresh = false) {
    if (!api.isSaveableHttpUrl(targetUrl)) return;
    els.previewSourceBadge.textContent = "กำลังพรีวิว...";
    try {
      const preview = await api.apiRequest("/api/preview", {
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

      const mediaUrls = normalizeMediaUrlList(
        preview.media_items,
        preview.image_url || preview.thumbnail_url || ""
      );
      const thumb = preview.image_url || preview.thumbnail_url || mediaUrls[0] || "";
      if (thumb) {
        renderPreviewThumbnail(thumb);
      }
    } catch (_err) {
      els.previewSourceBadge.textContent = "ใช้ข้อมูลแท็บ";
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
      els.platformBadge.textContent = "browser";
      els.contentTypeBadge.textContent = "blocked";
      els.previewSourceBadge.textContent = "ไม่รองรับแท็บนี้";
      els.siteNameLabel.textContent = tab.title || "แท็บระบบเบราว์เซอร์";
      return null;
    }

    state.activeTabId = tab.id || null;
    els.urlInput.value = rawUrl;
    els.titleInput.value = (tab.title || "").trim();
    els.siteNameLabel.textContent = rawUrl;
    return rawUrl;
  }

  async function enrichActiveTabAsync(tab, rawUrl) {
    if (!rawUrl) return;
    if (tab && tab.id && (await checkDomAssistPermissionPassive(rawUrl))) {
      try {
        const domMeta = await api.runDomAssist(tab.id);
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
          const domThumbs = normalizeMediaUrlList(domMeta.media_items);
          if (domThumbs[0]) {
            renderPreviewThumbnail(domThumbs[0]);
          }
        }
      } catch (_err) {
        // Passive DOM assist best-effort only
      }
    }
    await fetchPreviewForUrl(rawUrl, false);
  }

  async function populateActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const rawUrl = populateFromTabSync(tab);
    if (rawUrl) {
      await enrichActiveTabAsync(tab, rawUrl);
    }
  }

  async function enterSaverView(preloadedSession = null, preloadedCache = null, preloadedTab = null) {
    els.authView.classList.add("hidden");
    els.saverView.classList.remove("hidden");
    setSaverPaneMode("save");
    renderReminderPicker();

    const session = preloadedSession || (await api.getSessionState());
    const cache = preloadedCache || (await api.getWorkspaceCache());
    const cachedUser = cache.user || session.user;
    const userDisplay = (cachedUser && (cachedUser.display_name || cachedUser.email)) || "บัญชี Sharely";
    els.userLabel.textContent = `👤 ${userDisplay}`;

    if (cache.folders.length) renderFoldersDropdown(cache.folders);
    if (cache.tags.length) renderTagChips(cache.tags);
    if (cache.recentItems.length) renderRecentItems(cache.recentItems);

    if (preloadedTab && preloadedTab.url) {
      const rawUrl = populateFromTabSync(preloadedTab);
      if (rawUrl) {
        void enrichActiveTabAsync(preloadedTab, rawUrl);
      }
    } else {
      void populateActiveTab();
    }

    void refreshOfflineQueueBanner();

    try {
      const [me] = await Promise.all([
        api.apiRequest("/api/auth/me"),
        loadUserWorkspace(),
      ]);
      const profile = (me && (me.user || me.profile)) || {};
      const name = profile.display_name || profile.email || userDisplay;
      const quotaLeft =
        me && me.ai_quota && typeof me.ai_quota.remaining === "number" ? ` · AI เหลือ ${me.ai_quota.remaining}` : "";
      els.userLabel.textContent = `👤 ${name}${quotaLeft}`;
      void api.setWorkspaceCache({
        folders: state.cachedFolders,
        tags: state.cachedTags,
        recentItems: state.allRecentItems,
        user: profile,
      });
    } catch (err) {
      if (err.status === 401) {
        await api.clearAuthSession();
        enterAuthView();
        showBanner("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง", "error");
        return;
      }
      showBanner(`ซิงก์ข้อมูลพื้นหลังไม่สำเร็จ (${err.message}) — บันทึกลิงก์ได้ทันทีหรือเข้าคิวออฟไลน์`, "error");
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
                  // Continue to legacy state fallback
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

    const previewImage =
      (state.previewMeta && (state.previewMeta.image_url || state.previewMeta.thumbnail_url)) || "";
    const previewMedia = normalizeMediaUrlList(state.previewMeta && state.previewMeta.media_items, previewImage);
    const domMedia = normalizeMediaUrlList(state.domMeta && state.domMeta.media_items);
    const mergedMedia = previewMedia.length ? previewMedia : domMedia;
    const coverImage = previewImage || mergedMedia[0] || undefined;
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
      image_url: coverImage,
      embed_type: (state.previewMeta && state.previewMeta.embed_type) || undefined,
      embed_url: (state.previewMeta && state.previewMeta.embed_url) || undefined,
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

    if (els.reminderTriggerBtn) {
      els.reminderTriggerBtn.addEventListener("click", () => {
        state.reminder.pickerOpen = !state.reminder.pickerOpen;
        if (state.reminder.pickerOpen && !state.reminder.selectedDate) {
          state.reminder.viewYearMonth = getBangkokTodayIso().slice(0, 7);
        }
        renderReminderPicker();
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
      await enterSaverView(session, cachedWorkspace, tab);
    } else {
      enterAuthView();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
