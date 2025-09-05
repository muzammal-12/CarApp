// screens/profile/ProfileScreen.tsx
import React, { useCallback, useState, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
  ScrollView,
  KeyboardAvoidingView,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "../../services/authContext";
import { uploadToCloudinaryLocalFile } from "../../services/secure";

/* ⬇️ Optional native date picker (no hard dependency) */
let DateTimePicker: any = null;
try { DateTimePicker = require("@react-native-community/datetimepicker"); } catch {}

/* ───────── Types ───────── */
type CarAppUserProfile = {
  _id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatarUrl?: string;
};

type VehiclePhoto = {
  public_id: string;
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  format?: string;
  created_at?: string;
};

type MaintEntry = { mileage?: number; date?: string };
type LastMaintenance = {
  /** ✅ only oil_change remains */
  oil_change?: MaintEntry;
};

type CarAppVehicle = {
  _id: string;
  userId: string;
  make: string;
  model: string;
  year: number;
  mileage?: number;
  mileageUnit?: "km" | "mi";
  /** avg daily driving distance (km/day) */
  dailyDriveKm?: number;
  isPrimary?: boolean;
  nickname?: string;
  createdAt?: string;
  updatedAt?: string;
  photos?: VehiclePhoto[];
  last_maintenance?: LastMaintenance;
};

/* ───────── Config ───────── */
const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ||
  process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, "") ||
  "http://localhost:5000";

console.log("[TPC] API:", `${API_BASE}/api`);

/* ───────── Helpers ───────── */
const sortVehicles = (vs: CarAppVehicle[]) =>
  [...vs].sort(
    (a, b) =>
      Number(!!b.isPrimary) - Number(!!a.isPrimary) ||
      (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );

const addDays = (iso: string, days: number) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (aISO: string, bISO: string) => {
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / (24 * 3600 * 1000));
};
const formatYMD = (d: Date) => d.toISOString().slice(0, 10);

/** ✅ Only oil interval preview */
const RULES: Record<"oil_change", { km?: number; days?: number; label: string }> = {
  oil_change: { km: 8000, days: 365, label: "Oil Change" },
};

const buildPreview = (lm: LastMaintenance, currentMileage?: number, dailyDriveKm?: number) => {
  const today = new Date().toISOString().slice(0, 10);
  type Row = { key: keyof typeof RULES; label: string; dueKm?: number; dueDays?: number };
  const rows: Row[] = [];

  (Object.keys(RULES) as (keyof typeof RULES)[]).forEach((key) => {
    const rule = RULES[key];
    const seed = lm?.[key];
    if (!seed?.date && typeof seed?.mileage !== "number") return;

    let dueKm: number | undefined;
    if (typeof seed?.mileage === "number" && typeof rule.km === "number") {
      const nextAt = seed.mileage + rule.km;
      if (typeof currentMileage === "number") dueKm = nextAt - currentMileage;
    }

    let dueDays: number | undefined;
    if (seed?.date && typeof rule.days === "number") {
      const nextDate = addDays(seed.date, rule.days);
      if (nextDate) dueDays = daysBetween(today, nextDate);
    }

    if (dueDays === undefined && typeof dueKm === "number" && dueKm >= 0 && dailyDriveKm && dailyDriveKm > 0) {
      dueDays = Math.ceil(dueKm / dailyDriveKm);
    }

    rows.push({ key, label: rule.label, dueKm, dueDays });
  });

  rows.sort((a, b) => {
    const aScore = Math.min(a.dueKm ?? Infinity, a.dueDays ?? Infinity);
    const bScore = Math.min(b.dueKm ?? Infinity, b.dueDays ?? Infinity);
    return aScore - bScore;
  });

  return rows.slice(0, 1);
};

/* ───────── API ───────── */
async function fetchMe(authToken: string): Promise<CarAppUserProfile> {
  const r = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${authToken}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Profile fetch failed: ${r.status}`);
  return r.json();
}
async function patchMe(
  authToken: string,
  payload: { firstName?: string; lastName?: string; phone?: string }
): Promise<CarAppUserProfile> {
  const r = await fetch(`${API_BASE}/api/auth/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Profile update failed: ${r.status}`);
  return r.json();
}
async function fetchMyVehicles(authToken: string): Promise<CarAppVehicle[]> {
  const r = await fetch(`${API_BASE}/api/vehicles/my`, {
    headers: { Authorization: `Bearer ${authToken}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Vehicles fetch failed: ${r.status}`);
  return r.json();
}
async function createVehicle(
  authToken: string,
  payload: Partial<CarAppVehicle>
): Promise<CarAppVehicle> {
  const r = await fetch(`${API_BASE}/api/vehicles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Create vehicle failed: ${r.status} ${t}`);
  }
  return r.json();
}
async function updateVehicle(
  authToken: string,
  id: string,
  payload: Partial<CarAppVehicle>
): Promise<CarAppVehicle> {
  const r = await fetch(`${API_BASE}/api/vehicles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Update vehicle failed: ${r.status} ${t}`);
  }
  return r.json();
}

/** ✅ Robust vehicle delete */
async function deleteVehicleAny(authToken: string, id: string): Promise<{ ok: true }> {
  type Attempt = { note: string; url: string; init: RequestInit };
  const base = API_BASE.replace(/\/$/, "");
  const attempts: Attempt[] = [
    { note: "DELETE /api/vehicles/:id", url: `${base}/api/vehicles/${encodeURIComponent(id)}`, init: { method: "DELETE" } },
    { note: "DELETE /api/vehicle/:id (singular)", url: `${base}/api/vehicle/${encodeURIComponent(id)}`, init: { method: "DELETE" } },
    { note: "DELETE /api/vehicles?id=", url: `${base}/api/vehicles?id=${encodeURIComponent(id)}`, init: { method: "DELETE" } },
    { note: "POST /api/vehicles/:id?_method=DELETE", url: `${base}/api/vehicles/${encodeURIComponent(id)}?_method=DELETE`, init: { method: "POST" } },
    { note: "POST /api/vehicle/:id?_method=DELETE", url: `${base}/api/vehicle/${encodeURIComponent(id)}?_method=DELETE`, init: { method: "POST" } },
    { note: "POST /api/vehicles/:id/delete", url: `${base}/api/vehicles/${encodeURIComponent(id)}/delete`, init: { method: "POST" } },
    { note: "POST /api/vehicles/:id/remove", url: `${base}/api/vehicles/${encodeURIComponent(id)}/remove`, init: { method: "POST" } },
    {
      note: "POST /api/vehicles/delete { vehicleId }",
      url: `${base}/api/vehicles/delete`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vehicleId: id }) },
    },
    {
      note: "POST /api/vehicles/remove { id }",
      url: `${base}/api/vehicles/remove`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
    },
    {
      note: "DELETE /api/vehicles with JSON body { id }",
      url: `${base}/api/vehicles`,
      init: { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
    },
  ];
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { ...a.init, headers: { ...(a.init.headers || {}), Authorization: `Bearer ${authToken}` }, cache: "no-store" });
      if (r.ok || r.status === 204) return { ok: true };
      await r.text().catch(() => "");
    } catch {}
  }
  throw new Error("Could not find a working delete route. Check server routes for vehicles and adjust the client to match.");
}

async function setPrimaryVehicle(authToken: string, id: string): Promise<{ ok: true }> {
  const r = await fetch(`${API_BASE}/api/vehicles/${encodeURIComponent(id)}/set-primary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Set primary failed: ${r.status}`);
  return { ok: true };
}
async function attachVehiclePhoto(
  authToken: string,
  vehicleId: string,
  photo: VehiclePhoto
): Promise<CarAppVehicle> {
  const r = await fetch(`${API_BASE}/api/vehicles/${encodeURIComponent(vehicleId)}/photos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(photo),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Attach photo failed: ${r.status} ${t}`);
  }
  return r.json();
}
async function deleteVehiclePhoto(
  authToken: string,
  vehicleId: string,
  publicId: string
): Promise<CarAppVehicle> {
  const first = await fetch(
    `${API_BASE}/api/vehicles/${encodeURIComponent(vehicleId)}/photos?publicId=${encodeURIComponent(publicId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${authToken}` }, cache: "no-store" }
  );
  if (first.ok) return first.json();

  const second = await fetch(
    `${API_BASE}/api/vehicles/${encodeURIComponent(vehicleId)}/photos/${encodeURIComponent(publicId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${authToken}` }, cache: "no-store" }
  );
  if (!second.ok) {
    const t = await second.text().catch(() => "");
    throw new Error(`Delete photo failed: ${second.status} ${t}`);
  }
  return second.json();
}

/* ───────── Component ───────── */
export default function ProfileScreen() {
  const { token, logout } = useAuth();

  const [stateUser, setStateUser] = useState<CarAppUserProfile | null>(null);
  const [stateVehicles, setStateVehicles] = useState<CarAppVehicle[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // profile modal
  const [profileModal, setProfileModal] = useState(false);
  const [pfFirst, setPfFirst] = useState("");
  const [pfLast, setPfLast] = useState("");
  const [pfPhone, setPfPhone] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  // add/edit vehicle
  const [modalVisible, setModalVisible] = useState(false);
  const [editModeVehicleId, setEditModeVehicleId] = useState<string | null>(null);

  const [formMake, setFormMake] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formYear, setFormYear] = useState("");
  const [formMileage, setFormMileage] = useState("");
  const [formNickname, setFormNickname] = useState("");
  /** ✅ Daily drive kept */
  const [formDailyDrive, setFormDailyDrive] = useState("");

  // ✅ Only Oil Change seeds
  const [maintOpen, setMaintOpen] = useState(true);
  const [oilDate, setOilDate] = useState("");
  const [oilKm, setOilKm] = useState("");
  const [oilDatePickerOpen, setOilDatePickerOpen] = useState(false); // ⬅️ NEW

  const seedObj = useMemo<LastMaintenance>(() => {
    const maybe = (date: string, km: string): MaintEntry | undefined => {
      const d = (date || "").trim();
      const m = km ? Number(km) : undefined;
      if (!d && typeof m !== "number") return undefined;
      const out: MaintEntry = {};
      if (d) out.date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d).toISOString() : d;
      if (typeof m === "number" && !Number.isNaN(m)) out.mileage = m;
      return Object.keys(out).length ? out : undefined;
    };
    const o: LastMaintenance = {};
    const push = (v?: MaintEntry) => { if (v) o.oil_change = v; };
    push(maybe(oilDate, oilKm));
    return o;
  }, [oilDate, oilKm]);

  const previewRows = useMemo(
    () =>
      buildPreview(
        seedObj,
        formMileage ? Number(formMileage) : undefined,
        formDailyDrive ? Number(formDailyDrive) : undefined
      ),
    [seedObj, formMileage, formDailyDrive]
  );

  // confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState<string>("Confirm");
  const [confirmMsg, setConfirmMsg] = useState<string>("");
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);

  const askConfirm = (title: string, message: string, onYes: () => void) => {
    setConfirmTitle(title); setConfirmMsg(message); setConfirmAction(() => onYes); setConfirmOpen(true);
  };

  const resetVehicleForm = () => {
    setEditModeVehicleId(null);
    setFormMake(""); setFormModel(""); setFormYear(""); setFormMileage("");
    setFormNickname(""); setFormDailyDrive(""); setMaintOpen(true);
    setOilDate(""); setOilKm("");
  };

  const openAddModal = () => { resetVehicleForm(); setModalVisible(true); };

  const openEditModal = (v: CarAppVehicle) => {
    setEditModeVehicleId(v._id);
    setFormMake(v.make || ""); setFormModel(v.model || "");
    setFormYear(String(v.year || "")); setFormMileage(typeof v.mileage === "number" ? String(v.mileage) : "");
    setFormNickname(v.nickname || ""); setFormDailyDrive(typeof v.dailyDriveKm === "number" ? String(v.dailyDriveKm) : "");
    const lm = v.last_maintenance || {};
    const toShort = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
    setOilDate(toShort(lm.oil_change?.date)); setOilKm(lm.oil_change?.mileage?.toString() || "");
    setModalVisible(true);
  };

  const loadAll = useCallback(async () => {
    try {
      const [uRes, vsRes] = await Promise.allSettled([fetchMe(token || ""), fetchMyVehicles(token || "")]);
      if (uRes.status === "fulfilled") setStateUser(uRes.value);
      if (vsRes.status === "fulfilled") setStateVehicles(sortVehicles(vsRes.value));
    } finally { setLoadingInit(false); }
  }, [token]);

  useFocusEffect(useCallback(() => { setLoadingInit(true); loadAll(); }, [loadAll]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const vs = await fetchMyVehicles(token || "");
      setStateVehicles(sortVehicles(vs));
    } catch (e: any) {
      Alert.alert("Refresh Error", e?.message ?? "Failed to refresh vehicles");
    } finally { setRefreshing(false); }
  }, [token]);

  const openProfileModal = () => {
    setPfFirst(stateUser?.firstName || ""); setPfLast(stateUser?.lastName || "");
    setPfPhone(stateUser?.phone || ""); setProfileModal(true);
  };

  const saveProfile = async () => {
    try {
      setSavingProfile(true);
      const updated = await patchMe(token || "", {
        firstName: pfFirst.trim() || undefined,
        lastName: pfLast.trim() || undefined,
        phone: pfPhone.trim() || undefined,
      });
      setStateUser(updated); setProfileModal(false);
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not update profile");
    } finally { setSavingProfile(false); }
  };

  const submitVehicle = async () => {
    const yearNum = Number(formYear);
    const mileageNum = formMileage ? Number(formMileage) : undefined;
    const dailyDriveNum = formDailyDrive ? Number(formDailyDrive) : undefined;

    if (!formMake || !formModel || !yearNum) {
      Alert.alert("Validation", "Make, Model, and Year are required."); return;
    }
    if (formDailyDrive && !Number.isFinite(dailyDriveNum!)) {
      Alert.alert("Validation", "Daily drive must be a number (km/day)."); return;
    }

    const payload: Partial<CarAppVehicle> = {
      make: formMake.trim(),
      model: formModel.trim(),
      year: yearNum,
      mileage: mileageNum,
      nickname: formNickname.trim() || undefined,
      dailyDriveKm: dailyDriveNum,
    };
    if (seedObj.oil_change) payload.last_maintenance = { oil_change: seedObj.oil_change };

    try {
      if (editModeVehicleId) {
        const updated = await updateVehicle(token || "", editModeVehicleId, payload);
        setStateVehicles((prev) => sortVehicles(prev.map((v) => (v._id === updated._id ? updated : v))));
      } else {
        const created = await createVehicle(token || "", payload);
        setStateVehicles((prev) => sortVehicles([created, ...prev]));
      }
      setModalVisible(false); resetVehicleForm();
    } catch (e: any) {
      console.error("[UI] submitVehicle error:", e?.message || e);
      Alert.alert("Save Error", e?.message ?? "Failed to save vehicle");
    }
  };

  const removeVehicle = (vehicleId: string) => {
    askConfirm("Delete Vehicle", "This action cannot be undone.", async () => {
      try {
        setStateVehicles((prev) => prev.filter((v) => v._id !== vehicleId)); // optimistic
        await deleteVehicleAny(token || "", vehicleId);
        onRefresh();
      } catch (e: any) {
        console.error("[UI] deleteVehicle error:", e?.message || e);
        Alert.alert("Delete Error", e?.message ?? "Failed to delete vehicle");
        onRefresh();
      }
    });
  };

  const markAsPrimary = async (vehicleId: string) => {
    try {
      setStateVehicles((prev) => sortVehicles(prev.map((v) => ({ ...v, isPrimary: v._id === vehicleId }))));
      await setPrimaryVehicle(token || "", vehicleId);
      onRefresh();
    } catch (e: any) {
      console.error("[UI] setPrimary error:", e?.message || e);
      Alert.alert("Primary Error", e?.message ?? "Failed to set primary vehicle");
      onRefresh();
    }
  };

  const addPhotoToVehicle = async (vehicle: CarAppVehicle) => {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 });
    if (picked.canceled) return;
    const uri = picked.assets?.[0]?.uri;
    if (!uri) return;

    try {
      const uploaded = await uploadToCloudinaryLocalFile(uri, {
        folder: process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_FOLDER || "carai/vehicles",
      });

      const updated = await attachVehiclePhoto(token || "", vehicle._id, {
        public_id: uploaded.public_id,
        url: uploaded.secure_url,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
        format: uploaded.format,
        created_at: uploaded.created_at,
      });

      setStateVehicles((prev) => sortVehicles(prev.map((v) => (v._id === updated._id ? updated : v))));
    } catch (e: any) {
      console.error("[UI] addPhoto error:", e?.message || e);
      Alert.alert("Upload Error", e?.message ?? "Failed to upload photo");
    }
  };

  /* ⬇️ FIX: optimistic photo delete + auto-refresh */
  const removePhotoFromVehicle = (vehicle: CarAppVehicle, publicId: string) => {
    askConfirm("Delete Photo", "Remove this photo from your vehicle?", async () => {
      // optimistic: remove locally first
      setStateVehicles((prev) =>
        sortVehicles(
          prev.map((v) =>
            v._id === vehicle._id ? { ...v, photos: (v.photos || []).filter((p) => p.public_id !== publicId) } : v
          )
        )
      );
      try {
        const updated = await deleteVehiclePhoto(token || "", vehicle._id, publicId);
        // ensure final state matches server
        setStateVehicles((prev) => sortVehicles(prev.map((v) => (v._id === updated._id ? updated : v))));
      } catch (e: any) {
        console.error("[UI] deletePhoto error:", e?.message || e);
        Alert.alert("Delete Error", e?.message ?? "Failed to delete photo");
      } finally {
        // hard refresh so it also disappears after a pull-to-refresh-less flow
        onRefresh();
      }
    });
  };

  if (loadingInit) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" />
          <Text style={styles.loadingText}>Loading profile…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <FlatList
        data={stateVehicles}
        keyExtractor={(item) => item._id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View style={styles.headerWrap}>
            <Text style={styles.titleText}>Profile & Vehicle Settings</Text>

            <View style={styles.cardBlock}>
              <Text style={styles.cardTitle}>User</Text>
              <Text style={styles.cardLine}>Email: {stateUser?.email || "—"}</Text>
              <Text style={styles.cardLine}>
                Name: {(stateUser?.firstName || "") + (stateUser?.lastName ? ` ${stateUser?.lastName}` : "") || "—"}
              </Text>
              <Text style={styles.cardLine}>Phone: {stateUser?.phone || "—"}</Text>

              <View style={styles.rowGap8}>
                <Pressable style={styles.btnSecondary} onPress={openProfileModal}>
                  <Text style={styles.btnSecondaryText}>Edit Profile</Text>
                </Pressable>
                <Pressable style={styles.btnDanger} onPress={logout}>
                  <Text style={styles.btnDangerText}>Logout</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.vehiclesHeaderRow}>
              <Text style={styles.cardTitle}>My Vehicles</Text>
              <Pressable style={styles.btnPrimary} onPress={openAddModal}>
                <Text style={styles.btnPrimaryText}>+ Add Vehicle</Text>
              </Pressable>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.cardBlock, item.isPrimary && styles.primaryGlow]}>
            <View style={styles.vehicleTopRow}>
              <Text style={styles.vehicleTitle}>
                {item.nickname ? `${item.nickname} • ` : ""}{item.year} {item.make} {item.model}
              </Text>
              {item.isPrimary ? <Text style={styles.pillPrimary}>PRIMARY</Text> : null}
            </View>

            <Text style={styles.cardLine}>
              Mileage: {typeof item.mileage === "number" ? `${item.mileage.toLocaleString()} ${item.mileageUnit || "km"}` : "—"}
            </Text>
            <Text style={styles.cardLine}>
              Daily Drive: {typeof item.dailyDriveKm === "number" ? `${item.dailyDriveKm} km/day` : "—"}
            </Text>

            {!!item.last_maintenance?.oil_change?.date || !!item.last_maintenance?.oil_change?.mileage ? (
              <Text style={[styles.cardLine, { color: "#475569" }]}>
                Next Oil Change approx in{" "}
                {(() => {
                  const row = buildPreview(item.last_maintenance || {}, item.mileage, item.dailyDriveKm).find((r) => r.key === "oil_change");
                  if (!row) return "—";
                  const km =
                    typeof row.dueKm === "number"
                      ? `${row.dueKm >= 0 ? row.dueKm : Math.abs(row.dueKm)} km${row.dueKm < 0 ? " overdue" : ""}`
                      : "";
                  const days =
                    typeof row.dueDays === "number"
                      ? `${row.dueDays >= 0 ? row.dueDays : Math.abs(row.dueDays)} days${row.dueDays < 0 ? " overdue" : ""}`
                      : "";
                  if (km && days) return `${km} / ${days}`;
                  return km || days || "—";
                })()}
              </Text>
            ) : null}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
              {(item.photos ?? []).map((p) => (
                <View key={p.public_id} style={styles.photoTile}>
                  <Image source={{ uri: p.url }} style={styles.photoImg} accessibilityRole="image" />
                  <Pressable
                    onPress={() => removePhotoFromVehicle(item, p.public_id)}
                    onLongPress={() => removePhotoFromVehicle(item, p.public_id)}
                    hitSlop={10}
                    style={({ pressed }) => [styles.photoDelete, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
                    accessibilityRole="button"
                    accessibilityLabel="Delete photo"
                  >
                    <Text style={styles.photoDeleteTxt}>Delete</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable onPress={() => addPhotoToVehicle(item)} style={styles.addPhotoTile}>
                <Text style={{ fontSize: 24 }}>＋</Text>
                <Text style={{ fontSize: 12, color: "#6b7280" }}>Add Photo</Text>
              </Pressable>
            </ScrollView>

            <View style={styles.rowWrap}>
              {!item.isPrimary && (
                <Pressable style={styles.btnSecondary} onPress={() => markAsPrimary(item._id)}>
                  <Text style={styles.btnSecondaryText}>Set Primary</Text>
                </Pressable>
              )}
              <Pressable style={styles.btnSecondary} onPress={() => openEditModal(item)}>
                <Text style={styles.btnSecondaryText}>Edit</Text>
              </Pressable>
              <Pressable style={styles.btnDanger} onPress={() => removeVehicle(item._id)}>
                <Text style={styles.btnDangerText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={<View style={styles.emptyWrap}><Text style={styles.emptyText}>No vehicles yet. Tap “Add Vehicle”.</Text></View>}
        contentContainerStyle={styles.scrollerPad}
      />

      {/* Add/Edit Vehicle Modal */}
      <Modal animationType="slide" transparent visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ maxHeight: "85%" }}>
              <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalScrollContent}>
                <Text style={styles.modalTitle}>{editModeVehicleId ? "Edit Vehicle" : "Add Vehicle"}</Text>

                <View style={styles.formCol}>
                  <Text style={styles.label}>Make *</Text>
                  <TextInput value={formMake} onChangeText={setFormMake} placeholder="e.g., Honda" style={styles.input} />

                  <Text style={styles.label}>Model *</Text>
                  <TextInput value={formModel} onChangeText={setFormModel} placeholder="e.g., Civic" style={styles.input} />

                  <Text style={styles.label}>Year *</Text>
                  <TextInput value={formYear} onChangeText={setFormYear} placeholder="e.g., 2017" keyboardType="number-pad" style={styles.input} />

                  <Text style={styles.label}>Mileage (km)</Text>
                  <TextInput value={formMileage} onChangeText={setFormMileage} placeholder="Optional" keyboardType="number-pad" style={styles.input} />

                  <Text style={styles.label}>Daily Drive (avg km/day)</Text>
                  <TextInput value={formDailyDrive} onChangeText={setFormDailyDrive} placeholder="Optional" keyboardType="number-pad" style={styles.input} />

                  <Text style={styles.label}>Nickname</Text>
                  <TextInput value={formNickname} onChangeText={setFormNickname} placeholder="e.g., Daily Driver" style={styles.input} />
                </View>

                {/* ✅ Maintenance seed (Oil only) */}
                <Pressable onPress={() => setMaintOpen((v) => !v)} style={[styles.rowBetween, { marginTop: 10 }]}>
                  <Text style={[styles.modalTitle, { fontSize: 16 }]}>Maintenance (optional)</Text>
                  <Text style={{ color: "#2563EB", fontWeight: "700" }}>{maintOpen ? "Hide" : "Show"}</Text>
                </Pressable>

                {maintOpen && (
                  <>
                    <Text style={[styles.label, { marginTop: 6 }]}>
                      Enter the last oil change date and/or mileage. We’ll use this to forecast the next oil change.
                    </Text>

                    <View style={[styles.cardBlock, { marginTop: 8 }]}>
                      <Text style={styles.cardTitle}>Oil Change</Text>

                      {/* ⬇️ Date with calendar option */}
                      <Text style={styles.label}>Last Date</Text>

                      {Platform.OS === "web" ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <View style={{ flex: 1 }}>
                            {/* @ts-ignore RN Web: native input */}
                            <input
                              type="date"
                              value={oilDate}
                              max={new Date().toISOString().slice(0, 10)}
                              onChange={(e: any) => setOilDate(e.currentTarget.value)}
                              style={{
                                width: "100%",
                                height: 42,
                                padding: "10px 12px",
                                borderRadius: 10,
                                border: "1px solid #E5E7EB",
                                background: "#FFFFFF",
                                color: "#0F172A",
                                fontSize: 14,
                                outline: "none",
                              }}
                              placeholder="YYYY-MM-DD"
                            />
                          </View>
                        </View>
                      ) : (
                        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                          <TextInput
                            value={oilDate}
                            onChangeText={setOilDate}
                            placeholder="YYYY-MM-DD"
                            style={[styles.input, { flex: 1 }]}
                            autoCapitalize="none"
                          />
                          <Pressable
                            style={[styles.btnSecondary, !DateTimePicker && { opacity: 0.6 }]}
                            disabled={!DateTimePicker}
                            onPress={() => setOilDatePickerOpen(true)}
                          >
                            <Text style={styles.btnSecondaryText}>Pick Date</Text>
                          </Pressable>
                        </View>
                      )}

                      {DateTimePicker && oilDatePickerOpen && (
                        <DateTimePicker
                          value={oilDate ? new Date(oilDate) : new Date()}
                          mode="date"
                          display={Platform.OS === "ios" ? "inline" : "default"}
                          onChange={(_: any, d?: Date) => {
                            if (Platform.OS !== "ios") setOilDatePickerOpen(false);
                            if (d) setOilDate(formatYMD(d));
                          }}
                        />
                      )}

                      <Text style={styles.label}>Last Mileage (km)</Text>
                      <TextInput
                        value={oilKm}
                        onChangeText={setOilKm}
                        placeholder="e.g., 14600"
                        style={styles.input}
                        keyboardType="number-pad"
                      />
                    </View>

                    {/* Preview */}
                    <View style={[styles.cardBlock, { marginTop: 8 }]}>
                      <Text style={styles.cardTitle}>Next Oil Change Preview</Text>
                      {previewRows.length === 0 ? (
                        <Text style={styles.cardLine}>Add last oil change to see a preview.</Text>
                      ) : (
                        previewRows.map((r) => (
                          <Text key={r.label} style={styles.cardLine}>
                            {r.label}:{" "}
                            {typeof r.dueKm === "number"
                              ? `${r.dueKm >= 0 ? r.dueKm : Math.abs(r.dueKm)} km${r.dueKm < 0 ? " overdue" : ""}`
                              : "—"}
                            {"  "}
                            {typeof r.dueDays === "number"
                              ? `| ${r.dueDays >= 0 ? r.dueDays : Math.abs(r.dueDays)} days${r.dueDays < 0 ? " overdue" : ""}`
                              : ""}
                          </Text>
                        ))
                      )}
                    </View>
                  </>
                )}
              </ScrollView>
            </KeyboardAvoidingView>

            {/* pinned actions */}
            <View style={styles.modalBtnRow}>
              <Pressable
                style={styles.btnGhost}
                onPress={() => { setModalVisible(false); resetVehicleForm(); }}
              >
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.btnPrimary} onPress={submitVehicle}>
                <Text style={styles.btnPrimaryText}>{editModeVehicleId ? "Save" : "Add"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Edit Profile Modal */}
      <Modal animationType="fade" transparent visible={profileModal} onRequestClose={() => setProfileModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit Profile</Text>

            <View style={styles.formCol}>
              <Text style={styles.label}>Email (read-only)</Text>
              <TextInput value={stateUser?.email || ""} editable={false} style={[styles.input, { opacity: 0.8 }]} />

              <Text style={styles.label}>First name</Text>
              <TextInput value={pfFirst} onChangeText={setPfFirst} placeholder="e.g., John" style={styles.input} />

              <Text style={styles.label}>Last name</Text>
              <TextInput value={pfLast} onChangeText={setPfLast} placeholder="e.g., Doe" style={styles.input} />

              <Text style={styles.label}>Phone</Text>
              <TextInput value={pfPhone} onChangeText={setPfPhone} placeholder="+1 (555) 123-4567" keyboardType="phone-pad" style={styles.input} />
            </View>

            <View style={styles.modalBtnRow}>
              <Pressable style={styles.btnGhost} onPress={() => setProfileModal(false)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.btnPrimary, savingProfile && { opacity: 0.7 }]} onPress={saveProfile} disabled={savingProfile}>
                <Text style={styles.btnPrimaryText}>{savingProfile ? "Saving…" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* App-styled Confirm Dialog */}
      <Modal transparent visible={confirmOpen} animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>{confirmTitle}</Text>
            <Text style={styles.confirmMsg}>{confirmMsg}</Text>
            <View style={styles.confirmRow}>
              <Pressable style={styles.btnGhost} onPress={() => setConfirmOpen(false)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.btnDanger, { borderColor: "#fecaca" }]}
                onPress={() => { setConfirmOpen(false); confirmAction?.(); }}
              >
                <Text style={styles.btnDangerText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ───────── Styles ───────── */
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7FAFC" },
  scrollerPad: { padding: 16, paddingBottom: 48 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#64748B", marginTop: 10 },

  headerWrap: { gap: 16, marginBottom: 8 },
  titleText: { color: "#0F172A", fontSize: 22, fontWeight: "700" },

  cardBlock: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    marginBottom: 12,
  },
  primaryGlow: {
    shadowColor: "#2563EB",
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    ...(Platform.OS === "android" ? { elevation: 5 } : {}),
    borderColor: "#93C5FD",
  },
  cardTitle: { color: "#0F172A", fontSize: 16, fontWeight: "700", marginBottom: 8 },
  cardLine: { color: "#374151", marginBottom: 4 },

  vehiclesHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },

  vehicleTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  vehicleTitle: { color: "#0F172A", fontSize: 16, fontWeight: "700", flexShrink: 1 },
  pillPrimary: {
    color: "#1D4ED8",
    fontWeight: "700",
    borderWidth: 1,
    borderColor: "#93C5FD",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },

  rowWrap: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  rowGap8: { flexDirection: "row", gap: 8, marginTop: 10 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  btnPrimary: { backgroundColor: "#2563EB", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
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

  btnDanger: {
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  btnDangerText: { color: "#DC2626", fontWeight: "700" },

  btnGhost: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  btnGhostText: { color: "#1F2937", fontWeight: "700" },

  emptyWrap: { alignItems: "center", padding: 24 },
  emptyText: { color: "#64748B" },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: "#FFFFFF",
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    maxHeight: "90%",
    overflow: "hidden",
  },
  modalScrollContent: { paddingBottom: 24, gap: 10 },
  modalTitle: { color: "#0F172A", fontSize: 18, fontWeight: "800" },
  formCol: { gap: 8 },
  label: { color: "#374151", fontSize: 12, fontWeight: "600" },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    color: "#0F172A",
  },
  modalBtnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },

  // Photo tiles
  photoTile: { marginRight: 10, position: "relative" },
  photoImg: { width: 120, height: 80, borderRadius: 8 },
  photoDelete: {
    position: "absolute",
    right: 4,
    bottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    zIndex: 10,
    ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
  },
  photoDeleteTxt: { color: "#fff", fontSize: 12, fontWeight: "600" },

  addPhotoTile: {
    width: 120,
    height: 80,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f8fafc",
    alignItems: "center",
    justifyContent: "center",
  },

  // Confirm dialog
  confirmOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  confirmCard: {
    width: 360,
    maxWidth: "95%",
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    padding: 16,
  },
  confirmTitle: { color: "#0F172A", fontWeight: "800", fontSize: 18, marginBottom: 6 },
  confirmMsg: { color: "#374151", marginBottom: 12 },
  confirmRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
