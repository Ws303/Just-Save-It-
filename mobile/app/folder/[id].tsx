import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  createFolderInvite,
  fetchWorkspace,
  listFolderMembers,
  revokeFolderInvite,
  type DiscordInviteCreateOptions,
} from "../../src/api";
import { formatCardDisplayTitle, matchesItemSearch } from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

type ExpiryPresetKey = "30m" | "1h" | "6h" | "12h" | "1d" | "7d" | "never";

const EXPIRY_PRESETS: Array<{ key: ExpiryPresetKey; label: string; minutes?: number; days?: number; never?: boolean }> = [
  { key: "30m", label: "30 นาที", minutes: 30 },
  { key: "1h", label: "1 ชม.", minutes: 60 },
  { key: "6h", label: "6 ชม.", minutes: 360 },
  { key: "12h", label: "12 ชม.", minutes: 720 },
  { key: "1d", label: "1 วัน", days: 1 },
  { key: "7d", label: "7 วัน", days: 7 },
  { key: "never", label: "ไม่หมดอายุ", never: true },
];

const MAX_USE_PRESETS: Array<{ key: string; label: string; value: number | null }> = [
  { key: "", label: "ไม่จำกัด", value: null },
  { key: "1", label: "1 ครั้ง", value: 1 },
  { key: "5", label: "5 ครั้ง", value: 5 },
  { key: "10", label: "10 ครั้ง", value: 10 },
  { key: "25", label: "25 ครั้ง", value: 25 },
  { key: "50", label: "50 ครั้ง", value: 50 },
];

interface ActiveInviteRow {
  token: string;
  role: string;
  invite_url: string;
  expires_at?: string | null;
  never_expires?: boolean;
  max_uses?: number | null;
  use_count?: number;
}

function formatInviteExpiryLabel(inv: ActiveInviteRow): string {
  if (inv.never_expires || !inv.expires_at) return "ไม่หมดอายุ";
  const d = new Date(inv.expires_at);
  if (Number.isNaN(d.getTime())) return "มีกำหนดเวลา";
  return `หมดอายุ ${d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}`;
}

export default function FolderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isVirtualInbox = id === "virtual-inbox";
  const initialCache = getMemoryCachedWorkspace();

  const [folder, setFolder] = useState<MobileFolderItem | null>(() => {
    if (!initialCache) return null;
    if (isVirtualInbox) return { id: "virtual-inbox", name: "รวมไว้ดูทีหลัง" };
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
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("editor");
  const [inviteExpiry, setInviteExpiry] = useState<ExpiryPresetKey>("7d");
  const [inviteMaxUses, setInviteMaxUses] = useState<number | null>(null);
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState("");
  const [activeInvites, setActiveInvites] = useState<ActiveInviteRow[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
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
        setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง" });
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
      setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง" });
      setItems(ws.items.filter((it) => !it.folder_id));
    } else {
      const found = ws.folders.find((f) => f.id === id) || { id: String(id), name: "โฟลเดอร์" };
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

  const loadInvites = useCallback(async () => {
    if (!id || isVirtualInbox) return;
    setLoadingInvites(true);
    const res = await listFolderMembers(id);
    setLoadingInvites(false);
    if (!res.ok || !res.data) return;
    const raw = Array.isArray(res.data.active_invites) ? res.data.active_invites : [];
    setActiveInvites(
      raw
        .filter((inv): inv is Record<string, unknown> => Boolean(inv && typeof inv === "object"))
        .map((inv) => ({
          token: String(inv.token || ""),
          role: String(inv.role || "viewer"),
          invite_url: String(inv.invite_url || ""),
          expires_at: typeof inv.expires_at === "string" ? inv.expires_at : null,
          never_expires: Boolean(inv.never_expires || !inv.expires_at),
          max_uses: typeof inv.max_uses === "number" ? inv.max_uses : null,
          use_count: typeof inv.use_count === "number" ? inv.use_count : 0,
        }))
        .filter((inv) => inv.token),
    );
  }, [id, isVirtualInbox]);

  const visibleItems = useMemo(() => {
    return items.filter((it) => matchesItemSearch(it, query, folder?.name || ""));
  }, [items, query, folder?.name]);

  function openInviteModal() {
    if (!id || isVirtualInbox) return;
    setGeneratedInviteUrl("");
    setInviteModalOpen(true);
    void loadInvites();
  }

  async function shareInviteUrl(inviteUrl: string) {
    if (!inviteUrl) return;
    await Share.share({
      title: `เชิญเข้าร่วมโฟลเดอร์ ${folder?.name || ""}`,
      message: `เข้าร่วมโฟลเดอร์ "${folder?.name || ""}" บน Sherlink ได้ที่: ${inviteUrl}`,
    });
  }

  async function handleCreateInvite() {
    if (!id || isVirtualInbox) return;
    const preset = EXPIRY_PRESETS.find((p) => p.key === inviteExpiry) || EXPIRY_PRESETS[5];
    const options: DiscordInviteCreateOptions = {
      role: inviteRole,
      ...(preset.never
        ? { never_expires: true }
        : preset.minutes
          ? { expires_in_minutes: preset.minutes }
          : { expires_in_days: preset.days || 7 }),
      ...(inviteMaxUses ? { max_uses: inviteMaxUses } : {}),
    };
    await runGuardedBusyAction(actionSeqRef, setInviting, async (isStale) => {
      const res = await createFolderInvite(id, options);
      if (isStale()) return;
      const inviteUrl = typeof res.data?.invite_url === "string" ? res.data.invite_url : "";
      if (!res.ok || !inviteUrl) {
        Alert.alert("สร้างลิงก์เชิญไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setGeneratedInviteUrl(inviteUrl);
      void loadInvites();
      await shareInviteUrl(inviteUrl);
    });
  }

  async function handleRevokeInvite(token: string) {
    if (!id || !token || revokingToken) return;
    setRevokingToken(token);
    const res = await revokeFolderInvite(id, token);
    setRevokingToken(null);
    if (!res.ok) {
      Alert.alert("ยกเลิกลิงก์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
      return;
    }
    setActiveInvites((prev) => prev.filter((inv) => inv.token !== token));
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.titleLeft}>
            <Ionicons
              name={isVirtualInbox ? "bookmark-outline" : "folder-outline"}
              size={20}
              color="#1C1917"
            />
            <Text style={styles.title} numberOfLines={1}>
              {folder?.name || "โฟลเดอร์"}
            </Text>
          </View>
          {!isVirtualInbox ? (
            <Pressable
              style={[styles.inviteBtn, inviting && { opacity: 0.7 }]}
              disabled={inviting}
              onPress={openInviteModal}
            >
              <View style={styles.btnInnerRow}>
                <Ionicons name="people-outline" size={14} color="#FDFBF7" />
                <Text style={styles.inviteBtnText}>เชิญเพื่อนร่วมโฟลเดอร์</Text>
              </View>
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
              onPress={() =>
                router.push(
                  `/item/${encodeURIComponent(item.id)}?folderId=${encodeURIComponent(String(id || ""))}` as never,
                )
              }
            >
              <Text style={styles.cardTitle} numberOfLines={2}>
                {formatCardDisplayTitle(item) || item.url}
              </Text>
              <Text style={styles.cardUrl} numberOfLines={1}>
                {item.url}
              </Text>
            </Pressable>
          )}
        />
      )}

      <Modal
        visible={inviteModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setInviteModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHead}>
              <View style={styles.btnInnerRow}>
                <Ionicons name="link-outline" size={18} color="#1C1917" />
                <Text style={styles.modalTitle}>ตั้งค่าลิงก์เชิญโฟลเดอร์</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => setInviteModalOpen(false)}>
                <Ionicons name="close" size={20} color="#78716C" />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.modalLabel}>สิทธิ์ผู้ได้รับเชิญ (Role)</Text>
              <View style={styles.chipRow}>
                {(
                  [
                    { key: "viewer", label: "Viewer (ดูอย่างเดียว)" },
                    { key: "editor", label: "Editor (เพิ่ม/แก้ไขได้)" },
                  ] as const
                ).map((opt) => (
                  <Pressable
                    key={opt.key}
                    style={[styles.choiceChip, inviteRole === opt.key && styles.choiceChipActive]}
                    onPress={() => setInviteRole(opt.key)}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        inviteRole === opt.key && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.modalLabel}>วันหมดอายุ (Expiration)</Text>
              <View style={styles.chipRow}>
                {EXPIRY_PRESETS.map((opt) => (
                  <Pressable
                    key={opt.key}
                    style={[styles.choiceChip, inviteExpiry === opt.key && styles.choiceChipActive]}
                    onPress={() => setInviteExpiry(opt.key)}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        inviteExpiry === opt.key && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.modalLabel}>จำนวนครั้งที่ใช้ได้ (Max Uses)</Text>
              <View style={styles.chipRow}>
                {MAX_USE_PRESETS.map((opt) => (
                  <Pressable
                    key={opt.key || "unlimited"}
                    style={[styles.choiceChip, inviteMaxUses === opt.value && styles.choiceChipActive]}
                    onPress={() => setInviteMaxUses(opt.value)}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        inviteMaxUses === opt.value && styles.choiceChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                style={[styles.createInviteBtn, inviting && { opacity: 0.7 }]}
                disabled={inviting}
                onPress={() => void handleCreateInvite()}
              >
                <Text style={styles.createInviteBtnText}>
                  {inviting ? "กำลังสร้างลิงก์..." : "สร้างและแชร์ลิงก์คำเชิญ"}
                </Text>
              </Pressable>

              {generatedInviteUrl ? (
                <View style={styles.generatedBox}>
                  <Text style={styles.generatedUrl} selectable numberOfLines={2}>
                    {generatedInviteUrl}
                  </Text>
                  <Pressable
                    style={styles.shareSmallBtn}
                    onPress={() => void shareInviteUrl(generatedInviteUrl)}
                  >
                    <Text style={styles.shareSmallBtnText}>แชร์อีกครั้ง</Text>
                  </Pressable>
                </View>
              ) : null}

              <Text style={[styles.modalLabel, { marginTop: 16 }]}>ลิงก์คำเชิญที่ใช้งานอยู่</Text>
              {loadingInvites ? (
                <ActivityIndicator size="small" color="#9B2C2C" style={{ marginVertical: 10 }} />
              ) : activeInvites.length === 0 ? (
                <Text style={styles.noInvitesText}>ยังไม่มีลิงก์ที่เปิดใช้งานอยู่</Text>
              ) : (
                <View style={styles.activeInvList}>
                  {activeInvites.map((inv) => (
                    <View key={inv.token} style={styles.activeInvRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.activeInvRole}>
                          {inv.role === "editor" ? "Editor" : "Viewer"} · ใช้แล้ว {inv.use_count || 0}
                          {inv.max_uses ? `/${inv.max_uses}` : "/∞"}
                        </Text>
                        <Text style={styles.activeInvExp}>{formatInviteExpiryLabel(inv)}</Text>
                      </View>
                      {inv.invite_url ? (
                        <Pressable
                          style={styles.shareSmallBtn}
                          onPress={() => void shareInviteUrl(inv.invite_url)}
                        >
                          <Text style={styles.shareSmallBtnText}>แชร์</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        style={[styles.revokeBtn, revokingToken === inv.token && { opacity: 0.6 }]}
                        disabled={revokingToken === inv.token}
                        onPress={() => void handleRevokeInvite(inv.token)}
                      >
                        <Text style={styles.revokeBtnText}>ยกเลิก</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  listContent: { padding: 16, gap: 10, paddingBottom: 40 },
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.48)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FDFBF7",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: "86%",
  },
  modalHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  titleLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  btnInnerRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  modalTitle: { fontSize: 17, fontWeight: "800", color: "#1C1917" },
  modalClose: { fontSize: 18, color: "#78716C", padding: 4 },
  modalLabel: { fontSize: 13, fontWeight: "700", color: "#44403C", marginTop: 10, marginBottom: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#F3EFE6",
    borderWidth: 1,
    borderColor: "#E7E0D5",
  },
  choiceChipActive: { backgroundColor: "#9B2C2C", borderColor: "#9B2C2C" },
  choiceChipText: { fontSize: 12, fontWeight: "600", color: "#44403C" },
  choiceChipTextActive: { color: "#FDFBF7" },
  createInviteBtn: {
    backgroundColor: "#E24C4B",
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 16,
  },
  createInviteBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  generatedBox: {
    marginTop: 12,
    backgroundColor: "#F1EEFF",
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  generatedUrl: { flex: 1, fontSize: 12, color: "#312E81" },
  activeInvList: { gap: 8, paddingBottom: 16 },
  activeInvRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EAE4DB",
    borderRadius: 12,
    padding: 10,
  },
  activeInvRole: { fontSize: 13, fontWeight: "700", color: "#1C1917" },
  activeInvExp: { fontSize: 11, color: "#78716C", marginTop: 2 },
  shareSmallBtn: {
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  shareSmallBtnText: { fontSize: 12, fontWeight: "700", color: "#3730A3" },
  revokeBtn: {
    backgroundColor: "#FEE2E2",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  revokeBtnText: { fontSize: 12, fontWeight: "700", color: "#B91C1C" },
  noInvitesText: { fontSize: 12, color: "#78716C", paddingVertical: 8 },
});
