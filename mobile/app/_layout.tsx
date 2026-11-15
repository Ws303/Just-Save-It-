import React, { useEffect, useRef } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { acceptFolderInvite, fetchWorkspace, flushOfflineQueue } from "../src/api";
import { syncLocalRemindersWithOs } from "../src/notifications";
import { extractInviteTokenFromUrl, extractSharedUrlFromIntent } from "../src/shareIntent";
import { loadSession } from "../src/storage";

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const incomingUrl = Linking.useURL();
  const hydratedUserRef = useRef<string>("");
  const pendingDeepLinkRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    async function processDeepLink(rawUrl: string) {
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
    }

    async function bootstrap() {
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
        await flushOfflineQueue();
        const ws = await fetchWorkspace();
        if (active && ws.reminders.length > 0) {
          await syncLocalRemindersWithOs(ws.reminders);
        }
      }

      if (active && pendingDeepLinkRef.current) {
        const queuedUrl = pendingDeepLinkRef.current;
        pendingDeepLinkRef.current = null;
        await processDeepLink(queuedUrl);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [segments, router]);

  useEffect(() => {
    if (!incomingUrl) return;
    let active = true;
    async function handleDeepLink(rawUrl: string) {
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
    }
    void handleDeepLink(incomingUrl);
    return () => {
      active = false;
    };
  }, [incomingUrl, router]);

  return (
    <>
      <StatusBar style="light" backgroundColor="#880808" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#880808" },
          headerTintColor: "#FDFBF7",
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: "#F6F3EC" },
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
