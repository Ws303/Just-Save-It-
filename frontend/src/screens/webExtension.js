/**
 * Desktop & Browser Extension Views from Figma:
 * - W1 Web – Folder view (51:127): 3-column Sidebar + Filtered List + Detail Panel
 * - E1 Extension popup (51:248): 360x560 quick save popup
 */
import { icons, escHtml } from "../components/icons.js";
import { filterLinks, getFolderById, getFolderCount, getLinkById } from "../state/store.js";

export function renderWebView(state) {
  const { folders, links } = state.data;
  const activeFolderId = state.ui.activeFolderId || folders[0]?.id;
  const activeFolder = getFolderById(activeFolderId) || folders[0];
  const folderLinks = state.ui.webScope === "all"
    ? links
    : state.ui.webScope === "unread"
      ? links.filter((l) => l.status === "unread")
      : links.filter((l) => l.folderId === activeFolder.id);

  const visibleLinks = filterLinks(folderLinks, state.ui.folderDetailSearch, state.ui.folderDetailFilter);
  const selectedItem = getLinkById(state.ui.activeLinkId) || visibleLinks[0] || links[0];
  const unreadTotal = links.filter((l) => l.status === "unread").length;

  return `
    <div class="w1-frame">
      <!-- Column 1: Sidebar -->
      <aside class="w1-sidebar">
        <div class="brand-heading" style="font-size:21px;padding:4px 10px 8px;">Sharely</div>

        <button class="w1-nav-btn ${state.ui.webScope === "all" ? "active" : ""}" data-web-scope="all">
          <span>หน้าหลัก</span>
          <span class="tiny-hint">${links.length}</span>
        </button>
        <button class="w1-nav-btn ${state.ui.webScope === "unread" ? "active" : ""}" data-web-scope="unread">
          <span>ยังไม่ได้ดู</span>
          <span class="tiny-hint">${unreadTotal}</span>
        </button>

        <div class="tiny-hint" style="padding:10px 10px 2px;font-weight:700;">โฟลเดอร์</div>
        ${folders
          .map(
            (f) => `
          <button
            class="w1-nav-btn ${state.ui.webScope !== "all" && state.ui.webScope !== "unread" && f.id === activeFolder.id ? "active" : ""}"
            data-web-folder="${f.id}"
          >
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(f.name)}</span>
            <span class="tiny-hint">${getFolderCount(f)}</span>
          </button>`
          )
          .join("")}

        <button class="w1-nav-btn" style="color:var(--ink-secondary);" data-open-create-folder="1">+ โฟลเดอร์ใหม่</button>

        <button class="btn-dark-pill" style="height:42px;font-size:13px;margin-top:8px;" data-open-save-sheet="${activeFolder.id}">
          + วางลิงก์ใหม่
        </button>

        <button class="w1-nav-btn" style="margin-top:auto;" data-viewport-switch="mobile" data-go-screen="profile">
          <span>โปรไฟล์ (${escHtml(state.data.user.displayName)})</span>
        </button>
      </aside>

      <!-- Column 2: Link list -->
      <section class="w1-main">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <h2 style="margin:0;font-size:22px;">
            ${
              state.ui.webScope === "all"
                ? "ลิงก์ทั้งหมด"
                : state.ui.webScope === "unread"
                  ? "รายการที่ยังไม่ได้ดู"
                  : escHtml(activeFolder.name)
            }
          </h2>
          <div class="inline-flex-row">
            <div class="avatar-circle" style="width:28px;height:28px;">ม</div>
            <div class="avatar-circle" style="width:28px;height:28px;">ต</div>
            <button class="btn-dark-pill" style="width:auto;height:36px;padding:0 14px;font-size:13px;" data-open-invite-sheet="${activeFolder.id}">
              เชิญเพื่อน
            </button>
          </div>
        </div>

        <div class="search-box" style="height:40px;">
          ${icons.search(16)}
          <input
            type="search"
            placeholder="ค้นหาชื่อ แท็ก โน้ต"
            value="${escHtml(state.ui.folderDetailSearch)}"
            data-search-input="folderDetail"
          />
        </div>

        <div class="chip-row">
          ${[
            { id: "all", label: "ทั้งหมด" },
            { id: "unread", label: "ยังไม่ดู" },
            { id: "read", label: "ดูแล้ว" },
            { id: "favorite", label: "ชื่นชอบ", cherry: true },
          ]
            .map(
              (c) => `
            <button class="filter-chip ${state.ui.folderDetailFilter === c.id ? "active-dark" : ""}" data-filter-chip="${c.id}" data-filter-scope="dark">
              ${c.cherry ? `<span style="color:var(--theme-swatch);display:inline-flex;">${icons.cherry(14)}</span>` : ""}
              <span>${c.label}</span>
            </button>`
            )
            .join("")}
        </div>

        <div class="link-list">
          ${visibleLinks
            .map(
              (item) => `
            <div class="link-card ${selectedItem?.id === item.id ? "selected" : ""}" style="cursor:pointer;" data-select-web-link="${item.id}">
              <div class="link-thumb" style="width:60px;height:60px;">
                <span>${escHtml(item.platform)}</span>
              </div>
              <div class="link-body">
                <p class="link-title" style="font-size:14px;">${escHtml(item.title)}</p>
                <p class="link-sub">${escHtml(item.platform)} · ${escHtml(item.savedAgo)}</p>
                <div style="margin-top:4px;">
                  ${(item.tags || []).slice(0, 2).map((t) => `<span class="ai-badge-pill" style="margin-right:4px;">${escHtml(t)}</span>`).join("")}
                </div>
              </div>
              <button class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${item.id}">
                ${icons.cherry(17)}
              </button>
            </div>`
            )
            .join("")}
        </div>
      </section>

      <!-- Column 3: Detail Panel -->
      <aside class="w1-detail">
        ${
          selectedItem
            ? `
          <div class="media-hero" style="height:155px;">
            <button class="play-circle-btn" style="width:48px;height:48px;">${icons.play(20)}</button>
          </div>
          <a href="${escHtml(selectedItem.url)}" target="_blank" rel="noopener noreferrer" style="font-size:16px;font-weight:700;text-decoration:underline;display:inline-flex;align-items:center;gap:6px;">
            <span>${escHtml(selectedItem.title)}</span>
            ${icons.externalLink(15)}
          </a>
          <p class="tiny-hint" style="margin:0;">
            ${escHtml(selectedItem.platform)} · ${escHtml(selectedItem.savedAgo)} · โฟลเดอร์ ${escHtml(getFolderById(selectedItem.folderId)?.name || "")}
          </p>
          <div class="ai-summary-card">
            <div class="ai-summary-head">
              <strong style="font-size:13px;">สรุปเนื้อหา</strong>
              <span class="ai-badge-pill">AI</span>
            </div>
            <p style="margin:0 0 8px;font-size:12.5px;line-height:1.5;">
              ${escHtml(selectedItem.aiSummary || "ยังไม่มีคำสรุป AI กดปุ่มเพื่อสร้างสรุปทันที")}
            </p>
            <button class="btn-accent-pill" style="height:30px;padding:0 10px;font-size:12px;" data-run-ai-summarize="${selectedItem.id}">
              สรุปด้วย AI
            </button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
            <div class="chip-row">${(selectedItem.tags || []).map((t) => `<span class="ai-badge-pill">${escHtml(t)}</span>`).join("")}</div>
            <label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" ${selectedItem.status === "read" ? "checked" : ""} data-toggle-seen="${selectedItem.id}" />
              ดูแล้ว
            </label>
          </div>
          <textarea class="note-textarea" style="min-height:80px;" placeholder="เพิ่มโน้ต..." data-edit-note="${selectedItem.id}">${escHtml(selectedItem.note || "")}</textarea>
          <div>
            <span class="reminder-pill" style="height:34px;font-size:12.5px;">
              ${icons.clock(15)} ${escHtml(selectedItem.reminder || "ไม่ได้ตั้งเตือน")}
            </span>
          </div>
          <a class="btn-dark-pill" style="height:44px;font-size:14px;margin-top:auto;" href="${escHtml(selectedItem.url)}" target="_blank" rel="noopener noreferrer">
            เปิดลิงก์ต้นฉบับ
          </a>`
            : `<p class="tiny-hint">เลือกลิงก์ทางซ้ายเพื่อดูรายละเอียด</p>`
        }
      </aside>
    </div>
  `;
}

export function renderExtensionPopup(state) {
  const draft = state.ui.extensionDraft || {
    url: "https://www.tiktok.com/@minimal.ari/video/74009911",
    title: "คาเฟ่สายมินิมอลอารีย์",
    domain: "tiktok.com",
    folderId: state.data.folders[0]?.id,
    tags: ["#คาเฟ่"],
    note: "",
    reminder: "",
  };
  const folders = state.data.folders.slice(0, 4);

  return `
    <div class="e1-popup">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <strong style="font-size:18px;color:var(--ink-strong);">Sharely Extension</strong>
        <div class="avatar-circle" style="width:32px;height:32px;background:var(--theme-soft);color:var(--theme-accent-text);">
          ${escHtml(state.data.user.displayName.charAt(0))}
        </div>
      </div>

      <div style="display:flex;gap:6px;">
        <input class="tb-mini-input" style="flex:1;" type="url" value="${escHtml(draft.url)}" data-ext-url="1" />
        <button class="tb-btn" data-ext-unfurl="1">Unfurl</button>
      </div>

      <div class="link-card" style="padding:11px;">
        <div class="link-thumb" style="width:64px;height:64px;">Link</div>
        <div class="link-body">
          <p class="link-title" style="font-size:14.5px;">${escHtml(draft.title)}</p>
          <p class="link-sub">${escHtml(draft.domain)}</p>
        </div>
      </div>

      <div>
        <strong style="font-size:13.5px;display:block;margin-bottom:6px;">โฟลเดอร์</strong>
        <div class="chip-row" style="flex-wrap:wrap;">
          ${folders
            .map(
              (f) => `
            <button class="filter-chip ${draft.folderId === f.id ? "active-dark" : ""}" style="height:34px;font-size:12.5px;" data-ext-folder="${f.id}">
              ${escHtml(f.name)}
            </button>`
            )
            .join("")}
        </div>
      </div>

      <div>
        <strong style="font-size:13.5px;display:block;margin-bottom:6px;">แท็ก</strong>
        <div class="chip-row" style="flex-wrap:wrap;">
          ${["#คาเฟ่", "#อารีย์", "#ไอเดีย"]
            .map(
              (tag) => `
            <button class="filter-chip ${draft.tags.includes(tag) ? "active-dark" : ""}" style="height:34px;font-size:12.5px;" data-ext-tag="${escHtml(tag)}">
              ${escHtml(tag)}
            </button>`
            )
            .join("")}
        </div>
      </div>

      <input class="field-input" style="height:44px;" type="text" value="${escHtml(draft.note)}" placeholder="เพิ่มโน้ต (ไม่บังคับ)" data-ext-note="1" />

      <div>
        <button class="reminder-pill" data-ext-toggle-reminder="1">
          ${icons.clock(16)}
          <span>${escHtml(draft.reminder || "ตั้งเตือน")}</span>
        </button>
      </div>

      <button class="btn-dark-pill" style="margin-top:auto;" data-ext-submit="1">บันทึก</button>
    </div>
  `;
}
