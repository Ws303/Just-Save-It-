import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import { createFolderInvite, fetchWorkspace } from "../../src/api";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

export default function FolderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isVirtualInbox = id === "virtual-inbox";
  const initialCache = getMemoryCachedWorkspace();

  const [folder, setFolder] = useState<MobileFolderItem | null>(() => {
    if (!initialCache) return null;
    if (isVirtualInbox) return { id: "virtual-inbox", name: "รวมไว้ดูทีหลัง", icon: "🔖" };
    return initialCache.folders.find((f) => f.id === id) || null;
  });
  const [items, setItems] = useState<MobileLinkItem[]>(() => {
    if (!initialCache) return [];
    return isVirtualInbox
      ? initialCache.items.filter((it) => !it.folder_id)
      : initialCache.items.filter((it) => it.folder_id === id);
  });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState<boolean>(() => !initialCache);
  const [inviting, setInviting] = useState(false);
  const actionSeqRef = useRef(0);

  const loadFolder = useCallback(async () => {
    const startGen = getAuthGeneration();
    const cached = await loadCachedWorkspace();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      return;
    }
    if (cached.items.length > 0 || cached.folders.length > 0) {
      if (isVirtualInbox) {
        setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง", icon: "🔖" });
        setItems(cached.items.filter((it) => !it.folder_id));
      } else {
        const found = cached.folders.find((f) => f.id === id);
        if (found) setFolder(found);
        setItems(cached.items.filter((it) => it.folder_id === id));
      }
      setLoading(false);
    }

    const ws = await fetchWorkspace();
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      return;
    }
    if (isVirtualInbox) {
      setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง", icon: "🔖" });
      setItems(ws.items.filter((it) => !it.folder_id));
    } else {
      const found = ws.folders.find((f) => f.id === id) || { id: String(id), name: "โฟลเดอร์", icon: "📁" };
      setFolder(found);
      setItems(ws.items.filter((it) => it.folder_id === id));
    }
    setLoading(false);
  }, [id, isVirtualInbox]);

  useFocusEffect(
    useCallback(() => {
      void loadFolder();
    }, [loadFolder]),
  );

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      `${it.title || ""} ${it.url || ""} ${it.note || ""}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  async function handleShareInvite() {
    if (!id || isVirtualInbox) return;
    await runGuardedBusyAction(actionSeqRef, setInviting, async (isStale) => {
      const res = await createFolderInvite(id, "editor");
      if (isStale()) return;
      const inviteUrl = typeof res.data?.invite_url === "string" ? res.data.invite_url : "";
      if (!res.ok || !inviteUrl) {
        Alert.alert("สร้างลิงก์เชิญไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      await Share.share({
        title: `เชิญเข้าร่วมโฟลเดอร์ ${folder?.name || ""}`,
        message: `เข้าร่วมโฟลเดอร์ "${folder?.name || ""}" บน Sharely ได้ที่: ${inviteUrl}`,
      });
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>
            {folder?.emoji || folder?.icon || "📁"} {folder?.name || "โฟลเดอร์"}
          </Text>
          {!isVirtualInbox ? (
            <Pressable
              style={[styles.inviteBtn, inviting && { opacity: 0.7 }]}
              disabled={inviting}
              onPress={() => void handleShareInvite()}
            >
              <Text style={styles.inviteBtnText}>
                {inviting ? "กำลังสร้าง..." : "🤝 เชิญเพื่อนร่วมโฟลเดอร์"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <TextInput
          style={styles.searchInput}
          placeholder="ค้นหาในโฟลเดอร์นี้..."
          placeholderTextColor="#A8A29E"
          value={query}
          onChangeText={setQuery}
        />
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#9B2C2C" />
        </View>
      ) : (
        <FlatList
          data={visibleItems}
          keyExtractor={(it) => it.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>ยังไม่มีลิงก์ในโฟลเดอร์นี้</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => router.push(`/item/${encodeURIComponent(item.id)}`)}
            >
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.title || item.url}
              </Text>
              <Text style={styles.cardUrl} numberOfLines={1}>
                {item.url}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  header: {
    backgroundColor: "#FDFBF7",
    padding: 16,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#EAE4DB",
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  title: { flex: 1, fontSize: 18, fontWeight: "800", color: "#1C1917" },
  inviteBtn: { backgroundColor: "#9B2C2C", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  inviteBtnText: { color: "#FDFBF7", fontSize: 12, fontWeight: "700" },
  searchInput: {
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: "#1C1917",
  },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: 16, gap: 10 },
  emptyBox: { padding: 40, alignItems: "center" },
  emptyText: { fontSize: 14, color: "#78716C" },
  card: {
    backgroundColor: "#FDFBF7",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#1C1917" },
  cardUrl: { fontSize: 12, color: "#78716C", marginTop: 4 },
});
