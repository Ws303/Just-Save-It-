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
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  createFolder,
  deleteFolder,
  fetchWorkspace,
  resolveFolderCoverUrl,
  updateFolder,
  uploadFolderCover,
} from "../../src/api";
import { FIGMA_INK, getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import { resolveMobileThumbUrl } from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadFigmaAccentTheme,
  loadSession,
  subscribeFigmaAccentTheme,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

interface FolderCardRow {
  id: string;
  name: string;
  count: number;
  cover: string;
  collageThumbs: string[];
  customCoverUrl: string | null;
  isVirtual: boolean;
  isShared: boolean;
}

export default function FoldersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const initialCache = getMemoryCachedWorkspace();

  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

  const [folders, setFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [items, setItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [loading, setLoading] = useState<boolean>(
    () => !(initialCache?.folders?.length || initialCache?.items?.length),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [coverDraft, setCoverDraft] = useState<string | null>(null);
  const [hasExistingCustomCover, setHasExistingCustomCover] = useState(false);
  const [resetCover, setResetCover] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const actionSeqRef = useRef(0);
  const coverSeqRef = useRef(0);
  const modalSessionRef = useRef(0);

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  const loadData = useCallback(async () => {
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
    if (cached.folders.length > 0 || cached.items.length > 0) {
      setFolders((prev) => (prev.length ? prev : cached.folders));
      setItems((prev) => (prev.length ? prev : cached.items));
      setLoading(false);
    }
    const ws = await fetchWorkspace();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setFolders(ws.folders);
    setItems(ws.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  function openCreateModal() {
    modalSessionRef.current += 1;
    setEditingFolderId(null);
    setNewName("");
    setCoverDraft(null);
    setHasExistingCustomCover(false);
    setResetCover(false);
    setCoverUploading(false);
    setModalOpen(true);
  }

  function openEditModal(card: FolderCardRow) {
    if (card.isVirtual || card.isShared) return;
    modalSessionRef.current += 1;
    setEditingFolderId(card.id);
    setNewName(card.name);
    setCoverDraft(resolveFolderCoverUrl(card.customCoverUrl) || null);
    setHasExistingCustomCover(Boolean(card.customCoverUrl));
    setResetCover(false);
    setCoverUploading(false);
    setModalOpen(true);
  }

  function closeModal() {
    modalSessionRef.current += 1;
    setModalOpen(false);
    setEditingFolderId(null);
    setCoverUploading(false);
  }

  async function handlePickCover() {
    if (coverUploading || saving) return;
    const startGen = getAuthGeneration();
    const modalSess = modalSessionRef.current;
    const uploadSeq = (coverSeqRef.current += 1);
    const isStaleUpload = () =>
      getAuthGeneration() !== startGen ||
      modalSessionRef.current !== modalSess ||
      coverSeqRef.current !== uploadSeq;

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [16, 10],
        quality: 0.85,
        base64: true,
      });
      if (isStaleUpload() || result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert("อ่านไฟล์รูปไม่สำเร็จ", "กรุณาเลือกรูปภาพใหม่อีกครั้ง");
        return;
      }
      const mime = asset.mimeType && asset.mimeType.startsWith("image/") ? asset.mimeType : "image/jpeg";
      const dataUri = `data:${mime};base64,${asset.base64}`;
      setCoverUploading(true);
      const res = await uploadFolderCover(dataUri, asset.fileName || "cover.jpg");
      if (isStaleUpload()) return;
      setCoverUploading(false);
      if (!res.ok || !res.data?.cover_url) {
        Alert.alert("อัปโหลดภาพปกไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setCoverDraft(res.data.cover_url);
      setResetCover(false);
    } catch {
      if (isStaleUpload()) return;
      setCoverUploading(false);
      Alert.alert("ไม่สามารถเปิดคลังรูปภาพได้", "กรุณาตรวจสอบสิทธิ์การเข้าถึงรูปภาพในเครื่อง");
    }
  }

  function handleDeleteEditingFolder() {
    const targetEditId = editingFolderId;
    if (!targetEditId || saving) return;
    const modalGen = getAuthGeneration();
    Alert.alert("ลบโฟลเดอร์นี้?", "ลิงก์ภายในโฟลเดอร์จะยังคงอยู่ในคลังของคุณ (ย้ายเป็นยังไม่จัดหมวด)", [
      { text: "ยกเลิก", style: "cancel" },
      {
        text: "ลบโฟลเดอร์",
        style: "destructive",
        onPress: () => {
          if (getAuthGeneration() !== modalGen) return;
          void runGuardedBusyAction(actionSeqRef, setSaving, async (isStale) => {
            const res = await deleteFolder(targetEditId);
            if (isStale()) return;
            if (!res.ok) {
              Alert.alert("ลบโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
              return;
            }
            closeModal();
            void loadData();
          });
        },
      },
    ]);
  }

  function handleResetCover() {
    setCoverDraft(null);
    setResetCover(true);
  }

  async function handleSaveFolder() {
    if (!newName.trim()) {
      Alert.alert("กรุณาระบุชื่อโฟลเดอร์");
      return;
    }
    if (coverUploading) {
      Alert.alert("กำลังอัปโหลดภาพปก", "กรุณารอสักครู่");
      return;
    }
    const targetEditId = editingFolderId;
    await runGuardedBusyAction(actionSeqRef, setSaving, async (isStale) => {
      const res = targetEditId
        ? await updateFolder(targetEditId, {
            name: newName,
            ...(coverDraft ? { cover_url: coverDraft } : resetCover ? { cover_url: null } : {}),
          })
        : await createFolder(newName, "", coverDraft ? coverDraft : undefined);
      if (isStale()) return;
      if (!res.ok) {
        Alert.alert(targetEditId ? "แก้ไขโฟลเดอร์ไม่สำเร็จ" : "สร้างโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setNewName("");
      setCoverDraft(null);
      setHasExistingCustomCover(false);
      setResetCover(false);
      setEditingFolderId(null);
      setModalOpen(false);
      void loadData();
    });
  }

  const cards = useMemo<FolderCardRow[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const unfolderedItems = items.filter((it) => !it.folder_id);
    const unfolderedThumbs = unfolderedItems
      .map((it) => resolveMobileThumbUrl(it))
      .filter(Boolean)
      .slice(0, 4);

    const allCards: FolderCardRow[] = [
      {
        id: "virtual-inbox",
        name: "รวมไว้ดูทีหลัง",
        count: unfolderedItems.length,
        cover: unfolderedThumbs[0] || "",
        collageThumbs: unfolderedThumbs,
        customCoverUrl: null,
        isVirtual: true,
        isShared: false,
      },
      ...folders.map((f) => {
        const folderItems = items.filter((it) => it.folder_id === f.id);
        const thumbs = folderItems.map((it) => resolveMobileThumbUrl(it)).filter(Boolean).slice(0, 4);
        const explicitCover = resolveFolderCoverUrl(f.cover_url);
        return {
          id: f.id,
          name: f.name,
          count: typeof f.item_count === "number" ? f.item_count : folderItems.length,
          cover: explicitCover || thumbs[0] || "",
          collageThumbs: explicitCover ? [] : thumbs,
          customCoverUrl: f.cover_url ?? null,
          isVirtual: false,
          isShared: Boolean(f.role && f.role !== "owner"),
        };
      }),
    ];

    if (!q) return allCards;
    return allCards.filter((c) => c.name.toLowerCase().includes(q));
  }, [folders, items, searchQuery]);

  const isEditing = Boolean(editingFolderId);

  return (
    <View style={[styles.root, { paddingTop: Math.max(10, insets.top) }]}>
      <View style={styles.topbar}>
        <Text style={styles.brandHeading}>โฟลเดอร์</Text>
        <Pressable
          style={[styles.createBtn, { backgroundColor: theme.accent }]}
          onPress={openCreateModal}
        >
          <Ionicons name="add" size={16} color="#FFFFFF" />
          <Text style={styles.createBtnText}>สร้างโฟลเดอร์</Text>
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={18} color={FIGMA_INK.inkStrong} />
          <TextInput
            style={styles.searchInput}
            placeholder="ค้นหาชื่อโฟลเดอร์"
            placeholderTextColor="#8B9199"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery ? (
            <Pressable hitSlop={8} onPress={() => setSearchQuery("")}>
              <Ionicons name="close-circle" size={17} color="#9CA3AF" />
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.sectionTitle}>โฟลเดอร์ทั้งหมด</Text>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={cards}
          keyExtractor={(c) => c.id}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[
            styles.gridContent,
            { paddingBottom: 112 + insets.bottom },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={theme.accent}
              onRefresh={() => {
                setRefreshing(true);
                void loadData();
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>ไม่พบโฟลเดอร์ที่ตรงกับคำค้นหา</Text>
            </View>
          }
          renderItem={({ item }) => {
            const showCollage =
              !resolveFolderCoverUrl(item.customCoverUrl) &&
              (item.isVirtual || item.collageThumbs.length >= 2);
            const subtitle = item.isVirtual
              ? `${item.count} ลิงก์ · ยังไม่จัดหมวด`
              : `${item.count} ลิงก์ · ${item.isShared ? "โฟลเดอร์ที่แชร์" : "ส่วนตัว"}`;

            return (
              <Pressable
                style={styles.folderCard}
                onPress={() => router.push(`/folder/${encodeURIComponent(item.id)}`)}
              >
                <View style={styles.coverBox}>
                  {showCollage ? (
                    <View style={styles.collageGrid}>
                      {[0, 1, 2, 3].map((idx) => (
                        <View key={`cell-${item.id}-${idx}`} style={styles.collageCell}>
                          {item.collageThumbs[idx] ? (
                            <Image
                              source={{ uri: item.collageThumbs[idx] }}
                              style={styles.folderCoverImg}
                              resizeMode="cover"
                            />
                          ) : (
                            <Ionicons name="image-outline" size={14} color="#9CA3AF" />
                          )}
                        </View>
                      ))}
                    </View>
                  ) : item.cover ? (
                    <Image source={{ uri: item.cover }} style={styles.folderCoverImg} resizeMode="cover" />
                  ) : (
                    <Ionicons
                      name={item.isVirtual ? "bookmark-outline" : "folder-outline"}
                      size={28}
                      color="#78716C"
                    />
                  )}
                  {!item.isVirtual && !item.isShared ? (
                    <Pressable
                      style={styles.cardEditBtn}
                      hitSlop={8}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        openEditModal(item);
                      }}
                    >
                      <Ionicons name="pencil-outline" size={14} color={FIGMA_INK.inkStrong} />
                    </Pressable>
                  ) : null}
                </View>
                <Text style={styles.folderName} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={styles.folderMeta} numberOfLines={1}>
                  {subtitle}
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      <Modal visible={modalOpen} animationType="fade" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.modalHeadRow}>
                <Text style={styles.modalTitle}>
                  {isEditing ? "แก้ไขโฟลเดอร์" : "+ สร้างโฟลเดอร์ใหม่"}
                </Text>
                <Pressable hitSlop={8} onPress={closeModal}>
                  <Ionicons name="close" size={20} color="#666666" />
                </Pressable>
              </View>
              <Text style={styles.label}>ภาพปกโฟลเดอร์ (อัปโหลดเองหรือใช้อัตโนมัติ)</Text>
              <View style={styles.modalCoverRow}>
                <View style={styles.modalCoverPreview}>
                  {coverDraft && !resetCover ? (
                    <Image source={{ uri: coverDraft }} style={styles.folderCoverImg} resizeMode="cover" />
                  ) : (
                    <Ionicons name="folder-outline" size={24} color="#78716C" />
                  )}
                </View>
                <View style={styles.modalCoverActions}>
                  <Pressable
                    style={[styles.coverPickBtn, coverUploading && { opacity: 0.7 }]}
                    disabled={coverUploading}
                    onPress={() => void handlePickCover()}
                  >
                    <View style={styles.coverPickInner}>
                      <Ionicons name="image-outline" size={14} color={FIGMA_INK.aiInk} />
                      <Text style={styles.coverPickBtnText}>
                        {coverUploading ? "กำลังอัปโหลด..." : "เลือกรูปจากเครื่อง"}
                      </Text>
                    </View>
                  </Pressable>
                  {coverDraft || (hasExistingCustomCover && !resetCover) ? (
                    <Pressable style={styles.coverResetBtn} onPress={handleResetCover}>
                      <Text style={styles.coverResetBtnText}>ใช้ภาพปกอัตโนมัติ</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              <Text style={styles.label}>ชื่อโฟลเดอร์</Text>
              <TextInput
                style={styles.input}
                placeholder="เช่น คาเฟ่ห้ามพลาด"
                placeholderTextColor="#9CA3AF"
                value={newName}
                onChangeText={setNewName}
              />
              <View style={styles.modalActions}>
                <Pressable style={styles.cancelBtn} onPress={closeModal}>
                  <Text style={styles.cancelBtnText}>ยกเลิก</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.confirmBtn,
                    { backgroundColor: theme.accent },
                    (saving || coverUploading) && { opacity: 0.7 },
                  ]}
                  disabled={saving || coverUploading}
                  onPress={() => void handleSaveFolder()}
                >
                  <Text style={styles.confirmBtnText}>
                    {saving ? "กำลังบันทึก..." : isEditing ? "บันทึก" : "สร้าง"}
                  </Text>
                </Pressable>
              </View>
              {isEditing ? (
                <Pressable
                  style={styles.deleteFolderBtn}
                  disabled={saving}
                  onPress={handleDeleteEditingFolder}
                >
                  <Ionicons name="trash-outline" size={15} color="#B91C1C" />
                  <Text style={styles.deleteFolderBtnText}>ลบโฟลเดอร์นี้</Text>
                </Pressable>
              ) : null}
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
  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
  },
  brandHeading: {
    fontSize: 26,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
    letterSpacing: -0.4,
  },
  createBtn: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  createBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 13.5,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 10,
    gap: 12,
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
  sectionTitle: {
    fontSize: 16.5,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  gridContent: {
    paddingHorizontal: 16,
    gap: 12,
  },
  gridRow: {
    gap: 12,
  },
  folderCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 8,
    borderWidth: 1,
    borderColor: "#E2E2E6",
    minHeight: 168,
  },
  coverBox: {
    height: 100,
    borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
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
  folderCoverImg: {
    width: "100%",
    height: "100%",
  },
  cardEditBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  folderName: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
    marginTop: 8,
  },
  folderMeta: {
    fontSize: 12,
    color: FIGMA_INK.inkSubtle,
    marginTop: 2,
  },
  emptyBox: {
    padding: 36,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: FIGMA_INK.inkSecondary,
  },
  modalCoverRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 4,
  },
  modalCoverPreview: {
    width: 96,
    height: 62,
    borderRadius: 12,
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderLight,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  modalCoverActions: {
    flex: 1,
    gap: 6,
  },
  coverPickBtn: {
    backgroundColor: FIGMA_INK.lavenderBg,
    borderWidth: 1,
    borderColor: FIGMA_INK.lavenderBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
  },
  coverPickInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  coverPickBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: FIGMA_INK.aiInk,
  },
  coverResetBtn: {
    backgroundColor: FIGMA_INK.bgMuted,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: "center",
  },
  coverResetBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: FIGMA_INK.inkSecondary,
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
    maxHeight: "88%",
  },
  modalHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: FIGMA_INK.inkStrong,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 16,
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
  confirmBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  confirmBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  deleteFolderBtn: {
    marginTop: 14,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  deleteFolderBtnText: {
    color: "#B91C1C",
    fontSize: 13.5,
    fontWeight: "700",
  },
});
