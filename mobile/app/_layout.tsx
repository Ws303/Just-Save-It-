import React, { useEffect, useRef, useState } from "react";
import { Stack, useRootNavigationState, useRouter, useSegments } from "expo-router";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { acceptFolderInvite, fetchWorkspace, flushOfflineQueue } from "../src/api";
import { syncLocalRemindersWithOs } from "../src/notifications";
import { extractInviteTokenFromUrl, extractSharedUrlFromIntent } from "../src/shareIntent";
import { AppThemeMode, getThemePageBg, loadSession, loadThemeMode, subscribeThemeMode } from "../src/storage";

export default function RootLayout() {
  const router = useRouter();
  const rootNavState = useRootNavigationState();
  const segments = useSegments();
  const incomingUrl = Linking.useURL();
  const hydratedUserRef = useRef<string>("");
  const pendingDeepLinkRef = useRef<string | null>(null);
  const [themeMode, setThemeMode] = useState<AppThemeMode>("cream");
  const navReady = Boolean(rootNavState?.key);

  useEffect(() => {
    void loadThemeMode().then((mode) => setThemeMode(mode)).catch(() => {});
    return subscribeThemeMode((mode) => setThemeMode(mode));
  }, [segments]);

  useEffect(() => {
    if (!navReady) return;
    let active = true;
    async function processDeepLink(rawUrl: string) {
      try {
        const inviteToken = extractInviteTokenFromUrl(rawUrl);
        if (inviteToken) {
          await acceptFolderInvite(inviteToken);
          if (active) router.replace("/(tabs)/folders");
          return;
        }

        const extracted = extractSharedUrlFromIntent(rawUrl);
        if (extracted?.url) {
          router.replace({
            pathname: "/(tabs)",
            params: {
              sharedUrl: extracted.url,
              sharedTitle: extracted.title || "",
            },
          });
        }
      } catch {
        // Ignore malformed or transient deep link errors during cold start
      }
    }

    async function bootstrap() {
      try {
        const session = await loadSession();
        if (!active) return;
        const inLogin = segments[0] === "login";

        if (!session?.access_token) {
          hydratedUserRef.current = "";
          if (!inLogin) {
            router.replace("/login");
          }
          return;
        }

        if (inLogin) {
          router.replace("/(tabs)");
        }

        const sessionKey = session.user?.id || session.access_token;
        if (hydratedUserRef.current !== sessionKey) {
          hydratedUserRef.current = sessionKey;
          await flushOfflineQueue().catch(() => {});
          const ws = await fetchWorkspace().catch(() => ({ items: [], folders: [], reminders: [] }));
          if (active && Array.isArray(ws.reminders) && ws.reminders.length > 0) {
            await syncLocalRemindersWithOs(ws.reminders).catch(() => {});
          }
        }

        if (active && pendingDeepLinkRef.current) {
          const queuedUrl = pendingDeepLinkRef.current;
          pendingDeepLinkRef.current = null;
          await processDeepLink(queuedUrl);
        }
      } catch {
        // Never allow boot hydration failures to crash RootLayout
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [navReady, segments, router]);

  useEffect(() => {
    if (!incomingUrl || !navReady) return;
    let active = true;
    async function handleDeepLink(rawUrl: string) {
      try {
        const session = await loadSession();
        if (!active) return;
        if (!session?.access_token) {
          pendingDeepLinkRef.current = rawUrl;
          return;
        }

        const inviteToken = extractInviteTokenFromUrl(rawUrl);
        if (inviteToken) {
          await acceptFolderInvite(inviteToken);
          if (active) router.replace("/(tabs)/folders");
          return;
        }

        const extracted = extractSharedUrlFromIntent(rawUrl);
        if (extracted?.url) {
          router.replace({
            pathname: "/(tabs)",
            params: {
              sharedUrl: extracted.url,
              sharedTitle: extracted.title || "",
            },
          });
        }
      } catch {
        // Guard runtime deep link handler from uncaught promise rejection
      }
    }
    void handleDeepLink(incomingUrl);
    return () => {
      active = false;
    };
  }, [incomingUrl, navReady, router]);

  const bgColor = getThemePageBg(themeMode);

  return (
    <>
      <StatusBar style="light" backgroundColor="#880808" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#880808" },
          headerTintColor: "#FDFBF7",
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: bgColor },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="item/[id]" options={{ title: "รายละเอียดลิงก์" }} />
        <Stack.Screen name="folder/[id]" options={{ title: "โฟลเดอร์" }} />
      </Stack>
    </>
  );
}
