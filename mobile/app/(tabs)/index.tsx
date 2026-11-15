import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  fetchWorkspace,
  flushOfflineQueue,
  getOfflineQueueCount,
  patchLinkItem,
  saveLinkItem,
} from "../../src/api";
import type { MobileFolderItem, MobileLinkItem, WorkflowStatus } from "../../src/storage";

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
  const params = useLocalSearchParams<{ sharedUrl?: string; sharedTitle?: string }>();

  const [displayName, setDisplayName] = useState("เพื่อน");
  const [items, setItems] = useState<MobileLinkItem[]>([]);
  const [folders, setFolders] = useState<MobileFolderItem[]>([]);
  const [loading, setLoading] = useState(true);
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

  const loadAll = useCallback(async () => {
    const flushed = await flushOfflineQueue();
    const pendingCount = flushed.remaining || (await getOfflineQueueCount());
    setQueueCount(pendingCount);

    const ws = await fetchWorkspace();
    setOffline(ws.offline);
    setItems(ws.items);
    setFolders(ws.folders);
    const nameFromProfile =
      (typeof ws.me?.display_name === "string" && ws.me.display_name) ||
      (typeof ws.me?.email === "string" && ws.me.email.split("@")[0]) ||
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

  useEffect(() => {
    if (typeof params.sharedUrl === "string" && params.sharedUrl.trim()) {
      setSaveUrl(params.sharedUrl.trim());
      setSaveTitle(typeof params.sharedTitle === "string" ? params.sharedTitle : "");
      setModalOpen(true);
    }
  }, [params.sharedUrl, params.sharedTitle]);

  const filteredItems = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return items.filter((item) => {
      const wf = normalizeStatus(item.status);
      if (statusFilter !== "all" && wf !== statusFilter) return false;
      const plat = String(item.platform || "web").toLowerCase();
      if (platformFilter !== "all" && plat !== platformFilter.toLowerCase()) return false;
      const ct = String(item.content_type || "article").toLowerCase();
      if (contentTypeFilter !== "all" && ct !== contentTypeFilter.toLowerCase()) return false;
      if (q) {
        const hay = `${item.title || ""} ${item.url || ""} ${item.note || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, searchText, statusFilter, platformFilter, contentTypeFilter]);

  async function handleQuickSave() {
    const cleanUrl = saveUrl.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      Alert.alert("URL ไม่ถูกต้อง", "กรุณาระบุลิงก์ที่ขึ้นต้นด้วย http:// หรือ https://");
      return;
    }
    setSaving(true);
    const parsedTags = saveTags
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);

    const res = await saveLinkItem({
      url: cleanUrl,
      title: saveTitle.trim() || undefined,
      note: saveNote.trim() || undefined,
      tags: parsedTags.length ? parsedTags : undefined,
      folder_id: saveFolderId,
      status: saveStatus,
    });
    setSaving(false);
    if (!res.ok) {
      Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่อีกครั้ง");
      return;
    }
    setModalOpen(false);
    setSaveUrl("");
    setSaveTitle("");
    setSaveNote("");
    setSaveTags("");
    setSaveFolderId(null);
    setSaveStatus("inbox");
    if (res.queued) {
      Alert.alert("บันทึกเข้า Offline Queue แล้ว", "ระบบจะอัปโหลดขึ้น Cloud อัตโนมัติเมื่อออนไลน์");
    }
    void loadAll();
  }

  async function toggleFavorite(item: MobileLinkItem) {
    const nextFav = !item.is_favorite;
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_favorite: nextFav } : it)));
    const res = await patchLinkItem(item.id, { is_favorite: nextFav });
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
              {["all", "tiktok", "youtube", "facebook", "instagram", "web"].map((pl) => {
                const active = platformFilter === pl;
                return (
                  <Pressable
                    key={pl}
                    style={[styles.smallChip, active && styles.chipActive]}
                    onPress={() => setPlatformFilter(pl)}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {pl === "all" ? "ทุกแพลตฟอร์ม" : pl}
                    </Text>
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
            return (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/item/${encodeURIComponent(item.id)}`)}
              >
                {item.thumbnail_url ? (
                  <Image source={{ uri: item.thumbnail_url }} style={styles.thumb} resizeMode="cover" />
                ) : null}
                <View style={styles.cardBody}>
                  <View style={styles.cardMetaRow}>
                    <Text style={styles.platformBadge}>{item.platform || inferDomain(item.url)}</Text>
                    <View style={styles.statusPill}>
                      <Text style={styles.statusPillText}>{STATUS_LABELS[wf]}</Text>
                    </View>
                    <Pressable hitSlop={8} onPress={() => void toggleFavorite(item)}>
                      <Text style={styles.starBtn}>{item.is_favorite ? "⭐" : "☆"}</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {item.title || item.url}
                  </Text>
                  <Text style={styles.cardDomain} numberOfLines={1}>
                    {inferDomain(item.url)}
                  </Text>
                  {item.note ? (
                    <Text style={styles.cardNote} numberOfLines={2}>
                      {item.note}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <Modal visible={modalOpen} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>+ เก็บลิงก์ด่วน</Text>
              <Pressable onPress={() => setModalOpen(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>URL ลิงก์</Text>
              <TextInput
                style={styles.input}
                placeholder="https://..."
                placeholderTextColor="#A8A29E"
                autoCapitalize="none"
                value={saveUrl}
                onChangeText={setSaveUrl}
              />
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
              {folders.length > 0 ? (
                <>
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
                          {f.icon || "📁"} {f.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
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
        </View>
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
  starBtn: { fontSize: 18, marginLeft: "auto" },
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
