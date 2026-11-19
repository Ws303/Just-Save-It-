/**
 * Folders & Collaborative Invite Flows (Figma 1:1 Fidelity):
 * - Folders Overview & Detail
 * - Share Folder Bottom Sheet (319:3107), Generating State (319:3429), Error State (319:3751)
 * - Choose Share App & Preview Message
 */
import { icons, escHtml, safeImgUrl, resolveMediaThumbUrl } from "../components/icons.js";
import { COVER_CHOICES } from "../data/seed.js";
import { filterLinks, getFolderById, getFolderCount, buildFolderInviteUrl } from "../state/store.js";
import { renderBottomNav, renderFilterChips, renderLinkCard } from "./common.js";

function renderMobileFolderCover(folder, links = [], isWatchLater = false) {
  const linkThumbs = (links || [])
    .filter((l) => (isWatchLater ? !l.folderId || l.folderId === folder?.id : l.folderId === folder?.id))
    .map((l) => resolveMediaThumbUrl(l))
    .filter(Boolean)
    .slice(0, 4);

  if (isWatchLater || (!folder?.cover && linkThumbs.length >= 2)) {
    return `
      <div class="pc-folder-collage">
        ${[0, 1, 2, 3]
          .map((idx) =>
            linkThumbs[idx]
              ? `<div class="pc-folder-collage-cell"><img src="${escHtml(linkThumbs[idx])}" alt="" /></div>`
              : `<div class="pc-folder-collage-cell"><span>${icons.imagePlaceholder(14)}</span></div>`
          )
          .join("")}
      </div>
    `;
  }

  const cover = safeImgUrl(folder?.cover) || linkThumbs[0] || "";
  if (cover) {
    return `<img src="${escHtml(cover)}" alt="${escHtml(folder?.name || "")}" />`;
  }
  return `<div class="pc-folder-cover-empty">${escHtml(folder?.emoji || "📁")}</div>`;
}

export function renderFoldersGridInner(state) {
  const { folders, links } = state.data;
  const q = (state.ui.folderSearch || "").trim().toLowerCase();
  const visible = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;
  const uncatLinks = (links || []).filter((l) => !l.folderId);
  const hasUncatFolder = visible.some((f) => f.name === "ยังไม่จัดหมวด" || f.name === "รวมไว้ดูทีหลัง");

  return `
    ${
      !hasUncatFolder && uncatLinks.length > 0 && !q
        ? `<div class="folder-card" data-filter-chip="unread" data-filter-scope="home" data-nav="home">
             <div class="folder-cover-wrap">
               ${renderMobileFolderCover({ id: "__watch_later__", name: "รวมไว้ดูทีหลัง" }, links, true)}
             </div>
             <p class="folder-name">รวมไว้ดูทีหลัง</p>
             <p class="folder-meta">${uncatLinks.length} ลิงก์ · ยังไม่จัดหมวด</p>
           </div>`
        : ""
    }
    ${visible
      .map((f) => {
        const isWatchLater = f.name === "ยังไม่จัดหมวด" || f.name === "รวมไว้ดูทีหลัง";
        const displayName = f.name === "ยังไม่จัดหมวด" ? "รวมไว้ดูทีหลัง" : f.name;
        const shareText = f.sharedCount > 0 ? `แชร์กับ ${f.sharedCount} คน` : "ส่วนตัว";
        return `
        <div class="folder-card" data-open-folder="${escHtml(f.id)}">
          <div class="folder-cover-wrap">
            ${renderMobileFolderCover(f, links, isWatchLater)}
            <button
              type="button"
              class="folder-edit-circle"
              data-open-edit-folder="${escHtml(f.id)}"
              title="แก้ไขโฟลเดอร์"
            >
              ${icons.pencil(14)}
            </button>
          </div>
          <p class="folder-name">${escHtml(displayName)}</p>
          <p class="folder-meta">${getFolderCount(f)} ลิงก์ · ${shareText}</p>
        </div>`;
      })
      .join("")}
  `;
}

export function renderFolderDetailLinksInner(state, folderOverride = null) {
  const folder = folderOverride || getFolderById(state.ui.activeFolderId) || state.data.folders[0];
  if (!folder) return "";
  const folderLinks = state.data.links.filter((l) => l.folderId === folder.id);
  const filtered = filterLinks(folderLinks, state.ui.folderDetailSearch, state.ui.folderDetailFilter);
  return filtered.length === 0
    ? `<div class="ai-summary-card" style="text-align:center;color:var(--ink-secondary);">
         ยังไม่มีลิงก์ที่ตรงกับตัวกรองในโฟลเดอร์นี้
       </div>`
    : `<div class="link-list">
         ${filtered.map((item) => renderLinkCard(item, { folderContextId: folder.id })).join("")}
       </div>`;
}

export function renderFoldersScreen(state) {
  return `
    <div class="screen-scroll with-nav-pad">
      <div class="home-topbar">
        <h1 class="brand-heading">โฟลเดอร์</h1>
        <button type="button" class="btn-accent-pill" data-open-create-folder="1">
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

        <div class="folder-grid" data-search-list-host="mobile-folders">
          ${renderFoldersGridInner(state)}
        </div>
      </div>

      ${renderBottomNav("folders")}
    </div>
  `;
}

export function renderFolderDetailScreen(state) {
  const folder = getFolderById(state.ui.activeFolderId) || state.data.folders[0];
  if (!folder) {
    return `<div class="app-pad"><button class="btn-outline-pill" data-nav="folders">กลับหน้าโฟลเดอร์</button></div>`;
  }
  const count = getFolderCount(folder);

  return `
    <div class="screen-scroll with-nav-pad">
      <div class="sub-topbar">
        <div class="sub-topbar-left">
          <button type="button" class="icon-btn" data-nav="folders">${icons.back(22)}</button>
          <h1 style="margin:0;font-size:22px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escHtml(folder.name)}
          </h1>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="btn-outline-pill" style="height:36px;padding:0 14px;font-size:13px;" data-open-invite-sheet="${escHtml(folder.id)}">
            เชิญเพื่อน
          </button>
        </div>
      </div>

      ${(() => {
        const cached = state.ui.folderMembers?.[folder.id]?.members || [];
        const userInitial = (state.data.user?.displayName || state.data.user?.email || "U")
          .trim()
          .charAt(0)
          .toUpperCase() || "U";
        const initials = cached.length
          ? cached.slice(0, 3).map((m) => (m.display_name || m.email || m.user_id || "U").trim().charAt(0).toUpperCase())
          : folder.sharedUsers?.length
            ? folder.sharedUsers.slice(0, 3).map((u) => String(u).trim().charAt(0).toUpperCase())
            : [userInitial];
        const shareCount = Math.max(folder.sharedCount || 0, Math.max(0, cached.length - 1));
        return `
      <div class="shared-bar">
        <div class="avatar-stack">
          ${initials.map((ch) => `<div class="avatar-circle">${escHtml(ch)}</div>`).join("")}
        </div>
        <span style="font-size:13px;color:var(--ink-secondary);">
          ${shareCount > 0 ? `แชร์กับ ${shareCount} คน` : "โฟลเดอร์ส่วนตัว · กดเชิญเพื่อนเพื่อแชร์"}
        </span>
      </div>`;
      })()}

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

        ${renderFilterChips(state.ui.folderDetailFilter, "dark", state)}

        <div class="section-header-row" style="margin-bottom:0;margin-top:4px;">
          <h2 class="section-title">ลิงก์ในโฟลเดอร์ (${count})</h2>
          <button type="button" class="btn-accent-pill" style="height:36px;padding:0 14px;font-size:13px;" data-open-save-sheet="${escHtml(folder.id)}">
            ${icons.plus(14)}
            <span>เพิ่มลิงก์</span>
          </button>
        </div>

        <div data-search-list-host="mobile-folder-detail">
          ${renderFolderDetailLinksInner(state, folder)}
        </div>
      </div>

      ${renderBottomNav("folders")}
    </div>
  `;
}

export function renderFolderSheets(state) {
  const sheet = state.ui.activeSheet;
  if (!sheet) return "";

  // Create or Edit folder sheet (319:4659 / 129:360)
  if (sheet.type === "createFolder" || sheet.type === "editFolder") {
    const isEdit = sheet.type === "editFolder";
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-white-sheet" data-node-id="319:4659">
          <div class="figma-sheet-handle"></div>
          <h3 class="figma-add-sheet-title" style="font-size:22px;">
            ${isEdit ? "แก้ไขโฟลเดอร์" : "สร้างโฟลเดอร์"}
          </h3>

          <div class="figma-sheet-field">
            <label class="figma-sheet-label">ชื่อโฟลเดอร์</label>
            <div class="figma-url-control">
              <input
                type="text"
                class="figma-url-input"
                value="${escHtml(sheet.nameDraft)}"
                placeholder="ตั้งชื่อโฟลเดอร์ของคุณ"
                data-bind-folder-name="1"
              />
            </div>
          </div>

          <div class="figma-sheet-field">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
              <label class="figma-sheet-label">รูปปกโฟลเดอร์</label>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  data-folder-cover-input="1"
                  hidden
                />
                <button
                  type="button"
                  class="btn-outline-pill"
                  style="height:32px;padding:0 12px;font-size:12px;"
                  data-action="trigger-folder-cover-upload"
                  ${state.ui.folderCoverUploading ? "disabled" : ""}
                >
                  ${state.ui.folderCoverUploading ? "กำลังอัปโหลด…" : "อัปโหลดรูปปก"}
                </button>
                <button type="button" class="btn-outline-pill" style="height:32px;padding:0 12px;font-size:12px;" data-open-pick-cover="1">
                  เลือกรูปสำเร็จรูป
                </button>
                ${
                  sheet.coverDraft
                    ? `<button type="button" class="btn-outline-pill" style="height:32px;padding:0 10px;font-size:12px;color:var(--theme-accent-text);" data-action="reset-folder-cover">
                         ใช้ภาพปกอัตโนมัติ
                       </button>`
                    : ""
                }
              </div>
            </div>
            <div class="folder-cover-preview-box">
              ${
                safeImgUrl(sheet.coverDraft)
                  ? `<img src="${escHtml(safeImgUrl(sheet.coverDraft))}" alt="Cover preview" style="width:100%;height:100%;object-fit:cover;" />`
                  : `<div class="folder-cover-auto-hint">
                       ${icons.imagePlaceholder(22)}
                       <span>ใช้ภาพปกอัตโนมัติจากลิงก์ในโฟลเดอร์</span>
                     </div>`
              }
            </div>
            ${
              state.ui.folderCoverError
                ? `<p style="margin:0;font-size:12px;color:var(--theme-accent-text);font-weight:600;">${escHtml(state.ui.folderCoverError)}</p>`
                : ""
            }
          </div>

          <div class="figma-privacy-info-card">
            <strong>มองเห็นได้เฉพาะคุณ</strong>
            <p>แชร์ให้เพื่อนได้ภายหลังจากหน้าโฟลเดอร์</p>
          </div>

          <div class="figma-reminder-actions">
            <button type="button" class="figma-btn-outline-48" data-close-sheet="1">ยกเลิก</button>
            <button type="button" class="figma-btn-red-48" data-save-folder-sheet="1">${isEdit ? "บันทึก" : "สร้างโฟลเดอร์"}</button>
          </div>
          ${
            isEdit
              ? `<button type="button" class="figma-btn-outline-48 full" style="color:var(--theme-accent-text);border-color:var(--theme-soft-border);" data-confirm-delete-folder="${escHtml(sheet.folderId)}">
                   ลบโฟลเดอร์นี้
                 </button>`
              : ""
          }
        </div>
      </div>
    `;
  }

  // Pick Cover sheet
  if (sheet.type === "pickCover") {
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-white-sheet">
          <div class="figma-sheet-handle"></div>
          <h3 style="margin:0;font-size:20px;color:#142433;">เลือกรูปปก</h3>
          <p class="tiny-hint" style="margin:0;">${escHtml(sheet.returnSheet.nameDraft || "โฟลเดอร์")}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            ${COVER_CHOICES.map((c) => {
              const selected = sheet.returnSheet.coverDraft === c.src;
              return `
                <button
                  type="button"
                  class="folder-card"
                  style="padding:6px;border-color:${selected ? "var(--theme-accent)" : "#dbe0e3"};"
                  data-select-cover="${escHtml(c.src)}"
                >
                  <div class="folder-cover-wrap" style="height:76px;">
                    <img src="${escHtml(safeImgUrl(c.src))}" alt="${escHtml(c.label)}" />
                  </div>
                  <span style="font-size:12.5px;font-weight:600;color:#142433;">${escHtml(c.label)}</span>
                </button>`;
            }).join("")}
          </div>
          <button type="button" class="figma-btn-outline-48 full" data-back-to-folder-edit="1">กลับไปแก้ไข</button>
        </div>
      </div>
    `;
  }

  // 24 Share Folder Sheet: 319:3107 (Discord-style expiry, max uses & role)
  if (sheet.type === "invite") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    if (!folder) return "";
    const count = getFolderCount(folder);
    const sharePerm = state.ui.sharePermission === "editor" ? "editor" : "viewer";
    const inviteExpiry = state.ui.inviteExpiry || "7d";
    const inviteMaxUses = String(state.ui.inviteMaxUses ?? "");
    const shareState = state.ui.shareSheetState || "idle";
    const inviteUrl = buildFolderInviteUrl(folder, sharePerm, folder.inviteUrl);

    const memberBundle = state.ui.folderMembers?.[folder.id] || null;
    const members = Array.isArray(memberBundle?.members) ? memberBundle.members : [];
    const activeInvites = Array.isArray(memberBundle?.active_invites) ? memberBundle.active_invites : [];
    const ownerId = memberBundle?.owner_id || folder.ownerId || "";
    const isOwner = !memberBundle || memberBundle.caller_role === "owner";
    const folderCoverThumb = safeImgUrl(folder.cover) || resolveMediaThumbUrl((state.data.links || []).find((l) => l.folderId === folder.id)) || "";

    const formatInvExpiry = (inv) => {
      if (inv.never_expires || inv.expires_at === null) return "ไม่มีวันหมดอายุ";
      if (!inv.expires_at) return "จำกัดเวลา";
      try {
        const dt = new Date(inv.expires_at);
        if (!Number.isNaN(dt.getTime())) {
          return `หมดอายุ ${new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(dt)}`;
        }
      } catch {}
      return "จำกัดเวลา";
    };

    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div
          class="bottom-sheet figma-share-sheet"
          data-node-id="${shareState === "loading" ? "319:3429" : shareState === "error" ? "319:3751" : "319:3107"}"
        >
          <div class="figma-share-header">
            <h3 class="figma-share-title">เชิญเพื่อนเข้าโฟลเดอร์</h3>
            <button type="button" class="figma-share-close-btn" data-close-sheet="1" aria-label="ปิด">×</button>
          </div>

          <div class="figma-share-folder-preview">
            ${
              folderCoverThumb
                ? `<img class="figma-share-thumb" src="${escHtml(folderCoverThumb)}" alt="${escHtml(folder.name)}" />`
                : `<div class="figma-share-thumb" style="display:flex;align-items:center;justify-content:center;font-size:22px;">${escHtml(folder.emoji || "📁")}</div>`
            }
            <div class="figma-share-folder-meta">
              <strong>${escHtml(folder.name)}</strong>
              <span>${count} ลิงก์ที่บันทึก · ${members.length || 1} สมาชิก</span>
            </div>
          </div>

          <div class="figma-sheet-field">
            <span class="figma-share-label">สิทธิ์ของผู้ได้รับเชิญ</span>
            <div class="figma-share-perm-group">
              <button
                type="button"
                class="figma-share-perm-pill ${sharePerm === "viewer" ? "selected" : ""}"
                data-action="set-invite-role"
                data-role="viewer"
              >ผู้ดู (Viewer)</button>
              <button
                type="button"
                class="figma-share-perm-pill ${sharePerm === "editor" ? "selected" : ""}"
                data-action="set-invite-role"
                data-role="editor"
              >ผู้แก้ไข (Editor)</button>
            </div>
          </div>

          <div class="invite-config-grid">
            <div class="figma-sheet-field">
              <label class="figma-share-label" for="invite-expiry-select">หมดอายุลิงก์</label>
              <select id="invite-expiry-select" class="invite-select" data-invite-expiry="1">
                <option value="30m" ${inviteExpiry === "30m" ? "selected" : ""}>30 นาที</option>
                <option value="1h" ${inviteExpiry === "1h" ? "selected" : ""}>1 ชั่วโมง</option>
                <option value="6h" ${inviteExpiry === "6h" ? "selected" : ""}>6 ชั่วโมง</option>
                <option value="12h" ${inviteExpiry === "12h" ? "selected" : ""}>12 ชั่วโมง</option>
                <option value="1d" ${inviteExpiry === "1d" ? "selected" : ""}>1 วัน</option>
                <option value="7d" ${inviteExpiry === "7d" ? "selected" : ""}>7 วัน</option>
                <option value="never" ${inviteExpiry === "never" ? "selected" : ""}>ไม่มีวันหมดอายุ</option>
              </select>
            </div>
            <div class="figma-sheet-field">
              <label class="figma-share-label" for="invite-uses-select">จำนวนครั้งที่ใช้ได้</label>
              <select id="invite-uses-select" class="invite-select" data-invite-max-uses="1">
                <option value="" ${inviteMaxUses === "" ? "selected" : ""}>ไม่จำกัด</option>
                <option value="1" ${inviteMaxUses === "1" ? "selected" : ""}>1 ครั้ง</option>
                <option value="5" ${inviteMaxUses === "5" ? "selected" : ""}>5 ครั้ง</option>
                <option value="10" ${inviteMaxUses === "10" ? "selected" : ""}>10 ครั้ง</option>
                <option value="25" ${inviteMaxUses === "25" ? "selected" : ""}>25 ครั้ง</option>
                <option value="50" ${inviteMaxUses === "50" ? "selected" : ""}>50 ครั้ง</option>
              </select>
            </div>
          </div>

          <div class="figma-sheet-field">
            <span class="figma-share-label">ลิงก์คำเชิญล่าสุด</span>
            <div class="figma-share-url-box">
              ${
                shareState === "loading"
                  ? `<span class="figma-share-url-muted">กำลังสร้างลิงก์คำเชิญ…</span>`
                  : shareState === "error"
                    ? `<span class="figma-share-url-error">สร้างลิงก์ไม่สำเร็จ กรุณาลองอีกครั้ง</span>`
                    : `
                  <span class="figma-share-url-text">${escHtml(inviteUrl)}</span>
                  <button type="button" class="figma-red-inline-action" data-copy-invite="${escHtml(inviteUrl)}">คัดลอก</button>`
              }
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;">
            <button
              type="button"
              class="figma-btn-outline-48"
              data-action="generate-share-link"
              ${shareState === "loading" ? "disabled" : ""}
            >สร้างลิงก์ใหม่</button>
            <button
              type="button"
              class="figma-btn-red-48"
              data-copy-invite="${escHtml(inviteUrl)}"
              ${shareState === "loading" ? "disabled" : ""}
            >คัดลอกลิงก์เชิญ</button>
          </div>

          <button
            type="button"
            class="figma-btn-outline-48 full ${shareState !== "idle" ? "is-muted" : ""}"
            ${shareState !== "idle" ? "disabled" : ""}
            data-open-invite-apps="${escHtml(folder.id)}"
          >แชร์ผ่านแอปอื่น</button>

          <p class="figma-share-footnote">
            สิทธิ์ที่เลือก: ${sharePerm === "editor" ? "ผู้แก้ไข (เพิ่ม/แก้ไขลิงก์ได้)" : "ผู้ดู (อ่านอย่างเดียว)"}
          </p>

          ${
            members.length > 0 || activeInvites.length > 0
              ? `
            <div class="figma-sheet-field" style="width:100%;">
              <span class="figma-share-label">สมาชิกที่เข้าร่วม (${members.length}) · ลิงก์ที่ใช้งานอยู่ (${activeInvites.length})</span>
              <div class="figma-member-list">
                ${members
                  .map((m) => {
                    const uid = m.user_id || m.userId || "";
                    const isMemberOwner = uid === ownerId || m.role === "owner";
                    const nextRole = m.role === "editor" ? "viewer" : "editor";
                    const label = m.display_name || m.email || (uid ? `สมาชิก ${uid.slice(0, 6)}` : "สมาชิก");
                    return `
                      <div class="figma-member-row">
                        <div class="figma-member-meta">
                          <strong>${escHtml(label)}</strong>
                          <span>${isMemberOwner ? "เจ้าของโฟลเดอร์" : m.role === "editor" ? "ผู้แก้ไข (Editor)" : "ผู้ดู (Viewer)"}</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                          ${
                            isOwner && !isMemberOwner && uid
                              ? `
                            <button type="button" class="btn-outline-pill" style="height:28px;padding:0 10px;font-size:11.5px;" data-change-member-role="${escHtml(uid)}" data-role="${nextRole}">
                              สลับเป็น${nextRole === "editor" ? "แก้ไข" : "ดู"}
                            </button>
                            <button type="button" class="btn-outline-pill" style="height:28px;padding:0 10px;font-size:11.5px;color:var(--theme-accent-text);" data-remove-member="${escHtml(uid)}">
                              นำออก
                            </button>`
                              : ""
                          }
                        </div>
                      </div>`;
                  })
                  .join("")}
                ${activeInvites
                  .map((inv) => {
                    const invLink = inv.invite_url || buildFolderInviteUrl({ id: folder.id, inviteSlug: inv.token }, inv.role);
                    const usesText = inv.max_uses
                      ? `ใช้ไป ${Number(inv.use_count || 0)}/${Number(inv.max_uses)} ครั้ง`
                      : `${Number(inv.use_count || 0) > 0 ? `ใช้ไป ${Number(inv.use_count)} ครั้ง · ` : ""}ไม่จำกัดครั้ง`;
                    return `
                  <div class="figma-member-row">
                    <div class="figma-member-meta">
                      <strong>${inv.role === "editor" ? "Editor" : "Viewer"} · ${escHtml(formatInvExpiry(inv))}</strong>
                      <span>${escHtml(usesText)} · ${escHtml((inv.token || "").slice(0, 10))}…</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <button type="button" class="btn-outline-pill" style="height:28px;padding:0 10px;font-size:11.5px;" data-copy-invite="${escHtml(invLink)}">คัดลอก</button>
                      ${
                        isOwner && inv.token
                          ? `<button type="button" class="btn-outline-pill" style="height:28px;padding:0 10px;font-size:11.5px;color:var(--theme-accent-text);" data-revoke-invite="${escHtml(inv.token)}">ยกเลิก</button>`
                          : ""
                      }
                    </div>
                  </div>`;
                  })
                  .join("")}
              </div>
            </div>`
              : ""
          }
        </div>
      </div>
    `;
  }

  // 24.1 Folder · เลือกแอปแชร์
  if (sheet.type === "inviteShareApp") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    if (!folder) return "";
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-share-sheet">
          <div class="figma-sheet-handle"></div>
          <div class="figma-share-header">
            <h3 class="figma-share-title">แชร์คำเชิญ</h3>
            <button type="button" class="figma-share-close-btn" data-close-sheet="1" aria-label="ปิด">×</button>
          </div>
          <p class="tiny-hint" style="margin:0;">เลือกแอปเพื่อสร้างข้อความเชิญเข้าโฟลเดอร์ ${escHtml(folder.name)}</p>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;">
            ${["LINE", "Messages", "อีเมล"]
              .map(
                (app) => `
              <button type="button" class="figma-btn-outline-44" data-open-invite-preview="${escHtml(folder.id)}" data-share-app="${escHtml(app)}">
                ${app}
              </button>`
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  if (sheet.type === "invitePreview") {
    const folder = getFolderById(sheet.folderId) || state.data.folders[0];
    if (!folder) return "";
    const inviteUrl = buildFolderInviteUrl(
      folder,
      state.ui.sharePermission || "viewer",
      folder.inviteUrl
    );
    return `
      <div class="modal-backdrop" data-close-sheet="1">
        <div class="bottom-sheet figma-share-sheet">
          <div class="figma-sheet-handle"></div>
          <div class="figma-share-header">
            <h3 class="figma-share-title">ตัวอย่างข้อความเชิญ</h3>
            <button type="button" class="figma-share-close-btn" data-close-sheet="1" aria-label="ปิด">×</button>
          </div>
          <span style="font-size:13px;font-weight:700;color:#55596a;">ผ่าน ${escHtml(sheet.appName || "LINE")}</span>
          <div style="background:#f7f5f0;border-radius:12px;padding:12px;font-size:13px;width:100%;">
            <div>ชวนมาดูและช่วยกันเก็บลิงก์ในโฟลเดอร์ "${escHtml(folder.name)}" บน Sherlink</div>
            <div style="color:var(--theme-accent-text);margin-top:4px;font-weight:600;word-break:break-all;">${escHtml(inviteUrl)}</div>
          </div>
          <button type="button" class="figma-sheet-submit-btn" data-preview-recipient-invite="${escHtml(folder.id)}">
            ${icons.share(17)}
            <span>ดูหน้าที่ผู้รับจะเห็น</span>
          </button>
        </div>
      </div>
    `;
  }

  if (sheet.type === "deleteFolderDialog") {
    const folder = getFolderById(sheet.folderId);
    if (!folder) return "";
    const count = getFolderCount(folder);
    return `
      <div class="modal-backdrop center" data-close-sheet="1">
        <div class="center-dialog">
          <h3 style="margin:0;font-size:19px;color:var(--ink-primary);">ลบโฟลเดอร์นี้ไหม?</h3>
          <p style="margin:0;font-size:14px;font-weight:600;color:var(--ink-primary);">${escHtml(folder.name)}</p>
          <p style="margin:0;font-size:13px;color:var(--ink-secondary);">
            ${
              count > 0
                ? `ลิงก์ทั้งหมด ${count} รายการในโฟลเดอร์นี้จะถูกย้ายไปที่ "ยังไม่จัดหมวด" และจะไม่ถูกลบ`
                : "โฟลเดอร์นี้จะถูกลบออกอย่างถาวร"
            }
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px;">
            <button type="button" class="btn-outline-pill" data-close-sheet="1">ยกเลิก</button>
            <button type="button" class="btn-accent-pill lg" data-execute-delete-folder="${escHtml(folder.id)}">
              ลบโฟลเดอร์
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}
