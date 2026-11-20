import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import {
  isPostClearSafeToNavigate,
  runGuardedBusyAction,
  shouldNavigateAfterLogout,
} from "../../src/actionGuards";
import {
  deactivatePushDevice,
  deleteMyAccount,
  fetchWorkspace,
  flushOfflineQueue,
  getOfflineQueueCount,
  logoutAccount,
  registerPushDevice,
  sendPasswordResetEmail,
  submitBetaFeedback,
  syncRemindersFromServer,
  updateProfileDisplayName,
} from "../../src/api";
import {
  FIGMA_INK,
  FIGMA_THEME_OPTIONS,
  getFigmaTheme,
  type FigmaAccentThemeId,
} from "../../src/figmaTheme";
import { cancelAllLocalRemindersSafe, registerMobilePushToken } from "../../src/notifications";
import {
  buildBoundedCsvExport,
  clearRegisteredPushDevice,
  getAuthGeneration,
  getDebugBannerEnabled,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadFigmaAccentTheme,
  loadRegisteredPushDevice,
  loadSession,
  saveFigmaAccentTheme,
  setDebugBannerEnabled,
  subscribeDebugBanner,
  subscribeFigmaAccentTheme,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const initialCache = getMemoryCachedWorkspace();

  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

  const [name, setName] = useState("ผู้ใช้งาน");
  const [email, setEmail] = useState("");
  const [cachedItems, setCachedItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [cachedFolders, setCachedFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [queueCount, setQueueCount] = useState(0);
  const [debugBannerOn, setDebugBannerOn] = useState<boolean>(getDebugBannerEnabled);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushStatus, setPushStatus] = useState("รับการแจ้งเตือนเมื่อถึงเวลาที่ตั้งไว้");

  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [displayModalOpen, setDisplayModalOpen] = useState(false);
  const [securityModalOpen, setSecurityModalOpen] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [supportTopic, setSupportTopic] = useState("");
  const [supportDetail, setSupportDetail] = useState("");
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFolderId, setExportFolderId] = useState<string>("all");
  const [exportUnreadOnly, setExportUnreadOnly] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const actionSeqRef = useRef(0);
  const deleteInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (exportTimerRef.current) {
        clearTimeout(exportTimerRef.current);
        exportTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  const loadProfile = useCallback(async () => {
    const startGen = getAuthGeneration();
    setDebugBannerOn(getDebugBannerEnabled());
    const sess = await loadSession();
    if (getAuthGeneration() !== startGen || !sess?.access_token) return;
    if (sess.user?.email) setEmail(sess.user.email);
    if (sess.user?.display_name) setName(sess.user.display_name);

    const cached = await loadCachedWorkspace();
    if (getAuthGeneration() !== startGen) return;
    if (cached.items.length > 0) {
      setCachedItems((prev) => (prev.length ? prev : cached.items));
    }
    if (cached.folders.length > 0) {
      setCachedFolders((prev) => (prev.length ? prev : cached.folders));
    }

    const [ws, qCount, savedAccent, savedPush] = await Promise.all([
      fetchWorkspace(),
      getOfflineQueueCount(),
      loadFigmaAccentTheme(),
      loadRegisteredPushDevice().catch(() => null),
    ]);
    if (getAuthGeneration() !== startGen) return;
    setThemeId(savedAccent);
    setQueueCount(qCount);
    setCachedItems(ws.items);
    setCachedFolders(ws.folders);
    setPushEnabled(Boolean(savedPush));
    setPushStatus(
      savedPush
        ? savedPush.delivery_mode === "remote"
          ? `เปิดใช้แจ้งเตือน (${savedPush.platform}) แล้ว`
          : "เปิดใช้ซิงก์แจ้งเตือนบนเครื่องนี้แล้ว"
        : "รับการแจ้งเตือนเมื่อถึงเวลาที่ตั้งไว้",
    );
    setName(
      (typeof ws.me?.display_name === "string" && ws.me.display_name) ||
        (typeof ws.me?.email === "string" && ws.me.email.split("@")[0]) ||
        sess.user?.display_name ||
        "ผู้ใช้งาน Sherlink",
    );
    setEmail(typeof ws.me?.email === "string" ? ws.me.email : sess.user?.email || "");
  }, []);

  useFocusEffect(
    useCallback(() => {
      const unsub = subscribeDebugBanner((next) => setDebugBannerOn(next));
      void loadProfile();
      return () => unsub();
    }, [loadProfile]),
  );

  async function handleEnablePush() {
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "push" : ""),
      async (isStale) => {
        const reg = await registerMobilePushToken();
        if (isStale()) return;
        if (!reg.granted) {
          setPushEnabled(false);
          setPushStatus("ไม่ได้รับสิทธิ์แจ้งเตือนจากระบบ");
          Alert.alert("แจ้งเตือนถูกปิดไว้", "กรุณาอนุญาตการแจ้งเตือนในการตั้งค่าโทรศัพท์");
          return;
        }
        setPushEnabled(true);
        const apiRes = await registerPushDevice({
          platform: reg.platform,
          delivery_mode: reg.delivery_mode,
          push_token: reg.push_token,
        });
        if (isStale()) return;
        const ws = await fetchWorkspace();
        if (isStale()) return;
        const syncRes = await syncRemindersFromServer(ws.reminders);
        if (isStale()) return;
        const synced = syncRes.syncedCount;
        if (apiRes.ok) {
          setPushStatus(
            reg.delivery_mode === "remote"
              ? `เปิดใช้แจ้งเตือน (${reg.platform}) แล้ว`
              : `ซิงก์ปฏิทินแจ้งเตือนบนเครื่องแล้ว (${synced} รายการ)`,
          );
        } else {
          setPushStatus(`ซิงก์ออฟไลน์แล้ว (${synced} รายการ)`);
        }
      },
    );
  }

  async function handleDisablePush() {
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "push" : ""),
      async (isStale) => {
        const registered = await loadRegisteredPushDevice().catch(() => null);
        if (registered) {
          await deactivatePushDevice({
            platform: registered.platform,
            push_token: registered.push_token,
          }).catch(() => {});
        }
        if (isStale()) return;
        await Promise.allSettled([
          clearRegisteredPushDevice(),
          cancelAllLocalRemindersSafe(),
        ]);
        if (isStale()) return;
        setPushEnabled(false);
        setPushStatus("ปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว");
      },
    );
  }

  async function handleFlushQueue() {
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "queue" : ""),
      async (isStale) => {
        const res = await flushOfflineQueue();
        if (isStale()) return;
        setQueueCount(res.remaining);
        Alert.alert("ซิงก์คิวออฟไลน์", `อัปโหลดสำเร็จ ${res.flushed} รายการ (เหลือ ${res.remaining})`);
        void loadProfile();
      },
    );
  }

  async function handleSaveNickname() {
    const clean = nicknameDraft.trim();
    if (!clean) {
      Alert.alert("กรุณากรอกชื่อเล่น");
      return;
    }
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "nickname" : ""),
      async (isStale) => {
        const res = await updateProfileDisplayName(clean);
        if (isStale()) return;
        if (!res.ok) {
          Alert.alert("แก้ไขชื่อไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          return;
        }
        setName(clean);
        setNicknameOpen(false);
      },
    );
  }

  const exportFilteredItems = useMemo(() => {
    return cachedItems.filter((it) => {
      if (exportFolderId !== "all" && it.folder_id !== exportFolderId) return false;
      if (exportUnreadOnly) {
        const s = String(it.status || "inbox").toLowerCase();
        if (s === "done" || s === "read" || s === "archived") return false;
      }
      return true;
    });
  }, [cachedItems, exportFolderId, exportUnreadOnly]);

  async function runCsvShare(csv: string) {
    try {
      await Share.share({
        title: "sherlink-links-export.csv",
        message: csv,
      });
    } catch {
      Alert.alert("ส่งออกไม่สำเร็จ", "ไม่สามารถเปิดหน้าต่างแชร์ไฟล์ CSV ได้");
    }
  }

  function handleExportCsv() {
    if (exportFilteredItems.length === 0) {
      Alert.alert("ไม่มีรายการที่จะส่งออก", "ลองเปลี่ยนโฟลเดอร์หรือปิดตัวกรองเฉพาะที่ยังไม่ได้ดู");
      return;
    }
    const { csv, truncated, exportedCount, totalCount } = buildBoundedCsvExport(exportFilteredItems);
    setExportModalOpen(false);
    const presentExport = () => {
      if (!mountedRef.current) return;
      if (truncated) {
        Alert.alert(
          "ตัดทอนข้อมูลบางส่วน",
          `ส่งออกได้ ${exportedCount} จาก ${totalCount} รายการ เพื่อไม่ให้เกินขีดจำกัดขนาดแชร์ของ Android`,
          [
            { text: "ยกเลิก", style: "cancel" },
            {
              text: "ส่งออกต่อ",
              onPress: () => {
                void runCsvShare(csv);
              },
            },
          ],
        );
        return;
      }
      void runCsvShare(csv);
    };

    if (Platform.OS === "ios") {
      if (exportTimerRef.current) clearTimeout(exportTimerRef.current);
      exportTimerRef.current = setTimeout(() => {
        exportTimerRef.current = null;
        presentExport();
      }, 320);
      return;
    }
    presentExport();
  }

  async function handleSendPasswordReset() {
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      Alert.alert("ไม่พบอีเมลบัญชี", "กรุณาตรวจสอบว่าเข้าสู่ระบบด้วยอีเมลแล้ว");
      return;
    }
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "reset" : ""),
      async (isStale) => {
        const res = await sendPasswordResetEmail(cleanEmail);
        if (isStale()) return;
        if (!res.ok) {
          Alert.alert("ส่งลิงก์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          return;
        }
        Alert.alert("ส่งลิงก์แล้ว", `กรุณาตรวจสอบกล่องจดหมายของ ${cleanEmail} เพื่อตั้งหรือเปลี่ยนรหัสผ่าน`);
      },
    );
  }

  async function handleSubmitFeedback() {
    const topic = supportTopic.trim();
    const detail = supportDetail.trim();
    if ([topic, detail].filter(Boolean).join(" ").trim().length < 3) {
      Alert.alert("กรุณากรอกรายละเอียด", "โปรดระบุหัวข้อหรือรายละเอียดอย่างน้อย 3 ตัวอักษร");
      return;
    }
    await runGuardedBusyAction(
      actionSeqRef,
      (busy) => setBusyAction(busy ? "feedback" : ""),
      async (isStale) => {
        const res = await submitBetaFeedback({
          topic,
          detail,
          category: "bug",
          pageContext: "mobile_profile",
          contactEmail: email.trim() || null,
        });
        if (isStale()) return;
        if (!res.ok) {
          Alert.alert("ส่งรายงานไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          return;
        }
        setSupportTopic("");
        setSupportDetail("");
        setHelpModalOpen(false);
        Alert.alert("ส่งรายงานแล้ว", "ขอบคุณสำหรับข้อเสนอแนะ ทีมงานได้รับข้อมูลเรียบร้อยแล้ว");
      },
    );
  }

  async function handleDeleteAccount() {
    if (deleteInFlightRef.current || busyAction === "delete") return;
    if (deletePhrase.trim().toUpperCase() !== "DELETE") {
      Alert.alert("กรุณาพิมพ์คำว่า DELETE เพื่อยืนยัน");
      return;
    }
    const startGen = getAuthGeneration();
    const seq = (actionSeqRef.current += 1);
    deleteInFlightRef.current = true;
    setBusyAction("delete");
    try {
      const res = await deleteMyAccount();
      if (!res.ok) {
        if (getAuthGeneration() !== startGen) return;
        Alert.alert("ลบบัญชีไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      if (!(await isPostClearSafeToNavigate())) return;
      setDeleteOpen(false);
      router.replace("/login");
    } finally {
      deleteInFlightRef.current = false;
      if (actionSeqRef.current === seq) {
        setBusyAction("");
      }
    }
  }

  async function handleLogout() {
    if (!(await shouldNavigateAfterLogout(logoutAccount))) return;
    router.replace("/login");
  }

  return (
    <View style={[styles.root, { paddingTop: Math.max(10, insets.top) }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 112 + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.pageHeading}>โปรไฟล์</Text>

        {/* Horizontal Profile Card */}
        <View style={styles.settingsCard}>
          <Pressable
            style={styles.profileRow}
            onPress={() => {
              setNicknameDraft(name);
              setNicknameOpen(true);
            }}
          >
            <View style={styles.profileLeft}>
              <View style={[styles.avatarLg, { backgroundColor: theme.accent }]}>
                <Text style={styles.avatarLgText}>{name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.profileName} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={styles.profileEmail} numberOfLines={1}>
                  {email || "Cloud Authenticated"}
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
          </Pressable>
        </View>

        {/* Settings Group */}
        <View style={styles.groupBlock}>
          <Text style={styles.groupTitle}>การตั้งค่า</Text>
          <View style={styles.settingsCard}>
            <View style={[styles.settingsRow, styles.rowDivider]}>
              <View style={styles.rowLeft}>
                <Ionicons name="notifications-outline" size={20} color={FIGMA_INK.inkSecondary} />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>การแจ้งเตือน</Text>
                  <Text style={styles.rowHint}>{pushStatus}</Text>
                </View>
              </View>
              {busyAction === "push" ? (
                <ActivityIndicator color={theme.accent} />
              ) : (
                <Switch
                  value={pushEnabled}
                  onValueChange={(nextValue) =>
                    void (nextValue ? handleEnablePush() : handleDisablePush())
                  }
                  trackColor={{ false: "#D1D5DB", true: theme.accent }}
                  thumbColor="#FFFFFF"
                />
              )}
            </View>

            <Pressable
              style={[styles.settingsRow, styles.rowDivider]}
              onPress={() => router.push("/(tabs)/ai")}
            >
              <View style={styles.rowLeft}>
                <MaterialCommunityIcons
                  name="robot-outline"
                  size={20}
                  color={FIGMA_INK.inkSecondary}
                />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>การเชื่อมต่อ AI</Text>
                  <Text style={styles.rowHint}>จัดการผู้ให้บริการ โมเดล และ API Key</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </Pressable>

            <Pressable
              style={[styles.settingsRow, styles.rowDivider]}
              onPress={() => setDisplayModalOpen(true)}
            >
              <View style={styles.rowLeft}>
                <Ionicons name="color-palette-outline" size={20} color={FIGMA_INK.inkSecondary} />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>การแสดงผล</Text>
                  <Text style={styles.rowHint}>เลือกธีมสี ({theme.name})</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </Pressable>

            <Pressable style={styles.settingsRow} onPress={() => setSecurityModalOpen(true)}>
              <View style={styles.rowLeft}>
                <Ionicons name="shield-checkmark-outline" size={20} color={FIGMA_INK.inkSecondary} />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>บัญชีและความปลอดภัย</Text>
                  <Text style={styles.rowHint}>ซิงก์คิวออฟไลน์และการจัดการบัญชี</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </Pressable>
          </View>
        </View>

        {/* Other Group */}
        <View style={styles.groupBlock}>
          <Text style={styles.groupTitle}>อื่น ๆ</Text>
          <View style={styles.settingsCard}>
            <Pressable
              style={[styles.settingsRow, styles.rowDivider]}
              onPress={() => setHelpModalOpen(true)}
            >
              <View style={styles.rowLeft}>
                <Ionicons name="help-circle-outline" size={20} color={FIGMA_INK.inkSecondary} />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>ศูนย์ช่วยเหลือและแจ้งปัญหา</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </Pressable>

            <Pressable style={styles.settingsRow} onPress={() => setExportModalOpen(true)}>
              <View style={styles.rowLeft}>
                <Ionicons name="download-outline" size={20} color={FIGMA_INK.inkSecondary} />
                <View style={styles.rowTexts}>
                  <Text style={styles.rowTitle}>ส่งออกข้อมูลที่บันทึกไว้</Text>
                  <Text style={styles.rowHint}>รายการลิงก์ทั้งหมดเป็นไฟล์ CSV ({cachedItems.length} รายการ)</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </Pressable>
          </View>
        </View>

        {/* Logout Pill */}
        <Pressable style={styles.logoutBtn} onPress={() => setLogoutConfirmOpen(true)}>
          <Ionicons name="log-out-outline" size={18} color="#B91C1C" />
          <Text style={styles.logoutBtnText}>ออกจากระบบ</Text>
        </Pressable>
      </ScrollView>

      {/* Edit Nickname Sheet */}
      <Modal
        visible={nicknameOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setNicknameOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>แก้ไขชื่อเล่น</Text>
            <TextInput
              style={styles.input}
              placeholder="กรอกชื่อที่ต้องการแสดง"
              placeholderTextColor="#9CA3AF"
              value={nicknameDraft}
              onChangeText={setNicknameDraft}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelBtn} onPress={() => setNicknameOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryModalBtn, { backgroundColor: theme.accent }]}
                disabled={busyAction === "nickname"}
                onPress={() => void handleSaveNickname()}
              >
                <Text style={styles.primaryModalBtnText}>
                  {busyAction === "nickname" ? "กำลังบันทึก..." : "บันทึก"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Display / Theme Modal (128:360) */}
      <Modal
        visible={displayModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setDisplayModalOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheetCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.sheetDragBar} />
            <View style={styles.sheetHead}>
              <Text style={styles.modalTitle}>การแสดงผล</Text>
              <Pressable hitSlop={8} onPress={() => setDisplayModalOpen(false)}>
                <Ionicons name="close" size={20} color="#666666" />
              </Pressable>
            </View>
            <Text style={styles.subLabel}>ธีมสี</Text>
            <View style={{ gap: 8 }}>
              {FIGMA_THEME_OPTIONS.map((opt) => {
                const active = themeId === opt.id;
                return (
                  <Pressable
                    key={opt.id}
                    style={[
                      styles.themeOptionCard,
                      active && { borderColor: opt.accent, backgroundColor: opt.soft },
                    ]}
                    onPress={() => {
                      setThemeId(opt.id);
                      void saveFigmaAccentTheme(opt.id);
                    }}
                  >
                    <View style={[styles.themeSwatchBadge, { backgroundColor: opt.soft }]}>
                      <View style={[styles.themeSwatchDot, { backgroundColor: opt.swatch }]} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.themeOptionName}>{opt.name}</Text>
                      <Text style={styles.rowHint}>{opt.subtitle}</Text>
                    </View>
                    {active ? <Ionicons name="checkmark-circle" size={20} color={opt.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>
            <View style={[styles.themePreviewBox, { backgroundColor: theme.previewBg }]}>
              <Text style={styles.themePreviewHeading}>ตัวอย่างการแสดงผล</Text>
              <Text style={styles.rowHint}>{theme.name}</Text>
              <Text style={[styles.themePreviewSample, { color: theme.swatch }]}>
                กลับมาดูลิงก์ที่บันทึกไว้
              </Text>
            </View>
            <Pressable
              style={[styles.fullDoneBtn, { backgroundColor: theme.accent }]}
              onPress={() => setDisplayModalOpen(false)}
            >
              <Text style={styles.primaryModalBtnText}>เสร็จแล้ว</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Account & Security Modal (128:407) */}
      <Modal
        visible={securityModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setSecurityModalOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheetCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.sheetDragBar} />
            <View style={styles.sheetHead}>
              <Text style={styles.modalTitle}>บัญชีและความปลอดภัย</Text>
              <Pressable hitSlop={8} onPress={() => setSecurityModalOpen(false)}>
                <Ionicons name="close" size={20} color="#666666" />
              </Pressable>
            </View>

            <Pressable
              style={styles.actionTile}
              disabled={busyAction === "reset"}
              onPress={() => void handleSendPasswordReset()}
            >
              <Ionicons name="key-outline" size={18} color={FIGMA_INK.inkPrimary} />
              <Text style={styles.actionTileText}>
                {busyAction === "reset" ? "กำลังส่งลิงก์..." : "ส่งลิงก์ตั้งหรือเปลี่ยนรหัสผ่าน"}
              </Text>
            </Pressable>

            <Pressable
              style={styles.actionTile}
              disabled={busyAction === "queue"}
              onPress={() => void handleFlushQueue()}
            >
              <Ionicons name="sync-outline" size={18} color={FIGMA_INK.inkPrimary} />
              <Text style={styles.actionTileText}>
                {busyAction === "queue" ? "กำลังซิงก์..." : `ซิงก์ Offline Queue ตอนนี้ (${queueCount})`}
              </Text>
            </Pressable>

            <Pressable
              style={styles.actionTile}
              onPress={() => setDebugBannerEnabled(!debugBannerOn)}
            >
              <Ionicons name="bug-outline" size={18} color={FIGMA_INK.inkPrimary} />
              <Text style={styles.actionTileText}>
                {debugBannerOn ? "ปิด Deep Link / Auth Debug Banner" : "เปิด Deep Link / Auth Debug Banner"}
              </Text>
            </Pressable>

            <Text style={styles.monoMeta}>
              user={email || "anonymous"} · items={cachedItems.length}
            </Text>

            <Pressable
              style={[styles.actionTile, styles.dangerTile]}
              onPress={() => {
                setSecurityModalOpen(false);
                setDeletePhrase("");
                setDeleteOpen(true);
              }}
            >
              <Ionicons name="trash-outline" size={18} color="#B91C1C" />
              <Text style={[styles.actionTileText, { color: "#B91C1C" }]}>
                ลบบัญชีผู้ใช้อย่างถาวร
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Help Center & Feedback Modal (128:429) */}
      <Modal
        visible={helpModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setHelpModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.modalCard, { maxHeight: "86%" }]}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.sheetHead}>
                <Text style={styles.modalTitle}>ศูนย์ช่วยเหลือและแจ้งปัญหา</Text>
                <Pressable hitSlop={8} onPress={() => setHelpModalOpen(false)}>
                  <Ionicons name="close" size={20} color="#666666" />
                </Pressable>
              </View>
              <Text style={[styles.modalBody, { marginTop: 8 }]}>
                1. แชร์ลิงก์จาก Instagram, TikTok, YouTube หรือเบราว์เซอร์เข้ามาที่ Sherlink ผ่านเมนู Share ของ Android ได้ทันที
              </Text>
              <Text style={[styles.modalBody, { marginTop: 6 }]}>
                2. หากลิงก์แสดงผลไม่ครบ กดเข้าไปหน้ารายละเอียดแล้วดึงรีเฟรช หรือตรวจสอบว่าเป็นโพสต์สาธารณะ
              </Text>

              <Text style={[styles.subLabel, { marginTop: 14, marginBottom: 6 }]}>แจ้งปัญหา / ข้อเสนอแนะ</Text>
              <TextInput
                style={styles.input}
                placeholder="หัวข้อปัญหาสั้น ๆ"
                placeholderTextColor="#9CA3AF"
                value={supportTopic}
                onChangeText={setSupportTopic}
              />
              <TextInput
                style={[styles.input, styles.feedbackArea, { marginTop: 8 }]}
                placeholder="เล่าว่าเกิดอะไรขึ้น และเกิดในหน้าไหน..."
                placeholderTextColor="#9CA3AF"
                multiline
                value={supportDetail}
                onChangeText={setSupportDetail}
              />
              <View style={[styles.modalActions, { marginTop: 12 }]}>
                <Pressable style={styles.cancelBtn} onPress={() => setHelpModalOpen(false)}>
                  <Text style={styles.cancelBtnText}>ปิด</Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryModalBtn, { backgroundColor: theme.accent }, busyAction === "feedback" && { opacity: 0.7 }]}
                  disabled={busyAction === "feedback"}
                  onPress={() => void handleSubmitFeedback()}
                >
                  <Text style={styles.primaryModalBtnText}>
                    {busyAction === "feedback" ? "กำลังส่ง..." : "ส่งรายงาน"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Filtered CSV Export Sheet (128:465) */}
      <Modal
        visible={exportModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setExportModalOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheetCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.sheetDragBar} />
            <View style={styles.sheetHead}>
              <Text style={styles.modalTitle}>ส่งออกข้อมูลที่บันทึกไว้</Text>
              <Pressable hitSlop={8} onPress={() => setExportModalOpen(false)}>
                <Ionicons name="close" size={20} color="#666666" />
              </Pressable>
            </View>
            <Text style={styles.subLabel}>เลือกโฟลเดอร์</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.exportChipRow}>
                <Pressable
                  style={[
                    styles.exportChip,
                    exportFolderId === "all" && { backgroundColor: theme.soft, borderColor: theme.accent },
                  ]}
                  onPress={() => setExportFolderId("all")}
                >
                  <Text
                    style={[
                      styles.exportChipText,
                      exportFolderId === "all" && { color: theme.accentText, fontWeight: "700" },
                    ]}
                  >
                    ทุกโฟลเดอร์
                  </Text>
                </Pressable>
                {cachedFolders.map((f) => {
                  const active = exportFolderId === f.id;
                  return (
                    <Pressable
                      key={f.id}
                      style={[
                        styles.exportChip,
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => setExportFolderId(f.id)}
                    >
                      <Text
                        style={[
                          styles.exportChipText,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {f.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            <View style={styles.exportToggleRow}>
              <Text style={styles.rowTitle}>เฉพาะรายการที่ยังไม่ได้ดู</Text>
              <Switch
                value={exportUnreadOnly}
                onValueChange={setExportUnreadOnly}
                trackColor={{ false: "#D1D5DB", true: theme.accent }}
                thumbColor="#FFFFFF"
              />
            </View>

            <Text style={styles.modalBody}>
              จำนวนที่จะส่งออก ({exportFilteredItems.length} รายการ) · ไฟล์ CSV รวมชื่อโพสต์ URL โฟลเดอร์ แท็ก โน้ต และสรุป
            </Text>

            <View style={styles.exportBtnRow}>
              <Pressable style={[styles.cancelBtn, { flex: 1, alignItems: "center", paddingVertical: 13 }]} onPress={() => setExportModalOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.fullDoneBtn,
                  { flex: 1.4, backgroundColor: theme.accent },
                  exportFilteredItems.length === 0 && { opacity: 0.45 },
                ]}
                disabled={exportFilteredItems.length === 0}
                onPress={handleExportCsv}
              >
                <Text style={styles.primaryModalBtnText}>ส่งออก CSV</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Logout Confirm Dialog (124:433) */}
      <Modal
        visible={logoutConfirmOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setLogoutConfirmOpen(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ออกจากระบบใช่ไหม?</Text>
            <Text style={styles.modalBody}>
              คุณสามารถเข้าสู่ระบบใหม่ด้วย {email || "บัญชีของคุณ"} ได้ทุกเมื่อ
            </Text>
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelBtn} onPress={() => setLogoutConfirmOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={styles.deleteConfirmBtn}
                onPress={() => {
                  setLogoutConfirmOpen(false);
                  void handleLogout();
                }}
              >
                <Text style={styles.primaryModalBtnText}>ออกจากระบบ</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Permanent Delete Confirm Modal */}
      <Modal
        visible={deleteOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setDeleteOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>ยืนยันการลบบัญชีถาวร</Text>
            <Text style={styles.modalBody}>
              ข้อมูลลิงก์ โฟลเดอร์ และการแจ้งเตือนทั้งหมดจะถูกลบอย่างถาวร พิมพ์คำว่า DELETE ด้านล่างเพื่อยืนยัน:
            </Text>
            <TextInput
              style={styles.deleteInput}
              placeholder="พิมพ์ DELETE"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="characters"
              value={deletePhrase}
              onChangeText={setDeletePhrase}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelBtn} onPress={() => setDeleteOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={[styles.deleteConfirmBtn, busyAction === "delete" ? { opacity: 0.6 } : null]}
                disabled={busyAction === "delete"}
                onPress={() => void handleDeleteAccount()}
              >
                <Text style={styles.primaryModalBtnText}>
                  {busyAction === "delete" ? "กำลังลบ..." : "ลบบัญชีถาวร"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: FIGMA_INK.bgApp,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 6,
    gap: 16,
  },
  pageHeading: {
    fontSize: 26,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
    letterSpacing: -0.4,
  },
  settingsCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    overflow: "hidden",
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    gap: 12,
  },
  profileLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  avatarLg: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLgText: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "800",
  },
  profileName: {
    fontSize: 19,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  profileEmail: {
    fontSize: 13.5,
    color: FIGMA_INK.inkSecondary,
    marginTop: 2,
  },
  groupBlock: {
    gap: 8,
  },
  groupTitle: {
    fontSize: 15.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: "#EFEFEF",
  },
  rowLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowTexts: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  rowHint: {
    fontSize: 12,
    color: FIGMA_INK.inkSecondary,
  },
  logoutBtn: {
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFF5F5",
    borderWidth: 1,
    borderColor: "#FECACA",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  logoutBtnText: {
    color: "#B91C1C",
    fontWeight: "700",
    fontSize: 15,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.45)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  modalBody: {
    fontSize: 13.5,
    color: "#44403C",
    lineHeight: 20,
  },
  input: {
    height: 46,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 15,
    color: FIGMA_INK.inkStrong,
  },
  deleteInput: {
    height: 46,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 15,
    color: FIGMA_INK.inkStrong,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: FIGMA_INK.bgChip,
  },
  cancelBtnText: {
    color: "#444444",
    fontWeight: "600",
  },
  primaryModalBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
  },
  primaryModalBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
  },
  deleteConfirmBtn: {
    backgroundColor: "#B91C1C",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.43)",
    justifyContent: "flex-end",
  },
  sheetCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 12,
  },
  sheetDragBar: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
  },
  sheetHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  subLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  themeOptionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    backgroundColor: "#FFFFFF",
  },
  themeSwatchBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  themeSwatchDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  themeOptionName: {
    fontSize: 15,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  themePreviewBox: {
    borderRadius: 14,
    padding: 14,
    gap: 3,
  },
  themePreviewHeading: {
    fontSize: 14.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  themePreviewSample: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },
  fullDoneBtn: {
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  actionTile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: FIGMA_INK.bgMuted,
    padding: 13,
    borderRadius: 12,
  },
  dangerTile: {
    backgroundColor: "#FEF2F2",
  },
  actionTileText: {
    fontSize: 14,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  monoMeta: {
    fontSize: 11.5,
    color: FIGMA_INK.inkSecondary,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  feedbackArea: {
    height: 88,
    paddingTop: 10,
    textAlignVertical: "top",
  },
  exportChipRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
  },
  exportChip: {
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
  },
  exportChipText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: FIGMA_INK.inkStrong,
  },
  exportToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  exportBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
});
