/**
 * Link Flows & Sheets:
 * - 1 Save link bottom sheet (4:2) with live URL Unfurl (POST /api/preview)
 * - 5 Link detail (4:207) with Seen checkbox, On-Demand AI summary (POST /api/ai/summarize), Tags, Notes, Reminder
 * - 6 Reminder calendar + time picker sheet (4:250)
 * - 7 Saved preview swipe deck (24:119)
 */
import { icons, escHtml } from "../components/icons.js";
import { getFolderById, getLinkById } from "../state/store.js";

export function renderLinkDetailScreen(state) {
  const item = getLinkById(state.ui.activeLinkId) || state.data.links[0];
  if (!item) {
    return `<div class="app-pad"><button class="btn-outline-pill" data-nav="home">กลับหน้าหลัก</button></div>`;
  }
  const folder = getFolderById(item.folderId);
  const isSeen = item.status === "read";
  const isSummarizing = state.api.isSummarizing;

  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button class="icon-btn" data-nav="${state.ui.prevScreen === "folderDetail" ? "folderDetail" : "home"}">
            ${icons.back(22)}
          </button>
          <h1 style="margin:0;font-size:20px;font-weight:700;">รายละเอียด</h1>
        </div>
        <button class="cherry-btn ${item.favorite ? "active" : ""}" data-toggle-fav="${item.id}" title="ชื่นชอบ">
          ${icons.cherry(20)}
        </button>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:14px;padding-top:4px;padding-bottom:28px;">
        <div class="media-hero" data-toggle-video-play="1" style="cursor:pointer;">
          ${folder?.cover ? `<img src="${escHtml(folder.cover)}" alt="" />` : ""}
          <button class="play-circle-btn" aria-label="เล่นตัวอย่างสื่อ">
            ${state.ui.videoPlaying ? icons.check(24) : icons.play(24)}
          </button>
          ${
            state.ui.videoPlaying
              ? `<span style="position:absolute;bottom:10px;left:12px;background:rgba(0,0,0,0.72);color:#fff;padding:4px 10px;border-radius:8px;font-size:12px;">
                   กำลังพรีวิว (${escHtml(item.platform)} embed placeholder)
                 </span>`
              : ""
          }
        </div>

        <div class="title-check-row">
          <button class="seen-checkbox ${isSeen ? "checked" : ""}" data-toggle-seen="${item.id}" title="ทำเครื่องหมายว่าดูแล้ว">
            ${isSeen ? icons.check(14) : ""}
          </button>
          <div style="flex:1;min-width:0;">
            <a
              href="${escHtml(item.url)}"
              target="_blank"
              rel="noopener noreferrer"
              style="font-size:18px;font-weight:700;text-decoration:underline;display:inline-flex;align-items:center;gap:6px;line-height:1.35;"
            >
              <span>${escHtml(item.title)}</span>
              ${icons.externalLink(16)}
            </a>
          </div>
        </div>

        <p style="margin:0;font-size:13px;color:var(--ink-secondary);">
          ${escHtml(item.platform)} · ${escHtml(item.savedAgo)} · โฟลเดอร์ ${escHtml(folder?.name || "ทั่วไป")}
        </p>

        <div class="ai-summary-card">
          <div class="ai-summary-head">
            <strong style="font-size:14.5px;color:var(--ink-strong);">สรุปเนื้อหา</strong>
            <div class="inline-flex-row" style="gap:6px;">
              ${item.aiCached ? `<span class="ai-badge-pill">Cached</span>` : ""}
              <span class="ai-badge-pill">AI</span>
            </div>
          </div>
          ${
            item.aiSummary
              ? `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:var(--ink-primary);">${escHtml(item.aiSummary)}</p>`
              : `<p style="margin:0 0 10px;font-size:13px;color:var(--ink-secondary);">ยังไม่มีคำสรุปสำหรับลิงก์นี้ กดปุ่มด้านล่างเพื่อเรียก POST /api/ai/summarize</p>`
          }
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button class="btn-accent-pill" style="height:34px;padding:0 13px;font-size:12.5px;" data-run-ai-summarize="${item.id}" ${isSummarizing ? "disabled" : ""}>
              ${icons.bot(15)}
              <span>${isSummarizing ? "กำลังสรุป..." : item.aiSummary ? "สรุปใหม่ด้วย AI" : "สรุปเนื้อหาด้วย AI"}</span>
            </button>
            ${item.aiEngine ? `<span class="tiny-hint">${escHtml(item.aiEngine)}</span>` : ""}
          </div>
        </div>

        <div class="chip-row" style="flex-wrap:wrap;">
          ${(item.tags || [])
            .map(
              (tag) => `
            <span class="filter-chip" style="height:32px;padding:0 12px;font-size:12.5px;">
              ${escHtml(tag)}
              <button style="border:none;background:none;padding:0 0 0 4px;color:var(--ink-secondary);" data-remove-tag="${escHtml(tag)}" data-link-id="${item.id}">×</button>
            </span>`
            )
            .join("")}
          <button class="filter-chip" style="height:32px;padding:0 12px;font-size:12.5px;font-weight:600;" data-open-add-tag="${item.id}">
            + tag
          </button>
        </div>

        <textarea
          class="note-textarea"
          placeholder="เพิ่มโน้ต..."
          data-edit-note="${item.id}"
        >${escHtml(item.note || "")}</textarea>

        <div>
          <button class="reminder-pill" data-open-reminder="${item.id}">
            ${icons.clock(17)}
            <span>${escHtml(item.reminder || "ตั้งเตือน")}</span>
          </button>
        </div>

        <a
          class="btn-dark-pill"
          href="${escHtml(item.url)}"
          target="_blank"
          rel="noopener noreferrer"
          style="margin-top:6px;"
        >
          เปิดลิงก์ต้นฉบับ
        </a>
      </div>
    </div>
  `;
}

export function renderSavedPreviewScreen(state) {
  const unread = state.data.links.filter((l) => l.status === "unread");
  const pool = unread.length ? unread : state.data.links;
  const idx = Math.max(0, Math.min(state.ui.previewIndex, pool.length - 1));
  const item = pool[idx];
  const folder = item ? getFolderById(item.folderId) : null;

  return `
    <div class="screen-scroll">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button class="icon-btn" data-nav="home">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:20px;font-weight:700;">ดูรายการที่บันทึกไว้</h1>
        </div>
      </div>

      ${
        !item
          ? `<div class="app-pad"><p>ไม่มีรายการที่ยังไม่ได้ดู</p></div>`
          : `
        <div class="app-pad" style="display:flex;flex-direction:column;gap:12px;padding-top:2px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
            <strong style="color:var(--ink-strong);">${item.status === "unread" ? "ยังไม่ได้ดู" : "ดูแล้ว"}</strong>
            <span style="color:var(--ink-secondary);">${idx + 1} จาก ${pool.length}</span>
          </div>

          <div class="media-hero" style="height:290px;" data-open-link="${item.id}">
            ${folder?.cover ? `<img src="${escHtml(folder.cover)}" alt="" />` : ""}
            <button class="play-circle-btn">${icons.play(26)}</button>
          </div>

          <h2 style="margin:2px 0 0;font-size:20px;color:var(--ink-strong);">${escHtml(item.title)}</h2>
          <p style="margin:0;font-size:13px;color:var(--ink-secondary);">
            ${escHtml(item.platform)} · โฟลเดอร์${escHtml(folder?.name || "ทั่วไป")}
          </p>

          <div class="ai-summary-card">
            <div class="ai-summary-head">
              <strong style="font-size:14px;">สรุปเนื้อหา</strong>
              <span class="ai-badge-pill">AI</span>
            </div>
            <p style="margin:0;font-size:13px;line-height:1.5;color:var(--ink-primary);">
              ${escHtml(item.aiSummary || `สรุปเนื้อหาจาก ${item.platform} — แตะเพื่อเปิดหน้าเต็มหรือสรุปด้วย AI`)}
            </p>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
            <a class="btn-dark-pill" href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer">
              เปิดลิงก์ต้นฉบับ
            </a>
            <button class="btn-outline-pill" style="height:48px;border-radius:24px;border-color:var(--ink-strong);" data-preview-mark-read="${item.id}">
              ทำเครื่องหมายว่าดูแล้ว
            </button>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <button class="tb-btn" data-preview-step="-1" ${idx === 0 ? "disabled" : ""}>↑ รายการก่อนหน้า</button>
            <span class="tiny-hint">ปัดขึ้นเพื่อดูรายการถัดไป</span>
            <button class="tb-btn" data-preview-step="1" ${idx >= pool.length - 1 ? "disabled" : ""}>↓ รายการถัดไป</button>
          </div>
        </div>`
      }
    </div>
  `;
}

export function renderSaveAndReminderSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // 1 Save link bottom sheet (Neobrutalism Share Sheet as in screenshot)
  if (sheet.type === "saveLink") {
    const d = sheet.draft;
    const folders = state.data.folders;
    const quotaRem = state.data.freeQuotaRemaining ?? 4;
    const quotaTot = state.data.freeQuotaTotal ?? 4;
    const isPinned = Boolean(d.pinned);
    const selectedFolderId = d.folderId || folders[0]?.id;
    const isAdvancedOpen = Boolean(d.showAdvanced);

    // Determine preview thumbnail letter/icon based on platform or domain
    let thumbLetter = "V";
    if (d.platform === "TikTok" || (d.url && d.url.includes("tiktok"))) thumbLetter = "V";
    else if (d.platform === "Instagram") thumbLetter = "IG";
    else if (d.platform === "YouTube") thumbLetter = "▶";
    else if (d.platform === "X" || d.platform === "Twitter") thumbLetter = "𝕏";
    else if (d.title) thumbLetter = d.title.trim().charAt(0).toUpperCase();

    return `
      <div class="modal-backdrop share-sheet-backdrop" data-close-sheet="1">
        <div class="bottom-sheet neobrutal-share-sheet">
          <div class="sheet-handle"></div>

          <!-- Header matching screenshot: Mascot Tuckii/Just-Save-It Logo + App Name + Subtitle + Close Button -->
          <div class="nb-sheet-header">
            <div class="nb-sheet-brand">
              <div class="nb-brand-icon">
                ${icons.shareSheetLogo(40)}
              </div>
              <div class="nb-brand-meta">
                <div class="nb-brand-title">Just Save It</div>
                <div class="nb-brand-subtitle">บันทึกลิงก์ลงในคอลเลกชันของคุณ</div>
              </div>
            </div>
            <button class="nb-close-circle" data-close-sheet="1" aria-label="ปิด">
              ${icons.close(18)}
            </button>
          </div>

          <!-- Link Preview Card: Yellow badge with 'V' / icon + Title + Domain -->
          <div class="nb-preview-card">
            <div class="nb-thumb-box">
              <span class="nb-thumb-letter">${escHtml(thumbLetter)}</span>
            </div>
            <div class="nb-preview-info">
              <input
                type="text"
                class="nb-title-input"
                value="${escHtml(d.title || "TikTok - Make Your Day")}"
                placeholder="ชื่อโพสต์หรือเนื้อหา"
                data-bind-save-title="1"
                title="คลิกเพื่อแก้ไขชื่อโพสต์"
              />
              <div class="nb-domain-text">${escHtml(d.domain || "vt.tiktok.com")}</div>
            </div>
          </div>

          <!-- Collection Section: Title + '+ คอลเลกชันใหม่' -->
          <div class="nb-collection-head">
            <h4 class="nb-collection-title">บันทึกลงคอลเลกชัน</h4>
            <button class="nb-btn-new-collection" data-open-create-folder="1">
              + คอลเลกชันใหม่
            </button>
          </div>

          <!-- Collection List: Cards with Black Border, Shadow, Folder Icon, Item Count & Custom Radio Button -->
          <div class="nb-collection-list">
            ${folders
              .map((f) => {
                const isSelected = selectedFolderId === f.id;
                const count = state.data.links.filter((l) => l.folderId === f.id).length;
                return `
                  <div class="nb-folder-card ${isSelected ? "selected" : ""}" data-select-save-folder="${f.id}">
                    <div class="nb-folder-left">
                      <div class="nb-folder-icon-box">
                        ${icons.folderSolid(22)}
                      </div>
                      <div class="nb-folder-meta">
                        <div class="nb-folder-name">${escHtml(f.name)}</div>
                        <div class="nb-folder-count">${count} รายการ</div>
                      </div>
                    </div>
                    <div class="nb-radio-circle ${isSelected ? "checked" : ""}">
                      ${isSelected ? `<span class="nb-radio-inner"></span>` : ""}
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>

          <!-- Collapsible Optional Details (URL, Tags, Note, Reminder) -->
          <div class="nb-collapsible-section">
            <button class="nb-collapse-toggle" data-toggle-save-advanced="1">
              <span>${isAdvancedOpen ? "▼ ซ่อนตัวเลือกเพิ่มเติม (URL, แท็ก, โน้ต)" : "▶ ตัวเลือกเพิ่มเติม (URL, แท็ก, โน้ต)"}</span>
            </button>
            ${
              isAdvancedOpen
                ? `
              <div class="nb-advanced-body">
                <div style="display:flex;gap:6px;">
                  <input
                    class="field-input"
                    style="height:36px;font-size:12px;"
                    type="url"
                    value="${escHtml(d.url)}"
                    placeholder="URL ลิงก์"
                    data-bind-save-url="1"
                  />
                  <button class="btn-outline-pill" style="height:36px;padding:0 10px;font-size:12px;white-space:nowrap;" data-run-unfurl="1">
                    ดึงตัวอย่าง
                  </button>
                </div>

                <div style="margin-top:8px;">
                  <span class="tiny-hint" style="display:block;margin-bottom:4px;">แท็ก</span>
                  <div class="chip-row" style="flex-wrap:wrap;">
                    ${["#คาเฟ่", "#เที่ยว", "#อาหาร", "#สาระ", "#วิดีโอสั้น"]
                      .map((tag) => {
                        const active = (d.tags || []).includes(tag);
                        return `<button class="filter-chip ${active ? "active-dark" : ""}" style="font-size:11.5px;height:28px;" data-toggle-save-tag="${escHtml(tag)}">${escHtml(tag)}</button>`;
                      })
                      .join("")}
                  </div>
                </div>

                <input
                  class="field-input"
                  style="height:36px;margin-top:8px;font-size:12.5px;"
                  type="text"
                  value="${escHtml(d.note || "")}"
                  placeholder="เพิ่มโน้ตสั้นๆ (ไม่บังคับ)..."
                  data-bind-save-note="1"
                />
              </div>`
                : ""
            }
          </div>

          <!-- Quota Notice matching screenshot -->
          <div class="nb-quota-notice">
            วันนี้เหลือลิงก์ฟรี ${quotaRem} จาก ${quotaTot} ลิงก์
          </div>

          <!-- Bottom Action Row matching screenshot: Pin Switch + Yellow Save Button -->
          <div class="nb-bottom-action-row">
            <div class="nb-pin-switch-group">
              <div class="nb-pin-labels">
                <div class="nb-pin-title">ปักหมุดลิงก์นี้</div>
                <div class="nb-pin-subtitle">เพิ่มไว้บนสุดของคอลเลกชัน</div>
              </div>
              <label class="nb-ios-switch" title="เปิด/ปิด การปักหมุด" data-toggle-pin-link="1">
                <input
                  type="checkbox"
                  ${isPinned ? "checked" : ""}
                  data-toggle-pin-link="1"
                />
                <span class="nb-switch-slider"></span>
              </label>
            </div>

            <button class="nb-btn-save-yellow" data-submit-save-link="1">
              ${icons.bookmarkSolid(18)}
              <span>บันทึกลิงก์</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // 6 Reminder bottom sheet (4:250)
  if (sheet.type === "reminder") {
    const daySelected = sheet.day || 12;
    const days = Array.from({ length: 30 }, (_, i) => i + 1);
    const dows = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <h3 style="margin:0;font-size:20px;">ตั้งเตือน</h3>

          <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;">
            <button class="icon-btn" data-cal-month="-1">${icons.back(18)}</button>
            <strong style="font-size:15px;">${escHtml(sheet.monthLabel || "พฤศจิกายน 2569")}</strong>
            <button class="icon-btn" data-cal-month="1">${icons.chevronRight(18)}</button>
          </div>

          <div class="cal-grid">
            ${dows.map((d) => `<div class="cal-dow">${d}</div>`).join("")}
            ${days
              .map(
                (day) => `
              <button class="cal-day ${day < 11 ? "muted" : ""} ${day === daySelected ? "selected" : ""}" data-select-cal-day="${day}">
                ${day}
              </button>`
              )
              .join("")}
          </div>

          <div class="field-input" style="justify-content:space-between;">
            <span style="color:var(--ink-secondary);">เวลา</span>
            <input
              type="time"
              value="${escHtml(sheet.time || "18:00")}"
              style="border:none;outline:none;font-size:15px;font-weight:700;"
              data-bind-cal-time="1"
            />
          </div>

          <span class="tiny-hint">ถ้าไม่ตั้งเวลา จะไม่มีการแจ้งเตือน</span>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button class="btn-outline-pill" style="border-color:var(--ink-strong);" data-clear-reminder="${sheet.linkId}">
              ลบเตือน
            </button>
            <button class="btn-dark-pill" data-save-reminder="${sheet.linkId}">
              ตั้งเตือน
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Add Tag quick sheet
  if (sheet.type === "addTag") {
    return `
      <div class="modal-backdrop center" data-close-sheet="1">
        <div class="center-dialog" onclick="event.stopPropagation()">
          <h3 style="margin:0;font-size:18px;">เพิ่มแท็ก</h3>
          <input class="field-input" type="text" placeholder="เช่น #อร่อย หรือ #ต้องไป" id="newTagInput" value="${escHtml(sheet.value || "")}" data-bind-new-tag="1" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-save-new-tag="${sheet.linkId}">เพิ่มแท็ก</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
