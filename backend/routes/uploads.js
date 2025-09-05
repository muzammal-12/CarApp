// backend/routes/uploads.js
import express from "express";
import multer from "multer";
import axios from "axios";
import {
  INSPECTIONS_FOLDER,
  cloudinaryConfigured,
  uploadBuffer,
} from "../utils/cloudinary.js";
import requireAuth from "../middleware/requireAuth.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router = express.Router();

/* ─────────── Multer (in-memory) ─────────── */
const storage = multer.memoryStorage();
const limits = { fileSize: 10 * 1024 * 1024, files: 12 }; // 10MB/file, max 12
const imageExt = /\.(jpe?g|png|webp|heic|heif)$/i;
const fileFilter = (_req, file, cb) => {
  if (file.mimetype?.startsWith?.("image/") || imageExt.test(file.originalname || "")) {
    cb(null, true);
  } else {
    cb(new Error("Only image uploads are allowed"));
  }
};
// Accept various field names React Native might send
const upload = multer({ storage, limits, fileFilter }).any();

/* ─────────── Auth for all upload routes ─────────── */
router.use(requireAuth);

/* ─────────── Boot diagnostics ─────────── */
if (!cloudinaryConfigured) {
  console.warn("[uploads] Cloudinary is NOT configured — uploads will fail.");
}
console.log("[uploads] target folder:", INSPECTIONS_FOLDER);

/* ─────────── Gemini OCR setup ─────────── */
const GEMINI_API_KEY =
  process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
if (!GEMINI_API_KEY) {
  console.warn("[uploads] GEMINI_API_KEY (or GOOGLE_GEMINI_API_KEY) is missing in .env — OCR will return a stub.");
}
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

/* ─────────── Helpers ─────────── */
function guessMimeFromName(name = "") {
  const low = name.toLowerCase();
  if (low.endsWith(".png")) return "image/png";
  if (low.endsWith(".webp")) return "image/webp";
  if (low.endsWith(".heic") || low.endsWith(".heif")) return "image/heic";
  if (low.endsWith(".jpg") || low.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

async function urlToInlineData(url) {
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  const mimeType = resp.headers["content-type"] || guessMimeFromName(url);
  const data = Buffer.from(resp.data).toString("base64");
  return { inlineData: { data, mimeType } };
}

/** Heuristic: does the OCR text look like a computer-generated quote/invoice? */
function looksLikeQuote(raw = "") {
  const text = String(raw || "").trim();

  if (!text) return false;

  // Must contain at least one money signal (PKR, Rs, ₨, or numeric money shapes)
  const moneySig =
    /\b(?:PKR|Rs\.?|₨)\s*\d[\d,]*(?:\.\d{1,2})?/i.test(text) ||
    /\btotal\s*[:\-]?\s*(?:PKR|Rs\.?|₨)?\s*\d[\d,]*(?:\.\d{1,2})?\b/i.test(text) ||
    // bare amounts on multiple lines (e.g., 2+ currency-like numbers)
    (text.match(/\b\d{3,}(?:,\d{3})*(?:\.\d{1,2})?\b/g) || []).length >= 3;

  // Structure hints: typical invoice/quote fields
  const structureSig =
    /\b(invoice|quotation|quote\s*no\.?|estimate|bill|tax invoice|shop\s+supplies|subtotal|grand\s*total|total amount)\b/i.test(text) ||
    /\b(qty|quantity|unit price|rate|amount)\b/i.test(text) ||
    /\b(terms|validity|gst|sales tax|withholding|service charge)\b/i.test(text);

  // Multiple line items often have "x", "@", or colon-delimited price lines
  const lineItemLike =
    /(?:x\s*\d+|\d+\s*x|@\s*(?:PKR|Rs\.?|₨)?\s*\d)/i.test(text) ||
    /:?\s*(?:PKR|Rs\.?|₨)?\s*\d[\d,]*(?:\.\d{1,2})?\s*$/m.test(text);

  // Reject images that look like single words / sentences without structure
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lineCount = lines.length;

  // Final decision: needs money signal + some structure OR plenty of money-like lines
  return (
    (moneySig && (structureSig || lineItemLike)) ||
    ((moneySig && lineCount >= 5) || (lineCount >= 8 && lineItemLike))
  );
}

/**
 * POST /api/uploads/images
 * Accepts images under field names: files, file, image, images[], photos
 * Returns: { success, urls, items }
 */
router.post("/images", upload, async (req, res) => {
  try {
    const all = Array.isArray(req.files) ? req.files : [];
    const files = all.filter((f) =>
      ["files", "file", "image", "images[]", "photos"].includes(f.fieldname)
    );

    const meta = files.map((f) => ({
      fieldname: f.fieldname,
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
    }));

    console.log("[uploads] /images received files:", meta);

    if (!files.length) {
      return res.status(400).json({ success: false, message: "No image files attached" });
    }
    if (!cloudinaryConfigured) {
      return res.status(500).json({ success: false, message: "Cloudinary not configured on server" });
    }

    const uploads = [];
    for (const file of files) {
      const result = await uploadBuffer(file.buffer, {
        folder: INSPECTIONS_FOLDER, // -> carai/inspections (overridable via env)
        filename_override: file.originalname || undefined,
        resource_type: "image",
        use_filename: true,
        unique_filename: true,
        overwrite: false,
      });

      uploads.push({
        url: result.secure_url,
        public_id: result.public_id,
        asset_id: result.asset_id,
        width: result.width,
        height: result.height,
        format: result.format,
        folder: INSPECTIONS_FOLDER,
      });
    }

    console.log("[uploads] /images cloudinary results:", uploads.length);
    res.json({
      success: true,
      urls: uploads.map((u) => u.url),
      items: uploads,
    });
  } catch (err) {
    const msg =
      err?.message ||
      err?.response?.data?.error?.message ||
      "Cloudinary upload failed";
    console.error("[uploads] /images error:", err?.response?.data || err);
    res.status(500).json({ success: false, message: msg });
  }
});

/**
 * POST /api/uploads/ocr/quote
 * Accepts: either an uploaded image (any field name) or { imageUrl } in body
 * Returns: { text }  (422 if not a quote-looking document)
 */
router.post("/ocr/quote", upload, async (req, res) => {
  try {
    console.log("[uploads] /ocr/quote start — body keys:", Object.keys(req.body || {}));

    // 1) Pick first image file OR imageUrl
    const files = Array.isArray(req.files) ? req.files : [];
    const file =
      files.find((f) => ["image", "file", "files", "images[]", "photo", "photos"].includes(f.fieldname)) ||
      files[0];

    const { imageUrl } = req.body || {};

    let inlineData;

    if (file?.buffer?.length) {
      const mimeType = file.mimetype || guessMimeFromName(file.originalname);
      const data = Buffer.from(file.buffer).toString("base64");
      inlineData = { inlineData: { data, mimeType } };
      console.log("[uploads] /ocr/quote using uploaded file:", {
        field: file.fieldname,
        name: file.originalname,
        size: file.size
      });
    } else if (imageUrl) {
      console.log("[uploads] /ocr/quote fetching imageUrl:", imageUrl);
      inlineData = await urlToInlineData(imageUrl);
    } else {
      return res.status(400).json({ error: "No image provided. Upload an image or pass imageUrl." });
    }

    // 2) If no Gemini key, return a helpful stub (so the app can proceed in dev)
    if (!genAI) {
      console.warn("[uploads] /ocr/quote Gemini key missing — returning stub text.");
      const stubText = "Brake pads - 12000\nOil change: 8000\nCoolant flush 15000\nSpark plugs x4 = 20000";

      // Guard even on stub (keeps client behavior consistent)
      if (!looksLikeQuote(stubText)) {
        return res.status(422).json({
          ok: false,
          not_quote: true,
          message: "Please upload a computer-generated quote (PDF/printed). The image didn’t look like a quote.",
        });
      }
      return res.json({ text: stubText });
    }

    // 3) Call Gemini OCR
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const parts = [
      { text: "You are performing OCR. Return ONLY the plain text content of the image (no JSON, no extra commentary)." },
      inlineData
    ];

    const result = await model.generateContent(parts);
    const text = (result?.response?.text() || "").trim();

    console.log("[uploads] /ocr/quote OCR length:", text.length);

    // 4) Heuristic validation: only accept computer-generated quotes/invoices
    if (!looksLikeQuote(text)) {
      return res.status(422).json({
        ok: false,
        not_quote: true,
        message: "Please upload a computer-generated quote (PDF/printed). The image you uploaded didn’t look like a quote.",
      });
    }

    return res.json({ text });
  } catch (err) {
    console.error("[uploads] /ocr/quote error:", err?.response?.data || err);
    // As a resilience fallback, still return a tiny stub so UI isn't blocked in dev
    const stub = "Brake pads - 12000\nOil change: 8000\nCoolant flush 15000";
    // Try to keep the contract: if even stub doesn't look like a quote (unlikely), send 422
    if (!looksLikeQuote(stub)) {
      return res.status(422).json({
        ok: false,
        not_quote: true,
        message: "Please upload a computer-generated quote (PDF/printed). The image didn’t look like a quote.",
      });
    }
    return res.status(200).json({ text: stub, warning: "OCR failed server-side; returned stub." });
  }
});

export default router;
