import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  completeOAuthWithTokens,
  exchangeOAuthCode,
  isOAuthExchangeInFlight,
  loginWithPassword,
  prepareGoogleOAuthUrl,
  sendPasswordResetEmail,
  signupWithPassword,
} from "../src/api";
import { FIGMA_INK } from "../src/figmaTheme";
import { parseOAuthCallbackUrl } from "../src/shareIntent";
import {
  getDebugBannerEnabled,
  loadSession,
  recordAuthDebugEvent,
  setDebugBannerEnabled,
  subscribeDebugBanner,
} from "../src/storage";

WebBrowser.maybeCompleteAuthSession();

type AuthViewMode = "landing" | "email" | "signup" | "forgot";

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { oauthError } = useLocalSearchParams<{ oauthError?: string }>();
  const [viewMode, setViewMode] = useState<AuthViewMode>("landing");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [infoText, setInfoText] = useState("");
  const [debugOn, setDebugOn] = useState<boolean>(getDebugBannerEnabled);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const unsubDbg = subscribeDebugBanner((next) => setDebugOn(next));
    return () => {
      mountedRef.current = false;
      unsubDbg();
    };
  }, []);

  useEffect(() => {
    if (oauthError) {
      setErrorText(String(oauthError));
    }
  }, [oauthError]);

  function switchView(nextMode: AuthViewMode) {
    setViewMode(nextMode);
    setErrorText("");
    setInfoText("");
  }

  async function handleSubmit() {
    if (viewMode === "forgot") {
      if (!email.trim()) {
        setErrorText("กรุณากรอกอีเมลที่ใช้สมัคร");
        return;
      }
      setBusy(true);
      setErrorText("");
      setInfoText("");
      const res = await sendPasswordResetEmail(email);
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok) {
        setErrorText(res.error || "ไม่สามารถส่งลิงก์รีเซ็ตรหัสผ่านได้");
        return;
      }
      setInfoText("ส่งลิงก์ตั้งรหัสผ่านใหม่ไปยังอีเมลของคุณแล้ว กรุณาตรวจสอบกล่องจดหมายหรือโฟลเดอร์สแปม");
      return;
    }

    if (!email.trim() || !password) {
      setErrorText("กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน");
      return;
    }

    if (viewMode === "signup") {
      if (password.length < 8) {
        setErrorText("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
        return;
      }
      if (password !== confirmPassword) {
        setErrorText("รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน");
        return;
      }
      setBusy(true);
      setErrorText("");
      setInfoText("");
      const res = await signupWithPassword(email, password, displayName);
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok) {
        setErrorText(res.error || "สมัครสมาชิกไม่สำเร็จ");
        return;
      }
      if (typeof res.data?.access_token === "string" && res.data.access_token.trim().length > 0) {
        router.replace("/(tabs)");
      } else {
        Alert.alert("สมัครสมาชิกสำเร็จ", "กรุณายืนยันอีเมลแล้วเข้าสู่ระบบ");
        setViewMode("email");
      }
      return;
    }

    setBusy(true);
    setErrorText("");
    setInfoText("");
    const res = await loginWithPassword(email, password);
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error || "เข้าสู่ระบบไม่สำเร็จ");
      return;
    }
    router.replace("/(tabs)");
  }

  async function handleGoogleLogin() {
    setBusy(true);
    setErrorText("");
    setInfoText("");
    try {
      const redirectUri = Linking.createURL("auth-callback");
      const authUrl = await prepareGoogleOAuthUrl(redirectUri);
      recordAuthDebugEvent("oauth_start", redirectUri);
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
      if (!mountedRef.current) return;
      recordAuthDebugEvent("oauth_browser_result", result.type);

      if (result.type === "success" && result.url) {
        const parsed = parseOAuthCallbackUrl(result.url);
        if (parsed.error || parsed.errorDescription) {
          const msg = parsed.errorDescription || parsed.error;
          recordAuthDebugEvent("oauth_result_error", msg);
          setBusy(false);
          setErrorText(`เข้าสู่ระบบด้วย Google ไม่สำเร็จ: ${msg}`);
          return;
        }
        if (parsed.accessToken) {
          const res = await completeOAuthWithTokens(parsed.accessToken, parsed.refreshToken);
          if (!mountedRef.current) return;
          setBusy(false);
          if (res.ok) {
            router.replace("/(tabs)");
          } else {
            setErrorText(res.error || "บันทึกเซสชัน Google ไม่สำเร็จ");
          }
          return;
        }
        if (parsed.code) {
          const res = await exchangeOAuthCode(parsed.code);
          if (!mountedRef.current) return;
          setBusy(false);
          if (res.ok) {
            router.replace("/(tabs)");
          } else {
            setErrorText(res.error || "แลกรหัสเข้าสู่ระบบ Google ไม่สำเร็จ (PKCE)");
          }
          return;
        }
        setBusy(false);
        setErrorText("ไม่พบ Token หรือ Code จากหน้าต่าง Google กรุณาลองใหม่อีกครั้ง");
        return;
      }

      // On Android Chrome Custom Tabs, OS Intent may deliver the token/code directly to auth-callback
      const maxChecks = 16;
      for (let i = 0; i < maxChecks; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        if (!mountedRef.current) return;
        const existing = await loadSession().catch(() => null);
        if (!mountedRef.current) return;
        if (existing?.access_token) {
          setBusy(false);
          router.replace("/(tabs)");
          return;
        }
        if (!isOAuthExchangeInFlight() && i >= 1) {
          break;
        }
      }

      if (!mountedRef.current) return;
      setBusy(false);
      setErrorText("ยกเลิกการเข้าสู่ระบบด้วย Google หรือหน้าต่างถูกปิดก่อนเสร็จสิ้น");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "unknown error";
      recordAuthDebugEvent("oauth_open_exception", msg);
      if (!mountedRef.current) return;
      setBusy(false);
      setErrorText("ไม่สามารถเปิดหน้าต่างเข้าสู่ระบบ Google ได้");
    }
  }

  if (viewMode === "landing") {
    return (
      <View style={styles.landingRoot}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Image
            source={require("../assets/figma/login-red-corner.png")}
            style={styles.waveRedCorner}
            resizeMode="cover"
          />
          <Image
            source={require("../assets/figma/login-lavender-wave.png")}
            style={styles.waveLavenderBottom}
            resizeMode="stretch"
          />
        </View>

        <View
          style={[
            styles.landingStage,
            {
              paddingTop: Math.max(56, insets.top + 36),
              paddingBottom: Math.max(32, insets.bottom + 20),
            },
          ]}
        >
          <View style={styles.landingHero}>
            <Image
              source={require("../assets/figma/login-cherry-illustration.png")}
              style={styles.heroCherries}
              resizeMode="contain"
            />
            <Pressable
              onLongPress={() => setDebugBannerEnabled(!debugOn)}
              delayLongPress={700}
              style={styles.wordmarkWrap}
            >
              <Text style={styles.wordmarkHero}>Sherlink</Text>
              <Image
                source={require("../assets/figma/login-wordmark-accent.png")}
                style={styles.wordmarkRays}
                resizeMode="contain"
              />
            </Pressable>
            <Text style={styles.landingSubtitle}>Save, organize, and share what you love.</Text>
          </View>

          <View style={styles.landingBottom}>
            {errorText ? <Text style={styles.errorBanner}>{errorText}</Text> : null}

            <View style={styles.landingActions}>
              <Pressable
                style={[styles.redPillTall, busy && styles.disabledBtn]}
                disabled={busy}
                onPress={() => switchView("email")}
              >
                <Ionicons name="mail-outline" size={20} color="#FFFFFF" />
                <Text style={styles.redPillText}>เข้าสู่ระบบด้วยอีเมล</Text>
              </Pressable>

              <Pressable
                style={[styles.googlePillTall, busy && styles.disabledBtn]}
                disabled={busy}
                onPress={() => void handleGoogleLogin()}
              >
                {busy ? (
                  <ActivityIndicator color="#1B2135" />
                ) : (
                  <>
                    <Image
                      source={require("../assets/figma/google-logo.png")}
                      style={styles.googleIcon}
                      resizeMode="contain"
                    />
                    <Text style={styles.googlePillText}>ดำเนินการต่อด้วย Google</Text>
                  </>
                )}
              </Pressable>
            </View>

            <View style={styles.footerRow}>
              <Text style={styles.footerHint}>ยังไม่มีบัญชีใช่ไหม?</Text>
              <Pressable onPress={() => switchView("signup")}>
                <Text style={styles.footerLink}>สมัครใช้งาน</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.formRoot}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.formScroll,
          {
            paddingTop: Math.max(16, insets.top + 8),
            paddingBottom: Math.max(32, insets.bottom + 16),
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.topbar}>
          <Pressable
            style={styles.backBtn}
            hitSlop={10}
            onPress={() => switchView(viewMode === "forgot" ? "email" : "landing")}
          >
            <Ionicons name="chevron-back" size={20} color="#20283E" />
            <Text style={styles.backText}>กลับ</Text>
          </Pressable>
        </View>

        <View style={styles.subhead}>
          <Image
            source={require("../assets/figma/cherry-selected.png")}
            style={styles.smCherry}
            resizeMode="contain"
          />
          <Text style={styles.smWordmark}>Sherlink</Text>
          <Text style={styles.formTitle}>
            {viewMode === "signup"
              ? "สมัครใช้งาน"
              : viewMode === "forgot"
                ? "ลืมรหัสผ่าน?"
                : "เข้าสู่ระบบด้วยอีเมล"}
          </Text>
          <Text style={styles.formSub}>
            {viewMode === "signup"
              ? "สร้างบัญชีเพื่อเริ่มบันทึกลิงก์และแชร์กับเพื่อน"
              : viewMode === "forgot"
                ? "กรอกอีเมลที่ใช้สมัคร ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้คุณ"
                : "กรอกอีเมลและรหัสผ่านของคุณเพื่อใช้งานต่อ"}
          </Text>
        </View>

        {errorText ? <Text style={styles.errorBanner}>{errorText}</Text> : null}
        {infoText ? <Text style={styles.infoBanner}>{infoText}</Text> : null}

        {viewMode === "signup" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>ชื่อเล่น</Text>
            <TextInput
              style={styles.inputSoft}
              placeholder="เช่น มิน, แพรว"
              placeholderTextColor="#9CA3AF"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
            />
          </View>
        ) : null}

        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>อีเมล</Text>
          <TextInput
            style={styles.inputSoft}
            placeholder="name@email.com"
            placeholderTextColor="#9CA3AF"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            value={email}
            onChangeText={setEmail}
          />
        </View>

        {viewMode !== "forgot" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>รหัสผ่าน</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder={viewMode === "signup" ? "อย่างน้อย 8 ตัวอักษร" : "••••••••"}
                placeholderTextColor="#9CA3AF"
                secureTextEntry={!showPw}
                value={password}
                onChangeText={setPassword}
              />
              <Pressable hitSlop={8} onPress={() => setShowPw((v) => !v)}>
                <Text style={styles.pwToggleText}>{showPw ? "ซ่อน" : "แสดง"}</Text>
              </Pressable>
            </View>
            {viewMode === "email" ? (
              <View style={styles.forgotWrap}>
                <Pressable onPress={() => switchView("forgot")}>
                  <Text style={styles.forgotLink}>ลืมรหัสผ่าน?</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {viewMode === "signup" ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>ยืนยันรหัสผ่าน</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="กรอกรหัสผ่านอีกครั้ง"
                placeholderTextColor="#9CA3AF"
                secureTextEntry={!showPw}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
              />
            </View>
          </View>
        ) : null}

        <Pressable
          style={[styles.redPillTall, styles.formSubmitBtn, busy && styles.disabledBtn]}
          disabled={busy}
          onPress={() => void handleSubmit()}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.redPillText}>
              {viewMode === "signup"
                ? "สร้างบัญชี"
                : viewMode === "forgot"
                  ? "ส่งลิงก์รีเซ็ตรหัสผ่าน"
                  : "เข้าสู่ระบบ"}
            </Text>
          )}
        </Pressable>

        <View style={styles.footerRow}>
          {viewMode === "email" ? (
            <>
              <Text style={styles.footerHint}>ยังไม่มีบัญชีใช่ไหม?</Text>
              <Pressable onPress={() => switchView("signup")}>
                <Text style={styles.footerLink}>สมัครใช้งาน</Text>
              </Pressable>
            </>
          ) : viewMode === "signup" ? (
            <>
              <Text style={styles.footerHint}>มีบัญชีอยู่แล้ว?</Text>
              <Pressable onPress={() => switchView("email")}>
                <Text style={styles.footerLink}>เข้าสู่ระบบ</Text>
              </Pressable>
            </>
          ) : (
            <Pressable onPress={() => switchView("email")}>
              <Text style={styles.footerLink}>กลับไปหน้าเข้าสู่ระบบ</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  landingRoot: {
    flex: 1,
    backgroundColor: FIGMA_INK.bgCreamLogin,
    position: "relative",
  },
  waveRedCorner: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 221,
    height: 152,
    zIndex: 0,
  },
  waveLavenderBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: 147,
    zIndex: 0,
  },
  landingStage: {
    flex: 1,
    zIndex: 1,
    paddingHorizontal: 24,
    justifyContent: "space-between",
  },
  landingHero: {
    alignItems: "center",
    marginTop: 22,
    gap: 10,
  },
  heroCherries: {
    width: 205,
    height: 168,
  },
  wordmarkWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  wordmarkHero: {
    fontSize: 54,
    fontWeight: "800",
    letterSpacing: -2,
    color: FIGMA_INK.inkNavy,
    lineHeight: 60,
  },
  wordmarkRays: {
    position: "absolute",
    top: -10,
    right: -30,
    width: 28,
    height: 32,
  },
  landingSubtitle: {
    fontSize: 14.5,
    fontWeight: "500",
    color: "#1B2135",
    textAlign: "center",
  },
  landingBottom: {
    width: "100%",
    gap: 12,
  },
  landingActions: {
    gap: 12,
  },
  redPillTall: {
    height: 54,
    borderRadius: 999,
    backgroundColor: "#B80E23",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#B80E23",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 6,
  },
  redPillText: {
    color: "#FFFFFF",
    fontSize: 15.5,
    fontWeight: "700",
  },
  googlePillTall: {
    height: 54,
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "#E5D8C8",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleIcon: {
    width: 20,
    height: 20,
  },
  googlePillText: {
    color: "#1B2135",
    fontSize: 15.5,
    fontWeight: "600",
  },
  disabledBtn: {
    opacity: 0.7,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
  },
  footerHint: {
    fontSize: 14,
    color: "#334155",
  },
  footerLink: {
    fontSize: 14,
    fontWeight: "700",
    color: "#B80E23",
  },
  formRoot: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  formScroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingVertical: 6,
    paddingRight: 10,
  },
  backText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#20283E",
  },
  subhead: {
    alignItems: "center",
    marginBottom: 22,
    gap: 4,
  },
  smCherry: {
    width: 28,
    height: 28,
    marginBottom: 2,
  },
  smWordmark: {
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -1,
    color: "#C8102E",
  },
  formTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#20283E",
    marginTop: 6,
  },
  formSub: {
    fontSize: 13.5,
    color: FIGMA_INK.inkSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  fieldGroup: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 13.5,
    fontWeight: "700",
    color: "#20283E",
    marginBottom: 6,
  },
  inputSoft: {
    height: 48,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 14,
    paddingHorizontal: 14,
    fontSize: 15,
    color: FIGMA_INK.inkStrong,
  },
  passwordWrap: {
    height: 48,
    backgroundColor: FIGMA_INK.bgMuted,
    borderWidth: 1,
    borderColor: FIGMA_INK.borderCard,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  passwordInput: {
    flex: 1,
    height: 46,
    fontSize: 15,
    color: FIGMA_INK.inkStrong,
  },
  pwToggleText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#B80E23",
    paddingLeft: 10,
  },
  forgotWrap: {
    alignItems: "flex-end",
    marginTop: 8,
  },
  forgotLink: {
    fontSize: 13,
    fontWeight: "600",
    color: "#B80E23",
  },
  errorBanner: {
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
    color: "#991B1B",
    borderRadius: 12,
    padding: 10,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
  },
  infoBanner: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
    color: "#166534",
    borderRadius: 12,
    padding: 10,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 12,
    textAlign: "center",
    lineHeight: 19,
  },
  formSubmitBtn: {
    marginTop: 6,
  },
});
