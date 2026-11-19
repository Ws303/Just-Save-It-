import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { loadAiConfig, saveAiConfig, type MobileAiConfig } from "../../src/storage";

const VENDOR_PRESETS = [
  {
    id: "built-in",
    label: "Built-in Free",
    sub: "ฟรีจากเซิร์ฟเวอร์ Sherlink (Gemini Flash)",
    provider: "built-in" as const,
    defaultModel: "gemini-3.1-flash-lite",
    defaultBaseUrl: "",
  },
  {
    id: "openai",
    label: "OpenAI (BYOK)",
    sub: "ใช้ API Key ส่วนตัว (gpt-4o-mini)",
    provider: "byok" as const,
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    label: "Gemini (BYOK)",
    sub: "ใช้ Google AI Studio Key ส่วนตัว",
    provider: "byok" as const,
    defaultModel: "gemini-2.5-flash",
    defaultBaseUrl: "",
  },
  {
    id: "anthropic",
    label: "Claude (BYOK)",
    sub: "ใช้ Anthropic API Key ส่วนตัว",
    provider: "byok" as const,
    defaultModel: "claude-3-5-haiku-20241022",
    defaultBaseUrl: "",
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    sub: "OpenAI-compatible / Ollama / vLLM",
    provider: "custom" as const,
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://localhost:11434/v1",
  },
];

export default function AiSettingsScreen() {
  const [provider, setProvider] = useState<"built-in" | "byok" | "custom">("built-in");
  const [vendor, setVendor] = useState("built-in");
  const [model, setModel] = useState("gemini-3.1-flash-lite");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await loadAiConfig();
      setProvider(cfg.provider);
      setVendor(cfg.vendor || "built-in");
      setModel(cfg.model || "");
      setBaseUrl(cfg.base_url || "");
      setApiKey(cfg.api_key || "");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadConfig();
    }, [loadConfig]),
  );

  function selectPreset(preset: (typeof VENDOR_PRESETS)[number]) {
    setProvider(preset.provider);
    setVendor(preset.id);
    setModel(preset.defaultModel);
    setBaseUrl(preset.defaultBaseUrl);
    if (preset.provider === "built-in") {
      setApiKey("");
    }
  }

  async function handleSave() {
    if (provider === "byok" && !apiKey.trim()) {
      Alert.alert("กรุณาใส่ API Key", "สำหรับการเชื่อมต่อแบบ BYOK ต้องระบุ API Key");
      return;
    }
    if (provider === "custom" && !baseUrl.trim()) {
      Alert.alert("กรุณาใส่ Endpoint URL", "กรุณาระบุ URL ของ Custom Endpoint");
      return;
    }
    setSaving(true);
    try {
      const nextCfg: MobileAiConfig = {
        provider,
        vendor,
        model: model.trim() || "gemini-3.1-flash-lite",
        base_url: baseUrl.trim(),
        api_key: provider === "built-in" ? "" : apiKey.trim(),
      };
      await saveAiConfig(nextCfg);
      Alert.alert("บันทึกสำเร็จ", "อัปเดตการตั้งค่า AI สำหรับสรุปเนื้อหาใน Sherlink แล้ว");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#E24C4B" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.heroCard}>
          <Text style={styles.heroTitle}>ผู้ช่วยสรุปเนื้อหา AI</Text>
          <Text style={styles.heroSub}>
            เลือกใช้โควตาฟรีของ Sherlink หรือใส่ API Key ส่วนตัว (BYOK) โดยคีย์จะเก็บใน SecureStore บนเครื่องเท่านั้น และไม่เขียนทับคำอธิบายต้นฉบับ
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>เลือกผู้ให้บริการ AI</Text>
          <View style={styles.presetList}>
            {VENDOR_PRESETS.map((p) => {
              const active = vendor === p.id;
              return (
                <Pressable
                  key={p.id}
                  style={[styles.presetCard, active && styles.presetCardActive]}
                  onPress={() => selectPreset(p)}
                >
                  <View style={styles.presetHead}>
                    <Text style={[styles.presetLabel, active && styles.presetLabelActive]}>
                      {p.label}
                    </Text>
                    {active ? <Text style={styles.activeBadge}>ใช้งานอยู่</Text> : null}
                  </View>
                  <Text style={styles.presetSub}>{p.sub}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {provider !== "built-in" ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>รายละเอียดการเชื่อมต่อ ({vendor})</Text>
            <Text style={styles.label}>ชื่อโมเดล</Text>
            <TextInput
              style={styles.input}
              value={model}
              onChangeText={setModel}
              placeholder="gpt-4o-mini / gemini-2.5-flash"
              placeholderTextColor="#A8A29E"
              autoCapitalize="none"
            />
            {provider === "custom" ? (
              <>
                <Text style={styles.label}>Endpoint Base URL</Text>
                <TextInput
                  style={styles.input}
                  value={baseUrl}
                  onChangeText={setBaseUrl}
                  placeholder="https://.../v1"
                  placeholderTextColor="#A8A29E"
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </>
            ) : null}
            <Text style={styles.label}>API Key {provider === "custom" ? "(ถ้ามี)" : "*"}</Text>
            <TextInput
              style={styles.input}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="sk-... หรือ AIza..."
              placeholderTextColor="#A8A29E"
              autoCapitalize="none"
              secureTextEntry
            />
          </View>
        ) : null}

        <Pressable
          style={[styles.saveBtn, saving && { opacity: 0.7 }]}
          disabled={saving}
          onPress={() => void handleSave()}
        >
          <Text style={styles.saveBtnText}>
            {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่า AI"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FDFBF7" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#FDFBF7" },
  content: { padding: 16, gap: 14, paddingBottom: 110 },
  heroCard: {
    backgroundColor: "#F1EEFF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#E2DAFF",
    gap: 6,
  },
  heroTitle: { fontSize: 17, fontWeight: "800", color: "#4331A8" },
  heroSub: { fontSize: 13, color: "#4C4473", lineHeight: 19 },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#EFE9DF",
    gap: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: "#1E1B18" },
  presetList: { gap: 8 },
  presetCard: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#EFE9DF",
    backgroundColor: "#FDFBF7",
    gap: 3,
  },
  presetCardActive: {
    borderColor: "#E24C4B",
    backgroundColor: "#FDECEC",
  },
  presetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  presetLabel: { fontSize: 14, fontWeight: "700", color: "#1E1B18" },
  presetLabelActive: { color: "#C52732" },
  activeBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FFFFFF",
    backgroundColor: "#E24C4B",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  presetSub: { fontSize: 12, color: "#6E675F" },
  label: { fontSize: 13, fontWeight: "600", color: "#47413B", marginTop: 4 },
  input: {
    backgroundColor: "#FDFBF7",
    borderWidth: 1,
    borderColor: "#E2DACD",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1E1B18",
  },
  saveBtn: {
    backgroundColor: "#E24C4B",
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
});
