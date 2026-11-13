/**
 * QA & Backend/MCP Testbed Panel (Right Sidebar Inspector)
 * Exposes Mock/Live switching, backend /health check, POST /api/ai/summarize runner,
 * External Intent & Invite Flow simulators, 13-tool MCP Runner, HTTP Request/Response Inspector,
 * and Backend Implementation Coverage Matrix.
 */
import { escHtml } from "../components/icons.js";
import { MCP_TOOLS_CATALOG } from "../data/seed.js";
import { buildAiHeadersAndConfig } from "../services/apiClient.js";

export function renderTestbedPanel(state) {
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

      ${
        api.healthDetail
          ? `<pre class="tb-pre">${escHtml(JSON.stringify(api.healthDetail, null, 2))}</pre>`
          : ""
      }
    </div>

    <!-- Flow Triggers -->
    <div class="tb-card">
      <h3 class="tb-card-title"><span>จำลอง User Flows จาก Figma</span></h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <button class="tb-btn" data-sim-share-intent="tiktok">Share จาก TikTok → 1 Save Link</button>
        <button class="tb-btn" data-sim-share-intent="youtube">Share จาก YouTube</button>
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
    { area: "backend/Ai/router.py", route: "POST /api/ai/summarize", status: "Implemented (3-Tier)", mode: "Live + Mock" },
    { area: "backend/Ai/mcp_server.py", route: "SSE /mcp (13 Tools)", status: "Implemented", mode: "Sim + Probe" },
    { area: "backend/Login/", route: "POST /api/auth/* (Email/OAuth)", status: "Planned (.gitkeep)", mode: "Mock Simulated" },
    { area: "backend/Database/", route: "POST /api/preview, /links, /folders", status: "Planned (.gitkeep)", mode: "Mock Simulated" },
    { area: "backend/Database/", route: "/reminders & /invites & CSV Export", status: "Planned (.gitkeep)", mode: "Mock Simulated" },
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
