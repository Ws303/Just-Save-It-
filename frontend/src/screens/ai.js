/**
 * 18 AI · เชื่อมต่อ AI Screen
 * Matches Figma section 119:359 (OpenAI, Anthropic, Google Gemini, Custom Endpoint + Keyless, + Built-in Tier 1)
 * Maps directly to backend/Ai/router.py X-AI-* headers & SummarizeRequest schema.
 */
import { icons, escHtml } from "../components/icons.js";
import { AI_PROVIDER_PRESETS } from "../data/seed.js";
import { renderBottomNav } from "./common.js";

export function renderAiPanelBody(state) {
  const cfg = state.data.aiConfig;
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === cfg.provider) || AI_PROVIDER_PRESETS[0];
  const isCustom = preset.backendProvider === "custom";
  const isBuiltIn = preset.backendProvider === "built-in";
  const openMenu = state.ui.aiDropdown;
  const selectedModel = cfg.model || "";
  const quotaTotal = Math.max(1, Number(state.data.freeQuotaTotal ?? state.data.freeQuotaLimit ?? 50));
  const quotaRemaining = Math.max(0, Number(state.data.freeQuotaRemaining ?? quotaTotal));
  const quotaPct = Math.min(100, Math.max(0, Math.round((quotaRemaining / quotaTotal) * 100)));

  return `
        <div class="ai-header-row">
          <div class="ai-icon-tile">${icons.bot(22)}</div>
          <h1 class="page-heading">เชื่อมต่อ AI</h1>
        </div>
        <p style="margin:0;font-size:14px;color:var(--ink-secondary);">
          เชื่อมต่อ Sherlink กับ Endpoint ของคุณ (${escHtml(preset.description)})
        </p>

        <!-- Provider Dropdown (119:683) -->
        <div class="field-group">
          <label class="field-label">ผู้ให้บริการ AI</label>
          <button type="button" class="select-trigger" data-toggle-ai-dropdown="provider">
            <span>${escHtml(cfg.provider)}</span>
            ${icons.chevronDown(18)}
          </button>
          ${
            openMenu === "provider"
              ? `
            <div class="dropdown-popover">
              ${AI_PROVIDER_PRESETS.map(
                (p) => `
                <button type="button" class="dropdown-option ${cfg.provider === p.id ? "active" : ""}" data-select-ai-provider="${escHtml(p.id)}">
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
          <button type="button" class="select-trigger" data-toggle-ai-dropdown="model">
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
                <button type="button" class="dropdown-option ${selectedModel === m ? "active" : ""}" data-select-ai-model="${escHtml(m)}">
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
              value="${escHtml(isCustom && cfg.keyless ? "" : cfg.apiKey)}"
              placeholder="${isCustom && cfg.keyless ? "ไม่จำเป็นสำหรับโหมด Keyless" : "กรอก API Key ของคุณ"}"
              ${isCustom && cfg.keyless ? "disabled" : ""}
              data-bind-ai-key="1"
            />
          </div>`
            : `
          <div class="ai-summary-card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <strong style="font-size:13px;">Built-in Free Tier</strong>
              <span style="font-size:12px;font-weight:700;color:var(--theme-accent-text);">เหลือ ${quotaRemaining}/${quotaTotal} ครั้ง</span>
            </div>
            <div style="height:6px;border-radius:999px;background:var(--theme-soft);margin-top:8px;overflow:hidden;">
              <div style="height:100%;width:${quotaPct}%;background:var(--theme-accent);border-radius:inherit;"></div>
            </div>
            <p class="tiny-hint" style="margin:6px 0 0;">
              ใช้งานโมเดลฟรีจากเซิร์ฟเวอร์โดยไม่ต้องกรอก API Key ส่วนตัว (หรือเลือกผู้ให้บริการ BYOK ด้านบนเพื่อไม่จำกัดโควตา)
            </p>
          </div>`
        }

        <button type="button" class="btn-accent-pill full48" data-save-ai-config="1" ${state.ui.aiTesting ? "disabled" : ""}>
          ${state.ui.aiTesting ? "กำลังทดสอบการเชื่อมต่อ..." : "เชื่อมต่อและทดสอบ AI"}
        </button>
        ${
          !isBuiltIn && !isCustom
            ? `<p class="tiny-hint" style="margin:0;">การทดสอบสำหรับ BYOK จะเรียกโมเดล 1 ครั้งสั้น ๆ เพื่อตรวจสอบ Key (อาจมีค่าใช้จ่ายเล็กน้อยจากผู้ให้บริการ)</p>`
            : ""
        }

        ${
          cfg.lastTestedAt
            ? `
          <div class="settings-card" style="padding:10px 12px;border-color:${cfg.connected ? "#bbf7d0" : "#fecaca"};background:${cfg.connected ? "#f0fdf4" : "#fef2f2"};">
            <strong style="font-size:12.5px;color:${cfg.connected ? "#166534" : "#991b1b"};display:block;">
              ${cfg.connected ? "✓ เชื่อมต่อ AI พร้อมใช้งาน" : `⚠️ ${escHtml(cfg.lastTestError || "ทดสอบการเชื่อมต่อไม่สำเร็จ")}`}
            </strong>
          </div>`
            : ""
        }
  `;
}

export function renderAiScreen(state) {
  return `
    <div class="screen-scroll with-nav-pad">
      <div class="app-pad" style="display:flex;flex-direction:column;gap:14px;padding-top:20px;">
        ${renderAiPanelBody(state)}
      </div>

      ${renderBottomNav("ai")}
    </div>
  `;
}
