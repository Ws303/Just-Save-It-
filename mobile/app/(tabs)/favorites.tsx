import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import {
  fetchLocalSyncReminders,
  fetchWorkspace,
  patchLinkItem,
  type LocalSyncOccurrence,
} from "../../src/api";
import { formatCardDisplayTitle, inferMobilePlatform } from "../../src/itemHelpers";
import {
  planIosLocalNotifications,
  type ReminderInput,
} from "../../src/notifications";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadSession,
  type MobileLinkItem,
  type MobileReminderItem,
} from "../../src/storage";

export default function FavoritesScreen() {
  const router = useRouter();
  const initialCache = getMemoryCachedWorkspace();
  const [favorites, setFavorites] = useState<MobileLinkItem[]>(() =>
    (initialCache?.items || []).filter((it) => Boolean(it.is_favorite)),
  );
  const [reminders, setReminders] = useState<MobileReminderItem[]>(() => initialCache?.reminders || []);
  const [serverOccurrences, setServerOccurrences] = useState<LocalSyncOccurrence[] | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !(initialCache?.items?.length || initialCache?.reminders?.length));
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"fav" | "rem">("fav");

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
    if (cached.items.length > 0 || cached.reminders.length > 0) {
      setFavorites((prev) => (prev.length ? prev : cached.items.filter((it) => Boolean(it.is_favorite))));
      setReminders((prev) => (prev.length ? prev : cached.reminders));
      setLoading(false);
    }
    const [ws, syncRes] = await Promise.all([
      fetchWorkspace(),
      fetchLocalSyncReminders().catch(() => ({ ok: false as const, status: 0, data: null })),
    ]);
    if (getAuthGeneration() !== startGen) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setFavorites(ws.items.filter((it) => Boolean(it.is_favorite)));
    setReminders(ws.reminders);
    if (syncRes.ok && syncRes.data && !syncRes.data.ios_remote_push_active && Array.isArray(syncRes.data.notifications)) {
      setServerOccurrences(syncRes.data.notifications);
    } else {
      setServerOccurrences(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  async function removeFavorite(item: MobileLinkItem) {
    const startGen = getAuthGeneration();
    setFavorites((prev) => prev.filter((it) => it.id !== item.id));
    const res = await patchLinkItem(item.id, { is_favorite: false });
    if (getAuthGeneration() !== startGen) return;
    if (!res.ok) {
      setFavorites((prev) => (prev.some((it) => it.id === item.id) ? prev : [item, ...prev]));
    }
  }

  const plannedNotifications = planIosLocalNotifications(
    (serverOccurrences ?? reminders) as ReminderInput[],
    Date.now(),
    64,
  );

  return (
    <View style={styles.root}>
      <View style={styles.segmentWrap}>
        <Pressable
          style={[styles.segBtn, tab === "fav" && styles.segBtnActive]}
          onPress={() => setTab("fav")}
        >
          <View style={styles.inlineRow}>
            <Ionicons
              name={tab === "fav" ? "heart" : "heart-outline"}
              size={14}
              color={tab === "fav" ? "#FDFBF7" : "#E24C4B"}
            />
            <Text style={[styles.segText, tab === "fav" && styles.segTextActive]}>
              ชื่นชอบ ({favorites.length})
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={[styles.segBtn, tab === "rem" && styles.segBtnActive]}
          onPress={() => setTab("rem")}
        >
          <View style={styles.inlineRow}>
            <Ionicons
              name="notifications-outline"
              size={14}
              color={tab === "rem" ? "#FDFBF7" : "#57534E"}
            />
            <Text style={[styles.segText, tab === "rem" && styles.segTextActive]}>
              เตือนความจำ ({plannedNotifications.length}/64)
            </Text>
          </View>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#9B2C2C" />
        </View>
      ) : tab === "fav" ? (
        <FlatList
          data={favorites}
          keyExtractor={(it) => it.id}
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
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>ยังไม่มีรายการโปรด</Text>
              <Text style={styles.emptySub}>กดรูปดาวบนการ์ดลิงก์เพื่อปักหมุดไว้ที่นี่</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => router.push(`/item/${encodeURIComponent(item.id)}`)}
            >
              <View style={styles.cardTop}>
                <Text style={styles.platform}>{inferMobilePlatform(item) || "web"}</Text>
                <Pressable onPress={() => void removeFavorite(item)}>
                  <Ionicons name="heart" size={18} color="#E24C4B" />
                </Pressable>
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {formatCardDisplayTitle(item) || item.url}
              </Text>
              <Text style={styles.cardUrl} numberOfLines={1}>
                {item.url}
              </Text>
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={plannedNotifications}
          keyExtractor={(r) => `${r.reminderId}-${r.triggerAtMs}`}
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
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>ไม่มีเตือนความจำที่กำลังรอ</Text>
              <Text style={styles.emptySub}>ตั้งเวลาเตือนจากหน้ารายละเอียดลิงก์ได้ทุกเมื่อ (รองรับ iOS Local Sync สูงสุด 64 รายการ)</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => {
                if (item.itemId) router.push(`/item/${encodeURIComponent(item.itemId)}`);
              }}
            >
              <View style={[styles.inlineRow, { marginBottom: 4 }]}>
                <Ionicons name="time-outline" size={13} color="#9B2C2C" />
                <Text style={[styles.remTime, { marginBottom: 0 }]}>
                  {new Date(item.triggerAtMs).toLocaleString("th-TH")}
                </Text>
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.url ? (
                <Text style={styles.cardUrl} numberOfLines={1}>
                  {item.url}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  segmentWrap: {
    flexDirection: "row",
    margin: 14,
    backgroundColor: "#EAE4DB",
    borderRadius: 14,
    padding: 4,
  },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 11, alignItems: "center" },
  segBtnActive: { backgroundColor: "#9B2C2C" },
  segText: { fontSize: 13, fontWeight: "700", color: "#57534E" },
  segTextActive: { color: "#FDFBF7" },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { paddingHorizontal: 14, paddingBottom: 24, gap: 10 },
  emptyBox: { padding: 36, alignItems: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#44403C" },
  emptySub: { fontSize: 13, color: "#78716C", textAlign: "center", marginTop: 6 },
  card: {
    backgroundColor: "#FDFBF7",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  platform: {
    fontSize: 11,
    fontWeight: "700",
    color: "#9B2C2C",
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    textTransform: "uppercase",
  },
  star: { fontSize: 18 },
  inlineRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  remTime: { fontSize: 12, fontWeight: "700", color: "#9B2C2C", marginBottom: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#1C1917" },
  cardUrl: { fontSize: 12, color: "#78716C", marginTop: 4 },
});
