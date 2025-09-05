import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Platform,
  Dimensions,
  ScrollView,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "../../services/authContext";
import { API_BASE_URL } from "../../services/api";

/* ================= Types (unchanged) ================= */
type TpcMode = "tires" | "parts";

type TpcResult =
  | {
      type: "tires";
      overallCondition: "good" | "fair" | "poor";
      treadDepthMm?: number;
      unevenWear?: string[];
      ageEstimateMonths?: number;
      confidence: number;
      recommendations: string[];
    }
  | {
      type: "parts";
      partClass: "brake_pads" | "belts" | "filters" | "rotors" | "hoses" | "other";
      wearLevel: "low" | "medium" | "high";
      visibleIssues?: string[];
      confidence: number;
      recommendations: string[];
    };

type UsedVehicleEcho = { name?: string | null; make?: string | null; model?: string | null } | null;

type TpcApiResponse = {
  summary: string;
  results: TpcResult[];
  warnings?: string[];
  usedVehicle?: UsedVehicleEcho;
};

type TpcPicked = {
  id: string;
  uri: string;
  filename: string;
  mime: string;
};

type TpcRemote = {
  id: string;
  url: string;
  publicId?: string;
};

type TpcVehicle = {
  _id: string;
  name?: string;
  make?: string;
  model?: string;
  year?: number;
  mileage?: number;
  mileageUnit?: "km" | "mi";
};

/* ================= Config (unchanged) ================= */
const TPC_API_BASE = `${API_BASE_URL}/api`;
const TPC_STORE_KEY = "@tpc_uploaded_urls_v1";

/* ================= API helpers (unchanged) ================= */
async function tpcFetchVehicles(token: string): Promise<TpcVehicle[]> {
  const r = await fetch(`${TPC_API_BASE}/vehicles/my`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  const raw = await r.json();
  return (raw || []).map((v: any) => ({
    _id: String(v._id),
    name: v.name ?? v.nickname ?? undefined,
    make: v.make ?? undefined,
    model: v.model ?? undefined,
    year: typeof v.year === "number" ? v.year : Number(v.year) || undefined,
    mileage: typeof v.mileage === "number" ? v.mileage : Number(v.mileage) || undefined,
    mileageUnit: v.mileageUnit === "mi" ? "mi" : v.mileageUnit === "km" ? "km" : undefined,
  }));
}

async function tpcUploadToCloudinary(token: string | null, files: TpcPicked[]): Promise<TpcRemote[]> {
  const form = new FormData();
  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    if (Platform.OS === "web") {
      const resp = await fetch(f.uri);
      const blob = await resp.blob();
      form.append("files", blob, f.filename || `part_${idx}.jpg`);
    } else {
      const rnFile = { uri: f.uri, name: f.filename || `part_${idx}.jpg`, type: f.mime || "image/jpeg" };
      form.append("files", rnFile as any);
    }
  }

  const resp = await fetch(`${TPC_API_BASE}/uploads/images`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form as any,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Upload failed ${resp.status}: ${text || "no body"}`);
  }
  const data = await resp.json();
  if (!data?.success) throw new Error(`Upload error: ${JSON.stringify(data)}`);

  const items: { url: string; public_id?: string }[] = data.items || [];
  const urls: string[] = data.urls || [];
  if (items.length) return items.map((it) => ({ id: tpcShortId(), url: it.url, publicId: it.public_id }));
  if (urls.length) return urls.map((u) => ({ id: tpcShortId(), url: u }));
  throw new Error("Upload succeeded but server returned no URLs.");
}

async function tpcAnalyzeGemini(
  token: string,
  urls: string[],
  mode: TpcMode,
  vehicle: TpcVehicle | null,
  systemPrompt: string,
  notes?: string
): Promise<TpcApiResponse> {
  const body = {
    partType: mode === "tires" ? "tire" : "parts",
    imageUrls: urls,
    userNotes: notes || "",
    vehicle,
    systemPrompt,
  };

  const r = await fetch(`${TPC_API_BASE}/inspections/gemini`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    try {
      const j = await r.json();
      let msg = j?.message || `Analysis failed (${r.status})`;
      if (Array.isArray(j?.rejected) && j.rejected.length) {
        const lines = j.rejected.map((it: any) => `#${it.index} — ${it.reason || "not relevant"}`);
        msg += `\n\nIgnored photos:\n${lines.join("\n")}`;
      }
      const err = new Error(msg) as any;
      err.code = j?.code || String(r.status);
      err.rejected = j?.rejected;
      throw err;
    } catch {
      const t = await r.text().catch(() => "");
      throw new Error(t ? `Analysis failed: ${t}` : `Analysis failed (${r.status})`);
    }
  }

  const j = await r.json();
  const g = j?.inspection?.geminiResponse || j?.geminiResponse || j;
  const norm = normalizeGeminiToTpc(g, mode);
  if (j?.vehicleUsed !== undefined) (norm as any).usedVehicle = j.vehicleUsed as UsedVehicleEcho;
  return norm;
}

/* ================= Utils (unchanged) ================= */
function mapRiskToCondition(riskInput: unknown): "good" | "fair" | "poor" {
  const risk = typeof riskInput === "string" ? riskInput.toLowerCase() : "medium";
  if (risk === "low") return "good";
  if (risk === "high") return "poor";
  return "fair";
}
function mapRiskToWear(riskInput: unknown): "low" | "medium" | "high" {
  const risk = typeof riskInput === "string" ? riskInput.toLowerCase() : "medium";
  return risk === "low" || risk === "medium" || risk === "high" ? risk : "medium";
}
function normalizeGeminiToTpc(g: any, mode: TpcMode): TpcApiResponse {
  const summary: string = typeof g?.overall_assessment === "string" ? g.overall_assessment : "Inspection completed.";
  const risk: string = typeof g?.risk_level === "string" ? g.risk_level : "medium";
  const per: any[] = Array.isArray(g?.per_image_findings) ? g.per_image_findings : [];
  const issues: string[] = [];
  for (const p of per) if (Array.isArray(p?.issues)) issues.push(...p.issues);

  if (mode === "tires") {
    return {
      summary,
      results: [
        {
          type: "tires",
          overallCondition: mapRiskToCondition(risk),
          confidence: typeof g?.confidence === "number" ? g.confidence : 0.75,
          recommendations: Array.isArray(g?.recommendations) ? g.recommendations : [],
          unevenWear: issues.length ? issues : undefined,
        },
      ],
      warnings: [],
    };
  }
  return {
    summary,
    results: [
      {
        type: "parts",
        partClass: "other",
        wearLevel: mapRiskToWear(risk),
        visibleIssues: issues.length ? issues : undefined,
        confidence: typeof g?.confidence === "number" ? g.confidence : 0.75,
        recommendations: Array.isArray(g?.recommendations) ? g.recommendations : [],
      },
    ],
    warnings: [],
  };
}
function tpcPrettyPct(n: number | undefined) {
  if (typeof n !== "number") return "—";
  return `${Math.round(n * 100)}%`;
}
function tpcColorByCondition(c?: string) {
  switch (c) {
    case "good":
    case "low":
      return "#16A34A";
    case "fair":
    case "medium":
      return "#F59E0B";
    case "poor":
    case "high":
      return "#DC2626";
    default:
      return "#6B7280";
  }
}
function tpcShortId() {
  return Math.random().toString(36).slice(2, 9);
}

/* ================= Prompt builder (unchanged) ================= */
function buildSystemPrompt(vehicle: TpcVehicle | null, mode: TpcMode) {
  if (!vehicle) {
    return `
You are an AI vehicle inspection assistant. Analyze the provided photos and return ONLY JSON (no prose).

Inspection focus mode: ${mode.toUpperCase()}.

Rules:
- If something is not visible, mark it as "unclear" and DO NOT guess.
- Prefer short, actionable findings.
- Output valid JSON only.

If mode = "tires", check tread depth (estimate mm if visible), uneven wear, cracks/bulges/dry-rot/sidewall damage, age indicators (DOT if visible), and overall tyre condition.

If mode = "parts", check brakes/lights/mirrors/windshield/bumper/body/rust/leaks/belts/hoses as visible.

Schema:
{ ... }`.trim();
  }

  const v: Partial<TpcVehicle> = vehicle;
  const mileageText =
    typeof v.mileage === "number" ? `${v.mileage} ${v.mileageUnit || "km"}` : "unknown mileage";
  const title = [v.year, v.make, v.model].filter(Boolean).join(" ") || v.name || "Unknown Vehicle";

  return `
You are an AI vehicle inspection assistant. Analyze the provided photos for the selected vehicle and return ONLY JSON (no prose).

Vehicle context:
- Title: ${title}
- Make: ${v.make ?? "unknown"}
- Model: ${v.model ?? "unknown"}
- Year: ${typeof v.year === "number" ? v.year : "unknown"}
- Mileage: ${mileageText}

Inspection focus mode: ${mode.toUpperCase()}.

Rules:
- Use the vehicle context to calibrate expectations.
- If something is not visible, mark it as "unclear" and DO NOT guess.
- Prefer short, actionable findings.
- Output valid JSON only.

If mode = "tires", check tread depth, uneven wear, cracks/bulges/dry-rot/sidewall damage, age indicators (DOT), and overall condition.

If mode = "parts", check brakes/lights/mirrors/windshield/bumper/rust/leaks/belts/hoses as visible.

Schema:
{ ... }`.trim();
}

/* ================= Main Screen ================= */
export default function TirePartCheckScreen() {
  const { ready: authReady, authed, token } = useAuth();
  const [tpcVehicles, setTpcVehicles] = useState<TpcVehicle[]>([]);
  const [tpcVehicleId, setTpcVehicleId] = useState<string | undefined>(undefined);
  const selectedVehicle = useMemo(
    () => tpcVehicles.find((v) => v._id === tpcVehicleId) || null,
    [tpcVehicles, tpcVehicleId]
  );

  const [tpcMode, setTpcMode] = useState<TpcMode>("tires");
  const [tpcNotes, setTpcNotes] = useState("");
  const [tpcRemotes, setTpcRemotes] = useState<TpcRemote[]>([]);
  const [tpcBusy, setTpcBusy] = useState(false);
  const [tpcResp, setTpcResp] = useState<TpcApiResponse | null>(null);

  // screen width for responsive thumbnails
  const screenW = Dimensions.get("window").width;

  /* ------ init ------ */
  useEffect(() => {
    (async () => {
      try { await ImagePicker.requestCameraPermissionsAsync(); } catch {}

      try {
        if (token) {
          const vehicles = await tpcFetchVehicles(token);
          setTpcVehicles(vehicles);
          if (vehicles.length) setTpcVehicleId(vehicles[0]._id);
        }
      } catch {}

      try {
        const raw = await AsyncStorage.getItem(TPC_STORE_KEY);
        if (raw) {
          const urls: string[] = JSON.parse(raw);
          setTpcRemotes(urls.map((u) => ({ id: tpcShortId(), url: u })));
        }
      } catch {}
    })();
  }, [token]);

  const persistRemoteUrls = useCallback(async (remotes: TpcRemote[]) => {
    const urls = remotes.map((r) => r.url);
    await AsyncStorage.setItem(TPC_STORE_KEY, JSON.stringify(urls));
  }, []);

  /* ------ media pick/capture ------ */
  const tpcPickFromLibrary = useCallback(async () => {
    try {
      const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libPerm.granted) {
        Alert.alert("Permission required", "Allow photo library access to pick images.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: 6,
        quality: 0.85,
      });
      if (!res.canceled) {
        const picked: TpcPicked[] = res.assets.map((a, idx) => ({
          id: tpcShortId(),
          uri: a.uri,
          filename: (a as any).fileName || `tpc-${Date.now()}-${idx}.jpg`,
          mime: a.mimeType || "image/jpeg",
        }));
        setTpcBusy(true);
        try {
          const remotes = await tpcUploadToCloudinary(token, picked);
          const next = [...tpcRemotes, ...remotes].slice(0, 20);
          setTpcRemotes(next);
          await persistRemoteUrls(next);
          setTpcResp(null);
        } finally {
          setTpcBusy(false);
        }
      }
    } catch (e: any) {
      Alert.alert("Picker/Upload error", e?.message ?? "Could not pick/upload images.");
    }
  }, [tpcRemotes, persistRemoteUrls, token]);

  const tpcCapturePhoto = useCallback(async () => {
    try {
      const camPerm = await ImagePicker.requestCameraPermissionsAsync();
      if (!camPerm.granted) {
        Alert.alert("Permission required", "Camera access is needed to take photos.");
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 0.85, allowsEditing: false });
      if (!res.canceled) {
        const a = res.assets[0];
        const picked: TpcPicked = {
          id: tpcShortId(),
          uri: a.uri,
          filename: (a as any).fileName || `tpc-${Date.now()}.jpg`,
          mime: a.mimeType || "image/jpeg",
        };
        setTpcBusy(true);
        try {
          const remotes = await tpcUploadToCloudinary(token, [picked]);
          const next = [...tpcRemotes, ...remotes].slice(0, 20);
          setTpcRemotes(next);
          await persistRemoteUrls(next);
          setTpcResp(null);
        } finally {
          setTpcBusy(false);
        }
      }
    } catch (e: any) {
      Alert.alert("Camera/Upload error", e?.message ?? "Could not capture/upload photo.");
    }
  }, [tpcRemotes, persistRemoteUrls, token]);

  const tpcRemoveRemote = useCallback(
    async (id: string) => {
      const next = tpcRemotes.filter((r) => r.id !== id);
      setTpcRemotes(next);
      await persistRemoteUrls(next);
    },
    [tpcRemotes, persistRemoteUrls]
  );

  /* ------ submit ------ */
  const tpcSubmit = useCallback(async () => {
    if (!token) {
      Alert.alert("Login required", "Please sign in to analyze photos.");
      return;
    }
    if (!tpcRemotes.length) {
      Alert.alert("No images", "Upload at least one photo to analyze.");
      return;
    }

    setTpcBusy(true);
    try {
      const urls = tpcRemotes.map((r) => r.url);
      const systemPrompt = buildSystemPrompt(selectedVehicle, tpcMode);
      const res = await tpcAnalyzeGemini(token, urls, tpcMode, selectedVehicle, systemPrompt, tpcNotes.trim() || undefined);
      setTpcResp(res);
    } catch (e: any) {
      Alert.alert("Analysis failed", e?.message ?? "Could not analyze images.");
    } finally {
      setTpcBusy(false);
    }
  }, [token, tpcRemotes, tpcMode, tpcNotes, selectedVehicle]);

  /* ------ derived text ------ */
  const tpcHeaderHint = useMemo(
    () =>
      tpcMode === "tires"
        ? "Upload tire photos for AI-powered tread depth and wear pattern analysis"
        : "Upload photos of brake pads, filters, belts, and other components",
    [tpcMode]
  );

  const vehicleLabel = useMemo(() => {
    if (!selectedVehicle) return "";
    const bits = [selectedVehicle.year, selectedVehicle.make, selectedVehicle.model].filter(Boolean);
    const mil =
      typeof selectedVehicle.mileage === "number"
        ? ` • ${selectedVehicle.mileage.toLocaleString()} ${selectedVehicle.mileageUnit || "km"}`
        : "";
    return `${bits.join(" ")}${mil}`;
  }, [selectedVehicle]);

  /* ------ UI helpers ------ */
  const renderVehicleChips = () =>
    tpcVehicles.length ? (
      <FlatList
        data={[{ _id: "__none__", name: "No vehicle" } as TpcVehicle, ...tpcVehicles]}
        horizontal
        keyExtractor={(i) => i._id}
        contentContainerStyle={{ gap: 8 }}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => {
          const label =
            item._id === "__none__"
              ? "No vehicle"
              : [item.year, item.make, item.model].filter(Boolean).join(" ") || item.name || "Vehicle";
          const active =
            (item._id === "__none__" && !tpcVehicleId) ||
            (tpcVehicleId === item._id && item._id !== "__none__");
          return (
            <Pressable
              onPress={() => {
                if (item._id === "__none__") setTpcVehicleId(undefined);
                else if (tpcVehicleId === item._id) setTpcVehicleId(undefined);
                else setTpcVehicleId(item._id);
              }}
              style={[styles.tpcChip, active && styles.tpcChipActive]}
            >
              <Text style={[styles.tpcChipText, active && styles.tpcChipTextActive]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        }}
        style={{ marginTop: 6, marginBottom: 8 }}
      />
    ) : null;

  /** preview thumbs per row (inside uploader) */
  const thumbSize = screenW >= 900 ? 84 : screenW >= 600 ? 80 : 72;

  const Uploader = () => (
    <View style={styles.uploadBox}>
      {/* icon + hint */}
      <Feather name="camera" size={36} color="#64748b" style={{ alignSelf: "center" }} />
      <Text style={[styles.tpcMuted, { textAlign: "center", marginTop: 8 }]}>
        {tpcMode === "tires"
          ? "Take clear photos of each tire’s tread surface"
          : "Snap photos of parts that need inspection"}
      </Text>

      {/* actions */}
      <View style={{ marginTop: 12, width: "100%", alignItems: "center" }}>
        <Pressable style={[styles.btnWide, styles.btnPrimary]} onPress={tpcPickFromLibrary}>
          <Feather name="upload" size={16} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.btnPrimaryText}>
            {tpcMode === "tires" ? "Upload Tire Photos" : "Upload Part Photos"}
          </Text>
        </Pressable>

        <Pressable style={[styles.btnWide, styles.btnSecondary, { marginTop: 8 }]} onPress={tpcCapturePhoto}>
          <Feather name="image" size={16} color="#0f2940" style={{ marginRight: 8 }} />
          <Text style={styles.btnSecondaryText}>Take Photos</Text>
        </Pressable>
      </View>

      {/* inline previews */}
      <View style={[styles.previewWrap, { marginTop: 12 }]}>
        {tpcRemotes.length ? (
          <View style={styles.previewGrid}>
            {tpcRemotes.map((it) => (
              <View key={it.id} style={[styles.thumb, { width: thumbSize, height: thumbSize }]}>
                <Image source={{ uri: it.url }} style={{ width: "100%", height: "100%" }} />
                <Pressable style={styles.thumbX} onPress={() => tpcRemoveRemote(it.id)}>
                  <Text style={{ color: "#fff", fontWeight: "800" }}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={[styles.tpcMutedSmall, { textAlign: "center" }]}>No photos yet.</Text>
        )}
      </View>
    </View>
  );

  const NotesCard = () => (
    <View style={[styles.tpcCard, { marginTop: 12 }]}>
      <Text style={styles.tpcCardTitle}>Notes (optional)</Text>
      <Text style={styles.tpcMutedSmall}>
        Example (tires): “Front-left, inside wear, highway vibration over 100 km/h.”
      </Text>
      <Text style={styles.tpcInputLabel}>Notes</Text>
      <TextInput
        value={tpcNotes}
        onChangeText={setTpcNotes}
        placeholder="Add any details that help the AI…"
        placeholderTextColor="#9CA3AF"
        style={styles.tpcInput}
        multiline
      />
    </View>
  );

  /* ------ render ------ */
  return (
    <SafeAreaView style={styles.tpcSafe}>
      <ScrollView contentContainerStyle={styles.tpcPad}>
        {/* Title + tips */}
        <Text style={styles.tpcTitle}>Tire &amp; Part Check Page</Text>
        <Text style={styles.tpcMuted}>Tip: {tpcMode === "tires"
          ? "Take one photo per tire (tread close-up + full tire). Include DOT code if visible."
          : "Capture the part clearly and well-lit. For belts, show edges; for brakes, show pad thickness."}
        </Text>
        {!!vehicleLabel && (
          <Text style={[styles.tpcMutedSmall, { marginTop: 6 }]}>Vehicle: {vehicleLabel}</Text>
        )}

        {/* vehicle chips */}
        {renderVehicleChips()}

        {/* Segmented control */}
        <View style={styles.segment}>
          {(["tires", "parts"] as TpcMode[]).map((m) => {
            const active = tpcMode === m;
            return (
              <Pressable
                key={m}
                onPress={() => setTpcMode(m)}
                style={[styles.segmentItem, active && styles.segmentItemActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {m === "tires" ? "Tire Analysis" : "Part Inspection"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Section card */}
        <View style={styles.sectionCard}>
          <View style={styles.sectionHead}>
            <Feather name={tpcMode === "tires" ? "camera" : "zap"} size={18} color="#0f2940" />
            <Text style={styles.sectionTitle}>
              {tpcMode === "tires" ? "Tire Analysis" : "Part Inspection"}
            </Text>
          </View>
          <Text style={[styles.tpcMuted, { marginBottom: 10 }]}>{tpcHeaderHint}</Text>

          {/* dashed uploader with previews */}
          <Uploader />

          {/* notes just under uploader */}
          <NotesCard />

          {/* CTA row */}
          <View style={[styles.tpcRowGap8, { marginTop: 14, flexWrap: "wrap" }]}>
            <Pressable
              style={[styles.btnPrimary, styles.btnWide, { opacity: !authed || !tpcRemotes.length ? 0.6 : 1 }]}
              onPress={tpcSubmit}
              disabled={tpcBusy || !tpcRemotes.length || !authed}
            >
              <Text style={styles.btnPrimaryText}>{tpcBusy ? "Analyzing…" : "Analyze"}</Text>
            </Pressable>
            {!!tpcRemotes.length && (
              <Pressable
                style={[styles.btnGhost, styles.btnWide]}
                onPress={async () => {
                  setTpcRemotes([]);
                  await AsyncStorage.removeItem(TPC_STORE_KEY);
                  setTpcResp(null);
                }}
              >
                <Text style={styles.btnGhostText}>Clear Photos</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Results */}
        {tpcBusy ? (
          <View style={[styles.tpcCard, styles.tpcCenter]}>
            <ActivityIndicator size="large" />
            <Text style={[styles.tpcMuted, { marginTop: 8 }]}>
              Checking tread, wear and condition…
            </Text>
          </View>
        ) : tpcResp ? (
          <View style={styles.tpcCard}>
            <Text style={styles.tpcCardTitle}>Results</Text>
            {!!(tpcResp as any)?.usedVehicle && (
              <Text style={[styles.tpcMutedSmall, { marginTop: 6 }]}>
                Used vehicle: {[(tpcResp as any).usedVehicle?.name, (tpcResp as any).usedVehicle?.make, (tpcResp as any).usedVehicle?.model]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            )}
            <Text style={[styles.tpcMuted, { marginTop: 6 }]}>{tpcResp.summary}</Text>

            {tpcResp.warnings?.length ? (
              <>
                <Text style={styles.tpcSectionTitle}>Warnings</Text>
                {tpcResp.warnings.map((w, idx) => (
                  <View key={`tpc-w-${idx}`} style={styles.tpcBullet}>
                    <Text style={styles.tpcBulletDot}>•</Text>
                    <Text style={styles.tpcBulletText}>{w}</Text>
                  </View>
                ))}
              </>
            ) : null}

            {tpcResp.results.map((r, idx) => {
              if (r.type === "tires") {
                return (
                  <View key={`tpc-r-${idx}`} style={styles.tpcResultBlock}>
                    <View style={styles.tpcTopRow}>
                      <Text style={styles.tpcResultTitle}>Tire Assessment</Text>
                      <Text
                        style={[
                          styles.tpcBadge,
                          { borderColor: tpcColorByCondition(r.overallCondition), color: tpcColorByCondition(r.overallCondition) },
                        ]}
                      >
                        {r.overallCondition.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.tpcMutedSmall}>
                      Confidence: {tpcPrettyPct(r.confidence)}
                    </Text>
                    {!!(r as any).unevenWear?.length && (
                      <Text style={[styles.tpcMutedSmall, { marginTop: 4 }]}>
                        Uneven wear: {(r as any).unevenWear.join(", ")}
                      </Text>
                    )}
                    <Text style={styles.tpcSectionTitle}>Recommendations</Text>
                    {r.recommendations.map((rec, i2) => (
                      <View key={`tpc-r-t-${idx}-${i2}`} style={styles.tpcBullet}>
                        <Text style={styles.tpcBulletDot}>•</Text>
                        <Text style={styles.tpcBulletText}>{rec}</Text>
                      </View>
                    ))}
                  </View>
                );
              }
              return (
                <View key={`tpc-r-${idx}`} style={styles.tpcResultBlock}>
                  <View style={styles.tpcTopRow}>
                    <Text style={styles.tpcResultTitle}>Part Assessment</Text>
                    <Text
                      style={[
                        styles.tpcBadge,
                        { borderColor: tpcColorByCondition((r as any).wearLevel), color: tpcColorByCondition((r as any).wearLevel) },
                      ]}
                    >
                      {(r as any).partClass.toUpperCase()} • {(r as any).wearLevel.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.tpcMutedSmall}>Confidence: {tpcPrettyPct(r.confidence)}</Text>
                  {!!(r as any).visibleIssues?.length && (
                    <>
                      <Text style={styles.tpcSectionTitle}>Visible Issues</Text>
                      {(r as any).visibleIssues.map((vi: string, i3: number) => (
                        <View key={`tpc-r-p-${idx}-${i3}`} style={styles.tpcBullet}>
                          <Text style={styles.tpcBulletDot}>•</Text>
                          <Text style={styles.tpcBulletText}>{vi}</Text>
                        </View>
                      ))}
                    </>
                  )}
                  <Text style={styles.tpcSectionTitle}>Recommendations</Text>
                  {r.recommendations.map((rec, i4) => (
                    <View key={`tpc-r-p-${idx}-${i4}`} style={styles.tpcBullet}>
                      <Text style={styles.tpcBulletDot}>•</Text>
                      <Text style={styles.tpcBulletText}>{rec}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={{ height: 28 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ================= Styles ================= */
const styles = StyleSheet.create({
  tpcSafe: { flex: 1, backgroundColor: "#F6FAFF" },
  tpcPad: { padding: 16, paddingBottom: 48 },
  tpcTitle: { color: "#0f172a", fontSize: 22, fontWeight: "800" },
  tpcMuted: { color: "#64748b" },
  tpcMutedSmall: { color: "#64748b", fontSize: 12 },

  /* chips */
  tpcChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F3F4F6",
    maxWidth: 240,
  },
  tpcChipActive: { borderColor: "#93C5FD", backgroundColor: "#DBEAFE" },
  tpcChipText: { color: "#374151", fontWeight: "700" },
  tpcChipTextActive: { color: "#1D4ED8", fontWeight: "800" },

  /* segmented */
  segment: {
    flexDirection: "row",
    backgroundColor: "#eef2f7",
    borderRadius: 14,
    padding: 4,
    marginTop: 10,
  },
  segmentItem: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentItemActive: {
    backgroundColor: "#ffffff",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 1 },
    }),
  },
  segmentText: { color: "#475569", fontWeight: "700" },
  segmentTextActive: { color: "#1d4ed8", fontWeight: "800" },

  /* section */
  sectionCard: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 16,
    padding: 14,
    marginTop: 14,
  },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  sectionTitle: { color: "#0f172a", fontSize: 18, fontWeight: "800" },

  /* dashed uploader */
  uploadBox: {
    borderWidth: 2,
    borderColor: "#E0E7FF",
    borderStyle: "dashed",
    backgroundColor: "#F8FAFF",
    padding: 14,
    borderRadius: 14,
  },

  /* buttons */
  btnWide: {
    width: "100%",
    maxWidth: 520,
    minWidth: 220,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 12,
  },
  btnPrimary: { backgroundColor: "#0b66a9" },
  btnPrimaryText: { color: "#ffffff", fontWeight: "800" },
  btnSecondary: {
    backgroundColor: "#eff4fa",
    borderWidth: 1,
    borderColor: "#cfe0f1",
  },
  btnSecondaryText: { color: "#0f2940", fontWeight: "800" },
  btnGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  btnGhostText: { color: "#64748b", fontWeight: "800", textAlign: "center" },

  /* previews */
  previewWrap: { width: "100%" },
  previewGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumb: {
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    position: "relative",
  },
  thumbX: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "#00000066",
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },

  /* generic cards */
  tpcCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginTop: 12,
  },
  tpcCardTitle: { color: "#111827", fontSize: 16, fontWeight: "700" },
  tpcInputLabel: { color: "#374151", fontSize: 12, marginTop: 10, marginBottom: 6, fontWeight: "700" },
  tpcInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    color: "#111827",
  },

  /* results */
  tpcRowGap8: { flexDirection: "row", gap: 8 },
  tpcCenter: { alignItems: "center", justifyContent: "center" },
  tpcSectionTitle: { color: "#111827", fontSize: 14, fontWeight: "800", marginTop: 12, marginBottom: 6 },
  tpcResultBlock: { borderTopWidth: 1, borderTopColor: "#E5E7EB", paddingTop: 10, marginTop: 10 },
  tpcTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tpcResultTitle: { color: "#111827", fontSize: 16, fontWeight: "800" },
  tpcBadge: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, fontWeight: "800" },
  tpcBullet: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginBottom: 6 },
  tpcBulletDot: { color: "#2563eb", fontSize: 18, lineHeight: 18, marginTop: -2 },
  tpcBulletText: { color: "#374151", flex: 1 },
});
