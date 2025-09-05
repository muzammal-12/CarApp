// backend/utils/cloudinary.js
import { v2 as cloudinary } from "cloudinary";

/* ─────────── Config detection ─────────── */
const hasUrl = !!process.env.CLOUDINARY_URL;
const hasParts =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

export const cloudinaryConfigured = hasUrl || hasParts;

if (cloudinaryConfigured) {
  if (hasUrl) {
    // Reads everything from CLOUDINARY_URL; we still force https
    cloudinary.config({ secure: true });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
} else {
  console.warn(
    "[cloudinary] Missing CLOUDINARY_* env vars – uploads/deletions are disabled."
  );
}

/* ─────────── Folders ─────────── */
// Vehicles/photos base folder (existing behavior, used elsewhere)
export const CLOUDINARY_FOLDER =
  process.env.CLOUDINARY_UPLOAD_FOLDER ||
  process.env.CLOUDINARY_FOLDER ||
  "carai/vehicles";

// 👉 Inspections folder (now points to carai/inspections by default)
export const INSPECTIONS_FOLDER =
  process.env.CLOUDINARY_INSPECTIONS_FOLDER || "carai/inspections";

/* ─────────── Safe helpers ─────────── */
export async function deleteResourcesSafe(publicIds = []) {
  if (!cloudinaryConfigured || !publicIds.length) return null;
  try {
    return await cloudinary.api.delete_resources(publicIds, {
      resource_type: "image",
      type: "upload",
      invalidate: true,
    });
  } catch (err) {
    console.warn("[cloudinary] bulk delete failed:", err?.message || err);
    return null;
  }
}

export async function destroySafe(publicId) {
  if (!cloudinaryConfigured || !publicId) return null;
  try {
    return await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true,
    });
  } catch (err) {
    console.warn("[cloudinary] destroy failed:", publicId, err?.message || err);
    return null;
  }
}

/**
 * Upload a Node Buffer with an optional folder override.
 * Returns the Cloudinary upload result (secure_url, public_id, etc.)
 */
export function uploadBuffer(buffer, { folder = INSPECTIONS_FOLDER, ...opts } = {}) {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary is not configured – set CLOUDINARY_URL or CLOUDINARY_* envs.");
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        overwrite: false,
        use_filename: true,
        unique_filename: true,
        ...opts,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/* ─────────── Exports ─────────── */
export { cloudinary };        // named export
export default cloudinary;    // default export
