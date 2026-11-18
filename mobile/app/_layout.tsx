import React, { Component, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { getRandomValues as expoGetRandomValues } from "expo-crypto";
import { Stack, useRootNavigationState, useRouter, useSegments } from "expo-router";

const globalWithCrypto = globalThis as unknown as {
  crypto?: { getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T };
};
if (!globalWithCrypto.crypto) {
  globalWithCrypto.crypto = {
    getRandomValues: expoGetRandomValues as <T extends ArrayBufferView | null>(array: T) => T,
  };
} else if (typeof globalWithCrypto.crypto.getRandomValues !== "function") {
  globalWithCrypto.crypto.getRandomValues = expoGetRandomValues as <T extends ArrayBufferView | null>(array: T) => T;
}
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import {
  acceptFolderInvite,
  completeOAuthWithTokens,
  exchangeOAuthCode,
  fetchWorkspace,
  flushOfflineQueue,
  subscribeSessionExpired,
  syncRemindersFromServer,
} from "../src/api";
import {
  extractInviteTokenFromUrl,
  extractSharedUrlFromIntent,
  parseOAuthCallbackUrl,
} from "../src/shareIntent";
import {
  AppThemeMode,
  AuthDebugEvent,
  clearAuthDebugEvents,
  getAuthDebugEvents,
  getDebugBannerEnabled,
  getThemePageBg,
  loadSession,
  loadThemeMode,
  recordAuthDebugEvent,
  setDebugBannerEnabled,
  subscribeAuthDebugEvents,
  subscribeDebugBanner,
  subscribeThemeMode,
} from "../src/storage";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class RootErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg = error instanceof Error ? error.message : String(error || "เกิดข้อผิดพลาดที่ไม่คาดคิด");
    return { hasError: true, message: msg };
  }

  componentDidCatch(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error || "unknown error");
    recordAuthDebugEvent("root_error_boundary", msg);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={debugStyles.crashRoot}>
          <View style={debugStyles.crashCard}>
            <Text style={debugStyles.crashTitle}>แอปพบข้อผิดพลาดชั่วคราว</Text>
            <Text style={debugStyles.crashMsg}>{this.state.message}</Text>
            <Pressable
              style={debugStyles.crashBtn}
              onPress={() => this.setState({ hasError: false, message: "" })}
            >
              <Text style={debugStyles.crashBtnText}>ลองเปิดหน้าจออีกครั้ง</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

function RootLayoutContent() {
  const router = useRouter();
  const rootNavState = useRootNavigationState();
  const segments = useSegments();
  const incomingUrl = Linking.useURL();
  const hydratedUserRef = useRef<string>("");
  const pendingDeepLinkRef = useRef<string | null>(null);
  const [themeMode, setThemeMode] = useState<AppThemeMode>("cream");
  const [bootState, setBootState] = useState<{ ready: boolean; hasSession: boolean }>({
    ready: false,
    hasSession: false,
  });
  const [debugEnabled, setDebugEnabled] = useState<boolean>(getDebugBannerEnabled);
  const [debugEvents, setDebugEvents] = useState<AuthDebugEvent[]>(getAuthDebugEvents);
  const navReady = Boolean(rootNavState?.key);
  const navReadyRef = useRef(false);
  navReadyRef.current = navReady;
  const inAuthRouteRef = useRef(false);
  inAuthRouteRef.current = segments[0] === "login" || segments[0] === "auth-callback";

  useEffect(() => {
    void loadThemeMode().then((mode) => setThemeMode(mode)).catch(() => {});
    const unsubTheme = subscribeThemeMode((mode) => setThemeMode(mode));
    const unsubBanner = subscribeDebugBanner((next) => setDebugEnabled(next));
    const unsubLog = subscribeAuthDebugEvents((evts) => setDebugEvents([...evts]));
    const unsubExpired = subscribeSessionExpired(() => {
      hydratedUserRef.current = "";
      if (navReadyRef.current && !inAuthRouteRef.current) {
        router.replace("/login");
      }
    });
    return () => {
      unsubTheme();
      unsubBanner();
      unsubLog();
      unsubExpired();
    };
  }, [router]);

  useEffect(() => {
    let active = true;
    async function initColdBootGate() {
      try {
        const [session, initialUrl] = await Promise.all([
          loadSession().catch(() => null),
          Linking.getInitialURL().catch(() => null),
        ]);
        if (!active) return;
        const hasSession = Boolean(session?.access_token);
        recordAuthDebugEvent("boot_gate", `hasSession=${hasSession}`);
        if (initialUrl) {
          recordAuthDebugEvent("initial_url", initialUrl.split("?")[0].split("#")[0]);
        }
        setBootState({ ready: true, hasSession });
      } catch {
        if (active) setBootState({ ready: true, hasSession: false });
      }
    }
    void initColdBootGate();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!bootState.ready || !navReady) return;
    let active = true;
    async function processDeepLink(rawUrl: string) {
      try {
        const inviteToken = extractInviteTokenFromUrl(rawUrl);
        if (inviteToken) {
          const invRes = await acceptFolderInvite(inviteToken);
          if (!active) return;
          if (!invRes.ok) {
            Alert.alert("เข้าร่วมโฟลเดอร์ไม่สำเร็จ", invRes.error || "ลิงก์เชิญอาจหมดอายุหรือถูกยกเลิกแล้ว");
          }
          router.replace("/(tabs)/folders");
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
        const routeHead = String(segments[0] || "");
        const inLogin = routeHead === "login";
        const inAuthCallback = routeHead === "auth-callback";

        if (!session?.access_token) {
          hydratedUserRef.current = "";
          if (!inLogin && !inAuthCallback) {
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
          const liveSess = await loadSession().catch(() => null);
          if (active && !liveSess?.access_token) {
            hydratedUserRef.current = "";
            if (!inLogin && !inAuthCallback) {
              router.replace("/login");
            }
            return;
          }
          if (active) {
            await syncRemindersFromServer(Array.isArray(ws.reminders) ? ws.reminders : []).catch(() => {});
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
  }, [bootState.ready, navReady, segments, router]);

  useEffect(() => {
    if (!incomingUrl || !bootState.ready || !navReady) return;
    let active = true;
    async function handleDeepLink(rawUrl: string) {
      try {
        recordAuthDebugEvent("incoming_url", rawUrl.split("#")[0]);

        const oauth = parseOAuthCallbackUrl(rawUrl);
        if (oauth.isAuthCallback) {
          if (oauth.error || oauth.errorDescription) {
            const msg = oauth.errorDescription || oauth.error;
            recordAuthDebugEvent("oauth_deeplink_error", msg);
            const existing = await loadSession().catch(() => null);
            if (!existing?.access_token && active) {
              router.replace({ pathname: "/login", params: { oauthError: msg } });
            }
            return;
          }
          if (oauth.accessToken) {
            const res = await completeOAuthWithTokens(oauth.accessToken, oauth.refreshToken);
            if (active) {
              if (res.ok) {
                router.replace("/(tabs)");
              } else {
                const existing = await loadSession().catch(() => null);
                if (existing?.access_token) {
                  router.replace("/(tabs)");
                } else {
                  router.replace({ pathname: "/login", params: { oauthError: res.error || "OAuth ล้มเหลว" } });
                }
              }
            }
            return;
          }
          if (oauth.code) {
            const res = await exchangeOAuthCode(oauth.code);
            if (active) {
              if (res.ok) {
                router.replace("/(tabs)");
              } else {
                const existing = await loadSession().catch(() => null);
                if (existing?.access_token) {
                  router.replace("/(tabs)");
                } else {
                  router.replace({ pathname: "/login", params: { oauthError: res.error || "PKCE ล้มเหลว" } });
                }
              }
            }
            return;
          }
        }

        const session = await loadSession();
        if (!active) return;
        if (!session?.access_token) {
          pendingDeepLinkRef.current = rawUrl;
          return;
        }

        const inviteToken = extractInviteTokenFromUrl(rawUrl);
        if (inviteToken) {
          const invRes = await acceptFolderInvite(inviteToken);
          if (!active) return;
          if (!invRes.ok) {
            Alert.alert("เข้าร่วมโฟลเดอร์ไม่สำเร็จ", invRes.error || "ลิงก์เชิญอาจหมดอายุหรือถูกยกเลิกแล้ว");
          }
          router.replace("/(tabs)/folders");
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
  }, [incomingUrl, bootState.ready, navReady, router]);

  const bgColor = getThemePageBg(themeMode);

  if (!bootState.ready) {
    return (
      <View style={[debugStyles.bootGate, { backgroundColor: bgColor }]}>
        <StatusBar style={themeMode === "dark" ? "light" : "dark"} backgroundColor="#880808" />
        <ActivityIndicator size="large" color="#9B2C2C" />
        <Text style={debugStyles.bootText}>กำลังเตรียม Sharely...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <StatusBar style="light" backgroundColor="#880808" />
      <Stack
        initialRouteName={bootState.hasSession ? "(tabs)" : "login"}
        screenOptions={{
          headerStyle: { backgroundColor: "#880808" },
          headerTintColor: "#FDFBF7",
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: bgColor },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="auth-callback" options={{ headerShown: false }} />
        <Stack.Screen name="item/[id]" options={{ title: "รายละเอียดลิงก์" }} />
        <Stack.Screen name="folder/[id]" options={{ title: "โฟลเดอร์" }} />
      </Stack>

      {debugEnabled ? (
        <View style={debugStyles.bannerWrap} pointerEvents="box-none">
          <View style={debugStyles.bannerBox}>
            <View style={debugStyles.bannerHead}>
              <Text style={debugStyles.bannerTitle}>
                Debug · route=/{segments.join("/") || ""} · auth={hydratedUserRef.current ? "yes" : "no"}
              </Text>
              <View style={debugStyles.bannerActions}>
                <Pressable onPress={() => clearAuthDebugEvents()} style={debugStyles.bannerBtn}>
                  <Text style={debugStyles.bannerBtnText}>ล้าง</Text>
                </Pressable>
                <Pressable onPress={() => setDebugBannerEnabled(false)} style={debugStyles.bannerBtn}>
                  <Text style={debugStyles.bannerBtnText}>ปิด</Text>
                </Pressable>
              </View>
            </View>
            {debugEvents.slice(0, 3).map((ev, idx) => (
              <Text key={`${ev.at}-${idx}`} style={debugStyles.bannerLine} numberOfLines={1}>
                [{ev.at}] {ev.stage}: {ev.detail}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  return (
    <RootErrorBoundary>
      <RootLayoutContent />
    </RootErrorBoundary>
  );
}

const debugStyles = StyleSheet.create({
  bootGate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  bootText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#57534E",
  },
  crashRoot: {
    flex: 1,
    backgroundColor: "#F6F3EC",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  crashCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 22,
    width: "100%",
    maxWidth: 360,
    gap: 10,
    borderWidth: 1,
    borderColor: "#E7E5E4",
  },
  crashTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#880808",
  },
  crashMsg: {
    fontSize: 13,
    color: "#44403C",
    lineHeight: 19,
  },
  crashBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 6,
  },
  crashBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  bannerWrap: {
    position: "absolute",
    top: 38,
    left: 12,
    right: 12,
    zIndex: 99,
  },
  bannerBox: {
    backgroundColor: "rgba(28, 25, 23, 0.94)",
    borderRadius: 12,
    padding: 10,
    gap: 3,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  bannerHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  bannerTitle: {
    color: "#FDE68A",
    fontSize: 11,
    fontWeight: "700",
    flex: 1,
  },
  bannerActions: {
    flexDirection: "row",
    gap: 6,
  },
  bannerBtn: {
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  bannerBtnText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "600",
  },
  bannerLine: {
    color: "#E7E5E4",
    fontSize: 11,
  },
});
