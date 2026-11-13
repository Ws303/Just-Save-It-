/**
 * Shared UI primitives: Bottom Nav · Rounded, Filter Chips, Link Card, and Post Action Dialogs.
 */
import { icons, escHtml } from "../components/icons.js";
import { getFolderById } from "../state/store.js";

export function renderBottomNav(activeTab) {
  const tabs = [
    { id: "home", label: "หน้าหลัก", icon: icons.home(22) },
    { id: "folders", label: "โฟลเดอร์", icon: icons.folder(22) },
    { id: "ai", label: "AI", icon: icons.bot(22) },
    { id: "profile", label: "โปรไฟล์", icon: icons.profile(22) },
  ];

  return `
    <div class="bottom-nav-wrap">
      <nav class="bottom-nav" aria-label="Primary navigation">
        ${tabs
          .map(
            (t) => `
          <button class="nav-item ${activeTab === t.id ? "active" : ""}" data-nav="${t.id}">
            ${t.icon}
            <span>${t.label}</span>
          </button>`
          )
          .join("")}
      </nav>
    </div>
  `;
}

export function renderFilterChips(activeFilter, styleVariant = "home") {
  const chips = [
    { id: "all", label: "ทั้งหมด" },
    { id: "unread", label: "ยังไม่ได้ดู" },
    { id: "read", label: "ดูแล้ว" },
    { id: "favorite", label: "ชื่นชอบ", hasCherry: true },
  ];

  return `
    <div class="chip-row">
      ${chips
        .map((c) => {
          let cls = "filter-chip";
          if (activeFilter === c.id) {
            if (c.id === "favorite") cls += " active-fav";
            else cls += styleVariant === "dark" ? " active-dark" : " active-home";
          }
          const cherryHtml = c.hasCherry
            ? `<span style="color: var(--theme-swatch); display:inline-flex;">${icons.cherry(15)}</span>`
            : "";
          return `
            <button class="${cls}" data-filter-chip="${c.id}" data-filter-scope="${styleVariant}">
              ${cherryHtml}
              <span>${c.label}</span>
            </button>`;
        })
        .join("")}
    </div>
  `;
}

export function renderLinkCard(item, { folderContextId = null, selected = false } = {}) {
  const folder = getFolderById(item.folderId);
  const statusLabel = item.status === "read" ? "ดูแล้ว" : "ยังไม่ได้ดู";
  const folderLabel = folder ? folder.name : "ทั่วไป";
  const isRecentlyShared = window.__lastSharedHighlightId === item.id || item.savedAgo === "เมื่อสักครู่";
  const isPinned = Boolean(item.pinned);

  return `
    <div class="link-card ${selected ? "selected" : ""} ${isRecentlyShared ? "recently-shared" : ""}" data-link-card="${item.id}">
      <div class="link-thumb" data-open-link="${item.id}">
        ${
          folder?.cover
            ? `<img src="${escHtml(folder.cover)}" alt="" style="opacity:0.38; position:absolute; inset:0;" />`
            : ""
        }
        <span style="position:relative; z-index:1; font-size:10.5px; color:#233642; background:rgba(255,255,255,0.86); padding:2px 6px; border-radius:6px;">
          ${escHtml(item.platform)}
        </span>
      </div>
      <div class="link-body" data-open-link="${item.id}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <p class="link-platform" style="margin:0;">${escHtml(item.platform)}</p>
          ${isPinned ? `<span style="font-size:10px;font-weight:700;background:#111;color:#fff;padding:1px 6px;border-radius:4px;">📌 ปักหมุด</span>` : ""}
          ${isRecentlyShared ? `<span class="new-incoming-pill">✨ เพิ่งแชร์เข้ามา</span>` : ""}
        </div>
        <p class="link-title">${escHtml(item.title)}</p>
        <p class="link-sub">
          <span>${escHtml(folderLabel)} · ${statusLabel}</span>
          ${item.aiSummary ? `<span class="ai-badge-pill">AI</span>` : ""}
        </p>
      </div>
      <div class="link-actions">
        <button class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${item.id}" title="ชื่นชอบ">
          ${icons.cherry(18)}
        </button>
        <button class="icon-btn" style="width:30px;height:30px;color:#5c6269;" data-open-post-menu="${item.id}" data-menu-folder="${folderContextId || ""}" title="เมนูโพสต์">
          ${icons.kebab(16)}
        </button>
      </div>
    </div>
  `;
}

export function renderPostMenuAndDialog(ui, links) {
  const sheet = ui.activeSheet;
  if (!sheet) return "";

  if (sheet.type === "postMenu") {
    const item = links.find((l) => l.id === sheet.linkId);
    if (!item) return "";
    const inFolder = Boolean(sheet.folderContextId);
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:17px;">เมนูโพสต์</strong>
            <button class="icon-btn" data-close-sheet="1">${icons.close(17)}</button>
          </div>
          <p class="tiny-hint" style="margin:0;">${escHtml(item.title)}</p>
          <div class="settings-card">
            <button class="settings-row" data-open-link="${item.id}">
              <span>เปิดรายละเอียดลิงก์</span>
              ${icons.chevronRight(16)}
            </button>
            <button class="settings-row" data-toggle-status-sheet="${item.id}">
              <span>${item.status === "read" ? "ทำเครื่องหมายว่ายังไม่ได้ดู" : "ทำเครื่องหมายว่าดูแล้ว"}</span>
              ${icons.check(16)}
            </button>
            <button class="settings-row" data-trigger-ai-sheet="${item.id}">
              <span>สรุปเนื้อหาด้วย AI</span>
              <span class="ai-badge-pill">AI</span>
            </button>
            <button class="settings-row" style="color:var(--theme-accent-text);font-weight:700;" data-confirm-delete-post="${item.id}" data-delete-mode="${inFolder ? "removeFromFolder" : "delete"}" data-folder-id="${sheet.folderContextId || ""}">
              <span>${inFolder ? "นำออกจากโฟลเดอร์" : "ลบโพสต์"}</span>
              ${icons.close(16)}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  if (sheet.type === "deletePostDialog") {
    const item = links.find((l) => l.id === sheet.linkId);
    if (!item) return "";
    const isRemove = sheet.mode === "removeFromFolder";
    return `
      <div class="modal-backdrop center" data-close-sheet="1">
        <div class="center-dialog" onclick="event.stopPropagation()">
          <h3 style="margin:0;font-size:19px;color:var(--ink-primary);">
            ${isRemove ? "นำออกจากโฟลเดอร์?" : "ลบโพสต์นี้ไหม?"}
          </h3>
          <p style="margin:0;font-size:14px;font-weight:600;color:var(--ink-primary);">${escHtml(item.title)}</p>
          <p style="margin:0;font-size:13px;color:var(--ink-secondary);">
            ${
              isRemove
                ? "โพสต์นี้จะถูกนำออกจากโฟลเดอร์ปัจจุบัน"
                : "โพสต์นี้จะถูกลบออกจากรายการที่บันทึกไว้อย่างถาวร"
            }
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-execute-delete-post="${item.id}" data-delete-mode="${sheet.mode}">
              ${isRemove ? "นำออก" : "ลบโพสต์"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
