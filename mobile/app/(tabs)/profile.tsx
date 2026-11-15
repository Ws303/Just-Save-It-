import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  createMcpToken,
  deleteMyAccount,
  exportWorkspaceJson,
  fetchWorkspace,
  flushOfflineQueue,
  getOfflineQueueCount,
  listMcpTokens,
  logoutAccount,
  registerPushDevice,
  revokeMcpToken,
  type McpTokenRecord,
} from "../../src/api";
import { registerMobilePushToken, syncLocalRemindersWithOs } from "../../src/notifications";
import {
  buildBoundedExportPayloadJson,
  getDebugBannerEnabled,
  getMemoryCachedWorkspace,
  getThemePageBg,
  loadCachedWorkspace,
  loadSession,
  loadThemeMode,
  saveThemeMode,
  setDebugBannerEnabled,
  subscribeDebugBanner,
  type AppThemeMode,
} from "../../src/storage";

export default function ProfileScreen() {
  const router = useRouter();
  const initialCache = getMemoryCachedWorkspace();
  const [name, setName] = useState("ผู้ใช้งาน");
  const [email, setEmail] = useState("");
  const [itemCount, setItemCount] = useState<number>(() => initialCache?.items?.length || 0);
  const [folderCount, setFolderCount] = useState<number>(() => initialCache?.folders?.length || 0);
  const [queueCount, setQueueCount] = useState(0);
  const [themeMode, setThemeMode] = useState<AppThemeMode>("cream");
  const [debugBannerOn, setDebugBannerOn] = useState<boolean>(getDebugBannerEnabled);
  const [pushStatus, setPushStatus] = useState("ยังไม่ได้ลงทะเบียนอุปกรณ์นี้");

  const [tokens, setTokens] = useState<McpTokenRecord[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [latestRawToken, setLatestRawToken] = useState("");

  const [pdpaOpen, setPdpaOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const loadProfile = useCallback(async () => {
    setDebugBannerOn(getDebugBannerEnabled());
    const sess = await loadSession();
    if (!sess?.access_token) return;
    if (sess.user?.email) setEmail(sess.user.email);
    if (sess.user?.display_name) setName(sess.user.display_name);

    const cached = await loadCachedWorkspace();
    if (cached.items.length > 0 || cached.folders.length > 0) {
      setItemCount((prev) => (prev > 0 ? prev : cached.items.length));
      setFolderCount((prev) => (prev > 0 ? prev : cached.folders.length));
    }

    const [ws, qCount, savedTheme, tokRes] = await Promise.all([
      fetchWorkspace(),
      getOfflineQueueCount(),
      loadThemeMode(),
      listMcpTokens(),
    ]);
    setThemeMode(savedTheme);
    setQueueCount(qCount);
    setItemCount(ws.items.length);
    setFolderCount(ws.folders.length);
    setName(
      (typeof ws.me?.display_name === "string" && ws.me.display_name) ||
        (typeof ws.me?.email === "string" && ws.me.email.split("@")[0]) ||
        sess.user?.display_name ||
        "ผู้ใช้งาน Sharely",
    );
    setEmail(typeof ws.me?.email === "string" ? ws.me.email : sess.user?.email || "");
    setTokens(Array.isArray(tokRes.data?.tokens) ? tokRes.data.tokens : []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      const unsub = subscribeDebugBanner((next) => setDebugBannerOn(next));
      void loadProfile();
      return () => unsub();
    }, [loadProfile]),
  );

  async function handleThemeChange(mode: AppThemeMode) {
    setThemeMode(mode);
    await saveThemeMode(mode);
  }

  async function handleEnablePush() {
    setBusyAction("push");
    const reg = await registerMobilePushToken();
    if (!reg.granted) {
      setBusyAction("");
      setPushStatus("ไม่ได้รับสิทธิ์แจ้งเตือนจากระบบ");
      Alert.alert("แจ้งเตือนถูกปิดไว้", "กรุณาอนุญาตการแจ้งเตือนในการตั้งค่าโทรศัพท์");
      return;
    }
    const apiRes = await registerPushDevice({
      platform: reg.platform,
      delivery_mode: reg.delivery_mode,
      push_token: reg.push_token,
    });
    const ws = await fetchWorkspace();
    const synced = await syncLocalRemindersWithOs(ws.reminders);
    setBusyAction("");
    if (apiRes.ok) {
      setPushStatus(
        reg.delivery_mode === "remote"
          ? `เชื่อมต่อ Remote Push (${reg.platform}) แล้ว`
          : `เชื่อมต่อ Local Sync (iOS/Fallback • ซิงก์ ${synced} รายการ)`,
      );
    } else {
      setPushStatus(`ซิงก์ออฟไลน์แล้ว (${synced} รายการ)`);
    }
  }

  async function handleFlushQueue() {
    setBusyAction("queue");
    const res = await flushOfflineQueue();
    setQueueCount(res.remaining);
    setBusyAction("");
    Alert.alert("ซิงก์คิวออฟไลน์", `อัปโหลดสำเร็จ ${res.flushed} รายการ (เหลือ ${res.remaining})`);
    void loadProfile();
  }

  async function handleCreateToken() {
    setBusyAction("token");
    const res = await createMcpToken(newTokenName || "Expo Mobile Token");
    setBusyAction("");
    if (!res.ok || !res.data) {
      Alert.alert("สร้าง Token ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
      return;
    }
    setNewTokenName("");
    if (res.data.token) {
      setLatestRawToken(res.data.token);
    }
    void loadProfile();
  }

  async function handleRevokeToken(id: string) {
    const res = await revokeMcpToken(id);
    if (res.ok) {
      setTokens((prev) => prev.filter((t) => t.id !== id));
    }
  }

  async function handleExportJson() {
    setBusyAction("export");
    const res = await exportWorkspaceJson();
    setBusyAction("");
    if (!res.ok || !res.data) {
      Alert.alert("ส่งออกข้อมูลไม่สำเร็จ", res.error || "กรุณาลองใหม่");
      return;
    }
    const bounded = buildBoundedExportPayloadJson(res.data as Record<string, unknown>);
    if (bounded.truncated) {
      Alert.alert(
        "ขนาดข้อมูลส่งออกเกินขีดจำกัดแชร์บนมือถือ",
        `ตัดรายการเหลือ ${bounded.exportedItems} จาก ${bounded.totalItems} รายการ เพื่อหลีกเลี่ยงขีดจำกัด Android Binder (ดาวน์โหลดฉบับเต็มได้ที่ WebApp)`,
        [
          { text: "ยกเลิก", style: "cancel" },
          {
            text: "แชร์ฉบับย่อ",
            onPress: () => {
              void Share.share({
                title: "just-save-it-export.json",
                message: bounded.jsonString,
              });
            },
          },
        ],
      );
      return;
    }
    await Share.share({
      title: "just-save-it-export.json",
      message: bounded.jsonString,
    });
  }

  async function handleDeleteAccount() {
    if (deletePhrase.trim().toUpperCase() !== "DELETE") {
      Alert.alert("กรุณาพิมพ์คำว่า DELETE เพื่อยืนยัน");
      return;
    }
    setBusyAction("delete");
    const res = await deleteMyAccount();
    setBusyAction("");
    if (!res.ok) {
      Alert.alert("ลบบัญชีไม่สำเร็จ", res.error || "กรุณาลองใหม่");
      return;
    }
    setDeleteOpen(false);
    router.replace("/login");
  }

  async function handleLogout() {
    await logoutAccount();
    router.replace("/login");
  }

  const isDark = themeMode === "dark";
  const pageBg = getThemePageBg(themeMode);
  const cardBg = isDark ? "#292524" : "#FDFBF7";
  const textPrimary = isDark ? "#FAFAF9" : "#1C1917";

  return (
    <ScrollView style={[styles.root, { backgroundColor: pageBg }]} contentContainerStyle={styles.content}>
      <View style={[styles.profileCard, { backgroundColor: cardBg }]}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{name.slice(0, 1).toUpperCase()}</Text>
        </View>
        <Text style={[styles.nameText, { color: textPrimary }]}>{name}</Text>
        <Text style={styles.emailText}>{email || "Cloud Authenticated"}</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{itemCount}</Text>
            <Text style={styles.statLabel}>ลิงก์</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{folderCount}</Text>
            <Text style={styles.statLabel}>โฟลเดอร์</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{queueCount}</Text>
            <Text style={styles.statLabel}>ค้างซิงก์</Text>
          </View>
        </View>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
        <Text style={[styles.sectionTitle, { color: textPrimary }]}>ธีมการแสดงผล</Text>
        <View style={styles.chipRow}>
          {(
            [
              { id: "cream", label: "ครีม (Figma)" },
              { id: "white", label: "ขาวสว่าง" },
              { id: "dark", label: "โหมดมืด" },
            ] as const
          ).map((t) => (
            <Pressable
              key={t.id}
              style={[styles.chip, themeMode === t.id && styles.chipActive]}
              onPress={() => void handleThemeChange(t.id)}
            >
              <Text style={[styles.chipText, themeMode === t.id && styles.chipTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
        <Text style={[styles.sectionTitle, { color: textPrimary }]}>แจ้งเตือน & ซิงก์ออฟไลน์</Text>
        <Text style={styles.helperText}>{pushStatus}</Text>
        <Pressable style={styles.rowBtn} onPress={() => void handleEnablePush()}>
          {busyAction === "push" ? (
            <ActivityIndicator color="#9B2C2C" />
          ) : (
            <Text style={styles.rowBtnText}>🔔 เปิดใช้ / ซิงก์การแจ้งเตือนอุปกรณ์นี้</Text>
          )}
        </Pressable>
        <Pressable style={styles.rowBtn} onPress={() => void handleFlushQueue()}>
          <Text style={styles.rowBtnText}>🔄 ซิงก์ Offline Queue ตอนนี้ ({queueCount})</Text>
        </Pressable>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
        <Text style={[styles.sectionTitle, { color: textPrimary }]}>MCP API Tokens</Text>
        <View style={styles.tokenInputRow}>
          <TextInput
            style={styles.tokenInput}
            placeholder="ชื่อ Token (เช่น Claude / Cursor)"
            placeholderTextColor="#A8A29E"
            value={newTokenName}
            onChangeText={setNewTokenName}
          />
          <Pressable style={styles.smallPrimaryBtn} onPress={() => void handleCreateToken()}>
            <Text style={styles.smallPrimaryBtnText}>สร้าง</Text>
          </Pressable>
        </View>
        {latestRawToken ? (
          <View style={styles.tokenSecretBox}>
            <Text style={styles.tokenSecretLabel}>Token ใหม่ (คัดลอกเก็บไว้ตอนนี้):</Text>
            <Text selectable style={styles.tokenSecretValue}>
              {latestRawToken}
            </Text>
          </View>
        ) : null}
        {tokens.map((tok) => (
          <View key={tok.id} style={styles.tokenRow}>
            <View>
              <Text style={[styles.tokenName, { color: textPrimary }]}>{tok.name || "API Token"}</Text>
              <Text style={styles.tokenMeta}>
                {tok.token_prefix || tok.prefix ? `${tok.token_prefix || tok.prefix}•••` : tok.id}
              </Text>
            </View>
            <Pressable style={styles.revokeBtn} onPress={() => void handleRevokeToken(tok.id)}>
              <Text style={styles.revokeBtnText}>เพิกถอน</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
        <Text style={[styles.sectionTitle, { color: textPrimary }]}>PDPA & ข้อมูลส่วนตัว</Text>
        <Pressable style={styles.rowBtn} onPress={() => void handleExportJson()}>
          <Text style={styles.rowBtnText}>📦 ส่งออกข้อมูลทั้งหมดเป็น JSON</Text>
        </Pressable>
        <Pressable style={styles.rowBtn} onPress={() => setPdpaOpen(true)}>
          <Text style={styles.rowBtnText}>🛡️ นโยบายความเป็นส่วนตัว (PDPA)</Text>
        </Pressable>
        <Pressable
          style={styles.rowBtn}
          onPress={() => setDebugBannerEnabled(!debugBannerOn)}
        >
          <Text style={styles.rowBtnText}>
            🔍 {debugBannerOn ? "ปิด Deep Link / Auth Debug Banner" : "เปิด Deep Link / Auth Debug Banner"}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.rowBtn, styles.dangerRowBtn]}
          onPress={() => {
            setDeletePhrase("");
            setDeleteOpen(true);
          }}
        >
          <Text style={styles.dangerRowText}>⚠️ ลบบัญชีผู้ใช้อย่างถาวร</Text>
        </Pressable>
      </View>

      <Pressable style={styles.logoutBtn} onPress={() => void handleLogout()}>
        <Text style={styles.logoutBtnText}>ออกจากระบบ</Text>
      </Pressable>

      <Modal visible={pdpaOpen} animationType="fade" transparent>
        <View style={styles.backdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🛡️ นโยบายความเป็นส่วนตัว (PDPA)</Text>
            <Text style={styles.modalBody}>
              Sharely จัดเก็บเฉพาะลิงก์ แท็ก โน้ต และข้อมูลโฟลเดอร์ที่คุณบันทึกไว้ภายใต้ Row-Level Security (RLS) แยกตามบัญชีผู้ใช้ 100% คุณสามารถส่งออกข้อมูล JSON หรือสั่งลบบัญชีอย่างถาวรได้ทุกเมื่อ
            </Text>
            <Pressable style={styles.confirmBtn} onPress={() => setPdpaOpen(false)}>
              <Text style={styles.confirmBtnText}>ปิดหน้าต่าง</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={deleteOpen} animationType="fade" transparent>
        <View style={styles.backdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ยืนยันการลบบัญชีถาวร</Text>
            <Text style={styles.modalBody}>
              ข้อมูลลิงก์ โฟลเดอร์ และการแจ้งเตือนทั้งหมดจะถูกลบอย่างถาวร พิมพ์คำว่า DELETE ด้านล่างเพื่อยืนยัน:
            </Text>
            <TextInput
              style={styles.deleteInput}
              placeholder="พิมพ์ DELETE"
              placeholderTextColor="#A8A29E"
              autoCapitalize="characters"
              value={deletePhrase}
              onChangeText={setDeletePhrase}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelBtn} onPress={() => setDeleteOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable style={styles.deleteConfirmBtn} onPress={() => void handleDeleteAccount()}>
                <Text style={styles.confirmBtnText}>
                  {busyAction === "delete" ? "กำลังลบ..." : "ลบบัญชีถาวร"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 14, paddingBottom: 36 },
  profileCard: {
    borderRadius: 20,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#9B2C2C",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  avatarText: { color: "#FDFBF7", fontSize: 26, fontWeight: "800" },
  nameText: { fontSize: 18, fontWeight: "800" },
  emailText: { fontSize: 13, color: "#78716C", marginTop: 2 },
  statsRow: { flexDirection: "row", gap: 24, marginTop: 16 },
  statBox: { alignItems: "center" },
  statValue: { fontSize: 18, fontWeight: "800", color: "#9B2C2C" },
  statLabel: { fontSize: 12, color: "#78716C" },
  sectionCard: {
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    gap: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: "800" },
  helperText: { fontSize: 12, color: "#78716C" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#F3EFE6", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: "#9B2C2C" },
  chipText: { fontSize: 13, fontWeight: "600", color: "#44403C" },
  chipTextActive: { color: "#FDFBF7" },
  rowBtn: {
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowBtnText: { fontSize: 14, fontWeight: "600", color: "#1C1917" },
  dangerRowBtn: { backgroundColor: "#FEF2F2" },
  dangerRowText: { fontSize: 14, fontWeight: "700", color: "#B91C1C" },
  tokenInputRow: { flexDirection: "row", gap: 8 },
  tokenInput: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#1C1917",
  },
  smallPrimaryBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 12,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  smallPrimaryBtnText: { color: "#FDFBF7", fontWeight: "700" },
  tokenSecretBox: {
    backgroundColor: "#FEF2F2",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  tokenSecretLabel: { fontSize: 12, fontWeight: "700", color: "#9B2C2C", marginBottom: 4 },
  tokenSecretValue: { fontSize: 12, color: "#1C1917", fontFamily: "monospace" },
  tokenRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: "#EAE4DB",
  },
  tokenName: { fontSize: 13, fontWeight: "700" },
  tokenMeta: { fontSize: 11, color: "#78716C" },
  revokeBtn: {
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  revokeBtnText: { color: "#9B2C2C", fontSize: 12, fontWeight: "700" },
  logoutBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6CFC4",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  logoutBtnText: { color: "#9B2C2C", fontWeight: "800", fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: "#FDFBF7", borderRadius: 20, padding: 20, gap: 12 },
  modalTitle: { fontSize: 17, fontWeight: "800", color: "#1C1917" },
  modalBody: { fontSize: 14, color: "#44403C", lineHeight: 20 },
  deleteInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1C1917",
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: "#F3EFE6" },
  cancelBtnText: { color: "#44403C", fontWeight: "600" },
  confirmBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  deleteConfirmBtn: {
    backgroundColor: "#B91C1C",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
  },
  confirmBtnText: { color: "#FDFBF7", fontWeight: "700" },
});
