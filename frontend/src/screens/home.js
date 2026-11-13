/**
 * 11 / 12 / 13 / 16 Home Screen
 * Matches Figma 62:202: Sharely header, + เพิ่มลิงก์, bell notifications, search,
 * 4 filter chips, "กลับมาดูสิ่งที่บันทึกไว้กันเถอะ" banner, 2x2 folders, recent links, bottom nav.
 */
import { icons, escHtml } from "../components/icons.js";
import { filterLinks, getFolderCount } from "../state/store.js";
import { renderBottomNav, renderFilterChips, renderLinkCard } from "./common.js";

export function renderHomeScreen(state) {
  const { folders, links, notifications } = state.data;
  const { homeSearch, homeFilter, showNotifications } = state.ui;

  const filteredLinks = filterLinks(links, homeSearch, homeFilter);
  const unreadNotifications = notifications.filter((n) => n.unread).length;
  const unreadCount = links.filter((l) => l.status === "unread").length;

  return `
    <div class="screen-scroll with-nav-pad">
      <div class="home-topbar">
        <h1 class="brand-heading">Sharely</h1>
        <div class="inline-flex-row">
          <button class="btn-accent-pill" data-open-save-sheet="1">
            ${icons.plus(16)}
            <span>เพิ่มลิงก์</span>
          </button>
          <button class="bell-btn" data-toggle-notifs="1" title="การแจ้งเตือน">
            ${icons.bell(20)}
            ${unreadNotifications > 0 ? `<span class="bell-dot"></span>` : ""}
          </button>
        </div>
      </div>

      ${
        showNotifications
          ? `
        <div class="notif-popover">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:14px;">การแจ้งเตือน (${unreadNotifications})</strong>
            <button class="link-more-btn" style="font-size:12px;" data-mark-notifs-read="1">อ่านทั้งหมด</button>
          </div>
          ${notifications
            .map(
              (n) => `
            <div style="padding:8px;border-radius:10px;background:${n.unread ? "var(--theme-soft)" : "var(--bg-muted)"};font-size:12.5px;">
              <div style="font-weight:600;">${escHtml(n.title)}</div>
              <div class="tiny-hint">${escHtml(n.time)}</div>
            </div>`
            )
            .join("")}
        </div>`
          : ""
      }

      <div class="app-pad" style="display:flex;flex-direction:column;gap:14px;padding-top:6px;">
        <div class="search-box">
          <span style="color:var(--ink-strong);display:inline-flex;">${icons.search(18)}</span>
          <input
            type="search"
            placeholder="ค้นหาลิงก์ โน้ต หรือแท็ก"
            value="${escHtml(homeSearch)}"
            data-search-input="home"
          />
        </div>

        ${renderFilterChips(homeFilter, "home")}

        <div class="resume-banner">
          <div style="flex:1;min-width:0;">
            <p class="resume-title">กลับมาดู<br />สิ่งที่บันทึกไว้กันเถอะ</p>
            <button class="resume-cta" data-open-preview="1">
              <span>ดูรายการที่ยังไม่ได้ดู (${unreadCount})</span>
              ${icons.chevronRight(15)}
            </button>
          </div>
          <div class="resume-thumb-box">
            ${icons.imagePlaceholder(30)}
          </div>
        </div>

        <div>
          <div class="section-header-row">
            <h2 class="section-title">โฟลเดอร์ของฉัน</h2>
            <button class="link-more-btn" data-nav="folders">ดูทั้งหมด</button>
          </div>
          <div class="folder-grid">
            ${folders
              .slice(0, 4)
              .map(
                (f) => `
              <button class="folder-card" data-open-folder="${f.id}">
                <div class="folder-cover-wrap">
                  <img src="${escHtml(f.cover)}" alt="${escHtml(f.name)}" />
                </div>
                <p class="folder-name">${escHtml(f.name)}</p>
                <p class="folder-meta">${getFolderCount(f)} รายการ</p>
              </button>`
              )
              .join("")}
          </div>
        </div>

        <div>
          <div class="section-header-row">
            <h2 class="section-title">บันทึกล่าสุด</h2>
            <span class="tiny-hint">${filteredLinks.length} รายการ</span>
          </div>
          ${
            filteredLinks.length === 0
              ? `<div class="ai-summary-card" style="text-align:center;color:var(--ink-secondary);">
                   ไม่พบลิงก์ที่ตรงกับเงื่อนไข
                 </div>`
              : `<div class="link-list">
                   ${filteredLinks.map((item) => renderLinkCard(item)).join("")}
                 </div>`
          }
        </div>
      </div>

      ${renderBottomNav("home")}
    </div>
  `;
}
