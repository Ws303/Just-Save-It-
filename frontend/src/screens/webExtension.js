/**
 * Desktop PC Web UI (Figma 383:8963 — Cherry Split Auth & 2-Column Workspace + Dedicated 2-Card Link Detail)
 * + E1 Browser Extension Quick Save Popup (51:248).
 */
import { icons, escHtml, safeHrefUrl, safeImgUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { filterLinks, getFolderById, getFolderCount, getLinkById } from "../state/store.js";
import { renderWebAuthView } from "./auth.js";
import { renderNotificationsFullScreen } from "./home.js";
import { renderLinkCard } from "./common.js";
import { renderAiPanelBody } from "./ai.js";
import { renderProfileBody, renderDisplayBody, renderSecurityBody, renderHelpBody } from "./profile.js";
import { renderLinkDetailModals, renderRichPreviewBox, renderSavedPreviewScreen } from "./links.js";

function renderDesktopFolderThumb(folder, allLinks = []) {
  const linkThumbs = (allLinks || [])
    .filter((l) => l.folderId === folder?.id)
    .map((l) => resolveMediaThumbUrl(l))
    .filter(Boolean)
    .slice(0, 4);

  if (linkThumbs.length >= 2) {
    const coverFallback = safeImgUrl(folder?.cover) || "";
    const slots = linkThumbs.length >= 4 ? [0, 1, 2, 3] : [0, 1];
    return `
      <div class="pc-folder-collage" style="${slots.length === 2 ? "grid-template-rows:1fr;" : ""}">
        ${slots
          .map((idx) => {
            const src = linkThumbs[idx] || coverFallback;
            return src
              ? `<div class="pc-folder-collage-cell"><img src="${escHtml(src)}" alt="" /></div>`
              : `<div class="pc-folder-collage-cell"><span>${icons.imagePlaceholder(18)}</span></div>`;
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

function renderDesktopFolderCard(folder, allLinks, activeFolderId) {
  const selected = folder.id === activeFolderId;
  return `
    <div class="pc-folder-card ${selected ? "active" : ""}" data-open-folder="${escHtml(folder.id)}" role="button" tabindex="0">
      <div class="pc-folder-cover">
        ${renderDesktopFolderThumb(folder, allLinks)}
      </div>
      <div class="pc-folder-info">
        <div class="pc-folder-info-text">
          <strong>${escHtml(folder.name)}</strong>
          <span>${getFolderCount(folder)} รายการ</span>
        </div>
        <div class="pc-folder-card-actions">
          <button type="button" class="icon-btn" style="width:28px;height:28px;" data-open-edit-folder="${escHtml(folder.id)}" title="แก้ไขโฟลเดอร์">
            ${icons.pencil(14)}
          </button>
          <button type="button" class="icon-btn" style="width:28px;height:28px;" data-open-invite-sheet="${escHtml(folder.id)}" title="แชร์โฟลเดอร์">
            ${icons.share(14)}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderDesktopFilterPills(activeFilter, scope) {
  const chips = [
    { id: "all", label: "ทั้งหมด" },
    { id: "unread", label: "ยังไม่ได้ดู" },
    { id: "read", label: "ดูแล้ว" },
    { id: "favorite", label: "ชื่นชอบ", cherry: true },
  ];
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
    </div>
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
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
      <button type="button" class="pc-back-link-btn" data-pc-section="${escHtml(backSection)}">
        ${icons.back(16)}
        <span>กลับไปยัง${backSection === "folderDetail" && folder ? ` ${escHtml(folder.name)}` : backSection === "favorite" ? " รายการที่ชื่นชอบ" : " หน้าหลัก"}</span>
      </button>
      <span class="figma-section-hint">${idx + 1} / ${Math.max(1, links.length)}</span>
    </div>

    <div class="pc-detail-stage" data-node-id="383:8963">
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

          <div class="figma-detail-post-info">
            <a
              class="figma-detail-post-title-link"
              style="font-size:19px;"
              href="${escHtml(safeHrefUrl(item.url))}"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>${escHtml(item.title)}</span>
              <span class="figma-detail-ext-icon">${icons.externalLink(18)}</span>
            </a>
            <p class="figma-detail-post-meta">
              ${escHtml(item.platform || "Web")} · ${escHtml(item.savedAgo || "เมื่อสักครู่")} · ${escHtml(folderLabel)}
            </p>
          </div>

          <button type="button" class="figma-detail-reminder-pill" data-open-reminder="${escHtml(item.id)}">
            ${icons.clock(16)}
            <span>${escHtml(item.reminder || "ยังไม่ได้ตั้งเตือน")}</span>
          </button>
        </div>

        <div class="pc-detail-meta-card">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <strong style="font-size:16px;color:var(--ink-primary);">รายละเอียดและโน้ต</strong>
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

          <div class="figma-detail-ai-block">
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

          <a
            class="figma-detail-open-btn"
            href="${escHtml(safeHrefUrl(item.url))}"
            target="_blank"
            rel="noopener noreferrer"
          >
            เปิดลิงก์ต้นฉบับ
          </a>
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

  if (section === "home") {
    const visibleLinks = filterLinks(links, ui.homeSearch, ui.homeFilter);
    const resumeItem = links.find((l) => l.status !== "read") || links[0] || null;
    const resumeThumb = resumeItem ? resolveMediaThumbUrl(resumeItem) : "";

    mainContent = `
      <header class="pc-main-header">
        <div class="pc-main-title-wrap">
          <h1 class="pc-main-title">หน้าหลัก</h1>
          <span class="pc-main-sub">จัดการและกลับมาดูลิงก์ที่คุณบันทึกไว้</span>
        </div>
        <div class="pc-main-actions">
          <button type="button" class="figma-bell-btn" data-pc-section="notifications" title="การแจ้งเตือน">
            ${icons.bell(19)}
            ${unreadNotifications > 0 ? `<span class="figma-bell-dot"></span>` : ""}
          </button>
        </div>
      </header>

      <div class="pc-search-filter-block">
        <div class="pc-search-bar">
          <span class="figma-search-icon">${icons.search(17)}</span>
          <input
            type="search"
            placeholder="ค้นหาลิงก์ โน้ต หรือแท็ก"
            value="${escHtml(ui.homeSearch || "")}"
            data-search-input="home"
          />
        </div>
        ${renderDesktopFilterPills(ui.homeFilter || "all", "home")}
      </div>

      <div class="pc-resume-banner">
        <div class="pc-resume-copy">
          <strong>กลับมาดูสิ่งที่บันทึกไว้กันเถอะ</strong>
          <button type="button" class="pc-resume-cta" data-open-preview="1">
            <span>ดูรายการที่ยังไม่ได้ดู</span>
            ${icons.chevronRight(14)}
          </button>
        </div>
        <div class="pc-resume-thumb">
          ${resumeThumb ? `<img src="${escHtml(resumeThumb)}" alt="" />` : icons.imagePlaceholder(24)}
        </div>
      </div>

      <section class="pc-section">
        <div class="pc-section-head">
          <h2>โฟลเดอร์ของฉัน</h2>
          <button type="button" class="pc-section-link" data-pc-section="folders">ดูทั้งหมด</button>
        </div>
        <div class="pc-folders-grid">
          ${
            nonUncatFolders.length === 0
              ? `<button type="button" class="pc-folder-card" data-open-create-folder="1" style="grid-column:1/-1;align-items:center;justify-content:center;padding:24px;">
                   <span style="color:var(--theme-accent-text);">${icons.plus(22)}</span>
                   <strong style="font-size:14px;">สร้างโฟลเดอร์แรกของคุณ</strong>
                 </button>`
              : nonUncatFolders
                  .slice(0, 4)
                  .map((f) => renderDesktopFolderCard(f, links, null))
                  .join("")
          }
        </div>
      </section>

      <section class="pc-section">
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
            : `<div class="pc-link-grid">
                 ${visibleLinks.map((item) => renderLinkCard(item, { variant: "pc-row" })).join("")}
               </div>`
        }
      </section>
    `;
  } else if (section === "folders") {
    const q = (ui.folderSearch || "").trim().toLowerCase();
    const visibleFolders = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;

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

      <div class="pc-folders-grid">
        ${
          visibleFolders.length === 0
            ? `<div class="figma-empty-state" style="grid-column:1/-1;">
                 <div class="figma-empty-icon">${icons.folder(22)}</div>
                 <p>ไม่พบโฟลเดอร์</p>
               </div>`
            : visibleFolders.map((f) => renderDesktopFolderCard(f, links, activeFolder?.id)).join("")
        }
      </div>
    `;
  } else if (section === "folderDetail") {
    if (!activeFolder) {
      mainContent = `
        <button type="button" class="pc-back-link-btn" data-pc-section="folders">${icons.back(16)}<span>กลับไปหน้าโฟลเดอร์</span></button>
        <div class="figma-empty-state"><p>ยังไม่มีโฟลเดอร์</p></div>
      `;
    } else {
      const folderLinks = links.filter((l) => l.folderId === activeFolder.id);
      const filteredFolderLinks = filterLinks(folderLinks, ui.folderDetailSearch, ui.folderDetailFilter);
      const count = getFolderCount(activeFolder);
      const cachedMembers = state.ui.folderMembers?.[activeFolder.id]?.members || [];
      const shareCount = Math.max(activeFolder.sharedCount || 0, Math.max(0, cachedMembers.length - 1));

      mainContent = `
        <button type="button" class="pc-back-link-btn" data-pc-section="folders">
          ${icons.back(16)}
          <span>กลับไปโฟลเดอร์ทั้งหมด</span>
        </button>

        <div class="pc-folder-hero-card">
          <div class="pc-folder-hero-meta">
            <div class="pc-folder-hero-thumb">
              ${
                safeImgUrl(activeFolder.cover)
                  ? `<img src="${escHtml(safeImgUrl(activeFolder.cover))}" alt="" />`
                  : `<span style="font-size:28px;">${escHtml(activeFolder.emoji || "📁")}</span>`
              }
            </div>
            <div class="pc-folder-hero-copy">
              <h1>${escHtml(activeFolder.name)}</h1>
              <p>${count} รายการ · ${shareCount > 0 ? `แชร์กับ ${shareCount} คน` : "โฟลเดอร์ส่วนตัว"}</p>
            </div>
          </div>

          <div class="pc-folder-hero-actions">
            <button type="button" class="pc-hero-pill-btn" data-open-edit-folder="${escHtml(activeFolder.id)}">
              ${icons.pencil(14)}
              <span>แก้ไข</span>
            </button>
            <button type="button" class="pc-hero-pill-btn" data-open-invite-sheet="${escHtml(activeFolder.id)}">
              ${icons.people(15)}
              <span>เชิญเพื่อน</span>
            </button>
            <button type="button" class="pc-hero-pill-btn solid" data-open-save-sheet="${escHtml(activeFolder.id)}">
              ${icons.plus(15)}
              <span>เพิ่มลิงก์</span>
            </button>
          </div>
        </div>

        <div class="pc-search-filter-block">
          <div class="pc-search-bar">
            <span class="figma-search-icon">${icons.search(17)}</span>
            <input
              type="search"
              placeholder="ค้นหาลิงก์ในโฟลเดอร์นี้"
              value="${escHtml(ui.folderDetailSearch || "")}"
              data-search-input="folderDetail"
            />
          </div>
          ${renderDesktopFilterPills(ui.folderDetailFilter || "all", "dark")}
        </div>

        ${
          filteredFolderLinks.length === 0
            ? `<div class="figma-empty-state">
                 <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
                 <p>ยังไม่มีลิงก์ที่ตรงกับตัวกรองในโฟลเดอร์นี้</p>
                 <button type="button" class="figma-primary-btn compact" data-open-save-sheet="${escHtml(activeFolder.id)}">+ เพิ่มลิงก์ในโฟลเดอร์</button>
               </div>`
            : `<div class="pc-link-grid">
                 ${filteredFolderLinks
                   .map((item) => renderLinkCard(item, { folderContextId: activeFolder.id, variant: "pc-row", selected: ui.activeLinkId === item.id }))
                   .join("")}
               </div>`
        }
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
          <span class="pc-main-sub">รายการลิงก์ที่คุณปักหมุดหัวใจไว้ (${favLinks.length})</span>
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

      ${
        favLinks.length === 0
          ? `<div class="figma-empty-state">
               <div class="figma-empty-icon">${icons.cherry(22)}</div>
               <p>ยังไม่มีลิงก์ที่ชื่นชอบ — กดไอคอนเชอร์รี่บนการ์ดเพื่อบันทึกไว้ที่นี่</p>
             </div>`
          : `<div class="pc-link-grid">
               ${favLinks.map((item) => renderLinkCard(item, { variant: "pc-row", selected: ui.activeLinkId === item.id })).join("")}
             </div>`
      }
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
          <span class="pc-main-sub">ปรับขนาดตัวอักษรและธีมสี</span>
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
      <aside class="pc-sidebar">
        <div class="pc-sidebar-brand">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="pc-brand-logo-chip">${icons.bookmarkSolid(18)}</span>
            <div>
              <div class="pc-brand-title">Sharely</div>
              <div class="pc-brand-sub">เซฟไว้ก่อน ค่อยกลับมาดู</div>
            </div>
          </div>
        </div>

        <button type="button" class="pc-add-primary-btn" data-open-save-sheet="${escHtml(addSheetFolderArg)}">
          ${icons.plus(17)}
          <span>เพิ่มลิงก์</span>
        </button>

        <nav class="pc-nav-group" aria-label="PC Primary Navigation">
          <button type="button" class="pc-nav-item ${section === "home" ? "active" : ""}" data-pc-section="home">
            <span class="pc-nav-ico">${icons.home(18)}</span>
            <span class="pc-nav-label">หน้าหลัก</span>
            <span class="pc-nav-badge">${links.length}</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "folders" ? "active" : ""}" data-pc-section="folders">
            <span class="pc-nav-ico">${icons.folder(18)}</span>
            <span class="pc-nav-label">โฟลเดอร์</span>
            <span class="pc-nav-badge">${nonUncatFolders.length}</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "favorite" ? "active" : ""}" data-pc-section="favorite">
            <span class="pc-nav-ico">${icons.cherry(18)}</span>
            <span class="pc-nav-label">ชื่นชอบ</span>
            <span class="pc-nav-badge">${links.filter((l) => Boolean(l.favorite)).length}</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "ai" ? "active" : ""}" data-pc-section="ai">
            <span class="pc-nav-ico">${icons.bot(18)}</span>
            <span class="pc-nav-label">AI</span>
          </button>

          <button type="button" class="pc-nav-item ${section === "notifications" ? "active" : ""}" data-pc-section="notifications">
            <span class="pc-nav-ico">${icons.bell(18)}</span>
            <span class="pc-nav-label">การแจ้งเตือน</span>
            ${unreadNotifications > 0 ? `<span class="pc-nav-badge">${unreadNotifications}</span>` : ""}
          </button>

          <button type="button" class="pc-nav-item ${profileGroupActive ? "active" : ""}" data-pc-section="profile">
            <span class="pc-nav-ico">${icons.profile(18)}</span>
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
              const isActive = section === "folderDetail" && f.id === activeFolder?.id;
              return `
                <button
                  type="button"
                  class="pc-nav-item compact ${isActive ? "active" : ""}"
                  data-open-folder="${escHtml(f.id)}"
                >
                  <span class="pc-nav-emoji">${escHtml(f.emoji || "📁")}</span>
                  <span class="pc-nav-label">${escHtml(f.name)}</span>
                  <span class="pc-nav-badge">${getFolderCount(f)}</span>
                </button>`;
            })
            .join("")}
        </div>

        <div class="pc-sidebar-footer">
          <div class="pc-user-pill" data-pc-section="profile" role="button" tabindex="0">
            <span class="pc-user-avatar">${escHtml(userInitial)}</span>
            <div class="pc-user-meta">
              <strong>${escHtml(displayName)}</strong>
              <span>${escHtml(user.email || "")}</span>
            </div>
          </div>
          <button type="button" class="pc-logout-btn" data-open-logout-dialog="1" title="ออกจากระบบ">
            ${icons.signout(16)}
            <span>ออกจากระบบ</span>
          </button>
        </div>
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
