/**
 * Desktop & Browser Extension Views from Figma:
 * - Sharely PC Home & Workspace (383:9129): 3-column 1440x900 (272px Sidebar | Center Feed | 412px Detail Inspector)
 * - E1 Extension popup (51:248): 360x560 quick save popup
 */
import { icons, escHtml, safeHrefUrl, safeImgUrl } from "../components/icons.js";
import { filterLinks, getFolderById, getFolderCount, getLinkById } from "../state/store.js";
import { renderNotificationsFullScreen } from "./home.js";
import { renderLinkCard } from "./common.js";
import { renderLinkDetailModals, renderRichPreviewBox } from "./links.js";

function renderDesktopFolderThumb(folder) {
  const safeSrc = safeImgUrl(folder?.cover);
  if (safeSrc) {
    return `<img src="${escHtml(safeSrc)}" alt="${escHtml(folder.name || "")}" />`;
  }
  return `<div class="pc-folder-cover-empty">${escHtml(folder?.emoji || "📁")}</div>`;
}

export function renderWebView(state) {
  const folders = state.data.folders || [];
  const links = state.data.links || [];
  const ui = state.ui;
  const activeFolderId = ui.activeFolderId || folders[0]?.id;
  const activeFolder = getFolderById(activeFolderId) || folders[0];
  const webScope = ui.webScope || "all";

  const scopedLinks =
    webScope === "all"
      ? links
      : webScope === "unread"
        ? links.filter((l) => l.status === "unread")
        : webScope === "favorite"
          ? links.filter((l) => Boolean(l.favorite))
          : links.filter((l) => l.folderId === activeFolder?.id);

  const visibleLinks = filterLinks(scopedLinks, ui.folderDetailSearch, ui.folderDetailFilter);
  const selectedItem = getLinkById(ui.activeLinkId) || visibleLinks[0] || links[0];
  const unreadTotal = links.filter((l) => l.status === "unread").length;
  const unreadNotifications = (state.data.notifications || []).filter((n) => n.unread).length;
  const showNotifications = Boolean(ui.notificationScreenOpen || ui.showNotifications);

  const headingTitle =
    webScope === "all"
      ? "ลิงก์ที่บันทึกไว้"
      : webScope === "unread"
        ? "รายการที่ยังไม่ได้ดู"
        : webScope === "favorite"
          ? "รายการที่ชื่นชอบ"
          : activeFolder?.name || "โฟลเดอร์";

  const selectedFolder = selectedItem ? getFolderById(selectedItem.folderId) : null;
  const isSelectedSeen = selectedItem?.status === "read";

  return `
    <div class="pc-shell" data-node-id="383:9129">
      <!-- Column 1: Left Sidebar (272px, 384:3028) -->
      <aside class="pc-sidebar" data-node-id="384:3028">
        <div class="pc-sidebar-brand">
          <div class="pc-brand-title">Sharely</div>
          <div class="pc-brand-sub">เซฟไว้ก่อน ค่อยกลับมาดู</div>
        </div>

        <nav class="pc-nav-group" data-node-id="384:3030">
          <button
            type="button"
            class="pc-nav-item ${webScope === "all" && !showNotifications ? "active" : ""}"
            data-web-scope="all"
          >
            <span class="pc-nav-ico">${icons.home(20)}</span>
            <span class="pc-nav-label">หน้าหลัก</span>
            <span class="pc-nav-badge">${links.length}</span>
          </button>

          <button
            type="button"
            class="pc-nav-item ${webScope === "unread" && !showNotifications ? "active" : ""}"
            data-web-scope="unread"
          >
            <span class="pc-nav-ico">${icons.clock(20)}</span>
            <span class="pc-nav-label">ยังไม่ได้ดู</span>
            <span class="pc-nav-badge">${unreadTotal}</span>
          </button>

          <button
            type="button"
            class="pc-nav-item ${webScope === "favorite" && !showNotifications ? "active" : ""}"
            data-web-scope="favorite"
          >
            <span class="pc-nav-ico">${icons.cherry(20)}</span>
            <span class="pc-nav-label">ชื่นชอบ</span>
          </button>

          <button
            type="button"
            class="pc-nav-item"
            data-viewport-switch="mobile"
            data-go-screen="ai"
          >
            <span class="pc-nav-ico">${icons.bot(20)}</span>
            <span class="pc-nav-label">AI</span>
          </button>

          <button
            type="button"
            class="pc-nav-item"
            data-viewport-switch="mobile"
            data-go-screen="profile"
          >
            <span class="pc-nav-ico">${icons.profile(20)}</span>
            <span class="pc-nav-label">โปรไฟล์</span>
          </button>
        </nav>

        <div class="pc-folder-sidebar-head">
          <span>โฟลเดอร์ของฉัน</span>
          <button type="button" class="pc-folder-plus-btn" data-open-create-folder="1" title="สร้างโฟลเดอร์">+</button>
        </div>

        <div class="pc-folder-nav-list">
          ${folders
            .map((f) => {
              const isActive = webScope === "folder" && f.id === activeFolder?.id && !showNotifications;
              return `
                <button
                  type="button"
                  class="pc-nav-item compact ${isActive ? "active" : ""}"
                  data-web-folder="${escHtml(f.id)}"
                >
                  <span class="pc-nav-emoji">${escHtml(f.emoji || "📁")}</span>
                  <span class="pc-nav-label">${escHtml(f.name)}</span>
                  <span class="pc-nav-badge">${getFolderCount(f)}</span>
                </button>`;
            })
            .join("")}
        </div>

        <div class="pc-sidebar-footer">
          <div class="pc-user-pill">
            <span class="pc-user-avatar">${escHtml((state.data.user?.displayName || "P").charAt(0).toUpperCase())}</span>
            <div class="pc-user-meta">
              <strong>${escHtml(state.data.user?.displayName || "Ploy")}</strong>
              <span>${escHtml(state.data.user?.email || "")}</span>
            </div>
          </div>
          <button type="button" class="pc-logout-btn" data-open-logout-dialog="1" title="ออกจากระบบ">
            ${icons.signout(16)}
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </aside>

      <!-- Column 2: Center Workspace (Figma 383:9130) -->
      <main class="pc-main" data-node-id="383:9130">
        ${
          showNotifications
            ? `
          <div class="pc-notif-wrap">
            ${renderNotificationsFullScreen(state)}
          </div>`
            : `
          <header class="pc-main-header" data-node-id="383:9131">
            <div class="pc-main-title-wrap">
              <h1 class="pc-main-title">${escHtml(headingTitle)}</h1>
              ${
                webScope === "folder" && activeFolder
                  ? `<span class="pc-folder-count-tag">${getFolderCount(activeFolder)} รายการ</span>`
                  : ""
              }
            </div>
            <div class="pc-main-actions" data-node-id="383:9133">
              ${
                webScope === "folder" && activeFolder
                  ? `
                <button type="button" class="pc-invite-btn" data-open-invite-sheet="${escHtml(activeFolder.id)}">
                  ${icons.people(16)}
                  <span>เชิญเพื่อน</span>
                </button>`
                  : ""
              }
              <button type="button" class="figma-add-pill-btn" data-open-save-sheet="${escHtml(activeFolder?.id || "")}">
                ${icons.plus(18)}
                <span>เพิ่มลิงก์</span>
              </button>
              <button type="button" class="figma-bell-btn" data-action="open-notifications" title="การแจ้งเตือน">
                ${icons.bell(19)}
                ${unreadNotifications > 0 ? `<span class="figma-bell-dot"></span>` : ""}
              </button>
            </div>
          </header>

          <div class="pc-search-filter-block" data-node-id="383:9142">
            <div class="pc-search-bar">
              <span class="figma-search-icon">${icons.search(17)}</span>
              <input
                type="search"
                placeholder="ค้นหาลิงก์ โน้ต หรือแท็ก"
                value="${escHtml(ui.folderDetailSearch || "")}"
                data-search-input="folderDetail"
              />
            </div>

            <div class="figma-filter-row" role="tablist">
              ${[
                { id: "all", label: "ทั้งหมด" },
                { id: "unread", label: "ยังไม่ได้ดู" },
                { id: "read", label: "ดูแล้ว" },
                { id: "favorite", label: "ชื่นชอบ", cherry: true },
              ]
                .map(
                  (c) => `
                <button
                  type="button"
                  class="figma-filter-pill ${ui.folderDetailFilter === c.id ? "active" : ""}"
                  data-filter-chip="${c.id}"
                  data-filter-scope="dark"
                >
                  ${c.cherry ? `<span style="color:var(--theme-swatch);display:inline-flex;">${icons.cherry(15)}</span>` : ""}
                  <span>${c.label}</span>
                </button>`
                )
                .join("")}
            </div>
          </div>

          <div class="pc-resume-banner" data-node-id="383:9160">
            <div class="pc-resume-copy">
              <strong>กลับมาดูสิ่งที่บันทึกไว้กันเถอะ</strong>
              <button type="button" class="pc-resume-cta" data-open-preview="1">
                <span>ดูรายการที่ยังไม่ได้ดู</span>
                ${icons.chevronRight(14)}
              </button>
            </div>
            <div class="pc-resume-thumb">
              ${icons.imagePlaceholder(22)}
            </div>
          </div>

          <section class="pc-section" data-node-id="383:9172">
            <div class="pc-section-head">
              <h2>โฟลเดอร์ของฉัน</h2>
              <button type="button" class="pc-section-link" data-web-scope="all">ดูทั้งหมด</button>
            </div>
            <div class="pc-folders-grid" data-node-id="384:3027">
              ${folders
                .filter((f) => f.name !== "ยังไม่จัดหมวด")
                .slice(0, 4)
                .map((f) => {
                  const selected = webScope === "folder" && f.id === activeFolder?.id;
                  return `
                    <button type="button" class="pc-folder-card ${selected ? "active" : ""}" data-web-folder="${escHtml(f.id)}">
                      <div class="pc-folder-cover">
                        ${renderDesktopFolderThumb(f)}
                      </div>
                      <div class="pc-folder-info">
                        <strong>${escHtml(f.name)}</strong>
                        <span>${getFolderCount(f)} รายการ</span>
                      </div>
                    </button>`;
                })
                .join("")}
            </div>
          </section>

          <section class="pc-section" data-node-id="383:9202">
            <div class="pc-section-head">
              <h2>${webScope === "folder" ? `รายการใน ${escHtml(activeFolder?.name || "")}` : "บันทึกล่าสุด"}</h2>
              <span class="figma-section-hint">${visibleLinks.length} รายการ</span>
            </div>

            ${
              visibleLinks.length === 0
                ? `<div class="figma-empty-state">
                     <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
                     <p>ไม่พบลิงก์ในมุมมองนี้</p>
                     <button type="button" class="figma-primary-btn compact" data-open-save-sheet="${escHtml(activeFolder?.id || "")}">
                       + เพิ่มลิงก์แรกเลย
                     </button>
                   </div>`
                : `
              <div class="pc-link-list">
                ${visibleLinks
                  .map((item) =>
                    renderLinkCard(item, {
                      variant: "pc-row",
                      selected: selectedItem?.id === item.id,
                    })
                  )
                  .join("")}
              </div>`
            }
          </section>`
        }
      </main>

      <!-- Column 3: Right Detail Inspector (412px) -->
      <aside class="pc-inspector">
        ${
          selectedItem
            ? `
          <div class="pc-inspector-head">
            <div>
              <h2>รายละเอียด</h2>
              <span>${escHtml(selectedFolder?.name || "บันทึกล่าสุด")}</span>
            </div>
            <div class="pc-inspector-head-actions">
              <button type="button" class="cherry-btn ${selectedItem.favorite ? "active" : ""}" data-toggle-fav="${escHtml(selectedItem.id)}" title="ชื่นชอบ">
                ${icons.cherry(18)}
              </button>
              <button type="button" class="link-more-btn" data-open-post-menu="${escHtml(selectedItem.id)}" title="เพิ่มเติม">
                ${icons.kebab(17)}
              </button>
            </div>
          </div>

          <div class="pc-inspector-body">
            ${renderRichPreviewBox(selectedItem, ui, { desktop: true })}

            <div class="figma-detail-post-info" style="width:100%;">
              <a
                class="figma-detail-post-title-link"
                style="font-size:18px;width:100%;"
                href="${escHtml(safeHrefUrl(selectedItem.url))}"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>${escHtml(selectedItem.title)}</span>
                <span class="figma-detail-ext-icon">${icons.externalLink(17)}</span>
              </a>
              <p class="figma-detail-post-meta" style="width:100%;">
                ${escHtml(selectedItem.platform || "Web")} · ${escHtml(selectedItem.savedAgo || "เมื่อสักครู่")} · ${escHtml(selectedFolder?.name || "ทั่วไป")}
              </p>
            </div>

            <button type="button" class="figma-detail-reminder-pill" data-open-reminder="${escHtml(selectedItem.id)}">
              ${icons.clock(16)}
              <span>${escHtml(selectedItem.reminder || "ยังไม่ได้ตั้งเตือน")}</span>
            </button>

            <div class="figma-detail-status-block" style="width:100%;">
              <div class="figma-detail-status-row" style="width:100%;">
                <span class="figma-detail-sec-label">สถานะการรับชม</span>
                <button
                  type="button"
                  class="figma-detail-status-toggle ${isSelectedSeen ? "seen" : "unseen"}"
                  data-toggle-seen="${escHtml(selectedItem.id)}"
                >
                  ${
                    isSelectedSeen
                      ? `<span class="seen-check">✓</span><span>ดูแล้ว</span><span class="swap-arrows">⇄</span>`
                      : `<span>ยังไม่ดู</span><span class="swap-arrows">⇄</span>`
                  }
                </button>
              </div>

              <div class="figma-detail-tags-row" style="width:100%;">
                ${(selectedItem.tags || [])
                  .map(
                    (tag) => `
                  <button
                    type="button"
                    class="figma-detail-tag-pill"
                    data-action="remove-tag-inline"
                    data-id="${escHtml(selectedItem.id)}"
                    data-tag="${escHtml(tag)}"
                  >
                    ${escHtml(tag.startsWith("#") ? tag : `#${tag}`)} ×
                  </button>`
                  )
                  .join("")}
                <button type="button" class="figma-detail-add-tag-btn" data-action="toggle-tag-popover">
                  + เพิ่มแท็ก
                </button>
              </div>
            </div>

            <div class="figma-detail-note-block" style="width:100%;">
              <div class="figma-detail-note-head" style="width:100%;">
                <span class="figma-detail-sec-label">โน้ตของฉัน</span>
                <button type="button" class="figma-detail-edit-pill" data-action="toggle-note-edit" data-id="${escHtml(selectedItem.id)}">
                  แก้ไข
                </button>
              </div>
              <div
                class="figma-detail-note-box ${selectedItem.note ? "has-note" : ""}"
                style="width:100%;"
                role="button"
                tabindex="0"
                data-action="toggle-note-edit"
                data-id="${escHtml(selectedItem.id)}"
              >
                ${selectedItem.note ? escHtml(selectedItem.note) : `<span class="placeholder">เพิ่มโน้ต…</span>`}
              </div>
            </div>

            <div class="figma-detail-ai-block" style="width:100%;">
              ${
                selectedItem.aiSummary
                  ? `
                <div class="figma-detail-ai-card" style="width:100%;">
                  <div class="figma-detail-ai-card-head">
                    <span class="ai-ico">${icons.bot(18)}</span>
                    <strong>สรุปจากต้นฉบับ</strong>
                    <button type="button" class="figma-detail-ai-rerun" data-action="open-ai-confirm">สรุปใหม่</button>
                  </div>
                  <p class="figma-detail-ai-card-body">${escHtml(selectedItem.aiSummary)}</p>
                </div>`
                  : `
                <button type="button" class="figma-detail-ai-trigger" data-action="open-ai-confirm">
                  <span class="ai-ico">${icons.bot(18)}</span>
                  <span>สรุปด้วย AI</span>
                </button>`
              }
            </div>
          </div>

          <div class="pc-inspector-footer">
            <a
              class="figma-detail-open-btn"
              style="width:100%;"
              href="${escHtml(safeHrefUrl(selectedItem.url))}"
              target="_blank"
              rel="noopener noreferrer"
            >
              เปิดลิงก์ต้นฉบับ
            </a>
          </div>`
            : `<p class="tiny-hint">เลือกลิงก์ทางซ้ายเพื่อดูรายละเอียด</p>`
        }
      </aside>

      ${renderLinkDetailModals(state, selectedItem)}
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
  const folders = (state.data.folders || []).slice(0, 4);

  return `
    <div class="e1-popup">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <strong style="font-size:18px;color:var(--ink-strong);">Sharely Extension</strong>
        <div class="avatar-circle" style="width:32px;height:32px;background:var(--theme-soft);color:var(--theme-accent-text);">
          ${escHtml((state.data.user?.displayName || "P").charAt(0))}
        </div>
      </div>

      <div style="display:flex;gap:6px;">
        <input class="tb-mini-input" style="flex:1;" type="url" value="${escHtml(draft.url)}" data-ext-url="1" />
        <button type="button" class="tb-btn" data-ext-unfurl="1">Unfurl</button>
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
            <button type="button" class="filter-chip ${draft.folderId === f.id ? "active-dark" : ""}" style="height:34px;font-size:12.5px;" data-ext-folder="${escHtml(f.id)}">
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
            <button type="button" class="filter-chip ${draft.tags.includes(tag) ? "active-dark" : ""}" style="height:34px;font-size:12.5px;" data-ext-tag="${escHtml(tag)}">
              ${escHtml(tag)}
            </button>`
            )
            .join("")}
        </div>
      </div>

      <input class="field-input" style="height:44px;" type="text" value="${escHtml(draft.note)}" placeholder="เพิ่มโน้ต (ไม่บังคับ)" data-ext-note="1" />

      <div>
        <button type="button" class="reminder-pill" data-ext-toggle-reminder="1">
          ${icons.clock(16)}
          <span>${escHtml(draft.reminder || "ตั้งเตือน")}</span>
        </button>
      </div>

      <button type="button" class="btn-dark-pill" style="margin-top:auto;" data-ext-submit="1">บันทึก</button>
    </div>
  `;
}
