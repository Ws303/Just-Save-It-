/**
 * Desktop PC Web UI (Figma 383:8963 — Cherry Split Auth & 2-Column Workspace + Dedicated 2-Card Link Detail)
 * + E1 Browser Extension Quick Save Popup (51:248).
 */
import { icons, escHtml, safeHrefUrl, safeImgUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { filterLinks, getFolderById, getFolderCount, getLinkById } from "../state/store.js";
import { renderWebAuthView } from "./auth.js";
import { renderNotificationsFullScreen } from "./home.js";
import { renderLinkCard, renderAdvancedFilterToggle, renderAdvancedFilterDrawer } from "./common.js";
import { renderAiPanelBody } from "./ai.js";
import { renderProfileBody, renderDisplayBody, renderSecurityBody, renderHelpBody } from "./profile.js";
import { formatPostDetailTitleAndDesc, renderLinkDetailModals, renderRichPreviewBox, renderSavedPreviewScreen } from "./links.js";

function renderDesktopFolderThumb(folder, allLinks = [], isWatchLater = false) {
  const linkThumbs = (allLinks || [])
    .filter((l) => (isWatchLater ? !l.folderId || l.folderId === folder?.id : l.folderId === folder?.id))
    .map((l) => resolveMediaThumbUrl(l))
    .filter(Boolean)
    .slice(0, 4);

  if (linkThumbs.length >= 2 || isWatchLater) {
    const coverFallback = safeImgUrl(folder?.cover) || "";
    const slots = [0, 1, 2, 3];
    return `
      <div class="pc-folder-collage">
        ${slots
          .map((idx) => {
            const src = linkThumbs[idx] || (idx === 0 ? coverFallback : "");
            return src
              ? `<div class="pc-folder-collage-cell"><img src="${escHtml(src)}" alt="" /></div>`
              : `<div class="pc-folder-collage-cell"><span>${icons.imagePlaceholder(14)}</span></div>`;
          })
          .join("")}
      </div>
    `;
  }

  const safeSrc = safeImgUrl(folder?.cover) || linkThumbs[0] || "";
  if (safeSrc) {
    return `<img src="${escHtml(safeSrc)}" alt="${escHtml(folder?.name || "")}" />`;
  }
  return `<div class="pc-folder-cover-empty">${escHtml(folder?.emoji || "📁")}</div>`;
}

function renderDesktopFolderCard(folder, allLinks, activeFolderId, options = {}) {
  const isWatchLater = Boolean(options.isWatchLater);
  const selected = !isWatchLater && folder.id === activeFolderId;
  const count = isWatchLater ? Number(options.watchLaterCount || 0) : getFolderCount(folder);
  const shareLabel = isWatchLater
    ? "ยังไม่จัดหมวด"
    : folder.sharedCount > 0
      ? `แชร์ ${folder.sharedCount} คน`
      : "ส่วนตัว";
  const clickAttr = isWatchLater
    ? `data-filter-chip="unread" data-filter-scope="home"`
    : `data-open-folder="${escHtml(folder.id)}"`;

  return `
    <div class="pc-folder-card figma-style ${selected ? "active" : ""}" ${clickAttr} role="button" tabindex="0">
      <div class="pc-folder-info">
        <div class="pc-folder-info-text">
          <strong>${escHtml(folder.name)}</strong>
          <span>${count} รายการ</span>
          <span class="pc-folder-share-tag">${escHtml(shareLabel)}</span>
        </div>
        ${
          isWatchLater
            ? ""
            : `<div class="pc-folder-card-actions">
                 <button type="button" class="icon-btn" style="width:26px;height:26px;" data-open-edit-folder="${escHtml(folder.id)}" title="แก้ไขโฟลเดอร์">
                   ${icons.pencil(13)}
                 </button>
                 <button type="button" class="icon-btn" style="width:26px;height:26px;" data-open-invite-sheet="${escHtml(folder.id)}" title="แชร์โฟลเดอร์">
                   ${icons.share(13)}
                 </button>
               </div>`
        }
      </div>
      <div class="pc-folder-cover square-86">
        ${renderDesktopFolderThumb(folder, allLinks, isWatchLater)}
      </div>
    </div>
  `;
}

function renderDesktopFilterPills(activeFilter, scope, state = null) {
  const chips = [
    { id: "all", label: "ทั้งหมด" },
    { id: "unread", label: "ยังไม่ได้ดู" },
    { id: "read", label: "ดูแล้ว" },
    { id: "favorite", label: "ชื่นชอบ", cherry: true },
  ];
  const drawerScope = scope === "dark" ? "folder" : "home";
  return `
    <div class="figma-filter-row" role="tablist">
      ${chips
        .map(
          (c) => `
        <button
          type="button"
          class="figma-filter-pill ${activeFilter === c.id ? "active" : ""}"
          data-filter-chip="${c.id}"
          data-filter-scope="${scope}"
        >
          ${c.cherry ? `<span style="color:var(--theme-swatch);display:inline-flex;">${icons.cherry(15)}</span>` : ""}
          <span>${c.label}</span>
        </button>`
        )
        .join("")}
      ${state ? renderAdvancedFilterToggle(state, drawerScope, "figma-filter-pill") : ""}
    </div>
    ${state ? renderAdvancedFilterDrawer(state, drawerScope) : ""}
  `;
}

function renderDesktopLinkDetail(state) {
  const links = state.data.links || [];
  const ui = state.ui;
  const item = getLinkById(ui.activeLinkId) || links[0] || null;
  const backSection =
    ui.prevPcSection && ui.prevPcSection !== "linkDetail"
      ? ui.prevPcSection
      : ui.prevScreen === "folderDetail"
        ? "folderDetail"
        : "home";

  if (!item) {
    return `
      <button type="button" class="pc-back-link-btn" data-pc-section="${escHtml(backSection)}">
        ${icons.back(16)}
        <span>กลับ</span>
      </button>
      <div class="figma-empty-state">
        <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
        <p>ยังไม่มีลิงก์ที่เลือก</p>
        <button type="button" class="figma-primary-btn compact" data-open-save-sheet="1">+ เพิ่มลิงก์แรกเลย</button>
      </div>
    `;
  }

  const folder = getFolderById(item.folderId);
  const idx = Math.max(0, links.findIndex((l) => l.id === item.id));
  const isSeen = item.status === "read";
  const folderLabel = folder?.name || "ยังไม่จัดหมวด";

  return `
    <div class="pc-detail-head-bar">
      <button type="button" class="pc-folder-back-title" data-pc-section="${escHtml(backSection)}">
        ${icons.back(22)}
        <span>รายละเอียด</span>
      </button>
      <span class="figma-section-hint">${idx + 1}/${Math.max(1, links.length)} · ${escHtml(folderLabel)}</span>
    </div>

    <div class="pc-detail-stage" data-node-id="383:13673">
      <button
        type="button"
        class="pc-detail-arrow"
        data-link-nav="-1"
        aria-label="โพสต์ก่อนหน้า"
        ${links.length <= 1 ? "disabled" : ""}
      >
        ${icons.back(20)}
      </button>

      <div class="pc-detail-grid">
        <div class="pc-detail-media-card">
          ${renderRichPreviewBox(item, ui, { desktop: true })}

          ${(() => {
            const { displayTitle, displayDesc } = formatPostDetailTitleAndDesc(item);
            return `
          <div class="figma-detail-post-info">
            <a
              class="figma-detail-post-title-link"
              style="font-size:20px;text-decoration:underline;text-underline-offset:4px;"
              href="${escHtml(safeHrefUrl(item.url))}"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>${escHtml(displayTitle)}</span>
              <span class="figma-detail-ext-icon">${icons.externalLink(18)}</span>
            </a>
            <p class="figma-detail-post-meta">
              ${escHtml(item.platform || "Web")} · ${escHtml(folderLabel)} · ${escHtml(item.savedAgo || "เมื่อสักครู่")}
            </p>
            ${
              displayDesc
                ? `<p class="figma-detail-post-desc">${escHtml(displayDesc)}</p>`
                : ""
            }
          </div>`;
          })()}

          <a
            class="figma-detail-open-btn"
            href="${escHtml(safeHrefUrl(item.url))}"
            target="_blank"
            rel="noopener noreferrer"
          >
            เปิดลิงก์ต้นฉบับ
          </a>
        </div>

        <div class="pc-detail-meta-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <button type="button" class="figma-detail-reminder-pill" style="margin:0;flex:1;justify-content:center;" data-open-reminder="${escHtml(item.id)}">
              ${icons.clock(16)}
              <span>${escHtml(item.reminder || "ยังไม่ได้ตั้งเตือน")}</span>
            </button>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${escHtml(item.id)}" title="ชื่นชอบ">
                ${icons.cherry(18)}
              </button>
              <button
                type="button"
                class="link-more-btn"
                data-open-post-menu="${escHtml(item.id)}"
                ${item.folderId ? `data-menu-folder="${escHtml(item.folderId)}"` : ""}
                title="เมนูโพสต์"
              >
                ${icons.kebab(17)}
              </button>
            </div>
          </div>

          <div class="figma-detail-status-block">
            <div class="figma-detail-status-row">
              <span class="figma-detail-sec-label">สถานะการรับชม</span>
              <button
                type="button"
                class="figma-detail-status-toggle ${isSeen ? "seen" : "unseen"}"
                data-toggle-seen="${escHtml(item.id)}"
              >
                ${
                  isSeen
                    ? `<span class="seen-check">✓</span><span>ดูแล้ว</span><span class="swap-arrows">⇄</span>`
                    : `<span>ยังไม่ดู</span><span class="swap-arrows">⇄</span>`
                }
              </button>
            </div>

            <div class="figma-detail-tags-row">
              ${(item.tags || [])
                .map(
                  (tag) => `
                <button
                  type="button"
                  class="figma-detail-tag-pill"
                  data-action="remove-tag-inline"
                  data-id="${escHtml(item.id)}"
                  data-tag="${escHtml(tag)}"
                  title="แตะเพื่อลบแท็ก"
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

          <div class="figma-detail-note-block">
            <div class="figma-detail-note-head">
              <span class="figma-detail-sec-label">โน้ตของฉัน</span>
              <button type="button" class="figma-detail-edit-pill" data-action="toggle-note-edit" data-id="${escHtml(item.id)}">
                แก้ไข
              </button>
            </div>
            <div
              class="figma-detail-note-box ${item.note ? "has-note" : ""}"
              role="button"
              tabindex="0"
              data-action="toggle-note-edit"
              data-id="${escHtml(item.id)}"
            >
              ${item.note ? escHtml(item.note) : `<span class="placeholder">เพิ่มโน้ต…</span>`}
            </div>
          </div>

          <div class="figma-detail-ai-block" style="margin-top:auto;">
            ${
              item.aiSummary
                ? `
              <div class="figma-detail-ai-card">
                <div class="figma-detail-ai-card-head">
                  <span class="ai-ico">${icons.bot(18)}</span>
                  <strong>สรุปจากต้นฉบับ</strong>
                  <button type="button" class="figma-detail-ai-rerun" data-action="open-ai-confirm">สรุปใหม่</button>
                </div>
                <p class="figma-detail-ai-card-body">${escHtml(item.aiSummary)}</p>
              </div>`
                : `
              <button type="button" class="figma-detail-ai-trigger" data-action="open-ai-confirm">
                <span class="ai-ico">${icons.bot(18)}</span>
                <span>สรุปด้วย AI</span>
              </button>`
            }
          </div>
        </div>
      </div>

      <button
        type="button"
        class="pc-detail-arrow"
        data-link-nav="1"
        aria-label="โพสต์ถัดไป"
        ${links.length <= 1 ? "disabled" : ""}
      >
        ${icons.chevronRight(20)}
      </button>
    </div>

    ${renderLinkDetailModals(state, item)}
  `;
}

export function renderPcHomeLinksSectionInner(state) {
  const { links } = state.data;
  const { ui } = state;
  const visibleLinks = filterLinks(links, ui.homeSearch, ui.homeFilter, {
    platform: ui.homePlatformFilter,
    contentType: ui.homeContentTypeFilter,
  });
  return `
    <div class="pc-section-head">
      <h2>บันทึกล่าสุด</h2>
      <span class="figma-section-hint">${visibleLinks.length} รายการ</span>
    </div>
    ${
      visibleLinks.length === 0
        ? `<div class="figma-empty-state">
             <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
             <p>ไม่พบลิงก์ที่ตรงกับเงื่อนไข</p>
             <button type="button" class="figma-primary-btn compact" data-open-save-sheet="1">+ เพิ่มลิงก์</button>
           </div>`
        : `<div class="pc-link-list">
             ${visibleLinks.map((item) => renderLinkCard(item, { variant: "pc-row" })).join("")}
           </div>`
    }
  `;
}

export function renderPcFoldersGridInner(state) {
  const { folders, links } = state.data;
  const { ui } = state;
  const q = (ui.folderSearch || "").trim().toLowerCase();
  const visibleFolders = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;
  const activeFolder = getFolderById(ui.activeFolderId) || folders[0];
  return visibleFolders.length === 0
    ? `<div class="figma-empty-state" style="grid-column:1/-1;">
         <div class="figma-empty-icon">${icons.folder(22)}</div>
         <p>ไม่พบโฟลเดอร์</p>
       </div>`
    : visibleFolders.map((f) => renderDesktopFolderCard(f, links, activeFolder?.id)).join("");
}

export function renderPcFolderDetailLinksInner(state, folderOverride = null) {
  const { links, folders } = state.data;
  const { ui } = state;
  const activeFolder = folderOverride || getFolderById(ui.activeFolderId) || folders[0];
  if (!activeFolder) return "";
  const folderLinks = links.filter((l) => l.folderId === activeFolder.id);
  const filteredFolderLinks = filterLinks(folderLinks, ui.folderDetailSearch, ui.folderDetailFilter, {
    platform: ui.folderPlatformFilter,
    contentType: ui.folderContentTypeFilter,
  });
  return filteredFolderLinks.length === 0
    ? `<div class="figma-empty-state">
         <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
         <p>ยังไม่มีลิงก์ที่ตรงกับตัวกรองในโฟลเดอร์นี้</p>
         <button type="button" class="figma-primary-btn compact" data-open-save-sheet="${escHtml(activeFolder.id)}">+ เพิ่มลิงก์ในโฟลเดอร์</button>
       </div>`
    : `<div class="pc-link-list">
         ${filteredFolderLinks
           .map((item) => renderLinkCard(item, { folderContextId: activeFolder.id, variant: "pc-row", selected: ui.activeLinkId === item.id }))
           .join("")}
       </div>`;
}

export function renderPcFavoriteListInner(state) {
  const { links } = state.data;
  const { ui } = state;
  const favLinks = filterLinks(
    links.filter((l) => Boolean(l.favorite)),
    ui.homeSearch,
    "all"
  );
  return favLinks.length === 0
    ? `<div class="figma-empty-state">
         <div class="figma-empty-icon">${icons.cherry(22)}</div>
         <p>ยังไม่มีลิงก์ที่ชื่นชอบ — กดไอคอนเชอร์รี่บนการ์ดเพื่อบันทึกไว้ที่นี่</p>
       </div>`
    : `<div class="pc-link-grid">
         ${favLinks.map((item) => renderLinkCard(item, { variant: "pc-row", selected: ui.activeLinkId === item.id })).join("")}
       </div>`;
}

export function renderWebView(state) {
  if (["login", "emailLogin", "checkEmail", "inviteLanding"].includes(state.ui.screen)) {
    return renderWebAuthView(state);
  }

  const folders = state.data.folders || [];
  const links = state.data.links || [];
  const ui = state.ui;
  const user = state.data.user || {};
  const displayName = user.displayName || user.email?.split("@")[0] || "ผู้ใช้งาน";
  const userInitial = displayName.trim().charAt(0).toUpperCase() || "U";
  const activeFolderId = ui.activeFolderId || folders[0]?.id || null;
  const activeFolder = getFolderById(activeFolderId) || folders[0] || null;
  const unreadNotifications = (state.data.notifications || []).filter((n) => n.unread).length;
  const nonUncatFolders = folders.filter((f) => f.name !== "ยังไม่จัดหมวด");

  const section =
    ui.screen === "savedPreview"
      ? "savedPreview"
      : ui.notificationScreenOpen || ui.showNotifications || ui.pcSection === "notifications"
        ? "notifications"
        : ui.pcSection || "home";

  const addSheetFolderArg = section === "folderDetail" && activeFolder ? activeFolder.id : "1";

  let mainContent = "";

  const uncatLinks = links.filter((l) => !l.folderId);
  const uncatFolder = folders.find((f) => f.name === "ยังไม่จัดหมวด") || null;

  if (section === "home") {
    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">ลิงก์ที่บันทึกไว้</h1>
        </div>
        <div class="pc-main-actions">
          <button type="button" class="figma-bell-btn pc-bell-circle" data-pc-section="notifications" title="การแจ้งเตือน">
            ${icons.bell(19)}
            ${unreadNotifications > 0 ? `<span class="figma-bell-dot"></span>` : ""}
          </button>
        </div>
      </header>

      <div class="pc-search-filter-block figma-col">
        <div class="pc-search-bar">
          <span class="figma-search-icon">${icons.search(17)}</span>
          <input
            type="search"
            placeholder="ค้นหาลิงก์ โฟลเดอร์ หรือแท็ก..."
            value="${escHtml(ui.homeSearch || "")}"
            data-search-input="home"
          />
        </div>
        ${renderDesktopFilterPills(ui.homeFilter || "all", "home", state)}
      </div>

      <div class="pc-resume-banner lavender-figma" data-node-id="383:9129">
        <div class="pc-resume-copy">
          <strong>กลับมาดู<br />สิ่งที่บันทึกไว้กันเถอะ</strong>
          <button type="button" class="pc-resume-cta cream-pill" data-open-preview="1">
            <span>ดูรายการที่ยังไม่ได้ดู</span>
            ${icons.chevronRight(14)}
          </button>
        </div>
        <div class="pc-resume-mascot">
          <img src="./assets/icons/login-cherry-illustration.svg" alt="" />
        </div>
      </div>

      <section class="pc-section">
        <div class="pc-section-head">
          <h2>โฟลเดอร์ของฉัน</h2>
          <button type="button" class="pc-section-link" data-pc-section="folders">ดูทั้งหมด ${icons.chevronRight(14)}</button>
        </div>
        <div class="pc-folders-grid">
          ${
            uncatLinks.length > 0 || uncatFolder
              ? renderDesktopFolderCard(
                  { id: uncatFolder?.id || "__watch_later__", name: "รวมไว้ดูทีหลัง", cover: uncatFolder?.cover },
                  links,
                  null,
                  { isWatchLater: !uncatFolder, watchLaterCount: uncatFolder ? getFolderCount(uncatFolder) : uncatLinks.length }
                )
              : ""
          }
          ${
            nonUncatFolders.length === 0 && uncatLinks.length === 0 && !uncatFolder
              ? `<button type="button" class="pc-folder-card figma-style" data-open-create-folder="1" style="grid-column:1/-1;align-items:center;justify-content:center;padding:24px;">
                   <span style="color:var(--theme-accent-text);">${icons.plus(22)}</span>
                   <strong style="font-size:14px;">สร้างโฟลเดอร์แรกของคุณ</strong>
                 </button>`
              : nonUncatFolders
                  .slice(0, uncatLinks.length > 0 || uncatFolder ? 3 : 4)
                  .map((f) => renderDesktopFolderCard(f, links, null))
                  .join("")
          }
        </div>
      </section>

      <section class="pc-section" data-search-list-host="pc-home">
        ${renderPcHomeLinksSectionInner(state)}
      </section>
    `;
  } else if (section === "folders") {
    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">โฟลเดอร์</h1>
          <span class="pc-main-sub">จัดกลุ่มลิงก์และแชร์กับเพื่อน</span>
        </div>
        <div class="pc-main-actions">
          <button type="button" class="figma-add-pill-btn" data-open-create-folder="1">
            ${icons.plus(16)}
            <span>สร้างโฟลเดอร์</span>
          </button>
        </div>
      </header>

      <div class="pc-search-bar">
        <span class="figma-search-icon">${icons.search(17)}</span>
        <input
          type="search"
          placeholder="ค้นหาชื่อโฟลเดอร์"
          value="${escHtml(ui.folderSearch || "")}"
          data-search-input="folders"
        />
      </div>

      <div class="pc-folders-grid" data-search-list-host="pc-folders">
        ${renderPcFoldersGridInner(state)}
      </div>
    `;
  } else if (section === "folderDetail") {
    if (!activeFolder) {
      mainContent = `
        <button type="button" class="pc-folder-back-title" data-pc-section="folders">${icons.back(20)}<span>กลับไปหน้าโฟลเดอร์</span></button>
        <div class="figma-empty-state"><p>ยังไม่มีโฟลเดอร์</p></div>
      `;
    } else {
      const count = getFolderCount(activeFolder);
      const cachedMembers = state.ui.folderMembers?.[activeFolder.id]?.members || [];
      const shareCount = Math.max(activeFolder.sharedCount || 0, Math.max(0, cachedMembers.length - 1));
      const initials = cachedMembers.length
        ? cachedMembers.slice(0, 3).map((m) => (m.display_name || m.email || m.user_id || "U").trim().charAt(0).toUpperCase())
        : activeFolder.sharedUsers?.length
          ? activeFolder.sharedUsers.slice(0, 3).map((u) => String(u).trim().charAt(0).toUpperCase())
          : [userInitial];

      mainContent = `
        <header class="pc-main-header" data-node-id="383:9858">
          <button type="button" class="pc-folder-back-title" data-pc-section="folders">
            ${icons.back(22)}
            <span>${escHtml(activeFolder.name)}</span>
          </button>
          <div class="pc-main-actions">
            <button type="button" class="pc-invite-btn" data-open-edit-folder="${escHtml(activeFolder.id)}">
              ${icons.pencil(14)}
              <span>แก้ไข</span>
            </button>
            <button type="button" class="pc-invite-btn" data-open-invite-sheet="${escHtml(activeFolder.id)}">
              <span>เชิญเพื่อน</span>
            </button>
          </div>
        </header>

        <div class="shared-bar" style="padding:0;background:transparent;">
          <div class="avatar-stack">
            ${initials.map((ch) => `<div class="avatar-circle">${escHtml(ch)}</div>`).join("")}
          </div>
          <span style="font-size:13.5px;color:var(--ink-secondary);">
            ${shareCount > 0 ? `แชร์กับ ${shareCount} คน` : "โฟลเดอร์ส่วนตัว · กดเชิญเพื่อนเพื่อแชร์"}
          </span>
        </div>

        <div class="pc-search-filter-block figma-col">
          <div class="pc-search-bar">
            <span class="figma-search-icon">${icons.search(17)}</span>
            <input
              type="search"
              placeholder="ค้นหาลิงก์ในโฟลเดอร์"
              value="${escHtml(ui.folderDetailSearch || "")}"
              data-search-input="folderDetail"
            />
          </div>
          ${renderDesktopFilterPills(ui.folderDetailFilter || "all", "dark", state)}
        </div>

        <div class="pc-section-head">
          <h2>ลิงก์ในโฟลเดอร์ (${count})</h2>
          <button type="button" class="pc-add-inline-btn" data-open-save-sheet="${escHtml(activeFolder.id)}">
            ${icons.plus(14)}
            <span>เพิ่มลิงก์</span>
          </button>
        </div>

        <div data-search-list-host="pc-folder-detail">
          ${renderPcFolderDetailLinksInner(state, activeFolder)}
        </div>
      `;
    }
  } else if (section === "favorite") {
    const favLinks = filterLinks(
      links.filter((l) => Boolean(l.favorite)),
      ui.homeSearch,
      "all"
    );
    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">ชื่นชอบ</h1>
          <span class="pc-main-sub">รายการลิงก์ที่คุณปักหมุดหัวใจไว้ (<span data-search-count="pc-favorite">${favLinks.length}</span>)</span>
        </div>
      </header>

      <div class="pc-search-bar">
        <span class="figma-search-icon">${icons.search(17)}</span>
        <input
          type="search"
          placeholder="ค้นหาในรายการชื่นชอบ"
          value="${escHtml(ui.homeSearch || "")}"
          data-search-input="home"
        />
      </div>

      <div data-search-list-host="pc-favorite">
        ${renderPcFavoriteListInner(state)}
      </div>
    `;
  } else if (section === "linkDetail") {
    mainContent = renderDesktopLinkDetail(state);
  } else if (section === "savedPreview") {
    mainContent = `
      <button type="button" class="pc-back-link-btn" data-pc-section="home">
        ${icons.back(16)}
        <span>กลับหน้าหลัก</span>
      </button>
      <div class="pc-panel-card full">
        ${renderSavedPreviewScreen(state)}
      </div>
    `;
  } else if (section === "notifications") {
    mainContent = `
      <div class="pc-notif-wrap">
        ${renderNotificationsFullScreen(state)}
      </div>
    `;
  } else if (section === "ai") {
    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">การเชื่อมต่อ AI</h1>
          <span class="pc-main-sub">ใช้ Built-in Free Tier หรือเชื่อมต่อ API Key ของคุณเอง (BYOK)</span>
        </div>
      </header>
      <div class="pc-panel-card" style="max-width:680px;display:flex;flex-direction:column;gap:14px;">
        ${renderAiPanelBody(state)}
      </div>
    `;
  } else if (section === "profile") {
    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">โปรไฟล์และการตั้งค่า</h1>
          <span class="pc-main-sub">จัดการบัญชี การแจ้งเตือน และธีมการแสดงผล</span>
        </div>
      </header>
      <div class="pc-panel-card" style="max-width:680px;display:flex;flex-direction:column;gap:16px;">
        ${renderProfileBody(state)}
      </div>
    `;
  } else if (section === "display") {
    mainContent = `
      <button type="button" class="pc-back-link-btn" data-pc-section="profile">${icons.back(16)}<span>กลับไปโปรไฟล์</span></button>
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">การแสดงผล</h1>
          <span class="pc-main-sub">เลือกธีมสี</span>
        </div>
      </header>
      <div class="pc-panel-card" style="max-width:680px;display:flex;flex-direction:column;gap:18px;">
        ${renderDisplayBody(state)}
      </div>
    `;
  } else if (section === "security") {
    mainContent = `
      <button type="button" class="pc-back-link-btn" data-pc-section="profile">${icons.back(16)}<span>กลับไปโปรไฟล์</span></button>
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">บัญชีและความปลอดภัย</h1>
          <span class="pc-main-sub">อัปเดตอีเมลหรือส่งลิงก์ตั้งรหัสผ่านใหม่</span>
        </div>
      </header>
      <div class="pc-panel-card" style="max-width:680px;display:flex;flex-direction:column;gap:16px;">
        ${renderSecurityBody(state)}
      </div>
    `;
  } else if (section === "help") {
    mainContent = `
      <button type="button" class="pc-back-link-btn" data-pc-section="profile">${icons.back(16)}<span>กลับไปโปรไฟล์</span></button>
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">ศูนย์ช่วยเหลือและแจ้งปัญหา</h1>
        </div>
      </header>
      <div class="pc-panel-card" style="max-width:680px;display:flex;flex-direction:column;gap:16px;">
        ${renderHelpBody()}
      </div>
    `;
  }

  const profileGroupActive = ["profile", "display", "security", "help"].includes(section);

  return `
    <div class="pc-shell" data-node-id="383:8963">
      <aside class="pc-sidebar" data-node-id="384:3028">
        <div class="pc-sidebar-brand">
          <span class="pc-brand-title">Sharely</span>
          <span class="pc-brand-cherry">${icons.cherry(22)}</span>
        </div>

        <nav class="pc-nav-group" aria-label="PC Primary Navigation">
          <button type="button" class="pc-nav-item ${section === "home" ? "active" : ""}" data-pc-section="home">
            <span class="pc-nav-ico">${icons.home(18)}</span>
            <span class="pc-nav-label">หน้าหลัก</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "folders" || section === "folderDetail" ? "active" : ""}" data-pc-section="folders">
            <span class="pc-nav-ico">${icons.folder(18)}</span>
            <span class="pc-nav-label">โฟลเดอร์</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "favorite" ? "active" : ""}" data-pc-section="favorite">
            <span class="pc-nav-ico">${icons.cherry(18)}</span>
            <span class="pc-nav-label">ชื่นชอบ</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "ai" ? "active" : ""}" data-pc-section="ai">
            <span class="pc-nav-ico">${icons.bot(18)}</span>
            <span class="pc-nav-label">AI</span>
          </button>

          <button type="button" class="pc-nav-item ${profileGroupActive ? "active" : ""}" data-pc-section="profile">
            <span class="pc-nav-ico">${icons.profile(18)}</span>
            <span class="pc-nav-label">โปรไฟล์</span>
          </button>
        </nav>

        <button type="button" class="pc-add-primary-btn figma-pill" data-open-save-sheet="${escHtml(addSheetFolderArg)}">
          ${icons.plus(16)}
          <span>เพิ่มลิงก์</span>
        </button>
      </aside>

      <main class="pc-main">
        <div class="pc-main-inner">
          ${mainContent}
        </div>
      </main>
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
  const thumb = resolveMediaThumbUrl(draft);
  const userInitial = (state.data.user?.displayName || state.data.user?.email || "U")
    .trim()
    .charAt(0)
    .toUpperCase() || "U";

  return `
    <div class="e1-popup">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <strong style="font-size:18px;color:var(--ink-strong);">Sharely Extension</strong>
        <div class="avatar-circle" style="width:32px;height:32px;background:var(--theme-soft);color:var(--theme-accent-text);">
          ${escHtml(userInitial)}
        </div>
      </div>

      <div style="display:flex;gap:6px;">
        <input class="tb-mini-input" style="flex:1;" type="url" value="${escHtml(draft.url)}" data-ext-url="1" />
        <button type="button" class="tb-btn" data-ext-unfurl="1">Unfurl</button>
      </div>

      <div class="link-card" style="padding:11px;">
        <div class="link-thumb" style="width:64px;height:64px;">
          ${thumb ? `<img src="${escHtml(thumb)}" alt="" style="width:100%;height:100%;object-fit:cover;" />` : "Link"}
        </div>
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
            <button type="button" class="filter-chip ${(draft.tags || []).includes(tag) ? "active-dark" : ""}" style="height:34px;font-size:12.5px;" data-ext-tag="${escHtml(tag)}">
              ${escHtml(tag)}
            </button>`
            )
            .join("")}
        </div>
      </div>

      <input class="field-input" style="height:44px;" type="text" value="${escHtml(draft.note || "")}" placeholder="เพิ่มโน้ต (ไม่บังคับ)" data-ext-note="1" />

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
