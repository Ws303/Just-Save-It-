import React, { useCallback, useRef, useState } from "react";
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
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import { createFolder, fetchWorkspace, resolveFolderCoverUrl, updateFolder, uploadFolderCover } from "../../src/api";
import { resolveMobileThumbUrl } from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadSession,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

const ICON_CHOICES = ["📁", "☕", "🍜", "🎬", "✈️", "📚", "💡", "🛒"];

interface FolderCardRow {
  id: string;
  name: string;
  icon: string;
  count: number;
  cover: string;
  customCoverUrl: string | null;
  isVirtual: boolean;
}

export default function FoldersScreen() {
  const router = useRouter();
  const initialCache = getMemoryCachedWorkspace();
  const [folders, setFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [items, setItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [loading, setLoading] = useState<boolean>(() => !(initialCache?.folders?.length || initialCache?.items?.length));
  const [refreshing, setRefreshing] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("📁");
  const [coverDraft, setCoverDraft] = useState<string | null>(null);
  const [hasExistingCustomCover, setHasExistingCustomCover] = useState(false);
  const [resetCover, setResetCover] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const actionSeqRef = useRef(0);

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
    setEditingFolderId(null);
    setNewName("");
    setNewIcon("📁");
    setCoverDraft(null);
    setHasExistingCustomCover(false);
    setResetCover(false);
    setModalOpen(true);
  }

  function openEditModal(card: FolderCardRow) {
    if (card.isVirtual) return;
    setEditingFolderId(card.id);
    setNewName(card.name);
    setNewIcon(card.icon || "📁");
    setCoverDraft(resolveFolderCoverUrl(card.customCoverUrl) || null);
    setHasExistingCustomCover(Boolean(card.customCoverUrl));
    setResetCover(false);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingFolderId(null);
    setCoverUploading(false);
  }

  async function handlePickCover() {
    if (coverUploading || saving) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [16, 10],
        quality: 0.85,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert("อ่านไฟล์รูปไม่สำเร็จ", "กรุณาเลือกรูปภาพใหม่อีกครั้ง");
        return;
      }
      const mime = asset.mimeType && asset.mimeType.startsWith("image/") ? asset.mimeType : "image/jpeg";
      const dataUri = `data:${mime};base64,${asset.base64}`;
      setCoverUploading(true);
      const res = await uploadFolderCover(dataUri, asset.fileName || "cover.jpg");
      setCoverUploading(false);
      if (!res.ok || !res.data?.cover_url) {
        Alert.alert("อัปโหลดภาพปกไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setCoverDraft(res.data.cover_url);
      setResetCover(false);
    } catch {
      setCoverUploading(false);
      Alert.alert("ไม่สามารถเปิดคลังรูปภาพได้", "กรุณาตรวจสอบสิทธิ์การเข้าถึงรูปภาพในเครื่อง");
    }
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
            emoji: newIcon,
            ...(coverDraft ? { cover_url: coverDraft } : resetCover ? { cover_url: null } : {}),
          })
        : await createFolder(newName, newIcon, coverDraft ? coverDraft : undefined);
      if (isStale()) return;
      if (!res.ok) {
        Alert.alert(targetEditId ? "แก้ไขโฟลเดอร์ไม่สำเร็จ" : "สร้างโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setNewName("");
      setNewIcon("📁");
      setCoverDraft(null);
      setHasExistingCustomCover(false);
      setResetCover(false);
      setEditingFolderId(null);
      setModalOpen(false);
      void loadData();
    });
  }

  const unfolderedItems = items.filter((it) => !it.folder_id);
  const unfolderedCover = unfolderedItems.map((it) => resolveMobileThumbUrl(it)).find(Boolean) || "";

  const cards: FolderCardRow[] = [
    {
      id: "virtual-inbox",
      name: "รวมไว้ดูทีหลัง",
      icon: "🔖",
      count: unfolderedItems.length,
      cover: unfolderedCover,
      customCoverUrl: null,
      isVirtual: true,
    },
    ...folders.map((f) => {
      const folderItems = items.filter((it) => it.folder_id === f.id);
      const firstThumb = folderItems.map((it) => resolveMobileThumbUrl(it)).find(Boolean) || "";
      const explicitCover = resolveFolderCoverUrl(f.cover_url);
      return {
        id: f.id,
        name: f.name,
        icon: f.emoji || f.icon || "📁",
        count: typeof f.item_count === "number" ? f.item_count : folderItems.length,
        cover: explicitCover || firstThumb,
        customCoverUrl: f.cover_url ?? null,
        isVirtual: false,
      };
    }),
  ];

  const isEditing = Boolean(editingFolderId);

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.heading}>โฟลเดอร์ทั้งหมด</Text>
          <Text style={styles.subheading}>{folders.length} โฟลเดอร์ส่วนตัว & แชร์</Text>
        </View>
        <Pressable style={styles.createBtn} onPress={openCreateModal}>
          <Text style={styles.createBtnText}>+ สร้างโฟลเดอร์</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#9B2C2C" />
        </View>
      ) : (
        <FlatList
          data={cards}
          keyExtractor={(c) => c.id}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.gridContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor="#9B2C2C"
              onRefresh={() => {
                setRefreshing(true);
                void loadData();
              }}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.folderCard}
              onPress={() => router.push(`/folder/${encodeURIComponent(item.id)}`)}
            >
              <View style={styles.coverBox}>
                {item.cover ? (
                  <Image source={{ uri: item.cover }} style={styles.folderCoverImg} resizeMode="cover" />
                ) : (
                  <Text style={styles.folderIcon}>{item.icon}</Text>
                )}
                {item.cover ? (
                  <View style={styles.coverEmojiBadge}>
                    <Text style={styles.coverEmojiBadgeText}>{item.icon}</Text>
                  </View>
                ) : null}
                {!item.isVirtual ? (
                  <Pressable
                    style={styles.cardEditBtn}
                    hitSlop={8}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      openEditModal(item);
                    }}
                  >
                    <Text style={styles.cardEditBtnText}>✎</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.folderName} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.folderCount}>{item.count} รายการ</Text>
            </Pressable>
          )}
        />
      )}

      <Modal visible={modalOpen} animationType="fade" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.modalTitle}>
                {isEditing ? "แก้ไขโฟลเดอร์" : "+ สร้างโฟลเดอร์ใหม่"}
              </Text>
              <Text style={styles.label}>ภาพปกโฟลเดอร์ (อัปโหลดเองหรือใช้อัตโนมัติ)</Text>
              <View style={styles.modalCoverRow}>
                <View style={styles.modalCoverPreview}>
                  {coverDraft && !resetCover ? (
                    <Image source={{ uri: coverDraft }} style={styles.folderCoverImg} resizeMode="cover" />
                  ) : (
                    <Text style={styles.modalCoverPlaceholder}>{newIcon}</Text>
                  )}
                </View>
                <View style={styles.modalCoverActions}>
                  <Pressable
                    style={[styles.coverPickBtn, coverUploading && { opacity: 0.7 }]}
                    disabled={coverUploading}
                    onPress={() => void handlePickCover()}
                  >
                    <Text style={styles.coverPickBtnText}>
                      {coverUploading ? "กำลังอัปโหลด..." : "🖼️ เลือกรูปจากเครื่อง"}
                    </Text>
                  </Pressable>
                  {coverDraft || (hasExistingCustomCover && !resetCover) ? (
                    <Pressable style={styles.coverResetBtn} onPress={handleResetCover}>
                      <Text style={styles.coverResetBtnText}>ใช้ภาพปกอัตโนมัติ</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              <Text style={styles.label}>เลือกไอคอน</Text>
              <View style={styles.iconRow}>
                {ICON_CHOICES.map((ic) => (
                  <Pressable
                    key={ic}
                    style={[styles.iconChip, newIcon === ic && styles.iconChipActive]}
                    onPress={() => setNewIcon(ic)}
                  >
                    <Text style={styles.iconText}>{ic}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>ชื่อโฟลเดอร์</Text>
              <TextInput
                style={styles.input}
                placeholder="เช่น คาเฟ่ห้ามพลาด"
                placeholderTextColor="#A8A29E"
                value={newName}
                onChangeText={setNewName}
              />
              <View style={styles.modalActions}>
                <Pressable style={styles.cancelBtn} onPress={closeModal}>
                  <Text style={styles.cancelBtnText}>ยกเลิก</Text>
                </Pressable>
                <Pressable
                  style={[styles.confirmBtn, (saving || coverUploading) && { opacity: 0.7 }]}
                  disabled={saving || coverUploading}
                  onPress={() => void handleSaveFolder()}
                >
                  <Text style={styles.confirmBtnText}>
                    {saving ? "กำลังบันทึก..." : isEditing ? "บันทึก" : "สร้าง"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: "#FDFBF7",
    borderBottomWidth: 1,
    borderBottomColor: "#EAE4DB",
  },
  heading: { fontSize: 18, fontWeight: "800", color: "#1C1917" },
  subheading: { fontSize: 12, color: "#78716C", marginTop: 2 },
  createBtn: { backgroundColor: "#9B2C2C", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  createBtnText: { color: "#FDFBF7", fontWeight: "700", fontSize: 13 },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center" },
  gridContent: { padding: 14, gap: 12, paddingBottom: 100 },
  gridRow: { gap: 12 },
  folderCard: {
    flex: 1,
    backgroundColor: "#FDFBF7",
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    minHeight: 158,
    justifyContent: "space-between",
  },
  coverBox: {
    height: 86,
    borderRadius: 12,
    backgroundColor: "#F3EFE6",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
  },
  folderCoverImg: {
    width: "100%",
    height: "100%",
  },
  coverEmojiBadge: {
    position: "absolute",
    bottom: 6,
    left: 6,
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: "rgba(253, 251, 247, 0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  coverEmojiBadgeText: { fontSize: 14 },
  cardEditBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(253, 251, 247, 0.94)",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    alignItems: "center",
    justifyContent: "center",
  },
  cardEditBtnText: { fontSize: 13, fontWeight: "700", color: "#44403C" },
  folderIcon: { fontSize: 30 },
  folderName: { fontSize: 15, fontWeight: "700", color: "#1C1917", marginTop: 10 },
  folderCount: { fontSize: 12, color: "#78716C", marginTop: 4 },
  modalCoverRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  modalCoverPreview: {
    width: 96,
    height: 62,
    borderRadius: 12,
    backgroundColor: "#F3EFE6",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  modalCoverPlaceholder: { fontSize: 24 },
  modalCoverActions: { flex: 1, gap: 6 },
  coverPickBtn: {
    backgroundColor: "#F1EEFF",
    borderWidth: 1,
    borderColor: "#DDD6FE",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
  },
  coverPickBtnText: { fontSize: 12, fontWeight: "700", color: "#4C1D95" },
  coverResetBtn: {
    backgroundColor: "#F3EFE6",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: "center",
  },
  coverResetBtnText: { fontSize: 12, fontWeight: "600", color: "#57534E" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: "#FDFBF7", borderRadius: 20, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: "#1C1917", marginBottom: 12 },
  label: { fontSize: 13, fontWeight: "600", color: "#44403C", marginBottom: 6, marginTop: 8 },
  iconRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#F3EFE6",
    alignItems: "center",
    justifyContent: "center",
  },
  iconChipActive: { backgroundColor: "#FEF2F2", borderWidth: 2, borderColor: "#9B2C2C" },
  iconText: { fontSize: 20 },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1C1917",
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: "#F3EFE6" },
  cancelBtnText: { color: "#44403C", fontWeight: "600" },
  confirmBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: "#9B2C2C" },
  confirmBtnText: { color: "#FDFBF7", fontWeight: "700" },
});
