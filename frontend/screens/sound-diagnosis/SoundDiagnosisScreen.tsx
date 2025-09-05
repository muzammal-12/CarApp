// SoundDiagnosisScreen.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Audio } from "expo-av";
import * as DocumentPicker from "expo-document-picker";
import type { AVPlaybackStatus } from "expo-av";

// ===== Types =====
type SdVehicleLite = { _id: string; label: string }; // e.g., "2018 Toyota Corolla"
type SdDiagnosis = {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  probableIssues: { name: string; confidence: number; notes?: string }[];
  recommendations: string[];
  caution?: string;
};

// Expo AV helpers for TS
type RecordingInstance = InstanceType<typeof Audio.Recording>;
type SoundInstance = Audio.Sound;

// ===== Config (adjust) =====
const SD_API_BASE = process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, "") || "https://your-api.example.com";
const sdGetAuthToken = () => "__INJECT_YOUR_JWT_HERE__";

// ===== API helpers (align to your backend) =====
async function sdFetchVehicles(token: string): Promise<SdVehicleLite[]> {
  const r = await fetch(`${SD_API_BASE}/vehicles/my`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Vehicles fetch failed: ${r.status}`);
  const raw = await r.json();
  return (raw || []).map((v: any) => ({
    _id: v._id,
    label: [v.year, v.make, v.model].filter(Boolean).join(" "),
  }));
}

async function sdUploadForDiagnosis(
  token: string,
  fileUri: string,
  fileName: string,
  mimeType: string,
  vehicleId?: string,
  description?: string
): Promise<SdDiagnosis> {
  const form = new FormData();
  form.append("audio", { uri: fileUri, name: fileName, type: mimeType } as any);
  if (vehicleId) form.append("vehicleId", vehicleId);
  if (description) form.append("description", description);

  const r = await fetch(`${SD_API_BASE}/diagnostics/sound`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Diagnosis failed: ${r.status} ${t}`);
  }
  return r.json();
}

// ===== Utility bits =====
function sdFormatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
function sdSeverityColor(level: SdDiagnosis["severity"]) {
  switch (level) {
    case "low":
      return "#77e59b";
    case "medium":
      return "#ffd166";
    case "high":
      return "#ff7b6b";
    case "critical":
      return "#ff2d55";
    default:
      return "#c5c6c7";
  }
}

// ===== Main Screen =====
export default function SoundDiagnosisScreen() {
  const token = sdGetAuthToken();

  // Vehicles
  const [sdVehicles, setSdVehicles] = useState<SdVehicleLite[]>([]);
  const [sdSelectedVehicleId, setSdSelectedVehicleId] = useState<string | undefined>(undefined);

  // Recording / playback
  const [sdRecording, setSdRecording] = useState<RecordingInstance | null>(null);
  const [sdRecordingMs, setSdRecordingMs] = useState(0);
  const [sdIsRecording, setSdIsRecording] = useState(false);
  const [sdMeterValues, setSdMeterValues] = useState<number[]>([]); // for simple waveform during record

  const sdSoundRef = useRef<SoundInstance | null>(null);
  const [sdIsPlaying, setSdIsPlaying] = useState(false);
  const [sdPlayableUri, setSdPlayableUri] = useState<string | null>(null);
  const [sdPlayableFilename, setSdPlayableFilename] = useState<string | null>(null);
  const [sdPlayableMime, setSdPlayableMime] = useState<string>("audio/m4a");

  // Description / prompt
  const [sdDescription, setSdDescription] = useState("");

  // Diagnosis
  const [sdLoadingDiag, setSdLoadingDiag] = useState(false);
  const [sdDiagnosis, setSdDiagnosis] = useState<SdDiagnosis | null>(null);

  // Init: vehicles + audio config
  useEffect(() => {
    (async () => {
      try {
        const vehicles = await sdFetchVehicles(token);
        setSdVehicles(vehicles);
        if (vehicles.length) setSdSelectedVehicleId(vehicles[0]._id);
      } catch {
        // silent — vehicle selector is optional
      }

      // request permissions proactively
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
    })();
  }, [token]);

  // --- Recording logic ---
  const sdStartRecording = useCallback(async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission required", "Microphone access is needed to record sounds.");
        return;
      }

      // Prepare recorder
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY); // m4a on both iOS/Android

      // Metering (supported on iOS; Android returns -160). We'll still render a simple bar.
      rec.setOnRecordingStatusUpdate((status: any) => {
        setSdIsRecording(status.isRecording);
        if (typeof status.durationMillis === "number") setSdRecordingMs(status.durationMillis ?? 0);
        const meter = typeof status.metering === "number" ? status.metering : -60;
        setSdMeterValues((v) => {
          const clamped = Math.max(-60, Math.min(0, meter));
          return [...v.slice(-30), clamped]; // keep last ~30 samples
        });
      });

      setSdMeterValues([]);
      await rec.startAsync();
      setSdRecording(rec);
      setSdDiagnosis(null); // reset
      setSdPlayableUri(null);
      setSdPlayableFilename(null);
    } catch (e: any) {
      Alert.alert("Record error", e?.message ?? "Could not start recording.");
    }
  }, []);

  const sdStopRecording = useCallback(async () => {
    try {
      if (!sdRecording) return;
      await sdRecording.stopAndUnloadAsync();
      const uri = sdRecording.getURI();
      setSdRecording(null);
      setSdIsRecording(false);

      if (uri) {
        setSdPlayableUri(uri);
        const fname = `car-sound-${Date.now()}.m4a`;
        setSdPlayableFilename(fname);
        setSdPlayableMime("audio/m4a");
      }
    } catch (e: any) {
      Alert.alert("Stop error", e?.message ?? "Could not stop recording.");
    }
  }, [sdRecording]);

  // --- Playback logic ---
  const sdTogglePlay = useCallback(async () => {
    try {
      if (!sdPlayableUri) return;
      // stop existing
      if (sdSoundRef.current) {
        const status = await sdSoundRef.current.getStatusAsync();
        if ("isLoaded" in status && status.isLoaded && status.isPlaying) {
          await sdSoundRef.current.pauseAsync();
          setSdIsPlaying(false);
          return;
        }
      }
      // load (or resume)
      if (!sdSoundRef.current) {
        const { sound } = await Audio.Sound.createAsync(
          { uri: sdPlayableUri },
          { shouldPlay: true },
          (st?: AVPlaybackStatus) => {
            if (!st || !("isLoaded" in st) || !st.isLoaded) return;
            if (st.didJustFinish) {
              setSdIsPlaying(false);
            } else {
              setSdIsPlaying(!!st.isPlaying);
            }
          }
        );
        sdSoundRef.current = sound;
      } else {
        await sdSoundRef.current.playAsync();
      }
      setSdIsPlaying(true);
    } catch (e: any) {
      Alert.alert("Playback error", e?.message ?? "Could not play audio.");
    }
  }, [sdPlayableUri]);

  useEffect(() => {
    return () => {
      if (sdSoundRef.current) {
        sdSoundRef.current.unloadAsync().catch(() => {});
        sdSoundRef.current = null;
      }
    };
  }, []);

  // --- Pick existing audio ---
  const sdPickAudio = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["audio/*", "video/quicktime"], // broad; some phones store as video container
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a) return;

      setSdPlayableUri(a.uri);
      setSdPlayableFilename(a.name ?? `sound-${Date.now()}`);
      setSdPlayableMime(a.mimeType || (a.name?.endsWith(".wav") ? "audio/wav" : "audio/m4a"));
      setSdDiagnosis(null);
    } catch (e: any) {
      Alert.alert("File pick error", e?.message ?? "Could not select a file.");
    }
  }, []);

  // --- Submit to backend ---
  const sdSubmitDiagnosis = useCallback(async () => {
    if (!sdPlayableUri || !sdPlayableFilename) {
      Alert.alert("No audio", "Record or select a sound first.");
      return;
    }
    setSdLoadingDiag(true);
    try {
      const result = await sdUploadForDiagnosis(
        token,
        sdPlayableUri,
        sdPlayableFilename,
        sdPlayableMime || "audio/m4a",
        sdSelectedVehicleId,
        sdDescription.trim() || undefined
      );
      setSdDiagnosis(result);
    } catch (e: any) {
      Alert.alert("Analysis failed", e?.message ?? "Could not analyze the audio.");
    } finally {
      setSdLoadingDiag(false);
    }
  }, [token, sdPlayableUri, sdPlayableFilename, sdPlayableMime, sdSelectedVehicleId, sdDescription]);

  // --- Derived UI values ---
  const sdLevelBars = useMemo(() => {
    // Convert metering (-60..0 dB) into 0..1 heights
    const arr = sdMeterValues.length ? sdMeterValues : new Array(20).fill(-60);
    return arr.map((db) => {
      const norm = (db + 60) / 60; // -60->0, 0->1
      return Math.max(0.05, Math.min(1, norm));
    });
  }, [sdMeterValues]);

  // Simple vehicle selector (text chips)
  const VehicleSelector = () => {
    if (!sdVehicles.length) return null;
    return (
      <FlatList
        data={sdVehicles}
        horizontal
        keyExtractor={(i) => i._id}
        contentContainerStyle={{ gap: 8 }}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => {
          const active = sdSelectedVehicleId === item._id;
          return (
            <Pressable
              onPress={() => setSdSelectedVehicleId(item._id)}
              style={[styles.sdChip, active && styles.sdChipActive]}
            >
              <Text style={[styles.sdChipText, active && styles.sdChipTextActive]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          );
        }}
        style={{ marginTop: 6, marginBottom: 8 }}
      />
    );
  };

  return (
    <SafeAreaView style={styles.sdSafe}>
      <FlatList
        data={[1]}
        keyExtractor={() => "sd-root"}
        renderItem={() => (
          <View>
            <Text style={styles.sdTitle}>Sound Diagnosis</Text>
            <Text style={styles.sdMuted}>
              Record or upload a clip of the noise (10–20s works best). We’ll analyze it and suggest likely issues.
            </Text>

            {/* Vehicle selector */}
            <VehicleSelector />

            {/* Recording Card */}
            <View style={styles.sdCard}>
              <Text style={styles.sdCardTitle}>Record</Text>
              <Text style={styles.sdMutedSmall}>Keep the phone near the noise source. Minimize wind/background.</Text>

              <View style={styles.sdRowGap8}>
                {!sdIsRecording ? (
                  <Pressable style={styles.sdBtnPrimary} onPress={sdStartRecording}>
                    <Text style={styles.sdBtnPrimaryText}>● Start Recording</Text>
                  </Pressable>
                ) : (
                  <Pressable style={styles.sdBtnDanger} onPress={sdStopRecording}>
                    <Text style={styles.sdBtnDangerText}>■ Stop</Text>
                  </Pressable>
                )}
                <Pressable style={styles.sdBtnSecondary} onPress={sdPickAudio}>
                  <Text style={styles.sdBtnSecondaryText}>Upload Audio</Text>
                </Pressable>
              </View>

              {/* Level meter */}
              <View style={styles.sdWaveWrap}>
                {sdLevelBars.map((h, idx) => (
                  <View key={`lv-${idx}`} style={[styles.sdWaveBar, { height: 22 * h }]} />
                ))}
              </View>

              <Text style={styles.sdMutedSmall}>
                {sdIsRecording ? `Recording… ${sdFormatMs(sdRecordingMs)}` : sdPlayableUri ? "Ready to play/analyze." : "No audio yet."}
              </Text>

              {/* Playback */}
              {sdPlayableUri ? (
                <View style={[styles.sdRowGap8, { marginTop: 10 }]}>
                  <Pressable style={styles.sdBtnSecondary} onPress={sdTogglePlay}>
                    <Text style={styles.sdBtnSecondaryText}>{sdIsPlaying ? "Pause" : "Play"}</Text>
                  </Pressable>
                  <Pressable
                    style={styles.sdBtnGhost}
                    onPress={() => {
                      setSdPlayableUri(null);
                      setSdPlayableFilename(null);
                      setSdDiagnosis(null);
                    }}
                  >
                    <Text style={styles.sdBtnGhostText}>Clear</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            {/* Description / notes */}
            <View style={styles.sdCard}>
              <Text style={styles.sdCardTitle}>Notes (optional)</Text>
              <Text style={styles.sdMutedSmall}>Describe when the noise happens: cold start, accelerating, turning, etc.</Text>
              <TextInput
                value={sdDescription}
                onChangeText={setSdDescription}
                placeholder="e.g., Rattling on idle after cold start; louder near 1500 RPM."
                placeholderTextColor="#9CA3AF"
                style={[styles.sdInput, { marginTop: 8 }]}
                multiline
              />
            </View>

            {/* Analyze */}
            <View style={styles.sdRowGap8}>
              <Pressable style={styles.sdBtnPrimary} onPress={sdSubmitDiagnosis} disabled={sdLoadingDiag || !sdPlayableUri}>
                <Text style={styles.sdBtnPrimaryText}>{sdLoadingDiag ? "Analyzing…" : "Analyze Sound"}</Text>
              </Pressable>
            </View>

            {/* Results */}
            {sdLoadingDiag ? (
              <View style={[styles.sdCard, styles.sdCenter]}>
                <ActivityIndicator size="large" />
                <Text style={[styles.sdMuted, { marginTop: 8 }]}>Listening closely…</Text>
              </View>
            ) : sdDiagnosis ? (
              <View style={styles.sdCard}>
                <View style={styles.sdTopRow}>
                  <Text style={styles.sdCardTitle}>Results</Text>
                  <Text style={[styles.sdBadge, { borderColor: sdSeverityColor(sdDiagnosis.severity), color: sdSeverityColor(sdDiagnosis.severity) }]}>
                    {sdDiagnosis.severity.toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.sdMuted, { marginTop: 6 }]}>{sdDiagnosis.summary}</Text>

                <Text style={styles.sdSectionTitle}>Probable Issues</Text>
                {sdDiagnosis.probableIssues?.length ? (
                  sdDiagnosis.probableIssues.map((it, idx) => (
                    <View key={`issue-${idx}`} style={styles.sdIssueRow}>
                      <Text style={styles.sdIssueName}>{it.name}</Text>
                      <Text style={styles.sdIssueConf}>{Math.round(it.confidence * 100)}%</Text>
                      {it.notes ? <Text style={styles.sdIssueNotes}>{it.notes}</Text> : null}
                    </View>
                  ))
                ) : (
                  <Text style={styles.sdMutedSmall}>No specific issues identified.</Text>
                )}

                {sdDiagnosis.caution ? (
                  <>
                    <Text style={styles.sdSectionTitle}>Caution</Text>
                    <Text style={[styles.sdMuted, { color: "#eab308" }]}>{sdDiagnosis.caution}</Text>
                  </>
                ) : null}

                <Text style={styles.sdSectionTitle}>Recommended Next Steps</Text>
                {sdDiagnosis.recommendations?.length ? (
                  sdDiagnosis.recommendations.map((r, idx) => (
                    <View key={`rec-${idx}`} style={styles.sdBullet}>
                      <Text style={styles.sdBulletDot}>•</Text>
                      <Text style={styles.sdBulletText}>{r}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.sdMutedSmall}>No actions suggested.</Text>
                )}
              </View>
            ) : null}
          </View>
        )}
        contentContainerStyle={styles.sdPad}
      />
    </SafeAreaView>
  );
}

// ===== Styles (Light Theme) =====
const styles = StyleSheet.create({
  sdSafe: { flex: 1, backgroundColor: "#F9FAFB" },
  sdPad: { padding: 16, paddingBottom: 64 },
  sdTitle: { color: "#111827", fontSize: 22, fontWeight: "800" },
  sdMuted: { color: "#6B7280" },
  sdMutedSmall: { color: "#6B7280", fontSize: 12 },

  sdCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginTop: 12,
  },
  sdCardTitle: { color: "#111827", fontSize: 16, fontWeight: "700" },
  sdTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sdBadge: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, fontWeight: "800" },

  sdRowGap8: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 10 },

  sdBtnPrimary: { backgroundColor: "#2563EB", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  sdBtnPrimaryText: { color: "#FFFFFF", fontWeight: "800" },

  sdBtnSecondary: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  sdBtnSecondaryText: { color: "#111827", fontWeight: "700" },

  sdBtnDanger: {
    backgroundColor: "#FEE2E2",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#FCA5A5",
  },
  sdBtnDangerText: { color: "#B91C1C", fontWeight: "700" },

  sdBtnGhost: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  sdBtnGhostText: { color: "#374151", fontWeight: "700" },

  sdWaveWrap: {
    height: 28,
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
    marginTop: 10,
    marginBottom: 4,
  },
  sdWaveBar: { width: 4, borderRadius: 2, backgroundColor: "#93C5FD" },

  sdInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    color: "#111827",
  },

  sdChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F3F4F6",
    maxWidth: 220,
  },
  sdChipActive: { borderColor: "#93C5FD", backgroundColor: "#DBEAFE" },
  sdChipText: { color: "#374151", fontWeight: "700" },
  sdChipTextActive: { color: "#1D4ED8", fontWeight: "800" },

  sdSectionTitle: { color: "#111827", fontSize: 14, fontWeight: "800", marginTop: 12, marginBottom: 6 },
  sdIssueRow: {
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    paddingTop: 8,
    marginTop: 6,
  },
  sdIssueName: { color: "#111827", fontWeight: "700" },
  sdIssueConf: { color: "#2563EB", fontWeight: "700", marginTop: 2 },
  sdIssueNotes: { color: "#6B7280", marginTop: 2 },

  sdBullet: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginBottom: 6 },
  sdBulletDot: { color: "#2563EB", fontSize: 18, lineHeight: 18, marginTop: -2 },
  sdBulletText: { color: "#374151", flex: 1 },

  sdCenter: { alignItems: "center", justifyContent: "center" },
});
