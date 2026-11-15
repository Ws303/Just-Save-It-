import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { completeOAuthWithTokens, exchangeOAuthCode } from "../src/api";
import { parseOAuthCallbackUrl } from "../src/shareIntent";
import { loadSession, recordAuthDebugEvent } from "../src/storage";

export default function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string;
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  }>();
  const liveUrl = Linking.useURL();
  const handledRef = useRef(false);
  const [statusText, setStatusText] = useState("กำลังตรวจสอบข้อมูลการเข้าสู่ระบบ...");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let active = true;

    async function finishAuth() {
      if (handledRef.current) return;

      const initialUrl = await Linking.getInitialURL().catch(() => null);
      const rawUrl = liveUrl || initialUrl || "";
      const fromUrl = parseOAuthCallbackUrl(rawUrl);

      const error =
        String(params.error_description || params.error || fromUrl.errorDescription || fromUrl.error || "").trim();
      const accessToken = String(params.access_token || fromUrl.accessToken || "").trim();
      const refreshToken = String(params.refresh_token || fromUrl.refreshToken || "").trim();
      const code = String(params.code || fromUrl.code || "").trim();

      if (error) {
        handledRef.current = true;
        recordAuthDebugEvent("callback_error", error);
        if (!active) return;
        router.replace({ pathname: "/login", params: { oauthError: error } });
        return;
      }

      if (accessToken) {
        handledRef.current = true;
        recordAuthDebugEvent("callback_implicit_token", "received access_token");
        setStatusText("กำลังบันทึกเซสชันเข้าสู่ระบบ...");
        const res = await completeOAuthWithTokens(accessToken, refreshToken);
        if (!active) return;
        if (res.ok) {
          router.replace("/(tabs)");
        } else {
          router.replace({
            pathname: "/login",
            params: { oauthError: res.error || "เข้าสู่ระบบด้วย Google ไม่สำเร็จ" },
          });
        }
        return;
      }

      if (code) {
        handledRef.current = true;
        recordAuthDebugEvent("callback_pkce_code", "exchanging authorization code");
        setStatusText("กำลังแลกรหัสยืนยันตัวตน Google (PKCE)...");
        const res = await exchangeOAuthCode(code);
        if (!active) return;
        if (res.ok) {
          router.replace("/(tabs)");
        } else {
          router.replace({
            pathname: "/login",
            params: { oauthError: res.error || "แลกรหัสเข้าสู่ระบบ Google ไม่สำเร็จ" },
          });
        }
        return;
      }

      const existing = await loadSession().catch(() => null);
      if (existing?.access_token) {
        handledRef.current = true;
        if (active) router.replace("/(tabs)");
        return;
      }

      recordAuthDebugEvent("callback_empty", rawUrl ? `url=${rawUrl.split("?")[0]}` : "no params yet");
    }

    void finishAuth();

    const fallbackTimer = setTimeout(() => {
      if (!handledRef.current && active) {
        void loadSession().then((sess) => {
          if (!active || handledRef.current) return;
          if (sess?.access_token) {
            handledRef.current = true;
            router.replace("/(tabs)");
          } else {
            setErrorText("ไม่ได้รับข้อมูลยืนยันตัวตนจาก Google กรุณาลองใหม่อีกครั้ง");
          }
        });
      }
    }, 1800);

    return () => {
      active = false;
      clearTimeout(fallbackTimer);
    };
  }, [liveUrl, params.access_token, params.code, params.error, params.error_description, params.refresh_token, router]);

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <ActivityIndicator size="large" color="#9B2C2C" />
        <Text style={styles.title}>{errorText ? "เข้าสู่ระบบไม่สำเร็จ" : statusText}</Text>
        {errorText ? (
          <>
            <Text style={styles.errText}>{errorText}</Text>
            <Pressable
              style={styles.retryBtn}
              onPress={() => router.replace({ pathname: "/login", params: { oauthError: errorText } })}
            >
              <Text style={styles.retryText}>กลับหน้าเข้าสู่ระบบ</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#F6F3EC",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderColor: "#EFECE6",
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1C1917",
    textAlign: "center",
  },
  errText: {
    fontSize: 13,
    color: "#991B1B",
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 4,
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
});
