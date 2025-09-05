import { Platform } from "react-native";

/* ──────────────────────────────────────────────────────────────────────────────
   Base URL with smart fallbacks (EXPO_PUBLIC_API_BASE or _URL)
   ──────────────────────────────────────────────────────────────────────────── */
const DEFAULT_LOCAL =
  Platform.OS === "android" ? "http://10.0.2.2:5000" : "http://127.0.0.1:5000";

const rawBaseEnv =
  (process.env as any).EXPO_PUBLIC_API_BASE ??
  (process.env as any).EXPO_PUBLIC_API_BASE_URL ??
  DEFAULT_LOCAL;

const RAW_BASE = typeof rawBaseEnv === "string" ? rawBaseEnv.trim() : DEFAULT_LOCAL;
export const API_BASE_URL = RAW_BASE.replace(/\/+$/, "");
export const API_BASE = API_BASE_URL;

console.log("[API] Using base URL:", API_BASE_URL);

/* ──────────────────────────────────────────────────────────────────────────────
   Infra
   ──────────────────────────────────────────────────────────────────────────── */
export class ApiError extends Error {
  status: number;
  details?: any;
  constructor(msg: string, status = 500, details?: any) {
    super(msg);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

function joinURL(base: string, path: string) {
  if (!path) return base;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

function isJsonContent(res: Response) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json") || ct.includes("/json") || ct.includes("+json");
}

async function parseBody<T>(res: Response): Promise<{ data: T | null; text: string }> {
  const raw = await res.text();
  if (!raw) return { data: null, text: "" };

  const trimmed = raw.trim();

  if (isJsonContent(res)) {
    try {
      return { data: JSON.parse(trimmed) as T, text: raw };
    } catch {}
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return { data: JSON.parse(trimmed) as T, text: raw };
    } catch {}
  }
  return { data: null, text: raw };
}

/** Fetch with timeout (AbortController on web & RN newers) */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const canAbort = typeof AbortController !== "undefined";
  if (canAbort) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...(init || {}), signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }
  return (await Promise.race([
    fetch(input, init),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new ApiError("Request timeout", 408)), timeoutMs)
    ),
  ])) as Response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData =
    typeof init?.body !== "undefined" &&
    typeof FormData !== "undefined" &&
    (init?.body as any) instanceof FormData;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(init?.headers as Record<string, string>),
  };

  let res: Response;
  try {
    res = await fetchWithTimeout(joinURL(API_BASE_URL, path), { ...init, headers });
  } catch (err: any) {
    console.error("[API] Network error", path, err?.message || err);
    throw new ApiError(err?.message || "Network request failed", 0);
  }

  if (res.status === 204 || res.status === 205) return {} as T;

  const { data, text } = await parseBody<T>(res);

  if (!res.ok) {
    const msgFromJson = (data as any)?.msg || (data as any)?.message || (data as any)?.error;
    const fallback = isJsonContent(res) ? `HTTP ${res.status}` : text?.slice(0, 300) || `HTTP ${res.status}`;
    const msg = msgFromJson || fallback;
    console.error("[API] Error", res.status, path, msg);
    throw new ApiError(msg, res.status, isJsonContent(res) ? data : { raw: text });
  }

  if (data != null) return data as T;
  if (text) return ({ text } as unknown) as T;
  return {} as T;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Auth
   ──────────────────────────────────────────────────────────────────────────── */
export type SignupBody = { email: string; password: string };
export type SignupResp = { msg: string };

export type LoginBody = { email: string; password: string };
export type LoginResp = { token: string };

export type ForgotBody = { email: string };
export type ForgotResp = { msg: string };

export type VerifyResp = { msg: string };
export type MeResp = any;
export type LogoutResp = { ok: boolean };

export const apiSignup = (body: SignupBody) =>
  request<SignupResp>("/api/auth/signup", { method: "POST", body: JSON.stringify(body) });

export const apiLogin = (body: LoginBody) =>
  request<LoginResp>("/api/auth/login", { method: "POST", body: JSON.stringify(body) });

export const apiForgot = (body: ForgotBody) =>
  request<ForgotResp>("/api/auth/forgot-password", { method: "POST", body: JSON.stringify(body) });

export const apiVerify = (token: string) =>
  request<VerifyResp>(`/api/auth/verify/${encodeURIComponent(token)}`, { method: "GET" });

export const apiMe = (token: string) =>
  request<MeResp>("/api/auth/me", { method: "GET", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });

export const apiLogout = (token: string) =>
  request<LogoutResp>("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

/* ──────────────────────────────────────────────────────────────────────────────
   Vehicles
   ──────────────────────────────────────────────────────────────────────────── */
export type VehiclePhoto = {
  public_id: string;
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  format?: string;
  created_at?: string;
};

export type MaintEntry = { mileage?: number; date?: string };
export type LastMaintenance = {
  oil_change?: MaintEntry;
  brake_pads?: MaintEntry;
  air_filter?: MaintEntry;
  cabin_filter?: MaintEntry;
  coolant?: MaintEntry;
  tires?: MaintEntry;
  spark_plugs?: MaintEntry;
  transmission_fluid?: MaintEntry;
  battery?: MaintEntry;
  wiper_blades?: MaintEntry;
};

export type NextServiceHint = {
  key: keyof LastMaintenance | string;
  mileage?: number;
  date?: string;
  note?: string;
};

export type Vehicle = {
  _id: string;
  userId: string;
  make: string;
  model: string;
  year: number;
  mileage?: number;
  mileageUnit?: "km" | "mi";
  current_mileage?: number;
  name?: string;
  nickname?: string;
  vin?: string;
  engine?: string;
  last_maintenance?: LastMaintenance;
  next_service_hint?: NextServiceHint;
  isPrimary?: boolean;
  photos?: VehiclePhoto[];
  createdAt?: string;
  updatedAt?: string;
};

export type CreateVehicleBody = {
  make: string;
  model: string;
  year: number;
  mileage?: number;
  mileageUnit?: "km" | "mi";
  name?: string;
  nickname?: string;
  isPrimary?: boolean;
  vin?: string;
  engine?: string;
  last_maintenance?: LastMaintenance;
  next_service_hint?: NextServiceHint;
};

export type UpdateVehicleBody = Partial<CreateVehicleBody>;

export const apiGetVehicles = async (token: string) => {
  try {
    return await request<Vehicle[]>("/api/vehicles/my", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      // @ts-ignore
      cache: "no-store",
    });
  } catch {
    return await request<Vehicle[]>("/api/vehicles", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      // @ts-ignore
      cache: "no-store",
    });
  }
};

export const apiGetMyVehicles = (token: string) =>
  request<Vehicle[]>("/api/vehicles/my", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    cache: "no-store",
  });

export const apiCreateVehicle = (token: string, body: CreateVehicleBody) =>
  request<Vehicle>("/api/vehicles", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

export const apiUpdateVehicle = (token: string, vehicleId: string, body: UpdateVehicleBody) =>
  request<Vehicle>(`/api/vehicles/${encodeURIComponent(vehicleId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

export const apiDeleteVehicle = (token: string, vehicleId: string) =>
  request<{ ok: true; deletedVehicleId?: string; deletedPhotosCount?: number }>(
    `/api/vehicles/${encodeURIComponent(vehicleId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );

export const apiSetPrimaryVehicle = (token: string, vehicleId: string) =>
  request<{ ok: true }>(`/api/vehicles/${encodeURIComponent(vehicleId)}/set-primary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

export const apiAttachVehiclePhoto = (
  token: string,
  vehicleId: string,
  photo: VehiclePhoto
) =>
  request<Vehicle>(`/api/vehicles/${encodeURIComponent(vehicleId)}/photos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(photo),
  });

/**
 * Try both delete shapes to be compatible with different backends:
 * 1) /photos?publicId=...
 * 2) /photos/:publicId
 */
export const apiDeleteVehiclePhoto = async (
  token: string,
  vehicleId: string,
  publicId: string
) => {
  const qp = `/api/vehicles/${encodeURIComponent(vehicleId)}/photos?publicId=${encodeURIComponent(publicId)}`;
  try {
    return await request<{ ok: true; vehicle: Vehicle }>(qp, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      // @ts-ignore
      cache: "no-store",
    });
  } catch (e: any) {
    if (e?.status === 404) {
      const path = `/api/vehicles/${encodeURIComponent(vehicleId)}/photos/${encodeURIComponent(publicId)}`;
      return await request<{ ok: true; vehicle: Vehicle }>(path, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore
        cache: "no-store",
      });
    }
    throw e;
  }
};

export type CloudinarySignatureResp = {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  signature: string;
};

export const apiGetCloudinarySignature = (token: string) =>
  request<CloudinarySignatureResp>("/api/vehicles/cloudinary/signature", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

/* ──────────────────────────────────────────────────────────────────────────────
   Maintenance & Quotes
   ──────────────────────────────────────────────────────────────────────────── */
export type TyrePartStatus = {
  partName: string;
  status: "good" | "worn" | "urgent";
  notes?: string;
};

export type MarketRate = {
  key: string;
  label: string;
  avgPrice: number;
  rangeMin: number;
  rangeMax: number;
  standardHours?: number;
};

export type QuoteItem = {
  key: string;
  label: string;
  part?: string;
  qty?: number;
  price: number;
  laborHours?: number;
  notes?: string;
};

export type AnalysisBucket = {
  overpriced: QuoteItem[];
  questionable: QuoteItem[];
  fair: QuoteItem[];
};

export type SaveQuotePayload = {
  vehicleId: string;
  summary: string;
  total?: number;
  items?: QuoteItem[];
  analysis?: AnalysisBucket;
  marketRates?: MarketRate[];
  rawText?: string;
  ocrText?: string;
  manualText?: string;
};

export type InspectionQuoteDoc = {
  _id: string;
  userId: string;
  vehicleId: string;
  type: "maintenance-quote";
  summary: string;
  total: number;
  items: QuoteItem[];
  analysis?: AnalysisBucket;
  marketRates?: MarketRate[];
  rawText?: string;
  createdAt: string;
  updatedAt: string;
};

export const apiGetTyrePartsStatus = async (token: string, vehicleId?: string) => {
  const url = vehicleId
    ? `/api/inspections/tyres-parts?vehicleId=${encodeURIComponent(vehicleId)}`
    : `/api/inspections/tyres-parts`;
  console.log("[API] GET", url);
  return request<{ items: TyrePartStatus[] }>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    cache: "no-store",
  });
};

// helper for web File/Blob/Lists
function toWebBlob(maybe: any): Blob | File | undefined {
  if (!maybe) return undefined;
  if (typeof File !== "undefined" && maybe instanceof File) return maybe;
  if (typeof Blob !== "undefined" && maybe instanceof Blob) return maybe as Blob;
  if (Array.isArray(maybe) && maybe.length) return maybe[0];
  if (typeof maybe.length === "number" && maybe.length > 0 && maybe[0]) return maybe[0];
  if (typeof maybe.item === "function") {
    const f = maybe.item(0);
    if (f) return f as File;
  }
  return undefined;
}

export type OCRQuoteResp = { text: string; warning?: string };

export const apiPostOCRQuote = async (
  token: string,
  file?: {
    uri?: string;
    name?: string;
    type?: string;
    webFile?: any;
    file?: any;
  },
  imageUrl?: string
) => {
  const url = "/api/uploads/ocr/quote";
  const fd = new FormData();

  const webInput = file?.webFile ?? file?.file;
  const webBlob = typeof window !== "undefined" ? toWebBlob(webInput) : undefined;
  const isWebBlobLike = Boolean(webBlob);

  console.log("[API] POST", url, {
    branch: isWebBlobLike
      ? "web:File/Blob"
      : (Platform.OS === "web" &&
          file?.uri &&
          (file.uri.startsWith("blob:") || file.uri.startsWith("data:")))
      ? "web:uri->blob"
      : file?.uri
      ? "native:tuple"
      : imageUrl
      ? "imageUrl"
      : "none",
  });

  if (isWebBlobLike && webBlob) {
    const name = file?.name || (webBlob as any).name || `quote_${Date.now()}`;
    fd.append("image", webBlob as any, name);
  } else if (Platform.OS === "web" && file?.uri && (file.uri.startsWith("blob:") || file.uri.startsWith("data:"))) {
    const blob = await fetch(file.uri).then((r) => r.blob());
    const name = file?.name || (blob as any).name || `quote_${Date.now()}`;
    fd.append("image", blob as any, name);
  } else if (file?.uri) {
    const name =
      file.name ||
      file.uri.split("/").pop() ||
      `quote_${Date.now()}.${(file.type || "image/jpeg").split("/").pop()}`;
    const type = file.type || "image/jpeg";
    // @ts-ignore RN tuple
    fd.append("image", { uri: file.uri, name, type });
  } else if (imageUrl) {
    fd.append("imageUrl", imageUrl);
  } else {
    throw new ApiError("Provide either file or imageUrl to OCR", 400);
  }

  return request<{ text: string; warning?: string }>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
};

export const apiPostMarketRates = async (token: string, items: { key: string; label: string }[]) => {
  const url = "/api/inspections/market-rates";
  console.log("[API] POST", url, "items:", items.length);
  return request<MarketRate[]>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items }),
  });
};

export const apiAIQuoteAnalyze = async (token: string, payload: any) => {
  const url = "/api/inspections/ai/quote-analyze";
  console.log("[API] POST", url);
  return request<{ gemini: any }>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
};

export const apiSaveQuote = async (token: string, payload: SaveQuotePayload) => {
  const url = "/api/inspections/quotes";
  console.log(
    "[API] POST",
    url,
    payload.summary,
    "items:",
    Array.isArray(payload.items) ? payload.items.length : 0,
    "hasText:",
    Boolean(payload.rawText || payload.ocrText || payload.manualText)
  );
  return request<InspectionQuoteDoc>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
};

export const apiGetMaintenanceHistory = async (token: string, vehicleId?: string) => {
  const url = vehicleId
    ? `/api/inspections/maintenance/history?vehicleId=${encodeURIComponent(vehicleId)}`
    : `/api/inspections/maintenance/history`;
  console.log("[API] GET", url);
  return request<InspectionQuoteDoc[]>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    cache: "no-store",
  });
};

export const apiPatchVehicleMaintenance = async (
  token: string,
  vehicleId: string,
  updates: { key: string; mileage?: number; date?: string }[],
  current_mileage?: number
) => {
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/maintenance`;
  console.log("[API] PATCH", url, "updates:", updates.length, "current_mileage:", current_mileage);
  return request<Vehicle>(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ updates, current_mileage }),
  });
};

export type MaintenanceHistoryItem = {
  itemKey: string;
  date: string; // "YYYY-MM-DD"
  mileage?: number;
  cost?: number;
  notes?: string;
};

export const apiGetVehicleMaintenanceHistory = async (token: string, vehicleId: string) => {
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/maintenance-history`;
  console.log("[API] GET", url);
  return request<MaintenanceHistoryItem[]>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    cache: "no-store",
  });
};

export const apiCompleteMaintenance = async (
  token: string,
  vehicleId: string,
  payload: { itemKey: string; date: string; mileage?: number; cost?: number; notes?: string }
) => {
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/maintenance/complete`;
  console.log("[API] POST", url, payload.itemKey, payload.date);
  return request<{ ok: true }>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
};

/* ──────────────────────────────────────────────────────────────────────────────
   NEW: Scheduled services (per vehicle)
   ──────────────────────────────────────────────────────────────────────────── */
export type ScheduledService = {
  _id: string;
  service: string;          // e.g., "Window repair"
  itemKey: string;          // normalized key (e.g., "window_repair", "oil_change")
  dateISO: string;          // "YYYY-MM-DD"
  notes?: string;
  createdAt?: string;
};

export const apiListScheduledServices = (token: string, vehicleId: string) => {
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/schedule`;
  console.log("[API] GET", url);
  return request<ScheduledService[]>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    // @ts-ignore
    cache: "no-store",
  });
};

export const apiCreateScheduledService = (
  token: string,
  body: { vehicleId: string; service: string; itemKey?: string; dateISO: string; notes?: string }
) => {
  const { vehicleId, ...rest } = body;
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/schedule`;
  console.log("[API] POST", url, rest.service, rest.dateISO);
  return request<ScheduledService>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(rest),
  });
};

export const apiDeleteScheduledService = (
  token: string,
  vehicleId: string,
  scheduleId: string
) => {
  const url = `/api/vehicles/${encodeURIComponent(vehicleId)}/schedule/${encodeURIComponent(scheduleId)}`;
  console.log("[API] DELETE", url);
  return request<{ ok: true }>(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
};

/* ──────────────────────────────────────────────────────────────────────────────
   Small helpers
   ──────────────────────────────────────────────────────────────────────────── */
export const lastMaintenanceEntries = (lm?: LastMaintenance) =>
  Object.entries(lm ?? {}) as [keyof LastMaintenance, MaintEntry | undefined][];

export function normalizeServiceKey(raw: string) {
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

/* ──────────────────────────────────────────────────────────────────────────────
   Guides & Learnings – Chat
   ──────────────────────────────────────────────────────────────────────────── */
export type GLCChatSession = {
  _id: string;
  title: string;
  model: string;
  archived: boolean;
  lastMessagePreview?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GLCChatMessage = {
  _id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  index: number;
  createdAt?: string;
  updatedAt?: string;
};

export const apiGlcListSessions = (token: string) =>
  request<{ success: boolean; sessions: GLCChatSession[] }>("/api/guides/chat/sessions", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

export const apiGlcCreateSession = (token: string, title = "New chat", model?: string) =>
  request<{ success: boolean; session: GLCChatSession }>("/api/guides/chat/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, ...(model ? { model } : {}) }),
  });

export const apiGlcPatchSession = (token: string, sessionId: string, patch: { title?: string; archived?: boolean }) =>
  request<{ success: boolean; session: GLCChatSession }>(`/api/guides/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });

export const apiGlcDeleteSession = (token: string, sessionId: string) =>
  request<{ success: boolean }>(`/api/guides/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

export const apiGlcLoadMessages = (token: string, sessionId: string) =>
  request<{ success: boolean; session: GLCChatSession; messages: GLCChatMessage[] }>(
    `/api/guides/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

export const apiGlcSendMessage = (token: string, sessionId: string, content: string) =>
  request<{ success: boolean; user: GLCChatMessage; assistant: GLCChatMessage }>(
    `/api/guides/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    }
  );

/* ──────────────────────────────────────────────────────────────────────────────
   PRICING (Gemini-only) — no predefined baselines
   ──────────────────────────────────────────────────────────────────────────── */

// Request/response for single assessment
export type PricingAssessBody = {
  vehicle_make: string;     // company
  vehicle_model: string;
  vehicle_year: number;
  service_name: string;
  quoted_amount: number;
  currency?: string;
  location_city?: string | null;
  location_country?: string | null;
  extra_notes?: string | null;
  persist_assessment?: boolean;
  vehicleId?: string | null;
};

export type PricingAssessment = {
  decision: "fair" | "overpriced" | "unknown";
  confidence: number;
  rationale: string;
  inferred_fair_range?: { min?: number; max?: number; currency?: string };
  model_notes?: string;
  model_id: string; // "gemini-1.5-flash"
};

export type PricingAssessResp = { success: boolean; assessment: PricingAssessment };

export const apiPricingAssessQuote = (token: string, body: PricingAssessBody) => {
  const url = `/api/pricing/assess-quote`;
  console.log("[API] POST", url, body.service_name, body.quoted_amount);
  return request<PricingAssessResp>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
};

/* ──────────────────────────────────────────────────────────────────────────────
   NEW: Gemini compare (vehicle attrs → AI prices)
   ──────────────────────────────────────────────────────────────────────────── */
export type PricingCompareAIItem = {
  key?: string;
  label?: string;
  qty?: number;     // default 1
  price?: number;   // user-entered unit price
};

export type PricingCompareAIReq = {
  vehicle_make: string;      // e.g., "Toyota"
  vehicle_model: string;     // e.g., "Corolla"
  vehicle_year: number;      // e.g., 2022
  items: PricingCompareAIItem[];
  currency?: string;         // e.g., "PKR"
  location_city?: string | null;
  location_country?: string | null; // e.g., "PK"
};

export type PricingCompareRow = {
  service: string;
  qty: number;
  user_unit: number;
  user_total: number;
  ai_range_min: number | null;
  ai_range_max: number | null;
  ai_currency?: string;                // e.g., "PKR"
  ai_confidence?: number | null;       // 0..1
  ai_verdict: "overpriced" | "fair" | "unknown";
  delta_pct_vs_ai_mid?: number | null; // +/-% vs AI mid price
};

export type PricingCompareResp = {
  success: boolean;
  table: PricingCompareRow[];
};

/** POST /api/pricing/compare — Gemini 1.5 Flash backend */
export const apiPricingCompare = (token: string, body: PricingCompareAIReq) => {
  const url = `/api/pricing/compare`;
  console.log(
    "[API] POST",
    url,
    "items:",
    (body.items || []).length,
    body.vehicle_year,
    body.vehicle_make,
    body.vehicle_model
  );
  return request<PricingCompareResp>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
};

// Crowdsourced samples (unchanged)
export type PricingSampleItem = {
  key?: string;
  label?: string;
  qty?: number;
  price?: number;
  total?: number;
  vendor?: string;
};

export type PricingSubmitBody = {
  vehicleId?: string | null;
  city?: string | null;
  region?: string;         // default "GLOBAL" on backend
  currency?: string;       // default "USD"
  items: PricingSampleItem[];
};

export const apiPricingSubmitSamples = (token: string, body: PricingSubmitBody) => {
  const url = `/api/pricing/submit`;
  console.log("[API] POST", url, (body.items || []).length, "items");
  return request<{ success: boolean; inserted: number }>(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
};

export const apiPricingSamples = (
  token: string,
  opts?: { serviceKey?: string; region?: string; city?: string | null; limit?: number }
) => {
  const q = new URLSearchParams({
    ...(opts?.serviceKey ? { serviceKey: opts.serviceKey } : {}),
    ...(opts?.region ? { region: String(opts.region) } : {}),
    ...(opts?.city ? { city: String(opts.city) } : {}),
    ...(opts?.limit ? { limit: String(opts.limit) } : {}),
  }).toString();
  const url = `/api/pricing/samples${q ? `?${q}` : ""}`;
  console.log("[API] GET", url);
  return request<{ success: boolean; items: any[] }>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
};
