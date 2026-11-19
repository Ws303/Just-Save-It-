import React from "react";
import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottomOffset = Math.max(10, insets.bottom);

  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: "#FDFBF7" },
        headerStyle: { backgroundColor: "#FDFBF7" },
        headerTintColor: "#1E1B18",
        headerTitleStyle: { fontWeight: "800", fontSize: 18 },
        headerShadowVisible: false,
        tabBarActiveTintColor: "#E24C4B",
        tabBarInactiveTintColor: "#6E675F",
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
          marginBottom: Platform.OS === "ios" ? 0 : 4,
        },
        tabBarStyle: {
          position: "absolute",
          left: 16,
          right: 16,
          bottom: bottomOffset,
          height: 62,
          borderRadius: 31,
          backgroundColor: "#FFFFFF",
          borderTopWidth: 1,
          borderWidth: 1,
          borderColor: "#EFE9DF",
          paddingTop: 6,
          paddingBottom: 6,
          shadowColor: "#1E1B18",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.08,
          shadowRadius: 14,
          elevation: 8,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "หน้าหลัก",
          headerTitle: "SHERLINK",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "home" : "home-outline"} size={21} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="folders"
        options={{
          title: "โฟลเดอร์",
          headerTitle: "โฟลเดอร์ของฉัน",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "folder" : "folder-outline"} size={21} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="ai"
        options={{
          title: "AI",
          headerTitle: "ตั้งค่า AI สรุปเนื้อหา",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "sparkles" : "sparkles-outline"} size={21} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "โปรไฟล์",
          headerTitle: "โปรไฟล์และตั้งค่า",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "person" : "person-outline"} size={21} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          href: null,
          title: "ชื่นชอบ",
          headerTitle: "รายการโปรด",
        }}
      />
    </Tabs>
  );
}
