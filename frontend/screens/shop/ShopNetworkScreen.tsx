// ShopsScreen.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
  Platform,
} from "react-native";

// Optional deps: DocumentPicker + Location.
// If not installed, features are hidden but the screen still works.
let DocumentPicker: any = null;
let Location: any = null;
try {
  DocumentPicker = require("expo-document-picker");
} catch {}
try {
  Location = require("expo-location");
} catch {}

/** ===== Types ===== */
type Shop = {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  services?: string[]; // ["brakes","tires","fluids","general"]
  rating?: number;     // 0..5
  distanceKm?: number; // if location available
  isFavorite?: boolean;
  etaHrs?: number;     // typical turnaround
};

type QuoteLine = { id: string; description: string; qty: number; unitPrice: number };
type QuoteCompareResult = {
  totalEntered: number;
  fairTotal: { min: number; max: number };
  flags: string[];
  suggestedShops: { shopId: string; estimated: number }[];
  notes?: string;
};

type QuoteRequestResponse = { ok: true; requestedFrom: number };

/** ===== Config ===== */
const API_BASE = process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, "") || "https://your-api.example.com";
const authToken = () => "__INJECT_YOUR_JWT_HERE__";

/** ===== API helpers (map to your backend) ===== */
async function fetchShops(token: string, service?: string): Promise<Shop[]> {
  const url = new URL(`${API_BASE}/shops/nearby`);
  if (service) url.searchParams.set("service", service);
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Shops load failed: ${r.status}`);
  return r.json();
}

async function toggleFavoriteShop(token: string, shopId: string): Promise<{ ok: true; isFavorite: boolean }> {
  const r = await fetch(`${API_BASE}/shops/${shopId}/favorite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Favorite toggle failed: ${r.status}`);
  return r.json();
}

async function compareQuote(
  token: string,
  lines: QuoteLine[],
  attach?: { uri: string; name: string; mime?: string }
): Promise<QuoteCompareResult> {
  if (attach?.uri && attach?.name) {
    const form = new FormData();
    form.append("lines", JSON.stringify(lines));
    // @ts-ignore RN file
    form.append("attachment", { uri: attach.uri, name: attach.name, type: attach.mime || "application/octet-stream" });
    const r = await fetch(`${API_BASE}/shops/quote/compare`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!r.ok) throw new Error(`Compare failed: ${r.status}`);
    return r.json();
  }
  const r = await fetch(`${API_BASE}/shops/quote/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lines }),
  });
  if (!r.ok) throw new Error(`Compare failed: ${r.status}`);
  return r.json();
}

async function requestQuotesFromShops(
  token: string,
  shopIds: string[],
  payload: { notes?: string; lines: QuoteLine[] }
): Promise<QuoteRequestResponse> {
  const r = await fetch(`${API_BASE}/shops/quote/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ shopIds, ...payload }),
  });
  if (!r.ok) throw new Error(`Request quotes failed: ${r.status}`);
  return r.json();
}

/** ===== Utils ===== */
const money = (n?: number) => (typeof n === "number" ? `\$${n.toFixed(0)}` : "—");
const shortId = () => Math.random().toString(36).slice(2, 9);

/** ===== Main Screen ===== */
export default function ShopsScreen() {
  const token = authToken();

  // Shops & filters
  const [serviceFilter, setServiceFilter] = useState<"all" | "brakes" | "tires" | "fluids" | "general">("all");
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortByDistance, setSortByDistance] = useState(true);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);

  // Quote compare
  const [qcLines, setQcLines] = useState<QuoteLine[]>([{ id: shortId(), description: "", qty: 1, unitPrice: 0 }]);
  const [qcAttach, setQcAttach] = useState<{ uri: string; name: string; mime?: string } | null>(null);
  const [qcBusy, setQcBusy] = useState(false);
  const [qcResult, setQcResult] = useState<QuoteCompareResult | null>(null);
  const [qcNotes, setQcNotes] = useState("");

  // Shop multi-select for requests
  const [selectedShopIds, setSelectedShopIds] = useState<string[]>([]);

  // const loadShops = useCallback(async () => {
  //   setLoading(true);
  //   try {
  //     const svc = serviceFilter === "all" ? undefined : serviceFilter;
  //     const data = await fetchShops(token, svc);
  //     let list = data;

  //     // Optional: distance augmentation if you enabled expo-location
  //     if (Location && sortByDistance) {
  //       try {
  //         const { status } = await Location.requestForegroundPermissionsAsync();
  //         if (status === "granted") {
  //           const loc = await Location.getCurrentPositionAsync({});
  //           setCoords({ lat: loc.coords.latitude, lon: loc.coords.longitude });
  //         }
  //       } catch {}
  //     }

  //     // Sort: favorites first, then rating desc, then distance if present
  //     list = [...list].sort((a, b) => {
  //       const fav = Number(!!b.isFavorite) - Number(!!a.isFavorite);
  //       if (fav !== 0) return fav;
  //       const rt = (b.rating || 0) - (a.rating || 0);
  //       if (rt !== 0) return rt;
  //       return (a.distanceKm || Infinity) - (b.distanceKm || Infinity);
  //     });

  //     setShops(list);
  //   } catch (e: any) {
  //     Alert.alert("Load error", e?.message ?? "Failed to load shops");
  //     setShops([]);
  //   } finally {
  //     setLoading(false);
  //   }
  // }, [token, serviceFilter, sortByDistance]);

  const [loadErr, setLoadErr] = useState<string | null>(null);

  const loadShops = useCallback(async () => {
  setLoading(true);
  setLoadErr(null); // reset any prior inline error

  try {
    const svc = serviceFilter === "all" ? undefined : serviceFilter;
    const data = await fetchShops(token, svc);
    let list = data;

    // Optional: distance augmentation if expo-location is installed/enabled
    if (Location && sortByDistance) {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({});
          setCoords({ lat: loc.coords.latitude, lon: loc.coords.longitude });
        }
      } catch (locErr) {
        console.warn("Location fetch failed:", locErr);
        // do not alert; distance is optional
      }
    }

    // Sort: favorites first, then rating desc, then distance if present
    list = [...list].sort((a, b) => {
      const fav = Number(!!b.isFavorite) - Number(!!a.isFavorite);
      if (fav !== 0) return fav;
      const rt = (b.rating || 0) - (a.rating || 0);
      if (rt !== 0) return rt;
      return (a.distanceKm || Infinity) - (b.distanceKm || Infinity);
    });

    setShops(list);
  } catch (e: any) {
    console.warn("Shops load error:", e?.message ?? e);
    // No popup for background/auto loads; keep old list so UI doesn't flash empty
    setLoadErr(e?.message ?? "Could not load shops");
    // setShops([]); // ← leave commented to keep any prior list
  } finally {
    setLoading(false);
  }
}, [token, serviceFilter, sortByDistance]);


  useEffect(() => {
    loadShops();
  }, [loadShops]);

  const toggleFavorite = async (id: string) => {
    try {
      const res = await toggleFavoriteShop(token, id);
      setShops((prev) => prev.map((s) => (s.id === id ? { ...s, isFavorite: res.isFavorite } : s)));
    } catch (e: any) {
      Alert.alert("Favorite error", e?.message ?? "Could not update favorite");
    }
  };

  const setLine = (id: string, patch: Partial<QuoteLine>) =>
    setQcLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => setQcLines((prev) => [...prev, { id: shortId(), description: "", qty: 1, unitPrice: 0 }]);
  const rmLine = (id: string) => setQcLines((prev) => prev.filter((l) => l.id !== id));

  const pickAttachment = async () => {
    if (!DocumentPicker) {
      Alert.alert("Attachment disabled", "Install 'expo-document-picker' to attach files.");
      return;
    }
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "image/*"],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.type === "success") {
        setQcAttach({ uri: res.uri, name: res.name ?? `quote-${Date.now()}`, mime: res.mimeType });
      }
    } catch (e: any) {
      Alert.alert("Pick error", e?.message ?? "Could not pick a file");
    }
  };

  const doCompare = async () => {
    setQcBusy(true);
    setQcResult(null);
    try {
      const res = await compareQuote(token, qcLines, qcAttach || undefined);
      setQcResult(res);
    } catch (e: any) {
      Alert.alert("Compare failed", e?.message ?? "Could not compare quote");
    } finally {
      setQcBusy(false);
    }
  };

  const toggleSelectShop = (id: string) =>
    setSelectedShopIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const sendRequests = async () => {
    if (!selectedShopIds.length) {
      Alert.alert("Pick shops", "Select at least one shop to request a quote.");
      return;
    }
    try {
      const payload = { notes: qcNotes || undefined, lines: qcLines };
      const res = await requestQuotesFromShops(token, selectedShopIds, payload);
      Alert.alert("Requested", `Quote requests sent to ${res.requestedFrom} shop(s).`);
      setSelectedShopIds([]);
    } catch (e: any) {
      Alert.alert("Request failed", e?.message ?? "Could not send requests");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      {loading ? (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" />
          <Text style={styles.muted}>Loading shops…</Text>
        </View>
      ) : (
        <FlatList
          data={shops}
          keyExtractor={(s) => s.id}
          ListHeaderComponent={
            <View style={{ gap: 10, marginBottom: 6 }}>
              <Text style={styles.pageTitle}>Shops</Text>
              <Text style={styles.muted}>
                Find nearby mechanics, compare quotes, and request estimates in one place.
              </Text>

              {/* Filter & Sort */}
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {(["all", "brakes", "tires", "fluids", "general"] as const).map((tag) => {
                  const active = serviceFilter === tag;
                  return (
                    <Pressable key={tag} onPress={() => setServiceFilter(tag)} style={[styles.chip, active && styles.chipActive]}>
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{tag.toUpperCase()}</Text>
                    </Pressable>
                  );
                })}
                <View style={[styles.row, { alignItems: "center" }]}>
                  <Switch value={sortByDistance} onValueChange={setSortByDistance} />
                  <Text style={styles.mutedSmall}>Sort by distance</Text>
                </View>
              </View>

              {/* Quote Compare card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Quote Compare</Text>
                {qcLines.map((ln) => (
                  <View key={ln.id} style={[styles.row, { gap: 8, marginBottom: 8, flexWrap: "wrap" }]}>
                    <TextInput
                      value={ln.description}
                      onChangeText={(t) => setLine(ln.id, { description: t })}
                      placeholder="Item (e.g., Front brake pads & rotors)"
                      placeholderTextColor="#9CA3AF"
                      style={[styles.input, { flex: 1, minWidth: 220 }]}
                    />
                    <TextInput
                      value={String(ln.qty ?? 1)}
                      onChangeText={(t) => setLine(ln.id, { qty: Number(t) || 1 })}
                      keyboardType="numeric"
                      placeholder="Qty"
                      placeholderTextColor="#9CA3AF"
                      style={[styles.input, { width: 80 }]}
                    />
                    <TextInput
                      value={String(ln.unitPrice ?? 0)}
                      onChangeText={(t) => setLine(ln.id, { unitPrice: Number(t) || 0 })}
                      keyboardType="numeric"
                      placeholder="Unit $"
                      placeholderTextColor="#9CA3AF"
                      style={[styles.input, { width: 120 }]}
                    />
                    <Pressable style={styles.btnGhost} onPress={() => rmLine(ln.id)}>
                      <Text style={styles.btnGhostText}>Remove</Text>
                    </Pressable>
                  </View>
                ))}
                <View style={[styles.row, { gap: 8, flexWrap: "wrap" }]}>
                  <Pressable style={styles.btnSecondary} onPress={addLine}>
                    <Text style={styles.btnSecondaryText}>+ Add Line</Text>
                  </Pressable>

                  <Pressable
                    style={[styles.btnSecondary, !DocumentPicker && { opacity: 0.6 }]}
                    onPress={pickAttachment}
                    disabled={!DocumentPicker}
                  >
                    <Text style={styles.btnSecondaryText}>{qcAttach ? "Change Attachment" : "Attach Quote (PDF/JPG)"}</Text>
                  </Pressable>
                  <Text style={styles.mutedSmall}>{qcAttach?.name || (!DocumentPicker ? "Install expo-document-picker to enable attachments" : "No file selected")}</Text>
                </View>

                <View style={[styles.row, { gap: 8, marginTop: 8, flexWrap: "wrap" }]}>
                  <Pressable style={styles.btnPrimary} onPress={doCompare} disabled={qcBusy}>
                    <Text style={styles.btnPrimaryText}>{qcBusy ? "Comparing…" : "Compare Quote"}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.btnGhost}
                    onPress={() => {
                      setQcResult(null);
                      setQcLines([{ id: shortId(), description: "", qty: 1, unitPrice: 0 }]);
                      setQcAttach(null);
                    }}
                  >
                    <Text style={styles.btnGhostText}>Clear</Text>
                  </Pressable>
                </View>

                {qcResult ? (
                  <View style={[styles.card, { marginTop: 10 }]}>
                    <Text style={styles.cardTitle}>Comparison Result</Text>
                    <Text style={styles.mutedSmall}>
                      Entered: {money(qcResult.totalEntered)} | Fair: {money(qcResult.fairTotal.min)}–{money(qcResult.fairTotal.max)}
                    </Text>
                    {!!qcResult.flags?.length && (
                      <>
                        <Text style={styles.sectionTitle}>Flags</Text>
                        {qcResult.flags.map((f, i) => (
                          <View key={`flag-${i}`} style={styles.bullet}>
                            <Text style={styles.bulletDot}>•</Text>
                            <Text style={styles.bulletText}>{f}</Text>
                          </View>
                        ))}
                      </>
                    )}
                    {!!qcResult.suggestedShops?.length && (
                      <>
                        <Text style={styles.sectionTitle}>Suggested Shops</Text>
                        {qcResult.suggestedShops.map((ss, i) => {
                          const s = shops.find((x) => x.id === ss.shopId);
                          return (
                            <View key={`sug-${i}`} style={styles.bullet}>
                              <Text style={styles.bulletDot}>•</Text>
                              <Text style={styles.bulletText}>{s?.name || ss.shopId} — est. {money(ss.estimated)}</Text>
                            </View>
                          );
                        })}
                      </>
                    )}
                    {qcResult.notes ? <Text style={styles.mutedSmall}>{qcResult.notes}</Text> : null}
                  </View>
                ) : null}

                {/* Request quotes from selected shops */}
                <Text style={[styles.sectionTitle, { marginTop: 10 }]}>Request Quotes</Text>
                <Text style={styles.mutedSmall}>Select shops below, add notes, then send.</Text>
                <TextInput
                  value={qcNotes}
                  onChangeText={setQcNotes}
                  placeholder="Notes for shops (car, VIN/plate, symptoms, preferred times)…"
                  placeholderTextColor="#9CA3AF"
                  style={[styles.input, { marginTop: 6 }]}
                  multiline
                />
                <Pressable style={[styles.btnSecondary, { marginTop: 8 }]} onPress={sendRequests}>
                  <Text style={styles.btnSecondaryText}>Send Requests to Selected</Text>
                </Pressable>
              </View>
            </View>
          }
          renderItem={({ item }) => {
            const selected = selectedShopIds.includes(item.id);
            return (
              <View style={styles.card}>
                <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <Pressable style={styles.badge} onPress={() => toggleFavorite(item.id)}>
                    <Text style={{ color: item.isFavorite ? "#2563EB" : "#9CA3AF", fontWeight: "800" }}>
                      {item.isFavorite ? "★ Favorite" : "☆ Favorite"}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.mutedSmall}>
                  {item.services?.length ? item.services.join(" • ") : "General services"}
                  {typeof item.rating === "number" ? ` • ${item.rating.toFixed(1)}★` : ""}
                  {typeof item.distanceKm === "number" ? ` • ${item.distanceKm.toFixed(1)} km` : ""}
                  {typeof item.etaHrs === "number" ? ` • ETA ~${item.etaHrs}h` : ""}
                </Text>
                {!!item.address && <Text style={[styles.muted, { marginTop: 4 }]}>{item.address}</Text>}
                {!!item.phone && <Text style={styles.mutedSmall}>☎ {item.phone}</Text>}

                <View style={[styles.row, { gap: 8, marginTop: 10, flexWrap: "wrap" }]}>
                  <Pressable
                    style={[styles.btnSecondary, selected && { borderColor: "#2563EB", backgroundColor: "#DBEAFE" }]}
                    onPress={() => toggleSelectShop(item.id)}
                  >
                    <Text style={styles.btnSecondaryText}>{selected ? "Selected" : "Select for Request"}</Text>
                  </Pressable>
                  <Pressable style={styles.btnGhost} onPress={() => Alert.alert("Call", item.phone || "No number")}>
                    <Text style={styles.btnGhostText}>Call</Text>
                  </Pressable>
                  <Pressable style={styles.btnGhost} onPress={() => Alert.alert("Directions", item.address || "No address")}>
                    <Text style={styles.btnGhostText}>Directions</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", padding: 24 }}>
              <Text style={styles.muted}>No shops found for this filter.</Text>
            </View>
          }
          contentContainerStyle={styles.pad}
        />
      )}
    </SafeAreaView>
  );
}

/** ===== Styles (Light Theme) ===== */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7FAFC" },
  pad: { padding: 16, paddingBottom: 64 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },

  sectionTitle: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 10,
    marginBottom: 6,
  },
  bullet: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    marginBottom: 6,
  },
  bulletDot: {
    color: "#2563EB",
    fontSize: 18,
    lineHeight: 18,
    marginTop: -2,
  },
  bulletText: {
    color: "#374151",
    flex: 1,
  },

  pageTitle: { color: "#0F172A", fontSize: 22, fontWeight: "800" },
  muted: { color: "#6B7280" },
  mutedSmall: { color: "#6B7280", fontSize: 12 },

  row: { flexDirection: "row", gap: 8 },

  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
  },
  chipActive: { borderColor: "#2563EB", backgroundColor: "#DBEAFE" },
  chipText: { color: "#374151", fontWeight: "700" },
  chipTextActive: { color: "#1D4ED8", fontWeight: "800" },

  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginTop: 12,
  },
  cardTitle: { color: "#111827", fontSize: 16, fontWeight: "700" },

  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    color: "#111827",
  },

  btnPrimary: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  btnPrimaryText: { color: "#FFFFFF", fontWeight: "800" },

  btnSecondary: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  btnSecondaryText: { color: "#111827", fontWeight: "700" },

  btnGhost: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  btnGhostText: { color: "#374151", fontWeight: "700" },

  badge: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
});
