import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  apiFetch,
  deleteLinkItem,
  deleteReminder,
  patchLinkItem,
  refreshLinkPreview,
  saveReminder,
  summarizeLinkItem,
} from "../../src/api";
import { syncLocalRemindersWithOs } from "../../src/notifications";
import type { MobileLinkItem, WorkflowStatus } from "../../src/storage";

const STATUS_ITEMS: Array<{ id: WorkflowStatus; label: string }> = [
  { id: "inbox", label: "กล่องรับ" },
  { id: "todo", label: "รออ่าน" },
  { id: "done", label: "อ่านแล้ว" },
  { id: "archived", label: "เก็บถาวร" },
];

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [item, setItem] = useState<MobileLinkItem | null>(null);
  const [note, setNote] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const loadItem = useCallback(async () => {
    if (!id) return;
    const res = await apiFetch<MobileLinkItem>(`/api/items/${encodeURIComponent(id)}`);
    if (res.ok && res.data) {
      setItem(res.data);
      setNote(res.data.note || res.data.user_note || "");
      setTagsText((res.data.tags || []).join(" "));
      setAiSummary(res.data.ai_summary || "");
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void loadItem();
    }, [loadItem]),
  );

  async function handleStatusChange(nextStatus: WorkflowStatus) {
    if (!item) return;
    setItem({ ...item, status: nextStatus });
    await patchLinkItem(item.id, { status: nextStatus });
  }

  async function handleRefreshPreview() {
    if (!item) return;
    setBusy("preview");
    const res = await refreshLinkPreview(item.id);
    setBusy("");
    if (res.ok && res.data) {
      const nextItem = (res.data as { item?: MobileLinkItem })?.item ?? res.data;
      setItem(nextItem);
      Alert.alert("รีเฟรชพรีวิวสำเร็จ");
    } else {
      Alert.alert("รีเฟรชพรีวิวไม่สำเร็จ", res.error || "กรุณาลองใหม่");
    }
  }

  async function handleAiSummarize() {
    if (!item) return;
    setBusy("ai");
    const res = await summarizeLinkItem(item.id, false);
    setBusy("");
    if (res.ok && res.data) {
      const summary = typeof res.data.summary_th === "string" ? res.data.summary_th : "";
      if (summary) setAiSummary(summary);
    } else {
      Alert.alert("สรุปด้วย AI ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
    }
  }

  async function handleSaveEdits() {
    if (!item) return;
    setBusy("save");
    const parsedTags = tagsText
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
    const res = await patchLinkItem(item.id, {
      note: note.trim(),
      tags: parsedTags,
    });
    setBusy("");
    if (res.ok) {
      Alert.alert("บันทึกการแก้ไขแล้ว");
      void loadItem();
    } else {
      Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่");
    }
  }

  async function handleQuickReminder(hoursAhead: number, repeatDays: number | null) {
    if (!item) return;
    setBusy("rem");
    const dt = new Date(Date.now() + hoursAhead * 3600 * 1000);
    const iso = dt.toISOString();
    const res = await saveReminder(item.id, {
      schedule_type: repeatDays ? "every_n_days" : "once",
      remind_at: iso,
      repeat_every_days: repeatDays,
    });
    const remRes = await apiFetch<{ reminders?: MobileLinkItem[] }>("/api/reminders");
    if (Array.isArray(remRes.data?.reminders)) {
      await syncLocalRemindersWithOs(remRes.data.reminders);
    }
    setBusy("");
    if (res.ok) {
      Alert.alert("ตั้งเวลาเตือนความจำแล้ว", `แจ้งเตือนเมื่อ ${dt.toLocaleString("th-TH")}`);
    } else {
      Alert.alert("ตั้งเตือนไม่สำเร็จ", res.error || "กรุณาลองใหม่");
    }
  }

  async function handleClearReminder() {
    if (!item) return;
    await deleteReminder(item.id);
    Alert.alert("ลบการแจ้งเตือนแล้ว");
  }

  function confirmDelete() {
    if (!item) return;
    Alert.alert("ลบลิงก์นี้?", "ลิงก์จะถูกลบออกจากพื้นที่ทำงานของคุณ", [
      { text: "ยกเลิก", style: "cancel" },
      {
        text: "ลบ",
        style: "destructive",
        onPress: () => {
          void deleteLinkItem(item.id).then((res) => {
            if (res.ok) router.back();
          });
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color="#9B2C2C" />
      </View>
    );
  }

  if (!item) {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.emptyTitle}>ไม่พบรายละเอียดลิงก์</Text>
      </View>
    );
  }

  const currentStatus = String(item.status || "inbox").toLowerCase();

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        {item.thumbnail_url ? (
          <Image source={{ uri: item.thumbnail_url }} style={styles.cover} resizeMode="cover" />
        ) : null}
        <View style={styles.cardBody}>
          <Text style={styles.platformBadge}>{item.platform || "web"}</Text>
          <Text style={styles.title}>{item.title || item.url}</Text>
          <Text style={styles.urlText} numberOfLines={2}>
            {item.url}
          </Text>
          <View style={styles.actionRow}>
            <Pressable style={styles.primaryBtn} onPress={() => void Linking.openURL(item.url)}>
              <Text style={styles.primaryBtnText}>เปิดลิงก์ ↗</Text>
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={() => void handleRefreshPreview()}>
              <Text style={styles.secondaryBtnText}>
                {busy === "preview" ? "กำลังดึง..." : "รีเฟรชพรีวิว"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>สถานะการอ่าน (4 ขั้น)</Text>
        <View style={styles.chipRow}>
          {STATUS_ITEMS.map((st) => {
            const active = currentStatus === st.id || (st.id === "done" && currentStatus === "read");
            return (
              <Pressable
                key={st.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => void handleStatusChange(st.id)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{st.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.sectionCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>✨ สรุปด้วย AI</Text>
          <Pressable style={styles.smallPrimaryBtn} onPress={() => void handleAiSummarize()}>
            <Text style={styles.smallPrimaryBtnText}>
              {busy === "ai" ? "กำลังสรุป..." : "สรุปเนื้อหา"}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.summaryText}>
          {aiSummary || "แตะ 'สรุปเนื้อหา' เพื่อให้ AI สรุปสาระสำคัญจากลิงก์นี้เป็นภาษาไทย"}
        </Text>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>โน้ตและแท็ก</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder="บันทึกส่วนตัว..."
          placeholderTextColor="#A8A29E"
          multiline
          value={note}
          onChangeText={setNote}
        />
        <TextInput
          style={styles.input}
          placeholder="#แท็ก คั่นด้วยเว้นวรรค"
          placeholderTextColor="#A8A29E"
          value={tagsText}
          onChangeText={setTagsText}
        />
        <Pressable style={styles.primaryBtn} onPress={() => void handleSaveEdits()}>
          <Text style={styles.primaryBtnText}>
            {busy === "save" ? "กำลังบันทึก..." : "บันทึกโน้ตและแท็ก"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>🔔 เตือนความจำ</Text>
        <View style={styles.chipRow}>
          <Pressable style={styles.chip} onPress={() => void handleQuickReminder(2, null)}>
            <Text style={styles.chipText}>อีก 2 ชม.</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => void handleQuickReminder(24, null)}>
            <Text style={styles.chipText}>พรุ่งนี้เวลานี้</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => void handleQuickReminder(72, 3)}>
            <Text style={styles.chipText}>ทวนทุก 3 วัน</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => void handleClearReminder()}>
            <Text style={styles.chipText}>ปิดการเตือน</Text>
          </Pressable>
        </View>
      </View>

      <Pressable style={styles.deleteBtn} onPress={confirmDelete}>
        <Text style={styles.deleteBtnText}>ลบลิงก์นี้ออก</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, gap: 14, paddingBottom: 36 },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: "#44403C" },
  card: {
    backgroundColor: "#FDFBF7",
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  cover: { width: "100%", height: 190, backgroundColor: "#EAE4DB" },
  cardBody: { padding: 16, gap: 8 },
  platformBadge: {
    alignSelf: "flex-start",
    fontSize: 11,
    fontWeight: "700",
    color: "#9B2C2C",
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    textTransform: "uppercase",
  },
  title: { fontSize: 18, fontWeight: "800", color: "#1C1917" },
  urlText: { fontSize: 12, color: "#78716C" },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  primaryBtn: {
    flex: 1,
    backgroundColor: "#9B2C2C",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  primaryBtnText: { color: "#FDFBF7", fontWeight: "700", fontSize: 14 },
  secondaryBtn: {
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryBtnText: { color: "#1C1917", fontWeight: "600", fontSize: 14 },
  sectionCard: {
    backgroundColor: "#FDFBF7",
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    gap: 10,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: "#1C1917" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#F3EFE6", paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: "#9B2C2C" },
  chipText: { fontSize: 13, fontWeight: "600", color: "#44403C" },
  chipTextActive: { color: "#FDFBF7" },
  smallPrimaryBtn: { backgroundColor: "#9B2C2C", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  smallPrimaryBtnText: { color: "#FDFBF7", fontSize: 12, fontWeight: "700" },
  summaryText: { fontSize: 14, color: "#44403C", lineHeight: 21 },
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
  textArea: { minHeight: 80, textAlignVertical: "top" },
  deleteBtn: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
  },
  deleteBtnText: { color: "#B91C1C", fontWeight: "700", fontSize: 15 },
});
