/**
 * 18 AI · เชื่อมต่อ AI Screen
 * Matches Figma section 119:359 (OpenAI, Anthropic, Google Gemini, Custom Endpoint + Keyless, + Built-in Tier 1)
 * Maps directly to backend/Ai/router.py X-AI-* headers & SummarizeRequest schema.
 */
import { icons, escHtml } from "../components/icons.js";
import { AI_PROVIDER_PRESETS } from "../data/seed.js";
import { renderBottomNav } from "./common.js";

export function renderAiScreen(state) {
  const cfg = state.data.aiConfig;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === cfg.provider) || AI_PROVIDER_PRESETS[3];
  const isCustom = preset.backendProvider === "custom";
  const isBuiltIn = preset.backendProvider === "built-in";
  const openMenu = state.ui.aiDropdown;
  const selectedModel = cfg.model || "";
  const firstLink = state.data.links[2] || state.data.links[0];

  return `
    <div class="screen-scroll with-nav-pad">
      <div class="app-pad" style="display:flex;flex-direction:column;gap:14px;padding-top:20px;">
        <div class="ai-header-row">
          <div class="ai-icon-tile">${icons.bot(22)}</div>
          <h1 class="page-heading">เชื่อมต่อ AI</h1>
        </div>
        <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
          เชื่อมต่อ Sharely กับ Endpoint ของคุณ (${escHtml(preset.description)})
        </p>

        <!-- Provider Dropdown (119:683) -->
        <div class="field-group">
          <label class="field-label">ผู้ให้บริการ AI</label>
          <button class="select-trigger" data-toggle-ai-dropdown="provider">
            <span>${escHtml(cfg.provider)}</span>
            ${icons.chevronDown(18)}
          </button>
          ${
            openMenu === "provider"
              ? `
            <div class="dropdown-popover">
              ${AI_PROVIDER_PRESETS.map(
                (p) => `
                <button class="dropdown-option ${cfg.provider === p.id ? "active" : ""}" data-select-ai-provider="${escHtml(p.id)}">
                  <span>${escHtml(p.id)}</span>
                  <span class="tiny-hint">${escHtml(p.backendProvider)}</span>
                </button>`
              ).join("")}
            </div>`
              : ""
          }
        </div>

        <!-- Model Dropdown (119:694..715) -->
        <div class="field-group">
          <label class="field-label">โมเดล</label>
          <button class="select-trigger" data-toggle-ai-dropdown="model">
            <span style="color:${selectedModel ? "var(--ink-primary)" : "var(--ink-secondary)"};">
              ${escHtml(selectedModel || "เลือกโมเดล")}
            </span>
            ${icons.chevronDown(18)}
          </button>
          ${
            openMenu === "model"
              ? `
            <div class="dropdown-popover">
              ${preset.models
                .map(
                  (m) => `
                <button class="dropdown-option ${selectedModel === m ? "active" : ""}" data-select-ai-model="${escHtml(m)}">
                  <span>${escHtml(m)}</span>
                </button>`
                )
                .join("")}
            </div>`
              : ""
          }
        </div>

        ${
          isCustom
            ? `
          <div class="field-group">
            <label class="field-label">Endpoint</label>
            <input
              class="field-input"
              type="url"
              value="${escHtml(cfg.endpointUrl)}"
              placeholder="https://api.example.com/v1"
              data-bind-ai-endpoint="1"
            />
          </div>

          <div class="keyless-box" data-toggle-ai-keyless="1">
            <div class="keyless-checkbox ${cfg.keyless ? "checked" : ""}">
              ${cfg.keyless ? icons.check(14) : ""}
            </div>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--ink-primary);">Keyless</div>
              <div class="tiny-hint">Endpoint นี้ไม่ต้องใช้ API Key</div>
            </div>
          </div>`
            : ""
        }

        ${
          !isBuiltIn
            ? `
          <div class="field-group">
            <label class="field-label">API Key</label>
            <input
              class="field-input"
              type="password"
              value="${escHtml(cfg.keyless ? "" : cfg.apiKey)}"
              placeholder="${cfg.keyless ? "ไม่จำเป็นสำหรับโหมด Keyless" : "กรอก API Key ของคุณ"}"
              ${cfg.keyless ? "disabled" : ""}
              data-bind-ai-key="1"
            />
          </div>`
            : `
          <div class="ai-summary-card">
            <strong style="font-size:13px;">Built-in Free Tier</strong>
            <p class="tiny-hint" style="margin:4px 0 0;">
              ใช้ Key ของเซิร์ฟเวอร์ (backend/.env GEMINI_API_KEY) โดยไม่ต้องส่ง X-AI-Key จากแอป
            </p>
          </div>`
        }

        <button class="btn-accent-pill full48" data-save-ai-config="1">
          เชื่อมต่อ AI
        </button>

        ${
          firstLink
            ? `
          <div class="settings-card" style="padding:12px;background:var(--bg-muted);border-color:var(--border-divider);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong style="font-size:13px;">ทดสอบเรียกใช้งานจริง</strong>
              <span class="tag-badge ${state.api.mode === "live" ? "live" : "mock"}">
                ${state.api.mode === "live" ? "LIVE API" : "MOCK MODE"}
              </span>
            </div>
            <p class="tiny-hint" style="margin:0 0 8px;">
              ทดสอบยิง <code>POST /api/ai/summarize</code> สำหรับ "${escHtml(firstLink.title)}"
            </p>
            <button class="btn-outline-pill" style="width:100%;height:38px;font-size:13px;" data-run-ai-summarize="${firstLink.id}">
              ${state.api.isSummarizing ? "กำลังส่งคำขอ..." : "ทดสอบสรุปเนื้อหาทันที"}
            </button>
          </div>`
            : ""
        }
      </div>

      ${renderBottomNav("ai")}
    </div>
  `;
}
