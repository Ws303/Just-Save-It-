import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  createFolder,
  deleteLinkItem,
  fetchWorkspace,
  flushOfflineQueue,
  getOfflineQueueCount,
  patchLinkItem,
  previewLinkUrl,
  resolveFolderCoverUrl,
  saveLinkItem,
  saveReminder,
  syncRemindersFromServer,
  type PreviewUrlResponsePayload,
} from "../../src/api";
import { FIGMA_INK, getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import {
  formatCardDisplayTitle,
  formatRemindTimeAndZone,
  getSocialPostLinkWarning,
  inferMobileDomain,
  inferMobilePlatform,
  isGenericOrNoisyTitle,
  matchesItemSearch,
  resolveMobileThumbUrl,
  scrubGenericPlatformTitle,
} from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadFigmaAccentTheme,
  loadSession,
  subscribeFigmaAccentTheme,
  type MobileFolderItem,
  type MobileLinkItem,
  type MobileReminderItem,
  type WorkflowStatus,
} from "../../src/storage";

const CHERRY_SELECTED_IMG = require("../../assets/figma/cherry-selected.png");
const CHERRY_UNSELECTED_IMG = require("../../assets/figma/cherry-unselected.png");
const HOME_MASCOT_IMG = require("../../assets/figma/home-cherry-mascot.png");
const QUICK_SAVE_TAGS = ["#คาเฟ่", "#ไอเดีย", "#เที่ยว", "#อาหาร", "#อ่านทีหลัง"];
type QuickReminderPreset = "none" | "2h" | "tomorrow18" | "3d";

function isReadStatus(raw?: string): boolean {
  const s = String(raw || "inbox").toLowerCase();
  return s === "done" || s === "read" || s === "archived";
}

function inferDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatReminderWhen(raw?: string | null): string {
  if (!raw) return "เตือนความจำตามกำหนด";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "เตือนความจำตามกำหนด";
  return d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

export default function HomeFeedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ sharedUrl?: string; sharedTitle?: string; addToFolderId?: string }>();
  const initialCache = getMemoryCachedWorkspace();

  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

  const [items, setItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [folders, setFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [reminders, setReminders] = useState<MobileReminderItem[]>(() => initialCache?.reminders || []);
  const [loading, setLoading] = useState<boolean>(() => !(initialCache?.items?.length || initialCache?.folders?.length));
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [queueCount, setQueueCount] = useState(0);

  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "read" | "favorite">("all");
  const [showAllLinks, setShowAllLinks] = useState(false);

  // Notifications Modal & Post Action Sheet
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuItem, setMenuItem] = useState<MobileLinkItem | null>(null);

  // Quick Save Modal (319:541)
  const [modalOpen, setModalOpen] = useState(false);
  const [saveUrl, setSaveUrl] = useState("");
  const [saveTitle, setSaveTitle] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [saveTags, setSaveTags] = useState("");
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<WorkflowStatus>("inbox");
  const [saveReminderPreset, setSaveReminderPreset] = useState<QuickReminderPreset>("none");
  const [saving, setSaving] = useState(false);
  const [inlineFolderOpen, setInlineFolderOpen] = useState(false);
  const [inlineFolderName, setInlineFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewUrlResponsePayload | null>(null);
  const saveSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const favInFlightRef = useRef<Set<string>>(new Set());
  const seenInFlightRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const postModalAlertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socialWarning = useMemo(() => getSocialPostLinkWarning(saveUrl), [saveUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveSeqRef.current += 1;
      previewSeqRef.current += 1;
      if (postModalAlertTimerRef.current) {
        clearTimeout(postModalAlertTimerRef.current);
        postModalAlertTimerRef.current = null;
      }
    };
  }, []);

  function showPostModalAlert(title: string, message: string) {
    if (!mountedRef.current) return;
    if (Platform.OS === "ios") {
      if (postModalAlertTimerRef.current) clearTimeout(postModalAlertTimerRef.current);
      postModalAlertTimerRef.current = setTimeout(() => {
        postModalAlertTimerRef.current = null;
        if (mountedRef.current) Alert.alert(title, message);
      }, 320);
      return;
    }
    Alert.alert(title, message);
  }

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  const loadAll = useCallback(async () => {
    const startGen = getAuthGeneration();
    const sess = await loadSession();
    if (getAuthGeneration() !== startGen || !sess?.access_token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const cached = await loadCachedWorkspace();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (cached.items.length > 0 || cached.folders.length > 0) {
      setItems((prev) => (prev.length ? prev : cached.items));
      setFolders((prev) => (prev.length ? prev : cached.folders));
      setReminders((prev) => (prev.length ? prev : cached.reminders));
      setLoading(false);
    }

    const flushed = await flushOfflineQueue();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const pendingCount = flushed.remaining || (await getOfflineQueueCount());
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setQueueCount(pendingCount);

    const ws = await fetchWorkspace();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setOffline(ws.offline);
    setItems(ws.items);
    setFolders(ws.folders);
    setReminders(ws.reminders);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadAll();
    }, [loadAll]),
  );

  const handleFetchPreview = useCallback(async (rawTargetUrl: string) => {
    const cleanUrl = rawTargetUrl.trim();
    if (!/^https?:\/\//i.test(cleanUrl) || getSocialPostLinkWarning(cleanUrl)) return;
    await runGuardedBusyAction(previewSeqRef, setPreviewing, async (isStale) => {
      const res = await previewLinkUrl(cleanUrl);
      if (isStale() || !res.ok || !res.data) return;
      setPreviewData(res.data);
      const pvTitle = formatCardDisplayTitle(res.data);
      setSaveTitle((prev) => {
        if (!prev.trim() || isGenericOrNoisyTitle(prev, res.data?.platform || "", cleanUrl)) {
          return scrubGenericPlatformTitle(pvTitle, res.data?.platform || "", cleanUrl) || pvTitle;
        }
        return prev;
      });
    });
  }, []);

  useEffect(() => {
    if (typeof params.sharedUrl === "string" && params.sharedUrl.trim()) {
      const sharedClean = params.sharedUrl.trim();
      const rawSharedTitle = typeof params.sharedTitle === "string" ? params.sharedTitle : "";
      const cleanSharedTitle = scrubGenericPlatformTitle(rawSharedTitle, "", sharedClean);
      setSaveUrl(sharedClean);
      setSaveTitle(cleanSharedTitle);
      setPreviewData(null);
      setModalOpen(true);
      void handleFetchPreview(sharedClean);
    }
  }, [params.sharedUrl, params.sharedTitle, handleFetchPreview]);

  useEffect(() => {
    if (typeof params.addToFolderId === "string" && params.addToFolderId.trim()) {
      setSaveFolderId(params.addToFolderId.trim());
      setModalOpen(true);
      router.setParams({ addToFolderId: undefined });
    }
  }, [params.addToFolderId, router]);

  const folderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders) {
      if (f?.id) map.set(f.id, f.name || "");
    }
    return map;
  }, [folders]);

  const itemById = useMemo(() => {
    const map = new Map<string, MobileLinkItem>();
    for (const it of items) {
      if (it?.id) map.set(it.id, it);
    }
    return map;
  }, [items]);

  const activeReminders = useMemo(
    () =>
      reminders.filter(
        (r) => r && r.enabled !== false && r.is_enabled !== false && String(r.status || "").toLowerCase() !== "cancelled",
      ),
    [reminders],
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const seen = isReadStatus(item.status);
      if (statusFilter === "unread" && seen) return false;
      if (statusFilter === "read" && !seen) return false;
      if (statusFilter === "favorite" && !item.is_favorite) return false;
      const fName = item.folder_id ? folderNameById.get(item.folder_id) || "" : "";
      if (!matchesItemSearch(item, searchText, fName)) return false;
      return true;
    });
  }, [items, folderNameById, searchText, statusFilter]);

  const displayedItems = useMemo(() => {
    if (!showAllLinks && !searchText.trim() && statusFilter === "all") {
      return filteredItems.slice(0, 6);
    }
    return filteredItems;
  }, [filteredItems, showAllLinks, searchText, statusFilter]);

  function closeQuickSaveModal() {
    saveSeqRef.current += 1;
    previewSeqRef.current += 1;
    setSaving(false);
    setPreviewing(false);
    setModalOpen(false);
    setInlineFolderOpen(false);
    setInlineFolderName("");
    setSaveUrl("");
    setSaveTitle("");
    setSaveNote("");
    setSaveTags("");
    setSaveFolderId(null);
    setSaveStatus("inbox");
    setSaveReminderPreset("none");
    setPreviewData(null);
  }

  function hasQuickTag(tagWithHash: string): boolean {
    const needle = tagWithHash.replace(/^#/, "").trim().toLowerCase();
    return saveTags
      .split(/[\s,]+/)
      .some((t) => t.replace(/^#/, "").trim().toLowerCase() === needle);
  }

  function toggleQuickSaveTag(tagWithHash: string) {
    const needle = tagWithHash.replace(/^#/, "").trim().toLowerCase();
    const parts = saveTags
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const exists = parts.some((t) => t.replace(/^#/, "").toLowerCase() === needle);
    const next = exists
      ? parts.filter((t) => t.replace(/^#/, "").toLowerCase() !== needle)
      : [...parts, tagWithHash];
    setSaveTags(next.join(" "));
  }

  async function handleInlineCreateFolder() {
    const name = inlineFolderName.trim();
    if (!name) {
      Alert.alert("กรุณาระบุชื่อโฟลเดอร์");
      return;
    }
    const startGen = getAuthGeneration();
    setCreatingFolder(true);
    try {
      const res = await createFolder(name, "");
      if (getAuthGeneration() !== startGen) return;
      if (!res.ok || !res.data) {
        Alert.alert("สร้างโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      const created = res.data;
      setFolders((prev) => [...prev.filter((f) => f.id !== created.id), created]);
      setSaveFolderId(created.id);
      setInlineFolderName("");
      setInlineFolderOpen(false);
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleQuickSave() {
    const cleanUrl = saveUrl.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      Alert.alert("URL ไม่ถูกต้อง", "กรุณาระบุลิงก์ที่ขึ้นต้นด้วย http:// หรือ https://");
      return;
    }
    await runGuardedBusyAction(saveSeqRef, setSaving, async (isStale) => {
      const startGen = getAuthGeneration();
      const chosenPreset = saveReminderPreset;
      const chosenStatus = saveStatus;
      const parsedTags = saveTags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, "").trim())
        .filter(Boolean);

      const cleanedTitle = scrubGenericPlatformTitle(
        saveTitle.trim(),
        previewData?.platform || "",
        cleanUrl,
      );
      const matchedPv = previewData && previewData.url === cleanUrl ? previewData : null;
      const pvThumb = matchedPv ? resolveMobileThumbUrl(matchedPv) : "";

      const res = await saveLinkItem({
        url: cleanUrl,
        title: cleanedTitle || (matchedPv?.title ? formatCardDisplayTitle(matchedPv) : undefined),
        description: matchedPv?.description ?? undefined,
        thumbnail_url: pvThumb || undefined,
        image_url: matchedPv?.image_url ?? undefined,
        media_items: Array.isArray(matchedPv?.media_items) ? matchedPv.media_items : undefined,
        embed_url: matchedPv?.embed_url ?? undefined,
        embed_type: matchedPv?.embed_type ?? undefined,
        platform: matchedPv?.platform ?? undefined,
        note: saveNote.trim() || undefined,
        tags: parsedTags.length ? parsedTags : undefined,
        folder_id: saveFolderId,
        status: saveStatus,
      });
      if (isStale() || getAuthGeneration() !== startGen) return;
      if (!res.ok) {
        Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่อีกครั้ง");
        return;
      }
      const createdId = typeof res.data?.id === "string" ? res.data.id : "";
      let reminderWarning = "";
      if (!res.queued && createdId && chosenPreset !== "none" && chosenStatus !== "done") {
        const now = new Date();
        const remDt =
          chosenPreset === "2h"
            ? new Date(now.getTime() + 2 * 3600 * 1000)
            : chosenPreset === "tomorrow18"
              ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 18, 0, 0, 0)
              : new Date(now.getTime() + 72 * 3600 * 1000);
        const { remind_time, timezone } = formatRemindTimeAndZone(remDt);
        const remRes = await saveReminder(createdId, {
          schedule_type: "once",
          remind_at: remDt.toISOString(),
          remind_time,
          timezone,
          repeat_every_days: null,
        });
        if (isStale() || getAuthGeneration() !== startGen) return;
        if (!remRes.ok) {
          reminderWarning = remRes.error || "สามารถเข้าไปตั้งเตือนภายหลังได้ที่หน้ารายละเอียดลิงก์";
        } else {
          await syncRemindersFromServer().catch(() => {});
          if (isStale() || getAuthGeneration() !== startGen) return;
        }
      }
      closeQuickSaveModal();
      if (reminderWarning) {
        showPostModalAlert("บันทึกลิงก์แล้ว แต่ตั้งเตือนไม่สำเร็จ", reminderWarning);
      } else if (res.queued) {
        showPostModalAlert("บันทึกเข้า Offline Queue แล้ว", "ระบบจะอัปโหลดขึ้น Cloud อัตโนมัติเมื่อออนไลน์");
      }
      void loadAll();
    });
  }

  const flipFav = (list: MobileLinkItem[], id: string, v: boolean) =>
    list.map((it) => (it.id === id ? { ...it, is_favorite: v } : it));

  async function toggleFavorite(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    const pending = favInFlightRef.current;
    if (!item.id || pending.has(item.id)) return;
    pending.add(item.id);
    const nextFav = !item.is_favorite;
    setItems((p) => flipFav(p, item.id, nextFav));
    const res = await patchLinkItem(item.id, { is_favorite: nextFav }).finally(() => pending.delete(item.id));
    if (getAuthGeneration() !== startGen) return;
    if (!res.ok) setItems((p) => flipFav(p, item.id, !nextFav));
  }

  async function handleToggleSeenMenu(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    if (!item.id || seenInFlightRef.current.has(item.id)) return;
    seenInFlightRef.current.add(item.id);
    const prevStatus = item.status;
    const nextStatus: WorkflowStatus = isReadStatus(prevStatus) ? "inbox" : "done";
    setMenuItem(null);
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: nextStatus } : it)));
    try {
      const res = await patchLinkItem(item.id, { status: nextStatus });
      if (getAuthGeneration() !== startGen) return;
      if (!res.ok) {
        setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: prevStatus } : it)));
      }
    } finally {
      seenInFlightRef.current.delete(item.id);
    }
  }

  function handleOpenUrlFromMenu(item: MobileLinkItem) {
    setMenuItem(null);
    const raw = String(item.url || "").trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) {
      Alert.alert("ลิงก์ไม่ปลอดภัย", "อนุญาตเปิดเฉพาะลิงก์ http หรือ https เท่านั้น");
      return;
    }
    void Linking.openURL(raw).catch(() => {
      Alert.alert("ไม่สามารถเปิดลิงก์ได้", "กรุณาตรวจสอบแอปเบราว์เซอร์ในเครื่อง");
    });
  }

  function handleDeleteFromMenu(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    setMenuItem(null);
    Alert.alert("ลบลิงก์นี้?", "ลิงก์จะถูกลบออกจากพื้นที่ทำงานของคุณ", [
      { text: "ยกเลิก", style: "cancel" },
      {
        text: "ลบ",
        style: "destructive",
        onPress: () => {
          if (getAuthGeneration() !== startGen) return;
          void deleteLinkItem(item.id).then((res) => {
            if (getAuthGeneration() !== startGen) return;
            if (res.ok) {
              setItems((prev) => prev.filter((it) => it.id !== item.id));
            } else {
              Alert.alert("ลบไม่สำเร็จ", res.error || "กรุณาลองใหม่");
            }
          });
        },
      },
    ]);
  }

  function handleResumeUnread() {
    const firstUnread = items.find((it) => !isReadStatus(it.status));
    if (firstUnread?.id) {
      router.push(`/item/${encodeURIComponent(firstUnread.id)}`);
    } else {
      setStatusFilter("unread");
    }
  }

  function renderHomeHeaderBlock() {
    const homeFolders = folders.filter((f) => f.name !== "ยังไม่จัดหมวด").slice(0, 6);
    const showBanner = statusFilter === "all" && !searchText.trim();

    return (
      <View style={styles.feedHeaderBlock}>
        {showBanner ? (
          <View style={styles.resumeBanner}>
            <View style={styles.resumeCopy}>
              <Text style={styles.resumeTitle}>{"กลับมาดู\nสิ่งที่บันทึกไว้กันเถอะ"}</Text>
              <Pressable style={styles.resumeCta} onPress={handleResumeUnread}>
                <Text style={styles.resumeCtaText}>ดูรายการที่ยังไม่ได้ดู</Text>
                <Ionicons name="chevron-forward" size={14} color={FIGMA_INK.inkPrimary} />
              </Pressable>
            </View>
            <Image source={HOME_MASCOT_IMG} style={styles.resumeMascot} resizeMode="contain" />
          </View>
        ) : null}

        <View style={styles.sectionBlock}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>โฟลเดอร์ของฉัน</Text>
            <Pressable hitSlop={8} onPress={() => router.push("/(tabs)/folders")}>
              <Text style={styles.sectionActionLink}>ดูทั้งหมด</Text>
            </Pressable>
          </View>

          {homeFolders.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.folderStripRow}
            >
              {homeFolders.map((f) => {
                const folderItems = items.filter((it) => it.folder_id === f.id);
                const customCover = resolveFolderCoverUrl(f.cover_url);
                const thumbs = folderItems.map((it) => resolveMobileThumbUrl(it)).filter(Boolean).slice(0, 4);
                const cnt = typeof f.item_count === "number" ? f.item_count : folderItems.length;

                return (
                  <Pressable
                    key={f.id}
                    style={styles.homeFolderCard}
                    onPress={() => router.push(`/folder/${encodeURIComponent(f.id)}`)}
                  >
                    <View style={styles.homeFolderThumbWrap}>
                      {customCover ? (
                        <Image source={{ uri: customCover }} style={styles.fullImg} resizeMode="cover" />
                      ) : thumbs.length >= 2 ? (
                        <View style={styles.collageGrid}>
                          {[0, 1, 2, 3].map((idx) => (
                            <View key={`c-${f.id}-${idx}`} style={styles.collageCell}>
                              {thumbs[idx] ? (
                                <Image source={{ uri: thumbs[idx] }} style={styles.fullImg} resizeMode="cover" />
                              ) : (
                                <Ionicons name="image-outline" size={11} color="#9CA3AF" />
                              )}
                            </View>
                          ))}
                        </View>
                      ) : thumbs[0] ? (
                        <Image source={{ uri: thumbs[0] }} style={styles.fullImg} resizeMode="cover" />
                      ) : (
                        <Ionicons name="folder-outline" size={22} color="#6E675F" />
                      )}
                    </View>
                    <Text style={styles.homeFolderName} numberOfLines={1}>
                      {f.name}
                    </Text>
                    <Text style={styles.homeFolderCount}>{cnt} รายการ</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <Pressable
              style={styles.emptyFolderCard}
              onPress={() => router.push("/(tabs)/folders")}
            >
              <Ionicons name="add" size={20} color={theme.accentText} />
              <Text style={styles.emptyFolderCardText}>สร้างโฟลเดอร์แรกของคุณ</Text>
            </Pressable>
          )}
        </View>

        <View style={[styles.sectionHead, { marginTop: 4 }]}>
          <Text style={styles.sectionTitle}>บันทึกล่าสุด</Text>
          {filteredItems.length > 6 ? (
            <Pressable hitSlop={8} onPress={() => setShowAllLinks((v) => !v)}>
              <Text style={styles.sectionActionLink}>
                {showAllLinks ? "ย่อรายการ" : "ดูทั้งหมด"}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.sectionHint}>{filteredItems.length} รายการ</Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: Math.max(10, insets.top) }]}>
      <View style={styles.homeHeader}>
        <View style={styles.brandCol}>
          <Text style={styles.brandHeading}>Sherlink</Text>
          {offline || queueCount > 0 ? (
            <Text style={styles.syncHint}>
              {offline ? "โหมดออฟไลน์" : "กำลังเชื่อมต่อ"}
              {queueCount > 0 ? ` · ค้างซิงก์ ${queueCount}` : ""}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.addPillBtn, { backgroundColor: theme.accent }]}
            onPress={() => setModalOpen(true)}
          >
            <Ionicons name="add" size={16} color="#FFFFFF" />
            <Text style={styles.addPillText}>เพิ่มลิงก์</Text>
          </Pressable>
          <Pressable style={styles.bellBtn} onPress={() => setNotifOpen(true)}>
            <Ionicons name="notifications-outline" size={19} color={FIGMA_INK.inkPrimary} />
            {activeReminders.length > 0 ? (
              <View style={[styles.bellDot, { backgroundColor: theme.accent }]} />
            ) : null}
          </Pressable>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={18} color={FIGMA_INK.inkPrimary} />
          <TextInput
            style={styles.searchInput}
            placeholder="ค้นหาลิงก์ โน้ต หรือแท็ก"
            placeholderTextColor="#8B9199"
            value={searchText}
            onChangeText={setSearchText}
          />
          {searchText ? (
            <Pressable hitSlop={8} onPress={() => setSearchText("")}>
              <Ionicons name="close-circle" size={17} color="#9CA3AF" />
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {(
            [
              { id: "all", label: "ทั้งหมด" },
              { id: "unread", label: "ยังไม่ได้ดู" },
              { id: "read", label: "ดูแล้ว" },
              { id: "favorite", label: "ชื่นชอบ", hasCherry: true },
            ] as const
          ).map((st) => {
            const active = statusFilter === st.id;
            return (
              <Pressable
                key={st.id}
                style={[
                  styles.filterPill,
                  active && {
                    backgroundColor: theme.soft,
                    borderWidth: 1,
                    borderColor: theme.softBorder,
                  },
                ]}
                onPress={() => setStatusFilter(st.id)}
              >
                {"hasCherry" in st && st.hasCherry ? (
                  <Image source={CHERRY_SELECTED_IMG} style={styles.chipCherry} resizeMode="contain" />
                ) : null}
                <Text
                  style={[
                    styles.filterPillText,
                    active && { color: theme.accentText, fontWeight: "700" },
                  ]}
                >
                  {st.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={displayedItems}
          keyExtractor={(it) => it.id}
          ListHeaderComponent={renderHomeHeaderBlock}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={theme.accent}
              onRefresh={() => {
                setRefreshing(true);
                void loadAll();
              }}
            />
          }
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: 112 + insets.bottom },
          ]}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <View style={styles.emptyIconBadge}>
                <Ionicons name="bookmark" size={22} color={theme.accentText} />
              </View>
              <Text style={styles.emptyTitle}>ยังไม่มีลิงก์ที่ตรงกับตัวกรอง</Text>
              <Text style={styles.emptySub}>
                กดปุ่ม &quot;+ เพิ่มลิงก์&quot; ด้านบน หรือแชร์ลิงก์จากแอปอื่นมาที่ Sherlink
              </Text>
              <Pressable
                style={[styles.emptyCtaBtn, { backgroundColor: theme.accent }]}
                onPress={() => setModalOpen(true)}
              >
                <Text style={styles.emptyCtaText}>+ เพิ่มลิงก์แรกของฉัน</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => {
            const seen = isReadStatus(item.status);
            const thumbUri = resolveMobileThumbUrl(item);
            const platLabel = inferMobilePlatform(item) || inferMobileDomain(item.url) || inferDomain(item.url);
            const folderLabel = (item.folder_id && folderNameById.get(item.folder_id)) || "ยังไม่จัดหมวด";
            const codeBadge = String(platLabel || "WEB").slice(0, 3).toUpperCase();

            return (
              <Pressable
                style={styles.figmaLinkCard}
                onPress={() => router.push(`/item/${encodeURIComponent(item.id)}`)}
              >
                <View style={styles.figmaLinkThumb}>
                  {thumbUri ? (
                    <Image source={{ uri: thumbUri }} style={styles.fullImg} resizeMode="cover" />
                  ) : (
                    <Text style={styles.figmaThumbCode}>{codeBadge}</Text>
                  )}
                </View>

                <View style={styles.figmaLinkMain}>
                  <Text style={styles.figmaLinkPlatform} numberOfLines={1}>
                    {platLabel}
                  </Text>
                  <Text style={styles.figmaLinkTitle} numberOfLines={2}>
                    {formatCardDisplayTitle(item) || item.url}
                  </Text>
                  <Text style={styles.figmaLinkMeta} numberOfLines={1}>
                    {folderLabel} · {seen ? "ดูแล้ว" : "ยังไม่ได้ดู"}
                  </Text>
                </View>

                <View style={styles.figmaLinkActions}>
                  <Pressable
                    style={styles.cardActionIconBtn}
                    hitSlop={6}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      void toggleFavorite(item);
                    }}
                  >
                    <Image
                      source={item.is_favorite ? CHERRY_SELECTED_IMG : CHERRY_UNSELECTED_IMG}
                      style={styles.cherryActionImg}
                      resizeMode="contain"
                    />
                  </Pressable>
                  <Pressable
                    style={styles.cardActionIconBtn}
                    hitSlop={6}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      setMenuItem(item);
                    }}
                  >
                    <Ionicons name="ellipsis-vertical" size={16} color="#5C6269" />
                  </Pressable>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {/* Post Action Sheet Modal */}
      <Modal
        visible={Boolean(menuItem)}
        animationType="fade"
        transparent
        onRequestClose={() => setMenuItem(null)}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setMenuItem(null)}>
          <Pressable
            style={[styles.actionSheetCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}
            onPress={() => {}}
          >
            <View style={styles.sheetDragBar} />
            <Text style={styles.actionSheetTitle} numberOfLines={2}>
              {menuItem ? formatCardDisplayTitle(menuItem) || menuItem.url : ""}
            </Text>
            {menuItem ? (
              <View style={styles.actionSheetList}>
                <Pressable
                  style={styles.actionSheetRow}
                  onPress={() => {
                    const id = menuItem.id;
                    setMenuItem(null);
                    router.push(`/item/${encodeURIComponent(id)}`);
                  }}
                >
                  <Ionicons name="document-text-outline" size={18} color={FIGMA_INK.inkPrimary} />
                  <Text style={styles.actionSheetRowText}>ดูรายละเอียดและสรุป AI</Text>
                </Pressable>
                <Pressable style={styles.actionSheetRow} onPress={() => handleOpenUrlFromMenu(menuItem)}>
                  <Ionicons name="open-outline" size={18} color={FIGMA_INK.inkPrimary} />
                  <Text style={styles.actionSheetRowText}>เปิดลิงก์ต้นฉบับ</Text>
                </Pressable>
                <Pressable style={styles.actionSheetRow} onPress={() => void handleToggleSeenMenu(menuItem)}>
                  <Ionicons name="swap-horizontal-outline" size={18} color={FIGMA_INK.inkPrimary} />
                  <Text style={styles.actionSheetRowText}>
                    {isReadStatus(menuItem.status) ? "เปลี่ยนเป็น ยังไม่ได้ดู" : "ทำเครื่องหมายว่า ดูแล้ว"}
                  </Text>
                </Pressable>
                <Pressable style={[styles.actionSheetRow, styles.actionSheetDanger]} onPress={() => handleDeleteFromMenu(menuItem)}>
                  <Ionicons name="trash-outline" size={18} color="#B91C1C" />
                  <Text style={[styles.actionSheetRowText, { color: "#B91C1C" }]}>ลบลิงก์นี้ออก</Text>
                </Pressable>
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Notifications Modal (26 Notifications) */}
      <Modal
        visible={notifOpen}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setNotifOpen(false)}
      >
        <View style={[styles.notifRoot, { paddingTop: Math.max(12, insets.top) }]}>
          <View style={styles.notifHeader}>
            <Pressable style={styles.notifBackBtn} onPress={() => setNotifOpen(false)}>
              <Ionicons name="chevron-back" size={22} color={FIGMA_INK.inkPrimary} />
              <Text style={styles.notifHeaderTitle}>การแจ้งเตือน</Text>
            </Pressable>
            <Pressable hitSlop={8} onPress={() => setNotifOpen(false)}>
              <Ionicons name="close" size={22} color="#666666" />
            </Pressable>
          </View>
          <Text style={styles.notifSub}>รวมแจ้งเตือนความจำที่ตั้งเวลาไว้ใน Sherlink</Text>
          <ScrollView contentContainerStyle={styles.notifList}>
            {activeReminders.length === 0 ? (
              <View style={styles.notifEmptyCard}>
                <Ionicons name="notifications-off-outline" size={26} color="#9CA3AF" />
                <Text style={styles.notifEmptyText}>ยังไม่มีรายการแจ้งเตือนความจำที่ตั้งไว้</Text>
              </View>
            ) : (
              activeReminders.map((rem, idx) => {
                const target = itemById.get(rem.item_id);
                const whenStr = formatReminderWhen(
                  rem.remind_at || rem.next_remind_at || rem.next_run_at || rem.scheduled_for,
                );
                return (
                  <Pressable
                    key={rem.id || `${rem.item_id}-${idx}`}
                    style={styles.notifCard}
                    onPress={() => {
                      setNotifOpen(false);
                      router.push(`/item/${encodeURIComponent(rem.item_id)}`);
                    }}
                  >
                    <View style={[styles.notifIconCircle, { backgroundColor: theme.soft }]}>
                      <Ionicons name="time-outline" size={18} color={theme.accent} />
                    </View>
                    <View style={styles.notifContent}>
                      <Text style={styles.notifItemTitle} numberOfLines={2}>
                        {rem.title || (target ? formatCardDisplayTitle(target) : "") || rem.url || "ลิงก์ที่ตั้งเตือนไว้"}
                      </Text>
                      <Text style={styles.notifItemMeta}>{whenStr}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Quick Save Bottom Sheet Modal (Figma 319:541) */}
      <Modal visible={modalOpen} animationType="slide" transparent onRequestClose={closeQuickSaveModal}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.modalCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.sheetDragBar} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>บันทึกลิงก์</Text>
              <Pressable hitSlop={8} onPress={closeQuickSaveModal}>
                <Ionicons name="close" size={22} color="#666666" />
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.urlLabelRow}>
                <Text style={styles.label}>ลิงก์ (URL)</Text>
                <Pressable
                  style={[styles.previewBtn, previewing && { opacity: 0.6 }]}
                  disabled={previewing || !saveUrl.trim()}
                  onPress={() => void handleFetchPreview(saveUrl)}
                >
                  <View style={styles.chipInner}>
                    <Ionicons name="sparkles-outline" size={13} color={theme.accentText} />
                    <Text style={[styles.previewBtnText, { color: theme.accentText }]}>
                      {previewing ? "กำลังดึง..." : "ดึงพรีวิว"}
                    </Text>
                  </View>
                </Pressable>
              </View>
              <TextInput
                style={styles.input}
                placeholder="https://..."
                placeholderTextColor="#9CA3AF"
                autoCapitalize="none"
                value={saveUrl}
                onChangeText={(next) => {
                  setSaveUrl(next);
                  if (previewData && previewData.url !== next.trim()) {
                    setPreviewData(null);
                  }
                }}
              />
              {socialWarning ? (
                <View style={styles.warningBox}>
                  <View style={styles.warningHeadRow}>
                    <Ionicons name="warning-outline" size={15} color="#92400E" />
                    <Text style={styles.warningTitle}>ลิงก์หน้าฟีด {socialWarning.platform}</Text>
                  </View>
                  <Text style={styles.warningText}>{socialWarning.message}</Text>
                  <Text style={styles.warningHint}>ตัวอย่าง: {socialWarning.example}</Text>
                </View>
              ) : null}
              {previewData ? (
                <View style={styles.previewCard}>
                  {resolveMobileThumbUrl(previewData) ? (
                    <Image
                      source={{ uri: resolveMobileThumbUrl(previewData) }}
                      style={styles.previewThumb}
                      resizeMode="cover"
                    />
                  ) : null}
                  <View style={styles.previewBody}>
                    <Text style={[styles.previewPlat, { color: theme.accentText }]}>
                      {previewData.platform || "web"}
                    </Text>
                    <Text style={styles.previewTitle} numberOfLines={2}>
                      {formatCardDisplayTitle(previewData)}
                    </Text>
                  </View>
                </View>
              ) : null}

              <Text style={styles.label}>ชื่อเรื่อง (ไม่บังคับ)</Text>
              <TextInput
                style={styles.input}
                placeholder="ระบบจะดึงชื่อให้อัตโนมัติหากเว้นว่าง"
                placeholderTextColor="#9CA3AF"
                value={saveTitle}
                onChangeText={setSaveTitle}
              />

              <Text style={styles.label}>โฟลเดอร์</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subStrip}>
                <Pressable
                  style={[
                    styles.smallChip,
                    saveFolderId === null && { backgroundColor: "#1C1917", borderColor: "#1C1917" },
                  ]}
                  onPress={() => setSaveFolderId(null)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      saveFolderId === null && { color: "#FFFFFF", fontWeight: "700" },
                    ]}
                  >
                    ไม่ใส่โฟลเดอร์
                  </Text>
                </Pressable>
                {folders.map((f) => {
                  const active = saveFolderId === f.id;
                  return (
                    <Pressable
                      key={f.id}
                      style={[
                        styles.smallChip,
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => setSaveFolderId(f.id)}
                    >
                      <View style={styles.chipInner}>
                        <Ionicons
                          name="folder-outline"
                          size={13}
                          color={active ? theme.accentText : "#57534E"}
                        />
                        <Text
                          style={[
                            styles.chipText,
                            active && { color: theme.accentText, fontWeight: "700" },
                          ]}
                        >
                          {f.name}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
                <Pressable
                  style={[
                    styles.smallChip,
                    styles.newFolderChip,
                    inlineFolderOpen && { backgroundColor: theme.soft, borderColor: theme.accent },
                  ]}
                  onPress={() => setInlineFolderOpen((prev) => !prev)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: theme.accentText },
                    ]}
                  >
                    + สร้างโฟลเดอร์ใหม่
                  </Text>
                </Pressable>
              </ScrollView>

              {inlineFolderOpen ? (
                <View style={styles.inlineFolderBox}>
                  <View style={styles.inlineFolderRow}>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="ชื่อโฟลเดอร์ใหม่ เช่น คาเฟ่"
                      placeholderTextColor="#9CA3AF"
                      value={inlineFolderName}
                      onChangeText={setInlineFolderName}
                    />
                    <Pressable
                      style={[
                        styles.inlineCreateBtn,
                        { backgroundColor: theme.accent },
                        creatingFolder && { opacity: 0.65 },
                      ]}
                      disabled={creatingFolder}
                      onPress={() => void handleInlineCreateFolder()}
                    >
                      <Text style={styles.inlineCreateBtnText}>
                        {creatingFolder ? "..." : "สร้าง"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              <Text style={styles.label}>สถานะ</Text>
              <View style={styles.inlinePills}>
                {(["inbox", "done"] as const).map((st) => {
                  const active = saveStatus === st;
                  return (
                    <Pressable
                      key={st}
                      style={[
                        styles.smallChip,
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => setSaveStatus(st)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {st === "done" ? "ดูแล้ว" : "ยังไม่ดู"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.label}>แท็ก</Text>
              <View style={[styles.inlinePills, { flexWrap: "wrap", marginBottom: 8 }]}>
                {QUICK_SAVE_TAGS.map((qt) => {
                  const active = hasQuickTag(qt);
                  return (
                    <Pressable
                      key={qt}
                      style={[
                        styles.smallChip,
                        { marginRight: 0 },
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => toggleQuickSaveTag(qt)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {qt}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                style={styles.input}
                placeholder="#คาเฟ่ #ไอเดีย"
                placeholderTextColor="#9CA3AF"
                value={saveTags}
                onChangeText={setSaveTags}
              />

              <Text style={styles.label}>ตั้งเตือนด่วน</Text>
              <View style={[styles.inlinePills, { flexWrap: "wrap" }]}>
                {(
                  [
                    { id: "none", label: "ไม่เตือน" },
                    { id: "2h", label: "อีก 2 ชม." },
                    { id: "tomorrow18", label: "พรุ่งนี้ 18:00" },
                    { id: "3d", label: "อีก 3 วัน" },
                  ] as const
                ).map((opt) => {
                  const disabledByDone = saveStatus === "done" && opt.id !== "none";
                  const active = saveReminderPreset === opt.id && !disabledByDone;
                  return (
                    <Pressable
                      key={opt.id}
                      style={[
                        styles.smallChip,
                        { marginRight: 0 },
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                        disabledByDone && { opacity: 0.45 },
                      ]}
                      disabled={disabledByDone}
                      onPress={() => setSaveReminderPreset(opt.id)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {saveStatus === "done" ? (
                <Text style={styles.syncHint}>สถานะ &quot;ดูแล้ว&quot; จะไม่ตั้งเตือน</Text>
              ) : null}

              <Text style={styles.label}>โน้ตสั้น</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="จดโน้ตสั้นๆ..."
                placeholderTextColor="#9CA3AF"
                multiline
                value={saveNote}
                onChangeText={setSaveNote}
              />

              <Pressable
                style={[styles.saveCta, { backgroundColor: theme.accent }, saving && { opacity: 0.7 }]}
                disabled={saving}
                onPress={() => void handleQuickSave()}
              >
                {saving ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveCtaText}>บันทึก</Text>
                )}
              </Pressable>
            </ScrollView>
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
  homeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
  },
  brandCol: {
    flexDirection: "column",
  },
  brandHeading: {
    fontSize: 26,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
    letterSpacing: -0.4,
  },
  syncHint: {
    fontSize: 11,
    fontWeight: "600",
    color: "#B45309",
    marginTop: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  addPillBtn: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  addPillText: {
    color: "#FFFFFF",
    fontSize: 13.5,
    fontWeight: "700",
  },
  bellBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    backgroundColor: FIGMA_INK.bgMuted,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  bellDot: {
    position: "absolute",
    top: 7,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 10,
  },
  searchBox: {
    height: 42,
    borderRadius: 21,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderInput,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: FIGMA_INK.inkStrong,
    paddingVertical: 0,
  },
  filterRow: {
    gap: 7,
    alignItems: "center",
  },
  filterPill: {
    height: 34,
    paddingHorizontal: 13,
    borderRadius: 17,
    backgroundColor: FIGMA_INK.bgChip,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  chipCherry: {
    width: 14,
    height: 14,
  },
  filterPillText: {
    fontSize: 12.5,
    fontWeight: "500",
    color: "#444444",
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 2,
    gap: 8,
  },
  feedHeaderBlock: {
    gap: 12,
    marginBottom: 4,
  },
  resumeBanner: {
    backgroundColor: "#F8F8F9",
    borderWidth: 1,
    borderColor: "#E4E4E7",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  resumeCopy: {
    flex: 1,
    alignItems: "flex-start",
    gap: 8,
  },
  resumeTitle: {
    fontSize: 14.5,
    fontWeight: "800",
    lineHeight: 20,
    color: "#1D2430",
  },
  resumeCta: {
    height: 29,
    paddingHorizontal: 11,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#D4D4D8",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  resumeCtaText: {
    fontSize: 12,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  resumeMascot: {
    width: 76,
    height: 76,
  },
  sectionBlock: {
    gap: 8,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 16.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  sectionActionLink: {
    fontSize: 12.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
    textDecorationLine: "underline",
  },
  sectionHint: {
    fontSize: 12,
    color: FIGMA_INK.inkSubtle,
  },
  folderStripRow: {
    gap: 10,
    paddingRight: 4,
  },
  homeFolderCard: {
    width: 148,
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E2E6",
    padding: 7,
    gap: 3,
  },
  homeFolderThumbWrap: {
    width: "100%",
    height: 54,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: FIGMA_INK.bgThumb,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 3,
  },
  collageGrid: {
    width: "100%",
    height: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  collageCell: {
    width: "50%",
    height: "50%",
    backgroundColor: "#E5E7EB",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0.5,
    borderColor: "#FFFFFF",
  },
  fullImg: {
    width: "100%",
    height: "100%",
  },
  homeFolderName: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  homeFolderCount: {
    fontSize: 12,
    color: FIGMA_INK.inkSubtle,
  },
  emptyFolderCard: {
    height: 68,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E2E6",
    backgroundColor: "#FAFAFA",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyFolderCardText: {
    fontSize: 13.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  figmaLinkCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  figmaLinkThumb: {
    width: 54,
    height: 54,
    borderRadius: 10,
    backgroundColor: FIGMA_INK.bgThumb,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  figmaThumbCode: {
    fontSize: 12,
    fontWeight: "800",
    color: "#55596A",
  },
  figmaLinkMain: {
    flex: 1,
    minWidth: 0,
  },
  figmaLinkPlatform: {
    fontSize: 11,
    fontWeight: "500",
    color: "#777777",
  },
  figmaLinkTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
    lineHeight: 19,
  },
  figmaLinkMeta: {
    fontSize: 11,
    color: FIGMA_INK.inkSubtle,
    marginTop: 2,
  },
  figmaLinkActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  cardActionIconBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  cherryActionImg: {
    width: 20,
    height: 20,
  },
  emptyBox: {
    paddingVertical: 32,
    paddingHorizontal: 20,
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EFEFEF",
    marginTop: 6,
    gap: 6,
  },
  emptyIconBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#FCF0F0",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 15.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  emptySub: {
    fontSize: 13,
    color: FIGMA_INK.inkSecondary,
    textAlign: "center",
    lineHeight: 19,
  },
  emptyCtaBtn: {
    marginTop: 8,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCtaText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13.5,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.43)",
    justifyContent: "flex-end",
  },
  sheetDragBar: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
    marginBottom: 10,
  },
  actionSheetCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  actionSheetTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
    marginBottom: 12,
  },
  actionSheetList: {
    gap: 6,
  },
  actionSheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: FIGMA_INK.bgMuted,
  },
  actionSheetDanger: {
    backgroundColor: "#FEF2F2",
  },
  actionSheetRowText: {
    fontSize: 14.5,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  notifRoot: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  notifHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  notifBackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  notifHeaderTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  notifSub: {
    fontSize: 13,
    color: FIGMA_INK.inkSecondary,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  notifList: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 10,
  },
  notifEmptyCard: {
    padding: 36,
    borderRadius: 16,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#EFEFEF",
    alignItems: "center",
    gap: 8,
  },
  notifEmptyText: {
    fontSize: 14,
    color: FIGMA_INK.inkSecondary,
  },
  notifCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    backgroundColor: "#FFFFFF",
  },
  notifIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  notifContent: {
    flex: 1,
    gap: 3,
  },
  notifItemTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  notifItemMeta: {
    fontSize: 12,
    color: FIGMA_INK.inkSecondary,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.43)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    maxHeight: "88%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  urlLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 6,
  },
  previewBtn: {
    backgroundColor: FIGMA_INK.bgMuted,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
  },
  previewBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
  chipInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  warningHeadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  warningBox: {
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    gap: 4,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#92400E",
  },
  warningText: {
    fontSize: 12,
    color: "#78350F",
    lineHeight: 18,
  },
  warningHint: {
    fontSize: 11,
    color: "#B45309",
    fontWeight: "600",
  },
  previewCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: FIGMA_INK.bgMuted,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
    gap: 10,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
  },
  previewThumb: {
    width: 54,
    height: 54,
    borderRadius: 10,
    backgroundColor: FIGMA_INK.bgThumb,
  },
  previewBody: {
    flex: 1,
    gap: 2,
  },
  previewPlat: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  previewTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14.5,
    color: FIGMA_INK.inkStrong,
  },
  textArea: {
    minHeight: 68,
    textAlignVertical: "top",
  },
  inlinePills: {
    flexDirection: "row",
    gap: 8,
  },
  subStrip: {
    marginTop: 2,
  },
  smallChip: {
    backgroundColor: "#EEEEEE",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    marginRight: 8,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: "#444444",
  },
  newFolderChip: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D4D4D8",
  },
  inlineFolderBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
  },
  inlineFolderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inlineCreateBtn: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineCreateBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13,
  },
  saveCta: {
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
    marginBottom: 8,
  },
  saveCtaText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 15.5,
  },
});
