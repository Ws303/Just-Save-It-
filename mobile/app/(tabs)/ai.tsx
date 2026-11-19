import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import { apiFetch, testAiConnection } from "../../src/api";
import { FIGMA_INK, getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import {
  getAuthGeneration,
  loadAiConfig,
  loadFigmaAccentTheme,
  saveAiConfig,
  subscribeFigmaAccentTheme,
  type MobileAiConfig,
} from "../../src/storage";

interface VendorPreset {
  id: string;
  label: string;
  description: string;
  provider: "built-in" | "byok" | "custom";
  defaultBaseUrl: string;
  models: string[];
}

const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: "built-in",
    label: "Built-in Free (Server)",
    description: "Tier 1 · Built-in Free Key จากเซิร์ฟเวอร์ (Gemini Flash)",
    provider: "built-in",
    defaultBaseUrl: "",
    models: ["gemini-3.1-flash-lite"],
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "BYOK · OpenAI API (X-AI-Provider: byok)",
    provider: "byok",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4o-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "BYOK · Anthropic Claude (X-AI-Provider: byok)",
    provider: "byok",
    defaultBaseUrl: "",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    description: "BYOK · Google Gemini (X-AI-Provider: byok)",
    provider: "byok",
    defaultBaseUrl: "",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    description: "Tier 3 · OpenAI-compatible Endpoint / Ollama / vLLM",
    provider: "custom",
    defaultBaseUrl: "",
    models: ["llama3.2", "custom-model"],
  },
];

export default function AiSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

  const [provider, setProvider] = useState<"built-in" | "byok" | "custom">("built-in");
  const [vendor, setVendor] = useState("built-in");
  const [model, setModel] = useState("gemini-3.1-flash-lite");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyless, setKeyless] = useState(false);

  const [quotaTotal, setQuotaTotal] = useState(50);
  const [quotaRemaining, setQuotaRemaining] = useState(50);

  const [pickerOpen, setPickerOpen] = useState<"provider" | "model" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const actionSeqRef = useRef(0);

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  const loadConfig = useCallback(async () => {
    const startGen = getAuthGeneration();
    setLoading(true);
    try {
      const [cfg, meRes] = await Promise.all([
        loadAiConfig(),
        apiFetch<Record<string, unknown>>("/api/auth/me").catch(() => null),
      ]);
      if (getAuthGeneration() !== startGen) return;
      setProvider(cfg.provider);
      setVendor(cfg.vendor || "built-in");
      setModel(cfg.model || "gemini-3.1-flash-lite");
      setBaseUrl(cfg.base_url || "");
      setApiKey(cfg.api_key || "");
      setKeyless(Boolean(cfg.keyless));

      const quotaObj = (
        meRes?.data?.ai_quota && typeof meRes.data.ai_quota === "object" ? meRes.data.ai_quota : null
      ) as { limit?: unknown; remaining?: unknown } | null;
      const rawLimit = Number(
        quotaObj?.limit ?? meRes?.data?.ai_quota_limit ?? meRes?.data?.free_quota_limit ?? 50,
      );
      const rawRem = Number(
        quotaObj?.remaining ??
          meRes?.data?.ai_quota_remaining ??
          meRes?.data?.free_quota_remaining ??
          rawLimit,
      );
      if (Number.isFinite(rawLimit) && rawLimit > 0) setQuotaTotal(rawLimit);
      if (Number.isFinite(rawRem) && rawRem >= 0) setQuotaRemaining(rawRem);
    } finally {
      if (getAuthGeneration() === startGen) {
        setLoading(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadConfig();
    }, [loadConfig]),
  );

  const activePreset =
    VENDOR_PRESETS.find((p) => p.id === vendor) ||
    VENDOR_PRESETS.find((p) => p.provider === provider) ||
    VENDOR_PRESETS[0];

  function selectPreset(preset: VendorPreset) {
    setProvider(preset.provider);
    setVendor(preset.id);
    setModel(preset.models[0] || "");
    setBaseUrl(preset.defaultBaseUrl);
    if (preset.provider === "built-in") {
      setApiKey("");
      setKeyless(false);
    } else if (preset.provider === "byok") {
      setKeyless(false);
    }
    setTestResult(null);
    setPickerOpen(null);
  }

  async function handleSaveAndTest() {
    if (provider === "byok" && !apiKey.trim()) {
      Alert.alert("กรุณาใส่ API Key", "สำหรับการเชื่อมต่อแบบ BYOK ต้องระบุ API Key");
      return;
    }
    if (provider === "custom" && !baseUrl.trim()) {
      Alert.alert("กรุณาใส่ Endpoint URL", "กรุณาระบุ URL ของ Custom Endpoint");
      return;
    }
    if (provider === "custom" && !keyless && !apiKey.trim()) {
      Alert.alert("กรุณาใส่ API Key หรือเลือก Keyless", "ระบุ Key หรือติ๊ก Keyless หาก Endpoint ไม่ต้องใช้คีย์");
      return;
    }

    setTestResult(null);
    await runGuardedBusyAction(actionSeqRef, setSaving, async (isStale) => {
      const nextCfg: MobileAiConfig = {
        provider,
        vendor,
        model: model.trim() || activePreset.models[0] || "gemini-3.1-flash-lite",
        base_url: baseUrl.trim(),
        api_key: provider === "built-in" || (provider === "custom" && keyless) ? "" : apiKey.trim(),
        keyless: provider === "custom" ? keyless : false,
      };
      await saveAiConfig(nextCfg);
      if (isStale()) return;
      const testRes = await testAiConnection(nextCfg);
      if (isStale()) return;
      if (testRes.ok) {
        setTestResult({ ok: true, message: "เชื่อมต่อ AI พร้อมใช้งาน" });
      } else {
        setTestResult({
          ok: false,
          message: testRes.error || "บันทึกการตั้งค่าแล้ว แต่ทดสอบการเชื่อมต่อไม่สำเร็จ",
        });
      }
    });
  }

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  const isCustom = provider === "custom";
  const isBuiltIn = provider === "built-in";
  const quotaPct = Math.min(100, Math.max(0, Math.round((quotaRemaining / Math.max(1, quotaTotal)) * 100)));

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: Math.max(12, insets.top) }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 112 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View style={[styles.aiIconTile, { backgroundColor: theme.soft }]}>
            <MaterialCommunityIcons name="robot-outline" size={23} color={theme.accentText} />
          </View>
          <Text style={styles.pageHeading}>เชื่อมต่อ AI</Text>
        </View>
        <Text style={styles.pageSub}>
          เชื่อมต่อ Sherlink กับ Endpoint ของคุณ ({activePreset.description})
        </Text>

        {/* Provider Dropdown */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>ผู้ให้บริการ AI</Text>
          <Pressable style={styles.selectTrigger} onPress={() => setPickerOpen("provider")}>
            <Text style={styles.selectTriggerText}>{activePreset.label}</Text>
            <Ionicons name="chevron-down" size={18} color={FIGMA_INK.inkPrimary} />
          </Pressable>
        </View>

        {/* Model Dropdown */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>โมเดล</Text>
          <Pressable style={styles.selectTrigger} onPress={() => setPickerOpen("model")}>
            <Text
              style={[
                styles.selectTriggerText,
                !model && { color: FIGMA_INK.inkSecondary },
              ]}
            >
              {model || "เลือกโมเดล"}
            </Text>
            <Ionicons name="chevron-down" size={18} color={FIGMA_INK.inkPrimary} />
          </Pressable>
          {isCustom ? (
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={model}
              onChangeText={setModel}
              placeholder="ระบุชื่อโมเดล เช่น llama3.2"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="none"
            />
          ) : null}
        </View>

        {isCustom ? (
          <>
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Endpoint</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://api.example.com/v1"
                placeholderTextColor="#9CA3AF"
                autoCapitalize="none"
                keyboardType="url"
              />
            </View>

            <Pressable style={styles.keylessBox} onPress={() => setKeyless((v) => !v)}>
              <View
                style={[
                  styles.keylessCheckbox,
                  keyless && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
              >
                {keyless ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.keylessTitle}>Keyless</Text>
                <Text style={styles.tinyHint}>Endpoint นี้ไม่ต้องใช้ API Key</Text>
              </View>
            </Pressable>
          </>
        ) : null}

        {!isBuiltIn ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>API Key</Text>
            <TextInput
              style={[styles.input, isCustom && keyless && styles.inputDisabled]}
              value={isCustom && keyless ? "" : apiKey}
              onChangeText={setApiKey}
              placeholder={
                isCustom && keyless ? "ไม่จำเป็นสำหรับโหมด Keyless" : "กรอก API Key ของคุณ"
              }
              placeholderTextColor="#9CA3AF"
              editable={!(isCustom && keyless)}
              autoCapitalize="none"
              secureTextEntry
            />
          </View>
        ) : (
          <View style={styles.tierCard}>
            <View style={styles.tierHeadRow}>
              <Text style={styles.tierTitle}>Built-in Free Tier</Text>
              <Text style={[styles.tierQuota, { color: theme.accentText }]}>
                เหลือ {quotaRemaining}/{quotaTotal} ครั้ง
              </Text>
            </View>
            <View style={[styles.quotaTrack, { backgroundColor: theme.soft }]}>
              <View
                style={[
                  styles.quotaFill,
                  { width: `${quotaPct}%`, backgroundColor: theme.accent },
                ]}
              />
            </View>
            <Text style={styles.tinyHint}>
              ใช้งานโมเดลฟรีจากเซิร์ฟเวอร์โดยไม่ต้องกรอก API Key ส่วนตัว (หรือเลือกผู้ให้บริการ BYOK ด้านบนเพื่อไม่จำกัดโควตา)
            </Text>
          </View>
        )}

        <Pressable
          style={[styles.connectBtn, { backgroundColor: theme.accent }, saving && { opacity: 0.7 }]}
          disabled={saving}
          onPress={() => void handleSaveAndTest()}
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.connectBtnText}>เชื่อมต่อและทดสอบ AI</Text>
          )}
        </Pressable>

        {!isBuiltIn && !isCustom ? (
          <Text style={styles.tinyHint}>
            การทดสอบสำหรับ BYOK จะเรียกโมเดล 1 ครั้งสั้น ๆ เพื่อตรวจสอบ Key (อาจมีค่าใช้จ่ายเล็กน้อยจากผู้ให้บริการ)
          </Text>
        ) : null}

        {testResult ? (
          <View
            style={[
              styles.resultCard,
              testResult.ok
                ? { backgroundColor: "#F0FDF4", borderColor: "#BBF7D0" }
                : { backgroundColor: "#FEF2F2", borderColor: "#FECACA" },
            ]}
          >
            <Ionicons
              name={testResult.ok ? "checkmark-circle" : "warning-outline"}
              size={18}
              color={testResult.ok ? "#166534" : "#991B1B"}
            />
            <Text
              style={[
                styles.resultText,
                { color: testResult.ok ? "#166534" : "#991B1B" },
              ]}
            >
              {testResult.message}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Dropdown Picker Modal */}
      <Modal
        visible={pickerOpen !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setPickerOpen(null)}
      >
        <Pressable style={styles.pickerBackdrop} onPress={() => setPickerOpen(null)}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>
              {pickerOpen === "provider" ? "เลือกผู้ให้บริการ AI" : "เลือกโมเดล"}
            </Text>
            {pickerOpen === "provider"
              ? VENDOR_PRESETS.map((p) => {
                  const active = activePreset.id === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      style={[
                        styles.pickerOption,
                        active && { backgroundColor: theme.soft },
                      ]}
                      onPress={() => selectPreset(p)}
                    >
                      <Text
                        style={[
                          styles.pickerOptionTitle,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {p.label}
                      </Text>
                      <Text style={styles.pickerOptionSub}>{p.provider}</Text>
                    </Pressable>
                  );
                })
              : activePreset.models.map((m) => {
                  const active = model === m;
                  return (
                    <Pressable
                      key={m}
                      style={[
                        styles.pickerOption,
                        active && { backgroundColor: theme.soft },
                      ]}
                      onPress={() => {
                        setModel(m);
                        setPickerOpen(null);
                      }}
                    >
                      <Text
                        style={[
                          styles.pickerOptionTitle,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {m}
                      </Text>
                    </Pressable>
                  );
                })}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: FIGMA_INK.bgApp,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: FIGMA_INK.bgApp,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  aiIconTile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  pageHeading: {
    fontSize: 24,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  pageSub: {
    fontSize: 13.5,
    color: FIGMA_INK.inkSecondary,
    lineHeight: 20,
    marginTop: -4,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  selectTrigger: {
    height: 48,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectTriggerText: {
    fontSize: 14.5,
    fontWeight: "600",
    color: FIGMA_INK.inkStrong,
  },
  input: {
    height: 48,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 14.5,
    color: FIGMA_INK.inkStrong,
  },
  inputDisabled: {
    opacity: 0.55,
  },
  keylessBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 14,
    padding: 13,
  },
  keylessCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#9CA3AF",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  keylessTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  tierCard: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderLight,
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  tierHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tierTitle: {
    fontSize: 13.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  tierQuota: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  quotaTrack: {
    height: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
  quotaFill: {
    height: "100%",
    borderRadius: 999,
  },
  tinyHint: {
    fontSize: 12,
    color: FIGMA_INK.inkSecondary,
    lineHeight: 18,
  },
  connectBtn: {
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  connectBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  resultCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  resultText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.45)",
    justifyContent: "center",
    padding: 20,
  },
  pickerCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 16,
    gap: 6,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
    marginBottom: 6,
  },
  pickerOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  pickerOptionTitle: {
    fontSize: 14.5,
    fontWeight: "600",
    color: FIGMA_INK.inkStrong,
  },
  pickerOptionSub: {
    fontSize: 12,
    color: FIGMA_INK.inkSecondary,
  },
});
