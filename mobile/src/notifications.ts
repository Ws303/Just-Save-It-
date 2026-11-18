export interface ReminderInput {
  id?: string;
  reminder_id?: string | null;
  item_id?: string;
  title?: string;
  item_title?: string | null;
  title_snapshot?: string | null;
  url?: string;
  item_url?: string | null;
  item_status?: string | null;
  enabled?: boolean;
  is_enabled?: boolean;
  status?: string;
  schedule_type?: string;
  repeat_every_days?: number | null;
  remind_at?: string | null;
  occurrence_at?: string | null;
  next_remind_at?: string | null;
  scheduled_for?: string | null;
  next_run_at?: string | null;
}

export interface PlannedLocalNotification {
  reminderId: string;
  itemId: string;
  title: string;
  body: string;
  url: string;
  triggerAtMs: number;
  triggerIso: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function computeNextTriggerMs(rem: ReminderInput, nowMs: number): number | null {
  // Pre-unrolled server occurrences (`occurrence_at`) represent exact single fire times
  if (rem.occurrence_at) {
    const exactTs = Date.parse(rem.occurrence_at);
    if (Number.isNaN(exactTs) || exactTs <= nowMs) return null;
    return exactTs;
  }

  const rawIso = rem.remind_at || rem.next_remind_at || rem.scheduled_for || rem.next_run_at;
  if (!rawIso) return null;
  let ts = Date.parse(rawIso);
  if (Number.isNaN(ts)) return null;

  const sched = String(rem.schedule_type || "once").toLowerCase();
  let stepMs = 0;
  if (sched === "daily") {
    stepMs = ONE_DAY_MS;
  } else if (sched === "weekly") {
    stepMs = 7 * ONE_DAY_MS;
  } else if (sched === "every_n_days") {
    const days = Number(rem.repeat_every_days || 1);
    stepMs = Math.max(1, Number.isFinite(days) ? days : 1) * ONE_DAY_MS;
  }

  if (ts <= nowMs) {
    if (stepMs <= 0) return null;
    const steps = Math.floor((nowMs - ts) / stepMs) + 1;
    ts += steps * stepMs;
  }

  return ts > nowMs ? ts : null;
}

export function planIosLocalNotifications(
  reminders: ReminderInput[],
  nowMs: number = Date.now(),
  maxCap: number = 64,
): PlannedLocalNotification[] {
  if (!Array.isArray(reminders) || maxCap <= 0) return [];
  const cap = Math.min(64, Math.max(1, Math.floor(maxCap)));
  const candidates: PlannedLocalNotification[] = [];

  for (const rem of reminders) {
    if (!rem || rem.enabled === false || rem.is_enabled === false) continue;
    const remStatus = String(rem.status || "").toLowerCase();
    if (remStatus === "cancelled" || remStatus === "sent") continue;
    const itemStatus = String(rem.item_status || "").toLowerCase();
    if (itemStatus === "done" || itemStatus === "archived") continue;

    const triggerAtMs = computeNextTriggerMs(rem, nowMs);
    if (triggerAtMs === null) continue;

    const itemId = String(rem.item_id || rem.id || "");
    const title = String(rem.title || rem.item_title || rem.title_snapshot || "ถึงเวลาเปิดดูลิงก์ที่บันทึกไว้").trim();
    const resolvedUrl = String(rem.item_url || rem.url || "");
    candidates.push({
      reminderId: String(rem.reminder_id || rem.id || itemId || `rem-${triggerAtMs}`),
      itemId,
      title: `เตือนความจำ Sharely: ${title}`,
      body: resolvedUrl ? `แตะเพื่อเปิด ${resolvedUrl}` : "แตะเพื่อกลับไปดูลิงก์ที่คุณตั้งเตือนไว้",
      url: resolvedUrl,
      triggerAtMs,
      triggerIso: new Date(triggerAtMs).toISOString(),
    });
  }

  candidates.sort((a, b) => a.triggerAtMs - b.triggerAtMs);
  return candidates.slice(0, cap);
}

export async function cancelAllLocalRemindersSafe(): Promise<void> {
  try {
    const Notifications = await import("expo-notifications");
    if (typeof Notifications?.cancelAllScheduledNotificationsAsync === "function") {
      await Notifications.cancelAllScheduledNotificationsAsync();
    }
  } catch {
    // Ignore in environments without native notifications module
  }
}

export async function syncLocalRemindersWithOs(reminders: ReminderInput[]): Promise<number> {
  try {
    const planned = planIosLocalNotifications(reminders, Date.now(), 64);
    const Notifications = await import("expo-notifications");
    if (!Notifications?.scheduleNotificationAsync) return 0;

    if (planned.length === 0) {
      if (typeof Notifications.cancelAllScheduledNotificationsAsync === "function") {
        await Notifications.cancelAllScheduledNotificationsAsync();
      }
      return 0;
    }

    const perm = await Notifications.getPermissionsAsync();
    let status = perm.status;
    if (status !== "granted") {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== "granted") return 0;

    if (typeof Notifications.cancelAllScheduledNotificationsAsync === "function") {
      await Notifications.cancelAllScheduledNotificationsAsync();
    }

    for (const item of planned) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: item.title,
          body: item.body,
          data: { itemId: item.itemId, url: item.url },
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(item.triggerAtMs),
        },
      });
    }
    return planned.length;
  } catch {
    return 0;
  }
}

export async function registerMobilePushToken(): Promise<{
  granted: boolean;
  platform: "android" | "ios";
  delivery_mode: "remote" | "local_sync";
  push_token: string | null;
}> {
  try {
    const [{ Platform }, Notifications, ConstantsMod] = await Promise.all([
      import("react-native"),
      import("expo-notifications"),
      import("expo-constants"),
    ]);
    const platform: "android" | "ios" = Platform.OS === "ios" ? "ios" : "android";

    if (platform === "android" && typeof Notifications.setNotificationChannelAsync === "function") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Sharely Reminders",
        importance: Notifications.AndroidImportance?.MAX ?? 5,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#BA0E1A",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let finalStatus = existing.status;
    if (finalStatus !== "granted") {
      const asked = await Notifications.requestPermissionsAsync();
      finalStatus = asked.status;
    }
    if (finalStatus !== "granted") {
      return { granted: false, platform, delivery_mode: "local_sync", push_token: null };
    }

    const ConstantsObj = (ConstantsMod as { default?: { expoConfig?: { extra?: { eas?: { projectId?: string } } }; easConfig?: { projectId?: string } } })?.default;
    const projectId =
      ConstantsObj?.expoConfig?.extra?.eas?.projectId || ConstantsObj?.easConfig?.projectId;

    try {
      const tokenRes = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      if (tokenRes?.data) {
        return {
          granted: true,
          platform,
          delivery_mode: "remote",
          push_token: tokenRes.data,
        };
      }
    } catch {
      // Fallback to local_sync on iOS simulator / builds without APNs or Firebase credentials
    }

    return {
      granted: true,
      platform,
      delivery_mode: "local_sync",
      push_token: null,
    };
  } catch {
    return {
      granted: false,
      platform: "android",
      delivery_mode: "local_sync",
      push_token: null,
    };
  }
}
