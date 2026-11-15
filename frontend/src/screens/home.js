/**
 * 11 / 11B / 12 / 13 / 14 Home Screen + 26 Notifications Screen
 * Matches Figma 319:871, 319:944, 319:915, 319:926, 319:935, and 357:784.
 */
import { icons, escHtml, safeImgUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { filterLinks, getFolderById, getFolderCount } from "../state/store.js";
import { renderBottomNav, renderLinkCard, renderAdvancedFilterToggle, renderAdvancedFilterDrawer } from "./common.js";

export function renderNotificationsFullScreen(state) {
  const notifications = state.data.notifications || [];
  const recent = notifications.filter((n) => n.section !== "earlier");
  const earlier = notifications.filter((n) => n.section === "earlier");

  const renderNotifCard = (n) => {
    const iconBg =
      n.type === "shared_folder"
        ? "#f3ecfb"
        : n.type === "ai_summary"
          ? "#eaf8ef"
          : n.type === "invite"
            ? "#fff4e2"
            : "#fdecef";
    const iconColor =
      n.type === "shared_folder"
        ? "#6f59a8"
        : n.type === "ai_summary"
          ? "#1c7c48"
          : n.type === "invite"
            ? "#b4690e"
            : "#be2235";
    const badgeIcon =
      n.type === "shared_folder"
        ? icons.people(17)
        : n.type === "ai_summary"
          ? icons.bot(17)
          : n.type === "invite"
            ? icons.share(17)
            : icons.clock(17);

    return `
      <button
        class="figma-notif-card ${n.unread ? "unread" : ""}"
        data-action="open-notification-item"
        data-id="${escHtml(n.id)}"
      >
        <div class="figma-notif-icon" style="background:${iconBg};color:${iconColor};">
          ${badgeIcon}
        </div>
        <div class="figma-notif-content">
          <div class="figma-notif-title-row">
            <span class="figma-notif-title">${escHtml(n.title)}</span>
            ${n.unread ? `<span class="figma-unread-dot" aria-label="ยังไม่ได้อ่าน"></span>` : ""}
          </div>
          ${n.body ? `<p class="figma-notif-body">${escHtml(n.body)}</p>` : ""}
          <div class="figma-notif-meta">
            <span>${escHtml(n.time)}</span>
            ${n.badgeLabel ? `<span class="figma-notif-tag">${escHtml(n.badgeLabel)}</span>` : ""}
            ${n.badgeSecondary ? `<span class="figma-notif-tag">${escHtml(n.badgeSecondary)}</span>` : ""}
          </div>
        </div>
      </button>
    `;
  };

  return `
    <div class="screen-scroll figma-notif-screen">
      <div class="figma-notif-header">
        <button class="figma-notif-back" data-action="close-notifications">
          ${icons.back(20)}
          <span>การแจ้งเตือน</span>
        </button>
        <button class="figma-notif-mark-all" data-action="mark-all-notifications-read">
          อ่านทั้งหมด
        </button>
      </div>
      <p class="figma-notif-subtitle">รวมแจ้งเตือนความจำและกิจกรรมที่เกี่ยวกับโฟลเดอร์ของคุณ</p>

      ${
        recent.length
          ? `<div class="figma-notif-section">
              <div class="figma-notif-section-label">ล่าสุด</div>
              ${recent.map(renderNotifCard).join("")}
            </div>`
          : ""
      }

      ${
        earlier.length
          ? `<div class="figma-notif-section">
              <div class="figma-notif-section-label">ก่อนหน้านี้</div>
              ${earlier.map(renderNotifCard).join("")}
            </div>`
          : ""
      }
      ${
        !recent.length && !earlier.length
          ? `<div class="ai-summary-card" style="text-align:center;color:var(--ink-secondary);margin-top:12px;">
               ยังไม่มีการแจ้งเตือนใหม่
             </div>`
          : ""
      }
    </div>
  `;
}

export function renderFigmaLinkItemCard(item) {
  return renderLinkCard(item, { variant: "figma-home" });
}

export function renderHomeScreen(state) {
  if (state.ui.notificationScreenOpen) {
    return renderNotificationsFullScreen(state);
  }

  const { folders, links, notifications } = state.data;
  const {
    homeSearch,
    homeFilter,
    showAllHomeLinks,
    homePlatformFilter = "all",
    homeContentTypeFilter = "all",
  } = state.ui;

  const filteredLinks = filterLinks(links, homeSearch, homeFilter, {
    platform: homePlatformFilter,
    contentType: homeContentTypeFilter,
  });
  const hasAdvancedFilter = homePlatformFilter !== "all" || homeContentTypeFilter !== "all";
  const visibleLinks =
    !showAllHomeLinks && !homeSearch && homeFilter === "all" && !hasAdvancedFilter
      ? filteredLinks.slice(0, 2)
      : filteredLinks;
  const unreadNotifications = notifications.filter((n) => n.unread).length;
  const resumeItem = links.find((l) => l.status !== "read") || links[0] || null;
  const resumeThumb = resumeItem ? resolveMediaThumbUrl(resumeItem) : "";
  const homeFolders = folders.filter((f) => f.name !== "ยังไม่จัดหมวด").slice(0, 4);

  const filterChips = [
    { id: "all", label: "ทั้งหมด" },
    { id: "unread", label: "ยังไม่ได้ดู" },
    { id: "read", label: "ดูแล้ว" },
    { id: "favorite", label: "ชื่นชอบ", hasCherry: true },
  ];

  return `
    <div class="screen-scroll with-nav-pad figma-home-page">
      <div class="figma-home-header">
        <h1 class="figma-home-brand">Sharely</h1>
        <div class="figma-home-header-actions">
          <button type="button" class="figma-add-pill-btn" data-open-save-sheet="1">
            ${icons.plus(14)}
            <span>เพิ่มลิงก์</span>
          </button>
          <button type="button" class="figma-bell-btn" data-action="open-notifications" title="การแจ้งเตือน">
            ${icons.bell(18)}
            ${unreadNotifications > 0 ? `<span class="figma-bell-dot"></span>` : ""}
          </button>
        </div>
      </div>

      <div class="figma-home-content">
        <div class="figma-search-bar">
          <span class="figma-search-icon">${icons.search(17)}</span>
          <input
            type="search"
            placeholder="ค้นหาลิงก์ โน้ต หรือแท็ก"
            value="${escHtml(homeSearch)}"
            data-search-input="home"
          />
        </div>

        <div class="figma-filter-row" role="tablist">
          ${filterChips
            .map(
              (c) => `
            <button
              type="button"
              class="figma-filter-pill ${homeFilter === c.id ? "active" : ""}"
              data-filter-chip="${c.id}"
              data-filter-scope="home"
            >
              ${c.hasCherry ? `<span class="figma-chip-cherry">${icons.cherry(14)}</span>` : ""}
              <span>${escHtml(c.label)}</span>
            </button>`
            )
            .join("")}
          ${renderAdvancedFilterToggle(state, "home", "figma-filter-pill")}
        </div>
        ${renderAdvancedFilterDrawer(state, "home")}

        ${
          homeFilter === "all" && !homeSearch && !hasAdvancedFilter
            ? `
          <div class="figma-resume-banner">
            <div class="figma-resume-copy">
              <strong>กลับมาดู<br />สิ่งที่บันทึกไว้กันเถอะ</strong>
              <button type="button" class="figma-resume-cta" data-open-preview="1">
                <span>ดูรายการที่ยังไม่ได้ดู</span>
                ${icons.chevronRight(14)}
              </button>
            </div>
            <div class="figma-resume-thumb">
              ${
                resumeThumb
                  ? `<img src="${escHtml(resumeThumb)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" />`
                  : icons.imagePlaceholder(22)
              }
            </div>
          </div>`
            : ""
        }

        <div class="figma-section-block">
          <div class="figma-section-head">
            <h2 class="figma-section-title">โฟลเดอร์ของฉัน</h2>
            <button type="button" class="figma-section-action" data-nav="folders">ดูทั้งหมด</button>
          </div>

          <div class="figma-folder-grid">
            ${
              homeFolders.length === 0
                ? `<button type="button" class="figma-folder-card" data-open-create-folder="1" style="grid-column:1/-1;align-items:center;justify-content:center;padding:18px;gap:8px;">
                     <span style="color:var(--theme-accent-text);">${icons.plus(22)}</span>
                     <div class="figma-folder-card-name">สร้างโฟลเดอร์แรกของคุณ</div>
                   </button>`
                : homeFolders
                    .map((f) => {
                      const coverThumb =
                        safeImgUrl(f.cover) ||
                        links
                          .filter((l) => l.folderId === f.id)
                          .map((l) => resolveMediaThumbUrl(l))
                          .find(Boolean) ||
                        "./assets/covers/coffee.png";
                      return `
              <button type="button" class="figma-folder-card" data-open-folder="${escHtml(f.id)}">
                <div class="figma-folder-cover-wrap">
                  <img
                    src="${escHtml(coverThumb)}"
                    alt=""
                    class="figma-folder-cover-img"
                  />
                </div>
                <div class="figma-folder-card-name">${escHtml(f.name)}</div>
                <div class="figma-folder-card-count">${getFolderCount(f)} รายการ</div>
              </button>`;
                    })
                    .join("")
            }
          </div>
        </div>

        <div class="figma-section-block">
          <div class="figma-section-head">
            <h2 class="figma-section-title">บันทึกล่าสุด</h2>
            ${
              filteredLinks.length > 2
                ? `<button type="button" class="figma-section-action" data-action="toggle-home-all-links">${
                    showAllHomeLinks ? "ย่อรายการ" : "ดูทั้งหมด"
                  }</button>`
                : `<span class="figma-section-hint">${filteredLinks.length} รายการ</span>`
            }
          </div>

          ${
            visibleLinks.length === 0
              ? `
            <div class="figma-empty-state">
              <div class="figma-empty-icon">${icons.bookmarkSolid(22)}</div>
              <h3>ยังไม่มีลิงก์ที่บันทึกไว้</h3>
              <p>กดปุ่ม "+ เพิ่มลิงก์" ด้านบน หรือแชร์ลิงก์จากแอปอื่นมาที่ Sharely เพื่อเริ่มเก็บสิ่งน่าสนใจไว้ดูทีหลัง</p>
              <button type="button" class="figma-primary-btn compact" data-open-save-sheet="1">
                + เพิ่มลิงก์แรกของฉัน
              </button>
            </div>`
              : `<div class="figma-link-list">
                  ${visibleLinks.map(renderFigmaLinkItemCard).join("")}
                </div>`
          }
        </div>
      </div>
    </div>
    ${renderBottomNav("home")}
  `;
}
