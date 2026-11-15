import React, { useState } from "react";
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
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";
import { getGoogleOAuthUrl, loginWithPassword, signupWithPassword } from "../src/api";
import { saveSession } from "../src/storage";

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");

  async function handleSubmit() {
    if (!email.trim() || !password) {
      setErrorText("กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน");
      return;
    }
    setBusy(true);
    setErrorText("");

    if (mode === "login") {
      const res = await loginWithPassword(email, password);
      setBusy(false);
      if (!res.ok) {
        setErrorText(res.error || "เข้าสู่ระบบไม่สำเร็จ");
        return;
      }
      router.replace("/(tabs)");
      return;
    }

    const res = await signupWithPassword(email, password, displayName);
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error || "สมัครสมาชิกไม่สำเร็จ");
      return;
    }
    if (typeof res.data?.access_token === "string") {
      router.replace("/(tabs)");
    } else {
      Alert.alert("สมัครสมาชิกสำเร็จ", "กรุณายืนยันอีเมลแล้วเข้าสู่ระบบ");
      setMode("login");
    }
  }

  async function handleGoogleLogin() {
    setBusy(true);
    setErrorText("");
    try {
      const redirectUri = Linking.createURL("auth-callback");
      const authUrl = getGoogleOAuthUrl(redirectUri);
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
      if (result.type === "success" && result.url) {
        const hashIdx = result.url.indexOf("#");
        const query = hashIdx >= 0 ? result.url.slice(hashIdx + 1) : result.url.split("?")[1] || "";
        const params = new URLSearchParams(query);
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token") || "";
        if (accessToken) {
          await saveSession({
            access_token: accessToken,
            refresh_token: refreshToken,
            user: null,
          });
          setBusy(false);
          router.replace("/(tabs)");
          return;
        }
      }
      setBusy(false);
    } catch {
      setBusy(false);
      setErrorText("ไม่สามารถเปิดหน้าต่างเข้าสู่ระบบ Google ได้");
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.logoBadge}>
            <Image source={require("../assets/icon.png")} style={styles.logoImage} resizeMode="cover" />
          </View>
          <Text style={styles.brandTitle}>SHARELY</Text>
          <Text style={styles.brandSubtitle}>เก็บลิงก์ง่าย แชร์ไว ในที่เดียว</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.tabRow}>
            <Pressable
              style={[styles.tabBtn, mode === "login" && styles.tabBtnActive]}
              onPress={() => {
                setMode("login");
                setErrorText("");
              }}
            >
              <Text style={[styles.tabLabel, mode === "login" && styles.tabLabelActive]}>เข้าสู่ระบบ</Text>
            </Pressable>
            <Pressable
              style={[styles.tabBtn, mode === "signup" && styles.tabBtnActive]}
              onPress={() => {
                setMode("signup");
                setErrorText("");
              }}
            >
              <Text style={[styles.tabLabel, mode === "signup" && styles.tabLabelActive]}>สมัครสมาชิก</Text>
            </Pressable>
          </View>

          {mode === "signup" ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>ชื่อที่แสดง</Text>
              <TextInput
                style={styles.input}
                placeholder="เช่น ภูมิ"
                placeholderTextColor="#A8A29E"
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
              />
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>อีเมล</Text>
            <TextInput
              style={styles.input}
              placeholder="name@example.com"
              placeholderTextColor="#A8A29E"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>รหัสผ่าน</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor="#A8A29E"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </View>

          {errorText ? <Text style={styles.errorBanner}>{errorText}</Text> : null}

          <Pressable
            style={[styles.primaryBtn, busy && styles.disabledBtn]}
            disabled={busy}
            onPress={() => void handleSubmit()}
          >
            {busy ? (
              <ActivityIndicator color="#FDFBF7" />
            ) : (
              <Text style={styles.primaryBtnText}>
                {mode === "login" ? "เข้าสู่ระบบ" : "สร้างบัญชีใหม่"}
              </Text>
            )}
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>หรือ</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable
            style={styles.googleBtn}
            disabled={busy}
            onPress={() => void handleGoogleLogin()}
          >
            <Text style={styles.googleBtnText}>G  ดำเนินการต่อด้วย Google</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#F6F3EC",
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 32,
  },
  hero: {
    backgroundColor: "#880808",
    paddingTop: 64,
    paddingBottom: 42,
    paddingHorizontal: 24,
    alignItems: "center",
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  logoBadge: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: "#FDFBF7",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.65)",
  },
  logoImage: {
    width: "100%",
    height: "100%",
  },
  brandTitle: {
    color: "#FDFBF7",
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 2,
  },
  brandSubtitle: {
    color: "#FEE2E2",
    fontSize: 14,
    marginTop: 6,
  },
  card: {
    backgroundColor: "#FDFBF7",
    marginHorizontal: 20,
    marginTop: -22,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "#EAE4DB",
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: "#F3EFE6",
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  tabBtnActive: {
    backgroundColor: "#9B2C2C",
  },
  tabLabel: {
    color: "#78716C",
    fontWeight: "600",
    fontSize: 14,
  },
  tabLabelActive: {
    color: "#FDFBF7",
  },
  fieldGroup: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#44403C",
    marginBottom: 6,
  },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E7E0D5",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#1C1917",
  },
  errorBanner: {
    backgroundColor: "#FEF2F2",
    color: "#9B2C2C",
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    marginBottom: 12,
    textAlign: "center",
  },
  primaryBtn: {
    backgroundColor: "#9B2C2C",
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  disabledBtn: {
    opacity: 0.7,
  },
  primaryBtnText: {
    color: "#FDFBF7",
    fontWeight: "700",
    fontSize: 16,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#EAE4DB",
  },
  dividerText: {
    marginHorizontal: 10,
    color: "#78716C",
    fontSize: 12,
  },
  googleBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6CFC4",
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
  },
  googleBtnText: {
    color: "#1C1917",
    fontWeight: "600",
    fontSize: 15,
  },
});
