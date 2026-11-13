/**
 * Folders & Collaborative Invite Flows:
 * - 14 Folders · รวมโฟลเดอร์ (90:229)
 * - 15 & 17 Folder details (90:295, 105:266)
 * - แก้ไขโฟลเดอร์ (129:360) + เลือกรูปปก (158:370) + สร้างโฟลเดอร์ใหม่
 * - 24 เชิญเพื่อน (156:364) + 24.1 เลือกแอปแชร์ (156:400) + 24.2 ตัวอย่างข้อความเชิญ (156:427)
 */
import { icons, escHtml } from "../components/icons.js";
import { COVER_CHOICES } from "../data/seed.js";
import { filterLinks, getFolderById, getFolderCount } from "../state/store.js";
import { renderBottomNav, renderFilterChips, renderLinkCard } from "./common.js";

export function renderFoldersScreen(state) {
  const { folders } = state.data;
  const q = (state.ui.folderSearch || "").trim().toLowerCase();
  const visible = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;

  return `
    <div class="screen-scroll with-nav-pad">
      <div class="home-topbar">
        <h1 class="brand-heading">โฟลเดอร์</h1>
        <button class="btn-accent-pill" data-open-create-folder="1">
          ${icons.plus(16)}
          <span>สร้างโฟลเดอร์</span>
        </button>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:14px;padding-top:6px;">
        <div class="search-box">
          <span style="color:var(--ink-strong);display:inline-flex;">${icons.search(18)}</span>
          <input
            type="search"
            placeholder="ค้นหาชื่อโฟลเดอร์"
            value="${escHtml(state.ui.folderSearch)}"
            data-search-input="folders"
          />
        </div>

        <h2 class="section-title">โฟลเดอร์ทั้งหมด</h2>

        <div class="folder-grid">
          ${visible
            .map((f) => {
              const shareText = f.sharedCount > 0 ? `แชร์กับ ${f.sharedCount} คน` : "ส่วนตัว";
              return `
              <div class="folder-card" data-open-folder="${f.id}">
                <div class="folder-cover-wrap">
                  <img src="${escHtml(f.cover)}" alt="${escHtml(f.name)}" />
                  <button
                    class="folder-edit-circle"
                    data-open-edit-folder="${f.id}"
                    title="แก้ไขโฟลเดอร์"
                  >
                    ${icons.pencil(14)}
                  </button>
                </div>
                <p class="folder-name">${escHtml(f.name)}</p>
                <p class="folder-meta">${getFolderCount(f)} ลิงก์ · ${shareText}</p>
              </div>`;
            })
            .join("")}
        </div>
      </div>

      ${renderBottomNav("folders")}
    </div>
  `;
}

export function renderFolderDetailScreen(state) {
  const folder = getFolderById(state.ui.activeFolderId) || state.data.folders[0];
  const folderLinks = state.data.links.filter((l) => l.folderId === folder.id);
  const filtered = filterLinks(folderLinks, state.ui.folderDetailSearch, state.ui.folderDetailFilter);
  const count = getFolderCount(folder);

  return `
    <div class="screen-scroll with-nav-pad">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button class="icon-btn" data-nav="folders">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:22px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(folder.name)}
          </h1>
        </div>
        <button class="btn-outline-pill" style="height:36px;padding:0 14px;font-size:13px;" data-open-invite-sheet="${folder.id}">
          เชิญเพื่อน
        </button>
      </div>

      <div class="shared-bar">
        <div class="avatar-stack">
          <div class="avatar-circle">${escHtml((folder.sharedUsers?.[0] || "ม").charAt(0))}</div>
          <div class="avatar-circle">${escHtml((folder.sharedUsers?.[1] || "ต").charAt(0))}</div>
        </div>
        <span style="font-size:13px;color:var(--ink-secondary);">
          ${folder.sharedCount > 0 ? `แชร์กับ ${folder.sharedCount} คน` : "โฟลเดอร์ส่วนตัว · กดเชิญเพื่อนเพื่อแชร์"}
        </span>
      </div>

      <div class="app-pad" style="display:flex;flex-direction:column;gap:13px;padding-top:4px;">
        <div class="search-box">
          <span style="color:var(--ink-strong);display:inline-flex;">${icons.search(18)}</span>
          <input
            type="search"
            placeholder="ค้นหาลิงก์ในโฟลเดอร์"
            value="${escHtml(state.ui.folderDetailSearch)}"
            data-search-input="folderDetail"
          />
        </div>

        ${renderFilterChips(state.ui.folderDetailFilter, "dark")}

        <div class="section-header-row" style="margin-bottom:0;margin-top:4px;">
          <h2 class="section-title">ลิงก์ในโฟลเดอร์ (${count})</h2>
          <button class="btn-accent-pill" style="height:36px;padding:0 14px;font-size:13px;" data-open-save-sheet="${folder.id}">
            ${icons.plus(14)}
            <span>เพิ่มลิงก์</span>
          </button>
        </div>

        ${
          filtered.length === 0
            ? `<div class="ai-summary-card" style="text-align:center;color:var(--ink-secondary);">
                 ยังไม่มีลิงก์ที่ตรงกับตัวกรองในโฟลเดอร์นี้
               </div>`
            : `<div class="link-list">
                 ${filtered.map((item) => renderLinkCard(item, { folderContextId: folder.id })).join("")}
               </div>`
        }
      </div>

      ${renderBottomNav("folders")}
    </div>
  `;
}

export function renderFolderSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // Create or Edit folder sheet (129:360)
  if (sheet.type === "createFolder" || sheet.type === "editFolder") {
    const isEdit = sheet.type === "editFolder";
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <h3 style="margin:0;font-size:20px;color:var(--ink-primary);">
            ${isEdit ? "แก้ไขโฟลเดอร์" : "สร้างโฟลเดอร์ใหม่"}
          </h3>

          <div class="field-group">
            <label class="field-label">ชื่อโฟลเดอร์</label>
            <div class="field-input" style="padding-right:6px;gap:6px;">
              <input
                type="text"
                value="${escHtml(sheet.nameDraft)}"
                placeholder="เช่น คาเฟ่ที่อยากไป"
                style="border:none;outline:none;width:100%;font-size:14px;"
                data-bind-folder-name="1"
              />
              <button class="btn-soft-pill" style="height:30px;padding:0 10px;font-size:11px;white-space:nowrap;" data-suggest-folder-name="1">
                ลองชื่อใหม่
              </button>
            </div>
          </div>

          <div class="field-group">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="field-label">รูปปกโฟลเดอร์</span>
              <button class="btn-outline-pill" style="height:34px;padding:0 13px;font-size:13px;" data-open-pick-cover="1">
                เปลี่ยนรูปปก
              </button>
            </div>
            <div style="height:152px;border-radius:12px;overflow:hidden;background:var(--bg-thumb);">
              <img src="${escHtml(sheet.coverDraft)}" alt="Cover preview" style="width:100%;height:100%;object-fit:cover;" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button class="btn-accent-pill lg" data-save-folder-sheet="1">บันทึก</button>
          </div>
        </div>
      </div>
    `;
  }

  // Pick Cover sheet (158:370)
  if (sheet.type === "pickCover") {
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <h3 style="margin:0;font-size:20px;">เปลี่ยนรูปปก</h3>
          <p class="tiny-hint" style="margin:0;">${escHtml(sheet.returnSheet.nameDraft || "โฟลเดอร์")}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            ${COVER_CHOICES.map((c) => {
              const selected = sheet.returnSheet.coverDraft === c.src;
              return `
                <button
                  class="folder-card"
                  style="padding:6px;border-color:${selected ? "var(--theme-accent)" : "var(--border-input)"};"
                  data-select-cover="${c.src}"
                >
                  <div class="folder-cover-wrap" style="height:76px;">
                    <img src="${c.src}" alt="${escHtml(c.label)}" />
                  </div>
                  <span style="font-size:12.5px;font-weight:600;">${escHtml(c.label)}</span>
                </button>`;
            }).join("")}
          </div>
          <button class="btn-soft-pill" style="width:100%;" data-back-to-folder-edit="1">กลับไปแก้ไข</button>
        </div>
      </div>
    `;
  }

  // 24 Folder · เชิญเพื่อน (156:364)
  if (sheet.type === "invite") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    const inviteUrl = `https://sharely.example/i/${folder.inviteSlug || "coffee"}`;
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;font-size:21px;">เชิญเพื่อน</h3>
            <button class="icon-btn" style="background:var(--bg-muted);" data-close-sheet="1">${icons.close(16)}</button>
          </div>

          <div style="background:var(--bg-muted);border-radius:12px;padding:9px;display:flex;align-items:center;gap:10px;">
            <img src="${escHtml(folder.cover)}" alt="" style="width:63px;height:48px;border-radius:8px;object-fit:cover;" />
            <div>
              <strong style="font-size:14px;">${escHtml(folder.name)}</strong>
              <p class="tiny-hint" style="margin:2px 0 0;">ผู้รับคำเชิญดูและเพิ่มลิงก์ในโฟลเดอร์ได้</p>
            </div>
          </div>

          <div class="field-group">
            <span class="field-label">ลิงก์คำเชิญ</span>
            <div class="field-input" style="height:43px;font-size:13px;color:var(--ink-secondary);">
              <span>${escHtml(inviteUrl)}</span>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button class="btn-accent-pill lg" data-copy-invite="${escHtml(inviteUrl)}">
              ${icons.copy(17)}
              <span>คัดลอกลิงก์</span>
            </button>
            <button class="btn-outline-pill" style="height:46px;border-color:var(--border-divider);" data-open-invite-apps="${folder.id}">
              ${icons.share(17)}
              <span>แชร์ไปแอปอื่น</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // 24.1 Folder · เลือกแอปแชร์ (156:400)
  if (sheet.type === "inviteShareApp") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;font-size:21px;">แชร์คำเชิญ</h3>
            <button class="icon-btn" style="background:var(--bg-muted);" data-close-sheet="1">${icons.close(16)}</button>
          </div>
          <p class="tiny-hint" style="margin:0;">เลือกแอปเพื่อจำลองข้อความเชิญเข้าโฟลเดอร์ ${escHtml(folder.name)}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
            ${["LINE", "Messages", "อีเมล"]
              .map(
                (app) => `
              <button class="btn-outline-pill" style="border-radius:12px;height:48px;font-size:13px;" data-open-invite-preview="${folder.id}" data-share-app="${app}">
                ${app}
              </button>`
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  // 24.2 Folder · ตัวอย่างข้อความเชิญ (156:427)
  if (sheet.type === "invitePreview") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    const inviteUrl = `https://sharely.example/i/${folder.inviteSlug || "coffee"}`;
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;font-size:21px;">ตัวอย่างข้อความเชิญ</h3>
            <button class="icon-btn" style="background:var(--bg-muted);" data-close-sheet="1">${icons.close(16)}</button>
          </div>
          <span style="font-size:13px;font-weight:700;color:var(--ink-secondary);">ผ่าน ${escHtml(sheet.appName || "LINE")}</span>
          <div style="background:var(--bg-muted);border-radius:12px;padding:12px;font-size:13px;">
            <div>ชวนมาดูและช่วยกันเก็บลิงก์ในโฟลเดอร์ "${escHtml(folder.name)}" บน Sharely</div>
            <div style="color:var(--theme-accent-text);margin-top:4px;font-weight:600;">${escHtml(inviteUrl)}</div>
          </div>
          <button class="btn-accent-pill lg" data-preview-recipient-invite="${folder.id}">
            ${icons.share(17)}
            <span>ดูหน้าที่ผู้รับจะเห็น</span>
          </button>
          <span class="tiny-hint" style="text-align:center;">Prototype: เปิดหน้า 23 คำเชิญเข้าโฟลเดอร์</span>
        </div>
      </div>
    `;
  }

  return "";
}
