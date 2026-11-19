import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { runGuardedBusyAction } from "../../src/actionGuards";
import {
  apiFetch,
  deleteLinkItem,
  deleteReminder,
  patchLinkItem,
  refreshLinkPreview,
  resolveItemVideo,
  saveReminder,
  summarizeLinkItem,
  syncRemindersFromServer,
} from "../../src/api";
import {
  deriveVideoEmbedInfo,
  formatPostDetailTitleAndDesc,
  formatRemindTimeAndZone,
  getPreviewMediaImages,
  inferMobilePlatform,
  isGenericOrNoisyTitle,
  isPrivateOrRestrictedItem,
  resolveMobilePlayUrl,
  resolveMobileThumbUrl,
} from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  upsertCachedLinkItem,
  type MobileLinkItem,
} from "../../src/storage";

const _autoEnrichedItemIds = new Set<string>();

export default function ItemDetailScreen() {
  const { id, folderId } = useLocalSearchParams<{ id: string; folderId?: string }>();
  const router = useRouter();
  const cachedMatch = getMemoryCachedWorkspace()?.items.find((it) => it.id === id) || null;
  const [item, setItem] = useState<MobileLinkItem | null>(cachedMatch);
  const [note, setNote] = useState(cachedMatch?.note || cachedMatch?.user_note || "");
  const [tagsText, setTagsText] = useState(
    (cachedMatch?.tags || cachedMatch?.tag_names || []).join(" "),
  );
  const [aiSummary, setAiSummary] = useState(cachedMatch?.ai_summary || "");
  const [descExpanded, setDescExpanded] = useState(false);
  const [loading, setLoading] = useState(!cachedMatch);
  const [busy, setBusy] = useState("");
  const [carouselIdx, setCarouselIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [imageRatios, setImageRatios] = useState<Record<string, number>>({});
  const actionSeqRef = useRef(0);
  const activeIdRef = useRef<string | undefined>(id);
  activeIdRef.current = id;

  useEffect(() => {
    const match = getMemoryCachedWorkspace()?.items.find((it) => it.id === id) || null;
    setItem(match);
    setNote(match?.note || match?.user_note || "");
    setTagsText((match?.tags || match?.tag_names || []).join(" "));
    setAiSummary(match?.ai_summary || "");
    setDescExpanded(false);
    setCarouselIdx(0);
    setLoading(!match);
  }, [id]);

  const loadItem = useCallback(async () => {
    if (!id) return;
    const targetId = id;
    const startGen = getAuthGeneration();
    const res = await apiFetch<MobileLinkItem>(`/api/items/${encodeURIComponent(targetId)}`);
    if (getAuthGeneration() !== startGen || activeIdRef.current !== targetId) {
      if (activeIdRef.current === targetId) setLoading(false);
      return;
    }
    if (res.ok && res.data) {
      const loaded = res.data;
      setItem(loaded);
      setNote(loaded.note || loaded.user_note || "");
      setTagsText((loaded.tags || loaded.tag_names || []).join(" "));
      setAiSummary(loaded.ai_summary || "");
      void upsertCachedLinkItem(loaded).catch(() => {});

      const itemId = String(loaded.id || targetId);
      const targetUrl = String(loaded.canonical_url || loaded.url || "");
      const hasGenericTitle = isGenericOrNoisyTitle(loaded.title, loaded.platform || "", targetUrl);
      const descStr = String(loaded.description || "").trim();
      const hasCover = Boolean(resolveMobileThumbUrl(loaded));
      const isYt =
        /youtube\.com|youtu\.be/i.test(targetUrl) ||
        String(loaded.platform || "").toLowerCase() === "youtube";
      const isYtPlaceholderDesc = isYt && (descStr.startsWith("By ") || descStr.startsWith("วิดีโอ YouTube"));
      const hasDesc = Boolean(descStr) && !isYtPlaceholderDesc;
      const isYtVideo = isYt && !/youtube\.com\/(?:post\/|@|channel\/|c\/|user\/)/i.test(targetUrl);
      const needsAutoEnrich =
        !isPrivateOrRestrictedItem(loaded) &&
        loaded.enrich_status !== "failed" &&
        (!hasCover || !hasDesc || hasGenericTitle || (isYtVideo && !loaded.embed_url));

      if (itemId && needsAutoEnrich && !_autoEnrichedItemIds.has(itemId)) {
        _autoEnrichedItemIds.add(itemId);
        void refreshLinkPreview(itemId)
          .then((pvRes) => {
            if (getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
            const st = String(pvRes.data?.status || "").toLowerCase();
            if (pvRes.ok && st !== "failed" && pvRes.data) {
              const rawNext = (pvRes.data.item ?? pvRes.data) as MobileLinkItem;
              const merged: MobileLinkItem = { ...loaded, ...rawNext, id: itemId };
              setItem(merged);
              void upsertCachedLinkItem(merged).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }
    if (activeIdRef.current === targetId) setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void loadItem();
    }, [loadItem]),
  );

  const mediaImages = useMemo(() => getPreviewMediaImages(item), [item]);
  const derivedVideo = useMemo(() => deriveVideoEmbedInfo(item), [item]);
  const coverUri = resolveMobileThumbUrl(item) || mediaImages[0] || derivedVideo.thumbUrl || "";
  const activeSlideIndex = mediaImages.length > 0 ? ((carouselIdx % mediaImages.length) + mediaImages.length) % mediaImages.length : 0;
  const activeSlideUri = mediaImages[activeSlideIndex] || coverUri;

  useEffect(() => {
    setCarouselIdx(0);
  }, [item?.id]);

  useEffect(() => {
    if (!activeSlideUri || imageRatios[activeSlideUri]) return;
    let cancelled = false;
    Image.getSize(
      activeSlideUri,
      (w, h) => {
        if (cancelled || w <= 0 || h <= 0) return;
        const clamped = Math.max(0.72, Math.min(1.91, w / h));
        setImageRatios((prev) => (prev[activeSlideUri] ? prev : { ...prev, [activeSlideUri]: clamped }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [activeSlideUri, imageRatios]);

  function openExternalUrlSafe(rawInput?: string | null) {
    const rawUrl = String(rawInput ?? item?.url ?? "").trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      Alert.alert("ลิงก์ไม่ปลอดภัย", "อนุญาตเปิดเฉพาะลิงก์ http หรือ https เท่านั้น");
      return;
    }
    void Linking.openURL(rawUrl);
  }

  async function handlePlayVideo() {
    if (!item || !derivedVideo.embedUrl || videoLoading) return;
    const startGen = getAuthGeneration();
    const isIg =
      String(item.platform || "").toLowerCase() === "instagram" ||
      /instagram\.com/i.test(String(item.url || ""));

    let directMp4: string | null = null;
    if (isIg && item.id) {
      setVideoLoading(true);
      try {
        const res = await resolveItemVideo(item.id);
        if (getAuthGeneration() !== startGen) {
          setVideoLoading(false);
          return;
        }
        if (res.ok && res.data?.video_url) {
          directMp4 = res.data.video_url;
        }
      } catch {
        // Fallback below
      } finally {
        setVideoLoading(false);
      }
    }

    const targetPlayUrl = resolveMobilePlayUrl(item, derivedVideo.embedUrl, directMp4);
    if (!targetPlayUrl) return;

    try {
      await WebBrowser.openBrowserAsync(targetPlayUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor: "#9B2C2C",
      });
    } catch {
      openExternalUrlSafe(targetPlayUrl);
    }
  }

  async function handleToggleSeen() {
    if (!item) return;
    const prevItem = item;
    const cur = String(item.status || "inbox").toLowerCase();
    const currentlySeen = cur === "done" || cur === "read";
    const nextStatus = currentlySeen ? "inbox" : "done";
    const startGen = getAuthGeneration();
    const optimistic: MobileLinkItem = { ...item, status: nextStatus };
    setItem(optimistic);
    const res = await patchLinkItem(item.id, { status: nextStatus });
    if (getAuthGeneration() !== startGen) return;
    if (!res.ok) {
      setItem(prevItem);
      return;
    }
    void upsertCachedLinkItem(optimistic).catch(() => {});
  }

  async function handleAiSummarize() {
    if (!item) return;
    const targetId = item.id;
    const prevSnapshot = item;
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "ai" : ""),
      async (isStale) => {
        const res = await summarizeLinkItem(targetId, false);
        if (isStale()) return;
        if (res.ok && res.data) {
          const summary = typeof res.data.summary_th === "string" ? res.data.summary_th : "";
          const suggested = Array.isArray(res.data.suggested_tags)
            ? res.data.suggested_tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
            : [];
          if (summary) {
            setAiSummary(summary);
          }
          const updatedItem: MobileLinkItem = {
            ...prevSnapshot,
            ...(summary ? { ai_summary: summary } : {}),
            ...(suggested.length ? { tags: suggested, tag_names: suggested } : {}),
          };
          setItem(updatedItem);
          if (suggested.length && !tagsText.trim()) {
            setTagsText(suggested.join(" "));
          }
          await upsertCachedLinkItem(updatedItem).catch(() => {});
        } else {
          Alert.alert("สรุปด้วย AI ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        }
      },
    );
  }

  async function handleSaveEdits() {
    if (!item) return;
    const targetId = item.id;
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "save" : ""),
      async (isStale) => {
        const parsedTags = tagsText
          .split(/[\s,]+/)
          .map((t) => t.replace(/^#/, "").trim())
          .filter(Boolean);
        const res = await patchLinkItem(targetId, {
          note: note.trim(),
          tags: parsedTags,
        });
        if (isStale()) return;
        if (res.ok) {
          Alert.alert("บันทึกการแก้ไขแล้ว");
          void loadItem();
        } else {
          Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        }
      },
    );
  }

  async function handleQuickReminder(hoursAhead: number, repeatDays: number | null) {
    if (!item) return;
    const targetId = item.id;
    const itemSt = String(item.status || "inbox").toLowerCase();
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "rem" : ""),
      async (isStale) => {
        if (itemSt === "done" || itemSt === "read" || itemSt === "archived") {
          Alert.alert(
            "ตั้งเตือนไม่ได้",
            "ลิงก์นี้อยู่ในสถานะอ่านแล้วหรือเก็บถาวร กรุณาเปลี่ยนสถานะเป็นกล่องรับหรือรออ่านก่อนตั้งเตือน",
          );
          return;
        }
        const dt = new Date(Date.now() + hoursAhead * 3600 * 1000);
        const iso = dt.toISOString();
        const { remind_time, timezone } = formatRemindTimeAndZone(dt);
        const res = await saveReminder(targetId, {
          schedule_type: repeatDays ? "every_n_days" : "once",
          remind_at: iso,
          remind_time,
          timezone,
          repeat_every_days: repeatDays,
        });
        if (isStale()) return;
        if (!res.ok) {
          if (res.status === 409) {
            Alert.alert(
              "ตั้งเตือนไม่ได้",
              "ไม่สามารถตั้งเตือนให้ลิงก์ที่อ่านแล้วหรือเก็บถาวรได้",
            );
          } else {
            Alert.alert("ตั้งเตือนไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          }
          return;
        }
        await syncRemindersFromServer();
        if (isStale()) return;
        Alert.alert("ตั้งเวลาเตือนความจำแล้ว", `แจ้งเตือนเมื่อ ${dt.toLocaleString("th-TH")}`);
      },
    );
  }

  async function handleClearReminder() {
    if (!item) return;
    const targetId = item.id;
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "rem" : ""),
      async (isStale) => {
        const res = await deleteReminder(targetId);
        if (isStale()) return;
        if (!res.ok) {
          Alert.alert("ปิดการเตือนไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          return;
        }
        await syncRemindersFromServer();
        if (isStale()) return;
        Alert.alert("ลบการแจ้งเตือนแล้ว");
      },
    );
  }

  function confirmDelete() {
    if (!item) return;
    const modalGen = getAuthGeneration();
    Alert.alert("ลบลิงก์นี้?", "ลิงก์จะถูกลบออกจากพื้นที่ทำงานของคุณ", [
      { text: "ยกเลิก", style: "cancel" },
      {
        text: "ลบ",
        style: "destructive",
        onPress: () => {
          if (getAuthGeneration() !== modalGen) return;
          void deleteLinkItem(item.id).then((res) => {
            if (getAuthGeneration() !== modalGen) return;
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
  const isSeen = currentStatus === "done" || currentStatus === "read";
  const isPrivate = isPrivateOrRestrictedItem(item);
  const platBadge = inferMobilePlatform(item);
  const { displayTitle, displayDesc } = formatPostDetailTitleAndDesc(item);
  const originalDescription = (displayDesc || String(item.description || "").trim()).trim();
  const showDescToggle = originalDescription.length > 160 || originalDescription.includes("\n");
  const allCachedItems = getMemoryCachedWorkspace()?.items || [];
  const scopedItems = folderId
    ? folderId === "virtual-inbox"
      ? allCachedItems.filter((it) => !it.folder_id)
      : allCachedItems.filter((it) => it.folder_id === folderId)
    : allCachedItems;
  const navIds = scopedItems.map((it) => it.id).filter(Boolean);
  const navIdx = id ? navIds.indexOf(id) : -1;
  const prevNavId = navIdx > 0 ? navIds[navIdx - 1] : null;
  const nextNavId = navIdx >= 0 && navIdx < navIds.length - 1 ? navIds[navIdx + 1] : null;
  const goToAdjacentItem = (targetId: string | null) => {
    if (!targetId) return;
    router.replace(
      folderId
        ? (`/item/${encodeURIComponent(targetId)}?folderId=${encodeURIComponent(folderId)}` as never)
        : (`/item/${encodeURIComponent(targetId)}` as never),
    );
  };
  const activeAspect =
    (activeSlideUri && imageRatios[activeSlideUri]) ||
    (derivedVideo.embedUrl && derivedVideo.isVertical ? 0.8 : 1.58);
  const totalSlides = mediaImages.length;
  const isLastSlide = totalSlides >= 2 && activeSlideIndex === totalSlides - 1;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {navIds.length > 1 && navIdx >= 0 ? (
          <View style={styles.navBar}>
            <Pressable
              style={[styles.navBtn, !prevNavId && styles.navBtnDisabled]}
              disabled={!prevNavId}
              onPress={() => goToAdjacentItem(prevNavId)}
            >
              <Text style={[styles.navBtnText, !prevNavId && styles.navBtnTextDisabled]}>‹ ก่อนหน้า</Text>
            </Pressable>
            <Text style={styles.navCounter}>
              {navIdx + 1} / {navIds.length}
            </Text>
            <Pressable
              style={[styles.navBtn, !nextNavId && styles.navBtnDisabled]}
              disabled={!nextNavId}
              onPress={() => goToAdjacentItem(nextNavId)}
            >
              <Text style={[styles.navBtnText, !nextNavId && styles.navBtnTextDisabled]}>ถัดไป ›</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.card}>
          {derivedVideo.embedUrl ? (
            <Pressable
              style={[styles.mediaContainer, { aspectRatio: activeAspect }]}
              onPress={() => void handlePlayVideo()}
            >
              {coverUri ? (
                <Image source={{ uri: coverUri }} style={styles.mediaFill} resizeMode="cover" />
              ) : (
                <View style={styles.videoFallbackPoster} />
              )}
              <View style={styles.playBtnCircle}>
                {videoLoading ? (
                  <ActivityIndicator color="#FDFBF7" />
                ) : (
                  <Text style={styles.playBtnIcon}>▶</Text>
                )}
              </View>
              <View style={styles.mediaBadge}>
                <Text style={styles.mediaBadgeText}>
                  {derivedVideo.platform || platBadge || "Video"} ·{" "}
                  {videoLoading ? "กำลังเตรียมคลิป..." : "แตะเพื่อเล่น"}
                </Text>
              </View>
            </Pressable>
          ) : totalSlides >= 2 ? (
            <View style={[styles.mediaContainer, { aspectRatio: activeAspect }]}>
              <Pressable style={styles.mediaFill} onPress={() => setLightboxOpen(true)}>
                <Image source={{ uri: activeSlideUri }} style={styles.mediaFill} resizeMode="cover" />
              </Pressable>
              <Pressable
                style={[styles.carouselArrow, styles.carouselArrowLeft]}
                hitSlop={8}
                onPress={() => setCarouselIdx((prev) => (prev - 1 + totalSlides) % totalSlides)}
              >
                <Text style={styles.carouselArrowText}>‹</Text>
              </Pressable>
              <Pressable
                style={[styles.carouselArrow, styles.carouselArrowRight]}
                hitSlop={8}
                onPress={() => setCarouselIdx((prev) => (prev + 1) % totalSlides)}
              >
                <Text style={styles.carouselArrowText}>›</Text>
              </Pressable>
              <View style={styles.mediaBadge}>
                <Text style={styles.mediaBadgeText}>
                  {activeSlideIndex + 1}/{totalSlides}
                </Text>
              </View>
              <Pressable style={styles.zoomBtn} onPress={() => setLightboxOpen(true)}>
                <Text style={styles.zoomBtnText}>⤢ ขยาย</Text>
              </Pressable>
              {isLastSlide ? (
                <Pressable style={styles.moreInPostBtn} onPress={() => openExternalUrlSafe(item.url)}>
                  <Text style={styles.moreInPostText}>ดูรูปทั้งหมดในโพสต์ต้นฉบับ ↗</Text>
                </Pressable>
              ) : null}
              <View style={styles.dotsRow}>
                {mediaImages.map((_, idx) => (
                  <Pressable
                    key={`dot-${idx}`}
                    hitSlop={6}
                    onPress={() => setCarouselIdx(idx)}
                    style={[styles.dot, idx === activeSlideIndex && styles.dotActive]}
                  />
                ))}
              </View>
            </View>
          ) : coverUri ? (
            <View style={[styles.mediaContainer, { aspectRatio: activeAspect }]}>
              <Pressable style={styles.mediaFill} onPress={() => setLightboxOpen(true)}>
                <Image source={{ uri: coverUri }} style={styles.mediaFill} resizeMode="cover" />
              </Pressable>
              <Pressable style={styles.zoomBtn} onPress={() => setLightboxOpen(true)}>
                <Text style={styles.zoomBtnText}>⤢ ขยาย</Text>
              </Pressable>
            </View>
          ) : isPrivate ? (
            <View style={styles.privateBox}>
              <Text style={styles.privateTitle}>ไม่สามารถแสดงตัวอย่างได้</Text>
              <Text style={styles.privateSub}>
                โพสต์นี้เป็นแบบส่วนตัว (Private) หรือถูกจำกัดสิทธิ์การเข้าถึง กรุณากดเปิดลิงก์ต้นฉบับเพื่อดูเนื้อหา
              </Text>
            </View>
          ) : null}

          <View style={styles.cardBody}>
            <Text style={styles.platformBadge}>{platBadge || "web"}</Text>
            <Text style={styles.title}>{displayTitle || item.title || item.url}</Text>
            <Text style={styles.urlText} numberOfLines={2}>
              {item.url}
            </Text>
            <View style={styles.actionRow}>
              <Pressable style={styles.primaryBtn} onPress={() => openExternalUrlSafe(item.url)}>
                <Text style={styles.primaryBtnText}>เปิดลิงก์ ↗</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryBtn, isSeen && styles.seenBtnActive]}
                onPress={() => void handleToggleSeen()}
              >
                <Text style={[styles.secondaryBtnText, isSeen && styles.seenBtnTextActive]}>
                  {isSeen ? "✓ ดูแล้ว" : "○ ยังไม่ดู"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>คำอธิบายจากโพสต์ต้นฉบับ</Text>
          {originalDescription ? (
            <>
              <Text style={styles.descText} numberOfLines={descExpanded ? undefined : 4}>
                {originalDescription}
              </Text>
              {showDescToggle ? (
                <Pressable style={styles.descToggleBtn} onPress={() => setDescExpanded((v) => !v)}>
                  <Text style={styles.descToggleText}>
                    {descExpanded ? "ย่อข้อความ ▲" : "อ่านเพิ่มเติม ▼"}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyDescText}>ไม่มีคำอธิบายจากโพสต์ต้นฉบับ</Text>
          )}
        </View>

        <View style={[styles.sectionCard, styles.aiSectionCard]}>
          <View style={styles.rowBetween}>
            <Text style={[styles.sectionTitle, styles.aiSectionTitle]}>✨ สรุปจากต้นฉบับ</Text>
            <Pressable style={styles.smallPrimaryBtn} onPress={() => void handleAiSummarize()}>
              <Text style={styles.smallPrimaryBtnText}>
                {busy === "ai" ? "กำลังสรุป..." : aiSummary ? "สรุปใหม่" : "สรุปเนื้อหา"}
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
            <Pressable style={styles.chip} onPress={() => void handleQuickReminder(72, null)}>
              <Text style={styles.chipText}>อีก 3 วัน</Text>
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

      <Modal
        visible={lightboxOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setLightboxOpen(false)}
      >
        <View style={styles.lightboxBackdrop}>
          <View style={styles.lightboxTopBar}>
            <Text style={styles.lightboxCounter}>
              {totalSlides > 1 ? `${activeSlideIndex + 1} / ${totalSlides}` : "1 / 1"}
            </Text>
            <Pressable style={styles.lightboxCloseBtn} onPress={() => setLightboxOpen(false)}>
              <Text style={styles.lightboxCloseText}>✕ ปิด</Text>
            </Pressable>
          </View>

          <View style={styles.lightboxStage}>
            {activeSlideUri ? (
              <Image
                source={{ uri: activeSlideUri }}
                style={styles.lightboxImage}
                resizeMode="contain"
              />
            ) : null}
            {totalSlides > 1 ? (
              <>
                <Pressable
                  style={[styles.carouselArrow, styles.carouselArrowLeft]}
                  onPress={() => setCarouselIdx((prev) => (prev - 1 + totalSlides) % totalSlides)}
                >
                  <Text style={styles.carouselArrowText}>‹</Text>
                </Pressable>
                <Pressable
                  style={[styles.carouselArrow, styles.carouselArrowRight]}
                  onPress={() => setCarouselIdx((prev) => (prev + 1) % totalSlides)}
                >
                  <Text style={styles.carouselArrowText}>›</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
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
  mediaContainer: {
    width: "100%",
    backgroundColor: "#1C1917",
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  mediaFill: {
    width: "100%",
    height: "100%",
  },
  videoFallbackPoster: {
    width: "100%",
    height: "100%",
    backgroundColor: "#292524",
  },
  playBtnCircle: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "rgba(155, 44, 44, 0.92)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FDFBF7",
  },
  playBtnIcon: {
    color: "#FDFBF7",
    fontSize: 22,
    fontWeight: "800",
    marginLeft: 3,
  },
  mediaBadge: {
    position: "absolute",
    top: 10,
    left: 10,
    backgroundColor: "rgba(28, 25, 23, 0.78)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  mediaBadgeText: {
    color: "#FDFBF7",
    fontSize: 11,
    fontWeight: "700",
  },
  zoomBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(28, 25, 23, 0.78)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  zoomBtnText: {
    color: "#FDFBF7",
    fontSize: 11,
    fontWeight: "700",
  },
  carouselArrow: {
    position: "absolute",
    top: "42%",
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(28, 25, 23, 0.75)",
    alignItems: "center",
    justifyContent: "center",
  },
  carouselArrowLeft: { left: 10 },
  carouselArrowRight: { right: 10 },
  carouselArrowText: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 24,
  },
  moreInPostBtn: {
    position: "absolute",
    bottom: 28,
    backgroundColor: "rgba(155, 44, 44, 0.92)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  moreInPostText: {
    color: "#FDFBF7",
    fontSize: 11,
    fontWeight: "700",
  },
  dotsRow: {
    position: "absolute",
    bottom: 10,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "rgba(255,255,255,0.45)",
  },
  dotActive: {
    width: 18,
    backgroundColor: "#FDFBF7",
  },
  privateBox: {
    backgroundColor: "#F3EFE6",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#EAE4DB",
    gap: 4,
  },
  privateTitle: { fontSize: 13, fontWeight: "700", color: "#9B2C2C" },
  privateSub: { fontSize: 12, color: "#57534E", lineHeight: 18 },
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
  descText: { fontSize: 13, color: "#44403C", lineHeight: 19 },
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
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: "rgba(12, 10, 9, 0.95)",
    justifyContent: "space-between",
    paddingVertical: 48,
  },
  lightboxTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  lightboxCounter: {
    color: "#FAFAF9",
    fontSize: 14,
    fontWeight: "700",
  },
  lightboxCloseBtn: {
    backgroundColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
  lightboxCloseText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  lightboxStage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  lightboxImage: {
    width: "100%",
    height: "100%",
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FDFBF7",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  navBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: "#F3EFE6",
  },
  navBtnDisabled: {
    opacity: 0.4,
  },
  navBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1C1917",
  },
  navBtnTextDisabled: {
    color: "#78716C",
  },
  navCounter: {
    fontSize: 12,
    fontWeight: "700",
    color: "#78716C",
  },
  seenBtnActive: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  seenBtnTextActive: {
    color: "#065F46",
  },
  descToggleBtn: {
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  descToggleText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#9B2C2C",
  },
  emptyDescText: {
    fontSize: 13,
    color: "#78716C",
  },
  aiSectionCard: {
    backgroundColor: "#F1EEFF",
    borderColor: "#DDD6FE",
  },
  aiSectionTitle: {
    color: "#4C1D95",
  },
});
