import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import { createFolder, fetchWorkspace } from "../../src/api";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadSession,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

const ICON_CHOICES = ["📁", "☕", "🍜", "🎬", "✈️", "📚", "💡", "🛒"];

export default function FoldersScreen() {
  const router = useRouter();
  const initialCache = getMemoryCachedWorkspace();
  const [folders, setFolders] = useState<MobileFolderItem[]>(() => initialCache?.folders || []);
  const [items, setItems] = useState<MobileLinkItem[]>(() => initialCache?.items || []);
  const [loading, setLoading] = useState<boolean>(() => !(initialCache?.folders?.length || initialCache?.items?.length));
  const [refreshing, setRefreshing] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("📁");
  const [creating, setCreating] = useState(false);
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

  async function handleCreate() {
    if (!newName.trim()) {
      Alert.alert("กรุณาระบุชื่อโฟลเดอร์");
      return;
    }
    await runGuardedBusyAction(actionSeqRef, setCreating, async (isStale) => {
      const res = await createFolder(newName, newIcon);
      if (isStale()) return;
      if (!res.ok) {
        Alert.alert("สร้างโฟลเดอร์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setNewName("");
      setNewIcon("📁");
      setModalOpen(false);
      void loadData();
    });
  }

  const unfolderedCount = items.filter((it) => !it.folder_id).length;

  const cards: Array<{ id: string; name: string; icon: string; count: number }> = [
    { id: "virtual-inbox", name: "รวมไว้ดูทีหลัง", icon: "🔖", count: unfolderedCount },
    ...folders.map((f) => ({
      id: f.id,
      name: f.name,
      icon: f.icon || "📁",
      count: typeof f.item_count === "number" ? f.item_count : items.filter((it) => it.folder_id === f.id).length,
    })),
  ];

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.heading}>โฟลเดอร์ทั้งหมด</Text>
          <Text style={styles.subheading}>{folders.length} โฟลเดอร์ส่วนตัว & แชร์</Text>
        </View>
        <Pressable style={styles.createBtn} onPress={() => setModalOpen(true)}>
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
              <Text style={styles.folderIcon}>{item.icon}</Text>
              <Text style={styles.folderName} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.folderCount}>{item.count} รายการ</Text>
            </Pressable>
          )}
        />
      )}

      <Modal visible={modalOpen} animationType="fade" transparent>
        <View style={styles.backdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>+ สร้างโฟลเดอร์ใหม่</Text>
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
              <Pressable style={styles.cancelBtn} onPress={() => setModalOpen(false)}>
                <Text style={styles.cancelBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={[styles.confirmBtn, creating && { opacity: 0.7 }]}
                disabled={creating}
                onPress={() => void handleCreate()}
              >
                <Text style={styles.confirmBtnText}>{creating ? "กำลังสร้าง..." : "สร้าง"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
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
  gridContent: { padding: 14, gap: 12 },
  gridRow: { gap: 12 },
  folderCard: {
    flex: 1,
    backgroundColor: "#FDFBF7",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    minHeight: 130,
    justifyContent: "space-between",
  },
  folderIcon: { fontSize: 30 },
  folderName: { fontSize: 15, fontWeight: "700", color: "#1C1917", marginTop: 10 },
  folderCount: { fontSize: 12, color: "#78716C", marginTop: 4 },
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
