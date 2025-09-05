// services/secure.ts
import { Platform } from "react-native";
// Importing is fine on web; we just won't call its methods there.
import * as SecureStore from "expo-secure-store";

/* =========================================================================
 * Auth token storage
 * ========================================================================= */
const KEY = "mycarapp_token";

export async function saveToken(token: string) {
  if (Platform.OS === "web") {
    try {
      window.localStorage.setItem(KEY, token);
    } catch {}
    return;
  }
  await SecureStore.setItemAsync(KEY, token);
}

export async function getToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function clearToken() {
  if (Platform.OS === "web") {
    try {
      window.localStorage.removeItem(KEY);
    } catch {}
    return;
  }
  await SecureStore.deleteItemAsync(KEY);
}

/* =========================================================================
 * Cloudinary upload helper for local files (Expo ImagePicker URIs)
 * - Supports unsigned uploads via preset
 * - Optional signed uploads via backend signature endpoint
 * - Works on web (uses Blob/File) and native (uses { uri, name, type })
 * ========================================================================= */

type UploadOpts = {
  /** Target Cloudinary folder; defaults to EXPO_PUBLIC_CLOUDINARY_UPLOAD_FOLDER or "carai/vehicles" */
  folder?: string;
  /** If true, fetch a signature from backend before upload */
  useSigned?: boolean;
  /** Bearer token for hitting the signature endpoint when useSigned=true */
  token?: string;
  /** Optional override for upload_preset when using unsigned uploads */
  uploadPreset?: string;
  /** Optional override for cloud name */
  cloudName?: string;
  /** Optional: additional form fields to append (public_id, eager, etc) */
  extra?: Record<string, string | number | boolean>;
};

/**
 * Upload a local file (e.g., from expo-image-picker) to Cloudinary.
 * Returns Cloudinary upload JSON (public_id, secure_url, width, height, bytes, format, created_at, etc.)
 */
export async function uploadToCloudinaryLocalFile(uri: string, opts: UploadOpts = {}) {
  const cloudName =
    opts.cloudName || process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME!;
  const preset =
    opts.uploadPreset || process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET; // for unsigned uploads
  const folder =
    opts.folder || process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_FOLDER || "carai/vehicles";
  const apiBase =
    (process.env.EXPO_PUBLIC_API_BASE_URL || "http://localhost:5000").replace(/\/$/, "");

  // 🔎 Log env/input at the start (helps diagnose 400s)
  console.log("[Cloudinary] ENV/opts", {
    platform: Platform.OS,
    cloudName,
    preset,
    folder,
    useSigned: !!opts.useSigned,
    apiBase,
  });
  console.log("[Cloudinary] Upload URI", uri);

  if (!cloudName) {
    console.error("[Cloudinary] Missing cloud name");
    throw new Error("Missing EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME. Set it in your app env.");
  }

  const form = new FormData();

  if (opts.useSigned) {
    try {
      console.log("[Cloudinary] Fetching signature from backend…");
      const sigRes = await fetch(`${apiBase}/api/vehicles/cloudinary/signature`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token ?? ""}` },
      });
      if (!sigRes.ok) {
        const t = await sigRes.text().catch(() => "");
        console.error("[Cloudinary] Signature request failed", sigRes.status, t);
        throw new Error("Failed to fetch Cloudinary signature");
      }
      const sig = await sigRes.json();
      console.log("[Cloudinary] Signature OK", { folder: sig.folder, ts: sig.timestamp });
      form.append("api_key", sig.apiKey);
      form.append("timestamp", String(sig.timestamp));
      form.append("signature", sig.signature);
      form.append("folder", sig.folder);
    } catch (e: any) {
      console.error("[Cloudinary] Signature error", e?.message || e);
      throw e;
    }
  } else {
    // Unsigned upload via preset
    if (!preset) {
      console.error("[Cloudinary] Missing unsigned preset");
      throw new Error(
        "Missing EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET for unsigned uploads. Either set it or use useSigned: true."
      );
    }
    form.append("upload_preset", preset);
    form.append("folder", folder);
  }

  // Extra fields if any (e.g., public_id)
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      form.append(k, String(v));
    }
  }

  // Guess a filename and content type
  const filename = uri.split("/").pop() || `photo_${Date.now()}.jpg`;
  const mime = guessMimeType(filename) || "image/jpeg";

  // ---- WEB vs NATIVE file part ----
  try {
    if (Platform.OS === "web") {
      // In browsers, Cloudinary needs a Blob/File, not { uri, ... }.
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const file = new File([blob], filename, { type: blob.type || mime });
      form.append("file", file);
      console.log("[Cloudinary] Appended File (web)", { name: file.name, type: file.type, size: file.size });
    } else {
      // React Native (iOS/Android)
      // @ts-expect-error React Native FormData file type
      form.append("file", { uri, name: filename, type: mime });
      console.log("[Cloudinary] Appended RN file", { name: filename, type: mime });
    }
  } catch (e: any) {
    console.error("[Cloudinary] Error preparing file for upload", e?.message || e);
    throw e;
  }

  console.log("[Cloudinary] Uploading…");
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await safeText(res);
    console.error("[Cloudinary] Upload failed", res.status, text);
    // Surface Cloudinary's message (helps debug 400s)
    throw new Error(`Cloudinary upload failed: ${res.status} ${text ? `- ${text}` : ""}`);
  }

  const json = await res.json();
  console.log("[Cloudinary] Upload OK", {
    public_id: json.public_id,
    secure_url: json.secure_url,
    bytes: json.bytes,
    format: json.format,
  });
  return json; // Cloudinary response JSON
}

/* =========================================================================
 * Small helpers
 * ========================================================================= */

function guessMimeType(name: string): string | null {
  const n = name.toLowerCase();
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".heic") || n.endsWith(".heif")) return "image/heic";
  return null;
}

async function safeText(res: Response) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
