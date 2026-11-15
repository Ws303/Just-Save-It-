/**
 * QA & Backend/MCP Testbed Panel (Right Sidebar Inspector)
 * Exposes Mock/Live switching, backend /health check, POST /api/ai/summarize runner,
 * External Intent & Invite Flow simulators, 13-tool MCP Runner, HTTP Request/Response Inspector,
 * and Backend Implementation Coverage Matrix.
 */
import { escHtml } from "../components/icons.js";
import { MCP_TOOLS_CATALOG } from "../data/seed.js";
import { buildAiHeadersAndConfig } from "../services/apiClient.js";
import { getAuthMode, hasValidSession } from "../services/routeGuard.js";
import { isQaModeEnabled } from "../state/store.js";

export function renderTestbedPanel(state) {
  if (!isQaModeEnabled()) return "";
  const { api, data, ui } = state;
  const activeTab = ui.inspectorTab || "controls";
  const selectedLink = data.links.find((l) => l.id === ui.activeLinkId) || data.links[0];
  const { headers, preset } = buildAiHeadersAndConfig();

  return `
    <aside class="tb-inspector" aria-label="Backend & QA Testbed">
      <div class="tb-ins-tabs">
        <button class="tb-ins-tab ${activeTab === "controls" ? "active" : ""}" data-ins-tab="controls">Test Runner</button>
        <button class="tb-ins-tab ${activeTab === "logs" ? "active" : ""}" data-ins-tab="logs">HTTP (${api.logs.length})</button>
        <button class="tb-ins-tab ${activeTab === "mcp" ? "active" : ""}" data-ins-tab="mcp">MCP (13)</button>
        <button class="tb-ins-tab ${activeTab === "matrix" ? "active" : ""}" data-ins-tab="matrix">Backend</button>
      </div>

      <div class="tb-ins-body">
        ${activeTab === "controls" ? renderControlsTab(state, selectedLink, headers, preset) : ""}
        ${activeTab === "logs" ? renderLogsTab(api) : ""}
        ${activeTab === "mcp" ? renderMcpTab(state) : ""}
        ${activeTab === "matrix" ? renderMatrixTab(api) : ""}
      </div>
    </aside>
  `;
}

function renderControlsTab(state, selectedLink, headers, preset) {
  const { api, data } = state;
  return `
    <!-- Backend Connection & Mode -->
    <div class="tb-card">
      <h3 class="tb-card-title">
        <span>Backend Mode</span>
        <span class="tag-badge ${api.mode === "live" ? "live" : "mock"}">
          ${api.mode === "live" ? "LIVE FASTAPI" : "MOCK SIMULATOR"}
        </span>
      </h3>
      <div class="tb-segmented" style="width:100%;">
        <button class="tb-seg-btn ${api.mode === "mock" ? "active" : ""}" style="flex:1;" data-set-api-mode="mock">Mock Mode (Offline)</button>
        <button class="tb-seg-btn ${api.mode === "live" ? "active" : ""}" style="flex:1;" data-set-api-mode="live">Live FastAPI</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr auto;gap:6px;">
        <input class="tb-mini-input" type="url" value="${escHtml(api.baseUrl)}" placeholder="http://localhost:8000" data-bind-api-base="1" />
        <button class="tb-btn primary" data-ping-health="1">Ping /health</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div>
          <span class="tiny-hint">X-User-Id (Dev Bypass)</span>
          <input class="tb-mini-input" type="text" value="${escHtml(api.userId)}" data-bind-user-id="1" />
        </div>
        <div>
          <span class="tiny-hint">Simulated Latency (ms)</span>
          <input class="tb-mini-input" type="number" min="0" max="3000" step="50" value="${api.latencyMs}" data-bind-latency="1" />
        </div>
      </div>

      <label style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--ink-secondary);padding:4px 2px 0;cursor:pointer;">
        <span>ส่ง X-User-Id Dev Bypass เมื่อไม่มี Bearer JWT</span>
        <input type="checkbox" ${api.useDevBypass ? "checked" : ""} data-toggle-dev-bypass="1" />
      </label>

      ${
        api.healthDetail
          ? `<pre class="tb-pre">${escHtml(JSON.stringify(api.healthDetail, null, 2))}</pre>`
          : ""
      }
    </div>

    <!-- Phase 1: Supabase Auth & Protected Route Guard Runner -->
    <div class="tb-card" style="border: 2px solid var(--theme-accent); background: #faf5ff;">
      <h3 class="tb-card-title">
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span style="background:var(--theme-accent);color:#fff;border-radius:6px;padding:1px 6px;font-size:11px;font-weight:900;">AUTH</span>
          <span>Supabase Auth &amp; Protected Routes</span>
        </span>
        <span class="tag-badge ${hasValidSession(state) ? "live" : "mock"}">
          ${hasValidSession(state) ? "AUTHENTICATED" : "LOCKED"}
        </span>
      </h3>

      <div class="tb-segmented" style="width:100%;margin-bottom:6px;">
        <button class="tb-seg-btn ${getAuthMode(state) === "mock" ? "active" : ""}" style="flex:1;font-size:11px;" data-set-auth-provider="mock">Mock</button>
        <button class="tb-seg-btn ${getAuthMode(state) === "supabase" ? "active" : ""}" style="flex:1;font-size:11px;" data-set-auth-provider="supabase">Supabase Cloud</button>
        <button class="tb-seg-btn ${getAuthMode(state) === "backend" ? "active" : ""}" style="flex:1;font-size:11px;" data-set-auth-provider="backend">FastAPI JWT</button>
      </div>

      ${
        getAuthMode(state) === "supabase"
          ? `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px;">
              <span class="tiny-hint">Supabase URL (JWKS Asymmetric Auth)</span>
              <input class="tb-mini-input" type="url" value="${escHtml(api.supabaseUrl)}" data-bind-supabase-url="1" />
              <span class="tiny-hint">Publishable / Anon Key</span>
              <input class="tb-mini-input" type="text" value="${escHtml(api.supabaseAnonKey)}" data-bind-supabase-key="1" />
            </div>`
          : ""
      }

      <label style="display:flex;align-items:center;justify-content:space-between;background:#fff;padding:6px 8px;border-radius:6px;border:1px solid var(--tb-border);margin-bottom:6px;font-size:11.5px;cursor:pointer;">
        <span>🛡️ Protected Route Guard (${state.ui.authGuardEnabled !== false ? "ON" : "OFF"})</span>
        <input type="checkbox" ${state.ui.authGuardEnabled !== false ? "checked" : ""} data-toggle-auth-guard="1" />
      </label>

      <div style="font-size:11px;color:var(--ink-secondary);margin-bottom:8px;padding:6px;background:#fff;border-radius:6px;border:1px solid var(--tb-border);word-break:break-all;">
        <div><strong>Bearer JWT:</strong> ${api.bearerToken ? `<span style="color:#059669;font-weight:600;">${escHtml(api.bearerToken.slice(0, 26))}...</span>` : `<span style="color:#dc2626;">(ยังไม่มี Token - Protected Routes Locked)</span>`}</div>
        ${
          api.jwtClaims
            ? `<div style="margin-top:3px;color:#334155;"><strong>Claims:</strong> alg=${escHtml(api.jwtClaims.alg || "-")} · sub=${escHtml(String(api.jwtClaims.sub || "").slice(0, 14))}... · email=${escHtml(api.jwtClaims.email || "-")}</div>`
            : ""
        }
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="loginPassword" title="POST /api/auth/login or Supabase Sign In">
          🔑 Login (Test Account)
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="magicLink" title="Magic Link OTP">
          ✉️ Magic Link
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="getMe" title="GET /api/auth/me">
          👤 Get /api/auth/me
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="testProtectedRoute" title="ทดสอบ Protected Route + GET /api/items">
          🛡️ Test Protected Route
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="refreshToken" title="Refresh Session JWT">
          🔄 Refresh Session
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="googleOauth" title="Google OAuth">
          🌐 Google OAuth URL
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;" data-tb-test-auth="createToken" title="POST /api/auth/tokens">
          🎟️ Create MCP Token
        </button>
        <button class="tb-btn" style="justify-content:center;background:#fff;color:#dc2626;" data-tb-test-auth="logout" title="Sign Out & Lock Protected Routes">
          🚪 Logout (Lock)
        </button>
      </div>
    </div>

    <!-- Share Sheet Intent Simulator (Primary Focus) -->
    <div class="tb-card" style="border: 2px solid #fed053; background: #fffdf5;">
      <h3 class="tb-card-title">
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span style="background:#fed053;border:1.5px solid #000;border-radius:6px;padding:1px 5px;font-size:11px;font-weight:900;">NEW</span>
          <span>จำลองการแชร์จากแอปอื่น (Share Sheet Test)</span>
        </span>
      </h3>
      <p class="tiny-hint" style="margin:0 0 6px;">
        ทดสอบว่าเมื่อผู้ใช้กด Share จาก TikTok, IG หรือแอปอื่นเข้ามา หน้าตา Share Sheet สไตล์ Neobrutalism จะขึ้นอย่างไร และข้อมูลถูกส่งเข้าแอปจริงหรือไม่
      </p>

      <!-- Preset Quick Triggers -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button
          class="tb-btn"
          style="background:#fed053;color:#000;font-weight:800;border:1.5px solid #000;box-shadow:2px 2px 0 #000;justify-content:center;"
          data-sim-share-preset="tiktok"
          title="จำลองแชร์จาก TikTok ตรงตามรูปตัวอย่าง"
        >
          🎵 TikTok (ตามรูปตัวอย่าง)
        </button>
        <button
          class="tb-btn"
          style="justify-content:center;"
          data-sim-share-preset="instagram"
          title="จำลองแชร์คลิป Reels จาก Instagram"
        >
          📸 Instagram Reels
        </button>
        <button
          class="tb-btn"
          style="justify-content:center;"
          data-sim-share-preset="youtube"
          title="จำลองแชร์จาก YouTube"
        >
          ▶️ YouTube
        </button>
        <button
          class="tb-btn"
          style="justify-content:center;"
          data-sim-share-preset="twitter"
          title="จำลองแชร์จาก X (Twitter)"
        >
          𝕏 X (Twitter)
        </button>
      </div>

      <!-- Backdrop Simulator Toggle -->
      <div style="margin-top:6px;display:flex;align-items:center;justify-content:space-between;background:#fff;padding:6px 10px;border-radius:8px;border:1px solid var(--tb-border);">
        <span style="font-size:12px;font-weight:600;color:#1e293b;">จำลองฉากหลังแอปต้นทาง (Simulate Host App)</span>
        <label style="display:inline-flex;align-items:center;cursor:pointer;">
          <input type="checkbox" id="tbToggleHostBackdrop" ${state.ui.simulatedSourceApp ? "checked" : ""} data-toggle-host-backdrop="1" />
        </label>
      </div>

      <!-- Custom Share Form -->
      <details style="font-size:12px;margin-top:4px;">
        <summary style="cursor:pointer;color:var(--ink-secondary);font-weight:600;">กำหนดข้อความและ URL เพื่อทดสอบเอง (Custom Intent)</summary>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;background:#fff;padding:8px;border-radius:8px;border:1px solid var(--tb-border);">
          <input class="tb-mini-input" type="text" id="customShareTitle" placeholder="ชื่อโพสต์ เช่น คาเฟ่เปิดใหม่ชวนไปลอง" value="TikTok - Make Your Day" />
          <input class="tb-mini-input" type="url" id="customShareUrl" placeholder="URL เช่น https://vt.tiktok.com/ZSjXample/" value="https://vt.tiktok.com/ZSjXample/" />
          <button class="tb-btn primary" data-sim-custom-share="1">⚡ ส่งแชร์เข้าแอป Just Save It</button>
        </div>
      </details>
    </div>

    <!-- Incoming Share Verification Inspector -->
    <div class="tb-card" style="border: 2px solid ${data.lastSharedEvent ? "#10b981" : "var(--tb-border)"};">
      <h3 class="tb-card-title">
        <span style="display:inline-flex;align-items:center;gap:6px;">
          <span>📥 ตรวจสอบข้อมูลที่ถูกส่งเข้าแอป</span>
          ${
            data.lastSharedEvent
              ? `<span class="tag-badge live" style="background:#10b981;">DATA RECEIVED</span>`
              : `<span class="tag-badge mock">WAITING</span>`
          }
        </span>
      </h3>

      ${
        data.lastSharedEvent
          ? `
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;">
            <div style="color:#065f46;font-weight:700;display:flex;align-items:center;gap:4px;">
              <span>✓ ข้อมูลถูกส่งเข้าแอปและบันทึกเรียบร้อย</span>
              <span class="tiny-hint" style="color:#047857;">(${escHtml(data.lastSharedEvent.at)})</span>
            </div>
            <div style="margin-top:4px;">
              <strong>ชื่อโพสต์:</strong> ${escHtml(data.lastSharedEvent.title)}<br/>
              <strong>URL:</strong> <a href="${escHtml(data.lastSharedEvent.url)}" target="_blank" style="text-decoration:underline;">${escHtml(data.lastSharedEvent.url)}</a><br/>
              <strong>แพลตฟอร์ม:</strong> ${escHtml(data.lastSharedEvent.platform)} (${escHtml(data.lastSharedEvent.domain)})<br/>
              <strong>คอลเลกชัน:</strong> 📁 ${escHtml(data.lastSharedEvent.folderName)}<br/>
              <strong>สถานะการปักหมุด:</strong> ${data.lastSharedEvent.pinned ? "📌 ปักหมุดไว้บนสุด" : "ธรรมดา"}<br/>
              <strong>แท็ก:</strong> ${(data.lastSharedEvent.tags || []).join(", ") || "-"}
            </div>
          </div>

          <div style="display:flex;gap:6px;">
            <button class="tb-btn primary" style="flex:1;" data-open-link="${data.lastSharedEvent.id}">
              👀 เปิดดูการ์ดที่แชร์เข้ามาในแอป
            </button>
            <button class="tb-btn" style="flex:1;" data-open-folder="${data.lastSharedEvent.folderId}">
              📁 ไปที่คอลเลกชัน ${escHtml(data.lastSharedEvent.folderName)}
            </button>
          </div>

          <details style="font-size:11.5px;">
            <summary style="cursor:pointer;color:var(--ink-secondary);font-weight:600;">ดู Raw JSON Payload ที่ส่งเข้า API</summary>
            <pre class="tb-pre">${escHtml(JSON.stringify(data.lastSharedEvent, null, 2))}</pre>
          </details>
        </div>`
          : `
        <div style="padding:10px;text-align:center;color:var(--ink-secondary);font-size:12.5px;">
          ยังไม่มีข้อมูลที่เพิ่งแชร์เข้ามา<br/>
          <span class="tiny-hint">ลองกดปุ่ม <strong>"🎵 TikTok (ตามรูปตัวอย่าง)"</strong> ด้านบน แล้วกด <strong>"บันทึกลิงก์"</strong> ในแชร์ชีต</span>
        </div>`
      }
    </div>

    <!-- Other Figma Flows -->
    <div class="tb-card">
      <h3 class="tb-card-title"><span>หน้าจออื่นๆ จาก Figma</span></h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <button class="tb-btn" data-sim-open-invite="1">เปิดคำเชิญเพื่อน → 23 Invite</button>
        <button class="tb-btn" data-open-preview="1">โหมดปัดดูรายการ → 7 Preview</button>
        <button class="tb-btn" data-go-screen="login">Logout Preview → 10 Login</button>
      </div>
    </div>

    <!-- Live POST /api/ai/summarize Runner -->
    <div class="tb-card">
      <h3 class="tb-card-title">
        <span>ทดสอบ POST /api/ai/summarize</span>
        <span class="tiny-hint">${escHtml(preset.backendProvider)}</span>
      </h3>

      <select class="tb-mini-input" data-select-test-item="1">
        ${data.links
          .map(
            (l) => `
          <option value="${l.id}" ${selectedLink?.id === l.id ? "selected" : ""}>
            ${escHtml(l.title)} (${escHtml(l.platform)})
          </option>`
          )
          .join("")}
      </select>

      <div style="display:flex;gap:14px;font-size:12px;">
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
          <input type="checkbox" ${api.summarizeOptions.forceRefresh ? "checked" : ""} data-toggle-force-refresh="1" />
          force_refresh
        </label>
        <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
          <input type="checkbox" ${api.summarizeOptions.saveToNote ? "checked" : ""} data-toggle-save-note="1" />
          save_to_note
        </label>
      </div>

      <details style="font-size:11.5px;">
        <summary style="cursor:pointer;color:var(--ink-secondary);font-weight:600;">ดู Headers ที่จะส่ง (X-AI-* & Auth)</summary>
        <pre class="tb-pre">${escHtml(JSON.stringify(headers, null, 2))}</pre>
      </details>

      <button
        class="tb-btn primary"
        style="width:100%;height:36px;"
        data-run-ai-summarize="${selectedLink?.id || ""}"
        ${api.isSummarizing ? "disabled" : ""}
      >
        ${api.isSummarizing ? "กำลังส่ง POST /api/ai/summarize..." : "ยิง POST /api/ai/summarize"}
      </button>
    </div>

    <!-- State Utilities -->
    <div class="tb-card">
      <div style="display:flex;gap:8px;justify-content:space-between;">
        <button class="tb-btn" style="flex:1;" data-export-json-state="1">Export State JSON</button>
        <button class="tb-btn" style="flex:1;color:#b91c1c;" data-reset-seed="1">Reset Demo Seed</button>
      </div>
    </div>
  `;
}

function renderLogsTab(api) {
  if (!api.logs.length) {
    return `<div class="tb-card"><span class="tiny-hint">ยังไม่มีประวัติ API — ลองกดเพิ่มลิงก์ สรุปด้วย AI หรือ Ping /health</span></div>`;
  }

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:13px;">HTTP & MCP Trace Logs</strong>
      <button class="tb-btn" data-clear-logs="1">ล้าง Logs</button>
    </div>
    ${api.logs
      .map(
        (log) => `
      <div class="tb-log-item">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div class="inline-flex-row" style="gap:6px;">
            <span class="method-badge ${escHtml(log.method)}">${escHtml(log.method)}</span>
            <code style="font-size:11.5px;font-weight:600;">${escHtml(log.path)}</code>
          </div>
          <span class="tiny-hint">${log.status} · ${log.durationMs}ms · ${log.mode}</span>
        </div>
        ${log.error ? `<div style="color:#dc2626;margin-top:4px;font-weight:600;">${escHtml(log.error)}</div>` : ""}
        ${
          log.requestBody
            ? `<details style="margin-top:4px;"><summary class="tiny-hint" style="cursor:pointer;">Request</summary><pre class="tb-pre">${escHtml(JSON.stringify(log.requestBody, null, 2))}</pre></details>`
            : ""
        }
        ${
          log.responseBody
            ? `<details open style="margin-top:4px;"><summary class="tiny-hint" style="cursor:pointer;">Response</summary><pre class="tb-pre">${escHtml(JSON.stringify(log.responseBody, null, 2))}</pre></details>`
            : ""
        }
      </div>`
      )
      .join("")}
  `;
}

function renderMcpTab(state) {
  const { lastMcpResult } = state.api;
  return `
    <div class="tb-card">
      <h3 class="tb-card-title"><span>13 MCP Tools Tester (backend/Ai/mcp_server.py)</span></h3>
      <p class="tiny-hint" style="margin:0;">
        ทดสอบเครื่องมือ MCP ทั้ง 13 ตัว (Mount อยู่ที่ <code>/mcp</code> SSE บน FastAPI)
      </p>
      <div style="display:grid;grid-template-columns:1fr;gap:6px;">
        ${MCP_TOOLS_CATALOG.map(
          (tool) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--tb-border);border-radius:8px;">
            <div style="min-width:0;">
              <div style="font-family:var(--font-mono);font-size:11.5px;font-weight:700;">${escHtml(tool.name)}</div>
              <div class="tiny-hint">${escHtml(tool.group)} · ${escHtml(tool.desc)}</div>
            </div>
            <button class="tb-btn" data-run-mcp-tool="${escHtml(tool.name)}">Run</button>
          </div>`
        ).join("")}
      </div>
      ${
        lastMcpResult
          ? `
        <div>
          <strong style="font-size:12px;">ผลลัพธ์ล่าสุด: ${escHtml(lastMcpResult.toolName)}</strong>
          <pre class="tb-pre">${escHtml(JSON.stringify(lastMcpResult.result, null, 2))}</pre>
        </div>`
          : ""
      }
    </div>
  `;
}

function renderMatrixTab(api) {
  const rows = [
    { area: "backend/main.py", route: "GET /health", status: "Implemented", mode: "Live + Mock" },
    { area: "backend/Login/", route: "POST /api/auth/* (Email/OAuth/Native/Tokens)", status: "Implemented (Phase 1)", mode: "Live + Mock" },
    { area: "backend/Ai/router.py", route: "POST /api/ai/summarize", status: "Implemented (3-Tier)", mode: "Live + Mock" },
    { area: "backend/Ai/mcp_server.py", route: "SSE /mcp (13 Tools)", status: "Implemented", mode: "Sim + Probe" },
    { area: "backend/Database/", route: "POST /api/preview, /links, /folders", status: "Implemented", mode: "Live + Mock" },
    { area: "backend/Database/", route: "/reminders & /invites & CSV Export", status: "Implemented", mode: "Live + Mock" },
  ];

  return `
    <div class="tb-card">
      <h3 class="tb-card-title"><span>Backend Readiness & Endpoint Coverage</span></h3>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${rows
          .map(
            (r) => `
          <div style="border:1px solid var(--tb-border);border-radius:8px;padding:8px 10px;font-size:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>${escHtml(r.route)}</strong>
              <span class="tag-badge ${r.status.startsWith("Implemented") ? "live" : "mock"}">${escHtml(r.status)}</span>
            </div>
            <div class="tiny-hint" style="margin-top:3px;">${escHtml(r.area)} · ${escHtml(r.mode)}</div>
          </div>`
          )
          .join("")}
      </div>
      <div style="background:#f8fafc;border-radius:8px;padding:10px;font-size:11.5px;line-height:1.5;color:#334155;">
        <strong>วิธีรัน Live FastAPI Backend:</strong><br />
        <code>uvicorn backend.main:app --reload --port 8000</code><br />
        เป้าหมายปัจจุบัน: <code>${escHtml(api.baseUrl)}</code>
      </div>
    </div>
  `;
}
