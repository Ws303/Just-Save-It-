import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  computeFolderShareState,
  createFolderInvite,
  fetchWorkspace,
  listFolderMembers,
  patchLinkItem,
  revokeFolderInvite,
  type DiscordInviteCreateOptions,
} from "../../src/api";
import { FIGMA_INK, getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import {
  formatCardDisplayTitle,
  inferMobileDomain,
  inferMobilePlatform,
  matchesItemSearch,
  resolveMobileThumbUrl,
} from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadFigmaAccentTheme,
  loadSession,
  resolveSessionUserId,
  subscribeFigmaAccentTheme,
  type MobileFolderItem,
  type MobileLinkItem,
} from "../../src/storage";

const CHERRY_SELECTED_IMG = require("../../assets/figma/cherry-selected.png");
const CHERRY_UNSELECTED_IMG = require("../../assets/figma/cherry-unselected.png");

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

interface MemberRow {
  user_id?: string;
  display_name?: string;
  email?: string;
  role?: string;
}

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

function formatInviteExpiryLabel(inv: ActiveInviteRow): string {
  if (inv.never_expires || !inv.expires_at) return "ไม่หมดอายุ";
  const d = new Date(inv.expires_at);
  if (Number.isNaN(d.getTime())) return "มีกำหนดเวลา";
  return `หมดอายุ ${d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}`;
}

export default function FolderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isVirtualInbox = id === "virtual-inbox";
  const initialCache = getMemoryCachedWorkspace();

  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

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
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [folderOwnerId, setFolderOwnerId] = useState("");
  const [callerRole, setCallerRole] = useState("");
  const [selfInitial, setSelfInitial] = useState("U");
  const [selfUserId, setSelfUserId] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "read" | "favorite">("all");
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
  const activeFolderIdRef = useRef(id);
  activeFolderIdRef.current = id;
  const favInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setFolderOwnerId("");
    setCallerRole("");
    setMembers([]);
    setActiveInvites([]);
  }, [id]);

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  const loadInvites = useCallback(async () => {
    if (!id || isVirtualInbox) return;
    const targetFolderId = id;
    const startGen = getAuthGeneration();
    setLoadingInvites(true);
    const res = await listFolderMembers(targetFolderId);
    if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) return;
    setLoadingInvites(false);
    if (!res.ok || !res.data) return;
    if (typeof res.data.owner_id === "string") {
      setFolderOwnerId(res.data.owner_id);
    }
    if (typeof res.data.caller_role === "string") {
      setCallerRole(res.data.caller_role);
    }
    if (Array.isArray(res.data.members)) {
      setMembers(
        res.data.members.filter((m): m is MemberRow => Boolean(m && typeof m === "object")),
      );
    }
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

  const loadFolder = useCallback(async () => {
    const startGen = getAuthGeneration();
    const targetFolderId = id;
    const sess = await loadSession().catch(() => null);
    if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) return;
    setSelfUserId(resolveSessionUserId(sess));
    const initChar = (sess?.user?.display_name || sess?.user?.email || "U")
      .trim()
      .charAt(0)
      .toUpperCase();
    if (initChar) setSelfInitial(initChar);

    const cached = await loadCachedWorkspace();
    if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) {
      setLoading(false);
      return;
    }
    if (cached.items.length > 0 || cached.folders.length > 0) {
      if (isVirtualInbox) {
        setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง" });
        setItems(cached.items.filter((it) => !it.folder_id));
      } else {
        const found = cached.folders.find((f) => f.id === targetFolderId);
        if (found) setFolder(found);
        setItems(cached.items.filter((it) => it.folder_id === targetFolderId));
      }
      setLoading(false);
    }

    const ws = await fetchWorkspace();
    if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) {
      setLoading(false);
      return;
    }
    if (isVirtualInbox) {
      setFolder({ id: "virtual-inbox", name: "รวมไว้ดูทีหลัง" });
      setItems(ws.items.filter((it) => !it.folder_id));
    } else {
      const found = ws.folders.find((f) => f.id === targetFolderId) || { id: String(targetFolderId), name: "โฟลเดอร์" };
      setFolder(found);
      setItems(ws.items.filter((it) => it.folder_id === targetFolderId));
    }
    setLoading(false);
    if (!isVirtualInbox) {
      void loadInvites();
    }
  }, [id, isVirtualInbox, loadInvites]);

  useFocusEffect(
    useCallback(() => {
      void loadFolder();
    }, [loadFolder]),
  );

  const visibleItems = useMemo(() => {
    return items.filter((it) => {
      const seen = isReadStatus(it.status);
      if (statusFilter === "unread" && seen) return false;
      if (statusFilter === "read" && !seen) return false;
      if (statusFilter === "favorite" && !it.is_favorite) return false;
      return matchesItemSearch(it, query, folder?.name || "");
    });
  }, [items, query, folder?.name, statusFilter]);

  function openInviteModal() {
    if (!id || isVirtualInbox) return;
    setGeneratedInviteUrl("");
    setInviteModalOpen(true);
    void loadInvites();
  }

  async function toggleFavorite(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    const targetFolderId = id;
    if (!item.id || favInFlightRef.current.has(item.id)) return;
    favInFlightRef.current.add(item.id);
    const nextFav = !item.is_favorite;
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_favorite: nextFav } : it)));
    try {
      const res = await patchLinkItem(item.id, { is_favorite: nextFav });
      if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) return;
      if (!res.ok) {
        setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_favorite: !nextFav } : it)));
      }
    } finally {
      favInFlightRef.current.delete(item.id);
    }
  }

  async function shareInviteUrl(inviteUrl: string) {
    if (!inviteUrl) return;
    try {
      await Share.share({
        title: `เชิญเข้าร่วมโฟลเดอร์ ${folder?.name || ""}`,
        message: `เข้าร่วมโฟลเดอร์ "${folder?.name || ""}" บน Sherlink ได้ที่: ${inviteUrl}`,
      });
    } catch {
      Alert.alert("แชร์ลิงก์ไม่สำเร็จ", "ไม่สามารถเปิดหน้าต่างแชร์ได้");
    }
  }

  async function handleCreateInvite() {
    if (!id || isVirtualInbox) return;
    const targetFolderId = id;
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
      const res = await createFolderInvite(targetFolderId, options);
      if (isStale() || activeFolderIdRef.current !== targetFolderId) return;
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
    const targetFolderId = id;
    const startGen = getAuthGeneration();
    setRevokingToken(token);
    try {
      const res = await revokeFolderInvite(targetFolderId, token);
      if (getAuthGeneration() !== startGen || activeFolderIdRef.current !== targetFolderId) return;
      if (!res.ok) {
        Alert.alert("ยกเลิกลิงก์ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        return;
      }
      setActiveInvites((prev) => prev.filter((inv) => inv.token !== token));
    } finally {
      if (getAuthGeneration() === startGen && activeFolderIdRef.current === targetFolderId) {
        setRevokingToken(null);
      }
    }
  }

  const avatarInitials = useMemo(() => {
    if (members.length > 0) {
      return members
        .slice(0, 3)
        .map((m) => (m.display_name || m.email || m.user_id || "U").trim().charAt(0).toUpperCase() || "U");
    }
    return [selfInitial];
  }, [members, selfInitial]);

  const { isOwner, sharedPeerCount } = useMemo(
    () =>
      computeFolderShareState({
        isVirtualInbox,
        folder,
        members,
        ownerId: folderOwnerId,
        callerRole,
        selfUserId,
      }),
    [isVirtualInbox, folder, members, folderOwnerId, callerRole, selfUserId],
  );

  return (
    <View style={[styles.root, { paddingTop: Math.max(10, insets.top) }]}>
      <View style={styles.subTopbar}>
        <View style={styles.subTopLeft}>
          <Pressable
            style={styles.backBtn}
            hitSlop={8}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace("/(tabs)/folders");
            }}
          >
            <Ionicons name="chevron-back" size={23} color={FIGMA_INK.inkPrimary} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {folder?.name || "โฟลเดอร์"}
          </Text>
        </View>
        {!isVirtualInbox && isOwner ? (
          <Pressable
            style={[styles.inviteBtn, inviting && { opacity: 0.7 }]}
            disabled={inviting}
            onPress={openInviteModal}
          >
            <Ionicons name="people-outline" size={14} color={FIGMA_INK.inkStrong} />
            <Text style={styles.inviteBtnText}>เชิญเพื่อน</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.sharedBar}>
        <View style={styles.avatarStack}>
          {avatarInitials.map((ch, idx) => (
            <View key={`av-${idx}`} style={styles.avatarCircle}>
              <Text style={styles.avatarCircleText}>{ch}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.sharedBarText}>
          {sharedPeerCount > 0
            ? `แชร์กับ ${sharedPeerCount} คน`
            : isVirtualInbox
              ? "ลิงก์ที่ยังไม่ได้จัดหมวดหมู่"
              : !folder
                ? "กำลังตรวจสอบสถานะโฟลเดอร์..."
                : isOwner
                  ? "โฟลเดอร์ส่วนตัว · กดเชิญเพื่อนเพื่อแชร์"
                  : "โฟลเดอร์ที่แชร์"}
        </Text>
      </View>

      <View style={styles.controlsWrap}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={18} color={FIGMA_INK.inkStrong} />
          <TextInput
            style={styles.searchInput}
            placeholder="ค้นหาลิงก์ในโฟลเดอร์"
            placeholderTextColor="#8B9199"
            value={query}
            onChangeText={setQuery}
          />
          {query ? (
            <Pressable hitSlop={8} onPress={() => setQuery("")}>
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

        <Text style={styles.sectionHeading}>ลิงก์ในโฟลเดอร์ ({visibleItems.length})</Text>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={visibleItems}
          keyExtractor={(it) => it.id}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: Math.max(28, insets.bottom + 16) },
          ]}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>ยังไม่มีลิงก์ที่ตรงกับตัวกรองในโฟลเดอร์นี้</Text>
            </View>
          }
          renderItem={({ item }) => {
            const seen = isReadStatus(item.status);
            const thumbUri = resolveMobileThumbUrl(item);
            const platLabel = inferMobilePlatform(item) || inferMobileDomain(item.url) || inferDomain(item.url);
            const codeBadge = String(platLabel || "WEB").slice(0, 3).toUpperCase();

            return (
              <Pressable
                style={styles.figmaLinkCard}
                onPress={() =>
                  router.push(
                    `/item/${encodeURIComponent(item.id)}?folderId=${encodeURIComponent(String(id || ""))}` as never,
                  )
                }
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
                    {seen ? "ดูแล้ว" : "ยังไม่ได้ดู"}
                  </Text>
                </View>

                <Pressable
                  style={styles.cardActionIconBtn}
                  hitSlop={8}
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
              </Pressable>
            );
          }}
        />
      )}

      <Modal
        visible={inviteModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setInviteModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.modalHead}>
              <View style={styles.btnInnerRow}>
                <Ionicons name="link-outline" size={18} color={FIGMA_INK.inkPrimary} />
                <Text style={styles.modalTitle}>ตั้งค่าลิงก์เชิญโฟลเดอร์</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => setInviteModalOpen(false)}>
                <Ionicons name="close" size={20} color="#666666" />
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
                ).map((opt) => {
                  const active = inviteRole === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[
                        styles.choiceChip,
                        active && { backgroundColor: theme.accent, borderColor: theme.accent },
                      ]}
                      onPress={() => setInviteRole(opt.key)}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          active && styles.choiceChipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.modalLabel}>วันหมดอายุ (Expiration)</Text>
              <View style={styles.chipRow}>
                {EXPIRY_PRESETS.map((opt) => {
                  const active = inviteExpiry === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[
                        styles.choiceChip,
                        active && { backgroundColor: theme.accent, borderColor: theme.accent },
                      ]}
                      onPress={() => setInviteExpiry(opt.key)}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          active && styles.choiceChipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.modalLabel}>จำนวนครั้งที่ใช้ได้ (Max Uses)</Text>
              <View style={styles.chipRow}>
                {MAX_USE_PRESETS.map((opt) => {
                  const active = inviteMaxUses === opt.value;
                  return (
                    <Pressable
                      key={opt.key || "unlimited"}
                      style={[
                        styles.choiceChip,
                        active && { backgroundColor: theme.accent, borderColor: theme.accent },
                      ]}
                      onPress={() => setInviteMaxUses(opt.value)}
                    >
                      <Text
                        style={[
                          styles.choiceChipText,
                          active && styles.choiceChipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Pressable
                style={[styles.createInviteBtn, { backgroundColor: theme.accent }, inviting && { opacity: 0.7 }]}
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
                <ActivityIndicator size="small" color={theme.accent} style={{ marginVertical: 10 }} />
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
  root: {
    flex: 1,
    backgroundColor: FIGMA_INK.bgApp,
  },
  subTopbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 10,
  },
  subTopLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    fontSize: 21,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  inviteBtn: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  inviteBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  sharedBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  avatarStack: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  avatarCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#D1D5DB",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarCircleText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#374151",
  },
  sharedBarText: {
    fontSize: 13,
    color: FIGMA_INK.inkSecondary,
  },
  controlsWrap: {
    paddingHorizontal: 16,
    gap: 10,
    paddingBottom: 10,
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
  sectionHeading: {
    fontSize: 16,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
    marginTop: 2,
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  emptyBox: {
    padding: 32,
    borderRadius: 14,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#EFEFEF",
    alignItems: "center",
  },
  emptyText: {
    fontSize: 13.5,
    color: FIGMA_INK.inkSecondary,
    textAlign: "center",
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
  fullImg: {
    width: "100%",
    height: "100%",
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
  cardActionIconBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  cherryActionImg: {
    width: 20,
    height: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
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
  btnInnerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
    marginTop: 10,
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  choiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
  },
  choiceChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: FIGMA_INK.inkStrong,
  },
  choiceChipTextActive: {
    color: "#FFFFFF",
  },
  createInviteBtn: {
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  createInviteBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  generatedBox: {
    marginTop: 12,
    backgroundColor: FIGMA_INK.lavenderBg,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  generatedUrl: {
    flex: 1,
    fontSize: 12,
    color: "#312E81",
  },
  activeInvList: {
    gap: 8,
    paddingBottom: 16,
  },
  activeInvRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    padding: 10,
  },
  activeInvRole: {
    fontSize: 13,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  activeInvExp: {
    fontSize: 11,
    color: FIGMA_INK.inkSecondary,
    marginTop: 2,
  },
  shareSmallBtn: {
    backgroundColor: "#EEF2FF",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  shareSmallBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#3730A3",
  },
  revokeBtn: {
    backgroundColor: "#FEE2E2",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  revokeBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#B91C1C",
  },
  noInvitesText: {
    fontSize: 12,
    color: FIGMA_INK.inkSecondary,
    paddingVertical: 8,
  },
});
