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
import { useFocusEffect, useRouter } from "expo-router";
import { fetchWorkspace, patchLinkItem } from "../../src/api";
import { planIosLocalNotifications } from "../../src/notifications";
import type { MobileLinkItem, MobileReminderItem } from "../../src/storage";

export default function FavoritesScreen() {
  const router = useRouter();
  const [favorites, setFavorites] = useState<MobileLinkItem[]>([]);
  const [reminders, setReminders] = useState<MobileReminderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"fav" | "rem">("fav");

  const loadData = useCallback(async () => {
    const ws = await fetchWorkspace();
    setFavorites(ws.items.filter((it) => Boolean(it.is_favorite)));
    setReminders(ws.reminders);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  async function removeFavorite(item: MobileLinkItem) {
    setFavorites((prev) => prev.filter((it) => it.id !== item.id));
    await patchLinkItem(item.id, { is_favorite: false });
  }

  const plannedNotifications = planIosLocalNotifications(reminders, Date.now(), 64);

  return (
    <View style={styles.root}>
      <View style={styles.segmentWrap}>
        <Pressable
          style={[styles.segBtn, tab === "fav" && styles.segBtnActive]}
          onPress={() => setTab("fav")}
        >
          <Text style={[styles.segText, tab === "fav" && styles.segTextActive]}>
            ⭐ ชื่นชอบ ({favorites.length})
          </Text>
        </Pressable>
        <Pressable
          style={[styles.segBtn, tab === "rem" && styles.segBtnActive]}
          onPress={() => setTab("rem")}
        >
          <Text style={[styles.segText, tab === "rem" && styles.segTextActive]}>
            🔔 เตือนความจำ ({plannedNotifications.length}/64)
          </Text>
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
                <Text style={styles.platform}>{item.platform || "web"}</Text>
                <Pressable onPress={() => void removeFavorite(item)}>
                  <Text style={styles.star}>⭐</Text>
                </Pressable>
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.title || item.url}
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
              <Text style={styles.remTime}>⏰ {new Date(item.triggerAtMs).toLocaleString("th-TH")}</Text>
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
  remTime: { fontSize: 12, fontWeight: "700", color: "#9B2C2C", marginBottom: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: "#1C1917" },
  cardUrl: { fontSize: 12, color: "#78716C", marginTop: 4 },
});
