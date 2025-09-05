// screens/dashboard/DashboardScreen.tsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useLayoutEffect,
} from "react";
import {
  ScrollView,
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ActivityIndicator,
  FlatList,
  Dimensions,
  Platform,
  StatusBar,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../../services/authContext";
import type { DimensionValue, ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { DrawerActions } from "@react-navigation/native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

type RootStackParamList = {
  Guides: undefined;
  Maintenance: undefined;
  TireCheck: undefined;
  SoundDiagnosis: undefined;
  ShopNetwork: undefined;
  Profile: undefined;
};
type Props = NativeStackScreenProps<RootStackParamList, any>;

type Vehicle = {
  _id: string;
  make: string;
  model: string;
  year: number;
  mileage?: number;
  isPrimary?: boolean;
  nickname?: string;
};

const API_BASE = `${(process.env.EXPO_PUBLIC_API_BASE_URL ||
  process.env.EXPO_PUBLIC_API_BASE ||
  "http://localhost:5000")}`.replace(/\/$/, "");

async function fetchMyVehicles(token: string): Promise<Vehicle[]> {
  const r = await fetch(`${API_BASE}/api/vehicles/my`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Vehicles fetch failed: ${r.status}`);
  return r.json();
}
async function setPrimaryVehicle(token: string, id: string) {
  const r = await fetch(`${API_BASE}/api/vehicles/${id}/set-primary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Set primary failed: ${r.status}`);
  return r.json();
}

function computeMetrics(v?: Vehicle) {
  if (!v) {
    return {
      savings: 0, savingsDelta: 0,
      health: 0, healthDelta: 0,
      nextServiceDays: 0, nextServiceDelta: 0,
      issues: 0, issuesDelta: 0,
    };
  }
  const seed = v._id.split("").reduce((a, c) => (a + c.charCodeAt(0)) % 997, 0);
  const rng = (n: number) => ((seed * 71 + n * 19) % 100) / 100;

  const savings = Math.round(160 + rng(1) * 180);
  const savingsDelta = Math.round((rng(2) * 0.25 - 0.12) * 1000) / 10;
  const health = Math.round(72 + rng(3) * 26);
  const healthDelta = Math.round((rng(4) * 0.15 - 0.05) * 1000) / 10;
  const nextServiceDays = Math.max(3, Math.round(6 + rng(5) * 42));
  const nextServiceDelta = Math.round((rng(6) * 0.1 - 0.05) * 1000) / 10;
  const issues = Math.round(rng(7) * 3);
  const issuesDelta = Math.round((rng(8) * 0.1 - 0.05) * 1000) / 10;

  return { savings, savingsDelta, health, healthDelta, nextServiceDays, nextServiceDelta, issues, issuesDelta };
}

const STORAGE_KEY = "dashboard:selectedVehicleId";

export default function DashboardScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false, title: "" });
  }, [navigation]);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const selected = useMemo(
    () =>
      vehicles.find((v) => v._id === selectedId) ||
      vehicles.find((v) => v.isPrimary) ||
      vehicles[0],
    [vehicles, selectedId]
  );
  const metrics = useMemo(() => computeMetrics(selected), [selected]);

  const loadVehicles = useCallback(async () => {
    setLoadingVehicles(true);
    setLoadErr(null);
    try {
      const vs = await fetchMyVehicles(token || "");
      const sorted = [...vs].sort(
        (a, b) => Number(b.isPrimary) - Number(a.isPrimary)
      );
      setVehicles(sorted);

      let stored: string | null = null;
      try { stored = await AsyncStorage.getItem(STORAGE_KEY); } catch {}
      if (stored && sorted.some((v) => v._id === stored)) {
        setSelectedId(stored);
      } else if (sorted[0]) {
        setSelectedId(sorted[0]._id);
      } else {
        setSelectedId(null);
      }
    } catch (e: any) {
      setLoadErr(e?.message ?? "Failed to load vehicles");
      setVehicles([]);
      setSelectedId(null);
    } finally {
      setLoadingVehicles(false);
    }
  }, [token]);

  useEffect(() => { loadVehicles(); }, [loadVehicles]);

  const chooseVehicle = async (id: string, makePrimary: boolean) => {
    setSelectedId(id);
    try { await AsyncStorage.setItem(STORAGE_KEY, id); } catch {}
    if (makePrimary) {
      try {
        await setPrimaryVehicle(token || "", id);
        setVehicles((prev) => prev.map((v) => ({ ...v, isPrimary: v._id === id })));
      } catch {}
    }
    setPickerOpen(false);
  };

  // responsive + measured navbar
  const { width: screenW } = Dimensions.get("window");
  const [navHeight, setNavHeight] = useState(56);

  // For a solid header, Android status bar is NOT translucent.
  // So only use iOS safe-area top inset.
  const TOP_INSET = Platform.OS === "ios" ? insets.top : 0;

  // knobs
  const NAV_CONTENT_OFFSET = 14; // pushes menu/title down inside the header
  const CONTENT_SEP = 20;        // clear separation between header and content

  // grid sizing
  const ovCols = screenW < 600 ? 1 : screenW < 980 ? 2 : 4;
  const ovGap = 12;
  const ovCardW = useMemo(() => {
    if (ovCols === 1) return "100%";
    const container = Math.min(screenW - 32, 1200);
    const theoretical = Math.floor((container - ovGap * (ovCols - 1)) / ovCols);
    return Math.max(220, Math.min(300, theoretical));
  }, [screenW, ovCols]);
  const ovWidth: DimensionValue = typeof ovCardW === "number" ? ovCardW : "100%";
  const ovCardStyle: ViewStyle = { width: ovWidth, height: 140 };

  // drawer opener
  const openDrawer = () => {
    let nav: any = navigation;
    for (let i = 0; i < 4 && nav; i++) {
      if (typeof nav.openDrawer === "function") { nav.openDrawer(); return; }
      nav = nav.getParent?.();
    }
    navigation.dispatch(DrawerActions.openDrawer());
  };

  return (
    <SafeAreaView style={styles.safe} edges={['left','right','bottom']}>
      {/* Solid, opaque status bar & header background */}
      <StatusBar translucent={false} backgroundColor="#ffffff" barStyle="dark-content" />

      {/* Solid white navbar (covers content beneath) */}
      <View
        style={[styles.navbarSolid, { top: 0, paddingTop: TOP_INSET }]}
        onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
      >
        <View style={[styles.navRow, { paddingTop: NAV_CONTENT_OFFSET }]}>
          <Pressable onPress={openDrawer} style={styles.navIconBtn} accessibilityLabel="Open navigation">
            <Feather name="menu" size={20} color="#0f172a" />
          </Pressable>

          <View style={styles.centerWrap} pointerEvents="none">
            <Text style={styles.appName}>CarCare Pro</Text>
          </View>

          <View style={{ width: 40 }} />
        </View>
      </View>

      {/* Content placed fully below the header */}
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: TOP_INSET + navHeight + CONTENT_SEP - NAV_CONTENT_OFFSET },
        ]}
      >
        <View style={[styles.headerRow, { marginBottom: 14 }]}>
          <Text style={styles.sectionHeading}>Overview</Text>

          {loadingVehicles ? (
            <View style={styles.selBox}>
              <ActivityIndicator />
              <Text style={[styles.selSub, { marginTop: 4 }]}>Loading…</Text>
            </View>
          ) : selected ? (
            <Pressable onPress={() => setPickerOpen(true)} style={[styles.selBox, { elevation: 2 }]}>
              <Feather name="clock" size={16} color="#475569" style={{ marginRight: 8 }} />
              <View>
                <Text numberOfLines={1} style={styles.selTitle}>
                  {selected.year} {selected.make} {selected.model}
                </Text>
                <Text numberOfLines={1} style={styles.selSub}>
                  {typeof selected.mileage === "number" ? `${selected.mileage.toLocaleString()} miles` : "—"}
                  {selected.isPrimary ? "  ·  Primary" : ""}
                </Text>
              </View>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => navigation.navigate("Profile")}
              style={styles.addVehicleBtn}
            >
              <Feather name="plus" size={16} color="#111827" style={{ marginRight: 6 }} />
              <Text style={styles.addVehicleText}>Add Vehicle</Text>
            </Pressable>
          )}
        </View>

        {/* Cards */}
        <View style={[styles.ovGrid, { gap: ovGap }]}>
          <View style={[styles.ovCard, ovCardStyle]}>
            <View style={[styles.ovBadge, { backgroundColor: "#E7F5EC", borderColor: "#BBE7CF" }]}>
              <Feather name="dollar-sign" size={20} color="#0F9D58" />
            </View>
            <View style={styles.ovBody}>
              <Text style={styles.ovValue}>${metrics.savings}</Text>
              <Text style={styles.ovLabel}>Monthly Savings</Text>
            </View>
            <Text style={[styles.delta, metrics.savingsDelta >= 0 ? styles.deltaUp : styles.deltaDown]}>
              {metrics.savingsDelta >= 0 ? "↗" : "↘"} {Math.abs(metrics.savingsDelta)}%
            </Text>
          </View>

          <View style={[styles.ovCard, ovCardStyle]}>
            <View style={[styles.ovBadge, { backgroundColor: "#E8F3FB", borderColor: "#CBE5F7" }]}>
              <Feather name="activity" size={20} color="#0B72B9" />
            </View>
            <View style={styles.ovBody}>
              <Text style={styles.ovValue}>{metrics.health}%</Text>
              <Text style={styles.ovLabel}>Vehicle Health</Text>
            </View>
            <Text style={[styles.delta, metrics.healthDelta >= 0 ? styles.deltaUp : styles.deltaDown]}>
              {metrics.healthDelta >= 0 ? "↗" : "↘"} {Math.abs(metrics.healthDelta)}%
            </Text>
          </View>

          <View style={[styles.ovCard, ovCardStyle]}>
            <View style={[styles.ovBadge, { backgroundColor: "#E7FAF7", borderColor: "#BEEBE3" }]}>
              <Feather name="calendar" size={20} color="#10B981" />
            </View>
            <View style={styles.ovBody}>
              <Text style={styles.ovValue}>{metrics.nextServiceDays} days</Text>
              <Text style={styles.ovLabel}>Next Service</Text>
            </View>
            <Text style={[styles.delta, metrics.nextServiceDelta >= 0 ? styles.deltaUp : styles.deltaDown]}>
              {metrics.nextServiceDelta >= 0 ? "↗" : "↘"} {Math.abs(metrics.nextServiceDelta)}%
            </Text>
          </View>

          <View style={[styles.ovCard, ovCardStyle]}>
            <View style={[styles.ovBadge, { backgroundColor: "#FDECEC", borderColor: "#F7C6C6" }]}>
              <Feather name="alert-triangle" size={20} color="#E53935" />
            </View>
            <View style={styles.ovBody}>
              <Text style={styles.ovValue}>{metrics.issues}</Text>
              <Text style={styles.ovLabel}>Active Issues</Text>
            </View >
            <Text style={[styles.delta, metrics.issuesDelta >= 0 ? styles.deltaUp : styles.deltaDown]}>
              {metrics.issuesDelta >= 0 ? "↗" : "↘"} {Math.abs(metrics.issuesDelta)}%
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>© 2024 CarCare Pro. Keep your vehicle running smoothly.</Text>
        </View>
      </ScrollView>

      {/* Vehicle picker */}
      <Modal visible={pickerOpen} animationType="fade" transparent onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Vehicle</Text>
            <FlatList
              data={vehicles}
              keyExtractor={(v) => v._id}
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              renderItem={({ item }) => {
                const active = item._id === selected?._id;
                return (
                  <Pressable
                    style={[styles.vehicleItem, active && styles.vehicleItemActive]}
                    onPress={() => chooseVehicle(item._id, false)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.vehicleName}>
                        {item.nickname ? `${item.nickname} • ` : ""}
                        {item.year} {item.make} {item.model}
                      </Text>
                      <Text style={styles.vehicleSub}>
                        {typeof item.mileage === "number" ? `${item.mileage.toLocaleString()} miles` : "—"}
                        {item.isPrimary ? "  ·  Primary" : ""}
                      </Text>
                    </View>
                    {!item.isPrimary ? (
                      <Pressable onPress={() => chooseVehicle(item._id, true)} style={styles.makePrimaryBtn}>
                        <Text style={styles.makePrimaryText}>Make Primary</Text>
                      </Pressable>
                    ) : null}
                  </Pressable>
                );
              }}
              style={{ marginTop: 10, maxHeight: 360 }}
            />
            <View style={{ alignItems: "flex-end", marginTop: 10 }}>
              <Pressable onPress={() => setPickerOpen(false)} style={styles.btnGhost}>
                <Text style={styles.btnGhostText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#EEF3FA" },

  // Solid white navbar that covers content beneath
  navbarSolid: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: "#ffffff",
    paddingBottom: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(15,23,42,0.08)",
    zIndex: 100,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 2 },
    }),
  },

  navRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 56,
  },

  navIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },

  centerWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  appName: { color: "#0f172a", fontSize: 20, fontWeight: "900", letterSpacing: 0.2 },

  content: {
    paddingHorizontal: 16,
    paddingBottom: 28,
  },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
  },

  sectionHeading: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "900",
  },

  selBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 320,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  selTitle: { color: "#0f172a", fontWeight: "800" },
  selSub: { color: "#6b7280", fontSize: 12 },

  addVehicleBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addVehicleText: { color: "#111827", fontWeight: "800" },

  ovGrid: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginBottom: 16,
  },
  ovCard: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  ovBadge: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1,
  },
  ovBody: { flex: 1 },
  ovValue: { color: "#0f172a", fontWeight: "900", fontSize: 26 },
  ovLabel: { color: "#6b7280", marginTop: 4 },
  delta: { fontWeight: "800" },
  deltaUp: { color: "#10b981" },
  deltaDown: { color: "#ef4444" },

  footer: { marginTop: 10, paddingVertical: 18, alignItems: "center" },
  footerText: { color: "#94a3b8", fontSize: 12, textAlign: "center" },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: "#FFFFFF",
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  modalTitle: { color: "#0F172A", fontSize: 18, fontWeight: "900" },
  vehicleItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f8fafc",
  },
  vehicleItemActive: {
    borderColor: "#93c5fd",
    backgroundColor: "#eff6ff",
  },
  vehicleName: { color: "#0f172a", fontWeight: "800" },
  vehicleSub: { color: "#6b7280", marginTop: 2 },
  makePrimaryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#ffffff",
  },
  makePrimaryText: { color: "#111827", fontWeight: "700" },

  btnGhost: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  btnGhostText: { color: "#1f2937", fontWeight: "700" },
});
