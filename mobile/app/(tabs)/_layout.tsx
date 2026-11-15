import React from "react";
import { Text } from "react-native";
import { Tabs } from "expo-router";

function TabEmoji({ symbol, focused }: { symbol: string; focused: boolean }) {
  return <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.65 }}>{symbol}</Text>;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: "transparent" },
        headerStyle: { backgroundColor: "#880808" },
        headerTintColor: "#FDFBF7",
        headerTitleStyle: { fontWeight: "700" },
        tabBarActiveTintColor: "#9B2C2C",
        tabBarInactiveTintColor: "#78716C",
        tabBarStyle: {
          backgroundColor: "#FDFBF7",
          borderTopColor: "#EAE4DB",
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "หน้าหลัก",
          headerTitle: "SHARELY",
          tabBarIcon: ({ focused }) => <TabEmoji symbol="🏠" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="folders"
        options={{
          title: "โฟลเดอร์",
          headerTitle: "โฟลเดอร์ของฉัน",
          tabBarIcon: ({ focused }) => <TabEmoji symbol="📁" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: "ชื่นชอบ",
          headerTitle: "รายการโปรด & เตือนความจำ",
          tabBarIcon: ({ focused }) => <TabEmoji symbol="⭐" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "โปรไฟล์",
          headerTitle: "โปรไฟล์ & ความปลอดภัย",
          tabBarIcon: ({ focused }) => <TabEmoji symbol="👤" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
