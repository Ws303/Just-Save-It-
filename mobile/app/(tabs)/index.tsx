import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  createFolder,
  fetchWorkspace,
  flushOfflineQueue,
  getOfflineQueueCount,
  patchLinkItem,
  previewLinkUrl,
  saveLinkItem,
  type PreviewUrlResponsePayload,
} from "../../src/api";
import {
  formatCardDisplayTitle,
  getSocialPostLinkWarning,
  inferMobileContentType,
  inferMobileDomain,
  inferMobilePlatform,
  isGenericOrNoisyTitle,
  matchesItemSearch,
  matchesPlatformFilter,
  resolveMobileThumbUrl,
  scrubGenericPlatformTitle,
} from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadSession,
  type MobileFolderItem,
  type MobileLinkItem,
  type WorkflowStatus,
} from "../../src/storage";

const QUICK_FOLDER_ICONS = ["📁", "🍜", "☕", "🎬", "💻", "✈️", "🛍️", "💡"];

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  inbox: "กล่องรับ",
  todo: "รออ่าน",
  done: "อ่านแล้ว",
  archived: "เก็บถาวร",
};

function normalizeStatus(raw?: string): WorkflowStatus {
  const s = String(raw || "inbox").toLowerCase();
  if (s === "done" || s === "read") return "done";
  if (s === "todo") return "todo";
  if (s === "archived") return "archived";
  return "inbox";
}

function inferDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function HomeFeedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ sharedUrl?: string; sharedTitle?: string }>();
  const initialCache = getMemoryCachedWorkspace();

  const [displayName, setDisplayName] = useState("เพื่อน");
  const [items, setItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [folders, setFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [loading, setLoading] = useState<boolean>(() => !(initialCache?.items?.length || initialCache?.folders?.length));
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [queueCount, setQueueCount] = useState(0);

  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | WorkflowStatus>("all");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [contentTypeFilter, setContentTypeFilter] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);

  // Quick Save Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [saveUrl, setSaveUrl] = useState("");
  const [saveTitle, setSaveTitle] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [saveTags, setSaveTags] = useState("");
  const [saveFolderId, setSaveFolderId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<WorkflowStatus>("inbox");
  const [saving, setSaving] = useState(false);
  const [inlineFolderOpen, setInlineFolderOpen] = useState(false);
  const [inlineFolderName, setInlineFolderName] = useState("");
  const [inlineFolderIcon, setInlineFolderIcon] = useState("📁");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewUrlResponsePayload | null>(null);
  const saveSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const socialWarning = useMemo(() => getSocialPostLinkWarning(saveUrl), [saveUrl]);

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
    const nameFromProfile =
      (typeof ws.me?.display_name === "string" && ws.me.display_name) ||
      (typeof ws.me?.email === "string" && ws.me.email.split("@")[0]) ||
      sess.user?.display_name ||
      "เพื่อน";
    setDisplayName(nameFromProfile);
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

  const folderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders) {
      if (f?.id) map.set(f.id, f.name || "");
    }
    return map;
  }, [folders]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const wf = normalizeStatus(item.status);
      if (statusFilter !== "all" && wf !== statusFilter) return false;
      if (!matchesPlatformFilter(item, platformFilter)) return false;
      const ct = inferMobileContentType(item);
      if (contentTypeFilter !== "all" && ct !== contentTypeFilter.toLowerCase()) return false;
      const fName = item.folder_id ? folderNameById.get(item.folder_id) || "" : "";
      if (!matchesItemSearch(item, searchText, fName)) return false;
      return true;
    });
  }, [items, folderNameById, searchText, statusFilter, platformFilter, contentTypeFilter]);

  function closeQuickSaveModal() {
    setModalOpen(false);
    setInlineFolderOpen(false);
    setInlineFolderName("");
    setInlineFolderIcon("📁");
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
      const res = await createFolder(name, inlineFolderIcon || "📁");
      if (getAuthGeneration() !== startGen) return;
      if (!res.ok || !res.data) {
        Alert.alert("สร้างโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      const created = res.data;
      setFolders((prev) => [...prev.filter((f) => f.id !== created.id), created]);
      setSaveFolderId(created.id);
      setInlineFolderName("");
      setInlineFolderIcon("📁");
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
      if (isStale()) return;
      if (!res.ok) {
        Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่อีกครั้ง");
        return;
      }
      closeQuickSaveModal();
      setSaveUrl("");
      setSaveTitle("");
      setSaveNote("");
      setSaveTags("");
      setSaveFolderId(null);
      setSaveStatus("inbox");
      setPreviewData(null);
      if (res.queued) {
        Alert.alert("บันทึกเข้า Offline Queue แล้ว", "ระบบจะอัปโหลดขึ้น Cloud อัตโนมัติเมื่อออนไลน์");
      }
      void loadAll();
    });
  }

  async function toggleFavorite(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    const nextFav = !item.is_favorite;
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_favorite: nextFav } : it)));
    const res = await patchLinkItem(item.id, { is_favorite: nextFav });
    if (getAuthGeneration() !== startGen) return;
    if (!res.ok) {
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_favorite: !nextFav } : it)));
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.topHeader}>
        <View style={styles.greetingRow}>
          <View>
            <Text style={styles.greetingTitle}>สวัสดี, {displayName} 👋</Text>
            <Text style={styles.greetingSub}>
              ทั้งหมด {items.length} ลิงก์ {offline ? "• โหมดออฟไลน์" : "• Cloud ซิงก์แล้ว"}
              {queueCount > 0 ? ` • ค้างซิงก์ ${queueCount}` : ""}
            </Text>
          </View>
          <Pressable style={styles.addBtn} onPress={() => setModalOpen(true)}>
            <Text style={styles.addBtnText}>+ เก็บลิงก์</Text>
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="ค้นหาชื่อลิงก์ เว็บไซต์ หรือ #แท็ก..."
            placeholderTextColor="#A8A29E"
            value={searchText}
            onChangeText={setSearchText}
          />
          <Pressable
            style={[styles.filterToggleBtn, showFilters && styles.filterToggleBtnActive]}
            onPress={() => setShowFilters((v) => !v)}
          >
            <Text style={[styles.filterToggleText, showFilters && styles.filterToggleTextActive]}>
              ตัวกรอง
            </Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statusStrip}>
          {(["all", "inbox", "todo", "done", "archived"] as const).map((st) => {
            const active = statusFilter === st;
            return (
              <Pressable
                key={st}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setStatusFilter(st)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {st === "all" ? "ทั้งหมด" : STATUS_LABELS[st]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {showFilters ? (
          <View style={styles.drawer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subStrip}>
              {[
                { id: "all", label: "ทุกแพลตฟอร์ม" },
                { id: "youtube", label: "YouTube" },
                { id: "tiktok", label: "TikTok" },
                { id: "instagram", label: "IG" },
                { id: "facebook", label: "Facebook" },
                { id: "x", label: "X" },
                { id: "web", label: "เว็บไซต์" },
              ].map((pl) => {
                const active = platformFilter === pl.id;
                return (
                  <Pressable
                    key={pl.id}
                    style={[styles.smallChip, active && styles.chipActive]}
                    onPress={() => setPlatformFilter(pl.id)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{pl.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subStrip}>
              {[
                { id: "all", label: "ทุกประเภท" },
                { id: "video", label: "วิดีโอ" },
                { id: "social", label: "โซเชียล" },
                { id: "image", label: "รูปภาพ" },
                { id: "article", label: "บทความ" },
              ].map((ct) => {
                const active = contentTypeFilter === ct.id;
                return (
                  <Pressable
                    key={ct.id}
                    style={[styles.smallChip, active && styles.chipActive]}
                    onPress={() => setContentTypeFilter(ct.id)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{ct.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#9B2C2C" />
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(it) => it.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor="#9B2C2C"
              onRefresh={() => {
                setRefreshing(true);
                void loadAll();
              }}
            />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>ยังไม่มีลิงก์ที่ตรงกับตัวกรอง</Text>
              <Text style={styles.emptySub}>กดปุ่ม "+ เก็บลิงก์" หรือแชร์ลิงก์จากแอปอื่นเข้ามาได้เลย</Text>
            </View>
          }
          renderItem={({ item }) => {
            const wf = normalizeStatus(item.status);
            const thumbUri = resolveMobileThumbUrl(item);
            const platLabel = inferMobilePlatform(item);
            return (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/item/${encodeURIComponent(item.id)}`)}
              >
                {thumbUri ? (
                  <Image source={{ uri: thumbUri }} style={styles.thumb} resizeMode="cover" />
                ) : null}
                <View style={styles.cardBody}>
                  <View style={styles.cardMetaRow}>
                    <Text style={styles.platformBadge}>{platLabel || inferDomain(item.url)}</Text>
                    <View style={styles.statusPill}>
                      <Text style={styles.statusPillText}>{STATUS_LABELS[wf]}</Text>
                    </View>
                    <Pressable style={styles.starBtnWrap} hitSlop={8} onPress={() => void toggleFavorite(item)}>
                      <Text style={styles.starBtn}>{item.is_favorite ? "⭐" : "☆"}</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {formatCardDisplayTitle(item) || item.url}
                  </Text>
                  <Text style={styles.cardDomain} numberOfLines={1}>
                    {inferMobileDomain(item.url) || inferDomain(item.url)}
                  </Text>
                  {item.note || item.user_note ? (
                    <Text style={styles.cardNote} numberOfLines={2}>
                      {item.note || item.user_note}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <Modal visible={modalOpen} animationType="slide" transparent onRequestClose={closeQuickSaveModal}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.modalCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>+ เก็บลิงก์ด่วน</Text>
              <Pressable onPress={closeQuickSaveModal}>
                <Text style={styles.modalClose}>✕</Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <View style={styles.urlLabelRow}>
                <Text style={styles.label}>URL ลิงก์</Text>
                <Pressable
                  style={[styles.previewBtn, previewing && { opacity: 0.6 }]}
                  disabled={previewing || !saveUrl.trim()}
                  onPress={() => void handleFetchPreview(saveUrl)}
                >
                  <Text style={styles.previewBtnText}>
                    {previewing ? "กำลังดึง..." : "🔍 ดึงพรีวิว"}
                  </Text>
                </Pressable>
              </View>
              <TextInput
                style={styles.input}
                placeholder="https://..."
                placeholderTextColor="#A8A29E"
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
                  <Text style={styles.warningTitle}>⚠️ ลิงก์หน้าฟีด {socialWarning.platform}</Text>
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
                    <Text style={styles.previewPlat}>{previewData.platform || "web"}</Text>
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
                placeholderTextColor="#A8A29E"
                value={saveTitle}
                onChangeText={setSaveTitle}
              />
              <Text style={styles.label}>บันทึกเพิ่มเติม</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="จดโน้ตสั้นๆ..."
                placeholderTextColor="#A8A29E"
                multiline
                value={saveNote}
                onChangeText={setSaveNote}
              />
              <Text style={styles.label}>แท็ก (คั่นด้วยเว้นวรรคหรือลูกน้ำ)</Text>
              <TextInput
                style={styles.input}
                placeholder="#คาเฟ่ #ไอเดีย"
                placeholderTextColor="#A8A29E"
                value={saveTags}
                onChangeText={setSaveTags}
              />
              <Text style={styles.label}>สถานะ</Text>
              <View style={styles.inlinePills}>
                {(["inbox", "todo"] as const).map((st) => (
                  <Pressable
                    key={st}
                    style={[styles.chip, saveStatus === st && styles.chipActive]}
                    onPress={() => setSaveStatus(st)}
                  >
                    <Text style={[styles.chipText, saveStatus === st && styles.chipTextActive]}>
                      {STATUS_LABELS[st]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>โฟลเดอร์</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.subStrip}>
                <Pressable
                  style={[styles.smallChip, saveFolderId === null && styles.chipActive]}
                  onPress={() => setSaveFolderId(null)}
                >
                  <Text style={[styles.chipText, saveFolderId === null && styles.chipTextActive]}>
                    รวมไว้ดูทีหลัง
                  </Text>
                </Pressable>
                {folders.map((f) => (
                  <Pressable
                    key={f.id}
                    style={[styles.smallChip, saveFolderId === f.id && styles.chipActive]}
                    onPress={() => setSaveFolderId(f.id)}
                  >
                    <Text style={[styles.chipText, saveFolderId === f.id && styles.chipTextActive]}>
                      {f.emoji || f.icon || "📁"} {f.name}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={[styles.smallChip, styles.newFolderChip, inlineFolderOpen && styles.chipActive]}
                  onPress={() => setInlineFolderOpen((prev) => !prev)}
                >
                  <Text style={[styles.chipText, styles.newFolderChipText, inlineFolderOpen && styles.chipTextActive]}>
                    + สร้างโฟลเดอร์ใหม่
                  </Text>
                </Pressable>
              </ScrollView>
              {inlineFolderOpen ? (
                <View style={styles.inlineFolderBox}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.emojiStrip}>
                    {QUICK_FOLDER_ICONS.map((ic) => (
                      <Pressable
                        key={ic}
                        style={[styles.emojiChip, inlineFolderIcon === ic && styles.emojiChipActive]}
                        onPress={() => setInlineFolderIcon(ic)}
                      >
                        <Text style={styles.emojiChipText}>{ic}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  <View style={styles.inlineFolderRow}>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="ชื่อโฟลเดอร์ใหม่ เช่น คาเฟ่"
                      placeholderTextColor="#A8A29E"
                      value={inlineFolderName}
                      onChangeText={setInlineFolderName}
                    />
                    <Pressable
                      style={[styles.inlineCreateBtn, creatingFolder && { opacity: 0.65 }]}
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

              <Pressable
                style={[styles.saveCta, saving && { opacity: 0.7 }]}
                disabled={saving}
                onPress={() => void handleQuickSave()}
              >
                {saving ? (
                  <ActivityIndicator color="#FDFBF7" />
                ) : (
                  <Text style={styles.saveCtaText}>บันทึกลง Sharely</Text>
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
  root: { flex: 1, backgroundColor: "transparent" },
  topHeader: {
    backgroundColor: "#FDFBF7",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#EAE4DB",
  },
  greetingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  greetingTitle: { fontSize: 18, fontWeight: "800", color: "#1C1917" },
  greetingSub: { fontSize: 12, color: "#78716C", marginTop: 2 },
  addBtn: { backgroundColor: "#9B2C2C", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  addBtnText: { color: "#FDFBF7", fontWeight: "700", fontSize: 13 },
  searchRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  searchInput: {
    flex: 1,
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: "#1C1917",
  },
  filterToggleBtn: {
    borderWidth: 1,
    borderColor: "#D6CFC4",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: "#FFFFFF",
  },
  filterToggleBtnActive: { backgroundColor: "#9B2C2C", borderColor: "#9B2C2C" },
  filterToggleText: { fontSize: 13, fontWeight: "600", color: "#44403C" },
  filterToggleTextActive: { color: "#FDFBF7" },
  statusStrip: { marginTop: 10 },
  drawer: { marginTop: 8, gap: 6 },
  subStrip: { marginTop: 4 },
  chip: {
    backgroundColor: "#F3EFE6",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    marginRight: 8,
  },
  smallChip: {
    backgroundColor: "#F3EFE6",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    marginRight: 8,
  },
  chipActive: { backgroundColor: "#9B2C2C" },
  chipText: { fontSize: 13, fontWeight: "600", color: "#57534E" },
  chipTextActive: { color: "#FDFBF7" },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: 16, gap: 12 },
  emptyBox: { padding: 36, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#44403C" },
  emptySub: { fontSize: 13, color: "#78716C", textAlign: "center", marginTop: 6 },
  card: {
    backgroundColor: "#FDFBF7",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    overflow: "hidden",
  },
  thumb: { width: "100%", height: 150, backgroundColor: "#EAE4DB" },
  cardBody: { padding: 14 },
  cardMetaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  platformBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: "#9B2C2C",
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    textTransform: "uppercase",
  },
  statusPill: {
    backgroundColor: "#F3EFE6",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  statusPillText: { fontSize: 11, fontWeight: "600", color: "#57534E" },
  starBtnWrap: { marginLeft: "auto" },
  starBtn: { fontSize: 18 },
  cardTitle: { fontSize: 16, fontWeight: "700", color: "#1C1917", marginBottom: 4 },
  cardDomain: { fontSize: 12, color: "#78716C" },
  cardNote: { fontSize: 13, color: "#44403C", marginTop: 6 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FDFBF7",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: "88%",
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#1C1917" },
  modalClose: { fontSize: 20, color: "#78716C", paddingHorizontal: 6 },
  urlLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6, marginBottom: 4 },
  previewBtn: {
    backgroundColor: "#F3EFE6",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D6CFC4",
  },
  previewBtnText: { fontSize: 12, fontWeight: "700", color: "#9B2C2C" },
  warningBox: {
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    gap: 4,
  },
  warningTitle: { fontSize: 13, fontWeight: "800", color: "#92400E" },
  warningText: { fontSize: 12, color: "#78350F", lineHeight: 18 },
  warningHint: { fontSize: 11, color: "#B45309", fontWeight: "600" },
  previewCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
    gap: 10,
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  previewThumb: { width: 54, height: 54, borderRadius: 8, backgroundColor: "#E7E0D5" },
  previewBody: { flex: 1, gap: 2 },
  previewPlat: { fontSize: 10, fontWeight: "700", color: "#9B2C2C", textTransform: "uppercase" },
  previewTitle: { fontSize: 13, fontWeight: "700", color: "#1C1917" },
  label: { fontSize: 13, fontWeight: "600", color: "#44403C", marginTop: 10, marginBottom: 6 },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#1C1917",
  },
  textArea: { minHeight: 72, textAlignVertical: "top" },
  inlinePills: { flexDirection: "row", marginTop: 2 },
  newFolderChip: { borderWidth: 1, borderColor: "#D6CFC4", backgroundColor: "#FFFFFF" },
  newFolderChipText: { color: "#9B2C2C" },
  inlineFolderBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "#F3EFE6",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    gap: 8,
  },
  emojiStrip: { marginBottom: 2 },
  emojiChip: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    borderWidth: 1,
    borderColor: "#E7E0D5",
  },
  emojiChipActive: { borderColor: "#9B2C2C", backgroundColor: "#FEF2F2" },
  emojiChipText: { fontSize: 16 },
  inlineFolderRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  inlineCreateBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineCreateBtnText: { color: "#FDFBF7", fontWeight: "700", fontSize: 13 },
  saveCta: {
    backgroundColor: "#9B2C2C",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
    marginBottom: 12,
  },
  saveCtaText: { color: "#FDFBF7", fontWeight: "700", fontSize: 16 },
});
