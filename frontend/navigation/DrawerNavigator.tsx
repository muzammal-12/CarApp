// navigation/DrawerNavigator.tsx
import "react-native-gesture-handler";
import React, { useEffect, useMemo, useState } from "react";
import {
  createDrawerNavigator,
  DrawerContentScrollView,
  DrawerContentComponentProps,
} from "@react-navigation/drawer";
import type { ParamListBase } from "@react-navigation/native";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import {
  Home,
  BookOpen,
  Wrench,
  Car,
  Headphones,
  MapPin,
  User,
  ChevronLeft,
  ChevronRight,
} from "lucide-react-native";

// 🔹 same auth hook used in Profile
import { useAuth } from "@/services/authContext";

import DashboardScreen from "@/screens/dashboard/DashboardScreen";
import GuidesScreen from "@/screens/guides/GuidesScreen";
import MaintenanceScreen from "@/screens/maintenance/MaintenanceScreen";
import TireCheckScreen from "@/screens/tire-check/TireCheckScreen";
import SoundDiagnosisScreen from "@/screens/sound-diagnosis/SoundDiagnosisScreen";
// import ShopNetworkScreen from "@/screens/shop/ShopNetworkScreen";
import ProfileScreen from "@/screens/profile/ProfileScreen";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const Drawer = createDrawerNavigator();

type NavItem = {
  label: string;
  route: keyof ParamListBase | string;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", route: "Dashboard", Icon: Home },
  { label: "Guides", route: "Guides", Icon: BookOpen },
  { label: "Maintenance", route: "Maintenance", Icon: Wrench },
  { label: "Tire&Part Check", route: "TireCheck", Icon: Car },
  { label: "Sound Diagnosis", route: "SoundDiagnosis", Icon: Headphones },
  // { label: "Shop Network", route: "ShopNetwork", Icon: MapPin },
  { label: "Profile", route: "Profile", Icon: User },
];

function BrandHeader({
  collapsed,
  canCollapse,
  onToggle,
}: {
  collapsed: boolean;
  canCollapse: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.brandRow}>
      {!collapsed && (
        <View style={{ flex: 1 }}>
          <Text style={styles.brandTitle}>Car-AI</Text>
          <Text style={styles.brandSub}>Search • Calls • Deals</Text>
        </View>
      )}
      {canCollapse && (
        <TouchableOpacity onPress={onToggle} style={styles.collapseBtn}>
          {collapsed ? (
            <ChevronRight size={18} color="#64748b" />
          ) : (
            <ChevronLeft size={18} color="#64748b" />
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

type CustomProps = DrawerContentComponentProps & {
  collapsed: boolean;
  onToggle: () => void;
  canCollapse: boolean;
  userEmail?: string | null;
};

function CustomDrawerContent({
  navigation,
  state,
  collapsed,
  onToggle,
  canCollapse,
  userEmail,
}: CustomProps) {
  const insets = useSafeAreaInsets();
  const activeRouteName =
    state && typeof state.index === "number"
      ? state.routeNames[state.index]
      : undefined;

  // small knob if you want a touch more spacing below the clock/indicators
  const STATUS_BUFFER = 50; // tweak to 8–10 if needed

  return (
    <DrawerContentScrollView
      // Respect the status bar area here so text never merges with time/notifications
      contentContainerStyle={[
        styles.drawer,
        collapsed && styles.drawerCollapsed,
        { paddingTop: insets.top + STATUS_BUFFER },
      ]}
    >
      <BrandHeader
        collapsed={collapsed}
        canCollapse={canCollapse}
        onToggle={onToggle}
      />

      {!collapsed && <Text style={styles.sectionLabel}>Navigation</Text>}

      <View style={styles.items}>
        {NAV_ITEMS.map(({ label, route, Icon }) => {
          const isFocused = activeRouteName === route;
          return (
            <TouchableOpacity
              key={String(route)}
              onPress={() => navigation.navigate(route as never)}
              accessibilityLabel={label}
              style={[
                styles.railItem,
                isFocused && styles.railItemActive,
                collapsed ? styles.railItemCollapsed : styles.railItemExpanded,
              ]}
            >
              <Icon size={20} color={isFocused ? "#0f172a" : "#64748b"} />
              {!collapsed && (
                <Text
                  style={[styles.railLabel, { color: "#0f172a" }]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {!collapsed && (
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Logged in as {userEmail ?? "—"}
          </Text>
        </View>
      )}
    </DrawerContentScrollView>
  );
}

export default function DrawerNavigator() {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const [collapsed, setCollapsed] = useState(false);

  // 🔹 Read what auth context exposes AND fall back to /api/auth/me (same as Profile)
  const { token, profile, user, me } = useAuth() as any;
  const [email, setEmail] = useState<string | null>(
    profile?.email ?? user?.email ?? me?.email ?? null
  );

  // Fetch if not present yet (same endpoint Profile uses)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (email || !token) return;
      try {
        const base =
          process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ||
          process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, "") ||
          "http://localhost:5000";
        const r = await fetch(`${base}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!cancelled && r.ok) {
          const me = await r.json();
          setEmail(me?.email ?? null);
        }
      } catch {
        // ignore – footer will show "—"
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [token, email]);

  const drawerWidth = useMemo(() => (collapsed ? 72 : 280), [collapsed]);

  return (
    <Drawer.Navigator
      initialRouteName="Dashboard"
      drawerContent={(p) => (
        <CustomDrawerContent
          {...p}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          canCollapse={isWide}
          userEmail={email}
        />
      )}
      screenOptions={{
        headerTitleAlign: "center",
        drawerType: isWide ? "permanent" : "front",
        drawerStyle: {
          backgroundColor: "#f8fafc",
          width: drawerWidth,
        },
        overlayColor: "rgba(0,0,0,0.25)",
        headerStyle: { backgroundColor: "#ffffff" },
        headerTintColor: "#111827",
      }}
    >
      <Drawer.Screen name="Dashboard" component={DashboardScreen} options={{ title: "Dashboard" }} />
      <Drawer.Screen name="Guides" component={GuidesScreen} options={{ title: "Guides" }} />
      <Drawer.Screen name="Maintenance" component={MaintenanceScreen} options={{ title: "Maintenance" }} />
      <Drawer.Screen name="TireCheck" component={TireCheckScreen} options={{ title: "Tire&Part Check" }} />
      <Drawer.Screen name="SoundDiagnosis" component={SoundDiagnosisScreen} options={{ title: "Sound Diagnosis" }} />
      {/* <Drawer.Screen name="ShopNetwork" component={ShopNetworkScreen} options={{ title: "Shop Network" }} /> */}
      <Drawer.Screen name="Profile" component={ProfileScreen} options={{ title: "Profile" }} />
    </Drawer.Navigator>
  );
}

/* ---- styles ---- */
const styles = StyleSheet.create({
  drawer: {
    backgroundColor: "#f8fafc",
    paddingTop: 0,      // actual top spacing comes from safe-area insets in component
    paddingHorizontal: 8,
    flex: 1,
  },
  drawerCollapsed: { paddingHorizontal: 6 },

  // use minHeight + padding instead of fixed height so the header breathes
  brandRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  brandTitle: { color: "#0f172a", fontSize: 18, fontWeight: "700" },
  brandSub: { color: "#6b7280", marginTop: 2, fontSize: 12 },
  collapseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },

  sectionLabel: {
    color: "#64748b",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 12,
  },

  items: { gap: 8, paddingTop: 8 },

  railItem: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    marginHorizontal: 4,
    backgroundColor: "#eef2f7",
  },
  railItemCollapsed: {
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  railItemExpanded: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  railItemActive: { backgroundColor: "#dbeafe" },
  railLabel: { marginLeft: 10, fontSize: 14, fontWeight: "600" },

  footer: {
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopColor: "#e5e7eb",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerText: { fontSize: 12, color: "#6b7280" },
});
