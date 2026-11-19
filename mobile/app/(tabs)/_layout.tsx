import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getFigmaTheme, type FigmaAccentThemeId } from "../../src/figmaTheme";
import { loadFigmaAccentTheme, subscribeFigmaAccentTheme } from "../../src/storage";

const VISIBLE_TABS: Record<
  string,
  {
    label: string;
    renderIcon: (color: string, focused: boolean) => React.ReactNode;
  }
> = {
  index: {
    label: "หน้าหลัก",
    renderIcon: (color, focused) => (
      <Ionicons name={focused ? "home" : "home-outline"} size={22} color={color} />
    ),
  },
  folders: {
    label: "โฟลเดอร์",
    renderIcon: (color, focused) => (
      <Ionicons name={focused ? "folder" : "folder-outline"} size={22} color={color} />
    ),
  },
  ai: {
    label: "AI",
    renderIcon: (color) => (
      <MaterialCommunityIcons name="robot-outline" size={22} color={color} />
    ),
  },
  profile: {
    label: "โปรไฟล์",
    renderIcon: (color, focused) => (
      <Ionicons name={focused ? "person-circle" : "person-circle-outline"} size={23} color={color} />
    ),
  },
};

type ExpoTabBarBaseProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>["tabBar"]>>[0];

interface CustomTabBarProps extends ExpoTabBarBaseProps {
  bottomOffset: number;
  themeId: FigmaAccentThemeId;
}

function FigmaFloatingTabBar({ state, navigation, bottomOffset, themeId }: CustomTabBarProps) {
  const theme = getFigmaTheme(themeId);
  const activeRouteKey = state.routes[state.index]?.key;
  const visibleRoutes = state.routes.filter((r) => Boolean(VISIBLE_TABS[r.name]));

  return (
    <View style={[styles.wrap, { bottom: bottomOffset }]} pointerEvents="box-none">
      <View style={styles.pill}>
        {visibleRoutes.map((route) => {
          const meta = VISIBLE_TABS[route.name];
          const focused = route.key === activeRouteKey;
          const color = focused ? theme.accentText : "#4F4F4F";

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              style={[
                styles.item,
                focused && { backgroundColor: theme.soft },
              ]}
              onPress={() => {
                const evt = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !evt.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
              onLongPress={() => {
                navigation.emit({
                  type: "tabLongPress",
                  target: route.key,
                });
              }}
            >
              {meta.renderIcon(color, focused)}
              <Text
                style={[
                  styles.label,
                  { color, fontWeight: focused ? "700" : "600" },
                ]}
                numberOfLines={1}
              >
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottomOffset = Math.max(12, insets.bottom);
  const [themeId, setThemeId] = useState<FigmaAccentThemeId>("sharely");

  useEffect(() => {
    void loadFigmaAccentTheme().then(setThemeId).catch(() => {});
    const unsub = subscribeFigmaAccentTheme((next) => setThemeId(next));
    return () => unsub();
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: "#FFFFFF" },
      }}
      tabBar={(props) => (
        <FigmaFloatingTabBar
          {...props}
          bottomOffset={bottomOffset}
          themeId={themeId}
        />
      )}
    >
      <Tabs.Screen name="index" options={{ title: "หน้าหลัก" }} />
      <Tabs.Screen name="folders" options={{ title: "โฟลเดอร์" }} />
      <Tabs.Screen name="ai" options={{ title: "AI" }} />
      <Tabs.Screen name="profile" options={{ title: "โปรไฟล์" }} />
      <Tabs.Screen name="favorites" options={{ href: null, title: "ชื่นชอบ" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 14,
    right: 14,
    zIndex: 20,
  },
  pill: {
    height: 68,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#FFFFFF",
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "#EFEFEF",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    shadowColor: "#1A1A1A",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 10,
  },
  item: {
    flex: 1,
    height: 54,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  label: {
    fontSize: 11,
    lineHeight: 14,
  },
});
