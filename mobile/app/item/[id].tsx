import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Linking,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
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
import { FIGMA_INK, getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import {
  buildCustomReminderDate,
  buildMobileMonthCalendar,
  deriveVideoEmbedInfo,
  formatPostDetailTitleAndDesc,
  formatRemindTimeAndZone,
  getPreviewMediaImages,
  inferMobileDomain,
  inferMobilePlatform,
  isGenericOrNoisyTitle,
  isPrivateOrRestrictedItem,
  resolveInlinePlayerSource,
  resolveMobileThumbUrl,
  resolveOriginalDescription,
  shiftYearMonth,
  type InlinePlayerSource,
} from "../../src/itemHelpers";
import {
  getAuthGeneration,
  getMemoryCachedWorkspace,
  loadCachedWorkspace,
  loadFigmaAccentTheme,
  subscribeFigmaAccentTheme,
  upsertCachedLinkItem,
  type CachedWorkspace,
  type MobileLinkItem,
} from "../../src/storage";

const CHERRY_SELECTED_IMG = require("../../assets/figma/cherry-selected.png");
const CHERRY_UNSELECTED_IMG = require("../../assets/figma/cherry-unselected.png");

const QUICK_TAG_SUGGESTIONS = ["#อ่านทีหลัง", "#คาเฟ่", "#เที่ยว", "#ไอเดีย", "#อาหาร"];

const PULL_EDGE_HINT_PX = 16;
const PULL_EDGE_TRIGGER_PX = 56;
const EDGE_SCROLL_TOLERANCE_PX = 4;
const ANDROID_EDGE_FLICK_VELOCITY = 0.45;
type PullEdgeState = "none" | "pull_prev" | "ready_prev" | "pull_next" | "ready_next";

function resolvePullEdgeState(
  direction: "prev" | "next" | "none",
  distancePx: number,
): PullEdgeState {
  if (direction === "none" || distancePx < PULL_EDGE_HINT_PX) return "none";
  if (direction === "prev") {
    return distancePx >= PULL_EDGE_TRIGGER_PX ? "ready_prev" : "pull_prev";
  }
  return distancePx >= PULL_EDGE_TRIGGER_PX ? "ready_next" : "pull_next";
}

const _autoEnrichedItemIds = new Set<string>();

function parseTagList(rawText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of rawText.split(/[\s,]+/)) {
    const cleaned = part.replace(/^#/, "").trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  }
  return out;
}

export default function ItemDetailScreen() {
  const { id, folderId } = useLocalSearchParams<{ id: string; folderId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();

  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");
  const theme = getFigmaTheme(themeId);

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
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false);
  const [reminderModalOpen, setReminderModalOpen] = useState(false);
  const [reminderLabelOverride, setReminderLabelOverride] = useState<string | null>(null);
  const nowSeed = new Date();
  const [remYearMonth, setRemYearMonth] = useState(
    `${nowSeed.getFullYear()}-${String(nowSeed.getMonth() + 1).padStart(2, "0")}`,
  );
  const [remDay, setRemDay] = useState(nowSeed.getDate());
  const [remHourText, setRemHourText] = useState("18");
  const [remMinuteText, setRemMinuteText] = useState("00");
  const [remRepeatDays, setRemRepeatDays] = useState<number | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [inlinePlayer, setInlinePlayer] = useState<InlinePlayerSource | null>(null);
  const [imageRatios, setImageRatios] = useState<Record<string, number>>({});
  const [diskWs, setDiskWs] = useState<CachedWorkspace | null>(null);
  const [pullEdgeState, setPullEdgeState] = useState<PullEdgeState>("none");
  const [androidCanScroll, setAndroidCanScroll] = useState(true);
  const actionSeqRef = useRef(0);
  const activeIdRef = useRef<string | undefined>(id);
  const mountedRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  const isDraggingScrollRef = useRef(false);
  const pullEdgeStateRef = useRef<PullEdgeState>("none");
  const navLockRef = useRef(false);
  const scrollMetricsRef = useRef({
    scrollY: 0,
    contentHeight: 0,
    layoutHeight: 0,
    maxScrollY: 0,
  });
  const androidCanScrollRef = useRef(true);
  const androidPanActiveRef = useRef(false);
  const androidDragStartEdgeRef = useRef({ atTop: false, atBottom: false });
  const androidPullOffset = useRef(new Animated.Value(0)).current;
  const navMetaRef = useRef<{
    count: number;
    idx: number;
    prevNavId: string | null;
    nextNavId: string | null;
  }>({ count: 0, idx: -1, prevNavId: null, nextNavId: null });
  const goToAdjacentItemRef = useRef<(targetId: string | null) => void>(() => {});
  activeIdRef.current = id;

  const setPullStateIfChanged = (next: PullEdgeState) => {
    if (pullEdgeStateRef.current === next) return;
    pullEdgeStateRef.current = next;
    setPullEdgeState(next);
  };

  const updateScrollMetrics = (
    patch: Partial<{ scrollY: number; contentHeight: number; layoutHeight: number }>,
  ) => {
    const prev = scrollMetricsRef.current;
    const scrollY = patch.scrollY ?? prev.scrollY;
    const contentHeight = patch.contentHeight ?? prev.contentHeight;
    const layoutHeight = patch.layoutHeight ?? prev.layoutHeight;
    const maxScrollY = layoutHeight > 0 ? Math.max(0, contentHeight - layoutHeight) : 0;
    scrollMetricsRef.current = { scrollY, contentHeight, layoutHeight, maxScrollY };

    if (Platform.OS === "android" && layoutHeight > 0 && contentHeight > 0) {
      const nextCanScroll = maxScrollY > 2;
      if (androidCanScrollRef.current !== nextCanScroll) {
        androidCanScrollRef.current = nextCanScroll;
        setAndroidCanScroll(nextCanScroll);
      }
    }
  };

  const getAndroidEdgeFlags = () => {
    const { scrollY, maxScrollY } = scrollMetricsRef.current;
    return {
      atTop: scrollY <= EDGE_SCROLL_TOLERANCE_PX,
      atBottom: scrollY >= Math.max(0, maxScrollY - EDGE_SCROLL_TOLERANCE_PX),
    };
  };

  const resetAndroidPullOffset = (animated = true) => {
    if (!animated) {
      androidPullOffset.stopAnimation();
      androidPullOffset.setValue(0);
      return;
    }
    Animated.spring(androidPullOffset, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 6,
      speed: 22,
    }).start();
  };

  const shouldHandleAndroidEdgePan = (dx: number, dy: number) => {
    if (Platform.OS !== "android" || navLockRef.current) return false;
    const meta = navMetaRef.current;
    if (meta.count <= 1 || meta.idx < 0) return false;
    const absDy = Math.abs(dy);
    const absDx = Math.abs(dx);
    if (absDy < 6 || absDy <= absDx * 1.2) return false;
    const { atTop, atBottom } = getAndroidEdgeFlags();
    return (dy > 0 && atTop) || (dy < 0 && atBottom);
  };

  const androidPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, gs) => shouldHandleAndroidEdgePan(gs.dx, gs.dy),
      onMoveShouldSetPanResponderCapture: (_evt, gs) => shouldHandleAndroidEdgePan(gs.dx, gs.dy),
      onPanResponderGrant: () => {
        androidPanActiveRef.current = true;
      },
      onPanResponderMove: (_evt, gs) => {
        const { atTop, atBottom } = getAndroidEdgeFlags();
        if (gs.dy > 0 && atTop) {
          const pullPx = gs.dy;
          setPullStateIfChanged(resolvePullEdgeState("prev", pullPx));
          androidPullOffset.setValue(Math.min(36, pullPx * 0.35));
        } else if (gs.dy < 0 && atBottom) {
          const pullPx = -gs.dy;
          setPullStateIfChanged(resolvePullEdgeState("next", pullPx));
          androidPullOffset.setValue(-Math.min(36, pullPx * 0.35));
        } else {
          setPullStateIfChanged("none");
          androidPullOffset.setValue(0);
        }
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_evt, gs) => {
        androidPanActiveRef.current = false;
        const meta = navMetaRef.current;
        const currentState = pullEdgeStateRef.current;
        const { atTop, atBottom } = getAndroidEdgeFlags();
        setPullStateIfChanged("none");
        resetAndroidPullOffset(true);
        if (meta.count <= 1 || meta.idx < 0) return;
        if ((currentState === "ready_prev" || (gs.dy >= PULL_EDGE_TRIGGER_PX && atTop)) && meta.prevNavId) {
          goToAdjacentItemRef.current(meta.prevNavId);
        } else if (
          (currentState === "ready_next" || (gs.dy <= -PULL_EDGE_TRIGGER_PX && atBottom)) &&
          meta.nextNavId
        ) {
          goToAdjacentItemRef.current(meta.nextNavId);
        }
      },
      onPanResponderTerminate: () => {
        androidPanActiveRef.current = false;
        setPullStateIfChanged("none");
        resetAndroidPullOffset(true);
      },
    }),
  ).current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  useEffect(() => {
    actionSeqRef.current += 1;
    setBusy("");
    setVideoLoading(false);
    setInlinePlayer(null);
    navLockRef.current = false;
    isDraggingScrollRef.current = false;
    androidPanActiveRef.current = false;
    androidDragStartEdgeRef.current = { atTop: false, atBottom: false };
    scrollMetricsRef.current.scrollY = 0;
    androidCanScrollRef.current = true;
    setAndroidCanScroll(true);
    resetAndroidPullOffset(false);
    pullEdgeStateRef.current = "none";
    setPullEdgeState("none");
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    const mem = getMemoryCachedWorkspace();
    if (!mem?.items?.length) {
      void loadCachedWorkspace()
        .then((loaded) => {
          if (mountedRef.current && loaded.items.length > 0) setDiskWs(loaded);
        })
        .catch(() => {});
    }
    const match = mem?.items.find((it) => it.id === id) || null;
    setItem(match);
    setNote(match?.note || match?.user_note || "");
    setTagsText((match?.tags || match?.tag_names || []).join(" "));
    setAiSummary(match?.ai_summary || "");
    setDescExpanded(false);
    setCarouselIdx(0);
    setReminderLabelOverride(null);
    setAiConfirmOpen(false);
    setNoteModalOpen(false);
    setTagModalOpen(false);
    setReminderModalOpen(false);
    setLightboxOpen(false);
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
              setItem((cur) => {
                if (!cur || cur.id !== itemId) return cur;
                const merged: MobileLinkItem = { ...cur, ...rawNext, id: itemId };
                void upsertCachedLinkItem(merged).catch(() => {});
                return merged;
              });
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
  const activeSlideIndex =
    mediaImages.length > 0 ? ((carouselIdx % mediaImages.length) + mediaImages.length) % mediaImages.length : 0;
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
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(rawUrl)) {
      Alert.alert("ลิงก์ไม่ปลอดภัย", "อนุญาตเปิดเฉพาะลิงก์ http หรือ https เท่านั้น");
      return;
    }
    void Linking.openURL(rawUrl).catch(() => {
      Alert.alert("ไม่สามารถเปิดลิงก์ได้", "กรุณาตรวจสอบแอปเบราว์เซอร์ในเครื่อง");
    });
  }

  async function handlePlayVideo() {
    if (!item || !derivedVideo.embedUrl || videoLoading) return;
    const targetId = item.id;
    const startGen = getAuthGeneration();
    const playSeq = actionSeqRef.current;
    const isIg =
      String(item.platform || "").toLowerCase() === "instagram" ||
      /instagram\.com/i.test(String(item.url || ""));

    let directMp4: string | null = null;
    if (isIg && targetId) {
      setVideoLoading(true);
      try {
        const res = await resolveItemVideo(targetId);
        if (
          !mountedRef.current ||
          getAuthGeneration() !== startGen ||
          activeIdRef.current !== targetId ||
          actionSeqRef.current !== playSeq
        ) {
          return;
        }
        if (res.ok && res.data?.video_url) {
          directMp4 = res.data.video_url;
        }
      } catch {
        // Fallback below
      } finally {
        if (mountedRef.current && activeIdRef.current === targetId) {
          setVideoLoading(false);
        }
      }
    }
    if (
      !mountedRef.current ||
      getAuthGeneration() !== startGen ||
      activeIdRef.current !== targetId ||
      actionSeqRef.current !== playSeq
    ) {
      return;
    }

    const playerSource = resolveInlinePlayerSource(derivedVideo.embedUrl, directMp4);
    if (playerSource) {
      setInlinePlayer(playerSource);
      return;
    }

    openExternalUrlSafe(item.url);
  }

  async function handleToggleSeen() {
    if (!item) return;
    const targetId = item.id;
    const prevStatus = item.status;
    const curStr = String(prevStatus || "inbox").toLowerCase();
    const currentlySeen = curStr === "done" || curStr === "read";
    const nextStatus = currentlySeen ? "inbox" : "done";
    const startGen = getAuthGeneration();
    setItem((cur) => (cur && cur.id === targetId ? { ...cur, status: nextStatus } : cur));
    const res = await patchLinkItem(targetId, { status: nextStatus });
    if (getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
    if (!res.ok) {
      setItem((cur) => (cur && cur.id === targetId ? { ...cur, status: prevStatus } : cur));
      return;
    }
    setItem((cur) => {
      if (cur && cur.id === targetId) {
        void upsertCachedLinkItem(cur).catch(() => {});
      }
      return cur;
    });
  }

  async function handleToggleFavorite() {
    if (!item) return;
    const targetId = item.id;
    const prevFav = Boolean(item.is_favorite);
    const nextFav = !prevFav;
    const startGen = getAuthGeneration();
    setItem((cur) => (cur && cur.id === targetId ? { ...cur, is_favorite: nextFav } : cur));
    const res = await patchLinkItem(targetId, { is_favorite: nextFav });
    if (getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
    if (!res.ok) {
      setItem((cur) => (cur && cur.id === targetId ? { ...cur, is_favorite: prevFav } : cur));
      return;
    }
    setItem((cur) => {
      if (cur && cur.id === targetId) {
        void upsertCachedLinkItem(cur).catch(() => {});
      }
      return cur;
    });
  }

  async function handleAiSummarize() {
    if (!item) return;
    const targetId = item.id;
    const startGen = getAuthGeneration();
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "ai" : ""),
      async (isStale) => {
        const res = await summarizeLinkItem(targetId, Boolean(aiSummary));
        if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
        if (res.ok && res.data) {
          const summary = typeof res.data.summary_th === "string" ? res.data.summary_th : "";
          const suggested = Array.isArray(res.data.suggested_tags)
            ? res.data.suggested_tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean)
            : [];
          if (summary) {
            setAiSummary(summary);
          }
          if (suggested.length && !tagsText.trim()) {
            setTagsText(suggested.join(" "));
          }
          setItem((cur) => {
            if (!cur || cur.id !== targetId) return cur;
            const nextItem: MobileLinkItem = {
              ...cur,
              ...(summary ? { ai_summary: summary } : {}),
              ...(suggested.length ? { tags: suggested, tag_names: suggested } : {}),
            };
            void upsertCachedLinkItem(nextItem).catch(() => {});
            return nextItem;
          });
        } else {
          Alert.alert("สรุปด้วย AI ไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        }
      },
    );
  }

  async function handleSaveEdits(overrideNote?: string, overrideTags?: string[]) {
    if (!item) return;
    const targetId = item.id;
    const startGen = getAuthGeneration();
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "save" : ""),
      async (isStale) => {
        const nextNote = typeof overrideNote === "string" ? overrideNote : note;
        const nextTags = Array.isArray(overrideTags) ? overrideTags : parseTagList(tagsText);
        const res = await patchLinkItem(targetId, {
          note: nextNote.trim(),
          tags: nextTags,
        });
        if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
        if (res.ok) {
          setNote(nextNote.trim());
          setTagsText(nextTags.join(" "));
          setNoteModalOpen(false);
          setTagModalOpen(false);
          setTagDraft("");
          setItem((cur) => {
            if (!cur || cur.id !== targetId) return cur;
            const updated: MobileLinkItem = {
              ...cur,
              note: nextNote.trim(),
              user_note: nextNote.trim(),
              tags: nextTags,
              tag_names: nextTags,
            };
            void upsertCachedLinkItem(updated).catch(() => {});
            return updated;
          });
        } else {
          Alert.alert("บันทึกไม่สำเร็จ", res.error || "กรุณาลองใหม่");
        }
      },
    );
  }

  function parseClampedTimeInt(raw: string, maxVal: number): number {
    const digits = raw.replace(/\D+/g, "");
    const n = digits ? Number.parseInt(digits, 10) : 0;
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(maxVal, n);
  }

  function stepReminderTime(kind: "hour" | "minute", delta: number) {
    if (kind === "hour") {
      const cur = parseClampedTimeInt(remHourText, 23);
      const next = (cur + delta + 24) % 24;
      setRemHourText(String(next).padStart(2, "0"));
    } else {
      const cur = parseClampedTimeInt(remMinuteText, 59);
      const next = (cur + delta + 60) % 60;
      setRemMinuteText(String(next).padStart(2, "0"));
    }
  }

  function openReminderModal() {
    const rawWhen =
      cachedReminder?.remind_at ||
      cachedReminder?.next_remind_at ||
      cachedReminder?.next_run_at ||
      cachedReminder?.scheduled_for;
    let base = rawWhen ? new Date(rawWhen) : null;
    if (!base || Number.isNaN(base.getTime()) || base.getTime() <= Date.now()) {
      const n = new Date();
      base = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 18, 0, 0, 0);
      if (base.getTime() <= Date.now()) {
        base = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 18, 0, 0, 0);
      }
    }
    const ym = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
    setRemYearMonth(ym);
    setRemDay(base.getDate());
    setRemHourText(String(base.getHours()).padStart(2, "0"));
    setRemMinuteText(String(base.getMinutes()).padStart(2, "0"));
    const rep =
      cachedReminder?.schedule_type === "every_n_days" &&
      typeof cachedReminder?.repeat_every_days === "number" &&
      cachedReminder.repeat_every_days > 0
        ? cachedReminder.repeat_every_days
        : null;
    setRemRepeatDays(rep);
    setReminderModalOpen(true);
  }

  async function executeReminderSave(
    targetId: string,
    itemStatus: string,
    dt: Date,
    repeatDays: number | null,
    isStale: () => boolean,
    startGen: number,
  ) {
    if (itemStatus === "done" || itemStatus === "read" || itemStatus === "archived") {
      Alert.alert(
        "ตั้งเตือนไม่ได้",
        "ลิงก์นี้อยู่ในสถานะอ่านแล้วหรือเก็บถาวร กรุณาเปลี่ยนสถานะเป็นยังไม่ดูก่อนตั้งเตือน",
      );
      return;
    }
    const iso = dt.toISOString();
    const { remind_time, timezone } = formatRemindTimeAndZone(dt);
    const res = await saveReminder(targetId, {
      schedule_type: repeatDays ? "every_n_days" : "once",
      remind_at: iso,
      remind_time,
      timezone,
      repeat_every_days: repeatDays,
    });
    if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
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
    if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
    const formatted = dt.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
    const fullLabel = repeatDays ? `${formatted} (ทุก ${repeatDays} วัน)` : formatted;
    setReminderLabelOverride(fullLabel);
    setReminderModalOpen(false);
    Alert.alert("ตั้งเวลาเตือนความจำแล้ว", `แจ้งเตือนเมื่อ ${fullLabel}`);
  }

  async function handleQuickReminder(hoursAhead: number, repeatDays: number | null) {
    if (!item) return;
    const targetId = item.id;
    const itemSt = String(item.status || "inbox").toLowerCase();
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "rem" : ""),
      async (isStale) => {
        const startGen = getAuthGeneration();
        const dt = new Date(Date.now() + hoursAhead * 3600 * 1000);
        await executeReminderSave(targetId, itemSt, dt, repeatDays, isStale, startGen);
      },
    );
  }

  function handleShiftReminderMonth(delta: number) {
    const nextYm = shiftYearMonth(remYearMonth, delta);
    const nextCal = buildMobileMonthCalendar(nextYm);
    setRemYearMonth(nextYm);
    setRemDay((prevDay) => {
      const clamped = Math.min(prevDay, nextCal.days.length);
      const clampedCell = nextCal.days.find((c) => c.day === clamped);
      if (clampedCell && !clampedCell.isPast) return clamped;
      const firstValid = nextCal.days.find((c) => !c.isPast);
      return firstValid ? firstValid.day : clamped;
    });
  }

  async function handleSaveCustomReminder() {
    if (!item) return;
    const targetId = item.id;
    const itemSt = String(item.status || "inbox").toLowerCase();
    const hh = parseClampedTimeInt(remHourText, 23);
    const mm = parseClampedTimeInt(remMinuteText, 59);
    setRemHourText(String(hh).padStart(2, "0"));
    setRemMinuteText(String(mm).padStart(2, "0"));
    const activeDay = Math.min(remDay, buildMobileMonthCalendar(remYearMonth).days.length);
    const dt = buildCustomReminderDate(remYearMonth, activeDay, hh, mm);
    if (!dt || dt.getTime() <= Date.now()) {
      Alert.alert("กรุณาเลือกเวลาในอนาคต", "วันและเวลาที่ตั้งเตือนต้องอยู่หลังจากเวลาปัจจุบัน");
      return;
    }
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "rem" : ""),
      async (isStale) => {
        const startGen = getAuthGeneration();
        await executeReminderSave(targetId, itemSt, dt, remRepeatDays, isStale, startGen);
      },
    );
  }

  async function handleClearReminder() {
    if (!item) return;
    const targetId = item.id;
    const startGen = getAuthGeneration();
    await runGuardedBusyAction(
      actionSeqRef,
      (isBusy) => setBusy(isBusy ? "rem" : ""),
      async (isStale) => {
        const res = await deleteReminder(targetId);
        if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
        if (!res.ok) {
          Alert.alert("ปิดการเตือนไม่สำเร็จ", res.error || "กรุณาลองใหม่");
          return;
        }
        await syncRemindersFromServer();
        if (isStale() || getAuthGeneration() !== startGen || activeIdRef.current !== targetId) return;
        setReminderLabelOverride("");
        setReminderModalOpen(false);
        Alert.alert("ลบการแจ้งเตือนแล้ว");
      },
    );
  }

  function confirmDelete() {
    if (!item) return;
    const targetId = item.id;
    const modalGen = getAuthGeneration();
    Alert.alert("ลบลิงก์นี้?", "ลิงก์จะถูกลบออกจากพื้นที่ทำงานของคุณ", [
      { text: "ยกเลิก", style: "cancel" },
      {
        text: "ลบ",
        style: "destructive",
        onPress: () => {
          if (getAuthGeneration() !== modalGen || activeIdRef.current !== targetId) return;
          void deleteLinkItem(targetId).then((res) => {
            if (getAuthGeneration() !== modalGen || activeIdRef.current !== targetId) return;
            if (res.ok) {
              if (router.canGoBack()) router.back();
              else router.replace("/(tabs)");
            } else {
              Alert.alert("ลบไม่สำเร็จ", res.error || "กรุณาลองใหม่");
            }
          });
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={[styles.centerBox, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (!item) {
    return (
      <View style={[styles.centerBox, { paddingTop: insets.top }]}>
        <Text style={styles.emptyTitle}>ไม่พบรายละเอียดลิงก์</Text>
      </View>
    );
  }

  const currentStatus = String(item.status || "inbox").toLowerCase();
  const isSeen = currentStatus === "done" || currentStatus === "read";
  const isPrivate = isPrivateOrRestrictedItem(item);
  const platBadge = inferMobilePlatform(item) || inferMobileDomain(item.url) || "Web";
  const { displayTitle } = formatPostDetailTitleAndDesc(item);
  const originalDescription = resolveOriginalDescription(item);
  const showDescToggle = originalDescription.length > 130 || originalDescription.includes("\n");
  const remCalendar = buildMobileMonthCalendar(remYearMonth);
  const activeCalDay = Math.min(remDay, remCalendar.days.length);

  const memWs = getMemoryCachedWorkspace() || diskWs;
  const allCachedItems = memWs?.items || [];
  const allFolders = memWs?.folders || [];
  const resolvedFolderId = folderId || item.folder_id || "";
  const matchedFolderName =
    resolvedFolderId === "virtual-inbox"
      ? "รวมไว้ดูทีหลัง"
      : allFolders.find((f) => f.id === resolvedFolderId)?.name || "";

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
    if (!targetId || navLockRef.current) return;
    navLockRef.current = true;
    router.replace(
      folderId
        ? (`/item/${encodeURIComponent(targetId)}?folderId=${encodeURIComponent(folderId)}` as never)
        : (`/item/${encodeURIComponent(targetId)}` as never),
    );
  };
  navMetaRef.current = {
    count: navIds.length,
    idx: navIdx,
    prevNavId,
    nextNavId,
  };
  goToAdjacentItemRef.current = goToAdjacentItem;

  const getOverscrollDistances = (nativeEvent: NativeScrollEvent) => {
    const y = nativeEvent.contentOffset?.y ?? 0;
    const contentH = nativeEvent.contentSize?.height ?? 0;
    const layoutH = nativeEvent.layoutMeasurement?.height ?? 0;
    if (layoutH <= 0) return { topOverscroll: 0, bottomOverscroll: 0 };
    const maxY = Math.max(0, contentH - layoutH);
    const topOverscroll = y < 0 ? -y : 0;
    const bottomOverscroll = y > maxY ? y - maxY : 0;
    return { topOverscroll, bottomOverscroll };
  };

  const handleScrollLayout = (e: LayoutChangeEvent) => {
    updateScrollMetrics({ layoutHeight: e.nativeEvent.layout.height });
  };

  const handleScrollContentSizeChange = (_width: number, height: number) => {
    updateScrollMetrics({ contentHeight: height });
  };

  const syncMetricsFromScrollEvent = (nativeEvent: NativeScrollEvent) => {
    const y = nativeEvent.contentOffset?.y ?? scrollMetricsRef.current.scrollY;
    const contentH = nativeEvent.contentSize?.height ?? scrollMetricsRef.current.contentHeight;
    const layoutH = nativeEvent.layoutMeasurement?.height ?? scrollMetricsRef.current.layoutHeight;
    updateScrollMetrics({ scrollY: y, contentHeight: contentH, layoutHeight: layoutH });
    const maxY = layoutH > 0 ? Math.max(0, contentH - layoutH) : scrollMetricsRef.current.maxScrollY;
    return { y, maxY };
  };

  const handleScrollBeginDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isDraggingScrollRef.current = true;
    const { y, maxY } = syncMetricsFromScrollEvent(e.nativeEvent);
    androidDragStartEdgeRef.current = {
      atTop: y <= EDGE_SCROLL_TOLERANCE_PX,
      atBottom: y >= Math.max(0, maxY - EDGE_SCROLL_TOLERANCE_PX),
    };
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    syncMetricsFromScrollEvent(e.nativeEvent);

    if (Platform.OS !== "ios") return;
    if (!isDraggingScrollRef.current || navIds.length <= 1 || navIdx < 0) return;
    const { topOverscroll, bottomOverscroll } = getOverscrollDistances(e.nativeEvent);
    if (topOverscroll >= PULL_EDGE_HINT_PX && topOverscroll >= bottomOverscroll) {
      setPullStateIfChanged(resolvePullEdgeState("prev", topOverscroll));
    } else if (bottomOverscroll >= PULL_EDGE_HINT_PX) {
      setPullStateIfChanged(resolvePullEdgeState("next", bottomOverscroll));
    } else {
      setPullStateIfChanged("none");
    }
  };

  const handleScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const wasDragging = isDraggingScrollRef.current;
    isDraggingScrollRef.current = false;
    const { y, maxY } = syncMetricsFromScrollEvent(e.nativeEvent);

    if (!wasDragging || navIds.length <= 1 || navIdx < 0) {
      setPullStateIfChanged("none");
      return;
    }

    if (Platform.OS === "ios") {
      setPullStateIfChanged("none");
      const { topOverscroll, bottomOverscroll } = getOverscrollDistances(e.nativeEvent);
      if (topOverscroll >= PULL_EDGE_TRIGGER_PX && topOverscroll >= bottomOverscroll && prevNavId) {
        goToAdjacentItem(prevNavId);
      } else if (bottomOverscroll >= PULL_EDGE_TRIGGER_PX && nextNavId) {
        goToAdjacentItem(nextNavId);
      }
      return;
    }

    if (!androidPanActiveRef.current) {
      setPullStateIfChanged("none");
      const vy = e.nativeEvent.velocity?.y ?? 0;
      if (
        androidDragStartEdgeRef.current.atTop &&
        y <= EDGE_SCROLL_TOLERANCE_PX &&
        vy >= ANDROID_EDGE_FLICK_VELOCITY &&
        prevNavId
      ) {
        goToAdjacentItem(prevNavId);
      } else if (
        androidDragStartEdgeRef.current.atBottom &&
        y >= Math.max(0, maxY - EDGE_SCROLL_TOLERANCE_PX) &&
        vy <= -ANDROID_EDGE_FLICK_VELOCITY &&
        nextNavId
      ) {
        goToAdjacentItem(nextNavId);
      }
    }
  };

  const handleMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isDraggingScrollRef.current = false;
    syncMetricsFromScrollEvent(e.nativeEvent);
    if (!androidPanActiveRef.current) {
      setPullStateIfChanged("none");
    }
  };

  const renderEdgeNavHint = (direction: "prev" | "next") => {
    if (navIds.length <= 1 || navIdx < 0) return null;
    const isPrev = direction === "prev";
    const targetId = isPrev ? prevNavId : nextNavId;
    const isPulling = pullEdgeState === (isPrev ? "pull_prev" : "pull_next");
    const isReady = pullEdgeState === (isPrev ? "ready_prev" : "ready_next");
    const label = isReady
      ? targetId
        ? isPrev
          ? "ปล่อยเพื่อดูโพสต์ก่อนหน้า"
          : "ปล่อยเพื่อดูโพสต์ถัดไป"
        : isPrev
          ? "อยู่โพสต์แรกแล้ว"
          : "อยู่โพสต์ล่าสุดแล้ว"
      : isPulling
        ? targetId
          ? isPrev
            ? "ดึงลงอีกนิดเพื่อดูโพสต์ก่อนหน้า"
            : "ดึงขึ้นอีกนิดเพื่อดูโพสต์ถัดไป"
          : isPrev
            ? "อยู่โพสต์แรกแล้ว"
            : "อยู่โพสต์ล่าสุดแล้ว"
        : isPrev
          ? "โพสต์ก่อนหน้า"
          : "โพสต์ถัดไป";
    const iconName = isReady && targetId
      ? isPrev
        ? "arrow-up"
        : "arrow-down"
      : isPrev
        ? "chevron-up"
        : "chevron-down";
    const iconColor = !targetId
      ? "#CBD5E1"
      : isReady
        ? theme.accentText
        : "#57596A";

    return (
      <Pressable
        style={[
          styles.edgeHintBtn,
          !isPrev && { marginTop: 4 },
          !targetId && styles.edgeHintDisabled,
          isReady &&
            targetId && {
              backgroundColor: theme.soft,
              borderColor: theme.softBorder,
              borderWidth: 1,
            },
        ]}
        disabled={!targetId}
        onPress={() => goToAdjacentItem(targetId)}
      >
        <Ionicons name={iconName} size={14} color={iconColor} />
        <Text
          style={[
            styles.edgeHintText,
            !targetId && styles.edgeHintTextDisabled,
            isReady && targetId && { color: theme.accentText },
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const cachedReminder = (memWs?.reminders || []).find(
    (r) =>
      r.item_id === item.id &&
      r.enabled !== false &&
      r.is_enabled !== false &&
      String(r.status || "").toLowerCase() !== "cancelled",
  );
  const activeReminderLabel = (() => {
    if (reminderLabelOverride !== null) return reminderLabelOverride;
    const rawWhen =
      cachedReminder?.remind_at ||
      cachedReminder?.next_remind_at ||
      cachedReminder?.next_run_at ||
      cachedReminder?.scheduled_for;
    if (!rawWhen) return "";
    const d = new Date(rawWhen);
    if (Number.isNaN(d.getTime())) return "ตั้งเตือนไว้แล้ว";
    return d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  })();

  const activeTags = parseTagList(tagsText);
  const activeAspect =
    (activeSlideUri && imageRatios[activeSlideUri]) ||
    (derivedVideo.embedUrl && derivedVideo.isVertical ? 0.8 : 1.58);
  const maxMediaWidth = Math.max(220, windowWidth - 32);
  const computedMediaHeight = Math.round(Math.min(390, maxMediaWidth / activeAspect));
  const totalSlides = mediaImages.length;
  const isLastSlide = totalSlides >= 2 && activeSlideIndex === totalSlides - 1;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: Math.max(6, insets.top) }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Custom Figma Detail Topbar */}
      <View style={styles.topbar}>
        <Pressable
          style={styles.topbarIconBtn}
          hitSlop={8}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)");
          }}
        >
          <Ionicons name="chevron-back" size={23} color="#20283E" />
        </Pressable>
        <View style={styles.topTitles}>
          <Text style={styles.topHeading}>รายละเอียด</Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {navIds.length > 0 && navIdx >= 0 ? `${navIdx + 1}/${navIds.length} · ` : ""}
            {matchedFolderName || "บันทึกล่าสุด"}
          </Text>
        </View>
        <View style={styles.topRightActions}>
          <Pressable style={styles.topbarIconBtn} hitSlop={6} onPress={() => void handleToggleFavorite()}>
            <Image
              source={item.is_favorite ? CHERRY_SELECTED_IMG : CHERRY_UNSELECTED_IMG}
              style={styles.cherryTopIcon}
              resizeMode="contain"
            />
          </Pressable>
          <Pressable style={styles.topbarIconBtn} hitSlop={6} onPress={confirmDelete}>
            <Ionicons name="trash-outline" size={20} color="#55596A" />
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={Platform.OS === "android" ? androidCanScroll : true}
        bounces
        alwaysBounceVertical
        scrollEventThrottle={16}
        onLayout={handleScrollLayout}
        onContentSizeChange={handleScrollContentSizeChange}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScroll={handleScroll}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleMomentumScrollEnd}
      >
        <Animated.View
          style={[
            styles.scrollInner,
            Platform.OS === "android" && { transform: [{ translateY: androidPullOffset }] },
          ]}
          {...(Platform.OS === "android" ? androidPanResponder.panHandlers : {})}
        >
          {renderEdgeNavHint("prev")}

        {/* Rich Preview Box */}
        {derivedVideo.embedUrl ? (
          inlinePlayer ? (
            <View style={[styles.mediaContainer, { height: computedMediaHeight }]}>
              <WebView
                key={`${item.id}-${inlinePlayer.kind === "uri" ? inlinePlayer.uri : "html"}`}
                source={
                  inlinePlayer.kind === "html"
                    ? { html: inlinePlayer.html, baseUrl: inlinePlayer.baseUrl }
                    : { uri: inlinePlayer.uri }
                }
                style={styles.mediaFill}
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                allowsFullscreenVideo
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                bounces={false}
                originWhitelist={["https://*"]}
              />
              <Pressable style={styles.zoomBtn} onPress={() => setInlinePlayer(null)} hitSlop={8}>
                <View style={styles.inlineIconRow}>
                  <Ionicons name="close" size={12} color="#FFFFFF" />
                  <Text style={styles.zoomBtnText}>ปิด</Text>
                </View>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.mediaContainer, { height: computedMediaHeight }]}
              onPress={() => void handlePlayVideo()}
            >
              {coverUri ? (
                <Image source={{ uri: coverUri }} style={styles.mediaFill} resizeMode="cover" />
              ) : (
                <View style={styles.videoFallbackPoster} />
              )}
              <View style={styles.playBtnCircle}>
                {videoLoading ? (
                  <ActivityIndicator color={theme.accent} />
                ) : (
                  <Ionicons name="play" size={24} color={theme.accent} style={{ marginLeft: 2 }} />
                )}
              </View>
              <View style={styles.mediaBadge}>
                <Text style={styles.mediaBadgeText}>
                  {derivedVideo.platform || platBadge} · {videoLoading ? "กำลังเตรียมคลิป..." : "แตะเพื่อเล่น"}
                </Text>
              </View>
            </Pressable>
          )
        ) : totalSlides >= 2 ? (
          <View style={[styles.mediaContainer, { height: computedMediaHeight }]}>
            <Pressable style={styles.mediaFill} onPress={() => setLightboxOpen(true)}>
              <Image source={{ uri: activeSlideUri }} style={styles.mediaFill} resizeMode="cover" />
            </Pressable>
            <Pressable
              style={[styles.carouselArrow, styles.carouselArrowLeft]}
              hitSlop={8}
              onPress={() => setCarouselIdx((prev) => (prev - 1 + totalSlides) % totalSlides)}
            >
              <Ionicons name="chevron-back" size={18} color="#FFFFFF" />
            </Pressable>
            <Pressable
              style={[styles.carouselArrow, styles.carouselArrowRight]}
              hitSlop={8}
              onPress={() => setCarouselIdx((prev) => (prev + 1) % totalSlides)}
            >
              <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
            </Pressable>
            <View style={styles.mediaBadge}>
              <Text style={styles.mediaBadgeText}>
                {activeSlideIndex + 1}/{totalSlides}
              </Text>
            </View>
            <Pressable style={styles.zoomBtn} onPress={() => setLightboxOpen(true)}>
              <View style={styles.inlineIconRow}>
                <Ionicons name="expand-outline" size={12} color="#FFFFFF" />
                <Text style={styles.zoomBtnText}>ขยาย</Text>
              </View>
            </Pressable>
            {isLastSlide ? (
              <Pressable
                style={[styles.moreInPostBtn, { backgroundColor: theme.accent }]}
                onPress={() => openExternalUrlSafe(item.url)}
              >
                <View style={styles.inlineIconRow}>
                  <Text style={styles.moreInPostText}>ดูรูปทั้งหมดในโพสต์ต้นฉบับ</Text>
                  <Ionicons name="open-outline" size={12} color="#FFFFFF" />
                </View>
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
          <View style={[styles.mediaContainer, { height: computedMediaHeight }]}>
            <Pressable style={styles.mediaFill} onPress={() => setLightboxOpen(true)}>
              <Image source={{ uri: coverUri }} style={styles.mediaFill} resizeMode="cover" />
            </Pressable>
            <Pressable style={styles.zoomBtn} onPress={() => setLightboxOpen(true)}>
              <View style={styles.inlineIconRow}>
                <Ionicons name="expand-outline" size={12} color="#FFFFFF" />
                <Text style={styles.zoomBtnText}>ขยาย</Text>
              </View>
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

        {/* Underlined Title + Meta */}
        <View style={styles.postInfoBlock}>
          <Pressable style={styles.postTitleRow} onPress={() => openExternalUrlSafe(item.url)}>
            <Text style={styles.postTitleLink}>
              {displayTitle || item.title || item.url}
            </Text>
            <Ionicons name="open-outline" size={19} color="#0F172A" style={{ marginTop: 3 }} />
          </Pressable>
          <Text style={styles.postMeta}>
            {platBadge} · {matchedFolderName || "ทั่วไป"}
          </Text>
        </View>

        {/* Original Description above-the-fold (hidden when empty, never overwritten by AI) */}
        {originalDescription ? (
          <View style={styles.descBlock}>
            <Text style={styles.secLabel}>คำอธิบายจากโพสต์ต้นฉบับ</Text>
            <Text style={styles.descText} numberOfLines={descExpanded ? undefined : 3}>
              {originalDescription}
            </Text>
            {showDescToggle ? (
              <Pressable style={styles.descToggleBtn} onPress={() => setDescExpanded((v) => !v)}>
                <View style={styles.inlineIconRow}>
                  <Text style={[styles.descToggleText, { color: theme.accentText }]}>
                    {descExpanded ? "ย่อข้อความ" : "อ่านเพิ่มเติม"}
                  </Text>
                  <Ionicons
                    name={descExpanded ? "chevron-up" : "chevron-down"}
                    size={14}
                    color={theme.accentText}
                  />
                </View>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* Reminder Pill */}
        <Pressable style={styles.reminderPill} onPress={openReminderModal}>
          <Ionicons name="time-outline" size={16} color={FIGMA_INK.inkPrimary} />
          <Text style={styles.reminderPillText}>
            {activeReminderLabel || "ยังไม่ได้ตั้งเตือน"}
          </Text>
        </Pressable>

        {/* Status Toggle + Tags */}
        <View style={styles.statusBlock}>
          <View style={styles.rowBetween}>
            <Text style={styles.secLabel}>สถานะการรับชม</Text>
            <Pressable
              style={[
                styles.statusTogglePill,
                isSeen
                  ? styles.statusToggleSeen
                  : { backgroundColor: theme.soft, borderColor: theme.softBorder },
              ]}
              onPress={() => void handleToggleSeen()}
            >
              {isSeen ? <Ionicons name="checkmark" size={14} color="#065F46" /> : null}
              <Text
                style={[
                  styles.statusToggleText,
                  { color: isSeen ? "#065F46" : theme.accentText },
                ]}
              >
                {isSeen ? "ดูแล้ว" : "ยังไม่ดู"}
              </Text>
              <Ionicons
                name="swap-horizontal"
                size={14}
                color={isSeen ? "#065F46" : theme.accentText}
              />
            </Pressable>
          </View>

          <View style={styles.tagsWrap}>
            {activeTags.map((tag) => (
              <Pressable
                key={tag}
                style={styles.tagPill}
                onPress={() => {
                  const next = activeTags.filter((t) => t !== tag);
                  void handleSaveEdits(note, next);
                }}
              >
                <Text style={styles.tagPillText}>
                  {tag.startsWith("#") ? tag : `#${tag}`} ×
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.addTagBtn} onPress={() => setTagModalOpen(true)}>
              <Text style={styles.addTagBtnText}>+ เพิ่มแท็ก</Text>
            </Pressable>
          </View>
        </View>

        {/* My Note (Read + Edit Modal trigger) */}
        <View style={styles.noteBlock}>
          <View style={styles.rowBetween}>
            <Text style={styles.secLabel}>โน้ตของฉัน</Text>
            <Pressable
              style={styles.editPillBtn}
              onPress={() => {
                setNoteDraft(note);
                setNoteModalOpen(true);
              }}
            >
              <Text style={styles.editPillBtnText}>แก้ไข</Text>
            </Pressable>
          </View>
          <Pressable
            style={styles.noteReadBox}
            onPress={() => {
              setNoteDraft(note);
              setNoteModalOpen(true);
            }}
          >
            <Text style={note ? styles.noteReadText : styles.notePlaceholderText}>
              {note || "เพิ่มโน้ต..."}
            </Text>
          </Pressable>
        </View>

        {/* Lavender AI Summary Card (372:873) */}
        {aiSummary ? (
          <View style={styles.aiCard}>
            <View style={styles.rowBetween}>
              <View style={styles.inlineIconRow}>
                <MaterialCommunityIcons name="robot-outline" size={18} color={FIGMA_INK.aiInk} />
                <Text style={styles.aiCardTitle}>สรุปจากต้นฉบับ</Text>
              </View>
              <Pressable
                style={styles.aiRerunPill}
                disabled={busy === "ai"}
                onPress={() => setAiConfirmOpen(true)}
              >
                <Text style={styles.aiRerunPillText}>
                  {busy === "ai" ? "กำลังสรุป..." : "สรุปใหม่"}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.aiCardBody}>{aiSummary}</Text>
          </View>
        ) : (
          <Pressable
            style={[styles.aiTriggerBtn, busy === "ai" && { opacity: 0.7 }]}
            disabled={busy === "ai"}
            onPress={() => setAiConfirmOpen(true)}
          >
            <MaterialCommunityIcons name="robot-outline" size={18} color={FIGMA_INK.aiInk} />
            <Text style={styles.aiTriggerText}>
              {busy === "ai" ? "กำลังสรุป..." : "สรุปด้วย AI"}
            </Text>
          </Pressable>
        )}

          {renderEdgeNavHint("next")}
        </Animated.View>
      </ScrollView>

      {/* Sticky Bottom Open URL CTA */}
      <View style={[styles.stickyCtaBar, { paddingBottom: Math.max(14, insets.bottom) }]}>
        <Pressable
          style={[styles.stickyOpenBtn, { backgroundColor: theme.accent }]}
          onPress={() => openExternalUrlSafe(item.url)}
        >
          <Text style={styles.stickyOpenBtnText}>เปิดลิงก์ต้นฉบับ</Text>
        </Pressable>
      </View>

      {/* Edit Note Dialog */}
      <Modal
        visible={noteModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setNoteModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.dialogBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.dialogCard}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.dialogTitle}>แก้ไขโน้ต</Text>
              <TextInput
                style={[styles.dialogTextArea, { marginTop: 12 }]}
                placeholder="กลับมาเปิดลิงก์นี้ช่วงวันหยุด..."
                placeholderTextColor="#9CA3AF"
                multiline
                value={noteDraft}
                onChangeText={setNoteDraft}
              />
              <View style={[styles.dialogActions, { marginTop: 12 }]}>
                <Pressable style={styles.dialogOutlineBtn} onPress={() => setNoteModalOpen(false)}>
                  <Text style={styles.dialogOutlineBtnText}>ยกเลิก</Text>
                </Pressable>
                <Pressable
                  style={[styles.dialogRedBtn, { backgroundColor: theme.accent }]}
                  disabled={busy === "save"}
                  onPress={() => void handleSaveEdits(noteDraft, activeTags)}
                >
                  <Text style={styles.dialogRedBtnText}>
                    {busy === "save" ? "กำลังบันทึก..." : "บันทึก"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Tag Dialog */}
      <Modal
        visible={tagModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setTagModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.dialogBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.dialogCard}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.dialogTitle}>เพิ่มแท็ก</Text>
              <TextInput
                style={[styles.dialogInput, { marginTop: 12 }]}
                placeholder="เช่น อ่านทีหลัง"
                placeholderTextColor="#9CA3AF"
                value={tagDraft}
                onChangeText={setTagDraft}
              />
              <View style={[styles.quickTagsRow, { marginTop: 12 }]}>
                {QUICK_TAG_SUGGESTIONS.map((qt) => (
                  <Pressable
                    key={qt}
                    style={styles.quickTagChip}
                    onPress={() => {
                      const clean = qt.replace(/^#/, "").trim();
                      const merged = activeTags.includes(clean) ? activeTags : [...activeTags, clean];
                      void handleSaveEdits(note, merged);
                    }}
                  >
                    <Text style={styles.quickTagChipText}>{qt}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={[styles.dialogActions, { marginTop: 12 }]}>
                <Pressable style={styles.dialogOutlineBtn} onPress={() => setTagModalOpen(false)}>
                  <Text style={styles.dialogOutlineBtnText}>ยกเลิก</Text>
                </Pressable>
                <Pressable
                  style={[styles.dialogRedBtn, { backgroundColor: theme.accent }]}
                  disabled={busy === "save"}
                  onPress={() => {
                    const extra = parseTagList(tagDraft);
                    if (!extra.length) {
                      setTagModalOpen(false);
                      return;
                    }
                    const merged = Array.from(new Set([...activeTags, ...extra]));
                    void handleSaveEdits(note, merged);
                  }}
                >
                  <Text style={styles.dialogRedBtnText}>เพิ่มแท็ก</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* AI Confirm Dialog (319:5253) */}
      <Modal
        visible={aiConfirmOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setAiConfirmOpen(false)}
      >
        <View style={styles.dialogBackdrop}>
          <View style={styles.dialogCard}>
            <Text style={styles.dialogTitle}>ยืนยันการสรุปด้วย AI</Text>
            <View style={styles.aiNoticeBox}>
              <Text style={styles.aiNoticeText}>
                ผู้ให้บริการ AI ที่คุณเชื่อมต่อจะประมวลผลเนื้อหาต้นฉบับ โดยใช้โควตาหรือ Token ของคุณ (คำอธิบายต้นฉบับจะยังคงแสดงครบเหมือนเดิม)
              </Text>
            </View>
            <View style={styles.dialogActions}>
              <Pressable style={styles.dialogOutlineBtn} onPress={() => setAiConfirmOpen(false)}>
                <Text style={styles.dialogOutlineBtnText}>ยกเลิก</Text>
              </Pressable>
              <Pressable
                style={[styles.dialogRedBtn, { backgroundColor: theme.accent }]}
                disabled={busy === "ai"}
                onPress={() => {
                  setAiConfirmOpen(false);
                  void handleAiSummarize();
                }}
              >
                <Text style={styles.dialogRedBtnText}>ยืนยัน</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Hybrid Calendar + Custom Time + Quick Preset Reminder Sheet (Figma 319:5142) */}
      <Modal
        visible={reminderModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setReminderModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.sheetBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={styles.sheetBackdropTap} onPress={() => setReminderModalOpen(false)} />
          <View style={[styles.sheetCard, styles.remSheetMax, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.sheetDragBar} />
            <View style={styles.rowBetween}>
              <View style={styles.inlineIconRow}>
                <Ionicons name="time-outline" size={18} color={FIGMA_INK.inkPrimary} />
                <Text style={styles.dialogTitle}>ตั้งเตือน</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => setReminderModalOpen(false)}>
                <Ionicons name="close" size={20} color="#666666" />
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {/* 1-Tap Quick Presets */}
              <Text style={styles.remSectionMiniLabel}>ทางลัดด่วน</Text>
              <View style={styles.reminderGrid}>
                <Pressable
                  style={styles.remOptionChip}
                  disabled={busy === "rem"}
                  onPress={() => void handleQuickReminder(2, null)}
                >
                  <Text style={styles.remOptionText}>อีก 2 ชม.</Text>
                </Pressable>
                <Pressable
                  style={styles.remOptionChip}
                  disabled={busy === "rem"}
                  onPress={() => void handleQuickReminder(24, null)}
                >
                  <Text style={styles.remOptionText}>พรุ่งนี้เวลานี้</Text>
                </Pressable>
                <Pressable
                  style={styles.remOptionChip}
                  disabled={busy === "rem"}
                  onPress={() => void handleQuickReminder(72, null)}
                >
                  <Text style={styles.remOptionText}>อีก 3 วัน</Text>
                </Pressable>
              </View>

              {/* Calendar Month Nav */}
              <View style={styles.calMonthRow}>
                <Pressable
                  style={styles.calNavBtn}
                  onPress={() => handleShiftReminderMonth(-1)}
                >
                  <Ionicons name="chevron-back" size={18} color={FIGMA_INK.inkPrimary} />
                </Pressable>
                <Text style={styles.calMonthLabel}>{remCalendar.monthLabel}</Text>
                <Pressable
                  style={styles.calNavBtn}
                  onPress={() => handleShiftReminderMonth(1)}
                >
                  <Ionicons name="chevron-forward" size={18} color={FIGMA_INK.inkPrimary} />
                </Pressable>
              </View>

              {/* Day-of-Week Header + Day Cells */}
              <View style={styles.calGrid}>
                {["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"].map((dow) => (
                  <View key={dow} style={styles.calDowCell}>
                    <Text style={styles.calDowText}>{dow}</Text>
                  </View>
                ))}
                {Array.from({ length: remCalendar.leadingEmpty }, (_, i) => (
                  <View key={`empty-${i}`} style={styles.calDayCell} />
                ))}
                {remCalendar.days.map((cell) => {
                  const selected = cell.day === activeCalDay && !cell.isPast;
                  return (
                    <Pressable
                      key={`day-${cell.day}`}
                      style={[
                        styles.calDayCell,
                        cell.isToday && !selected && { borderColor: theme.softBorder, borderWidth: 1 },
                        selected && { backgroundColor: theme.accent },
                        cell.isPast && { opacity: 0.35 },
                      ]}
                      disabled={cell.isPast}
                      onPress={() => setRemDay(cell.day)}
                    >
                      <Text
                        style={[
                          styles.calDayText,
                          selected && { color: "#FFFFFF", fontWeight: "700" },
                        ]}
                      >
                        {cell.day}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Time HH:MM Selector */}
              <Text style={styles.remSectionMiniLabel}>เลือกเวลา (HH:MM)</Text>
              <View style={styles.timePresetRow}>
                {[
                  { h: "09", m: "00" },
                  { h: "12", m: "00" },
                  { h: "18", m: "00" },
                  { h: "21", m: "00" },
                ].map((tp) => {
                  const isMatch =
                    remHourText.padStart(2, "0") === tp.h &&
                    remMinuteText.padStart(2, "0") === tp.m;
                  return (
                    <Pressable
                      key={`${tp.h}:${tp.m}`}
                      style={[
                        styles.remOptionChip,
                        isMatch && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => {
                        setRemHourText(tp.h);
                        setRemMinuteText(tp.m);
                      }}
                    >
                      <Text
                        style={[
                          styles.remOptionText,
                          isMatch && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {tp.h}:{tp.m}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.timeStepperRow}>
                <View style={styles.timeBoxGroup}>
                  <Pressable style={styles.timeStepBtn} onPress={() => stepReminderTime("hour", -1)}>
                    <Ionicons name="remove" size={15} color={FIGMA_INK.inkPrimary} />
                  </Pressable>
                  <TextInput
                    style={styles.timeNumInput}
                    value={remHourText}
                    keyboardType="number-pad"
                    maxLength={2}
                    onChangeText={(txt) => setRemHourText(txt.replace(/\D+/g, ""))}
                    onBlur={() =>
                      setRemHourText(String(parseClampedTimeInt(remHourText, 23)).padStart(2, "0"))
                    }
                  />
                  <Pressable style={styles.timeStepBtn} onPress={() => stepReminderTime("hour", 1)}>
                    <Ionicons name="add" size={15} color={FIGMA_INK.inkPrimary} />
                  </Pressable>
                </View>

                <Text style={styles.timeColon}>:</Text>

                <View style={styles.timeBoxGroup}>
                  <Pressable style={styles.timeStepBtn} onPress={() => stepReminderTime("minute", -5)}>
                    <Ionicons name="remove" size={15} color={FIGMA_INK.inkPrimary} />
                  </Pressable>
                  <TextInput
                    style={styles.timeNumInput}
                    value={remMinuteText}
                    keyboardType="number-pad"
                    maxLength={2}
                    onChangeText={(txt) => setRemMinuteText(txt.replace(/\D+/g, ""))}
                    onBlur={() =>
                      setRemMinuteText(String(parseClampedTimeInt(remMinuteText, 59)).padStart(2, "0"))
                    }
                  />
                  <Pressable style={styles.timeStepBtn} onPress={() => stepReminderTime("minute", 5)}>
                    <Ionicons name="add" size={15} color={FIGMA_INK.inkPrimary} />
                  </Pressable>
                </View>
              </View>

              {/* Repeat Interval */}
              <Text style={styles.remSectionMiniLabel}>ทำซ้ำ</Text>
              <View style={styles.reminderGrid}>
                {(
                  [
                    { label: "ครั้งเดียว", days: null },
                    { label: "ทุกวัน", days: 1 },
                    { label: "ทุก 3 วัน", days: 3 },
                    { label: "ทุก 7 วัน", days: 7 },
                  ] as const
                ).map((opt) => {
                  const active = remRepeatDays === opt.days;
                  return (
                    <Pressable
                      key={opt.label}
                      style={[
                        styles.remOptionChip,
                        active && { backgroundColor: theme.soft, borderColor: theme.accent },
                      ]}
                      onPress={() => setRemRepeatDays(opt.days)}
                    >
                      <Text
                        style={[
                          styles.remOptionText,
                          active && { color: theme.accentText, fontWeight: "700" },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Action Row: Delete + Save Custom */}
              <View style={styles.remActionsRow}>
                <Pressable
                  style={styles.remDeleteBtn}
                  disabled={busy === "rem"}
                  onPress={() => void handleClearReminder()}
                >
                  <Text style={styles.remDeleteBtnText}>ลบเตือน</Text>
                </Pressable>
                <Pressable
                  style={[styles.remSaveBtn, { backgroundColor: theme.accent }, busy === "rem" && { opacity: 0.7 }]}
                  disabled={busy === "rem"}
                  onPress={() => void handleSaveCustomReminder()}
                >
                  <Text style={styles.remSaveBtnText}>
                    {busy === "rem" ? "กำลังบันทึก..." : "ตั้งเตือน"}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Fullscreen Media Lightbox */}
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
              <View style={styles.inlineIconRow}>
                <Ionicons name="close" size={15} color="#FFFFFF" />
                <Text style={styles.lightboxCloseText}>ปิด</Text>
              </View>
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
                  <Ionicons name="chevron-back" size={18} color="#FFFFFF" />
                </Pressable>
                <Pressable
                  style={[styles.carouselArrow, styles.carouselArrowRight]}
                  onPress={() => setCarouselIdx((prev) => (prev + 1) % totalSlides)}
                >
                  <Ionicons name="chevron-forward" size={18} color="#FFFFFF" />
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
  root: {
    flex: 1,
    backgroundColor: FIGMA_INK.bgApp,
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: FIGMA_INK.bgApp,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIGMA_INK.inkStrong,
  },
  topbar: {
    height: 54,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFFFF",
  },
  topbarIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  topTitles: {
    flex: 1,
    minWidth: 0,
  },
  topHeading: {
    fontSize: 19,
    fontWeight: "700",
    color: "#20283E",
    lineHeight: 23,
  },
  topSub: {
    fontSize: 12,
    color: "#55596A",
  },
  topRightActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  cherryTopIcon: {
    width: 22,
    height: 22,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 24,
  },
  scrollInner: {
    flexGrow: 1,
    gap: 14,
  },
  edgeHintBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  edgeHintDisabled: {
    opacity: 0.45,
  },
  edgeHintText: {
    fontSize: 11.5,
    fontWeight: "700",
    color: "#57596A",
  },
  edgeHintTextDisabled: {
    color: "#94A3B8",
  },
  mediaContainer: {
    width: "100%",
    maxWidth: "100%",
    maxHeight: 390,
    alignSelf: "center",
    borderRadius: 15,
    backgroundColor: "#0F172A",
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
    backgroundColor: "#20283E",
  },
  playBtnCircle: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  mediaBadge: {
    position: "absolute",
    top: 10,
    left: 10,
    backgroundColor: "rgba(17, 24, 39, 0.72)",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  mediaBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
  zoomBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(17, 24, 39, 0.72)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  zoomBtnText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
  carouselArrow: {
    position: "absolute",
    top: "44%",
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(17, 24, 39, 0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  carouselArrowLeft: { left: 10 },
  carouselArrowRight: { right: 10 },
  moreInPostBtn: {
    position: "absolute",
    bottom: 28,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  moreInPostText: {
    color: "#FFFFFF",
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
    backgroundColor: "#FFFFFF",
  },
  privateBox: {
    backgroundColor: "#FDF2F4",
    borderRadius: 15,
    padding: 16,
    borderWidth: 1,
    borderColor: "#F4CFD7",
    gap: 4,
  },
  privateTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#A62639",
  },
  privateSub: {
    fontSize: 13,
    color: "#55596A",
    lineHeight: 19,
  },
  postInfoBlock: {
    gap: 4,
  },
  postTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  postTitleLink: {
    flex: 1,
    fontSize: 19,
    fontWeight: "700",
    color: "#0F172A",
    lineHeight: 26,
    textDecorationLine: "underline",
  },
  postMeta: {
    fontSize: 12.5,
    color: "#55596A",
  },
  reminderPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderLight,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  reminderPillText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  statusBlock: {
    gap: 10,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  secLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  statusTogglePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusToggleSeen: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  statusToggleText: {
    fontSize: 13,
    fontWeight: "700",
  },
  tagsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tagPill: {
    backgroundColor: FIGMA_INK.lavenderTag,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  tagPillText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  addTagBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addTagBtnText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  noteBlock: {
    gap: 8,
  },
  editPillBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 999,
  },
  editPillBtnText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  noteReadBox: {
    minHeight: 72,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#FFFFFF",
    padding: 13,
  },
  noteReadText: {
    fontSize: 14,
    color: FIGMA_INK.inkStrong,
    lineHeight: 20,
  },
  notePlaceholderText: {
    fontSize: 14,
    color: "#9CA3AF",
  },
  descBlock: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#EAE4DB",
    backgroundColor: "#FFFFFF",
    padding: 14,
    gap: 6,
  },
  descText: {
    fontSize: 13.5,
    color: "#334155",
    lineHeight: 20,
  },
  descToggleBtn: {
    alignSelf: "flex-start",
    paddingTop: 2,
  },
  descToggleText: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  aiCard: {
    backgroundColor: FIGMA_INK.lavenderBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: FIGMA_INK.lavenderBorder,
    padding: 14,
    gap: 8,
  },
  inlineIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  aiCardTitle: {
    fontSize: 14.5,
    fontWeight: "800",
    color: FIGMA_INK.aiInk,
  },
  aiRerunPill: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D8D0FC",
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
  },
  aiRerunPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: FIGMA_INK.aiInk,
  },
  aiCardBody: {
    fontSize: 13.5,
    color: "#1E1B4B",
    lineHeight: 21,
  },
  aiTriggerBtn: {
    height: 48,
    borderRadius: 16,
    backgroundColor: FIGMA_INK.lavenderBg,
    borderWidth: 1,
    borderColor: FIGMA_INK.lavenderBorder,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  aiTriggerText: {
    fontSize: 14.5,
    fontWeight: "700",
    color: FIGMA_INK.aiInk,
  },
  stickyCtaBar: {
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#EFEFEF",
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  stickyOpenBtn: {
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  stickyOpenBtnText: {
    color: "#FFFFFF",
    fontSize: 15.5,
    fontWeight: "700",
  },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.45)",
    justifyContent: "center",
    padding: 20,
  },
  dialogCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 20,
    gap: 12,
    maxHeight: "86%",
  },
  dialogTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  dialogTextArea: {
    minHeight: 96,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    padding: 12,
    fontSize: 14.5,
    color: FIGMA_INK.inkStrong,
    textAlignVertical: "top",
  },
  dialogInput: {
    height: 46,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 14.5,
    color: FIGMA_INK.inkStrong,
  },
  quickTagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  quickTagChip: {
    backgroundColor: FIGMA_INK.lavenderTag,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  quickTagChipText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  dialogActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  dialogOutlineBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    backgroundColor: "#FFFFFF",
  },
  dialogOutlineBtnText: {
    color: FIGMA_INK.inkStrong,
    fontWeight: "600",
  },
  dialogRedBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  dialogRedBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  aiNoticeBox: {
    backgroundColor: FIGMA_INK.lavenderBg,
    borderWidth: 1,
    borderColor: FIGMA_INK.lavenderBorder,
    borderRadius: 12,
    padding: 12,
  },
  aiNoticeText: {
    fontSize: 13.5,
    color: "#312E81",
    lineHeight: 20,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(23, 23, 33, 0.43)",
    justifyContent: "flex-end",
  },
  sheetBackdropTap: {
    flex: 1,
  },
  sheetCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 12,
  },
  remSheetMax: {
    maxHeight: "88%",
  },
  sheetDragBar: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
    marginBottom: 4,
  },
  remSectionMiniLabel: {
    fontSize: 12.5,
    fontWeight: "700",
    color: FIGMA_INK.inkSecondary,
    marginTop: 8,
    marginBottom: 6,
  },
  reminderGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 4,
  },
  remOptionChip: {
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
  },
  remOptionText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: FIGMA_INK.inkPrimary,
  },
  calMonthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 8,
  },
  calNavBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: FIGMA_INK.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  calMonthLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
  },
  calGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 6,
  },
  calDowCell: {
    width: "14.285%",
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  calDowText: {
    fontSize: 11.5,
    fontWeight: "700",
    color: FIGMA_INK.inkSecondary,
  },
  calDayCell: {
    width: "14.285%",
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 1,
  },
  calDayText: {
    fontSize: 13.5,
    fontWeight: "500",
    color: FIGMA_INK.inkPrimary,
  },
  timePresetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  timeStepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  timeBoxGroup: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 12,
    padding: 4,
    gap: 6,
  },
  timeStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  timeNumInput: {
    width: 38,
    height: 32,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    color: FIGMA_INK.inkPrimary,
    paddingVertical: 0,
  },
  timeColon: {
    fontSize: 20,
    fontWeight: "800",
    color: FIGMA_INK.inkPrimary,
  },
  remActionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  remDeleteBtn: {
    flex: 1,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: "#FECACA",
    backgroundColor: "#FEF2F2",
    alignItems: "center",
    justifyContent: "center",
  },
  remDeleteBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#B91C1C",
  },
  remSaveBtn: {
    flex: 1.4,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  remSaveBtnText: {
    fontSize: 14.5,
    fontWeight: "700",
    color: "#FFFFFF",
  },
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
});
