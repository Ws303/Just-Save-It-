/**
 * Link Flows & Sheets (Figma 1:1 Fidelity):
 * - Add Link Bottom Sheets: 319:4332, 319:4791 (Expanded), 319:4779 (Folder Picker), 319:4659 (Create Folder), 319:541 (Share from External App)
 * - Link Detail & AI Flow: 319:6090, 372:821, 319:5253 (AI Confirm), 319:5264 (AI Loading), 319:5271 (AI Success), 319:5279 (AI Error), 319:5120 (Note Modal), 319:5131 (Tag Modal)
 * - Spec 1A Rich Preview inside fixed 358x186px (border-radius: 15px): fallback, single cover, multi-image carousel, allowlisted video iframe
 * - Spec 2B Reminder Bottom Sheet: 319:5142 + compact recurrence row (once / every_n_days)
 */
import { icons, escHtml, safeHrefUrl, safeImgUrl } from "../components/icons.js";
import { getFolderById, getLinkById } from "../state/store.js";

const EMBED_ALLOWLIST_RULES = [
  { hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"], exact: false, check: (p) => p.startsWith("/embed/") },
  { hosts: ["tiktok.com", "www.tiktok.com"], exact: false, check: (p) => p.startsWith("/embed/") },
  { hosts: ["player.vimeo.com"], exact: true, check: (p) => p.startsWith("/video/") },
  { hosts: ["open.spotify.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  { hosts: ["platform.twitter.com"], exact: true, check: (p) => p.startsWith("/embed/") },
  { hosts: ["facebook.com", "www.facebook.com", "web.facebook.com"], exact: false, check: (p) => p.startsWith("/plugins/") },
  { hosts: ["instagram.com", "www.instagram.com"], exact: false, check: (p) => /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/embed\/?$/.test(p) },
  { hosts: ["embed.reddit.com", "redditmedia.com", "www.redditmedia.com"], exact: false, check: (p) => p.startsWith("/r/") || p.startsWith("/mediaembed/") },
];

/**
 * Resolve a safe HTTPS iframe embed URL strictly within per-platform allowlist and embed path rules.
 * Returns null if missing, invalid, non-HTTPS, containing userinfo/traversal, or outside allowlist.
 */
export function resolveAllowlistedEmbedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "/";
    if (path.split("/").includes("..")) return null;
    const matched = EMBED_ALLOWLIST_RULES.some((rule) => {
      const hostOk = rule.exact
        ? rule.hosts.includes(host)
        : rule.hosts.some((h) => host === h || host.endsWith(`.${h}`));
      return hostOk && rule.check(path);
    });
    return matched ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function getPreviewMediaImages(item) {
  const list = Array.isArray(item?.mediaItems)
    ? item.mediaItems
    : Array.isArray(item?.media_items)
      ? item.media_items
      : [];
  return list
    .map((m) => (typeof m === "string" ? m : m?.media_url || m?.url || m?.thumbnail_url || ""))
    .map((u) => safeImgUrl(u))
    .filter(Boolean);
}

/**
 * Spec 1A: Rich Preview rendered strictly inside the 358x186px (15px radius) container.
 * No extra rows are added outside this container.
 */
export function renderRichPreviewBox(item, uiState = {}, options = {}) {
  const boxClass = options.desktop ? "figma-rich-preview-box is-desktop" : "figma-rich-preview-box";
  const safeEmbedUrl = resolveAllowlistedEmbedUrl(item?.embedUrl || item?.embed_url);
  const mediaImages = getPreviewMediaImages(item);
  const singleCover = safeImgUrl(item?.coverUrl || item?.imageUrl || mediaImages[0] || "");

  // Case 1: Interactive video iframe on allowlisted domain
  if (safeEmbedUrl) {
    if (uiState.videoPlaying) {
      return `
        <div class="${boxClass}" data-node-id="319:6103">
          <iframe
            class="figma-preview-iframe"
            src="${escHtml(safeEmbedUrl)}"
            title="${escHtml(item?.title || "ตัวอย่างวิดีโอ")}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-presentation"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
          <button
            type="button"
            class="figma-preview-close-btn"
            data-action="stop-embed-video"
            title="ปิดตัวเล่นวิดีโอ"
            aria-label="ปิดตัวเล่นวิดีโอ"
          >
            ${icons.close(14)}
          </button>
        </div>
      `;
    }
    return `
      <div class="${boxClass} has-media" data-node-id="319:6103">
        ${
          singleCover
            ? `<img class="figma-preview-img" src="${escHtml(singleCover)}" alt="${escHtml(item?.title || "")}" />`
            : `<div class="figma-preview-video-poster"></div>`
        }
        <button
          type="button"
          class="figma-preview-play-btn"
          data-action="play-embed-video"
          aria-label="เล่นวิดีโอตัวอย่าง"
        >
          ${icons.play(22)}
        </button>
        <span class="figma-preview-badge">${escHtml(item?.platform || "Video")} · แตะเพื่อเล่น</span>
      </div>
    `;
  }

  // Case 2: Multi-image carousel (2–5 images inside 358x186px)
  if (mediaImages.length >= 2) {
    const total = mediaImages.length;
    const rawIdx = Number(uiState.carouselIndex || 0);
    const activeIdx = ((rawIdx % total) + total) % total;
    const currentSrc = mediaImages[activeIdx];
    return `
      <div class="${boxClass} has-media" data-node-id="319:6103">
        <img class="figma-preview-img" src="${escHtml(currentSrc)}" alt="${escHtml(item?.title || "")}" />
        <button
          type="button"
          class="figma-carousel-arrow prev"
          data-action="carousel-prev"
          data-id="${escHtml(item.id)}"
          aria-label="รูปก่อนหน้า"
        >‹</button>
        <button
          type="button"
          class="figma-carousel-arrow next"
          data-action="carousel-next"
          data-id="${escHtml(item.id)}"
          aria-label="รูปถัดไป"
        >›</button>
        <span class="figma-preview-badge">${activeIdx + 1}/${total}</span>
        <div class="figma-carousel-dots">
          ${mediaImages
            .map(
              (_, i) => `
            <button
              type="button"
              class="figma-carousel-dot ${i === activeIdx ? "active" : ""}"
              data-action="carousel-dot"
              data-id="${escHtml(item.id)}"
              data-index="${i}"
              aria-label="รูปที่ ${i + 1}"
            ></button>`
            )
            .join("")}
        </div>
      </div>
    `;
  }

  // Case 3: Single cover image
  if (singleCover) {
    return `
      <div class="${boxClass} has-media" data-node-id="319:6103">
        <img class="figma-preview-img" src="${escHtml(singleCover)}" alt="${escHtml(item?.title || "")}" />
      </div>
    `;
  }

  // Case 4: Exact Figma fallback card (#f0ecfa) when no cover/media
  return `
    <div class="${boxClass} is-fallback" data-node-id="319:6103">
      <p class="figma-preview-fallback-title">ไม่มีตัวอย่างลิงก์</p>
      <p class="figma-preview-fallback-sub">เปิดลิงก์ต้นฉบับเพื่อดูเนื้อหา</p>
    </div>
  `;
}

/**
 * Shared modals for Link Detail & Desktop PC Right Inspector:
 * - 319:5253 AI Confirm
 * - 319:5264 AI Loading
 * - 319:5271 AI Success
 * - 319:5279 AI Error
 * - 319:5120 Note Multiline Edit Modal
 * - 319:5131 Add Tag Modal
 */
export function renderLinkDetailModals(state, item) {
  if (!item) return "";
  const ui = state.ui;

  if (ui.aiConfirmModalOpen || ui.aiSummaryStatus === "confirm") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5253">
          <h3 class="figma-dialog-title">ยืนยันการสรุปด้วย AI</h3>
          <div class="figma-ai-token-notice">
            ผู้ให้บริการ AI ที่คุณเชื่อมต่อจะประมวลผลเนื้อหาต้นฉบับ โดยใช้ Token ของคุณ และอาจมีค่าใช้จ่าย
          </div>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="close-ai-confirm">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="confirm-ai-summarize" data-id="${escHtml(item.id)}" data-force-refresh="1">ยืนยัน</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "loading") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5264">
          <h3 class="figma-dialog-title">กำลังสรุปเนื้อหา…</h3>
          <p class="figma-dialog-sub">กำลังตรวจว่าเปิดอ่านต้นฉบับได้</p>
          <button type="button" class="figma-btn-outline-44 full" data-action="close-ai-confirm">ยกเลิก</button>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "success") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5271">
          <h3 class="figma-dialog-title">สรุปจากต้นฉบับ</h3>
          <div class="figma-ai-result-box">
            ${escHtml(item.aiSummary || "สรุปเนื้อหาเรียบร้อยแล้ว")}
          </div>
          <button type="button" class="figma-btn-outline-44 full" data-action="close-ai-confirm">ปิด</button>
        </div>
      </div>
    `;
  }

  if (ui.aiSummaryStatus === "error") {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="close-ai-confirm">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5279">
          <h3 class="figma-dialog-title">สรุปไม่สำเร็จ</h3>
          <p class="figma-dialog-sub">เข้าถึงเนื้อหาต้นฉบับไม่ได้ จึงยังไม่มีสรุปให้แสดง</p>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="close-ai-confirm">ปิด</button>
            <button type="button" class="figma-btn-red-44" data-action="confirm-ai-summarize" data-id="${escHtml(item.id)}" data-force-refresh="1">ลองอีกครั้ง</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.noteEditing) {
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="cancel-note-edit">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5120">
          <h3 class="figma-dialog-title">แก้ไขโน้ต</h3>
          <textarea
            class="figma-modal-textarea"
            placeholder="กลับมาเปิดลิงก์นี้ช่วงวันหยุด..."
            data-bind-note-draft="1"
          >${escHtml(ui.noteDraft ?? item.note ?? "")}</textarea>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="cancel-note-edit">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="save-note-inline" data-id="${escHtml(item.id)}">บันทึก</button>
          </div>
        </div>
      </div>
    `;
  }

  if (ui.tagPopoverOpen) {
    const quickTags = ["#อ่านทีหลัง", "#คาเฟ่", "#เที่ยว", "#ไอเดีย", "#อาหาร"];
    return `
      <div class="modal-backdrop center figma-dialog-backdrop" data-action="toggle-tag-popover">
        <div class="figma-dialog-card" onclick="event.stopPropagation()" data-node-id="319:5131">
          <h3 class="figma-dialog-title">เพิ่มแท็ก</h3>
          <input
            type="text"
            class="figma-modal-input"
            placeholder="อ่านทีหลัง"
            value="${escHtml(ui.tagDraft || "")}"
            data-bind-tag-draft="1"
          />
          <div class="figma-quick-tag-row">
            ${quickTags
              .map(
                (tag) => `
              <button type="button" class="figma-tag-suggest-btn" data-action="add-tag-inline" data-id="${escHtml(item.id)}" data-tag="${escHtml(tag)}">
                ${escHtml(tag)}
              </button>`
              )
              .join("")}
          </div>
          <div class="figma-dialog-actions">
            <button type="button" class="figma-btn-outline-44" data-action="toggle-tag-popover">ยกเลิก</button>
            <button type="button" class="figma-btn-red-44" data-action="add-tag-inline" data-id="${escHtml(item.id)}">เพิ่มแท็ก</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

export function renderLinkDetailScreen(state) {
  const links = state.data.links || [];
  const item = getLinkById(state.ui.activeLinkId) || links[0];
  if (!item) {
    return `<div class="app-pad"><button class="btn-outline-pill" data-nav="home">กลับหน้าหลัก</button></div>`;
  }
  const folder = getFolderById(item.folderId);
  const idx = Math.max(0, links.findIndex((l) => l.id === item.id));
  const isSeen = item.status === "read";
  const backTarget = state.ui.prevScreen === "folderDetail" ? "folderDetail" : "home";
  const sourceLabel = folder?.name ? folder.name : "บันทึกล่าสุด";

  return `
    <div class="figma-detail-page" data-node-id="319:6090">
      <div class="figma-detail-topbar" data-node-id="319:6091">
        <button type="button" class="figma-back-btn" data-nav="${backTarget}" aria-label="ย้อนกลับ">
          ${icons.back(22)}
        </button>
        <div class="figma-detail-top-titles">
          <h1 class="figma-detail-top-heading">รายละเอียด</h1>
          <p class="figma-detail-top-sub">${idx + 1}/${Math.max(1, links.length)} · ${escHtml(sourceLabel)}</p>
        </div>
        <button type="button" class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${escHtml(item.id)}" title="ชื่นชอบ">
          ${icons.cherry(20)}
        </button>
      </div>

      <div class="figma-detail-scroll">
        <div class="figma-detail-edge-hint">
          <span class="figma-edge-chevron">⌄</span>
          <span>ลากลงเพื่อดูโพสต์ก่อนหน้า</span>
        </div>

        ${renderRichPreviewBox(item, state.ui)}

        <div class="figma-detail-post-info">
          <a
            class="figma-detail-post-title-link"
            href="${escHtml(safeHrefUrl(item.url))}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>${escHtml(item.title)}</span>
            <span class="figma-detail-ext-icon">${icons.externalLink(18)}</span>
          </a>
          <p class="figma-detail-post-meta">
            ${escHtml(item.platform || "Web")} · ${escHtml(item.savedAgo || "เมื่อสักครู่")} · ${escHtml(folder?.name || "ทั่วไป")}
          </p>
        </div>

        <button type="button" class="figma-detail-reminder-pill" data-open-reminder="${escHtml(item.id)}">
          ${icons.clock(17)}
          <span>${escHtml(item.reminder || "ยังไม่ได้ตั้งเตือน")}</span>
        </button>

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

        <div class="figma-detail-ai-block" data-node-id="372:873">
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

        <div class="figma-detail-edge-hint bottom">
          <span class="figma-edge-chevron">⌃</span>
          <span>ลากขึ้นเพื่อดูโพสต์ถัดไป</span>
        </div>
      </div>

      <div class="figma-detail-sticky-cta">
        <a
          class="figma-detail-open-btn"
          href="${escHtml(safeHrefUrl(item.url))}"
          target="_blank"
          rel="noopener noreferrer"
        >
          เปิดลิงก์ต้นฉบับ
        </a>
      </div>

      ${renderLinkDetailModals(state, item)}
    </div>
  `;
}

export function renderSavedPreviewScreen(state) {
  const unread = state.data.links.filter((l) => l.status === "unread");
  const pool = unread.length ? unread : state.data.links;
  const idx = Math.max(0, Math.min(state.ui.previewIndex || 0, pool.length - 1));
  const item = pool[idx];
  const folder = item ? getFolderById(item.folderId) : null;

  return `
    <div class="figma-detail-page">
      <div class="figma-detail-topbar">
        <button type="button" class="figma-back-btn" data-nav="home">${icons.back(22)}</button>
        <div class="figma-detail-top-titles">
          <h1 class="figma-detail-top-heading">ดูรายการที่บันทึกไว้</h1>
          <p class="figma-detail-top-sub">${idx + 1} จาก ${Math.max(1, pool.length)} · ${item?.status === "unread" ? "ยังไม่ได้ดู" : "ดูแล้ว"}</p>
        </div>
      </div>

      ${
        !item
          ? `<div class="app-pad"><p>ไม่มีรายการที่ยังไม่ได้ดู</p></div>`
          : `
        <div class="figma-detail-scroll">
          ${renderRichPreviewBox(item, state.ui)}
          <div class="figma-detail-post-info">
            <h2 class="figma-detail-post-title-link" style="text-decoration:none;cursor:pointer;" data-open-link="${escHtml(item.id)}">
              ${escHtml(item.title)}
            </h2>
            <p class="figma-detail-post-meta">${escHtml(item.platform)} · โฟลเดอร์${escHtml(folder?.name || "ทั่วไป")}</p>
          </div>

          <div class="figma-detail-ai-card">
            <div class="figma-detail-ai-card-head">
              <span class="ai-ico">${icons.bot(18)}</span>
              <strong>สรุปเนื้อหา</strong>
            </div>
            <p class="figma-detail-ai-card-body">
              ${escHtml(item.aiSummary || `สรุปเนื้อหาจาก ${item.platform} — แตะเพื่อเปิดหน้าเต็มหรือสรุปด้วย AI`)}
            </p>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            <a class="figma-detail-open-btn" href="${escHtml(safeHrefUrl(item.url))}" target="_blank" rel="noopener noreferrer">
              เปิดลิงก์ต้นฉบับ
            </a>
            <button type="button" class="figma-btn-outline-44 full" style="height:48px;border-radius:24px;" data-preview-mark-read="${escHtml(item.id)}">
              ทำเครื่องหมายว่าดูแล้ว
            </button>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;">
            <button type="button" class="tb-btn" data-preview-step="-1" ${idx === 0 ? "disabled" : ""}>↑ รายการก่อนหน้า</button>
            <span class="tiny-hint">ปัดขึ้นเพื่อดูรายการถัดไป</span>
            <button type="button" class="tb-btn" data-preview-step="1" ${idx >= pool.length - 1 ? "disabled" : ""}>↓ รายการถัดไป</button>
          </div>
        </div>`
      }
    </div>
  `;
}

function renderExternalShareSheet(state, sheet) {
  const d = sheet.draft;
  const folders = state.data.folders || [];
  const selectedFolderId = d.folderId || folders[0]?.id;
  const quickTags = ["#คาเฟ่", "#อารีย์", "#ญี่ปุ่น", "#อาหาร"];

  return `
    <div class="modal-backdrop share-sheet-backdrop" data-close-sheet="1">
      <div class="bottom-sheet figma-white-sheet" onclick="event.stopPropagation()" data-node-id="319:541">
        <div class="figma-sheet-handle"></div>
        <div class="figma-ext-sheet-top">
          <h3 class="figma-sheet-h3">บันทึกลิงก์</h3>
          <button
            type="button"
            class="figma-ext-reminder-icon ${d.reminder ? "active" : ""}"
            data-toggle-draft-reminder="1"
            title="${escHtml(d.reminder || "ตั้งเตือน")}"
          >
            ${icons.clock(20)}
          </button>
        </div>

        <div class="figma-ext-link-preview">
          <div class="figma-ext-link-thumb">
            ${safeImgUrl(d.coverUrl) ? `<img src="${escHtml(safeImgUrl(d.coverUrl))}" alt="" />` : `<span>${escHtml((d.platform || "L").charAt(0))}</span>`}
          </div>
          <div class="figma-ext-link-info">
            <input
              type="text"
              class="figma-ext-title-input"
              value="${escHtml(d.title || "คาเฟ่สายมินิมอลอารีย์")}"
              placeholder="ชื่อโพสต์"
              data-bind-save-title="1"
            />
            <span class="figma-ext-domain">${escHtml(d.domain || "tiktok.com/...")}</span>
          </div>
        </div>

        <div class="figma-sheet-field">
          <span class="figma-sheet-label">โฟลเดอร์</span>
          <div class="figma-chip-wrap">
            ${folders
              .map((f) => {
                const selected = selectedFolderId === f.id;
                return `
                  <button
                    type="button"
                    class="figma-pill-choice ${selected ? "selected" : ""}"
                    data-select-save-folder="${escHtml(f.id)}"
                  >${escHtml(f.name)}</button>`;
              })
              .join("")}
            <button type="button" class="figma-pill-choice" data-action="open-create-folder-sheet">+ ใหม่</button>
          </div>
        </div>

        <div class="figma-sheet-field">
          <span class="figma-sheet-label">แท็ก</span>
          <div class="figma-chip-wrap">
            ${quickTags
              .map((tag) => {
                const active = (d.tags || []).includes(tag);
                return `
                  <button
                    type="button"
                    class="figma-pill-choice ${active ? "selected" : ""}"
                    data-toggle-save-tag="${escHtml(tag)}"
                  >${escHtml(tag)}</button>`;
              })
              .join("")}
          </div>
        </div>

        <input
          type="text"
          class="figma-sheet-input"
          value="${escHtml(d.note || "")}"
          placeholder="เพิ่มโน้ต (ไม่บังคับ)"
          data-bind-save-note="1"
        />

        <button type="button" class="figma-sheet-submit-btn" data-submit-save-link="1">
          บันทึก
        </button>
      </div>
    </div>
  `;
}

export function renderSaveAndReminderSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // Add Link Bottom Sheets: 319:541 (external share) OR 319:4332 / 319:4791 (in-app Add Link)
  if (sheet.type === "saveLink") {
    if (state.ui.simulatedSourceApp) {
      return renderExternalShareSheet(state, sheet);
    }

    const d = sheet.draft;
    const folders = state.data.folders || [];
    const selectedFolder = folders.find((f) => f.id === d.folderId) || null;
    const isExpanded = Boolean(state.ui.addLinkExpanded || d.showAdvanced);
    const quickTags = ["#คาเฟ่", "#ไอเดีย", "#เที่ยว", "#อาหาร", "#อ่านทีหลัง"];

    const nestedPicker = state.ui.folderPickerSheetOpen
      ? `
      <div class="modal-backdrop figma-nested-backdrop" data-action="close-folder-picker-sheet">
        <div class="bottom-sheet figma-white-sheet" onclick="event.stopPropagation()" data-node-id="319:4779">
          <div class="figma-sheet-handle" data-action="close-folder-picker-sheet"></div>
          <h3 class="figma-picker-title">เลือกโฟลเดอร์</h3>
          <div class="figma-picker-list">
            ${folders
              .map((f) => {
                const active = d.folderId === f.id;
                return `
                  <button
                    type="button"
                    class="figma-picker-option ${active ? "selected" : ""}"
                    data-select-save-folder="${escHtml(f.id)}"
                  >${escHtml(f.name)}</button>`;
              })
              .join("")}
            <button type="button" class="figma-sheet-inline-link" data-action="open-create-folder-sheet">
              + สร้างโฟลเดอร์ใหม่
            </button>
          </div>
        </div>
      </div>`
      : "";

    const nestedCreateFolder = state.ui.createFolderSheetOpen
      ? `
      <div class="modal-backdrop figma-nested-backdrop" data-action="close-create-folder-sheet">
        <div class="bottom-sheet figma-white-sheet" onclick="event.stopPropagation()" data-node-id="319:4659">
          <div class="figma-sheet-handle" data-action="close-create-folder-sheet"></div>
          <h2 class="figma-add-sheet-title">สร้างโฟลเดอร์</h2>

          <div class="figma-sheet-field">
            <label class="figma-sheet-label">ชื่อโฟลเดอร์</label>
            <input
              type="text"
              class="figma-sheet-input"
              value="${escHtml(state.ui.inlineFolderName || "")}"
              placeholder="ตั้งชื่อโฟลเดอร์ของคุณ"
              data-bind-inline-folder-name="1"
            />
          </div>

          <div class="figma-sheet-field">
            <label class="figma-sheet-label">ไอคอน / ปก (ไม่บังคับ)</label>
            <div class="figma-emoji-row">
              ${["☕", "✈️", "🍜", "💡", "📚", "🎵"]
                .map(
                  (em) => `
                <button
                  type="button"
                  class="figma-emoji-pill ${state.ui.inlineFolderEmoji === em ? "selected" : ""}"
                  data-action="select-inline-emoji"
                  data-emoji="${em}"
                >${em}</button>`
                )
                .join("")}
            </div>
          </div>

          <div class="figma-privacy-info-card">
            <strong>มองเห็นได้เฉพาะคุณ</strong>
            <p>แชร์ให้เพื่อนได้ภายหลังจากหน้าโฟลเดอร์</p>
          </div>

          <button type="button" class="figma-sheet-submit-btn" data-action="create-folder-inline">
            สร้างโฟลเดอร์
          </button>
        </div>
      </div>`
      : "";

    return `
      <div class="modal-backdrop share-sheet-backdrop" data-close-sheet="1">
        <div
          class="bottom-sheet figma-white-sheet ${isExpanded ? "is-expanded" : ""}"
          onclick="event.stopPropagation()"
          data-node-id="${isExpanded ? "319:4791" : "319:4332"}"
        >
          <div
            class="figma-sheet-handle"
            role="button"
            tabindex="0"
            data-action="toggle-add-link-expand"
            title="${isExpanded ? "ย่อแผง" : "ขยายแผง"}"
          ></div>

          <div class="figma-add-sheet-scroll">
            <div class="figma-add-sheet-head">
              <h2 class="figma-add-sheet-title">เพิ่มลิงก์</h2>
              <button type="button" class="figma-add-expand-btn" data-action="toggle-add-link-expand">
                ${isExpanded ? "ย่อแผง" : "ขยายแผง"}
              </button>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">ลิงก์ที่ต้องการบันทึก</label>
              <div class="figma-url-control">
                <input
                  type="url"
                  class="figma-url-input"
                  value="${escHtml(d.url || "")}"
                  placeholder="https://…"
                  data-bind-save-url="1"
                />
                <button type="button" class="figma-red-inline-action" data-action="paste-clipboard-url">
                  วางลิงก์
                </button>
              </div>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">บันทึกในโฟลเดอร์</label>
              <button
                type="button"
                class="figma-select-control"
                data-action="open-folder-picker-sheet"
              >
                <span class="${selectedFolder ? "has-value" : "placeholder"}">
                  ${selectedFolder ? escHtml(selectedFolder.name) : "ยังไม่เลือกโฟลเดอร์"}
                </span>
                <span class="caret">⌄</span>
              </button>
              <button type="button" class="figma-sheet-inline-link" data-action="open-create-folder-sheet">
                + สร้างโฟลเดอร์ใหม่
              </button>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">แท็ก (ไม่บังคับ)</label>
              <div class="figma-tag-selector-box">
                ${quickTags
                  .map((tag) => {
                    const active = (d.tags || []).includes(tag);
                    return `
                      <button
                        type="button"
                        class="figma-pill-choice ${active ? "selected" : ""}"
                        data-toggle-save-tag="${escHtml(tag)}"
                      >${escHtml(tag)}</button>`;
                  })
                  .join("")}
              </div>
            </div>

            <div class="figma-sheet-field">
              <label class="figma-sheet-label">โน้ต (ไม่บังคับ)</label>
              <textarea
                class="figma-note-control"
                placeholder="จดสิ่งที่อยากกลับมาดู…"
                data-bind-save-note="1"
              >${escHtml(d.note || "")}</textarea>
            </div>

            ${
              isExpanded
                ? `
              <div class="figma-sheet-field">
                <label class="figma-sheet-label">ชื่อโพสต์ (ไม่บังคับ · ดึงอัตโนมัติได้)</label>
                <div class="figma-url-control">
                  <input
                    type="text"
                    class="figma-url-input"
                    value="${escHtml(d.title || "")}"
                    placeholder="ชื่อเรื่องหรือคำอธิบายโพสต์"
                    data-bind-save-title="1"
                  />
                  <button type="button" class="figma-red-inline-action" data-run-unfurl="1">
                    ดึงตัวอย่าง
                  </button>
                </div>
              </div>
              <div class="figma-sheet-field">
                <label class="figma-sheet-label">ตั้งเตือนด่วน</label>
                <button
                  type="button"
                  class="figma-pill-choice ${d.reminder ? "selected" : ""}"
                  data-toggle-draft-reminder="1"
                >
                  ${icons.clock(14)} ${escHtml(d.reminder || "เตือนพรุ่งนี้ 18:00")}
                </button>
              </div>`
                : ""
            }
          </div>

          <div class="figma-sheet-sticky-footer">
            <button type="button" class="figma-sheet-submit-btn" data-submit-save-link="1">
              บันทึกลิงก์
            </button>
          </div>
        </div>
      </div>
      ${nestedPicker}
      ${nestedCreateFolder}
    `;
  }

  // Reminder Bottom Sheet (Figma 319:5142 + Spec 2B Recurring Reminder Selector)
  if (sheet.type === "reminder") {
    const daySelected = sheet.day || 14;
    const days = Array.from({ length: 30 }, (_, i) => i + 1);
    const dows = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
    const scheduleType = sheet.scheduleType || state.ui.reminderScheduleType || "once";
    const repeatDays = Number(sheet.repeatEveryDays || state.ui.reminderRepeatDays || 3);

    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-reminder-sheet" onclick="event.stopPropagation()" data-node-id="319:5142">
          <div class="figma-sheet-handle"></div>
          <h3 class="figma-reminder-title">ตั้งเตือน</h3>

          <div class="figma-cal-month-row">
            <button type="button" class="figma-cal-nav-btn" data-cal-month="-1" aria-label="เดือนก่อนหน้า">${icons.back(18)}</button>
            <strong class="figma-cal-month-label">${escHtml(sheet.monthLabel || "พฤศจิกายน 2569")}</strong>
            <button type="button" class="figma-cal-nav-btn" data-cal-month="1" aria-label="เดือนถัดไป">${icons.chevronRight(18)}</button>
          </div>

          <div class="figma-cal-grid">
            ${dows.map((d) => `<div class="figma-cal-dow">${d}</div>`).join("")}
            ${days
              .map(
                (day) => `
              <button
                type="button"
                class="figma-cal-day ${day < 11 ? "muted" : ""} ${day === daySelected ? "selected" : ""}"
                data-select-cal-day="${day}"
              >${day}</button>`
              )
              .join("")}
          </div>

          <div class="figma-time-field">
            <span class="figma-time-label">เวลา</span>
            <input
              type="time"
              class="figma-time-input"
              value="${escHtml(sheet.time || "18:00")}"
              data-bind-cal-time="1"
            />
          </div>

          <!-- Spec 2B: Compact Recurring Schedule Row directly below Time -->
          <div class="figma-recurrence-row">
            <div class="figma-recurrence-tabs">
              <button
                type="button"
                class="figma-recur-pill ${scheduleType === "once" ? "active" : ""}"
                data-action="set-reminder-schedule-type"
                data-schedule-type="once"
              >เตือนครั้งเดียว</button>
              <button
                type="button"
                class="figma-recur-pill ${scheduleType === "every_n_days" ? "active" : ""}"
                data-action="set-reminder-schedule-type"
                data-schedule-type="every_n_days"
              >เตือนซ้ำทุก N วัน</button>
            </div>
            ${
              scheduleType === "every_n_days"
                ? `
              <div class="figma-recur-stepper">
                <button type="button" class="figma-step-btn" data-action="step-reminder-repeat-days" data-delta="-1">−</button>
                <span>${repeatDays} วัน</span>
                <button type="button" class="figma-step-btn" data-action="step-reminder-repeat-days" data-delta="1">+</button>
              </div>`
                : ""
            }
          </div>

          <div class="figma-reminder-actions">
            <button type="button" class="figma-btn-outline-48" data-clear-reminder="${escHtml(sheet.linkId)}">
              ลบเตือน
            </button>
            <button type="button" class="figma-btn-red-48" data-save-reminder="${escHtml(sheet.linkId)}">
              ตั้งเตือน
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
