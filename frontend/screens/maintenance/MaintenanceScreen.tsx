// screens/maintenance/MaintenanceRepairsScreen.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  Switch,
  RefreshControl,
  ScrollView,
} from "react-native";

/* Optional file picker for OCR uploads */
let DocumentPicker: any = null;
try { DocumentPicker = require("expo-document-picker"); } catch {}

/* Optional native date picker (no hard dependency) */
let DateTimePicker: any = null;
try { DateTimePicker = require("@react-native-community/datetimepicker"); } catch {}

/* Shared API + auth */
import {
  apiGetVehicles,
  apiGetMaintenanceHistory,
  apiPostOCRQuote,
  apiSaveQuote,
  apiGetTyrePartsStatus,
  apiCompleteMaintenance,
  // schedule endpoints
  apiListScheduledServices,
  apiCreateScheduledService,
  apiDeleteScheduledService,
  // NEW: Gemini-only Pricing endpoints
  apiPricingCompare,
  apiPricingSubmitSamples,
  type Vehicle,
  type QuoteItem,
  type LastMaintenance,
  type PricingCompareRow, // AI-based row (ai_verdict, ai_range_min/max, etc.)
} from "../../services/api";
import { useAuth } from "../../services/authContext";

/* ─── Local types ─── */
type MvVehicleLite = {
  _id: string;
  year?: number;
  make?: string;
  model?: string;
  label: string;
  odometerKm?: number;
  dailyDriveKm?: number;
  last_maintenance?: LastMaintenance;
};

type MvServiceRecord = {
  _id?: string;
  vehicleId: string;
  dateISO: string;
  odometerKm?: number;
  kind: string;
  cost?: number;
  notes?: string;
  provider?: string;
};

type MvScheduleItem = {
  key: keyof LastMaintenance | string;
  title: string;
  dueInKm?: number;
  dueInDays?: number;
  nextAtKm?: number;
  nextAtDateISO?: string;
  estCostMin?: number;
  estCostMax?: number;
  urgency: "soon" | "upcoming" | "overdue";
  hints?: string[];
};

/** Tag scheduled items so the CTA uses the right handler */
type MvScheduleItemExt = MvScheduleItem & { _scheduled?: ScheduledService };

type MvFlag = { lineId?: string; reason: string };

/** Keep qty & price as strings while editing to avoid focus thrash */
type MvQuoteLine = { id: string; description: string; qtyStr: string; unitPriceStr: string };

type MvQuoteAnalysis = {
  totalEntered: number;
  totalFair: { min: number; max: number };
  flags: MvFlag[];
  suggestions: string[];
};

/* DB model for scheduled services */
type ScheduledService = {
  _id: string;
  vehicleId: string;
  service: string;      // human label typed by user
  itemKey: string;      // normalized key
  dateISO: string;      // yyyy-mm-dd
  notes?: string;
  createdAt?: string;
};

/* ─── Helpers ─── */
const moneyUSD = (n?: number) => (typeof n === "number" ? `$${n.toFixed(0)}` : "—");
const currencySymbol = (code?: string) => {
  const c = (code || "").toUpperCase();
  if (c === "USD") return "$";
  if (c === "PKR") return "₨";
  if (c === "EUR") return "€";
  if (c === "GBP") return "£";
  return c ? `${c} ` : "$";
};
const money = (n?: number, cur?: string) =>
  (typeof n === "number" ? `${currencySymbol(cur)}${n.toFixed(0)}` : "—");

const shortId = () => Math.random().toString(36).slice(2, 9);

const daysBetween = (aISO: string, bISO: string) => {
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / (24 * 3600 * 1000));
};
const addDays = (iso: string, d: number) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  t.setDate(t.getDate() + d);
  return t.toISOString().slice(0, 10);
};

function normalizeServiceKey(raw: string) {
  const s = (raw || "").toLowerCase();
  if (s.includes("oil")) return "oil_change";
  if (s.includes("brake")) return "brake_pads";
  if (s.includes("air filter") || s.includes("engine filter")) return "air_filter";
  if (s.includes("cabin") || s.includes("pollen")) return "cabin_filter";
  if (s.includes("coolant") || s.includes("radiator")) return "coolant";
  if (s.includes("tire") || s.includes("tyre")) return "tires";
  if (s.includes("spark")) return "spark_plugs";
  if (s.includes("transmission")) return "transmission_fluid";
  if (s.includes("battery")) return "battery";
  if (s.includes("wiper")) return "wiper_blades";
  return s.replace(/[^a-z0-9_]+/g, "_");
}

/** Same rule map you’re using elsewhere (estimates only for schedule hints) */
const RULES: Record<
  "oil_change" | "cabin_filter" | "air_filter" | "coolant" | "spark_plugs" | "transmission_fluid",
  { km?: number; days?: number; label: string; est?: [number, number]; hints?: string[] }
> = {
  oil_change: { km: 8000, days: 365, label: "Oil Change", est: [45, 120], hints: ["Use spec oil (0W-20/5W-30)", "Reset oil-life monitor"] },
  cabin_filter: { km: 15000, days: 730, label: "Cabin Air Filter", est: [15, 40] },
  air_filter: { km: 20000, days: 730, label: "Engine Air Filter", est: [15, 50] },
  coolant: { km: 100000, days: 1825, label: "Coolant Service", est: [80, 200] },
  spark_plugs: { km: 100000, days: 2920, label: "Spark Plugs", est: [120, 300] },
  transmission_fluid: { km: 60000, days: 1460, label: "Transmission Fluid", est: [120, 280] },
};

type UpcomingRow = {
  key: keyof LastMaintenance | string;
  title: string;
  dueInKm?: number;
  dueInDays?: number;
  nextAtKm?: number;
  nextAtDateISO?: string;
  est?: [number, number];
  hints?: string[];
};

function buildUpcomingAll(lm: LastMaintenance | undefined, currentMileage?: number, dailyDriveKm?: number): UpcomingRow[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows: UpcomingRow[] = [];

  (Object.keys(RULES) as (keyof typeof RULES)[]).forEach((key) => {
    const rule = RULES[key];
    const seed = lm?.[key];
    if (!seed?.date && typeof seed?.mileage !== "number") return;

    let dueKm: number | undefined;
    let nextAtKm: number | undefined;
    if (typeof seed?.mileage === "number" && typeof rule.km === "number" && typeof currentMileage === "number") {
      nextAtKm = seed.mileage + rule.km;
      dueKm = nextAtKm - currentMileage;
    }

    let dueDays: number | undefined;
    let nextAtDateISO: string | undefined;
    if (seed?.date && typeof rule.days === "number") {
      const nextDate = addDays(seed.date, rule.days);
      if (nextDate) {
        nextAtDateISO = nextDate;
        const d = daysBetween(today, nextDate);
        if (typeof d === "number") dueDays = d;
      }
    }

    if (dueDays === undefined && typeof dueKm === "number" && dueKm >= 0 && dailyDriveKm && dailyDriveKm > 0) {
      dueDays = Math.ceil(dueKm / dailyDriveKm);
    }

    rows.push({ key, title: rule.label, dueInKm: dueKm, dueInDays: dueDays, nextAtKm, nextAtDateISO, est: rule.est, hints: rule.hints });
  });

  rows.sort((a, b) => {
    const urgencyRank = (r: UpcomingRow) => {
      const overdue = (typeof r.dueInKm === "number" && r.dueInKm < 0) || (typeof r.dueInDays === "number" && r.dueInDays < 0);
      const soon = (typeof r.dueInKm === "number" && r.dueInKm <= 1500) || (typeof r.dueInDays === "number" && r.dueInDays <= 30);
      return overdue ? 0 : soon ? 1 : 2;
    };
    const d = urgencyRank(a) - urgencyRank(b);
    if (d !== 0) return d;
    const aDue = Math.min(a.dueInKm ?? Infinity, a.dueInDays ?? Infinity);
    const bDue = Math.min(b.dueInKm ?? Infinity, b.dueInDays ?? Infinity);
    return aDue - bDue;
  });

  return rows;
}

const verdictColor = (v: "overpriced" | "fair" | "unknown") =>
  v === "overpriced" ? "#b91c1c" : v === "fair" ? "#2563eb" : "#6b7280";

/* ─────────────────────────────────────────────────────────────────────────────
   OCR parsing (kept as-is)
   ─────────────────────────────────────────────────────────────────────────── */
function parseItemsFromOCRText(text: string): QuoteItem[] {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const results: QuoteItem[] = [];

  for (const raw of lines) {
    let line = raw;

    if (/\bsubtotal\b|\btotal\b|\bgrand total\b/i.test(line)) continue;

    let qty = 1;
    const qtyHit =
      /(?:^|\s)(?:qty[: ]*)?x\s*(\d+(?:\.\d+)?)\b/i.exec(line) ||
      /(?:^|\s)(\d+(?:\.\d+)?)\s*x\b/i.exec(line) ||
      /qty[: ]+(\d+(?:\.\d+)?)\b/i.exec(line);
    if (qtyHit) {
      qty = Math.max(1, Number(qtyHit[1]) || 1);
      line = line.replace(qtyHit[0], " ").trim();
    }

    let label = line;
    let price: number | undefined;
    let m =
      /(.*?)(?:@|:)?\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(label) ||
      /(.*?)[^\d$](\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(label);

    if (m) {
      const dollars = Number((m[2] || "").replace(/,/g, ""));
      const cents = m[3] ? Number(m[3]) / 100 : 0;
      price = dollars + cents;
      label = (m[1] || label).trim().replace(/[•\-–:]+$/, "").trim();
    }

    if (price == null || !isFinite(price)) continue;

    const key = normalizeServiceKey(label);

    results.push({
      key,
      label: label || "Service",
      qty,
      price,
    });
  }

  return results;
}

/* ─── Main ─── */
type Tab = "upcoming" | "history" | "quote" | "schedule";

export default function MaintenanceRepairsScreen() {
  const { token } = useAuth();

  const [tab, setTab] = useState<Tab>("upcoming");
  const [vehicles, setVehicles] = useState<MvVehicleLite[]>([]);
  const [vehicleId, setVehicleId] = useState<string | undefined>(undefined);
  const [odoKm, setOdoKm] = useState<string>("");

  const [history, setHistory] = useState<MvServiceRecord[]>([]);
  const [historyFilter, setHistoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Quote checker
  const [qcLines, setQcLines] = useState<MvQuoteLine[]>([
    { id: shortId(), description: "", qtyStr: "1", unitPriceStr: "" },
  ]);
  const [qcAttach, setQcAttach] = useState<{ uri?: string; name?: string; mime?: string; webFile?: any; file?: any } | null>(null);
  const [qcIncludeAttachment, setQcIncludeAttachment] = useState(true);
  const [qcBusy, setQcBusy] = useState(false);
  const [qcResult, setQcResult] = useState<MvQuoteAnalysis | null>(null);

  // NEW: AI compare table
  const [pricingRows, setPricingRows] = useState<PricingCompareRow[] | null>(null);

  // Add-record form
  const [recKind, setRecKind] = useState("Oil Change");
  const [recDate, setRecDate] = useState(new Date().toISOString().slice(0, 10));
  const [recOdo, setRecOdo] = useState("");
  const [recCost, setRecCost] = useState("");
  const [recNotes, setRecNotes] = useState("");

  // SCHEDULE state
  const [schedService, setSchedService] = useState("");
  const [schedDate, setSchedDate] = useState(new Date().toISOString().slice(0, 10));
  const [schedNotes, setSchedNotes] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [scheduled, setScheduled] = useState<ScheduledService[]>([]);

  // real-time ticker to auto-decrement “days remaining”
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const selectedVehicle = useMemo(() => vehicles.find((v) => v._id === vehicleId), [vehicles, vehicleId]);
  const currentOdo = useMemo(() => Number(odoKm || selectedVehicle?.odometerKm || 0) || 0, [odoKm, selectedVehicle]);

  const upcomingAll: MvScheduleItem[] = useMemo(() => {
    const v = selectedVehicle;
    if (!v) return [];
    // include nowTick so “days remaining” re-computes as time passes
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = nowTick;
    const rows = buildUpcomingAll(v.last_maintenance, v.odometerKm, v.dailyDriveKm);
    return rows.map((r) => {
      const overdue = (typeof r.dueInKm === "number" && r.dueInKm < 0) || (typeof r.dueInDays === "number" && r.dueInDays < 0);
      const soon = (typeof r.dueInKm === "number" && r.dueInKm <= 1500) || (typeof r.dueInDays === "number" && r.dueInDays <= 30);
      const urgency: MvScheduleItem["urgency"] = overdue ? "overdue" : (soon ? "soon" : "upcoming");
      return {
        key: r.key,
        title: r.title,
        dueInKm: r.dueInKm,
        dueInDays: r.dueInDays,
        nextAtKm: r.nextAtKm,
        nextAtDateISO: r.nextAtDateISO,
        estCostMin: r.est?.[0],
        estCostMax: r.est?.[1],
        urgency,
        hints: r.hints,
      };
    });
  }, [selectedVehicle, nowTick]);

  /* Vehicles */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setLoading(false); return; }
      try {
        const vs = await apiGetVehicles(token);
        if (cancelled) return;
        const lite: MvVehicleLite[] = (vs || []).map((v: Vehicle) => ({
          _id: v._id,
          year: v.year, make: v.make, model: v.model,
          label: [v.year, v.make, v.model].filter(Boolean).join(" ") || (v as any).name || (v as any).nickname || "My Car",
          odometerKm: v.mileage ?? (v as any)?.current_mileage,
          dailyDriveKm: (v as any)?.dailyDriveKm,
          last_maintenance: v.last_maintenance,
        }));
        setVehicles(lite);
        if (!vehicleId && lite.length) setVehicleId(lite[0]._id);
      } catch (e: any) {
        console.error("[Maintenance] init vehicles error:", e?.message || e);
        Alert.alert("Load error", e?.message ?? "Could not load vehicles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  /* History loader */
  const mapQuotesToHistory = (rows: any[], vid: string): MvServiceRecord[] =>
    (rows || []).map((q) => ({
      _id: q._id,
      vehicleId: q.vehicleId ?? vid,
      dateISO: q.dateISO || q.createdAt || new Date().toISOString(),
      odometerKm: q.odometerKm ?? undefined,
      kind: q.kind || q.summary || q.title || "Maintenance",
      cost: typeof q.cost === "number" ? q.cost : (typeof q.total === "number" ? q.total : undefined),
      notes: q.notes || "",
      provider: q.provider || q.shop || undefined,
    }));

  const loadHistory = useCallback(async (vid: string) => {
    if (!token) return;
    try {
      const rows = await apiGetMaintenanceHistory(token, vid);
      const mapped = mapQuotesToHistory(rows as any[], vid);
      setHistory(mapped);
    } catch (e: any) {
      console.error("[Maintenance] history load error:", e?.message || e);
      setHistory([]);
    }
  }, [token]);

  useEffect(() => { if (vehicleId) loadHistory(vehicleId); }, [vehicleId, loadHistory]);

  /* ── Scheduled services ── */
  const loadScheduled = useCallback(async (vid: string) => {
    if (!token) return;
    try {
      const list = await apiListScheduledServices(token, vid);
      const normalized = (list || []).map((s: any) => ({ vehicleId: vid, ...s })) as ScheduledService[];
      setScheduled(normalized);
    } catch (e: any) {
      console.error("[Maintenance] loadScheduled error:", e?.message || e);
      setScheduled([]);
    }
  }, [token]);

  useEffect(() => { if (vehicleId) loadScheduled(vehicleId); }, [vehicleId, loadScheduled]);

  /** NOTE: moved below loadScheduled and added it to deps */
  const onRefresh = useCallback(async () => {
    if (!vehicleId) return;
    setRefreshing(true);
    try {
      await Promise.all([loadHistory(vehicleId), loadScheduled(vehicleId)]);
    } finally { setRefreshing(false); }
  }, [vehicleId, loadHistory, loadScheduled]);

  const addScheduled = useCallback(async () => {
    if (!token || !vehicleId) return;
    const serviceTrim = (schedService || "").trim();
    const dateShort = (schedDate || "").slice(0, 10);
    if (!serviceTrim) { Alert.alert("Missing service", "Please enter the service name."); return; }
    if (!dateShort) { Alert.alert("Missing date", "Please select a date."); return; }
    const itemKey = normalizeServiceKey(serviceTrim);

    try {
      const created = await apiCreateScheduledService(token, {
        vehicleId,
        service: serviceTrim,
        itemKey,
        dateISO: dateShort,
        notes: schedNotes || undefined,
      });

      const createdRow = { vehicleId, ...(created as any) } as ScheduledService; // ensure vehicleId present
      setScheduled((prev) => [createdRow, ...prev]); // optimistic add
      await loadScheduled(vehicleId);                // refresh from DB (source of truth)

      setSchedService("");
      setSchedNotes("");
      setTab("upcoming");
      Alert.alert("Scheduled", "Your service has been added.");
    } catch (e: any) {
      console.error("[Maintenance] addScheduled error:", e?.message || e);
      Alert.alert("Save error", e?.message ?? "Could not schedule service");
    }
  }, [token, vehicleId, schedService, schedDate, schedNotes, loadScheduled]);

  const deleteScheduled = useCallback(async (row: ScheduledService) => {
    if (!token || !vehicleId) return;
    try {
      await apiDeleteScheduledService(token, vehicleId, row._id);
      setScheduled((prev) => prev.filter((s) => s._id !== row._id));
    } catch (e: any) {
      console.error("[Maintenance] deleteScheduled error:", e?.message || e);
      Alert.alert("Delete failed", e?.message ?? "Could not cancel schedule");
    }
  }, [token, vehicleId]);

  const markScheduledCompleted = useCallback(async (row: ScheduledService) => {
    if (!token || !vehicleId) return;
    const key = row.itemKey || normalizeServiceKey(row.service);
    const dateShort = (row.dateISO || new Date().toISOString()).slice(0, 10);
    const odo = currentOdo || undefined;

    try {
      await apiCompleteMaintenance(token, vehicleId, {
        itemKey: key,
        date: dateShort,
        mileage: odo,
        notes: row.notes,
      });

      // Update local last_maintenance so Upcoming refreshes
      setVehicles((prev) =>
        prev.map((v) => {
          if (v._id !== vehicleId) return v;
          const lm = { ...(v.last_maintenance || {}) } as LastMaintenance;
          (lm as any)[key] = { date: dateShort, mileage: odo };
          return {
            ...v,
            last_maintenance: lm,
            odometerKm: typeof odo === "number" ? odo : v.odometerKm,
          };
        })
      );

      await loadScheduled(vehicleId);
      Alert.alert("Marked complete", `${row.service} saved to history.`);
    } catch (e: any) {
      console.error("[Maintenance] markScheduledCompleted error:", e?.message || e);
      Alert.alert("Update failed", e?.message ?? "Could not mark as completed");
    }
  }, [token, vehicleId, currentOdo, loadScheduled]);

  /* Add record (manual) — unchanged */
  const addRecord = async () => {
    if (!vehicleId || !token) return;

    const dateShort = (recDate || "").slice(0, 10);
    const odo = recOdo ? Number(recOdo) : undefined;
    const kindTrim = (recKind || "").trim() || "Service";
    const key = normalizeServiceKey(kindTrim);

    try {
      // Optimistic local update so Upcoming shows next instantly
      setVehicles((prev) =>
        prev.map((v) => {
          if (v._id !== vehicleId) return v;
          const lm = { ...(v.last_maintenance || {}) } as LastMaintenance;
          (lm as any)[key] = { date: `${dateShort}`, mileage: odo };
          return { ...v, last_maintenance: lm, odometerKm: typeof odo === "number" ? odo : v.odometerKm };
        })
      );

      // Persist server-side
      await apiCompleteMaintenance(token, vehicleId, {
        itemKey: key,
        date: dateShort,
        mileage: odo,
        cost: recCost ? Number(recCost) : undefined,
        notes: recNotes || undefined,
      });

      // Optional: save a simple “receipt”
      await apiSaveQuote(token, {
        vehicleId,
        summary: `${kindTrim} (${dateShort})`,
        total: recCost ? Number(recCost) : 0,
        items: [{ key, label: kindTrim, price: recCost ? Number(recCost) : 0, qty: 1 }],
        analysis: { overpriced: [], questionable: [], fair: [{ key, label: kindTrim, price: recCost ? Number(recCost) : 0, qty: 1 }] },
      });

      // Reload + refresh
      try {
        const vs = await apiGetVehicles(token);
        const lite: MvVehicleLite[] = (vs || []).map((v: Vehicle) => ({
          _id: v._id,
          year: v.year, make: v.make, model: v.model,
          label: [v.year, v.make, v.model].filter(Boolean).join(" "),
          odometerKm: v.mileage ?? (v as any)?.current_mileage,
          dailyDriveKm: (v as any)?.dailyDriveKm,
          last_maintenance: v.last_maintenance,
        }));
        setVehicles(lite);
      } catch {}

      await onRefresh();

      // Reset form
      setRecKind("Oil Change");
      setRecDate(new Date().toISOString().slice(0, 10));
      setRecOdo("");
      setRecCost("");
      setRecNotes("");

      Alert.alert("Saved", "Service record added");
    } catch (e: any) {
      console.error("[Maintenance] addRecord error:", e?.message || e);
      Alert.alert("Save error", e?.message ?? "Could not save record");
    }
  };

  /* Mark rule-based upcoming as completed — unchanged */
  const markUpcomingCompleted = async (row: MvScheduleItem) => {
    if (!vehicleId || !token) return;
    const key = String(row.key);
    const todayShort = new Date().toISOString().slice(0, 10);
    const odo = currentOdo || undefined;

    const snapshot = vehicles;

    try {
      // Optimistic local update
      setVehicles((prev) =>
        prev.map((v) => {
          if (v._id !== vehicleId) return v;
          const lm = { ...(v.last_maintenance || {}) } as LastMaintenance;
          (lm as any)[key] = { date: todayShort, mileage: odo };
          return { ...v, last_maintenance: lm, odometerKm: typeof odo === "number" ? odo : v.odometerKm };
        })
      );

      // Persist
      await apiCompleteMaintenance(token, vehicleId, {
        itemKey: key,
        date: todayShort,
        mileage: odo,
      });

      // Optional receipt entry
      await apiSaveQuote(token, {
        vehicleId,
        summary: `${row.title} (${todayShort})`,
        total: 0,
        items: [{ key, label: row.title, price: 0, qty: 1 }],
        analysis: { overpriced: [], questionable: [], fair: [{ key, label: row.title, price: 0, qty: 1 }] },
      });

      // Pull fresh snapshot & refresh
      try {
        const vs = await apiGetVehicles(token);
        const lite: MvVehicleLite[] = (vs || []).map((v: Vehicle) => ({
          _id: v._id,
          year: v.year, make: v.make, model: v.model,
          label: [v.year, v.make, v.model].filter(Boolean).join(" "),
          odometerKm: v.mileage ?? (v as any)?.current_mileage,
          dailyDriveKm: (v as any)?.dailyDriveKm,
          last_maintenance: v.last_maintenance,
        }));
        setVehicles(lite);
      } catch {}

      await onRefresh();
      Alert.alert("Marked complete", `${row.title} saved to history.`);
    } catch (e: any) {
      console.error("[Maintenance] markUpcomingCompleted error:", e?.message || e);
      setVehicles(snapshot); // rollback
      Alert.alert("Update failed", e?.message ?? "Could not mark as completed");
    }
  };

  /* Quote checker — UPDATED to use Gemini compare with vehicle attrs */
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

      if ((res as any).canceled) return;

      const asset = (res as any).assets?.[0];
      const fileFromOutput: any = (res as any).output?.[0];
      const pickedName = asset?.name || fileFromOutput?.name || `quote-${Date.now()}`;
      const pickedMime = asset?.mimeType || asset?.mime || fileFromOutput?.type;

      setQcAttach({
        uri: asset?.uri || undefined,
        name: pickedName,
        mime: pickedMime,
        webFile: fileFromOutput || asset?.file || undefined,
        file: fileFromOutput || undefined,
      });
    } catch (e: any) {
      console.error("[Maintenance/Repairs] pickAttachment error:", e?.message || e);
      Alert.alert("Pick error", e?.message ?? "Could not pick a file");
    }
  };

  const analyzeQuote = async () => {
    if (!vehicleId || !token) return;

    // Require vehicle attrs for Gemini assessment
    const mk = (selectedVehicle?.make || "").trim();
    const mdl = (selectedVehicle?.model || "").trim();
    const yr = Number(selectedVehicle?.year || 0);
    if (!mk || !mdl || !yr) {
      Alert.alert("Vehicle details needed", "Please ensure your vehicle has make, model, and year.");
      return;
    }

    setQcBusy(true);
    setQcResult(null);
    setPricingRows(null);
    try {
      const manualItems: QuoteItem[] = qcLines
        .map((l) => ({
          description: l.description,
          qty: Math.max(1, Number(l.qtyStr) || 1),
          unitPrice: Number(l.unitPriceStr) || 0,
        }))
        .filter((x) => (x.description || "").trim().length > 0 || x.unitPrice > 0)
        .map((x) => ({
          key: normalizeServiceKey(x.description),
          label: x.description || "Service",
          qty: x.qty,
          price: x.unitPrice,
        }));
      const totalEnteredManual = manualItems.reduce((s, it) => s + (it.qty || 1) * (it.price || 0), 0);

      let ocrText = "";
      let ocrItems: QuoteItem[] = [];
      if (qcAttach && qcIncludeAttachment) {
        try {
          const ocr = await apiPostOCRQuote(
            token,
            {
              webFile: qcAttach.webFile || qcAttach.file,
              uri: qcAttach.uri,
              name: qcAttach.name || `quote-${Date.now()}`,
              type: qcAttach.mime || "image/jpeg",
            } as any
          );

          if ((ocr as any)?.not_quote) {
            Alert.alert(
              "Not a quote",
              "Please upload a computer-generated quote (PDF/printed). The image you uploaded didn’t look like a quote."
            );
            setQcBusy(false);
            return;
          }

          ocrText = (ocr as any)?.text || "";
          ocrItems = parseItemsFromOCRText(ocrText);
        } catch (err: any) {
          if (err?.status === 422 || err?.details?.not_quote) {
            Alert.alert(
              "Not a quote",
              "Please upload a computer-generated quote (PDF/printed). The image you uploaded didn’t look like a quote."
            );
            setQcBusy(false);
            return;
          }
          throw err;
        }
      }

      const workingItems: QuoteItem[] = [...manualItems, ...ocrItems];
      const manualTextBlock =
        qcLines
          .filter((l) => (l.description || l.unitPriceStr))
          .map((l) => `${l.description || "Item"} x${l.qtyStr || "1"} @ ${l.unitPriceStr || "0"}`)
          .join("\n");

      const combinedRawText = [
        ocrText ? `OCR:\n${ocrText}` : "",
        manualTextBlock ? `MANUAL:\n${manualTextBlock}` : "",
      ].filter(Boolean).join("\n\n");

      if (!workingItems.length) {
        try {
          await apiSaveQuote(token, {
            vehicleId,
            summary: `Quote ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
            total: 0,
            items: [],
            analysis: { overpriced: [], questionable: [], fair: [] },
            rawText: combinedRawText || "(no text)",
          });
          await onRefresh();
        } catch {}
        Alert.alert("Saved", "Captured the quote text. Couldn’t extract line-items.");
        setQcBusy(false);
        return;
      }

      // Build compare body for Gemini
      const compareItems = workingItems.map((it) => ({
        key: it.key,
        label: it.label,
        qty: it.qty || 1,
        price: it.price || 0,
      }));

      const compareResp = await apiPricingCompare(token, {
        vehicle_make: mk,
        vehicle_model: mdl,
        vehicle_year: yr,
        currency: "PKR",            // optional: switch if your quotes are in another currency
        location_city: null,
        location_country: "PK",     // optional hint
        items: compareItems,
      });

      const table = compareResp?.table || [];
      setPricingRows(table);

      // Aggregate AI fair totals
      const fairMin = table.reduce((s, r) => s + (r.ai_range_min ?? 0) * (r.qty || 1), 0);
      const fairMax = table.reduce((s, r) => s + (r.ai_range_max ?? 0) * (r.qty || 1), 0);
      const totalEntered = workingItems.reduce((s, it) => s + (it.qty || 1) * (it.price || 0), 0);

      const primaryCurrency = table[0]?.ai_currency || "PKR";

      const flags: MvFlag[] = [];
      table.forEach((r) => {
        if (r.ai_verdict === "overpriced") {
          const over = typeof r.delta_pct_vs_ai_mid === "number"
            ? ` (+${r.delta_pct_vs_ai_mid.toFixed(0)}%)` : "";
          flags.push({ lineId: r.service, reason: `Overpriced: ${r.service}${over}` });
        } else if (r.ai_verdict === "unknown") {
          flags.push({ lineId: r.service, reason: `Low confidence: ${r.service} (AI needs more context/data)` });
        }
      });

      const suggestions: string[] = [];
      if (table.some((r) => r.ai_verdict === "overpriced")) {
        suggestions.push("Ask for parts vs labor breakdown and itemized fees.");
        suggestions.push("Request justification (OEM vs aftermarket, brand/grade, warranty).");
      }
      if (table.some((r) => r.ai_verdict === "unknown")) {
        suggestions.push("Rephrase item names (e.g., 'oil change', 'brake pads') for clearer assessment.");
      }

      const result: MvQuoteAnalysis = { totalEntered, totalFair: { min: fairMin, max: fairMax }, flags, suggestions };
      setQcResult(result);

      // Save quote (store the original items; analysis buckets by AI verdict)
      try {
        await apiSaveQuote(token, {
          vehicleId,
          summary: `Quote ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          total: totalEntered,
          items: workingItems,
          analysis: {
            overpriced: workingItems.filter((it) =>
              table.some((r) => r.service === it.label && r.ai_verdict === "overpriced")
            ),
            questionable: workingItems.filter((it) =>
              table.some((r) => r.service === it.label && r.ai_verdict === "unknown")
            ),
            fair: workingItems.filter((it) =>
              table.some((r) => r.service === it.label && r.ai_verdict === "fair")
            ),
          },
          rawText: combinedRawText || undefined,
        });
        await onRefresh();
      } catch {}

      // Crowdsourced: submit user samples (still allowed)
      try {
        await apiPricingSubmitSamples(token, {
          vehicleId,
          region: "GLOBAL",
          city: null,
          currency: primaryCurrency,
          items: workingItems.map((it) => ({
            key: it.key,
            label: it.label,
            qty: it.qty,
            price: it.price,
            total: (it.qty || 1) * (it.price || 0),
          })),
        });
      } catch {}

      Alert.alert(
        "Analysis Complete",
        `Items: ${workingItems.length}\nEntered: ${money(totalEntered, primaryCurrency)}\nAI fair: ${money(fairMin, primaryCurrency)}–${money(fairMax, primaryCurrency)}`
      );
    } catch (e: any) {
      console.error("[Maintenance/Repairs] analyzeQuote error:", e?.message || e);
      Alert.alert("Analysis failed", e?.message ?? "Could not analyze the quote");
    } finally {
      setQcBusy(false);
    }
  };

  /* ── Shared input props ── */
  const textInputCommon = {
    autoCorrect: false as const,
    autoCapitalize: "none" as const,
  };
  const numericInputProps = {
    ...textInputCommon,
    keyboardType: Platform.OS === "web" ? ("default" as const) : ("numeric" as const),
    ...(Platform.OS === "web" ? { inputMode: "numeric" as const } : {}),
  };

  /* ── Render callbacks ── */
  const renderVehicleChips = useCallback(() => (
    vehicles.length ? (
      <FlatList
        data={vehicles}
        keyExtractor={(v) => v._id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, marginTop: 10 }}
        renderItem={({ item }) => {
          const active = item._id === vehicleId;
          return (
            <Pressable onPress={() => setVehicleId(item._id)} style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          );
        }}
      />
    ) : null
  ), [vehicles, vehicleId]);

  /** Merge rule-based Upcoming + DB-scheduled items into one list */
  const upcomingDisplay: MvScheduleItemExt[] = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);

    const base = upcomingAll.map((r) => ({ ...r } as MvScheduleItemExt));

    const extra = (scheduled || [])
      .filter((s) => s.vehicleId === vehicleId)
      .map<MvScheduleItemExt>((s) => {
        const dLeft = typeof daysBetween(today, (s.dateISO || "").slice(0, 10)) === "number"
          ? (daysBetween(today, (s.dateISO || "").slice(0, 10)) as number)
          : undefined;

        const overdue = typeof dLeft === "number" && dLeft < 0;
        const soon = typeof dLeft === "number" && dLeft <= 30 && dLeft >= 0;
        const urgency: MvScheduleItem["urgency"] = overdue ? "overdue" : (soon ? "soon" : "upcoming");

        return {
          _scheduled: s,
          key: s.itemKey || s.service,
          title: s.service,
          dueInDays: dLeft,
          nextAtDateISO: (s.dateISO || "").slice(0, 10),
          estCostMin: undefined,
          estCostMax: undefined,
          dueInKm: undefined,
          urgency,
          hints: s.notes ? [s.notes] : undefined,
        };
      });

    const all = [...extra, ...base];

    all.sort((a, b) => {
      const ur = (r: MvScheduleItemExt) => {
        const overdue = (typeof r.dueInKm === "number" && r.dueInKm < 0) || (typeof r.dueInDays === "number" && r.dueInDays < 0);
        const soon = (typeof r.dueInKm === "number" && r.dueInKm <= 1500) || (typeof r.dueInDays === "number" && r.dueInDays <= 30);
        return overdue ? 0 : soon ? 1 : 2;
      };
      const d = ur(a) - ur(b);
      if (d !== 0) return d;
      const aDue = Math.min(a.dueInKm ?? Infinity, a.dueInDays ?? Infinity);
      const bDue = Math.min(b.dueInKm ?? Infinity, b.dueInDays ?? Infinity);
      return aDue - bDue;
    });

    return all;
  }, [upcomingAll, scheduled, vehicleId, nowTick]);

  const renderUpcomingSection = useCallback(() => (
    <FlatList
      data={upcomingDisplay}
      keyExtractor={(i, idx) => `${String(i.key)}_${i._scheduled ? "s" : "r"}_${idx}`}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={
        <View>
          <Text style={styles.sectionHeader}>Upcoming</Text>
          {renderVehicleChips()}
          <View style={[styles.card, { marginTop: 12 }]}>
            <Text style={styles.cardTitle}>Current Odometer (km)</Text>
            <TextInput
              {...numericInputProps}
              value={odoKm}
              onChangeText={setOdoKm}
              placeholder={String(selectedVehicle?.odometerKm ?? 0)}
              placeholderTextColor="#9aa3af"
              style={styles.input}
            />
            <Text style={styles.mutedSmall}>Used for mileage-based due dates.</Text>
          </View>
        </View>
      }
      
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={[styles.badge, { borderColor: urgencyColor(item), color: urgencyColor(item) }]}>
              {((typeof item.dueInKm === "number" && item.dueInKm < 0) || (typeof item.dueInDays === "number" && item.dueInDays < 0))
                ? "OVERDUE" : (((typeof item.dueInKm === "number" && item.dueInKm <= 1500) || (typeof item.dueInDays === "number" && item.dueInDays <= 30))
                ? "SOON" : "UPCOMING")}
            </Text>
          </View>
          <Text style={styles.mutedSmall}>
            {(typeof item.dueInKm === "number") ? `Distance: ${item.dueInKm >= 0 ? item.dueInKm + " km" : Math.abs(item.dueInKm) + " km overdue"}` : ""}
            {(typeof item.dueInKm === "number" && typeof item.dueInDays === "number") ? " • " : ""}
            {(typeof item.dueInDays === "number") ? `Time: ${item.dueInDays >= 0 ? item.dueInDays + " days" : Math.abs(item.dueInDays) + " days overdue"}` : ""}
          </Text>
          {item.nextAtDateISO && <Text style={styles.mutedSmall}>Target date: {item.nextAtDateISO}</Text>}
          <Text style={styles.mutedSmall}>
            Est. cost: {moneyUSD(item.estCostMin)}–{moneyUSD(item.estCostMax)}
          </Text>
          {!!item.hints?.length && (
            <>
              <Text style={styles.subheading}>Hints</Text>
              {item.hints.map((h, i) => (
                <View key={`hint-${i}`} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>{h}</Text>
                </View>
              ))}
            </>
          )}
          <View style={[styles.row, { gap: 8, marginTop: 10, flexWrap: "wrap" }]}>
            <Pressable
              style={styles.btnSecondary}
              onPress={() => item._scheduled ? markScheduledCompleted(item._scheduled) : markUpcomingCompleted(item)}
            >
              <Text style={styles.btnSecondaryText}>Mark as Completed</Text>
            </Pressable>
            {item._scheduled && (
              <Pressable style={styles.btnGhost} onPress={() => deleteScheduled(item._scheduled!)}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
      ListEmptyComponent={
        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={styles.mutedSmall}>No upcoming services found. Add seeds on the Profile screen or mark services in History.</Text>
        </View>
      }
      ListFooterComponent={<View style={{ height: 32 }} />}
      contentContainerStyle={styles.pad}
      keyboardShouldPersistTaps="handled"
      removeClippedSubviews={false}
    />
  ), [upcomingDisplay, refreshing, onRefresh, renderVehicleChips, numericInputProps, odoKm, selectedVehicle, markUpcomingCompleted, deleteScheduled, markScheduledCompleted]);

  const filteredHistory = useMemo(
    () => history.filter(h => (h.kind || "").toLowerCase().includes(historyFilter.toLowerCase())),
    [history, historyFilter]
  );

  const renderHistorySection = useCallback(() => (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionHeader}>History</Text>
      {renderVehicleChips()}

      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.cardTitle}>Add Service Record</Text>
        <Text style={styles.label}>Service</Text>
        <TextInput {...textInputCommon} value={recKind} onChangeText={setRecKind} placeholder="e.g., Oil Change" placeholderTextColor="#9aa3af" style={styles.input} />
        <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
        <TextInput {...textInputCommon} value={recDate} onChangeText={setRecDate} placeholder="2025-08-20" placeholderTextColor="#9aa3af" style={styles.input} />
        <Text style={styles.label}>Odometer (km)</Text>
        <TextInput {...numericInputProps} value={recOdo} onChangeText={setRecOdo} placeholder="e.g., 84500" placeholderTextColor="#9aa3af" style={styles.input} />
        <Text style={styles.label}>Cost</Text>
        <TextInput {...numericInputProps} value={recCost} onChangeText={setRecCost} placeholder="e.g., 95" placeholderTextColor="#9aa3af" style={styles.input} />
        <Text style={styles.label}>Notes</Text>
        <TextInput {...textInputCommon} value={recNotes} onChangeText={setRecNotes} placeholder="Optional notes…" placeholderTextColor="#9aa3af" style={styles.input} multiline />
        <View style={[styles.row, { marginTop: 8 }]}>
          <Pressable style={styles.btnSecondary} onPress={addRecord}>
            <Text style={styles.btnSecondaryText}>Save Record</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.cardTitle}>Search History</Text>
        <TextInput {...textInputCommon} value={historyFilter} onChangeText={setHistoryFilter} placeholder="Search service history…" placeholderTextColor="#9aa3af" style={styles.input} />
      </View>

      {filteredHistory.map((r) => (
        <View key={r._id || `${r.dateISO}-${r.kind}`} style={styles.card}>
          <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
            <Text style={styles.cardTitle}>{r.kind}</Text>
            <Text style={[styles.badge, { borderColor: "#16a34a", color: "#16a34a" }]}>DONE</Text>
          </View>
          <Text style={styles.mutedSmall}>Date: {r.dateISO?.slice(0, 10) || "—"}</Text>
          {!!r.odometerKm && <Text style={styles.mutedSmall}>Odometer: {r.odometerKm} km</Text>}
          {!!r.cost && <Text style={styles.mutedSmall}>Cost: {moneyUSD(r.cost)}</Text>}
          {!!r.notes && (<Text style={[styles.mutedSmall, { marginTop: 6 }]}>{r.notes}</Text>)}
        </View>
      ))}

      <View style={{ height: 32 }} />
    </ScrollView>
  ), [renderVehicleChips, textInputCommon, numericInputProps, recKind, recDate, recOdo, recCost, recNotes, filteredHistory]);

  const renderQuoteCheckerSection = useCallback(() => (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionHeader}>Quote Checker</Text>
      {renderVehicleChips()}

      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.cardTitle}>Line Items</Text>
        <Text style={styles.mutedSmall}>
          Note: only upload computer-generated quotes (PDF/printed). Photos of cars, chats, or hand-written notes won’t be analyzed.
        </Text>

        {qcLines.map((ln) => (
          <View key={ln.id} style={[styles.row, { gap: 8, marginTop: 8, flexWrap: "wrap" }]}>
            <TextInput
              {...textInputCommon}
              value={ln.description}
              onChangeText={(t) => setQcLines((prev) => prev.map((l) => l.id === ln.id ? { ...l, description: t } : l))}
              placeholder="Item (e.g., Brake pads & rotors)"
              placeholderTextColor="#9aa3af"
              style={[styles.input, { flex: 1, minWidth: 200 }]}
            />
            <TextInput
              {...numericInputProps}
              value={ln.qtyStr}
              onChangeText={(t) => setQcLines((prev) => prev.map((l) =>
                l.id === ln.id ? { ...l, qtyStr: t.replace(/[^\d]/g, "") } : l))}
              placeholder="Qty"
              placeholderTextColor="#9aa3af"
              style={[styles.input, { width: 80 }]}
            />
            <TextInput
              {...numericInputProps}
              value={ln.unitPriceStr}
              onChangeText={(t) => setQcLines((prev) => prev.map((l) =>
                l.id === ln.id ? { ...l, unitPriceStr: t.replace(/[^\d.]/g, "") } : l))}
              placeholder="Unit Price"
              placeholderTextColor="#9aa3af"
              style={[styles.input, { width: 160 }]}
            />
            <Pressable style={styles.btnGhost} onPress={() => setQcLines((prev) => prev.filter((l) => l.id !== ln.id))}>
              <Text style={styles.btnGhostText}>Remove</Text>
            </Pressable>
          </View>
        ))}
        <View style={[styles.row, { gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }]}>
          <Pressable
            style={styles.btnSecondary}
            onPress={() => setQcLines((prev) => [...prev, { id: shortId(), description: "", qtyStr: "1", unitPriceStr: "" }])}
          >
            <Text style={styles.btnSecondaryText}>+ Add Line</Text>
          </Pressable>

          <View style={styles.attachRow}>
            <Switch value={qcIncludeAttachment} onValueChange={setQcIncludeAttachment} />
            <Text style={styles.mutedSmall}>Attach photo/PDF</Text>

            <Pressable
              style={[styles.btnSecondary, styles.btnInline, !DocumentPicker && { opacity: 0.6 }]}
              onPress={pickAttachment}
              disabled={!DocumentPicker}
            >
              <Text style={styles.btnSecondaryText} numberOfLines={1} ellipsizeMode="tail">
                {qcAttach ? "Change Attachment" : "Pick Attachment"}
              </Text>
            </Pressable>

            {/* filename always fits; drops below on small widths */}
            <View style={styles.filenameWrap}>
              <Text style={styles.filenameText} numberOfLines={1} ellipsizeMode="middle">
                {qcAttach?.name || (!DocumentPicker ? "Install expo-document-picker to enable" : "No file selected")}
              </Text>
            </View>
          </View>

        </View>

        <View style={[styles.row, { gap: 8, marginTop: 10, flexWrap: "wrap" }]}>
          <Pressable style={styles.btnPrimary} onPress={analyzeQuote} disabled={qcBusy}>
            <Text style={styles.btnPrimaryText}>{qcBusy ? "Analyzing…" : "Analyze Quote"}</Text>
          </Pressable>
          <Pressable
            style={styles.btnGhost}
            onPress={() => {
              setQcResult(null);
              setPricingRows(null);
              setQcLines([{ id: shortId(), description: "", qtyStr: "1", unitPriceStr: "" }]);
              setQcAttach(null);
            }}
          >
            <Text style={styles.btnGhostText}>Clear</Text>
          </Pressable>
        </View>
      </View>

      {qcResult && (
        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={styles.cardTitle}>Results</Text>
          {/* Use first row currency for the header range/totals */}
          <Text style={styles.mutedSmall}>
            Entered total: {money(qcResult.totalEntered, pricingRows?.[0]?.ai_currency || "PKR")} | AI fair total: {money(qcResult.totalFair.min, pricingRows?.[0]?.ai_currency || "PKR")}–{money(qcResult.totalFair.max, pricingRows?.[0]?.ai_currency || "PKR")}
          </Text>

          {/* AI Comparison table */}
          {pricingRows && pricingRows.length > 0 && (
            <View style={{ marginTop: 10 }}>
              <View style={[styles.row, styles.tableHeader]}>
                <Text style={[styles.th, { flex: 1.5 }]}>Service</Text>
                <Text style={[styles.th, { width: 42, textAlign: "right" }]}>Qty</Text>
                <Text style={[styles.th, { width: 90, textAlign: "right" }]}>Unit</Text>
                <Text style={[styles.th, { width: 100, textAlign: "right" }]}>Total</Text>
                <Text style={[styles.th, { width: 90, textAlign: "right" }]}>AI Min</Text>
                <Text style={[styles.th, { width: 90, textAlign: "right" }]}>AI Max</Text>
                <Text style={[styles.th, { width: 140 }]}>AI Verdict</Text>
              </View>
              {pricingRows.map((r, idx) => {
                const cur = r.ai_currency || "PKR";
                return (
                  <View key={`cmp-${idx}`} style={[styles.row, styles.tr]}>
                    <Text style={[styles.td, { flex: 1.5 }]} numberOfLines={2}>{r.service}</Text>
                    <Text style={[styles.td, { width: 42, textAlign: "right" }]}>{r.qty}</Text>
                    <Text style={[styles.td, { width: 90, textAlign: "right" }]}>{money(r.user_unit, cur)}</Text>
                    <Text style={[styles.td, { width: 100, textAlign: "right" }]}>{money(r.user_total, cur)}</Text>
                    <Text style={[styles.td, { width: 90, textAlign: "right" }]}>{r.ai_range_min != null ? money(r.ai_range_min, cur) : "—"}</Text>
                    <Text style={[styles.td, { width: 90, textAlign: "right" }]}>{r.ai_range_max != null ? money(r.ai_range_max, cur) : "—"}</Text>
                    <Text style={[styles.td, { width: 140, color: verdictColor(r.ai_verdict), fontWeight: "800" }]} numberOfLines={2}>
                      {r.ai_verdict}
                      {typeof r.delta_pct_vs_ai_mid === "number" ? ` (${r.delta_pct_vs_ai_mid > 0 ? "+" : ""}${r.delta_pct_vs_ai_mid.toFixed(0)}%)` : ""}
                      {typeof r.ai_confidence === "number" ? ` • conf ${Math.round(r.ai_confidence * 100)}%` : ""}
                    </Text>
                  </View>
                );
              })}
              <Text style={[styles.mutedSmall, { marginTop: 6 }]}>
                Currency per row from AI • Assessed by Gemini 1.5-Flash.
              </Text>
            </View>
          )}

          {!!qcResult.flags?.length && (
            <>
              <Text style={styles.subheading}>Flags</Text>
              {qcResult.flags.map((f, i) => (
                <View key={`flag-${i}`} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>{f.reason}</Text>
                </View>
              ))}
            </>
          )}
          {!!qcResult.suggestions?.length && (
            <>
              <Text style={styles.subheading}>Suggestions</Text>
              {qcResult.suggestions.map((s, i) => (
                <View key={`sug-${i}`} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>{s}</Text>
                </View>
              ))}
            </>
          )}
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  ), [renderVehicleChips, qcLines, textInputCommon, numericInputProps, qcIncludeAttachment, qcAttach, qcBusy, qcResult, pricingRows]);

  const renderScheduleSection = useCallback(() => {
    const onChangeDate = (event: any, selected?: Date) => {
      setShowDatePicker(false);
      if (selected) {
        const iso = selected.toISOString().slice(0, 10);
        setSchedDate(iso);
      }
    };
    return (
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionHeader}>Schedule</Text>
        {renderVehicleChips()}

        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={styles.cardTitle}>Schedule Service</Text>

          <Text style={styles.label}>Service Needed</Text>
          <TextInput
            {...textInputCommon}
            value={schedService}
            onChangeText={setSchedService}
            placeholder="e.g., Window repair"
            placeholderTextColor="#9aa3af"
            style={styles.input}
          />

          <Text style={styles.label}>Preferred Date</Text>

          {Platform.OS === "web" ? (
            // @ts-ignore web-only element
            <input
              id="sched-date-input"
              type="date"
              aria-label="Preferred Date"
              title="Preferred Date"
              placeholder="YYYY-MM-DD"
              value={(schedDate || "").slice(0,10)}
              onChange={(e: any) => setSchedDate(String(e.target?.value || "").slice(0,10))}
              style={styles.webDateInput as any}
            />
          ) : !DateTimePicker ? (
            <TextInput
              {...textInputCommon}
              value={schedDate}
              onChangeText={(t) => setSchedDate((t || "").slice(0,10))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#9aa3af"
              style={styles.input}
            />
          ) : (
            <>
              <Pressable style={styles.btnSecondary} onPress={() => setShowDatePicker(true)}>
                <Text style={styles.btnSecondaryText}>{schedDate || "Pick a date"}</Text>
              </Pressable>
              {showDatePicker && (
                <DateTimePicker
                  testID="scheduleDatePicker"
                  value={new Date(schedDate || new Date().toISOString().slice(0,10))}
                  mode="date"
                  display={Platform.OS === "ios" ? "inline" : "default"}
                  onChange={onChangeDate}
                />
              )}
            </>
          )}

          <Text style={styles.label}>Notes</Text>
          <TextInput
            {...textInputCommon}
            value={schedNotes}
            onChangeText={setSchedNotes}
            placeholder="Optional notes…"
            placeholderTextColor="#9aa3af"
            style={styles.input}
            multiline
          />

          <View style={[styles.row, { marginTop: 8, gap: 8, flexWrap: "wrap" }]}>
            <Pressable style={styles.btnSecondary} onPress={addScheduled}>
              <Text style={styles.btnSecondaryText}>Add Service</Text>
            </Pressable>
          </View>
        </View>

        {/* Quick glance of existing scheduled for this vehicle */}
        {scheduled.filter((s) => s.vehicleId === vehicleId).length > 0 && (
          <View style={[styles.card, { marginTop: 12 }]}>
            <Text style={styles.cardTitle}>Your Scheduled Items</Text>
            {scheduled
              .filter((s) => s.vehicleId === vehicleId)
              .sort((a, b) => (a.dateISO || "").localeCompare(b.dateISO || ""))
              .map((s) => (
                <View key={s._id} style={[styles.card, { marginTop: 10 }]}>
                  <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
                    <Text style={styles.cardTitle}>{s.service}</Text>
                    <Text style={[styles.badge, { borderColor: "#2563eb", color: "#2563eb" }]}>SCHEDULED</Text>
                  </View>
                  <Text style={styles.mutedSmall}>Date: {s.dateISO?.slice(0,10) || "—"}</Text>
                  {!!s.notes && <Text style={[styles.mutedSmall, { marginTop: 6 }]}>{s.notes}</Text>}
                  <View style={[styles.row, { gap: 8, marginTop: 10, flexWrap: "wrap" }]}>
                    <Pressable style={styles.btnSecondary} onPress={() => markScheduledCompleted(s)}>
                      <Text style={styles.btnSecondaryText}>Mark as Completed</Text>
                    </Pressable>
                    <Pressable style={styles.btnGhost} onPress={() => deleteScheduled(s)}>
                      <Text style={styles.btnGhostText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    );
  }, [
    renderVehicleChips,
    textInputCommon,
    schedService,
    schedDate,
    schedNotes,
    addScheduled,
    scheduled,
    vehicleId,
    markScheduledCompleted,
    deleteScheduled,
    showDatePicker
  ]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.center, styles.pad]}>
          <Text style={styles.pageTitle}>Maintenance & Repairs</Text>
          <Text style={[styles.muted, { marginTop: 8 }]}>Please log in to view your vehicles.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.pad, { paddingBottom: 0 }]}>
        <Text style={styles.pageTitle}>Maintenance & Repairs</Text>
        <Text style={styles.muted}>Track your vehicle&apos;s service schedule and history, and check quotes.</Text>

        <View style={styles.tabs}>
          {(["upcoming","history","quote","schedule"] as Tab[]).map((t) => {
            const label = t === "upcoming" ? "Upcoming" : t === "history" ? "History" : t === "quote" ? "Quote Checker" : "Schedule";
            const active = tab === t;
            return (
              <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, active && styles.tabActive]}>
                <Text
                  style={[styles.tabText, active && styles.tabTextActive]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  adjustsFontSizeToFit
                  minimumFontScale={0.9}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {tab === "upcoming" && renderUpcomingSection()}
      {tab === "history" && renderHistorySection()}
      {tab === "quote" && renderQuoteCheckerSection()}
      {tab === "schedule" && renderScheduleSection()}
    </SafeAreaView>
  );
}
/* ─── Styles ─── */
const TAB_HEIGHT = 44;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f9ff" },
  pad: { padding: 16 },
  pageTitle: { color: "#0f172a", fontSize: 24, fontWeight: "800" },
  sectionHeader: { color: "#111827", fontSize: 18, fontWeight: "800", marginBottom: 8 },

  /* Tabs: fixed height + single line labels so long text doesn't distort */
  tabs: { flexDirection: "row", marginTop: 12, backgroundColor: "#e5e7eb", borderRadius: 12, padding: 4 },
  tab: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    justifyContent: "center",
    height: TAB_HEIGHT,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  tabActive: {
    backgroundColor: "#ffffff",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 1 },
    }),
  },
  tabText: { color: "#374151", fontWeight: "700", maxWidth: "100%" },
  tabTextActive: { color: "#111827", fontWeight: "800" },

  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
    borderColor: "#d1d5db", backgroundColor: "#f9fafb", maxWidth: 220,
  },
  chipActive: { borderColor: "#60a5fa", backgroundColor: "#eff6ff" },
  chipText: { color: "#1f2937", fontWeight: "700" },
  chipTextActive: { color: "#2563eb", fontWeight: "800" },

  card: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    marginTop: 12,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 1 },
    }),
  },
  cardTitle: { color: "#111827", fontSize: 16, fontWeight: "700" },

  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    color: "#111827",
    marginTop: 6,
  },
  label: { color: "#475569", fontSize: 12, marginTop: 8, marginBottom: 4, fontWeight: "700" },

  title: { color: "#0f172a", fontSize: 22, fontWeight: "800" },
  muted: { color: "#475569" },
  mutedSmall: { color: "#64748b", fontSize: 12 },
  subheading: { color: "#1f2937", fontSize: 14, fontWeight: "800", marginTop: 10, marginBottom: 6 },

  row: { flexDirection: "row", gap: 8 },
  btnPrimary: { backgroundColor: "#00d0ff", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  btnPrimaryText: { color: "#031b1f", fontWeight: "800" },
  btnSecondary: {
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d1d5db",
  },
  btnSecondaryText: { color: "#111827", fontWeight: "700" },
  btnGhost: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  btnGhostText: { color: "#64748b", fontWeight: "700" },

  badge: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, fontWeight: "800" },

  bullet: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginTop: 4 },
  bulletDot: { color: "#2563eb", fontSize: 18, lineHeight: 18, marginTop: -2 },
  bulletText: { color: "#334155", flex: 1 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  /* Filename & attachment row (updated for responsiveness) */
  attachRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    width: "100%",
    gap: 8,
  },
  btnInline: {
    alignSelf: "flex-start",
    flexShrink: 1,
    maxWidth: "100%",
  },
  filenameWrap: {
    flexShrink: 1,
    flexGrow: 1,
    minWidth: 0,
    flexBasis: "100%",   // move file name to its own line when tight
    marginTop: 6,
  },
  filenameText: { color: "#64748b", fontSize: 12 },

  /* Web-only date input styling (no inline styles) */
  webDateInput: {
    width: "100%",
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#fff",
    color: "#111827",
    marginTop: 6,
    boxSizing: "border-box" as any,
  },

  /* Simple table styles */
  tableHeader: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
  },
  th: { color: "#111827", fontWeight: "800", fontSize: 12 },
  tr: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: "#f1f5f9",
    alignItems: "center",
  },
  td: { color: "#334155", fontSize: 12 },
});
// Badge color helper used in Upcoming + Scheduled lists
const urgencyColor = (row: { dueInKm?: number; dueInDays?: number }) => {
  const overdue =
    (typeof row.dueInKm === "number" && row.dueInKm < 0) ||
    (typeof row.dueInDays === "number" && row.dueInDays < 0);

  const soon =
    (typeof row.dueInKm === "number" && row.dueInKm <= 1500) ||
    (typeof row.dueInDays === "number" && row.dueInDays <= 30);

  return overdue ? "#b91c1c" : soon ? "#b45309" : "#166534";
};

